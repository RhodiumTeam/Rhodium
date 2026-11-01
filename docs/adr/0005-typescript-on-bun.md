# 主程序用 TypeScript + Bun

这篇回答：`rhodium` 和 `rh` 用什么语言和运行时写，为什么。

前置阅读：[术语表](../../GLOSSARY.md)、[产品说明](../product.md)、[调研摘要](../research.md)

状态：已接受（2026-10-21）

`rhodium` 常驻进程和 `rh` 命令行用 TypeScript 写，跑在 Bun 上，编成一个单文件可执行程序。托管进程是例外，用 Rust。

选 TypeScript，有三个原因：

- 只有 TypeScript 在五个 IM 平台上都有在维护的 SDK（[调研摘要](../research.md) §5）。
- agent 的消息类型有现成的 TypeScript 版可以对照：pi 本身就是 TypeScript，Codex 能直接生成 TypeScript 类型。换别的语言要手抄。
- qq-cli 就是 Bun 上的 TypeScript。它的额度计数、分块、配对等代码和测试能直接搬过来。

选 Bun 而不是 Node，是因为空闲内存只有 Node 的三分之一左右（本机实测，见[调研摘要](../research.md) §1）。Bun 还自带 SQLite，能编成单文件。

## 考虑过的其他方案

- **Rust**。重视内存，但 Rhodium 自身不是大头。每个 Claude 终端进程 340–440MB（本机实测），无头进程估计相近（待验证）。整个 Rhodium 换成 Rust，估算只省约 80MB。代价是 QQ、微信 iLink、飞书没有可用的 Rust SDK，这几个平台的接入要从头写。

## 后果

- 省内存靠空闲回收，不靠换语言（[产品说明](../product.md) §2）。
