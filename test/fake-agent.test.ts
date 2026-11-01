// Process-level self-tests for the fake agent: start it, feed stdin, compare stdout.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, installFakeAgent, type Config } from "./fake-agent/fake-agent.ts";

const base = mkdtempSync(join(tmpdir(), "rhodium-test-fake-agent-"));
afterAll(() => rmSync(base, { recursive: true, force: true }));

let count = 0;
function setup(config: Config) {
  const dir = join(base, String(count++));
  const home = join(dir, "home");
  const work = join(dir, "work");
  mkdirSync(home, { recursive: true });
  mkdirSync(work);
  return { dir, home, work, agent: installFakeAgent(dir, config) };
}

type StartOptions = { args?: string[]; env?: Record<string, string>; cwd: string };

function start(path: string, { args = [], env = {}, cwd }: StartOptions) {
  const proc = Bun.spawn([path, ...args], { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const chunks: Buffer[] = [];
  const pump = (async () => {
    for await (const c of proc.stdout) chunks.push(Buffer.from(c));
  })();
  const out = () => Buffer.concat(chunks);
  const lines = () => out().toString().split("\n").slice(0, -1);
  return {
    proc,
    chunks,
    out,
    lines,
    send(...ls: string[]) {
      for (const l of ls) proc.stdin.write(l + "\n");
      proc.stdin.flush();
    },
    close: () => proc.stdin.end(),
    /** Polls stdout until `done(lines)` holds; fails if the agent exits first. */
    async until(done: (ls: string[]) => boolean): Promise<string[]> {
      while (!done(lines())) {
        if (proc.exitCode !== null || proc.signalCode !== null) {
          await pump;
          if (done(lines())) break;
          const stderr = await new Response(proc.stderr).text();
          throw new Error(`agent exited early; stdout:\n${lines().join("\n")}\nstderr:\n${stderr}`);
        }
        await Bun.sleep(5);
      }
      return lines();
    },
    async finish() {
      await proc.exited;
      await pump;
      return { code: proc.exitCode, signal: proc.signalCode, stderr: await new Response(proc.stderr).text() };
    },
  };
}

test("records argv, env with secrets redacted, and every stdin line", async () => {
  const { home, work, agent } = setup({ script: { steps: [] } });
  const a = start(agent.path, {
    args: ["-p", "--verbose"],
    env: { HOME: home, FOO: "bar", RH_TOKEN: "s3cret", ANTHROPIC_API_KEY: "sk-1" },
    cwd: work,
  });
  a.send('{"type":"user"}', "not json \u2028 still one line");
  a.close();
  expect((await a.finish()).code).toBe(0);

  const [run] = agent.runs();
  expect(run!.argv).toEqual(["-p", "--verbose"]);
  expect(run!.env).toEqual({ HOME: home, FOO: "bar", RH_TOKEN: "<redacted>", ANTHROPIC_API_KEY: "<redacted>" });
  expect(run!.cwd).toBe(work);
  expect(run!.stdin).toEqual(['{"type":"user"}', "not json \u2028 still one line"]);
});

test("runs() keeps the stdin of concurrent runs of one installed agent apart", async () => {
  const { home, work, agent } = setup({ script: { steps: [] } });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  const b = start(agent.path, { env: { HOME: home }, cwd: work });
  while (agent.runs().length < 2) await Bun.sleep(5);
  a.send("from-a");
  a.close();
  await a.finish();
  b.send("from-b");
  b.close();
  await b.finish();
  const stdin = (pid: number) => agent.runs().find((r) => r.pid === pid)!.stdin;
  expect([stdin(a.proc.pid), stdin(b.proc.pid)]).toEqual([["from-a"], ["from-b"]]);
});

test("emit writes each line, then the agent exits 0 when stdin closes", async () => {
  const { home, work, agent } = setup({ script: { steps: [{ emit: ['{"a":1}', "plain text"] }] } });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  await a.until((ls) => ls.length === 2);
  a.close();
  expect((await a.finish()).code).toBe(0);
  expect(a.out().toString()).toBe('{"a":1}\nplain text\n');
});

test("wait blocks until a matching line arrives, and templates read that line", async () => {
  const { home, work, agent } = setup({
    script: {
      steps: [
        { wait: { type: "ping", body: { ok: true } } },
        { emit: ['{"pong":"{{in.id}}","body":"{{in.body}}","missing":"{{in.nope}}"}'] },
      ],
    },
  });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  a.send('{"type":"ping","id":1,"body":{"ok":false}}', "not json", '{"type":"other"}');
  await Bun.sleep(200);
  expect(a.lines()).toEqual([]);
  a.send('{"type":"ping","id":"x\\"y","body":{"ok":true,"more":1}}');
  expect(await a.until((ls) => ls.length === 1)).toEqual([
    '{"pong":"x\\"y","body":{"ok":true,"more":1},"missing":null}',
  ]);
  a.close();
  expect((await a.finish()).code).toBe(0);
});

test("on handlers answer matching lines at any time, but an active wait takes its line first", async () => {
  const { home, work, agent } = setup({
    script: {
      on: [{ match: { type: "control_request" }, emit: ['{"answer":"{{in.request_id}}"}'] }],
      steps: [
        { wait: { type: "control_request", request_id: "w" } },
        { emit: ['{"waited":"{{in.request_id}}"}'] },
        { wait: { type: "never" } },
      ],
    },
  });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  a.send('{"type":"control_request","request_id":"w"}');
  await a.until((ls) => ls.length === 1);
  a.send('{"type":"control_request","request_id":"h1"}', '{"type":"control_request","request_id":"h2"}');
  await a.until((ls) => ls.length === 3);
  a.close();
  expect((await a.finish()).code).toBe(0);
  expect(a.lines()).toEqual(['{"waited":"w"}', '{"answer":"h1"}', '{"answer":"h2"}']);
});

test("an on handler that fires during a split write answers after the split line, not inside it", async () => {
  const { home, work, agent } = setup({
    script: {
      on: [{ match: { type: "ping" }, emit: ['{"pong":true}'] }],
      steps: [{ emit: ['{"long":"abcdef"}'], splitAt: 5 }, { wait: { type: "never" } }],
    },
  });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  // The first half is out; the agent now pauses 50 ms before the rest.
  while (a.out().length === 0) await Bun.sleep(1);
  a.send('{"type":"ping"}');
  await a.until((ls) => ls.length === 2);
  a.close();
  await a.finish();
  expect(a.lines()).toEqual(['{"long":"abcdef"}', '{"pong":true}']);
});

test("exit ends the run with that code, even while stdin is open", async () => {
  const { home, work, agent } = setup({ script: { steps: [{ emit: ["bye"] }, { exit: 3 }] } });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  expect(await a.finish()).toMatchObject({ code: 3, signal: null });
  expect(a.lines()).toEqual(["bye"]);
});

test("kill ends the run by that signal", async () => {
  const { home, work, agent } = setup({ script: { steps: [{ kill: "SIGKILL" }] } });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  expect(await a.finish()).toMatchObject({ code: null, signal: "SIGKILL" });
});

test("sleep pauses between steps", async () => {
  const { home, work, agent } = setup({ script: { steps: [{ emit: ["a"] }, { sleep: 300 }, { emit: ["b"] }] } });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  await a.until((ls) => ls.length === 1);
  const t = performance.now();
  await a.until((ls) => ls.length === 2);
  expect(performance.now() - t).toBeGreaterThan(250);
  a.close();
  await a.finish();
});

test("goto loops, and seq numbers every emitted line", async () => {
  const { home, work, agent } = setup({
    script: { steps: [{ emit: ['{"seq":"{{seq}}"}'] }, { sleep: 1 }, { goto: 0 }] },
  });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  const ls = await a.until((ls) => ls.length >= 50);
  a.proc.kill("SIGKILL");
  await a.finish();
  expect(ls.slice(0, 50)).toEqual(Array.from({ length: 50 }, (_, i) => `{"seq":${i + 1}}`));
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const transcriptScript = {
  steps: [
    { wait: { type: "user" } },
    {
      transcript: [
        '{"type":"user","sessionId":"{{session_id}}","cwd":"{{cwd}}","uuid":"{{uuid}}","timestamp":"{{now}}","message":"{{in.message}}"}',
      ],
    },
    { emit: ['{"session_id":"{{session_id}}"}'] },
  ],
};

test("transcript appends lines to Claude's transcript file for the session in --session-id", async () => {
  const { home, work, agent } = setup({ script: transcriptScript });
  // Claude turns every character that is not an ASCII letter or digit into "-".
  const cwd = join(work, "my.proj_dir", "中文");
  mkdirSync(cwd, { recursive: true });
  const sid = "6f1c2c9e-1d7a-4c39-9a51-7c1f4f0f2a10";
  const a = start(agent.path, { args: ["-p", "--session-id", sid], env: { HOME: home }, cwd });
  a.send('{"type":"user","message":{"role":"user","content":"hi"}}');
  await a.until((ls) => ls.length === 1);
  a.close();
  expect((await a.finish()).code).toBe(0);
  expect(a.lines()).toEqual([`{"session_id":"${sid}"}`]);

  const projects = join(home, ".claude", "projects");
  const [dir, ...others] = readdirSync(projects);
  expect(others).toEqual([]);
  expect(dir!.endsWith("-work-my-proj-dir---")).toBe(true);
  expect(dir).toMatch(/^[A-Za-z0-9-]+$/);
  expect(dir!.length).toBe(cwd.length);
  const entries = readFileSync(join(projects, dir!, `${sid}.jsonl`), "utf8").split("\n");
  expect(entries.at(-1)).toBe("");
  const entry = JSON.parse(entries[0]!);
  expect(entry).toMatchObject({ type: "user", sessionId: sid, cwd, message: { role: "user", content: "hi" } });
  expect(entry.uuid).toMatch(UUID);
  expect(Date.now() - Date.parse(entry.timestamp)).toBeLessThan(60_000);
});

test("transcript follows --resume=<id> and CLAUDE_CONFIG_DIR; like Claude, it resumes only a conversation written down, in any directory", async () => {
  const { home, work, agent } = setup({ script: transcriptScript });
  const config = join(home, "elsewhere");
  const env = { HOME: home, CLAUDE_CONFIG_DIR: config };
  const none = start(agent.path, { args: ["--resume=abc"], env, cwd: work });
  expect(await none.finish()).toEqual({ code: 1, signal: null, stderr: "No conversation found with session ID: abc\n" });

  mkdirSync(join(config, "projects", "-other"), { recursive: true });
  writeFileSync(join(config, "projects", "-other", "abc.jsonl"), "");
  const a = start(agent.path, { args: ["--resume=abc"], env, cwd: work });
  a.send('{"type":"user","message":"m"}');
  a.close();
  expect((await a.finish()).code).toBe(0);
  expect(readFileSync(join(config, "projects", claudeProjectDir(work), "abc.jsonl"), "utf8")).toContain('"message":"m"');
});

test("transcript: false in the config turns transcript writing off", async () => {
  const { home, work, agent } = setup({ script: transcriptScript, transcript: false });
  const a = start(agent.path, { env: { HOME: home }, cwd: work });
  a.send('{"type":"user"}');
  const [line] = await a.until((ls) => ls.length === 1);
  expect(JSON.parse(line!).session_id).toMatch(UUID);
  a.close();
  await a.finish();
  expect(existsSync(join(home, ".claude"))).toBe(false);
});

// Built-in scripts speak Claude's stream-json; a driver starts with `initialize`, then sends user messages.
const INIT = '{"type":"control_request","request_id":"rh-1-1","request":{"subtype":"initialize"}}';
const user = (text: string) =>
  JSON.stringify({ type: "user", uuid: crypto.randomUUID(), message: { role: "user", content: text } });
const kind = (l: string) => {
  const m = JSON.parse(l);
  return [m.type, m.subtype, m.state].filter(Boolean).join("/");
};
const idles = (ls: string[]) => ls.filter((l) => kind(l) === "system/session_state_changed/idle").length;

async function claudeScript(script: string, args: string[] = []) {
  const { home, work, agent } = setup({ script });
  const a = start(agent.path, { args, env: { HOME: home }, cwd: work });
  a.send(INIT);
  const [answer, tasks] = await a.until((ls) => ls.length === 2);
  expect(JSON.parse(answer!)).toMatchObject({
    type: "control_response",
    response: { subtype: "success", request_id: "rh-1-1", pending_permission_requests: [] },
  });
  expect(JSON.parse(tasks!)).toMatchObject({ type: "system", subtype: "background_tasks_changed", tasks: [] });
  return { a, home };
}

test("built-in turn: each user message gets one full turn and two transcript lines", async () => {
  const sid = "0b4d3c1e-58a8-4f43-9a8f-3f8d2f1d7c55";
  const { a, home } = await claudeScript("turn", ["--session-id", sid]);
  const hi = user("hi");
  a.send(hi);
  await a.until((ls) => idles(ls) === 1);
  a.send('{"type":"control_request","request_id":"rh-1-2","request":{"subtype":"get_usage"}}', user("again"));
  await a.until((ls) => idles(ls) === 2);
  a.close();
  expect((await a.finish()).code).toBe(0);

  const turn = [
    "system/session_state_changed/running", "command_lifecycle/queued", "command_lifecycle/started", "system/init", "assistant", "result/success",
    "system/session_state_changed/idle",
  ];
  expect(a.lines().map(kind)).toEqual(["control_response", "system/background_tasks_changed", ...turn, "control_response", ...turn]);
  expect(JSON.parse(a.lines()[3]!).command_uuid).toBe(JSON.parse(hi).uuid);
  expect(JSON.parse(a.lines()[9]!).response.request_id).toBe("rh-1-2");
  expect(JSON.parse(a.lines()[5]!).session_id).toBe(sid);

  const [dir] = readdirSync(join(home, ".claude", "projects"));
  const transcript = readFileSync(join(home, ".claude", "projects", dir!, `${sid}.jsonl`), "utf8");
  const entries = transcript.trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(entries.map((e) => [e.type, e.message.role])).toEqual([
    ["user", "user"],
    ["assistant", "assistant"],
    ["user", "user"],
    ["assistant", "assistant"],
  ]);
  expect(entries[2].message.content).toBe("again");
});

test("built-in ask: the turn stops at can_use_tool until the answer comes back", async () => {
  const { a } = await claudeScript("ask");
  a.send(user("run it"));
  const ls = await a.until((ls) => ls.some((l) => kind(l) === "control_request"));
  const ask = JSON.parse(ls.find((l) => kind(l) === "control_request")!);
  expect(ask.request.subtype).toBe("can_use_tool");
  await Bun.sleep(200);
  expect(a.lines().some((l) => kind(l).startsWith("result"))).toBe(false);
  a.send(
    JSON.stringify({
      type: "control_response",
      response: { subtype: "success", request_id: ask.request_id, response: { behavior: "allow", updatedInput: {} } },
    }),
  );
  await a.until((ls) => idles(ls) === 1);
  a.close();
  expect((await a.finish()).code).toBe(0);
});

test("built-in background: the turn ends, then the finished task wakes the session for another turn", async () => {
  const { a } = await claudeScript("background");
  a.send(user("start it"));
  await a.until((ls) => idles(ls) === 2);
  a.close();
  expect((await a.finish()).code).toBe(0);
  const kinds = a.lines().map(kind);
  const order = ["system/task_started", "result/success", "system/session_state_changed/idle", "system/task_notification", "result/success"];
  let from = 0;
  for (const k of order) from = kinds.indexOf(k, from) + 1;
  expect(from).toBeGreaterThan(0);
  expect(kinds.lastIndexOf("system/session_state_changed/idle")).toBe(kinds.length - 1);
});

test("built-in rate-limit: a rejected rate_limit_event and an error result", async () => {
  const { a } = await claudeScript("rate-limit");
  a.send(user("hi"));
  await a.until((ls) => idles(ls) === 1);
  a.close();
  await a.finish();
  const msgs = a.lines().map((l) => JSON.parse(l));
  const event = msgs.find((m) => m.type === "rate_limit_event");
  expect(event.rate_limit_info.status).toBe("rejected");
  expect(event.rate_limit_info.resetsAt).toBeGreaterThan(Date.now() / 1000);
  expect(msgs.find((m) => m.type === "result")).toMatchObject({ is_error: true });
});

test("built-in crash: the agent dies mid-turn with a non-zero code", async () => {
  const { a } = await claudeScript("crash");
  a.send(user("hi"));
  const { code } = await a.finish();
  expect(code).not.toBe(0);
  expect(a.lines().map(kind)).toContain("assistant");
  expect(a.lines().some((l) => kind(l).startsWith("result"))).toBe(false);
});

test("built-in seq: numbered lines in order without end", async () => {
  const { a } = await claudeScript("seq");
  a.send(user("go"));
  const ls = await a.until((ls) => ls.filter((l) => kind(l) === "seq").length >= 30);
  a.proc.kill("SIGKILL");
  await a.finish();
  const seqs = ls.filter((l) => kind(l) === "seq").map((l) => JSON.parse(l).seq);
  expect(seqs.slice(1, 30)).toEqual(seqs.slice(0, 29).map((n: number) => n + 1));
});

// pi-shaped built-ins speak `pi --mode rpc`: commands carry an id that the response repeats.
const prompt = (id: string, message: string, more: object = {}) => JSON.stringify({ id, type: "prompt", message, ...more });
const settled = (ls: string[]) => ls.filter((l) => JSON.parse(l).type === "agent_settled").length;

test("built-in pi-turn: each prompt gets a run to agent_settled, written to a session file in pi's layout", async () => {
  const { home, work, agent } = setup({ script: "pi-turn" });
  const sid = "00000000-0000-4000-8000-4c4a2a950dc8";
  const a = start(agent.path, { args: ["--mode", "rpc", "--session-id", sid], env: { HOME: home }, cwd: work });
  a.send(prompt("c1", "hi"));
  await a.until((ls) => settled(ls) === 1);
  a.send('{"id":"c2","type":"get_state"}', prompt("c3", "again"));
  await a.until((ls) => settled(ls) === 2);
  a.close();
  expect((await a.finish()).code).toBe(0);

  const recs = a.lines().map((l) => JSON.parse(l));
  const run = ["response", "agent_start", "turn_start", "message_start", "message_update", "message_end", "turn_end", "agent_end", "agent_settled"];
  expect(recs.map((r) => r.type)).toEqual([...run, "response", ...run]);
  expect(recs.filter((r) => r.type === "response").map((r) => [r.id, r.command, r.success])).toEqual([
    ["c1", "prompt", true], ["c2", "get_state", true], ["c3", "prompt", true],
  ]);
  expect(recs[9].data).toMatchObject({ sessionId: sid, model: { provider: "fake", id: "pi-fake" } });

  // As pi names them: the directory from the cwd, the file from its start time and the session id.
  const sessions = join(home, ".pi/agent/sessions", `--${work.slice(1).replaceAll("/", "-")}--`);
  const [file, ...others] = readdirSync(sessions);
  expect(others).toEqual([]);
  expect(file).toMatch(new RegExp(`^\\d{4}-\\d\\d-\\d\\dT\\d\\d-\\d\\d-\\d\\d-\\d{3}Z_${sid}\\.jsonl$`));
  const lines = readFileSync(join(sessions, file!), "utf8").trimEnd().split("\n").map((l) => JSON.parse(l));
  expect(lines[0]).toMatchObject({ type: "session", version: 3, id: sid, cwd: work });
  expect(lines.slice(1).map((e) => [e.type, e.message.role])).toEqual([
    ["message", "user"], ["message", "assistant"], ["message", "user"], ["message", "assistant"],
  ]);
  expect(lines[3].message.content).toEqual([{ type: "text", text: "again" }]);
});

test("built-in pi-turn: a later run of the same session id appends to its file; --session-dir puts it there", async () => {
  const { home, work, agent } = setup({ script: "pi-turn" });
  const dir = join(home, "elsewhere");
  for (const text of ["one", "two"]) {
    const a = start(agent.path, { args: ["--mode", "rpc", "--session-id", "s1", "--session-dir", dir], env: { HOME: home }, cwd: work });
    a.send(prompt("c1", text));
    await a.until((ls) => settled(ls) === 1);
    a.close();
    await a.finish();
  }
  const [file, ...others] = readdirSync(dir);
  expect(others).toEqual([]);
  expect(readFileSync(join(dir, file!), "utf8").match(/"type":"session"/g)).toHaveLength(1);
  expect(readFileSync(join(dir, file!), "utf8")).toContain('"text":"two"');
});

test("built-in pi-until-interrupted: the first run goes on until abort, then settles as aborted before abort is answered", async () => {
  const { home, work, agent } = setup({ script: "pi-until-interrupted" });
  const a = start(agent.path, { args: ["--mode", "rpc", "--session-id", "s1"], env: { HOME: home }, cwd: work });
  a.send(prompt("c1", "count"));
  await a.until((ls) => ls.some((l) => JSON.parse(l).type === "agent_start"));
  a.send(prompt("c2", "and more", { streamingBehavior: "steer" }));
  await a.until((ls) => ls.some((l) => JSON.parse(l).id === "c2"));
  a.send('{"id":"c3","type":"abort"}');
  await a.until((ls) => settled(ls) === 1);
  a.send(prompt("c4", "next"));
  await a.until((ls) => settled(ls) === 2);
  a.close();
  expect((await a.finish()).code).toBe(0);
  const recs = a.lines().map((l) => JSON.parse(l));
  const at = (pred: (r: any) => boolean) => recs.findIndex(pred);
  expect(recs.find((r) => r.id === "c2").data).toEqual({ disposition: "queued" });
  expect(recs.find((r) => r.type === "agent_settled")).toEqual({ type: "agent_settled", aborted: true });
  expect(at((r) => r.type === "agent_settled")).toBeLessThan(at((r) => r.id === "c3"));
  expect(recs.at(-1)).toEqual({ type: "agent_settled", aborted: false });
});

test("built-in hard-lines: U+2028, a multi-MB line and a split 汉 arrive byte for byte", async () => {
  const { a } = await claudeScript("hard-lines");
  a.send(user("go"));
  await a.until((ls) => idles(ls) === 1);
  a.close();
  await a.finish();
  const out = a.out();
  // U+2028 stays raw (E2 80 A8) inside its line, not escaped and not a line break.
  expect(out.includes(Buffer.from([0xe2, 0x80, 0xa8]))).toBe(true);
  const texts = a.lines().filter((l) => kind(l) === "assistant").map((l) => JSON.parse(l).message.content[0].text);
  expect(texts).toEqual(["line separator \u2028 inside a line", "x".repeat(3 * 1024 * 1024), "汉字被切开", "done"]);
  // The two writes of the last line meet inside the three bytes of 汉.
  const han = out.indexOf(Buffer.from("汉"));
  let end = 0;
  const boundaries = a.chunks.map((c) => (end += c.length));
  expect(boundaries.some((b) => b > han && b < han + 3)).toBe(true);
});

// A hand-written recording in the fixture format: meta, in.log ("<out.log bytes> <line>"), out.log.
const IN = [
  '{"type":"control_request","request_id":"rh-1-1","request":{"subtype":"initialize"}}',
  '{"type":"user","uuid":"11111111-1111-4111-8111-111111111111","message":{"role":"user","content":"hi"}}',
];
const OUT = [
  '{"type":"system","subtype":"hook_started"}\n',
  '{"type":"control_response","response":{"subtype":"success","request_id":"rh-1-1"}}\n',
  '{"type":"result","user_message_uuids":["11111111-1111-4111-8111-111111111111"],"result":"\u2028汉"}\n',
];
/** `ins[i]` is written once `outs[0..i]` are out. */
function recording(dir: string, ins: string[], outs: string[]): string {
  const fixture = join(dir, "fixture");
  mkdirSync(fixture);
  writeFileSync(join(fixture, "meta"), '{"agent":"claude","version":"2.1.304","scenario":"tiny","edited":true}\n');
  const at = (n: number) => Buffer.byteLength(outs.slice(0, n).join(""));
  writeFileSync(join(fixture, "in.log"), ins.map((l, i) => `${at(i + 1)} ${l}\n`).join(""));
  writeFileSync(join(fixture, "out.log"), outs.join(""));
  return fixture;
}
function replayer(ins = IN, outs = OUT) {
  const { dir, home, work } = setup({});
  const agent = installFakeAgent(dir, { replay: recording(dir, ins, outs) });
  return start(agent.path, { env: { HOME: home }, cwd: work });
}

test("replay plays out.log in step with in.log and exits 0 when every input matches", async () => {
  const a = replayer();
  await a.until((ls) => ls.length === 1);
  await Bun.sleep(100);
  expect(a.lines().length).toBe(1);
  a.send(IN[0]!);
  await a.until((ls) => ls.length === 2);
  a.send(IN[1]!);
  await a.until((ls) => ls.length === 3);
  a.close();
  expect(await a.finish()).toMatchObject({ code: 0, stderr: "" });
  expect(a.out()).toEqual(Buffer.from(OUT.join("")));
});

test("replay accepts other uuids and request ids in the same places, and answers with them", async () => {
  const a = replayer();
  a.send(IN[0]!.replace("rh-1-1", "rh-7-3"), IN[1]!.replace(/1111/g, "2222"));
  a.close();
  expect(await a.finish()).toMatchObject({ code: 0, stderr: "" });
  expect(a.out().toString()).toBe(OUT.join("").replace("rh-1-1", "rh-7-3").replace(/1111/g, "2222"));
});

test("replay fails when a uuid slot holds no uuid or a request_id slot holds no string", async () => {
  const uuid = /"11111111-1111-4111-8111-111111111111"/;
  for (const [line, path] of [
    [IN[1]!.replace(uuid, "null"), "$.uuid"],
    [IN[1]!.replace(uuid, "42"), "$.uuid"],
    [IN[1]!.replace(uuid, '"not-a-uuid"'), "$.uuid"],
    [IN[0]!.replace('"rh-1-1"', "7"), "$.request_id"],
  ] as [string, string][]) {
    const a = replayer();
    a.send(...(line.includes("initialize") ? [line, IN[1]!] : [IN[0]!, line]));
    a.close();
    const { code, stderr } = await a.finish();
    expect({ line, code, path: stderr.includes(path) }).toEqual({ line, code: 1, path: true });
  }
});

test("replay holds the driver to request ids the agent sent: the answer must carry the same one", async () => {
  // Claude asks with a uuid request_id; the driver's answer has to echo that exact value.
  const asked = "33333333-3333-4333-8333-333333333333";
  const ins = [
    IN[0]!,
    `{"type":"control_response","response":{"subtype":"success","request_id":"${asked}","response":{"behavior":"allow"}}}`,
  ];
  const outs = [
    OUT[0]!,
    OUT[1]! + `{"type":"control_request","request_id":"${asked}","request":{"subtype":"can_use_tool","tool_name":"Bash"}}\n`,
    '{"type":"result"}\n',
  ];
  const right = replayer(ins, outs);
  right.send(...ins);
  right.close();
  expect(await right.finish()).toMatchObject({ code: 0, stderr: "" });

  const wrong = replayer(ins, outs);
  wrong.send(ins[0]!, ins[1]!.replace(asked, "00000000-0000-4000-8000-000000000000"));
  wrong.close();
  const { code, stderr } = await wrong.finish();
  expect(code).toBe(1);
  expect(stderr).toContain("in.log line 2: $.response.request_id");
});

test("replay takes pi's command id as random like a request_id; an id pi sent must come back exactly", async () => {
  // pi's commands carry the writer's id; its dialogs carry pi's own, which the answer echoes.
  const asked = "00000000-0000-4000-8000-75acedd0fb5a";
  const ins = ['{"id":"get_state-47","type":"get_state"}', `{"type":"extension_ui_response","id":"${asked}","value":"allow"}`];
  const outs = [
    "",
    `{"id":"get_state-47","type":"response","command":"get_state","success":true}\n{"type":"extension_ui_request","id":"${asked}","method":"select"}\n`,
    '{"type":"agent_settled"}\n',
  ];
  const right = replayer(ins, outs);
  right.send(ins[0]!.replace("get_state-47", "rh-1-1"), ins[1]!);
  right.close();
  expect(await right.finish()).toMatchObject({ code: 0, stderr: "" });
  expect(right.lines()[0]).toBe('{"id":"rh-1-1","type":"response","command":"get_state","success":true}');

  const wrong = replayer(ins, outs);
  wrong.send(ins[0]!.replace("get_state-47", "rh-1-1"), ins[1]!.replace(asked, "rh-1-2"));
  wrong.close();
  const { code, stderr } = await wrong.finish();
  expect(code).toBe(1);
  expect(stderr).toContain("in.log line 2: $.id");
});

test("replay fails with a diff on stderr when a line has an extra field", async () => {
  const a = replayer();
  a.send(IN[0]!, IN[1]!.replace('"content":"hi"', '"content":"hi","extra":1'));
  a.close();
  const { code, stderr } = await a.finish();
  expect(code).not.toBe(0);
  expect(stderr).toContain("in.log line 2");
  expect(stderr).toContain("$.message.extra");
});

test("replay fails with a diff on stderr when a line is missing or one too many", async () => {
  const short = replayer();
  short.send(IN[0]!);
  short.close();
  const missing = await short.finish();
  expect(missing.code).not.toBe(0);
  expect(missing.stderr).toContain("in.log line 2");
  expect(missing.stderr).toContain(IN[1]!);

  const long = replayer();
  long.send(...IN, '{"type":"user"}');
  long.close();
  const extra = await long.finish();
  expect(extra.code).not.toBe(0);
  expect(extra.stderr).toContain('{"type":"user"}');
});

test("project directory names match real Claude 2.1.304, including the hashed form of long paths", () => {
  // Seen on disk after real `claude` runs in these directories.
  expect(claudeProjectDir("/home/user/Rhodium/.claude/worktrees/wf_d29635d3-b04-4/.scratch/probe18")).toBe(
    "-home-user-Rhodium--claude-worktrees-wf-d29635d3-b04-4--scratch-probe18",
  );
  // Over 200 characters Claude keeps 200 and appends a base-36 hash of the full path.
  // Expected value computed separately in Python from the rule found in the 2.1.304 binary.
  const long = "/tmp/" + "a".repeat(120) + "/" + "b".repeat(120);
  expect(claudeProjectDir(long)).toBe("-tmp-" + "a".repeat(120) + "-" + "b".repeat(74) + "-k4vqaw");
});
