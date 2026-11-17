// Pairing and owners on the board (spec web-bots, its third ticket; architecture §8.5.1): the board's
// rh pair --add, --list and --rm, the owners a bot has by GET /api/bots/owners, and the pairing seen on
// the event stream. No platform account reaches the page (architecture §11). Seen from seam one.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { BOARD_LOGIN, boardAct, newInstance, until } from "./instance";

const A = "owner-in-config-1234"; // the config's owner, who never wrote
const B = "owner-paired-5678"; // an account of yours paired from the board
const rhodium = newInstance({ bots: { q: { like: "qq", owner: A, target: "w/a" } } });
let base = "";
let bot = "";
beforeAll(async () => {
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  const topo = (await (await fetch(`${base}/api/topology`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as { bots: { id: string }[] };
  bot = topo.bots[0]!.id;
});
afterAll(() => rhodium.cleanup());

type Reply = { ok: true; text: string } | { ok: false; error: string };
const act = async (...argv: string[]): Promise<Reply> => (await (await boardAct(base, { kind: "rh", argv })).json()) as Reply;
type Owner = { id: string; fixed: boolean; chat: string | null; name: string | null; avatar: string | null };
const ownersOf = (b: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) =>
  fetch(`${base}/api/bots/owners?bot=${b}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, ...headers } });
const list = async (): Promise<{ text: string; owners: Owner[] }> => {
  const r = await ownersOf(bot);
  expect(r.status).toBe(200);
  const text = await r.text();
  return { text, owners: (JSON.parse(text) as { owners: Owner[] }).owners };
};
/** The events after seq on the event stream, read for a moment. */
async function eventsAfter(seq: number): Promise<{ seq: number; type: string; data: unknown }[]> {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "Last-Event-ID": String(seq) }, signal: ac.signal });
  const seen: { seq: number; type: string; data: unknown }[] = [];
  const reading = (async () => {
    try {
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) for (const m of chunk.matchAll(/^data: (\{.*\})$/gm)) seen.push(JSON.parse(m[1]!));
    } catch {
      // aborted
    }
  })();
  await Bun.sleep(300);
  ac.abort();
  await reading;
  return seen;
}

test("stories 678, 682: the board's rh pair --add, by the bot's id, puts the code in its reply; sent in IM, it pairs, and the page hears bot_paired with the bot's id", async () => {
  const before = (await eventsAfter(0)).at(-1)!.seq;
  const r = await act("pair", bot, "--add");
  expect(r.ok).toBe(true);
  const code = /配对码：(\S+)/.exec((r as { text: string }).text)![1]!;
  await rhodium.im.inject("q", { chat: B, sender: B, text: code });
  await until(async () => (await rhodium.im.log("q", B)).some((p) => p.text.startsWith("已配对")), 15_000);
  const seen = await eventsAfter(before);
  expect(seen.find((e) => e.type === "bot_paired")?.data).toEqual({ bot: "q", id: bot });
  // The code's end, for the page's countdown, by the bot's id too; never the code.
  expect(seen.find((e) => e.type === "pair_code")?.data).toEqual({ bot: "q", id: bot, until: expect.any(Number) });
}, 30_000);

test("story 683: the owners list gives a code for each, the config's marked, a private chat's id where there is one, and no account", async () => {
  const { text, owners } = await list();
  expect(text).not.toContain(A);
  expect(text).not.toContain(B);
  expect(owners.map((o) => [o.fixed, o.chat === null])).toEqual([
    [true, true],
    [false, false],
  ]);
  for (const o of owners) expect(o.id).toMatch(/^[0-9a-f]{8}$/);
  // rh pair --list from the board names them by the same codes.
  const listed = await act("pair", bot, "--list");
  expect(listed).toEqual({ ok: true, text: `Bot q 的主人：\n${owners[0]!.id}（配置）\n${owners[1]!.id}：私聊交给 w/a` });
});

test("story 683: the board takes a paired owner off by its code; not the config's, nor a code no owner has, and no account in what it says", async () => {
  const [fixed, pairedOne] = (await list()).owners;
  const refused = await act("pair", bot, "--rm", fixed!.id);
  expect(refused).toEqual({ ok: false, error: `${fixed!.id} 是 Bot q 配置里写的主人，以配置为准。要去掉，改配置文件里的 owner。` });
  expect(await act("pair", bot, "--rm", "00000000")).toEqual({ ok: false, error: "00000000 不是 Bot q 的主人。" });
  expect(await act("pair", bot, "--rm", pairedOne!.id)).toEqual({ ok: true, text: "已去掉假 IM Bot 的一个主人。" });
  expect((await list()).owners.map((o) => o.id)).toEqual([fixed!.id]);
  expect(await rhodium.ok("pair", "q", "--list")).toBe(`Bot q 的主人：\n${A}（配置）\n`);
});

test("story 683: the board pairs only beside the owners, never in place of them", async () => {
  // The config's owner would refuse a plain rh pair anyway; the board's own refusal must come first.
  const refused: Reply = { ok: false, error: "看板只做 rh pair 的 --add、--list、--rm。" };
  expect(await act("pair", bot)).toEqual(refused);
  expect(await act("pair", "q")).toEqual(refused);
});

test("architecture §11: the owners list answers the board's own page alone, and a bot it has", async () => {
  expect((await ownersOf(bot, {})).status).toBe(403);
  expect((await ownersOf(bot, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await ownersOf("nope")).status).toBe(404);
});
