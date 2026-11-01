// Holders (architecture §4): launch one per headless conversation through systemd,
// and speak hold/1 to it. The holder itself is the Rust binary rh-hold (holder/).
import { rmSync, statSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { Config } from "./config";
import type { AgentLink, SpawnSpec } from "./contracts";
import { decodeHold, encodeHold, HOLD_PROTO, type HoldMessage } from "./hold";
import type { Store } from "./store";

/** Where a conversation's holder keeps its files (architecture §4.3), and its unit. */
export function holderPaths(cfg: Config, conversation: string) {
  return {
    unit: `${cfg.unitPrefix}hold-${conversation}`,
    dir: join(cfg.stateDir, "hold", conversation),
    sock: join(cfg.socketDir, "hold", `${conversation}.sock`),
    lock: join(cfg.lockDir, conversation),
  };
}

// Paths go into unit settings unquoted: absolute, and only characters systemd takes literally.
const plainPath = /^\/[\w/.,+:@-]*$/;

/** Waits until systemd no longer has the unit, in whatever state, its ExecStopPost done. False if
 *  it still has it after wait ms (durations.holderGone): only a cap, as a holder unit goes within
 *  moments of its holder. One that has not by then is stuck, and systemd-run says so. */
export async function unitGone(unit: string, wait: number): Promise<boolean> {
  for (const end = Date.now() + wait; Date.now() < end; await Bun.sleep(50)) {
    const show = Bun.spawn(["systemctl", "--user", "show", "--property=LoadState", "--value", `${unit}.service`], { stdout: "pipe" });
    if ((await new Response(show.stdout).text()).trim() !== "loaded") return true;
  }
  return false;
}

/**
 * Records the holder in the store, then starts it as a transient systemd unit
 * (architecture §4.2). Resolves once its socket is listening. Arguments and tokens
 * never go on a command line; they go over the socket in `start`.
 */
export async function launchHolder(o: {
  cfg: Config;
  store: Store;
  conversation: string;
  /** The rh-hold binary. Each version is installed in its own directory (§4.7). */
  holdBin?: string;
}) {
  const { cfg, store, conversation } = o;
  const holdBin = o.holdBin ?? join(dirname(process.execPath), "rh-hold");
  const p = holderPaths(cfg, conversation);
  for (const path of [holdBin, p.dir, p.sock, p.lock]) {
    if (!plainPath.test(path)) {
      throw new Error(`holder: path ${JSON.stringify(path)} has characters systemd would expand`);
    }
  }
  // The conversation's last holder may still be on its way out, its ExecStopPost running. systemd
  // takes no new unit of the same name until it is gone, which is quick.
  await unitGone(p.unit, cfg.durations.holderGone);
  // The last agent's exit, gone before this holder is on record: from then on, after a restart, an
  // exit file with no unit always means this holder ran and ended (architecture §4.2).
  rmSync(join(p.dir, "exit"), { force: true });
  // An out.log shorter than the stored offset was deleted with its directory (§4.5): start over.
  const size = statSync(join(p.dir, "out.log"), { throwIfNoEntry: false })?.size ?? 0;
  const errStart = statSync(join(p.dir, "err.log"), { throwIfNoEntry: false })?.size ?? 0;
  // Recorded before it starts, so there is never a holder rhodium does not know about.
  store.tx((tx) => {
    const [row] = tx.find("holder", { conversation });
    const set = { unit: p.unit, proto: HOLD_PROTO, stopRequested: 0 as const, exited: 0 as const, outStart: size, errStart };
    if (!row) tx.insert("holder", { conversation, ...set, outOffset: 0 });
    else tx.update("holder", { conversation }, { ...set, outOffset: row.outOffset > size ? 0 : row.outOffset });
  });
  const argv = [
    "systemd-run",
    "--user",
    "--collect",
    "--quiet",
    `--unit=${p.unit}`,
    // notify: systemd-run returns once the holder's socket is listening.
    "--property=Type=notify",
    "--property=KillMode=mixed",
    `--property=MemoryHigh=${cfg.memoryHigh}`,
    // A process the kernel kills for memory, such as a test the agent ran, takes no more with it (§4.2).
    "--property=OOMPolicy=continue",
    `--property=ExecStopPost=${holdBin} stop-post ${p.dir}`,
    `--setenv=PATH=${cfg.agentPath}`,
    holdBin,
    "run",
    p.dir,
    p.sock,
    p.lock,
    String(Math.round(cfg.durations.holdStartTimeout)),
  ];
  // The last holder's unit is gone by now (above), so its name is free.
  const run = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe" });
  if ((await run.exited) !== 0) throw new Error(`holder: systemd-run failed: ${(await new Response(run.stderr).text()).trim()}`);
  return p;
}

/** Launches a holder and starts the agent in it with the PATH from the config. */
export async function spawnHolder(
  o: Parameters<typeof launchHolder>[0] & { spec: SpawnSpec; boot: number; on: HolderEvents },
): Promise<HolderLink> {
  const { sock } = await launchHolder(o);
  const [row] = o.store.tx((tx) => tx.find("holder", { conversation: o.conversation }));
  const link = await connectHolder(sock, { boot: o.boot, offset: row!.outOffset }, o.on);
  await link.start({ ...o.spec, env: { ...o.spec.env, PATH: o.cfg.agentPath } });
  return link;
}

/** Lets the agent exit: closes its stdin, then sends TERM, then KILL, grace apart, until it has
 *  exited (architecture §6.2). Each driver's close() ends with this. */
export async function closeLink(link: AgentLink, grace: number): Promise<void> {
  const exited = () => Promise.race([link.exited.then(() => true), Bun.sleep(grace).then(() => false)]);
  await link.eof();
  if (await exited()) return;
  await link.signal("TERM");
  if (await exited()) return;
  await link.signal("KILL");
}

export type HolderEvents = {
  /** One or more whole lines of agent output, starting at byte `pos` of out.log. */
  out(pos: number, data: Uint8Array): void;
  /** A line is in stdin, whichever connection wrote it, so also `hello.writing`'s (§4.6). */
  ack?(id: string): void;
  /** The agent exited; the holder exits right after. */
  exit(code: number | null, signal: string | null): void;
  /** The connection is gone, whether or not the holder is. */
  close?(): void;
};

export type HolderLink = AgentLink & {
  readonly hello: Extract<HoldMessage, { type: "hello_ok" }>;
  /** Settles once this connection gets the agent's exit; a dropped connection leaves it pending. */
  exited: Promise<Exit>;
  /** Starts the agent; resolves with its pid. Sends `spec.env` as the agent's whole environment. */
  start(spec: SpawnSpec): Promise<number>;
  close(): void;
};

type Exit = { code: number | null; signal: string | null };
type Waiter = { resolve: (v: any) => void; reject: (e: Error) => void };

/**
 * Connects to a holder: hello, then the holder replays out.log from `offset` and goes live.
 * A newer connection to the same holder closes this one.
 */
export function connectHolder(
  sock: string,
  hello: { boot: number; offset: number },
  on: HolderEvents,
): Promise<HolderLink> {
  return new Promise((resolve, reject) => {
    const s = connect(sock);
    const acks = new Map<string, Waiter>();
    let started: Waiter | undefined;
    let link: HolderLink | undefined;
    let agentExited!: (e: Exit) => void;
    const exited = new Promise<Exit>((r) => (agentExited = r));
    const send = (m: HoldMessage) =>
      new Promise<void>((res, rej) => s.write(encodeHold(m), (e) => (e ? rej(e) : res())));
    const wait = <T>(set: (w: Waiter) => void, m: HoldMessage) =>
      new Promise<T>((res, rej) => {
        set({ resolve: res, reject: rej });
        send(m).catch(rej);
      });

    const handle = (m: HoldMessage) => {
      if (m.type === "hello_ok") {
        link = {
          hello: m,
          start: (spec) => wait((w) => (started = w), { type: "start", ...spec }),
          write: (id, line) => wait((w) => acks.set(id, w), { type: "write", id, line }),
          eof: () => send({ type: "eof" }),
          signal: (sig) => send({ type: "signal", sig }),
          close: () => s.destroy(),
          exited,
        };
        resolve(link);
      } else if (m.type === "started") {
        started?.resolve(m.pid);
      } else if (m.type === "out") {
        on.out(m.pos, Buffer.from(m.data, "base64"));
      } else if (m.type === "ack") {
        on.ack?.(m.id);
        acks.get(m.id)?.resolve(undefined);
        acks.delete(m.id);
      } else if (m.type === "exit") {
        started?.reject(new Error(`holder: the agent did not start (exit ${m.code})`));
        agentExited({ code: m.code, signal: m.signal });
        on.exit(m.code, m.signal);
      }
    };

    // Split on byte 0x0A, as the holder does; a line may span many chunks.
    let parts: Buffer[] = [];
    s.on("data", (chunk: Buffer) => {
      for (let i = chunk.indexOf(10); i >= 0; i = chunk.indexOf(10)) {
        parts.push(chunk.subarray(0, i));
        const line = Buffer.concat(parts).toString();
        parts = [];
        chunk = chunk.subarray(i + 1);
        try {
          handle(decodeHold(line));
        } catch (e) {
          return void s.destroy(e as Error);
        }
      }
      if (chunk.length) parts.push(chunk);
    });
    s.on("connect", () => send({ type: "hello", proto: HOLD_PROTO, ...hello }).catch(() => s.destroy()));
    s.on("error", () => {}); // close follows
    s.on("close", () => {
      // A write that was sent but not acked may or may not have reached the agent (§4.6).
      const gone = new Error("holder: connection closed");
      for (const w of acks.values()) w.reject(gone);
      acks.clear();
      started?.reject(gone);
      if (link) on.close?.();
      else reject(gone);
    });
  });
}
