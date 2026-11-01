// Panels as docs/im-style.md §9 and §11 draw them: buttons two a row by width, short ones up to four,
// pages of 8 numbered across pages, and the steps back and forth. Pure: no rhodium needed.
import { expect, test } from "bun:test";
import { buttonRows, CANCEL, moment, showPanel, type Panel } from "../src/panels";

const refs = ["Rhodium/docs", "Rhodium/main", "Rhodium/pi", "shop/api", "shop/bench", "shop/docs-site", "shop/fix-login", "shop/review"];
const use = (current: string): Panel => ({
  command: "/rh_use",
  head: ["这里的消息交给谁？", `现在：${current}`],
  candidates: [
    { label: "回到默认（dispatcher/main）", command: "/rh_use -" },
    ...refs.map((r) => ({ label: r, command: `/rh_use ${r}`, current: r === current })),
  ],
});
/** Each row of buttons as its labels. */
const rows = (s: ReturnType<typeof showPanel>) => buttonRows(s.buttons).map((r) => r.map((b) => b.label));

test("§9.2: a panel that fits one page goes unnumbered, names two a row when both are narrow, the one now marked ✓; 取消 last", () => {
  const p = { ...use("Rhodium/pi"), candidates: use("Rhodium/pi").candidates.slice(0, 4) };
  const s = showPanel(p, 1, { edits: false });
  expect(s.text).toBe("这里的消息交给谁？\n现在：Rhodium/pi");
  expect(rows(s)).toEqual([["回到默认（dispatcher/main）"], ["Rhodium/docs", "Rhodium/main"], ["✓ Rhodium/pi"], ["取消"]]);
  expect(s.buttons.at(-1)).toMatchObject({ data: CANCEL, muted: true });
  expect(s.buttons.find((b) => b.label === "✓ Rhodium/pi")!.data).toBe("/rh_use Rhodium/pi");
  expect(s.numbered).toBeNull();
});

test("§9.2: more than 8 page, numbered across pages, with 下一页 and 上一页 to move between them", () => {
  const first = showPanel(use("Rhodium/pi"), 1, { edits: false });
  expect(first.text).toBe("这里的消息交给谁？\n现在：Rhodium/pi\n第 1 页，共 2 页。也可以回编号。");
  expect(rows(first)).toEqual([
    ["1. 回到默认（dispatcher/main）"],
    ["2. Rhodium/docs", "3. Rhodium/main"],
    ["✓ 4. Rhodium/pi", "5. shop/api"],
    ["6. shop/bench", "7. shop/docs-site"],
    ["下一页", "取消"],
  ]);
  expect(first.buttons.find((b) => b.label === "下一页")).toMatchObject({ data: "page:2:/rh_use", muted: true });
  expect(first.numbered).toEqual(["/rh_use -", ...refs.map((r) => `/rh_use ${r}`)]);
  const second = showPanel(use("Rhodium/pi"), 2, { edits: false });
  expect(second.text).toBe("这里的消息交给谁？\n现在：Rhodium/pi\n第 2 页，共 2 页。也可以回编号。");
  expect(rows(second)).toEqual([["8. shop/fix-login", "9. shop/review"], ["上一页", "取消"]]);
});

test("§11.2: short options of one group share a row, up to four; 返回 only where the message is edited in place", () => {
  const effort: Panel = {
    command: "/effort",
    head: ["思考强度改成哪档？", "现在：high"],
    short: true,
    back: "/status",
    candidates: ["low", "medium", "high", "max"].map((l) => ({ label: l, command: `/effort ${l}`, current: l === "high" })),
  };
  expect(rows(showPanel(effort, 1, { edits: false }))).toEqual([["low", "medium", "✓ high", "max"], ["取消"]]);
  const edited = showPanel(effort, 1, { edits: true });
  expect(rows(edited)).toEqual([["low", "medium", "✓ high", "max"], ["返回", "取消"]]);
  expect(edited.buttons.find((b) => b.label === "返回")).toMatchObject({ data: "/status", muted: true });
});

test("§11.2: a name too wide for two a row takes a row of its own, cut short past 36 columns", () => {
  const p: Panel = {
    command: "/resume",
    head: ["回到哪段对话？"],
    candidates: [
      { label: "17:43 你好，帮我看下测试…", command: "/resume a" },
      { label: "昨天 22:10 把 README 的安装…", command: "/resume b" },
      { label: "x".repeat(50), command: "/resume c" },
    ],
  };
  expect(rows(showPanel(p, 1, { edits: false }))).toEqual([["17:43 你好，帮我看下测试…"], ["昨天 22:10 把 README 的安装…"], [`${"x".repeat(35)}…`], ["取消"]]);
});

test("§2.4: a moment is the time today, 昨天 and the time yesterday, month and day this year, the date before", () => {
  const now = new Date(2026, 9, 21, 18, 0).getTime();
  expect(moment(new Date(2026, 9, 21, 9, 5).getTime(), now)).toBe("09:05");
  expect(moment(new Date(2026, 9, 20, 22, 10).getTime(), now)).toBe("昨天 22:10");
  expect(moment(new Date(2026, 9, 18, 9, 12).getTime(), now)).toBe("10/18 09:12");
  expect(moment(new Date(2025, 9, 18, 9, 12).getTime(), now)).toBe("2025/10/18");
});
