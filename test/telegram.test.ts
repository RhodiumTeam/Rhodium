// The Telegram adapter on grammY, its apiRoot pointed at a local stand-in for the Bot API, as far as
// the stand-in copies Telegram: what Telegram itself does with the calls is not in automated tests
// (docs/spec/v1.md "不在自动测试里的").
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { botApi, ME } from "./bot-api";
import type { Script, Step } from "./fake-agent/fake-agent";
import { asking, endTurn, on, startTurn, textDelta, toolCall } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, withoutSource, type Instance } from "./instance";
import { TelegramAdapter } from "../src/telegram";
import { TELEGRAM_ROW } from "../src/commands";

const TOKEN = "123456:fake-token-never-logged";

let rhodium: Instance;
let api: ReturnType<typeof botApi>;
afterEach(async () => {
  await rhodium?.cleanup();
  api.stop();
});

test("each getUpdates tells rhodium how it went, to count the failures: a refused one with Telegram's error, then one that got through", async () => {
  api = botApi({ refuseFirstPoll: true });
  const heard: (string | undefined | true)[] = [];
  const bot = new TelegramAdapter("B1", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: () => {} });
  const messages = bot.messages((up, error) => heard.push(up || error));
  const next = messages.next();
  await until(() => heard.length >= 2, 5_000);
  expect(heard.slice(0, 2)).toEqual([expect.stringContaining("401"), true]);
  expect(heard[0]).not.toContain(TOKEN);
  api.say("hello"); // so the generator stops at a message, and can be closed
  await next;
  await messages.return(undefined);
});

test("after a restart, rhodium reads Telegram on from where it got to, not from the start", async () => {
  api = botApi();
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhodium.start();
  await rhodium.slots("a");
  api.say("hello");
  await until(() => api.sent.length === 1, 15_000);
  expect(api.sent).toEqual([{ chat_id: String(ME), text: "fake reply", rich: true }]);

  // The agent stops first: taking a running one back after a restart is not this test's to show.
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await rhodium.stop();
  const polled = api.polls.length;
  api.say("are you there?"); // while rhodium is down
  await rhodium.start();
  await until(() => api.sent.length === 2, 15_000);
  expect(api.polls[polled]).toBe(1001); // the update after hello's
  expect(api.sent[1]).toEqual({ chat_id: String(ME), text: "fake reply", rich: true });
}, 30_000);

test("story 147: the board says the bot is not connected while Telegram turns its polls down, and connected once one is answered", async () => {
  api = botApi({ refuseFirstPoll: true });
  rhodium = newInstance({ toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`].join("\n") });
  const d = await rhodium.start();
  const board = `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
  const status = async () => (await (await fetch(`${board}/api/rhodium`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as { bots: { name: string; platform: string; state: string }[] };
  await until(async () => (await status()).bots[0]!.state === "online", 10_000);
  expect((await status()).bots).toEqual([{ name: "t", platform: "telegram", state: "online" }]);
  expect(d.logs.filter((l) => l.msg === "bot connection")).toEqual([
    { msg: "bot connection", bot: "t", state: "reconnecting" },
    { msg: "bot connection", bot: "t", state: "online" },
  ]);
  // The refused poll was logged, and no log line carries the token.
  const logs = d.logs.map((l) => JSON.stringify(l));
  expect(logs.some((l) => l.includes("getUpdates") && l.includes("401"))).toBe(true);
  expect(logs.filter((l) => l.includes(TOKEN))).toEqual([]);
}, 30_000);

test("another bot's token put under the same name reads from its own start, not from where the old bot got to", async () => {
  api = botApi();
  rhodium = newInstance({ toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`].join("\n") });
  await rhodium.start();
  api.say("hello");
  await until(() => api.polls.includes(1001), 15_000); // hello read
  await rhodium.stop();

  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace(TOKEN, "654321:another-bot"));
  const polled = api.polls.length;
  await rhodium.start();
  await until(() => api.polls.length > polled, 15_000);
  // The old bot's offset would have Telegram take every update of the new bot's below it as read.
  expect(api.polls[polled]).toBeUndefined();
}, 30_000);

test("story 73: a reply goes as a rich message in Telegram's Markdown; one Telegram turns down goes again as plain text, and its flood limit is waited out", async () => {
  api = botApi();
  const reply = "Use `Vec<T>`, not Vec<T>.";
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
    claude: { script: { on, steps: [...startTurn, ...endTurn(reply), { goto: 0 }] } },
  });
  await rhodium.start();
  await rhodium.slots("a");
  api.say("hi");
  await until(() => api.sent.length === 1, 15_000);
  api.next.push({ method: "sendRichMessage", how: "refuse" });
  api.say("again");
  await until(() => api.sent.length === 2, 15_000);
  api.next.push({ method: "sendRichMessage", how: "flood" });
  api.say("and again");
  await until(() => api.sent.length === 3, 15_000);
  expect(api.sent).toEqual([
    { chat_id: String(ME), text: "Use `Vec<T>`, not Vec&lt;T>.", rich: true },
    { chat_id: String(ME), text: reply },
    { chat_id: String(ME), text: "Use `Vec<T>`, not Vec&lt;T>.", rich: true },
  ]);
}, 30_000);

/** A Telegram bot t, its apiRoot the stand-in's, sending your messages to slot w/a. */
const tg = () => ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n");

test("stories 72, 73: an edit Telegram can't take as Markdown goes as plain text; one to what the message shows is done; one still over the flood limit after the waits is not sent anew", async () => {
  api = botApi();
  const deltas = Array.from({ length: 4 }, (_, i): Step[] => [{ sleep: 1000 }, { emit: [textDelta(`${i} `)] }]).flat();
  rhodium = newInstance({
    toml: tg(),
    // A second for the tool's own edit, from running to done, before the text comes.
    claude: { script: { on, steps: [...startTurn, toolCall("toolu_read", "Read", { file_path: "notes.txt" }), { sleep: 1000 }, ...deltas, ...endTurn("0 1 2 3"), { goto: 0 }] } },
  });
  const d = await rhodium.start();
  await rhodium.slots("a");
  const edit = "editMessageText";
  api.next.push({ method: edit, how: "refuse", rich: true }, { method: edit, how: "same", rich: true }, ...Array.from({ length: 3 }, () => ({ method: edit, how: "flood0" as const, rich: true })));
  api.say("count");
  const edits = () => api.calls.filter((c) => c.method === edit).map((c) => c.body.rich_message?.markdown ?? { plain: c.body.text });
  const tool = "> [🔧 Read] `notes.txt`";
  await until(() => edits().at(-1) === `${tool}\n\n0 1 2 3`, 20_000);
  // The first edit turned down as Markdown, then made in plain text; the second "not modified"; the
  // third over the flood limit three times. None of them sent the text anew.
  expect(edits().slice(0, 4)).toEqual([tool, { plain: "[🔧 Read] notes.txt" }, `${tool}\n\n0`, `${tool}\n\n0 1`]);
  expect(api.calls.filter((c) => c.method === "sendRichMessage" || c.method === "sendMessage")).toHaveLength(1);
  expect(d.logs.filter((l) => l.msg === "edit failed")).toEqual([expect.objectContaining({ flood: true })]);
}, 30_000);

test("stories 75, 82: an ask's options go as inline buttons; your press is answered, reaches the agent, and takes the buttons off", async () => {
  api = botApi();
  rhodium = newInstance({ toml: tg(), claude: { script: asking([["p-1", "Bash", { command: "make" }]]) } });
  await rhodium.start();
  await rhodium.slots("a");
  api.say("build it");
  await until(() => api.calls.some((c) => c.body.reply_markup), 15_000);
  const ask = api.calls.find((c) => c.body.reply_markup)!;
  const buttons: { text: string; callback_data: string }[][] = ask.body.reply_markup.inline_keyboard;
  expect(buttons.map((row) => row.map((b) => b.text))).toEqual([["允许", "拒绝"]]); // one row (docs/im-style.md §11.2)
  const id = api.sent.findIndex((s) => s.text === ask.body.text) + 1;
  api.press(id, buttons[0]![0]!.callback_data);
  await until(() => api.sent.some((s) => s.text === "answered"), 15_000);
  expect(api.sent.map((s) => s.text)).toContain("已允许运行这条命令。");
  expect(api.calls.filter((c) => c.method === "answerCallbackQuery").map((c) => c.body)).toEqual([{ callback_query_id: expect.stringMatching(/^press-/) }]);
  await until(() => api.calls.some((c) => c.method === "editMessageReplyMarkup"), 15_000);
  expect(api.calls.find((c) => c.method === "editMessageReplyMarkup")!.body).toEqual({ chat_id: String(ME), message_id: id, reply_markup: { inline_keyboard: [] } });
}, 30_000);

// A 1x1 PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
/** Where rhodium keeps these bytes. */
const stored = (data: Buffer) => join(rhodium.dir, "state/media", new Bun.CryptoHasher("sha256").update(data).digest("hex"));
/** The content of each user frame the fake claude was given, in order, its text without the source line. */
const users = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => m.message.content.map((b: { type: string; text?: string }) => (b.type === "text" ? { ...b, text: withoutSource(b.text!) } : b)));

test("a reply to your old picture brings it as kept, its path too; Telegram's caption only when none was kept", async () => {
  api = botApi();
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhodium.start();
  await rhodium.slots("a");
  const texts = () => users().map((c: { type: string; text?: string }[]) => c.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
  api.files.set("photo-1", PNG);
  const photo = { photo: [{ file_id: "photo-1", file_unique_id: "p", width: 1, height: 1 }] };
  const chart = api.say({ ...photo, caption: "the chart" });
  await until(() => users().length === 1, 15_000);

  api.say({ text: "what about this?", reply_to_message: chart });
  await until(() => users().length === 2, 15_000);
  // Sent before rhodium was there, say.
  api.say({ text: "and this?", reply_to_message: { ...chart, ...photo, message_id: 5, caption: "an old one" } });
  await until(() => users().length === 3, 15_000);
  // Part of it picked: that part, as ever.
  api.say({ text: "this bit?", reply_to_message: chart, quote: { text: "chart", position: 4 } });
  await until(() => users().length === 4, 15_000);

  expect(texts().slice(1)).toEqual([`> the chart\n> [图片] ${stored(PNG)}\n\nwhat about this?`, "> an old one\n\nand this?", "> chart\n\nthis bit?"]);
}, 30_000);

test("story 574: a reply to a whole message of 300 characters brings the agent its first 100 and …; a part of 300 you picked comes whole", async () => {
  api = botApi();
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhodium.start();
  await rhodium.slots("a");
  const long = Array.from({ length: 300 }, (_, i) => "一二三四五六七八九十"[i % 10]).join("");
  const texts = () => users().map((c: { type: string; text?: string }[]) => c.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
  const reply = { message_id: 7, date: 0, chat: { id: ME, type: "private" }, from: { id: 1, is_bot: true, first_name: "bot" }, text: long + long };
  api.say({ text: "第二处呢", reply_to_message: reply });
  await until(() => users().length === 1, 15_000);
  api.say({ text: "这段呢", reply_to_message: reply, quote: { text: long, position: 0 } });
  await until(() => users().length === 2, 15_000);

  expect(texts()).toEqual([`> ${long.slice(0, 100)}…\n\n第二处呢`, `${long.replace(/^/gm, "> ")}\n\n这段呢`]);
}, 30_000);

test("a voice message of yours is not for the agent yet: you are told so, and a stranger is not", async () => {
  api = botApi();
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhodium.start();
  await rhodium.slots("a");
  // Hand-written after the Bot API's Voice object, as a phone records it.
  const voice = { voice: { file_id: "voice-1", file_unique_id: "v1", duration: 3, mime_type: "audio/ogg", file_size: 9000 } };
  const stranger = { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "x" } };
  api.say({ ...stranger, ...voice });
  api.say(voice);
  api.say({ ...voice, caption: "about this" }); // a caption does not make it heard
  api.say("hello");
  await until(() => api.sent.length === 3, 15_000);

  const notice = "暂不支持语音，这条没交给 agent。用文字再发一遍。";
  expect(api.sent.map((s) => [s.chat_id, s.text])).toEqual([[String(ME), notice], [String(ME), notice], [String(ME), "fake reply"]]);
  expect(users()).toEqual([[{ type: "text", text: "hello" }]]);
  expect(api.asked).toEqual([]); // never downloaded
}, 30_000);

test("a stranger's file is never downloaded; one of yours Telegram won't hand over is named in the text", async () => {
  api = botApi();
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
  });
  await rhodium.start();
  await rhodium.slots("a");
  api.files.set("theirs", Buffer.from("20 MB of junk"));
  const stranger = { chat: { id: 999, type: "private" }, from: { id: 999, is_bot: false, first_name: "x" } };
  api.say({ ...stranger, document: { file_id: "theirs", file_unique_id: "t", file_name: "junk.bin" }, caption: "hi" });
  api.say({ document: { file_id: "too-big", file_unique_id: "b", file_name: "dump.zip" }, caption: "take this" });
  await until(() => users().length === 1, 15_000);

  expect(api.asked).toEqual(["too-big"]);
  expect(users()[0]).toEqual([{ type: "text", text: expect.stringMatching(/^take this\n\[文件没收到：dump\.zip，.*file is too big.*\]$/) }]);
}, 30_000);

test("pictures, files and replies come in by Telegram's own fields, and rh send me --file goes out as a photo, an animation or a document", async () => {
  api = botApi();
  const script: Script = {
    on,
    steps: [
      ...startTurn,
      ...endTurn("got it"),
      ...startTurn,
      { rh: ["send", "me", "--file", "chart.png", "the chart"] },
      { rh: ["send", "me", "--file", "wave.gif"] },
      { rh: ["send", "me", "--file", "notes.txt"] },
      ...endTurn("done"),
    ],
  };
  rhodium = newInstance({
    toml: ["[bots.t]", 'platform = "telegram"', `token = "${TOKEN}"`, `apiRoot = "${api.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n"),
    claude: { script },
  });
  await rhodium.start();
  await rhodium.slots("a");
  const csv = Buffer.from("name,count\nwicks,12\n");
  writeFileSync(join(rhodium.dir, "w/chart.png"), PNG);
  writeFileSync(join(rhodium.dir, "w/notes.txt"), csv);
  const gif = Buffer.from("GIF89a, moving");
  writeFileSync(join(rhodium.dir, "w/wave.gif"), gif);

  // A file, with its caption for text.
  api.files.set("doc-1", csv);
  api.say({ document: { file_id: "doc-1", file_unique_id: "d1", file_name: "counts.csv" }, caption: "sum these" });
  await until(() => users().length === 1, 15_000);
  expect(users()[0]).toEqual([{ type: "text", text: `sum these\n[文件] counts.csv：${stored(csv)}` }]);
  expect(readFileSync(stored(csv))).toEqual(csv);

  // The largest size of a photo, under a reply to an earlier message, whose text Telegram brings.
  api.files.set("photo-big", PNG);
  const sizes = [{ file_id: "photo-small", file_unique_id: "s", width: 1, height: 1 }, { file_id: "photo-big", file_unique_id: "b", width: 1, height: 1 }];
  const earlier = { message_id: 7, date: 0, chat: { id: ME, type: "private" }, text: "the chart of wicks" };
  api.say({ photo: sizes, caption: "send me this chart", reply_to_message: earlier });
  await until(() => users().length === 2, 15_000);
  expect(users()[1]).toEqual([
    { type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } },
    { type: "text", text: `> the chart of wicks\n\nsend me this chart\n[图片] ${stored(PNG)}` },
  ]);

  // The text goes first, then each file; a picture as a photo, a GIF as an animation (a photo would
  // stand still), the rest as a document. Each by the agent's name for it.
  await until(() => api.uploads.length === 3, 15_000);
  expect(api.sent.map((s) => s.text)).toContain("the chart");
  expect(api.uploads).toEqual([
    { method: "sendPhoto", chat_id: String(ME), name: "chart.png", data: new Uint8Array(PNG) },
    { method: "sendAnimation", chat_id: String(ME), name: "wave.gif", data: new Uint8Array(gif) },
    { method: "sendDocument", chat_id: String(ME), name: "notes.txt", data: new Uint8Array(csv) },
  ]);
}, 30_000);

test("a picture Telegram won't take as a photo, say one too tall, goes as a document instead, so it still arrives", async () => {
  api = botApi();
  const bot = new TelegramAdapter("B1", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: () => {} });
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-tall-"));
  try {
    writeFileSync(join(dir, "page.png"), PNG);
    api.next.push({ method: "sendPhoto", how: "dimensions" });
    const r = await bot.send(String(ME), { text: "the page", file: { kind: "image", path: join(dir, "page.png"), name: "page.png" } });
    expect(r.status).toBe("sent");
    expect(api.uploads).toEqual([{ method: "sendDocument", chat_id: String(ME), caption: "the page", name: "page.png", data: new Uint8Array(PNG) }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a copy button goes as an inline button that copies its text, beside the callback ones", async () => {
  api = botApi();
  const bot = new TelegramAdapter("B1", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: () => {} });
  const buttons = [{ label: "复制", data: "帮我看下测试", copy: true as const }, { label: "允许", data: "ask:A1:1" }];
  expect((await bot.send(String(ME), { text: "崩溃了", buttons })).status).toBe("sent");
  const [sent] = api.calls.filter((c) => c.body.reply_markup);
  expect(sent!.body.reply_markup).toEqual({ inline_keyboard: [[{ text: "复制", copy_text: { text: "帮我看下测试" } }], [{ text: "允许", callback_data: "ask:A1:1" }]] });
});

test("story 330: setRow sends your chat one short message with a reply keyboard: the four commands in one row, persistent and resized, no inline buttons", async () => {
  api = botApi();
  const bot = new TelegramAdapter("B1", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: () => {} });
  await bot.setRow(TELEGRAM_ROW, String(ME));
  expect(api.rows).toEqual([{
    chat_id: String(ME),
    text: "常用按钮放在输入框下面了。",
    reply_markup: { keyboard: [["/rh_ls", "/rh_use", "/rh_tui", "/rh_help"].map((text) => ({ text }))], is_persistent: true, resize_keyboard: true },
  }]);
  expect(api.calls).toEqual([]);
});

test("a menu goes through though one description is longer than the 256 characters Telegram takes: that one is cut short", async () => {
  api = botApi();
  const bot = new TelegramAdapter("B1", "t", { platform: "telegram", token: TOKEN, apiRoot: api.url }, { log: () => {} });
  await bot.setMenu([{ command: "/long", description: "x".repeat(300) }, { command: "/short", description: "short" }]);
  const [push] = api.calls.filter((c) => c.method === "setMyCommands");
  expect(push!.body.commands).toEqual([
    { command: "long", description: `${"x".repeat(255)}…` },
    { command: "short", description: "short" },
  ]);
});
