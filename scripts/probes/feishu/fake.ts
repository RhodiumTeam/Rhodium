// A local stand-in for Feishu, as far as probe.ts uses it, with you scripted in, for probe.ts --fake.
// The SDK's domain points here, and so do the scan's calls to accounts.feishu.cn. You answer each
// card the probe sends with a step on it: press its first button, or send what the step asks for
// (the sticker you skip). When the probe drops its connection the first time, you send a message;
// Feishu keeps it and pushes it again 5 minutes later (times cut by scale), as its retries do.

export const APP = "cli_0123456789abcdef";
const OWNER = "ou_fake_owner";
const CHAT = "oc_fake_p2p";

const enc = new TextEncoder();
const varint = (n: number): number[] => {
  const o: number[] = [];
  for (; n > 127; n >>>= 7) o.push((n & 127) | 128);
  return [...o, n];
};
const field = (no: number, b: Uint8Array) => [...varint((no << 3) | 2), ...varint(b.length), ...b];
/** A data frame as the SDK's protobuf (pbbp2.Frame) has it: SeqID 1, LogID 1, service 7, method data, headers, payload. */
function frame(headers: Record<string, string>, payload: object): Uint8Array {
  const out = [8, 1, 16, 1, 24, 7, 32, 1];
  for (const [k, v] of Object.entries(headers)) out.push(...field(5, new Uint8Array([...field(1, enc.encode(k)), ...field(2, enc.encode(v))])));
  out.push(...field(8, enc.encode(JSON.stringify(payload))));
  return new Uint8Array(out);
}

type Stored = { message_id: string; msg_type: string; create_time: string; chat_id: string; parent_id?: string; upper_message_id?: string; sender: { id: string; id_type: string; sender_type: string }; body: { content: string } };
type Button = { label: string; value: Record<string, string> };

/** What you send for each step whose card has no button but 跳过. */
const SAY: Record<string, [string, object]> = {
  hello: ["text", { text: "你好" }],
  render: ["image", { image_key: "img_fake" }],
  image: ["image", { image_key: "img_fake" }],
  file: ["file", { file_key: "file_fake", file_name: "note.txt" }],
  audio: ["audio", { file_key: "file_audio", duration: 2000 }],
  forward: ["merge_forward", { content: "Merged and Forwarded Message" }],
  reply: ["text", { text: "回复一句" }],
  post: ["post", { title: "标题", content: [[{ tag: "text", text: "加粗", style: ["bold"] }]] }],
  slash: ["text", { text: "/rh_help" }],
};
const SKIP = new Set(["sticker"]);
const FILES: Record<string, string> = { img_fake: "fake image bytes", file_fake: "fake file bytes", file_audio: "fake opus bytes" };

export function fakeFeishu(scale: number) {
  let n = 0;
  let sock: Bun.ServerWebSocket<unknown> | undefined;
  let closes = 0;
  let begins = 0;
  let polls = 0;
  const history: Stored[] = [];
  const pending: Stored[] = []; // yours while the probe was away, for the retry
  const commands: object[] = [];
  const toasts: object[] = [];
  const counts = { patches: 0, pushes: 0, repushes: 0, uploads: 0 };
  const store = (m: Omit<Stored, "message_id" | "create_time" | "chat_id">, mine: boolean) => {
    const s: Stored = { message_id: `om_${mine ? "u" : "b"}${++n}`, create_time: String(Date.now()), chat_id: CHAT, ...m };
    history.push(s);
    return s;
  };
  const push = (event_type: string, event: object) => {
    counts.pushes++;
    const header = { event_id: `ev_${++n}`, event_type, create_time: String(Date.now()), token: "", app_id: APP, tenant_key: "t_fake" };
    sock?.send(frame({ type: "event", message_id: `f_${n}`, sum: "1", seq: "0", trace_id: `tr_${n}` }, { schema: "2.0", header, event }));
  };
  const pushMessage = (s: Stored) =>
    push("im.message.receive_v1", {
      sender: { sender_id: { open_id: OWNER, union_id: "on_fake" }, sender_type: "user", tenant_key: "t_fake" },
      message: { message_id: s.message_id, parent_id: s.parent_id, create_time: s.create_time, chat_id: CHAT, chat_type: "p2p", message_type: s.msg_type, content: s.body.content },
    });
  const say = (type: string, content: object, parent_id?: string) => {
    const s = store({ msg_type: type, body: { content: JSON.stringify(content) }, sender: { id: OWNER, id_type: "open_id", sender_type: "user" }, ...(parent_id && { parent_id }) }, true);
    if (sock) pushMessage(s);
    else pending.push(s);
  };
  const press = (message_id: string, value: Record<string, string>) =>
    push("card.action.trigger", { operator: { open_id: OWNER, union_id: "on_fake" }, token: "c-fake", action: { tag: "button", value }, host: "im_message", context: { open_message_id: message_id, open_chat_id: CHAT } });

  /** You, reading a card the probe sent. */
  const read = (s: Stored, card: any) => {
    const buttons: Button[] = [];
    const walk = (x: any): void => {
      if (x?.tag === "button") buttons.push({ label: x.text?.content, value: x.behaviors?.[0]?.value ?? {} });
      else if (x && typeof x === "object") Object.values(x).forEach(walk);
    };
    walk(card);
    const step = buttons[0]?.value.step;
    if (!step) return;
    const choice = buttons.find((b) => b.label !== "跳过");
    setTimeout(() => {
      if (choice && !SAY[step]) return press(s.message_id, choice.value);
      if (SKIP.has(step) || !SAY[step]) return press(s.message_id, buttons[0]!.value);
      const [type, content] = SAY[step]!;
      if (step === "forward") {
        const top = store({ msg_type: type, body: { content: JSON.stringify(content) }, sender: { id: OWNER, id_type: "open_id", sender_type: "user" } }, true);
        for (const text of ["转发里的第一句", "第二句"]) store({ msg_type: "text", body: { content: JSON.stringify({ text }) }, sender: { id: OWNER, id_type: "open_id", sender_type: "user" }, upper_message_id: top.message_id }, true);
        return pushMessage(top);
      }
      say(type, content, step === "reply" ? s.message_id : undefined);
    }, 20);
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const base = `http://127.0.0.1:${srv.port}`;
      const ok = (data: object = {}) => Response.json({ code: 0, msg: "success", data });
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (path === "/oauth/v1/app/registration") {
        const form = new URLSearchParams(await req.text());
        if (form.get("action") === "begin") {
          begins++;
          return Response.json({ device_code: `dc${begins}`, user_code: "FAKE", verification_uri_complete: `https://open.feishu.cn/page/cli?user_code=FAKE${begins}`, expires_in: 3600, interval: 0.02 });
        }
        // The first link expires unscanned; the second is scanned after one more poll.
        if (form.get("device_code") === "dc1") return Response.json({ error: "expired_token", error_description: "expired" }, { status: 400 });
        if (++polls === 1) return Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({ client_id: APP, client_secret: "fake-secret", user_info: { open_id: OWNER, tenant_brand: "feishu" } });
      }
      if (path === "/open-apis/auth/v3/tenant_access_token/internal") return Response.json({ code: 0, msg: "ok", tenant_access_token: "t-fake-tenant-token-0123456789", expire: 7200 });
      if (path === "/callback/ws/endpoint") return ok({ URL: `ws://127.0.0.1:${srv.port}/ws?device_id=d1&service_id=7`, ClientConfig: { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 120, ReconnectNonce: 30 } });
      if (path === "/avatar.png") return new Response("fake png", { headers: { "content-type": "image/png" } });
      if (path === "/open-apis/bot/v3/info") return Response.json({ code: 0, msg: "ok", bot: { activate_status: 2, app_name: "Rhodium 测试机", avatar_url: `${base}/avatar.png`, open_id: "ou_fake_bot" } });
      if (path === "/open-apis/application/v6/scopes") return ok({ scopes: [{ scope_name: "im:message:send_as_bot", grant_status: 1 }, { scope_name: "docx:document:readonly", grant_status: 1 }, { scope_name: "contact:user.base:readonly", grant_status: 2 }] });
      if (path.startsWith("/open-apis/contact/v3/users/")) return ok({ user: { open_id: OWNER, name: "你", avatar: { avatar_72: `${base}/avatar.png`, avatar_240: `${base}/avatar.png` } } });
      if (path === "/open-apis/application/v7/app_slash_commands") {
        if (req.method === "GET") return ok({ items: commands });
        const body = (await req.json()) as { command: string };
        if (commands.some((c: any) => c.command === body.command)) return Response.json({ code: 40000000, msg: "command already exists" }, { status: 400 });
        commands.push({ command_id: `sc_${++n}`, ...body });
        return ok(commands.at(-1));
      }
      if (path === "/open-apis/im/v1/images" || path === "/open-apis/im/v1/files") {
        const form = await req.formData();
        const blob = (form.get("image") ?? form.get("file")) as Blob | null;
        if (!blob?.size) return Response.json({ code: 234001, msg: "empty file" }, { status: 400 });
        counts.uploads++;
        return ok(path.endsWith("images") ? { image_key: `img_up_${++n}` } : { file_key: `file_up_${++n}` });
      }
      if (path === "/open-apis/im/v1/messages" && req.method === "POST") {
        const body = (await req.json()) as { msg_type: string; content: string };
        const s = store({ msg_type: body.msg_type, body: { content: body.content }, sender: { id: APP, id_type: "app_id", sender_type: "app" } }, false);
        if (body.msg_type === "interactive") read(s, JSON.parse(body.content));
        return ok({ message_id: s.message_id, chat_id: CHAT, msg_type: body.msg_type, create_time: s.create_time });
      }
      if (path === "/open-apis/im/v1/messages" && req.method === "GET") {
        const [from, to] = ["start_time", "end_time"].map((k) => Number(url.searchParams.get(k) ?? 0) * 1000) as [number, number];
        return ok({ has_more: false, items: history.filter((m) => !m.upper_message_id && +m.create_time >= from && (!to || +m.create_time <= to + 999)) });
      }
      const res = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(path);
      if (res) return FILES[res[2]!] ? new Response(FILES[res[2]!]) : Response.json({ code: 234003, msg: "File not in msg" }, { status: 400 });
      const one = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path)?.[1];
      if (one && req.method === "PATCH") return (counts.patches++, ok());
      if (one && req.method === "GET") {
        const top = history.find((m) => m.message_id === one);
        return top ? ok({ items: [top, ...history.filter((m) => m.upper_message_id === one)] }) : Response.json({ code: 230001, msg: "no message" }, { status: 400 });
      }
      return Response.json({ code: 404, msg: `no ${req.method} ${path} here` }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sock = ws;
        for (const s of pending.splice(0)) setTimeout(() => (counts.repushes++, pushMessage(s)), Math.max(0, +s.create_time + 5 * 60_000 * scale - Date.now()));
      },
      message(_ws, msg) {
        // The SDK's ack: {"code":200} and, for a press, the base64 of what the handler gave back.
        const data = /\{"code":\d+,"data":"([^"]+)"\}/.exec(Buffer.from(msg as Uint8Array).toString("latin1"))?.[1];
        if (data) toasts.push(JSON.parse(Buffer.from(data, "base64").toString()));
      },
      close() {
        sock = undefined;
        if (++closes === 1) setTimeout(() => say("text", { text: "断线时发的" }), 20);
      },
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, toasts, counts, commands, stop: () => server.stop(true) };
}
