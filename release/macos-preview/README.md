这篇回答：macOS 预览版装好以后，怎么在终端里接着聊、从手机打开网页、建 Bot、升级、不让 Mac 睡着，以及出问题时怎么查。

前置阅读：同包的 TESTING.md（安装、系统服务和卸载）。

# Rhodium macOS 预览版说明

下面沿用 TESTING.md 的约定：测试目录是 `~/rhodium-test`，配置是 `~/rhodium-test/config.toml`，`~/rhodium-test/current` 指向在用的版本目录。

改了配置以后，要重启 Rhodium 才生效。先等所有槽位空闲：

- 用系统服务时：

  ~~~sh
  sudo "$HOME/rhodium-test/macos-admin" uninstall
  sudo "$HOME/rhodium-test/macos-admin" install
  ~~~

- 在终端里手动运行时：在那个终端按 Ctrl-C，再照 TESTING.md 重新运行。

## 开始之前

Rhodium 运行的是你自己装的 Claude Code、Codex 和 pi。在你自己的终端里能启动、能回话的，在 Rhodium 里一般就能用，不用另外登录。有三个例外：

- **只写在 `~/.zshrc` 这类文件里的环境变量带不过来。** Rhodium 由系统服务启动，不读 shell 的配置文件。登录信息存在文件里的不受影响。
- **pi 拿不到 Anthropic 的四个环境变量。** `ANTHROPIC_API_KEY`、`ANTHROPIC_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL` 会被去掉，免得 pi 用上 Claude 的订阅。请给 pi 配它自己的提供商。
- **Claude 的订阅登录还没在系统服务里验证过。** macOS 上 Claude 把订阅凭据存在钥匙串里，系统服务能不能读到还没测。用订阅时，先建一个 Claude 槽位发一句话试试；不行就先在终端里手动运行 Rhodium，并告诉发包者。

系统服务的 PATH 里有 `~/.local/bin`、`/opt/homebrew/bin` 和 `/usr/local/bin`。CLI 装在别处时，在配置的 `[programs]` 里写绝对路径，例如 `claude = '/Users/你/bin/claude'`。

这是测试包，没有 Apple 的签名和公证，所以要照 TESTING.md 对核对过 SHA256 的目录去掉下载隔离标记。

## 在终端里接着聊：装 Herdr（推荐）

Herdr 是一个终端工作区程序。装了它，槽位才能“切到终端”，用 agent 自己的界面接着聊；网页上也才有“终端”。也能把你在 Herdr 里自己开的 Claude、pi 导入成槽位。

不装也行：其他功能照常，只是“切到终端”和网页终端不出现。

**1. 安装。** 有 Homebrew 的话：

~~~sh
brew install herdr
herdr --version
~~~

应看到 `herdr 0.9.5` 或更新。Homebrew 装在 `/opt/homebrew/bin`，系统服务找得到，不用改配置。

没有 Homebrew 的话，下载官方程序并核对：

~~~sh
mkdir -p ~/.local/bin
curl -fL -o ~/.local/bin/herdr.new https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-macos-aarch64
echo "fb77c2232a05a8035421382c894392f4174e4e38a18e48af3dd0290157c3a7e2  $HOME/.local/bin/herdr.new" | shasum -a 256 -c
chmod +x ~/.local/bin/herdr.new && mv ~/.local/bin/herdr.new ~/.local/bin/herdr
xattr -d com.apple.quarantine ~/.local/bin/herdr 2>/dev/null; ~/.local/bin/herdr --version
~~~

应看到 `herdr.new: OK`，然后 `herdr 0.9.5`。显示 `FAILED` 就删掉 `~/.local/bin/herdr.new`，不要继续。

装好后照本文开头重启 Rhodium。

**2. 让 Herdr 在后台跑着。** 在终端里运行一次 `herdr`。关掉窗口后，它的会话仍在后台；重启电脑后要再运行一次。Rhodium 默认用名为 `default` 的会话，就是直接运行 `herdr` 时的那个。

**3. 建议做的两件事：**

- 运行 `herdr integration install claude` 和 `herdr integration install pi`。装了以后，Herdr 里的 Claude、pi 会报告自己在用哪段对话，Rhodium 才能看到它们的状态，并从 pane 导入。这两条命令会写入 Claude 的设置和 pi 的扩展目录。
- 打开 `~/.config/herdr/config.toml`（没有就新建），加上：

  ~~~toml
  [session]
  resume_agents_on_restore = false
  ~~~

  不关的话，Herdr 重启时 Rhodium 若不在线，它会把已经切回无头的对话再开一份。`rh doctor` 也会一直为这个告警。

Codex 能切到终端，但 Herdr 里你自己开的 Codex 还不能导入。

## 从手机打开网页：Tailscale

刚装好时，网页只在这台 Mac 上打得开（`http://127.0.0.1:17861/`）。要从手机或别的电脑打开，用 Tailscale：它把你的设备连成一个只有你能进的私有网络。

**1. 装 Tailscale。** Mac 上从 https://tailscale.com/download/macos 下载安装，手机上装 Tailscale App，两边登录同一个账号。Mac 上在 Tailscale 菜单的设置里装上命令行工具，让终端里能用 `tailscale`。

**2. 查你的 Tailscale 账号：**

~~~sh
tailscale status --json | grep -o '"LoginName": *"[^"]*"' | sort -u
~~~

列出的账号里，认出你自己的那个，例如 `you@example.com` 或 `you@github`。

**3. 改配置。** 在 `~/rhodium-test/config.toml` 的 `[board]` 下，删掉 `auth = "none"` 这一行，加上你的账号：

~~~toml
[board]
bind = "127.0.0.1"
port = 17861
login = "you@example.com"
~~~

照本文开头重启 Rhodium，再检查：

~~~sh
curl -s http://127.0.0.1:17861/
~~~

应看到“只有配置文件 [board] login 里的 Tailscale 账号能看这个看板。”。这说明网页起来了，本机直接访问没带 Tailscale 账号，所以被拒，这是对的。

**4. 发布到你的私有网络：**

~~~sh
tailscale serve --bg --https=17861 http://127.0.0.1:17861
tailscale serve status
~~~

应看到一行 `https://<电脑名>.<网络名>.ts.net:17861`，在手机上打开它。

不对时：

- 打印了一个链接，说要开启 HTTPS：在浏览器里打开它并开启，再运行一次。
- 必须写 `--https=17861` 这种带端口的形式。不带端口的写法会占用 443 端口，覆盖你已有的设置。
- 不想发布了：`tailscale serve --https=17861 off`。

### 安全

谁打开了这个网页，谁就能完全控制这台 Mac：指挥 agent、用网页终端、读写文件。所以：

- **用 Tailscale 时**，Tailscale 会告诉网页来访的是哪个账号，网页只放行 `login` 写的那一个。同一个私有网络里的其他人和共享给你的设备都进不来。
- **`bind` 保持 `127.0.0.1`。** 不要改成 `0.0.0.0`，也不要在路由器上做端口转发。
- **不要在网页前面再接别的代理**，例如 nginx：它会把请求变成从本机来的，别人就能冒充你。
- **`auth = "none"`（刚装好时就是这样）不认人**：这台 Mac 上的任何程序、任何账号都能打开网页。只在只有你一个人用的 Mac 上这样用。
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

本机的 `rh` 不能建 Bot：建 Bot、配对这类只有你本人能做的事，在网页或已配对的聊天里做。

在聊天里，`/rh_help` 是首页，点按钮就能用大部分功能。`/stop` 停下 agent，`/new` 开新对话，`/rh_use` 改和另一个槽位说话。

## 升级

1. 核对新包的 SHA256，解压到 `~/RhodiumPreview-apps` 下**另一个**目录，旧目录不动。进入新目录，去掉下载隔离标记，确认版本：

   ~~~sh
   xattr -dr com.apple.quarantine "$PWD"
   ./rhodium --version
   ~~~

2. 等所有槽位空闲，把 `current` 指向新目录，再照本文开头重启：

   ~~~sh
   ln -sfn "$PWD" ~/rhodium-test/current.new && mv -fh ~/rhodium-test/current.new ~/rhodium-test/current
   ~~~

3. 先别删旧目录：还在跑的 agent 可能仍在用它。等 `rh doctor`（见下文）不再报“还在跑旧版的托管进程”，再删。

## 别让 Mac 睡着

Mac 睡着时，手机上的消息没人处理，网页也打不开，醒来联网后才继续。锁屏不影响。

- **Mac mini、iMac 这类台式机**：在“系统设置 → 能耗”里打开“显示器关闭时，防止自动进入睡眠”和“唤醒以供网络访问”。顺便打开“断电后自动启动”。
- **MacBook**：在“系统设置 → 电池 → 选项”里打开“使用电源适配器且显示器关闭时，防止自动进入睡眠”，并接着电源。合上盖子仍会睡眠。
- 也可以在终端里设：`sudo pmset -c sleep 0`（接电源时不睡眠），用 `pmset -g` 查看。
- 开了 FileVault 的 Mac 重启后，要先在本机输入密码解锁，系统才会启动，Rhodium 才会运行。

## 出问题时

先运行自检。它只报错误和告警：

~~~sh
RHODIUM_SOCKET="$HOME/rhodium-test/run/rh.sock" ~/rhodium-test/current/rhodium rh doctor
~~~

| 现象 | 先看什么 |
|---|---|
| Bot 和网页都没反应 | `sudo "$HOME/rhodium-test/macos-admin" status` 是否在运行；再看 `~/rhodium-test/daemon.log` 的最后几行 |
| 槽位报“找不到 agent 程序” | 在 `[programs]` 里写这个 CLI 的绝对路径，重启 Rhodium |
| 没有“切到终端” | Herdr 没装好，或装在系统服务找不到的地方；在 `[programs]` 里写 `herdr` 的绝对路径 |
| 切到终端失败 | Herdr 的会话没在跑：运行一次 `herdr` |
| 手机打开网页是 403 | `login` 和你的 Tailscale 账号对不上，回到“从手机打开网页”第 2 步 |
| agent 报错退出 | 网页上这个槽位的“详情”里有它的错误输出 |
| 开机后没自己起来 | 看 `~/rhodium-test/observations.log`，见 TESTING.md 的“开机未登录” |

反馈问题时，附上版本（`./rhodium --version`）、macOS 版本、怎么复现，和 `rh doctor` 的输出。发之前删掉 token、配对码、API key、账号 ID 和对话内容。不要发 `config.toml`、数据库或整个 `~/rhodium-test`。
