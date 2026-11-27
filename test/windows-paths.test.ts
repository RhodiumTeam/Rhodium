import { expect, spyOn, test } from "bun:test";
import { join, posix, win32 } from "node:path";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { messagePage } from "../src/transcript";
import { checkLocal } from "../src/reply-images";
import { displayDirectory, expandHome, localDrivePath, parentDirectory, sameDirectory } from "../src/paths";
import { pickerPath } from "../web/src/picker-path";

test("the Windows picker accepts pasted drive paths and stops at each drive root", () => {
  const home = "C:\\Users\\测试";
  for (const raw of ["C:\\", "C:/", "D:\\资料\\"]) {
    const text = pickerPath(raw, true);
    expect(text.lastIndexOf("/")).toBe(text.length - 1);
  }
  for (const raw of ["~/a b", "~\\a b"]) {
    const native = win32.resolve(home, expandHome(raw, home, win32));
    expect(native).toBe(home + "\\a b");
    expect(displayDirectory(native, home, win32)).toBe("~/a b");
  }
  expect(displayDirectory("c:/users/测试", home, win32)).toBe("~");
  expect(displayDirectory("C:\\Users\\测试2", home, win32)).toBe("C:/Users/测试2");
  expect(displayDirectory("D:\\测试", home, win32)).toBe("D:/测试");
  expect(sameDirectory("c:/Work/资料/", "C:\\work\\资料", win32)).toBe(true);
  expect(sameDirectory(String.raw`\\?\C:\Work\Data`, "C:/work/Data", win32)).toBe(true);
  expect(displayDirectory("//?/C:/Users/测试/x", home, win32)).toBe("~/x");
  expect(localDrivePath(String.raw`\\?\UNC\server\file`)).toBe(String.raw`\\?\UNC\server\file`);
  expect(parentDirectory("D:\\资料", win32)).toBe("D:\\");
  expect(parentDirectory("D:\\", win32)).toBeNull();
  expect(parentDirectory("C:/", win32)).toBeNull();
});

test("Unix directories retain case and literal backslashes", () => {
  expect(pickerPath("/tmp/a\\b", false)).toBe("/tmp/a\\b");
  expect(expandHome("~\\a", "/home/test", posix)).toBe("~\\a");
  expect(displayDirectory("/home/test/a\\b", "/home/test", posix)).toBe("~/a\\b");
  expect(sameDirectory("/tmp/A", "/tmp/a", posix)).toBe(false);
  expect(parentDirectory("/", posix)).toBeNull();
});

test.skipIf(process.platform !== "win32")("reply files and pictures use the real slot or temp directory on a local drive", () => {
  const fixture = fs.mkdtempSync(join(process.cwd(), "rhodium-test-preview-"));
  const temp = fs.mkdtempSync(join(tmpdir(), "rhodium-test-preview-"));
  try {
    const slot = join(fixture, "Slot");
    fs.mkdirSync(slot);
    const picture = join(slot, "output.png");
    const sibling = join(fixture, "Slot-other");
    fs.mkdirSync(sibling);
    const outside = join(sibling, "sibling.txt");
    const note = join(temp, "note.txt");
    fs.writeFileSync(picture, Buffer.from("89504e470d0a1a0a00000000", "hex"));
    fs.writeFileSync(outside, "outside");
    fs.writeFileSync(note, "note");
    for (const target of [picture, picture.replaceAll("\\", "/"), "output.png", decodeURIComponent(pathToFileURL(picture).href)]) {
      const result = checkLocal(slot.toUpperCase(), target, true);
      expect("real" in result && sameDirectory(result.real, fs.realpathSync(picture))).toBe(true);
    }
    expect(checkLocal(slot, note, false)).toEqual({ real: fs.realpathSync(note) });
    expect(checkLocal(slot, note, true)).toEqual({ why: "不是图片" });
    expect(checkLocal(slot, outside, false)).toEqual({ why: "不在槽位目录或 /tmp 里" });
    const junction = join(slot, "escape");
    fs.symlinkSync(sibling, junction, "junction");
    expect(checkLocal(slot, join(junction, "sibling.txt"), false)).toEqual({ why: "不在槽位目录或 /tmp 里" });
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("network, device and drive-less rooted reply paths are rejected before filesystem access", () => {
  const lookup = spyOn(fs, "realpathSync").mockReturnValue("");
  const stat = spyOn(fs, "statSync").mockImplementation(() => { throw Error("unexpected stat"); });
  try {
    for (const target of [String.raw`\\host\share\pic.png`, String.raw`\\?\C:\slot\pic.png`, String.raw`\\.\pipe\test`, "//host/share", "/rooted", "\\rooted", "file://host/share", "file:////host/share"]) {
      expect(checkLocal("C:\\slot", target, false)).toEqual({ why: "不在槽位目录或 /tmp 里" });
    }
    expect(lookup).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  } finally {
    stat.mockRestore();
    lookup.mockRestore();
  }
});

test.skipIf(process.platform !== "win32")("Codex ImageView rejects network and rooted paths before looking up any file", async () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), "rhodium-test-viewed-"));
  const transcript = join(tmp, "events.jsonl");
  const paths = [String.raw`\\host\share\x.png`, String.raw`\\?\C:\x.png`, String.raw`\\.\pipe\x`, "//host/share", "/rooted"];
  fs.writeFileSync(transcript, paths.map((path, i) => JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "item_completed", thread_id: "t", turn_id: "u", item: { type: "ImageView", id: String(i), path } } })).join("\n") + "\n");
  const lookup = spyOn(fs, "realpathSync").mockReturnValue("");
  const stat = spyOn(fs, "statSync").mockImplementation(() => { throw Error("unexpected stat"); });
  try {
    const { blocks } = await messagePage(transcript, Infinity, "backward", tmp, tmp);
    expect(blocks.map(b => b.kind === "tool" && b.result?.media)).toEqual(paths.map(() => undefined));
    expect(lookup).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  } finally {
    stat.mockRestore(); lookup.mockRestore();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
