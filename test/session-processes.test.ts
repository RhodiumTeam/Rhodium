import { expect, test } from "bun:test";
import { matchingProcesses } from "../src/session-processes";

test("only a command naming this session claims it, except the import command itself", () => {
  const id = crypto.randomUUID();
  const cmds = [
    "codex app-server", "pi --session-id other", `arbitrary-tool "${id}"`,
    `"/some path/rh" import ${id}`, `"C:\\Program Files\\Rhodium\\rh.exe" import ${id}`,
    `rhodium.exe rh import ${id}`, `bun --no-env-file /code/src/main.ts rh import ${id}`,
    `claude --resume ${id} --prompt "what does rh import do?"`,
    `pi --session-id ${id}`,
  ];
  const rows = cmds.map((command, i) => ({ command, pid: process.pid + i + 1 }));
  expect(matchingProcesses(rows, id)).toEqual([rows[2]!.pid, rows[7]!.pid, rows[8]!.pid]);
});

test("unquoted executable paths from ps and shell script arguments are distinguished", () => {
  const id = crypto.randomUUID();
  const rows = [
    { pid: 101, image: "/Users/test/My Tools/rh", command: `/Users/test/My Tools/rh import ${id}` },
    { pid: 102, image: "/Users/test/Tools With Spaces/rhodium", command: `/Users/test/Tools With Spaces/rhodium rh import ${id}` },
    { pid: 103, image: "/bin/sh", command: `/bin/sh /tmp/agent.sh --resume ${id} --message 'how does rh import work'` },
    { pid: 104, image: "/bin/sh", command: `/bin/sh -c 'rh import ${id}'` },
  ];
  expect(matchingProcesses(rows, id)).toEqual([103].filter((pid) => pid !== process.pid));
});
