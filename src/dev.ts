// rh dev --fake (architecture §2): Rhodium with the fake IM platform in your terminal, no real bot.
// It runs the platform for the config's fake bots and a rhodium on that config. Each line you type
// reaches the first fake bot as a private message from its owner; what the bot sends back is
// printed. The agent is whatever [programs] says: a fake agent, or your own claude.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fixedOwners, loadConfig, type Config } from "./config";
import { FakeIm, FakeImClient, fakeCapabilities } from "./fake-im";

const USAGE = "用法：rh dev --fake --config <配置文件>\n";

/** This same program run as the rhodium daemon: the compiled binary, or bun with main.ts. */
const self = () => (Bun.main.startsWith("/$bunfs/") ? [process.execPath] : [process.execPath, Bun.main]);

export async function dev(args: string[]): Promise<number> {
  let config: string | undefined;
  let cfg: Config;
  try {
    const { values } = parseArgs({ args, options: { fake: { type: "boolean" }, config: { type: "string" } } });
    if (!values.fake || !values.config) throw new Error("");
    config = values.config;
  } catch {
    process.stderr.write(USAGE);
    return 2;
  }
  try {
    cfg = loadConfig(config);
  } catch (err) {
    process.stderr.write(`rh dev: ${(err as Error).message}\n`);
    return 1;
  }
  const fakes = Object.entries(cfg.bots).filter(([, b]) => b.platform === "fake");
  const [name, bot] = fakes[0] ?? [];
  if (!name || !bot?.socket || !bot.owner) {
    process.stderr.write('rh dev: 配置里要有一个 platform = "fake" 的 Bot，写上 socket 和 owner（你在这个 Bot 下的用户 ID）\n');
    return 1;
  }
  const me = fixedOwners(bot)[0]!; // the first, of a list

  const platform = new FakeIm(bot.socket);
  for (const [n, b] of fakes) {
    if (b.socket === bot.socket) platform.bot({ name: n, capabilities: fakeCapabilities(b), passiveReplies: cfg.limits.qqPassiveReplies, passiveWindowMs: cfg.durations.qqPassiveWindow });
  }
  const im = new FakeImClient(bot.socket);
  mkdirSync(cfg.stateDir, { recursive: true });
  const logFile = join(cfg.stateDir, "dev.log");
  const daemon = Bun.spawn([...self(), "--config", config], { stdin: "ignore", stdout: "ignore", stderr: Bun.file(logFile) });
  let stopping = false;
  void daemon.exited.then((code) => {
    if (stopping) return;
    process.stderr.write(`rh dev: rhodium 退出了（${code}），日志在 ${logFile}\n`);
    platform.close();
    process.exit(1);
  });
  // Terminated, say by a test's cleanup: its rhodium goes too, rather than run on unowned.
  process.on("SIGTERM", () => {
    stopping = true;
    daemon.kill();
    process.exit(143);
  });
  process.stdout.write(`rhodium 已启动，日志在 ${logFile}。\n每输入一行，就是你经 Bot ${name} 发的一条私聊消息。Ctrl-D 退出。\n`);

  // What the bot sends to your chat, as it comes.
  let shown = 0;
  const printing = (async () => {
    while (!stopping) {
      const posts = await im.log(name, me).catch(() => []);
      for (const p of posts.slice(shown)) {
        if (p.kind === "toast" || p.kind === "unbutton") continue; // buttons can't be pressed here: answer with words
        const file = p.file ? `[${p.file.kind === "image" ? "图片" : "文件"}] ${p.file.name}` : "";
        const buttons = p.buttons?.length ? `[${p.buttons.map((b) => b.label).join(" | ")}]` : "";
        process.stdout.write(`${p.kind === "edit" ? "~" : "<"} ${[file, p.text, buttons].filter(Boolean).join(" ")}\n`);
      }
      shown = Math.max(shown, posts.length);
      await Bun.sleep(100);
    }
  })();

  for await (const line of console) {
    if (line.trim()) await im.inject(name, { chat: me, sender: me, text: line });
  }

  stopping = true;
  await printing;
  daemon.kill();
  await daemon.exited;
  platform.close();
  process.stdout.write(
    `rhodium 已停。托管进程照常在跑，和 rhodium 重启时一样；要停掉它们：systemctl --user stop '${cfg.unitPrefix}hold-*'\n`,
  );
  return 0;
}
