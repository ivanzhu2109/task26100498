import test from 'node:test';
import assert from 'node:assert/strict';
import { NegotiationCoordinator } from '../src/coordinator';
import { Harness, sendCandidate } from '../src/testing/harness';
import { MockDriver } from '../src/testing/mockDriver';
import { Round } from '../src/types';

/** 收敛断言：两端 stable，本地与远端描述对应同一最大轮次。 */
function assertConverged(h: Harness): void {
  const max = h.maxRound();
  const rounds = h.descriptionRounds();
  const sides: [NegotiationCoordinator, MockDriver][] = [
    [h.requester, h.requesterDriver],
    [h.technician, h.technicianDriver],
  ];
  for (const [coordinator, driver] of sides) {
    assert.equal(driver.signalingState, 'stable', '驱动应回到 stable');
    assert.deepEqual(coordinator.state(), { round: max, status: 'stable' });
    assert.ok(driver.localDescription, '应有本地描述');
    assert.ok(driver.remoteDescription, '应有远端描述');
    assert.deepEqual(rounds.get(driver.localDescription!), max, '本地描述应对应最大轮次');
    assert.deepEqual(rounds.get(driver.remoteDescription!), max, '远端描述应对应最大轮次');
  }
}

const round = (count: number, initiator: 'requester' | 'technician'): Round => ({
  count,
  initiator,
});

test('基本流程：offer/answer 配对后两端收敛', async () => {
  const h = new Harness();
  await h.requester.negotiate();
  assert.deepEqual(h.requester.state(), {
    round: round(1, 'requester'),
    status: 'have-local-offer',
  });
  await h.toTechnician.deliverAll(); // offer
  await h.toRequester.deliverAll(); // answer
  assertConverged(h);
});

test('双方同时发起：较小轮次被撤销，最终配对到 technician 轮次', async () => {
  const h = new Harness();
  // 同时发起：同计数时 technician 轮次更大
  await Promise.all([h.requester.negotiate(), h.technician.negotiate()]);
  assert.deepEqual(h.requester.state(), { round: round(1, 'requester'), status: 'have-local-offer' });
  assert.deepEqual(h.technician.state(), { round: round(1, 'technician'), status: 'have-local-offer' });

  // technician 的 offer 到达 requester：requester 撤销自己的 offer 并回答
  await h.toRequester.deliverAll();
  assert.ok(
    h.requesterDriver.log.includes('rollback -> stable'),
    'requester 应 rollback 尚未配对的 offer',
  );
  assert.deepEqual(h.requester.state(), { round: round(1, 'technician'), status: 'stable' });

  // requester 的迟到 offer 到达 technician：轮次更小，必须忽略
  const logBefore = h.technicianDriver.log.length;
  await h.toTechnician.deliver(0); // requester 的 stale offer
  assert.equal(h.technicianDriver.log.length, logBefore, 'stale offer 不得触发任何驱动操作');
  assert.deepEqual(h.technician.state(), { round: round(1, 'technician'), status: 'have-local-offer' });

  // answer 到达 technician，配对成功
  await h.toTechnician.deliverAll();
  assertConverged(h);
  assert.equal(h.maxRound().initiator, 'technician');
});

test('candidate 先于对应 offer/answer 抵达且重复：缓存、按时添加并去重', async () => {
  const h = new Harness();
  await h.requester.negotiate(); // offer 进入 toTechnician 队列

  // 调用方采集 candidate 并发送；它先于 offer 抵达 technician，且重复投递
  sendCandidate(h.requester, h.toTechnician, 'r-cand-0');
  await h.toTechnician.deliverTwice(1); // 队列 [offer, candidate]，先投 candidate 两次
  assert.equal(h.technicianDriver.candidateAdds.length, 0, 'offer 生效前不得添加 candidate');

  // offer 抵达：technician 回答并补加缓存的 candidate（去重后仅一次）
  await h.toTechnician.deliverAll();
  assert.equal(h.technicianDriver.candidateAdds.length, 1, '重复 candidate 只应添加一次');

  // technician 的 candidate 先于 answer 抵达 requester，同样重复投递
  sendCandidate(h.technician, h.toRequester, 't-cand-0');
  await h.toRequester.deliverTwice(1); // 队列 [answer, candidate]
  assert.equal(h.requesterDriver.candidateAdds.length, 0, 'answer 生效前不得添加 candidate');

  // answer 抵达：配对成功并补加缓存的 candidate
  await h.toRequester.deliverAll();
  assert.equal(h.requesterDriver.candidateAdds.length, 1, '重复 candidate 只应添加一次');

  // candidate 添加时刻的远端描述必须属于最终轮次
  const max = h.maxRound();
  const rounds = h.descriptionRounds();
  for (const driver of [h.requesterDriver, h.technicianDriver]) {
    for (const add of driver.candidateAdds) {
      assert.deepEqual(rounds.get(add.remoteDescription!), max, 'candidate 应添加在同轮远端描述上');
    }
  }
  assertConverged(h);
});

test('被取代轮次的延迟 candidate 与 offer 不得串入新轮次', async () => {
  const h = new Harness();
  await Promise.all([h.requester.negotiate(), h.technician.negotiate()]);

  // 双方在看到对方 offer 前各自采集了本端轮次的 candidate
  sendCandidate(h.requester, h.toTechnician, 'stale-r-cand'); // 轮次 {1, requester}
  sendCandidate(h.technician, h.toRequester, 't-cand'); // 轮次 {1, technician}

  // technician 的 offer 先到达 requester：requester 撤销并回答
  await h.toRequester.deliver(0);

  // toTechnician 队列：[stale offer, stale candidate, answer]，乱序全部投递
  await h.toTechnician.deliverAllReversed();
  assert.equal(
    h.technicianDriver.candidateAdds.length,
    0,
    '被取代轮次的 candidate 不得添加到 technician',
  );

  // technician 轮次的 candidate 到达 requester：同轮远端描述已生效，正常添加
  await h.toRequester.deliverAll();
  assert.equal(h.requesterDriver.candidateAdds.length, 1);

  assertConverged(h);
  assert.equal(h.maxRound().initiator, 'technician');
});

test('再次发起：更大轮次取代进行中轮次，迟到的旧 offer 被忽略', async () => {
  const h = new Harness();
  await h.requester.negotiate(); // 轮次 {1, requester}
  await h.requester.negotiate(); // 轮次 {2, requester}，撤销前一轮
  assert.ok(h.requesterDriver.log.includes('rollback -> stable'));
  assert.deepEqual(h.requester.state(), { round: round(2, 'requester'), status: 'have-local-offer' });

  // 旧 offer 先到达（乱序）：technician 采纳轮次 1
  await h.toTechnician.deliver(0);
  assert.deepEqual(h.technician.state().round, round(1, 'requester'));

  // 新 offer 到达：更大轮次取代已配对的轮次 1，重新回答
  await h.toTechnician.deliver(0);
  assert.deepEqual(h.technician.state().round, round(2, 'requester'));

  // 轮次 1 的 answer 迟到：不得破坏轮次 2
  await h.toRequester.deliver(0);
  assert.deepEqual(h.requester.state(), { round: round(2, 'requester'), status: 'have-local-offer' });

  // 轮次 2 的 answer 到达，配对成功
  await h.toRequester.deliverAll();
  assertConverged(h);
  assert.deepEqual(h.maxRound(), round(2, 'requester'));
});
