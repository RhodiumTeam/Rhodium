// The row and the / menu as defined (spec im-buttons, its first ticket): the / menu holds the agent's
// commands and /rh_help last, as the board's palette does; QQ's row holds Rhodium's own, within the
// platform's limits (architecture §8.4).
import { expect, test } from "bun:test";
import { commandsFor } from "../src/board";
import { QQ_ROW, QQ_ROW_FLAT, slashMenu } from "../src/commands";

const names = (agent?: "claude" | "pi" | null) => slashMenu(agent).map((i) => i.command);
const CLAUDE = ["/stop", "/new", "/status", "/resume", "/model", "/usage", "/context", "/compact", "/effort", "/ultracode", "/rh_help"];
const PI = CLAUDE.filter((c) => c !== "/ultracode");

test("story 326: a Claude slot's / menu is its 11 commands in order, a pi slot's 10 with /usage (story 397); no rh_ one but /rh_help, last", () => {
  expect(names("claude")).toEqual(CLAUDE);
  expect(names("pi")).toEqual(PI);
  for (const agent of ["claude", "pi"] as const) expect(names(agent).filter((c) => c.startsWith("/rh_"))).toEqual(["/rh_help"]);
  for (const item of slashMenu("claude")) expect(item.description).not.toBe("");
});

test("story 326: the board's palette and the / menu list the same commands but /rh_help; with no agent, both as a pi slot, without /ultracode", () => {
  for (const agent of ["claude", "pi", null] as const) expect(commandsFor(agent).map((c) => `/${c.name}`)).toEqual(names(agent).slice(0, -1));
  expect(names(null)).toEqual(PI);
  expect(names()).toEqual(PI);
});

// QQ's limits (architecture §8.4): 10 buttons, names of 10 characters; 5 in a folder, names of 14; a Chinese one counts 2.
const width = (s: string) => [...s].reduce((n, c) => n + (c.charCodeAt(0) < 128 ? 1 : 2), 0);

test("stories 323, 324: QQ's row is 停止、槽位、切换、换 agent、帮助 and the folders 终端 and 更多, within QQ's limits; the flat one too", () => {
  expect(QQ_ROW.map((b) => b.label)).toEqual(["停止", "槽位", "切换", "换 agent", "帮助", "终端", "更多"]);
  expect(QQ_ROW.flatMap((b) => ("sub" in b ? b.sub : [b])).map((b) => b.command)).toEqual([
    "/stop", "/rh_ls", "/rh_use", "/rh_agent", "/rh_help", "/rh_tui", "/rh_release", "/rh_rename", "/rh_archive", "/rh_import", "/rh_bind", "/rh_verbose",
  ]);
  for (const row of [QQ_ROW, QQ_ROW_FLAT]) {
    expect(row.length).toBeLessThanOrEqual(10);
    for (const b of row) {
      expect(width(b.label)).toBeLessThanOrEqual(10);
      if (!("sub" in b)) continue;
      expect(b.sub.length).toBeLessThanOrEqual(5);
      for (const s of b.sub) expect(width(s.label)).toBeLessThanOrEqual(14);
    }
  }
  expect(QQ_ROW_FLAT.map((b) => b.label)).toEqual(["停止", "槽位", "切换", "换 agent", "帮助", "切到 TUI", "切回无头", "改名", "归档", "导入"]);
});
