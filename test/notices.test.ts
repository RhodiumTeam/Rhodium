// scripts/notices.ts (#524): the notices that go with a package, and no package without a licence.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./instance";

const base = mkdtempSync(join(tmpdir(), "rhodium-test-notices-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const script = join(import.meta.dir, "../scripts/notices.ts");
const pkg = (dir: string, json: object, files: Record<string, string> = {}) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(json));
  for (const [f, text] of Object.entries(files)) writeFileSync(join(dir, f), text);
};

test("#524: NOTICE.md, then each bundled package with its licence file, its dependencies and Tailwind too, never a type package; none without a licence it may ship under", async () => {
  pkg(base, { dependencies: { a: "1", b: "1", d: "1" } }, { "NOTICE.md": "# 第三方声明\n\n依赖包的许可证随包装在 `node_modules/` 里，不在这里列。\n" });
  mkdirSync(join(base, "release/licenses"), { recursive: true });
  writeFileSync(join(base, "release/licenses/musl-1.2.5.txt"), "musl as a whole is licensed under MIT\n");
  writeFileSync(join(base, "release/licenses/rust-1.98.1.md"), "addr2line 0.25.1 MIT\n");
  const nm = join(base, "node_modules");
  pkg(join(nm, "a"), { name: "a", version: "1.0.0", license: "MIT", dependencies: { c: "1", "@types/c": "1" } }, { LICENSE: "MIT a\n" });
  pkg(join(nm, "a/node_modules/c"), { name: "c", version: "2.0.0", license: "ISC" });
  pkg(join(nm, "@types/c"), { name: "@types/c", version: "1.0.0", license: "MIT" });
  pkg(join(nm, "tailwindcss"), { name: "tailwindcss", version: "4.0.0", license: "MIT" }, { LICENSE: "MIT tw\n" });
  pkg(join(nm, "b"), { name: "b", version: "3.0.0", license: "UNLICENSED" });
  pkg(join(nm, "d"), { name: "d", version: "4.0.0", licenses: [{ type: "Apache 2.0" }] }, { "README.md": "# d\n\n## License Plate Reader\n\nnot this\n\nLicense\n-------\n\n(MIT) Copyright d's author\n\nOther\n-----\nno\n" });
  const refused = await exec([process.execPath, script, base]);
  expect([refused.code, refused.out, refused.err]).toEqual([1, "", "这些包没有可以随程序分发的许可证：b@3.0.0（UNLICENSED）\n"]);

  pkg(join(nm, "b"), { name: "b", version: "3.0.0", license: "Apache-2.0" }, { "LICENSE.txt": "Apache b\n", NOTICE: "notice b\n" });
  const run = () => exec([process.execPath, script, base]);
  // No notice for the Bun this runs on: refused, so a Bun upgrade brings its own.
  expect(await run()).toMatchObject({ code: 1, out: "" });
  expect((await run()).err).toContain(`没有 Bun ${Bun.version} 的许可证说明`);
  writeFileSync(join(base, `release/licenses/bun-${Bun.version}.md`), "Bun itself is MIT-licensed.\n");
  const r = await run();
  expect(r.code).toBe(0);
  // NOTICE.md's line that the dependencies are not listed is not true of this file.
  expect(r.out).toStartWith("# 第三方声明\n\n依赖包和程序自带的运行时，许可证见下文。\n\n## 程序自带的运行时\n");
  for (const runtime of ["Bun itself is MIT-licensed.", "musl as a whole"]) expect(r.out).toContain(`\`\`\`\`\n${runtime}`);
  expect(r.out).toContain("`RUST-STD-COPYRIGHT.html`");
  expect(r.out).toContain("addr2line 0.25.1 MIT");
  expect(r.out).not.toContain("not this");
  expect(r.out.split("\n").filter((l) => l.startsWith("### "))).toEqual([`### Bun ${Bun.version}`, "### musl 1.2.5", "### Rust 1.98.1 标准库", "### a 1.0.0（MIT）", "### b 3.0.0（Apache-2.0）", "### c 2.0.0（ISC）", "### d 4.0.0（Apache 2.0）", "### tailwindcss 4.0.0（MIT）"]);
  // A copyright line kept only in the README, under an underlined heading.
  expect(r.out).toContain("### d 4.0.0（Apache 2.0）\n\n包里没有许可证文件，下面是它 README 里讲许可证的那一节。\n\n````\n(MIT) Copyright d's author\n````");
  expect(r.out).toContain("````\nApache b\n````\n\n````\nnotice b\n````");
  expect(r.out).toContain("### c 2.0.0（ISC）\n\n包里没有许可证文件，package.json 写的是 ISC。");

  // A NOTICE.md whose line changed: refused rather than left saying what is not so.
  writeFileSync(join(base, "NOTICE.md"), "# 第三方声明\n");
  expect((await run()).err).toContain("NOTICE.md 里没有");
});
