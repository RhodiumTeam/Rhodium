// The local pictures and file links in what an agent said, on the board (stories 600-604, spec
// web-images "回复里的本机图片和文件链接"): each block's table of them, the copies kept, and /api/file.
import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { serveBoard, type BoardData } from "../src/board";
import { loadConfig } from "../src/config";
import { saidPictures } from "../src/reply-images";
import { openStore, type Slot, type Store } from "../src/store";
import { sessionsDir, type Local } from "../src/transcript";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { BOARD_LOGIN, newInstance, until } from "./instance";

const sha = (data: Uint8Array | string) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
/** A PNG's first bytes and then anything: a picture by them, each tag another content. */
const png = (tag: string) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tag)]);
// Outside the slot's directory and /tmp.
const out = mkdtempSync("/var/tmp/rhodium-test-local-");
afterAll(() => rmSync(out, { recursive: true, force: true }));

type Said = { kind: string; text?: string; local?: Local };
type Board = {
  dir: string;
  /** The slot's directory, under /tmp. */
  slot: string;
  media: string;
  store: Store;
  conversation: string;
  /** Appends what the agent said to the slot's transcript, as written at time. */
  say(time: number, text: string): void;
  /** The page's blocks of what the agent said, each with its table. */
  page(): Promise<Said[]>;
  get(path: string, site?: string): Promise<Response>;
  /** The main loop's check as a message is whole (src/daemon.ts), at now. */
  whole(text: string, now: number): boolean;
  /** Rhodium stops and starts again. */
  restart(): void;
  rows(): { path: string; by: string; hash: string | null; why: string | null }[];
};

/** A board over a store with one slot in mode, whose pi conversation the test writes. */
async function withBoard(mode: Slot["mode"], fn: (b: Board) => Promise<void>) {
  const dir = mkdtempSync("/tmp/rhodium-test-local-");
  const home = process.env.HOME;
  process.env.HOME = dir;
  const slot = join(dir, "slot");
  mkdirSync(slot);
  writeFileSync(join(dir, "config.toml"), `stateDir = "${dir}/state"\n[herdr]\nsession = "rhodium-test-none"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
  const cfg = loadConfig(join(dir, "config.toml"));
  let store = openStore(join(dir, "rh.db"));
  let server = serveBoard(store, cfg, new Set(), join(dir, "web")).servers[0]!;
  const [id, conversation] = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: tx.insert("workspace", { name: "w", dir: slot }).id, name: "pics", dir: slot, mode, state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "s1", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return [id, conversation];
  });
  const file = join(sessionsDir(slot, "pi"), "2026-11-10_s1.jsonl");
  mkdirSync(join(file, ".."), { recursive: true });
  const get = (path: string, site = "same-origin") => fetch(`http://127.0.0.1:${server.port}${path}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "Sec-Fetch-Site": site } });
  try {
    await fn({
      dir,
      slot,
      media: join(dir, "state/media"),
      get store() {
        return store;
      },
      conversation,
      say: (time, text) => appendFileSync(file, JSON.stringify({ type: "message", timestamp: new Date(time).toISOString(), message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n"),
      page: async () => ((await (await get(`/api/messages?slot=${id}`)).json()) as { blocks: Said[] }).blocks.filter((b) => b.kind === "assistant"),
      get,
      whole: (text, now) => store.tx((tx) => saidPictures(tx, join(dir, "state/media"), conversation, text, now)),
      restart() {
        void server.stop(true);
        store.close();
        store = openStore(join(dir, "rh.db"));
        server = serveBoard(store, cfg, new Set(), join(dir, "web")).servers[0]!;
      },
      rows: () => store.tx((tx) => tx.find("replyImage", {})).map(({ path, by, hash, why }) => ({ path, by, hash, why })),
    });
  } finally {
    process.env.HOME = home;
    void server.stop(true);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("stories 600-602, 604: what was said with no one looking, an hour ago, is checked as it is first read, by two pages at once too: a picture in /tmp, one with a Chinese name, kept, and one not there, why; both stay so once the files change and rhodium restarts, the copies still served; a copy pruned says so and is not checked again; an address elsewhere is in no table", async () => {
  await withBoard("headless", async (b) => {
    const [shot, cn] = [join(b.dir, "shot.png"), join(b.dir, "截图.png")];
    writeFileSync(shot, png("first"));
    writeFileSync(cn, png("中文"));
    b.say(Date.now() - 3_600_000, `看 ![图](${shot})、![截图](${cn})、![没有](${b.dir}/none.png)、![again](${shot}) 和 ![图](data:image/png;base64,AAAA)、[邮件](mailto:a@b.c)`);
    const images: Local["images"] = { [shot]: { kind: "image", hash: sha(png("first")), name: "shot.png" }, [cn]: { kind: "image", hash: sha(png("中文")), name: "截图.png" }, [`${b.dir}/none.png`]: { why: "找不到文件" } };
    const [one, two] = await Promise.all([b.page(), b.page()]);
    expect(one[0]!.local).toEqual({ images, links: {} });
    expect(two).toEqual(one);
    expect(b.rows().map((r) => [r.path, r.by])).toEqual([[shot, "board"], [cn, "board"], [`${b.dir}/none.png`, "board"]]);
    // The list's line has a picture as its words.
    expect(((await (await b.get("/api/board")).json()) as BoardData).workspaces[0]!.groups.idle[0]!.last!.text).toBe("看 图、截图、没有、again 和 图、邮件");

    writeFileSync(shot, png("second"));
    writeFileSync(join(b.dir, "none.png"), png("late"));
    rmSync(cn);
    b.restart();
    expect((await b.page())[0]!.local!.images).toEqual(images);
    expect(Buffer.from(await (await b.get(`/api/media?h=${sha(png("first"))}`)).bytes())).toEqual(png("first"));
    expect(b.rows()).toHaveLength(3);

    // Pruned after 90 days (architecture §7.8): the row stays, so the file there now does not take its place.
    rmSync(join(b.media, sha(png("first"))));
    expect((await b.page())[0]!.local!.images[shot]).toEqual({ gone: true });
    expect(b.rows()).toHaveLength(3);
  });
});

test("stories 600, 602: a headless slot's block just written waits for the main loop's check, pending, and has it once that wrote its rows, a copy or why; the same path said in two messages two minutes apart, the file changed between, each has its own copy", async () => {
  await withBoard("headless", async (b) => {
    const [shot, far] = [join(b.dir, "shot.png"), join(out, "far.png")];
    writeFileSync(far, png("far"));
    const now = Date.now();
    const said = `![图](${shot})`;
    // Two minutes apart, word for word; the main loop checks each a second after it is written.
    writeFileSync(shot, png("one"));
    b.say(now - 600_000, said);
    expect(b.whole(said, now - 599_000)).toBe(true);
    writeFileSync(shot, png("two"));
    b.say(now - 480_000, said);
    b.whole(said, now - 479_000);
    // Just written: the page reads the block before the main loop wrote its rows.
    writeFileSync(shot, png("three"));
    b.say(now, `![图](${shot}) ![外面](${far})`);
    const hashes = async () => (await b.page()).map((s) => s.local!.images[shot]);
    expect(await hashes()).toMatchObject([{ hash: sha(png("one")) }, { hash: sha(png("two")) }, { pending: true }]);
    expect((await b.page())[2]!.local!.images[far]).toEqual({ pending: true });
    b.whole(`![图](${shot}) ![外面](${far}) ![图](${shot})`, Date.now());
    expect(await hashes()).toMatchObject([{ hash: sha(png("one")) }, { hash: sha(png("two")) }, { hash: sha(png("three")) }]);
    expect((await b.page())[2]!.local!.images[far]).toEqual({ why: "不在槽位目录或 /tmp 里" });
    expect(b.rows().map((r) => r.by)).toEqual(["loop", "loop", "loop", "loop"]);
  });
});

test("story 602: a picture that passes whose copy cannot be kept gets no row and is pending, for the main loop and the board alike; once copies can be kept, read again, it has its address", async () => {
  await withBoard("headless", async (b) => {
    const shot = join(b.dir, "shot.png");
    writeFileSync(shot, png("one"));
    mkdirSync(join(b.dir, "state"), { recursive: true });
    writeFileSync(b.media, "in the way of the media dir");
    b.say(Date.now() - 3_600_000, `![图](${shot})`);
    expect(b.whole(`![图](${shot})`, Date.now() - 3_599_000)).toBe(false);
    expect((await b.page())[0]!.local!.images[shot]).toEqual({ pending: true });
    expect(b.rows()).toEqual([]);
    rmSync(b.media);
    expect((await b.page())[0]!.local!.images[shot]).toMatchObject({ hash: sha(png("one")) });
  });
});

test("story 602: a picture whose row cannot be written, the disk full say, is pending and the rest of the conversation still reads; read again once it can, it has its address", async () => {
  await withBoard("tui", async (b) => {
    const shot = join(b.dir, "shot.png");
    writeFileSync(shot, png("one"));
    b.say(Date.now() - 3_600_000, `![图](${shot}) 说完了`);
    const db = new Database(join(b.dir, "rh.db"));
    db.run("CREATE TRIGGER full BEFORE INSERT ON replyImage BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    expect(await b.page()).toMatchObject([{ text: `![图](${shot}) 说完了`, local: { images: { [shot]: { pending: true } } } }]);
    db.run("DROP TRIGGER full");
    db.close();
    expect((await b.page())[0]!.local!.images[shot]).toMatchObject({ hash: sha(png("one")) });
  });
});

test("story 604: what a slot in the terminal just said is checked as it is read, with no wait; the same path said twice 30 s apart, each block read before the file changed again, each has its own copy, after a restart too", async () => {
  await withBoard("tui", async (b) => {
    const shot = join(b.dir, "shot.png");
    const now = Date.now();
    writeFileSync(shot, png("one"));
    b.say(now - 30_000, `![图](${shot})`);
    expect((await b.page())[0]!.local!.images[shot]).toEqual({ kind: "image", hash: sha(png("one")), name: "shot.png" });
    writeFileSync(shot, png("two"));
    b.say(now, `![图](${shot})`);
    const hashes = async () => (await b.page()).map((s) => (s.local!.images[shot] as { hash?: string }).hash);
    expect(await hashes()).toEqual([sha(png("one")), sha(png("two"))]);
    b.restart();
    expect(await hashes()).toEqual([sha(png("one")), sha(png("two"))]);
  });
});

test("story 603: a link to a file in the slot's directory can be downloaded, one outside it or not there cannot, one to a line is a code reference; /api/file gives the file as it is now, a Chinese name too, always as a download, to the board's own page alone, and nothing outside the slot's directory and /tmp, nor a code reference", async () => {
  await withBoard("headless", async (b) => {
    writeFileSync(join(b.slot, "notes.md"), "v1\n");
    writeFileSync(join(b.slot, "笔记 1.html"), "<script>alert(1)</script>");
    writeFileSync(join(b.slot, "a.ts:12"), "a file named as a line\n");
    writeFileSync(join(out, "secret.txt"), "outside\n");
    b.say(Date.now() - 3_600_000, `[笔记](notes.md) [中文](<笔记 1.html>) [外面](${out}/secret.txt) [没有](none.md) [a.ts:12](a.ts:12) [第 3 行](notes.md#L3) [站](https://a.example/x)`);
    expect((await b.page())[0]!.local).toEqual({ images: {}, links: { "notes.md": "file", "笔记 1.html": "file", [`${out}/secret.txt`]: "none", "none.md": "none", "a.ts:12": "code", "notes.md#L3": "code" } });
    expect(b.rows()).toEqual([]);

    const file = (path: string, site?: string, conversation = b.conversation) => b.get(`/api/file?conversation=${conversation}&path=${encodeURIComponent(path)}`, site);
    const r = await file("notes.md");
    expect([r.status, await r.text()]).toEqual([200, "v1\n"]);
    expect(["content-type", "content-disposition", "x-content-type-options", "cache-control"].map((h) => r.headers.get(h))).toEqual(["application/octet-stream", "attachment", "nosniff", "no-store"]);
    writeFileSync(join(b.slot, "notes.md"), "v2\n");
    expect(await (await file("notes.md")).text()).toBe("v2\n");
    const html = await file("笔记 1.html");
    expect([html.status, html.headers.get("content-type"), await html.text()]).toEqual([200, "application/octet-stream", "<script>alert(1)</script>"]);
    expect((await file(`${b.slot}/notes.md`)).status).toBe(200);
    for (const path of [`${out}/secret.txt`, `../../../..${out}/secret.txt`, "/etc/hostname", "none.md", "a.ts:12", ".", ""]) expect([path, (await file(path)).status]).toEqual([path, 404]);
    expect((await file("notes.md", undefined, "no-such-conversation")).status).toBe(404);
    for (const site of ["cross-site", "same-site"]) expect((await file("notes.md", site)).status).toBe(403);
  });
});

test("stories 600-602: a headless agent says two local pictures, one in /tmp and one outside; once its message is whole the main loop has checked both, and the board tells the slot's pages, whose block has one's copy and why not the other; with the file gone and rhodium restarted, the same copy; deleting the slot deletes its rows", async () => {
  const shots = mkdtempSync("/tmp/rhodium-test-local-");
  writeFileSync(join(shots, "截图.png"), png("shot"));
  writeFileSync(join(out, "far.png"), png("far"));
  const reply = `好了 ![截图](${shots}/截图.png) ![外面](${out}/far.png)`;
  const rhodium = newInstance({ bots: { q: { like: "qq", owner: "you-openid", target: "w/d" } }, claude: { script: { on, steps: [...startTurn, ...endTurn(reply)] } } });
  try {
    let at = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
    await rhodium.slots("a", "d");
    const get = (path: string) => fetch(at + path, { headers: { "Tailscale-User-Login": BOARD_LOGIN, "Sec-Fetch-Site": "same-origin" } });
    const slot = ((await (await get("/api/board")).json()) as { workspaces: { groups: { idle: { id: string; name: string }[] } }[] }).workspaces[0]!.groups.idle.find((c) => c.name === "a")!.id;
    // A page following the slot hears that the pictures' rows are written.
    const stream = await get(`/api/events?slot=${slot}`);
    let heard = "";
    void (async () => {
      for await (const chunk of stream.body!) heard += new TextDecoder().decode(chunk);
    })().catch(() => {});
    await rhodium.im.inject("q", { chat: "you-openid", sender: "you-openid", text: "/rh_use a" });
    await rhodium.im.inject("q", { chat: "you-openid", sender: "you-openid", text: "截个图" });
    await until(() => heard.includes("event: pictures"), 15_000);
    const images = async () => ((await (await get(`/api/messages?slot=${slot}`)).json()) as { blocks: Said[] }).blocks.find((b) => b.kind === "assistant")!.local!.images;
    const want: Local["images"] = { [`${shots}/截图.png`]: { kind: "image", hash: sha(png("shot")), name: "截图.png" }, [`${out}/far.png`]: { why: "不在槽位目录或 /tmp 里" } };
    expect(await images()).toEqual(want);

    rmSync(shots, { recursive: true });
    await rhodium.stop();
    at = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
    expect(await images()).toEqual(want);
    expect(Buffer.from(await (await get(`/api/media?h=${sha(png("shot"))}`)).bytes())).toEqual(png("shot"));

    const rows = () => {
      const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
      try {
        return (db.query("SELECT by FROM replyImage").all() as { by: string }[]).map((r) => r.by);
      } finally {
        db.close();
      }
    };
    expect(rows()).toEqual(["loop", "loop"]);
    await rhodium.ok("archive", "w/a");
    await until(async () => (await rhodium.state("w/a")) === "未运行（已归档）", 15_000);
    await rhodium.ok("rm", "w/a");
    expect(rows()).toEqual([]);
  } finally {
    await rhodium.cleanup();
    rmSync(shots, { recursive: true, force: true });
  }
}, 60_000);
