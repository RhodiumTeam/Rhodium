// Telegram rich messages (#29): what rich Markdown does to an agent's plain words, how fast a rich
// message can be edited, and which edits between plain and rich text work. Sends a few silent
// messages to your private chat with the dev bot, prints what Telegram made of each, and deletes
// every message it sent.
//
// Usage: bun scripts/probes/telegram/rich.ts [token-file] [chat-id-file]
// Defaults: ~/.config/rhodium-dev/telegram.env (the whole file is the token)
// and ~/.config/rhodium-dev/telegram-owner-id.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

type Reply = { ok: boolean; result?: any; error_code?: number; description?: string; parameters?: { retry_after?: number } };

const dir = `${homedir()}/.config/rhodium-dev`;
const token = readFileSync(process.argv[2] ?? `${dir}/telegram.env`, "utf8").trim();
const chat_id = Number(readFileSync(process.argv[3] ?? `${dir}/telegram-owner-id`, "utf8").trim());

async function call(method: string, params: object = {}): Promise<Reply> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    return (await res.json()) as Reply;
  } catch (e) {
    throw new Error(String(e).replaceAll(token, "<token>")); // fetch errors may echo the URL
  }
}

const sent: number[] = [];
const rich = async (markdown: string, extra: object = {}) => {
  const r = await call("sendRichMessage", { chat_id, rich_message: { markdown }, disable_notification: true, ...extra });
  if (r.ok) sent.push(r.result.message_id);
  return r;
};
const plain = async (text: string) => {
  const r = await call("sendMessage", { chat_id, text, disable_notification: true });
  if (r.ok) sent.push(r.result.message_id);
  return r;
};
const editRich = (message_id: number, markdown: string, extra: object = {}) => call("editMessageText", { chat_id, message_id, rich_message: { markdown }, ...extra });
const editPlain = (message_id: number, text: string) => call("editMessageText", { chat_id, message_id, text });
const outcome = (r: Reply) => (r.ok ? "ok" : `${r.error_code} ${r.description}`);

const out: Record<string, unknown> = {};
try {
  // 1. Words an agent writes outside code that rich Markdown may take for formulas, spoilers,
  // marks or HTML; then the same with backslash escapes.
  const words = {
    generics: "Vec<T> and Option<String>",
    tag: "use <b> for bold, and <details>",
    dollars: "costs $5 to $10 a month",
    shell: "set $HOME and $PATH",
    pipes: "a || b || c",
    marks: "x == y and z == w",
    escaped: "Vec\\<T\\>, \\$5 to \\$10, a \\|\\| b, x \\=\\= y, \\<details\\>",
    formula: "$x^2$ and ||secret|| and ==marked==",
    formulaEscaped: "\\$x^2\\$ and \\|\\|secret\\|\\| and \\=\\=marked\\=\\=",
    entities: "Vec&lt;T&gt; and AT&T and a &amp; b and a < b and 1<2",
    code: "`a || b` and `$HOME` and `Vec<T>`",
    fence: "```rust\nlet v: Vec<T> = a || b; // $5\n```",
    gfm: "# Title\n\n- **bold** and _it_\n- [link](https://example.com)\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quote",
  };
  const parsed: Record<string, unknown> = {};
  for (const [name, md] of Object.entries(words)) {
    const r = await rich(md);
    parsed[name] = r.ok ? r.result.rich_message ?? r.result : outcome(r);
  }
  out.parsed = parsed;

  // 2. A rich message edited once a second, ten times.
  const live = await rich("editing 0");
  const edits: string[] = [];
  for (let i = 1; i <= 10 && live.ok; i++) {
    await Bun.sleep(1000);
    edits.push(outcome(await editRich(live.result.message_id, `editing **${i}**`)));
  }
  out.richEditsOncePerSecond = edits;
  if (live.ok) out.sameTextAgain = outcome(await editRich(live.result.message_id, "editing **10**"));

  // 3. Plain to rich and rich to plain.
  const p = await plain("plain first");
  if (p.ok) out.plainToRich = outcome(await editRich(p.result.message_id, "now **rich**"));
  const r = await rich("rich first");
  if (r.ok) out.richToPlain = outcome(await editPlain(r.result.message_id, "now plain"));

  // 4. Inline buttons on a rich message, then taken off.
  const keyboard = { inline_keyboard: [[{ text: "允许", callback_data: "a:1" }, { text: "拒绝", callback_data: "a:2" }]] };
  const b = await rich("with buttons", { reply_markup: keyboard });
  out.richWithButtons = outcome(b);
  if (b.ok) out.buttonsRemoved = outcome(await call("editMessageReplyMarkup", { chat_id, message_id: b.result.message_id, reply_markup: { inline_keyboard: [] } }));

  // 5. Markdown Telegram can't parse, if any, and the limit.
  out.unclosedTag = outcome(await rich("<b>never closed"));
  out.over4096 = outcome(await rich("x".repeat(5000)));
} finally {
  for (const message_id of sent) await call("deleteMessage", { chat_id, message_id });
  out.deleted = sent.length;
}
console.log(JSON.stringify(out, null, 2));
