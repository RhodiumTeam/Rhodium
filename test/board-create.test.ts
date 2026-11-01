// New slots and imports from the board (spec web-write, its ninth ticket): rh ws, rh new and rh import as
// the page sends them, the new slot's id in the answer for the page to open its chat; what there is to
// import as IM's panel lists it, for the directory of the workspace picked. Seen from seam one, through
// the board's HTTP, with a fake Herdr and a conversation on disk copied from a real transcript.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeProjectDir } from "./fake-agent/fake-agent";
import { BOARD_LOGIN, boardAct, newInstance } from "./instance";

const ME = "you-openid";
const rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, herdr: true });
let base = "";
beforeAll(async () => {
  base = `http://${(await rhodium.start()).logs.find((l) => l.msg === "ready")!.board}`;
  await rhodium.slots("a");
}, 30_000);
afterAll(() => rhodium.cleanup());

type Reply = { ok: true; text: string; slot?: string; panel?: { head: string[]; candidates: { label: string; command: string }[] } } | { ok: false; error: string };
const act = async (a: unknown): Promise<Reply> => (await boardAct(base, a)).json() as Promise<Reply>;
type Board = { workspaces: { name: string; dir: string; groups: Record<string, { id: string; ref: string; agent: string | null }[]> }[] };
const board = async () => (await fetch(`${base}/api/board`, { headers: { "Tailscale-User-Login": BOARD_LOGIN } })).json() as Promise<Board>;
const card = async (ref: string) => (await board()).workspaces.flatMap((w) => Object.values(w.groups).flat()).find((c) => c.ref === ref);

test("story 320: a workspace made on the board, its directory under ~ as you write it, then a slot in it with the agent picked: the answer has the new slot's id; IM hears nothing", async () => {
  const ws = await act({ kind: "rh", argv: ["ws", "proj", "~/proj"] });
  expect(ws.ok).toBe(true);
  expect((await board()).workspaces.find((w) => w.name === "proj")!.dir).toBe(join(rhodium.home, "proj"));

  const r = await act({ kind: "rh", argv: ["new", "proj/s", "--agent", "pi"] });
  const made = (await card("proj/s"))!;
  expect([r.ok && r.slot, made.agent]).toEqual([made.id, "pi"]);
  expect(await rhodium.im.log("q", ME)).toEqual([]);
});

test("story 321: the board lists what there is to import for a directory under ~ as you write it, as IM's panel does; one picked and named is imported, in a workspace made for the directory, the answer with the new slot's id", async () => {
  const dir = join(rhodium.home, "imports");
  mkdirSync(dir, { recursive: true });
  // A real transcript under the sandbox HOME, as a conversation you started in dir.
  const fixtures = join(import.meta.dir, "fixtures/transcripts/claude");
  const [file] = readdirSync(fixtures);
  const old = file!.replace(/\.jsonl$/, "").replace(/^[^_]*_/, "");
  const session = crypto.randomUUID();
  const into = join(rhodium.home, ".claude/projects", claudeProjectDir(dir));
  mkdirSync(into, { recursive: true });
  writeFileSync(join(into, file!.replace(old, session)), readFileSync(join(fixtures, file!), "utf8").replace(/"cwd":"[^"]*"/g, `"cwd":${JSON.stringify(dir)}`).replaceAll(old, session));

  const listed = await act({ kind: "rh", argv: ["import", "--dir", "~/imports"] });
  expect(listed.ok && listed.panel!.candidates.map((c) => c.command)).toEqual([`/rh_import ${session} --name`]);

  const r = await act({ kind: "rh", argv: ["import", session, "--name", "picked"] });
  expect(r.ok && r.slot).toBe((await card("imports/picked"))!.id);
  expect(await rhodium.im.log("q", ME)).toEqual([]);
}, 30_000);

test("stories 538-542: /api/dirs, to the board's own page alone, lists a folder by its real path under ~: its folders, hidden ones last, a link by where it leads, a broken one left out, at most 500; its first 8 files; its git branch, a worktree's too; the workspace it is the default dir of, through a link too, with its slots, else a new one's name", async () => {
  const home = rhodium.home;
  const dirs = (path: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) => fetch(`${base}/api/dirs?path=${encodeURIComponent(path)}`, { headers: { "Tailscale-User-Login": BOARD_LOGIN, ...headers } });
  const get = async (path: string) => (await dirs(path)).json();
  mkdirSync(join(home, "repo/.git/worktrees/wt"), { recursive: true });
  writeFileSync(join(home, "repo/.git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(home, "repo/.git/worktrees/wt/HEAD"), "ref: refs/heads/side\n");
  for (const d of ["b", ".a", "a", "w"]) mkdirSync(join(home, "repo/mix", d), { recursive: true });
  mkdirSync(join(home, "elsewhere"));
  symlinkSync(join(home, "elsewhere"), join(home, "repo/mix/link"));
  symlinkSync(join(home, "nowhere"), join(home, "repo/mix/broken"));
  writeFileSync(join(home, "repo/mix/f.txt"), "");
  mkdirSync(join(home, "wt"));
  writeFileSync(join(home, "wt/.git"), `gitdir: ${join(home, "repo/.git/worktrees/wt")}\n`);
  for (let i = 0; i < 501; i++) mkdirSync(join(home, "many", `d${i}`), { recursive: true });
  for (let i = 0; i < 9; i++) writeFileSync(join(home, "many", `f${i}`), "");

  expect((await dirs("~/repo/mix", {})).status).toBe(403);
  expect(await get("~/repo/mix")).toMatchObject({ path: "~/repo/mix", up: "~/repo", dirs: ["a", "b", "link", "w", ".a"], more: 0, files: ["f.txt"], moreFiles: 0, branch: "main", workspace: "mix", fresh: true, slots: 0 });
  expect(await get("~/repo/mix/link")).toMatchObject({ path: "~/elsewhere", workspace: "elsewhere" });
  expect(await get("~/wt")).toMatchObject({ branch: "side" });
  // w is taken.
  expect(await get("~/repo/mix/w")).toMatchObject({ workspace: "w-2", fresh: true });
  expect(await get(join(home, "../w"))).toMatchObject({ path: join(home, "../w"), workspace: "w", fresh: false, slots: 1 });
  const many = await get("~/many");
  expect([many.dirs.length, many.more, many.files.length, many.moreFiles]).toEqual([500, 1, 8, 1]);
  expect(await get("~/nope")).toMatchObject({ path: "~/nope", up: "~", dirs: [], error: "没有这个目录" });
  // A workspace whose dir is a link: the folder it leads to is its, with its slots.
  mkdirSync(join(home, "real"));
  symlinkSync(join(home, "real"), join(home, "lw"));
  expect((await act({ kind: "rh", argv: ["ws", "lw", "~/lw"] })).ok).toBe(true);
  expect((await act({ kind: "rh", argv: ["new", "lw/s", "--agent", "pi"] })).ok).toBe(true);
  expect(await get("~/real")).toMatchObject({ path: "~/real", workspace: "lw", fresh: false, slots: 1 });
}, 30_000);
