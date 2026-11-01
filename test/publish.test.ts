// The publish export (#523): only what the manifest takes goes, and only once it passes the checks.
// The samples that must trip a check are put together at run time, so this file itself exports clean.
import { afterAll, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { gzipSync } from "node:zlib";
import { exec, run } from "./instance";

const base = mkdtempSync(join(tmpdir(), "rhodium-test-publish-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const script = join(import.meta.dir, "../scripts/publish/export.ts");
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
const deny = join(base, "deny.txt");
writeFileSync(deny, "# private names\nsecret-?word\n墨[栗]\n");
const word = ["Secret", "Word"].join("-");
const cjk = ["墨", "栗"].join("");
const doc = (name: string) => ["docs", name].join("/");

/** A repo at dir with these files, committed. */
async function repo(dir: string, files: Record<string, string>) {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  }
  if (!existsSync(join(dir, ".git"))) await run(["git", "init", "-q", dir], { env });
  await run(["git", "-C", dir, "add", "-A"], { env });
  await run(["git", "-C", dir, "commit", "-qm", "c"], { env });
}
const exportTo = (src: string, out: string, e: Record<string, string | undefined> = env) =>
  exec([process.execPath, script, "--repo", src, "--ref", "HEAD", "--deny", deny, "--no-check", out], { env: e });
const list = (dir: string) => (readdirSync(dir, { recursive: true }) as string[]).filter((p) => !p.startsWith(".git") && !lstatSync(join(dir, p)).isDirectory()).sort();
const problems = (err: string) => err.split("\n").slice(1).filter(Boolean).sort();

const clean = {
  "scripts/publish/manifest.txt": "README.md\npackage.json\ndocs/**\nsrc/**\n!**/*.local.md\n",
  "package.json": '{ "version": "1.2.3" }\n',
  "README.md": `[a](${doc("a.md")})、[adr](${doc("adr/")})、[外面](https://example.com/x.md)、[本节](#约定)、[占位](地址)\n`,
  [doc("a.md")]: "a\n",
  [doc("adr/0001.md")]: "adr\n",
  [doc("b.local.md")]: "this machine\n",
  [doc("C.LOCAL.MD")]: "this machine too\n",
  "src/x.ts": `// see ${doc("a.md")}; mail ${"noreply"}@anthropic.com or you@example.com\nconst filler = "${"AQID".repeat(60)}";\n`,
  "notes.txt": "not listed\n",
};
const exported = ["README.md", doc("a.md"), doc("adr/0001.md"), "package.json", "src/x.ts"];
const ok = join(base, "ok");
await repo(ok, clean);

test("#523: only the paths the manifest takes go, never a .local.md; into a clone it swaps the files and commits once, unpushed", async () => {
  const out = join(base, "ok-out");
  expect(await exportTo(ok, out)).toMatchObject({ code: 0, err: "" });
  expect(list(out)).toEqual(exported);

  // The public clone: an old file goes, the snapshot comes in as one commit, and a file its old
  // .gitignore hid stays out of it even though the snapshot ignores nothing.
  const pub = join(base, "pub");
  await repo(pub, { "old.md": "gone\n", "src/x.ts": "old\n", ".gitignore": "hidden.env\n" });
  writeFileSync(join(pub, "hidden.env"), `${word}\n`);
  expect((await exportTo(ok, pub)).code).toBe(0);
  expect(list(pub)).toEqual([...exported, "hidden.env"].sort());
  expect((await run(["git", "-C", pub, "log", "--format=%s"], { env })).trim().split("\n")).toEqual(["Rhodium 1.2.3", "c"]);
  expect(await run(["git", "-C", pub, "ls-files"], { env })).not.toContain("hidden.env");
  expect(await run(["git", "-C", pub, "status", "--porcelain"], { env })).toBe("?? hidden.env\n");
  expect(await run(["git", "-C", pub, "remote"], { env })).toBe("");
});

test("#523: without --no-check it runs bun run check on the copy, committed as a git repository of its own, as the public clone will be", async () => {
  const src = join(base, "checked");
  await repo(src, { ...clean, "package.json": '{ "version": "1.2.3", "scripts": { "check": "git rev-parse --verify -q HEAD >/dev/null && git status --porcelain | wc -l" } }\n' });
  const out = join(base, "checked-out");
  const r = await exec([process.execPath, script, "--repo", src, "--ref", "HEAD", "--deny", deny, out], { env, timeoutMs: 60_000 });
  expect([r.code, r.out.split("\n").includes("0")]).toEqual([0, true]);
  expect(list(out)).toEqual(exported);
  expect(existsSync(join(out, ".git"))).toBe(false);
});

test("#523: deny-list words in a file or its path, keys, this machine's home, an email, a link or a mention of a file that does not go, a symlink: each stops the export, named by file, line and rule, never by what matched", async () => {
  const src = join(base, "bad");
  const user = userInfo().username;
  await repo(src, {
    ...clean,
    "src/y.ts": `const who = '${word}';\nconst url = "https://api.telegram.org/bot${"1234567890"}:AA${"x".repeat(32)}-/getMe";\n`,
    "src/z.ts": `// see ${doc("b.local.md")}, in ${process.env.HOME}/x and -home-${user}-Rhodium, from ${"alex"}@mail.com\n`,
    [`src/${word}.ts`]: "x\n",
    [`src/-home-${user}`]: "x\n",
    [doc("c.md")]: `[私有](b.local.md)\n[没了](../${doc(`${word}.md`)})\n`,
    "src/keys.ts": `const a = "${"gh"}p_${"a".repeat(36)}", b = "${"sk"}-ant-${"b".repeat(24)}";\n`,
    // Long base64: a name inside, plain and gzipped; a picture; ciphertext.
    "src/blob.ts": [
      Buffer.from(`the user is ${word} ${"and more words ".repeat(8)}`).toString("base64"),
      gzipSync(Buffer.from(`${word} ${"x".repeat(200)}`)).toString("base64url"),
      Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120)]).toString("base64"),
      randomBytes(150).toString("base64"),
      // Short and binary: a name in protobuf-like bytes, ASCII or UTF-8, and one with a prefix stuck on (#537).
      Buffer.from([0x0a, word.length, ...Buffer.from(word), 0x10, 0x01, 0x00, 0x00]).toString("base64"),
      `img_${Buffer.from(word).toString("base64")}`,
      Buffer.from([0x0a, Buffer.byteLength(cjk), ...Buffer.from(cjk), 0x10, 0x01, 0x00, 0x00]).toString("base64"),
    ].map((b) => `const b = "${b}";`).join("\n") + "\n",
  });
  symlinkSync("/etc/hostname", join(src, "src/link.ts"));
  writeFileSync(join(src, "src/pic.bin"), Buffer.concat([Buffer.from([0x00, 0x01]), Buffer.from(cjk), Buffer.from([0x00])]));
  await run(["git", "-C", src, "add", "-A"], { env });
  await run(["git", "-C", src, "commit", "-qm", "link"], { env });
  const out = join(base, "bad-out");
  const r = await exportTo(src, out);
  expect(r.code).toBe(1);
  expect(problems(r.err)).toEqual([
    `${doc("c.md")} 第 1 行：链接指向不导出的文件`,
    `${doc("c.md")} 第 2 行：链接指向不导出的文件`,
    `${doc("c.md")}: 关键词清单第 2 行`,
    `src/-home-${user}: 路径里有这台机器的家目录`,
    "src/blob.ts 第 1 行：长串里有关键词清单第 2 行",
    "src/blob.ts 第 2 行：长串里有关键词清单第 2 行",
    "src/blob.ts 第 3 行：看不出内容的长串（图片或密文）",
    "src/blob.ts 第 4 行：看不出内容的长串（图片或密文）",
    "src/blob.ts 第 5 行：长串里有关键词清单第 2 行",
    "src/blob.ts 第 6 行：长串里有关键词清单第 2 行",
    "src/blob.ts 第 7 行：长串里有关键词清单第 3 行",
    "src/keys.ts: Anthropic 的 API key",
    "src/keys.ts: GitHub 的 token",
    "src/link.ts: 不是普通文件",
    "src/pic.bin: 关键词清单第 3 行",
    "src/y.ts: Telegram 的 token",
    "src/y.ts: 关键词清单第 2 行",
    "src/z.ts 第 1 行：提到不导出的文档",
    "src/z.ts: 这台机器的家目录",
    "src/z.ts: 邮箱",
    "src/＊＊.ts: 路径里有关键词清单第 2 行",
  ]);
  expect(r.err).not.toMatch(/secret|alex|local\.md/i);
  expect(existsSync(out)).toBe(false);
});

test("#523: no deny list, the private repo or a clone of it, a dirty clone, one with no git identity, or a full directory that is no clone: it writes nothing", async () => {
  const none = await exec([process.execPath, script, "--repo", ok, "--ref", "HEAD", "--deny", join(base, "missing.txt"), "--no-check", join(base, "x")], { env });
  expect([none.code, none.err]).toEqual([1, `no deny list at ${join(base, "missing.txt")}: write one, or pass --deny\n`]);

  const full = join(base, "full");
  mkdirSync(full);
  writeFileSync(join(full, "mine.txt"), "keep\n");
  expect((await exportTo(ok, full)).err).toBe(`${full} is neither empty nor a git clone\n`);

  // The private repo, a clone of it, and a clone that has yet to fetch the commit being exported.
  const clone = join(base, "clone");
  await run(["git", "clone", "-q", ok, clone], { env });
  const newer = join(base, "newer");
  await run(["git", "clone", "-q", ok, newer], { env });
  await repo(newer, { "README.md": "newer\n" });
  // And one on an orphan branch of its own, its private history still there.
  const orphan = join(base, "orphan");
  await run(["git", "clone", "-q", ok, orphan], { env });
  await run(["git", "-C", orphan, "checkout", "-q", "--orphan", "empty"], { env });
  await run(["git", "-C", orphan, "rm", "-rqf", "."], { env });
  await run(["git", "-C", orphan, "commit", "-q", "--allow-empty", "-m", "empty"], { env });
  for (const [src, dir] of [[ok, ok], [ok, clone], [newer, clone], [ok, orphan], [newer, orphan]] as const)
    expect((await exportTo(src, dir)).err).toBe(`${dir} shares history with ${src}: it is the private repo or a clone of it\n`);

  const dirty = join(base, "dirty");
  await repo(dirty, { "a.md": "a\n" });
  writeFileSync(join(dirty, "wip.md"), "wip\n");
  expect((await exportTo(ok, dirty)).err).toBe(`${dirty} has changes of its own: commit or drop them first\n`);

  // Who the commit would be by: nobody, a name with an address git guesses from this machine, a real
  // address, a deny-listed word. A GitHub no-reply address is fine.
  const nobody = join(base, "nobody");
  await repo(nobody, { "a.md": "a\n" });
  const home = join(base, "empty-home");
  mkdirSync(home);
  const as = (name?: string, email?: string) => ({ PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: name, GIT_COMMITTER_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_EMAIL: email });
  for (const who of [as(), as("t"), as("t", `${"alex"}@mail.com`), as(word, "t@example.com")])
    expect((await exportTo(ok, nobody, who)).err).toBe(`${nobody}: git there has no identity to commit as, or one that may not go public: set user.name and user.email there, to a made-up or GitHub no-reply address\n`);
  expect((await exportTo(ok, nobody, as("t", "1+t@users.noreply.github.com"))).code).toBe(0);

  expect(list(full)).toEqual(["mine.txt"]);
  expect(list(dirty)).toEqual(["a.md", "wip.md"]);
  expect(list(nobody)).toEqual(exported);
  expect(list(clone)).toEqual(list(ok));
});

test("#537: a file of many base64-like runs is checked in one pass, not a count from the top for each run", async () => {
  const src = join(base, "big");
  await repo(src, { ...clean, "src/big.ts": `const s = "${"x".repeat(20)}";\n`.repeat(40_000) });
  expect(await exportTo(src, join(base, "big-out"))).toMatchObject({ code: 0, err: "" });
});
