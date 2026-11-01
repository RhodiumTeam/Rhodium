<p align="center"><img src="docs/assets/banner.jpg" alt="Rhodium" width="100%"></p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-yellow" alt="License: MIT">
  <img src="https://img.shields.io/badge/platform-Linux-informational?logo=linux&amp;logoColor=white" alt="Platform: Linux">
  <img src="https://img.shields.io/badge/runtime-Bun-555?logo=bun" alt="Runtime: Bun">
  <img src="https://img.shields.io/badge/agents-Claude%20Code%20%7C%20Codex%20%7C%20pi-8a5cf6" alt="Agents: Claude Code | Codex | pi">
  <img src="https://img.shields.io/badge/IM-QQ%20%7C%20Telegram%20%7C%20Feishu-2ea44f" alt="IM: QQ | Telegram | Feishu">
</p>

<div align="center">

English | [简体中文](README_zh.md)

</div>

Rhodium is a single-user agent host that runs on an always-on Linux machine. Built for individual developers, it lets you control the coding agents on your server from your phone, a web board, or a terminal. The user interface and documentation are currently primarily in Chinese.

## Features

### Unified Agent Host

Rhodium hosts the coding agents already installed on your server: Claude Code, Codex, and pi. Each agent runs its official binary using your own subscription or API key. Rhodium does not provide models or touch your accounts.

The host is written in Bun (TypeScript) and works alongside `rh-hold`, a small helper written in Rust. `rh-hold` keeps agent processes alive so running agents are not interrupted when Rhodium restarts or upgrades. Rhodium also automatically resumes work after quota resets or agent crashes. Idle agent processes are stopped to save resources and started again when a new message arrives.

### Everyday Remote Control

You can control your agents in three ways:

- **IM**: Chat privately with your own bot on QQ, Telegram, or Feishu from your phone. Rhodium passes your messages to the agent and sends replies, tool calls, questions, and approval buttons back to the chat window. Only the paired bot owner can trigger an agent.
- **Web board (GUI)**: A PWA you open straight in the browser, on desktops, tablets and phones, and can install to your desktop or home screen. Use it to create slots, chat, switch models and reasoning effort, answer approvals, inspect tool call details, open a web terminal, or change settings. It also includes a topology view to inspect and edit bindings between bots, chat windows, and slots. Almost everything the `rh` CLI does can be done by clicking in the web board.
- **Terminal (TUI)**: Using the [Herdr](https://github.com/herdrdev/herdr) terminal multiplexer, you can switch an active conversation into your terminal. This gives you the agent's native interface and full feature set. When you exit the terminal session, the conversation returns to headless mode so you can keep using it from IM or the web.

### Slots

A slot is the core concept in Rhodium. One slot is an agent conversation fixed to a specific directory, written as `workspace/slot` (for example, `work/main`).

You can freely change how IM chat windows bind to slots. A bot can have its own default slot, while individual chat windows can point to other slots and switch targets at any time. The same slot shares the exact same conversation across IM, the web board, and the terminal. The web board stays in sync in real time, so you can continue the conversation from whichever interface is convenient.

### Agent-Native CLI

Rhodium provides the `rh` command-line tool, which agents can also run themselves:

- `rh send`: Send messages to other slots for cross-slot and cross-agent communication.
- `rh spawn`: Spawn a child slot to handle a task; it automatically reports back to the parent slot when it finishes or gets stuck.
- `rh use`, `rh bind`: Adjust bindings between chat windows and slots.
- `rh ls`, `rh read`: Inspect slot status and read conversation history.

When an agent attempts a sensitive action—such as rebinding a chat window you are actively using—Rhodium asks for your confirmation in IM first.

## What Rhodium Is Not

- **Not a new agent harness**: It only hosts the harnesses you have already installed (Claude Code, Codex, pi).
- **Not a multi-agent orchestrator**: Its slot and CLI design allows basic coordination, but its main goal is practical remote control.
- **Not a commercial or enterprise platform**: This is a personal project started so the author could more easily control agents on a personal Linux server.
- **Not a hosted service or SaaS**: It requires a Linux machine with systemd, and everything runs on your own hardware.
- **Not a personal assistant or an AI coworker**: The bots Rhodium creates are a control UI for the agents on your server. They are not meant to be a general-purpose personal assistant, and they don't join IM group chats as an AI coworker.
- **Not a multi-user bot platform**: It is built for a single user. Only the paired owner can trigger agents.
- **Not a way to share accounts or bypass limits**: It does not provide model quotas or bypass official subscription and rate limits.

## Quick Start

Download the latest release archive (`rhodium-<version>-linux-x86_64.tar.xz` or `rhodium-<version>-linux-arm64.tar.xz`) from GitHub Releases.

Before you begin, it helps to understand **slots**. A slot is an agent conversation tied to a directory, written as `workspace/slot` (such as `work/main`). IM, the web board, and the terminal all connect to the same conversation when pointed at the same slot, and you can switch interfaces or rebind chat windows whenever you want.

The archive includes `INSTALLATION.md`, an installation guide written for agents. Hand the archive to an agent on your machine and ask it to install Rhodium by following that file. To deploy from source instead, see [deploy/README.md](deploy/README.md).

You only need to do six things yourself:

1. **Install dependencies**: Prepare a Linux machine with a systemd user session, and install the coding agents you want to host. We recommend exposing the web board only to yourself over Tailscale (localhost-only and Cloudflare Access are also supported). Install [Herdr](https://github.com/herdrdev/herdr) if you want the terminal TUI feature.
2. **Log in to your agents**: Sign in to each agent with your own subscription or API key. Do this step yourself rather than leaving it to an agent.
3. **Learn the web board**: Take a look around the web board; it covers almost all daily use.
4. **Create and pair your first bot**: Run `rh bot <name> qq|telegram|feishu` in your terminal. Scan the QR code with your phone for QQ or Feishu, or paste a token from `@BotFather` for Telegram. Follow the prompts to pair: send the pairing code `rh bot` prints to your bot in a private IM chat. From that point on, only you can control it. If the scan already recognized you, no pairing is needed.
5. **Start using it**: Send a message from your IM chat window or the web board.
6. **Let your agent read the docs**: Most docs in this repository are written by agents, for agents; you don't need to read them yourself. If you have other questions, ask your agent to read them and answer you: the glossary in [GLOSSARY.md](GLOSSARY.md), the product guide in [docs/product.md](docs/product.md), and the documentation map in [docs/README.md](docs/README.md).

## Contributing

Rhodium is developed in the author's private repository. The public repository at `github.com/RhodiumTeam/Rhodium` publishes versioned snapshots without commit history.

You are welcome to open Issues for bugs or feedback, though the author has limited time and may not reply right away. Features are built around the author's own needs and may not cover every request. If you want to contribute code via a pull request, please read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## Disclaimer

Rhodium is an open-source personal project for a single user, provided under the MIT License. Please understand the following before using it.

- **No warranty:** The software is provided “as is,” without any express or implied warranty. The authors and copyright holders are not liable for losses arising from its use; see the MIT License for the full terms.
- **Independent project:** Rhodium is not affiliated with, endorsed by, or sponsored by Anthropic, OpenAI, Tencent, Telegram, ByteDance, Tailscale, Cloudflare, Herdr, the authors of pi, or their respective organizations. Trademarks and logos belong to their owners; the QQ penguin is not covered by Rhodium's MIT License. See [NOTICE.md](NOTICE.md) for details.
- **Accounts and rules:** You are responsible for complying with local laws, each agent provider's terms and usage policies, and IM platform rules. Do not use Rhodium to share or resell accounts or bypass usage limits; only you may trigger an agent, and do not let a third-party harness such as pi sign in with a Claude subscription.
- **Costs:** Agents use your own logins and allowances and may consume subscription usage or incur API charges, which you are responsible for. Rhodium does not provide models, resell usage, or share accounts.
- **Security:** Remotely controlling a machine that can execute commands and read, change, or delete files carries risks. Agents can make mistakes or be misled by prompt injection in messages or web content; secure access and credentials, keep backups, and remember that other programs on the same machine can also reach the web board.
- **Data and privacy:** Messages and files pass through third-party IM platforms; conversation records, uploaded files, and logs are stored on your machine. The author does not collect your data and is not liable for data loss or leaks.
- **Intended use:** The project is not suitable for production, commercial, multi-user, or enterprise use. Breaking changes may occur at any time, and availability, maintenance, and fixes are not guaranteed.
- **Code:** Most code was written and reviewed by coding agents under the author's direction; assess the risks before use.

## License

Rhodium is licensed under the MIT License; see [LICENSE](LICENSE) for details. Licenses and notices for third-party code and graphics can be found in [NOTICE.md](NOTICE.md).
