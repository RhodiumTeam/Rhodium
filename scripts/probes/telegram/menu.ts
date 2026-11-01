// Probe 16 (Telegram): can a bot register `rh_` commands for one private chat?
// Registers the 17 v1 menu commands with BotCommandScopeChat, reads them back,
// checks the default scope is untouched, then restores the chat scope.
// Also confirms the server knows `sendMessageDraft` by calling it with no
// parameters. Nothing is ever sent to any chat.
//
// Usage: bun scripts/probes/telegram/menu.ts [token-file] [chat-id-file]
// Defaults: ~/.config/rhodium-dev/telegram.env (the whole file is the token)
// and ~/.config/rhodium-dev/telegram-owner-id. Exits 1 if any check fails.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

type BotCommand = { command: string; description: string };
type Reply = { ok: boolean; result?: unknown; error_code?: number; description?: string };

const dir = `${homedir()}/.config/rhodium-dev`;
const token = readFileSync(process.argv[2] ?? `${dir}/telegram.env`, "utf8").trim();
const chatId = Number(readFileSync(process.argv[3] ?? `${dir}/telegram-owner-id`, "utf8").trim());

const MENU: BotCommand[] = [
  ["stop", "停止当前回合"],
  ["new", "开一段新对话"],
  ["status", "看槽位和 agent 的状态"],
  ["rh_use", "改当前聊天窗口的目标"],
  ["resume", "回到旧对话"],
  ["model", "切模型"],
  ["usage", "看额度用量"],
  ["rh_ls", "列出槽位"],
  ["rh_tui", "切到 TUI 模式"],
  ["rh_help", "帮助"],
  ["context", "看上下文占用"],
  ["compact", "压缩上下文"],
  ["effort", "设思考强度"],
  ["rh_agent", "换 agent，从一段新对话开始"],
  ["rh_release", "强制切回无头"],
  ["rh_bind", "改这个 Bot 的默认目标"],
  ["rh_import", "把磁盘上的对话或 Herdr pane 导入成槽位"],
].map(([command, description]) => ({ command: command!, description: description! }));

async function call(method: string, params: object = {}): Promise<Reply> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await res.json()) as Reply;
  } catch (e) {
    // fetch errors may echo the URL; never let the token reach the output.
    throw new Error(String(e).replaceAll(token, "<token>"));
  }
}

const same = (a: unknown, b: BotCommand[]) =>
  Array.isArray(a) &&
  JSON.stringify(a.map(({ command, description }) => ({ command, description }))) ===
    JSON.stringify(b);

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const scope = { type: "chat", chat_id: chatId };

const me = await call("getMe");
if (!me.ok) {
  console.error(`getMe failed: ${me.error_code} ${me.description}`);
  process.exit(1);
}
const before = (await call("getMyCommands", { scope })).result as BotCommand[];
const defaultBefore = (await call("getMyCommands")).result as BotCommand[];
notes.chatScopeBefore = before.length;
notes.defaultScopeBefore = defaultBefore.length;

try {
  const hyphen = await call("setMyCommands", {
    commands: [{ command: "rh-use", description: "x" }],
    scope,
  });
  checks.hyphenRejected = !hyphen.ok;
  notes.hyphenError = hyphen.description;

  checks.set = (await call("setMyCommands", { commands: MENU, scope })).ok;
  const readBack = await call("getMyCommands", { scope });
  checks.readBackMatches = same(readBack.result, MENU);
  notes.readBackRaw = readBack.result;
  checks.defaultScopeUntouched = same((await call("getMyCommands")).result, defaultBefore);
} finally {
  // Put the chat scope back exactly as found: delete if it was empty.
  const restore = before.length
    ? await call("setMyCommands", { commands: before, scope })
    : await call("deleteMyCommands", { scope });
  checks.restored = restore.ok && same((await call("getMyCommands", { scope })).result, before);
}

// No chat_id: the server can only say "bad request" (method exists) or 404.
const draft = await call("sendMessageDraft");
checks.draftMethodKnown = !draft.ok && draft.error_code === 400;
notes.draftError = `${draft.error_code} ${draft.description}`;

console.log(JSON.stringify({ checks, notes }, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
