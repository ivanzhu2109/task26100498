/** 参与端角色。 */
export type Role = 'requester' | 'technician';

/**
 * 协商轮次：递增计数 + 发起端。
 * 比较规则：先比计数；计数相同则 technician 大于 requester。
 */
export interface Round {
  count: number;
  initiator: Role;
}

/** 比较两个轮次大小：a > b 返回正数，相等返回 0，a < b 返回负数。 */
export function compareRound(a: Round, b: Round): number {
  if (a.count !== b.count) return a.count - b.count;
  if (a.initiator === b.initiator) return 0;
  return a.initiator === 'technician' ? 1 : -1;
}

/** SDP 对协调器而言是不透明数据。 */
export type Sdp = unknown;
/** ICE candidate 对协调器而言是不透明数据。 */
export type IceCandidate = unknown;

/** 端与端之间传递的信令消息。 */
export type Message =
  | { kind: 'offer'; round: Round; sdp: Sdp }
  | { kind: 'answer'; round: Round; sdp: Sdp }
  | { kind: 'candidate'; round: Round; seq: number; candidate: IceCandidate };

/** 协调状态。 */
export type NegotiationStatus = 'stable' | 'have-local-offer';

/** state() 返回的当前轮次与协商状态快照。 */
export interface CoordinatorState {
  /** 本端已见轮次（尚未见任何轮次时为 null）。 */
  round: Round | null;
  status: NegotiationStatus;
}

/**
 * 调用方提供的异步驱动（对应 WebRTC 操作子集）。
 * 所有操作最终成功；生成操作不改变状态。
 */
export interface Driver {
  createOffer(): Promise<Sdp>;
  createAnswer(): Promise<Sdp>;
  setLocalDescription(sdp: Sdp): Promise<void>;
  setRemoteDescription(sdp: Sdp): Promise<void>;
  rollback(): Promise<void>;
  addIceCandidate(candidate: IceCandidate): Promise<void>;
}

/** 协调器发送 offer / answer 的回调。 */
export type SendCallback = (message: Message) => void;
