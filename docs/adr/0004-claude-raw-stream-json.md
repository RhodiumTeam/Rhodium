# Claude 驱动自己实现 stream-json 通信，不用 Agent SDK

这篇回答：Rhodium 怎样和无头 Claude 通信，为什么不用 Anthropic 官方的 Agent SDK。

前置阅读：[术语表](../../GLOSSARY.md)、[产品说明](../product.md)、[调研摘要](../research.md)

状态：已接受（2026-10-21）。取代同一天早些时候的选择：用官方 Agent SDK，无头用 SDK 自带的 `claude`。

无头 Claude 是 `claude -p --input-format stream-json --output-format stream-json`。stdin 和 stdout 上一行一条 JSON。其中一部分是控制请求：发出方要等对方回一个应答，例如审批。

下文的“驱动”指 Rhodium 里负责和某一家 agent 收发消息的那部分代码。

Rhodium 用 TypeScript 自己实现 Claude 驱动，估算 500–800 行。无头和终端用系统里同一个 `claude`，照常自动更新。合规要求不变，见[产品说明](../product.md) §12。

不用 SDK，是因为它和 CLI 绑死：SDK 0.3.N 只配 CLI 2.1.N，还自带一份 CLI。当时的原话是：“既然 SDK 也不稳定，那我们就用 claude -p 自己实现通信”。

代码来源：

- 逻辑照官方 Python SDK 移植。它是 MIT 许可，移植的文件保留它的版权声明。
- 字段名对照官方 TS SDK 的类型文件 `sdk.d.ts`，只读，不复制。TS SDK 的许可是“All rights reserved”。

## 考虑过的其他方案

- **SDK 加它自带的 claude**（原先的选择）。无头的 `claude` 要等升级 SDK 时才更新，比终端里的旧。旧版能不能接着新版写过的对话往下跑，没有验证。
- **SDK 加系统里的 claude**。两边版本必须一致，只能关掉自动更新，你终端里的 Claude 也跟着停更。
- **直接用 HAPI 的现成代码**。HAPI 是一个手机遥控 Claude 和 Codex 的开源项目，也用 TypeScript 实现了这套通信。但它的许可是 AGPL-3.0，而且只实现了审批、中断、撤回三种控制消息。

## 后果

- 协议变化要自己兜。`claude` 大约一天一版：2026-07-08 到 10-19 发了约 100 个版本（npm 发布日期）。防线有四道：
  - 不认识的消息类型和字段一律跳过，不报错。
  - 新功能看 `claude` 在 `system/init` 消息里声明的 `capabilities` 判断，不看版本号。
  - 托管进程存下的真实对话，挑一些做回放测试。
  - `claude` 版本一变，`rh doctor` 先离线核对二进制里的协议字符串，再起一个只握手、不跑模型的进程核对应答。
- Rhodium 自己不通过控制协议注册 hook 回调，也不提供进程内 MCP 服务器。这两种机制要求 Rhodium 在回合中途随时在线作答，Rhodium 一重启就失效。Rhodium 要给 agent 加工具时，用独立进程的 MCP 服务器。
- 你 settings 里的 hook 和 MCP 不受上一条影响，照常加载（[产品说明](../product.md) §4.1）。
- 审批同样要 Rhodium 作答，但不怕重启。Rhodium 重连后重发 `initialize`，`claude` 会把还没答的审批重新交出来（2.1.268 起）。
