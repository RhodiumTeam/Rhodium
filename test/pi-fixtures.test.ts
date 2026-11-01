// Checks the recorded pi rpc fixtures (test/fixtures/pi/<scenario>/) against
// the recording format and the protocol facts probe 17 established.
import { describe, expect, test } from "bun:test";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "fixtures/pi");

// pi records are untyped JSON; the tests read them as such.
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

const response = (out: Rec[], command: string) =>
  out.filter((r) => r.type === "response" && r.command === command);

function checkFormat(scenario: string) {
  const { meta, input, outSize } = load(scenario);
  expect(meta).toMatchObject({ agent: "pi", scenario, edited: false });
  expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
  let last = 0;
  for (const { offset } of input) {
    expect(offset).toBeGreaterThanOrEqual(last);
    expect(offset).toBeLessThanOrEqual(outSize);
    last = offset;
  }
}

describe("pi fixtures", () => {
  test("turn: streamed text, a tool call, then agent_settled", () => {
    checkFormat("turn");
    const { out } = load("turn");
    expect(response(out, "prompt")[0].data.disposition).toBe("started");
    expect(out.some((r) => r.assistantMessageEvent?.type === "text_delta")).toBe(true);
    expect(out.some((r) => r.type === "tool_execution_end" && r.toolName === "bash" && !r.isError)).toBe(true);
    expect(out.find((r) => r.type === "agent_settled")).toMatchObject({ aborted: false });
  });

  // Probe 17, checks 1 and 2: restarting with the same --session-id reopens the same
  // session, and the file written before stdin closed holds every entry.
  test("resume-session-id: same session, every entry survived the restart", () => {
    checkFormat("resume-session-id");
    const before = load("turn").out;
    const after = load("resume-session-id").out;
    const state = (out: Rec[]) => response(out, "get_state").at(-1)!.data;
    const entries = (out: Rec[]) => response(out, "get_entries").at(-1)!.data;
    expect(state(after).sessionId).toBe(state(before).sessionId);
    expect(state(after).sessionFile).toBe(state(before).sessionFile);
    expect(entries(after).leafId).toBe(entries(before).leafId);
    expect(entries(after).entries.length).toBe(entries(before).entries.length);
    const texts = JSON.stringify(response(after, "get_messages")[0].data.messages);
    expect(texts).toContain("echo hello from bash");
  });

  test("steer: a message sent mid-run is queued and joins the same run", () => {
    checkFormat("steer");
    const { out, input } = load("steer");
    const steer = input.find((i) => i.rec.streamingBehavior === "steer")!.rec;
    expect(out.find((r) => r.type === "response" && r.id === steer.id)!.data.disposition).toBe("queued");
    const settled = out.findIndex((r) => r.type === "agent_settled");
    const delivered = out.findIndex(
      (r) => r.type === "message_end" && r.message.role === "user" && JSON.stringify(r.message.content).includes(steer.message),
    );
    expect(delivered).toBeGreaterThan(0);
    expect(delivered).toBeLessThan(settled);
    expect(out.filter((r) => r.type === "agent_settled")).toHaveLength(1);
  });

  test("abort: stops the running tool and settles as aborted", () => {
    checkFormat("abort");
    const { out } = load("abort");
    expect(response(out, "abort")[0].success).toBe(true);
    expect(out.find((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
  });

  // Probe 17, check 3: in rpc mode the approval extension holds a tool call and asks.
  const approvals = (out: Rec[]) =>
    out
      .filter((r) => r.type === "extension_ui_request" && r.method === "select")
      .map((r) => ({ id: r.id, options: r.options, ...JSON.parse(r.title) }));
  const answerTo = (input: { rec: Rec }[], id: string) =>
    input.find((i) => i.rec.type === "extension_ui_response" && i.rec.id === id)?.rec;
  const toolEnd = (out: Rec[], tool: string) => out.find((r) => r.type === "tool_execution_end" && r.toolName === tool)!;

  test("approval-allow: bash waits for allow, read-only tools are not asked", () => {
    checkFormat("approval-allow");
    const { out, input } = load("approval-allow");
    const asked = approvals(out);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ rhodium: "approval", toolName: "bash", options: ["allow", "deny"] });
    expect(answerTo(input, asked[0].id)).toMatchObject({ value: "allow" });
    expect(toolEnd(out, "read")).toMatchObject({ isError: false });
    expect(toolEnd(out, "bash")).toMatchObject({ isError: false });
  });

  test("approval-deny: the reason reaches the model as the blocked tool's result", () => {
    checkFormat("approval-deny");
    const { out, input } = load("approval-deny");
    const [asked] = approvals(out);
    const answer = answerTo(input, asked.id)!;
    expect(answer.value).toStartWith("deny: ");
    const end = toolEnd(out, "bash");
    expect(end.isError).toBe(true);
    expect(JSON.stringify(end.result)).toContain(answer.value.slice("deny: ".length));
  });

  test("abort-pending-approval: abort resolves the open request silently", () => {
    checkFormat("abort-pending-approval");
    const { out, input } = load("abort-pending-approval");
    const [asked] = approvals(out);
    const abortAt = input.findIndex((i) => i.rec.type === "abort");
    expect(abortAt).toBeGreaterThan(-1);
    expect(response(out, "abort")[0].success).toBe(true);
    expect(out.find((r) => r.type === "agent_settled")).toMatchObject({ aborted: true });
    expect(toolEnd(out, "bash").isError).toBe(true);
    // A late answer to the withdrawn request is ignored without any record.
    const late = input.findIndex((i) => i.rec.type === "extension_ui_response" && i.rec.id === asked.id);
    expect(late).toBeGreaterThan(abortAt);
    const [answered, next] = [input[late]!, input[late + 1]!];
    expect(out.find((r) => r.type === "response" && r.id === next.rec.id)).toBeDefined();
    const after = readFileSync(join(ROOT, "abort-pending-approval", "out.log"))
      .subarray(answered.offset, next.offset)
      .toString();
    expect(after).toBe("");
  });

  const sessionIds = (out: Rec[]) => response(out, "get_state").map((r) => r.data.sessionId);

  test("new-session: starts a session with a new id", () => {
    checkFormat("new-session");
    const { out } = load("new-session");
    expect(response(out, "new_session")[0].data).toEqual({ cancelled: false });
    const [before, after] = sessionIds(out);
    expect(after).not.toBe(before);
  });

  test("switch-session: goes back to an earlier session file", () => {
    checkFormat("switch-session");
    const { out } = load("switch-session");
    const [first, fresh, back] = sessionIds(out);
    expect(first).toBe(sessionIds(load("turn").out)[0]);
    expect(fresh).not.toBe(first);
    expect(response(out, "switch_session")[0].data).toEqual({ cancelled: false });
    expect(back).toBe(first);
    expect(JSON.stringify(response(out, "get_messages").at(-1)!.data)).toContain("echo hello from bash");
  });

  test("get-session-stats: tokens and cost of the reopened session", () => {
    checkFormat("get-session-stats");
    const stats = response(load("get-session-stats").out, "get_session_stats")[0].data;
    expect(stats.tokens.total).toBeGreaterThan(0);
    expect(typeof stats.cost).toBe("number");
    expect(stats.contextUsage.contextWindow).toBeGreaterThan(0);
  });

  test("compact: returns a summary", () => {
    checkFormat("compact");
    const res = response(load("compact").out, "compact")[0];
    expect(res.success).toBe(true);
    expect(res.data.summary.length).toBeGreaterThan(0);
  });

  // Rhodium closes stdin only when idle; this shows why: pi ends the run at once.
  test("close-mid-turn: pi exits during a tool call without settling", () => {
    checkFormat("close-mid-turn");
    const { out } = load("close-mid-turn");
    expect(out.some((r) => r.type === "tool_execution_start")).toBe(true);
    expect(out.some((r) => r.type === "agent_settled")).toBe(false);
  });

  // pi does not reject an unknown level: it silently falls back to "off".
  test("set-thinking-level: changes the level; an unknown level becomes off", () => {
    checkFormat("set-thinking-level");
    const { out } = load("set-thinking-level");
    const changes = out.filter((r) => r.type === "thinking_level_changed").map((r) => r.level);
    expect(response(out, "set_thinking_level").map((r) => r.success)).toEqual([true, true]);
    expect(changes).toEqual(["off", "low"]);
    expect(response(out, "get_state").at(-1)!.data.thinkingLevel).toBe("low");
  });

  test("set-model: switches the model, rejects an unknown one", () => {
    checkFormat("set-model");
    const { out } = load("set-model");
    const [ok, bad] = response(out, "set_model");
    expect(ok.data).toMatchObject({ provider: "deepseek", id: "deepseek-v4-pro" });
    expect(bad.success).toBe(false);
    expect(response(out, "get_state").at(-1)!.data.model.id).toBe("deepseek-v4-pro");
  });

  // pi runs on its own DeepSeek key: no model it can reach comes from Anthropic.
  test("get-available-models: lists only pi's own providers", () => {
    checkFormat("get-available-models");
    const { models } = response(load("get-available-models").out, "get_available_models")[0].data;
    expect(models.some((m: Rec) => m.provider === "deepseek" && m.id === "deepseek-flash")).toBe(true);
    expect(models.filter((m: Rec) => m.provider === "anthropic")).toEqual([]);
  });
});

test("the pi recordings name no home directory but the placeholder /home/user", () => {
  const roots = [ROOT, join(import.meta.dir, "fixtures/transcripts/pi")];
  const homes = roots.flatMap((root) =>
    [...new Bun.Glob("**/*").scanSync(root)].flatMap((f) => readFileSync(join(root, f), "utf8").match(/\/home\/(?!user\/)[^/"\s]+/g) ?? []),
  );
  expect(homes).toEqual([]);
});
