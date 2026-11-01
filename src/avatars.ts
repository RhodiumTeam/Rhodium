// Avatars and your Telegram name for the topology view (spec web-topology "头像"): each bot's
// profile, fetched at start and once a day, kept under the state directory's avatars/ by Rhodium's
// ids, so the board serves them with no token, platform id or platform address in sight.
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { owners, type Config } from "./config";
import type { ImAdapter } from "./contracts";
import type { Store } from "./store";

export const avatarDir = (cfg: Pick<Config, "stateDir">) => join(cfg.stateDir, "avatars");

/** An error as the log may say it: its kind and code, never its message, which may hold an address. */
export function errorKind(e: unknown): string {
  const err = e as { name?: string; message?: string; code?: unknown; error_code?: unknown; httpStatus?: unknown };
  if (/^HTTP \d+$/.test(err?.message ?? "")) return err.message!;
  return [err?.name ?? "Error", err?.code ?? err?.error_code ?? err?.httpStatus].filter((x) => x != null).join(" ");
}

/** Asks each bot for its profile and keeps it: the bot's picture by its id, yours and your name by
 *  your private chat's (<id>.name), once that chat is there; for each owner of the bot, by their
 *  own chat. What does not come keeps what was kept. */
export async function refreshAvatars(store: Store, cfg: Config, adapters: Map<string, Pick<ImAdapter, "profile">>): Promise<void> {
  const dir = avatarDir(cfg);
  await mkdir(dir, { recursive: true });
  // Written whole or not at all: the board may be reading it.
  const keep = async (name: string, data: Uint8Array | string) => {
    await Bun.write(join(dir, `${name}.tmp`), data);
    await rename(join(dir, `${name}.tmp`), join(dir, name));
  };
  await Promise.all(
    [...adapters].map(async ([id, adapter]) => {
      const bot = store.tx((tx) => tx.get("bot", id));
      if (!bot) return;
      const yours = owners(bot, cfg);
      // The bot's picture comes with each; asked with no owner, there is one still.
      for (const you of yours.length ? yours : [null]) {
        const chat = you === null ? undefined : store.tx((tx) => tx.find("chat", { bot: id, platformChatId: you })[0]);
        const p = await adapter.profile(you);
        if (p.bot) await keep(id, p.bot);
        if (chat && p.you) await keep(chat.id, p.you);
        if (chat && p.name) await keep(`${chat.id}.name`, p.name);
      }
    }),
  );
}
