import type { Opaque, PeerDriver } from '../src/types.ts';

type DriverState = 'stable' | 'have-local-offer' | 'have-remote-offer';

export interface DriverRecord {
  readonly op: string;
  readonly stateBefore: DriverState;
  readonly sdp?: Opaque;
  readonly candidate?: Opaque;
}

/**
 * 测试驱动：模拟真实端点的状态机，对每一次调用做合法性检查，
 * 任何非法状态转换都会立即抛错使测试失败。
 *
 * 规则：
 * - createOffer / createAnswer 不改变状态；createAnswer 仅能在 have-remote-offer。
 * - setLocalOffer 仅 stable；setLocalAnswer 仅 have-remote-offer（配对后回 stable）。
 * - setRemoteOffer 仅 stable；setRemoteAnswer 仅 have-local-offer（配对后回 stable）。
 * - rollback 撤销尚未配对的 offer（本地或远端），回到 stable。
 * - addCandidate 要求远端描述已生效。
 */
export class FakeDriver implements PeerDriver {
  state: DriverState = 'stable';
  remoteDescSet = false;
  localDesc: Opaque = null;
  remoteDesc: Opaque = null;
  readonly addedCandidates: Opaque[] = [];
  readonly history: DriverRecord[] = [];
  private offerSeq = 0;
  private answerSeq = 0;

  private readonly name: string;

  constructor(name: string) {
    this.name = name;
  }

  private record(entry: DriverRecord): void {
    this.history.push(entry);
  }

  private fail(op: string): never {
    throw new Error(
      `${this.name}: illegal ${op} in state ${this.state} (remoteDescSet=${this.remoteDescSet})`,
    );
  }

  async createOffer(): Promise<Opaque> {
    this.record({ op: 'createOffer', stateBefore: this.state });
    return { tag: 'offer', by: this.name, n: ++this.offerSeq };
  }

  async createAnswer(): Promise<Opaque> {
    if (this.state !== 'have-remote-offer') this.fail('createAnswer');
    this.record({ op: 'createAnswer', stateBefore: this.state });
    return { tag: 'answer', by: this.name, n: ++this.answerSeq };
  }

  async setLocalOffer(sdp: Opaque): Promise<void> {
    if (this.state !== 'stable') this.fail('setLocalOffer');
    this.record({ op: 'setLocalOffer', stateBefore: this.state, sdp });
    this.state = 'have-local-offer';
    this.localDesc = sdp;
  }

  async setLocalAnswer(sdp: Opaque): Promise<void> {
    if (this.state !== 'have-remote-offer') this.fail('setLocalAnswer');
    this.record({ op: 'setLocalAnswer', stateBefore: this.state, sdp });
    this.state = 'stable';
    this.localDesc = sdp;
  }

  async setRemoteOffer(sdp: Opaque): Promise<void> {
    if (this.state !== 'stable') this.fail('setRemoteOffer');
    this.record({ op: 'setRemoteOffer', stateBefore: this.state, sdp });
    this.state = 'have-remote-offer';
    this.remoteDesc = sdp;
    this.remoteDescSet = true;
  }

  async setRemoteAnswer(sdp: Opaque): Promise<void> {
    if (this.state !== 'have-local-offer') this.fail('setRemoteAnswer');
    this.record({ op: 'setRemoteAnswer', stateBefore: this.state, sdp });
    this.state = 'stable';
    this.remoteDesc = sdp;
    this.remoteDescSet = true;
  }

  async rollback(): Promise<void> {
    if (this.state === 'stable') this.fail('rollback');
    this.record({ op: 'rollback', stateBefore: this.state });
    if (this.state === 'have-local-offer') this.localDesc = null;
    if (this.state === 'have-remote-offer') {
      this.remoteDesc = null;
      this.remoteDescSet = false;
    }
    this.state = 'stable';
  }

  async addCandidate(candidate: Opaque): Promise<void> {
    if (!this.remoteDescSet) this.fail('addCandidate');
    this.record({ op: 'addCandidate', stateBefore: this.state, candidate });
    this.addedCandidates.push(candidate);
  }
}
