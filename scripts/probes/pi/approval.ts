// Prototype of Rhodium's pi approval extension (probe 17).
//
// Every tool call except the read-only built-ins is held until the rpc client answers:
//   pi -> client: {"type":"extension_ui_request","id":"<uuid>","method":"select",
//                  "title":"{\"rhodium\":\"approval\",\"toolCallId\":…,\"toolName\":…,\"input\":…}",
//                  "options":["allow","deny"]}
//   client -> pi: {"type":"extension_ui_response","id":"<uuid>","value":"allow"}
//                 value "deny" or "deny: <reason>", or "cancelled": true, blocks the call.
// pi does not validate `value` against `options`, which is what lets a deny carry a reason.
// The dialog is tied to ctx.signal, so `abort` resolves it; pi emits no record for that.

const READ_ONLY = new Set(["read", "grep", "find", "ls"]);

export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    if (READ_ONLY.has(event.toolName)) return;
    const title = JSON.stringify({
      rhodium: "approval",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      input: event.input,
    });
    const answer: string | undefined = await ctx.ui.select(title, ["allow", "deny"], { signal: ctx.signal });
    if (answer === "allow") return;
    const reason = answer?.startsWith("deny:") ? answer.slice(5).trim() : "";
    return { block: true, reason: reason || "Denied by the user." };
  });
}
