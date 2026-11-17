// A Bot's menu on the topology (spec web-bots stories 681-684): a right click on its node, a finger
// held on it on a phone. 添加小号 shows a pairing code to send it from another account of yours; 主人
// lists its owners, a paired one taken off by a key; 删除 Bot asks first. The two that take no typing
// are dialogs in the middle on a phone too; 添加小号 is the new-slot sheet's Form.
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog } from "@base-ui/react/dialog";
import { useQuery } from "@tanstack/react-query";
import { Check, Clock, Copy, Lock, Trash2, UserPlus, Users, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { OwnersData } from "../../src/board";
import { buttonVariants } from "./components/ui/button";
import { Form } from "./create";
import { json, queryClient, seen, type TopologyData } from "./data";
import { Face, KindMark } from "./faces";
import { toast } from "./toast";
import { act, Asks, MenuAt, Spin, useAct } from "./write";

type Bot = TopologyData["bots"][number];

/** The menu of bot at at, null: closed; and what its choices open, which stay as it closes. */
export function BotMenu({ bot, at, close }: { bot: Bot; at: { x: number; y: number } | null; close: () => void }) {
  const [open, setOpen] = useState<"pair" | "owners" | "rm" | null>(null);
  const shut = (o: boolean) => o || setOpen(null);
  return (
    <>
      <MenuAt
        at={at}
        close={close}
        head={<div className="truncate px-3 pt-2 pb-1 text-xs font-medium text-muted-foreground">{bot.name}</div>}
        choices={[
          { icon: UserPlus, label: "添加小号", run: () => setOpen("pair") },
          { icon: Users, label: "主人", run: () => setOpen("owners") },
          { icon: Trash2, label: "删除 Bot", apart: true, danger: true, off: bot.main ? "主 Bot 不能删除" : undefined, run: () => setOpen("rm") },
        ]}
      />
      <Pairing bot={bot} open={open === "pair"} close={() => setOpen(null)} />
      <Owners bot={bot} open={open === "owners"} onOpenChange={shut} />
      <AlertDialog.Root open={open === "rm"} onOpenChange={shut}>
        <Asks title={`删除 ${bot.name}？`} sub="其相关的聊天窗口和槽位绑定也将永久删除">
          <AlertDialog.Close className={buttonVariants({ variant: "outline", size: "lg" })}>取消</AlertDialog.Close>
          <AlertDialog.Close onClick={() => void act({ kind: "rh", argv: ["bot", "rm", bot.id] }).then((r) => !r.ok && toast(r.error, true))} className={buttonVariants({ variant: "destructive", size: "lg" })}>
            删除
          </AlertDialog.Close>
        </Asks>
      </AlertDialog.Root>
    </>
  );
}

/** m:ss of ms, none under 0. */
const mss = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** 添加小号 (story 682): rh pair --add's code, as it is, to send the bot from another account of yours,
 *  and how long it has, from the pair_code event; paired, it says so and closes. */
function Pairing({ bot, open, close }: { bot: Bot; open: boolean; close: () => void }) {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCode(null);
    setError(null);
    setUntil(null);
    setCopied(false);
    // Heard before it is asked for: its pair_code may come before the answer does.
    const hear = (e: { type: string; data: unknown }) => {
      const d = e.data as { id?: string; until?: number } | null;
      if (d?.id !== bot.id) return;
      if (e.type === "pair_code") setUntil(d.until ?? null);
      if (e.type === "bot_paired") (toast("已配对"), close());
    };
    seen.add(hear);
    void act({ kind: "rh", argv: ["pair", bot.id, "--add"] }).then((r) => (r.ok ? setCode(/配对码：(\S+)/.exec(r.text)?.[1] ?? null) : setError(r.error)));
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => (seen.delete(hear), clearInterval(tick));
  }, [open]);
  return (
    <Form open={open} close={close} title="添加小号" error={error} submit={() => {}}>
      {code ? (
        <div className="grid justify-items-center gap-3 py-2">
          <div className="flex items-center gap-2">
            <span className="font-mono text-4xl font-semibold tracking-wider">{code}</span>
            {/* Not the chat's CopyKey: its file brings the chat's Markdown into the topology's part. */}
            <button type="button" aria-label="复制" onClick={() => navigator.clipboard.writeText(code).then(() => setCopied(true), () => toast("没能复制。", true))} className="grid size-11 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
              {copied ? <Check className="size-5" /> : <Copy className="size-5" />}
            </button>
          </div>
          <p>私聊 {bot.name}，发送这个码</p>
          {until !== null && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground tabular-nums">
              <Clock className="size-4" />
              {mss(until - now)}
            </span>
          )}
        </div>
      ) : (
        !error && (
          <div className="grid place-items-center py-6 text-muted-foreground">
            <Spin />
          </div>
        )
      )}
    </Form>
  );
}

/** 主人 (story 683): each owner by its avatar and name, or its code with none; the config's locked, a
 *  paired one with a key to take it off. In the middle, a phone's too: nothing to type. */
function Owners({ bot, open, onOpenChange }: { bot: Bot; open: boolean; onOpenChange: (open: boolean) => void }) {
  const key = ["owners", bot.id];
  const { data } = useQuery({ queryKey: key, queryFn: () => json<OwnersData>(`api/bots/owners?bot=${encodeURIComponent(bot.id)}`), enabled: open });
  const [busy, run] = useAct();
  // Focus on the dialog itself, not ringing its close key as it opens.
  const popup = useRef<HTMLDivElement>(null);
  const drop = (code: string) => void run({ kind: "rh", argv: ["pair", bot.id, "--rm", code] }).then(() => queryClient.invalidateQueries({ queryKey: key }));
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <Dialog.Popup ref={popup} initialFocus={popup} className="fixed top-1/2 left-1/2 z-50 flex max-h-[85dvh] w-[min(24rem,calc(100vw-2rem))] -translate-1/2 flex-col rounded-2xl border bg-popover text-sm text-popover-foreground shadow-lg outline-none transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0">
          <div className="flex items-center gap-2.5 py-1 pr-1 pl-4">
            <Face url={bot.avatar} p={bot.platform} size={24} ring="ring-popover" />
            <Dialog.Title className="min-w-0 flex-1 truncate text-base font-medium">主人</Dialog.Title>
            <Dialog.Close aria-label="关闭" className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground">
              <X className="size-5" />
            </Dialog.Close>
          </div>
          {data ? (
            <ul className="overflow-y-auto px-2 pb-2">
              {data.owners.map((o) => (
                <li key={o.id} className="flex h-12 items-center gap-2.5 pr-0 pl-2">
                  {o.avatar ? <img src={o.avatar} alt="" className="size-8 shrink-0 rounded-full object-cover" /> : <KindMark kind="private" size={32} />}
                  <span className={o.name ? "min-w-0 flex-1 truncate" : "min-w-0 flex-1 truncate font-mono text-muted-foreground"}>{o.name ?? o.id}</span>
                  {o.fixed ? (
                    <Lock role="img" aria-label="配置里的" className="mx-3.5 size-4 shrink-0 text-muted-foreground" />
                  ) : (
                    <button aria-label="去掉" disabled={busy} onClick={() => drop(o.id)} className="grid size-11 shrink-0 place-items-center rounded-lg text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-50">
                      <X className="size-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <div className="grid place-items-center pb-6 text-muted-foreground">
              <Spin />
            </div>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
