# HelpTunnel 协商协调器

HelpTunnel 双端 WebRTC 协商协调器（TypeScript）。Requester 与 Technician 各持有一个
`NegotiationCoordinator` 实例，信令由调用方传递。SDP 与 candidate 均为不透明数据，
协调器不做连接建立或 SDP 解析；本地 ICE 采集与发送由调用方负责。

## 构建与测试

```sh
npm run build   # tsc 编译到 dist/
npm test        # 编译并运行 node:test 自动化测试
```

## 使用

```ts
import { NegotiationCoordinator } from './src/coordinator';
import { Driver, Message } from './src/types';

// 调用方实现异步驱动（对应 WebRTC 操作子集）
const driver: Driver = {
  createOffer: () => pc.createOffer().then(() => pc.localDescription),
  createAnswer: () => pc.createAnswer().then(() => pc.localDescription),
  setLocalDescription: (sdp) => pc.setLocalDescription(sdp as any),
  setRemoteDescription: (sdp) => pc.setRemoteDescription(sdp as any),
  rollback: () => pc.setLocalDescription({ type: 'rollback' } as any),
  addIceCandidate: (c) => pc.addIceCandidate(c as any),
};

// send 回调把 offer/answer 交给调用方的信令通道
const coordinator = new NegotiationCoordinator('requester', driver, (message: Message) => {
  signalingChannel.send(message);
});

await coordinator.negotiate();                 // 发起新一轮协商
signalingChannel.onmessage = (m) => coordinator.receive(m); // 接收对端信令
const { round, status } = coordinator.state(); // 查看当前轮次与协商状态

// 本地 ICE 采集：用 candidateMessage 包装后由调用方发送
pc.onicecandidate = () => {
  const message = coordinator.candidateMessage(pc.localDescription /* candidate */);
  if (message) signalingChannel.send(message);
};
```

## 语义要点

- **轮次**：`{count, initiator}`，先比计数，同计数时 technician 较大。新发起轮次必须
  大于本端已见轮次；只有本端发起或收到更大 offer 才推进已见轮次。
- **answer** 沿用 offer 轮次；**candidate** 携带轮次与轮次内唯一消息号。
- 信令可延迟、重复、乱序：重复 offer 幂等重答，重复 candidate 去重，被取代轮次的
  迟到消息一律忽略；较大轮次取代进行中轮次（必要时 rollback 未配对的 offer）。
- candidate 只有在同轮远端描述生效后才添加，先到者缓存等待；同一消息最多添加一次。

## 目录

- `src/types.ts` — 轮次、消息、驱动接口等类型定义
- `src/coordinator.ts` — 协调器实现
- `src/testing/mockDriver.ts` — 校验状态转换的测试驱动
- `src/testing/harness.ts` — 可控投递（延迟/重复/乱序）的双端测试环境
- `test/coordinator.test.ts` — 自动化测试
