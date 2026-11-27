这份说明帮助你在一台 Windows 电脑上从手机使用 Rhodium，并记录一次可复查的后台运行测试。

前置阅读：无。英文见同包 TESTING-en.md。

# Windows 预览版测试

Rhodium 在电脑上运行你已登录的命令行 agent。网页用来配置，手机上的 Bot 把消息交给“槽位”（一个工作目录里由 Rhodium 管理的对话）。rhodium.exe 是控制面，独立的 rh-hold.exe 负责在控制面重启时继续照看 agent。

## 准备

- 推荐一台自己单独使用的 Windows 11 x64 电脑，使用普通用户和系统自带的 **Windows PowerShell 5.1**（开始菜单搜 Windows PowerShell）。包中含 Bun/Rust 运行所需的程序。构建机是 Windows Server 2022 x64；ARM64、32 位及无人登录时运行均未验收。
- 选用本人已登录的原生 CLI。首次对话示例用 Claude；只有 Codex 或 pi 时，在建槽位时选已准备好的那一种。若测试 Claude，在新的 PowerShell 运行 `Get-Command claude.exe,claude.cmd -ErrorAction SilentlyContinue` 和 `claude --version`，在空测试目录完成登录、目录信任并发一条短消息，然后退出。仅有 npm 启动器时，在预览配置的 `[programs]` 中填写自己的 `claude.cmd` 绝对路径。三种 CLI 的终端分别验收；真实对话使用本人的订阅或 API，可能计费。[Claude 官方安装](https://code.claude.com/docs/en/setup)
- 手机用 Telegram 的官方 @BotFather 执行 /newbot，记下测试 Bot 的用户名，把 token 留在自己手边。用新 Bot，避免其他程序同时轮询它。[Telegram 官方说明](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)
- 示例看板只听 **127.0.0.1:17860**，仅在这台电脑打开，不开放防火墙、不做端口转发。看板不要求浏览器再次登录，本机其他进程也可访问，因此只在信任的单用户测试电脑上使用。手机走 Telegram。
- 向发包者取得 ZIP 的 SHA256。先创建一个空工作目录 `$env:USERPROFILE\RhodiumPreview-work`。不要选放有私人代码、密钥或其他 agent 会话的目录。

## 安装和第一次对话

1. 把 ZIP 保存到电脑。打开普通 Windows PowerShell，输入：

   ~~~powershell
   $zip = Get-Item -LiteralPath (Read-Host '粘贴 ZIP 的完整路径（不要加引号）')
   (Get-FileHash -Algorithm SHA256 -LiteralPath $zip.FullName).Hash
   ~~~

   和发包者给的 64 位十六进制值逐位一致才继续。以下命令在同一窗口执行。预览程序、配置数据和工作目录相互独立。

   ~~~powershell
   $apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
   $data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
   $work = Join-Path $env:USERPROFILE 'RhodiumPreview-work'
   $app = Join-Path $apps $zip.BaseName
   if (Test-Path $app) { throw '这个版本目录已存在，请核对后使用已有目录' }
   New-Item -Type Directory -Force $apps,$work | Out-Null
   Unblock-File -LiteralPath $zip.FullName
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy RemoteSigned -Force
   Expand-Archive -LiteralPath $zip.FullName -DestinationPath $app
   Set-Location -LiteralPath $app
   .\rhodium.exe --version
   ~~~

   应显示预览版本号和提交号（`<版本号>-windows-preview-<提交号>`），与 VERSION.txt 第一行相同。执行策略只作用于当前 PowerShell 窗口；新窗口运行已核验的脚本时可重复这一行。公司策略阻止脚本时，记录提示并询问管理员，不要改系统安全策略。

2. 检查随包的 config.example.toml。安装脚本会把模板中的路径换成这次测试的绝对路径，并把找到的 claude.exe 写入配置；已有配置会保留。请解压到本机 NTFS 目录。ZIP 中只有一份主程序，安装脚本在同目录创建指向 rhodium.exe 的硬链接 rh.exe，普通用户即可运行。安装后再调用 rh.exe。运行：

   ~~~powershell
   .\windows-task.ps1 -TaskName RhodiumPreview -InstallDir $app -InstanceDir $data -ConfigTemplate .\config.example.toml
   Get-ScheduledTask -TaskName RhodiumPreview | Select-Object TaskName,State
   $env:RHODIUM_SOCKET = Join-Path $data 'run\rh.sock'
   .\rh.exe ls
   ~~~

   等几秒后任务应为 Running，rh ls 应有回应。配置在 `$data\config.toml`。若找不到 agent，将其中的 claude 改成真实 exe 的绝对路径（TOML 单引号可保留反斜线），在没有进行中回合时重新启动此测试任务。若 17860 已占用，在配置里换一个空闲端口并用新地址。登录后新开的 PowerShell 不保留变量，可用下面两行重新定位，再按需设置 RHODIUM_SOCKET：

   ~~~powershell
   $data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
   $app = Split-Path (Get-ScheduledTask -TaskName RhodiumPreview).Actions[0].Execute
   ~~~

3. 本机浏览器打开 **http://127.0.0.1:17860/**。先点“新建”，选择上面的工作目录，按提示建立工作区和一个 Claude 槽位，例如 `preview/chat`。在网页对话框发“请只回复 WEB-01”。应只收到一个回答，页面应显示本次对话。尚无槽位时“新建 Bot”会灰掉。
4. 点“+ → 新建 Bot”，选 Telegram，名称填 `tgtest`，“投递给”选择刚建的槽位。在网页凭据输入框粘贴 token。用自己的 Telegram 账号**私聊新 Bot**，发送网页上的配对码。网页应显示“创建成功”；第一个配对私聊会成为主窗口。
5. 在手机上发“请只回复 IM-01”，检查 Bot 回复，并在网页同一槽位看到这次消息。再从网页发 WEB-02，检查网页收到回答。**网页自己发起的回合默认回复网页**；不要把“手机也收到一份网页回复”当成功条件。

## 测试记录

每项记下系统版本、VERSION.txt 第一行、当地时间/时区、操作、实际结果和通过/失败/待测。用下面的命令在各阶段拍进程快照。它只列预览安装目录下的程序，不输出命令行或会话 ID：

~~~powershell
$apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($apps+'\',[StringComparison]::OrdinalIgnoreCase) -and $_.Name -in 'rhodium.exe','rh-hold.exe' } |
  Select-Object @{n='role';e={if ($_.Name -eq 'rhodium.exe') {'daemon'} elseif ($_.CommandLine -match '\s"?task"?\s') {'task launcher'} elseif ($_.CommandLine -match '\s"?run"?\s') {'agent holder'} else {'CLI listener'}}},ProcessId,CreationDate
Get-ScheduledTaskInfo -TaskName RhodiumPreview | Select-Object LastRunTime,LastTaskResult
~~~

| 项目 | 怎么做 | 应该看到什么 | 不对时记什么 |
|---|---|---|---|
| 桌面弹窗 | 换版后新开 pi 槽位，从手机发消息，请它执行一条 Node 命令。关掉安装用的 PowerShell，再追问一次。 | 计划任务启动、槽位启动、执行命令均不弹终端，两次消息都有回复。 | 记下哪一步弹窗、脱敏的窗口标题和当时的槽位状态。 |
| 登录自启 | 等槽位空闲，注销 Windows，然后重新登录。无需打开启动脚本，从手机发 LOGIN-01。 | 约一分钟内任务运行，手机能收到回复。注销会结束原进程。 | 登录时间、任务状态、LastRunTime/LastTaskResult、发消息至收到回复的时间。 |
| 锁屏 | 保持供电、网络和电脑唤醒，按 Win+L；用手机发 LOCK-01；解锁后看网页。 | 锁屏期间手机就收到回复，解锁后 daemon PID/创建时间与先前一致。 | 锁屏与解锁时间；手机是否到解锁才收到，机器是否其实睡着了。 |
| 睡眠 | 开始菜单选择“睡眠”，用手机发 SLEEP-01；唤醒并等待联网，再发 WAKE-01。 | 睡眠期间无即时回复；联网后新消息可达。单独记录睡眠期间那条是否补投、是否重复。 | 睡眠/唤醒/网络恢复时刻、两条消息各自到达和回复次数。 |
| IM 与网页 | 分别发一个有不同标记的短消息，如前述第 5 步。 | 手机发起的有手机回复，网页可追溯；网页发起的有网页回复。 | 发起端、时间、对应槽位、缺失或重复发生在哪一端。 |
| 杀控制面并恢复 | 用下一段的长任务，在出现 R1-start 且未出现 R1-end 时，拍快照，只结束 daemon；继续用手机观察。 | 首次异常退出后，任务中的看守等待 2 秒再启动控制面；就绪还需启动时间。daemon PID 变，agent holder 的 PID 和创建时间不变；文件 start/end 各一行，原回复回到手机，追加问题仍有答复。 | 记录旧/新两组 PID、任务最后结果、回合是否重复、是否靠手动启动才恢复。手动救援要单列。 |
| 真换版 | 有第二个**不同提交**的预览包时再做。按下面步骤并用 U1 标记。 | 新版 daemon 运行，旧目录中的原 holder 持续到回合结束。工作目录、Bot、历史都还在，最终回复只到一次。 | 两版本、各 PID/创建时间、注册/结束进程顺序、是否丢回复。仅有一个包时填“待测”。 |
| 配置权限 | 执行 `icacls "$data\config.toml"` 和 `icacls "$data"`，仅本机查看。 | 新数据目录授予当前用户访问，普通其他用户、Users、Everyone 没有读取权限。程序也认识 Windows 内置管理员和 SYSTEM；系统管理员仍有系统级能力。 | 只记是否有意外的允许项、启动是否拒绝。不要发 ACL 原文、账号名或 SID。 |

看守只在控制面启动失败或以非零码退出时重试，连续失败依次等待 2、4、8、16、32 秒，第五次重试仍失败就结束。控制面连续运行满一分钟后，下一次异常退出重新获得五次重试。退出码 0（包括外部工具指定 0 强杀）和手动停止整个任务都不会触发看守重启。看守恢复期间计划任务仍为 Running，LastTaskResult 可能显示 267009；确认恢复请看新 daemon PID 和网页可用性。任务计划程序的失败重试另保留作兜底。

**长任务与结束控制面。** 让手机上的 agent 在测试工作目录执行一次如下 PowerShell 操作并等待完成，然后回复 R1-DONE。用记事本或 Get-Content 观察文件。每次测试用新的标记/文件，不要先把旧数据算进去。

~~~powershell
Add-Content .\probe-R1.txt 'R1-start'; Start-Sleep 90; Add-Content .\probe-R1.txt 'R1-end'
~~~

在另一个普通 PowerShell 执行下面的命令。匹配本测试任务的完整 exe 路径，进程数量不为一时停止。**不要结束 rh-hold、agent，或点击计划任务的“结束”**；那测的是另一种停止方式。

~~~powershell
$oldExe = Join-Path (Split-Path (Get-ScheduledTask -TaskName RhodiumPreview).Actions[0].Execute) 'rhodium.exe'
$old = @(Get-Process -Name rhodium -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $oldExe })
if ($old.Count -ne 1) { throw '未找到唯一的预览 daemon' }
$old[0].Kill()
~~~

**换版。** 先验新 ZIP 的 SHA256，按第 1 步解压到 `$apps` 下另一个版本目录，保留旧目录和同一个 `$data`。用两个版本的 `rhodium.exe --version` 确认提交不同。发长任务（换用 probe-U1.txt / U1-start / U1-end）。见到 start 后记快照并保存 `$oldExe`；在新目录执行第 2 步的注册命令，将 -InstallDir 换为新目录，TaskName 和 InstanceDir 保持原值。新目录会生成自己的 rh.exe；在新目录运行 `.\rh.exe --version`，应与新版 rhodium.exe 一致。安装脚本会让旧任务退出，再从新目录启动。检查任务 Actions[0].Execute 指向新目录的 rh-hold.exe，并确认新的 daemon PID 和路径；原 holder 和 agent 应继续完成回合。若两分钟后新控制面仍未就绪，先记录任务历史与进程快照，再用 `Start-ScheduledTask -TaskName RhodiumPreview` 手动救援。旧 holder 还在时不要删除旧程序目录。

## 日志和反馈

在当前版本目录，一条命令生成诊断 ZIP 并打印其完整路径：

~~~powershell
.\collect-feedback.ps1
~~~

包内有任务状态、Windows 构建号、时区、进程时间、近 48 小时的此任务事件摘要（系统启用历史时）、各 holder 日志大小与最近更新时间。任务计划程序中的“历史记录”也可就地查看；未启用应记“无历史”。daemon 的常规日志写 stderr，计划任务没有单独的 daemon.log。原始 `$data\state\hold\<会话>\err.log` 是 agent 的标准错误，in.log/out.log 是对话与协议原文，rh.db 是数据库，**均不会被诊断脚本打包**。如需更详细错误，只抄与故障直接相关的短句。

反馈给发包者时附：预览版本、Windows 版本、通过/失败/待测表、失败复现步骤和已检查的诊断 ZIP。**先解压检查**，从文字、图片、原始日志中删去 Bot token、配对码、API key、账号/聊天 ID、SID、用户名、私人路径、对话和工具输出。不要发送 config.toml、数据库或整份状态目录。

目录框接受 C:\、C:/ 和 ~\，统一显示正斜线。到盘符根后“上一级”停用，可直接输入另一个盘符。从“+ → 导入”选择目录和记录。命令行含目标会话 ID 或 Herdr pane 报告同一会话时拒绝导入；无关的同种 agent 可以继续运行。未报告 ID 的活跃会话仍需由你先退出，以免同时写入。

此预览支持 Rhodium 为 Claude、Codex、pi 创建的 TUI pane。可导入正在运行的 Claude pane；pi pane 仅在凭据检查确认四项均为空或缺失时才可接管；Codex pane 暂不接管，rh stop --all、rh trace 暂不提供。本机 rh 的本人专属命令会被拒；已有的特权管理入口在本人网页或已配对 IM 上。

## Claude Code、Codex、pi 槽位和网页终端

1. 在本机为要测的 CLI 完成本人登录并确认能独立回复；pi 使用自己的提供商和登录。在预览配置的 `[programs]` 下填入这些 CLI 及 `herdr` 的路径，在 `[herdr]` 下填 `session = "rhodium-test-preview"`。启动新的命名测试会话：在另一终端运行 `herdr --session rhodium-test-preview server`，再让预览服务加载配置。记下 Rhodium、Herdr（探针用 0.9.5）和各 CLI 版本。

Windows 的 `[programs]` 支持以下入口。填绝对路径时可用 TOML 单引号保留反斜线。路径检查在停止旧无头进程前执行。

| 槽位 | Windows 终端启动方式 |
|---|---|
| Claude Code | 原生 `claude.exe`，或官方 npm `claude.cmd`。当前 npm 包运行其原生目标；旧包由 Node 运行包声明的 JS 入口。 |
| Codex | 原生 `codex.exe`，或官方 npm `codex.cmd` 的 Node 入口。 |
| pi | 原生 `pi.exe`、标准 npm `pi.cmd`，或 pi.dev 的 `install.ps1` 生成且完整匹配官方模板的 `pi.cmd`。最后这一种按模板选 Node，运行原来的 `pi-launcher.js`，保留启动器的更新环境；Rhodium 核对运行 agent 的内层 Node 的 PID 和创建时间。 |

遇到自写或被改过的 cmd/bat，记下界面提示，在 `programs.claude`、`programs.codex` 或 `programs.pi` 中指定对应的受支持入口，再试切换。

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

## 卸载

先在网页停止本次测试的各槽位，备份自己需要的测试结果。以下仅针对本文约定的测试任务和文件夹。配置中绑定的是测试 Bot，可在 @BotFather 撤销它的 token。删除本机目录不会自动撤销 Telegram token。

~~~powershell
$apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
$data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
Set-Location $env:USERPROFILE
Disable-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview | Out-Null
Stop-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview
Unregister-ScheduledTask -TaskPath '\' -TaskName RhodiumPreview -Confirm:$false
$remaining = @(Get-Process -Name rhodium,rh-hold -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($apps+'\',[StringComparison]::OrdinalIgnoreCase) })
foreach ($p in $remaining) { if (-not $p.HasExited) { $p.Kill() }; $p.WaitForExit() }
Remove-Item -LiteralPath $apps,$data -Recurse -Force
~~~

这会删除测试配置、Bot 凭据、Rhodium 历史和所有预览版本。手动删除测试工作目录、下载 ZIP 和反馈 ZIP。agent 自己的登录/记录仍由原 CLI 管理；不要删除整个 .claude、.codex 或 .pi 目录。
