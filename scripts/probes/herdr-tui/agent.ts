// Compile once and copy under each CLI name. This fixture never calls a provider.
import { appendFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { run } from "../../../test/fake-agent/fake-agent";

const agent = basename(process.execPath, extname(process.execPath)).toLowerCase();
if (!["claude", "pi", "codex"].includes(agent)) throw new Error("unexpected test executable name");
const args = process.argv.slice(2);
if (!process.env.HERDR_PANE_ID || args.includes("-p") || args.includes("app-server") || args.includes("rpc")) {
  if (existsSync("rhodium-test-workspace")) writeFileSync("headless-entered", "");
  await run({ script: agent === "claude" ? "turn" : agent + "-turn" }, agent);
} else {
  if (!existsSync("rhodium-test-workspace") || !homedir().includes("rhodium-test-")) throw new Error("not in the isolated test workspace");
  const flag = (name: string) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
  const thread = agent === "codex" ? (args[0] === "resume" ? args[1] : null) : flag("--resume") ?? flag("--session-id");
  if (!thread || !/^[a-f0-9-]{36}$/i.test(thread)) throw new Error("no resumed fixture session");
  // Invoke the integration Herdr installed in the private test profile, with only the
  // event and sessionManager supplied by the synthetic agent.
  if (agent === "claude") {
    const windows = process.platform === "win32";
    const hook = join(homedir(), ".claude", "hooks", "herdr-agent-state." + (windows ? "ps1" : "sh"));
    const cmd = windows ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", hook] : ["/bin/sh", hook];
    const child = Bun.spawnSync([...cmd, "session"], { stdin: Buffer.from(JSON.stringify({ hook_event_name: "SessionStart", source: "resume", session_id: thread })), stdout: "ignore", stderr: "ignore", windowsHide: true });
    if (child.exitCode !== 0) throw new Error("Herdr Claude SessionStart hook failed");
  } else if (agent === "pi") {
    const dir = join(homedir(), ".pi", "agent");
    const sessions = join(dir, "sessions");
    const path = readdirSync(sessions, { recursive: true, encoding: "utf8" }).find(f => f.endsWith("_" + thread + ".jsonl"));
    if (!path) throw new Error("pi fixture transcript is missing");
    const extension = await import(pathToFileURL(join(dir, "extensions", "herdr-agent-state.ts")).href);
    type Listener = (event: object, context: object) => Promise<void>;
    const handlers = new Map<string, Listener>();
    extension.default({ events: { on() {} }, on(name: string, fn: Listener) { handlers.set(name, fn); } });
    const start = handlers.get("session_start");
    if (!start) throw new Error("Herdr pi extension did not register session_start");
    await start({ reason: "resume" }, { mode: "tui", isIdle: () => true, sessionManager: { getSessionFile: () => join(sessions, path), getSessionId: () => thread } });
  }
  writeFileSync("pane-observation.json", JSON.stringify({
    pid: process.pid, thread, dedicated: args.includes("--no-daemon"),
    sentinel: Object.keys(process.env).some((key) => key.toUpperCase() === "ANTHROPIC_API_KEY" && process.env[key] === "rhodium-test-sentinel"),
  }));
  console.log("PANE_READY");
  const box = (insert: boolean) => console.log(["Claude Code v2.1.325", "──────────────", "❯", "──────────────", insert ? "-- INSERT --" : "", "⏵⏵ bypass permissions on (shift+tab to cycle)"].join("\n"));
  if (agent === "claude") box(false);
  process.on("SIGINT", () => process.exit(0));
  for await (const line of createInterface({ input: process.stdin, terminal: false })) {
    if (line === "leave") {
      writeFileSync("natural-exit-requested", "");
      process.exit(0);
    }
    if (line === "insert" && agent === "claude") box(true);
    if (line === "probe") {
      console.log("PANE_ACCEPTED");
      appendFileSync("pane-inputs", "probe\n");
    }
  }
}
