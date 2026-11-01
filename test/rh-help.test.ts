import { afterAll, expect, test } from "bun:test";
import { newInstance } from "./instance";

// No rhodium running: help and the skill must not need one.
const rhodium = newInstance();
afterAll(() => rhodium.cleanup());

// The commands shipped so far, and who may run them (docs/spec/v1.md "rh 命令").
const shipped = ["ls", "ws", "new", "spawn", "stop", "archive", "unarchive", "rm", "rename", "agent", "tui", "release", "import", "send", "read", "set", "doctor", "use", "bind", "bot", "pair", "trace", "forget"].sort();
const onlyYou = ["rm", "set", "bot", "trace"];

test("rh --help and rh --skill list the same commands, from one definition", async () => {
  const help = await rhodium.rh(["--help"]);
  const skill = await rhodium.rh(["--skill"]);
  expect([help.code, skill.code]).toEqual([0, 0]);

  const helpCommands = [...help.out.matchAll(/^ {2}rh (\S+)/gm)].map((m) => m[1]).sort();
  const skillCommands = [...skill.out.matchAll(/^- `rh (\S+)/gm)].map((m) => m[1]).sort();
  expect(helpCommands).toEqual(shipped);
  expect(skillCommands).toEqual(shipped);
});

test("each command says whether only you may run it, or agents too", async () => {
  const help = (await rhodium.rh(["--help"])).out;
  const skill = (await rhodium.rh(["--skill"])).out;
  for (const name of shipped) {
    // In the help, the line after "rh <name>" carries the mark; in the skill, the same line does.
    const helpEntry = help.split(/\n(?= {2}rh )/).find((e) => e.startsWith(`  rh ${name} `))!;
    const skillEntry = skill.split("\n").find((l) => l.startsWith(`- \`rh ${name} `))!;
    if (onlyYou.includes(name)) {
      expect(helpEntry).toContain("只有你");
      expect(skillEntry).toContain("agent 调用会被拒绝");
    } else {
      expect(helpEntry).toContain("你和 agent");
      expect(skillEntry).not.toContain("agent 调用会被拒绝");
    }
  }
});

test("rh with no arguments prints the help", async () => {
  const r = await rhodium.rh([]);
  expect(r.code).toBe(0);
  expect(r.out).toBe((await rhodium.rh(["--help"])).out);
});

test("rh --skill tells agents rh release asks the user first even for their own descendants, and returns at once", async () => {
  const skill = (await rhodium.rh(["--skill"])).out;
  const release = skill.split("\n").find((l) => l.startsWith("- `rh release "))!;
  expect(release).not.toContain("直接执行");
  expect(release).toContain("rh 立刻返回“已请用户确认”");
});
