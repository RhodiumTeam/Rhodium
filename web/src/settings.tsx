// The settings card (spec web-maximize "设置"), opened by a gear at maximize mode's sidebar's foot and
// at the home header's right, and this device's 终端入口 (spec web-write "终端入口"). The header's
// comes apart from the first screen, as the + does.
import { Popover } from "@base-ui/react/popover";
import { useQuery } from "@tanstack/react-query";
import { cn } from "cn";
import { Monitor, Moon, Sun } from "lucide-react";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { THEME, THEMES, useTheme } from "./common";
import { json, type BoardData } from "./data";
import { canRemind, reminding, remindBy } from "./unread";

const THEME_ICON = { system: [Monitor, "跟随系统"], light: [Sun, "浅色"], dark: [Moon, "深色"] } as const;

/** Whether this device shows the ways to switch a slot to the terminal: till turned off here. Storage
 *  that cannot be used keeps them. */
const ENTRY = {
  get: () => {
    try {
      return localStorage.getItem("terminal-entry") !== "off";
    } catch {
      return true;
    }
  },
  set: (on: boolean) => {
    try {
      if (on) localStorage.removeItem("terminal-entry");
      else localStorage.setItem("terminal-entry", "off");
    } catch {}
    entered.forEach((f) => f());
  },
};
const entered = new Set<() => void>();
const useEntry = () => useSyncExternalStore((f) => (entered.add(f), () => void entered.delete(f)), ENTRY.get, ENTRY.get);

/** Whether the board found no Herdr, as /api/board last said: asked here only while nothing has, not
 *  again at every event, as on a phone's chat with no list beside it. */
const useNoHerdr = () => !!useQuery({ queryKey: ["board"], queryFn: () => json<BoardData>("api/board"), enabled: (q) => q.state.data === undefined }).data?.noHerdr;

/** Whether the three ways to switch a slot to the terminal show (the key under where you type, 切到终端
 *  in a row's menu and the topology's): 终端入口 on, and Herdr there. A slot already in the terminal
 *  keeps its own, and /rh_tui typed still goes. */
export function useTerminalEntry(): boolean {
  const on = useEntry();
  const none = useNoHerdr();
  return on && !none;
}

/** A gear that opens the settings card on side of it: over it at the sidebar's foot, under it in the
 *  home's header, its right edge on the header's, not on the gear's box, 4px past it (-mx-1).
 *  children: the gear. */
export function SettingsMenu({ side, className, children }: { side: "top" | "bottom"; className: string; children: ReactNode }) {
  return (
    <Popover.Root>
      <Popover.Trigger aria-label="设置" title="设置" className={className}>
        {children}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side={side} align={side === "top" ? "start" : "end"} alignOffset={side === "top" ? 0 : 4} sideOffset={4} collisionPadding={8} className="z-[70]">
          <Popover.Popup className="grid w-64 gap-3 rounded-xl border bg-popover p-3 text-sm text-popover-foreground shadow-lg outline-none transition-opacity data-ending-style:opacity-0 data-starting-style:opacity-0">
            <SettingsCard />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** An on-off switch of the card, greyed where it cannot be pressed. */
function Toggle({ label, on, disabled, set }: { label: string; on: boolean; disabled?: boolean; set: () => void }) {
  return (
    <button role="switch" aria-checked={on} aria-label={label} disabled={disabled} onClick={set} className="group mr-0.5 h-5 w-9 rounded-full bg-input p-0.5 transition-colors aria-checked:bg-running disabled:opacity-50">
      {/* White, as the slot's settings' switches: the page's ground would melt into the dark track. */}
      <span className="block size-4 rounded-full bg-white shadow-xs transition-transform group-aria-checked:translate-x-4" />
    </button>
  );
}

/** The settings card: the theme; where the page can show one, whether this device reminds you as turns
 *  end, turned on with no leave yet asking for it in that click, denied saying where to allow it again,
 *  as the page cannot ask once more; and 终端入口, greyed with no Herdr. */
function SettingsCard() {
  const theme = useTheme();
  const [can] = useState(canRemind);
  const [leave, setLeave] = useState(() => (can ? Notification.permission : "denied"));
  const [on, setOn] = useState(reminding);
  const checked = on && leave === "granted";
  const entry = useEntry();
  const noHerdr = useNoHerdr();
  return (
    <>
      <div className="flex items-center justify-between">
        主题
        <div className="inline-flex overflow-hidden rounded-lg border">
          {THEMES.map((t) => {
            const [Icon, label] = THEME_ICON[t];
            return (
              <button key={t} aria-label={label} title={label} aria-pressed={theme === t} onClick={() => THEME.set(t)} className={cn("grid h-8 w-9 place-items-center transition-colors", theme === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground")}>
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </div>
      {can && (
        <div>
          <div className="flex items-center justify-between">
            通知
            <Toggle
              label="通知"
              on={checked}
              disabled={leave === "denied"}
              set={async () => {
                const now = await remindBy(!checked);
                setOn(!checked);
                setLeave(now);
              }}
            />
          </div>
          {leave === "denied" && <p className="mt-1 text-xs text-muted-foreground">要在浏览器的网站设置里重新允许</p>}
        </div>
      )}
      <div>
        <div className="flex items-center justify-between">
          终端入口
          <Toggle label="终端入口" on={entry && !noHerdr} disabled={noHerdr} set={() => ENTRY.set(!entry)} />
        </div>
        {noHerdr && <p className="mt-1 text-xs text-muted-foreground">没装 Herdr</p>}
      </div>
    </>
  );
}
