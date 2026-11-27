import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vim } from "../src/tui";
import { managedVimFile, nativeVimLaunch, rememberVimLaunch } from "../src/tui-vim";

test("native Claude managed JSON lives in the platform policy directory", () => {
  expect(managedVimFile("linux")).toBe("/etc/claude-code/managed-settings.json");
  expect(managedVimFile("darwin")).toBe("/Library/Application Support/ClaudeCode/managed-settings.json");
  expect(managedVimFile("win32", "D:\\Program Files")).toBe("D:\\Program Files\\ClaudeCode\\managed-settings.json");
});

test("native vim checks live argv and cwd, then the same process's launch receipt, in Linux settings order", () => {
  const root = mkdtempSync(join(tmpdir(), "rhodium-test-tui-vim-"));
  const home = join(root, "home"), slot = join(root, "slot"), cwd = join(root, "process cwd");
  const holder = join(root, "new holder"), managed = join(root, "managed.json");
  const pid = 55, start = 1000;
  const setting = (file: string, mode: string) => writeFileSync(file, JSON.stringify({ editorMode: mode }));
  try {
    mkdirSync(join(slot, ".claude"), { recursive: true });
    mkdirSync(join(home, ".claude"), { recursive: true });
    mkdirSync(cwd);
    setting(join(home, ".claude.json"), "vim");
    const current = (argv?: string[], currentDir?: string, born: number = start) => {
      const info = nativeVimLaunch(holder, pid, born, [{ pid: 85, argv: ["--settings=wrong.json"], cwd: slot }, { pid, argv, cwd: currentDir }]);
      return vim(slot, pid, home, info, managed);
    };
    expect(current()).toBe(true);
    setting(join(home, ".claude/settings.json"), "normal");
    expect(current()).toBe(false);
    setting(join(slot, ".claude/settings.json"), "vim");
    expect(current()).toBe(true);
    setting(join(slot, ".claude/settings.local.json"), "normal");
    expect(current()).toBe(false);
    rememberVimLaunch(holder, pid, start, ["claude", "--settings", '{"unrelated":"synthetic-canary","editorMode":"vim"}'], cwd);
    expect(readFileSync(join(holder, "tui-vim.json"), "utf8")).not.toContain("synthetic-canary");
    expect(current()).toBe(true);
    expect(current(undefined, undefined, start + 1)).toBe(false);
    expect(current(["claude"])).toBe(false); // Live argv explicitly contains no flag.
    expect(current(["claude", "--settings", '{"editorMode":"normal"}'])).toBe(false);
    setting(join(cwd, "relative file.json"), "vim");
    setting(join(slot, "relative file.json"), "normal");
    const args = ["claude", "--settings", '{"editorMode":"normal"}', "--settings=relative file.json"];
    expect(current(args)).toBe(true); // Missing live cwd: resolve against the receipt.
    expect(current(args, slot)).toBe(false);
    expect(current(["claude", "--settings", join(cwd, "relative file.json")], undefined, start + 1)).toBe(true);
    rememberVimLaunch(holder, pid, start, args, cwd);
    expect(current()).toBe(true);
    setting(managed, "normal");
    expect(current()).toBe(false);
    rmSync(managed);
    setting(join(cwd, "relative file.json"), "normal");
    expect(current()).toBe(false); // Read settings files again on each decision.
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
