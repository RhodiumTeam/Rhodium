// Holder units held up over their MemoryHigh (architecture §4.2, #692). The kernel throttles a unit past
// MemoryHigh as a whole, the agent with it, which then takes nothing in and never says so. Rhodium reads
// each running holder unit's memory.pressure every durations.memoryLook; one whose processes all wait
// on memory most of the time is blocked, which the router keeps on its slot and tells you of once.
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { log, type Loop } from "./daemon";
import { memoryText, type Config } from "./config";
import type { Blocked } from "./contracts";
import type { Store } from "./store";

export type Pressure = { avg10: number; avg60: number };

/** The full line of a cgroup's memory.pressure: the share of time all its processes waited on memory,
 *  over the last 10 s and 60 s, in %. null with no such line. */
export function fullPressure(text: string): Pressure | null {
  const m = /^full avg10=([\d.]+) avg60=([\d.]+)/m.exec(text);
  return m ? { avg10: Number(m[1]), avg60: Number(m[2]) } : null;
}

/** Blocked once the last 10 s and the last minute are both at ENTER% or more, so a spike alone is not;
 *  then till the last 10 s drop under LEAVE%, so it does not flap. A unit throttled at its limit with
 *  no swap runs at 60–90% over 10 s; one only shedding page cache stays near 0 (architecture §4.2). */
const ENTER = 40;
const LEAVE = 10;
export const blocked = (was: boolean, p: Pressure): boolean => (was ? p.avg10 >= LEAVE : p.avg10 >= ENTER && p.avg60 >= ENTER);

/** A process by its program's name: its argv[0]'s, or for node the script it runs, as vite's. */
export function programName(argv: string[]): string {
  const name = basename(argv[0] ?? "");
  const script = argv[1];
  return /^node\d*$/.test(name) && script && !script.startsWith("-") ? basename(script).replace(/\.[cm]?js$/, "") : name;
}

const TOP = 2;
const cgroups = new Map<string, string>();

/** The unit's cgroup directory, as systemd has it; asked once per unit. undefined: no such unit. */
async function cgroupOf(unit: string): Promise<string | undefined> {
  const known = cgroups.get(unit);
  if (known) return known;
  const show = Bun.spawn(["systemctl", "--user", "show", "--property=ControlGroup", "--value", `${unit}.service`], { stdout: "pipe", stderr: "ignore" });
  const path = (await new Response(show.stdout).text()).trim();
  if (!path) return undefined;
  cgroups.set(unit, `/sys/fs/cgroup${path}`);
  return cgroups.get(unit);
}

/** The unit's programs by the anonymous memory of their processes, summed by name, biggest first.
 *  Read off the main thread: reading a throttled process's cmdline takes its mmap_lock and can sit in
 *  D state, which a sync read would make the whole daemon wait out. */
async function topOf(dir: string): Promise<Blocked["top"]> {
  const by = new Map<string, number>();
  for (const pid of readFileSync(`${dir}/cgroup.procs`, "utf8").split("\n").filter(Boolean)) {
    try {
      const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
      const name = argv.length ? programName(argv) : (await readFile(`/proc/${pid}/comm`, "utf8")).trim();
      const kb = Number(/^RssAnon:\s+(\d+)/m.exec(await readFile(`/proc/${pid}/status`, "utf8"))?.[1] ?? 0);
      by.set(name, (by.get(name) ?? 0) + kb * 1024);
    } catch {
      // Gone meanwhile.
    }
  }
  return [...by].map(([name, bytes]) => ({ name, bytes })).sort((a, b) => b.bytes - a.bytes).slice(0, TOP);
}

/** What the unit's cgroup says now: its full memory pressure, what it uses, its MemoryHigh, and with
 *  top its biggest programs. null for a unit that is not there, or no longer. */
export async function readUnit(unit: string, top = false): Promise<(Blocked & { pressure: Pressure }) | null> {
  const dir = await cgroupOf(unit);
  if (!dir) return null;
  try {
    const pressure = fullPressure(readFileSync(`${dir}/memory.pressure`, "utf8"));
    if (!pressure) return null;
    const high = readFileSync(`${dir}/memory.high`, "utf8").trim();
    return { pressure, current: Number(readFileSync(`${dir}/memory.current`, "utf8")), high: high === "max" ? null : Number(high), top: top ? await topOf(dir) : [] };
  } catch {
    cgroups.delete(unit); // gone; a holder of the same name later may be elsewhere
    return null;
  }
}

/** Every durations.memoryLook, each headless slot whose agent runs in its holder unit: blocked or free
 *  again, or what a blocked one uses changed, goes to the main loop. A slot kept blocked whose agent
 *  stopped, or that went to the terminal, is free again. A blocked unit's programs are waited for one
 *  memoryLook at most: a read stuck on a throttled process would else hold up this slot's mark and every
 *  later look; past that it is told without them. Returns what stops it. */
export function watchMemory(o: { cfg: Config; store: Store; loop: Loop; read?: typeof readUnit }): () => void {
  const { cfg, store, loop, read = readUnit } = o;
  const programs = (unit: string) =>
    Promise.race([read(unit, true).then((r) => r?.top ?? []), new Promise<Blocked["top"]>((ok) => setTimeout(() => ok([]), cfg.durations.memoryLook))]);
  const look = async () => {
    const slots = store.tx((tx) =>
      tx.find("slot", {}).map((s) => {
        const runs = s.mode === "headless" && s.conversation && s.state !== "off" && s.state !== "crashed";
        const holder = runs ? tx.find("holder", { conversation: s.conversation!, exited: 0 })[0] : undefined;
        return { id: s.id, kept: s.memBlocked, unit: holder?.unit };
      }),
    );
    for (const s of slots) {
      if (!s.unit && !s.kept) continue;
      const was = s.kept ? (JSON.parse(s.kept) as Pick<Blocked, "current" | "high">) : null;
      const r = s.unit ? await read(s.unit) : null;
      if (r && blocked(was !== null, r.pressure)) {
        const top = was ? [] : await programs(s.unit!);
        if (!was || memoryText(was) !== memoryText(r)) loop.enqueue({ kind: "memory", slot: s.id, blocked: { current: r.current, high: r.high, top } });
      } else if (was) loop.enqueue({ kind: "memory", slot: s.id, blocked: null });
    }
  };
  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    look()
      .catch((err) => log("cannot read the holder units' memory", { error: String(err) }))
      .finally(() => (busy = false));
  }, cfg.durations.memoryLook);
  return () => clearInterval(timer);
}
