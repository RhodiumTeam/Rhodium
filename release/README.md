# Rhodium

在网页上，或者手机上的 QQ、Telegram 里，指挥你 Linux 机器上的 Claude Code：你发消息，它在那台机器上干活，再把过程和结果给你看。

**安装**交给 agent：把这个压缩包交给它，让它照 [INSTALLATION.md](INSTALLATION.md) 装。装好后看下面。

## 登录 Claude

Rhodium 用你在这台机器上的 Claude Code 登录，二选一。这一步你自己做，不要交给 agent。

- **订阅**：在终端里运行 `claude`，按提示用 Pro 或 Max 订阅登录。用量算在订阅额度里。
- **自己的 API 地址和令牌**：按用量计费。
  1. 在 `~/.claude/settings.json` 的 `"env"` 里写上这两项。文件已经有内容的话，只往 `"env"` 里加，别的不动：

     ```json
     {
       "env": {
         "ANTHROPIC_BASE_URL": "https://你的 API 地址",
         "ANTHROPIC_AUTH_TOKEN": "你的令牌"
       }
     }
     ```

  2. 用的不是 Anthropic 官方的地址时，服务商要求的话，再加上模型变量，例如 `ANTHROPIC_MODEL`。
  3. 在终端里运行 `claude`，能正常对话就好了。
  4. 不要写在 `.bashrc`、`.zshrc` 里 `export`：Rhodium 是后台服务，看不到它们。

## 几个词

- **槽位**：一段 Claude Code 对话，固定在一个目录里干活。写成 `工作区/槽位`，例如 `work/main`。
- **工作区**：一组槽位，带一个默认目录。
- **Bot**：你在 QQ 或 Telegram 上建的机器人。你私聊它的消息，交给它绑定的槽位。

## 网页

日常用网页就够了：建槽位、聊天、换模型、改设置、看终端，都在上面点。

### 打开

地址装完时 agent 会告诉你。按装的时候选的方式打开：

- **Tailscale**（默认）：地址形如 `https://<机器名>.<网络名>.ts.net:7800/`。在手机或电脑上装 Tailscale，登录装的时候填的那个账号，就能打开。别的账号打不开。
- **只在本机**：在那台机器的浏览器里打开 `http://127.0.0.1:7800/`。在你自己的电脑上，先运行 `ssh -L 7800:127.0.0.1:7800 <账号>@<那台机器>`，连着的时候打开 `http://localhost:7800/`。
- **Cloudflare**：打开 `https://<你的主机名>/`，先过 Cloudflare Access 的登录。怎么配见下面。

手机上可以“添加到主屏幕”，当 App 用。

装的时候没配网页的话，跳到下面的“IM”，用 QQ 或 Telegram 也行。

### 经 Cloudflare 打开

不用 Tailscale，想经自己的域名从公网打开的，可以用 Cloudflare Tunnel 加 Access。Cloudflare 上的事你自己做，不要交给 agent：

1. 选一个只给网页用的主机名，例如 `board.example.com`。它的域名要在你的 Cloudflare 账号里。
2. 在 Cloudflare Zero Trust 里建一条 Tunnel，照它给的命令在那台机器上装好 cloudflared。
3. 给这条 Tunnel 加上这个主机名，服务填 `http://127.0.0.1:7800`。
4. 在这个主机名上打开 “Protect with Access”。Access 应用只管这个主机名，策略只放你自己的邮箱。
5. 把主机名告诉 agent。它写进 Rhodium 的配置，再用 `rh doctor` 核对：不登录打不开才对。

要知道：

- 不要用 trycloudflare 的临时隧道（`cloudflared tunnel --url ...`）。它没有 Access，拿到地址的人都能控制那台机器。
- Cloudflare 看得到明文：对话、你上传的文件、网页终端的每次按键和每一屏。介意就用 Tailscale。
- 认人全靠 Access。Cloudflare 账号要开两步验证。
- Access 的登录过期后（默认 24 小时），页面自己转去登录。

### 第一次用

1. 首页右上角点 **＋**，选 **新建槽位**。
2. 选一个已经存在的目录（例如你的项目目录）：在路径框里输入，或者在下面的文件夹列表里点进去。这个目录还不属于哪个工作区时，会给它新建一个，名字在 **工作区名** 框里改（例如 `work`）。
3. 槽位名填 `main`，agent 点 Claude 的图标，点 **新建**。这台机器上装好并登录了 Codex 或 pi 的，也可以点它们的图标。
4. 进到这个槽位，在下面的输入框里说一句话。Claude 在那个目录里开始干活，过程实时显示。

### 常用操作

- **停下**：Claude 在干活时，输入框旁边有停止键。
- **输入框下面一排**：换 agent、换模型和思考强度、开关 ultracode、切到终端。
- **命令**：在输入框里打 `/`，列出这个槽位能用的命令。
- **顶栏的 ⋯**：开新对话、压缩上下文、改名、归档。
- **顶栏的“详情”**：
  - 设置。其中“审批模式”打开后，Claude 每次运行命令、改文件前都先问你；默认是关的，它不问就做。
  - 时间线：回到这个槽位以前的对话。
- **Claude 问你问题时**，页面上出现一张卡片，点选或打字回答。
- **首页**能在列表和拓扑图之间切换。拓扑图画出 Bot、聊天窗口和槽位怎么连，也能在上面改。
- **列表里的一行**：右键（手机上长按）弹出菜单，可以停止、开新对话、改名、切到终端、置顶、归档。置顶的槽位固定在列表上面。
- **列表的顺序**：最上面是需要你回答的，然后是置顶的，其余按最近一次开始或结束干活的时间排，新的在上。
- **网页的提醒**：电脑上网页不在前台时，你从网页发起的活干完了、或者 Claude 有问题等你回答，会弹一条系统通知；打开那个对话，通知自己消失。宽屏侧栏左下角的齿轮里能关掉，也能换主题。

## IM：在 QQ、Telegram 里用

有了 Bot，不开网页也能在手机的聊天软件里指挥 Claude。Bot 要在那台机器的终端里用 `rh` 命令建，每个 Bot 只建一次。

### 建 Bot

先要有一个槽位，Bot 建好就绑定到它。网页上建过就用那个；没有网页的话，在终端里建：

```sh
rh ws work ~/work      # 建工作区 work，默认目录 ~/work（目录要已经存在）
rh new work/main       # 在里面建槽位 main
```

然后二选一：

- **Telegram**
  1. 在 Telegram 里找 @BotFather，发 `/newbot`，按提示起名，拿到一串 token。
  2. 运行 `rh bot tg telegram work/main`，粘贴 token（屏幕上不显示），回车。
  3. 屏幕上出现一个配对码。10 分钟内在 Telegram 里私聊你的新 Bot，把码发给它。它回“已配对”就好了。
- **QQ**
  1. 运行 `rh bot qq qq work/main`，屏幕上出现二维码。
  2. 用手机 QQ 扫码，点“创建新机器人”。不要选标着“在线”的。
  3. 扫码的 QQ 号一般自动算作你，不用再配对。屏幕上要是出现了配对码，就照 Telegram 的第 3 步做。
  4. 在手机 QQ 里打开和这个新机器人的私聊。

命令里的 `tg`、`qq` 是你给 Bot 起的名字，只能用英文字母、数字、`_` 和 `-`。

**配对**让 Bot 只认你的账号：别人给它发消息，它不理，也不会触发 Claude。

你有几个自己的账号（例如 QQ 小号）时，可以都配给同一个 Bot：`rh pair <Bot名> --add` 再拿一个码，用小号私聊 Bot 发过去。也可以在聊天里让 Claude 加，码由 Rhodium 直接发给你，Claude 看不到。每个号的私聊是一个窗口，在里面发 `/rh_use <槽位>` 就能各指一个槽位。`rh pair <Bot名> --list` 看有哪些号，`--rm <账号>` 去掉一个，再用 `rh forget <Bot名>/<账号>` 把它的窗口从列表里去掉。只配你自己的号。

### 在 IM 里聊

私聊你的 Bot，说一句话，Claude 就在那个槽位里干活，过程和回复都发回这个聊天。常用命令：

| 命令 | 作用 |
|---|---|
| `/rh_help` | 首页，Rhodium 的功能都在这里，点按钮就行 |
| `/status` | 看状态，下面有换模型、开新对话等按钮 |
| `/stop` | 停下 Claude 正在做的事 |
| `/new` | 开一段新对话 |
| `/model` | 换模型 |
| `/rh_ls` | 列出所有槽位 |
| `/rh_use` | 让这个聊天改和另一个槽位说话 |

别的 `/` 命令原样交给 Claude。

### 主窗口（建议设）

Rhodium 有事找你、又不知道发到哪个聊天时，就发到主窗口。在配置文件 `~/.config/rhodium/config.toml` 开头那行 `# mainChat` 下面加一行，必须在任何 `[方括号]` 之前：

- Telegram：`mainChat = "tg/<你的 Telegram 数字 ID>"`。数字 ID 可以私聊 @userinfobot 问到。
- QQ：`mainChat = "qq/<owner>"`，`<owner>` 抄这个文件里 `[bots.qq]` 下面 `owner` 那一行引号里的值。

把 `tg`、`qq` 换成你给 Bot 起的名字。然后运行 `systemctl --user restart rhodium`，正在进行的对话不受影响。再运行 `rh ls`：报“连不上 rhodium”就是写错了，运行 `journalctl --user -u rhodium -n 5` 看原因。

终端里运行 `rh`，能看到所有命令。

## 在终端里接着聊（装了 Herdr 才有）

把一段对话从网页或 IM 搬进终端里的 Claude，用你熟悉的 Claude Code 界面接着做：

- **切过去**：网页上点输入框下面的“切到终端”，选“跑完再切”或“打断，马上切”。IM 里发 `/rh_tui`。
- **在哪用**：网页上，这个槽位的页面直接变成终端，可以打字操作。在那台机器上运行 `herdr --session rhodium` 也能看到它。
- **切回来**：在终端里退出 Claude（输入 `/exit`），对话回到网页和 IM，接着聊。
- **卡住了**：网页顶栏的 ⋯ 里点“收回终端”，或在 IM 里发 `/rh_release`，强制切回来。

## 要知道的

- Claude 用你自己的登录：订阅算额度，API 令牌按用量计费。
- 想用 Codex：自己装好 `codex` 并登录。ChatGPT 账号，或在 `~/.codex/config.toml` 里配自己的服务商都行；令牌别写在 `.bashrc` 的 `export` 里，Rhodium 的服务看不到。`rh doctor` 会写出 Codex 的版本和登录方式。
- 只有你能指挥 Claude：网页走 Tailscale 时只认你的 Tailscale 账号，Bot 只认配对的账号。别把它们交给别人用。
- 网页选了只在本机或 Cloudflare，Rhodium 自己不认人：打得开网页的人就能完全控制它，包括终端。那台机器上有别人的账号时别这么用，他们也打得开。
- 关机重启后 Rhodium 会自己启动。
- 有了新版本的压缩包，交给 agent，让它照 INSTALLATION.md 的“以后升级”做。

## 出问题时

| 情况 | 做什么 |
|---|---|
| 网页打不开，或 Bot 不回消息 | 在那台机器上运行 `rh doctor` 自检，`systemctl --user status rhodium` 看服务 |
| 看日志 | `journalctl --user -u rhodium -f` |
| 让所有 agent 立刻停下 | `rh stop --all` |
| 重启 Rhodium | `systemctl --user restart rhodium` |
| 提示找不到 `rh` | 用 `~/.local/bin/rh` 代替，或者把 `~/.local/bin` 加进你的 `PATH` |
