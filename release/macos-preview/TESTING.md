这篇回答：如何在一台自用的 Apple Silicon Mac 上试用无头和三种 agent 的终端预览，验证开机未登录时的能力，并在测试后卸载。

前置阅读：同包 VERSION.txt、LaunchDaemon.plist.in。Requires Apple Silicon; this preview uses a system LaunchDaemon running as the test user. GUI sign-in is not the trigger.

## 准备和启动

比对发布者给的 tar.gz SHA256。解压至个人专用版本目录（例如在家目录建 RhodiumPreview-apps，再在其中执行 tar -xzf 加上下载包路径）。进入解压出来的目录，运行：

~~~sh
xattr -dr com.apple.quarantine "$PWD"
./rhodium --version
./rh-hold --version
./prepare-macos.sh
~~~

这是没有 Developer ID 签名和公证的测试包。仅对已经核对 SHA256 的这个目录移除下载隔离标记，不更改系统 Gatekeeper。Apple Silicon 二进制可能带链接器或运行时所需的 ad-hoc 标记。保留旧版本目录，直到旧 holder 都已退出。

准备脚本用当前非 root 用户创建 0700 的 ~/rhodium-test，包含 current 链接、Rhodium 配置、状态及工作目录。看板的 ~ 和 agent 的 HOME 均为该用户的真实家目录。Codex 默认读 ~/.codex/sessions；在自定义 CODEX_HOME 下使用 Codex 时，要让服务也能读到同一个目录。仅支持家目录为 /Users/短用户名 的本地用户。若该测试目录已有其他用途，请停止。看板示例只监听本机 127.0.0.1:17861，信任能访问回环地址的本机进程。只在可信单用户 Mac 上使用。网页登录后先建工作区和槽位，再从“+ → 新建 Bot”选择 Telegram 等测试 Bot 并私聊配对。CLI 查询可用 RHODIUM_SOCKET="$HOME/rhodium-test/run/rh.sock" ./rhodium rh ls。特权操作走本人网页/已配对 IM。可导入运行中的 Claude pane；pi pane 仅在凭据检查确认四项均为空或缺失时才可接管，Codex pane 暂缓。内存压力监控、本地终端专属急停和 trace 暂不提供。

在看板“+ → 导入”选择目录和已有会话。与 Linux 一致，仅在其他进程的命令行包含该会话 ID，或所配置的 Herdr 会话里有 pane 报告它时提示占用。另一个 Codex 或 pi 正在运行本身不会阻止导入。若某 CLI 此刻正使用目标记录却没有公开 ID，先退出它，避免两个进程同时写入。

**普通用户手动测试**：在一个终端执行以下命令，打开本地看板。它不会注册系统服务。不要与同一实例的 LaunchDaemon 同时运行。

~~~sh
base="$HOME/rhodium-test"
cd "$base"
./current/rhodium --config "$base/config.toml" 2>>"$base/daemon.log"
~~~

从旧预览升级时，运行中的旧 plist 带有隔离 HOME。先用**旧版** helper 卸载旧测试任务，再替换 root 副本或重新运行新版 prepare，最后用新版 helper 安装。受限 sudoers 只应指向可信的 root:wheel 副本。

**系统服务**：普通用户先完成 prepare，再按需在终端执行以下命令。由 launchd 在 system 域启动；plist 固定 UserName 为准备时的用户，日志由降权后的进程打开。切勿将可由用户写入的 helper 路径加入免密 sudoers。

~~~sh
sudo "$HOME/rhodium-test/macos-admin" install
sudo "$HOME/rhodium-test/macos-admin" status
~~~

测试机若使用单独授权的测试 helper，只使用已核验的 root:wheel 副本 /usr/local/sbin/rhodium-test-launchd 及其精确参数。在正式授权前仅手动运行。此预览不使用 LaunchAgent。系统服务处于运行状态时，避免原地替换 exe；等待槽位空闲或记录进行中的回合，解压不同提交并切换 current，核验重启控制面后 holder PID、回复和工具执行次数。

## Claude Code、Codex、pi 槽位和网页终端

1. 在本机为要测的 CLI 完成本人登录并确认能独立回复；pi 使用自己的提供商和登录。在预览配置的 `[programs]` 下填入这些 CLI 及 `herdr` 的路径，在 `[herdr]` 下填 `session = "rhodium-test-preview"`。启动新的命名测试会话：在另一终端运行 `herdr --session rhodium-test-preview server`，再让预览服务加载配置。记下 Rhodium、Herdr（探针用 0.9.5）和各 CLI 版本。
2. 在看板“+ → 新建”选测试工作区，分别选择 Claude、Codex、pi 新建三个无头槽位。以下步骤每个槽位各做一遍；缺少哪种登录就把那一行标为“未测”。每次自选两个短随机标记 A、B，避免在追问中泄露答案。用网页聊天或该槽位绑定的测试 Bot 发送“记住这个标记：A，只回复收到”（把 A 换成实际标记）。等回复并空闲。
3. 点该槽位的“切到终端”（或从绑定的聊天发送 `/rh_tui`），打开网页的“终端”。应看到所选 CLI 的提示符。亲自在终端里输入“复述上一条的标记，再记住 B”。应收到 A；等本回合结束。调整网页终端大小，再用第二个页面打开同一槽位终端。新页面能继续操作，旧页提示被接管，先前画面仍在。
4. 用 CLI 自己的退出操作正常退出。等看板回到无头，从网页聊天或绑定的 Bot 问“我让你记住的第二个标记是什么？”应只收到一次 B。再从同一槽位切到终端，输入另一个新标记，等回复；这次从绑定的聊天发送 `/rh_release` 并确认，或用网页确认切回无头。再次追问应能复述新标记。仅关闭网页终端不会退出 CLI。
5. 每行分别记录“无头首回合 / 终端续接 / 网页输入 / 双页接管 / 正常退出续接 / 确认切回续接”的通过、失败或未测。失败时记当地时间、版本、CLI 启动形式、槽位模式、最后成功步骤及脱敏短错误；区分没有提示符、可以手打但没有自动输入、进入了空白新会话。不要提交配置文件、原始会话记录、终端录屏、令牌或账号/会话 ID。

**Claude hook 与 vim。** Herdr 的 `herdr integration install claude` 安装 SessionStart hook，让 pane 报告 Claude 会话身份；工作状态还会从屏幕识别。**pi 扩展。** `herdr integration install pi` 安装扩展，用于向 Herdr 报告会话和状态。已有集成可直接使用。两条安装命令都会写入对应 agent 的设置或扩展目录；需要补装时只在专用测试用户或隔离测试配置中执行，重新打开测试 pane。只记报告是否出现。

如果 Claude 的测试项目已启用 vim，且槽位已开启“打进终端”，在空提示符的 NORMAL 状态从绑定聊天发一条测试消息，应先排队；回到空的 INSERT 提示符后应只投递一次。记录状态和次数，手工键入不用于判断自动投递。pi 可另开一次受控环境测试：只在启动专用 Herdr 测试 server 的环境中给 `ANTHROPIC_AUTH_TOKEN` 设一个合成占位值，不使用真实密钥。在 pi 槽位请它用工具执行下式，只报告 `present` 或 `absent`；预期是 `absent`。pi 应仍能使用自己的提供商。不要打印环境清单或变量值。

~~~sh
node -e "console.log(Object.hasOwn(process.env,'ANTHROPIC_AUTH_TOKEN')?'present':'absent')"
~~~

测试完成后，等测试槽位切回无头，再用 `herdr session stop rhodium-test-preview` 结束这个命名测试会话。

## Claude Code, Codex and pi slots and the web terminal

1. Sign in to each CLI you plan to test and verify one standalone reply. Give pi its own provider and login. Put the CLI and Herdr paths under the existing `[programs]` section of the preview config. Under `[herdr]`, set `session = "rhodium-test-preview"`. Run `herdr --session rhodium-test-preview server` in another terminal, then reload the preview service with this config. Record the Rhodium, Herdr (the probe used 0.9.5) and CLI versions.
2. On the board use **+ → 新建** (New) in a test workspace. Create three headless slots, selecting Claude, Codex and pi respectively. Run the following checks separately for each available login and mark any missing one as untested. Choose two short random markers A and B for each slot. From the board chat or its paired bot, ask “Remember A and reply only OK,” substituting your marker. Wait for the reply and an idle slot.
3. Choose **切到终端** (switch to terminal), or send `/rh_tui` from the bound chat, and open the board terminal. At the CLI prompt type “Repeat my previous marker and remember B,” substituting the second marker. Expect A. Let the turn finish, resize the terminal and open the same slot terminal in a second browser tab. The second tab should take over the same screen and accept input; the first should indicate that it lost control.
4. Quit the CLI normally. After the board shows headless mode, ask “What was my second marker?” from the board chat or bound bot. Expect one reply containing B. Switch to the terminal again, give it a fresh marker, and wait for a reply. This time confirm Release on the board or send `/rh_release` from the bound chat and confirm. Ask for the latest marker in headless mode without repeating it. Closing a browser tab alone leaves the CLI running.
5. For each agent, mark the headless turn, same-session terminal reply, web input, takeover, return after normal exit and return after confirmed release as pass/fail/untested. For a failure record local time, versions, launcher form, slot mode, last successful step and short redacted error. Distinguish a missing prompt, manual input working while auto-input waits, and an unexpected fresh conversation. Omit config, raw transcripts, recordings, tokens and account/session IDs.

**Claude hook, vim and pi extension.** `herdr integration install claude` installs the SessionStart hook that reports Claude's session identity to Herdr. Screen detection also provides working state. `herdr integration install pi` installs the extension that reports pi session and state. Use an existing integration if available. These commands write agent settings or extensions; if needed, run them only in a dedicated test account or isolated test profile and reopen the test pane. Record only whether a session was reported.

If vim is enabled in the Claude test project and terminal type-in is on, send a test message from the bound chat at an empty NORMAL prompt. It should wait, then be delivered once at an empty INSERT prompt. Record the mode and delivery count; manual typing tests a different path. For a separate pi environment check, set `ANTHROPIC_AUTH_TOKEN` to a synthetic placeholder only in the environment of a dedicated test Herdr server. Use no real secret. Ask pi to run the command below as a tool and report only `present` or `absent`. Expect `absent` and a working reply through pi's own provider. Do not print the environment or the value.

~~~sh
node -e "console.log(Object.hasOwn(process.env,'ANTHROPIC_AUTH_TOKEN')?'present':'absent')"
~~~

When all test slots are back in headless mode, stop this named session with `herdr session stop rhodium-test-preview`.

## 开机未登录：如何留下可判断的结果

- 服务启动先写 ~/rhodium-test/observations.log，约一分钟后再取一次样。记录 UTC、启动时间标记、console 是 loginwindow 还是已登录、是否以普通用户运行、无凭据请求 Anthropic HTTPS 得到的状态码或 curl 失败码（6 为解析失败，7 为连接失败）。收到 401/404 等 HTTP 回应也证明 DNS/TLS/网络可用，不代表 API 已通过身份验证。daemon.log 是控制面 stderr。启用了 FileVault 的冷启动可能停在磁盘解锁界面，此时操作系统和 LaunchDaemon 本身还没有开始运行。
- **登录凭据需要对照实验**。使用本人的正常 Claude Code 登录，在本人终端核对 `claude auth status`。不需要在另一份 profile 里重新登录，也不需要复制凭据或解锁钥匙串。用户希望检验启动时的访问能力时，在测试目录创建空文件 probe-auth；从该目录执行 `./current/macos-observe sample` 留下已登录基线，再比较 system 域和登录窗口样本。日志仅保留登录布尔值、凭据类型和退出码。auth status 为 true 不足以证明真实模型回合可用。只有自动测试才显式指定临时 HOME、CLAUDE_CONFIG_DIR、CODEX_HOME 及假 agent；测试目录可与日常会话完全分开。
- TCC（系统隐私权限）按应用身份、目录与启动环境生效。由用户选择一个受保护目录中的无敏感内容测试文件，将其绝对路径单独一行写入 ~/rhodium-test/probe-tcc-path，先测登录时可读基线。探针只读一个字节到 /dev/null，仅记录 readable/unavailable。未提供 canary 时不接触桌面、文稿等目录；读取失败也可能是文件不存在，不能单凭它诊断 TCC。
- **未登录测试由用户决定时机**。先记录真实 agent/测试 Bot 登录后的短回复、控制面版本和上述基线。在允许的一次开机后停留在登录窗口，等待至少两分钟，从手机给测试 Bot 发唯一标记并记录时间、是否回复。不要依赖 SSH：本测试机的隧道是用户 LaunchAgent，未登录时可能完全不通。之后登录，核对相同 boot 标记下 loginwindow 时的样本、HTTPS、auth、TCC，和手机收发时间，再取登录后样本。如果只有 logged-in 样本，不能当作未登录通过；只有醒后才来消息要单列。锁屏、SSH 登录、系统域但桌面已登录，也都不是开机未登录。
- 排查时仅提供上述布尔值、HTTP 状态、版本和错误类别。不要发送 config.toml、rh.db、密钥、账户标识、原始 agent 输入输出或钥匙串内容。服务不可用时保留测试结果，不自动改成 LaunchAgent。若 macOS holder 自身被异常杀掉且没有 exit，分支会保留 agent.started 标记以阻止再开同一会话。先人工确认旧 agent 已退出再离线处理测试实例。

## 卸载

先在看板停止各测试槽位，再执行以下命令。普通手动模式只需停止自己开的控制面。核对没有测试 holder 残留后，删除本次创建的测试数据目录和解压目录；删除数据会清掉测试对话及日志。不要删除日常 agent 目录或其他 launchd 服务。

~~~sh
sudo "$HOME/rhodium-test/macos-admin" uninstall
~~~

在授权 helper 的专用测试机，上述卸载改为 sudo /usr/local/sbin/rhodium-test-launchd uninstall；sudoers 条目及 /usr/local/sbin 的副本由安装者最后撤销。

异常标记还记录系统 boot session。已确认换过 boot 的旧进程无法继续运行，会自动清理标记；同一 boot 或 boot 身份未知时继续保护原会话。测试中的模拟 boot 标记覆盖这种判定，不等于真做过重启。
