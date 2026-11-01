// The IM platforms Rhodium talks to, one row each (architecture §8.1). What differs by platform
// outside its adapter is read from here: its name, its capability table and how rh bot makes one.
// What needs the platform's SDK is a Record<Platform, …> beside the code that loads it: the adapter's
// construction (daemon.ts's ADAPTERS), and rh bot's scan or paste (bot.ts's ONBOARD). A platform
// missing from any of them does not compile. No imports but types: every rh call loads this.
import type { BotConfig } from "./config";
import type { Capabilities, Durations, Platform } from "./contracts";

/** The platforms rh bot makes a bot on: all but the fake, which a test or rh dev runs. */
export type Made = Exclude<Platform, "fake">;

export type PlatformDef = {
  label: string; // as Rhodium's own words call it: QQ, 飞书 (source lines, chat names)
  /** Its capability table, for the bot's [bots.<name>] table and the config's durations. */
  capabilities(bot: BotConfig, durations: Durations): Capabilities;
};

/** How rh bot makes a bot on the platform (product §5.11, architecture §8.5). */
export type BotDef = {
  needed: string[]; // the keys its credentials must have; the first tells one bot from another
  optional: string[]; // and may have: owner, from a scan
  how: string; // rh bot's help, after the label
  apiRoot?: string; // what --api-root points it at, which it takes only so
  paste?: true; // takes --paste
  another: string; // how to make another bot, where the config has this one already
};

// The SDK's limits for a picture and a file (getMaxUploadSize), past which it uploads in chunks
// from 5 MB; test/platforms.test.ts holds them to the SDK's.
const QQ_FILE_BYTES = { image: 30 * 2 ** 20, file: 100 * 2 ** 20 };

export const QQ_CAPABILITIES: Capabilities = {
  progress: "append",
  // Callback buttons, in private chats too (probe 15); since 2026-10-22, on a phone, shown on a
  // Markdown message only (withKeyboard).
  buttons: "markdown",
  // A keyboard has at most 5 rows of 5 (QQ's button docs); Rhodium's pages hold 8 and a row of
  // 上一页、下一页 and 取消.
  maxButtons: 11,
  // ponytail: a command button's data, as Telegram's copy_text takes; QQ documents no limit, so measure it on the dev bot.
  copy: 256,
  sendLimit: { kind: "qq_quota" },
  menu: { scope: "global", maxItems: 20, row: "custom_menu" }, // 20: the most items one panel holds (bot.qq.com)
  // The SDK's own TEXT_CHUNK_LIMIT is 5000; 2000 keeps phone-screen-sized messages.
  maxTextLength: 2000,
  maxFileBytes: QQ_FILE_BYTES,
  // msg_type 2, as qq-cli's Stop hook sends it. QQ takes it only from a bot it approved for it, so
  // the adapter falls back to plain text. Syntax of its own beyond GFM: a heading's # needs no
  // space after it (#397, on a phone); more unverified.
  markdown: { extensions: ["heading"], literal: true },
};

export const TELEGRAM_CAPABILITIES: Capabilities = {
  progress: "edit",
  buttons: true, // inline buttons
  copy: 256, // copy_text buttons
  sendLimit: { kind: "rate", perChatPerSecond: 1 },
  menu: { scope: "per_chat", maxItems: 100, row: "reply_keyboard" },
  // Rich messages take up to 32768, but plain text, their fallback, 4096: one limit, so a message
  // the renderer cut to fit never needs cutting again.
  maxTextLength: 4096,
  maxFileBytes: { image: 10 * 2 ** 20, file: 50 * 2 ** 20 }, // sendPhoto and sendDocument, uploaded
  // Rich messages (Bot API 10.1) read $formula$, ||spoiler||, ==mark== and HTML tags, and swallow
  // Vec<T> without a word (scripts/probes/telegram/rich.ts).
  markdown: { extensions: ["html", "math", "spoiler", "mark"] },
};

/** Feishu's capability table; editEvery is durations.feishuEdit. */
export const feishuCapabilities = (editEvery: number): Capabilities => ({
  progress: "edit",
  editEvery,
  buttons: true, // a card's callback buttons; no copy button
  sendLimit: { kind: "rate", perChatPerSecond: 5 },
  menu: { scope: "global", maxItems: 100 },
  maxTextLength: 4000,
  maxFileBytes: { image: 10 * 2 ** 20, file: 30 * 2 ** 20 },
  markdown: { extensions: ["html", "emoji"], links: "http" },
});

export const PLATFORMS: { [P in Platform]: PlatformDef & (P extends Made ? { bot: BotDef } : unknown) } = {
  qq: {
    label: "QQ",
    capabilities: () => QQ_CAPABILITIES,
    bot: { needed: ["appId", "secret"], optional: ["owner"], how: "用手机 QQ 扫码", another: "扫码后点“创建新机器人”" },
  },
  telegram: {
    label: "Telegram",
    capabilities: () => TELEGRAM_CAPABILITIES,
    bot: { needed: ["token"], optional: [], how: "粘贴 @BotFather 给的 token，不回显", apiRoot: "别的 Telegram Bot API 服务器", another: "向 @BotFather 发 /newbot" },
  },
  feishu: {
    label: "飞书",
    capabilities: (_, d) => feishuCapabilities(d.feishuEdit),
    bot: {
      needed: ["appId", "secret"],
      optional: ["owner"],
      how: "用飞书扫码，扫码的账号就是你，不用配对；--paste 改为粘贴 App ID 和密钥，密钥不回显",
      apiRoot: "飞书开放平台",
      paste: true,
      another: "扫码时选新建应用",
    },
  },
  fake: { label: "假 IM", capabilities: fakeCapabilities },
};

/** The platforms rh bot makes a bot on, with how. */
export const MADE = Object.fromEntries(Object.entries(PLATFORMS).flatMap(([p, def]) => ("bot" in def ? [[p, def.bot]] : []))) as Record<Made, BotDef>;

/** A [bots.<name>] table with platform = "fake" picks its capability table with like = one of the
 *  others. perChatPerSecond, the fake's own key, swaps the table's send limit for that rate, so tests
 *  need not wait out Telegram's one request a second. buttons = "false", its own too, takes the
 *  buttons away, so lists and asks go numbered as they do when there are too many choices for buttons.
 *  copy, its own too, is the longest text its copy buttons take. markdown = "false", its own too, has
 *  it send plain text only. */
function fakeCapabilities(bot: BotConfig, durations: Durations): Capabilities {
  const like = bot.like as Platform | undefined;
  if (!like || like === "fake" || !Object.hasOwn(PLATFORMS, like)) {
    const likes = Object.keys(MADE).map((p) => `"${p}"`);
    throw new Error(`config: a fake bot needs like = ${likes.slice(0, -1).join(", ")} or ${likes.at(-1)}`);
  }
  let caps = PLATFORMS[like].capabilities(bot, durations);
  if (bot.buttons === "false") caps = { ...caps, buttons: false };
  if (bot.copy) caps = { ...caps, copy: Number(bot.copy) };
  if (bot.markdown === "false") caps = { ...caps, markdown: null };
  return bot.perChatPerSecond ? { ...caps, sendLimit: { kind: "rate", perChatPerSecond: Number(bot.perChatPerSecond) } } : caps;
}

/** Words as a Chinese list, the last two joined by and: qq、telegram 或 feishu; a space between a
 *  Latin word and Chinese, none between Chinese and Chinese (docs/im-style.md): Telegram 和飞书. */
export function series(words: string[], and: string): string {
  const last = words.at(-1) ?? "";
  if (words.length < 2) return last;
  const head = words.slice(0, -1).join("、");
  return `${head}${/[A-Za-z]$/.test(head) ? " " : ""}${and}${/^[A-Za-z]/.test(last) ? " " : ""}${last}`;
}

/** A label among Chinese words, with a space on a side that is Latin: 扫码的 QQ 账号, 扫码的飞书账号. */
export const amid = (label: string): string => `${/^[A-Za-z]/.test(label) ? " " : ""}${label}${/[A-Za-z]$/.test(label) ? " " : ""}`;
