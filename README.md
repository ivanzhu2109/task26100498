# task26100498

HelpTunnel 双端 WebRTC 协商协调器（TypeScript）。Requester 与 Technician
各持一个 `NegotiationCoordinator` 实例，信令传输、本地 ICE 采集与发送均由
调用方负责；协调器不建立连接、不解析 SDP，SDP 与 candidate 均为不透明数据。

## 运行

```sh
npm run build   # 类型检查（本机 TypeScript 5.4，见 node_modules 软链）
npm test        # node --test，Node 24 原生运行 TS
```

## API

```ts
const coord = new NegotiationCoordinator({
  role: 'requester',          // 或 'technician'
  driver,                     // 调用方提供的异步驱动（见下）
  onOffer: (sdp, round) => sendToPeer({ kind: 'offer', round, sdp }),
  onAnswer: (sdp, round) => sendToPeer({ kind: 'answer', round, sdp }),
});

await coord.negotiate();      // 发起新一轮协商（轮次 = 已见最大计数+1，发起端为本端）
await coord.receive(message); // 接收对端信令（offer / answer / candidate）
coord.state();                // { round, signalingState }
```

本地 ICE candidate 由调用方采集并按 `state().round` 标记轮次、分配轮次内唯一
`seq` 后自行发送：`{ kind: 'candidate', round, seq, candidate }`。

## 驱动约定（PeerDriver）

协调器只通过驱动操作连接，并保证调用时序合法（合法调用最终成功）：

- `createOffer` / `createAnswer` 不改变状态；`createAnswer` 仅用于补齐已设置的远端 offer。
- `setLocalOffer` 仅在 stable；`setLocalAnswer` 配对后回到 stable。
- `setRemoteOffer` 仅在 stable；`setRemoteAnswer` 配对后回到 stable。
- `rollback` 撤销尚未配对的 offer（本地或远端），回到 stable。
- `addCandidate` 仅在同轮远端描述生效后调用，同一 `(round, seq)` 最多一次。

## 协商规则

- 轮次 = `{ count, initiator }`：先比计数，同计数时 technician 较大。
- 已见轮次只在本端发起或接受更大 offer 时推进；answer 沿用 offer 轮次。
- 较大轮次取代进行中的轮次（未配对的 offer 被 rollback）；被取代轮次的
  迟到 offer / answer / candidate 一律忽略。
- candidate 先于同轮 offer / answer 抵达时缓冲，远端描述生效时按序冲刷；
  按 `(round, seq)` 去重。

## 测试

`test/coordinator.test.ts` 使用 `test/fake-driver.ts`（对每次调用做状态机
合法性检查）覆盖：

- 单向发起后两端收敛到同一最大轮次、均为 stable；
- 双方同时发起：requester 回滚未配对 offer，technician 轮次胜出并完成配对；
- candidate 先于 offer / answer 抵达且重复：验证添加时刻、去重，以及被
  淘汰轮次的迟到 candidate 不串入新轮次。
