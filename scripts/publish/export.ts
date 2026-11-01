#!/usr/bin/env bun
// Export one commit as the public snapshot (#523), no history: only the paths
// scripts/publish/manifest.txt takes, and only once they pass every check below. Then, unless
// --no-check, `bun run check` on the exported copy. Into an empty or new out-dir it writes the
// files; into a clean clone of the public repo it swaps the files and commits once. It never pushes.
//
//   bun scripts/publish/export.ts [--ref <commit>] [--repo <dir>] [--deny <file>] [--no-check] <out-dir>
//
// --ref: origin/main by default. --deny: the private deny list, one case-insensitive regex per line
// (# starts a comment), ~/.config/rhodium-dev/publish-deny.txt by default. It holds real ids and
// secrets, so a hit is reported by file and line of the list, never by what it matched.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, posix } from "node:path";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

const { values, positionals } = parseArgs({
  options: { ref: { type: "string" }, repo: { type: "string" }, deny: { type: "string" }, "no-check": { type: "boolean" } },
  allowPositionals: true,
});
if (positionals.length !== 1) die("usage: bun scripts/publish/export.ts [--ref <commit>] [--repo <dir>] [--deny <file>] [--no-check] <out-dir>");
const out = positionals[0]!;
const repo = values.repo ?? join(import.meta.dir, "../..");
const denyFile = values.deny ?? join(homedir(), ".config/rhodium-dev/publish-deny.txt");

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
function sh(argv: string[], cwd = repo, stdio: "pipe" | "inherit" = "pipe"): string {
  const r = Bun.spawnSync(argv, { cwd, stdout: stdio, stderr: stdio, stdin: "ignore" });
  if (r.exitCode !== 0) die(`${argv.join(" ")} exited with ${r.exitCode}${r.stderr ? `: ${r.stderr.toString().trim()}` : ""}`);
  return r.stdout?.toString() ?? "";
}

// Which paths go: the manifest of the commit itself, so a commit carries its own list.
const commit = sh(["git", "rev-parse", "--verify", `${values.ref ?? "origin/main"}^{commit}`]).trim();
const modes = new Map(
  sh(["git", "ls-tree", "-r", "-z", commit])
    .split("\0")
    .filter(Boolean)
    .map((l) => [l.slice(l.indexOf("\t") + 1), l.slice(0, 6)] as const),
);
const lines = sh(["git", "show", `${commit}:scripts/publish/manifest.txt`]).split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
const takes = lines.filter((l) => !l.startsWith("!")).map((l) => new Bun.Glob(l));
const leaves = lines.filter((l) => l.startsWith("!")).map((l) => new Bun.Glob(l.slice(1)));
// *.local.md stays private even with the manifest's line gone, whatever its case.
const taken = [...modes.keys()].filter((p) => takes.some((g) => g.match(p)) && !leaves.some((g) => g.match(p)) && !/\.local\.md$/i.test(p));
const has = new Set(taken);
const dirs = new Set(taken.flatMap((p) => p.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));

// Where it goes, checked before any work: a clean clone of the public repo that can commit, or an
// empty or new directory. Never the private repo or a clone of it, which has this commit and its history.
const git = existsSync(join(out, ".git"));
if (git) {
  // It has this commit, or shares a root commit with the private repo even if this commit is newer.
  const quiet = { stdout: "pipe", stderr: "ignore" } as const;
  const roots = Bun.spawnSync(["git", "rev-list", "--max-parents=0", "--all"], { cwd: out, ...quiet }).stdout.toString().split("\n").filter(Boolean);
  const ours = (c: string) => Bun.spawnSync(["git", "cat-file", "-e", `${c}^{commit}`], { cwd: repo, ...quiet }).exitCode === 0;
  if (Bun.spawnSync(["git", "cat-file", "-e", commit], { cwd: out, ...quiet }).exitCode === 0 || roots.some(ours)) die(`${out} shares history with ${repo}: it is the private repo or a clone of it`);
  if (sh(["git", "status", "--porcelain"], out).trim()) die(`${out} has changes of its own: commit or drop them first`);
} else if (existsSync(out) && readdirSync(out).length) die(`${out} is neither empty nor a git clone`);

const deny = existsSync(denyFile)
  ? readFileSync(denyFile, "utf8").split("\n").map((l, i) => [i + 1, l.trim()] as const).filter(([, l]) => l && !l.startsWith("#")).map(([n, l]) => [n, new RegExp(l, "i")] as const)
  : die(`no deny list at ${denyFile}: write one, or pass --deny`);
/** s as it may be printed: whatever a deny rule matches in it blanked out. */
const mask = (s: string) => deny.reduce((s, [, re]) => s.replace(new RegExp(re.source, "gi"), "＊＊"), s);

const stage = mkdtempSync(join(tmpdir(), "rhodium-publish-"));
process.on("exit", () => rmSync(stage, { recursive: true, force: true }));
const tar = join(stage, ".snapshot.tar");
sh(["git", "archive", "--format=tar", "-o", tar, commit, "--", ...taken.map((p) => `:(literal)${p}`)]);
sh(["tar", "-xf", tar, "-C", stage]);
rmSync(tar);

// Checks. Each problem is one line: the file and line, then which rule; never the text a rule matched.
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const me = esc(userInfo().username);
// This machine's home, as a path and as Claude Code and pi spell a directory in their file names.
const home = new RegExp(`(?:${esc(homedir())}|/home/${me})(?![\\w-])|-home-${me}(?!\\w)`);
// Made-up domains, the no-reply addresses commit trailers carry, and GitHub's (git@, a token in a URL) are fine.
const fine = (email: string) => /^(noreply|git)@/i.test(email) || /@(.+\.)?example(\.(com|org|net))?$|\.(test|invalid)$|@github\.com$|@users\.noreply\.github\.com$/i.test(email);
const builtIn: [string, (text: string) => boolean][] = [
  ["Telegram 的 token", (t) => /(?<!\d)\d{8,10}:AA[A-Za-z0-9_-]{33}(?![A-Za-z0-9_-])/.test(t)],
  ["GitHub 的 token", (t) => /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/.test(t)],
  ["Anthropic 的 API key", (t) => /\bsk-ant-[A-Za-z0-9_-]{20,}/.test(t)],
  ["私钥", (t) => /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)],
  ["这台机器的家目录", (t) => home.test(t)],
  ["邮箱", (t) => [...t.matchAll(/[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g)].some(([e]) => !fine(e))],
];
// Who the snapshot is committed as goes public too: never a guessed address, one of these words or
// a real email. To publish as yourself, a GitHub no-reply address passes once the deny list allows it.
if (git) {
  const idents = ["GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"].map((v) => Bun.spawnSync(["git", "var", v], { cwd: out, stdout: "pipe", stderr: "ignore" }));
  const bad = (r: (typeof idents)[number]) => {
    const who = r.stdout.toString().replace(/\s+\d+ [+-]\d{4}\s*$/, "");
    return r.exitCode !== 0 || !fine(who.match(/<([^>]*)>/)?.[1] ?? "") || deny.some(([, re]) => re.test(who)) || builtIn.some(([, hit]) => hit(who));
  };
  if (idents.some(bad)) die(`${out}: git there has no identity to commit as, or one that may not go public: set user.name and user.email there, to a made-up or GitHub no-reply address`);
}

// Binary bytes, an image's or a font's metadata or a protobuf, read as text three ways: Latin-1 with
// the NULs out, which also reads ASCII in UTF-16 of either byte order and offset; UTF-16; and UTF-8.
const readings = (buf: Buffer) => [buf.toString("latin1").replaceAll("\0", ""), buf.toString("utf16le"), buf.toString("utf8")];
// A base64 run is text no rule can read as it stands: what it holds, gunzipped too, is checked like
// the file, and read as a binary file is when it is binary, which finds a name in protobuf-like bytes.
// A long one that holds no text (a picture, ciphertext, a key) stops the export, unless it is as
// plain as the fixed filler the fixture synthesis writes.
// ponytail: decoded from the run's first character only, so a prefix stuck on is seen through only
// when its length is a multiple of 4 (img_<b64>, not id_<b64>); decode at all 4 offsets if that bites.
const BLOB = /[A-Za-z0-9+/_-]{16,}={0,2}/g;
const entropy = (s: string) => {
  const n = new Map<string, number>();
  for (const c of s) n.set(c, (n.get(c) ?? 0) + 1);
  return [...n.values()].reduce((h, k) => h - (k / s.length) * Math.log2(k / s.length), 0);
};
function unwrapped(run: string): { texts: string[]; opaque: boolean } {
  let buf = Buffer.from(run.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      buf = gunzipSync(buf);
    } catch {}
  }
  const text = buf.toString("utf8");
  // Text: valid UTF-8 and few control bytes besides tab, newlines and the terminal's escape.
  const controls = text.match(/[\x00-\x08\x0b\x0c\x0e-\x1a\x1c-\x1f]/g)?.length ?? 0;
  if (!text.includes("\ufffd") && controls < text.length / 20) return { texts: [text], opaque: false };
  return { texts: readings(buf), opaque: run.length >= 120 && (/^(?:iVBORw0KGgo|\/9j\/|R0lGOD|UklGR)/.test(run) || entropy(run) > 4.5) };
}

const problems: string[] = [];
const exists = (p: string) => has.has(p) || dirs.has(p.replace(/\/$/, ""));
const lineOf = (text: string, at: number) => text.slice(0, at).split("\n").length;
for (const file of taken) {
  const where = mask(file);
  // What is published must be what is checked: a link would be published as a link to something else.
  if (modes.get(file) !== "100644" && modes.get(file) !== "100755") {
    problems.push(`${where}: 不是普通文件`);
    continue;
  }
  for (const [n, re] of deny) if (re.test(file)) problems.push(`${where}: 路径里有关键词清单第 ${n} 行`);
  for (const [what, hit] of builtIn) if (hit(file)) problems.push(`${where}: 路径里有${what}`);
  const buf = readFileSync(join(stage, file));
  const binary = buf.includes(0);
  const texts = binary ? readings(buf) : [buf.toString("utf8")];
  for (const [n, re] of deny) if (texts.some((t) => re.test(t))) problems.push(`${where}: 关键词清单第 ${n} 行`);
  for (const [what, hit] of builtIn) if (texts.some(hit)) problems.push(`${where}: ${what}`);
  if (binary) continue;
  const text = texts[0]!;
  for (const m of text.matchAll(BLOB)) {
    // The line only for a hit: counted for every run, a 3 MB recording took seconds.
    const at = () => `${where} 第 ${lineOf(text, m.index)} 行`;
    const { texts: held, opaque } = unwrapped(m[0]);
    if (opaque) problems.push(`${at()}：看不出内容的长串（图片或密文）`);
    for (const [n, re] of deny) if (held.some((t) => re.test(t))) problems.push(`${at()}：长串里有关键词清单第 ${n} 行`);
    for (const [what, hit] of builtIn) if (held.some(hit)) problems.push(`${at()}：长串里有${what}`);
  }
  if (file.endsWith(".md")) {
    for (const m of text.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
      // Only what reads as a path, a file name or a directory: not a URL, an anchor or a placeholder like (地址).
      const target = m[1]!, bare = target.split("#")[0]!;
      if (/^[a-z][a-z+.-]*:/i.test(target) || !/\.\w+$|\/$/.test(bare)) continue;
      if (!exists(posix.normalize(posix.join(posix.dirname(file), decodeURI(bare))))) problems.push(`${where} 第 ${lineOf(text, m.index)} 行：链接指向不导出的文件`);
    }
  } else if (!file.startsWith("test/fixtures/")) {
    // Recordings quote other programs' docs (pi's own docs/*.md), not this repo's.
    for (const m of text.matchAll(/(?<![\w./-])(?:docs|deploy)\/[\w./-]*\.md\b/g)) if (!has.has(m[0])) problems.push(`${where} 第 ${lineOf(text, m.index)} 行：提到不导出的文档`);
  }
}
if (problems.length) die(`没有导出 ${commit.slice(0, 7)}，${problems.length} 处没过：\n${[...new Set(problems)].join("\n")}`);

if (!values["no-check"]) {
  // As the public clone will be: a git repository with the snapshot committed, which build.sh
  // reads the commit from. It is the copy's own, and nothing of it is written out.
  const as = { GIT_AUTHOR_NAME: "publish", GIT_AUTHOR_EMAIL: "noreply@example.com", GIT_COMMITTER_NAME: "publish", GIT_COMMITTER_EMAIL: "noreply@example.com" };
  for (const argv of [["git", "init", "-q"], ["git", "add", "-A"], ["git", "commit", "-q", "-m", "snapshot"]]) {
    if (Bun.spawnSync(argv, { cwd: stage, env: { ...process.env, ...as }, stdout: "ignore", stderr: "inherit" }).exitCode !== 0) die(`${argv.join(" ")} failed in the copy`);
  }
  sh(["bun", "install", "--frozen-lockfile"], stage, "inherit");
  sh(["bun", "run", "check"], stage, "inherit");
  rmSync(join(stage, "node_modules"), { recursive: true, force: true });
}

// Write out: into the clone, in place of what it has; or into the empty or new directory.
if (git) for (const p of sh(["git", "ls-files", "-z"], out).split("\0").filter(Boolean)) rmSync(join(out, p), { force: true });
for (const p of taken) {
  mkdirSync(join(out, dirname(p)), { recursive: true });
  cpSync(join(stage, p), join(out, p));
}
const version = JSON.parse(readFileSync(join(stage, "package.json"), "utf8")).version as string;
if (git) {
  // Only what was checked: what the clone tracked and is now gone, and the snapshot's paths. Not
  // `add -A`, which would also take a file the clone's old .gitignore hid and the new one does not.
  sh(["git", "add", "-u"], out);
  sh(["git", "add", "-f", "--", ...taken.map((p) => `:(literal)${p}`)], out);
  if (sh(["git", "status", "--porcelain"], out).trim()) sh(["git", "commit", "-q", "-m", `Rhodium ${version}`], out);
}
console.log(`导出了 ${commit.slice(0, 7)}（${version}）的 ${taken.length} 个文件到 ${out}${git ? "，提交了，没推送" : ""}。`);
