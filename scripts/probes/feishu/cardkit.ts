// CardKit card entities on the dev app (#783, docs/spec/feishu.md "改卡片"): what streaming, folding
// and replacing a card do, and what Feishu answers. Each mode sends you, the dev app's owner, cards
// in your private chat with it; watch them on a phone.
//
// Usage: bun scripts/probes/feishu/cardkit.ts <mode>
// - stream: text typed out as it grows; a second element changed alone; a change that is not a prefix;
//   15 changes in a row; a sequence out of order (300317); im PATCH on an entity's message; streaming
//   closed, then text (300309), a whole-card PUT that takes the button off, streaming opened again.
// - ten: streaming left open 10.5 minutes, then text (200850 on 2026-11-17), opened again, then a PUT.
// - burst: 20 changes to one card at once (half turned down, 200400 or 300317, on 2026-11-17).
// - fold: a tool part shown as lines, then shrunk to one, swapped for a folded panel, a panel added
//   open and folded, an element added and deleted; with streaming on, then with it closed.
// - combo: what Rhodium does: text typed out, a tool part an open panel that grows a line at a time
//   and is folded, titled by its tools, once the agent speaks.
//
// Credentials: ~/.config/rhodium-dev/feishu-dev.json (appId, appSecret, ownerOpenId), as probe.ts
// writes it. Out: /tmp/rhodium-test-feishu-probe/cardkit.jsonl, each call's step, HTTP status, code,
// message and time, appended run after run; no credentials, ids or contents.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";

const D = "https://open.feishu.cn";
const OUT = "/tmp/rhodium-test-feishu-probe";
const cred = JSON.parse(readFileSync(`${process.env.HOME}/.config/rhodium-dev/feishu-dev.json`, "utf8")) as { appId: string; appSecret: string; ownerOpenId: string };
mkdirSync(OUT, { recursive: true });
const log = (o: object) => {
  appendFileSync(`${OUT}/cardkit.jsonl`, `${JSON.stringify({ t: new Date().toISOString(), ...o })}\n`);
  console.log(JSON.stringify(o));
};
const token = (await (await fetch(`${D}/open-apis/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: cred.appId, app_secret: cred.appSecret }) })).json()) as { tenant_access_token: string };
const headers = { authorization: `Bearer ${token.tenant_access_token}`, "content-type": "application/json; charset=utf-8" };
const sleep = (ms: number) => Bun.sleep(ms);

let calls = 0;
async function call(step: string, method: string, path: string, body?: object): Promise<any> {
  calls++;
  const t0 = performance.now();
  const r = await fetch(`${D}${path}`, { method, headers, body: body && JSON.stringify(body) });
  const j: any = await r.json().catch(() => ({}));
  log({ step, http: r.status, code: j.code, msg: j.msg, ms: Math.round(performance.now() - t0) });
  return j;
}

let seq = 0;
const CK = "/open-apis/cardkit/v1/cards";
/** A card entity made from the card JSON, and sent to you; gives its id and the message's. */
async function made(card: object): Promise<{ id: string; msg: string }> {
  const id = (await call("create", "POST", CK, { type: "card_json", data: JSON.stringify(card) })).data?.card_id as string;
  const content = JSON.stringify({ type: "card", data: { card_id: id } });
  const msg = (await call("send", "POST", "/open-apis/im/v1/messages?receive_id_type=open_id", { receive_id: cred.ownerOpenId, msg_type: "interactive", content })).data?.message_id as string;
  return { id, msg };
}
const text = (id: string, el: string, content: string, step = "content", sequence = ++seq) => call(step, "PUT", `${CK}/${id}/elements/${el}/content`, { content, sequence });
const streaming = (id: string, on: boolean, step = "settings") => call(step, "PATCH", `${CK}/${id}/settings`, { settings: JSON.stringify({ config: { streaming_mode: on } }), sequence: ++seq });
const typing = (ms: number, step: number) => ({ print_frequency_ms: { default: ms }, print_step: { default: step }, print_strategy: "fast" });
const words = (s: string) => [...s];

/** stream and ten's card: its text, a second element, and a button. */
const card = (body: string, button: boolean, on: boolean) => ({
  schema: "2.0",
  config: { update_multi: true, streaming_mode: on, summary: { content: "" }, streaming_config: typing(30, 2) },
  body: {
    elements: [
      { tag: "markdown", element_id: "body", content: body },
      { tag: "markdown", element_id: "run", content: "" },
      ...(button ? [{ tag: "button", element_id: "btn", text: { tag: "plain_text", content: "测试按钮" }, behaviors: [{ type: "callback", value: { d: "probe" } }] }] : []),
    ],
  },
});
const replace = (id: string, body: string, button: boolean, on: boolean, step = "full") => call(step, "PUT", `${CK}/${id}`, { card: { type: "card_json", data: JSON.stringify(card(body, button, on)) }, sequence: ++seq });

async function stream() {
  let body = "**[1/6] 流式打字机**（每 300ms 一次，前缀延伸）\n\n";
  const { id, msg } = await made(card(body, true, true));
  const say = words("探针：这是一段模拟 agent 逐字输出的文字，用来看飞书卡片实体流式更新的打字机效果。每次传的是累积的全量文本，新文本以旧文本为前缀。");
  for (let i = 0; i < say.length; i += 3) {
    body += say.slice(i, i + 3).join("");
    await text(id, "body", body, "stream");
    await sleep(300);
  }
  await text(id, "run", "⏳ 正在运行 Bash（第二个元素）", "run-line");
  await sleep(2000);
  await text(id, "body", `**[2/6] 非前缀替换**：整段换掉，应无打字机\n\n${body.slice(30)}`, "nonprefix");
  await sleep(2000);
  for (let i = 0; i < 15; i++) await text(id, "body", `${body}\n\n[3/6] 连发 ${i + 1}/15`, "burst");
  await sleep(1500);
  await text(id, "body", body, "seq-old", 1);
  await call("im-patch", "PATCH", `/open-apis/im/v1/messages/${msg}`, { content: JSON.stringify(card("[4/6] 这是 im PATCH 改的", false, false)) });
  await sleep(1500);
  await streaming(id, false, "close");
  await text(id, "body", `${body}\n\n[5/6] 关流后再改`, "after-close");
  await replace(id, `${body}\n\n**[5/6] 全量 PUT**：按钮应已撤掉，流已关`, false, false, "full-nobutton");
  await sleep(1500);
  await streaming(id, true, "reopen");
  await text(id, "body", `${body}\n\n[6/6] 重开流后再改：打字机应恢复`, "after-reopen");
  await streaming(id, false, "final-close");
}

async function ten() {
  const head = "**[10 分钟]** 开流后放着不动，10 分 30 秒后再改一次\n\n";
  const { id } = await made(card(head, false, true));
  await text(id, "body", `${head}已开流，等待中……`, "ten-start");
  await sleep(630_000);
  const r = await text(id, "body", "**[10 分钟]** 10 分 30 秒后的改动", "ten-after");
  if (r.code !== 0) {
    await streaming(id, true, "ten-reopen");
    await text(id, "body", "**[10 分钟]** 重开流后的改动", "ten-after-reopen");
  }
  await replace(id, "**[10 分钟]** 全量 PUT 收尾", false, false, "ten-full");
}

async function burst() {
  const { id } = await made({ schema: "2.0", config: { update_multi: true, streaming_mode: true }, body: { elements: [{ tag: "markdown", element_id: "body", content: "**[并发]** 20 个请求同时发" }] } });
  // Sequences 1 to 20, sent all at once.
  await Promise.all(Array.from({ length: 20 }, (_, i) => text(id, "body", `**[并发]** 20 个请求同时发 ${"▮".repeat(i + 1)}`, `burst-${i + 1}`, i + 1)));
  seq = 100;
  await streaming(id, false, "close");
}

const TOOLS = ["🔧 Bash `bun test test/feishu.test.ts`", "🔧 Read `src/feishu.ts`", "🔧 Edit `src/daemon.ts`"];
const lines = (n: number) => TOOLS.slice(0, n).join("\n");
const panel = (el: string, title: string, content: string, expanded: boolean, body?: string) => ({
  tag: "collapsible_panel",
  element_id: el,
  expanded,
  header: { title: { tag: "markdown", content: title } },
  border: { color: "grey" },
  elements: [{ tag: "markdown", ...(body && { element_id: body }), content }],
});

async function fold() {
  for (const on of [true, false]) {
    const tag = on ? "on" : "off";
    const empty = (el: string) => ({ tag: "markdown", element_id: el, content: "" });
    const head = { tag: "markdown", element_id: "head", content: `**[折叠探针，流式${on ? "开着" : "关掉后"}]**` };
    const { id } = await made({ schema: "2.0", config: { update_multi: true, streaming_mode: true, summary: { content: "" } }, body: { elements: [head, empty("t1"), empty("say1"), empty("t2"), empty("say2")] } });
    for (let n = 1; n <= 3; n++) {
      await text(id, "t1", lines(n), `${tag}-t1-grow`);
      await sleep(700);
    }
    if (!on) await streaming(id, false, `${tag}-close`);
    // A: the lines shrunk to one, in place.
    await text(id, "t1", "🔧 Bash ×1，Read ×1，Edit ×1（A：原地缩成一行）", `${tag}-A-shrink`);
    await sleep(700);
    await text(id, "say1", "第一段话：工具段结束，开始说话。", `${tag}-say1`);
    for (let n = 1; n <= 3; n++) {
      await text(id, "t2", lines(n), `${tag}-t2-grow`);
      await sleep(700);
    }
    // B: the lines swapped for a folded panel.
    await call(`${tag}-B-panel`, "PUT", `${CK}/${id}/elements/t2`, { element: JSON.stringify(panel("t2", "🔧 工具 ×3", lines(3), false)), sequence: ++seq });
    await sleep(700);
    await text(id, "say2", "第二段话：上面的工具段应已收进折叠面板（B）。", `${tag}-say2`);
    // C: a panel added open, then folded.
    await call(`${tag}-C-add-open`, "POST", `${CK}/${id}/elements`, { type: "append", elements: JSON.stringify([panel("t3", "🔧 工具 ×2", lines(2), true)]), sequence: ++seq });
    await sleep(1500);
    await call(`${tag}-C-fold`, "PATCH", `${CK}/${id}/elements/t3`, { partial_element: JSON.stringify({ expanded: false }), sequence: ++seq });
    // D: an element added, then deleted.
    await call(`${tag}-D-add`, "POST", `${CK}/${id}/elements`, { type: "append", elements: JSON.stringify([{ tag: "markdown", element_id: "gone", content: "这一行（D）随后会被删掉" }]), sequence: ++seq });
    await sleep(1500);
    await call(`${tag}-D-delete`, "DELETE", `${CK}/${id}/elements/gone`, { sequence: ++seq });
    if (on) await streaming(id, false, `${tag}-close-end`);
  }
}

async function combo() {
  const TOOL_PARTS = [TOOLS, ["🔧 Grep `editEvery`", "🔧 Bash `git diff --stat`"]];
  const SAY = ["测试都过了。我改了 daemon 里的编辑队列，让最后一次编辑把 final 带给适配器，这样飞书收尾时能关掉流式模式。", "改动一共三个文件，下面是总结：队列结构没变，只多传了一个字段；飞书和 Telegram 两边各自决定怎么用它。"];
  const head = { tag: "markdown", element_id: "head", content: "**[逐字 + 折叠]** 工具段运行中展开，结束收起；正文逐字" };
  const { id } = await made({ schema: "2.0", config: { update_multi: true, streaming_mode: true, summary: { content: "" }, streaming_config: typing(120, 1) }, body: { elements: [head] } });
  for (const [s, tools] of TOOL_PARTS.entries()) {
    const p = `p${s}`;
    await call(`${p}-add`, "POST", `${CK}/${id}/elements`, { type: "append", elements: JSON.stringify([panel(p, "🔧 工具 ×1（运行中）", "", true, `${p}body`)]), sequence: ++seq });
    for (let k = 1; k <= tools.length; k++) {
      if (k > 1) await call(`${p}-title`, "PATCH", `${CK}/${id}/elements/${p}`, { partial_element: JSON.stringify({ header: { title: { tag: "markdown", content: `🔧 工具 ×${k}（运行中）` } } }), sequence: ++seq });
      await text(id, `${p}body`, tools.slice(0, k).join("\n"), `${p}-line`);
      await sleep(2000);
    }
    const title = `🔧 ${tools.map((l) => `${l.split(" ")[1]} ×1`).join("，")}`;
    await call(`${p}-fold`, "PATCH", `${CK}/${id}/elements/${p}`, { partial_element: JSON.stringify({ expanded: false, header: { title: { tag: "markdown", content: title } } }), sequence: ++seq });
    await call(`say${s}-add`, "POST", `${CK}/${id}/elements`, { type: "append", elements: JSON.stringify([{ tag: "markdown", element_id: `say${s}`, content: "" }]), sequence: ++seq });
    const say = words(SAY[s]!);
    let shown = "";
    // 3 characters every 400 ms, typed out a character every 120 ms.
    for (let i = 0; i < say.length; i += 3) {
      shown += say.slice(i, i + 3).join("");
      await text(id, `say${s}`, shown, `say${s}-stream`);
      await sleep(400);
    }
    await sleep(1000);
  }
  await streaming(id, false, "close");
}

const modes: Record<string, () => Promise<void>> = { stream, ten, burst, fold, combo };
const mode = modes[process.argv[2] ?? ""];
if (!mode) {
  console.error(`usage: bun scripts/probes/feishu/cardkit.ts ${Object.keys(modes).join("|")}`);
  process.exit(2);
}
await mode();
log({ step: "done", mode: process.argv[2], calls });
