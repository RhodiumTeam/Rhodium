#!/usr/bin/env bun
// The third-party notices that go with a built rhodium (#524): NOTICE.md, then every package the
// binary bundles, with the licence file it ships. The binary has no comments, so a notice kept only
// in the source does not reach whoever gets the package. Exits 1, printing nothing, when a bundled
// package has no licence it may be shipped under.
//   bun scripts/notices.ts [checkout] > THIRD_PARTY_NOTICES.md      (this checkout by default)
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(process.argv[2] ?? join(import.meta.dir, ".."));
type Pkg = { name: string; version: string; license?: unknown; licenses?: unknown; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string>; peerDependencies?: Record<string, string> };

/** Where node resolves name from dir: the nearest node_modules up the tree that has it. */
function find(name: string, dir: string): string | null {
  for (let d = dir; ; d = dirname(d)) {
    const p = join(d, "node_modules", name, "package.json");
    if (existsSync(p)) return p;
    if (dirname(d) === d) return null;
  }
}

// The packages: package.json's dependencies and what they pull in, and Tailwind, whose base styles
// go into the board's CSS.
const seen = new Map<string, Pkg>();
const walk = (name: string, from: string) => {
  const p = find(name, from);
  if (!p || seen.has(p)) return;
  const pkg = JSON.parse(readFileSync(p, "utf8")) as Pkg;
  seen.set(p, pkg);
  // Type packages hold no code that runs, so none of them is bundled.
  for (const n of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies, ...pkg.peerDependencies })) if (!n.startsWith("@types/")) walk(n, dirname(p));
};
function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

const top = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Pkg;
for (const n of [...Object.keys(top.dependencies ?? {}), "tailwindcss"]) walk(n, root);

/** A package's licence as package.json says it: a string, or the old { type } and [{ type }] forms. */
const licence = (pkg: Pkg) => {
  const l = (pkg.license ?? pkg.licenses ?? null) as unknown;
  const one = (x: any) => (typeof x === "string" ? x : String(x?.type ?? null));
  return Array.isArray(l) ? l.map(one).join(" OR ") : one(l);
};
const files = (dir: string) => readdirSync(dir).filter((f) => /^(licen[cs]e|copying|notice)/i.test(f)).sort();
const bad = [...seen.values()].filter((p) => /^(null|UNLICENSED|SEE LICENSE)/i.test(licence(p)));
if (bad.length) die(`这些包没有可以随程序分发的许可证：${bad.map((p) => `${p.name}@${p.version}（${licence(p)}）`).join("、")}`);

/** The licence section of a package's README, for one that keeps its copyright line only there. */
function readmeLicence(dir: string): string | null {
  const readme = readdirSync(dir).find((f) => /^readme/i.test(f));
  if (!readme) return null;
  const lines = readFileSync(join(dir, readme), "utf8").split("\n");
  // A heading: "## License", or "License" underlined with --- or ===.
  const under = (i: number) => /^\s*[-=]{3,}\s*$/.test(lines[i + 1] ?? "") && lines[i]!.trim() !== "";
  const heading = (i: number) => /^#{1,6}\s/.test(lines[i]!) || under(i);
  const at = lines.findIndex((l, i) => /^#{1,6}\s*licen[cs]e\s*$/i.test(l) || (under(i) && /^\s*licen[cs]e\s*$/i.test(l)));
  if (at < 0) return null;
  const from = at + (under(at) ? 2 : 1);
  const end = lines.findIndex((_, i) => i >= from && heading(i));
  return lines.slice(from, end < 0 ? undefined : end).join("\n").trim() || null;
}

// The source's own notices, said here of the package as a whole: what it bundles comes below.
const source = readFileSync(join(root, "NOTICE.md"), "utf8").trimEnd();
const notListed = "依赖包的许可证随包装在 `node_modules/` 里，不在这里列。";
if (!source.includes(notListed)) die(`NOTICE.md 里没有“${notListed}”这一句了：改 scripts/notices.ts 里换掉它的那一处`);
const notice = source.replace(notListed, "依赖包和程序自带的运行时，许可证见下文。");
// The runtimes: Bun's notice for the Bun this runs on, which is the one that compiles rhodium.
const licences = join(root, "release/licenses");
const bunNotice = join(licences, `bun-${Bun.version}.md`);
if (!existsSync(bunNotice)) die(`没有 Bun ${Bun.version} 的许可证说明：把 github.com/oven-sh/bun 标签 bun-v${Bun.version} 的 LICENSE.md 存成 ${bunNotice}`);
// Rust's notices for the Rust scripts/package.sh builds rh-hold with, the one its name says.
const rustNotice = readdirSync(licences).find((f) => /^rust-.+\.md$/.test(f)) ?? die(`${licences} 里没有 Rust 的声明 rust-<版本>.md`);
const block = (text: string) => ["````", text.trim(), "````", ""];
const out = [
  notice,
  "",
  "## 程序自带的运行时",
  "",
  `### Bun ${Bun.version}`,
  "",
  "`rhodium` 是用 Bun 编译的单个程序，里面带着 Bun 的运行时。下面是 Bun 自己的许可证说明，各项的全文见它给的链接。",
  "",
  ...block(readFileSync(bunNotice, "utf8")),
  "### musl 1.2.5",
  "",
  "`rh-hold` 静态链接了 musl。",
  "",
  ...block(readFileSync(join(licences, "musl-1.2.5.txt"), "utf8")),
  `### Rust ${rustNotice.slice("rust-".length, -".md".length)} 标准库`,
  "",
  "`rh-hold` 静态链接了 Rust 的标准库，连同它用到的第三方代码。它们的声明见同一目录下的 `RUST-STD-COPYRIGHT.html`，取自构建用的 Rust 工具链；那里漏掉的几项在下面。",
  "",
  readFileSync(join(licences, rustNotice), "utf8").trim(),
  "",
  "## 打进程序的依赖包",
  "",
  "`rhodium` 里打进了下面这些包，看板网页用的也在内。每个包照它自带的许可证文件抄录；没带的，抄它 README 里讲许可证的那一节，都没有就写它声明的许可证。",
  "",
];
for (const [p, pkg] of [...seen].sort(([, a], [, b]) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  out.push(`### ${pkg.name} ${pkg.version}（${licence(pkg)}）`, "");
  const texts = files(dirname(p)).map((f) => readFileSync(join(dirname(p), f), "utf8").trim());
  const fromReadme = texts.length ? null : readmeLicence(dirname(p));
  if (texts.length) for (const t of texts) out.push(...block(t));
  else if (fromReadme) out.push("包里没有许可证文件，下面是它 README 里讲许可证的那一节。", "", ...block(fromReadme));
  else out.push(`包里没有许可证文件，package.json 写的是 ${licence(pkg)}。`, "");
}
console.log(out.join("\n"));
