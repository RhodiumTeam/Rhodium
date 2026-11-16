#!/usr/bin/env bun
// What Herdr's pane.read gives back (#710, architecture §10.3), recorded for the fake Herdr's test to
// compare against.
//
// Runs a Herdr server for session `rhodium-test` under a temporary HOME, so neither your Herdr
// sessions nor its config are touched, and stops it at the end. Its one pane runs `cat` after printing
// a line in dim, red and bright black; no agent runs. Reads that pane from each source in each format,
// with and without strip_ansi, then a pane that is not there.
//
//   bun scripts/probes/herdr/probe-pane-read.ts [--fixture PATH]
//
// Prints each read's text. --fixture writes the socket traffic, the temporary directory replaced by
// /work, as test/fixtures/herdr/pane-read.jsonl is.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../../../src/herdr";
import { synthPath } from "../synth";

const HERDR = process.env.HERDR_BIN ?? join(homedir(), ".local/bin/herdr");
const at = process.argv.indexOf("--fixture");
const FIXTURE = at > 0 ? process.argv[at + 1] : undefined;

const work = mkdtempSync(join(tmpdir(), "rhodium-test-pane-read-"));
const socket = join(work, ".config/herdr/sessions/rhodium-test/herdr.sock");
const server = Bun.spawn([HERDR, "--session", "rhodium-test", "server"], { env: { HOME: work, PATH: process.env.PATH! }, stdout: "ignore", stderr: "ignore" });
const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => log.push({ t: Date.now() - t0, dir, msg });
let n = 0;
async function ask(method: string, params: object = {}): Promise<any> {
  const id = `pr:${++n}`;
  rec(">>", { id, method, params });
  const answer = { ...(await call(socket, method, params)), id };
  rec("<<", answer);
  return answer;
}

try {
  for (const end = Date.now() + 10_000; !(await call(socket, "ping").catch(() => undefined)); await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error("no Herdr socket in 10 s");
  }
  const ws = (await ask("workspace.create", { cwd: work, label: "w", focus: false })).result;
  const line = String.raw`printf '\033[2mdim\033[0m plain \033[31mred\033[0m \033[90mgrey\033[0m\n'; exec cat`;
  const { layout } = (await ask("layout.apply", { workspace_id: ws.workspace.workspace_id, tab_label: "cat", root: { type: "pane", cwd: work, command: ["/bin/sh", "-c", line] } })).result;
  const pane = layout.root.pane_id;
  await Bun.sleep(500);
  for (const source of ["recent", "detection", "visible"]) {
    for (const format of ["ansi", "text"]) {
      const a = await ask("pane.read", { pane_id: pane, source, format, strip_ansi: false });
      console.log(`${source} ${format}: ${JSON.stringify(a.result.read.text)}`);
    }
  }
  // strip_ansi left out, and true: Herdr 0.9.5 does not look at it.
  for (const extra of [{}, { strip_ansi: true }]) await ask("pane.read", { pane_id: pane, source: "recent", format: "ansi", ...extra });
  await ask("pane.read", { pane_id: "w99:p9", source: "recent", format: "ansi", strip_ansi: false });
  await ask("tab.close", { tab_id: layout.tab_id });
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
