// A slot's 详情 (spec web-topology, stories 252–254): its process on top, which says whether a slot that
// seems stuck is thinking or broken, its settings folded under it (story 322), and under them its
// events, read as the chat is, oldest first.
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Check, ChevronRight, CircleQuestionMark, Flag, Globe, MessageSquare, Power, RotateCcw, Send, Square, TriangleAlert, X, type LucideIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { moment, span } from "../../src/panels";
import { Box } from "./common";
import { Events, type SlotData, type SlotEvent } from "./data";
import { Stick } from "./stick";
import { inTurn, Timeline } from "./timeline";
import { toast } from "./toast";
import { act, Spin, useAct } from "./write";

export const KIND: Record<string, string> = { question: "选择题", plan: "计划确认", permission: "审批", confirm: "确认请求" };
const ASKED: Record<string, string> = { deferred: "等你", open: "等你", answered: "已答", delivered: "已答", timeout: "超时", cancelled: "作废" };
const WAITS: Record<string, string> = { pending: "待发", held: "等你回话", sending: "发送中" };
const ERRORS: Record<string, string> = { tui_failed: "没能切到终端", tui_back_failed: "没能切回无头", protocol_error: "看不懂 agent 说的话", agent_missing: "找不到 agent 程序" };
/** What became of the slot, said as a state is. */
const BECAME: Record<string, string> = { slot_agent: "换了 agent", tui_switch: "切到终端", tui_opened: "终端已打开", tui_release: "切回无头", tui_back: "回到无头" };
const STDERR_LINES = 50;
/** A process's state as systemd has it: its dot and its word; any other, it has exited. */
const RUNS: Record<string, [string, string]> = { active: ["bg-running", "运行中"], activating: ["bg-running", "启动中"], deactivating: ["bg-idle", "正在退出"], failed: ["bg-destructive", "已退出"] };

const QUIET = "text-muted-foreground";
/** Each kind of event's icon and colour: a state is a quiet line across, as in the chat. */
const LOOKS = {
  message: [MessageSquare, QUIET],
  ask: [CircleQuestionMark, "text-needs"],
  answered: [Check, QUIET],
  turn: [Flag, QUIET],
  sent: [Send, "text-running"],
  error: [TriangleAlert, "text-destructive"],
  stopped: [Square, QUIET],
  board: [Globe, QUIET],
  state: [null, QUIET],
  other: [null, QUIET],
} satisfies Record<string, [LucideIcon | null, string]>;

/** What an event says, in one sentence, and its kind; note: why your message was not handed to the agent. */
export function look(e: SlotEvent): { kind: keyof typeof LOOKS; text: string; note?: string } {
  const d = (e.data ?? {}) as Record<string, string | number | null | undefined>;
  const because = (what: string, why: unknown) => (why ? `${what}：${why}` : what);
  switch (e.type) {
    case "im_routed":
    case "board_routed":
      return { kind: "message", text: e.text ?? "（没存原文）", ...(e.why && { note: e.why }) };
    case "ask":
      // The tool only for a permission: the others' are the agent's own plumbing.
      return { kind: "ask", text: [`${KIND[d.kind!] ?? d.kind}${d.kind === "permission" && d.tool ? ` ${d.tool}` : ""}`, e.status && ASKED[e.status]].filter(Boolean).join("，") };
    case "ask_answered":
      return { kind: "answered", text: d.by === "timeout" ? "超时，按默认作答" : "已回答" };
    case "slot_state":
      return { kind: "state", text: e.text ?? "" };
    case "final_reply":
      return { kind: "turn", text: "回合结束" };
    case "send_me":
      return { kind: "sent", text: "agent 发给你一条消息" };
    case "compacted":
      return { kind: "turn", text: "/compact 跑完" };
    case "agent_crashed":
      return { kind: "error", text: d.signal ? `崩溃，信号 ${d.signal}` : `崩溃，退出码 ${d.code}` };
    case "herdr_lost":
      return { kind: "error", text: "Herdr 断了" };
    case "agent_stopped":
      return { kind: "stopped", text: "agent 退出" };
    case "slot_stop":
      return { kind: "stopped", text: "停下" };
    case "board_act": {
      // What you did on the board, as you would type it.
      const a = e.data as { kind?: string; name?: string; argv?: string[] } | null;
      return { kind: "board", text: a?.kind === "common" ? `/${a.name}` : `rh ${a?.argv?.join(" ") ?? ""}` };
    }
  }
  if (ERRORS[e.type]) return { kind: "error", text: because(ERRORS[e.type]!, d.error ?? d.detail) };
  if (BECAME[e.type]) return { kind: "state", text: BECAME[e.type]! };
  return { kind: "other", text: e.type };
}

let opened = 0;

/** 详情's insides: the process fixed on top, the events under it the only part that scrolls. Its
 *  events are of this opening: they open at the newest, and the newest page comes again on each
 *  update, which is each event while the stream is open. */
export function Details({ d }: { d: SlotData }) {
  const [{ events, query }] = useState(() => {
    const events = new Events(d.id);
    return { events, query: { queryKey: ["slot-events", d.id, ++opened], queryFn: async () => (await events.newest(), events.list) } };
  });
  useQuery(query);
  return (
    <>
      {d.process && <ProcessLine p={d.process} slot={d.id} />}
      <Settings d={d} />
      {/* Folded: the events are what 详情 is read for. */}
      {d.timeline.length > 0 && (
        <details className="max-h-[60dvh] shrink-0 overflow-y-auto px-4 pb-3">
          <summary className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
            时间线<span className="tabular-nums">{d.timeline.length}</span>
          </summary>
          <Timeline slot={d.id} list={d.timeline} turn={inTurn(d)} />
        </details>
      )}
      <Stick label="事件" reset={d.id} tail={events.list.at(-1)?.seq} older={() => events.older()} className="border-t">
        {() => (
          <ul className="grid gap-2.5 px-4 pt-3 pb-[calc(1.5rem+env(safe-area-inset-bottom))]">
            {events.list.map((e) => (
              <EventRow key={e.seq} e={e} />
            ))}
          </ul>
        )}
      </Stick>
    </>
  );
}

/** An event in a line: its icon, what it says and its time; what was sent for it under it. */
export function EventRow({ e }: { e: SlotEvent }) {
  const { kind, text, note } = look(e);
  const [Icon, colour] = LOOKS[kind];
  const time = <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{moment(e.at, Date.now())}</span>;
  if (kind === "state")
    return (
      <li className="flex items-center gap-3 text-xs text-muted-foreground">
        <span className="h-px flex-1 bg-border" />
        {text}
        <span className="h-px flex-1 bg-border" />
        {time}
      </li>
    );
  return (
    <li className="grid gap-1">
      <div className="flex items-start gap-2">
        {Icon ? <Icon className={cn("mt-0.5 size-4 shrink-0", colour)} /> : <span className="size-4 shrink-0" />}
        <div className={cn("min-w-0 flex-1 wrap-anywhere", kind === "error" && "text-destructive")}>
          {kind === "other" && e.data != null ? (
            <details>
              <summary className="cursor-pointer text-xs text-muted-foreground">{text}</summary>
              <Box className="mt-1">{JSON.stringify(e.data)}</Box>
            </details>
          ) : (
            <p className={cn(kind === "message" && "line-clamp-2 whitespace-pre-wrap", kind === "other" && "text-xs text-muted-foreground")}>{text}</p>
          )}
          {note && <p className="text-xs text-muted-foreground">{note}</p>}
        </div>
        {time}
      </div>
      {e.sends?.map((s, i) => (
        <Sent key={i} s={s} />
      ))}
    </li>
  );
}

/** A message sent for an event, under it: two lines, all of it once tapped. Marked only when it was
 *  not sent: a red cross for failed, an amber ? for an unknown outcome, a word while it waits. */
function Sent({ s }: { s: NonNullable<SlotEvent["sends"]>[number] }) {
  const [open, setOpen] = useState(false);
  return (
    <button type="button" onClick={() => setOpen(!open)} className="ml-6 flex items-start gap-1.5 border-l-2 pl-2 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
      {s.status === "failed" && <X className="mt-px size-3.5 shrink-0 text-destructive" aria-label="没发出去" />}
      {s.status === "unknown" && <CircleQuestionMark className="mt-px size-3.5 shrink-0 text-needs" aria-label="结局不明" />}
      {WAITS[s.status] && <span className="shrink-0">{WAITS[s.status]}</span>}
      <span className={cn("min-w-0 wrap-anywhere whitespace-pre-wrap", !open && "line-clamp-2")}>{s.text}</span>
    </button>
  );
}

/** A headless slot's process in a line, and the end of its stderr a tap away when it has some. One that
 *  runs has a key at the right that stops it, its conversation kept (story 270). */
function ProcessLine({ p, slot }: { p: NonNullable<SlotData["process"]>; slot: string }) {
  const [dot, state] = RUNS[p.activeState] ?? ["bg-idle", "已退出"];
  const says = [state, p.activeState === "active" && p.pid && `PID ${p.pid}`, state === "已退出" && p.exitStatus != null && `退出码 ${p.exitStatus}`];
  const [busy, run] = useAct();
  return (
    <div className="grid gap-2 px-4 pb-3">
      <div className="flex min-h-11 items-center gap-2 text-sm">
        <span className={cn("size-2 shrink-0 rounded-full", dot)} />
        {says.filter(Boolean).join("，")}
        {(p.activeState === "active" || p.activeState === "activating") && (
          <button aria-label="停掉进程" disabled={busy} onClick={() => void run({ kind: "rh", argv: ["stop", slot] })} className="-mr-2.5 ml-auto grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground active:bg-muted">
            {busy ? <Spin /> : <Power className="size-4.5" />}
          </button>
        )}
      </div>
      {p.stderr.length > 0 && (
        <details>
          <summary className="cursor-pointer text-sm text-muted-foreground transition-colors hover:text-foreground">错误输出</summary>
          <Box className="mt-1.5 max-h-[40dvh]">{p.stderr.slice(-STDERR_LINES).join("\n")}</Box>
        </details>
      )}
    </div>
  );
}

/** What a duration setting offers, in ms; 0 is never. */
const STEPS = [60_000, 300_000, 600_000, 1_800_000, 3_600_000, 7_200_000, 21_600_000, 86_400_000, 604_800_000, 0];
const SWITCH = "relative h-7 w-12 shrink-0 rounded-full bg-muted transition aria-checked:bg-running hover:not-disabled:brightness-[0.92] disabled:opacity-50 dark:hover:not-disabled:brightness-125";

/** A switch, on or off. */
function Switch({ label, on, busy, set }: { label: string; on: boolean; busy: boolean; set: (on: boolean) => void }) {
  return (
    <button role="switch" aria-label={label} aria-checked={on} disabled={busy} onClick={() => set(!on)} className={SWITCH}>
      <span className={cn("absolute top-1 left-1 size-5 rounded-full bg-white shadow-xs transition-transform", on && "translate-x-5")} />
    </button>
  );
}

/** The slot's settings (story 322), folded above its events: each as rh set has it, changed as you
 *  change it, the one changed from its default with a way back to it; and one-off or long-term. Only
 *  what goes wrong is said: the setting itself shows what went right. */
function Settings({ d }: { d: SlotData }) {
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (key: string, value: string) => {
    setBusy(key);
    const r = await act({ kind: "rh", argv: ["set", d.id, `${key}=${value}`] });
    setBusy(null);
    if (!r.ok) toast(r.error, true);
  };
  const row = (key: string, label: string, control: ReactNode, own: boolean) => (
    <li key={key} className="flex min-h-11 items-center gap-2 text-sm">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {own && (
        <button aria-label={`${label}回到默认`} disabled={busy !== null} onClick={() => void set(key, "default")} className="hover-round grid size-11 shrink-0 place-items-center text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-4" />
        </button>
      )}
      {control}
    </li>
  );
  return (
    <details className="group border-t px-4">
      <summary className="flex h-11 cursor-pointer list-none items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
        设置
      </summary>
      <ul className="grid pb-2">
        {d.settings.map((s) => {
          const now = s.value ?? s.default;
          const control =
            s.kind === "flag" ? (
              <Switch label={s.label} on={now === 1} busy={busy !== null} set={(on) => void set(s.key, on ? "on" : "off")} />
            ) : (
              <select aria-label={s.label} value={now} disabled={busy !== null} onChange={(e) => void set(s.key, `${Number(e.target.value) / 1000}s`)} className="h-9 shrink-0 rounded-lg border bg-background px-2 text-sm transition-colors hover:border-ring/50">
                {[...new Set([...STEPS, now])].toSorted((a, b) => (a || Infinity) - (b || Infinity)).map((ms) => (
                  <option key={ms} value={ms}>
                    {ms ? span(ms) : "从不"}
                  </option>
                ))}
              </select>
            );
          return row(s.key, s.label, control, s.value !== null);
        })}
        {row("lifetime", "一次性", <Switch label="一次性" on={d.lifetime === "oneoff"} busy={busy !== null} set={(on) => void set("lifetime", on ? "oneoff" : "longterm")} />, false)}
      </ul>
    </details>
  );
}
