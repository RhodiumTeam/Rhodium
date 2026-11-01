// Preloaded into rh (bun --preload): stands in for QQ's QR service on q.qq.com, which rh bot asks for
// a bind task and polls, as Tencent's qqbot-agent-sdk does. The first QR code expires on its first
// poll; the second is scanned on its second. The secret comes sealed with the key rh sent.
// Imported in a test, it stands in there too; outage makes the next calls to a path time out.

export const QR = {
  expired: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=task%201&_wv=2",
  url: "https://q.qq.com/qqbot/openclaw/connect.html?task_id=task%202&_wv=2",
  appId: "102030405",
  secret: "qq-secret-never-shown",
  openid: "you-openid",
};

/** How many of the next calls to each path ("/lite/poll_bind_result") time out with no answer. */
export const outage: Record<string, number> = {};

const tasks: { key: string; polls: number }[] = [];
const ok = (data: object) => Response.json({ retcode: 0, data });

async function sealed(key: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aes = await crypto.subtle.importKey("raw", Buffer.from(key, "base64"), "AES-GCM", false, ["encrypt"]);
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aes, new TextEncoder().encode(QR.secret));
  return Buffer.concat([iv, new Uint8Array(box)]).toString("base64");
}

async function qq(req: Request): Promise<Response> {
  // Without it, the real one answers with a page that checks for bots.
  if (req.headers.get("accept") !== "application/json") return new Response("<html>", { headers: { "content-type": "text/html" } });
  const body = await req.json();
  const path = new URL(req.url).pathname;
  if (outage[path]) {
    outage[path]--;
    throw new DOMException("The operation timed out.", "TimeoutError");
  }
  if (path === "/lite/create_bind_task") {
    if (Buffer.from(body.key, "base64").length !== 32) return Response.json({ retcode: 1, msg: "bad key" });
    tasks.push({ key: body.key, polls: 0 });
    return ok({ task_id: `task ${tasks.length}` });
  }
  const task = path === "/lite/poll_bind_result" && tasks[Number(String(body.task_id).slice(5)) - 1];
  if (!task) return Response.json({ retcode: 1, msg: "no such task" });
  task.polls++;
  if (task === tasks[0]) return ok({ status: 3 });
  if (task.polls === 1) return ok({ status: 1 });
  return ok({ status: 2, bot_appid: Number(QR.appId), bot_encrypt_secret: await sealed(task.key), user_openid: QR.openid });
}

const real = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const req = new Request(input, init);
  return req.url.startsWith("https://q.qq.com/") ? qq(req) : real(input, init);
}) as typeof fetch;
