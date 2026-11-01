// Rhodium's approval extension for pi (architecture §6.3): the probe 17 prototype
// (scripts/probes/pi/approval.ts). rhodium writes this file out and loads it with -e when the
// slot's approval mode is on; pi runs it, so it imports nothing.
//
// Every tool call except the read-only built-ins waits for the rpc client's answer:
//   pi -> client: {"type":"extension_ui_request","id":"<uuid>","method":"select",
//                  "title":"{\"rhodium\":\"approval\",\"toolCallId\":…,\"toolName\":…,\"input\":…}",
//                  "options":["allow","deny"]}
//   client -> pi: {"type":"extension_ui_response","id":"<uuid>","value":"allow"}
//                 value "deny" or "deny: <reason>", or "cancelled": true, blocks the call.
// pi does not check `value` against `options`, which is what lets a deny carry a reason.
// The dialog takes ctx.signal, so `abort` ends it; without it a pending approval holds the abort.

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (READ_ONLY.has(event.toolName)) return;
    const title = JSON.stringify({ rhodium: "approval", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input });
    const answer: string | undefined = await ctx.ui.select(title, ["allow", "deny"], { signal: ctx.signal });
    if (answer === "allow") return;
    const reason = answer?.startsWith("deny:") ? answer.slice(5).trim() : "";
    return { block: true, reason: reason || "Denied by the user." };
  });
}
