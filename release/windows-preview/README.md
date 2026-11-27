这篇回答：Windows 预览版装好以后，怎么在终端里接着聊、从手机打开网页、建 Bot、升级，以及出问题时怎么查。

前置阅读：同包的 TESTING-zh.md（安装和第一次对话）。

# Rhodium Windows 预览版说明

下面的 `$apps`、`$app`、`$data` 和任务名 `RhodiumPreview` 沿用 TESTING-zh.md 里的写法。新开的 PowerShell 先用这三行找回它们：

~~~powershell
$apps = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-apps'
$data = Join-Path $env:LOCALAPPDATA 'RhodiumPreview-data'
$app = Split-Path (Get-ScheduledTask -TaskName RhodiumPreview).Actions[0].Execute
~~~

改了 `$data\config.toml` 以后，要重启任务才生效。先等所有槽位空闲，再运行：

~~~powershell
Stop-ScheduledTask -TaskName RhodiumPreview; Start-ScheduledTask -TaskName RhodiumPreview
~~~

## 开始之前

Rhodium 运行的是你自己装的 Claude Code、Codex 和 pi。在你自己的 PowerShell 里能启动、能回话的，在 Rhodium 里就能用，不用另外登录。只有三个例外：

- **只写在 PowerShell profile 里的环境变量带不过来。** Rhodium 由计划任务启动，不读 profile。登录信息存在文件里的不受影响；在“系统属性 → 环境变量”里设的用户变量也带得过来。
- **pi 拿不到 Anthropic 的四个环境变量。** `ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 会被去掉，免得 pi 用上 Claude 的订阅。请给 pi 配它自己的提供商。
- **程序要找得到。** 计划任务里的 PATH 可能和你的终端不同。找不到时，在配置的 `[programs]` 里写绝对路径，见 TESTING-zh.md 第 2 步。

这是测试包，没有代码签名。Windows 可能提示“已保护你的电脑”；只对核对过 SHA256 的这个包选“更多信息 → 仍要运行”。

## 在终端里接着聊：装 Herdr（推荐）

Herdr 是一个终端工作区程序。装了它，槽位才能“切到终端”，用 agent 自己的界面接着聊；网页上也才有“终端”。也能把你在 Herdr 里自己开的 Claude、pi 导入成槽位。

不装也行：其他功能照常，只是“切到终端”和网页终端不出现。

**1. 下载并核对。** 在 PowerShell 里运行：

~~~powershell
$dir = Join-Path $env:LOCALAPPDATA 'Programs\herdr'
$zip = Join-Path $env:TEMP 'herdr-windows-x86_64.zip'
Invoke-WebRequest 'https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-windows-x86_64.zip' -OutFile $zip
(Get-FileHash -Algorithm SHA256 $zip).Hash -eq 'D2C6C9C971C43A0BFDDE8C692A9A1A7A45C3E4807CD01AE45662B4734FAC1CBF'
~~~

最后一行应打印 `True`。打印 `False` 就删掉这个文件，不要继续。

**2. 解压，确认能运行：**

~~~powershell
Expand-Archive -LiteralPath $zip -DestinationPath $dir -Force
$herdr = (Get-ChildItem -LiteralPath $dir -Recurse -Filter herdr.exe | Select-Object -First 1).FullName
& $herdr --version
$herdr
~~~

应看到 `herdr 0.9.5`，下一行是 herdr.exe 的完整路径。

**3. 告诉 Rhodium 它在哪。** 打开 `$data\config.toml`，在 `[programs]` 下面加一行，把路径换成上一步打印的那个：

~~~toml
herdr = 'C:\Users\你的用户名\AppData\Local\Programs\herdr\herdr.exe'
~~~

单引号能原样保留反斜线。存好后照本文开头重启任务。

**4. 让 Herdr 在后台跑着。** 在 Windows Terminal 里运行一次 `herdr`。关掉窗口后，它的会话仍在后台；注销或重启后要再运行一次。Rhodium 默认用名为 `default` 的会话，就是直接运行 `herdr` 时的那个。

**5. 建议做的两件事：**

- 运行 `herdr integration install claude` 和 `herdr integration install pi`。装了以后，Herdr 里的 Claude、pi 会报告自己在用哪段对话，Rhodium 才能看到它们的状态，并从 pane 导入。这两条命令会写入 Claude 的设置和 pi 的扩展目录。
- 打开 `%APPDATA%\herdr\config.toml`（没有就新建），加上：

  ~~~toml
  [session]
  resume_agents_on_restore = false
  ~~~

  不关的话，Herdr 重启时 Rhodium 若不在线，它会把已经切回无头的对话再开一份。`rh doctor` 也会一直为这个告警。

Codex 能切到终端，但 Herdr 里你自己开的 Codex 还不能导入。

## 从手机打开网页：Tailscale

刚装好时，网页只在这台电脑上打得开（`http://127.0.0.1:17860/`）。要从手机或别的电脑打开，用 Tailscale：它把你的设备连成一个只有你能进的私有网络。

**1. 装 Tailscale。** 电脑上从 https://tailscale.com/download/windows 下载安装，手机上装 Tailscale App，两边登录同一个账号。

**2. 查你的 Tailscale 账号。** 在 PowerShell 里运行：

~~~powershell
tailscale status --json | ConvertFrom-Json | ForEach-Object { $_.User.PSObject.Properties.Value.LoginName } | Sort-Object -Unique
~~~

列出的账号里，认出你自己的那个，例如 `you@example.com` 或 `you@github`。

**3. 改配置。** 在 `$data\config.toml` 的 `[board]` 下，删掉 `auth = "none"` 这一行，加上你的账号：

~~~toml
[board]
bind = "127.0.0.1"
port = 17860
login = "you@example.com"
~~~

照本文开头重启任务，再检查：

~~~powershell
curl.exe -s http://127.0.0.1:17860/
~~~

应看到“只有配置文件 [board] login 里的 Tailscale 账号能看这个看板。”。这说明网页起来了，本机直接访问没带 Tailscale 账号，所以被拒，这是对的。

**4. 发布到你的私有网络：**

~~~powershell
tailscale serve --bg --https=17860 http://127.0.0.1:17860
tailscale serve status
~~~

应看到一行 `https://<电脑名>.<网络名>.ts.net:17860`，在手机上打开它。

不对时：

- 打印了一个链接，说要开启 HTTPS：在浏览器里打开它并开启，再运行一次。
- 报权限错误：用“以管理员身份运行”的 PowerShell 再运行一次。
- 必须写 `--https=17860` 这种带端口的形式。不带端口的写法会占用 443 端口，覆盖你已有的设置。
- 不想发布了：`tailscale serve --https=17860 off`。

### 安全

谁打开了这个网页，谁就能完全控制这台电脑：指挥 agent、用网页终端、读写文件。所以：

- **用 Tailscale 时**，Tailscale 会告诉网页来访的是哪个账号，网页只放行 `login` 写的那一个。同一个私有网络里的其他人和共享给你的设备都进不来。
- **`bind` 保持 `127.0.0.1`。** 不要改成 `0.0.0.0`，不要在路由器上做端口转发，也不要放行防火墙。
- **不要在网页前面再接别的代理**，例如 nginx：它会把请求变成从本机来的，别人就能冒充你。
- **`auth = "none"`（刚装好时就是这样）不认人**：这台电脑上的任何程序、任何账号都能打开网页。只在只有你一个人用的电脑上这样用。
- 从公网经自己的域名打开（例如 Cloudflare）的方式，这一版还没有说明。

## 建 Bot

有了 Bot，不开网页也能在手机的聊天软件里指挥 agent。

1. 先在网页上建好至少一个槽位，Bot 建好后会绑定到它。
2. 点“+ → 新建 Bot”，选平台：
   - **Telegram**：在 Telegram 里找 @BotFather，发 `/newbot`，按提示起名，把拿到的 token 粘贴到网页上。
   - **QQ**：用手机 QQ 扫网页上的二维码，点“创建新机器人”，不要选标着“在线”的。
   - **飞书**：用飞书扫网页上的二维码。
3. 按网页提示配对：用你自己的账号私聊新 Bot，把配对码发给它。配对后，Bot 只认你的账号，别人发消息它不理，也不会触发 agent。QQ、飞书扫码的账号一般自动算作你。
4. 第一个配对的私聊会成为**主窗口**：Rhodium 有事找你、又不知道发到哪个聊天时，就发到这里。

本机的 `rh.exe` 不能建 Bot：建 Bot、配对这类只有你本人能做的事，在网页或已配对的聊天里做。

在聊天里，`/rh_help` 是首页，点按钮就能用大部分功能。`/stop` 停下 agent，`/new` 开新对话，`/rh_use` 改和另一个槽位说话。

## 升级

1. 核对新 ZIP 的 SHA256，按 TESTING-zh.md 第 1 步解压到 `$apps` 下**另一个**版本目录。旧目录和 `$data` 都不动。
2. 等所有槽位空闲，在新目录里运行：

   ~~~powershell
   .\windows-task.ps1 -TaskName RhodiumPreview -InstallDir (Get-Location).Path -InstanceDir $data -ConfigTemplate .\config.example.toml
   .\rh.exe --version
   ~~~

   版本号应是新包的。已有的配置会保留。
3. 先别删旧目录：还在跑的 agent 可能仍在用它。等 `rh doctor`（见下文）不再报“还在跑旧版的托管进程”，再删。

## 别让电脑睡着

电脑睡着时，手机上的消息没人处理，醒来联网后才继续。锁屏不影响。

- 在“设置 → 系统 → 电源”里，把插电时的“使设备进入睡眠状态”设为“从不”。
- 注销会结束 Rhodium，下次登录后它自动启动。

## 出问题时

先运行自检。它只报错误和告警：

~~~powershell
Set-Location -LiteralPath $app
$env:RHODIUM_SOCKET = Join-Path $data 'run\rh.sock'
.\rh.exe doctor
~~~

| 现象 | 先看什么 |
|---|---|
| Bot 和网页都没反应 | `Get-ScheduledTask -TaskName RhodiumPreview` 是否为 Running；不是就 `Start-ScheduledTask -TaskName RhodiumPreview` |
| 槽位报“找不到 agent 程序” | 在 `[programs]` 里写这个 CLI 的绝对路径，重启任务 |
| 没有“切到终端” | Herdr 没装好，或 `[programs]` 里的 `herdr` 路径不对 |
| 切到终端失败 | Herdr 的会话没在跑：运行一次 `herdr` |
| 手机打开网页是 403 | `login` 和你的 Tailscale 账号对不上，回到“从手机打开网页”第 2 步 |
| agent 报错退出 | 网页上这个槽位的“详情”里有它的错误输出 |

要把问题反馈给发包者时，在版本目录运行 `.\collect-feedback.ps1`，它会生成一个诊断 ZIP。发之前先解压看一遍，删掉 token、配对码、API key、账号 ID 和对话内容。不要发 `config.toml`、数据库或整个 `$data`。更多见 TESTING-zh.md 的“日志和反馈”。
