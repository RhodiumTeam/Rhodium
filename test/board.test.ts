// The read-only board (seam one, product §7, architecture §11): its JSON and event stream over
// HTTP, with and without your Tailscale login in the header tailscale serve adds.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync } from "node:zlib";
import { serveBoard, type BoardData } from "../src/board";
import { loadConfig } from "../src/config";
import { openStore, type Slot, type Store } from "../src/store";
import { call, installFakeHerdr, startFakeHerdr } from "./fake-herdr/fake-herdr";
import { asking, PROGRESS_PIECES } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until, type Daemon, type Instance } from "./instance";

const ME = "you-openid";
const GROUP = "-100999"; // a group of r's, the main chat
// Bot q sends your private chat to w/ask, whose claude asks to run a command; bot r to w/run,
// whose pi works until stopped. w/idle never runs. A request quiet for 1 s may be dropped, which Bun
// checks every 4 s.
const rhodium = newInstance({
  bots: { q: { like: "qq", owner: ME, target: "w/ask" }, r: { like: "qq", owner: ME, target: "w/run" } },
  claude: { script: asking([["ask-1", "Bash", { command: "make" }]]) },
  pi: { script: "pi-until-interrupted" },
  toml: `mainChat = "r/${GROUP}"\n[durations]\nboardIdle = "1s"`,
});
let base = "";
let daemon: Daemon;
beforeAll(async () => {
  const d = (daemon = await rhodium.start());
  base = `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("ask", "idle");
  await rhodium.ok("new", "w/run", "--agent", "pi");
});
afterAll(() => rhodium.cleanup());

/** at: another instance's board. */
const get = (path: string, login: string | null = BOARD_LOGIN, headers: Record<string, string> = {}, signal?: AbortSignal, at = base) =>
  fetch(at + path, { headers: { ...(login !== null && { "Tailscale-User-Login": login }), ...headers }, signal });

type Card = { id: string; ref: string; name: string; agent: string; state: string; turnEndedAt: number | null; last: { role: string; text: string; at: number | null; source?: string } | null; bots: string[] };
type Group = "needsYou" | "running" | "done" | "idle";
type Board = { workspaces: { name: string; groups: Record<Group, Card[]>; archived: Card[] }[]; bots: { id: string; name: string; platform: string; avatar: string | null }[] };

async function board(): Promise<Board> {
  const r = await get("/api/board");
  expect(r.status).toBe(200);
  return (await r.json()) as Board;
}
/** Workspace w's slot names, by group, archived last. */
async function groups(): Promise<Record<Group | "archived", string[]>> {
  const w = (await board()).workspaces.find((w) => w.name === "w")!;
  const names = (cards: Card[]) => cards.map((c) => c.name);
  const g = w.groups;
  return { needsYou: names(g.needsYou), running: names(g.running), done: names(g.done), idle: names(g.idle), archived: names(w.archived) };
}
const card = async (name: string) => {
  const w = (await board()).workspaces.find((w) => w.name === "w")!;
  return [...Object.values(w.groups).flat(), ...w.archived].find((c) => c.name === name)!;
};

type Ev = { seq: number; type: string; slot: string | null; data: any };
/** The board's event stream, following slot's transcript if given, read into seen as it comes; told
 *  has what it said that is not in the event table, by its event name, and grew counts the times it
 *  said the transcript grew; pages, the page it said it serves, as it opens. at: another instance's board. */
async function stream(lastId?: number, slot?: string, at = base) {
  const ac = new AbortController();
  const r = await get(slot ? `/api/events?slot=${slot}` : "/api/events", BOARD_LOGIN, lastId === undefined ? {} : { "Last-Event-ID": String(lastId) }, ac.signal, at);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toStartWith("text/event-stream");
  const seen: Ev[] = [];
  const told: [string, unknown][] = [];
  const pages: unknown[] = [];
  const reading = (async () => {
    let buf = "";
    try {
      for await (const chunk of r.body!.pipeThrough(new TextDecoderStream())) {
        buf += chunk;
        for (let i = buf.indexOf("\n\n"); i >= 0; i = buf.indexOf("\n\n")) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.match(/^data: (.*)$/m)?.[1];
          if (!data) continue; // a heartbeat comment
          const name = block.match(/^event: (.*)$/m)?.[1];
          if (name) {
            expect(block).not.toMatch(/^id:/m); // not in the event table
            if (name === "page") pages.push(JSON.parse(data));
            else told.push([name, JSON.parse(data)]);
            continue;
          }
          const e = JSON.parse(data) as Ev;
          expect(block).toMatch(new RegExp(`^id: ${e.seq}$`, "m"));
          seen.push(e);
        }
      }
    } catch {
      // aborted
    }
  })();
  return {
    seen,
    told,
    pages,
    get grew() {
      return told.filter(([name]) => name === "grew").length;
    },
    close: () => (ac.abort(), reading),
  };
}

const say = (bot: string, text: string) => rhodium.im.inject(bot, { chat: ME, sender: ME, text });

test("story 137: without your Tailscale login in the header, or with someone else's, every path is refused", async () => {
  for (const path of ["/", "/api/board", "/api/events", "/api/ping", "/manifest.webmanifest", "/icon-192.png"]) {
    for (const login of [null, "someone@example.com", ""]) {
      const r = await get(path, login);
      expect({ path, login, status: r.status }).toEqual({ path, login, status: 403 });
    }
  }
  expect((await get("/api/board")).status).toBe(200);
  // #286: what the page times the round trip by: nothing, at once.
  expect((await get("/api/ping")).status).toBe(204);
});

test("stories 139, 140: slots in four groups, and each change of state comes down the event stream", async () => {
  const events = await stream();
  expect(await groups()).toEqual({ needsYou: [], running: [], done: [], idle: ["ask", "idle", "run"], archived: [] });
  const ask = (await card("ask")).id;

  await say("q", "go");
  await until(async () => (await groups()).needsYou.includes("ask"), 15_000);
  await until(() => events.seen.some((e) => e.type === "slot_state" && e.slot === ask && e.data.state === "waiting"), 5_000);
  expect((await card("ask")).state).toBe("需要你");

  await say("r", "work");
  await until(async () => (await groups()).running.includes("run"), 15_000);
  expect((await card("run")).agent).toBe("pi");

  await say("q", "1"); // allow: the turn goes on to its end
  await until(async () => (await groups()).done.includes("ask"), 15_000);
  await until(() => events.seen.some((e) => e.type === "slot_state" && e.slot === ask && e.data.state === "idle"), 5_000);
  expect((await card("ask")).turnEndedAt).toBeNumber();
  expect(await groups()).toEqual({ needsYou: [], running: ["run"], done: ["ask"], idle: ["idle"], archived: [] });
  await events.close();
}, 40_000);

test("story 140: a stream reconnecting with Last-Event-ID gets every event it missed, in order", async () => {
  const first = await stream();
  await rhodium.ok("new", "w/sse1");
  await until(() => first.seen.some((e) => e.type === "slot_created" && e.data.ref === "w/sse1"));
  await first.close();
  const last = first.seen.at(-1)!.seq;

  await rhodium.ok("new", "w/sse2");
  await rhodium.ok("archive", "w/sse2");
  const again = await stream(last);
  await until(() => again.seen.some((e) => e.type === "slot_archived"));
  await again.close();
  expect(again.seen[0]!.seq).toBe(last + 1);
  expect(again.seen.map((e) => e.seq)).toEqual(again.seen.map((_, i) => last + 1 + i));
  // w/run's pi, still starting from the test before, may tell of itself in between (#575).
  const sse2 = again.seen.find((e) => e.type === "slot_created")!.slot;
  expect(again.seen.filter((e) => e.slot === sse2).map((e) => e.type)).toEqual(["slot_created", "slot_archived"]);
});

test("story 140: a stream quiet for longer than Bun's idle timeout stays open", async () => {
  const quiet = await stream();
  await Bun.sleep(5_000);
  await rhodium.ok("new", "w/quiet");
  await until(() => quiet.seen.some((e) => e.type === "slot_created" && e.data.ref === "w/quiet"), 5_000);
  await quiet.close();
}, 25_000);

test("stories 23, 146: an archived slot leaves the four groups for the archived list; rh unarchive puts it back in its group", async () => {
  await rhodium.ok("archive", "w/idle");
  let g = await groups();
  expect(Object.values(g).slice(0, 4).flat()).not.toContain("idle");
  expect(g.archived).toContain("idle");

  await rhodium.ok("unarchive", "w/idle");
  g = await groups();
  expect(g.idle).toContain("idle");
  expect(g.archived).not.toContain("idle");
});

// The page's own files come gzipped too, as test/build.test.ts checks: run from source, there are none unbuilt.
test("the API comes gzipped to a browser that takes gzip, but not the event stream", async () => {
  const gzip = { "accept-encoding": "gzip" };
  const r = await get("/api/board", BOARD_LOGIN, gzip);
  expect({ encoding: r.headers.get("content-encoding"), vary: r.headers.get("vary") }).toEqual({ encoding: "gzip", vary: "accept-encoding" });
  expect((await get("/api/board", BOARD_LOGIN, { "accept-encoding": "identity" })).headers.get("content-encoding")).toBeNull();
  const ac = new AbortController();
  const events = await get("/api/events", BOARD_LOGIN, gzip, ac.signal);
  expect(events.headers.get("content-type")).toStartWith("text/event-stream");
  expect(events.headers.get("content-encoding")).toBeNull();
  ac.abort();
});

/** A board of its own on an empty store, serving the page's files from web, which the test writes.
 *  Its herdr fails as Herdr does with no server, noting its arguments in ran (a file under dir); for
 *  pane w1:long, saying why in 181 bytes; for pane w1:gone, as Herdr does for a pane not there. */
async function withWeb(fn: (at: string, web: string, store: Store, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-web-"));
  const web = join(dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  const herdr = join(dir, "herdr");
  const long = "a" + "终".repeat(60);
  writeFileSync(herdr, `#!/bin/sh\necho "$@" >> ${dir}/ran\ncase "$*" in *w1:gone*) echo '{"type":"terminal.closed","reason":"terminal session control failed: terminal target w1:gone not found"}'; exit 0;; *w1:long*) echo "${long}" >&2; exit 1;; *w1:flood*) f=$(head -c 49152 /dev/zero | base64 -w0); for i in $(seq 1000); do echo "{\\"type\\":\\"terminal.frame\\",\\"bytes\\":\\"$f\\"}"; done; exec sleep 30;; esac\necho "herdr: failed to connect to server: No such file or directory (os error 2)" >&2\necho "Is herdr server running? Start it with \\\`herdr server\\\`." >&2\nexit 1\n`, { mode: 0o755 });
  writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[programs]\nherdr = "${herdr}"\n[herdr]\nsession = "rhodium-test-none"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, loadConfig(join(dir, "config.toml")), new Set(), web);
  try {
    await fn(`http://127.0.0.1:${server.port}`, web, store, dir);
  } finally {
    server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A picture w by h, PNG or JPEG; noisy: the share of its rows that are noise, which packs badly, for a
 *  file of some size. Drawn as a BMP, which Bun.Image reads. */
function picture(w: number, h: number, noisy: number, as: "png" | "jpeg"): Promise<Uint8Array> {
  const row = (w * 3 + 3) & ~3;
  const bmp = Buffer.alloc(54 + row * h);
  bmp.write("BM");
  [[2, bmp.length], [10, 54], [14, 40], [18, w], [22, -h]].forEach(([at, v]) => bmp.writeInt32LE(v!, at!));
  [[26, 1], [28, 24]].forEach(([at, v]) => bmp.writeUInt16LE(v!, at!));
  for (let y = 0; y < h * noisy; y++) crypto.getRandomValues(bmp.subarray(54 + y * row, 54 + y * row + w * 3));
  const image = new Bun.Image(bmp);
  return (as === "png" ? image.png() : image.jpeg()).bytes();
}
const sha = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

test("stories 564-566, spec web-images 安全: /api/media gives a kept file by its hash alone, to the board's own page alone; only a picture, by its first bytes, as one, anything else as a download; a preview and a viewing copy, each made once, never enlarged; 404 once it is gone", async () => {
  await withWeb(async (at, _web, _store, dir) => {
    const media = join(dir, "state/media");
    mkdirSync(media, { recursive: true });
    const keep = (data: Uint8Array | string) => (writeFileSync(join(media, sha(data)), data), sha(data));
    const answers: Response[] = [];
    const get = async (query: string, site: string | null = "same-origin") => {
      const r = await fetch(`${at}/api/media?${query}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, ...(site && { "Sec-Fetch-Site": site }) } });
      answers.push(r);
      return r;
    };
    /** An answer's type, and the width and height of the picture in it. */
    const seen = async (r: Response) => {
      const m = await new Bun.Image(await r.bytes()).metadata();
      return [r.headers.get("content-type"), m.width, m.height];
    };
    writeFileSync(join(dir, "state/secret"), "not yours");
    const small = keep(await picture(640, 480, 0, "png"));
    for (const h of ["", "x", small.toUpperCase(), small.slice(1), `../${small.slice(3)}`, "../secret", `${small.slice(0, 32)}/${small.slice(33)}`]) expect([h, (await get(`h=${encodeURIComponent(h)}`)).status]).toEqual([h, 400]);
    expect((await get(`h=${small}&v=thumb`)).status).toBe(400);
    expect((await get(`h=${small}`, "cross-site")).status).toBe(403);
    expect((await get(`h=${small}`, null)).status).toBe(403);

    const png = await get(`h=${small}`);
    expect([png.status, png.headers.get("content-type"), png.headers.get("cache-control")]).toEqual([200, "image/png", "private, max-age=31536000, immutable"]);
    for (const data of ["<!doctype html><script>fetch('/api/act')</script>", '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>']) {
      for (const v of ["", "&v=preview"]) {
        const r = await get(`h=${keep(data)}${v}`);
        expect([r.headers.get("content-type"), r.headers.get("content-disposition"), await r.text()]).toEqual(["application/octet-stream", "attachment", data]);
      }
    }

    // A preview, its long side 800, made the first time; a small one is the picture itself.
    const big = keep(await picture(4000, 3000, 0.25, "jpeg"));
    expect(await seen(await get(`h=${big}&v=preview`))).toEqual(["image/webp", 800, 600]);
    const preview = join(media, "preview", big);
    const first = statSync(preview).mtimeMs;
    await Bun.sleep(20);
    expect(await seen(await get(`h=${big}&v=preview`))).toEqual(["image/webp", 800, 600]);
    expect(statSync(preview).mtimeMs).toBe(first);
    expect(Buffer.from(await (await get(`h=${small}&v=preview`)).bytes()).equals(readFileSync(join(media, small)))).toBe(true);

    // The viewing copy: over 2576 px or 2 MB, a JPEG at most 2576 px; never enlarged; else the picture.
    expect(statSync(join(media, big)).size).toBeGreaterThan(2 << 20);
    expect(await seen(await get(`h=${big}&v=view`))).toEqual(["image/jpeg", 2576, 1932]);
    const heavy = keep(await picture(2000, 1500, 0.3, "png"));
    expect(statSync(join(media, heavy)).size).toBeGreaterThan(2 << 20);
    expect(await seen(await get(`h=${heavy}&v=view`))).toEqual(["image/jpeg", 2000, 1500]);
    const light = keep(await picture(1200, 900, 0.25, "png"));
    expect(statSync(join(media, light)).size).toBeLessThan(2 << 20);
    expect(Buffer.from(await (await get(`h=${light}&v=view`)).bytes()).equals(readFileSync(join(media, light)))).toBe(true);

    rmSync(join(media, small));
    expect((await get(`h=${small}`)).status).toBe(404);
    expect(answers.map((r) => r.headers.get("x-content-type-options"))).toEqual(answers.map(() => "nosniff"));
  });
}, 30_000);

test("stories 561, 562, 563, 567, 568: a page's blocks carry your pictures and file, what an rh send to you sent, and what a tool's result showed the agent, by hash with each picture's sides and a name to save it by, never a picture's data; the list's line says [图片]", async () => {
  await withWeb(async (at, _web, store, dir) => {
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      const media = join(dir, "state/media");
      mkdirSync(media, { recursive: true });
      const [shot, photo, notes] = [await picture(1080, 2400, 0, "png"), await picture(400, 300, 0, "jpeg"), "12 wicks\n"];
      for (const data of [shot, photo, notes]) writeFileSync(join(media, sha(data)), data);
      const slot = store.tx((tx) => {
        const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
        const id = tx.insert("slot", { workspace: ws, name: "pics", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
        tx.update("slot", { id }, { conversation: tx.insert("conversation", { slot: id, agent: "pi", sessionId: "s1", startedAt: Date.now() }).id });
        return id;
      });
      // The rh send's event, as rhodium wrote it while the call ran: once you approved it, minutes after
      // the call's line (product §4.8).
      store.tx((tx) => tx.append({ source: "rh", type: "send_me", slot, data: { files: [{ kind: "image", hash: sha(photo), name: "shot.png" }] } }));
      const sent = Date.now();
      const t = sent - 200_000;
      const line = (at: number, role: string, content: unknown[], more = {}) => JSON.stringify({ type: "message", timestamp: new Date(at).toISOString(), message: { role, content, ...more } }) + "\n";
      const bash = (at: number, id: string, command: string, took = 500, isError = false) => line(at, "assistant", [{ type: "toolCall", id, name: "bash", arguments: { command } }]) + line(at + took, "toolResult", [{ type: "text", text: "ok" }], { toolCallId: id, isError });
      // Text alone, by its event, with no data: sent, though the command failed after it; and one in a branch never run, none.
      setSystemTime(sent + 2200);
      store.tx((tx) => tx.append({ source: "rh", type: "send_me", slot }));
      setSystemTime();
      const data = Buffer.from(shot).toString("base64");
      const read = line(t + 100, "assistant", [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "/w/shot.png" } }]) + line(t + 200, "toolResult", [{ type: "text", text: "Read image file [image/png]" }, { type: "image", data, mimeType: "image/png" }], { toolCallId: "r1", isError: false });
      const words = `[来自 网页]\n看这个\n[图片] ${media}/${sha(shot)}\n[图片] ${media}/${sha(photo)}\n[文件] notes.txt：${media}/${sha(notes)}`;
      mkdirSync(join(dir, ".pi/agent/sessions/--w--"), { recursive: true });
      writeFileSync(join(dir, ".pi/agent/sessions/--w--/2026-11-06_s1.jsonl"), line(t, "user", [{ type: "text", text: words }, { type: "image", data, mimeType: "image/png" }]) + read + bash(t + 1000, "c1", "rh send me --file shot.png 测试过了", sent + 500 - (t + 1000)) + bash(sent + 1000, "c2", "ls") + bash(sent + 2000, "c3", 'rh send me "Delivered"; false', 500, true) + bash(sent + 5000, "c4", 'if false; then rh send me "Tests passed"; fi'));
      const r = await fetch(`${at}/api/messages?slot=${slot}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } });
      const text = await r.text();
      expect(text).not.toContain(data);
      const blocks = JSON.parse(text).blocks as { kind: string; text?: string; media?: unknown; send?: unknown }[];
      expect(blocks[0]).toMatchObject({
        kind: "user",
        text: "看这个",
        media: [
          { kind: "image", hash: sha(shot), name: `${sha(shot)}.png`, w: 1080, h: 2400 },
          { kind: "image", hash: sha(photo), name: `${sha(photo)}.jpeg`, w: 400, h: 300 },
          { kind: "file", hash: sha(notes), name: "notes.txt" },
        ],
      });
      expect(blocks[1]).toMatchObject({ kind: "tool", result: { text: "Read image file [image/png]", media: [{ kind: "image", hash: sha(shot), name: `${sha(shot)}.png`, w: 1080, h: 2400 }] } });
      expect(blocks.filter((b) => b.kind === "tool").map((b) => b.send)).toEqual([undefined, { to: "me", text: "测试过了", files: ["shot.png"], media: [{ kind: "image", hash: sha(photo), name: "shot.png", w: 400, h: 300 }] }, undefined, { to: "me", text: "Delivered", files: [], media: [] }, { to: "me", text: "Tests passed", files: [] }]);
      const board = (await (await fetch(`${at}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as BoardData;
      expect(board.workspaces[0]!.groups.idle[0]!.last).toMatchObject({ role: "user", text: "看这个 [图片] [图片] [文件]" });
    } finally {
      process.env.HOME = home;
    }
  });
});

test("story 562: two rh sends close together each have their own files, and one never run takes none, on a page read from the later one's call as the page reads on", async () => {
  await withWeb(async (at, _web, store, dir) => {
    const home = process.env.HOME;
    process.env.HOME = dir;
    try {
      const media = join(dir, "state/media");
      mkdirSync(media, { recursive: true });
      const [one, two] = [await picture(4, 3, 0, "png"), await picture(3, 4, 0, "png")];
      for (const data of [one, two]) writeFileSync(join(media, sha(data)), data);
      const slot = store.tx((tx) => {
        const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
        const id = tx.insert("slot", { workspace: ws, name: "pics", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
        tx.update("slot", { id }, { conversation: tx.insert("conversation", { slot: id, agent: "pi", sessionId: "s1", startedAt: Date.now() }).id });
        return id;
      });
      const t = Date.now() - 200_000;
      // Text alone without data.
      const sent = (when: number, data?: Uint8Array, name?: string) => {
        setSystemTime(when);
        store.tx((tx) => tx.append({ source: "rh", type: "send_me", slot, ...(data && { data: { files: [{ kind: "image", hash: sha(data), name }] } }) }));
        setSystemTime();
      };
      const file = join(dir, ".pi/agent/sessions/--w--/2026-11-06_s1.jsonl");
      mkdirSync(join(file, ".."), { recursive: true });
      const line = (when: number, role: string, content: unknown[], more = {}) => JSON.stringify({ type: "message", timestamp: new Date(when).toISOString(), message: { role, content, ...more } }) + "\n";
      // A line each, as Claude writes a message's calls.
      const call = (when: number, id: string, command: string) => appendFileSync(file, line(when, "assistant", [{ type: "toolCall", id, name: "bash", arguments: { command } }]));
      const done = (when: number, id: string) => appendFileSync(file, line(when, "toolResult", [{ type: "text", text: "ok" }], { toolCallId: id, isError: false }));
      type Page = { blocks: { kind: string; id?: string; at: string; send?: { media?: { name: string }[] } }[] };
      const read = async (after?: number) => (await (await fetch(`${at}/api/messages?slot=${slot}${after === undefined ? "" : `&after=${after}`}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json()) as Page;
      const fromCall = async (id: string) => {
        const c = (await read()).blocks.find((b) => b.id === id)!;
        return (await read(parseInt(c.at))).blocks.find((b) => b.id === id)!.send!.media?.map((m) => m.name);
      };

      // Half a minute apart: the page reads the second call before its rh runs, the first's on a page before.
      call(t, "c1", "rh send me --file one.png");
      sent(t + 1000, one, "one.png");
      done(t + 1500, "c1");
      call(t + 31_000, "c2", "rh send me --file two.png");
      expect(await fromCall("c2")).toBeUndefined();
      sent(t + 32_000, two, "two.png");
      done(t + 32_500, "c2");
      expect(await fromCall("c2")).toEqual(["two.png"]);

      // Two calls in one message, both written before either runs; the page reads on from the second's.
      call(t + 60_000, "c3", "rh send me --file one.png");
      call(t + 60_000, "c4", "rh send me --file two.png");
      sent(t + 61_000, one, "one.png");
      done(t + 61_500, "c3");
      sent(t + 62_000, two, "two.png");
      done(t + 62_500, "c4");
      expect(await fromCall("c4")).toEqual(["two.png"]);
      expect((await read()).blocks.filter((b) => b.kind === "tool").map((b) => b.send!.media?.[0]!.name)).toEqual(["one.png", "two.png", "one.png", "two.png"]);

      // One never run half a minute after one sent text alone; the page reads on from its call, its result there.
      call(t + 90_000, "c5", "rh send me 开始跑测试");
      sent(t + 91_000);
      done(t + 91_500, "c5");
      call(t + 121_000, "c6", "bun test || rh send me 测试挂了");
      done(t + 125_000, "c6");
      expect(await fromCall("c6")).toBeUndefined();
    } finally {
      process.env.HOME = home;
    }
  });
});

test("#356: a script or style of the page comes as the brotli built beside it to a browser that takes br, else gzipped, else as it is; one with none built beside it, and the HTML, gzipped", async () => {
  await withWeb(async (at, web) => {
    const js = "export const said = 'hello';\n".repeat(50);
    writeFileSync(join(web, "assets/a-1.js"), js);
    writeFileSync(join(web, "assets/a-1.js.br"), brotliCompressSync(js));
    writeFileSync(join(web, "assets/b-1.css"), "body{color:red}\n".repeat(50));
    writeFileSync(join(web, "index.html"), "<!doctype html><title>Rhodium</title>\n".repeat(20));
    const fetched = async (path: string, accept: string) => {
      const r = await fetch(at + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "accept-encoding": accept }, decompress: false });
      const bytes = Buffer.from(await r.arrayBuffer());
      const encoding = r.headers.get("content-encoding");
      const text = (encoding === "br" ? brotliDecompressSync(bytes) : encoding === "gzip" ? gunzipSync(bytes) : bytes).toString();
      return { path, accept, status: r.status, type: r.headers.get("content-type")?.split(";")[0], encoding, vary: r.headers.get("vary"), cache: r.headers.get("cache-control"), text };
    };
    const kept = "public, max-age=31536000, immutable";
    const js1 = { path: "/assets/a-1.js", status: 200, type: "text/javascript", vary: "accept-encoding", cache: kept, text: js };
    expect(await fetched("/assets/a-1.js", "gzip, deflate, br, zstd")).toEqual({ ...js1, accept: "gzip, deflate, br, zstd", encoding: "br" });
    expect(await fetched("/assets/a-1.js", "gzip, deflate")).toEqual({ ...js1, accept: "gzip, deflate", encoding: "gzip" });
    expect(await fetched("/assets/a-1.js", "identity")).toEqual({ ...js1, accept: "identity", encoding: null });
    expect((await fetched("/assets/b-1.css", "gzip, br")).encoding).toBe("gzip");
    expect((await fetched("/", "gzip, br")).encoding).toBe("gzip");
  });
});

test("#595: /api/board says noHerdr only while herdr is not where switching looks for it, so the page hides its ways to the terminal", async () => {
  await withWeb(async (at, _web, _store, dir) => {
    const noHerdr = async () => ((await (await get("/api/board", BOARD_LOGIN, {}, undefined, at)).json()) as BoardData).noHerdr;
    expect(await noHerdr()).toBeUndefined();
    rmSync(join(dir, "herdr"));
    expect(await noHerdr()).toBe(true);
  });
});

test("#356: each event stream opens by naming the page rhodium serves now, by the script its HTML loads first; with none built, null", async () => {
  await withWeb(async (at, web) => {
    const pageOf = async () => {
      const s = await stream(undefined, undefined, at);
      await until(() => s.pages.length > 0);
      await s.close();
      // Each stream's own id too, which the page says whether it is in front by (#593).
      return s.pages.map((p): unknown => ({ ...(p as object), stream: (p as { stream?: string }).stream?.length }));
    };
    expect(await pageOf()).toEqual([{ entry: null, stream: 36 }]);
    const html = (entry: string) => `<!doctype html><script src="./theme.js"></script><script type="module" crossorigin src="${entry}"></script><link rel="modulepreload" href="./assets/lib-1.js">`;
    writeFileSync(join(web, "index.html"), html("./assets/index-A1.js"));
    expect(await pageOf()).toEqual([{ entry: "./assets/index-A1.js", stream: 36 }]);
    // Built anew under a rhodium still running, as from source: the next stream says so.
    writeFileSync(join(web, "index.html"), html("./assets/index-B2.js"));
    expect(await pageOf()).toEqual([{ entry: "./assets/index-B2.js", stream: 36 }]);
  });
});

type Said = { conversation: string | null; blocks: { kind: string; text?: string }[]; end: number };
const said = async (slot: string, after?: number): Promise<Said> => (await get(`/api/messages?slot=${slot}${after === undefined ? "" : `&after=${after}`}`)).json() as Promise<Said>;

test("stories 202, 204: a stream following a slot says each time its agent writes to its transcript, and only for that slot; reconnected, the page reads on from where it was", async () => {
  const [ask, idle] = [(await card("ask")).id, (await card("idle")).id];
  const logged = (msg: string) => daemon.logs.filter((l) => l.msg === msg && l.slot === ask).length;
  const all = await stream();
  const mine = await stream(undefined, ask);
  const also = await stream(undefined, ask);
  const other = await stream(undefined, idle);
  let { end } = await said(ask);

  // You say something: the agent writes it down, then asks to run make.
  await say("q", "more");
  await until(() => mine.grew > 0 && also.grew > 0, 5_000);
  const page = await said(ask, end);
  expect(page.blocks.map((b) => [b.kind, b.text])).toEqual([["user", "more"]]);
  end = page.end;

  // The page loses its stream; meanwhile the agent writes its reply. Once back, it reads on from where it was.
  await mine.close();
  const grew = also.grew;
  await say("q", "1");
  await until(() => also.grew > grew, 15_000);
  const back = await stream(undefined, ask);
  expect((await said(ask, end)).blocks.map((b) => [b.kind, b.text])).toEqual([["assistant", "answered"]]);

  expect([all.grew, other.grew]).toEqual([0, 0]);
  // One look at the transcript for all its streams, until the last goes.
  expect(logged("watching a transcript")).toBe(1);
  await also.close();
  await Bun.sleep(100);
  expect(logged("stopped watching a transcript")).toBe(0);
  await back.close();
  await until(() => logged("stopped watching a transcript") === 1);
  await Promise.all([all.close(), other.close()]);
}, 40_000);

test("story 203: what a headless agent writes comes as it writes, piece by piece and then that the message is whole, and that its process ended, to the streams following its slot and no other; not in the event table", async () => {
  // w/a's claude reads a file and runs a command, then writes its reply in nine pieces.
  const writer = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: "progress" } });
  try {
    const at = `http://${(await writer.start()).logs.find((l) => l.msg === "ready")!.board}`;
    await writer.slots("a", "b");
    const slots = ((await (await get("/api/board", BOARD_LOGIN, {}, undefined, at)).json()) as Board).workspaces[0]!.groups.idle;
    const [a, b] = ["a", "b"].map((n) => slots.find((c) => c.name === n)!.id);
    const all = await stream(undefined, undefined, at);
    const mine = await stream(undefined, a, at);
    const other = await stream(undefined, b, at);

    await writer.im.inject("q", { chat: ME, sender: ME, text: "go" });
    await until(() => mine.told.some(([name]) => name === "said"), 15_000);
    const written = mine.told.filter(([name]) => name !== "grew");
    expect(written).toEqual([...PROGRESS_PIECES.map((text): [string, unknown] => ["delta", { text }]), ["said", {}]]);
    // The turn's end is in the event table, but not what was written.
    await until(() => all.seen.some((e) => e.type === "final_reply"), 5_000);
    expect([all.told, other.told]).toEqual([[], []]);
    expect(JSON.stringify(all.seen)).not.toContain(PROGRESS_PIECES[1]!);
    // And that its process ended, as one stopped mid-message never says its message is whole.
    expect((await writer.rh(["stop", "w/a"])).code).toBe(0);
    await until(() => mine.told.some(([name]) => name === "exit"), 5_000);
    expect(mine.told.filter(([name]) => name !== "grew").slice(-2)).toEqual([["said", {}], ["exit", {}]]);
    expect([all.told, other.told]).toEqual([[], []]);
    await Promise.all([all.close(), mine.close(), other.close()]);
  } finally {
    await writer.cleanup();
  }
}, 40_000);

test("#209: each card has the last thing you or the agent said, and when, kept up as its transcript grows", async () => {
  expect((await card("idle")).last).toBeNull();
  await say("q", "one **more**");
  await until(async () => (await card("ask")).last?.text === "one more", 15_000);
  expect((await card("ask")).last).toEqual({ role: "user", text: "one more", at: expect.any(Number), source: "假 IM Bot q 的私聊" });
  await say("q", "1"); // allow
  await until(async () => (await card("ask")).last?.role === "assistant", 15_000);
  expect((await card("ask")).last?.text).toBe("answered");
}, 40_000);

/** A POST to /api/act with your login and these headers; the body an act that only lists the workspaces. */
const post = (headers: Record<string, string>, body = JSON.stringify({ id: crypto.randomUUID(), act: { kind: "rh", argv: ["ws"] } }), method = "POST") =>
  fetch(`${base}/api/act`, { method, headers: { "Tailscale-User-Login": BOARD_LOGIN, "content-type": "application/json", ...headers }, ...(method === "GET" ? {} : { body }) });

test("story 258: a write comes only from the board's own page: same-origin as the browser says, or, where it does not, an Origin of this host and port", async () => {
  const same = { "sec-fetch-site": "same-origin" };
  expect((await post(same)).status).toBe(200);
  for (const site of ["same-site", "cross-site", "none"]) expect([site, (await post({ "sec-fetch-site": site })).status]).toEqual([site, 403]);
  // An older browser says no Sec-Fetch-Site: its Origin then. tailscale serve brings https to the board's http.
  const { host } = new URL(base);
  for (const origin of [base, `https://${host}`]) expect([origin, (await post({ origin })).status]).toEqual([origin, 200]);
  for (const origin of ["http://127.0.0.1:1", `http://${host}.evil.example`, "null"]) expect([origin, (await post({ origin })).status]).toEqual([origin, 403]);
  expect((await post({})).status).toBe(403);
  // JSON only, which a page elsewhere cannot send without asking first; POST only.
  expect((await post({ ...same, "content-type": "text/plain" })).status).toBe(400);
  expect((await post(same, "", "GET")).status).toBe(405);
  expect((await post(same, "{")).status).toBe(400);
  for (const act of [{ kind: "nope" }, { kind: "rh", argv: "ws" }, { kind: "common", slot: "S", name: "rm" }]) {
    expect([act, (await post(same, JSON.stringify({ id: "x1", act }))).status]).toEqual([act, 400]);
  }
  expect((await post(same, JSON.stringify({ act: { kind: "rh", argv: ["ws"] } }))).status).toBe(400);
  // New targets each say what they were before (story 260).
  const binds = [
    { kind: "bind", changes: [{ chat: "C", to: "S" }] },
    { kind: "bind", changes: [{ chat: "C", from: { slot: "S" }, to: "S" }] },
    { kind: "bind", changes: [{ chat: "C", from: null, to: null }] },
    { kind: "bind", changes: [{ bot: "B", from: "S", to: null }] },
    { kind: "bind", changes: {} },
    { kind: "bind", changes: [], unarchive: 1 },
  ];
  for (const act of binds) expect([act, (await post(same, JSON.stringify({ id: "x3", act }))).status]).toEqual([act, 400]);
  const bind = { kind: "bind", changes: [{ chat: "C", from: { slot: null, use: false }, to: "S" }, { bot: "B", from: null, to: "S" }] };
  expect(await (await post(same, JSON.stringify({ id: "x4", act: bind }))).json()).toEqual({ ok: false, error: "没有这个聊天窗口。" });
  // At most 1MB.
  expect((await post(same, JSON.stringify({ id: "x2", act: { kind: "rh", argv: ["ws", "x".repeat(1 << 20)] } }))).status).toBe(413);
  // Taking the terminal back from the board says you confirmed it: the page asks first.
  const release = (sure?: true) => JSON.stringify({ id: crypto.randomUUID(), act: { kind: "rh", argv: ["release", "w/idle"], ...(sure && { sure }) } });
  expect((await post(same, release())).status).toBe(400);
  expect(await (await post(same, release(true))).json()).toEqual({ ok: true, text: "w/idle 不在 TUI 里。" });
});

test("story 258: every path, reading too, answers only to a Host of the tailnet or this machine: a page elsewhere whose name points here gets nothing", async () => {
  const { port } = new URL(base);
  for (const path of ["/", "/api/board", "/api/events", "/api/act", "/icon-192.png"]) {
    for (const host of ["evil.example", `evil.example:${port}`, "ts.net.evil.example"]) {
      expect([path, host, (await get(path, BOARD_LOGIN, { host })).status]).toEqual([path, host, 403]);
    }
  }
  for (const host of [`localhost:${port}`, "myhost.tail1234.ts.net", `myhost.tail1234.ts.net:${port}`]) {
    expect([host, (await get("/api/board", BOARD_LOGIN, { host })).status]).toEqual([host, 200]);
  }
});

test("stories 289, 290, 293: /api/slot gives each ask what its card shows; one answered is gone from the asks, and says where for a while; an answer with no ask or text is no act", async () => {
  const same = { "sec-fetch-site": "same-origin" };
  for (const act of [{ kind: "answer", ask: "A1" }, { kind: "answer", text: "1" }, { kind: "answer", ask: 1, text: "1" }]) {
    expect([act, (await post(same, JSON.stringify({ id: "x3", act }))).status]).toEqual([act, 400]);
  }
  const id = (await card("ask")).id;
  const slot = async () => (await (await get(`/api/slot?id=${id}`)).json()) as { asks: { id: string; card: unknown }[]; gone: { id: string; why: string }[] };
  await say("q", "go");
  await until(async () => (await slot()).asks.length > 0, 15_000);
  const [ask] = (await slot()).asks;
  expect(ask!.card).toEqual({ head: "要运行这条命令", body: "make", yes: "允许", no: "拒绝", told: true });
  expect(await (await post(same, JSON.stringify({ id: crypto.randomUUID(), act: { kind: "answer", ask: ask!.id, text: "1" } }))).json()).toEqual({ ok: true, text: "已允许运行这条命令。" });
  const after = await slot();
  expect(after.asks).toEqual([]);
  expect(after.gone).toContainEqual({ id: ask!.id, why: "已在网页回答" });
}, 30_000);

test("story 319: a chat's tool-line switch says which chat and on or off, else it is no act", async () => {
  const same = { "sec-fetch-site": "same-origin" };
  for (const act of [{ kind: "verbose", chat: "C1" }, { kind: "verbose", on: true }, { kind: "verbose", chat: "C1", on: "on" }]) {
    expect([act, (await post(same, JSON.stringify({ id: "x4", act }))).status]).toEqual([act, 400]);
  }
  expect(await (await post(same, JSON.stringify({ id: crypto.randomUUID(), act: { kind: "verbose", chat: "C1", on: true } }))).json()).toEqual({ ok: false, error: "没有这个聊天窗口。" });
});

/** A POST to /api/send with your login and these headers; the body a message to w/idle, form, or what is given. */
const send = async (headers: Record<string, string>, body?: BodyInit, method = "POST") => {
  const form = new FormData();
  form.set("id", crypto.randomUUID());
  form.set("slot", (await card("idle")).id);
  form.set("text", "/rh_help");
  return fetch(`${base}/api/send`, { method, headers: { "Tailscale-User-Login": BOARD_LOGIN, ...headers }, ...(method === "GET" ? {} : { body: body ?? form }) });
};

test("stories 258, 276: a message with what you attached comes, as multipart, only from the board's own page, at most 20MB; /api/act takes none attached", async () => {
  const same = { "sec-fetch-site": "same-origin" };
  expect(await (await send(same)).json()).toEqual({ ok: true, text: "打 / 看命令面板。" });
  for (const site of ["same-site", "cross-site", "none"]) expect([site, (await send({ "sec-fetch-site": site })).status]).toEqual([site, 403]);
  expect((await send({})).status).toBe(403);
  expect((await send(same, undefined, "GET")).status).toBe(405);
  expect((await send({ ...same, "content-type": "text/plain" }, "hi")).status).toBe(400);
  const big = new FormData();
  big.set("id", crypto.randomUUID());
  big.set("slot", (await card("idle")).id);
  big.set("text", "");
  big.append("file", new File([new Uint8Array(20 << 20)], "big.bin"));
  expect((await send(same, big)).status).toBe(413);
  // What /api/act carries is never a path to a file: only /api/send attaches, what it has kept itself.
  const attached = { kind: "say", slot: (await card("idle")).id, text: "hi", attachments: [{ kind: "file", name: "x", path: "/etc/passwd" }] };
  expect((await post(same, JSON.stringify({ id: crypto.randomUUID(), act: attached }))).status).toBe(400);
});

test("stories 283, 286: /api/slot lists your messages from the board waiting for the agent, by request id, with their words, how many they carry attached and why they wait; a queue act takes a slot, now or drop, and drop one by id", async () => {
  // w/run's pi works until stopped.
  if ((await card("run")).state !== "运行中") {
    await say("r", "work");
    await until(async () => (await card("run")).state === "运行中", 15_000);
  }
  const run = (await card("run")).id;
  const same = { "sec-fetch-site": "same-origin" };
  const [one, two] = [crypto.randomUUID(), crypto.randomUUID()];
  expect(await (await post(same, JSON.stringify({ id: one, act: { kind: "say", slot: run, text: "顺便看看日志" } }))).json()).toEqual({ ok: true, text: "排队" });
  const form = new FormData();
  for (const [k, v] of [["id", two], ["slot", run], ["text", "看看这个"]]) form.set(k!, v!);
  form.append("file", new File(["notes"], "notes.txt", { type: "text/plain" }));
  expect(await (await fetch(`${base}/api/send`, { method: "POST", headers: { "Tailscale-User-Login": BOARD_LOGIN, ...same }, body: form })).json()).toEqual({ ok: true, text: "排队" });
  const slot = async () => (await (await get(`/api/slot?id=${run}`)).json()) as { queue: unknown[] };
  expect((await slot()).queue).toEqual([
    { id: one, text: "顺便看看日志", files: 0, reason: "web_queue" },
    { id: two, text: "看看这个", files: 1, reason: "web_queue" },
  ]);
  for (const act of [{ kind: "queued", slot: run, op: "later" }, { kind: "queued", slot: run, op: "drop" }, { kind: "queued", op: "now" }, { kind: "queued", slot: run, op: "now", input: 1 }]) {
    expect([act, (await post(same, JSON.stringify({ id: crypto.randomUUID(), act }))).status]).toEqual([act, 400]);
  }
  for (const input of [one, two]) {
    expect(await (await post(same, JSON.stringify({ id: crypto.randomUUID(), act: { kind: "queued", slot: run, op: "drop", input } }))).json()).toEqual({ ok: true, text: "删掉了。" });
  }
  expect((await slot()).queue).toEqual([]);
}, 30_000);

test("story 322: /api/slot gives the slot's settings, each with its own value, null for the default, and the default, and whether it is one-off; rh set from the board changes them, and default goes back", async () => {
  const idle = (await card("idle")).id;
  type Setting = { key: string; label: string; kind: string; value: number | null; default: number };
  const slot = async () => (await (await get(`/api/slot?id=${idle}`)).json()) as { settings: Setting[]; lifetime: string };
  const set = async (...items: string[]) => (await post({ "sec-fetch-site": "same-origin" }, JSON.stringify({ id: crypto.randomUUID(), act: { kind: "rh", argv: ["set", idle, ...items] } }))).json();
  const before = await slot();
  expect(before.lifetime).toBe("longterm");
  expect(before.settings.map((s) => [s.key, s.label, s.kind, s.value, typeof s.default])).toEqual([
    ["approval", "审批模式", "flag", null, "number"],
    ["reap", "回收时长", "duration", null, "number"],
    ["ask-timeout", "提问超时", "duration", null, "number"],
    ["crash-resume", "崩溃续跑", "flag", null, "number"],
    ["auto-continue", "额度续跑", "flag", null, "number"],
  ]);
  expect(await set("reap=600s", "approval=on")).toMatchObject({ ok: true });
  const value = (s: { settings: Setting[] }, key: string) => s.settings.find((x) => x.key === key)!.value;
  const after = await slot();
  expect([value(after, "reap"), value(after, "approval")]).toEqual([600_000, 1]);
  await set("reap=default", "approval=default");
  const back = await slot();
  expect([value(back, "reap"), value(back, "approval")]).toEqual([null, null]);
});

type Topology = { bots: { id: string; name: string; platform: string; avatar: string | null }[]; chats: { id: string; bot: string; kind: string; main: boolean }[]; bindings: { chat: string; slot: string }[] };

/** The slots with a bot on them, by name, with those bots' names, as /api/board has them. Checked
 *  against /api/topology: the same bots, and on each slot those your private chat (one of yours) or
 *  the main chat there lands on, in the bots' order. */
async function faces(yours: string[]): Promise<Record<string, string[]>> {
  const b = await board();
  const t = (await (await get("/api/topology")).json()) as Topology;
  expect(b.bots).toEqual(t.bots.map(({ id, name, platform, avatar }) => ({ id, name, platform, avatar })));
  const mine = t.chats.filter((c) => yours.includes(c.id) || c.main);
  const landed = (slot: string) => t.bots.filter((x) => mine.some((c) => c.bot === x.id && t.bindings.some((y) => y.chat === c.id && y.slot === slot))).map((x) => x.id);
  const cards = b.workspaces.flatMap((w) => [...Object.values(w.groups).flat(), ...w.archived]);
  for (const c of cards) expect([c.ref, c.bots]).toEqual([c.ref, landed(c.id)]);
  const name = (id: string) => b.bots.find((x) => x.id === id)!.name;
  return Object.fromEntries(cards.filter((c) => c.bots.length).map((c) => [c.name, c.bots.map(name)]));
}

test("stories 437, 440: /api/board has the bots, and on each slot those your private chat or the main chat lands on now: a slot a chat picked, not a default no chat follows, nor a stranger's pick", async () => {
  // Your private chats, there even when this test runs alone.
  for (const bot of ["q", "r"]) await say(bot, "/rh_help");
  const chats = async () => ((await (await get("/api/topology")).json()) as Topology).chats.filter((c) => !c.main);
  await until(async () => (await chats()).length === 2);
  // A stranger's chat is a private one too (#291): yours are these.
  const yours = (await chats()).map((c) => c.id);
  expect(await faces(yours)).toEqual({ ask: ["q"], run: ["r"] });
  await rhodium.ok("use", `q/${ME}`, "w/idle");
  expect(await faces(yours)).toEqual({ idle: ["q"], run: ["r"] });
  await rhodium.ok("use", "r/stranger-openid", "w/ask");
  expect(await faces(yours)).toEqual({ idle: ["q"], run: ["r"] });
  // The main chat counts; a bot with two such chats on a slot is there once.
  await rhodium.ok("use", `r/${GROUP}`, "w/idle");
  expect(await faces(yours)).toEqual({ idle: ["q", "r"], run: ["r"] });
  await rhodium.ok("use", `r/${ME}`, "w/idle");
  expect(await faces(yours)).toEqual({ idle: ["q", "r"] });
  for (const chat of [`q/${ME}`, `r/${ME}`, "r/stranger-openid", `r/${GROUP}`]) await rhodium.ok("use", chat, "-");
  expect(await faces(yours)).toEqual({ ask: ["q"], run: ["r"] });
});

/** The status line's code the board answers a WebSocket handshake for /api/terminal with, the request
 *  written by hand: a browser's on the board's own page, with your login, but for headers, each null
 *  to leave it out. */
async function handshake(at: string, query: string, headers: Record<string, string | null> = {}): Promise<number> {
  return new Promise((ok, ko) => {
    const s = upgrading(at, query, headers);
    let buf = "";
    s.on("data", (d) => {
      buf += d;
      if (buf.includes("\r\n")) (s.destroy(), ok(Number(buf.split(" ")[1])));
    });
    s.on("error", ko);
  });
}

/** A socket to the board at that asks to upgrade to /api/terminal<query>, as handshake writes it. */
function upgrading(at: string, query: string, headers: Record<string, string | null> = {}) {
  const { host, hostname, port } = new URL(at);
  const all: Record<string, string | null> = {
    Host: host,
    Connection: "Upgrade",
    Upgrade: "websocket",
    "Sec-WebSocket-Version": "13",
    "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    "Tailscale-User-Login": BOARD_LOGIN,
    "Sec-Fetch-Site": "same-origin",
    ...headers,
  };
  const head = Object.entries(all).flatMap(([k, v]) => (v === null ? [] : [`${k}: ${v}\r\n`]));
  const s = connect(Number(port), hostname, () => s.write(`GET /api/terminal${query} HTTP/1.1\r\n${head.join("")}\r\n`));
  return s;
}

/** The page's terminal of slot on the board at, as a browser on the board's own page opens it with your
 *  login: got, what it was sent, a binary frame as its text; closed, how it closed. */
function terminal(at: string, slot: string, size = "&cols=50&rows=20") {
  const ws = new WebSocket(`${at.replace(/^http/, "ws")}/api/terminal?slot=${slot}${size}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, Origin: at } } as any);
  ws.binaryType = "arraybuffer";
  const got: string[] = [];
  ws.onmessage = (e) => got.push(typeof e.data === "string" ? `text ${e.data}` : new TextDecoder().decode(e.data as ArrayBuffer));
  const closed = new Promise<{ code: number; reason: string }>((ok) => (ws.onclose = (e) => ok({ code: e.code, reason: e.reason })));
  return { ws, got, closed, saw: (text: string) => until(() => got.some((g) => g.includes(text))) };
}

describe("the web terminal of a slot in the terminal, with a fake Herdr", () => {
  let term: Instance;
  let at = "";
  let logs: Daemon["logs"];
  let slot = "";
  let pane = "";
  /** The lines the fake Herdr's terminal session controls got, as fake.calls has them. */
  const herdr = async () => ((await call(term.herdr.socket, "fake.calls")).result.calls as { method: string; params: any }[]).filter((c) => c.method.startsWith("terminal."));
  beforeAll(async () => {
    term = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/t" } }, herdr: true });
    const d = await term.start();
    logs = d.logs;
    at = `http://${d.logs.find((l) => l.msg === "ready")!.board}`;
    await term.slots("t");
    await term.im.inject("q", { chat: ME, sender: ME, text: "hi" });
    await until(async () => (await term.state("w/t")) === "空闲", 15_000);
    await term.ok("tui", "w/t");
    await until(async () => (await term.state("w/t")) === "TUI 模式", 15_000);
    const card = ((await (await get("/api/board", BOARD_LOGIN, {}, undefined, at)).json()) as Board).workspaces[0]!.groups.running[0]!;
    slot = card.id;
    pane = ((await (await get(`/api/slot?id=${slot}`, BOARD_LOGIN, {}, undefined, at)).json()) as { pane: string }).pane;
  }, 30_000);
  afterAll(() => term.cleanup());

  test("story 356: the terminal's handshake is checked as a write is: no login or another's, a page elsewhere, a host elsewhere is 403, with no upgrade; no upgrade or no slot is 400; Herdr hears of none", async () => {
    const q = `?slot=${slot}&cols=50&rows=20`;
    const refused: [string, Record<string, string | null>][] = [
      ["no login", { "Tailscale-User-Login": null }],
      ["another's login", { "Tailscale-User-Login": "someone@example.com" }],
      ["same-site", { "Sec-Fetch-Site": "same-site" }],
      ["cross-site", { "Sec-Fetch-Site": "cross-site" }],
      ["another origin", { "Sec-Fetch-Site": null, Origin: "http://127.0.0.1:1" }],
      ["neither", { "Sec-Fetch-Site": null }],
      ["another host", { Host: "evil.example" }],
    ];
    for (const [why, headers] of refused) expect([why, await handshake(at, q, headers)]).toEqual([why, 403]);
    const bad: [string, string, Record<string, string | null>][] = [
      ["no upgrade", q, { Connection: null, Upgrade: null }],
      ["no slot", "?cols=50&rows=20", {}],
      ["a slot that is no id", "?slot=../x", {}],
    ];
    for (const [why, query, headers] of bad) expect([why, await handshake(at, query, headers)]).toEqual([why, 400]);
    expect(await herdr()).toEqual([]);
    // Its Origin, where a browser says no Sec-Fetch-Site; tailscale serve brings https to the board's http.
    expect(await handshake(at, q, { "Sec-Fetch-Site": null, Origin: `https://${new URL(at).host}` })).toBe(101);
    // Dropped as it opened: Herdr lets go.
    await until(async () => (await herdr()).map((c) => c.method).join() === "terminal.session.control,terminal.release");
  });

  test("stories 340, 341: the page gets Herdr's frames of the pane as binary, its ANSI as Herdr drew it, attached at the page's size; a size changes the pane's, kept in range; what it cannot read is dropped and the rest goes on; a binary frame closes it; closed, Herdr lets go", async () => {
    const from = (await herdr()).length;
    const t = terminal(at, slot);
    await t.saw(`fake herdr ${pane} 50x20`);
    expect(t.got[0]).toStartWith("\x1b[2J");
    for (const junk of ["nope", '{"t":"size","c":"x","r":2}', '{"t":"zzz"}', "[1]", "null", '{"t":"size","c":999,"r":1}', '{"t":"size","c":40,"r":12}']) t.ws.send(junk);
    await t.saw("40x12");
    expect(t.got.some((g) => g.startsWith("text "))).toBe(false);
    t.ws.close();
    await until(async () => (await herdr()).some((c, i) => i >= from && c.method === "terminal.release"));
    expect((await herdr()).slice(from)).toEqual([
      { method: "terminal.session.control", params: { pane_id: pane, takeover: true, cols: 50, rows: 20 } },
      { method: "terminal.resize", params: { cols: 500, rows: 2 } },
      { method: "terminal.resize", params: { cols: 40, rows: 12 } },
      { method: "terminal.release", params: {} },
    ]);
    // A line each as it opens and closes, with why.
    await until(() => logs.some((l) => l.msg === "terminal closed" && l.slot === slot));
    expect(logs.find((l) => l.msg === "terminal opened" && l.slot === slot)).toMatchObject({ pane, cols: 50, rows: 20 });

    const binary = terminal(at, slot);
    await binary.saw("50x20");
    binary.ws.send(new Uint8Array([1, 2, 3]));
    expect((await binary.closed).code).toBe(1003);
    // A frame is 64KB at most: the page cuts what you type to fit.
    const big = terminal(at, slot);
    await big.saw("50x20");
    big.ws.send(JSON.stringify({ t: "size", c: 40, r: 12, pad: "x".repeat(64 * 1024) }));
    expect((await big.closed).code).toBe(1009);
    // Let go of before the next test counts what Herdr heard.
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");
  });

  test("stories 349, 350: a second page of the slot takes it over: the first closes with 4001, and Herdr hears the first let go before the second attaches; a line says so", async () => {
    const from = (await herdr()).length;
    const first = terminal(at, slot);
    await first.saw("50x20");
    const second = terminal(at, slot, "&cols=60&rows=20");
    expect((await first.closed).code).toBe(4001);
    await second.saw("60x20");
    expect((await herdr()).slice(from)).toEqual([
      { method: "terminal.session.control", params: { pane_id: pane, takeover: true, cols: 50, rows: 20 } },
      { method: "terminal.release", params: {} },
      { method: "terminal.session.control", params: { pane_id: pane, takeover: true, cols: 60, rows: 20 } },
    ]);
    expect(logs.some((l) => l.msg === "terminal taken over" && l.slot === slot)).toBe(true);
    second.ws.close();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");

    // herdr-web on the pane, which attaches as any terminal session control does, is taken over too.
    const bin = /^herdr = "(.*)"$/m.exec(readFileSync(term.config, "utf8"))![1]!;
    const web = Bun.spawn([bin, "--session", term.herdr.session, "terminal", "session", "control", pane, "--takeover"], { env: term.env, stdin: "pipe", stdout: "pipe" });
    const said = new Response(web.stdout).text();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.session.control");
    const page = terminal(at, slot);
    await page.saw("50x20");
    await web.exited;
    expect((await said).trim().split("\n").map((l) => JSON.parse(l)).at(-1)).toEqual({ type: "terminal.closed", reason: "terminal attach taken over" });
    page.ws.close();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");
  });

  test("stories 351, 353: a page back in front or connecting again (resume=1) leaves the slot to another page open on it: it closes with 4001, the other goes on, Herdr hears nothing; with none open, or only its own connection still open, it attaches", async () => {
    const open = terminal(at, slot, "&cols=50&rows=20&page=a");
    await open.saw("50x20");
    let from = (await herdr()).length;
    const back = terminal(at, slot, "&cols=60&rows=20&resume=1&page=b");
    expect((await back.closed).code).toBe(4001);
    open.ws.send(JSON.stringify({ t: "size", c: 40, r: 12 }));
    await open.saw("40x12");
    expect((await herdr()).slice(from)).toEqual([{ method: "terminal.resize", params: { cols: 40, rows: 12 } }]);

    // Its own, which the board has not seen drop yet (a phone off one network and on another): taken over.
    from = (await herdr()).length;
    const again = terminal(at, slot, "&cols=60&rows=20&resume=1&page=a");
    expect((await open.closed).code).toBe(4001);
    await again.saw("60x20");
    expect((await herdr()).slice(from).map((c) => c.method)).toEqual(["terminal.release", "terminal.session.control"]);
    again.ws.close();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");

    const alone = terminal(at, slot, "&cols=60&rows=20&resume=1&page=c");
    await alone.saw("60x20");
    alone.ws.close();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");
  });

  test("stories 343, 346, 347: what you type goes to the pane as Herdr's terminal.input, and a scroll as its terminal.scroll, its lines kept within 1 and 200; one of another shape is dropped and the rest goes on", async () => {
    const from = (await herdr()).length;
    const t = terminal(at, slot);
    await t.saw("50x20");
    const typed = "\x1b[200~两行\n中文 🙂\x1b[201~";
    const sent = [
      { t: "in", d: typed },
      { t: "in", d: "\r" },
      { t: "in", d: 5 },
      { t: "scroll", up: "yes", n: 3 },
      { t: "scroll", up: true, n: "3" },
      { t: "scroll", up: true, n: 3 },
      { t: "scroll", up: false, n: 999 },
      { t: "scroll", up: true, n: 0 },
      { t: "scroll", up: false, n: 2.6 },
    ];
    for (const m of sent) t.ws.send(JSON.stringify(m));
    await t.saw("scrolled down 3");
    expect(t.got.some((g) => g.includes("两行\n中文 🙂"))).toBe(true);
    t.ws.close();
    await until(async () => (await herdr()).some((c, i) => i >= from && c.method === "terminal.release"));
    expect((await herdr()).slice(from + 1, -1)).toEqual([
      { method: "terminal.input", params: { text: typed } },
      { method: "terminal.input", params: { text: "\r" } },
      { method: "terminal.scroll", params: { direction: "up", lines: 3 } },
      { method: "terminal.scroll", params: { direction: "down", lines: 200 } },
      { method: "terminal.scroll", params: { direction: "up", lines: 1 } },
      { method: "terminal.scroll", params: { direction: "down", lines: 3 } },
    ]);
  });

  test("story 357: a click goes to the pane as Herdr's terminal.mouse, its cell kept within 0..499 and 0..199, and a scroll carries the cell under the pointer; one of another shape is dropped and the rest goes on", async () => {
    const from = (await herdr()).length;
    const t = terminal(at, slot);
    await t.saw("50x20");
    const sent = [
      { t: "mouse", a: "down", c: 9, r: 4 },
      { t: "mouse", a: "drag", c: 9999, r: -3 },
      { t: "mouse", a: "move", c: 1, r: 1 },
      { t: "mouse", a: "down" },
      { t: "mouse", a: "up", c: "1", r: 1 },
      { t: "mouse", a: "up", c: 10.4, r: 4 },
      { t: "scroll", up: true, n: 3, c: 9, r: 4 },
      { t: "scroll", up: false, n: 2, c: "9", r: 4 },
    ];
    for (const m of sent) t.ws.send(JSON.stringify(m));
    await t.saw("scrolled down 2");
    t.ws.close();
    await until(async () => (await herdr()).some((c, i) => i >= from && c.method === "terminal.release"));
    expect((await herdr()).slice(from + 1, -1)).toEqual([
      { method: "terminal.mouse", params: { action: "down", column: 9, row: 4 } },
      { method: "terminal.mouse", params: { action: "drag", column: 499, row: 0 } },
      { method: "terminal.mouse", params: { action: "up", column: 10, row: 4 } },
      { method: "terminal.scroll", params: { direction: "up", lines: 3, column: 9, row: 4 } },
      { method: "terminal.scroll", params: { direction: "down", lines: 2 } },
    ]);
  });

  test("#380: Herdr's frames go to the page compressed (permessage-deflate), with a compressor of the socket's own that keeps what it sent before, and decode as Herdr drew them", async () => {
    const t = terminal(at, slot);
    await t.saw(`fake herdr ${pane} 50x20`);
    // A shared compressor would say server_no_context_takeover too.
    expect(t.ws.extensions).toBe("permessage-deflate; client_no_context_takeover");
    t.ws.close();
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");
    // Bun sends a frame raw unless told to compress it, the extension agreed or not: RSV1 says it is compressed.
    const s = upgrading(at, `?slot=${slot}&cols=50&rows=20`, { "Sec-WebSocket-Extensions": "permessage-deflate" });
    let buf = Buffer.alloc(0);
    const first = await new Promise<number>((ok) =>
      s.on("data", (d: Buffer) => {
        buf = Buffer.concat([buf, d]);
        const i = buf.indexOf("\r\n\r\n");
        if (i >= 0 && buf.length > i + 4) ok(buf[i + 4]!);
      }),
    );
    s.destroy();
    expect(first.toString(2)).toBe("11000010"); // FIN, RSV1, binary
    await until(async () => (await herdr()).at(-1)?.method === "terminal.release");
  });

  test("stories 349, 352: Herdr saying another took over closes it with 4001; the pane's process exiting, or its tab closed, with 4000", async () => {
    const t = terminal(at, slot);
    await t.saw("50x20");
    const bin = /^herdr = "(.*)"$/m.exec(readFileSync(term.config, "utf8"))![1]!;
    const other = Bun.spawn([bin, "--session", term.herdr.session, "terminal", "session", "control", pane, "--takeover"], { env: term.env, stdin: "pipe", stdout: "ignore" });
    expect(await t.closed).toEqual({ code: 4001, reason: "terminal attach taken over" });
    other.stdin.end();
    await other.exited;

    const exits = terminal(at, slot);
    await exits.saw("50x20");
    process.kill((await call(term.herdr.socket, "pane.process_info", { pane_id: pane })).result.process_info.shell_pid, "SIGKILL");
    const closed = await exits.closed;
    expect([closed.code, closed.reason]).toEqual([4000, expect.stringMatching(/^terminal \S+ exited$/)]);

    // In the terminal again, its tab closed under it, as Rhodium closes an imported pane's.
    await until(async () => ["空闲", "未运行"].includes((await term.state("w/t"))!), 15_000);
    await term.ok("tui", "w/t");
    await until(async () => (await term.state("w/t")) === "TUI 模式", 15_000);
    const again = ((await (await get(`/api/slot?id=${slot}`, BOARD_LOGIN, {}, undefined, at)).json()) as { pane: string }).pane;
    const shut = terminal(at, slot);
    await shut.saw("50x20");
    const tab = (await call(term.herdr.socket, "pane.get", { pane_id: again })).result.pane.tab_id;
    await call(term.herdr.socket, "tab.close", { tab_id: tab });
    const gone = await shut.closed;
    expect([gone.code, gone.reason]).toEqual([4000, expect.stringMatching(/^terminal attach ended: terminal \S+ not found$/)]);
  }, 40_000);
});

test("#380: the page's terminal does not wait for Herdr's look for new clients, every 250 ms while idle: the board wakes it, asking about the pane every 10 ms till the first frame, and asks no more", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rhodium-test-wake-"));
  const bin = installFakeHerdr(dir);
  const session = "rhodium-test-wake";
  const env = { HOME: dir, PATH: process.env.PATH! };
  const fake = await startFakeHerdr(bin, session, env);
  // The board runs Herdr's CLI with its own env, so with the fake's HOME through this.
  writeFileSync(join(dir, "herdr-here"), `#!/bin/sh\nHOME=${dir} exec ${bin} "$@"\n`, { mode: 0o755 });
  writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[programs]\nherdr = "${dir}/herdr-here"\n[herdr]\nsession = "${session}"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
  const store = openStore(join(dir, "rh.db"));
  const server = serveBoard(store, loadConfig(join(dir, "config.toml")));
  try {
    const pane = (await call(fake.socket, "workspace.create", { cwd: dir, label: "w", focus: false })).result.root_pane.pane_id;
    const ws = store.tx((tx) => tx.insert("workspace", { name: "w", dir }).id);
    const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "t", dir, mode: "tui", state: "idle", lifetime: "longterm", herdrPane: pane, tuiPid: 1 }).id);
    const at = `http://127.0.0.1:${server.port}`;
    // The first one's look for the socket pings Herdr, which wakes it too.
    const first = terminal(at, slot);
    await first.saw(`${pane} 50x20`);
    first.ws.close();
    await first.closed;
    // Past the look Herdr had due for it.
    await Bun.sleep(300);
    // Alone, as herdr-web attaches, it waits for Herdr's look.
    let t0 = performance.now();
    const alone = Bun.spawn([bin, "--session", session, "terminal", "session", "control", pane, "--takeover"], { env, stdin: "pipe", stdout: "pipe" });
    await alone.stdout.getReader().read();
    const waited = performance.now() - t0;
    alone.stdin.end();
    await alone.exited;
    expect(waited).toBeGreaterThan(250);

    t0 = performance.now();
    const t = terminal(at, slot);
    await t.saw(`${pane} 50x20`);
    expect(performance.now() - t0).toBeLessThan(waited - 150);
    // fake.calls is a request too, but none waits by now.
    const asked = async () => ((await call(fake.socket, "fake.calls")).result.calls as { method: string; params: any }[]).filter((c) => c.method === "pane.get" && c.params.pane_id === pane).length;
    await Bun.sleep(50);
    const n = await asked();
    expect(n).toBeGreaterThan(0);
    await Bun.sleep(300);
    expect(await asked()).toBe(n);
    t.ws.close();
    await t.closed;
  } finally {
    server.stop(true);
    store.close();
    await fake.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15_000);

test("#383: a slot still in the terminal whose pane is gone, as just after its agent exits and before Rhodium switches it back, closes with 4000, as its pane closed: the page asks for the slot afresh and shows no note", async () => {
  await withWeb(async (at, _web, store) => {
    const ws = store.tx((tx) => tx.insert("workspace", { name: "w", dir: "/w" }).id);
    const gone = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "gone", dir: "/w", mode: "tui", state: "idle", lifetime: "longterm", herdrPane: "w1:gone", tuiPid: 1 }).id);
    expect(await terminal(at, gone).closed).toEqual({ code: 4000, reason: "terminal session control failed: terminal target w1:gone not found" });
  });
});

test("spec web-terminal: a page that reads too slowly is closed once 1MB waits for it, not kept open with Herdr's frames dropped", async () => {
  await withWeb(async (at, _web, store) => {
    const ws = store.tx((tx) => tx.insert("workspace", { name: "w", dir: "/w" }).id);
    const flood = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "flood", dir: "/w", mode: "tui", state: "idle", lifetime: "longterm", herdrPane: "w1:flood", tuiPid: 1 }).id);
    // Herdr sends 48MB and stays; the page reads nothing for 2 s, then all it can.
    const s = upgrading(at, `?slot=${flood}`);
    s.pause();
    setTimeout(() => s.resume(), 2_000);
    s.on("data", () => {});
    const closed = new Promise<string>((ok) => (s.on("close", () => ok("closed")), s.on("error", () => ok("closed"))));
    expect(await Promise.race([closed, Bun.sleep(8_000).then(() => "open")])).toBe("closed");
    s.destroy();
  });
}, 15_000);

test("stories 340, 352, 356: a slot not in the terminal, still switching to it, or whose Herdr restarts gets its handshake, then 4000, no Herdr run; one in it runs Herdr's terminal session control at the page's size, in range, 80x24 by default, and one that cannot start closes with 4002 and why; /api/slot says whether Herdr restarts; the page may run WebAssembly", async () => {
  await withWeb(async (at, web, store, dir) => {
    const ws = store.tx((tx) => tx.insert("workspace", { name: "w", dir: "/w" }).id);
    const slot = (name: string, more: Partial<Slot>) => store.tx((tx) => tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", ...more }).id);
    const headless = slot("headless", {});
    const switching = slot("switching", { mode: "tui" });
    const lost = slot("lost", { mode: "tui", herdrPane: "w1:p2", tuiPid: 1, herdrLostAt: Date.now() });
    const term = slot("term", { mode: "tui", herdrPane: "w1:p3", tuiPid: 1 });
    for (const s of [headless, switching, lost, "NOSUCHSLOT"]) {
      const closed = await terminal(at, s).closed;
      expect([s, closed.code]).toEqual([s, 4000]);
    }
    expect(existsSync(join(dir, "ran"))).toBe(false);

    const herdrLost = async (id: string) => ((await (await get(`/api/slot?id=${id}`, BOARD_LOGIN, {}, undefined, at)).json()) as { herdrLost: boolean }).herdrLost;
    expect([await herdrLost(lost), await herdrLost(term), await herdrLost(headless)]).toEqual([true, false, false]);
    // #381: its card on the board says which pane its chat shows, for a page to draw that before /api/slot answers.
    const board = (await (await get("/api/board", BOARD_LOGIN, {}, undefined, at)).json()) as BoardData;
    expect(Object.fromEntries(Object.values(board.workspaces[0]!.groups).flat().map((c) => [c.name, c.terminal]))).toEqual({ headless: null, switching: null, lost: null, term: "w1:p3" });
    store.tx((tx) => tx.update("slot", { id: lost }, { herdrLostAt: null }));
    expect(await herdrLost(lost)).toBe(false);

    const failed = await terminal(at, term, "&cols=999&rows=1").closed;
    expect(failed).toEqual({ code: 4002, reason: "herdr: failed to connect to server: No such file or directory (os error 2)" });
    await terminal(at, term, "").closed;
    await terminal(at, term, "&cols=x&rows=30").closed;
    // Not the board's looks for Herdr's socket, to wake it (#380).
    expect(readFileSync(join(dir, "ran"), "utf8").trim().split("\n").filter((l) => l !== "session list --json")).toEqual([
      "--session rhodium-test-none terminal session control w1:p3 --takeover --cols 500 --rows 2",
      "--session rhodium-test-none terminal session control w1:p3 --takeover --cols 80 --rows 24",
      "--session rhodium-test-none terminal session control w1:p3 --takeover --cols 80 --rows 30",
    ]);

    // Why, in the 123 bytes a close gives it, no character cut in two.
    const long = slot("long", { mode: "tui", herdrPane: "w1:long", tuiPid: 1 });
    expect(await terminal(at, long).closed).toEqual({ code: 4002, reason: "a" + "终".repeat(40) });

    writeFileSync(join(web, "index.html"), "<!doctype html><title>Rhodium</title>");
    expect((await get("/", BOARD_LOGIN, {}, undefined, at)).headers.get("content-security-policy")).toBe("frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'");
  });
});
