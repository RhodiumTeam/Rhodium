#!/usr/bin/env bun
// What Herdr's `terminal session control` does (architecture §10.4, spec web-terminal), recorded for
// the fake Herdr's test to compare against.
//
// Runs a Herdr server for session `rhodium-test` under a temporary HOME, so neither your Herdr
// sessions nor its config are touched, and stops it at the end. Opens a workspace whose pane runs sh,
// then one terminal session control after another on its pane: A attaches, types, resizes and
// scrolls; B without --takeover is refused; C with it takes over from A, then lets go; D's stdin
// ends; E types exit, and the pane's process exits; F asks for a pane that is not there; I's pane is
// closed under it; Herdr stops under H, attached to another pane, and G finds no Herdr. No agent runs.
//
//   bun scripts/probes/herdr/probe-terminal.ts [--fixture PATH]
//
// Prints each line as it comes. --fixture writes them, the temporary directory replaced by /work, as
// test/fixtures/herdr/terminal-control.jsonl is: dir "X>" a line written to session X's stdin, "X<"
// one read from its stdout, "X exit" its exit code and the lines of its stderr.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { call } from "../../../src/herdr";
import { synthPath } from "../synth";

const HERDR = process.env.HERDR_BIN ?? join(homedir(), ".local/bin/herdr");
const SESSION = "rhodium-test";
const at = process.argv.indexOf("--fixture");
const FIXTURE = at > 0 ? process.argv[at + 1] : undefined;

const work = mkdtempSync(join(tmpdir(), "rhodium-test-terminal-"));
const env = { HOME: work, PATH: process.env.PATH!, SHELL: "/bin/sh", TERM: "xterm-256color" };
const socket = join(work, `.config/herdr/sessions/${SESSION}/herdr.sock`);
const server = Bun.spawn([HERDR, "--session", SESSION, "server"], { env, stdout: "ignore", stderr: "ignore" });
const t0 = Date.now();
const log: { t: number; dir: string; msg: unknown }[] = [];
const rec = (dir: string, msg: unknown) => {
  log.push({ t: Date.now() - t0, dir, msg });
  console.log(dir, JSON.stringify(msg).slice(0, 200));
};

/** A terminal session control on pane, as X: lines lists what it printed, closed resolves on its exit. */
function control(name: string, pane: string, ...flags: string[]) {
  const proc = Bun.spawn([HERDR, "--session", SESSION, "terminal", "session", "control", pane, ...flags], { env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  rec(`${name} argv`, ["terminal", "session", "control", pane, ...flags]);
  const lines: any[] = [];
  const reading = (async () => {
    let buf = "";
    for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
        const msg = JSON.parse(buf.slice(0, i));
        lines.push(msg);
        rec(`${name}<`, msg);
      }
    }
  })();
  const closed = (async () => {
    const [code, err] = await Promise.all([proc.exited, new Response(proc.stderr).text(), reading]);
    rec(`${name} exit`, { code, stderr: err.trim() ? err.trim().split("\n") : [] });
  })();
  return {
    lines,
    closed,
    send(msg: object) {
      rec(`${name}>`, msg);
      proc.stdin.write(JSON.stringify(msg) + "\n");
      proc.stdin.flush();
    },
    end: () => (rec(`${name}>`, "EOF"), proc.stdin.end()),
    /** Waits until it printed a line that test passes, at most 5 s. */
    async until(test: (msg: any) => boolean) {
      for (const end = Date.now() + 5_000; !lines.some(test); await Bun.sleep(20)) if (Date.now() > end) throw new Error(`${name}: waited 5 s`);
    },
  };
}
const frame = (m: any) => m.type === "terminal.frame";
const closed = (m: any) => m.type === "terminal.closed";
const settle = () => Bun.sleep(400);

try {
  for (const end = Date.now() + 10_000; !(await call(socket, "ping").catch(() => undefined)); await Bun.sleep(50)) {
    if (Date.now() > end) throw new Error("no Herdr socket in 10 s");
  }
  const ws = (await call(socket, "workspace.create", { cwd: work, label: "w", focus: false })).result;
  const pane: string = ws.root_pane.pane_id;
  rec("pane", pane);
  await Bun.sleep(500); // the shell's prompt

  const a = control("A", pane, "--cols", "50", "--rows", "20");
  await a.until(frame);
  a.send({ type: "terminal.input", text: "echo hello\r" });
  await a.until((m) => frame(m) && atob(m.bytes).includes("hello"));
  await settle();
  a.send({ type: "terminal.resize", cols: 40, rows: 12 });
  await a.until((m) => frame(m) && m.width === 40 && m.height === 12);
  await settle();
  a.send({ type: "terminal.input", text: "seq 1 30\r" });
  await settle();
  a.send({ type: "terminal.scroll", direction: "up", lines: 5 });
  await settle();
  a.send({ type: "terminal.scroll", direction: "down", lines: 5 });
  await settle();

  const b = control("B", pane, "--cols", "30", "--rows", "10");
  await b.closed;

  const c = control("C", pane, "--takeover", "--cols", "30", "--rows", "10");
  await a.closed;
  await c.until(frame);
  await settle();
  c.send({ type: "terminal.release" });
  await c.closed;

  const d = control("D", pane, "--cols", "30", "--rows", "10");
  await d.until(frame);
  await settle();
  d.end();
  await d.closed;

  const e = control("E", pane, "--cols", "30", "--rows", "10");
  await e.until(frame);
  e.send({ type: "terminal.input", text: "exit\r" });
  await e.closed;

  const f = control("F", "w9:p9", "--cols", "30", "--rows", "10");
  await f.closed;

  // I's pane is closed under it, as Rhodium closes a slot's tab.
  const closing = (await call(socket, "workspace.create", { cwd: work, label: "w", focus: false })).result;
  await Bun.sleep(500);
  const i = control("I", closing.root_pane.pane_id, "--cols", "30", "--rows", "10");
  await i.until(frame);
  rec("tab.close", closing.tab.tab_id);
  await call(socket, "tab.close", { tab_id: closing.tab.tab_id });
  await i.closed;

  // Herdr stops under H, as it does to restart; then G finds no server.
  const other = (await call(socket, "workspace.create", { cwd: work, label: "w", focus: false })).result.root_pane.pane_id;
  await Bun.sleep(500);
  const h = control("H", other, "--cols", "30", "--rows", "10");
  await h.until(frame);
  rec("stop", null);
  server.kill();
  await server.exited;
  await h.closed;
  const g = control("G", other, "--cols", "30", "--rows", "10");
  await g.closed;

  if (FIXTURE) {
    writeFileSync(FIXTURE, log.map((l) => JSON.stringify(l).replaceAll(work, "/work")).join("\n") + "\n");
    synthPath(FIXTURE, "herdr");
  }
} finally {
  server.kill();
  await server.exited;
  rmSync(work, { recursive: true, force: true });
}
