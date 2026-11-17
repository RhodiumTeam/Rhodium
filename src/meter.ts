// What Rhodium last heard of each conversation's context and use, and of each agent's quota, which its
// slots share as the quota is the account's (architecture §7.11): recorded from the drivers' usage,
// context and status results, and from a slot's transcript while it is in the terminal; read back for
// the board's /api/slot.
import { windowsOf } from "./codex";
import type { AgentKind, CommandResult, ContextUse, ExtraUsage, QuotaWindow, SessionUse } from "./contracts";
import type { Conversation, Tx } from "./store";
import type { TranscriptMeter } from "./transcript";

/** A conversation's meter column: its context, Claude's categories too, and its use; each with when it was heard, ms. */
export type Heard = { context?: ContextUse & { categories?: { name: string; tokens: number }[]; at: number }; session?: SessionUse & { at: number } };
/** An agent's quota as last heard, the meta row quota.<agent>. */
export type Quota = { limits: QuotaWindow[]; extra?: ExtraUsage; credits?: number; at: number };
/** What /api/slot says of it: null for what was never heard. */
export type SlotMeter = { context: NonNullable<Heard["context"]> | null; session: NonNullable<Heard["session"]> | null; quota: Quota | null };

const quotaKey = (agent: AgentKind) => `quota.${agent}`;
const heardOf = (c: Conversation): Heard => JSON.parse(c.meter ?? "{}");
const quotaOf = (tx: Tx, agent: AgentKind): Quota | null => JSON.parse(tx.get("meta", quotaKey(agent))?.value ?? "null");

function keep(tx: Tx, c: Conversation, heard: Heard | null, quota: Quota | null): void {
  if (heard) tx.update("conversation", { id: c.id }, { meter: JSON.stringify(heard) });
  if (!quota) return;
  const id = quotaKey(c.agent);
  const value = JSON.stringify(quota);
  if (!tx.update("meta", { id }, { value })) tx.insert("meta", { id, value });
}

/** When the conversation's context or use was last heard; 0 for never. */
export function heardAt(c: Conversation): number {
  const h = heardOf(c);
  return Math.max(h.context?.at ?? 0, h.session?.at ?? 0);
}

/** Records what the conversation's usage, context or status result says, as heard at. True if it said
 *  anything to record. A quota with no window, extra use or credits is none (pi's, an API key login's). */
export function record(tx: Tx, conversation: string, r: CommandResult, at = Date.now()): boolean {
  const c = tx.get("conversation", conversation);
  if (!c) return false;
  const h = heardOf(c);
  let heard = false;
  let quota: Quota | null = null;
  if (r.command === "context") {
    h.context = { usedTokens: r.usedTokens, maxTokens: r.maxTokens, ...(r.categories && { categories: r.categories }), at };
    heard = true;
  } else if (r.command === "status") {
    if (r.context) (h.context = { ...r.context, at }), (heard = true);
    // /status has the windows alone: the extra use and credits heard before stay.
    if (r.limits?.length) quota = { ...quotaOf(tx, c.agent), limits: r.limits, at };
  } else if (r.command === "usage") {
    if (r.session) (h.session = { ...r.session, at }), (heard = true);
    if (r.limits.length || r.extra || r.credits !== undefined) quota = { limits: r.limits, ...(r.extra && { extra: r.extra }), ...(r.credits !== undefined && { credits: r.credits }), at };
  }
  keep(tx, c, heard ? h : null, quota);
  return heard || quota !== null;
}

/** Takes in what the transcript of a slot in the terminal says, where newer than what was heard: its
 *  context, out of the limit heard before but for Codex's, which its file has; Codex's quota bucket,
 *  over that bucket's windows alone, the others' kept (architecture §7.11). True if it recorded anything. */
export function fromTranscript(tx: Tx, c: Conversation, t: TranscriptMeter): boolean {
  const h = heardOf(c);
  const context = t.context && t.context.at > (h.context?.at ?? 0) ? { ...t.context, maxTokens: t.context.maxTokens ?? h.context?.maxTokens ?? null } : null;
  if (context) h.context = context;
  const q = c.agent === "codex" ? quotaOf(tx, "codex") : null;
  const r = c.agent === "codex" && t.rateLimits && t.rateLimits.at > (q?.at ?? 0) ? t.rateLimits : null;
  let quota: Quota | null = null;
  if (r) {
    const b = r.bucket as { limitId: string; credits?: { hasCredits?: boolean; balance?: string | null } };
    const credits = b.credits ? (b.credits.hasCredits && b.credits.balance != null ? Number(b.credits.balance) : undefined) : q?.credits;
    const limits = [...windowsOf(b), ...(q?.limits ?? []).filter((w) => (w.limitId ?? "codex") !== b.limitId)];
    quota = { limits, ...(q?.extra && { extra: q.extra }), ...(credits !== undefined && { credits }), at: r.at };
  }
  keep(tx, c, context ? h : null, quota);
  return !!context || quota !== null;
}

/** The conversation's meter for /api/slot, the quota its agent's. */
export function meterOf(tx: Tx, c: Conversation | null): SlotMeter {
  if (!c) return { context: null, session: null, quota: null };
  const h = heardOf(c);
  return { context: h.context ?? null, session: h.session ?? null, quota: quotaOf(tx, c.agent) };
}
