// Rebuild test/fixtures/claude from the raw recordings: make each one synthetic (../synth.ts), then
// derive the hand-edited scenarios. Usage: bun make-fixtures.ts [raw-dir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { localNames, rewriteOut, synthRecording } from "../synth";

const RAW = process.argv[2] ?? join(homedir(), "Rhodium/.scratch/recordings/claude");
const DST = join(import.meta.dir, "../../../test/fixtures/claude");

// fixture name <- raw recording name
const FROM: Record<string, string> = {
  "basic-turn": "basic-turn", "approval-allow-deny": "approval-allow-deny", question: "question", "plan-confirm": "plan-confirm",
  "mid-turn-message": "mid-turn-message", "interrupt-pending-approval": "interrupt-pending-approval", "background-wake": "background-wake",
  "reinitialize-pending-approval": "reinitialize-pending-approval",
  "cmd-new": "cmd-new", "cmd-stop": "cmd-stop", "cmd-status": "cmd-status", "cmd-model": "cmd-model", "cmd-compact": "cmd-compact",
  "cmd-usage": "cmd-usage", "cmd-usage-session": "cmd-usage-session", "cmd-context": "cmd-context", "cmd-resume": "cmd-resume", "cmd-effort": "cmd-effort", "cmd-ultracode": "cmd-ultracode",
  // Extra recordings from the probes that later issues will want.
  "approvals-off-questions": "p6-bypass", "close-with-background": "p7-close-with-bg", "crash-resume-auto-turn": "p9-resume-with-var",
  "background-agent": "background-agent",
};

type Fixture = { meta: any; inLog: string; outLog: string };
const save = (name: string, f: Fixture) => {
  mkdirSync(join(DST, name), { recursive: true });
  const { agent, version, edited, note } = f.meta; // same key order as the pi fixtures; undefined note is dropped
  writeFileSync(join(DST, name, "meta"), JSON.stringify({ agent, version, scenario: name, edited, note }) + "\n");
  writeFileSync(join(DST, name, "in.log"), f.inLog);
  writeFileSync(join(DST, name, "out.log"), f.outLog);
};

const clean: Record<string, Fixture> = {};
for (const [name, raw] of Object.entries(FROM)) {
  const read = (f: string) => readFileSync(join(RAW, raw, f), "utf8");
  const res = synthRecording({ inLog: read("in.log"), outLog: read("out.log") }, "claude", { home: homedir(), names: localNames() });
  if (res.leaks.length) throw new Error(`${raw}: ${res.leaks.length} private value(s) left; fix synth.ts`);
  const { agent, version } = JSON.parse(read("meta"));
  clean[name] = { meta: { agent, version, edited: false }, inLog: res.inLog, outLog: res.outLog };
  save(name, clean[name]);
}

const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const parse = (l: string) => { try { return JSON.parse(l); } catch { return null; } };

// Unknown message types and fields, hand-inserted into a real turn.
{
  const base = clean["basic-turn"]!;
  const sid = base.outLog.split("\n").map(parse).find((o) => o?.session_id)?.session_id;
  const reqId = U(170);
  let inserted = false, startSeen = false, assistantSeen = false;
  let errAt = 0;
  const res = rewriteOut(base, (raw) => {
    const o = parse(raw);
    if (!o) return [raw];
    if (o.type === "system" && o.subtype === "init" && !inserted) {
      inserted = true;
      o.capabilities = [...(o.capabilities ?? []), "rh_future_capability_v1"];
      o.rh_future_field = { nested: true };
      return [JSON.stringify(o),
        JSON.stringify({ type: "rh_future_event", payload: { note: "inserted by hand" }, uuid: U(171), session_id: sid }),
        JSON.stringify({ type: "system", subtype: "rh_future_subtype", detail: { x: 1 }, uuid: U(172), session_id: sid }),
        "[DEBUG] a non-JSON line, as some CLI versions print to stdout",
        JSON.stringify({ type: "control_request", request_id: reqId, request: { subtype: "rh_future_request", x: 1 } })];
    }
    if (o.type === "stream_event" && o.event?.type === "message_start" && !startSeen) {
      startSeen = true;
      return [raw, JSON.stringify({ type: "stream_event", event: { type: "rh_future_stream_event", index: 0 }, session_id: sid, parent_tool_use_id: null, uuid: U(173) })];
    }
    if (o.type === "assistant" && !assistantSeen) { assistantSeen = true; o.rh_future_field = "x"; o.message.rh_future_field = 1; return [JSON.stringify(o)]; }
    if (o.type === "result") { o.rh_future_field = [1, 2]; return [JSON.stringify(o)]; }
    return [raw];
  });
  // The driver answers the unknown control request with an error, right after reading it.
  const outLines = res.outLog.split("\n");
  for (const l of outLines) { errAt += Buffer.byteLength(l) + 1; if (l.includes(`"request_id":"${reqId}"`)) break; }
  const errLine = `${errAt} ${JSON.stringify({ type: "control_response", response: { subtype: "error", request_id: reqId, error: "Unsupported control request subtype: rh_future_request" } })}`;
  const inLines = res.inLog.split("\n").filter(Boolean);
  const pos = inLines.findIndex((l) => Number(l.split(" ")[0]) > errAt);
  inLines.splice(pos === -1 ? inLines.length : pos, 0, errLine);
  save("unknown-messages", { meta: { ...base.meta, edited: true,
    note: "Real basic-turn recording plus hand-inserted unknown type, system subtype, stream event, fields and capability, a non-JSON line, and an unknown CLI control request whose error reply is in in.log." },
    inLog: inLines.join("\n") + "\n", outLog: res.outLog });
}

// Limit reached: a real turn reshaped into what the CLI sends when the limit rejects the request.
{
  const base = clean["cmd-status"]!;
  let turn = false, text = "";
  // In the real turn rate_limit_event comes after the streamed reply and before result.
  const res = rewriteOut(base, (raw) => {
    const o = parse(raw);
    if (!o) return [raw];
    if (o.type === "system" && o.subtype === "init") turn = true;
    if (!turn) return [raw];
    if (o.type === "stream_event" || o.type === "assistant") return [];
    if (o.type === "rate_limit_event") {
      const info = o.rate_limit_info;
      Object.assign(info, { status: "rejected", rateLimitType: "five_hour" });
      if (info.unifiedWindows?.five_hour) info.unifiedWindows.five_hour.utilization = 1;
      text = `You've hit your limit · resets ${new Date(info.resetsAt * 1000).toISOString().slice(11, 16)} (UTC)`;
      const assistant = { type: "assistant", message: { id: U(180), container: null, model: "<synthetic>", role: "assistant", stop_reason: "stop_sequence", stop_sequence: "",
        type: "message", usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [{ type: "text", text }] },
        parent_tool_use_id: null, session_id: o.session_id, uuid: U(181), error: "rate_limit" };
      return [JSON.stringify(o), JSON.stringify(assistant)];
    }
    if (o.type === "result") {
      Object.assign(o, { is_error: true, api_error_status: 429, stop_reason: "stop_sequence", total_cost_usd: 0, result: text });
      return [JSON.stringify(o)];
    }
    return [raw];
  });
  save("rate-limit-rejected", { meta: { ...base.meta, edited: true,
    note: "Real cmd-status recording, reshaped by hand: rate_limit_event set to rejected, the streamed reply replaced by the synthetic error message and error result the CLI sends when a limit rejects the request (shape from the 2.1.304 binary, not observed live)." },
    ...res });
}

// The driver marks every allow with decisionClassification; probe 6 left it off its one question
// answer. The CLI takes the answer either way (the question recording carries it).
{
  const base = clean["approvals-off-questions"]!;
  const inLog = base.inLog.split("\n").map((l) => {
    const sp = l.indexOf(" ");
    const o = parse(l.slice(sp + 1));
    const r = o?.type === "control_response" ? o.response?.response : null;
    if (r?.behavior !== "allow" || "decisionClassification" in r) return l;
    r.decisionClassification = "user_temporary";
    return `${l.slice(0, sp)} ${JSON.stringify(o)}`;
  }).join("\n");
  save("approvals-off-questions", { meta: { ...base.meta, edited: true,
    note: "Real probe 6 recording; the question answer in in.log gained decisionClassification user_temporary, which the driver puts on every allow." },
    inLog, outLog: base.outLog });
}

// The compaction summary retold what a plugin's SessionStart hook said; that line goes.
{
  const base = clean["cmd-compact"]!;
  const res = rewriteOut(base, (raw) => [raw.replace(/\\n {3}- plugin-\d+ \\"full\\" mode is active [^\\]*/g, "")]);
  save("cmd-compact", { meta: { ...base.meta, edited: true,
    note: "Real cmd-compact recording; the line of the compaction summary that retold a plugin's SessionStart hook was taken out." }, ...res });
}

console.log(`wrote ${Object.keys(FROM).length + 2} fixtures to ${DST}`);
