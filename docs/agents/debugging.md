# 调试开发实例

这篇回答：查开发实例 `rhodium-dev` 的问题时，库、日志、socket 各在哪，怎么查才不出错。

前置阅读：[部署](../../deploy/README.md)、[架构 §4.3 托管进程的文件](../architecture.md#43-文件)、[架构 §12 可观测性与运维](../architecture.md#12-可观测性与运维)、[规格“`rh` 怎么认出调用者”](../spec/v1.md#rh-怎么认出调用者)

## 东西在哪

下面以开发实例 `rhodium-dev` 为例，路径照[部署](../../deploy/README.md)的布局。实例名不同的，把 `rhodium-dev` 换成你的实例名。`scripts/rh-dev` 就是对这个实例跑的 `rh`。

| 东西 | 在哪 |
|---|---|
| 配置 | `~/.config/rhodium/dev/config.toml` |
| 状态目录 | `~/.local/state/rhodium-dev/` |
| 数据库 | 状态目录下的 `rh.db`。表结构看 `src/store.ts` 的 `MIGRATIONS` |
| 托管进程的日志 | `~/.local/state/rhodium-dev/hold/<对话 ID>/`：`in.log` 写给 agent 的输入，`out.log` agent 的输出，`err.log` agent 的 stderr |
| `rh` 的 socket | `$XDG_RUNTIME_DIR/rhodium-dev/rh.sock` |
| 服务日志 | `journalctl --user -u rhodium-dev`，一行一个 JSON |
| 看板 | `127.0.0.1:7801` |

对开发实例跑 `rh`：

```sh
RHODIUM_SOCKET=$XDG_RUNTIME_DIR/rhodium-dev/rh.sock ~/.local/opt/rhodium-dev/current/rh ls
```

## 查数据库

`rhodium` 在跑时，不要直接打开 `rh.db`。先把 `rh.db*`（连同 `-wal`、`-shm`）拷出来，只读打开拷贝：

```sh
d=$(mktemp -d) && cp ~/.local/state/rhodium-dev/rh.db* "$d"/
bun -e '
const db = new (require("bun:sqlite").Database)(process.argv.at(-1), { readonly: true });
console.table(db.query("SELECT w.name AS workspace, s.name, s.state, s.mode, s.conversation FROM slot s JOIN workspace w ON w.id = s.workspace WHERE s.archivedAt IS NULL").all());
' "$d/rh.db"
```

查完删掉 `$d`。写查询前先看 `src/store.ts` 里的列名，别猜：

- 槽位名分两半：`workspace.name` 和 `slot.name`。
- 别的表里指向槽位、对话、窗口的列（`event.slot`、`inbound.route`、`slot.conversation` 等）存的是内部 ID，不是名字。
- 时间列是毫秒。转成本地时间：`datetime(at / 1000, 'unixepoch', 'localtime')`。
- `event.data` 是 JSON 文本，用 `json_extract` 取字段。
- 后来加的列在后面的迁移里（`ALTER TABLE`），第一段建表语句里没有。

## rh trace

`rh trace <消息 ID>` 追查一条 IM 消息。ID 写平台的消息 ID 或 Rhodium 的追踪 ID 都行。它打出：

- 入站记录：哪个 Bot、哪个窗口、发送者、收到的时间。
- 去向：投给了哪个槽位，为什么；没投给槽位时也写原因。
- 投给 agent 的每一次和结果（排队中、已写入、agent 已收下……）。
- 为它发出的每条消息和结果。
- 带这个追踪 ID 的所有事件。

入站消息和事件过了保留期就查不到了（配置里的 `durations.inboundKeep`、`durations.eventKeep`）。定义在 `src/commands.ts`，实现在 `src/ops.ts` 的 `trace`。

`rh trace` 只有用户本人能用，从 agent 的 shell 调会被拒绝。要它的结果，请用户在终端跑；或者照上面的办法查库：`inbound`、`agentInput`、`outbound`、`event` 都有 `trace` 列。

## 别从自己的 shell 跑用户级的 rh 命令

开发用的 agent 不在 Rhodium 的槽位里，也不是从终端调的，所以 Rhodium 认不出它是谁（[规格“`rh` 怎么认出调用者”](../spec/v1.md#rh-怎么认出调用者)第 3 条）。

- 只读的命令照常用：`rh ls`、`rh read`、`rh doctor`、不带参数的 `rh ws`。
- 会改东西的命令（`archive`、`stop`、`new`、`send` 等）不会直接执行，而是变成一条确认请求，发到用户手机上。在循环里跑，用户会一下收到一串确认（2026-10-22 有过 12 条）。
- 只有用户本人能用的命令（`trace`、`set`、`use`、`bind`、`bot`、`pair`、`stop --all`）直接拒绝。

要做这些事，把命令写给用户，请他在自己的终端跑。
