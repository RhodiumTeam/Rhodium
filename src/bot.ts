// rh bot, the terminal side (product §5.11, architecture §8.5.1): it starts a bot-making flow in
// rhodium, which checks the name and the slot first, then asks after it each second: it draws each QR
// code rhodium gives at the terminal and prints what rhodium says, and reads what you paste, never
// echoed, for rhodium to check. Ctrl-C, or the terminal gone, cancels the flow. The scan, the check, writing the bot in and
// the pairing code are rhodium's (bot-flow.ts).
import type { RhRequest } from "./daemon";
import type { Made } from "./platforms";
import type { RhReply } from "./router";

/** One rh call to rhodium; throws when rhodium cannot be reached. more: a flow's op, and what was pasted. */
export type Ask = (argv: string[], more?: Pick<RhRequest, "flow" | "credentials">) => Promise<RhReply>;

const say = (text: string) => void process.stdout.write(text.endsWith("\n") ? text : text + "\n");

/** How each platform that takes a paste reads it at the terminal: the secret parts unechoed. */
const PASTE: Partial<Record<Made, () => Promise<Record<string, string>>>> = {
  telegram: async () => ({ token: await readLine("粘贴 @BotFather 给的 token（不回显），回车：", true) }),
  feishu: async () => ({ appId: await readLine("App ID："), secret: await readLine("App Secret（不回显）：", true) }),
};

export async function bot(args: string[], ask: Ask): Promise<number> {
  const fail = (text: string) => (process.stderr.write(`rh: ${text}\n`), 1);
  const first = await ask(["bot", ...args], { flow: { op: "start" } });
  if (!first.ok) return fail(first.error);
  say(first.text);
  const { id, platform } = first.flow!;
  const op = (o: "get" | "cancel" | "credentials", credentials?: Record<string, string>) => ask([], { flow: { op: o, id }, ...(credentials && { credentials }) });
  // Ctrl-C, the terminal gone (ssh dropped, window closed) or a kill: the flow goes with rh, as the scan did.
  for (const [signal, code] of [["SIGINT", 130], ["SIGHUP", 129], ["SIGTERM", 143]] as const)
    process.on(signal, () => {
      stty("echo"); // as a paste may have left it
      void op("cancel")
        .catch(() => {})
        .finally(() => process.exit(code));
    });
  let shown = 0;
  for (;;) {
    const r = await op("get");
    if (!r.ok) return fail(r.error);
    const f = r.flow!;
    const log = f.log ?? [];
    for (const s of log.slice(shown)) "qr" in s ? qrCode(s.qr) : say(s.text);
    shown = log.length;
    if (f.state === "done" || f.state === "pairing") return 0;
    if (f.state === "failed" || f.state === "cancelled") return fail(f.error ?? "已取消。");
    if (f.state === "paste") {
      // Turned down: as before the flow, rh bot ends; another try is another rh bot.
      if (f.error) {
        await op("cancel");
        return fail(f.error);
      }
      let pasted: Record<string, string>;
      try {
        pasted = await PASTE[platform]!();
      } catch (err) {
        await op("cancel");
        return fail((err as Error).message);
      }
      await op("credentials", pasted); // its outcome is the flow's next state
      continue;
    }
    await Bun.sleep(1000);
  }
}

/** text's QR code, drawn on the terminal. */
const qrCode = (text: string): void =>
  (require("qrcode-terminal") as { generate(text: string, o: { small: boolean }, done: (qr: string) => void): void }).generate(text, { small: true }, say);

const stty = (arg: string) => Bun.spawnSync(["stty", arg], { stdin: "inherit", stdout: "ignore", stderr: "ignore" }).success;

let lines: AsyncIterator<string> | undefined;
/** A line from the terminal on stdin; hidden: with its echo off while it is typed. */
async function readLine(prompt: string, hidden = false): Promise<string> {
  if (hidden && !stty("-echo")) throw new Error("rh bot 要在终端里运行，粘贴的才能不回显。");
  try {
    process.stderr.write(prompt); // after echo is off, so nothing typed on seeing it shows
    const line = await (lines ??= console[Symbol.asyncIterator]()).next();
    return line.done ? "" : line.value.trim();
  } finally {
    if (hidden) {
      stty("echo");
      process.stderr.write("\n");
    }
  }
}
