# 不用 ACP 统一各家 agent

这篇回答：Rhodium 用什么方式驱动 Claude、Codex、pi，为什么不套一层统一协议。

前置阅读：[术语表](../../GLOSSARY.md)、[调研摘要](../research.md)

状态：已接受（2026-10-21）。Codex 的接法后来改成每段对话一个私有的 app-server，见 [ADR-0011](0011-codex-private-app-server.md)。不用 ACP 的结论不变。

ACP（Agent Client Protocol）是一个想统一各家 agent 的协议，Claude、Codex、pi 都有 ACP 适配器。Rhodium 不用它，每家都走自己的原生无头接口：

- Claude：`claude -p` 加 stream-json。
- Codex：连它的共享 `codex app-server` 服务。
- pi：`pi --mode rpc`。

Rhodium 给每家写一个驱动，也就是 Rhodium 里负责和这一家 agent 收发消息的那部分代码。三个驱动之上的统一接口由 Rhodium 自己定义，从一开始就按三家设计。

不用 ACP，是因为它丢掉的正好是 Rhodium 最在意的东西（[调研摘要](../research.md) §6）：

- 插话、额度、后台任务，要么不在规范里，要么藏在私有扩展字段里。
- codex-acp 自己拉起一个私有的 app-server，丢掉了共享服务“客户端断开不打断回合”的性质。
- pi-acp 自称还是最小可用版本，把重试和压缩事件降成了普通文本。
- Claude 的适配器 claude-agent-acp 建在官方 TS SDK 上，等于把“SDK 每个版本只配一个 CLI 版本”的绑定又带了回来。

## 考虑过的其他方案

- **用 ACP 统一三家**。好处是接口现成，新 agent 只要有 ACP 适配器就能接。代价就是上面那四条。

## 后果

- 要维护三个驱动，各自跟上游的变化。
- 以后再接别的 agent，也要为它单写驱动，不能靠 ACP 适配器直接接入。
