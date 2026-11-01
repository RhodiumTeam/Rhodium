// Checks the recorded Herdr socket traffic (test/fixtures/herdr/probe-18.jsonl) against
// the interface list in docs/architecture.md §10.3, which the fake Herdr copies.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Herdr messages are untyped JSON; the tests read them as such.
// Checks avoid asymmetric matchers on this shared data: bun 1.4's toMatchObject wrote them into it.
type Rec = any;

const lines: { t: number; dir: string; msg: Rec }[] = readFileSync(
  join(import.meta.dir, "fixtures/herdr/probe-18.jsonl"),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// events.subscribe answers on its own stream, recorded with the events.
const requests = lines.filter((l) => l.dir === ">>" && l.msg.method !== "events.subscribe").map((l) => l.msg);
const answer = (id: string) => lines.find((l) => l.dir === "<<" && l.msg.id === id)?.msg;
const results = (method: string) =>
  requests.filter((r) => r.method === method).map((r) => answer(r.id)?.result).filter(Boolean);
const events = (name: string) =>
  lines.filter((l) => l.dir === "ev" && l.msg.event === name).map((l) => l.msg.data);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe("herdr probe 18 fixture", () => {
  test("every request gets one answer: result.type or error.code", () => {
    for (const r of requests) {
      expect([typeof r.id, typeof r.method, typeof r.params]).toEqual(["string", "string", "object"]);
      const a = answer(r.id);
      expect(a).toBeDefined();
      if (a.error) expect([typeof a.error.code, typeof a.error.message]).toEqual(["string", "string"]);
      else expect(typeof a.result.type).toBe("string");
    }
    const subs = lines.filter((l) => l.dir === "ev" && l.msg.id === "p18:sub");
    expect(subs.length).toBeGreaterThan(0);
    for (const s of subs) expect(s.msg.result.type).toBe("subscription_started");
  });

  test("each method the bridge uses answers with the documented type", () => {
    const types: Record<string, string> = {
      ping: "pong",
      "workspace.create": "workspace_created",
      "pane.get": "pane_info",
      "pane.process_info": "pane_process_info",
      "session.snapshot": "session_snapshot",
      "pane.send_keys": "ok",
      "tab.close": "ok",
    };
    for (const [method, type] of Object.entries(types)) {
      const got = results(method);
      expect(got.length).toBeGreaterThan(0);
      for (const r of got) expect(r.type).toBe(type);
    }
    const pong = results("ping")[0];
    expect([pong.version, pong.protocol]).toEqual(["0.9.1", 22]);
  });

  test("created ids: w1, w1:t1, w1:p1", () => {
    const ws = results("workspace.create")[0];
    expect(ws.workspace.workspace_id).toMatch(/^w\d+$/);
    expect(ws.tab.tab_id).toMatch(/^w\d+:t\d+$/);
    expect(ws.root_pane.pane_id).toMatch(/^w\d+:p\d+$/);
    const tab = results("tab.create")[0];
    expect(tab.tab.tab_id).toMatch(/^w\d+:t\d+$/);
    expect(tab.root_pane.pane_id).toMatch(/^w\d+:p\d+$/);
  });

  test("pane.get reports the Claude session id; /clear and /resume change it, with no event", () => {
    const first = results("workspace.create")[0].root_pane.pane_id;
    const ids: string[] = [];
    for (const r of requests.filter((r) => r.method === "pane.get" && r.params.pane_id === first)) {
      const s = answer(r.id).result?.pane.agent_session;
      if (!s) continue;
      expect([s.source, s.agent, s.kind]).toEqual(["herdr:claude", "claude", "id"]);
      expect(s.value).toMatch(UUID);
      if (ids.at(-1) !== s.value) ids.push(s.value);
    }
    // start → /clear → /clear → /resume back to the first /clear's id
    expect(ids.length).toBe(4);
    expect(new Set(ids.slice(0, 3)).size).toBe(3);
    expect(ids[3]).toBe(ids[1]);
    // The second /clear's id lived only until /resume, with nothing else changing: no event carried it.
    const evented = events("pane_updated").map((d) => d.pane.agent_session?.value);
    expect(evented).not.toContain(ids[2]);
  });

  test("pane.process_info gives the agent pid", () => {
    const withClaude = results("pane.process_info")
      .map((r) => [r.process_info, r.process_info.foreground_processes.find((p: Rec) => p.name === "claude")])
      .filter(([, p]) => p);
    expect(withClaude.length).toBeGreaterThan(0);
    // Launched with `exec`, the agent replaces the pane's shell.
    for (const [info, p] of withClaude) expect(p.pid).toBe(info.shell_pid);
  });

  test("agent exit under exec: pane_exited, then the released agent", () => {
    const [exited] = events("pane_exited");
    expect(Object.keys(exited).sort()).toEqual(["pane_id", "type", "workspace_id"]);
    const released = events("pane_agent_detected").find((d) => d.pane_id === exited.pane_id && d.released);
    expect([released?.agent, typeof released?.final_status]).toEqual(["claude", "string"]);
    for (const l of lines.filter((l) => l.dir === "ev" && l.msg.event)) expect(l.msg.data.type).toBe(l.msg.event);
  });

  test("exiting with Ctrl-C: a pane_updated with the current session id comes before pane_exited", () => {
    const exitAt = lines.findIndex((l) => l.dir === "ev" && l.msg.event === "pane_exited");
    const pane = lines[exitAt]!.msg.data.pane_id;
    const polled = lines
      .slice(0, exitAt)
      .filter((l) => l.dir === "<<" && l.msg.result?.pane?.pane_id === pane && l.msg.result.pane.agent_session)
      .at(-1)!.msg.result.pane.agent_session.value;
    const ctrlC = lines.findIndex((l) => l.dir === ">>" && l.msg.method === "pane.send_keys" && l.msg.params.keys[0] === "ctrl+c");
    const updates = lines.slice(ctrlC, exitAt).filter((l) => l.dir === "ev" && l.msg.data?.pane?.pane_id === pane);
    expect(updates.at(-1)?.msg.data.pane.agent_session.value).toBe(polled);
  });

  test("pane exit takes its tab and workspace along without tab_closed or workspace_closed", () => {
    const subscribed = lines
      .filter((l) => l.dir === ">>" && l.msg.method === "events.subscribe")
      .flatMap((l) => l.msg.params.subscriptions.map((s: Rec) => s.type));
    expect(subscribed.filter((t) => t === "tab.closed" || t === "workspace.closed").length).toBeGreaterThan(0);
    const exitAt = lines.findIndex((l) => l.dir === "ev" && l.msg.event === "pane_exited");
    const snap = lines.slice(exitAt).find((l) => l.dir === "<<" && l.msg.result?.type === "session_snapshot");
    expect([snap?.msg.result.snapshot.tabs, snap?.msg.result.snapshot.workspaces]).toEqual([[], []]);
    expect(events("workspace_closed")).toEqual([]);
    // tab_closed comes only from tab.close, and tab.close sends no pane_exited.
    const closed = requests.filter((r) => r.method === "tab.close").map((r) => r.params.tab_id);
    expect(events("tab_closed").map((d) => d.tab_id)).toEqual(closed);
    expect(events("pane_exited").map((d) => d.workspace_id)).toEqual(["w1"]);
  });

  // The bridge now starts the agent with layout.apply, recorded on its own (test/fake-herdr.test.ts, #372).
  test("probe 18 launched as the bridge did then: tokens in tab.create env, PATH in the typed ` exec env PATH=…` line", () => {
    const slot = requests.find((r) => r.method === "tab.create" && r.params.label === "slot");
    expect(Object.keys(slot.params.env).sort()).toEqual(["RHODIUM_SLOT", "RHODIUM_TOKEN"]);
    const pane = answer(slot.id).result.root_pane.pane_id;
    const typed = requests.find((r) => r.method === "pane.send_input" && r.params.pane_id === pane).params.text;
    expect(typed).toMatch(/^ exec env PATH=\S+ \/\S+\/claude .*--resume [0-9a-f-]{36}$/);
  });

  test("recorded on haiku: every claude the probe starts has --model haiku", () => {
    const launches = requests.filter((r) => r.method === "pane.send_input" && r.params.text.includes("/claude "));
    expect(launches.length).toBe(2);
    for (const r of launches) expect(r.params.text).toContain(" --model haiku ");
  });

  test("a stopping server just closes the subscription: no event between the stop and EOF", () => {
    const stops = lines.flatMap((l, i) => (l.dir === "stop" ? [i] : []));
    expect(stops.length).toBe(2);
    for (const i of stops) {
      const eof = lines.findIndex((l, j) => j > i && l.dir === "ev" && l.msg === "EOF");
      expect(eof).toBeGreaterThan(i);
      expect(lines.slice(i, eof).filter((l) => l.dir === "ev")).toEqual([]);
    }
  });

  test("a gone pane answers pane_not_found", () => {
    const errors = lines.filter((l) => l.dir === "<<" && l.msg.error).map((l) => l.msg.error);
    expect(errors.some((e) => e.code === "pane_not_found" && e.message.includes("not found"))).toBe(true);
  });
});
