# Codex 驱动规格

这篇回答：Rhodium 接 Codex 要做成什么样、满足哪些需求、和 Codex 之间怎么说话、怎么测、怎么验收、明确不做什么，以及怎么拆工单。

前置阅读：[术语表](../../GLOSSARY.md)、[产品说明](../product.md)、[ADR-0011](../adr/0011-codex-private-app-server.md)、[架构](../architecture.md)、[IM 文字与交互规范](../im-style.md)、[v1 规格](v1.md)、[查询命令规格](info-commands.md)

方向在第 34 轮拷问里定下（2026-10-27），行为写进了[产品说明](../product.md) §4、§5、§12。写规格前，用你自己的 Codex 登录在 codex-cli 0.162.1 上跑了一遍探针，共 14 个回合，全用最便宜的模型加最低思考强度。协议的实测事实和录制名写在[架构](../architecture.md) §6.4，接法的决定和实测后的补记在 [ADR-0011](../adr/0011-codex-private-app-server.md)。这里不重复，只写需求、两边怎么说话、测试和交付。

这篇用到几个词：

- Codex CLI：OpenAI 的命令行 agent，程序名 `codex`。
- app-server：`codex app-server`，Codex 自带的后台接口程序。客户端和它用 JSON-RPC 说话，每行一条 JSON。Rhodium 给每段 Codex 对话起一个只给它用的（[ADR-0011](../adr/0011-codex-private-app-server.md)）。
- 共享后台服务：你本机常驻的那个 app-server。你自己开的 `codex` 默认连它，Rhodium 不连。
- 线程：Codex 叫对话为线程（thread），就是[术语表](../../GLOSSARY.md)里的对话。线程 ID 由 Codex 生成。
- 对话记录（rollout）：Codex 每个线程一个 JSONL 文件，在 `~/.codex/sessions/年/月/日/` 下。
- 写锁：Codex 自己给每个线程加的锁。哪个进程开着这个线程，就由它持有，别的进程再要接着写会被拒。
- 审批设置：Codex 的 `approvalPolicy`。用到三个值：`never`（不问）、`untrusted`（每条命令、每次改文件都问）、`on-request`（Codex 自己判断，危险的才问）。
- 沙箱：Codex 限制命令能读写哪些文件、能不能联网的机制。本机起不来，Rhodium 一律不用，即 `danger-full-access`。
- credits：Codex 账号里预付的点数。额度窗口满了以后，Codex 可能先扣它接着跑。

## 问题

**Codex 只能在终端里用。**

- Rhodium 托管 Claude Code 和 pi，Codex 还没接。
- 你想在手机上也能派活给 Codex，和另两家一样看进度、答审批。

**Codex 和另两家不一样，照搬会出错。**

- 线程 ID 由 Codex 生成，Rhodium 不能预先指定。没跑过回合的线程不写记录。
- 本机 Codex 的沙箱起不来，它的几种审批设置要重新对应。
- “每条都问”的设置 `untrusted` 已从 Codex 的配置文件里拿掉，只是接口还收；终端也不认它。
- Codex 的拒绝带不了理由。
- 回合中途关掉它的输入，回合立刻被杀，不像 Claude 会等。
- 你自己开的 `codex` 默认连共享后台服务。退出后后台服务还会占着线程一阵（0.163 起最长 30 分钟），这期间别人接不上。
- 它没有无头的斜杠命令。

## 方案

新加一个驱动 `src/codex.ts`。每段对话一个托管进程，里面跑 `codex app-server --listen stdio://`，和 pi 一样。驱动把 JSON-RPC 翻成[架构](../architecture.md) §6.1 的统一操作和事件。驱动以外按 agent 不同的地方，都在[架构](../architecture.md) §6.1 说的那几张表里加一行 `codex`。

在 Telegram 里大致是这样：

```
你：把 src/config.ts 的超时改成 30 秒，再跑测试
┌──────────────────────────────────────────┐
│ ┃ [🔧 exec_command ×2] rg timeout src、cat src/config.ts
│ ┃ [🔧 apply_patch] src/config.ts
│ ┃ [🔧 exec_command] bun test，正在运行
└──────────────────────────────────────────┘
┌──────────────────────────────────────────┐
│ 要运行这条命令，允许吗？                     │  ← 审批开时
│ rm -rf build && bun run build             │
│ 回别的话算拒绝，并转告它。                   │
│ [允许] [拒绝]                              │
└──────────────────────────────────────────┘
```

`/status`：

```
## shop/codex
空闲

### 模型设置
Agent：Codex CLI
模型：GPT-6.1-Sol high

### 状态
目录：~/shop
上下文：12% (~31k / 258k Tokens)

### 额度信息
**86%** 7d，10-30 19:00 重置
```

这一步包含：

- 驱动：握手、开线程和接着旧线程、收发、插话、打断、审批和提问、额度和用量、`/compact`，Rhodium 重启后接上。
- agent 表的 `codex` 一行，以及驱动表、对话记录表、终端表、带回设置表、网页的 logo 和工具名表里的 `codex`。
- 工具行和审批用 Codex 自己的工具名。
- 切终端：`codex resume <线程 ID> --no-daemon`。
- 读 Codex 的对话记录：看板对话页、`rh import`、`/resume` 列表、`rh read`。
- `rh doctor` 查 Codex。
- 假 agent 的 Codex 模式，测试都接它。

## 用户故事

“用户”就是你本人。编号从 483 开始，前面的号已经有别的规格用了。

### 用上 Codex

483. 作为用户，我想要用 `/rh_agent codex`、`rh new --agent codex`、`rh spawn --agent codex` 或网页上选 agent，让一个槽位用 Codex，以便同一套 IM 和看板也能指挥 Codex。
484. 作为用户，我想要 Codex 跑的是我自己装的、未经修改的 `codex`，用我自己的登录，Rhodium 不经手凭据，Codex 也看不到 Claude 的登录和令牌，以便合规。
485. 作为用户，我想要 `/status` 的 Agent 行、看板和网页选 agent 的地方写“Codex CLI”，IM 里 `/rh_agent` 的按钮写“Codex”，配 OpenAI 的标，深色模式下也看得清，以便一眼认出是哪家。

### 收发

486. 作为用户，我想要在 IM 里给 Codex 槽位发一句，Codex 在槽位的目录里干活，最终回复发回原来的窗口，以便像用 Claude 一样派活。
487. 作为用户，我想要过程消息里的工具行用 Codex 自己的工具名，例如 `exec_command`、`apply_patch`，参数照另两家的规矩取，以便看出 Codex 在做什么。
488. 作为用户，我想要回合进行中发的话并进当前回合，`!` 开头的先打断再发，`/stop` 停下回合，以便和 Claude 一样插话、叫停。
489. 作为用户，我想要我发的 `/x`（Rhodium 不认识的斜杠命令）原样交给 Codex，以便规则和另两家一样。
490. 作为用户，我想要 Rhodium 重启或升级时 Codex 的回合不断，挂着的审批也还在，以便放心升级。
491. 作为用户，我想要 Codex 进程崩了，Rhodium 告诉我，再发一句续跑提示让它接着做；10 分钟内崩 3 次就停手，以便不白烧额度。
492. 作为用户，我想要这段对话正在别处打开（例如我自己的 codex 开着它）时，Rhodium 不起进程，告诉我它在别处开着，消息留着，以便两边不抢同一段对话。

### 审批和提问

493. 作为用户，我想要审批关时，Codex 无头和终端都不问、不加沙箱，以便和 Claude 跳过审批一样顺手。
494. 作为用户，我想要审批开时，Codex 每条命令、每次改文件都发到 IM 问我，按钮只有允许和拒绝，以便每一步都过目。
495. 作为用户，我想要我回别的话、或审批超时时，Rhodium 拒绝之后把那句话交给 Codex，以便它知道为什么被拒，按我的意思接着做。
496. 作为用户，我想要 Codex 要用 MCP 工具（agent 接的外部工具）时照普通审批问我；MCP 要我填表的一律拒绝；万一它出选择题，照常问我，以便没有哪种请求让回合卡住。
497. 作为用户，我想要回合进行中改审批模式时，Rhodium 告诉我从下一个回合起生效，以便知道这一回合还按旧设置跑。
498. 作为用户，我想要哪天 Codex 不再接受“每条都问”，Rhodium 直接告诉我开不了审批，不悄悄改成不问，以便不在我以为有审批时乱跑。

### 命令和额度

499. 作为用户，我想要 `/model` 列出 Codex 的模型、写它们的显示名，选了以后接着问思考强度，六档 low 到 ultra 都能选，记在槽位上，以便换模型和思考强度。
500. 作为用户，我想要 `/usage` 写 Codex 额度、credits 余额和当前对话的 token 数，`/context` 写上下文占用，`/status` 在额度快满时提醒，以便知道还剩多少。
501. 作为用户，我想要 `/compact` 压缩 Codex 的上下文，压缩时我发的话等压缩完再交给它，以便长对话接着用。
502. 作为用户，我想要 Codex 额度用完时槽位进“等额度”，通知写“Codex 额度用完了”和恢复时间，到点自动续跑，以便不用守着周额度重置。

### 终端

503. 作为用户，我想要 `/rh_tui` 把 Codex 槽位切到 Herdr 里的 `codex`，接着同一段对话，带上槽位记的模型、思考强度和审批模式，不弹更新提示和“信任这个目录”的提示，以便回到电脑前直接接着干。
504. 作为用户，我想要在终端里退出 codex 以后，槽位马上回到无头，对话不被 Codex 的后台服务占着，以便切回来就能接着在 IM 里用。
505. 作为用户，我想要我在终端里换了模型或思考强度、又跑过一个回合，切回无头后槽位记下它们，通知多一行，以便和 Claude 一样。
506. 作为用户，我想要还没聊过就切终端时，Rhodium 回“还没有对话可以接着用”，以便不开出一个接不上的终端。2026-10-28 改：终端里开一段新对话（[v1 规格](v1.md)故事 544、545，#461）。

### 对话记录和导入

507. 作为用户，我想要看板对话页画出 Codex 槽位的对话：我的话、它的话、思考摘要、工具调用和结果、压缩和打断，图标照 Codex 的工具分，以便在网页上回看。
508. 作为用户，我想要用 `rh import <线程 ID>` 或 `/rh_import` 把我在别处开过的 Codex 对话导入成槽位，落到它所在目录的工作区，以便在手机上接着聊。
509. 作为用户，我想要 `/resume` 列出这个目录里的 Codex 对话，标“（codex）”，选了就回到那段，以便在几段对话之间来回。

### 自检

510. 作为用户，我想要 `rh doctor` 写出 Codex 的版本和登录方式（ChatGPT、API key，或我在 Codex 配置里配的服务商）；Codex 不再接受“每条都问”、没登录、或服务商令牌所在的环境变量 Rhodium 看不到时报出来，以便升级 codex 后心里有数。

## 实现决定

### 已定的大方向

第 34 轮定的：

- 一次做完：Claude 现在有的都做。分几张工单，每张照常审查后合并。
- 不用 Codex 的沙箱。据反馈它非常不稳定；本机也起不来。
- 审批关等于 yolo：无头和终端都不问。审批开时，无头每条都问，终端由 Codex 自己判断。详见下面的[审批怎么对应](#审批怎么对应)。
- 额度用完和 Claude 一样：等额度，到点自动续跑。
- 思考强度六档都给，含 ultra。
- 工具行用 Codex 自己的叫法。
- 名字叫 Codex CLI，用 OpenAI 的标。
- `/x` 照旧原样发，Codex 当普通文字读。
- 从 Herdr pane 导入暂缓，从磁盘导入照做。原因见[不做的事](#不做的事)。
- 按 codex-cli 0.162.1 做。你升级以后，拿录制比一遍。

第 34 轮开头列出、没有被反对的：

- Codex 用你自己 codex 的登录，跑官方未改的 `codex`，Rhodium 不经手凭据（[产品说明](../product.md) §12）。
- Codex 的进程和终端都看不到 Claude 的登录和令牌，和 pi 一样。
- 审批关时，`rm -f`、`rm -rf` 这类强制删除 Codex 自己拒跑，让它换个做法。你自己的 codex 跳过审批时也这样。
- 回合进行中改审批模式，从下一个回合起生效，Rhodium 告诉你一声。想马上停就 `/stop`。
- Rhodium 起的终端不连你的共享后台服务，终端一退出对话马上放开，也不替你把后台服务拉起来。
- 你自己的终端开着这段对话时，Rhodium 接不上，告诉你它在别处开着。
- Rhodium 开的 Codex 对话也出现在你自己 `codex resume` 的列表里。Rhodium 正用着时你在那边打开，Codex 只读打开，不让你接着写。
- 你的后台服务自动更新、重启，碰不到 Rhodium 的进程。你升级 codex 以后，正在跑的对话还用旧版，下次起进程才用新版。
- Rhodium 起的终端不弹“有新版本”和“信任这个目录”的提示，都用启动参数关，不改你的配置。“Hooks need review”是你自己插件的，留着。
- Codex 的拒绝带不了话：先拒绝，再把那句话插进当前回合。
- 审批按钮只有允许、拒绝，不做“这段对话都允许”。
- MCP 工具的审批照普通审批问你；MCP 要你填表的一律拒绝，和 pi 一样。
- Codex 只在计划模式下出选择题，Rhodium 不开计划模式。万一来了照样问你。Codex 没有计划确认。
- `/usage` 里当前对话只写 token 数，Codex 不给费用。账号有 credits 时多一行余额。
- 崩溃后和 pi 一样，由 Rhodium 发续跑提示。只在空闲时关 Codex 进程。
- 还没聊过就切终端，回“还没有对话可以接着用”。2026-10-28 改成开一段新对话（#461）。
- 终端里换的模型和思考强度，切回来后槽位跟着换，缺口和 Claude 一样。
- 默认 agent 仍是 Claude。

### 这些没单独问，直接定了

不同意就说，改起来都只动一处：

| 定了什么 | 为什么 |
|---|---|
| 句子里叫“Codex”，`/status` 的 Agent 行、看板、网页选 agent 的地方写“Codex CLI” | 和 Claude 一样：句子里叫 Claude，`/status` 写 Claude Code。IM 里 `/rh_agent` 面板的按钮也写“Codex”，和“Claude”“pi”并排 |
| 槽位的对话 ID 就是 Codex 的线程 ID | Codex 不让指定 ID。新对话先用 Rhodium 起的临时 ID，`thread/start` 应答后换成线程 ID，和 Claude 一样走现有的那条路 |
| 系统提示放在 `developerInstructions`，不用 `baseInstructions` | 后者会整个换掉 Codex 自己的提示 |
| 不打开 app-server 的实验接口 | 选择题不需要它；少一份会变的接口 |
| 握手时声明不收命令输出、推理正文这类增量通知 | Rhodium 用不到，`out.log` 少写很多行 |
| 看板上 Codex 槽位没有“正在运行”那一行 | 对话记录只写做完的工具调用。IM 里照常有，它来自驱动的事件 |
| `rh doctor` 开一个不落盘的临时线程，看 Codex 还收不收 `untrusted` | 不调模型、不花额度；接口哪天不收了，你先从 `rh doctor` 知道 |
| 线程被写锁占着，算“没能启动”，不自动重试 | 占着的那边可能要占很久（你的后台服务最长 30 分钟）。下次来消息再试，和[产品说明](../product.md) §4.5 的“对话锁被别的进程拿着”一样 |
| 额度用完却读不到恢复时间时，不进等额度，把 Codex 的报错转给你 | 不知道等到什么时候；用 API key 登录时没有额度窗口 |
| credits 余额保留两位小数，不加千位逗号，例如 `58572.75` | 和 Claude 的 `/usage` 写金额一样。原定取整，2026-10-27 改成两位小数，网页的用量卡片也一样 |

### 审批怎么对应

行为见[产品说明](../product.md) §4.8 的表。无头用哪个 Codex 设置见[架构](../architecture.md) §6.4，终端的启动参数见[架构](../architecture.md) §10.3。这里只补规格层面的几条：

- 回合进行中改审批模式，不重启进程，下一个回合起生效。`rh set` 的回复多一句“Codex 从下一个回合起按新设置跑。”。
- Codex 不收“每条都问”时，这次启动算失败。故障通知的原因写：“这一版 Codex 不再接受“每条都问”的审批设置，审批开的 Codex 槽位起不来。关掉这个槽位的审批再发一条，或者换回旧版 codex。”。消息都留着，和别的没能启动一样。
- 审批开时终端是“Codex 自己判断，危险的才问”：终端不认“每条都问”。

### 工具行和审批的写法

- 工具名：条目种类换成 Codex 给模型的工具名，对照表在[架构](../architecture.md) §6.4。驱动、对话记录和看板共用它。
- 工具行的参数、审批的第一行：[IM 文字与交互规范](../im-style.md) §3.1、§4.2 的表里加了 Codex 的行。
- 看板的图标按工具名分：

| 工具名 | 图标 |
|---|---|
| `exec_command` | 命令 |
| `apply_patch` | 改文件 |
| `web_search` | 网页 |
| `view_image` | 读文件 |
| `spawn_agent` 这类子 agent 的工具 | 子 agent |
| `update_plan` | 记账 |
| `mcp__` 开头的 | MCP |
| 别的（`image_gen` 等） | 别的 |

### 命令

10 个通用命令对 Codex 怎么做：行为见[产品说明](../product.md) §5.6，接口见[架构](../architecture.md) §6.1 的表，写法见[查询命令规格](info-commands.md)和 [IM 文字与交互规范](../im-style.md) §7。补几条：

- `/model` 列不隐藏的模型。默认的那个写“默认（GPT-6.1-Sol）”这样。选了接着问思考强度，档位取这个模型支持的。
- `/model`、`/effort` 都从下一个回合起生效。
- `/compact`：Codex 把压缩当一个回合跑。压缩期间你发的话排着，压缩完再交。
- `/usage`：你的套餐只有 7 天窗口。给出 5 小时窗口的账号，照样多写一行 `5h`；按模型分的额度桶，照 Claude 写成“7d 模型名”一行。
- 读不到额度窗口时（API key 登录、自己的服务商，`account/rateLimits/read` 报错），`/usage` 只写当前对话，不报错（2026-10-27 补）。
- `/model` 照 `model/list` 给什么列什么（用自己的服务商时给的是什么，见[架构](../architecture.md) §6.4）。列表为空不报错，写现在用的模型。
- 记下的模型 Codex 不再列出：新进程用 Codex 的默认，照[产品说明](../product.md) §5.6 清掉并说一句。
- agent 没在运行时写模型的显示名，用最近一次存下的模型列表。Rhodium 起的进程和 `rh doctor` 都会存。

### 额度用完

- 回合以“额度用完”的错误结束时，槽位进等额度（[产品说明](../product.md) §4.6）。
- 恢复时间取用满的那个窗口的重置时间。
- Codex 每次模型请求后都推一次额度快照，驱动记着最近的。
- credits：周额度满了以后 Codex 可能先扣 credits 接着跑。只要回合没以“额度用完”结束，Rhodium 就不管。
- 通知写“Codex 额度用完了，10-30 19:00 恢复。在等的：A、B。”，和 Claude 的分开合并、分开错开。

### 切到终端

启动命令和参数见[架构](../architecture.md) §10.3。规格层面：

- 终端不连你的共享后台服务。终端一退出写锁就放开，命令带着 pane 里注入的槽位身份。
- 关提示的参数只管这一次启动，不写你的 `config.toml`。
- 线程还没写记录（没跑过回合）：不切，回“还没有对话可以接着用”。2026-10-28 改：当成没有对话，开一段新的（#461）。
- Herdr 认出 pane 里是 codex 就算开好。你的 Herdr hook 要到第一个回合才报线程 ID，不等它。
- 切回无头时，按 pane 最后报的线程 ID 接着用；一直没报（终端里一个回合都没跑），接着用原来那段。
- 带回设置：比终端起来之前和终端里最后一个回合的设置，规则同 Claude（[产品说明](../product.md) §4.2）。通知里模型写显示名，查不到写原值。
- “别的进程在用这段对话”的检查有盲区，靠 Codex 的写锁兜住，见[架构](../architecture.md) §10.1 和下面的[收发里的几条](#收发里的几条)。
- 你的共享后台服务占着这段对话时（你自己的 codex 刚退出，最长 30 分钟），检查看不到它，照常切过去。
  - 终端里的 Codex 只读打开，提示 “This conversation is open in another app. Close it there and press R”。
  - 等后台服务放开后按 R，接着写同一段对话。不想等就退出终端，槽位切回无头，过一阵再切。

### 收发里的几条

协议见[架构](../architecture.md) §6.4。规格层面：

- 回合进行中来的话并进当前回合，回合恰好结束时改成开新回合。
- 打断时，驱动给还没做完的命令收尾，工具行不留“正在运行”。
- 只在空闲时关 Codex 进程。空闲回收、`/new`、`/resume`、切终端本来都等空闲；`rh stop` 和急停照旧马上停。
- 崩溃后由 Rhodium 发续跑提示，规则同 pi（[产品说明](../product.md) §4.5）。
- 写锁被占：故障通知写“shop/codex 没能启动，这段对话别处正在用。那边退出后再发一条消息，等着的消息会一起交给它。”，原因写“Codex 说别的程序开着它。你自己的 codex 退出后，它连的后台服务还会占一阵，最长 30 分钟。”。消息留着，下次来消息再试。

### 对话记录、导入和 `/resume`

文件在哪、读哪些行，见[架构](../architecture.md) §6.4、§7.7。规格层面：

- 按目录列对话：逐个读文件第一行，看它在哪个目录开的。
- 标题：有线程名用线程名，没有用第一条你的话。
- `rh import` 从磁盘照常导入，落到对话所在目录的工作区。给的是 pane 时回“Codex 只能从磁盘导入：rh import <线程 ID>”。
- `/resume` 和 `/rh_import` 的列表，照现有规则列这个目录里的 Codex 对话，标“（codex）”。

### rh doctor

查什么见[架构](../architecture.md) §12：版本、登录方式、还收不收“每条都问”。都不调模型、不花额度。没装 codex 就整节不写。

`rh doctor` 的写法：

```
Codex 0.162.1
Codex 登录：ChatGPT（pro）
```

- 版本和上次核对的不同时，版本后面带“（上次核对的是 0.162.1）”，另有一条告警，说 Codex 驱动照哪一版写成、要跑一遍探针核对。第一次核对带“（第一次核对）”。
- 登录的另两种写法：“API key，按用量计费”；“自定义服务商（acme，llm.example.com），按服务商计费”，括号里是服务商的名字和 `base_url` 的主机名。
- 报错的几种（2026-10-27 补的自定义服务商一并在内）：
  - 没登录、也没配服务商：说在终端里跑 `codex login`，或者在 `~/.codex/config.toml` 里配 `model_provider`。
  - 服务商的令牌来自 `env_key` 指定的环境变量，Rhodium 服务的环境里却没有它：只写变量名，不打印值，提示改用服务商的 `auth` 命令（例如读一个 0600 的文件）或别的不靠环境变量的办法。
  - 不再收“每条都问”：带上 Codex 的原话，说审批开的 Codex 槽位起不来，关掉它们的审批或换回旧版 codex。
  - 这三条都以“Codex”开头，升级 Rhodium 时不因它们退回旧版（[架构](../architecture.md) §12）。
- 环境变量过滤不去掉 `OPENAI_*` 和服务商 `env_key` 指定的变量，只去 Claude 的、`HERDR_*` 和父 Codex 会话的，无头和终端都一样（[架构](../architecture.md) §6.4）。

### 配置

- `[programs] codex` 默认是 `codex`，在 Rhodium 的 `PATH` 里找。
- 没有新的配置项。

### 接口变化汇总

| 哪里 | 变化 |
|---|---|
| `AgentKind` | 加 `"codex"` |
| agent 表 | `name: "Codex"`，`statusName: "Codex CLI"`，`program: "codex"`，`sessionIdOpens: false`，`liveApproval: "next turn"`，`ultracode: false`，`apiPrice: false`，`modelNames: true`（模型列表存进下一行的 `codexModels`），`paneImport: false`，`claudeKeys: false` |
| 环境过滤 | 父 Codex 会话的变量（`CODEX_THREAD_ID` 这类）也去掉，`CODEX_HOME` 留着 |
| 驱动表 | `codex` → `src/codex.ts` |
| 对话记录表 | Codex 的格式：按目录列、按 ID 找文件、读 `item_completed` 行 |
| 终端表 | `codex resume … --no-daemon`（[架构](../architecture.md) §10.3）；认出 agent 就算开好 |
| 带回设置表 | 读记录里每回合的设置行 |
| `SessionUse.cost` | 改成可选。Codex 不给费用 |
| meta 表 | `codexModels`：最近一次 `model/list` 的显示名，同 `claudeModels` |
| `rh set` 的回复 | Codex 槽位回合进行中改审批，多一句“下一个回合起” |
| `rh import` | Codex 不收 pane |
| `rh doctor` | Codex 一节 |
| 网页 | `LOGO.codex`（OpenAI 的标，单色，用 `currentColor`）；`NAMES.codex` 照上面的工具表 |
| 假 agent | Codex 模式：照录制回放 JSON-RPC，写 Codex 格式的对话记录，当终端时照 Herdr hook 报 agent 和线程 |

### 要先实测的

都用最便宜的模型加最低思考强度，在临时目录里，测完删掉线程。

1. 第 1 张工单开头：
   - 回合进行中发 `turn/start`，是不是并进当前回合（照源码是）。是，驱动一律用它发消息，插话恰好在回合结束时写进去的那种竞态就没了。
   - `clientUserMessageId` 是不是原样写进 `userMessage` 条目的 `clientId`。`turn/start` 和 `turn/steer` 各试一次（照源码都是）。探针没发过它。不是的话，“收下了”和重启后对输入都按写入顺序对，和 pi 一样。
2. 第 1 张工单：接着旧线程时再给一次 `developerInstructions`，是替换、叠加，还是重复写进对话。
3. 第 1 张工单：同时跑 3 个私有进程，会不会报数据库忙（0.164 才修了这一条）。
4. 第 2 张工单开头：`untrusted` 加 `danger-full-access`，每条命令、每个补丁是不是都问。
5. 第 2 张工单：拒绝之后插一句话，Codex 接不接得上。
6. 第 2 张工单：MCP 工具的审批在 elicitation 请求里怎么认出来，和要你填表的怎么分开。照源码定，再测一次。
7. 第 3 张工单：ultra 档下 Codex 开了子 agent，回合什么时候结束，线程状态什么时候回到空闲。结束得早了，空闲回收会在它还在干活时关进程。结论：会早，见[架构](../architecture.md) §6.4“子 agent”。
8. 第 4 张工单：额度用完的错误录不到，照类型手写一份。真碰上时比一遍。结论：照 0.162.1 的源码手写成 `usage-limit`，被拒那次请求的额度先推过来、再报错，见[架构](../architecture.md) §6.4“额度和用量”。还没真碰上。
9. 第 5 张工单：线程名在哪里（可能是 `~/.codex/session_index.jsonl`）。
10. 第 6 张工单：`--no-daemon` 起的终端里 `/new`、`/resume` 换了线程，Herdr hook 报不报新的 ID。
11. 第 6 张工单：Herdr 重启后自己恢复 Codex 的 pane 时用什么命令。
12. 第 6 张工单：网页终端里 Codex 的鼠标和括号粘贴。

## 测试决定

照 [v1 规格](v1.md#测试决定)的规矩：只测外部看得到的行为，测试名带故事编号。

- 假 agent 加 Codex 模式（`test/fake-agent/`）：
  - 照 `test/fixtures/codex/<场景>/` 回放 JSON-RPC。客户端请求的 id 原样回；服务端请求的 id 由录制给出，核对 Rhodium 的应答带回同一个 id。
  - 内置几段 Codex 形状的脚本，和 `pi-turn` 对应，例如 `codex-turn`、`codex-approval`、`codex-quota`。
  - 写对话记录到 `$CODEX_HOME/sessions/…`，拒绝写进真的家目录。
  - 当终端用时，照 Herdr hook 的样子先报 agent `codex`，第一个回合后再报线程 ID。
- `test/codex-fixtures.test.ts`：像 `pi-fixtures.test.ts` 一样，逐条核对[架构](../architecture.md) §6.4 写的实测事实。
- `test/codex-driver.test.ts`：每个录制场景进驱动，核对报出的统一事件；Rhodium 重启后从 `out.log` 回放，接上线程、回合和挂着的审批。
  - 另造一条会拆成两项 `commandActions` 的命令，例如 `cat a.txt && cat b.txt`。录制里没有这种。核对工具行和审批都是整条命令，取法见[架构](../architecture.md) §6.4。
- 对话记录：`test/transcript.test.ts` 加 Codex 用例，用 `test/fixtures/transcripts/codex/` 的两份。
- 整条链路：`test/instance.ts` 加第三个假 agent `codex`，沙箱 HOME 里设 `CODEX_HOME`。
  - 收发、插话、打断、崩溃续跑、写锁被占。
  - 审批开关、拒绝后插话、超时、改审批的那句提示、`untrusted` 不收时起不来。
  - `/model`、`/effort`、`/usage`、`/context`、`/compact`、`/status`；额度用完、到点续跑。
  - 切终端和切回、带回设置、还没聊过就切。
  - `rh import`、`/resume` 列表、看板对话页。
- `rh doctor`：`test/doctor.test.ts` 接假 codex，回放 `doctor`、`doctor-api-key`、`doctor-logged-out`、`doctor-provider` 四份录制（ChatGPT、API key、没登录、自己的服务商），“不收每条都问”用手写的脚本。
- 要跟着改的旧测试：`test/crash.test.ts` 的两张按 agent 的表，`quota-agents`、`tui`、`doctor`、`import` 的测试。
- 真 Codex：探针 `scripts/probes/codex/probe.ts` 和 `tui.sh` 留着，要重新核对时再跑。
  - 必须用你真的 `CODEX_HOME` 和登录。把 `auth.json` 拷到临时目录不安全：Codex 刷新令牌时会换掉旧的，你原来那份可能就失效了。
  - 录下的线程测完用 `thread/delete` 删掉。
  - 录制里换掉家目录、邮箱、账号 ID、安装 ID。
  - 终端那一步只用 `rhodium-test` 这个 Herdr 会话。
  - 不调模型的登录场景（没登录、API key、自己的服务商）用临时的 `CODEX_HOME`，服务商的 `base_url` 用解析不到的假地址。这些不碰你的登录，可以放心重录。

## 你来验收

验过的：2026-10-28 在正式实例上粗测，功能基本全部可用（七张工单 2026-10-27 合并、装上）。在终端里换了模型、没跑回合就退出时带不回来，和 Claude 一样，当作预期行为。

每张工单合并前，开发用的 agent 从源码另起一个 `rhodium`，跑成 `rhodium-test-` 开头的单元，接开发用的 Bot，你在 IM 里发。真 Codex 用你的登录，模型选最便宜的那个。不碰正式实例。

收发：

- `/rh_agent codex`，发“列一下这个目录的文件，再新建 hello.txt 写一行 hi”：工具行写 `exec_command`、`apply_patch`，最终回复发回来。看板上这个槽位是 OpenAI 的标，写 Codex CLI。
- 让它跑一条要 30 秒的命令，中途发一句“顺便告诉我现在几点”：它在同一个回合里接上。再让它跑一条长命令，发 `/stop`：回合停下，工具行没有留“正在运行”。
- 回合在跑时在 ssh 里重启这个 `rhodium`：回合接着跑完，回复照常发回来。

审批：

- `rh set <槽位> approval=on`，让它删一个文件：IM 里来审批，按拒绝。再让它删，回“别删，改名成 .bak”：它改名了。
- 回合进行中开审批：回复里写着从下一个回合起。
- 关审批，让它 `rm -rf` 一个临时目录：Codex 自己不跑，换了个办法。

命令：

- `/model` 选一个模型，再选 ultra 以外的一档；`/status` 写着它们。`/effort` 列出六档。
- `/usage`：Codex 额度一行 7d，一行 credits 余额，当前对话的 token。`/context` 一行。
- `/compact`：回压缩前后的 token 数。

终端：

- `/rh_tui`：Herdr 里打开 codex，没有更新提示和信任目录的提示，接着刚才的对话。在里面换个模型、发一句、退出：IM 里说切回无头，多一行“已应用 TUI 中的设置：模型 …”。
- 新开一个 Codex 槽位，不说话就 `/rh_tui`：终端里开一段新对话；说一句、退出终端：IM 里说切回无头了，槽位接着用这段，时间线上只有这一段（2026-10-28 改，#461）。
- `rh stop <槽位>`，在 ssh 里自己 `codex resume <线程 ID> --no-daemon` 打开这个槽位的线程，不退出，在 IM 里给它发一句：Rhodium 说它在别处开着。退出那边，再发一句：照常回复。
  - 先 `rh stop`：不然槽位的 Codex 进程还拿着写锁，只读打开的是你那边。
  - 加 `--no-daemon`：不然你的共享后台服务在你退出后还占着线程，最长 30 分钟接不上。
- 再 `rh stop <槽位>`，在 ssh 里不加 `--no-daemon` 开 `codex resume <线程 ID>`，发一句，退出，马上 `/rh_tui`：终端里的 Codex 提示 “open in another app”，只读打开。退出终端：IM 里说切回无头。这一条放最后：之后最长 30 分钟，这个槽位接不上。

对话记录：

- 看板打开这个槽位：你的话、它的话、工具调用、压缩和打断都在。
- 在 ssh 里自己 `codex --no-daemon` 聊两句，退出，`rh import <线程 ID 开头>`：新槽位在那个目录的工作区，发一句它接得上。不加 `--no-daemon` 的话，退出后最长 30 分钟接不上。
- `/resume`：列表里有这几段 Codex 对话，标着（codex）。

自检：

- `rh doctor`：写着 Codex 的版本和登录方式。

## 不做的事

| 不做的事 | 什么时候再说 |
|---|---|
| 从 Herdr pane 导入 Codex | 暂缓（第 34 轮定）。你自己在 pane 里开的 codex 默认连你的共享后台服务，命令由后台服务跑。后台服务是很早以前起的，环境里没有哪个槽位的身份。导入后它调 `rh`，Rhodium 认不出是哪个槽位，写操作都要你确认。Rhodium 自己起的 Codex 不连后台服务，没有这个问题 |
| Codex 的沙箱 | 不做（第 34 轮定） |
| “这段对话都允许”的审批按钮 | 不做，和 Claude 一样只有允许、拒绝 |
| 计划模式和计划确认 | 不做。Codex 没有计划确认 |
| MCP 要你填表、打开网址的请求 | 一律拒绝 |
| 把你的 Codex skill 做成 `/` 命令 | 用得上再加。现在 `/x` 原样当文字发 |
| `/ultracode` 对应到 ultra | 不做。ultra 在 `/effort` 里选 |
| 看板上 Codex 的“正在运行”行 | 按需。对话记录里只有做完的调用 |
| 回合结束后还在跑的命令 | 按需。回合结束后还在跑的子 agent 照第 7 条的结论报成后台任务，空闲回收等它们跑完（[架构](../architecture.md) §6.4） |
| 用 app-server 的接口读历史（`thread/read` 这类） | 不做。要起一个约 105MB 的进程；直接读文件，读不懂的行跳过 |
| 连共享后台服务 | 不做（[ADR-0011](../adr/0011-codex-private-app-server.md)） |
| 关你后台服务的自动更新 | 不需要：它碰不到 Rhodium 的进程 |
| Codex 的费用估算 | 不做。Codex 不给 |

## 其他说明

### 拆工单

顺序按“先跑通一个回合，再补齐别的”。

| # | 工单 | 做什么 | 故事 | 大小 | 被挡 |
|---|---|---|---|---|---|
| 1 | 驱动和收发 | 先实测第 1 到 3 条；`AgentKind` 加 `codex`，agent 表和环境过滤；`src/codex.ts`：握手、开线程和接着旧线程（每次带审批和沙箱，审批先只做关：审批开的 Codex 槽位起不来，故障通知写“Codex 的审批还没做好，审批开的 Codex 槽位暂时起不来。关掉这个槽位的审批再发一条。”）、收发、“收下了”、插话、打断、空闲才关、回合结束和最终回复、Rhodium 重启后接上、写锁被占、续跑提示；工具行的 Codex 名字；logo 和名字；别的表先填最小的一行（终端回“还没接上”、对话记录列不出）；假 agent 的 Codex 模式；`codex-fixtures`、`codex-driver` 测试 | 483–493 | 大 | 无 |
| 2 | 审批和提问 | 先实测第 4 到 6 条；去掉第 1 张对审批开的拦截，换成 `untrusted`；命令、改文件、权限、MCP 的审批和写法；选择题；拒绝后插话、超时；撤回；挂着的审批在 Rhodium 重启后还在；回合进行中改审批的那句；`untrusted` 不收时起不来；不认识的请求回错误 | 494–498 | 中 | 1 |
| 3 | 模型、思考强度和查询命令 | 先实测第 7 条；`/model`、`/effort`（六档）、`model_gone`、`codexModels`；`/usage`（额度窗口、credits、只写 token，`SessionUse.cost` 改可选）、`/context`、`/status` 的额度；`/compact` 和压缩时排队 | 499–501 | 中 | 1 |
| 4 | 额度用完 | 额度快照、回合以额度用完结束时进等额度、恢复时间、通知；手写的录制 | 502 | 小 | 3 |
| 5 | 对话记录、导入和 `/resume` | 先实测第 9 条；对话记录表的 Codex 格式；看板对话页、最近一句话、`rh read`；`rh import` 从磁盘；`/resume` 和 `/rh_import` 的列表 | 507–509 | 中 | 1 |
| 6 | 切终端 | 先实测第 10 到 12 条；终端表：启动命令、审批参数、关掉两个提示、认出 agent 就算开好；还没聊过不切；写锁两个方向，含你的后台服务占着时切终端；切回接 pane 报的线程；带回设置 | 503–506 | 中 | 1、5 |
| 7 | `rh doctor` 和收尾 | `rh doctor` 的 Codex 一节；`docs/agents/testing.md` 补 Codex 的录制规则；产品说明 §13 的进度 | 510 | 小 | 1 |

说明：

- 第 1 张先合。之后 2、3、5、7 互不挡，可以并行。4 等 3，6 等 5。
- 第 1 张合并后就能选 Codex，但审批开、切终端、看板对话要等后面几张。这期间审批开的 Codex 槽位起不来，不会悄悄不问。正式实例等全部合并、你同意以后再装。
- 2 到 6 都改 `src/codex.ts`，后合的那张合并时对一下。
- 每张都要：驱动的行为在 `test/codex-driver.test.ts`，接录制；牵涉路由的加一条整条链路的测试。
- 每张合并前照[你来验收](#你来验收)手动走一遍它那几条。
