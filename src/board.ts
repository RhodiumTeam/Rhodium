// The board (product §7, architecture §11). HTTP on [board] bind, 127.0.0.1 by default: what brings
// it to your phone, and who checks it is you, is yours to choose (ADR-0013). By default tailscale serve
// brings your tailnet in and says who asks in Tailscale-User-Login, and only your login gets in. It serves
// the slots by workspace in product §4's four groups, the event table as a stream that keeps them
// live (architecture §7.2), and the page showing both, which goes on a phone's home screen. A slot's
// page has its transcript, read from the agent's own file (architecture §7.7); the topology view, the
// bots and chats with where each goes (spec web-topology). The page, web/, is at
// / (architecture §2), and imports the types below for what each path answers. What the page writes
// goes to the main loop, from that page alone (spec web-write). A slot in the terminal shows its Herdr
// pane, which the board passes on between the page's WebSocket and Herdr (architecture §10.4).
import type { Server, ServerWebSocket } from "bun";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { AGENTS } from "./agents";
import { askCard, askText, type AskCard, type AskPrompt } from "./asks";
import { avatarDir } from "./avatars";
import { frameUuid } from "./claude";
import { log } from "./daemon";
import { COMMON, type AgentEvent, type AgentKind, type BoardAct, type Platform } from "./contracts";
import { owners, type BotConfig, type Config } from "./config";
import { call, sessionSocket } from "./herdr";
import { holderPaths } from "./holder";
import { imageType, mediaLine, saveMedia, withoutMedia } from "./media";
import { moment } from "./panels";
import { agentCommands } from "./commands";
import { askGone, contactOf, resumeWaits, settingsOf, slotState, STATE, target, WEB_PAUSED, WEB_QUEUE, workspaceName, type Payload, type RhReply } from "./router";
import { namesOf, type Ask, type Bot, type Chat, type Conversation, type Event, type Outbound, type Slot, type Store, type Tx } from "./store";
import { PLATFORMS } from "./platforms";
import { withoutSource } from "./prompt";
import { describe, fullText, lastSaid, messagePage, transcriptFile, type Block as Read, type Message } from "./transcript";

/** The page and its files as Vite built them: embedded in the built binary, and in web/dist when
 *  run from source. */
const WEB = Bun.main.startsWith("/$bunfs/") ? join(import.meta.dir, "web") : join(import.meta.dir, "../web/dist");

export type Group = "needsYou" | "running" | "done" | "idle";

/** A slot on the board. parent: the slot that spawned it (story 97). last: the last thing you or its
 *  agent said in its current conversation, on one line, and when, with where a user message came from
 *  (lastSaid). bots: the bots whose private chat with you, or the main chat, goes here now, in
 *  BoardData's order (spec web-maximize "Bot 头像"). terminal: the pane its chat shows in its place, in
 *  the terminal with Herdr not restarting, as SlotData says it; else null. mode: headless or in the
 *  terminal, for the row's menu (spec web-write "列表行的菜单"). activeAt: when it was last active,
 *  which the list goes by (product §7), 0 for never; pinnedAt: when you pinned it, null for not. */
export type Card = {
  id: string;
  ref: string;
  name: string;
  parent: string | null;
  agent: AgentKind | null;
  state: string;
  lifetime: Slot["lifetime"];
  turnEndedAt: number | null;
  archivedAt: number | null;
  last: (Message & { at: number | null; source?: string }) | null;
  bots: string[];
  terminal: string | null;
  mode: Slot["mode"];
  activeAt: number;
  pinnedAt: number | null;
};
/** GET /api/board. bots: as /api/topology has them. */
export type BoardData = {
  workspaces: { name: string; dir: string; groups: Record<Group, Card[]>; archived: Card[] }[];
  bots: Pick<TopologyData["bots"][number], "id" | "name" | "platform" | "avatar">[];
};

/** How long a slot whose turn ended counts as done (product §7). */
const DONE = 24 * 3_600_000;

/** Product §4's groups. resuming: crashed, it is resumed once there is room under the running limit.
 *  One that failed to switch back from the terminal waits for you. */
function groupOf(s: Slot, asked: boolean, resuming: boolean, now: number): Group {
  if (asked || s.state === "waiting" || (s.state === "crashed" && !resuming) || slotState(s) === "没能切回无头") return "needsYou";
  if (s.mode === "tui" || resuming || s.state === "starting" || s.state === "running" || s.state === "rate_limited") return "running";
  if (s.turnEndedAt !== null && now - s.turnEndedAt < DONE) return "done";
  return "idle";
}

/** The slot's state as the board shows it (product §4, §7): as rh ls has it, plus when one waiting for
 *  quota carries on, that a crashed one waits for room to resume, and the pane of one in the terminal. */
function stateOf(s: Slot, now: number, resuming = false): string {
  const state = slotState(s);
  if (state === "TUI 模式") return `TUI 模式（pane ${s.herdrPane}）`;
  if (state === STATE.rate_limited && s.resumeAt !== null) return `等额度，预计 ${moment(s.resumeAt, now)} 恢复`;
  return resuming && state === STATE.crashed ? "崩溃，有空位后自动恢复" : state;
}

/** What each read found in each transcript, by the read's name and the file, and the size and time
 *  of change the file had then. */
const reads = new Map<string, { stamp: string; value: unknown }>();

/** What read finds in file, read again only once the file changes: the board asks on every refresh.
 *  With when the file last changed. Throws for a file that cannot be read. */
async function readOnce<T>(name: string, file: string, read: (file: string) => Promise<T>): Promise<{ value: T; mtime: number }> {
  const { size, mtimeMs } = await stat(file);
  const stamp = `${size} ${mtimeMs}`;
  const key = `${name} ${file}`;
  const seen = reads.get(key);
  if (seen?.stamp === stamp) return { value: seen.value as T, mtime: mtimeMs };
  const value = await read(file);
  reads.set(key, { stamp, value });
  return { value, mtime: mtimeMs };
}

/** What lastSaid finds in file. null for no file, or one that cannot be read, which only loses the line. */
async function lastIn(file: string | null): Promise<Card["last"]> {
  if (!file) return null;
  return (await readOnce("last", file, lastSaid).catch(() => null))?.value ?? null;
}

/** How the board puts each slot (product §4): its state in words, and its group. */
function statusOf(tx: Tx, now: number): (s: Slot) => { state: string; group: Group } {
  const asks = tx.find("ask", { status: "open" });
  const resumes = tx.find("agentInput", { status: "queued", source: "crash_resume" }).filter(resumeWaits);
  return (s) => {
    // Once let through, the slot is starting.
    const resuming = s.state === "crashed" && resumes.some((i) => i.conversation === s.conversation);
    return { state: stateOf(s, now, resuming), group: groupOf(s, asks.some((a) => a.slot === s.id), resuming, now) };
  };
}

/** What GET /api/board answers: each workspace's slots in the four groups; archived ones apart. */
async function board(store: Store, cfg: Config, now: number): Promise<BoardData> {
  const { workspaces, slots, conversations, status } = store.tx((tx) => ({
    workspaces: tx.find("workspace", {}),
    slots: tx.find("slot", {}),
    conversations: tx.find("conversation", {}),
    status: statusOf(tx, now),
  }));
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const ref = (s: Slot) => `${workspaces.find((w) => w.id === s.workspace)?.name ?? "?"}/${s.name}`;
  const last = new Map(
    await Promise.all(
      slots.map(async (s) => {
        const c = conversations.find((c) => c.id === s.conversation);
        return [s.id, c?.sessionId ? await lastIn(await transcriptFile(s.dir, c.agent, c.sessionId)) : null] as const;
      }),
    ),
  );
  // Where your private chats and the main chat go: not a stranger's.
  const topo = topologyRows(store, cfg, now);
  const yours = new Map(topo.chats.filter((c) => c.yours || c.main).map((c) => [c.id, c.bot]));
  const landed = (slot: string) => {
    const bots = new Set(topo.bindings.filter((b) => b.slot === slot).map((b) => yours.get(b.chat)));
    return topo.bots.filter((b) => bots.has(b.id)).map((b) => b.id);
  };
  return {
    bots: await Promise.all(topo.bots.map(async ({ id, name, platform }) => ({ id, name, platform, avatar: await avatarOf(cfg, id) }))),
    workspaces: workspaces.sort(byName).map((w) => {
      const groups: Record<Group, Card[]> = { needsYou: [], running: [], done: [], idle: [] };
      const archived: Card[] = [];
      for (const s of slots.filter((s) => s.workspace === w.id).sort(byName)) {
        const { state, group } = status(s);
        const parent = slots.find((p) => p.id === s.parent);
        const card: Card = {
          id: s.id,
          ref: ref(s),
          name: s.name,
          parent: parent ? ref(parent) : null,
          agent: conversations.find((c) => c.id === s.conversation)?.agent ?? null,
          state,
          lifetime: s.lifetime,
          turnEndedAt: s.turnEndedAt,
          archivedAt: s.archivedAt,
          last: last.get(s.id) ?? null,
          bots: landed(s.id),
          terminal: s.mode === "tui" && s.herdrLostAt === null ? s.herdrPane : null,
          mode: s.mode,
          // With no turn running, its turn's end and the last thing said too: in the terminal, now or since
          // its last turn, no turn is told to start or end, and before #506 none was kept. Not mid-turn.
          activeAt: Math.max(s.activeAt ?? 0, ...(s.mode === "tui" || s.turnStartedAt === null ? [s.turnEndedAt ?? 0, last.get(s.id)?.at ?? 0] : [])),
          pinnedAt: s.pinnedAt,
        };
        if (s.archivedAt !== null) archived.push(card);
        else groups[group].push(card);
      }
      return { name: w.name, dir: w.dir, groups, archived };
    }),
  };
}

/** GET /api/dirs (spec web-write "目录选择器"). path: the folder, by its real path, ~/… under HOME; up:
 *  its parent, null at /. dirs: the names of its folders, links to one too, hidden ones last, at most
 *  DIRS; more: how many past those. files: its first 8 files' names; moreFiles: how many past those.
 *  branch: the git branch it is on, if on one. workspace: the one it is the default dir of, else the
 *  name one made for it gets (fresh). slots: how many slots not archived are in it. error: why it
 *  could not be listed. */
export type DirsData = { path: string; up: string | null; dirs: string[]; more: number; files: string[]; moreFiles: number; branch?: string; workspace: string; fresh: boolean; slots: number; error?: string };

const DIRS = 500;
const DIR_ERRORS: Record<string, string> = { ENOENT: "没有这个目录", EACCES: "没有权限读这个目录", EPERM: "没有权限读这个目录", ENOTDIR: "不是目录" };

/** What GET /api/dirs answers for path: ~/…, absolute, or empty for ~, as rhodium's HOME has it. Reads
 *  names alone, anywhere up to /: the terminal and the agents reach all of it anyway (architecture §11). */
async function dirs(store: Store, path: string): Promise<DirsData> {
  const home = process.env.HOME || homedir();
  const tilde = (p: string) => (p === home ? "~" : p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);
  const asked = resolve(home, path.replace(/^~(?=\/|$)/, home));
  let real = asked;
  let error: string | undefined;
  const folders: string[] = [];
  const files: string[] = [];
  try {
    real = await realpath(asked);
    // ponytail: reads every entry, about 1 s for a million; opendir with a cap if that ever matters.
    const entries = await readdir(real, { withFileTypes: true });
    // A link is what it leads to; a broken one, nothing.
    const isDir = await Promise.all(entries.map(async (e) => (e.isSymbolicLink() ? ((await stat(join(real, e.name)).catch(() => null))?.isDirectory() ?? null) : e.isDirectory())));
    entries.forEach((e, i) => isDir[i] !== null && (isDir[i] ? folders : files).push(e.name));
  } catch (e) {
    error = DIR_ERRORS[(e as NodeJS.ErrnoException).code ?? ""] ?? (e as Error).message;
  }
  const order = (a: string, b: string) => Number(a.startsWith(".")) - Number(b.startsWith(".")) || a.localeCompare(b);
  folders.sort(order);
  files.sort(order);
  const { workspaces, slots } = store.tx((tx) => ({ workspaces: tx.find("workspace", {}), slots: tx.find("slot", {}).filter((s) => s.archivedAt === null) }));
  // A workspace's or a slot's dir is where it leads through a link: the page asks again by that.
  const reals = new Map(await Promise.all([...new Set([...workspaces, ...slots].map((x) => x.dir))].map(async (d) => [d, await realpath(d).catch(() => d)] as const)));
  const here = (dir: string) => reals.get(dir) === real;
  const had = workspaces.find((w) => here(w.dir));
  return {
    path: tilde(real),
    up: real === "/" ? null : tilde(dirname(real)),
    dirs: folders.slice(0, DIRS),
    more: Math.max(0, folders.length - DIRS),
    files: files.slice(0, 8),
    moreFiles: Math.max(0, files.length - 8),
    ...(!error && { branch: await branchOf(real) }),
    workspace: had?.name ?? workspaceName(workspaces, real),
    fresh: !had,
    slots: slots.filter((s) => here(s.dir)).length,
    ...(error && { error }),
  };
}

/** The branch the work tree holding dir is on, by its HEAD, as git has it, with no git run: the first
 *  .git up from dir, a folder, or a worktree's file naming its own. None when detached, or in none. */
async function branchOf(dir: string): Promise<string | undefined> {
  for (let d = dir; ; d = dirname(d)) {
    const git = join(d, ".git");
    const found = await stat(git).catch(() => null);
    if (found) {
      const at = found.isDirectory() ? git : resolve(d, /^gitdir: (.+)$/m.exec(await readFile(git, "utf8").catch(() => ""))?.[1]?.trim() ?? "");
      return /^ref: refs\/heads\/(.+)$/m.exec(await readFile(join(at, "HEAD"), "utf8").catch(() => ""))?.[1]?.trim();
    }
    if (d === "/") return undefined;
  }
}

/** GET /api/topology (spec web-topology): the bots with your chats, where each chat goes, and the
 *  workspaces and slots. By Rhodium's ids only: no token, and no platform's user or chat id. */
export type TopologyData = {
  /** name: its label, else its name in the config. main: the main chat's. conn: as the bot row has it.
   *  target: the slot its chats go to by default. avatar: where the page gets its picture; null for none. */
  bots: { id: string; name: string; platform: Platform; main: boolean; conn: Bot["connState"]; target: string | null; avatar: string | null }[];
  /** Your private chat with each bot, a chat that picked a slot of its own, and the main chat; not a
   *  stranger's. kind: "private" for each, a stranger's too, as v1 has private chats only (#291); groups
   *  will go by the kind the platform gives. yours: your private chat, not a stranger's or a group's.
   *  name: yours on the platform, or the group's; null where it gives none, as for a stranger. verbose:
   *  its tool lines in full (/rh_verbose). */
  chats: { id: string; bot: string; kind: "private" | "group"; yours: boolean; name: string | null; main: boolean; avatar: string | null; verbose: boolean }[];
  /** Where each chat's messages go now, as routing has it. use: the chat picked it (/rh_use, rh use);
   *  else it follows its bot's default. */
  bindings: { chat: string; slot: string; use: boolean }[];
  workspaces: { id: string; name: string }[];
  /** phase: the slot's state as stored; state and group: as /api/board has them. contact: its contact chat. */
  slots: {
    id: string;
    ref: string;
    name: string;
    workspace: string;
    parent: string | null;
    agent: AgentKind | null;
    mode: Slot["mode"];
    phase: Slot["state"];
    state: string;
    group: Group;
    lifetime: Slot["lifetime"];
    archived: boolean;
    contact: string | null;
  }[];
};

/** Where the page gets a bot's or chat's kept avatar: its address changes with the picture, so the
 *  browser keeps each for good. null for none. */
async function avatarOf(cfg: Config, id: string): Promise<string | null> {
  const found = await readOnce("avatar", join(avatarDir(cfg), id), async (f) => Bun.hash(await Bun.file(f).bytes()).toString(36)).catch(() => null);
  return found && `api/avatar?id=${id}&v=${found.value}`;
}

/** Your name as kept for a chat (refreshAvatars); null for none. */
const nameOf = async (cfg: Config, id: string) => (await readOnce("name", join(avatarDir(cfg), `${id}.name`), (f) => Bun.file(f).text()).catch(() => null))?.value ?? null;

async function topology(store: Store, cfg: Config, now: number): Promise<TopologyData> {
  const data = topologyRows(store, cfg, now);
  await Promise.all([
    ...data.bots.map(async (b) => void (b.avatar = await avatarOf(cfg, b.id))),
    ...data.chats.map(async (c) => void Object.assign(c, { avatar: await avatarOf(cfg, c.id), name: await nameOf(cfg, c.id) })),
  ]);
  return data;
}

/** The topology as the state tables have it, with no avatars or names yet. */
function topologyRows(store: Store, cfg: Config, now: number): TopologyData {
  return store.tx((tx) => {
    const state = { workspaces: tx.find("workspace", {}), slots: tx.find("slot", {}), conversations: tx.find("conversation", {}), bots: tx.find("bot", {}), chats: tx.find("chat", {}) };
    const status = statusOf(tx, now);
    const bots = state.bots.filter((b) => Object.hasOwn(cfg.bots, b.name)).sort((a, b) => a.name.localeCompare(b.name));
    const main = cfg.mainChat;
    const isMain = (b: Bot, c: Chat) => b.name === main?.bot && c.platformChatId === main.chat;
    const chats = state.chats.flatMap((c) => {
      const b = bots.find((b) => b.id === c.bot);
      return b && (owners(b, cfg).includes(c.platformChatId) || c.target !== null || isMain(b, c)) ? [{ c, b }] : [];
    });
    const ws = new Map(state.workspaces.map((w) => [w.id, w.name]));
    return {
      bots: bots.map((b) => ({
        id: b.id,
        name: cfg.bots[b.name]!.label ?? b.name,
        platform: b.platform,
        main: b.name === main?.bot,
        conn: b.connState,
        target: target(state, b, undefined, { config: cfg })?.id ?? null,
        avatar: null,
      })),
      chats: chats.map(({ c, b }) => ({ id: c.id, bot: b.id, kind: "private", yours: owners(b, cfg).includes(c.platformChatId), name: null, main: isMain(b, c), avatar: null, verbose: verboseIn(c, cfg.bots[b.name]!, cfg) })),
      bindings: chats.flatMap(({ c, b }) => {
        const s = target(state, b, c, { config: cfg });
        return s ? [{ chat: c.id, slot: s.id, use: c.target !== null }] : [];
      }),
      workspaces: state.workspaces.map((w) => ({ id: w.id, name: w.name })).sort((a, b) => a.name.localeCompare(b.name)),
      slots: state.slots.map((s) => ({
        id: s.id,
        ref: `${ws.get(s.workspace) ?? "?"}/${s.name}`,
        name: s.name,
        workspace: s.workspace,
        parent: s.parent,
        agent: state.conversations.find((c) => c.id === s.conversation)?.agent ?? null,
        mode: s.mode,
        phase: s.state,
        ...status(s),
        lifetime: s.lifetime,
        archived: s.archivedAt !== null,
        contact: contactOf(state, cfg, s),
      })),
    };
  });
}

/** Whether the chat writes tool lines in full: as /rh_verbose set it, else as the router has it by
 *  default, in full where the platform edits a message in place (Telegram's, Feishu's, and the fake
 *  IM's bots like them). */
const verboseIn = (c: Chat, bot: BotConfig, cfg: Config) => (c.verbose ?? +(PLATFORMS[bot.platform].capabilities(bot, cfg.durations).progress === "edit")) === 1;

/** A count from the query string: a whole number from 0 up, or NaN. */
const count = (v: string | null) => (v !== null && /^\d{1,15}$/.test(v) ? Number(v) : NaN);

/** The slot's current conversation, or with conversation that one, and its transcript file, if it
 *  has them; undefined for no such slot or conversation. */
async function current(store: Store, slot: string, conversation?: string): Promise<{ conversation: string | null; file: string | null; dir: string } | undefined> {
  const found = store.tx((tx) => {
    if (conversation !== undefined) {
      const c = tx.get("conversation", conversation);
      const s = c && tx.get("slot", c.slot);
      return s && { slot: s, conv: c };
    }
    const s = tx.get("slot", slot);
    return s && { slot: s, conv: s.conversation ? tx.get("conversation", s.conversation) : null };
  });
  if (!found) return undefined;
  const { slot: s, conv } = found;
  // ponytail: looks in the slot's directory now; a conversation begun before rh set dir moved it is not found there.
  return { conversation: conv?.id ?? null, file: conv?.sessionId ? await transcriptFile(s.dir, conv.agent, conv.sessionId) : null, dir: s.dir };
}

/** Who your message came through (spec web-topology): the platform, the bot's name, the bot's avatar
 *  and the chat's, yours on that platform; the avatars null for none, as for a bot gone. bot null when
 *  the source line does not say which of the platform's bots. */
export type From = { platform: Platform; bot: string | null; botAvatar: string | null; avatar: string | null };
/** A message block (architecture §7.7); yours with from, null when its source line names no bot,
 *  as rh send's and reports', or when it has none, as what you type in the terminal. */
export type Block = Exclude<Read, { kind: "user" }> | (Extract<Read, { kind: "user" }> & { from: From | null });

// A source line naming a chat (router's chatName): the platform, the bot when it has several, which chat.
const THROUGH = new RegExp(`^(${Object.values(PLATFORMS).map((p) => p.label).join("|")})(?: Bot (.+) 的| ?)(私聊|聊天窗口)(?:，发送于 .*)?$`);

/** The bot and chat a source line names, as the bots are now (each by the name chats call it).
 *  Written when its platform had one bot, the line names none: the platform's only bot now, if it
 *  still has one. id null for a bot gone or one of several. null for a line naming no chat. */
export function saidThrough(source: string | null, bots: { id: string; name: string; platform: Platform }[]): { platform: Platform; bot: string | null; id: string | null; private: boolean } | null {
  const m = source === null ? null : THROUGH.exec(source);
  const platform = m && (Object.keys(PLATFORMS) as Platform[]).find((p) => PLATFORMS[p].label === m[1]);
  if (!m || !platform) return null;
  const mine = bots.filter((b) => b.platform === platform);
  const bot = m[2] !== undefined ? mine.find((b) => b.name === m[2]) : mine.length === 1 ? mine[0] : undefined;
  return { platform, bot: bot?.name ?? m[2] ?? null, id: bot?.id ?? null, private: m[3] === "私聊" };
}

/** The blocks of the conversation with from on yours. */
async function withFrom(store: Store, cfg: Config, conversation: string | null, blocks: Read[]): Promise<Block[]> {
  const { bots, chats, came } = store.tx((tx) => {
    // The conversation's inputs' traces by what the agents' records name them by (transcript's id).
    const sent = new Map((conversation ? tx.find("agentInput", { conversation }) : []).flatMap((i) => (i.trace ? [[i.id, i.trace], [frameUuid(i.id), i.trace]] : [])));
    // The chat each block came from, where its input was a message: that inbound's id is its trace.
    const came = blocks.map((b) => (b.kind === "user" && b.id !== undefined ? tx.get("inbound", sent.get(b.id) ?? "")?.chat : undefined));
    return { bots: tx.find("bot", {}).filter((b) => Object.hasOwn(cfg.bots, b.name)), chats: tx.find("chat", {}), came };
  });
  const named = bots.map((b) => ({ id: b.id, name: cfg.bots[b.name]!.label ?? b.name, platform: b.platform }));
  return Promise.all(
    blocks.map(async (b, n): Promise<Block> => {
      if (b.kind !== "user") return b;
      const said = saidThrough(b.source, named);
      if (!said) return { ...b, from: null };
      const chat = chats.find((c) => c.id === came[n]);
      const bot = bots.find((x) => x.id === (chat?.bot ?? said.id));
      // Without its chat, the source line names no account: with several of yours, whose chat it was is not known, so none's avatar.
      const mine = bot && said.private ? chats.filter((c) => c.bot === bot.id && owners(bot, cfg).includes(c.platformChatId)) : [];
      const yours = bot && (chat ?? (mine.length === 1 ? mine[0] : undefined));
      const name = named.find((x) => x.id === bot?.id)?.name ?? said.bot;
      return { ...b, from: { platform: said.platform, bot: name, botAvatar: bot ? await avatarOf(cfg, bot.id) : null, avatar: yours ? await avatarOf(cfg, yours.id) : null } };
    }),
  );
}

/** GET /api/messages. */
export type MessagesData = { conversation: string | null; blocks: Block[]; start: number; end: number };

/** GET /api/messages?slot=<id>: a page of the slot's current conversation as message blocks
 *  (architecture §7.7): the latest, the one before before, or what was written after after. A page's
 *  start and end are where the next page back and forward begin; before and after must be 0 or such
 *  a start or end. With conversation=<id>, of that conversation instead, whichever slot. */
async function messages(store: Store, cfg: Config, q: URLSearchParams): Promise<Response> {
  const after = q.get("after") === null ? null : count(q.get("after"));
  const before = q.get("before") === null ? Infinity : count(q.get("before"));
  if (Number.isNaN(after) || Number.isNaN(before)) return new Response("before 或 after 不对。\n", { status: 400 });
  const found = await current(store, q.get("slot") ?? "", q.get("conversation") ?? undefined);
  if (!found) return new Response(q.has("conversation") ? "没有这段对话。\n" : "没有这个槽位。\n", { status: 404 });
  const { conversation, file, dir } = found;
  const page = !file ? { blocks: [], start: 0, end: 0 } : after !== null ? await messagePage(file, after, "forward", dir) : await messagePage(file, before, "backward", dir);
  const data: MessagesData = { conversation, ...page, blocks: await withFrom(store, cfg, conversation, page.blocks) };
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}

/** GET /api/full. */
export type FullData = { text: string };

/** GET /api/full?conversation=<id>&at=<block's at>: the whole of a block a page gave only the start
 *  of. By conversation, not slot: a page of one the slot has left still has it. */
async function full(store: Store, q: URLSearchParams): Promise<Response> {
  const at = q.get("at") ?? "";
  if (!/^\d{1,15}\.\d{1,6}$/.test(at)) return new Response("at 不对。\n", { status: 400 });
  const file = (await current(store, "", q.get("conversation") ?? ""))?.file;
  const text = file && (await fullText(file, at));
  if (typeof text !== "string") return new Response("没有这一块。\n", { status: 404 });
  const data: FullData = { text };
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}

const PAGE_EVENTS = 50; // events on a page of a slot's 详情

/** One of a slot's events, with your message's text and why it never reached the agent, if it did not,
 *  an ask's status, timeout for one the timeout answered, a state by name, and what was sent for its trace. */
export type SlotEvent = Omit<Event, "machine" | "slot" | "trace"> & {
  text?: string | null;
  why?: string;
  status?: Ask["status"] | "timeout" | null;
  sends?: { at: number; status: Outbound["status"]; text: string }[];
};

/** GET /api/slot-events?id=<id>: a page of the slot's events, oldest first: the latest, or those before
 *  the seq before (spec web-topology). What was sent for a trace comes with the slot's first event of
 *  it, say your message: the reply, an ask's push, a send whose outcome is unknown (architecture
 *  §7.4). The first in the slot, not on this page, so it is there once however the pages fall. */
function slotEvents(store: Store, q: URLSearchParams): Response {
  const before = q.get("before") === null ? Number.MAX_SAFE_INTEGER : count(q.get("before"));
  if (Number.isNaN(before)) return new Response("before 不对。\n", { status: 400 });
  const id = q.get("id") ?? "";
  const events = store.slotEvents(id, PAGE_EVENTS, before).reverse();
  const traced = new Map([...new Set(events.flatMap((e) => e.trace ?? []))].map((t) => [t, store.traced(t).filter((e) => e.slot === id)]));
  const data = store.tx((tx) => {
    if (!tx.get("slot", id)) return null;
    // Inputs are on record from the oldest one kept: a message from before it has no record either way.
    // ponytail: reads every input row once a page; a min(id) query if that table grows large.
    let first: string | undefined;
    const recorded = (trace: string) => (first ??= tx.find("agentInput", {})[0]?.id ?? "") <= trace;
    return events.map(({ machine, slot, trace, ...e }) => {
      const r: SlotEvent = e;
      const data = e.data as Record<string, unknown> | null;
      // Only your text is kept, and only its start (architecture §8.3): from IM on its inbound record;
      // from the board, which has none, on the event.
      if ((e.type === "im_routed" || e.type === "board_routed") && trace) {
        r.text = e.type === "im_routed" ? (tx.get("inbound", trace)?.text ?? null) : typeof data?.text === "string" ? data.text : null;
        // Not handed to the agent: where it was routed says why; given back while it waited, what gave it back.
        // With no record of it either way, nothing.
        const back = traced.get(trace)!.find((t) => t.type === "input_returned")?.data as { why?: string } | undefined;
        const why = back?.why ?? (tx.find("agentInput", { trace, source: "human" }).length || !recorded(trace) ? undefined : data?.reason);
        if (typeof why === "string") r.why = why;
      }
      if (e.type === "ask" && typeof data?.ask === "string") {
        const a = tx.get("ask", data.ask);
        r.status = a?.answeredBy === "timeout" ? "timeout" : (a?.status ?? null);
      }
      if (e.type === "slot_state") r.text = data?.mode === "tui" ? "TUI 模式" : STATE[data?.state as Slot["state"]];
      if (trace && traced.get(trace)![0]?.seq === e.seq) {
        const sends = tx.find("outbound", { trace }).map((o) => ({ at: o.createdAt, status: o.status, text: o.text ?? sentText(o.payload) }));
        if (sends.length) r.sends = sends;
      }
      return r;
    });
  });
  if (!data) return new Response("没有这个槽位。\n", { status: 404 });
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}

/** GET /api/slot. */
export type SlotData = {
  id: string;
  ref: string;
  dir: string;
  agent: AgentKind | null;
  mode: Slot["mode"];
  /** The state as stored; state: in words. */
  phase: Slot["state"];
  state: string;
  archivedAt: number | null;
  lifetime: Slot["lifetime"];
  /** Its rh set items (settingsOf). */
  settings: ReturnType<typeof settingsOf>;
  /** What /model set, by the name Claude's last handshake gave it; null: the agent's default. */
  model: string | null;
  /** What /effort set; null: the agent's default. */
  effort: string | null;
  /** /ultracode set on (#276). */
  ultracode: boolean;
  /** In the terminal: the Herdr pane its agent runs in. */
  pane: string | null;
  /** In the terminal, while Herdr restarts (architecture §10.2). */
  herdrLost: boolean;
  /** The asks waiting on you, oldest first, in the words IM asks them in, without buttons; card: as
   *  its card on the board shows it. */
  asks: { id: string; kind: Ask["kind"]; text: string; card: AskCard; deadline: number | null }[];
  /** The asks answered lately, for a page that showed one to say where (story 293). */
  gone: { id: string; why: string }[];
  /** Your messages from the board still waiting for the agent, oldest first (spec web-write "待发队列"):
   *  each by the id of the request it came in, its words, how many it carries attached, and why it
   *  waits: in the board's queue, paused there, or held by Rhodium for an interrupt, the quota or a stop. */
  queue: { id: string; text: string; files: number; reason: Waits }[];
  process: Process | null;
  /** The conversations it has had, newest first. */
  timeline: Episode[];
  /** What its command palette offers (spec web-write "命令面板"). */
  commands: Command[];
};

/** A command in a slot's palette, as IM has it: its name, its arguments and what it does. kind: what
 *  picking it does: run it, or show what it offers to pick from. */
export type Command = { name: string; usage?: string; summary: string; kind: "run" | "pick" };

/** The commands of a slot with the agent: its / menu's but /rh_help, each a button on the board (#289).
 *  One with a list to pick from is pick. */
export const commandsFor = (agent: AgentKind | null): Command[] =>
  agentCommands(agent).map((c) => ({
    name: c.name,
    ...(c.usage && { usage: c.usage }),
    summary: c.summary,
    kind: c.list ? "pick" : "run",
  }));

export type Waits = "web_queue" | "web_paused" | "after_interrupt" | "after_quota" | "stopping";
/** Why the board's messages in the queue wait, as /api/slot says (SlotData). */
const WAITS: Record<string, Waits> = { [WEB_QUEUE]: WEB_QUEUE, [WEB_PAUSED]: WEB_PAUSED, after_interrupt: "after_interrupt", after_quota: "after_quota" };

/** The slot's queue on the board (SlotData): your messages that came in no chat, as none has them on
 *  record. One with no queue reason waits only while the agent stops, for its next start (router's toAgent). */
function queueOf(tx: Tx, s: Slot): SlotData["queue"] {
  if (!s.conversation) return [];
  const stopping = s.state !== "off" && s.state !== "crashed" && (tx.find("holder", { conversation: s.conversation })[0]?.stopRequested ?? 0) > 0;
  return tx.find("agentInput", { conversation: s.conversation, status: "queued", source: "human" }).flatMap((i) => {
    const reason = i.queueReason === null ? (stopping ? "stopping" : undefined) : WAITS[i.queueReason];
    if (!i.trace || !reason || tx.get("inbound", i.trace)) return [];
    return [{ id: i.trace, ...withoutMedia(withoutSource(i.body ?? "")), reason }];
  });
}

/** A conversation in a slot's timeline. short: the start of the agent's session id, as /resume and rh
 *  import show it; null before the agent has one. lastWrite: when its transcript last changed. title: as /resume calls it; null for
 *  none, as with no transcript or nothing said. current: the slot's now. */
export type Episode = { id: string; short: string | null; agent: AgentKind; startedAt: number; lastWrite: number | null; title: string | null; current: boolean };

/** The slot's timeline: its conversations, last active (written to, or started) first. */
async function timeline(slot: Slot, conversations: Conversation[]): Promise<Episode[]> {
  const episodes = await Promise.all(
    conversations.map(async (c) => {
      const file = c.sessionId ? await transcriptFile(slot.dir, c.agent, c.sessionId) : null;
      const found = file ? await readOnce("title", file, (f) => describe(f, c.agent, c.sessionId!)).catch(() => null) : null;
      return { id: c.id, short: c.sessionId?.slice(0, 8) ?? null, agent: c.agent, startedAt: c.startedAt, lastWrite: found?.mtime ?? null, title: found?.value.title || null, current: c.id === slot.conversation };
    }),
  );
  return episodes.sort((a, b) => (b.lastWrite ?? b.startedAt) - (a.lastWrite ?? a.startedAt));
}

/** How long an ask answered stays in a slot's gone, by its ask_answered event: past the next refresh
 *  of a page that showed it. Among the slot's last 20 events. */
const GONE_FOR = 10_000;

/** GET /api/slot?id=<id>: the slot (product §7) and its timeline; its events are on /api/slot-events.
 *  A headless slot also has its process. */
async function slotDetail(store: Store, cfg: Config, id: string): Promise<Response> {
  const detail = store.tx((tx) => {
    const s = tx.get("slot", id);
    if (!s) return null;
    const conv = s.conversation ? tx.get("conversation", s.conversation) : null;
    return {
      id: s.id,
      ref: `${tx.get("workspace", s.workspace)?.name ?? "?"}/${s.name}`,
      dir: s.dir,
      agent: conv?.agent ?? null,
      mode: s.mode,
      phase: s.state,
      state: stateOf(s, Date.now()),
      archivedAt: s.archivedAt,
      lifetime: s.lifetime,
      settings: settingsOf(s, cfg),
      // As /status names it (router's remembered); the default by the model it uses (story 407).
      model: conv && AGENTS[conv.agent].modelNames ? (namesOf(tx, conv.agent)[s.model ?? "default"] ?? s.model) : s.model,
      effort: s.effort,
      ultracode: s.ultracode === 1,
      pane: s.mode === "tui" ? s.herdrPane : null,
      herdrLost: s.herdrLostAt !== null,
      asks: tx.find("ask", { slot: s.id, status: "open" }).map((a) => {
        const p = JSON.parse(a.prompt!) as AskPrompt;
        return { id: a.id, kind: a.kind, text: askText(a.kind, p, ""), card: askCard(a.kind, p), deadline: a.deadline };
      }),
      gone: store.slotEvents(s.id, 20).flatMap((e) => {
        const { ask, by } = (e.data ?? {}) as { ask?: string; by?: string };
        if (e.type !== "ask_answered" || !ask || e.at < Date.now() - GONE_FOR) return [];
        return [{ id: ask, why: askGone({ bots: tx.find("bot", {}), chats: tx.find("chat", {}) }, { config: cfg }, by) }];
      }),
      queue: queueOf(tx, s),
      conversation: s.conversation,
      slot: s,
      conversations: tx.find("conversation", { slot: s.id }),
    };
  });
  if (!detail) return new Response("没有这个槽位。\n", { status: 404 });
  const { conversation, slot, conversations, ...view } = detail;
  const data: SlotData = { ...view, process: view.mode === "headless" ? await processOf(store, cfg, conversation) : null, timeline: await timeline(slot, conversations), commands: commandsFor(view.agent) };
  return Response.json(data, { headers: { "cache-control": "no-store" } });
}

type Process = NonNullable<Awaited<ReturnType<typeof processOf>>>;

const ERR_TAIL = 16 * 1024; // bytes from the end of err.log

/** A headless slot's holder as systemd has it, and the end of its agent's stderr (architecture §4.3,
 *  §12): whether the agent is thinking or its process is broken. null when it never had one. */
async function processOf(store: Store, cfg: Config, conversation: string | null) {
  const holder = conversation ? store.tx((tx) => tx.find("holder", { conversation })[0]) : undefined;
  if (!holder) return null;
  const show = Bun.spawn(["systemctl", "--user", "show", `${holder.unit}.service`, "-p", "ActiveState,SubState,MainPID,ExecMainStatus"], { stdout: "pipe", stderr: "ignore" });
  const props = Object.fromEntries((await new Response(show.stdout).text()).trim().split("\n").map((l) => l.split("=", 2)));
  // The agent's last words before it crashed often lack their newline. The cut line at the start goes.
  // ponytail: just after err.log rotates this shows little; read err.log.1 too if that hides things.
  const log = Bun.file(join(holderPaths(cfg, conversation!).dir, "err.log"));
  const lines = stripVTControlCharacters(await log.slice(Math.max(0, log.size - ERR_TAIL)).text()).split("\n");
  if (log.size > ERR_TAIL) lines.shift();
  if (lines.at(-1) === "") lines.pop();
  return {
    unit: holder.unit,
    activeState: props.ActiveState ?? "unknown",
    subState: props.SubState ?? "unknown",
    pid: Number(props.MainPID) || null,
    exitStatus: props.ExecMainStatus === undefined ? null : Number(props.ExecMainStatus),
    stderr: lines,
  };
}

const LOG_LINES = 200;

/** GET /api/rhodium: Rhodium itself (product §7): this run, each bot's connection, and its log in
 *  journald (architecture §12). No log when it does not run as its systemd service, as under rh dev. */
async function rhodium(store: Store, cfg: Config, startedAt: number) {
  const { rows, boot } = store.tx((tx) => ({ rows: tx.find("bot", {}), boot: tx.get("meta", "boot")?.value }));
  const bots = Object.entries(cfg.bots)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, b]) => ({ name, platform: b.platform, state: rows.find((r) => r.name === name)?.connState ?? null }));
  return { boot: Number(boot), pid: process.pid, startedAt, unit: cfg.unit || null, bots, logs: cfg.unit ? await journal(cfg.unit) : null };
}
/** GET /api/rhodium. */
export type RhodiumData = Awaited<ReturnType<typeof rhodium>>;

/** The unit's last lines in journald, oldest first. */
async function journal(unit: string): Promise<{ at: number; line: string }[]> {
  const argv = ["journalctl", "--user", "-u", `${unit}.service`, "-n", String(LOG_LINES), "-o", "json", "--output-fields=MESSAGE", "--no-pager"];
  const out = await new Response(Bun.spawn(argv, { stdout: "pipe", stderr: "ignore" }).stdout).text();
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const e = JSON.parse(l) as { __REALTIME_TIMESTAMP: string; MESSAGE: string | number[] | null };
      // journald gives a message that is not UTF-8 as its bytes.
      const line = Array.isArray(e.MESSAGE) ? Buffer.from(e.MESSAGE).toString() : (e.MESSAGE ?? "");
      return { at: Math.floor(Number(e.__REALTIME_TIMESTAMP) / 1000), line };
    });
}

/** The text of a message not sent yet, or whose send failed or may not have arrived. */
function sentText(payload: string | null): string {
  if (!payload) return "";
  const p = JSON.parse(payload) as Payload;
  return p.file ? [p.text, mediaLine(p.file)].filter(Boolean).join("\n") : p.text;
}

/** The image types avatars come in, by their first bytes. */
const IMAGES: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46], "image/gif"],
  [[0x52, 0x49, 0x46, 0x46], "image/webp"],
];

/** GET /api/avatar?id=<id>: a bot's or chat's kept avatar, by Rhodium's id alone; 404 for none. Its
 *  address in the data changes with the picture, so it is kept for good. */
async function avatar(store: Store, cfg: Config, id: string): Promise<Response> {
  const known = store.tx((tx) => tx.get("bot", id) ?? tx.get("chat", id));
  const bytes = known && (await Bun.file(join(avatarDir(cfg), id)).bytes().catch(() => null));
  if (!bytes) return new Response("没有头像。\n", { status: 404 });
  const type = IMAGES.find(([magic]) => magic.every((b, i) => bytes[i] === b))?.[1] ?? "application/octet-stream";
  return new Response(bytes, { headers: { "content-type": type, "cache-control": "private, max-age=31536000, immutable" } });
}

/** A file of the page, by its path; / is the page itself. Vite names the files under
 *  assets/ by their content, so the browser keeps those for good, and asks again for the rest. To a
 *  browser that takes br, one with a brotli built beside it (web/vite.config.ts) comes as that. The
 *  page goes in no other page's frame, to be clicked through unseen, and runs no script but its own
 *  files, say one in what an agent wrote (spec web-write), and WebAssembly, the web terminal's (ADR-0012). */
async function webFile(web: string, path: string, accepts: string): Promise<Response> {
  const name = join(web, path === "/" ? "index.html" : path);
  const file = Bun.file(name);
  if (await file.exists()) {
    const headers = new Headers({ "cache-control": path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache", "content-type": file.type });
    if (file.type.startsWith("text/html")) headers.set("content-security-policy", "frame-ancestors 'none'; script-src 'self' 'wasm-unsafe-eval'");
    // Not file.name: in the built binary that is not where the file is.
    const br = Bun.file(`${name}.br`);
    if (/\bbr\b/.test(accepts) && (await br.exists())) {
      headers.set("content-encoding", "br");
      return new Response(br, { headers });
    }
    return new Response(file, { headers });
  }
  if (path === "/") return new Response("看板的页面还没构建：先跑 bun run build:web。\n", { status: 503 });
  return new Response("没有这一页。\n", { status: 404 });
}

const LOOK = 500; // ms between looks at a followed transcript's size

/** What hears a headless agent write (the runner's writing): the board, once it is up. */
export type Hear = (conversation: string, e: Extract<AgentEvent, { type: "text_delta" | "item" | "exit" }>) => void;

/** Follows slots' transcripts for the event streams that ask (architecture §7.7): follow(slot, tell)
 *  tells grew each time the slot's current transcript grows, or the slot moves on to another, until
 *  the function it returns is called. A transcript is looked at only while a stream follows it. And
 *  hear tells the streams following the slot what its agent writes: delta, a piece of text, and said,
 *  once the message is whole; exit, its process ended. tell takes them as server-sent events. */
function transcripts(store: Store) {
  const followed = new Map<string, { streams: Set<(event: string) => void>; timer: Timer }>();
  const follow = (slot: string, tell: (event: string) => void): (() => void) => {
    let f = followed.get(slot);
    if (!f) {
      const streams = new Set<(event: string) => void>();
      let last: string | undefined;
      const look = async () => {
        const found = await current(store, slot);
        const now = found?.file ? `${found.file} ${Bun.file(found.file).size}` : "";
        const was = last;
        last = now;
        if (was !== undefined && now !== was) for (const t of streams) t("event: grew\ndata: {}\n\n");
      };
      // One that fails, say as the transcript moves, looks again next time.
      const tryLook = () => void look().catch(() => {});
      tryLook();
      followed.set(slot, (f = { streams, timer: setInterval(tryLook, LOOK) }));
      log("watching a transcript", { slot });
    }
    const { streams, timer } = f;
    streams.add(tell);
    return () => {
      if (!streams.delete(tell) || streams.size) return;
      clearInterval(timer);
      followed.delete(slot);
      log("stopped watching a transcript", { slot });
    };
  };
  const hear: Hear = (conversation, e) => {
    if (!followed.size) return;
    const f = followed.get(store.tx((tx) => tx.get("conversation", conversation)?.slot) ?? "");
    const event = e.type === "text_delta" ? `event: delta\ndata: ${JSON.stringify({ text: e.text })}\n\n` : `event: ${e.type === "item" ? "said" : "exit"}\ndata: {}\n\n`;
    for (const t of f?.streams ?? []) t(event);
  };
  return { follow, hear };
}

/** The event table from after seq on, as server-sent events: id is the seq, so a browser that
 *  reconnects sends Last-Event-ID and misses nothing. With slot, also what transcripts tells of its
 *  transcript and what its agent writes: with no id, as it is not in the event table. */
async function events(store: Store, req: Request, server: Server<Term>, follow: ReturnType<typeof transcripts>["follow"], web: string): Promise<Response> {
  server.timeout(req, 0); // Bun drops a connection quiet for durations.boardIdle
  const entry = await entryOf(web);
  const last = Number(req.headers.get("Last-Event-ID") ?? NaN);
  const after = Number.isSafeInteger(last) && last >= 0 ? last : store.lastSeq();
  let stop = () => {};
  const body = new ReadableStream<string>({
    start(c) {
      // First the page served now, which a page loaded from another build reloads for (architecture
      // §2); Bun sends the headers with the first bytes.
      c.enqueue(`event: page\ndata: ${JSON.stringify({ entry })}\n\n`);
      const unsubscribe = store.subscribe(after, ({ machine, ...e }) => c.enqueue(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`));
      const slot = new URL(req.url).searchParams.get("slot");
      const unfollow = slot ? follow(slot, (event) => c.enqueue(event)) : () => {};
      const ping = setInterval(() => c.enqueue(": ping\n\n"), 25_000); // and proxies keep it open
      stop = () => (unsubscribe(), unfollow(), clearInterval(ping));
      req.signal.addEventListener("abort", stop);
    },
    cancel: () => stop(),
  });
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
}

/** The script the page's HTML in web loads first, as it is written there, which names its build;
 *  null with none built. Read afresh each time: run from source, web/dist is built anew under it. */
async function entryOf(web: string): Promise<string | null> {
  const html = await Bun.file(join(web, "index.html")).text().catch(() => "");
  return /<script type="module"[^>]* src="([^"]+)"/.exec(html)?.[1] ?? null;
}

/** res gzipped, when it is text the browser takes gzip for and not already compressed. Not the event
 *  stream, whose events would wait to fill a block. */
async function gzipped(req: Request, res: Response): Promise<Response> {
  if (!/html|css|javascript|json/.test(res.headers.get("content-type") ?? "")) return res;
  res.headers.set("vary", "accept-encoding");
  if (res.headers.has("content-encoding") || !/\bgzip\b/.test(req.headers.get("accept-encoding") ?? "")) return res;
  res.headers.set("content-encoding", "gzip");
  // ponytail: compressed on each request, the page's script too; keep the gzipped files if it shows.
  return new Response(Bun.gzipSync(await res.bytes()), { status: res.status, headers: res.headers });
}

/** Does what the page asks, as the main loop answers it: by the page's id for it. */
export type Act = (id: string, act: BoardAct) => Promise<RhReply>;

/** Whether the request comes from the board's own page (spec web-write "只认看板自己的页面"): every
 *  host and port on the tailnet, or under your domain, is one site, agents' pages among them, so the
 *  same origin, as the browser says; one too old to say gives its Origin, whose host and port must be
 *  this one. Not its scheme: the proxy in front, tailscale serve say, takes https to this http. */
function ownPage(req: Request): boolean {
  const site = req.headers.get("Sec-Fetch-Site");
  if (site !== null) return site === "same-origin";
  const origin = URL.parse(req.headers.get("Origin") ?? "");
  return origin !== null && origin.host === new URL(req.url).host;
}

/** A request's id, the page's: the same when it sends one again. */
const ID = /^[\w-]{1,64}$/;
/** The most a write's body may be: JSON, or what you typed with what you attached (spec web-write
 *  "写请求"); the latter, as Telegram's bots take, is the server's, which answers 413 past it. */
const ACT_MAX = 1 << 20;
const SEND_MAX = 20 << 20;

/** The act in a write's body, with the page's id for it; null for a body that is not one. A message
 *  comes with nothing attached: only POST /api/send attaches, what it has kept itself. */
function actOf(body: unknown): { id: string; act: BoardAct } | null {
  const { id, act } = (body ?? {}) as { id?: unknown; act?: Record<string, unknown> };
  if (typeof id !== "string" || !ID.test(id) || typeof act !== "object" || act === null) return null;
  const text = (v: unknown) => typeof v === "string";
  if (act.kind === "common" && text(act.slot) && (COMMON as unknown[]).includes(act.name) && (act.args === undefined || text(act.args))) return { id, act: act as BoardAct };
  if (act.kind === "rh" && Array.isArray(act.argv) && act.argv.length > 0 && act.argv.every(text) && (act.sure === undefined || act.sure === true)) return { id, act: act as BoardAct };
  if (act.kind === "bind" && Array.isArray(act.changes) && act.changes.every(change) && (act.unarchive === undefined || text(act.unarchive))) return { id, act: act as BoardAct };
  if (act.kind === "answer" && text(act.ask) && text(act.text)) return { id, act: act as BoardAct };
  if (act.kind === "say" && text(act.slot) && text(act.text) && act.attachments === undefined) return { id, act: act as BoardAct };
  if (act.kind === "queued" && text(act.slot) && (act.op === "now" || act.op === "drop") && (act.input === undefined ? act.op === "now" : text(act.input))) return { id, act: act as BoardAct };
  if (act.kind === "verbose" && text(act.chat) && typeof act.on === "boolean") return { id, act: act as BoardAct };
  if (act.kind === "pin" && text(act.slot) && typeof act.on === "boolean") return { id, act: act as BoardAct };
  return null;
}

/** Whether c is a BindChange. */
function change(c: unknown): boolean {
  const { chat, bot, from, to } = (c ?? {}) as Record<string, unknown>;
  const slot = (v: unknown) => v === null || typeof v === "string";
  if (typeof chat === "string") {
    const f = (from ?? {}) as Record<string, unknown>;
    return typeof from === "object" && slot(f.slot) && typeof f.use === "boolean" && slot(to);
  }
  return typeof bot === "string" && slot(from) && typeof to === "string";
}

/** POST /api/act (spec web-write "写请求"): the act in its JSON body, done once by its id, from the
 *  board's own page alone; the answer is the main loop's, always 200. The status is for what is wrong
 *  with the request: 403 for where it came from, 405 its method, 400 its body. */
async function write(req: Request, act: Act): Promise<Response> {
  if (!ownPage(req)) return new Response("只认看板自己的页面发来的请求。\n", { status: 403 });
  if (req.method !== "POST") return new Response("只收 POST。\n", { status: 405, headers: { allow: "POST" } });
  // A page elsewhere cannot send JSON without the browser asking first, which the check above turns down.
  if (req.headers.get("content-type")?.split(";")[0]!.trim() !== "application/json") return new Response("请求体要是 JSON。\n", { status: 400 });
  const body = await req.bytes();
  if (body.length > ACT_MAX) return new Response("请求体太大。\n", { status: 413 });
  const found = actOf(await new Response(body).json().catch(() => null));
  if (!found) return new Response("请求体不对。\n", { status: 400 });
  // The page confirms first: one that skipped its own dialog by mistake ends no agent in your terminal.
  if (found.act.kind === "rh" && found.act.argv[0] === "release" && !found.act.sure) return new Response("收回终端要先确认。\n", { status: 400 });
  return Response.json(await act(found.id, found.act), { headers: { "cache-control": "no-store" } });
}

/** POST /api/send (spec web-write "写请求"): what you typed with what you attached, as multipart
 *  fields id, slot, text and a file each, from the board's own page alone, as /api/act. Each file is
 *  kept under media as IM's are (architecture §8.3), by its content, its name only a label; a picture
 *  the agent can be shown gets its type. Then the message goes as /api/act's say. */
async function sendWith(req: Request, act: Act, media: string): Promise<Response> {
  if (!ownPage(req)) return new Response("只认看板自己的页面发来的请求。\n", { status: 403 });
  if (req.method !== "POST") return new Response("只收 POST。\n", { status: 405, headers: { allow: "POST" } });
  const form = await req.formData().catch(() => null);
  const [id, slot, text] = ["id", "slot", "text"].map((k) => form?.get(k));
  const files = form?.getAll("file") ?? [];
  if (typeof id !== "string" || !ID.test(id) || typeof slot !== "string" || typeof text !== "string" || !files.every((f) => f instanceof File)) {
    return new Response("请求体不对。\n", { status: 400 });
  }
  let attachments: Extract<BoardAct, { kind: "say" }>["attachments"];
  try {
    attachments = await Promise.all(
      (files as File[]).map(async (f) => {
        const data = await f.bytes();
        const image = f.type.startsWith("image/");
        const mimeType = image ? imageType(data) : null;
        return { kind: image ? ("image" as const) : ("file" as const), name: f.name.replace(/\s+/g, " "), path: saveMedia(media, data), ...(mimeType && { mimeType }) };
      }),
    );
  } catch (err) {
    return Response.json({ ok: false, error: `附件没存下来：${err}` } satisfies RhReply);
  }
  return Response.json(await act(id, { kind: "say", slot, text, attachments }), { headers: { "cache-control": "no-store" } });
}

/** A page's web terminal (spec web-terminal): the slot, the size its address gives, the page it is on
 *  and whether it only resumes (resume=1: back in front, or connecting again); once open, the Herdr
 *  terminal session control it talks to, and once that lets go, its going. */
type Term = { slot: string; cols: number; rows: number; page: string; resume: boolean; herdr?: Bun.Subprocess<"pipe", "pipe", "pipe">; gone?: Promise<unknown> };

/** v as a whole number kept within lo and hi; none for no number. */
const fit = (v: number, lo: number, hi: number, none: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : none);
const COLS = (v: number) => fit(v, 2, 500, 80);
const ROWS = (v: number) => fit(v, 2, 200, 24);

/** GET /api/terminal?slot=<id>&cols=C&rows=R: upgrades to the page's terminal of the slot, checked as a
 *  write is first: 403 for where it came from, 400 for no upgrade or slot. undefined once upgraded. */
function terminalUpgrade(req: Request, server: Server<Term>): Response | undefined {
  if (!ownPage(req)) return new Response("只认看板自己的页面发来的请求。\n", { status: 403 });
  const q = new URL(req.url).searchParams;
  const slot = q.get("slot") ?? "";
  if (req.headers.get("upgrade")?.toLowerCase() !== "websocket" || !ID.test(slot)) return new Response("要带槽位升级成 WebSocket。\n", { status: 400 });
  const data: Term = { slot, cols: COLS(count(q.get("cols"))), rows: ROWS(count(q.get("rows"))), page: q.get("page") ?? "", resume: q.get("resume") === "1" };
  return server.upgrade(req, { data }) ? undefined : new Response("没能升级成 WebSocket。\n", { status: 400 });
}

/** The line for Herdr's terminal session control of what the page sent, a JSON text frame (spec
 *  web-terminal "页面发来的消息"): what you type, a size, a scroll or a click, those two at the cell
 *  under the pointer; null for one it does not take. */
function herdrLine(text: string): string | null {
  let m: { t?: unknown; c?: unknown; r?: unknown; d?: unknown; up?: unknown; n?: unknown; a?: unknown } | null;
  try {
    m = JSON.parse(text);
  } catch {
    return null;
  }
  const cell = typeof m?.c === "number" && typeof m.r === "number" ? { column: fit(m.c, 0, 499, 0), row: fit(m.r, 0, 199, 0) } : undefined;
  if (m?.t === "in" && typeof m.d === "string") return JSON.stringify({ type: "terminal.input", text: m.d });
  if (m?.t === "size" && typeof m.c === "number" && typeof m.r === "number") return JSON.stringify({ type: "terminal.resize", cols: COLS(m.c), rows: ROWS(m.r) });
  if (m?.t === "scroll" && typeof m.up === "boolean" && typeof m.n === "number") return JSON.stringify({ type: "terminal.scroll", direction: m.up ? "up" : "down", lines: fit(m.n, 1, 200, 1), ...cell });
  // Herdr encodes it for the mode the pane's program asked for, and drops it if none (architecture §10.4).
  if (m?.t === "mouse" && (m.a === "down" || m.a === "drag" || m.a === "up") && cell) return JSON.stringify({ type: "terminal.mouse", action: m.a, ...cell });
  return null;
}

/** The close code for why Herdr closed the terminal (spec web-terminal "关闭代码"): the pane's process
 *  exited, its tab was closed, or it was gone already, as just after its agent exited and before Rhodium
 *  switches the slot back (#383), 4000; another took it over, 4001; else 4002. */
const closeCode = (reason: string) =>
  reason === "terminal attach taken over" ? 4001 : /^terminal \S+ exited$|^terminal (attach ended: terminal|session control failed: terminal target) \S+ not found$/.test(reason) ? 4000 : 4002;

/** The page's terminal opened (architecture §10.4): a slot in the terminal, its pane there and Herdr
 *  not restarting, gets Herdr's terminal session control of the pane, taking it over at the page's
 *  size, and its frames as binary; else 4000. It is the slot's one page terminal in open: one open
 *  before it is closed with 4001 and let go of first, unless this one only resumes and that one is
 *  another page's: then this one leaves the slot to it, closed with 4001 itself (spec web-terminal
 *  "一处在操作"). One of its own page is one the board has not seen drop.
 *  Herdr's closing closes it with the code for why; one that ends without saying why, as one that
 *  cannot start, with 4002 and its stderr's first line. */
async function openTerminal(store: Store, cfg: Config, ws: ServerWebSocket<Term>, open: Map<string, ServerWebSocket<Term>>, herdrSocket: () => Promise<string>) {
  const t = ws.data;
  const s = store.tx((tx) => tx.get("slot", t.slot));
  if (!s || s.mode !== "tui" || s.herdrPane === null || s.herdrLostAt !== null) return ws.close(4000, "槽位不在终端里");
  const before = open.get(t.slot);
  if (before && t.resume && !(t.page && before.data.page === t.page)) return ws.close(4001, "在别处打开");
  open.set(t.slot, ws);
  if (before) {
    log("terminal taken over", { slot: t.slot });
    before.close(4001, "在别处打开");
    // Gone before this one attaches: whether Herdr would let go of this one too, told so after it attached, is untested.
    await letGo(before.data);
    if (open.get(t.slot) !== ws || ws.readyState !== 1) return;
  }
  // Bun cuts a reason to the 123 bytes a close gives it, no character in two.
  const close = (code: number, reason: string) => void (ws.readyState === 1 && ws.close(code, reason));
  const argv = [cfg.programs.herdr, "--session", cfg.herdr.session, "terminal", "session", "control", s.herdrPane, "--takeover", "--cols", String(t.cols), "--rows", String(t.rows)];
  try {
    t.herdr = Bun.spawn(argv, { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    return close(4002, String(err));
  }
  log("terminal opened", { slot: t.slot, pane: s.herdrPane, cols: t.cols, rows: t.rows });
  const herdr = t.herdr;
  const stderr = new Response(herdr.stderr).text();
  const woken = wake(herdrSocket(), s.herdrPane);
  void (async () => {
    let why: string | undefined;
    let buf = "";
    for await (const chunk of herdr.stdout.pipeThrough(new TextDecoderStream())) {
      // Herdr has let it in.
      woken();
      buf += chunk;
      for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
        let m: { type?: unknown; bytes?: unknown; reason?: unknown };
        try {
          m = JSON.parse(buf.slice(0, i));
        } catch {
          continue;
        }
        // Bun sends it raw unless told to compress it, the extension agreed or not.
        if (m.type === "terminal.frame" && typeof m.bytes === "string" && ws.readyState === 1) ws.sendBinary(Buffer.from(m.bytes, "base64"), true);
        else if (m.type === "terminal.closed") why = String(m.reason);
      }
    }
    const code = await herdr.exited;
    if (why !== undefined) return close(closeCode(why), why);
    // Its first line says what went wrong; the rest, what to do about it.
    close(4002, (await stderr).trim().split("\n")[0] || `herdr 退出码 ${code}`);
  })().catch((err) => close(4002, String(err)));
}

/** Herdr lets a new client in only every 250 ms while idle, and at once as any request comes on its
 *  socket (architecture §10.4): asks it about the pane every 10 ms, 250 ms at most. Stopped by what it
 *  returns. */
function wake(socket: Promise<string>, pane: string): () => void {
  let on = true;
  const stop = () => void (on = false);
  setTimeout(stop, 250);
  void socket.then(
    async (at) => {
      for (; on; await Bun.sleep(10)) void call(at, "pane.get", { pane_id: pane }, 1_000).catch(() => {});
    },
    () => {},
  );
  return stop;
}

/** Herdr lets go of the terminal's pane, once: its terminal session control is told so, and killed if
 *  it has not exited within 2 s. Resolves as it has. */
function letGo(t: Term): Promise<unknown> {
  const herdr = t.herdr;
  if (!herdr) return Promise.resolve();
  return (t.gone ??= (() => {
    if (herdr.exitCode === null)
      try {
        herdr.stdin.write('{"type":"terminal.release"}\n');
        herdr.stdin.end();
      } catch {}
    const kill = setTimeout(() => herdr.kill(), 2_000);
    return herdr.exited.finally(() => clearTimeout(kill));
  })());
}

/** The page's terminal closed: no longer its slot's one in open, and Herdr lets go of the pane. */
function closeTerminal(ws: ServerWebSocket<Term>, code: number, reason: string, open: Map<string, ServerWebSocket<Term>>) {
  log("terminal closed", { slot: ws.data.slot, code, reason });
  if (open.get(ws.data.slot) === ws) open.delete(ws.data.slot);
  void letGo(ws.data);
}

/** Whether the request names as its host this machine, or what reaches the board from elsewhere: the
 *  tailnet (auth tailscale), or one of hosts, exactly (auth none). A page whose own name was made to
 *  point here, in a browser on this machine or behind the proxy, names its own, and gets nothing (spec web-write). */
function ownHost(req: Request, b: Config["board"]): boolean {
  const name = new URL(req.url).hostname;
  return name === "127.0.0.1" || name === "localhost" || (b.auth === "tailscale" ? /(^|\.)ts\.net$/.test(name) : b.hosts.includes(name));
}

/** Starts the board on <board.bind>:<board.port>; throws if it cannot listen there. It joins hearing,
 *  told what the agents write. web: the page's files. act: does what the page writes; with none, the
 *  board only shows. */
export function serveBoard(store: Store, cfg: Config, hearing = new Set<Hear>(), web = WEB, act: Act = async () => ({ ok: false, error: "这个看板只能看。" })): Server<Term> {
  const startedAt = Date.now();
  const { follow, hear } = transcripts(store);
  hearing.add(hear);
  /** Each slot's one page terminal open. */
  const terms = new Map<string, ServerWebSocket<Term>>();
  /** Herdr's socket, listed as a terminal first opens; listed again after a try that failed. */
  let socket: Promise<string> | undefined;
  const herdrSocket = () =>
    (socket ??= sessionSocket(cfg.programs.herdr, cfg.herdr.session).catch((err) => {
      socket = undefined;
      throw err;
    }));
  return Bun.serve<Term>({
    hostname: cfg.board.bind,
    port: cfg.board.port,
    idleTimeout: Math.ceil(cfg.durations.boardIdle / 1000),
    maxRequestBodySize: SEND_MAX,
    fetch: async (req, server) => {
      const res = await route(req, server);
      return res && gzipped(req, res);
    },
    websocket: {
      // What the page sends is what you type, which it cuts to fit, a size, a scroll or a click (spec web-terminal).
      maxPayloadLength: 64 * 1024,
      // A page that reads too slowly is closed once 1MB waits for it, not left with frames dropped: it
      // reconnects and gets a whole screen.
      backpressureLimit: 1 << 20,
      closeOnBackpressureLimit: true,
      // Herdr's frames to the page, about a fifth as many bytes: a compressor of the socket's own keeps
      // what it sent before, as each frame redraws much of the last. The page's few bytes stay as they are.
      perMessageDeflate: { compress: "dedicated", decompress: false },
      // Bun pings a page quiet this long, less 2 s: well before a proxy in front drops a socket quiet
      // too long, Cloudflare's said to at 100 s, nginx's by default at 60 s.
      idleTimeout: 30,
      open: (ws) => void openTerminal(store, cfg, ws, terms, herdrSocket),
      message: (ws, msg) => {
        if (typeof msg !== "string") return ws.close(1003, "只收文本帧");
        const line = herdrLine(msg);
        if (line && ws.data.herdr?.exitCode === null) (ws.data.herdr.stdin.write(line + "\n"), ws.data.herdr.stdin.flush());
      },
      close: (ws, code, reason) => closeTerminal(ws, code, reason, terms),
    },
  });

  function route(req: Request, server: Server<Term>): Response | Promise<Response> | undefined {
    const b = cfg.board;
    if (b.closed) return new Response(`看板关着：配置文件 [board] 写错了，${b.closed}。改好后重启 Rhodium。\n`, { status: 503 });
    if (!ownHost(req, b)) return new Response(b.auth === "tailscale" ? "看板只认 tailnet 和本机的地址。\n" : "看板只认本机的地址和配置文件 [board] hosts 里的主机名。\n", { status: 403 });
    // Every path, the page and its icons too: only tailscale serve reaches this port from outside. With
    // auth none whoever reaches it is let in, a Tailscale-User-Login they send no more than any header.
    if (b.auth === "tailscale" && (!b.login || req.headers.get("Tailscale-User-Login") !== b.login)) {
      return new Response("只有配置文件 [board] login 里的 Tailscale 账号能看这个看板。\n", { status: 403 });
    }
    const url = new URL(req.url);
    const path = url.pathname;
    // Where the page was tried (story 211): a bookmark, or a page still open there, goes on to /. Not
    // //host, which would take you to another site.
    if (/^\/next(\/|$)/.test(path)) return new Response(null, { status: 301, headers: { location: `/${path.slice("/next".length).replace(/^\/+/, "")}${url.search}` } });
    switch (path) {
      case "/api/board":
        return board(store, cfg, Date.now()).then((b) => Response.json(b, { headers: { "cache-control": "no-store" } }));
      case "/api/topology":
        return topology(store, cfg, Date.now()).then((t) => Response.json(t, { headers: { "cache-control": "no-store" } }));
      case "/api/avatar":
        return avatar(store, cfg, url.searchParams.get("id") ?? "");
      case "/api/events":
        return events(store, req, server, follow, web);
      case "/api/messages":
        return messages(store, cfg, url.searchParams);
      case "/api/full":
        return full(store, url.searchParams);
      case "/api/slot":
        return slotDetail(store, cfg, url.searchParams.get("id") ?? "");
      case "/api/slot-events":
        return slotEvents(store, url.searchParams);
      // Names anywhere on the disk: the board's own page alone, as for a write.
      case "/api/dirs":
        if (!ownPage(req)) return new Response("只认看板自己的页面发来的请求。\n", { status: 403 });
        return dirs(store, url.searchParams.get("path") ?? "").then((d) => Response.json(d, { headers: { "cache-control": "no-store" } }));
      // What the page times the round trip by (#286).
      case "/api/ping":
        return new Response(null, { status: 204 });
      case "/api/rhodium":
        return rhodium(store, cfg, startedAt).then((r) => Response.json(r, { headers: { "cache-control": "no-store" } }));
      case "/api/act":
        return write(req, act);
      case "/api/send":
        return sendWith(req, act, join(cfg.stateDir, "media"));
      case "/api/terminal":
        return terminalUpgrade(req, server);
    }
    // The URL parser has resolved any . and .. in the path.
    return webFile(web, path, req.headers.get("accept-encoding") ?? "");
  }
}
