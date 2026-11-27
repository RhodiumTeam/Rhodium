// Telegram drafts (#784): sendMessageDraft and sendRichMessageDraft, as a turn's message shows while
// it goes, and sendRichMessage, as it is sent at the end. Sends drafts and a few messages to your
// private chat with the dev bot, and prints each call's outcome and time, never the token or chat id.
// What only eyes can tell (the animation, how long a draft stays, the fold) needs you watching your phone.
//
// Usage: bun scripts/probes/telegram/drafts.ts <mode> [token-file] [chat-id-file]
// Modes:
//   api       30 drafts one after the other (no 429 at about 2 a second); a rich draft with
//             can_stop; an empty one ("Thinking…"); a rich message to end it
//   par       20 drafts at once: some come back 429
//   live      watch: text growing, a non-prefix replace, a draft left alone (does it go after
//             30 s?), a message sent mid-draft (does the draft go?), can_stop's button
//   fold      watch: tool lines growing in a quote, then folded: an HTML draft, a rich draft with
//             <details>, and messages with each
//   foldslow  watch: a rich draft's <details open> block growing a line every 3 s, then closed
//   anim      watch: text growing in a rich draft, a plain one and an HTML one, side by side
//   combo     watch: what a turn does, tool blocks open while they run and closed after, the text
//             growing under them, then sent as a rich message
// Defaults: ~/.config/rhodium-dev/telegram.env (the whole file is the token)
// and ~/.config/rhodium-dev/telegram-owner-id.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

type Reply = { ok: boolean; error_code?: number; description?: string; parameters?: { retry_after?: number } };

const dir = `${homedir()}/.config/rhodium-dev`;
const mode = process.argv[2] ?? "";
const token = readFileSync(process.argv[3] ?? `${dir}/telegram.env`, "utf8").trim();
const chat_id = Number(readFileSync(process.argv[4] ?? `${dir}/telegram-owner-id`, "utf8").trim());
const sleep = (ms: number) => Bun.sleep(ms);

async function call(method: string, params: object): Promise<Reply> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id, ...params }),
    });
    return (await res.json()) as Reply;
  } catch (e) {
    throw new Error(String(e).replaceAll(token, "<token>")); // fetch errors may echo the URL
  }
}

/** One call, printed as a line of JSON: its step's name, ok, how long it took, and Telegram's error. */
async function step(name: string, method: string, params: object): Promise<void> {
  const t0 = performance.now();
  const r = await call(method, params);
  const ms = Math.round(performance.now() - t0);
  console.log(JSON.stringify({ name, ok: r.ok, ms, ...(!r.ok && { code: r.error_code, desc: r.description, retry: r.parameters?.retry_after }) }));
}
const draft = (name: string, draft_id: number, text: string, more: object = {}) => step(name, "sendMessageDraft", { draft_id, text, ...more });
const richDraft = (name: string, draft_id: number, markdown: string, more: object = {}) => step(name, "sendRichMessageDraft", { draft_id, rich_message: { markdown }, ...more });
const rich = (name: string, markdown: string) => step(name, "sendRichMessage", { rich_message: { markdown } });

/** Text growing three characters at a time, every 400 ms: each step's whole text so far. */
async function grow(head: string, words: string, show: (text: string) => Promise<void>): Promise<void> {
  const w = [...words];
  for (let i = 3; i <= w.length + 2; i += 3) {
    await show(head + w.slice(0, i).join(""));
    await sleep(400);
  }
}

const WORDS = "探针：这是一段模拟 agent 逐字输出的文字，用来看 Telegram 草稿消息的动画效果，每次传累积的全量文本。";
const TOOLS = ["🔧 Bash `bun test`", "🔧 Read `src/feishu.ts`", "🔧 Edit `src/daemon.ts`"];
const HTML_TOOLS = ["🔧 Bash <code>bun test</code>", "🔧 Read <code>src/feishu.ts</code>", "🔧 Edit <code>src/daemon.ts</code>"];

const modes: Record<string, () => Promise<void>> = {
  async api() {
    let t = "[API] 连发草稿 ";
    for (let i = 1; i <= 30; i++) await draft(`burst-${i}`, 7001, (t += "▮"));
    await richDraft("rich-draft", 7002, "**[API]** rich 草稿，带 `code` 和\n\n> 引用块", { can_stop: true });
    await draft("empty-draft", 7003, "");
    await rich("rich-final", "**[探针]** Telegram 草稿 API 测试结束（这条是定稿的真消息，可以删）");
  },
  async par() {
    await Promise.all(Array.from({ length: 20 }, (_, i) => draft(`par-${i + 1}`, 7004, `[API] 并发草稿 ${"▮".repeat(i + 1)}`)));
  },
  async live() {
    const head = "[1/5] 草稿逐字（每 400ms 一次，同一 draft_id）\n\n";
    await grow(head, WORDS, (t) => draft("live-stream", 8001, t));
    await draft("live-nonprefix", 8001, `[2/5] 非前缀替换：整段换掉\n\n${WORDS.slice(10)}`);
    await sleep(3000);
    await draft("live-hold", 8001, "[3/5] 这条草稿之后不再更新，看它多久消失（脚本 60 秒后继续）");
    await sleep(60_000);
    await draft("live-again", 8002, "[4/5] 新草稿，3 秒后 Bot 发一条真消息，看草稿是否消失");
    await sleep(3000);
    await step("live-mid-send", "sendMessage", { text: "[4/5] 回合中途 Bot 发的真消息（可删）" });
    await sleep(4000);
    await richDraft("live-stop", 8003, "**[5/5]** rich 草稿带停止按钮，可以按一下停止（20 秒后定稿）", { can_stop: true });
    await sleep(20_000);
    await rich("live-final", "**[5/5] 定稿**：草稿探针结束（可删）");
  },
  async fold() {
    const html = (n: number) => HTML_TOOLS.slice(0, n).join("\n");
    for (let n = 1; n <= 3; n++) {
      await draft(`html-draft-grow-${n}`, 9001, `<b>[折叠 1] HTML 草稿</b>\n<blockquote>${html(n)}</blockquote>`, { parse_mode: "HTML" });
      await sleep(800);
    }
    await draft("html-draft-shrink", 9001, "<b>[折叠 1] HTML 草稿</b>\n<blockquote>🔧 Bash ×1，Read ×1，Edit ×1</blockquote>\n开始说话……", { parse_mode: "HTML" });
    await sleep(1500);
    await draft("html-draft-expandable", 9001, `<b>[折叠 1] HTML 草稿</b>\n<blockquote expandable>${html(3)}</blockquote>\n草稿里的可展开引用块`, { parse_mode: "HTML" });
    await sleep(1500);
    for (let n = 1; n <= 3; n++) {
      await richDraft(`rich-draft-grow-${n}`, 9002, `**[折叠 2] rich 草稿**\n\n${TOOLS.slice(0, n).map((l) => `> ${l}`).join("\n")}`);
      await sleep(800);
    }
    const details = `<details><summary>🔧 工具 ×3</summary>\n\n${TOOLS.join("\n\n")}\n\n</details>`;
    await richDraft("rich-draft-details", 9002, `**[折叠 2] rich 草稿**\n\n${details}\n\n开始说话……`);
    await sleep(1500);
    await step("final-html-expandable", "sendMessage", { text: `<b>[折叠 3] 定稿：HTML 可展开引用块</b>\n<blockquote expandable>${html(3)}</blockquote>\n这里是正文。`, parse_mode: "HTML" });
    await rich("final-rich-details", `**[折叠 4] 定稿：rich 的 details 块**\n\n${details}\n\n这里是正文。`);
    // Rich messages turn MarkdownV2's expandable quote down (2026-11-17).
    await rich("final-rich-expandable-quote", `**[折叠 5] 定稿：rich 里的可展开引用**\n\n**>${TOOLS.join("\n>")}||\n\n这里是正文。`);
  },
  async foldslow() {
    const head = "**[慢放] rich 草稿**\n\n";
    for (let n = 1; n <= 3; n++) {
      await richDraft(`slow-open-${n}`, 9101, `${head}<details open><summary>🔧 工具 ×${n}（运行中，展开）</summary>\n\n${TOOLS.slice(0, n).join("\n\n")}\n\n</details>`);
      await sleep(3000);
    }
    const folded = `${head}<details><summary>🔧 Bash ×1，Read ×1，Edit ×1</summary>\n\n${TOOLS.join("\n\n")}\n\n</details>\n\n`;
    await richDraft("slow-fold", 9101, `${folded}工具段结束，收起，开始说话`);
    await sleep(3000);
    await richDraft("slow-say", 9101, `${folded}工具段结束，收起，开始说话。这是后面的正文，一点点往外长……`);
    await sleep(4000);
    await rich("slow-final", `${folded}**[慢放] 定稿**：工具段收起，这里是正文。`);
  },
  async anim() {
    const words = "这是一段用来对照动画的文字：每四百毫秒加三个字，看新加的字是渐渐浮现，还是一下子蹦出来。";
    await grow("**[对照 1] rich 草稿**\n\n", words, (t) => richDraft("anim-rich", 9201, t));
    await sleep(2500);
    await grow("[对照 2] 普通草稿\n\n", words, (t) => draft("anim-plain", 9202, t));
    await sleep(2500);
    await grow("<b>[对照 3] 普通草稿 + HTML</b>\n\n", words, (t) => draft("anim-html", 9203, t, { parse_mode: "HTML" }));
  },
  async combo() {
    const tools = [
      ["🔧 Bash `bun test test/telegram.test.ts`", "🔧 Read `src/telegram.ts`", "🔧 Edit `src/daemon.ts`"],
      ["🔧 Grep `sendMessageDraft`", "🔧 Bash `git diff --stat`"],
    ];
    const say = [
      "测试都过了。我改了 daemon 里的编辑队列，让最后一次编辑把 final 带给适配器，这样 Telegram 定稿时能发成真消息。",
      "改动一共三个文件，下面是总结：队列结构没变，只多传了一个字段；飞书和 Telegram 两边各自决定怎么用它。",
    ];
    const stat = (ls: string[]) => `${ls.map((l) => l.split(" ")[1]).join(" ×1，")} ×1`;
    const block = (ls: string[], open: boolean) => `<details${open ? " open" : ""}><summary>🔧 ${open ? `工具 ×${ls.length}（运行中）` : stat(ls)}</summary>\n\n${ls.join("\n\n")}\n\n</details>`;
    let done = "**[逐字 + 折叠]** rich 草稿\n\n";
    for (const [i, ls] of tools.entries()) {
      for (let k = 1; k <= ls.length; k++) {
        await richDraft(`combo-tool-${i}-${k}`, 9401, done + block(ls.slice(0, k), true));
        await sleep(2000);
      }
      done += `${block(ls, false)}\n\n`;
      await grow(done, say[i]!, (t) => richDraft(`combo-say-${i}`, 9401, t));
      done += `${say[i]}\n\n`;
      await sleep(1000);
    }
    await rich("combo-final", done.replace("rich 草稿", "定稿"));
  },
};

const run = modes[mode];
if (!run) {
  console.error(`usage: bun scripts/probes/telegram/drafts.ts <${Object.keys(modes).join("|")}> [token-file] [chat-id-file]`);
  process.exit(2);
}
await run();
