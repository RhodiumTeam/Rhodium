import { expect, test } from "bun:test";
import { decodeHold, encodeHold, type HoldMessage } from "../src/hold";

// One sample per message type; the mapped type makes tsc fail if a type is missing.
const samples: { [K in HoldMessage["type"]]: Extract<HoldMessage, { type: K }> } = {
  hello: { type: "hello", proto: 1, boot: 7, offset: 1024 },
  hello_ok: {
    type: "hello_ok",
    proto: 1,
    pid: 4242,
    size: 2048,
    written: ["01JB0000000000000000000000", "w2"],
    writing: "w3",
  },
  start: {
    type: "start",
    argv: ["/usr/bin/claude", "-p", "--resume=abc"],
    env: { PATH: "/usr/bin", RHODIUM_TOKEN: "secret" },
    cwd: "/home/u/proj",
  },
  started: { type: "started", pid: 4243 },
  out: { type: "out", pos: 2048, data: Buffer.from('{"a":" "}\n').toString("base64") },
  write: { type: "write", id: "01JB0000000000000000000001", line: '{"type":"user","text":"你好 "}' },
  ack: { type: "ack", id: "01JB0000000000000000000001" },
  eof: { type: "eof" },
  signal: { type: "signal", sig: "KILL" },
  exit: { type: "exit", code: null, signal: "KILL" },
};

for (const msg of Object.values(samples)) {
  test(`hold/1 ${msg.type} survives encode then decode`, () => {
    const line = encodeHold(msg);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect(decodeHold(line)).toEqual(msg);
  });
}

test("hello_ok before the agent starts has no pid", () => {
  const msg: HoldMessage = { type: "hello_ok", proto: 1, pid: null, size: 0, written: [], writing: null };
  expect(decodeHold(encodeHold(msg))).toEqual(msg);
});

test("decode ignores fields it does not know, so fields can be added within hold/1", () => {
  expect(decodeHold('{"type":"ack","id":"x","later":true}')).toMatchObject({ type: "ack", id: "x" });
});

test("decode rejects unknown types, missing fields and wrong field types", () => {
  expect(() => decodeHold('{"type":"bogus"}')).toThrow();
  expect(() => decodeHold('{"type":"ack"}')).toThrow();
  expect(() => decodeHold('{"type":"hello","proto":1,"boot":"7","offset":0}')).toThrow();
  expect(() => decodeHold('{"type":"signal","sig":"HUP"}')).toThrow();
  expect(() => decodeHold('{"type":"start","argv":["a"],"env":{"A":1},"cwd":"/"}')).toThrow();
  expect(() => decodeHold('{"type":"start","argv":[],"env":{},"cwd":"/"}')).toThrow();
  expect(() => decodeHold("not json")).toThrow();
});

test("decode rejects names that only exist on Object.prototype", () => {
  for (const type of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    expect(() => decodeHold(JSON.stringify({ type }))).toThrow(/unknown message/);
  }
});

test("a write line may not contain a newline, since the holder splits on 0x0A", () => {
  expect(() => encodeHold({ type: "write", id: "a", line: "one\ntwo" })).toThrow();
  expect(() => decodeHold('{"type":"write","id":"a","line":"one\\ntwo"}')).toThrow();
});
