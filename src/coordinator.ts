import type {
  CandidateMessage,
  CoordinatorCallbacks,
  CoordinatorState,
  Opaque,
  PeerDriver,
  Role,
  Round,
  SignalMessage,
} from './types.ts';

/** 轮次比较：先比计数，同计数时 technician 较大。 */
export function compareRounds(a: Round, b: Round): number {
  if (a.count !== b.count) return a.count - b.count;
  if (a.initiator === b.initiator) return 0;
  return a.initiator === 'technician' ? 1 : -1;
}

export function roundEquals(a: Round, b: Round): boolean {
  return compareRounds(a, b) === 0;
}

function roundKey(round: Round): string {
  return `${round.count}:${round.initiator}`;
}

export interface CoordinatorOptions extends CoordinatorCallbacks {
  readonly role: Role;
  readonly driver: PeerDriver;
}

/**
 * HelpTunnel 双端 WebRTC 协商协调器。
 * Requester 与 Technician 各持一个实例，信令传输由调用方完成。
 *
 * 不变式：
 * - seenRound 只在本端发起协商或接受更大 offer 时推进，单调不减。
 * - remoteDescRound 始终等于设置该远端描述时的 seenRound。
 * - candidate 仅在其轮次的远端描述生效期间添加，且按 (round, seq) 去重。
 */
export class NegotiationCoordinator {
  private readonly role: Role;
  private readonly driver: PeerDriver;
  private readonly onOffer: CoordinatorCallbacks['onOffer'];
  private readonly onAnswer: CoordinatorCallbacks['onAnswer'];

  private seenRound: Round | null = null;
  private signaling: CoordinatorState['signalingState'] = 'stable';
  private localOfferRound: Round | null = null;
  private remoteDescRound: Round | null = null;

  private readonly addedCandidates = new Set<string>();
  private readonly bufferedCandidates = new Map<string, CandidateMessage[]>();
  private readonly bufferedSeqs = new Map<string, Set<number>>();

  private chain: Promise<void> = Promise.resolve();

  constructor(options: CoordinatorOptions) {
    this.role = options.role;
    this.driver = options.driver;
    this.onOffer = options.onOffer;
    this.onAnswer = options.onAnswer;
  }

  /** 发起新一轮协商。 */
  async negotiate(): Promise<void> {
    return this.enqueue(async () => {
      const round: Round = {
        count: (this.seenRound?.count ?? 0) + 1,
        initiator: this.role,
      };
      await this.ensureStable();
      this.seenRound = round;
      const sdp = await this.driver.createOffer();
      await this.driver.setLocalOffer(sdp);
      this.signaling = 'have-local-offer';
      this.localOfferRound = round;
      this.onOffer(sdp, round);
    });
  }

  /** 接收一条信令消息。 */
  async receive(message: SignalMessage): Promise<void> {
    return this.enqueue(async () => {
      switch (message.kind) {
        case 'offer':
          await this.handleOffer(message.round, message.sdp);
          break;
        case 'answer':
          await this.handleAnswer(message.round, message.sdp);
          break;
        case 'candidate':
          await this.handleCandidate(message);
          break;
      }
    });
  }

  /** 查看当前轮次与协商状态。 */
  state(): CoordinatorState {
    return { round: this.seenRound, signalingState: this.signaling };
  }

  private enqueue(op: () => Promise<void>): Promise<void> {
    const run = this.chain.then(op);
    this.chain = run.catch(() => {});
    return run;
  }

  /** 撤销尚未配对的 offer（无论本地还是远端），回到 stable。 */
  private async ensureStable(): Promise<void> {
    if (this.signaling === 'stable') return;
    await this.driver.rollback();
    this.signaling = 'stable';
    this.localOfferRound = null;
  }

  private async handleOffer(round: Round, sdp: Opaque): Promise<void> {
    if (this.seenRound !== null && compareRounds(round, this.seenRound) <= 0) {
      return; // 重复或已被更大轮次取代的 offer
    }
    await this.ensureStable();
    this.seenRound = round;
    await this.driver.setRemoteOffer(sdp);
    this.signaling = 'have-remote-offer';
    await this.setRemoteDescRound(round);
    const answer = await this.driver.createAnswer();
    await this.driver.setLocalAnswer(answer);
    this.signaling = 'stable';
    this.onAnswer(answer, round);
  }

  private async handleAnswer(round: Round, sdp: Opaque): Promise<void> {
    if (
      this.signaling !== 'have-local-offer' ||
      this.localOfferRound === null ||
      !roundEquals(round, this.localOfferRound)
    ) {
      return; // 重复或已被取代轮次的 answer
    }
    await this.driver.setRemoteAnswer(sdp);
    this.signaling = 'stable';
    this.localOfferRound = null;
    await this.setRemoteDescRound(round);
  }

  private async handleCandidate(message: CandidateMessage): Promise<void> {
    const key = `${roundKey(message.round)}#${message.seq}`;
    if (this.addedCandidates.has(key)) return;
    if (
      this.remoteDescRound !== null &&
      roundEquals(message.round, this.remoteDescRound)
    ) {
      await this.driver.addCandidate(message.candidate);
      this.addedCandidates.add(key);
      return;
    }
    if (
      this.seenRound !== null &&
      compareRounds(message.round, this.seenRound) < 0
    ) {
      return; // 被取代轮次的迟到 candidate，其远端描述不会再生效
    }
    const rk = roundKey(message.round);
    let seqs = this.bufferedSeqs.get(rk);
    if (seqs === undefined) {
      seqs = new Set();
      this.bufferedSeqs.set(rk, seqs);
      this.bufferedCandidates.set(rk, []);
    }
    if (seqs.has(message.seq)) return; // 缓冲期内重复送达
    seqs.add(message.seq);
    this.bufferedCandidates.get(rk)!.push(message);
  }

  /** 记录新生效的远端描述轮次，并冲刷同轮缓冲 candidate、清理旧轮次。 */
  private async setRemoteDescRound(round: Round): Promise<void> {
    this.remoteDescRound = round;
    const flush: CandidateMessage[] = [];
    for (const [rk, messages] of this.bufferedCandidates) {
      const cmp = compareRounds(messages[0].round, round);
      if (cmp > 0) continue; // 未来轮次的 candidate 继续等待其远端描述
      this.bufferedCandidates.delete(rk);
      this.bufferedSeqs.delete(rk);
      if (cmp === 0) flush.push(...messages);
      // cmp < 0：被取代轮次的迟到 candidate，丢弃
    }
    for (const message of flush) {
      const key = `${roundKey(message.round)}#${message.seq}`;
      if (this.addedCandidates.has(key)) continue;
      await this.driver.addCandidate(message.candidate);
      this.addedCandidates.add(key);
    }
  }
}
