// Daily backups, the retention cleanup, rh trace and the free disk threshold (architecture §7.8,
// §12), seen from seam one.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { newInstance, until, withoutSource, type Instance, type InstanceOptions } from "./instance";

const ME = "you-openid";
/** A claude that makes the rh calls its message lists. */
const obey: Script = { on, steps: [...startTurn, { rhFrom: "in.message.content.0.text" }, ...endTurn("done"), { goto: 0 }] };

let rhodium: Instance;
afterEach(() => rhodium.cleanup());

/** What the slot's claude runs were told, oldest first. */
const told = (ref: string) =>
  rhodium.claude
    .runs()
    .filter((r) => r.env.RHODIUM_SLOT === ref)
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)).filter((m) => m.type === "user"))
    .map((m) => withoutSource(m.message.content[0].text) as string);

test("story 155: at each backup time the database is backed up, only the newest 14 are kept, and a backup opens", async () => {
  rhodium = newInstance({ toml: '[durations]\nbackupEvery = "1s"' });
  // 14 old backups already there, and a file that is not a backup.
  const dir = join(rhodium.dir, "state/backup");
  mkdirSync(dir, { recursive: true });
  const old = Array.from({ length: 14 }, (_, i) => `rh-2000-01-${String(i + 1).padStart(2, "0")}T00-00-00-000Z.db`);
  for (const f of old) writeFileSync(join(dir, f), "old");
  writeFileSync(join(dir, "notes.txt"), "mine");
  await rhodium.start();
  await rhodium.slots("a");

  // A backup is put in place before the oldest goes, and the next one is written beside its name
  // first (#319): wait for one listing between backups, after at least 2 new ones, and check it.
  let files: string[] = [];
  const backups = () => files.filter((f) => f.endsWith(".db"));
  const added = () => backups().filter((f) => !old.includes(f)).length;
  await until(() => {
    files = readdirSync(dir).sort();
    return backups().length === 14 && !files.some((f) => f.endsWith(".tmp")) && added() >= 2;
  }, 5_000);
  expect(backups().slice(0, 14 - added())).toEqual(old.slice(added()));
  expect(files).toContain("notes.txt");

  const db = new Database(join(dir, backups().at(-1)!), { readonly: true });
  try {
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
    expect(db.query("SELECT name FROM slot").all()).toEqual([{ name: "a" }]);
  } finally {
    db.close();
  }
}, 15_000);

test("story 153: rh trace prints which slot a message went to, why, and how its delivery and reply went", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  const { messageId } = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);

  // By the platform's message id, or by the trace id it prints.
  const out = await rhodium.ok("trace", messageId);
  const trace = out.match(/^消息 (\S+)：/)?.[1];
  expect(out).toContain(`平台消息 ID ${messageId}`);
  expect(out).toMatch(/^去向：w\/a（起进程，开始新回合）$/m);
  expect(out).toMatch(/^投给 agent：w\/a，agent 已收下$/m);
  expect(out).toMatch(/^发送：已发，平台消息 ID \S+/m);
  expect(out).toMatch(/^ {2}.* im_routed w\/a /m);
  expect(out).toMatch(/^ {2}.* final_reply w\/a$/m);
  expect(await rhodium.ok("trace", trace!)).toBe(out);

  // A stranger's message goes nowhere, and says why.
  const stranger = await rhodium.im.inject("q", { chat: "stranger", sender: "stranger", text: "hi" });
  await until(async () => (await rhodium.rh(["trace", stranger.messageId])).code === 0);
  const ignored = await rhodium.ok("trace", stranger.messageId);
  expect(ignored).toMatch(/^去向：没有投给槽位（忽略：不是本人）$/m);
  expect(ignored).toMatch(/^投给 agent：没有$/m);
  expect(ignored).toMatch(/^发送：没有$/m);

  const unknown = await rhodium.rh(["trace", "no-such-message"]);
  expect(unknown.code).toBe(1);
  expect(unknown.err).toContain("没有找到");
}, 30_000);

test("past their keep times, inbound messages, outbound records with their quoted text, and events are deleted; newer ones stay", async () => {
  rhodium = newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" } },
    toml: '[durations]\nbackupEvery = "1s"\ninboundKeep = "5s"\neventKeep = "15s"',
  });
  await rhodium.start();
  await rhodium.slots("a");
  const say = async (text: string, quote?: string) => {
    const n = (await rhodium.im.log("q", ME)).length;
    const sent = await rhodium.im.inject("q", { chat: ME, sender: ME, text, ...(quote && { quote: { ref: quote } }) });
    await until(async () => (await rhodium.im.log("q", ME)).length === n + 1, 15_000);
    const traced = await rhodium.ok("trace", sent.messageId);
    return { ...sent, trace: traced.match(/^消息 (\S+)：/)![1]!, reply: (await rhodium.im.log("q", ME)).at(-1)!.messageId };
  };
  const a = await say("the secret word is plum");

  // Inbound and outbound records go after 5s; the events stay till 15s.
  const traceOf = async (id: string) => {
    const r = await rhodium.rh(["trace", id]);
    return r.code === 0 ? r.out : r.err;
  };
  await until(async () => /没有它的入站记录[\s\S]*^发送：没有$/m.test(await traceOf(a.trace)), 12_000);
  expect(await traceOf(a.trace)).toMatch(/^ {2}.* im_routed w\/a /m);

  // Quoting them finds no text now. A newer message has all its records.
  const b = await say("what did I say, and you?", a.messageId);
  const fresh = await traceOf(b.messageId);
  expect(fresh).toMatch(/^去向：w\/a（/m);
  expect(fresh).toMatch(/^发送：已发/m);
  await say("and you?", a.reply);
  expect(told("w/a").slice(-2)).toEqual(["> （找不到引用的原文）\n\nwhat did I say, and you?", "> （找不到引用的原文）\n\nand you?"]);

  await until(async () => /^事件：没有$/m.test(await traceOf(a.trace)), 15_000);
  expect(await traceOf(b.trace)).toMatch(/^ {2}.* im_routed w\/a /m);
}, 45_000);

const DAY = 86_400_000;
const holdDir = () => join(rhodium.dir, "state/hold");
/** Sets every file in the hold dir as last written ago ms ago. */
function age(dir: string, ago: number): void {
  const t = new Date(Date.now() - ago);
  for (const f of readdirSync(join(holdDir(), dir))) utimesSync(join(holdDir(), dir, f), t, t);
}
/** The hold dir of a conversation no slot has, its agent long gone: bytes of out.log, written ago ms ago. */
function ended(dir: string, bytes: number, ago = 0): void {
  mkdirSync(join(holdDir(), dir), { recursive: true });
  writeFileSync(join(holdDir(), dir, "out.log"), Buffer.alloc(bytes));
  age(dir, ago);
}
/** Bot q goes to w/a; the cleanup runs each second, with a size cap of 1MB, and your messages are kept whole. */
const capped = (opts: InstanceOptions = {}) =>
  newInstance({
    bots: { q: { like: "qq", owner: ME, target: "w/a" } },
    toml: '[durations]\nbackupEvery = "1s"\n[limits]\nstateMaxMB = 1\nquoteMaxChars = 2000000',
    ...opts,
  });

test("past the size cap, the oldest records and ended hold dirs go first till the rest fits; what is in use stays; each cleanup says what went (2026-10-21)", async () => {
  rhodium = capped();
  const hold = holdDir();
  ended("ancient", 1000, 8 * DAY); // past durations.holdDirKeep: it goes, small as it is
  await rhodium.start();
  await rhodium.slots("a");
  // Your message's text is kept whole (quoteMaxChars): its inbound record is some 600KB.
  const sent = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "x".repeat(600_000) });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  const trace = (await rhodium.ok("trace", sent.messageId)).match(/^消息 (\S+)：/)![1]!;
  // The slot's current conversation: its dir stays, however old, its agent stopped.
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  const [current] = readdirSync(hold).filter((d) => d !== "ancient");
  age(current!, 30 * DAY);
  await until(() => !existsSync(join(hold, "ancient")), 5_000);

  // Under the cap, nothing else goes.
  ended("old", 300_000, 2 * DAY);
  await Bun.sleep(1500);
  expect(existsSync(join(hold, "old"))).toBe(true);
  // Over it: the oldest first, the old dir before the message's records, and no more than that.
  ended("new", 300_000);
  await until(() => !existsSync(join(hold, "old")), 5_000);
  expect(await rhodium.ok("trace", trace)).toMatch(/^去向：w\/a/m);
  // Over it again: the message's records are the oldest now.
  ended("newer", 400_000);
  // Records go by the minute: the reply and the turn's events may be a minute on, and stay.
  await until(async () => (await rhodium.ok("trace", trace)).includes("没有它的入站记录"), 5_000);
  expect(readdirSync(hold).sort()).toEqual([current!, "new", "newer"].sort());

  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  try {
    const said = db.query("SELECT data FROM event WHERE type = 'state_pruned' ORDER BY seq").all() as { data: string }[];
    expect(JSON.parse(said.at(-1)!.data)).toMatchObject({ inbound: 1, holdDirs: 0 });
    expect(JSON.parse(said.at(-1)!.data).bytes).toBeGreaterThan(600_000);
  } finally {
    db.close();
  }
}, 45_000);

/** Puts the cleanup over the cap with an old hold dir that goes first and a new one, and waits for it to
 *  run: past the old dir, it gets to the records, of some 600KB here. */
async function overTheCap(): Promise<void> {
  ended("old", 100_000, 2 * DAY);
  ended("new", 500_000);
  await until(() => !existsSync(join(holdDir(), "old")), 5_000);
}

test("past the size cap, a message not sent yet and every record newer than it stay (2026-10-21)", async () => {
  rhodium = capped();
  await rhodium.start();
  await rhodium.slots("a");
  // The platform takes the reply to hello but never answers: it is still being sent.
  await rhodium.im.next("q", "hang", "send");
  const hello = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  const trace = (await rhodium.ok("trace", hello.messageId)).match(/^消息 (\S+)：/)![1]!;
  // A newer message of some 600KB, whose turn is over, its reply waiting behind hello's.
  const big = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "x".repeat(600_000) });
  await until(async () => (await rhodium.rh(["trace", big.messageId])).code === 0 && (await rhodium.state("w/a")) === "空闲", 15_000);

  await overTheCap();
  expect(await rhodium.ok("trace", trace)).toMatch(/^发送：发送中/m);
  expect(await rhodium.ok("trace", big.messageId)).toMatch(/^去向：w\/a[\s\S]*^发送：待发/m);
}, 45_000);

test("past the size cap, the message a turn under way began and every record newer than it stay (2026-10-21)", async () => {
  rhodium = capped({ claude: { script: "until-interrupted" } });
  await rhodium.start();
  await rhodium.slots("a");
  const big = await rhodium.im.inject("q", { chat: ME, sender: ME, text: "x".repeat(600_000) });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);

  await overTheCap();
  expect(await rhodium.ok("trace", big.messageId)).toMatch(/^去向：w\/a/m);
  expect(await rhodium.state("w/a")).toBe("运行中");
}, 45_000);

test("the hold dir of a conversation no slot is on any more stays while its agent has not exited (2026-10-21)", async () => {
  // The agent ignores SIGTERM mid-turn, so after /new it runs on for stopGrace before it is killed.
  const script: Script = { on, steps: [{ ignore: "SIGTERM" }, ...startTurn, { sleep: 60_000 }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script }, toml: '[durations]\nbackupEvery = "1s"\nstopGrace = "30s"' });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "work" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);
  const [left] = readdirSync(holdDir());
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "/new" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);

  // Past holdDirKeep, as the ancient one beside it, which goes.
  age(left!, 30 * DAY);
  ended("ancient", 1000, 8 * DAY);
  await until(() => !existsSync(join(holdDir(), "ancient")), 5_000);
  expect(existsSync(join(holdDir(), left!))).toBe(true);
  expect(() => process.kill(rhodium.claude.runs()[0]!.pid, 0)).not.toThrow(); // the agent is still there
}, 45_000);

test("story 570: a kept picture or file goes, with what was made of it, 90 days after it was last stored; one younger, or stored again since, stays; the cleanup says how many went", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, toml: '[durations]\nbackupEvery = "1d"' });
  const media = join(rhodium.dir, "state/media");
  /** data kept in the media dir, last stored ago ms ago, with a copy made of it under each of made; its name. */
  const kept = (data: string, ago: number, made: string[] = []) => {
    const name = new Bun.CryptoHasher("sha256").update(data).digest("hex");
    for (const sub of ["", ...made]) {
      mkdirSync(join(media, sub), { recursive: true });
      writeFileSync(join(media, sub, name), data);
    }
    const t = new Date(Date.now() - ago);
    utimesSync(join(media, name), t, t);
    return name;
  };
  const old = kept("old", 91 * DAY, ["preview", "view", "agent"]);
  const young = kept("young", 89 * DAY, ["preview"]);
  const again = kept("again", 91 * DAY);
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "this again", attachments: [{ kind: "file", name: "a.txt", data: Buffer.from("again") }] });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  // Each second from now on: the cleanup a day after the first start comes as soon as rhodium is back.
  await rhodium.kill9();
  writeFileSync(rhodium.config, readFileSync(rhodium.config, "utf8").replace('backupEvery = "1d"', 'backupEvery = "1s"'));
  await rhodium.start();

  // The event is the cleanup's last step: once it is there, all that goes has gone.
  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const said = () => db.query("SELECT data FROM event WHERE type = 'state_pruned'").all() as { data: string }[];
  try {
    await until(() => said().length > 0, 5_000);
    expect(said().map((e) => JSON.parse(e.data).media)).toEqual([1]);
  } finally {
    db.close();
  }
  expect(["", "preview", "view", "agent"].map((sub) => readdirSync(join(media, sub)).filter((f) => !["preview", "view", "agent"].includes(f)).sort())).toEqual([[again, young].sort(), [young], [], []]);
}, 45_000);

test("a copy whose picture is gone goes, and the cleanup says so, though no record or kept file went", async () => {
  rhodium = newInstance({ toml: '[durations]\nbackupEvery = "1s"' });
  // Left by a crash while it was being written.
  const preview = join(rhodium.dir, "state/media/preview");
  mkdirSync(preview, { recursive: true });
  writeFileSync(join(preview, "f00d.123.tmp"), "half");
  await rhodium.start();

  const db = new Database(join(rhodium.dir, "state/rh.db"), { readonly: true });
  const said = () => db.query("SELECT data FROM event WHERE type = 'state_pruned'").all() as { data: string }[];
  try {
    await until(() => said().length > 0, 5_000);
    expect(JSON.parse(said()[0]!.data)).toMatchObject({ media: 0, bytes: 4 });
  } finally {
    db.close();
  }
  expect(readdirSync(preview)).toEqual([]);
}, 45_000);

const FULL = "[limits]\nminFreeMB = 1024000000\n";
/** Restarts rhodium wanting more free disk than any disk has, 1,000,000GB; or, full false, the default again. */
async function diskFull(full = true): Promise<void> {
  await rhodium.kill9(); // the holders run on
  const toml = readFileSync(rhodium.config, "utf8").replace(FULL, "");
  writeFileSync(rhodium.config, full ? toml.replace("[programs]", FULL + "[programs]") : toml);
  await rhodium.start();
}

test("story 135: below the free disk threshold, new slots and resuming a slot are refused, and you are told", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await diskFull();

  for (const argv of [["new", "w/b"], ["spawn", "c", "a task"], ["send", "w/a", "hi"]]) {
    const r = await rhodium.rh(argv);
    expect([r.code, r.err]).toEqual([1, expect.stringContaining("磁盘剩余")]);
  }
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1);
  const [told] = await rhodium.im.log("q", ME);
  expect(told!.text).toMatch(/^磁盘只剩 \d+\.\d GB，这条没交给 w\/a。清出空间再发。$/);
  await Bun.sleep(300);
  expect(rhodium.claude.runs()).toEqual([]);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/[bc] /m);
  expect(await rhodium.ok("doctor")).toMatch(/^告警：磁盘剩余不到 1000000\.0GB$/m);
}, 30_000);

test("story 135: short of free disk, a running agent's rh spawn is refused and you are told", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME, target: "w/a" } }, claude: { script: obey } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "[]" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await diskFull();

  await rhodium.im.inject("q", { chat: ME, sender: ME, text: JSON.stringify([["spawn", "c", "a task"]]) });
  await until(async () => (await rhodium.im.log("q", ME)).length === 3, 15_000);
  const [, notice, reply] = (await rhodium.im.log("q", ME)).map((p) => p.text);
  expect(notice).toStartWith("w/a 派生 c 被拒绝：磁盘剩余");
  expect(reply).toBe("done");
  expect(await rhodium.ok("ls")).not.toMatch(/^w\/c /m);
}, 30_000);

test("story 135: short of free disk, a slot rh stop stopped is not started again for the messages waiting on it; you are told, and they go in once there is room", async () => {
  // After each turn the agent reads nothing for 5 s, so stopping it takes stopGrace and TERM.
  const lazy: Script = { on, steps: [...startTurn, ...endTurn("done"), { sleep: 5000 }, { goto: 0 }] };
  rhodium = newInstance({ claude: { script: lazy }, toml: '[durations]\nstopGrace = "3s"', bots: { q: { like: "qq", owner: ME, target: "w/a" } } });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "hello" });
  await until(async () => (await rhodium.im.log("q", ME)).length === 1, 15_000);
  await diskFull();

  // Your message and an internal one come while it stops.
  await rhodium.ok("stop", "w/a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: "and this" });
  await rhodium.ok("send", "w/a", "from you");
  await until(async () => (await rhodium.im.log("q", ME)).length === 2, 15_000);
  const notice = (await rhodium.im.log("q", ME))[1]!.text;
  expect(notice).toContain("磁盘剩余");
  expect(notice).toContain("w/a 停下后没有再启动");
  expect(await rhodium.state("w/a")).toBe("未运行");

  // Still short of it, a restart starts nothing.
  await diskFull();
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(told("w/a")).toEqual(["hello"]);

  // With room again, the restart starts it for them, and the reply comes back to you.
  await diskFull(false);
  await until(() => told("w/a").length === 3, 15_000);
  expect(told("w/a")).toEqual(["hello", "and this", "from you"]);
  await until(async () => (await rhodium.im.log("q", ME)).length === 3, 15_000);
  expect((await rhodium.im.log("q", ME))[2]!.text).toBe("done");
}, 45_000);

test("story 135: short of free disk, a child's report does not wake its stopped parent; you are told, and it goes in once there is room", async () => {
  // w/a's child is a pi that asks first.
  rhodium = newInstance({
    claude: { script: obey },
    pi: { script: "pi-ask" },
    bots: { q: { like: "qq", owner: ME, target: "w/a" }, qc: { like: "qq", owner: ME, target: "w/c" } },
  });
  await rhodium.start();
  await rhodium.slots("a");
  await rhodium.im.inject("q", { chat: ME, sender: ME, text: JSON.stringify([["spawn", "c", "--agent", "pi", "do it"]]) });
  await until(() => told("w/a").some((t) => t.startsWith("子槽位 w/c 卡住了")), 15_000);
  await until(async () => (await rhodium.state("w/a")) === "空闲", 15_000);
  await rhodium.ok("stop", "w/a");
  await until(async () => (await rhodium.state("w/a")) === "未运行", 15_000);
  await diskFull();

  // You answer w/c's ask, so it is done and reports to w/a.
  await rhodium.im.inject("qc", { chat: ME, sender: ME, text: "1" });
  await until(async () => (await rhodium.im.log("q", ME)).some((p) => p.text.includes("没有唤醒 w/a")), 15_000);
  expect((await rhodium.im.log("q", ME)).at(-1)!.text).toContain("磁盘剩余");
  await Bun.sleep(500);
  expect(await rhodium.state("w/a")).toBe("未运行");
  expect(told("w/a").some((t) => t.startsWith("子槽位 w/c 完成了"))).toBe(false);

  await diskFull(false);
  await until(() => told("w/a").some((t) => t.startsWith("子槽位 w/c 完成了")), 15_000);
}, 45_000);
