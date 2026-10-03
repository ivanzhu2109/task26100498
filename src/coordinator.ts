import {
  compareRound,
  CoordinatorState,
  Driver,
  IceCandidate,
  Message,
  NegotiationStatus,
  Round,
  Role,
  SendCallback,
  Sdp,
} from './types';

function roundKey(round: Round): string {
  return `${round.count}:${round.initiator}`;
}

/**
 * HelpTunnel 双端 WebRTC 协商协调器。
 * Requester 与 Technician 各持一个实例，信令由调用方传递。
 *
 * - SDP 与 candidate 均为不透明数据，不做连接建立或 SDP 解析。
 * - 通过回调发送 offer / answer；candidate 由调用方采集并发送
 *   （用 candidateMessage() 包装出携带轮次与消息号的信令）。
 * - 内部串行化所有异步驱动操作，信令可延迟、重复、乱序。
 */
export class NegotiationCoordinator {
  private readonly role: Role;
  private readonly driver: Driver;
  private readonly send: SendCallback;

  /** 本端已见轮次（仅由本端发起或收到更大 offer 推进）。 */
  private lastSeen: Round | null = null;
  private status: NegotiationStatus = 'stable';
  /** 当前轮次的远端描述是否已成功生效。 */
  private remoteApplied = false;
  /** 当前轮次已添加的 candidate 消息号（去重）。 */
  private readonly addedSeq = new Set<number>();
  /** 当前轮次下一个 candidate 消息号。 */
  private nextSeq = 0;
  /** 已回答的 offer 轮次及缓存的 answer，用于重复 offer 的幂等重答。 */
  private answered: { round: Round; sdp: Sdp } | null = null;
  /** 等待对应轮次远端描述生效的 candidate 缓存。 */
  private readonly buffered = new Map<string, { round: Round; seq: number; candidate: IceCandidate }[]>();
  /** 串行化队列：保证驱动操作不交错。 */
  private queue: Promise<void> = Promise.resolve();

  constructor(role: Role, driver: Driver, send: SendCallback) {
    this.role = role;
    this.driver = driver;
    this.send = send;
  }

  /** 发起新一轮协商：新轮次必须大于本端已见轮次。 */
  negotiate(): Promise<void> {
    return this.enqueue(async () => {
      if (this.status === 'have-local-offer') {
        await this.driver.rollback();
        this.status = 'stable';
      }
      const round: Round = {
        count: (this.lastSeen ? this.lastSeen.count : 0) + 1,
        initiator: this.role,
      };
      const offer = await this.driver.createOffer();
      await this.driver.setLocalDescription(offer);
      this.adoptRound(round);
      this.status = 'have-local-offer';
      this.send({ kind: 'offer', round, sdp: offer });
    });
  }

  /** 接收对端信令。 */
  receive(message: Message): Promise<void> {
    return this.enqueue(async () => {
      switch (message.kind) {
        case 'offer':
          await this.onOffer(message.round, message.sdp);
          return;
        case 'answer':
          await this.onAnswer(message.round, message.sdp);
          return;
        case 'candidate':
          await this.onCandidate(message.round, message.seq, message.candidate);
          return;
      }
    });
  }

  /** 查看当前轮次与协商状态。 */
  state(): CoordinatorState {
    return { round: this.lastSeen, status: this.status };
  }

  /**
   * 为调用方构造 candidate 信令：携带当前轮次与轮次内唯一消息号。
   * 尚未进入任何轮次时返回 null。发送动作由调用方负责。
   */
  candidateMessage(candidate: IceCandidate): Message | null {
    if (!this.lastSeen) return null;
    const seq = this.nextSeq;
    this.nextSeq += 1;
    return { kind: 'candidate', round: this.lastSeen, seq, candidate };
  }

  private async onOffer(round: Round, sdp: Sdp): Promise<void> {
    const cmp = this.lastSeen ? compareRound(round, this.lastSeen) : 1;
    if (cmp < 0) return; // 被取代轮次的迟到 offer，忽略
    if (cmp === 0) {
      // 当前轮次的重复 offer：幂等重发缓存的 answer
      if (
        round.initiator !== this.role &&
        this.answered &&
        compareRound(this.answered.round, round) === 0
      ) {
        this.send({ kind: 'answer', round, sdp: this.answered.sdp });
      }
      return;
    }
    // 更大轮次：取代进行中的轮次
    if (this.status === 'have-local-offer') {
      await this.driver.rollback();
      this.status = 'stable';
    }
    this.dropStaleBuffers(round);
    await this.driver.setRemoteDescription(sdp);
    const answer = await this.driver.createAnswer();
    await this.driver.setLocalDescription(answer);
    this.adoptRound(round);
    this.remoteApplied = true;
    this.answered = { round, sdp: answer };
    this.send({ kind: 'answer', round, sdp: answer });
    await this.flushCandidates(round);
  }

  private async onAnswer(round: Round, sdp: Sdp): Promise<void> {
    // answer 只能补齐本端已设置且尚未配对的 offer
    if (this.status !== 'have-local-offer') return;
    if (!this.lastSeen || compareRound(round, this.lastSeen) !== 0) return;
    await this.driver.setRemoteDescription(sdp);
    this.status = 'stable';
    this.remoteApplied = true;
    await this.flushCandidates(round);
  }

  private async onCandidate(round: Round, seq: number, candidate: IceCandidate): Promise<void> {
    if (this.lastSeen && compareRound(round, this.lastSeen) < 0) {
      return; // 被取代轮次的 candidate，丢弃
    }
    if (!this.lastSeen || compareRound(round, this.lastSeen) > 0 || !this.remoteApplied) {
      // 对应 offer/answer 尚未抵达或生效，缓存等待
      const key = roundKey(round);
      const list = this.buffered.get(key) ?? [];
      list.push({ round, seq, candidate });
      this.buffered.set(key, list);
      return;
    }
    if (this.addedSeq.has(seq)) return; // 同一消息最多添加一次
    this.addedSeq.add(seq);
    await this.driver.addIceCandidate(candidate);
  }

  /** 推进已见轮次并重置轮次内状态。 */
  private adoptRound(round: Round): void {
    this.lastSeen = round;
    this.remoteApplied = false;
    this.addedSeq.clear();
    this.nextSeq = 0;
  }

  /** 轮次推进后，丢弃被取代轮次缓存的 candidate。 */
  private dropStaleBuffers(newRound: Round): void {
    for (const [key, list] of this.buffered) {
      if (list.length > 0 && compareRound(list[0].round, newRound) < 0) {
        this.buffered.delete(key);
      }
    }
  }

  /** 同轮远端描述生效后，补加缓存的 candidate（去重）。 */
  private async flushCandidates(round: Round): Promise<void> {
    const list = this.buffered.get(roundKey(round));
    if (!list) return;
    this.buffered.delete(roundKey(round));
    for (const item of list) {
      if (this.addedSeq.has(item.seq)) continue;
      this.addedSeq.add(item.seq);
      await this.driver.addIceCandidate(item.candidate);
    }
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
