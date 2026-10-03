import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NegotiationCoordinator } from '../src/coordinator.ts';
import type { Opaque, Role, Round, SignalMessage } from '../src/types.ts';
import { FakeDriver } from './fake-driver.ts';

interface Endpoint {
  readonly name: Role;
  readonly coord: NegotiationCoordinator;
  readonly driver: FakeDriver;
  readonly inbox: SignalMessage[];
}

interface Pair {
  readonly requester: Endpoint;
  readonly technician: Endpoint;
  readonly sdpRounds: Map<Opaque, Round>;
}

function makePair(): Pair {
  const sdpRounds = new Map<Opaque, Round>();
  const endpoints = {} as Record<Role, Endpoint>;
  const peerOf: Record<Role, Role> = {
    requester: 'technician',
    technician: 'requester',
  };
  for (const role of ['requester', 'technician'] as const) {
    const driver = new FakeDriver(role);
    const endpoint: Endpoint = {
      name: role,
      driver,
      inbox: [],
      coord: undefined as unknown as NegotiationCoordinator,
    };
    endpoints[role] = endpoint;
    const coord = new NegotiationCoordinator({
      role,
      driver,
      onOffer: (sdp, round) => {
        sdpRounds.set(sdp, round);
        endpoints[peerOf[role]].inbox.push({ kind: 'offer', round, sdp });
      },
      onAnswer: (sdp, round) => {
        sdpRounds.set(sdp, round);
        endpoints[peerOf[role]].inbox.push({ kind: 'answer', round, sdp });
      },
    });
    (endpoint as { coord: NegotiationCoordinator }).coord = coord;
  }
  return { requester: endpoints.requester, technician: endpoints.technician, sdpRounds };
}

/** 逐条投递收件箱中的全部消息（按当前顺序，允许测试中途再塞入）。 */
async function deliverAll(endpoint: Endpoint): Promise<void> {
  while (endpoint.inbox.length > 0) {
    const message = endpoint.inbox.shift()!;
    await endpoint.coord.receive(message);
  }
}

/** 重发一条已投递过的消息（模拟传输层重复）。 */
async function redeliver(endpoint: Endpoint, message: SignalMessage): Promise<void> {
  await endpoint.coord.receive(message);
}

function candidate(round: Round, seq: number, tag: string): SignalMessage {
  return { kind: 'candidate', round, seq, candidate: { tag } };
}

/** 终态不变式：两端 stable，轮次一致，本地/远端描述对应同一最大轮次。 */
function assertConverged(pair: Pair, expected: Round): void {
  for (const ep of [pair.requester, pair.technician]) {
    assert.equal(ep.driver.state, 'stable', `${ep.name} driver state`);
    assert.deepEqual(
      ep.coord.state(),
      { round: expected, signalingState: 'stable' },
      `${ep.name} coordinator state`,
    );
    assert.deepEqual(
      pair.sdpRounds.get(ep.driver.localDesc),
      expected,
      `${ep.name} local description round`,
    );
    assert.deepEqual(
      pair.sdpRounds.get(ep.driver.remoteDesc),
      expected,
      `${ep.name} remote description round`,
    );
  }
}

test('单向发起：offer/answer 配对后两端收敛', async () => {
  const pair = makePair();
  await pair.requester.coord.negotiate();
  assert.deepEqual(pair.requester.coord.state(), {
    round: { count: 1, initiator: 'requester' },
    signalingState: 'have-local-offer',
  });
  await deliverAll(pair.technician);
  await deliverAll(pair.requester);
  assertConverged(pair, { count: 1, initiator: 'requester' });
});

test('双方同时发起：requester 撤销本地 offer，technician 轮次胜出', async () => {
  const pair = makePair();
  await Promise.all([
    pair.requester.coord.negotiate(),
    pair.technician.coord.negotiate(),
  ]);
  assert.equal(pair.requester.driver.state, 'have-local-offer');
  assert.equal(pair.technician.driver.state, 'have-local-offer');

  // 乱序送达：requester 的 offer 先到 technician（被忽略），
  // technician 的 offer 后到 requester（触发撤销 + 应答）。
  await deliverAll(pair.technician);
  assert.equal(
    pair.technician.driver.state,
    'have-local-offer',
    'technician 应忽略同计数下更小的 requester 轮次',
  );
  await deliverAll(pair.requester);
  assert.ok(
    pair.requester.driver.history.some((r) => r.op === 'rollback'),
    'requester 应回滚自己未配对的 offer',
  );
  assert.equal(pair.requester.driver.state, 'stable');

  await deliverAll(pair.technician);
  assertConverged(pair, { count: 1, initiator: 'technician' });
});

test('candidate 先于 offer/answer 抵达且重复：缓冲、去重、按轮次隔离', async () => {
  const pair = makePair();
  const { requester: req, technician: tech } = pair;

  await req.coord.negotiate();
  const round1: Round = { count: 1, initiator: 'requester' };

  // candidate 先于 offer 抵达 technician，且重复送达。
  const c1 = candidate(round1, 1, 'c1');
  const c2 = candidate(round1, 2, 'c2');
  await redeliver(tech, c1);
  await redeliver(tech, c2);
  await redeliver(tech, c1); // 重复
  assert.deepEqual(
    tech.driver.addedCandidates,
    [],
    '远端描述生效前不得添加 candidate',
  );

  // offer 抵达：同轮缓冲 candidate 随远端描述生效而冲刷，且仅添加一次。
  await deliverAll(tech);
  assert.deepEqual(
    tech.driver.addedCandidates.map((c) => (c as { tag: string }).tag),
    ['c1', 'c2'],
  );
  await redeliver(tech, c1); // 已添加过的重复 candidate
  assert.equal(tech.driver.addedCandidates.length, 2);

  // technician 的 candidate 先于 answer 抵达 requester。
  const c3 = candidate(round1, 1, 'c3');
  await redeliver(req, c3);
  await redeliver(req, c3); // 重复
  assert.deepEqual(req.driver.addedCandidates, []);
  await deliverAll(req); // answer 抵达，冲刷缓冲
  assert.deepEqual(
    req.driver.addedCandidates.map((c) => (c as { tag: string }).tag),
    ['c3'],
  );
  assertConverged(pair, round1);

  // technician 发起更大轮次，取代已完成的第 1 轮。
  await tech.coord.negotiate();
  const round2: Round = { count: 2, initiator: 'technician' };
  await deliverAll(req);
  await deliverAll(tech);
  assertConverged(pair, round2);

  // 被淘汰轮次的迟到 candidate 不得串入新轮次。
  const stale1 = candidate(round1, 3, 'stale-for-tech');
  const stale2 = candidate(round1, 2, 'stale-for-req');
  await redeliver(tech, stale1);
  await redeliver(req, stale2);
  assert.deepEqual(
    tech.driver.addedCandidates.map((c) => (c as { tag: string }).tag),
    ['c1', 'c2'],
    '被淘汰轮次的 candidate 不得添加到 technician',
  );
  assert.deepEqual(
    req.driver.addedCandidates.map((c) => (c as { tag: string }).tag),
    ['c3'],
    '被淘汰轮次的 candidate 不得添加到 requester',
  );
});
