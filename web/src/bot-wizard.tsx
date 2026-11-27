// The new bot's wizard (spec web-bots stories 670-679): a screen a step, in the sheet new slots have.
// Step 1 picks the platform, the name and the slot it delivers to, and starts rhodium's bot-making flow
// (architecture §8.5.1); then the flow's state is the screen: a QR code to scan, a box to paste into, a
// pairing code, or 创建成功. The page reads the flow again as the event stream says it changed. Closed,
// the flow is cancelled.
import { Field } from "@base-ui/react/field";
import { Select } from "@base-ui/react/select";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { ArrowRight, Check, ChevronsUpDown, Clock, Eye, EyeOff, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { FlowView as Full } from "../../src/bot-flow";
import type { Made } from "../../src/platforms";
import type { RhReply } from "../../src/router";
import { AgentLogo } from "./common";
import { buttonVariants } from "./components/ui/button";
import { FIELD, Form, Submit } from "./create";
import { json, queryClient, type BoardData, type Card, type TopologyData } from "./data";
import { Mark } from "./faces";
import { CopyKey, post } from "./write";

/** A flow as the board answers it: without the lines rh shows at the terminal. */
type FlowView = Omit<Full, "log">;

const PLATFORMS: { p: Made; label: string }[] = [
  { p: "qq", label: "QQ" },
  { p: "telegram", label: "Telegram" },
  { p: "feishu", label: "飞书" },
];
/** A bot's name, as the router takes one. */
const NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** A new bot's name at first (story 672): the platform's, -2, -3... after it while taken. */
export function botName(platform: string, taken: string[]): string {
  const has = new Set(taken);
  if (!has.has(platform)) return platform;
  for (let n = 2; ; n++) if (!has.has(`${platform}-${n}`)) return `${platform}-${n}`;
}

/** The slot 投递给 starts on (story 672): the main bot's, else the one used last; ids of live slots. */
export function startTarget(slots: Pick<Card, "id" | "activeAt">[], bots: Pick<TopologyData["bots"][number], "main" | "target">[]): string | undefined {
  const main = bots.find((b) => b.main)?.target;
  if (main && slots.some((s) => s.id === main)) return main;
  return slots.reduce<Pick<Card, "id" | "activeAt"> | undefined>((a, s) => (!a || s.activeAt > a.activeAt ? s : a), undefined)?.id;
}

/** Its step, of how many (story 673): a scan's two, a paste's three; a scan that brought no account back pairs too. */
const steps = (paste: boolean, f: FlowView | undefined) => (paste || f?.state === "pairing" ? 3 : 2);

/** Whether rhodium's answer, once there is one, is a flow that ended, or none at all. */
const over = (r: RhReply | undefined) => !!r && (!r.ok || !r.flow || ["done", "failed", "cancelled"].includes(r.flow.state));

const call = (method: string, path: string, body?: object) => post(path, { method, ...(body && { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }) });

/** The wizard. open: whether it shows; close: told it closed, the flow cancelled. */
export function BotWizard({ open, close }: { open: boolean; close: () => void }) {
  const board = useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), enabled: open }).data;
  const topology = useQuery({ queryKey: ["topology"], queryFn: () => json<TopologyData>("api/topology"), enabled: open }).data;
  const slots = (board?.workspaces ?? []).flatMap((w) => Object.values(w.groups).flat()).sort((a, b) => a.ref.localeCompare(b.ref));
  const [platform, setPlatform] = useState<Made>("qq");
  // null: as yet untouched, the default.
  const [typed, setName] = useState<string | null>(null);
  const [picked, setTarget] = useState<string | null>(null);
  const [paste, setPaste] = useState(false);
  const [id, setId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Whether there was a main chat as the flow started: none, the bot made may be it now (story 680).
  const [hadMain, setHadMain] = useState(true);
  const name = typed ?? botName(platform, topology?.bots.map((b) => b.name) ?? []);
  const target = picked ?? startTarget(slots, topology?.bots ?? []) ?? null;
  // Ended, it is read no more: rhodium forgets it after a while, or as it restarts, and a refresh would
  // then find no flow where the bot was made.
  const reply = useQuery({ queryKey: ["bot-flow", id], queryFn: () => json<RhReply>(`api/bots/flow?id=${encodeURIComponent(id!)}`), enabled: (q) => !!id && !over(q.state.data) }).data;
  const live = reply?.ok ? reply.flow : undefined;
  // Cancelled, as it closes or turns to pasting: the screen it was on stays till it goes, not 创建成功.
  const [last, keep] = useState<FlowView>();
  if (live && live.state !== "cancelled" && live !== last) keep(live);
  const flow = live?.state === "cancelled" ? last : live;
  const state = flow?.state;

  // Opened again, it starts afresh.
  const [was, setWas] = useState(open);
  if (open !== was) {
    setWas(open);
    if (open) (setPlatform("qq"), setName(null), setTarget(null), setPaste(false), setId(null), setError(null));
  }
  // Failed, or gone with a restart: back to step 1, saying why.
  const lost = (reply && !reply.ok && reply.error) || (state === "failed" && (flow!.error ?? "没建成。"));
  useEffect(() => {
    if (lost) (setId(null), setError(lost));
  }, [lost]);
  // Done: the topology shows the bot, and whether its chat is the main one now.
  useEffect(() => void (state === "done" && queryClient.invalidateQueries({ queryKey: ["topology"] })), [state]);

  const ended = over(reply);
  const cancel = () => void (id && !ended && call("DELETE", `api/bots/flow?id=${encodeURIComponent(id)}`));
  const shut = () => (cancel(), close());
  const back = () => (cancel(), setId(null), setError(null));
  const start = async (paste: boolean) => {
    setBusy(true);
    setError(null);
    setHadMain(!!topology?.bots.some((b) => b.main));
    // --paste is Feishu's choice of pasting over scanning; Telegram pastes its token without it.
    const r = await call("POST", "api/bots/flow", { name, platform, ...(target && { target }), paste: paste && platform !== "telegram" });
    setBusy(false);
    if (!r.ok || !r.flow) return setError(r.ok ? "没建成。" : r.error);
    queryClient.setQueryData(["bot-flow", r.flow.id], r);
    setPaste(paste);
    setId(r.flow.id);
  };
  const of = steps(paste || platform === "telegram", flow);
  const form = { open, close: shut, error, submit: () => {} };

  if (!id || !flow)
    return (
      <Form {...form} title="新建 Bot" step={`第 1 / ${steps(platform === "telegram", undefined)} 步`} submit={() => void (NAME.test(name) && target && start(platform === "telegram"))}>
        <div className="flex items-end gap-2">
          <div role="radiogroup" aria-label="平台" className="flex shrink-0 overflow-hidden rounded-lg border">
            {PLATFORMS.map(({ p, label }) => (
              <button key={p} type="button" role="radio" aria-label={label} aria-checked={platform === p} onClick={() => setPlatform(p)} className={cn("focus-child grid size-11 place-items-center transition focus-visible:opacity-100", platform === p ? "bg-secondary" : "opacity-40 grayscale hover:opacity-70")}>
                <Mark p={p} size={22} />
              </button>
            ))}
          </div>
          <Field.Root invalid={!!name && !NAME.test(name)} className="grid min-w-0 flex-1 gap-1">
            <Field.Label className="text-xs text-muted-foreground">名称</Field.Label>
            <Field.Control value={name} onValueChange={setName} autoCapitalize="off" autoComplete="off" spellCheck={false} className={FIELD} />
          </Field.Root>
        </div>
        {name && !NAME.test(name) && <p className="-mt-1 text-sm text-destructive">名称只能用英文字母、数字和 _ -</p>}
        <Field.Root className="grid gap-1">
          <Field.Label className="text-xs text-muted-foreground">投递给</Field.Label>
          <SlotSelect slots={slots} value={target} pick={setTarget} />
        </Field.Root>
        <Submit busy={busy} disabled={!NAME.test(name) || !target}>
          下一步
        </Submit>
      </Form>
    );

  if (state === "scan" || (state === "writing" && !paste))
    return (
      <Form {...form} title="扫码" step={`第 2 / ${of} 步`} back={back}>
        <Scan flow={flow} />
        {platform === "feishu" && (
          <button type="button" onClick={() => (cancel(), void start(true))} className="mx-auto -mt-1 h-9 px-2 text-sm text-muted-foreground transition-colors hover:text-foreground">
            改为粘贴 App ID 和密钥
          </button>
        )}
      </Form>
    );

  if (state === "paste" || state === "checking" || state === "writing")
    return <Paste flow={flow} form={form} back={back} of={of} />;

  if (state === "pairing")
    return (
      <Form {...form} title="配对" step={`第 3 / ${of} 步`}>
        <Pairing code={flow.code ?? ""} until={flow.until ?? 0} bot={flow.name} />
      </Form>
    );

  // done.
  const main = !hadMain && !!topology?.bots.some((b) => b.main && b.name === flow.name);
  const to = slots.find((s) => s.ref === flow.target);
  return (
    <Form {...form} title="创建成功" submit={close}>
      <div className="grid justify-items-center gap-2 py-2">
        <Mark p={flow.platform} size={48} />
        <p className="text-lg font-medium">{flow.name}</p>
        {flow.target && (
          <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <ArrowRight aria-label="投递给" className="size-4" />
            {to?.agent && <AgentLogo agent={to.agent} className="size-4" />}
            {flow.target}
          </p>
        )}
        {main && (
          <p className="flex items-center gap-1 text-sm text-running">
            <Check className="size-4" />
            已设为主窗口
          </p>
        )}
      </div>
      <Submit busy={false} disabled={false}>
        完成
      </Submit>
    </Form>
  );
}

/** 投递给: a live slot, each by its agent's logo and full name. */
function SlotSelect({ slots, value, pick }: { slots: Card[]; value: string | null; pick: (id: string) => void }) {
  const items = slots.map((s) => ({ value: s.id, label: s.ref }));
  const row = (s: Card) => (
    <>
      {s.agent && <AgentLogo agent={s.agent} className="size-4 shrink-0" />}
      <span className="truncate">{s.ref}</span>
    </>
  );
  const at = slots.find((s) => s.id === value);
  return (
    <Select.Root items={items} value={value} onValueChange={(v) => v && pick(v)}>
      <Select.Trigger className={cn(FIELD, "flex items-center gap-2 text-left")}>
        <Select.Value className="flex min-w-0 flex-1 items-center gap-2">{() => (at ? row(at) : null)}</Select.Value>
        <Select.Icon className="text-muted-foreground">
          <ChevronsUpDown className="size-4" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Positioner alignItemWithTrigger={false} sideOffset={4} collisionPadding={8} className="z-[70]">
          <Select.Popup className="max-h-[min(var(--available-height),20rem)] w-(--anchor-width) overflow-y-auto rounded-xl border bg-popover p-1 text-sm text-popover-foreground shadow-lg outline-none">
            {slots.map((s) => (
              <Select.Item key={s.id} value={s.id} className="flex h-11 cursor-default items-center gap-2 rounded-lg px-3 outline-none select-none data-highlighted:bg-muted">
                <Select.ItemText className="flex min-w-0 flex-1 items-center gap-2">{row(s)}</Select.ItemText>
                <Select.ItemIndicator>
                  <Check className="size-4 text-running" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Popup>
        </Select.Positioner>
      </Select.Portal>
    </Select.Root>
  );
}

/** The scan (story 674): 在 QQ 里打开 and its link to copy on top, the QR code and 等你扫码 under them. */
function Scan({ flow }: { flow: FlowView }) {
  const open = flow.platform === "feishu" ? "在飞书里打开" : "在 QQ 里打开";
  return (
    <>
      <div className="flex gap-2">
        {/* Greyed till the first QR code comes with its link. */}
        <a href={flow.url} aria-disabled={!flow.url} target="_blank" rel="noreferrer" className={buttonVariants({ size: "lg", className: cn("h-11 flex-1 text-base", !flow.url && "pointer-events-none opacity-50") })}>
          {open}
        </a>
        <CopyKey text={flow.url ?? ""} disabled={!flow.url} className={buttonVariants({ variant: "outline", size: "icon-lg", className: "size-11 shrink-0" })} icon="size-4" />
      </div>
      {flow.svg && <img alt="二维码" src={`data:image/svg+xml;utf8,${encodeURIComponent(flow.svg)}`} className="mx-auto size-56 rounded-md" />}
      <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 animate-spin" />
        {flow.state === "writing" ? "正在写入" : "等你扫码"}
      </p>
    </>
  );
}

/** A secret's box (story 676): the browser's own password field, with an eye to show it once. */
function Secret({ label, value, set, error }: { label: string; value: string; set: (v: string) => void; error?: string }) {
  const [shown, show] = useState(false);
  return (
    <Field.Root invalid={!!error} className="grid gap-1">
      <Field.Label className="text-xs text-muted-foreground">{label}</Field.Label>
      <div className="relative">
        <Field.Control type={shown ? "text" : "password"} value={value} onValueChange={set} autoComplete="off" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={cn(FIELD, "pr-11 font-mono")} />
        <button type="button" aria-label={shown ? "隐藏" : "显示"} aria-pressed={shown} onClick={() => show(!shown)} className="absolute inset-y-0 right-0 grid w-11 place-items-center text-muted-foreground hover:text-foreground">
          {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {error && <Field.Error match className="text-sm whitespace-pre-wrap wrap-anywhere text-destructive">{error}</Field.Error>}
    </Field.Root>
  );
}

/** What is pasted (story 676): Telegram's token, or Feishu's App ID and secret, checked by rhodium; why
 *  not under the box. */
function Paste({ flow, form, back, of }: { flow: FlowView; form: { open: boolean; close: () => void }; back: () => void; of: number }) {
  const feishu = flow.platform === "feishu";
  const [token, setToken] = useState("");
  const [appId, setAppId] = useState("");
  const [secret, setSecret] = useState("");
  const [why, setWhy] = useState<string | undefined>();
  const checking = flow.state !== "paste";
  const submit = async () => {
    setWhy(undefined);
    const r = await call("POST", "api/bots/flow/credentials", { id: flow.id, ...(feishu ? { appId: appId.trim(), secret: secret.trim() } : { token: token.trim() }) });
    if (!r.ok) setWhy(r.error);
    void queryClient.invalidateQueries({ queryKey: ["bot-flow", flow.id] });
  };
  const error = why ?? flow.error;
  return (
    <Form {...form} error={null} title={feishu ? "填写 App ID 和密钥" : "填写 token"} step={`第 2 / ${of} 步`} back={back} submit={() => void (!checking && submit())}>
      {feishu ? (
        <>
          <Field.Root className="grid gap-1">
            <Field.Label className="text-xs text-muted-foreground">App ID</Field.Label>
            <Field.Control value={appId} onValueChange={setAppId} autoComplete="off" autoCapitalize="off" spellCheck={false} className={cn(FIELD, "font-mono")} />
          </Field.Root>
          <Secret label="密钥" value={secret} set={setSecret} error={error} />
        </>
      ) : (
        <Secret label="token" value={token} set={setToken} error={error} />
      )}
      <Submit busy={checking} disabled={feishu ? !appId.trim() || !secret.trim() : !token.trim()}>
        下一步
      </Submit>
    </Form>
  );
}

/** The time a moment ago, as now, then each second. */
function useNow() {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

/** The pairing screen (story 678): the code as it is, a key to copy it, what to do with it, and how
 *  long it works. bot: the name to send it to. */
export function Pairing({ code, until, bot }: { code: string; until: number; bot: string }) {
  const left = Math.max(0, Math.ceil((until - useNow()) / 1000));
  return (
    <div className="grid justify-items-center gap-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-3xl font-semibold tracking-wider">{code}</span>
        <CopyKey text={code} className={buttonVariants({ variant: "outline", size: "icon-lg", className: "size-11 shrink-0" })} icon="size-4" />
      </div>
      <p className="text-sm">私聊 {bot}，发送这个码</p>
      <p className="flex items-center gap-1.5 text-sm text-muted-foreground tabular-nums">
        <Clock aria-label="还剩" className="size-4" />
        {`${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
      </p>
    </div>
  );
}
