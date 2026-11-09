// Upkeep (architecture §7.8, §12): the daily retention cleanup and database backup, and the free
// disk space that new and resumed slots need.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatDuration, type Config } from "./config";
import { log } from "./daemon";
import { time } from "./im-commands";
import type { RhReply } from "./router";
import { setMeta, type AgentInput, type Outbound, type Store } from "./store";

/** Free bytes on the disk dir is on. */
export function freeDisk(dir: string): number {
  const disk = statfsSync(dir);
  return disk.bavail * disk.bsize;
}

/** How many backups are kept (architecture §7.8). */
const KEEP = 14;
/** A backup's file name: rh-<UTC time>.db, so names sort by time. */
const BACKUP = /^rh-.*\.db$/;

/**
 * Runs run once every `every` ms, counted from the time in the meta row `key`, which run sets when
 * it starts: a restart keeps the day, and a run that came due while rhodium was down comes now. With
 * no time on record, the first comes one period from now.
 */
export function daily(store: Store, key: string, every: number, run: () => Promise<unknown>): void {
  const tick = () => {
    let at = Number(store.tx((tx) => tx.get("meta", key)?.value));
    if (!at) setMeta(store, key, String((at = Date.now())));
    const left = at + every - Date.now();
    // setTimeout can't wait longer than about 24.8 days in one go.
    if (left > 0) return void setTimeout(tick, Math.min(left, 2 ** 31 - 1));
    run().finally(tick);
  };
  tick();
}

/** Backs the database up into <stateDir>/backup and keeps the newest KEEP backups. */
function backup(cfg: Config, store: Store): void {
  const dir = join(cfg.stateDir, "backup");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `rh-${new Date().toISOString().replace(/[:.]/g, "-")}.db`;
  // Written beside its name, then renamed: a half-written one is never taken for a backup, nor
  // counted among those kept. One a crash left behind goes now.
  for (const f of readdirSync(dir)) if (f.endsWith(".db.tmp") && BACKUP.test(f.slice(0, -4))) rmSync(join(dir, f));
  // ponytail: holds up the main loop while it copies, fine for a db of tens of MB; a worker if it grows.
  store.backup(join(dir, `${name}.tmp`));
  renameSync(join(dir, `${name}.tmp`), join(dir, name));
  for (const f of readdirSync(dir).filter((f) => BACKUP.test(f)).sort().slice(0, -KEEP)) rmSync(join(dir, f));
}

/** The hold dirs no longer in use (architecture §4.3): neither a slot's current conversation's nor one
 *  whose holder has not exited. Each with when it was last written and its bytes. */
function endedHoldDirs(cfg: Config, store: Store): { path: string; at: number; bytes: number }[] {
  const hold = join(cfg.stateDir, "hold");
  const inUse = store.tx((tx) => new Set([...tx.find("slot", {}).map((s) => s.conversation), ...tx.find("holder", { exited: 0 }).map((h) => h.conversation)]));
  return (existsSync(hold) ? readdirSync(hold) : []).flatMap((c) => {
    if (inUse.has(c)) return [];
    try {
      const files = readdirSync(join(hold, c)).map((f) => statSync(join(hold, c, f)));
      return [{ path: join(hold, c), at: Math.max(0, ...files.map((f) => f.mtimeMs)), bytes: files.reduce((n, f) => n + f.size, 0) }];
    } catch {
      return []; // not a dir, or gone meanwhile
    }
  });
}

/** Removes the files in the media dir (architecture §7.8) last stored before `before`, and what was made
 *  of each, which lies under a dir of the media dir's by the same name; so goes one made of a file gone
 *  otherwise. Adds what went to gone. */
function pruneMedia(dir: string, before: number, gone: { media: number; bytes: number }): void {
  if (!existsSync(dir)) return;
  const remove = (path: string) => {
    gone.bytes += statSync(path).size;
    rmSync(path);
  };
  const made: string[] = [];
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    if (f.isDirectory()) made.push(f.name);
    else if (statSync(join(dir, f.name)).mtimeMs < before) {
      remove(join(dir, f.name));
      gone.media++;
    }
  }
  for (const sub of made) for (const f of readdirSync(join(dir, sub))) if (!existsSync(join(dir, f))) remove(join(dir, sub, f));
}

/**
 * The retention cleanup (architecture §7.8). First what is past its keep time: inbound messages and
 * outbound records with the quoted text they hold, the QQ passive quota each inbound message brought,
 * events, ended hold dirs, and the media dir's files. Then, while those records and ended hold dirs
 * still come to more than limits.stateMaxMB, the oldest of them, but never a record of what is still in
 * use: a message not sent yet, and the one a turn under way began. One event says what went.
 */
function prune(cfg: Config, store: Store): void {
  const now = Date.now();
  const gone = { inbound: 0, outbound: 0, events: 0, holdDirs: 0, media: 0, bytes: 0 };
  const recordBytes = () => store.recordBytes().reduce((n, r) => n + r.bytes, 0);
  const had = recordBytes();
  const drop = (before: number, eventsBefore: number) =>
    store.tx((tx) => {
      gone.inbound += tx.delete("inbound", { receivedAt: { before } });
      gone.outbound += tx.delete("outbound", { createdAt: { before } });
      // Its reset time is a little after its message came, so it goes a little after it.
      tx.delete("quota", { kind: "qq_passive", resetsAt: { before } });
      gone.events += tx.dropEvents(eventsBefore);
    });
  const remove = (d: { path: string; bytes: number }) => {
    rmSync(d.path, { recursive: true, force: true });
    gone.holdDirs++;
    gone.bytes += d.bytes;
  };
  drop(now - cfg.durations.inboundKeep, now - cfg.durations.eventKeep);
  const dirs = endedHoldDirs(cfg, store);
  const old = (d: { at: number }) => d.at < now - cfg.durations.holdDirKeep;
  for (const d of dirs.filter(old)) remove(d);
  pruneMedia(join(cfg.stateDir, "media"), now - cfg.durations.inboundKeep, gone);

  const keepFrom = store.tx((tx) =>
    Math.min(
      ...(["pending", "held", "sending"] as const).flatMap((status) => tx.find("outbound", { status }).map((o) => o.createdAt)),
      ...tx.find("slot", {}).flatMap((s) => (s.turnInbound ? [tx.get("inbound", s.turnInbound)?.receivedAt ?? Infinity] : [])),
    ),
  );
  const records = store.recordBytes().filter((r) => r.at < keepFrom);
  const left = dirs.filter((d) => !old(d));
  let over = recordBytes() + left.reduce((n, d) => n + d.bytes, 0) - cfg.limits.stateMaxMB * 2 ** 20;
  let cut = 0; // records from before it go
  const items: { at: number; bytes: number; path?: string }[] = [...records, ...left].sort((a, b) => a.at - b.at);
  for (const i of items) {
    if (over <= 0) break;
    over -= i.bytes;
    if (i.path !== undefined) remove({ path: i.path, bytes: i.bytes });
    else cut = Math.min(i.at + 60_000, keepFrom);
  }
  if (cut) drop(cut, cut);
  gone.bytes += had - recordBytes();
  // bytes alone when only copies whose picture was gone went.
  if (gone.inbound || gone.outbound || gone.events || gone.holdDirs || gone.media || gone.bytes) {
    store.tx((tx) => tx.append({ source: "clock", type: "state_pruned", data: gone }));
    log("retention cleanup", gone);
  }
}

/** The daily upkeep, every durations.backupEvery: the retention cleanup, then a backup. */
export function upkeep(cfg: Config, store: Store): void {
  daily(store, "upkeepAt", cfg.durations.backupEvery, async () => {
    setMeta(store, "upkeepAt", String(Date.now()));
    try {
      prune(cfg, store);
      backup(cfg, store);
    } catch (err) {
      log("upkeep failed", { error: String(err) });
    }
  });
}

const INPUT: Record<AgentInput["status"], string> = { queued: "排队中", writing: "正在写入", written: "已写入，agent 还没收下", taken: "agent 已收下", unknown: "结局不明，没有重发" };
const SENT: Record<Outbound["status"], string> = { pending: "待发", held: "等你回话", sending: "发送中", sent: "已发", failed: "发送失败", unknown: "结局不明，没有重发" };

/** rh trace (architecture §12): where an IM message went, why, and how its delivery to the agent
 *  and its replies went, with the events it led to. id: the platform's message id, or the trace id. */
export function trace(store: Store, id: string, cfg: Config): RhReply {
  return store.tx((tx) => {
    // ponytail: the first chat's when two chats have a message with this platform id; by chat if that bites.
    const m = tx.get("inbound", id) ?? tx.find("inbound", { platformMsgId: id })[0];
    const traceId = m?.trace ?? id;
    const inputs = tx.find("agentInput", { trace: traceId });
    const sends = tx.find("outbound", { trace: traceId });
    const events = store.traced(traceId);
    if (!m && !inputs.length && !sends.length && !events.length) {
      const keep = `入站消息保留 ${formatDuration(cfg.durations.inboundKeep)}，事件保留 ${formatDuration(cfg.durations.eventKeep)}`;
      return { ok: false, error: `没有找到消息 ${id}：ID 不对，或者它已过保留期（${keep}）。` };
    }
    const ref = (slot: string | null | undefined) => {
      const s = slot ? tx.get("slot", slot) : null;
      const w = s && tx.get("workspace", s.workspace);
      if (s && w) return `${w.name}/${s.name}`;
      // A deleted slot's name is in its last event (architecture §9.8).
      const last = slot ? store.slotEvents(slot, 1)[0] : undefined;
      return last?.type === "slot_deleted" ? (last.data as { ref: string }).ref : (slot ?? "");
    };
    const lines: string[] = [];
    if (m) {
      const chat = tx.get("chat", m.chat);
      const bot = chat && tx.get("bot", chat.bot);
      lines.push(`消息 ${traceId}：Bot ${bot?.name} 的窗口 ${chat?.platformChatId}，平台消息 ID ${m.platformMsgId}，发送者 ${m.sender}，${time(m.receivedAt)} 收到`);
      lines.push(m.route ? `去向：${ref(m.route)}（${m.reason}）` : `去向：没有投给槽位（${m.reason}）`);
    } else lines.push(`消息 ${traceId}：没有它的入站记录，可能已过保留期（${formatDuration(cfg.durations.inboundKeep)}）`);
    if (!inputs.length) lines.push("投给 agent：没有");
    for (const i of inputs) lines.push(`投给 agent：${ref(tx.get("conversation", i.conversation)?.slot)}，${INPUT[i.status]}`);
    if (!sends.length) lines.push("发送：没有");
    for (const o of sends) lines.push(`发送：${SENT[o.status]}${o.platformMsgId ? `，平台消息 ID ${o.platformMsgId}` : ""}，${time(o.createdAt)}`);
    lines.push(events.length ? "事件：" : "事件：没有");
    for (const e of events) lines.push(`  ${time(e.at)} ${e.type}${e.slot ? ` ${ref(e.slot)}` : ""}${e.data === null ? "" : ` ${JSON.stringify(e.data)}`}`);
    return { ok: true, text: lines.join("\n") };
  });
}
