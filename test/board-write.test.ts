// Writing from the board (spec web-write, its first ticket): what the board's own page sends to
// POST /api/act goes to the router as a board input, yours, as at a terminal; its result comes back to
// the page alone. Seen from seam one, through the board's HTTP.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { asking } from "./fake-agent/scripts";
import { BOARD_LOGIN, boardAct, newInstance, until } from "./instance";

const ME = "you-openid";
// Bot q sends your private chat to w/ask, whose claude asks to run a command; bot r to w/run, whose
// pi works until stopped. w/a is for rh commands.
const rhodium = newInstance({
  bots: { q: { like: "qq", owner: ME, target: "w/ask" }, r: { like: "qq", owner: ME, target: "w/run" } },
  claude: { script: asking([["ask-1", "Bash", { command: "make" }]]) },
  pi: { script: "pi-until-interrupted" },
});
let base = "";
beforeAll(async () => {
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("ask", "a");
  await rhodium.ok("new", "w/run", "--agent", "pi");
});
afterAll(() => rhodium.cleanup());

type Reply = { ok: true; text: string } | { ok: false; error: string };
/** What rhodium answers the act, sent with id. */
async function act(a: unknown, id?: string): Promise<Reply> {
  const r = await boardAct(base, a, id);
  expect(r.status).toBe(200);
  return (await r.json()) as Reply;
}
const slotId = async (name: string): Promise<string> => {
  const r = await fetch(`${base}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
  const w = ((await r.json()) as { workspaces: { name: string; groups: Record<string, { id: string; name: string }[]> }[] }).workspaces.find((w) => w.name === "w")!;
  return Object.values(w.groups).flat().find((c) => c.name === name)!.id;
};
type Ev = { type: string; source: string; trace: string | null; slot: string | null };
/** The events after seq, as the event stream gives them. */
async function eventsAfter(seq: number): Promise<Ev[]> {
  const ac = new AbortController();
  const r = await fetch(`${base}/api/events`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "Last-Event-ID": String(seq) }, signal: ac.signal });
  const seen: Ev[] = [];
  const reading = (async () => {
    try {
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
        for (const m of chunk.matchAll(/^data: (\{.*\})$/gm)) seen.push(JSON.parse(m[1]!));
      }
    } catch {
      // aborted
    }
  })();
  await Bun.sleep(300);
  ac.abort();
  await reading;
  return seen;
}
const texts = async (bot: string) => (await rhodium.im.log(bot, ME)).map((p) => p.text);

test("stories 255, 259, 264: the board's stop ends the turn under way, as /stop does, its agent kept; the result is the board's alone, and on the event stream under the board's name", async () => {
  await rhodium.im.inject("r", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/run")) === "运行中", 15_000);
  const run = await slotId("run");
  const before = (await eventsAfter(0)).at(-1) as Ev & { seq: number };

  const id = crypto.randomUUID();
  expect(await act({ kind: "common", slot: run, name: "stop" }, id)).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
  await until(async () => (await rhodium.state("w/run")) === "空闲", 15_000);
  // Another tab hears of it as of any change, by the request's id.
  const seen = await eventsAfter(before.seq);
  expect(seen.find((e) => e.type === "board_act")).toMatchObject({ source: "board", trace: id, slot: run });
  expect(await texts("r")).not.toContainEqual(expect.stringContaining("已停下"));
}, 30_000);

test("story 264: the stop works while an ask waits on you too: it is no answer to the ask", async () => {
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "go" });
  await until(async () => (await rhodium.state("w/ask")) === "需要你", 15_000);
  expect(await act({ kind: "common", slot: await slotId("ask"), name: "stop" })).toEqual({ ok: true, text: "已停下这一回合，对话留着。" });
  expect(await texts("q")).not.toContainEqual(expect.stringContaining("已停下"));
}, 30_000);

test("story 255: an rh command from the board runs as yours, as at a terminal; not the emergency stop, nor one the board has no use for", async () => {
  expect(await act({ kind: "rh", argv: ["rename", "w/a", "b"] })).toEqual({ ok: true, text: "已把 w/a 改名为 w/b。" });
  expect(await rhodium.ok("ls")).toContain("w/b ");
  for (const argv of [["stop", "--all"], ["stop"], ["ls"], ["send", "w/b", "hi"], ["use", "q/x", "w/b"]]) {
    const r = await act({ kind: "rh", argv });
    expect([argv, r.ok]).toEqual([argv, false]);
  }
  // rh stop <slot> stops its process; the conversation stays.
  expect(await act({ kind: "rh", argv: ["stop", "w/run"] })).toEqual({ ok: true, text: "正在停止 w/run，对话保留。" });
  await until(async () => (await rhodium.state("w/run")) === "未运行", 15_000);
}, 30_000);

test("story 262: a reply from the board names the next step on the board, never a command to type", async () => {
  const refused = await act({ kind: "rh", argv: ["archive", "w/run"] });
  expect(refused).toEqual({ ok: false, error: "w/run 是 假 IM Bot r 的默认目标，先在拓扑图上给 假 IM Bot r 换一个默认目标，再归档。" });
  expect(await act({ kind: "rh", argv: ["archive", "w/b"] })).toMatchObject({ ok: true, text: "已归档 w/b，对话保留。" });
});

test("story 257: an act sent again with the same id, as the page does when the network dropped its answer, is done once; one refused is refused again", async () => {
  const id = crypto.randomUUID();
  const ws = { kind: "rh", argv: ["ws", "w2", rhodium.dir] };
  expect(await act(ws, id)).toEqual({ ok: true, text: `已建工作区 w2，默认目录 ${rhodium.dir}` });
  expect(await act(ws, id)).toEqual({ ok: true, text: "已经做过了。" });
  expect((await act(ws)).ok).toBe(false); // a new id: it is done again, and refused as w2 is there

  const ls = crypto.randomUUID();
  const first = await act({ kind: "rh", argv: ["ls"] }, ls);
  expect(first.ok).toBe(false);
  expect(await act({ kind: "rh", argv: ["ls"] }, ls)).toEqual(first);
});
