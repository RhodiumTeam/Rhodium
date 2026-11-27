// The web terminal's own selection of what it draws (spec web-terminal "鼠标"), against ghostty-web's
// real terminal: a CJK character is two cells wide, its second an empty spacer.
import { expect, test } from "bun:test";
import { Ghostty } from "ghostty-web";
import { selectedText, wordAt } from "../web/src/terminal";

const ghostty = await Ghostty.load();
/** A terminal of 40x4 with lines drawn, and the cells of each row. */
function drawn(...lines: string[]) {
  const t = ghostty.createTerminal(40, 4);
  t.write(new TextEncoder().encode(lines.join("\r\n")));
  return { t, row: (r: number) => t.getLine(r)! };
}
const at = (col: number, absoluteRow: number) => ({ col, absoluteRow });

test("#805: a drag over CJK takes each character once, no space after it; real spaces stay, trailing blanks go; across rows each ends a line", () => {
  const { t } = drawn("以后改驱动建议只改", "走 ssh 中文abc   ", "x");
  expect(selectedText(t, at(0, 0), at(39, 0))).toBe("以后改驱动建议只改");
  expect(selectedText(t, at(0, 1), at(39, 1))).toBe("走 ssh 中文abc");
  // From the right, and starting on the second half of 后.
  expect(selectedText(t, at(8, 1), at(3, 0))).toBe("后改驱动建议只改\n走 ssh 中");
  expect(selectedText(t, at(0, 1), at(5, 2))).toBe("走 ssh 中文abc\nx");
  expect(selectedText(t, at(2, 1), at(2, 1))).toBe("");
});

test("#805: a double click on CJK takes the word Intl.Segmenter finds there, on either half of a character; on a word, a number or a path as before; on a blank or a mark nothing", () => {
  const { row } = drawn("以后改驱动建议只改，走 ssh", "cat /a/b-c.txt 42", "   ");
  const words = new Intl.Segmenter("zh-CN", { granularity: "word" });
  // 驱动 is cells 6 to 9.
  expect([...words.segment("以后改驱动建议只改")].map((s) => s.segment)).toContain("驱动");
  expect(wordAt(row(0), 6, "zh-CN")).toEqual({ startCol: 6, endCol: 9 });
  expect(wordAt(row(0), 9, "zh-CN")).toEqual({ startCol: 6, endCol: 9 });
  expect(wordAt(row(0), 0, "zh-CN")).toEqual({ startCol: 0, endCol: 3 });
  expect(wordAt(row(0), 18, "zh-CN")).toBeNull();
  expect(wordAt(row(0), 23, "zh-CN")).toEqual({ startCol: 23, endCol: 25 });
  expect(wordAt(row(1), 0, "zh-CN")).toEqual({ startCol: 0, endCol: 2 });
  // A path stops at / and ., as ghostty-web's [\w-] does.
  expect(wordAt(row(1), 7, "zh-CN")).toEqual({ startCol: 7, endCol: 9 });
  expect(wordAt(row(1), 15, "zh-CN")).toEqual({ startCol: 15, endCol: 16 });
  expect(wordAt(row(1), 3, "zh-CN")).toBeNull();
  expect(wordAt(row(2), 1, "zh-CN")).toBeNull();
});

test("#805: the blank Ghostty leaves at a line's end, where a CJK character didn't fit, is a blank: a drag from it takes nothing of the character before, a double click on it selects nothing", () => {
  const t = ghostty.createTerminal(10, 4);
  t.write(new TextEncoder().encode("ls foo/ba中文"));
  // Cell 9 of row 0 is that blank, two cells wide 中 went on to row 1.
  expect(t.getLine(0)![9]!.width).toBe(0);
  expect(selectedText(t, at(9, 0), at(3, 1))).toBe("\n中文");
  expect(wordAt(t.getLine(0)!, 9, "zh-CN")).toBeNull();
});
