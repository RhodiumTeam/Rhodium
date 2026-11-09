// The asks waiting on you, as cards under the chat in place of its bar (spec web-write "提问"): each
// answered here as you would reply in IM, which hears it was answered here.
import { cn } from "cn";
import { ArrowUp, ClipboardList, Hand, LoaderCircle, MessageCircleQuestionMark, ShieldQuestionMark, Square, SquareCheck } from "lucide-react";
import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import type { AskCard } from "../../src/asks";
import { clock } from "./common";
import { buttonVariants } from "./components/ui/button";
import type { SlotData } from "./data";
import { KIND } from "./details";
import { MARKDOWN } from "./tools";
import { toast } from "./toast";
import { act, StopKey, useEdges } from "./write";

type Ask = SlotData["asks"][number];
type Questions = Extract<AskCard, { questions: unknown }>["questions"];
type YesNo = Exclude<AskCard, { questions: unknown }>;

/** No words for what kind of ask it is: its icon says it. */
const ICON = { question: MessageCircleQuestionMark, permission: ShieldQuestionMark, plan: ClipboardList, confirm: Hand };
/** How long the line saying an ask is gone stays (story 293). */
const GONE_FOR = 4_000;

/** What a question card sends (story 289), as you would reply in IM: your own words, else the numbers
 *  of the options picked, space apart; several questions a line each. picked and own: by question.
 *  null while one has neither. */
export function answerText(picked: number[][], own: string[]): string | null {
  const several = picked.length > 1;
  const lines = picked.map((p, i) => (several ? own[i]!.replace(/\s+/g, " ") : own[i]!).trim() || p.toSorted((a, b) => a - b).join(" "));
  return lines.every(Boolean) ? lines.join("\n") : null;
}

/** The slot's asks waiting on you, oldest first, a card each; the top one has the stop key while a
 *  turn runs (story 264). One this page showed that went meanwhile, answered elsewhere or timed out,
 *  or one gone by the time its answer from here came, leaves a line saying where or why for a few
 *  seconds (story 293). An answer that fails otherwise leaves the card as it was, and says why. */
export function Asks({ d, turn }: { d: SlotData; turn: boolean }) {
  // Shown here, and not answered here: the ones whose going this page says.
  const [shown] = useState(() => new Set<string>());
  const [lines, setLines] = useState<{ id: string; why: string }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const gone = (id: string, why: string) => {
    shown.delete(id);
    setLines((l) => [...l, { id, why }]);
    setTimeout(() => setLines((l) => l.filter((x) => x.id !== id)), GONE_FOR);
  };
  useEffect(() => {
    for (const g of d.gone) if (shown.has(g.id)) gone(g.id, g.why);
    for (const a of d.asks) shown.add(a.id);
  }, [d]);
  const answer = (a: Ask, text: string) => {
    shown.delete(a.id); // its answer from here says so itself
    setBusy(a.id);
    void act({ kind: "answer", ask: a.id, text }).then((r) => {
      setBusy(null);
      if (r.ok) return void (r.text && toast(r.text));
      if (r.gone) return gone(a.id, r.error);
      shown.add(a.id);
      toast(r.error, true);
    });
  };
  const asks = d.asks.filter((a) => !lines.some((l) => l.id === a.id));
  if (!asks.length && !lines.length) return null;
  return (
    <div className="card-scroll max-h-[60dvh] overflow-y-auto border-t px-4 pt-3 pb-2">
      <div className="mx-auto grid max-w-3xl gap-2">
        {lines.map((l) => (
          <p key={l.id} className="rounded-lg border border-dashed px-3 py-2 text-sm text-muted-foreground">
            {l.why}
          </p>
        ))}
        {asks.map((a, i) => (
          <Card key={a.id} a={a} stop={turn && i === 0 ? d.id : undefined} busy={busy === a.id} send={(text) => answer(a, text)} />
        ))}
      </div>
    </div>
  );
}

/** An ask's card: its icon, what it asks, when it times out, the stop key on the top one; then how to answer. */
function Card({ a, stop, busy, send }: { a: Ask; stop?: string; busy: boolean; send: (text: string) => void }) {
  const Icon = ICON[a.kind];
  const c = a.card;
  const qs = "questions" in c ? c.questions : null;
  // One question asks itself at the top; several each head their options.
  const head = "questions" in c ? (c.questions.length === 1 ? c.questions[0]!.question : "") : c.head;
  return (
    <section aria-label={KIND[a.kind]} className="rounded-lg border border-l-4 border-l-needs bg-card px-3 py-2 text-sm">
      <div className="flex items-start gap-2">
        <Icon className="mt-0.5 size-4 shrink-0 text-needs" />
        <p className="min-w-0 flex-1 font-medium whitespace-pre-wrap wrap-anywhere">{head}</p>
        {a.deadline !== null && <span className="mt-0.5 shrink-0 text-xs text-muted-foreground tabular-nums">{clock(a.deadline)} 超时</span>}
        {stop && <StopKey slot={stop} className="-my-2.5 -mr-1.5" />}
      </div>
      {qs ? <Choose qs={qs} busy={busy} send={send} /> : <Decide c={c as YesNo} busy={busy} send={send} />}
    </section>
  );
}

const field = "h-11 min-w-0 flex-1 rounded-md border bg-background px-3 text-base outline-none transition-colors hover:border-ring/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50";

/** The send key, which spins while the answer is on its way. */
const Send = ({ busy, ok }: { busy: boolean; ok: boolean }) => (
  <button type="submit" aria-label="发送" disabled={busy || !ok} className="group focus-child grid size-11 shrink-0 place-items-center disabled:opacity-50">
    <span className="grid size-9 place-items-center rounded-full bg-primary text-primary-foreground transition-colors group-enabled:group-hover:bg-primary/80">{busy ? <LoaderCircle className="size-4 animate-spin" /> : <ArrowUp className="size-4" />}</span>
  </button>
);

/** A question's options as buttons, or your own words, for each question (story 289). A single choice
 *  answers as you tap; several, or more than one question, once sent. */
function Choose({ qs, busy, send }: { qs: Questions; busy: boolean; send: (text: string) => void }) {
  const [picked, setPicked] = useState(() => qs.map((): number[] => []));
  const [own, setOwn] = useState(() => qs.map(() => ""));
  const tap = qs.length === 1 && !qs[0]!.multi;
  const text = answerText(picked, own);
  const pick = (i: number, n: number) => {
    if (tap) return send(String(n));
    const multi = qs[i]!.multi;
    setPicked((p) => p.map((was, j) => (j !== i ? was : was.includes(n) ? was.filter((x) => x !== n) : multi ? [...was, n] : [n])));
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (text && !busy) send(text);
  };
  return (
    <form onSubmit={submit} className="grid gap-3 pt-2">
      {qs.map((q, i) => (
        <fieldset key={i} disabled={busy} className="grid gap-2">
          {qs.length > 1 && <legend className="mb-2 font-medium whitespace-pre-wrap wrap-anywhere">{q.question}</legend>}
          <div className="flex flex-wrap gap-2">
            {q.options.map((o, j) => {
              const on = picked[i]!.includes(j + 1);
              return (
                <Option key={j} on={on} press={!tap} box={q.multi} onClick={() => pick(i, j + 1)}>
                  {o.label}
                  {o.description && <span className="text-xs font-normal opacity-70">{o.description}</span>}
                </Option>
              );
            })}
          </div>
          <div className="flex items-center gap-1">
            <input value={own[i]} onChange={(e) => setOwn((w) => w.map((was, j) => (j === i ? e.target.value : was)))} placeholder="自己写" aria-label="自己写" className={field} />
            {i === qs.length - 1 && <Send busy={busy} ok={!!text} />}
          </div>
        </fieldset>
      ))}
    </form>
  );
}

/** An option: one to tap, or one to pick, pressed while picked; box: one of several to pick, a box
 *  ticked while picked (story 289). */
function Option({ on, press, box, onClick, children }: { on: boolean; press: boolean; box: boolean; onClick: () => void; children: ReactNode }) {
  const Box = on ? SquareCheck : Square;
  return (
    <button
      type="button"
      aria-pressed={press ? on : undefined}
      onClick={onClick}
      className={cn(buttonVariants({ variant: on ? "default" : "outline" }), "h-auto min-h-11 max-w-full items-start gap-2 px-3 py-1.5 text-left whitespace-normal wrap-anywhere")}
    >
      {box && <Box className="mt-0.5" />}
      <span className="flex min-w-0 flex-col">{children}</span>
    </button>
  );
}

/** An approval, a plan or a confirm request: what it is about, then its no and yes; a no with a
 *  reason where that reaches whoever asks (story 290). */
function Decide({ c, busy, send }: { c: YesNo; busy: boolean; send: (text: string) => void }) {
  const [why, setWhy] = useState("");
  const no = () => send(why.trim() ? `2 ${why.trim()}` : "2");
  return (
    <div className="grid gap-2 pt-2">
      {c.body &&
        (c.markdown ? (
          <Plan body={c.body} />
        ) : (
          <pre className="card-scroll max-h-40 overflow-auto rounded-md bg-muted px-2.5 py-1.5 font-mono text-xs whitespace-pre-wrap wrap-anywhere">{c.body}</pre>
        ))}
      {c.told && <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="理由" aria-label="理由" disabled={busy} className={field} />}
      <div className="flex gap-2">
        <button type="button" disabled={busy} onClick={no} className={cn(buttonVariants({ variant: "outline" }), "h-11 flex-1")}>
          {c.no}
        </button>
        <button type="button" disabled={busy} onClick={() => send("1")} className={cn(buttonVariants(), "h-11 flex-1")}>
          {busy && <LoaderCircle className="animate-spin" />}
          {c.yes}
        </button>
      </div>
    </div>
  );
}

/** A plan, in Markdown: in no box round the boxes of its tables and code, on the board's thin bar, its
 *  ends faded while there is more that way (#557). The bar, where it takes room, sits in the card's
 *  right padding, so the tables and code line up with the reason and the keys below. Its headings no
 *  bigger than the card's words. */
function Plan({ body }: { body: string }) {
  const scroller = useEdges<HTMLDivElement>();
  return (
    <div {...scroller} className="card-scroll edge-fade-y -mr-(--bar) max-h-[35dvh] overflow-y-auto [&_:is(h1,h2,h3,h4)]:mt-3 [&_:is(h1,h2,h3,h4)]:text-base">
      <Streamdown mode="static" {...MARKDOWN}>
        {body}
      </Streamdown>
    </div>
  );
}
