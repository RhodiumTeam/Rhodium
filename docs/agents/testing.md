# 跑测试

- 合并 PR 之前，在合并后的代码上跑 `bun run check`。它依次做三件事，任何一步失败就以非零退出：
  1. `holder/` 的 Rust 格式检查（`cargo fmt --check`）。要 rustfmt 组件，没有就 `rustup component add rustfmt`。
  2. 类型检查（`bun run typecheck`）。
  3. 全套测试（`bun run test`）。
- 全套测试里的 `test/package.test.ts` 打 x86_64 和 arm64 两个安装包，要 `xz` 和 `rustup`。第一次要联网：它用 `rustup` 装 `release/licenses/rust-<版本>.md` 写的那个版本的 Rust 和两个 musl 的目标，`bun` 还要下载另一种架构的运行时。
- 只改了 Markdown 文件的 PR（`docs/`、`README.md`、`GLOSSARY.md` 等），开 PR 前和合入 main 后都不用跑：没有测试读它们。
  - 例外：`test/dispatcher.test.ts` 读 `deploy/dispatcher/CLAUDE.md`。改了它，只跑这一个测试。
  - 例外：`test/package.test.ts` 跑 `scripts/package.sh` 打安装包，它读 `NOTICE.md` 和 `release/` 下的文件。改了它们，只跑这一个测试。
  - 以后哪个测试或构建步骤要读某个 Markdown 文件，把它加进这条例外。
- 全套测试用 `bun run test`。它按核数的三分之一并行，至少 4 路；例如 32 核的机器上是 10 路，一遍约四分半（2026-10-26，约 1560 个测试）。
- 同一时间最多跑两遍全套。再多就互相拖慢，测试开始超时。
- 只跑单个文件用 `bun test <文件>`，在仓库根目录跑。
- 每个 `bun test` 进程都有内存上限（#277）：
  - 仓库根的 `bunfig.toml` 让它在跑测试前先加载 `test/cap.ts`，把自己挪进单独的 systemd 范围单元 `rhodium-test-capped-<pid>.scope`，上限 8G，不用交换区。它起的程序都在里面，包括冒烟测试里 Chromium 的渲染进程；Chromium 的主进程会把自己挪进单独的范围单元，不受这个上限管，但也不在 Herdr 和 holder 的单元里。
  - 超了内核只杀这个单元：测试挂掉，起它的 Herdr 或 agent 的托管进程没事。`journalctl --user -u rhodium-test-capped-<pid>.scope` 里能看到 `killed by the OOM killer`。
  - `bun run test`、`bun run check` 和单跑一个文件都走这条路，不用另外包一层。不在仓库根目录跑，或者用 `bun` 直接跑脚本，不加载它，没有上限。要跑可能失控的东西，自己包一层：`systemd-run --user --scope --unit=rhodium-test-<名字> -p MemoryMax=8G -p MemorySwapMax=0 <命令>`。
  - 起不了这个单元（没有 systemd 用户会话），测试直接报错，不会不设上限照跑。
- `expect(...).toEqual(...)` 的期望值里别放 playwright 的对象，例如 `Locator`。比较不上时，bun 要把它背后整个 playwright 的对象图打印出来，同步卡住、不停吃内存，2026-10-24 吃到 58G（#277）。
- 用 `timeout` 给 `bun test` 限时可以：冒烟测试关掉了 playwright 自己的 SIGTERM 处理（它只关浏览器，不退出），SIGTERM 能结束卡住的测试。
- 测试里调外部程序（`systemctl`、`rh`、脚本），用 `test/instance.ts` 的 `exec`、`run`、`systemctl`、`mainPid` 和实例的 `rh`。它们是异步的，超时就杀掉程序、让测试失败。
  - 不用 `Bun.spawnSync`。它会挡住整个测试进程：外部程序一旦没返回，单条测试的超时也触发不了，整遍测试就卡死。

## 录制 Codex 的素材

Codex 的录制在 `test/fixtures/codex/`，由 `scripts/probes/codex/probe.ts` 跑真的 `codex app-server` 录下（[Codex 驱动规格](../spec/codex.md#测试决定)）。录的时候：

- 用你真的 `CODEX_HOME` 和登录，不把 `auth.json` 拷到临时目录。Codex 刷新令牌时会换掉旧的，你原来那份可能就失效了。
- 调模型的场景用最便宜的模型加最低思考强度，探针把回合数记在工作目录的 `state.json` 里。
- 录完用 `thread/delete` 删掉录制开的线程：最后跑探针的 `cleanup`。
- 录制里换掉家目录、邮箱、账号 ID、安装 ID。探针收尾时自动换，再过一遍合成步骤，见下一节。
- 不调模型的登录场景（`doctor-logged-out`、`doctor-api-key`、`doctor-provider`）用探针工作目录下的临时 `CODEX_HOME`，不碰你的登录。
- 不改 `~/.codex` 里的任何文件，也不连你的共享后台服务。探针的环境去掉 `HERDR_*` 和 Claude 的变量。

## 录制素材是合成的

`test/fixtures/` 里的素材不带你的账号、ID 和环境。

- 合成步骤是 `scripts/probes/synth.ts`。各录制脚本收尾时都跑它；手动拷进来的素材，跑 `bun scripts/probes/synth.ts`。
- 它把 ID 换成合成的：同一个值在哪个文件里都换成同一个，再跑一遍不变。签名、加密内容换成固定的假值，账号、家目录、socket 路径换成通用的，Claude socket 名里的 pid 也换掉。
- 它把绝对时间移到固定的基准上，真实的录制时间、额度恢复时间都不留：
  - 一份录制（`out.log` 和 `in.log` 一起）或一个 `.jsonl` 文件里，最早的那个真实时间移到 `FAKE.timeBase`（2026-01-01 00:00:00 UTC），其余的跟着整体平移，先后、间隔和时长不变。
  - 平移量是整数秒，所以毫秒部分、整数秒字段的类型都不变。
  - 各种写法都跟着动：ISO 时间、秒和毫秒的时间戳（数字或文本里的）、日期、Codex 的 `rollout-<时间>` 文件名和日期目录、pi 会话的文件名、提示文字里的时间（Claude 的 `resets 11:20 (UTC)`、Codex 的 `try again at Mar 5th, 2026 3:42 PM`）、飞书 ID 里带的创建时间。无时区的时间按 `FAKE.utcOffset`（`FAKE.timezone` 的钟点）算。
  - 已经落在 `[FAKE.timeBase, FAKE.timeBase + FAKE.timeWindow)` 里的时间当作已合成，不再动。所以每份录制各从基准起算，不同录制之间的真实间隔没有留下。
  - 测试要用的时间，从素材里读，不写死：重录或重新合成时它们会变。
- 命令、技能、插件、agent、MCP 服务器、Codex 技能这些清单，只留 Agent 自带的，名单在 `synth.ts` 的 `BUILTIN`。新版自带的新东西要用，先加进名单。
- `test/fixture-hygiene.test.ts` 扫遍所有素材，漏了合成的会挂。它也查时间：ISO 时间、时间戳、日期、飞书 ID 里的时间，只要不在上面那个时间窗里就挂。

## 手动验收接真 Herdr

规格要求合并前从源码另起看板，接 Herdr 的 `rhodium-test` 会话手动验收。这时候：

- 起 `rhodium-test` 的 Herdr 服务时带上 `HERDR_CONFIG_PATH`，指向一份临时配置，里面只写 `[session]` 和 `resume_agents_on_restore = false`。
  - 为什么：`~/.config/herdr/config.toml` 没关自动恢复的话，`rhodium-test` 会话里以前留下的 Claude pane，服务一起来就会被拉起来。拉起来的 Claude 可能带着插件，例如 Telegram 插件，和你自己窗口里的那个抢同一个 Bot。
- 在测试 pane 里手动起真的 `claude`，要带上 `TELEGRAM_STATE_DIR=<一个空目录>`，和 Rhodium 给槽位的环境一样（`src/runner.ts`）。不带的话，它会拿你的 Bot token 去拉消息。
- 用完关掉自己开的 tab，停掉这个服务。
