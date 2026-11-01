// 未读 and 跑完提醒 (spec web-maximize "未读和跑完提醒怎么做"): a slot whose turn this page saw end, its
// reply on the web alone, while its chat was not in front of you, is unread till it is: a dot on its
// row, a count in the title and the app's badge. With the page hidden or its window not focused, a
// computer also shows a system notification for a turn your message on the board began, or a slot
// needing you, till you have seen it. Kept in the page's memory alone.
import { useSyncExternalStore } from "react";
import { chatAt, openFrom, ROOM } from "./common";
import { json, queryClient, seen, type BoardData } from "./data";

/** The page now: the slot whose chat is open, "" for none; whether the page is in front, and its
 *  window has the focus. */
export type Here = { chat: string; visible: boolean; focused: boolean };

const page = (): Here => ({ chat: chatAt(location.hash.slice(1), matchMedia(ROOM).matches), visible: document.visibilityState === "visible", focused: document.hasFocus() });
/** Brings the page in front with slot's chat open, the page staying as it is, as the jump box does. */
const openChat = (slot: string) => (focus(), openFrom(slot, location.hash.slice(1)));

const unread = new Set<string>();
/** The system notification shown for each slot, closed once you have seen it. */
const shown = new Map<string, Notification>();
const close = (slot: string) => (shown.get(slot)?.close(), shown.delete(slot));
const told = new Set<() => void>();
const changed = () => {
  document.title = unread.size ? `(${unread.size}) Rhodium` : "Rhodium";
  (navigator as { setAppBadge?: (n: number) => Promise<void> }).setAppBadge?.(unread.size).catch(() => {});
  told.forEach((f) => f());
};
const listen = (f: () => void) => (told.add(f), () => void told.delete(f));
/** Whether slot id is unread, as it changes. */
export function useUnread(id: string): boolean {
  const get = () => unread.has(id);
  return useSyncExternalStore(listen, get, get);
}
/** Whether a slot but id is unread, as it changes. */
export function useUnreadBut(id: string): boolean {
  const get = () => [...unread].some((s) => s !== id);
  return useSyncExternalStore(listen, get, get);
}

/** The slot's state as the board last had it: running for 运行中. */
const onBoard = (slot: string) =>
  queryClient
    .getQueryData<BoardData>(["board"])
    ?.workspaces.flatMap((w) => Object.values(w.groups).flat())
    .find((c) => c.id === slot)?.state === "运行中"
    ? "running"
    : undefined;

/** Which of this browser's Rhodium pages is in front, its window focused, as they tell each other in
 *  storage: a turn ending there is seen, and the others remind of nothing. */
const me = crypto.randomUUID();
const FRONT = "front";
/** What storage lets us do: nothing, as in some private windows. */
const stored = <T>(f: () => T) => {
  try {
    return f();
  } catch {
    return undefined;
  }
};
// ponytail: a page that dies in front stays there, no reminders, till another comes in front and goes.
const leave = () => stored(() => localStorage.getItem(FRONT) === me && localStorage.removeItem(FRONT));

/** Follows the event stream for turns that end with their reply on the web alone: a slot going from
 *  running to idle, as the stream said, or the board for one it said nothing of yet, with no
 *  final_reply, send_me or compacted since its turn began: an IM turn's final_reply, or your
 *  /compact's compacted, comes in the same transaction just before it, and rh send me mid-turn, a
 *  question or a quota wait maybe after it.
 *  Each is unread unless its chat is in front of you. With the page hidden or not focused, one your
 *  message on the board began is reminded of, as the stream's web says, and so is an ask, a slot
 *  needing you; the reminder goes once its chat is in front of you, the ask is answered or withdrawn,
 *  or a turn of yours from the board begins. here: the page now; open: what a reminder's click does.
 *  Returns what stops it, the unread going with it. */
export function watch(here: () => Here = page, open: (slot: string) => void = openChat): () => void {
  const states = new Map<string, string>();
  const replied = new Set<string>();
  // Slots in a turn of yours from the board, or one running on from it unseen, as a report that waited for its end.
  const mine = new Set<string>();
  const away = () => {
    const h = here();
    return !h.visible || !h.focused;
  };
  const look = () => {
    const h = here();
    if (h.visible && h.focused) stored(() => localStorage.setItem(FRONT, me));
    else leave();
    if (!h.visible) return;
    close(h.chat);
    if (unread.delete(h.chat)) changed();
  };
  const take = (e: { type: string; slot: string | null; data: unknown }) => {
    if (!e.slot) return;
    if (e.type === "final_reply" || e.type === "send_me" || e.type === "compacted") return void replied.add(e.slot);
    if (e.type === "ask") return void (away() && remind(e.slot, open, true));
    if (e.type === "ask_answered") return void close(e.slot);
    if (e.type !== "slot_state") return;
    const { state = "", web = false } = (e.data ?? {}) as { state?: string; web?: boolean };
    const was = states.get(e.slot) ?? onBoard(e.slot);
    states.set(e.slot, state);
    // Its asks withdrawn unanswered, as by /stop, write no ask_answered.
    if (was === "waiting" && state !== "waiting") close(e.slot);
    if (web) mine.add(e.slot);
    // A turn begins: forget an rh send me from before it, as a background job's report. Yours from the
    // board, on any page, says you saw its chat.
    if (state === "running" && was !== "running" && was !== "waiting" && was !== "rate_limited") {
      replied.delete(e.slot);
      if (web) close(e.slot);
    }
    if (state === "running" || state === "waiting" || state === "rate_limited") return;
    const yours = mine.delete(e.slot);
    if (replied.delete(e.slot) || was !== "running" || state !== "idle") return;
    const h = here();
    if (!(h.visible && h.chat === e.slot) && !unread.has(e.slot)) (unread.add(e.slot), changed());
    if (yours && (!h.visible || !h.focused)) void remind(e.slot, open);
  };
  seen.add(take);
  for (const e of ["hashchange", "focus", "blur"]) addEventListener(e, look);
  addEventListener("pagehide", leave);
  document.addEventListener("visibilitychange", look);
  look();
  return () => {
    seen.delete(take);
    for (const e of ["hashchange", "focus", "blur"]) removeEventListener(e, look);
    removeEventListener("pagehide", leave);
    document.removeEventListener("visibilitychange", look);
    unread.clear();
  };
}

/** The computer's system notification for slot's turn: its name, the start of its reply, as its row's
 *  last line has it; or, needs, 需要你, while the board has it so, not for a confirm request waiting
 *  for its turn's end. One per slot. Only with leave, and where the page may show one itself:
 *  Android's Chrome throws. */
async function remind(slot: string, open: (slot: string) => void, needs = false): Promise<void> {
  if (typeof Notification === "undefined" || Notification.permission !== "granted" || !reminding()) return;
  const there = stored(() => localStorage.getItem(FRONT));
  if (there && there !== me) return;
  const c = await json<BoardData>("api/board").then(
    (d) => d.workspaces.flatMap((w) => (needs ? w.groups.needsYou : Object.values(w.groups).flat())).find((c) => c.id === slot),
    () => undefined,
  );
  if (needs && !c) return;
  const reply = c?.last?.role === "assistant" ? [...c.last.text] : [];
  const body = needs ? "需要你" : reply.length > 60 ? `${reply.slice(0, 60).join("")}…` : reply.join("");
  try {
    const n = new Notification(c?.ref ?? "Rhodium", { tag: slot, ...(body && { body }) });
    n.onclick = () => (open(slot), n.close());
    shown.set(slot, n);
  } catch {}
}

/** Whether this device reminds you: till turned off in maximize mode's settings (#491). */
export const reminding = () => stored(() => localStorage.getItem("remind")) !== "off";

/** Turns reminders on this device on or off (#491); on with no leave yet, asks for it in the click that
 *  turns them on, and never again at a send. What leave is then. */
export async function remindBy(on: boolean): Promise<NotificationPermission> {
  stored(() => (on ? localStorage.removeItem("remind") : localStorage.setItem("remind", "off")));
  if (!on || Notification.permission !== "default") return Notification.permission;
  stored(() => localStorage.setItem("remindAsked", "1"));
  return Notification.requestPermission();
}

/** Whether the page can show a reminder itself: not where its constructor throws even before leave
 *  (Android's Chrome). Tried only without leave, when it shows nothing. */
export function canRemind(): boolean {
  if (typeof Notification === "undefined") return false;
  if (Notification.permission === "granted") return true;
  try {
    new Notification("").close();
    return true;
  } catch {
    return false;
  }
}

/** Asks for leave to remind you, once on this device, as you first send a message from the web: in
 *  its gesture, the only time browsers ask in earnest. Never again, denied or dismissed, nor once
 *  reminders are turned off. Not where the page cannot show one itself, whose constructor throws even
 *  before leave (Android's Chrome), nor where storage cannot keep that it asked, which would ask at
 *  every send. */
export function askOnce(): void {
  if (typeof Notification === "undefined" || Notification.permission !== "default" || !reminding()) return;
  try {
    if (localStorage.getItem("remindAsked")) return;
    localStorage.setItem("remindAsked", "1");
  } catch {
    return;
  }
  if (canRemind()) void Notification.requestPermission();
}
