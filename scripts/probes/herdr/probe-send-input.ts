#!/usr/bin/env bun
// What Herdr's pane.send_input with text alone and pane.send_keys ["enter"] write into a pane (#712,
// architecture §10.3, §10.5), recorded for the fake Herdr's test to compare against.
//
// Runs a Herdr server for session `rhodium-test` under a temporary HOME, so neither your Herdr
// sessions nor its config are touched, and stops it at the end. No agent runs: each pane runs a small
// Python reader that puts its terminal in raw mode and prints the bytes of each read, one pane with
// bracketed paste turned on and one without. Writes a three-line text with send_input, reads the
// screen, presses enter with send_keys, reads it again; then both methods on a pane that is not there.
//
//   bun scripts/probes/herdr/probe-send-input.ts [--fixture PATH]
//
// Prints each screen. --fixture writes the socket traffic, the temporary directory replaced by
// /work, as test/fixtures/herdr/send-input.jsonl is.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../../../src/herdr";
import { synthPath } from "../synth";

const HERDR = process.env.HERDR_BIN ?? join(homedir(), ".local/bin/herdr");
const at = process.argv.indexOf("--fixture");
const FIXTURE = at > 0 ? process.argv[at + 1] : undefined;

const work = mkdtempSync(join(tmpdir(), "rhodium-test-send-input-"));
const socket = join(work, ".config/herdr/sessions/rhodium-test/herdr.sock");
const server = Bun.spawn([HERDR, "--session", "rhodium-test", "server"], { env: { HOME: work, PATH: process.env.PATH! }, stdout: "ignore", stderr: "ignore" });
const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => log.push({ t: Date.now() - t0, dir, msg });
let n = 0;
async function ask(method: string, params: object = {}): Promise<any> {
  const id = `si:${++n}`;
  rec(">>", { id, method, params });
  const answer = { ...(await call(socket, method, params)), id };
  rec("<<", answer);
  return answer;
}

/** Prints the repr of each read off its raw terminal, so every byte shows; bracketed paste on if asked. */
const reader = (paste: boolean) =>
  `import os,sys,tty\n${paste ? "sys.stdout.write('\\x1b[?2004h')\n" : ""}tty.setraw(0)\nsys.stdout.write('ready\\r\\n');sys.stdout.flush()\nwhile True:\n  b=os.read(0,4096)\n  sys.stdout.write(repr(b)+'\\r\\n');sys.stdout.flush()\n`;

try {
  for (const end = Date.now() + 10_000; !(await call(socket, "ping").catch(() => undefined)); await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error("no Herdr socket in 10 s");
  }
  const ws = (await ask("workspace.create", { cwd: work, label: "w", focus: false })).result;
  for (const paste of [true, false]) {
    const label = paste ? "paste" : "plain";
    const { layout } = (await ask("layout.apply", { workspace_id: ws.workspace.workspace_id, tab_label: label, root: { type: "pane", cwd: work, command: ["python3", "-c", reader(paste)] } })).result;
    const pane = layout.root.pane_id;
    await Bun.sleep(800);
    await ask("pane.send_input", { pane_id: pane, text: "[来自 Rhodium：子槽位汇报]\nline two\tTAB\nline three", keys: [] });
    await Bun.sleep(400);
    const typed = await ask("pane.read", { pane_id: pane, source: "recent", format: "text", strip_ansi: false });
    console.log(`${label} after send_input:\n${typed.result.read.text}`);
    await ask("pane.send_keys", { pane_id: pane, keys: ["enter"] });
    await Bun.sleep(400);
    const entered = await ask("pane.read", { pane_id: pane, source: "recent", format: "text", strip_ansi: false });
    console.log(`${label} after send_keys:\n${entered.result.read.text}`);
    await ask("tab.close", { tab_id: layout.tab_id });
  }
  await ask("pane.send_input", { pane_id: "w99:p9", text: "x", keys: [] });
  await ask("pane.send_keys", { pane_id: "w99:p9", keys: ["enter"] });
  await ask("tab.close", { tab_id: ws.tab.tab_id });
  if (FIXTURE) {
    writeFileSync(FIXTURE, log.map((l) => JSON.stringify(l).replaceAll(work, "/work")).join("\n") + "\n");
    synthPath(FIXTURE, "herdr");
  }
} finally {
  server.kill();
  await server.exited;
  rmSync(work, { recursive: true, force: true });
}
