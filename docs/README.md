# 文档地图

这篇回答：仓库里有哪些文档，各自回答什么问题，按什么顺序读。

前置阅读：无

这里的文档多数由 agent 编写，也以 agent 为读者。

文档按依赖关系排成一张图：箭头从上游指向下游，下游文档只引用它的上游。第一次读，从上往下读即可。

```mermaid
flowchart TD
  classDef doc fill:#f4ebe1,stroke:#8a5a2b,color:#1d1d1b
  G["GLOSSARY.md<br/>术语表"]:::doc
  P["docs/product.md<br/>产品：是什么、怎么表现"]:::doc
  R["docs/research.md<br/>调研：借鉴了谁"]:::doc
  D["docs/adr/<br/>14 篇架构决定"]:::doc
  A["docs/architecture.md<br/>架构：怎么实现"]:::doc
  S["docs/spec/v1.md<br/>v1 规格：做什么、怎么验收"]:::doc
  SW["docs/spec/web-chat.md<br/>网页对话界面规格"]:::doc
  ST["docs/spec/web-topology.md<br/>网页拓扑图规格"]:::doc
  S2["docs/spec/bot-programs.md<br/>Bot 程序规格"]:::doc
  SR["docs/spec/web-write.md<br/>网页能写规格"]:::doc
  TE["docs/spec/web-terminal.md<br/>网页终端规格"]:::doc
  SI["docs/spec/im-buttons.md<br/>IM 按钮行规格"]:::doc
  SQ["docs/spec/info-commands.md<br/>查询命令规格"]:::doc
  SM["docs/spec/web-maximize.md<br/>网页放大模式规格"]:::doc
  SF["docs/spec/feishu.md<br/>飞书连接器规格"]:::doc
  SC["docs/spec/codex.md<br/>Codex 驱动规格"]:::doc
  SG["docs/spec/web-images.md<br/>网页图片、复制和引用规格"]:::doc
  TI["docs/spec/tui-input.md<br/>TUI 槽位的输入规格"]:::doc
  TU["docs/spec/tui-user-input.md<br/>TUI 槽位的输入第二批规格"]:::doc
  WI["docs/spec/web-import-composer.md<br/>网页新建导入和输入框规格"]:::doc
  WB["docs/spec/web-bots.md<br/>网页管 Bot 规格"]:::doc
  WX["docs/spec/web-exchanges.md<br/>对话页的宽度、刻度条和 rh send 规格"]:::doc
  I["docs/im-style.md<br/>IM 文字与交互规范"]:::doc
  G --> P
  G --> R
  P --> D
  R --> D
  D --> A
  A --> I
  I --> S
  S --> SW
  SW --> ST
  S --> S2
  ST --> SR
  SR --> TE
  S --> SI
  SR --> SQ
  SI --> SQ
  TE --> SM
  SQ --> SM
  SI --> SF
  SQ --> SC
  SR --> SG
  TE --> TI
  TI --> TU
  SM --> WI
  TU --> WI
  WI --> WB
  ST --> WB
  SR --> WB
  SG --> WX
  SM --> WX
```

| 文档 | 回答什么问题 |
|---|---|
| [GLOSSARY.md](../GLOSSARY.md) | 槽位、目标、绑定、联系窗口……这些词是什么意思 |
| [docs/product.md](product.md) | Rhodium 是什么、在各种情况下怎么表现、每项功能放在哪一版 |
| [docs/research.md](research.md) | 设计参考了哪些现成项目、借了什么、避开了什么坑 |
| [docs/adr/](adr/) | 每个难以撤销的架构决定：选了什么、为什么 |
| [docs/architecture.md](architecture.md) | 怎么实现：进程、协议、数据、故障时会怎样 |
| [docs/im-style.md](im-style.md) | Rhodium 在 QQ、Telegram 里的每类话、工具行、选择面板和按钮具体怎么写 |
| [docs/spec/v1.md](spec/v1.md) | v1 做什么、不做什么、怎么测试、分几个里程碑 |
| [docs/spec/web-chat.md](spec/web-chat.md) | 网页第 2 步的对话页做什么、不做什么、怎么测试、怎么验收 |
| [docs/spec/web-topology.md](spec/web-topology.md) | 网页拓扑图的只读部分和对话页的头像做什么、不做什么、怎么测试、怎么验收 |
| [docs/spec/bot-programs.md](spec/bot-programs.md) | Bot 程序这一期做什么、不做什么、怎么测试、分哪两段 |
| [docs/spec/web-write.md](spec/web-write.md) | 网页第 3 步“网页能写”做什么、不做什么、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/web-terminal.md](spec/web-terminal.md) | 网页第 5 步“终端嵌入”做什么、不做什么、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/im-buttons.md](spec/im-buttons.md) | IM 的按钮行和 `/` 菜单怎么分开、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/info-commands.md](spec/info-commands.md) | `/status`、`/usage`、`/context` 这类查询命令在网页和 IM 上什么样、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/web-maximize.md](spec/web-maximize.md) | 电脑宽屏上的放大模式和侧栏、列表里的 Bot 头像、跳转框、真全屏做什么、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/feishu.md](spec/feishu.md) | 接飞书私聊做什么、和飞书之间怎么说话、怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/codex.md](spec/codex.md) | 接 Codex 做什么、怎么测试、怎么验收、明确不做什么、怎么拆工单 |
| [docs/spec/web-images.md](spec/web-images.md) | 网页上怎么看图（包括 agent 写在回复里的本机图片）、回复里的本机文件链接怎么下载、交给 agent 的图怎么缩、收发的图留多久，整条消息怎么复制和引用，怎么测试、怎么验收、怎么拆工单。2026-11-10 `rh send` 重新设计那一批的工单表也在这里 |
| [docs/spec/tui-input.md](spec/tui-input.md) | TUI 槽位的输入第一批（等着时的提示、“被弹框挡住”、内部消息打进终端、终端带系统提示）开工前实测什么、怎么测试、怎么验收、怎么拆工单，以后的几步和还没定的事 |
| [docs/spec/tui-user-input.md](spec/tui-user-input.md) | TUI 槽位的输入第二批（你从 IM、网页发的消息打进终端，回复转回发消息的窗口）开工前实测什么、怎么测试、怎么验收、怎么拆工单，还没定的事 |
| [docs/spec/web-bots.md](spec/web-bots.md) | 2026-11-17 的网页管 Bot：新建 Bot 的向导、Bot 的菜单、建 Bot 流程挪进 `rhodium`、主窗口自动设、首页的引导，怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/web-exchanges.md](spec/web-exchanges.md) | 2026-11-20 的对话页改版（三档宽度、刻度条、`rh send` 发给你的显示和从标准输入读、系统提示和回执的措辞；往来行和折叠行改版另见 `web-exchanges` 分支），怎么测试、怎么验收、怎么拆工单 |
| [docs/spec/web-import-composer.md](spec/web-import-composer.md) | 2026-11-16 的网页改版：新建和导入的弹窗、导入列表和搜索、列表行的菜单、终端槽位的列表行、输入框的历史消息、上下文和额度的显示，`/usage`、`/context`、`/model` 的小弹窗，怎么测试、怎么验收、怎么拆工单 |

[AGENTS.md](../AGENTS.md) 和 [docs/agents/](agents/) 是给 AI agent 看的工作约定，不在阅读路径上。`CLAUDE.md` 只引用 `AGENTS.md`。

[deploy/README.md](../deploy/README.md) 讲怎么部署一个实例、怎么升级和回滚、怎么打安装包，也不在阅读路径上。

## 约定

- 文档用中文；代码、标识符、注释和提交信息用英文。
- README 和 CONTRIBUTING 以英文版为准，旁边各有一份中文译本，两份一起改。
- 开发流程：spec → GitHub issue → 每个 issue 一个 PR，先写测试，独立审查后合并。
- 设计过程中的原始调研、8 套候选架构和评审意见都不进仓库。仓库里只放整理后的结论。
- 开发在作者的私有仓库里进行，公开仓库是按版本导出的快照，不带提交历史。文档和代码注释里的 `#编号` 指私有仓库的 issue，在公开仓库里查不到。
- 文件名带 `.local.md` 的只在私有仓库里，写的是作者那台机器自己的事，不公开。
