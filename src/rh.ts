// The rh command line: one request to rhodium's unix socket per call (architecture §9.1).
// Help and the agent skill are printed locally, so they work without a running rhodium.
import { dialWindows, windows } from "./windows";
import { createConnection } from "node:net";
import { isatty } from "node:tty";
import type { Ask } from "./bot";
import { helpText, skillText } from "./commands";
import { defaultSocketDir } from "./config";
import type { RhRequest } from "./daemon";
import type { RhReply } from "./router";

/** Runs one rh call and returns its exit code. */
export async function rh(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  // They ask no rhodium: a child slot's agent is known by what its process was started with (architecture §6.1).
  const child = env.RHODIUM_CHILD === "1";
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(helpText(child));
    return 0;
  }
  if (args[0] === "--skill") {
    process.stdout.write(skillText(undefined, child));
    return 0;
  }
  // Loaded only here: it brings the fake IM platform, which every other rh call can do without.
  if (args[0] === "dev") return (await import("./dev")).dev(args.slice(1));

  const path = env.RHODIUM_SOCKET || `${defaultSocketDir(env)}/rh.sock`;
  const caller = { token: env.RHODIUM_TOKEN || null, pid: process.pid, tty: isatty(0), cwd: process.cwd() };
  const ask: Ask = async (argv, more) => {
    const req: RhRequest = { argv, caller, ...more };
    return JSON.parse(await call(path, JSON.stringify(req) + "\n"));
  };
  let reply: RhReply;
  try {
    // Loaded only here, with the QR code drawing it brings.
    if (args[0] === "bot" && args[1] !== "rm") return await (await import("./bot")).bot(args.slice(1), ask);
    if (args[0] === "send" && args.at(-1) === "-") {
      let body = 2;
      if (!args[1]?.includes("/") && !/^[0-9A-HJKMNP-TV-Z]{26}$/.test(args[1] ?? "")) {
        while (args[body] === "--file") body += 2;
      }
      if (body === args.length - 1) args = [...args.slice(0, body), (await Bun.stdin.text()).replace(/\n$/, "")];
    }
    reply = await ask(args);
  } catch (err) {
    process.stderr.write(`rh: 连不上 rhodium（${path}）：${(err as Error).message}\n`);
    return 1;
  }
  if (!reply.ok) {
    process.stderr.write(`rh: ${reply.error}\n`);
    return 1;
  }
  process.stdout.write(reply.text.endsWith("\n") ? reply.text : reply.text + "\n");
  return 0;
}

async function call(path: string, line: string): Promise<string> {
  const sock = windows ? await dialWindows(path) : createConnection(path, () => sock.write(line));
  return new Promise((ok, fail) => {
    let buf = "";
    if (windows) sock.write(line);
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => (buf += chunk));
    sock.on("error", fail);
    sock.on("end", () => (buf ? ok(buf) : fail(new Error("rhodium 没有回复就断开了"))));
  });
}
