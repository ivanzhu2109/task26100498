import { NegotiationCoordinator } from '../coordinator';
import { Message, Round } from '../types';
import { MockDescription, MockDriver } from './mockDriver';

/** 单向信令通道：消息先入队，测试显式控制投递顺序与次数。 */
export class Wire {
  private receiver: NegotiationCoordinator | null = null;
  private readonly pending: Message[] = [];
  /** 所有经过通道的 offer/answer，按发送顺序记录（用于轮次对应断言）。 */
  readonly sentLog: Message[] = [];

  bind(receiver: NegotiationCoordinator): void {
    this.receiver = receiver;
  }

  readonly send = (message: Message): void => {
    this.pending.push(message);
    this.sentLog.push(message);
  };

  get size(): number {
    return this.pending.length;
  }

  peek(index: number): Message {
    return this.pending[index];
  }

  /** 投递队列中第 index 条消息。 */
  async deliver(index = 0): Promise<void> {
    const [message] = this.pending.splice(index, 1);
    if (!message) throw new Error(`deliver: 没有第 ${index} 条消息`);
    await this.receiverOrThrow().receive(message);
  }

  /** 把第 index 条消息原样投递两次（模拟重复送达），只消耗一条队列元素。 */
  async deliverTwice(index = 0): Promise<void> {
    const message = this.pending[index];
    if (!message) throw new Error(`deliverTwice: 没有第 ${index} 条消息`);
    await this.receiverOrThrow().receive(message);
    await this.receiverOrThrow().receive(message);
    this.pending.splice(index, 1);
  }

  /** 逆序投递全部消息（模拟乱序）。 */
  async deliverAllReversed(): Promise<void> {
    while (this.pending.length > 0) {
      await this.deliver(this.pending.length - 1);
    }
  }

  /** 顺序投递全部消息。 */
  async deliverAll(): Promise<void> {
    while (this.pending.length > 0) {
      await this.deliver(0);
    }
  }

  private receiverOrThrow(): NegotiationCoordinator {
    if (!this.receiver) throw new Error('Wire 尚未绑定接收方');
    return this.receiver;
  }
}

/** 双端测试环境：requester 与 technician 各持一个协调器实例。 */
export class Harness {
  readonly requesterDriver = new MockDriver();
  readonly technicianDriver = new MockDriver();
  readonly requester: NegotiationCoordinator;
  readonly technician: NegotiationCoordinator;
  /** requester <- technician 方向的消息队列。 */
  readonly toRequester = new Wire();
  /** technician <- requester 方向的消息队列。 */
  readonly toTechnician = new Wire();

  constructor() {
    this.requester = new NegotiationCoordinator('requester', this.requesterDriver, this.toTechnician.send);
    this.technician = new NegotiationCoordinator('technician', this.technicianDriver, this.toRequester.send);
    this.toRequester.bind(this.requester);
    this.toTechnician.bind(this.technician);
  }

  /** 描述对象 -> 轮次 的对应表（来自两个方向已发送的 offer/answer）。 */
  descriptionRounds(): Map<MockDescription, Round> {
    const map = new Map<MockDescription, Round>();
    for (const wire of [this.toRequester, this.toTechnician]) {
      for (const message of wire.sentLog) {
        if (message.kind === 'candidate') continue;
        const desc = message.sdp as MockDescription;
        map.set(desc, message.round);
      }
    }
    return map;
  }

  /** 已发送 offer/answer 中的最大轮次。 */
  maxRound(): Round {
    let max: Round | null = null;
    for (const round of this.descriptionRounds().values()) {
      if (
        !max ||
        round.count > max.count ||
        (round.count === max.count && round.initiator === 'technician')
      ) {
        max = round;
      }
    }
    if (!max) throw new Error('没有任何 offer/answer 被发送');
    return max;
  }
}

/** 让某端产生一个 candidate 信令并送入对端通道（发送动作模拟调用方）。 */
export function sendCandidate(
  from: NegotiationCoordinator,
  wire: Wire,
  data: string,
): Message {
  const message = from.candidateMessage({ data });
  if (!message) throw new Error('当前没有可用轮次，无法构造 candidate');
  wire.send(message);
  return message;
}
