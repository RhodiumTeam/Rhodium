import { describe, expect, test } from "bun:test";
import { FAKE, SYNTHETIC_TAIL, SYNTHETIC_UUID, synthLines, synthName, synthRecording } from "../scripts/probes/synth";

const HOME = "/home/alice";
const j = (o: unknown) => JSON.stringify(o);
const lines = (s: string) => s.split("\n").filter(Boolean);
const parse = (s: string) => lines(s).map((l) => JSON.parse(l));
const claude = (outLog: string, inLog = "", names?: string[]) => synthRecording({ inLog, outLog }, "claude", { home: HOME, names });

const initResponse = {
  type: "control_response",
  response: {
    subtype: "success", request_id: "rh-1-1",
    response: {
      account: { email: "alice@corp.example", organization: "alice@corp.example's Organization", subscriptionType: "Claude Max", apiProvider: "firstParty" },
      commands: [
        { name: "my-voice", description: "Alice's personal writing voice. (user)", argumentHint: "" },
        { name: "tidy:tidy-review", description: "Find what to delete.", argumentHint: "" },
        { name: "compact", description: "Clear conversation history but keep a summary", argumentHint: "<optional instructions>" },
      ],
      available_output_styles: ["default", "Alice"],
      user_output_styles_dir: "/home/alice/.claude/output-styles",
    },
    pending_permission_requests: [],
  },
};
const sysInit = {
  type: "system", subtype: "init", cwd: "/tmp/rh-probe-AbC123/work", session_id: "8c3f1b5e-2d4a-4f6b-9a1c-3e5d7f9b1a2c",
  tools: ["Bash", "Read", "mcp__plugin_chatbridge_chatbridge__reply"],
  mcp_servers: [{ name: "plugin:chatbridge:chatbridge", status: "failed", source: "plugin" }],
  slash_commands: ["my-voice", "tidy:tidy-review", "compact"],
  skills: ["my-voice", "tidy:tidy-review"],
  plugins: [
    { name: "tidy", path: "/home/alice/.claude/plugins/cache/tidy/tidy/4.9.0", source: "tidy@tidy" },
    { name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" },
  ],
  agents: ["claude", "Explore", "alice-agent"],
  memory_paths: { auto: "/home/alice/.claude/projects/-home-alice-work/memory/" },
};

describe("synthesizing a Claude recording", () => {
  test("account values become fixed ones, keeping the fields", () => {
    const out = parse(claude(j(initResponse) + "\n").outLog);
    expect(out[0].response.response.account).toEqual({ email: FAKE.email, organization: FAKE.org, subscriptionType: FAKE.claudePlan, apiProvider: "firstParty" });
  });

  test("lists keep only what Claude Code ships, and home paths become /home/user", () => {
    const res = claude(j(initResponse) + "\n" + j(sysInit) + "\n", "", ["alice-agent"]);
    const [r, init] = parse(res.outLog);
    expect(r.response.response.commands.map((c: any) => c.name)).toEqual(["compact"]);
    expect(r.response.response.available_output_styles).toEqual(["default"]);
    expect(r.response.response.user_output_styles_dir).toBe("/home/user/.claude/output-styles");
    expect(init).toMatchObject({
      cwd: "/tmp/rh-probe/work", tools: ["Bash", "Read"], mcp_servers: [], slash_commands: ["compact"], skills: [],
      plugins: [{ name: "cc-plugin-telemetry", path: "builtin", source: "cc-plugin-telemetry@builtin" }],
      agents: ["claude", "Explore"], memory_paths: { auto: "/home/user/.claude/projects/-home-user-work/memory/" },
    });
    expect(res.leaks).toEqual([]);
  });

  test("an id becomes a synthetic one, the same in out.log and in.log, and stays it when synthesized again", () => {
    const tool = { type: "assistant", session_id: sysInit.session_id, message: { id: "msg_01AbCdEfGhIjKlMnOpQrStUv", content: [{ type: "tool_use", id: "toolu_01AbCdEfGhIjKlMnOpQrStUv", name: "Read", input: {} }] } };
    const answer = { type: "user", session_id: sysInit.session_id, message: { content: [{ type: "tool_result", tool_use_id: "toolu_01AbCdEfGhIjKlMnOpQrStUv" }] } };
    const outLog = j(tool) + "\n";
    const res = claude(outLog, `${outLog.length} ${j(answer)}\n`);
    const out = parse(res.outLog)[0];
    const sent = JSON.parse(res.inLog.slice(res.inLog.indexOf(" ") + 1));
    expect(out.session_id).toMatch(SYNTHETIC_UUID);
    expect(sent.session_id).toBe(out.session_id);
    const id = out.message.content[0].id;
    expect(id).toMatch(/^toolu_/);
    expect(id.slice(6)).toMatch(SYNTHETIC_TAIL);
    expect(id).toHaveLength("toolu_01AbCdEfGhIjKlMnOpQrStUv".length);
    expect(sent.message.content[0].tool_use_id).toBe(id);
    expect(out.message.id).not.toBe("msg_01AbCdEfGhIjKlMnOpQrStUv");
    const again = synthRecording(res, "claude", { home: HOME });
    expect({ inLog: again.inLog, outLog: again.outLog }).toEqual({ inLog: res.inLog, outLog: res.outLog });
  });

  test("thinking signatures become a fixed fake, streamed or whole", () => {
    const whole = { type: "assistant", message: { content: [{ type: "thinking", thinking: "hm", signature: "EqQBCkYIBxgCKkB" }] } };
    const delta = { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "EqQBCkYIBxgCKkB" } } };
    const [a, d] = parse(claude(j(whole) + "\n" + j(delta) + "\n").outLog);
    expect(a.message.content[0].signature).toBe(FAKE.signature);
    expect(d.event.delta.signature).toBe(FAKE.signature);
  });

  test("hook output becomes a placeholder", () => {
    const hook = { type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", output: "TIDY MODE ACTIVE", stdout: "TIDY MODE ACTIVE", stderr: "", exit_code: 0 };
    expect(parse(claude(j(hook) + "\n").outLog)[0]).toEqual({ ...hook, output: "Placeholder hook output.", stdout: "Placeholder hook output." });
  });

  test("a home path split across streamed deltas is cleaned, and the deltas still join up", () => {
    const delta = (text: string) => ({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } });
    const outLog = [{ type: "stream_event", event: { type: "message_start", message: { id: "m1" } } }, delta("Saved to /home/al"), delta("ice/plan.md now")]
      .map(j).join("\n") + "\n";
    const out = parse(claude(outLog).outLog);
    expect(out[1].event.delta.text + out[2].event.delta.text).toBe("Saved to /home/user/plan.md now");
    // and no piece ends halfway through the cleaned path, which would read as another home dir
    expect(out[1].event.delta.text).toBe("Saved to /home/user/plan.md");
  });

  test("in.log offsets follow the out.log lines they pointed at", () => {
    const first = j(initResponse);
    const second = j({ type: "system", subtype: "session_state_changed", state: "idle" });
    const outLog = first + "\n" + second + "\n";
    const frame = j({ type: "user", message: { role: "user", content: "see /tmp/rh-probe-AbC123/work" } });
    const res = claude(outLog, `0 ${frame}\n${first.length + 1} ${frame}\n${outLog.length} ${frame}\n`);
    const newFirst = lines(res.outLog)[0]!;
    const sent = j({ type: "user", message: { role: "user", content: "see /tmp/rh-probe/work" } });
    expect(res.inLog).toBe(`0 ${sent}\n${newFirst.length + 1} ${sent}\n${res.outLog.length} ${sent}\n`);
  });

  test("a plain-word private name is only replaced where it is the whole value, so URLs in built-in text survive", () => {
    const resp = structuredClone(initResponse);
    resp.response.response.commands = [{ name: "ultrareview", description: "See https://code.claude.com/docs/en/web", argumentHint: "" }];
    const said = { type: "user", message: { role: "user", content: "docs" } };
    const init = { type: "system", subtype: "init", skills: ["docs"], slash_commands: ["docs", "ultrareview"] };
    const [r, i, s] = parse(claude(j(resp) + "\n" + j(init) + "\n" + j(said) + "\n").outLog);
    expect(r.response.response.commands[0].description).toBe("See https://code.claude.com/docs/en/web");
    expect(i.slash_commands).toEqual(["ultrareview"]);
    expect(s.message.content).toMatch(/^skill-\d+$/);
  });

  test("plugin names in prose are replaced whatever their case, also when only a command names the plugin", () => {
    const resp = structuredClone(initResponse);
    resp.response.response.commands.push({ name: "acme-skills:interview", description: "Interview the user.", argumentHint: "" });
    const prose = { type: "user", message: { role: "user", content: "Summary: Tidy mode is active via the tidy plugin; acme-skills is idle." } };
    const res = claude(j(resp) + "\n" + j(sysInit) + "\n" + j(prose) + "\n");
    expect(parse(res.outLog)[2].message.content).toMatch(/^Summary: (plugin-\d+) mode is active via the \1 plugin; plugin-\d+ is idle\.$/);
    expect(res.leaks).toEqual([]);
  });

  test("reports what is still left when a private name survives somewhere unexpected", () => {
    // a plugin name glued into another word is not swapped, so the leak check must catch it
    const leaky = { type: "assistant", message: { content: [{ type: "text", text: "see tidyness" }] } };
    expect(claude(j(sysInit) + "\n" + j(leaky) + "\n").leaks).toEqual(["tidy"]);
  });

  test("a transcript's skill listing keeps the built-in skills and their digests", () => {
    const listing = { type: "attachment", attachment: { type: "skill_listing", content: "- my-voice: …", skillCount: 2, names: ["my-voice", "simplify"], digests: ["aa", "bb"] } };
    expect(parse(synthLines(j(listing), "claude", { home: HOME }))[0].attachment).toEqual({ type: "skill_listing", content: "[redacted]", skillCount: 1, names: ["simplify"], digests: ["bb"] });
  });
});

describe("synthesizing other recordings", () => {
  test("the timezone in the text Codex shows the model, and the name of a file you sent, become fixed ones", () => {
    const lines = [
      { type: "response_item", payload: { content: [{ text: "<environment_context>\n  <timezone>America/Denver</timezone>\n</environment_context>" }] } },
      { event: { message: { content: JSON.stringify({ file_key: "file_v3_01", file_name: "Alice's thesis draft.pdf" }) } } },
      { event: { message: { content: JSON.stringify({ file_key: "file_v3_02", file_name: "README" }) } } },
      { event: { message: { content: JSON.stringify({ file_key: "file_v3_03", file_name: 'a "quoted" name.pdf' }) } } },
      { event: { message: { content: JSON.stringify({ file_key: "file_v3_04", file_name: "notes on Dr.Tanaka" }) } } },
    ].map(j).join("\n");
    const [env, file, bare, quoted, dotted] = parse(synthLines(lines, "codex", { home: HOME }));
    expect(JSON.parse(quoted.event.message.content).file_name).toBe("file.pdf");
    expect(JSON.parse(dotted.event.message.content).file_name).toBe("file");
    expect(env.payload.content[0].text).toBe(`<environment_context>\n  <timezone>${FAKE.timezone}</timezone>\n</environment_context>`);
    expect(JSON.parse(file.event.message.content).file_name).toBe("file.pdf");
    expect(JSON.parse(bare.event.message.content).file_name).toBe("file");
  });

  test("Codex's skill list keeps its system skills, and account values become fixed ones", () => {
    const body = [
      "## Skills", "### Skill roots", "- `r0` = `/home/alice/.agents/skills`", "- `r1` = `/home/alice/.codex/skills/.system`",
      "- `r2` = `/home/alice/.codex/plugins/cache/tidy/tidy/1.0.0/skills`", "### Available skills",
      "- imagegen: Make images. (file: r1/imagegen/SKILL.md)", "- my-voice: Alice's voice. (file: r0/my-voice/SKILL.md)",
      "- tidy:tidy-review: Find what to delete. (file: r2/tidy-review/SKILL.md)",
    ].join("\n");
    const rollout = [
      { type: "world_state", payload: { state: { host_skills: { body }, environments: { timezone: "America/Denver" } } } },
      { type: "event_msg", payload: { rate_limits: { plan_type: "pro", credits: { has_credits: true, balance: "123.4500000000" } } } },
      { type: "response_item", payload: { content: [{ text: "Use tidy:tidy-review, as tidy says." }] } },
      { method: "remoteControl/status/changed", params: { status: "disabled", serverName: "alices-laptop" } },
      { method: "mcpServer/elicitation/request", params: { serverName: "rhprobe" } },
    ].map(j).join("\n");
    const [world, limits, prose, remote, mcp] = parse(synthLines(rollout, "codex", { home: HOME }));
    expect(world.payload.state.host_skills.body).toBe([
      "## Skills", "### Skill roots", "- `r1` = `/home/user/.codex/skills/.system`", "### Available skills", "- imagegen: Make images. (file: r1/imagegen/SKILL.md)",
    ].join("\n"));
    expect(world.payload.state.environments.timezone).toBe(FAKE.timezone);
    expect(limits.payload.rate_limits).toEqual({ plan_type: FAKE.codexPlan, credits: { has_credits: true, balance: FAKE.credits } });
    expect(prose.payload.content[0].text).toMatch(/^Use skill-\d+, as plugin-\d+ says\.$/);
    expect(remote.params.serverName).toBe(FAKE.host);
    expect(mcp.params.serverName).toBe("rhprobe");
  });

  test("Feishu's probe log starts at a fixed moment, keeping the gaps, and its app id becomes a synthetic one", () => {
    const log = [
      { t: "2026-03-05T07:51:11.377Z", ev: "qr" },
      { t: "2026-03-05T07:52:11.877Z", ev: "done", appId: "cli_a1b2c3d4e5f60718" },
    ].map(j).join("\n") + "\n";
    const [qr, done] = parse(synthLines(log, "feishu"));
    expect([qr.t, done.t]).toEqual(["2026-01-01T00:00:00.377Z", "2026-01-01T00:01:00.877Z"]);
    expect(done.appId).toMatch(/^cli_0000\d{12}$/);
  });

  test("the pid in the name of a Claude socket becomes a synthetic one, the same wherever it shows", () => {
    const row = (pid: string) => ({ env: `ANTHROPIC_UNIX_SOCKET=/run/user/1000/cc-socks/${pid}.sock` });
    const [a, b, c] = parse(synthLines([row("1522153"), row("1522153"), row("2172997")].map(j).join("\n"), "claude", { home: HOME }));
    expect(a.env).toMatch(/^ANTHROPIC_UNIX_SOCKET=\/run\/user\/1000\/cc-socks\/0\d{6}\.sock$/);
    expect([b.env, c.env]).toEqual([a.env, expect.not.stringContaining(a.env)]);
    expect(parse(synthLines(j(a), "claude", { home: HOME }))[0]).toEqual(a);
  });

  test("your home in pi's and Claude's directory names becomes user's", () => {
    const state = { type: "response", data: { sessionFile: "/home/alice/.pi/agent/sessions/--home-alice-shop--/s.jsonl" } };
    expect(parse(synthLines(j(state), "pi", { home: HOME }))[0].data.sessionFile).toBe("/home/user/.pi/agent/sessions/--home-user-shop--/s.jsonl");
  });

  test("pi's entry ids become synthetic ones and still chain", () => {
    const session = [{ type: "model_change", id: "a1b2c3d4", parentId: null }, { type: "message", id: "e5f60718", parentId: "a1b2c3d4" }].map(j).join("\n");
    const [first, second] = parse(synthLines(session, "pi"));
    expect(first.id).toMatch(/^00\d{6}$/);
    expect(second).toMatchObject({ id: expect.stringMatching(/^00\d{6}$/), parentId: first.id });
  });
});

describe("synthesizing absolute times", () => {
  // The recording's first moment; the rest of the times below are given as seconds after it.
  const T0 = Date.parse("2026-03-14T08:33:00.119Z") / 1000 | 0;
  const iso = (s: number, ms = "119") => new Date(s * 1000).toISOString().replace(".000", `.${ms}`);
  const base = FAKE.timeBase / 1000;

  test("the earliest time moves to the fixed base and every other keeps its gap to it, in whatever form it is written", () => {
    const out = [
      { type: "system", timestamp: iso(T0) },
      { type: "limits", as_of: iso(T0 + 2).replace("Z", "").replace(".119", ".416777+00:00"), resetsAt: T0 + 5 * 3600, completed_at_ms: (T0 + 3) * 1000 + 250 },
      { thread: { createdAt: T0 + 1, create_time: T0 + 0.5, update_time: String((T0 + 4) * 1000 + 7), started: String(T0 + 6) } },
      { message: { content: JSON.stringify({ CreateTime: T0 + 8, FileSize: 10615609 }) } },
    ];
    const [a, b, c, d] = parse(synthLines(out.map(j).join("\n"), "codex", { home: HOME }));
    expect(a.timestamp).toBe("2026-01-01T00:00:00.119Z");
    expect(b.as_of).toBe("2026-01-01T00:00:02.416777+00:00");
    expect(b.resetsAt).toBe(base + 5 * 3600);
    expect(b.completed_at_ms).toBe((base + 3) * 1000 + 250);
    expect(c.thread).toEqual({ createdAt: base + 1, create_time: base + 0.5, update_time: String((base + 4) * 1000 + 7), started: String(base + 6) });
    expect(JSON.parse(d.message.content)).toEqual({ CreateTime: base + 8, FileSize: 10615609 });
  });

  test("the local clock follows: a Codex rollout's file name and dated directory, the current date, and the times printed in prose", () => {
    // 17:33 on the clock of FAKE.timezone (UTC+9); the quota resets 3 hours later, and the prose gives that in UTC and in local time.
    const rows = [
      { timestamp: iso(T0) },
      { path: `/home/user/.codex/sessions/2026/03/14/rollout-2026-03-14T17-33-00-00000000-0000-7000-8000-8d5c554c3185.jsonl` },
      { env: "<current_date>2026-03-14</current_date>", current_date: "2026-03-14", beta: "oauth-2025-04-20" },
      { error: "You've hit your limit · resets 11:33 (UTC)", more: "try again at Mar 14th, 2026 8:33 PM." },
    ];
    const [t, p, e, m] = parse(synthLines(rows.map(j).join("\n"), "codex", { home: HOME }));
    expect(t.timestamp).toBe("2026-01-01T00:00:00.119Z");
    expect(p.path).toBe("/home/user/.codex/sessions/2026/01/01/rollout-2026-01-01T09-00-00-00000000-0000-7000-8000-8d5c554c3185.jsonl");
    expect(e).toEqual({ env: "<current_date>2026-01-01</current_date>", current_date: "2026-01-01", beta: "oauth-2025-04-20" });
    expect(m.error).toBe("You've hit your limit · resets 03:00 (UTC)");
    expect(m.more).toBe("try again at Jan 1st, 2026 12:00 PM.");
  });

  test("a recording's in.log and out.log move together, and synthesizing again changes nothing", () => {
    const sent = { type: "user", timestamp: iso(T0 + 10), message: { role: "user", content: "hi" } };
    const outLog = j({ type: "system", timestamp: iso(T0), startedAt: T0 }) + "\n";
    const res = claude(outLog, `0 ${j(sent)}\n`);
    expect(JSON.parse(res.inLog.slice(2)).timestamp).toBe("2026-01-01T00:00:10.119Z");
    expect(parse(res.outLog)[0]).toEqual({ type: "system", timestamp: "2026-01-01T00:00:00.119Z", startedAt: base });
    const again = synthRecording(res, "claude", { home: HOME });
    expect({ inLog: again.inLog, outLog: again.outLog }).toEqual({ inLog: res.inLog, outLog: res.outLog });
  });

  test("a time already inside the synthetic window stays, a real one next to it moves", () => {
    const rows = [{ t: "2026-01-01T00:00:05.000Z" }, { create_time: String(T0), update_time: String(T0 + 60) }];
    const [t, c] = parse(synthLines(rows.map(j).join("\n"), "feishu"));
    expect(t.t).toBe("2026-01-01T00:00:05.000Z");
    expect(c).toEqual({ create_time: String(base), update_time: String(base + 60) });
  });

  test("a Feishu id carries its creation second in its top bits, which move with the times", () => {
    const id = (sec: number) => String((BigInt(sec) << 32n) | 0x1234567n);
    const rows = [{ create_time: String(T0), command_id: id(T0) }, { command_id: id(T0 + 3) }];
    const [a, b] = parse(synthLines(rows.map(j).join("\n"), "feishu"));
    expect([a.create_time, a.command_id, b.command_id]).toEqual([String(base), id(base), id(base + 3)]);
  });

  test("a card press's create_time in microseconds moves with the times, and the probe's lag that carried it goes", () => {
    const rows = [
      { t: new Date(T0 * 1000 + 618).toISOString(), ev: "message", lag: 618, event: { create_time: String(T0 * 1000) } },
      { t: new Date(T0 * 1000 + 2000).toISOString(), ev: "press", lag: -T0 * 1e6, event: { create_time: String(T0 * 1e6 + 1_500_000) } },
    ];
    const [m, p] = parse(synthLines(rows.map(j).join("\n"), "feishu"));
    expect(m.lag).toBe(618);
    expect(p.event.create_time).toBe(String(base * 1e6 + 1_500_000));
    expect("lag" in p).toBe(false);
  });

  test("a file named by its start time is renamed with the time inside it", () => {
    const header = { type: "session", id: "s", timestamp: "2026-03-05T14:07:09.386Z" };
    const name = "2026-03-05T14-07-09-386Z_00000000-0000-4000-8000-4c4a2a950dc8.jsonl";
    expect(synthName(name, j(header))).toBe("2026-01-01T00-00-00-386Z_00000000-0000-4000-8000-4c4a2a950dc8.jsonl");
    expect(parse(synthLines(j(header), "pi"))[0].timestamp).toBe("2026-01-01T00:00:00.386Z");
    // already synthetic: unchanged
    expect(synthName("2026-01-01T00-00-00-386Z_x.jsonl", j({ timestamp: "2026-01-01T00:00:00.386Z" }))).toBe("2026-01-01T00-00-00-386Z_x.jsonl");
  });
});
