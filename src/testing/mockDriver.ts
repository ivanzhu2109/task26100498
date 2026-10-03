import { Driver, IceCandidate, Sdp } from '../types';

/** 测试用 SDP 描述：对协调器不透明，但测试驱动可识别类型。 */
export interface MockDescription {
  type: 'offer' | 'answer';
  id: number;
}

export type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer';

export interface CandidateAdd {
  candidate: IceCandidate;
  /** 添加时刻已生效的远端描述。 */
  remoteDescription: MockDescription;
}

/**
 * 测试驱动：用信令状态机校验协调器发起的每一次状态转换，
 * 非法转换立即抛错。语义约束：
 * - 生成操作（createOffer/createAnswer）不改变状态；
 * - offer 仅能在 stable 设置为本地描述；
 * - answer 仅能补齐已设置的对端 offer，配对成功后回到 stable；
 * - rollback 撤销尚未配对的本地 offer 并回到 stable；
 * - candidate 只能在远端描述生效后添加。
 */
export class MockDriver implements Driver {
  signalingState: SignalingState = 'stable';
  localDescription: MockDescription | null = null;
  remoteDescription: MockDescription | null = null;
  readonly candidateAdds: CandidateAdd[] = [];
  readonly log: string[] = [];

  private nextId = 1;

  createOffer(): Promise<Sdp> {
    const before = this.signalingState;
    const desc: MockDescription = { type: 'offer', id: this.nextId++ };
    this.log.push(`createOffer#${desc.id}`);
    this.assertUnchanged(before, 'createOffer');
    return Promise.resolve(desc);
  }

  createAnswer(): Promise<Sdp> {
    const before = this.signalingState;
    const desc: MockDescription = { type: 'answer', id: this.nextId++ };
    this.log.push(`createAnswer#${desc.id}`);
    this.assertUnchanged(before, 'createAnswer');
    return Promise.resolve(desc);
  }

  setLocalDescription(sdp: Sdp): Promise<void> {
    const desc = sdp as MockDescription;
    if (desc.type === 'offer') {
      this.expect('stable', 'setLocalDescription(offer)');
      this.localDescription = desc;
      this.signalingState = 'have-local-offer';
    } else {
      this.expect('have-remote-offer', 'setLocalDescription(answer)');
      this.localDescription = desc;
      this.signalingState = 'stable';
    }
    this.log.push(`setLocal(${desc.type}#${desc.id}) -> ${this.signalingState}`);
    return Promise.resolve();
  }

  setRemoteDescription(sdp: Sdp): Promise<void> {
    const desc = sdp as MockDescription;
    if (desc.type === 'offer') {
      this.expect('stable', 'setRemoteDescription(offer)');
      this.remoteDescription = desc;
      this.signalingState = 'have-remote-offer';
    } else {
      this.expect('have-local-offer', 'setRemoteDescription(answer)');
      this.remoteDescription = desc;
      this.signalingState = 'stable';
    }
    this.log.push(`setRemote(${desc.type}#${desc.id}) -> ${this.signalingState}`);
    return Promise.resolve();
  }

  rollback(): Promise<void> {
    this.expect('have-local-offer', 'rollback');
    this.localDescription = null;
    this.signalingState = 'stable';
    this.log.push('rollback -> stable');
    return Promise.resolve();
  }

  addIceCandidate(candidate: IceCandidate): Promise<void> {
    if (!this.remoteDescription) {
      throw new Error('addIceCandidate: 远端描述尚未生效');
    }
    this.candidateAdds.push({
      candidate,
      remoteDescription: this.remoteDescription,
    });
    this.log.push(`addIceCandidate(remote=#${this.remoteDescription.id})`);
    return Promise.resolve();
  }

  private expect(expected: SignalingState, op: string): void {
    if (this.signalingState !== expected) {
      throw new Error(`${op}: 期望状态 ${expected}，实际 ${this.signalingState}`);
    }
  }

  private assertUnchanged(before: SignalingState, op: string): void {
    if (this.signalingState !== before) {
      throw new Error(`${op}: 生成操作不得改变状态`);
    }
  }
}
