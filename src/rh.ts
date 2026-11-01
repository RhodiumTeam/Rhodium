// The rh command line: one request to rhodium's unix socket per call (architecture §9.1).
// Help and the agent skill are printed locally, so they work without a running rhodium.
import { createConnection } from "node:net";
import { isatty } from "node:tty";
import type { Ask } from "./bot";
import { helpText, skillText } from "./commands";
import { defaultSocketDir } from "./config";
import type { RhRequest } from "./daemon";
import type { RhReply } from "./router";

/** Runs one rh call and returns its exit code. */
export async function rh(args: string[], env: Record<string, string | undefined> = process.env): Promise<number> {
  if (!args.length || args[0] === "--help" || args[0] === "-h") {
    process.stdout.write(helpText());
    return 0;
  }
  if (args[0] === "--skill") {
    process.stdout.write(skillText());
    return 0;
  }
  // Loaded only here: it brings the fake IM platform, which every other rh call can do without.
  if (args[0] === "dev") return (await import("./dev")).dev(args.slice(1));

  const path = env.RHODIUM_SOCKET || `${defaultSocketDir(env)}/rh.sock`;
  const caller = { token: env.RHODIUM_TOKEN || null, pid: process.pid, tty: isatty(0), cwd: process.cwd() };
  const ask: Ask = async (argv, credentials) => {
    const req: RhRequest = { argv, caller, ...(credentials && { credentials }) };
    return JSON.parse(await call(path, JSON.stringify(req) + "\n"));
  };
  let reply: RhReply;
  try {
    // Loaded only here, with the QR and Telegram clients it brings.
    if (args[0] === "bot") return await (await import("./bot")).bot(args.slice(1), ask);
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

function call(path: string, line: string): Promise<string> {
  return new Promise((ok, fail) => {
    let buf = "";
    const sock = createConnection(path, () => sock.write(line));
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => (buf += chunk));
    sock.on("error", fail);
    sock.on("end", () => (buf ? ok(buf) : fail(new Error("rhodium 没有回复就断开了"))));
  });
}
