// hold/1: the protocol between rhodium (R) and a holder (H), one JSON object per line.
// Message table and connection sequence: docs/architecture.md §4.4.
// Within hold/1 only add fields; changing what a field means needs hold/2.

export const HOLD_PROTO = 1;

export type HoldMessage =
  // R -> H, first message on every connection. offset: out.log bytes rhodium has processed.
  | { type: "hello"; proto: number; boot: number; offset: number }
  // H -> R. pid is null until start has launched the agent. size: out.log length now.
  // written: ids of the last 64 writes that reached stdin. writing: the id whose line is
  // going into stdin right now, or null; its ack comes on this connection (§4.6).
  | { type: "hello_ok"; proto: number; pid: number | null; size: number; written: string[]; writing: string | null }
  // R -> H, once. env is the agent's whole environment; the holder passes on none of its own.
  | { type: "start"; argv: string[]; env: Record<string, string>; cwd: string }
  // H -> R, the agent is running.
  | { type: "started"; pid: number }
  // H -> R. data: base64 of one or more whole out.log lines, newlines included,
  // starting at byte pos. Raw bytes because the holder never decodes agent output.
  | { type: "out"; pos: number; data: string }
  // R -> H. line has no newline; the holder appends one. id is the agent input's id.
  | { type: "write"; id: string; line: string }
  // H -> R, the whole line is in the agent's stdin.
  | { type: "ack"; id: string }
  // R -> H, close the agent's stdin.
  | { type: "eof" }
  // R -> H, signal the agent's process group.
  | { type: "signal"; sig: "TERM" | "KILL" }
  // H -> R, the agent exited: code, or the signal name that killed it. Then the holder exits.
  | { type: "exit"; code: number | null; signal: string | null };

type Check = (v: unknown) => boolean;
const int: Check = (v) => Number.isSafeInteger(v);
const str: Check = (v) => typeof v === "string";
const orNull = (c: Check): Check => (v) => v === null || c(v);
const strList: Check = (v) => Array.isArray(v) && v.every(str);
const strMap: Check = (v) =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(str);
const oneLine: Check = (v) => str(v) && !(v as string).includes("\n");

const shapes: Record<HoldMessage["type"], Record<string, Check>> = {
  hello: { proto: int, boot: int, offset: int },
  hello_ok: { proto: int, pid: orNull(int), size: int, written: strList, writing: orNull(str) },
  start: { argv: (v) => strList(v) && (v as string[]).length > 0, env: strMap, cwd: str },
  started: { pid: int },
  out: { pos: int, data: str },
  write: { id: str, line: oneLine },
  ack: { id: str },
  eof: {},
  signal: { sig: (v) => v === "TERM" || v === "KILL" },
  exit: { code: orNull(int), signal: orNull(str) },
};

function check(msg: unknown): HoldMessage {
  const m = msg as Record<string, unknown> | null;
  const shape =
    typeof m === "object" && m !== null && Object.hasOwn(shapes, m.type as string) && shapes[m.type as HoldMessage["type"]];
  if (!shape) throw new Error(`hold/1: unknown message ${JSON.stringify(msg)}`);
  for (const [field, ok] of Object.entries(shape)) {
    if (!ok(m[field])) throw new Error(`hold/1: ${m.type}: bad ${field}`);
  }
  return m as HoldMessage;
}

/** One message as a line, newline included. */
export function encodeHold(msg: HoldMessage): string {
  return JSON.stringify(check(msg)) + "\n";
}

/** One line (trailing newline optional) back into a message. Throws on anything malformed. */
export function decodeHold(line: string): HoldMessage {
  return check(JSON.parse(line));
}
