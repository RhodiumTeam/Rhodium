// Local pictures and file links in what an agent said (stories 600-604, architecture §8.3): which
// targets are local paths, how a path is decoded, what in a message refers to one, and the path check.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { normalizeUri } from "micromark-util-sanitize-uri";
import { codeRef, decoded, elsewhere, linkWords } from "../src/local";
import { checkLocal, localRefs } from "../src/reply-images";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
// Under /tmp, and one outside both it and the slot's directory.
const dir = mkdtempSync("/tmp/rhodium-test-local-");
const out = mkdtempSync("/var/tmp/rhodium-test-local-");
afterAll(() => [dir, out].forEach((d) => rmSync(d, { recursive: true, force: true })));

test("story 600: a path decodes to the same on the page, which gets it as its Markdown library turned it, as in rhodium, which reads what the agent wrote; half a valid % too", () => {
  for (const [written, path] of [["/tmp/截图.png", "/tmp/截图.png"], ["/tmp/a b.png", "/tmp/a b.png"], ["/tmp/a%20b.png", "/tmp/a b.png"], ["/tmp/50%.png", "/tmp/50%.png"], ["/tmp/%E6截.png", "/tmp/%E6%E6%88%AA.png"]] as const) {
    expect(decoded(written)).toBe(path);
    expect(decoded(normalizeUri(written))).toBe(path);
  }
  // In angle brackets, which Markdown takes off first.
  expect(localRefs("![图](</tmp/a b.png>) ![图](/tmp/a\\(1\\).png)").map((r) => r.path)).toEqual(["/tmp/a b.png", "/tmp/a(1).png"]);
});

test("story 603: mailto:, javascript:, data: and any scheme:// but file:// are addresses elsewhere, in any case; a path with a colon is a local path", () => {
  for (const to of ["mailto:a@b.c", "MAILTO:a@b.c", "javascript:alert(1)", "data:image/png;base64,AAAA", "ftp://a/b", "https://a.example/b.png"]) expect([to, elsewhere(to)]).toEqual([to, true]);
  for (const to of ["a.ts:12", "./data:1.txt", "file:///tmp/a.png", "/tmp/a.png", "~/a.png"]) expect([to, elsewhere(to)]).toEqual([to, false]);
  expect(["a.ts:12", "src/a.ts:12:3", "src/a.ts#L42", "a.ts", "a:b.ts"].map(codeRef)).toEqual([true, true, true, false, false]);
  // What a message refers to: pictures and links outside code, not addresses elsewhere, angle brackets off first.
  const said = "看 ![截图](/tmp/截图.png)、[入口](src/auth.ts)、[auth.ts:42](src/auth.ts#L42) 和 `![no](/tmp/code.png)`\n[邮件](<mailto:a@b.c>) ![图](data:image/png;base64,AAAA) [x](https://a.example)\n```\n![no](/tmp/fenced.png)\n```\n![again](/tmp/%E6%88%AA%E5%9B%BE.png)";
  expect(localRefs(said)).toEqual([
    { kind: "image", path: "/tmp/截图.png", words: "截图" },
    { kind: "link", path: "src/auth.ts", words: "入口" },
    { kind: "code", path: "src/auth.ts#L42", words: "auth.ts:42" },
    { kind: "image", path: "/tmp/截图.png", words: "again" },
  ]);
  // A link to a place in the page is no path; a picture of that name is.
  expect(localRefs("[见上文](#安装) ![图](#a.png)")).toEqual([{ kind: "image", path: "#a.png", words: "图" }]);
  expect([linkWords("入口", "src/auth.ts"), linkWords("auth.ts", "src/auth.ts"), linkWords("`auth.ts`", "src/auth.ts"), linkWords("src/auth.ts", "src/auth.ts"), linkWords("auth.ts:42", "src/auth.ts#L42")]).toEqual(["入口（src/auth.ts）", "src/auth.ts", "src/auth.ts", "src/auth.ts", "auth.ts:42（src/auth.ts#L42）"]);
});

test("stories 601, 603: the path check passes a regular file of at most 50MB whose real path is in the slot's directory or /tmp, a picture by its first bytes; else it says why", () => {
  const slot = join(dir, "slot");
  mkdirSync(join(slot, "sub"), { recursive: true });
  writeFileSync(join(slot, "in.png"), PNG);
  writeFileSync(join(dir, "tmp.png"), PNG);
  writeFileSync(join(out, "out.png"), PNG);
  symlinkSync(join(out, "out.png"), join(slot, "link.png"));
  writeFileSync(join(slot, "notes.png"), "just words\n");
  writeFileSync(join(slot, "big.png"), PNG);
  truncateSync(join(slot, "big.png"), (50 << 20) + 1);
  const check = (path: string, image = true) => checkLocal(slot, path, image);
  expect(check(join(slot, "in.png"))).toEqual({ real: join(slot, "in.png") });
  expect(check(join(dir, "tmp.png"))).toEqual({ real: join(dir, "tmp.png") });
  expect(check("in.png")).toEqual({ real: join(slot, "in.png") });
  expect(check(`file://${slot}/in.png`)).toEqual({ real: join(slot, "in.png") });
  expect(check("link.png")).toEqual({ why: "不在槽位目录或 /tmp 里" });
  expect(check(join(out, "out.png"))).toEqual({ why: "不在槽位目录或 /tmp 里" });
  expect(check("../slot/../../../etc/hostname", false)).toEqual({ why: "不在槽位目录或 /tmp 里" });
  expect(check("notes.png")).toEqual({ why: "不是图片" });
  expect(check("notes.png", false)).toEqual({ real: join(slot, "notes.png") });
  expect(check("big.png")).toEqual({ why: "超过 50MB" });
  expect(check("big.png", false)).toEqual({ why: "超过 50MB" });
  expect(check("none.png")).toEqual({ why: "找不到文件" });
  expect(check("sub", false)).toEqual({ why: "找不到文件" });
  // A directory whose name begins as the slot's is not in it.
  mkdirSync(`${out}/slot`);
  writeFileSync(`${out}/slot-2.png`, PNG);
  expect(checkLocal(`${out}/slot`, `${out}/slot-2.png`, true)).toEqual({ why: "不在槽位目录或 /tmp 里" });
});
