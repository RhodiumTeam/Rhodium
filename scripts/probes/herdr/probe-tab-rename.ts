#!/usr/bin/env bun
// What Herdr does with tab.rename (#244), recorded for the fake Herdr's test to compare against.
//
// Runs a Herdr server for session `rhodium-test` under a temporary HOME, so neither your Herdr
// sessions nor its config are touched, and stops it at the end. Makes Rhodium's workspace with the
// slot's tab, and a workspace of yours; renames the slot's tab, then one that is not there. No agent runs.
//
//   bun scripts/probes/herdr/probe-tab-rename.ts [--fixture PATH]
//
// Prints the tabs before and after. --fixture writes the socket traffic, requests and answers then
// the events heard, the temporary directory replaced by /work, as test/fixtures/herdr/tab-rename.jsonl is.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { call, subscribe } from "../../../src/herdr";
import { synthPath } from "../synth";

const HERDR = process.env.HERDR_BIN ?? join(homedir(), ".local/bin/herdr");
const at = process.argv.indexOf("--fixture");
const FIXTURE = at > 0 ? process.argv[at + 1] : undefined;

const work = mkdtempSync(join(tmpdir(), "rhodium-test-tab-rename-"));
const socket = join(work, ".config/herdr/sessions/rhodium-test/herdr.sock");
const server = Bun.spawn([HERDR, "--session", "rhodium-test", "server"], { env: { HOME: work, PATH: process.env.PATH! }, stdout: "ignore", stderr: "ignore" });
const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => log.push({ t: Date.now() - t0, dir, msg });
let n = 0;
async function ask(method: string, params: object = {}): Promise<any> {
  const id = `tr:${++n}`;
  rec(">>", { id, method, params });
  const answer = { ...(await call(socket, method, params)), id };
  rec("<<", answer);
  return answer;
}

try {
  for (const end = Date.now() + 10_000; !(await call(socket, "ping").catch(() => undefined)); await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error("no Herdr socket in 10 s");
  }
  const sub = subscribe(socket, ["workspace.created", "workspace.closed", "tab.created", "tab.closed", "tab.renamed"]);
  await sub.started;
  const ours = (await ask("workspace.create", { cwd: work, label: "w", focus: false })).result;
  const slot = (await ask("tab.create", { workspace_id: ours.workspace.workspace_id, cwd: work, label: "a" })).result;
  const yours = (await ask("workspace.create", { cwd: work, label: "yours", focus: false })).result;
  const tabs = async () => (await ask("session.snapshot")).result.snapshot.tabs.map((t: any) => `${t.tab_id} ${t.label}`).join(", ");
  console.log(`before: ${await tabs()}`);
  await ask("tab.rename", { tab_id: slot.tab.tab_id, label: "c" });
  console.log(`after:  ${await tabs()}`);
  await ask("tab.rename", { tab_id: "w99:t9", label: "x" });
  for (const tab of [slot.tab, ours.tab, yours.tab]) await ask("tab.close", { tab_id: tab.tab_id });
  await Bun.sleep(300);
  for (const e of sub.events) rec("ev", e);
  sub.close();
  if (FIXTURE) {
    writeFileSync(FIXTURE, log.map((l) => JSON.stringify(l).replaceAll(work, "/work")).join("\n") + "\n");
    synthPath(FIXTURE, "herdr");
  }
} finally {
  server.kill();
  await server.exited;
  rmSync(work, { recursive: true, force: true });
}
