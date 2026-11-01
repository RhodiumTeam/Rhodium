// The Herdr bridge's client (architecture §10.3): Herdr's documented socket API, one JSON line each
// way, a connection per request and one held open for events. No Rhodium imports, so the fake
// Herdr in test/ shares it.
import { connect } from "node:net";

/** One request on its own connection: resolves with the whole answer line, error or result. A
 *  Herdr that keeps quiet for `timeout` ms counts as gone. */
export function call(socket: string, method: string, params: object = {}, timeout = 5_000): Promise<any> {
  return new Promise((ok, ko) => {
    const s = connect(socket);
    let buf = "";
    s.setTimeout(timeout, () => s.destroy(new Error(`${method}: no answer from Herdr in ${timeout} ms`)));
    s.on("connect", () => s.write(JSON.stringify({ id: `rh:${method}`, method, params }) + "\n"));
    s.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      s.end();
      // A throw here would go uncaught and take rhodium down with it.
      try {
        ok(JSON.parse(buf.slice(0, i)));
      } catch {
        ko(new Error(`${method}: Herdr answered with a line that is not JSON: ${buf.slice(0, Math.min(i, 200))}`));
      }
    });
    s.on("error", ko);
    s.on("close", () => ko(new Error(`${method}: connection closed without an answer`)));
  });
}

/** call, for the result alone: Herdr's error is thrown. */
export async function request(socket: string, method: string, params: object = {}): Promise<any> {
  const a = await call(socket, method, params);
  if (a.error) throw new Error(`Herdr ${method}: ${a.error.code} ${a.error.message}`);
  return a.result;
}

/** Holds an `events.subscribe` connection open; `events` fills as event lines arrive. */
export function subscribe(socket: string, types: string[]) {
  const s = connect(socket);
  const events: any[] = [];
  let buf = "";
  let started!: (answer: any) => void;
  s.on("connect", () => {
    const params = { subscriptions: types.map((type) => ({ type })) };
    s.write(JSON.stringify({ id: "rh:events.subscribe", method: "events.subscribe", params }) + "\n");
  });
  s.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\n")) >= 0; buf = buf.slice(i + 1)) {
      let msg;
      try {
        msg = JSON.parse(buf.slice(0, i));
      } catch {
        continue; // a garbled line is skipped; events only prompt a look at /proc (architecture §10.3)
      }
      if ("event" in msg) events.push(msg);
      else started(msg);
    }
  });
  s.on("error", () => {});
  return {
    events,
    started: new Promise<any>((ok) => (started = ok)),
    /** Resolves when the server closes the connection: Herdr stopped (architecture §10.2). */
    closed: new Promise<void>((ok) => s.on("close", () => ok())),
    close: () => s.destroy(),
  };
}

/** The socket of the Herdr session, from `herdr session list --json`; throws unless it runs. */
export async function sessionSocket(herdr: string, session: string): Promise<string> {
  const proc = Bun.spawn([herdr, "session", "list", "--json"], { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`herdr session list 失败：${err.trim() || `退出码 ${code}`}`);
  const found = (JSON.parse(out).sessions as { name: string; running: boolean; socket_path: string }[]).find((s) => s.name === session);
  if (!found?.running) throw new Error(`Herdr 会话 ${session} 没在运行`);
  return found.socket_path;
}
