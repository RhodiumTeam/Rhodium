<p align="center"><img src="docs/assets/banner.jpg" alt="Rhodium" width="100%"></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License: MIT">
  <img src="https://img.shields.io/badge/platform-Linux-informational?logo=linux&amp;logoColor=white" alt="Platform: Linux">
  <img src="https://img.shields.io/badge/runtime-Bun-555?logo=bun" alt="Runtime: Bun">
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20pi-8a5cf6" alt="Agents: Claude Code | Codex | pi">
  <img src="https://img.shields.io/badge/IM-QQ%20%7C%20Telegram%20%7C%20Feishu-2ea44f" alt="IM: QQ | Telegram | Feishu">
</p>

<div align="center">

[English](README.md) | 简体中文

</div>

Rhodium 是一个单用户 agent 宿主，运行在常开的 Linux 机器上。它面向个人开发者，方便用户通过手机、网页看板或终端，随时控制服务器上的编程 agent。项目目前的界面和文档以中文为主。

## 功能

### 统一的 agent 宿主

Rhodium 托管服务器上已经安装好的编程 agent，支持 Claude Code、Codex 和 pi。每个 agent 都直接运行官方程序，使用你自己的订阅或 API key。Rhodium 不提供模型，也不触碰你的账号。

宿主程序使用 Bun（TypeScript）编写，并配有 Rust 编写的小程序 `rh-hold`。`rh-hold` 负责托住 agent 进程，因此 Rhodium 重启或升级时，正在工作的 agent 不会中断。额度用尽或 agent 崩溃后，系统会自动恢复运行；系统还会回收空闲的 agent 进程，待新消息到达时再次拉起。

### 随手可用的远程控制

你可以按场景选择 3 种控制方式：

- **IM**：在手机的 QQ、Telegram 或飞书里，私聊自己创建的 Bot。Rhodium 把消息交给 agent，再将回复、工具调用、提问和审批按钮发回聊天窗口。只有配对过的 Bot 主人能够触发 agent。
- **网页看板（GUI）**：可直接通过浏览器访问的 PWA 应用，支持电脑、平板和手机，支持安装到桌面或主屏幕。你可以在看板上创建槽位、聊天、切换模型和思考强度，也能回答审批、查看工具调用细节、打开网页终端或修改设置。看板还提供拓扑图，用来查看和修改 Bot、聊天窗口与槽位之间的绑定。绝大多数 `rh` 命令能完成的操作，都能在网页看板上点击完成。
- **终端（TUI）**：借助终端复用器 [Herdr](https://github.com/herdrdev/herdr)，你可以把同一段对话切换到终端里。终端直接呈现 agent 原生界面，功能最完整；退出后对话回到无头模式，可以接着使用。

### 槽位

槽位是 Rhodium 的核心概念。一个槽位是一段固定在某个目录里的 agent 对话，写成“工作区/槽位”，例如 `work/main`。

你可以自由调整 IM 聊天窗口与槽位的绑定。每个 Bot 可以拥有自己的默认槽位，单个聊天窗口也能单独指向其他槽位，并且可以随时修改指向。同一个槽位在 IM、网页看板和终端里是同一段对话，网页看板会实时同步状态，从任意一端都能接着交流。

### Agent 原生

Rhodium 提供命令行工具 `rh`，agent 自己也能直接调用：

- `rh send`：给其他槽位发送消息，实现跨槽位、跨 agent 通信。
- `rh spawn`：派生一个子槽位去完成任务，做完或卡住时自动向父槽位汇报。
- `rh use`、`rh bind`：调整聊天窗口与槽位的绑定。
- `rh ls`、`rh read`：查看槽位状态与对话内容。

如果操作涉及用户正在使用的聊天窗口等敏感变更，Rhodium 会先在 IM 里请用户确认。

## Rhodium 不是什么

- **不是新的 harness**：它只托管你机器上已经安装好的 harness（Claude Code、Codex、pi）。
- **不是多 agent 编排器**：由于槽位与命令的设计，它带有一定的编排能力，但主要目标是提供更易用的远程控制。
- **不是成熟的商用或企业级 agent 平台**：这是个人项目，出发点是作者希望更方便地控制自己 Linux 服务器上的 agent。
- **不是云端托管服务或 SaaS**：它只支持带有 systemd 的 Linux 机器，所有程序都运行在你自己的设备上。
- **不是通用的个人助理或 AI 同事**：Rhodium 创建的 Bot 是一种控制界面，用来指挥服务器上的 agent。它不打算成为通用的个人助理，也不进入 IM 群聊充当 AI 同事。
- **不是多人共用的 Bot 平台**：它采用单用户设计，只有配对过的 Bot 主人能触发 agent。
- **不帮你共享账号或绕过限制**：它不提供模型额度，也不绕过官方的订阅与用量限制。

## 快速开始

请前往 GitHub Releases 页面，下载最新的安装包 `rhodium-<版本>-linux-x86_64.tar.xz` 或 `rhodium-<版本>-linux-arm64.tar.xz`。

使用前需要先了解核心机制“槽位”。一个槽位是一段固定在某个目录里的 agent 对话，写成“工作区/槽位”（例如 `work/main`）。同一个槽位在 IM、网页看板和终端里共享同一段对话，你可以随时切换控制方式，也可以随时修改聊天窗口指向的槽位。

安装包里带有一份写给 agent 的安装指导 `INSTALLATION.md`。请把安装包交给你机器上的 agent，让它照着这份文档完成安装。想从源码部署，见 [deploy/README.md](deploy/README.md)。

你需要自己完成以下 6 件事：

1. **了解并安装依赖**：准备 Linux 环境与 systemd 用户会话，安装需要托管的 agent 本身。网页看板建议经 Tailscale 仅对自己开放，也支持只在本机访问或经 Cloudflare Access 访问；终端功能需要安装 [Herdr](https://github.com/herdrdev/herdr)。
2. **登录 agent**：使用自己的订阅或 API key 登录各个 agent。这一步需要自己完成，不要交给 agent 操作。
3. **了解网页看板**：熟悉网页看板界面，日常使用通过网页看板就能满足。
4. **创建第一个 Bot 并连接**：在终端里运行 `rh bot <名字> qq|telegram|feishu`。QQ 和飞书使用手机扫码，Telegram 粘贴 `@BotFather` 提供的 token。随后照提示配对：在 IM 里私聊这个 Bot，发送 `rh bot` 给出的配对码，从此只有你能指挥它。扫码已认出你的话，不用配对。
5. **开始使用**：在 IM 聊天窗口或网页看板中发送消息，开始日常使用。
6. **查阅其他文档**：本仓库的多数文档由 agent 编写，也以 agent 为读者，你不必直接阅读。如果还有其他问题，可以让 agent 阅读这些文档来回答，包括术语表 [GLOSSARY.md](GLOSSARY.md)、产品说明 [docs/product.md](docs/product.md) 和文档地图 [docs/README.md](docs/README.md)。

## 参与贡献

Rhodium 在作者的私有仓库中开发，公开仓库 `github.com/RhodiumTeam/Rhodium` 是按版本导出的快照，不带提交历史。

欢迎提交 Issue 反馈问题或建议。作者精力有限，可能不会及时处理；功能按作者自己的需求迭代，可能无法满足所有需求。如果你希望通过 PR 贡献代码，请先阅读 [CONTRIBUTING_zh.md](CONTRIBUTING_zh.md)。

## 免责声明

Rhodium 是按 MIT 许可提供的单用户开源个人项目，使用前请了解以下事项。

- **无担保**：本软件按“原样”提供，不作任何明示或暗示的担保；作者和版权持有人不对使用本软件产生的损失承担责任，具体以 MIT 许可为准。
- **独立项目**：Rhodium 与 Anthropic、OpenAI、腾讯、Telegram、字节跳动、Tailscale、Cloudflare、Herdr 及 pi 的作者等没有关联，也未获其认可或赞助。商标和标志归各自所有者；QQ 企鹅不在 Rhodium 的 MIT 许可范围内，详见 [NOTICE.md](NOTICE.md)。
- **账号与规则**：你须遵守所在地法律法规、各 agent 提供方的服务条款和使用政策以及 IM 平台规则，不得用本软件共享或转售账号、绕过用量限制。只有你本人可以触发 agent；不要让 pi 等第三方 harness 使用 Claude 订阅登录。
- **费用**：agent 使用你自己的登录和额度，可能消耗订阅额度或产生 API 费用，均由你承担。Rhodium 不提供模型、不转售额度，也不共享账号。
- **安全**：远程控制能执行命令、读写和删除文件的机器存在风险；agent 可能误操作，也可能受消息或网页内容中的提示注入诱导。请自行做好访问控制、凭据保管和备份；同一台机器上的其他程序也可能访问网页看板。
- **数据与隐私**：消息和文件会经过第三方 IM 平台，对话记录、上传文件和日志保存在你的机器上。作者不收集你的数据，也不对数据丢失或泄露承担责任。
- **适用范围**：本项目不适合生产、商用、多用户或企业场景，可能随时出现不兼容的变更，也不保证可用性、维护或问题修复。
- **代码来源**：代码主要由编程 agent 在作者指导下编写和审查，使用前请自行评估风险。

## 许可

本项目采用 MIT 许可，详见 [LICENSE](LICENSE)。第三方代码和图形的许可见 [NOTICE.md](NOTICE.md)。
