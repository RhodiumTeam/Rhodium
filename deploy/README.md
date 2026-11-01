# 部署

这篇回答：一个 Rhodium 实例由哪些东西组成，怎么装、用、重启、看日志、停掉、升级、回滚和卸载，以及怎么打安装包。

前置阅读：[术语表](../GLOSSARY.md)、[架构 §12 可观测性与运维](../docs/architecture.md#12-可观测性与运维)、[规格·配置](../docs/spec/v1.md#配置)

## 实例由什么组成

一台机器上可以装几个实例，例如日常用的一个、开发用的一个。下文的 `<实例>` 是实例名，例如 `rhodium`、`rhodium-dev`。

- 实例名就是它的 systemd 服务名。
- 升级脚本按实例名找程序目录和 socket，所以下表里带 `<实例>` 的路径要照写。

| 东西 | 在哪 |
|---|---|
| `rhodium` 服务 | systemd 用户服务 `<实例>`，enable，崩了自动拉起 |
| 带外告警 | 单元 `<实例>-alert`。`<实例>` 反复起不来时，用告警的 Telegram Bot 发给你 |
| 程序 | `~/.local/opt/<实例>/`：`versions/` 下每个版本一个目录，`current` 指向在用的，`previous` 指向上一个 |
| 配置 | 例如 `~/.config/rhodium/<实例>/config.toml`，权限 0600 |
| 告警的环境文件 | 例如 `~/.config/rhodium/<实例>/alert.env`，权限 0600 |
| 状态 | 配置里的 `stateDir`，例如 `~/.local/state/<实例>/`：数据库 `rh.db`、托管进程的目录 `hold/`、备份 `backup/`、锁 `lock/` |
| `rh` 的 socket | `$XDG_RUNTIME_DIR/<实例>/rh.sock`，也就是配置里的 `socketDir` 下 |
| `rh` 包装 | `~/.local/bin/rh`，连的是这个实例，见下文“日常” |
| 托管进程 | systemd 单元 `<unitPrefix>hold-<对话>`，`unitPrefix` 写在配置里，例如 `<实例>-` |
| 看板 | 本机 `127.0.0.1:<端口>`；用 `tailscale serve` 发布后，tailnet 上是 `https://myhost.example.ts.net:<端口>/` |
| Herdr | TUI 开在配置里 `[herdr] session` 写的会话，通常是你自己在用的 Herdr 会话 |
| 调度员槽位 | `dispatcher/main`，目录 `~/RhodiumWorkplace`，主 Bot 私聊的默认目标 |

几点说明：

- Bot 的名字（`[bots.<名字>]` 的键）是命令里用的 ID，不带空格。想让窗口名和来源行显示别的名字，在那张表里加 `label`。例如写了 `label = "Echo Agent"`，窗口就叫“QQ Bot Echo Agent 的私聊”。见[规格·配置](../docs/spec/v1.md#配置)。
- 主窗口写在配置里：`mainChat = "<Bot 名字>/<你在这个 Bot 下的 openid>"`。QQ 上的主动消息有额度，Rhodium 算出用完了、或者平台按额度拒收了，通知就改经另一个 Bot 的私聊转告，例如 Telegram。
- 调度员的 `CLAUDE.md` 抄自本目录的 [dispatcher/CLAUDE.md](dispatcher/CLAUDE.md)。两边要一起改。
- Herdr 的自动恢复开着时，`rh doctor` 会一直报这条告警。关不关由你定。
- 服务单元和 agent 的 `PATH` 里写死了 Node 的路径，例如 nvm 的某个版本。nvm 换了 Node 版本，要改配置里的 `agentPath`、`[programs]`，再按下文“首次安装”第 4 步重装服务。
- 看板只认配置里 `[board] login` 写的 Tailscale 账号。这台机器是带标签的 Tailscale 节点时，从它自己经 tailnet 打开会被拒，从你的设备打开才行。
- 开发用的 agent 和测试不碰你自己在用的 Herdr 会话，只用各自的测试会话。只有 Rhodium 自己在那个会话里开关 tab。

## 日常

在 ssh 里直接敲 `rh`，连的就是这个实例。`~/.local/bin/rh` 是这样一个包装：

```sh
#!/bin/sh
RHODIUM_SOCKET=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/<实例>/rh.sock exec "$HOME/.local/opt/<实例>/current/rh" "$@"
```

- 你自己在 Herdr 里开的 pane 没有 `RHODIUM_SOCKET`。导入后 pane 里的 `rh` 靠这个包装才连得上，Herdr 自动恢复出来的 pane 也一样。
- 仓库里的 `scripts/rh-dev` 就是开发实例 `rhodium-dev` 的这个包装。

| 要做什么 | 命令 |
|---|---|
| 看状态 | `systemctl --user status <实例>` |
| 看日志 | `journalctl --user -u <实例> -f`（一行一个 JSON） |
| 某个 agent 的 stderr | `<stateDir>/hold/<对话>/err.log` |
| 重启 | `systemctl --user restart <实例>`。正在跑的回合不受影响 |
| 停掉 | `systemctl --user stop <实例>`。托管进程和 agent 照常在跑 |
| 连 agent 一起停 | 先 `rh stop --all`，再停服务 |
| 再启动 | `systemctl --user start <实例>` |
| 告警之后 | 修好原因，`systemctl --user reset-failed <实例>`，再 `start` |

改了配置文件要重启才生效。`rh bot` 加的 Bot 例外，当场生效，不用重启。

### 给 Bot 改名

Bot 的名字是配置里 `[bots.<名字>]` 的键，库里也按它认 Bot。只改配置的话，重启后库里会多出一行新 Bot，旧名字下记的东西都对不上：`/rh_bind` 设的默认目标、各窗口 `/rh_use` 的目标、槽位的联系窗口。所以停着服务，库和配置一起改：

```sh
systemctl --user stop <实例>
bun -e 'new (require("bun:sqlite").Database)("<stateDir>/rh.db").run("UPDATE bot SET name = ? WHERE name = ?", ["<新名字>", "<旧名字>"])'
# 再改配置：[bots.<旧名字>] 改成 [bots.<新名字>]；mainChat 写的是这个 Bot 的话，前缀一起改
systemctl --user start <实例>
```

- `mainChat` 漏改的话，`rhodium` 起不来：配置校验要求主窗口的 Bot 在 `[bots]` 里。
- 用 `bun` 改库，机器上不用装 `sqlite3`。
- 停服务期间托管进程和 agent 照跑，回合不受影响。

## 升级

```sh
deploy/upgrade.sh -m "<改了什么>" <实例>              # 装 origin/main
deploy/upgrade.sh -m "<改了什么>" <实例> <git 引用>    # 装别的提交、分支或标签
```

PR 合进来以后，可以交给开发用的 agent 直接升级，不用等你。

`-m` 给一句中文说明，讲这次改了什么，可以不给。新版本起来后在主窗口报一句，例如“升级到 1.0.0（4a9cf6e）：每回合第一行带发送时间”。什么时候报、怎么写见[架构 §12](../docs/architecture.md#12-可观测性与运维)。

在仓库的哪个检出里跑都行，不用先切到要装的提交。它依次做这些事：

1. `git fetch origin`，把要装的引用（默认 `origin/main`）检出到一个临时目录。
2. 在那里按 `bun.lock` 装好依赖，用那个提交自己的 `scripts/build.sh` 构建，把提交号和 `-m` 的说明编进 `rhodium`，装进新的 `versions/<版本>-<提交>-<随机>`。然后删掉临时目录，构建失败也删。构建失败时别的都不动，脚本以非零退出。
3. 记下数据库现在的结构版本（schema 版本，每跑一步数据库迁移加一）。
4. `current` 指向新版本，重启 `<实例>`，等它在一分钟内应答。
5. 跑 `rh doctor`，打出报告。都没问题，就把 `previous` 留给原来的版本。

`rhodium` 没起来，或 `rh doctor` 报了错误级别的结果，脚本就把 `current` 切回原来的版本，重启，然后以 1 退出。

- 告警级别的结果不算失败。
- 看板的错误、你的 Codex 的错误（以“Codex”开头的）也不算，见[架构 §12](../docs/architecture.md#12-可观测性与运维) 的 `rh doctor`。
- 新版加的配置项，升级成功后再写进配置文件。先写了，切回的旧版不认它，起不来。

有一种情况不切回：新版本已经迁移了数据库。`rhodium` 遇到比自己新的数据库会拒绝启动，切回去旧版本也起不来。这时脚本让 `current` 留在新版本，以 1 退出，并说明结构版本从几变到了几。服务可能还在跑新版本，也可能已经停了。看日志修好原因，再装一个修好的提交。

- 不用在终端里跑，开发用的 agent 也能跑：`rh doctor` 谁都能用。
- 脚本按实例名自己算 socket，不用你 shell 里的 `RHODIUM_SOCKET`。
- 新版反复起不来时，systemd 会先放弃它，告警单元会发一条 Telegram 告警。脚本随后切回原版本，可以不管这条告警。
- 旧版本目录不会自动删。还在跑的托管进程可能在用它的 `rh-hold`。`rh doctor` 列出这样的托管进程；没有了，旧目录就可以手动删。

手动回滚到上一个版本：

```sh
cd ~/.local/opt/<实例>
ln -sfn "$(readlink previous)" current
systemctl --user restart <实例>
```

升级时迁移过数据库的话，就回滚不了。旧版本遇到比自己新的数据库会拒绝启动，日志里是 `has schema <N>, newer than this rhodium`，服务反复起不来，告警也会响。拒绝启动不会动数据库，所以把 `current` 指回新版本、重启就好。

## 首次安装

照这个顺序做。第 3 步的单独 Herdr 会话，只在不想用你自己在用的 Herdr 会话时才要。

1. `deploy/upgrade.sh <实例>`：服务还没装，所以只构建、装到 `~/.local/opt/<实例>/current`。
2. 写配置和告警的环境文件，都是 0600。配置的要点：
   - `unit = "<实例>"`、`unitPrefix = "<实例>-"`、`stateDir`。
   - `socketDir = "/run/user/<你的 uid>/<实例>"`：`upgrade.sh` 按实例名找 socket。
   - `agentPath` 以 `~/.local/opt/<实例>/current` 打头：agent 靠它找到 `rh`。
   - `[board]` 下的 `port`，和 `login`（你的 Tailscale 账号，例如 `you@example.com`）。
   - `[herdr] session`：TUI 开在哪个 Herdr 会话。
   - Bot 各带 `owner` 和 `target`。
3. 要单独的 Herdr 会话时，写 `~/.config/systemd/user/<实例>-herdr.service`：`ExecStart=%h/.local/bin/herdr --session <会话> server`、`Restart=on-failure`；然后 `systemctl --user enable --now <实例>-herdr`。
   - 这个 Herdr 可以用单独的一份配置，例如关掉 `resume_agents_on_restore`。你自己的 `~/.config/herdr/config.toml` 不改，你的会话照旧。
   - 配置：把 `~/.config/herdr/config.toml` 抄到 `~/.config/rhodium/<实例>/herdr.toml`（0600），末尾加上 `[session]` 和 `resume_agents_on_restore = false`。以后改了主配置，这份不会跟着变，要重抄。
   - 让 Herdr 和 Rhodium 都读这一份：给 `<实例>-herdr` 和 `<实例>` 各写一个 drop-in，`~/.config/systemd/user/<单元>.service.d/herdr-config.conf`，内容是 `[Service]` 和 `Environment=HERDR_CONFIG_PATH=%h/.config/rhodium/<实例>/herdr.toml`。Rhodium 要读它，`rh doctor` 才查的是这一份。drop-in 不会被 `rhodium-service.sh install` 覆盖。
4. 装服务：

   ```sh
   scripts/rhodium-service.sh install <实例> \
     --config ~/.config/rhodium/<实例>/config.toml \
     --path "$HOME/.local/opt/<实例>/current:<你登录 shell 的 PATH>" \
     --alert-env ~/.config/rhodium/<实例>/alert.env \
     -- ~/.local/opt/<实例>/current/rhodium
   ```

   - 要开机自启，给你的用户开 linger：`loginctl enable-linger`。
5. 放好上文“日常”的 `rh` 包装。
6. 建调度员：`mkdir ~/RhodiumWorkplace`，放进 `dispatcher/CLAUDE.md`；`rh ws dispatcher ~/RhodiumWorkplace`，`rh new dispatcher/main`。
7. 发布看板：`tailscale serve --bg --https=<端口> http://127.0.0.1:<端口>`。只用带 `--https=<端口>` 的写法，不带的会占 443、覆盖已有条目。

## 卸载

```sh
rh stop --all                                       # 先停 agent
scripts/rhodium-service.sh uninstall <实例>          # 服务和告警单元
systemctl --user stop '<unitPrefix>hold-*'          # 还剩的托管进程
rm -rf ~/.config/systemd/user/<实例>-herdr.service ~/.config/systemd/user/<实例>-herdr.service.d ~/.config/systemd/user/<实例>.service.d && systemctl --user daemon-reload
tailscale serve --https=<端口> off
rm -rf ~/.local/opt/<实例> <stateDir> ~/.config/rhodium/<实例> ~/.local/bin/rh
```

- 删 `<实例>-herdr` 单元和 drop-in 的那行，只在“首次安装”第 3 步装过单独的 Herdr 会话时才要。
- `~/RhodiumWorkplace` 和 Herdr 为单独的会话留下的文件（`~/.config/herdr/sessions/<会话>/`）要不要删，你自己定。

## 打安装包

安装包给没有这份代码的机器用：一个 `.tar.xz`，装着两个程序、服务脚本、`release/` 下给人看的 `README.md` 和给 agent 看的 `INSTALLATION.md`，还有许可证和第三方声明。

- 在本机打：`scripts/package.sh [输出目录] [x86_64|arm64]`，默认是 `dist/` 和本机的架构。
  - 包名是 `rhodium-<版本>-<提交>-linux-<架构>.tar.xz`。
  - 也能打另一种架构的包。
  - 要 `xz` 和 `rustup`。第一次要联网：装打包用的 Rust 和它的 musl 目标，下载另一种架构的 Bun 运行时。
- 发版用公开仓库的 GitHub Action `.github/workflows/release.yml`。它只能手动触发，私有仓库里不跑。
  1. 先升版本：`package.json` 和 `holder/Cargo.toml` 一起改。
  2. 在公开仓库的 Actions 页选 `Release packages`，点 Run workflow；或者 `gh workflow run release.yml -R <公开仓库>`。
  3. 它在 GitHub 的 x86_64 和 arm64 机器上各跑一遍 `scripts/package.sh`，再建一个草稿 Release：标签 `v<版本>`，附上两个包和 `SHA256SUMS`。
  4. 去 Release 页看草稿，写好说明，再点发布。发布时才建标签。
- 同一个版本再跑一遍：草稿的附件换成新打的，说明不动。这个版本已经发布过的话，它报错退出，什么都不改。
- Action 装的 Bun 是 `release/licenses/bun-<版本>.md` 写的那个版本。升 Bun 时换掉这份说明，Action 就跟着换。
- 打包用的 Rust 是 `release/licenses/rust-<版本>.md` 写的那个版本，不管机器上默认的是哪个。没装的话，`package.sh` 用 rustup 装一个。
  - 要钉住，是因为 Rust 标准库带的第三方库每个版本都不一样，这份声明只对得上这一个版本。
  - 升 Rust 时，照新版本 `rh-hold` 带的库重写这份声明，文件名换成新版本号。`test/package.test.ts` 会查每个库都有声明。
