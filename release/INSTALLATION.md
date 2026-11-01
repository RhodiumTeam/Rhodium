# 安装 Rhodium

这篇回答：怎么在一台 Linux 机器上从这个压缩包装好 Rhodium，让它作为服务一直运行。写给替用户安装的 agent，照着从头做到尾即可。

前置阅读：无。装好以后，用户看同一个包里的 `README.md` 学怎么用。

## 先读：规矩

- 用 bash 执行下面的命令。每个代码块都能单独运行，不依赖上一个块里设的变量。
- 用用户自己的普通账号安装，不要用 root，也不要在命令前加 `sudo`。只有写明“请用户执行”的那几条要用 `sudo`，由用户自己执行。
- 每一步都先看“应该看到”。对不上就按“不对时”处理。处理不了就停下，把命令和完整输出告诉用户，不要猜着往下做。
- 写着“问用户”的地方，必须停下来问，拿到回答再继续。
- 不要替用户登录 Claude，不要建 Bot。这些是用户的事，写在 `README.md` 里。
- 不要碰 Bot 的 token 和 Claude 的 API 令牌：不读出，不打印，不替用户写。`~/.claude/settings.json` 里可能有令牌，不要用 `cat` 之类的命令看它。
- 不要修改这些目录里已有的东西：`~/.claude`、`~/.config/herdr`、`~/.pi`。
- 不要删除或覆盖用户已有的文件。下面会新建的文件和目录：
  - `~/.local/opt/rhodium/`：程序。
  - `~/.local/bin/rh`：命令行入口。
  - `~/.config/rhodium/`：配置。
  - `~/.local/state/rhodium/`：数据，服务第一次启动时自己建。
  - `~/.config/systemd/user/rhodium.service`：服务，由安装脚本写。
  - `~/.config/systemd/user/rhodium-herdr.service`：Herdr 的服务，只在第 5 步用 Herdr 时才有。
  - 第 1 步会检查这些是不是已经存在。

## 第 1 步：检查机器

```bash
uname -m
id -u
echo "XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR"
systemctl --user is-system-running
systemctl --version | head -n 1
loginctl show-user "$USER" -p Linger
command -v tar xz curl
df -h "$HOME" | tail -n 1
for f in ~/.local/opt/rhodium ~/.local/bin/rh ~/.config/rhodium ~/.config/systemd/user/rhodium.service ~/.config/systemd/user/rhodium-herdr.service; do [ -e "$f" ] && echo "已存在：$f"; done; true
```

应该看到：

- `uname -m` 是 `x86_64` 或 `aarch64`。
- `id -u` 不是 `0`。
- `XDG_RUNTIME_DIR` 有值，例如 `/run/user/1000`。
- `systemctl --user is-system-running` 是 `running` 或 `degraded`。
- systemd 版本 245 或更新，例如 `systemd 255 (...)`。
- `Linger=yes`。
- `tar`、`xz`、`curl` 三个都打印出路径。
- 家目录所在磁盘剩余 3G 以上。
- 没有以 `已存在：` 开头的行。

不对时：

- 两个都不是：Rhodium 不支持这台机器。停下，告诉用户。
- `id -u` 是 `0`：你在用 root。停下，请用户换成自己的普通账号登录，再从头开始。
- `XDG_RUNTIME_DIR` 为空，或 `systemctl --user` 报 `Failed to connect to bus`：这个 shell 不是用户直接登录得来的（例如用了 `su`）。请用户直接用自己的账号 ssh 登录，再从头开始。
- `is-system-running` 是 `offline` 或别的：这台机器没有 systemd 用户服务（例如容器、没开 systemd 的 WSL）。停下，Rhodium 在这里装不了。
- systemd 低于 245：停下，告诉用户系统太旧。
- `Linger=no`：运行 `loginctl enable-linger "$USER"`，再查一次。还是 `no` 或者报权限错误，请用户执行 `sudo loginctl enable-linger <用户名>`。没有 linger，用户退出登录后服务就停了。
- 缺 `xz`：请用户安装。Debian、Ubuntu 是 `sudo apt install xz-utils`，Fedora、Rocky 是 `sudo dnf install xz`，Arch 是 `sudo pacman -S xz`。缺 `curl` 同理。
- 磁盘不到 3G：告诉用户。剩余不到 2G 时 Rhodium 不开新对话。
- 有 `已存在：` 的行：这台机器以前装过 Rhodium。停下，把这几行告诉用户，问用户是要升级（见文末“以后升级”）、先卸载再装（见文末“卸载”），还是停止。不要覆盖这些文件，里面可能有用户的 Bot token 和对话数据。

## 第 2 步：找到用户的程序

服务不经过用户的 shell 启动，看不到用户在 `.bashrc`、`.zshrc` 里加的 `PATH`（例如 nvm）。这一步从用户的登录 shell 里取出 `PATH`，存起来给服务用。

```bash
mkdir -p ~/.config/rhodium
LOGIN_PATH=$(timeout 20 "$SHELL" -ic 'echo "PATH_IS=$PATH"' </dev/null 2>/dev/null | grep '^PATH_IS=' | tail -n 1 | cut -d= -f2-)
printf '%s' "$HOME/.local/opt/rhodium/current:$LOGIN_PATH:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin" | tr ':' '\n' | grep '^/' | awk '!seen[$0]++' | paste -sd: - > ~/.config/rhodium/service-path
cat ~/.config/rhodium/service-path
for p in claude node herdr pi codex tailscale; do printf '%-10s ' "$p"; PATH="$(cat ~/.config/rhodium/service-path)" command -v "$p" || echo "（没有）"; done
PATH="$(cat ~/.config/rhodium/service-path)" claude --version
```

应该看到：

- 第一行是一串用 `:` 隔开的目录，第一个是 `/home/<用户>/.local/opt/rhodium/current`。
- `claude` 一行打印出路径。
- 最后一行是 Claude Code 的版本，例如 `2.1.310 (Claude Code)`。
- `node`、`herdr`、`pi`、`codex`、`tailscale` 有没有都行，后面几步会用到这个结果。

不对时：

- 第一行只有 `/home/<用户>/.local/opt/rhodium/current:/home/<用户>/.local/bin:/usr/local/bin:/usr/bin:/bin`：没取到用户的 `PATH`。
  - 用户的 shell 是 fish（`echo $SHELL` 以 `fish` 结尾）：把块里第二行换成 `LOGIN_PATH=$(fish -c 'string join : $PATH')`，整块重跑。
  - 别的情况：请用户在自己的终端里运行 `echo $PATH`，把结果发给你。把块里第二行换成 `LOGIN_PATH="用户给的结果"`，整块重跑。
- `claude` 没有：问用户装没装 Claude Code。没装，请用户先装好（官方装法：`curl -fsSL https://claude.ai/install.sh | bash`），再照解压出来的包里 `README.md` 的“登录 Claude”登录：用 Pro 或 Max 订阅，或者用自己的 API 地址和令牌。装好后从这一步重来。
- `claude --version` 报 `node: No such file or directory` 之类：`node` 不在这串目录里。请用户在自己的终端里运行 `command -v node`，把结果发给你。去掉结果末尾的 `/node`，就是 node 所在的目录，填进下面第一行的引号里运行，再跑一次 `PATH="$(cat ~/.config/rhodium/service-path)" claude --version`：

  ```bash
  NODE_DIR="/填/node/所在的目录"
  sed -i "s|\$|:$NODE_DIR|" ~/.config/rhodium/service-path
  cat ~/.config/rhodium/service-path
  ```

- 不要用别的办法改 `service-path`。它必须只有一行。

## 第 3 步：解压程序

把用户给你的压缩包完整路径填进第一行的引号里。你之前为了读这篇已经解压到别处也没关系，这里再解一次到固定位置。

```bash
PKG="/填/压缩包的/完整路径/rhodium-版本-linux-架构.tar.xz"
NAME=$(tar -tJf "$PKG" | head -n 1 | cut -d/ -f1)
echo "包里的目录：$NAME"
mkdir -p ~/.local/opt/rhodium/versions ~/.local/bin
tar -xJf "$PKG" -C ~/.local/opt/rhodium/versions
ln -sfn "versions/$NAME" ~/.local/opt/rhodium/current
ln -sfn ~/.local/opt/rhodium/current/rh ~/.local/bin/rh
ls -l ~/.local/opt/rhodium/current/
~/.local/opt/rhodium/current/rhodium --version
~/.local/opt/rhodium/current/rh-hold --version
~/.local/bin/rh --version
```

应该看到：

- `包里的目录：rhodium-<版本>-linux-<架构>`。架构和第 1 步的 `uname -m` 对得上：`x86_64` 的机器是 `x86_64`，`aarch64` 的机器是 `arm64`。
- 目录里有 `INSTALLATION.md`、`README.md`、`rh`（指向 `rhodium`）、`rh-hold`、`rhodium`、`rhodium-service.sh`。
- 三个版本号，例如 `1.0.0-2ea904b`、`1.0.0`、`1.0.0-2ea904b`。

不对时：

- `tar` 报错：压缩包路径不对，或者下载不完整。请用户确认文件。
- 架构对不上，或者运行时报 `Exec format error`：这个包是给另一种 CPU 的。请用户换成文件名以 `linux-x86_64` 或 `linux-arm64` 结尾、和这台机器对得上的那个包，从这一步重来。
- 运行时报 `Illegal instruction`：这台机器的 CPU 太旧，停下告诉用户。

## 第 4 步：写配置

```bash
cd ~/.config/rhodium
umask 077
cat > config.toml <<'EOF'
# Rhodium 的配置文件。改完运行 systemctl --user restart rhodium 才生效。
# 主窗口：Rhodium 有事找你、又不知道该发到哪个聊天窗口时，发到这里。
# 写法见 README.md 的“主窗口”。这一行必须在下面任何 [方括号] 之前。
# mainChat = "<Bot 名>/<聊天 ID>"

[herdr]
session = "rhodium"
EOF
chmod 600 config.toml
printf '[session]\nresume_agents_on_restore = false\n' > herdr.toml
ls -l ~/.config/rhodium/
```

应该看到：`config.toml` 的权限是 `-rw-------`。

说明：

- 配置文件里以后会放 Bot 的 token，所以必须是 `600`，否则 Rhodium 拒绝启动。
- `herdr.toml` 是给 Rhodium 用的 Herdr 会话单独的设置。用不用 Herdr 都写上，不影响用户自己的 Herdr。
- 以后用户用 `rh bot` 建 Bot 时，Rhodium 会自己往这个文件末尾加内容。

## 第 5 步：Herdr（可选）

Herdr 是一个终端工作区程序。有它，用户才能把对话切到终端里（TUI 模式），网页上也才能看到那个终端。没有它，其他功能照常。

看第 2 步 `herdr` 那一行：

- **有路径**：运行 `herdr --version`。是 0.9.2 或更新，跳到下面的“建 Herdr 服务”。低于 0.9.2 也能用，只是网页终端里点击没反应，告诉用户一声，继续。
- **没有**：问用户“要不要装 Herdr（用来在终端里接着对话，以及网页终端）？”。不要就跳到第 6 步。要就装：

```bash
mkdir -p ~/.local/bin
case "$(uname -m)" in
  x86_64) SUM=14d9e8bc8b4a9e0118d77c32266f76d461f09b40342eb23752960bd89f59929d ;;
  aarch64) SUM=17d7536f2da50859523680ef279dffcac8e4a235f4e46fe8da6c2ec44141897c ;;
esac
curl -fL -o ~/.local/bin/herdr.new "https://github.com/herdrdev/herdr/releases/download/v0.9.5/herdr-linux-$(uname -m)"
echo "$SUM  $HOME/.local/bin/herdr.new" | sha256sum -c
chmod +x ~/.local/bin/herdr.new && mv ~/.local/bin/herdr.new ~/.local/bin/herdr
~/.local/bin/herdr --version
```

应该看到：`herdr.new: OK`，然后 `herdr 0.9.5`。

不对时：

- 下载失败或很慢：可能连不上 GitHub。问用户有没有代理；有就在 `curl` 后面加 `-x <代理地址>` 再试。也可以请用户自己下载这个文件放到 `~/.local/bin/herdr`。
- `sha256sum` 报 `FAILED`：文件不对。删掉 `~/.local/bin/herdr.new`，停下告诉用户。

### 建 Herdr 服务

Rhodium 不会自己启动 Herdr，要有一个服务让 Herdr 一直运行。Rhodium 用一个单独的会话 `rhodium`，和用户平时用的 Herdr 会话分开。

```bash
HERDR=$(PATH="$(cat ~/.config/rhodium/service-path)" command -v herdr)
echo "herdr: $HERDR"
mkdir -p ~/.config/systemd/user
cat > ~/.config/systemd/user/rhodium-herdr.service <<EOF
[Unit]
Description=Herdr session for Rhodium

[Service]
ExecStart=$HERDR --session rhodium server
Environment=HERDR_CONFIG_PATH=%h/.config/rhodium/herdr.toml
Environment="PATH=$(cat ~/.config/rhodium/service-path)"
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable --now rhodium-herdr
sleep 3
"$HERDR" --session rhodium status server
```

应该看到：`herdr:` 后面是一个以 `/` 开头的路径；最后的输出里有 `status: running`。

不对时：`herdr:` 后面是空的，说明 `herdr` 不在 `service-path` 里，回到上面把它的目录加进去。服务起不来，运行 `journalctl --user -u rhodium-herdr -n 30 --no-pager`，把输出告诉用户。

## 第 6 步：装服务

```bash
~/.local/opt/rhodium/current/rhodium-service.sh install rhodium \
  --config "$HOME/.config/rhodium/config.toml" \
  --path "$(cat ~/.config/rhodium/service-path)" \
  --env "HERDR_CONFIG_PATH=$HOME/.config/rhodium/herdr.toml" \
  -- "$HOME/.local/opt/rhodium/current/rhodium"
for i in $(seq 1 15); do ~/.local/bin/rh ls 2>/dev/null && break; sleep 2; done
systemctl --user is-active rhodium
```

应该看到：

- 安装脚本没有输出。
- `还没有槽位。用 rh new <工作区/槽位> 新建。`：服务已经准备好。
- `active`。

不对时：

- 安装脚本报 `must be an absolute path` 或 `every --path entry`：`~/.config/rhodium/service-path` 里有不以 `/` 开头的目录，删掉它再重跑。
- 没有出现“还没有槽位”那句，或者不是 `active`：运行 `journalctl --user -u rhodium -n 50 --no-pager -o cat`，看最后几行：
  - `has mode`：配置文件权限不对，`chmod 600 ~/.config/rhodium/config.toml`，再 `systemctl --user restart rhodium`。
  - 有 `cannot load config`：配置文件写错了，看它后面 `error` 里写的原因，对照第 4 步改。
  - 看不懂就把这些输出告诉用户。
- `Unknown key name 'RestartMode'`：只是旧版 systemd 不认这一项，不用管。

## 第 7 步：自检

```bash
~/.local/bin/rh doctor
```

应该看到：

- 开头几行是信息，例如 `Claude 2.1.310` 或 `Claude （读不到版本号）（第一次核对）`、`磁盘剩余 70.0GB`，用了 Herdr 的还有 `Herdr 0.9.5（protocol 22）`。
- 有一行 `Claude 登录：`，后面是 `订阅（...）` 或 `API（...），按用量计费`。两种都对。
- 没有以 `错误：` 开头的行。
- 这几条 `告警：` 可以不管：
  - `还没有数据库备份`：第一份备份在装好一天后才有。
  - `找不到 pi`：用户不用 pi 就没关系。
  - `连不上 Herdr`：只在用户不用 Herdr 时可以不管。用了 Herdr 却有这条，回第 5 步检查服务。

不对时：

- `错误：找不到 claude`：`claude` 不在 `service-path` 里，回第 2 步。改完 `service-path` 要重跑第 6 步。
- `错误：claude 没有登录`：问用户用订阅，还是用自己的 API 地址和令牌。请用户照 `~/.local/opt/rhodium/current/README.md` 的“登录 Claude”做，再在自己的终端里运行 `claude`，确认能对话。然后再跑 `rh doctor`。
  - 用 API 令牌的，还报这条错误：运行下面这条，它只打印变量名，不打印值。

    ```bash
    grep -o '"ANTHROPIC_[A-Z_]*"' ~/.claude/settings.json | sort -u
    ```

  - 应该看到 `"ANTHROPIC_BASE_URL"` 和 `"ANTHROPIC_AUTH_TOKEN"`。少了的话，令牌多半写在了 `.bashrc`、`.zshrc` 里，服务看不到。请用户照 `~/.local/opt/rhodium/current/README.md` 的“登录 Claude”把它写进 `~/.claude/settings.json` 的 `"env"`。
  - 两个都有还报错：把 `rh doctor` 的输出告诉用户，请用户检查这个文件是不是合法的 JSON，这两项是不是写在 `"env"` 里面。
- `错误：claude 里找不到协议名字`：用户的 Claude Code 太旧。请用户运行 `claude update`，再跑 `rh doctor`。
- `错误：和 claude 握手失败`：多半是这台机器连不上 Claude 的服务器。把输出告诉用户，网络由用户解决。
- 别的错误：原样告诉用户。

## 第 8 步：网页界面（可选）

问用户要不要网页界面。不要就跳到第 9 步。要的话，问用户从哪打开，三选一。用户说不清就选 Tailscale。

- **Tailscale**（默认）：Tailscale 把用户的手机、电脑和这台机器连成一个私有网络。只有用户的 Tailscale 账号打得开。
- **只在本机**：在这台机器的浏览器里打开，或者用户用 `ssh -L` 转到自己的电脑上打开。
- **Cloudflare**：经用户自己的域名从公网打开，由 Cloudflare Access 认人。Cloudflare 那边由用户自己配。

后两种 Rhodium 自己不认人：谁打得开网页，谁就能完全控制它，包括网页终端。选了后两种，先问用户这台机器上有没有别人的账号。有的话不要用，改用 Tailscale：别的账号也连得到本机的端口。

先确认 7800 端口是 Rhodium 的：

```bash
curl -s http://127.0.0.1:7800/; echo
```

应该看到：`只有配置文件 [board] login 里的 Tailscale 账号能看这个看板。`，这是 Rhodium 自己的网页在回答。打印了别的，说明 7800 端口被别的程序占着：停下告诉用户。

然后只做用户选的那一节。

### 用 Tailscale

看第 2 步 `tailscale` 那一行：

- **没有**：请用户自己装 Tailscale 并登录（`curl -fsSL https://tailscale.com/install.sh | sh`，然后 `sudo tailscale up`），装好再继续。
- **有**：继续。

先确认账号：

```bash
tailscale status | head -n 3
tailscale status --json | grep -o '"LoginName": *"[^"]*@[^"]*"' | sort -u
```

- `tailscale status` 报错或提示登录：请用户执行 `sudo tailscale up` 登录。
- 最后一条列出几个账号：问用户哪个是他们自己的 Tailscale 账号。只列出一个、且用户确认是自己的，就用它。

把账号填进第一行的引号里（例如 `you@example.com` 或 `you@github`），写进配置并重启：

```bash
LOGIN="填用户的 Tailscale 账号"
grep -q '^\[board\]' ~/.config/rhodium/config.toml && echo "配置里已经有 [board]，没有改动" || printf '\n[board]\nlogin = "%s"\n' "$LOGIN" >> ~/.config/rhodium/config.toml
systemctl --user restart rhodium
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7800/
```

应该看到：`403`。如果打印了“配置里已经有 [board]”，停下，请用户检查配置文件里 `[board]` 下的 `login`。

`403` 说明网页已经起来了；本机直接访问没带 Tailscale 账号，所以被拒绝，这是对的。

再让 Tailscale 把网页发布到用户的私有网络：

```bash
tailscale serve --bg --https=7800 http://127.0.0.1:7800
tailscale serve status
```

应该看到：一行 `https://<机器名>.<网络名>.ts.net:7800 (tailnet only)`。记下这个地址，最后告诉用户。

不对时：

- 报 `Access denied` 或权限错误：请用户执行一次 `sudo tailscale set --operator=<用户名>`，再重跑这个块。
- 打印了一个链接，说要开启 HTTPS：把链接给用户，请用户在浏览器里打开并开启，再重跑这个块。
- 必须写 `--https=7800` 这种带端口的形式。不带端口的写法会占用 443 端口，覆盖用户已有的设置。

不要在 7800 端口前再接别的代理，例如 nginx：它把请求的地址改成本机的，公网上谁都能冒充用户。

### 只在本机

```bash
grep -q '^\[board\]' ~/.config/rhodium/config.toml && echo "配置里已经有 [board]，没有改动" || printf '\n[board]\nauth = "none"\n' >> ~/.config/rhodium/config.toml
systemctl --user restart rhodium
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7800/api/ping
```

应该看到：`204`。如果打印了“配置里已经有 [board]”，停下，请用户检查配置文件里的 `[board]`。

最后告诉用户：在这台机器上打开 `http://127.0.0.1:7800/`；在别的电脑上怎么开，见 `README.md` 的“网页”。

### 用 Cloudflare

你不碰 Cloudflare 的账号和设置。请用户照 `~/.local/opt/rhodium/current/README.md` 的“经 Cloudflare 打开”配好，再继续。

问用户给网页用的主机名，例如 `board.example.com`：小写，不带 `https://`、路径和端口。填进第一行的引号里：

```bash
HOST="填用户的主机名"
grep -q '^\[board\]' ~/.config/rhodium/config.toml && echo "配置里已经有 [board]，没有改动" || printf '\n[board]\nauth = "none"\nhosts = ["%s"]\n' "$HOST" >> ~/.config/rhodium/config.toml
systemctl --user restart rhodium
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:7800/api/ping
~/.local/bin/rh doctor
```

应该看到：

- `204`。
- `rh doctor` 里没有以 `错误：看板` 开头的行，也没有以 `告警：连不上 https://` 开头的行。

不对时：

- 打印了“配置里已经有 [board]”：停下，请用户检查配置文件里的 `[board]`。
- `错误：看板在 https://... 上不登录就能打开`：Access 没配好，现在公网上谁都能控制这台机器。马上运行下面这块关掉网页，再请用户检查 Access：应用要管住这个主机名，策略只放用户自己的邮箱。改好后从上面写配置的块重跑。

  ```bash
  sed -i '/^\[board\]$/d; /^auth = "none"$/d; /^hosts = \[/d' ~/.config/rhodium/config.toml
  systemctl --user restart rhodium
  ```

- `错误：看板关着`：配置写错了，多半是主机名。运行上面那块删掉 `[board]`，问用户确认主机名，再从写配置的块重跑。
- `告警：连不上 https://...`：这台机器打不开那个地址，没核对 Access，多半是 Cloudflare 那边还没配完。请用户在手机的无痕窗口里打开 `https://<主机名>/`：先出 Cloudflare 的登录页才对。直接出现网页，就照上面关掉网页。

最后告诉用户的地址是 `https://<主机名>/`。

## 第 9 步：交给用户

先确认用户在自己的终端里能直接敲 `rh`：

```bash
timeout 20 "$SHELL" -ic 'command -v rh' </dev/null 2>/dev/null | tail -n 1
```

应该看到：一个以 `/rh` 结尾的路径。什么都没有的话，`~/.local/bin` 不在用户的 `PATH` 里。不要自己改用户的 shell 配置，把这件事写进下面的第 6 条。

告诉用户这些：

1. 装好了，Rhodium 作为服务在运行，开机自动启动。
2. `rh doctor` 的结果。
3. 网页地址（做了第 8 步的话）。
4. 跳过了哪些可选项：Herdr、网页。
5. 接下来请用户看 `~/.local/opt/rhodium/current/README.md`：配了网页的，从“网页”一节的“第一次用”开始；没配网页的，从“IM”一节开始建 Bot。Claude 回了用户在网页或 IM 里发的第一条消息，就说明整条链路都通了；没回的话，请用户运行 `rh doctor`，并看 `journalctl --user -u rhodium -n 50`。
6. 上面的检查没找到 `rh` 的话：请用户把 `export PATH="$HOME/.local/bin:$PATH"` 加到自己 shell 的配置文件（`~/.bashrc` 或 `~/.zshrc`）末尾，重新登录后就能直接敲 `rh`。在那之前用 `~/.local/bin/rh` 代替。

## 以后升级

拿到新的压缩包后，先看文件名的架构和第 3 步装的一样，再运行：

```bash
PKG="/填/新压缩包的/完整路径.tar.xz"
NAME=$(tar -tJf "$PKG" | head -n 1 | cut -d/ -f1)
echo "包里的目录：$NAME"
tar -xJf "$PKG" -C ~/.local/opt/rhodium/versions
ln -sfn "versions/$NAME" ~/.local/opt/rhodium/current
systemctl --user restart rhodium
sleep 5
~/.local/bin/rh --version
~/.local/bin/rh doctor
```

- 正在跑的对话不受重启影响。
- 旧版本目录先留着：还在跑的对话可能在用它的 `rh-hold`。等 `rh doctor` 不再报“还在跑旧版的托管进程”，再删 `~/.local/opt/rhodium/versions/` 下的旧目录。
- 新版本第一次启动可能升级数据库。之后就不能退回旧版本了。

## 卸载

先问用户确认。这会删掉 Rhodium 的所有数据，包括对话的记录（Claude 自己的对话文件在 `~/.claude` 里，不删）。

```bash
~/.local/bin/rh stop --all
~/.local/opt/rhodium/current/rhodium-service.sh uninstall rhodium
systemctl --user stop 'rh-hold-*'
systemctl --user disable --now rhodium-herdr 2>/dev/null
rm -f ~/.config/systemd/user/rhodium-herdr.service
systemctl --user daemon-reload
tailscale serve --https=7800 off 2>/dev/null
rm -rf ~/.local/opt/rhodium ~/.config/rhodium ~/.local/state/rhodium ~/.local/bin/rh
```

用户建 Bot 时在 QQ 或 Telegram 平台上建的机器人账号还在，要删请用户去平台上删。用了 Cloudflare 的，请用户自己去 Cloudflare 上删掉那条 Tunnel 和 Access 应用。
