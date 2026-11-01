// A tiny MCP server over stdio for the probe's mcp-elicitation scenario (spec codex.md, live check 6).
// Two tools, neither marked read-only, so Codex asks before each under untrusted: `note` echoes its
// text; `ask` puts a form to the client (elicitation/create) and returns what came back.
import { createInterface } from "node:readline";

const send = (m: object) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const waiting = new Map<unknown, (r: any) => void>();
let next = 0;

const tools = [
  { name: "note", description: "Writes a note.", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } },
  { name: "ask", description: "Asks the user for their favourite colour.", inputSchema: { type: "object", properties: {} } },
];

for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === undefined) {
    waiting.get(m.id)?.(m);
    continue;
  }
  if (m.id === undefined) continue; // notifications
  if (m.method === "initialize") send({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "rhprobe", version: "0.0.0" } } });
  else if (m.method === "tools/list") send({ id: m.id, result: { tools } });
  else if (m.method === "tools/call" && m.params.name === "note") send({ id: m.id, result: { content: [{ type: "text", text: `noted: ${m.params.arguments?.text}` }] } });
  else if (m.method === "tools/call" && m.params.name === "ask") {
    // Answered on a later line: not awaited here, or the loop would never read it.
    const id = `elicit-${next++}`;
    waiting.set(id, (r) => send({ id: m.id, result: { content: [{ type: "text", text: `elicitation: ${JSON.stringify(r.result ?? r.error)}` }] } }));
    send({ id, method: "elicitation/create", params: { message: "What is your favourite colour?", requestedSchema: { type: "object", properties: { colour: { type: "string" } }, required: ["colour"] } } });
  } else send({ id: m.id, error: { code: -32601, message: `no ${m.method}` } });
}
