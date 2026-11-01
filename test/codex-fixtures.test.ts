// Checks the recorded Codex app-server fixtures (test/fixtures/codex/<scenario>/) against the
// recording format and the protocol facts architecture §6.4 states, one recording at a time.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "fixtures/codex");

// Codex records are untyped JSON; the tests read them as such.
type Rec = any;

function load(scenario: string) {
  const dir = join(ROOT, scenario);
  const meta = JSON.parse(readFileSync(join(dir, "meta"), "utf8"));
  const outSize = statSync(join(dir, "out.log")).size;
  const out: Rec[] = readFileSync(join(dir, "out.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const input = readFileSync(join(dir, "in.log"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const m = /^(\d+) (.*)$/.exec(l);
      if (!m) throw new Error(`bad in.log line: ${l}`);
      return { offset: Number(m[1]), rec: JSON.parse(m[2]!) as Rec };
    });
  return { meta, out, input, outSize };
}

/** The answer to the request the client sent as `method`, the nth of them. */
function answer(scenario: string, method: string, n = 0): Rec {
  const { out, input } = load(scenario);
  const id = input.filter((i) => i.rec.method === method)[n]!.rec.id;
  return out.find((r) => r.id === id && r.method === undefined);
}
const notes = (out: Rec[], method: string) => out.filter((r) => r.method === method);
const items = (out: Rec[], event: "item/started" | "item/completed", type: string) => notes(out, event).filter((r) => r.params.item.type === type);

describe("Codex fixtures", () => {
  test.each(readdirSync(ROOT))("%s: the recording's format, and one JSON-RPC message a line with no jsonrpc field", (scenario) => {
    const { meta, out, input, outSize } = load(scenario);
    expect(meta).toMatchObject({ agent: "codex", scenario, version: "0.162.1" });
    // Only what cannot be recorded is made by hand (usage-limit), and says how.
    expect(meta.edited).toBe(scenario === "usage-limit");
    if (meta.edited) expect(meta.note).toBeString();
    let last = 0;
    for (const { offset, rec } of input) {
      expect(offset).toBeGreaterThanOrEqual(last);
      expect(offset).toBeLessThanOrEqual(outSize);
      expect(rec.jsonrpc).toBeUndefined();
      last = offset;
    }
    for (const r of out) expect(r.jsonrpc).toBeUndefined();
  });

  test("handshake: initialize gives the version and CODEX_HOME; Codex warns its sandbox cannot start here", () => {
    const { out } = load("handshake");
    expect(answer("handshake", "initialize").result).toMatchObject({ userAgent: expect.stringContaining("/0.162.1 "), codexHome: "/home/user/.codex" });
    expect(notes(out, "configWarning")[0].params.summary).toContain("bubblewrap");
  });

  test("turn: Codex makes the thread's id, a UUIDv7, and names its record by day; app-server threads are vscode's", () => {
    const { thread } = answer("turn", "thread/start").result;
    expect(thread.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    expect(thread.path).toMatch(new RegExp(`/\\.codex/sessions/\\d{4}/\\d\\d/\\d\\d/rollout-\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-${thread.id}\\.jsonl$`));
    expect(thread.source).toBe("vscode");
  });

  test("turn: the events of a turn, in order; the command wrapped in zsh -lc, its summary one unknown action", () => {
    const { out } = load("turn");
    const order = out.flatMap((r) => (["turn/started", "turn/completed"].includes(r.method) ? [r.method] : r.method === "item/completed" ? [r.params.item.type] : []));
    expect(order).toEqual(["turn/started", "userMessage", "commandExecution", "fileChange", "agentMessage", "turn/completed"]);
    const [command] = items(out, "item/completed", "commandExecution");
    expect(command.params.item.command).toBe("/usr/bin/zsh -lc 'env | grep ''^RHODIUM_ | sort'");
    expect(command.params.item.commandActions).toEqual([{ type: "unknown", command: "env | grep ^RHODIUM_ | sort" }]);
    // RHODIUM_SLOT and RHODIUM_TOKEN reach Codex's commands: its default passes the whole environment.
    expect(command.params.item.aggregatedOutput).toContain("RHODIUM_TOKEN=");
    const [message] = items(out, "item/completed", "agentMessage");
    expect(message.params.item).toMatchObject({ phase: "final_answer", text: "ok" });
    expect(notes(out, "turn/completed")[0].params.turn).toMatchObject({ status: "completed", error: null });
    // turn/start's answer names the turn that turn/started then starts.
    expect(answer("turn", "turn/start").result.turn.id).toBe(notes(out, "turn/started")[0].params.turn.id);
  });

  test("restart-idle: a resumed thread keeps its approval setting, but its sandbox comes back read-only; its history goes on", () => {
    const { out } = load("restart-idle");
    expect(answer("restart-idle", "thread/resume").result).toMatchObject({ approvalPolicy: "never", sandbox: { type: "readOnly" } });
    expect(items(out, "item/completed", "agentMessage").at(-1).params.item.text).toBe("hello.txt");
  });

  test("resume-locked, resume-after-tui: a thread another process holds is refused with Codex's writer-lock error; once it lets go, it opens", () => {
    const thread = load("resume-locked").input.find((i) => i.rec.method === "thread/resume")!.rec.params.threadId;
    expect(answer("resume-locked", "thread/resume").error).toEqual({ code: -32600, message: `thread ${thread} already has an active writer` });
    expect(answer("resume-after-tui", "thread/resume").result.thread.id).toBe(thread);
  });

  test("start-mid-turn: a turn/start while a turn runs joins it, under the running turn's id, with no turn/started of its own", () => {
    const { out } = load("start-mid-turn");
    const first = answer("start-mid-turn", "turn/start", 0).result.turn.id;
    expect(answer("start-mid-turn", "turn/start", 1).result.turn).toMatchObject({ id: first, status: "inProgress" });
    expect(notes(out, "turn/started").map((r) => r.params.turn.id)).toEqual([first, answer("start-mid-turn", "turn/start", 2).result.turn.id]);
    expect(notes(out, "turn/completed").map((r) => r.params.turn.status)).toEqual(["completed", "completed"]);
  });

  test("start-mid-turn: clientUserMessageId comes back as the user message's clientId, from turn/start and from turn/steer", () => {
    const { out, input } = load("start-mid-turn");
    const sentIds = input.filter((i) => i.rec.method === "turn/start" || i.rec.method === "turn/steer").map((i) => i.rec.params.clientUserMessageId);
    expect(sentIds).toEqual(["c-1", "c-2", "c-3", "c-4"]);
    expect(items(out, "item/started", "userMessage").map((r) => r.params.item.clientId)).toEqual(sentIds);
    expect(answer("start-mid-turn", "turn/steer").result).toEqual({ turnId: answer("start-mid-turn", "turn/start", 2).result.turn.id });
  });

  test("start-mid-turn: the CODEX_ variables Codex gives its commands, which a headless agent's environment goes without", () => {
    const [command] = items(load("start-mid-turn").out, "item/completed", "commandExecution");
    expect(command.params.item.aggregatedOutput).toBe("CODEX_APPLY_PATCH_PRESERVE_LINE_ENDINGS\nCODEX_CI\nCODEX_SESSION_ID\nCODEX_THREAD_ID\nCODEX_VERSION\n");
  });

  test("steer: turn/steer joins the running turn; with none running it is refused", () => {
    const { out } = load("steer");
    expect(answer("steer", "turn/steer", 0).result).toEqual({ turnId: notes(out, "turn/started")[0].params.turn.id });
    expect(answer("steer", "turn/steer", 1).error).toEqual({ code: -32600, message: "no active turn to steer" });
  });

  test("developer-resume: developer instructions given again on resume neither replace nor add to the ones the thread started with", () => {
    const { out, input } = load("developer-resume");
    expect(input.find((i) => i.rec.method === "thread/resume")!.rec.params.developerInstructions).toContain("PEAR");
    const reply = items(out, "item/completed", "agentMessage").at(-1).params.item.text;
    expect(reply).toContain("APPLE");
    expect(reply).not.toContain("PEAR");
  });

  test("interrupt: turn/interrupt is answered at once; the turn ends interrupted, its command never completed", () => {
    const { out } = load("interrupt");
    expect(answer("interrupt", "turn/interrupt").result).toEqual({});
    expect(notes(out, "turn/completed")[0].params.turn.status).toBe("interrupted");
    expect(items(out, "item/started", "commandExecution")).toHaveLength(1);
    expect(items(out, "item/completed", "commandExecution")).toEqual([]);
  });

  test("interrupt-pending-approval: the turn ends before the ask is withdrawn", () => {
    const { out } = load("interrupt-pending-approval");
    const methods = out.map((r) => r.method).filter((m) => m === "turn/completed" || m === "serverRequest/resolved");
    expect(methods).toEqual(["turn/completed", "serverRequest/resolved"]);
  });

  test("kill-mid-turn, resume-after-kill: killed mid-command, no turn end comes; resumed, nothing runs again by itself", () => {
    expect(notes(load("kill-mid-turn").out, "turn/completed")).toEqual([]);
    const after = load("resume-after-kill").out;
    expect(notes(after, "turn/started")).toEqual([]);
    expect(answer("resume-after-kill", "thread/read").result.thread.turns.at(-1).status).toBe("interrupted");
  });

  test("close-mid-turn: stdin closed mid-turn ends the process before the turn ends", () => {
    expect(notes(load("close-mid-turn").out, "turn/completed")).toEqual([]);
  });

  test("compact: thread/compact/start is answered at once and runs as a turn of one compaction item, with no thread/compacted", () => {
    const { out } = load("compact");
    expect(answer("compact", "thread/compact/start").result).toEqual({});
    expect(items(out, "item/completed", "contextCompaction")).toHaveLength(1);
    expect(notes(out, "thread/compacted")).toEqual([]);
    expect(notes(out, "turn/completed")[0].params.turn.status).toBe("completed");
  });

  test("ultra-agents (live check 7): the turn that spawns a sub-agent ends while it runs; the sub-agent is another thread on the same connection, and its end wakes no turn", () => {
    const { out } = load("ultra-agents");
    const main = answer("ultra-agents", "thread/start").result.thread.id;
    const [spawned, ended] = items(out, "item/completed", "subAgentActivity").map((r) => ({ at: out.indexOf(r), ...r.params }));
    expect(spawned).toMatchObject({ threadId: main, item: { kind: "started", agentPath: "/root/touch_file" } });
    expect(ended).toMatchObject({ threadId: main, turnId: spawned!.turnId, item: { kind: "completed", agentThreadId: spawned!.item.agentThreadId } });
    const sub = spawned!.item.agentThreadId;
    const turns = notes(out, "turn/completed").map((r) => ({ at: out.indexOf(r), thread: r.params.threadId, root: r.params.turn.rootTurnId }));
    // The main turn ends first, its thread idle; the sub-agent's turn, under the main one's root, after.
    expect(turns.map((t) => t.thread)).toEqual([main, sub]);
    expect(turns[1]!.root).toBe(spawned!.turnId);
    expect(turns[0]!.at).toBeLessThan(turns[1]!.at);
    expect(out.slice(turns[0]!.at - 1, turns[0]!.at).map((r) => [r.method, r.params.threadId, r.params.status?.type])).toEqual([["thread/status/changed", main, "idle"]]);
    expect(ended!.at).toBeGreaterThan(turns[1]!.at);
    // Its own turn, items and tokens name its own thread; nothing more starts on the main one.
    expect(notes(out, "turn/started").map((r) => r.params.threadId)).toEqual([main, sub]);
    expect(notes(out, "thread/tokenUsage/updated").some((r) => r.params.threadId === sub)).toBe(true);
    expect(items(out, "item/started", "commandExecution").map((r) => r.params.threadId)).toEqual([sub]);
    expect(items(out, "item/started", "collabAgentToolCall")).toEqual([]);
  });

  test("doctor*: account/read tells a ChatGPT login, an API key, none, and none needed by a provider of yours, which config/read names", () => {
    expect(answer("doctor", "account/read").result).toMatchObject({ account: { type: "chatgpt", planType: expect.any(String) }, requiresOpenaiAuth: true });
    expect(answer("doctor-api-key", "account/read").result).toMatchObject({ account: { type: "apiKey" }, requiresOpenaiAuth: true });
    expect(answer("doctor-logged-out", "account/read").result).toMatchObject({ account: null, requiresOpenaiAuth: true });
    expect(answer("doctor-provider", "account/read").result).toMatchObject({ account: null, requiresOpenaiAuth: false });
    const { config } = answer("doctor-provider", "config/read").result;
    expect(config.model_provider).toBe("acme");
    expect(config.model_providers.acme).toMatchObject({ base_url: "https://llm.acme.invalid/v1", env_key: "ACME_API_KEY", auth: null, experimental_bearer_token: null });
  });

  test("doctor*: an ephemeral thread takes untrusted and is never written down, whatever the login; a provider's missing key does not stop it", () => {
    for (const s of ["doctor", "doctor-api-key", "doctor-logged-out", "doctor-provider"]) {
      const { result } = answer(s, "thread/start");
      expect(result).toMatchObject({ approvalPolicy: "untrusted", sandbox: { type: "dangerFullAccess" }, thread: { ephemeral: true, path: null } });
    }
    expect(answer("doctor-provider", "thread/start").result).toMatchObject({ modelProvider: "acme", model: "acme-coder" });
  });

  test("doctor-provider: model/list gives codex's own catalog, not the provider's models; there are no rate limits to read", () => {
    const models = answer("doctor-provider", "model/list").result.data.map((m: Rec) => m.model);
    expect(models).toContain("gpt-6-luna");
    expect(models).not.toContain("acme-coder");
    expect(answer("doctor-provider", "account/rateLimits/read").error.message).toBe("codex account authentication required to read rate limits");
  });

  test("untrusted: taken on thread/start with no sandbox; every command asks, ls too, and the patch; a no, then words steered in, and Codex does as they say", () => {
    const { out } = load("untrusted");
    expect(answer("untrusted", "thread/start").result).toMatchObject({ approvalPolicy: "untrusted", sandbox: { type: "dangerFullAccess" } });
    const asked = out.filter((r) => /requestApproval$/.test(r.method ?? "")).map((r) => r.params.command ?? r.method);
    expect(asked).toEqual(["/usr/bin/zsh -lc ls", "/usr/bin/zsh -lc 'touch a.txt'", "item/fileChange/requestApproval", "/usr/bin/zsh -lc 'rm a.txt'", "/usr/bin/zsh -lc 'mv a.txt a.txt.bak'"]);
    // The words joined the turn that asked, which went on to the rename.
    const rm = out.find((r) => r.params?.command === "/usr/bin/zsh -lc 'rm a.txt'");
    expect(answer("untrusted", "turn/steer").result.turnId).toBe(rm.params.turnId);
    expect(notes(out, "turn/completed").map((r) => r.params.turn.id)).toContain(rm.params.turnId);
    expect(items(out, "item/completed", "agentMessage").at(-1).params.item.text).toBe("renamed");
  });

  test("mcp-elicitation: an MCP tool's approval is a form elicitation marked mcp_tool_call, after its call started; a server's own form is not marked", () => {
    const { out } = load("mcp-elicitation");
    const asked = notes(out, "mcpServer/elicitation/request").map((r) => [r.params.mode, r.params._meta?.codex_approval_kind ?? null, r.params.requestedSchema.properties]);
    expect(asked).toEqual([["form", "mcp_tool_call", {}], ["form", "mcp_tool_call", {}], ["form", null, { colour: { type: "string" } }]]);
    const first = out.findIndex((r) => r.method === "mcpServer/elicitation/request");
    expect(out.findIndex((r) => r.method === "item/started" && r.params.item.type === "mcpToolCall")).toBeLessThan(first);
    expect(items(out, "item/completed", "mcpToolCall").map((r) => r.params.item.status)).toEqual(["completed", "completed"]);
  });
});
