# TUI 交给 Herdr，不自建终端宿主

这篇回答：TUI 模式的槽位跑在哪里，为什么不自己写一个终端宿主。

前置阅读：[术语表](../../GLOSSARY.md)、[产品说明](../product.md)、[调研摘要](../research.md)

状态：已接受（2026-10-21）

TUI 模式的槽位跑在 Herdr 的一个 pane 里。Herdr 是你已经在用的终端多路复用工具，和 tmux 类似，多了 agent 状态。一个 Rhodium 工作区对应一个 Herdr workspace。

Rhodium 只用 Herdr 公开的命令行和 socket JSON 接口，不碰它的私有二进制协议，也不改你的 Herdr 配置。

不自建，是因为终端兼容的边角问题太多。自建终端宿主的最小版本估算 1.5–3 人周，做到可用估算再加 4–8 周（[调研摘要](../research.md) §6）。Herdr 0.9.4 一个版本就修了约 15 条这类问题。

另一个好处：v3 要在网页里嵌终端时，可以直接用 Herdr 公开的 `herdr terminal session observe/control`。

## 考虑过的其他方案

- **tmux**。协议稳定，内存小。但它没有 agent 状态接口，网页嵌入时终端画面的状态要自己维护。

## 后果

- Herdr server 重启会结束 pane 里的进程。Rhodium 不看 pane 还在不在，只看 agent 进程还活着没有。进程没了，就把槽位切回无头并通知你。完整规则见[产品说明](../product.md) §4.2。
- Herdr 重启后，可能按它的默认配置 `resume_agents_on_restore` 用 `claude --resume` 把 pane 里的 agent 拉起来。Rhodium 起无头进程前要再查一遍，避免两个进程写同一段对话。
- Herdr 大约 10 天发一版。它的私有终端协议 3 个月里变了 4 次，这是只用公开接口的原因。
