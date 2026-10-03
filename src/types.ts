/** 不透明数据：协调器不解析、不修改，仅透传。 */
export type Opaque = unknown;

/** 端角色：发起协助的请求方与提供协助的技术方。 */
export type Role = 'requester' | 'technician';

/** 协商轮次：递增计数 + 发起端。先比计数，同计数时 technician 较大。 */
export interface Round {
  readonly count: number;
  readonly initiator: Role;
}

export interface OfferMessage {
  readonly kind: 'offer';
  readonly round: Round;
  readonly sdp: Opaque;
}

export interface AnswerMessage {
  readonly kind: 'answer';
  readonly round: Round;
  readonly sdp: Opaque;
}

export interface CandidateMessage {
  readonly kind: 'candidate';
  readonly round: Round;
  /** 轮次内唯一消息号，用于去重。 */
  readonly seq: number;
  readonly candidate: Opaque;
}

export type SignalMessage = OfferMessage | AnswerMessage | CandidateMessage;

/** 协调器跟踪的信令状态（镜像调用方驱动的状态机）。 */
export type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer';

export interface CoordinatorState {
  /** 本端已见最大轮次；尚未参与任何协商时为 null。 */
  readonly round: Round | null;
  readonly signalingState: SignalingState;
}

/**
 * 调用方提供的异步驱动。协调器只通过它操作连接，不解析任何 SDP。
 *
 * 约定（合法调用最终成功）：
 * - createOffer / createAnswer 不改变状态；createAnswer 仅能在 have-remote-offer 下调用。
 * - setLocalOffer 仅能在 stable 下调用，进入 have-local-offer。
 * - setLocalAnswer 仅能在 have-remote-offer 下调用，配对成功回到 stable。
 * - setRemoteOffer 仅能在 stable 下调用，进入 have-remote-offer。
 * - setRemoteAnswer 仅能在 have-local-offer 下调用，配对成功回到 stable。
 * - rollback 撤销尚未配对的本地 offer，回到 stable。
 * - addCandidate 要求远端描述已生效。
 */
export interface PeerDriver {
  createOffer(): Promise<Opaque>;
  createAnswer(): Promise<Opaque>;
  setLocalOffer(sdp: Opaque): Promise<void>;
  setLocalAnswer(sdp: Opaque): Promise<void>;
  setRemoteOffer(sdp: Opaque): Promise<void>;
  setRemoteAnswer(sdp: Opaque): Promise<void>;
  rollback(): Promise<void>;
  addCandidate(candidate: Opaque): Promise<void>;
}

export interface CoordinatorCallbacks {
  /** 协调器生成本地 offer 后，通过该回调交给调用方发送。 */
  onOffer(sdp: Opaque, round: Round): void;
  /** 协调器生成本地 answer 后，通过该回调交给调用方发送。 */
  onAnswer(sdp: Opaque, round: Round): void;
}
