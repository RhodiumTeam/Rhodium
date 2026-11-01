// The bar's agent and model buttons from the board (spec web-write, its sixth ticket): what the model
// button says comes with the slot, and the timeline's 回到这段 goes back to a conversation by its id.
// Seen from seam one, through the board's HTTP.
import { afterEach, expect, test } from "bun:test";
import { BOARD_LOGIN, boardAct, newInstance, until, type Instance } from "./instance";

const ME = "you-openid";
let rhodium: Instance;
let base = "";
afterEach(() => rhodium.cleanup());

async function begin(): Promise<string> {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
  const w = (await get("/api/board")).workspaces.find((w: any) => w.name === "w");
  return Object.values(w.groups as Record<string, { id: string; name: string }[]>).flat().find((c) => c.name === "a")!.id;
}
const get = async (path: string) => (await fetch(base + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<any>;
const say = async (slot: string, text: string) => (await boardAct(base, { kind: "say", slot, text })).json() as Promise<any>;

test("story 304: the slot says the model and thinking level it keeps, for the model button", async () => {
  const slot = await begin();
  expect(await get(`/api/slot?id=${slot}`)).toMatchObject({ model: null, effort: null });
  await say(slot, "hello");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  expect(await say(slot, "/model haiku low")).toMatchObject({ ok: true });
  expect(await get(`/api/slot?id=${slot}`)).toMatchObject({ model: "Haiku", effort: "low" });
}, 30_000);

test("story 306: 回到这段 goes back to a conversation by its id on the timeline, said on the page alone", async () => {
  const slot = await begin();
  await say(slot, "first");
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  const [first] = (await get(`/api/slot?id=${slot}`)).timeline;
  await say(slot, "/new");
  expect((await get(`/api/slot?id=${slot}`)).timeline.find((c: any) => c.id === first.id).current).toBe(false);
  expect(await say(slot, `/resume ${first.id}`)).toMatchObject({ ok: true, text: expect.stringMatching(/^已回到今天 \d\d:\d\d 那段对话。/) });
  expect((await get(`/api/slot?id=${slot}`)).timeline.find((c: any) => c.id === first.id).current).toBe(true);
  expect(await rhodium.im.log("q", ME)).toEqual([]);
}, 30_000);
