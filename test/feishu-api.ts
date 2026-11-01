// A local stand-in for Feishu's open platform and long connection, as far as Rhodium uses them: a
// Feishu bot's apiRoot points here (docs/spec/feishu.md "测试决定"). Adapted from the probe's
// scripts/probes/feishu/fake.ts; its answers have the fields and types of the ones recorded in
// test/fixtures/feishu/ (test/fake-feishu.test.ts).

/** The test app's credentials: the SDK takes only cli_ and 16 hex digits for an App ID. */
export const APP = "cli_0123456789abcdef";
export const SECRET = "fake-secret-never-logged";
/** Your open_id under the app, which is also your private chat's id in Rhodium (spec "窗口 ID"). */
export const ME = "ou_owner";
/** Your private chat with the bot, as Feishu names it. */
export const CHAT = "oc_p2p";
/** The bot's own open_id. */
export const BOT = "ou_bot";
const TENANT = "tenant_0";

const enc = new TextEncoder();
const dec = new TextDecoder();
const varint = (n: number): number[] => {
  const o: number[] = [];
  for (; n > 127; n >>>= 7) o.push((n & 127) | 128);
  return [...o, n];
};
const field = (no: number, b: Uint8Array) => [...varint((no << 3) | 2), ...varint(b.length), ...b];
/** A frame as the SDK's protobuf (pbbp2.Frame) has it: SeqID 1, LogID 1, service 7, method (0
 *  control, 1 data), headers, payload. */
function frame(method: 0 | 1, headers: Record<string, string>, payload: object): Uint8Array {
  const out = [8, 1, 16, 1, 24, 7, 32, method];
  for (const [k, v] of Object.entries(headers)) out.push(...field(5, new Uint8Array([...field(1, enc.encode(k)), ...field(2, enc.encode(v))])));
  out.push(...field(8, enc.encode(JSON.stringify(payload))));
  return new Uint8Array(out);
}
/** The fields of a protobuf message: varints as numbers, the rest as bytes, each by its number. */
function fields(b: Uint8Array): [number, number | Uint8Array][] {
  const out: [number, number | Uint8Array][] = [];
  let i = 0;
  const read = () => {
    let n = 0;
    for (let shift = 0; ; shift += 7) {
      const byte = b[i++]!;
      n += (byte & 127) * 2 ** shift;
      if (byte < 128) return n;
    }
  };
  while (i < b.length) {
    const tag = read();
    if ((tag & 7) === 0) out.push([tag >>> 3, read()]);
    else {
      const len = read();
      out.push([tag >>> 3, b.subarray(i, i + len)]);
      i += len;
    }
  }
  return out;
}
/** A frame the SDK sent: its method, headers and payload. */
function parse(b: Uint8Array): { method: number; headers: Record<string, string>; payload: string } {
  const f = fields(b);
  const headers = Object.fromEntries(
    f.filter(([no]) => no === 5).map(([, h]) => fields(h as Uint8Array).map(([, v]) => dec.decode(v as Uint8Array)) as [string, string]),
  );
  const payload = f.find(([no]) => no === 8)?.[1];
  return { method: Number(f.find(([no]) => no === 4)?.[1] ?? 0), headers, payload: payload instanceof Uint8Array ? dec.decode(payload) : "" };
}

/** How the next call goes wrong (spec "结果怎么报"): over the rate limit (230020, with the seconds to
 *  wait in x-ogw-ratelimit-reset; or 99991400), out of the month's quota (99991403, with HTTP 429 as
 *  Feishu gives it), a card's Markdown turned down (230099), some other refusal, a server error, or
 *  no answer at all. */
const FAILURES = {
  flood: [400, { code: 230020, msg: "The request you send is too frequent" }],
  busy: [429, { code: 99991400, msg: "request trigger frequency limit" }],
  quota: [429, { code: 99991403, msg: "The monthly API call quota has been exceeded" }],
  refuse: [400, { code: 230099, msg: "Failed to create card content, ext=ErrCode: 11310; ErrMsg: table number over limit" }],
  denied: [400, { code: 230013, msg: "Bot has NO availability to this user." }],
  resolution: [400, { code: 234039, msg: "Image resolution exceeds limit." }], // a picture's upload, per Feishu's docs
  error: [500, { code: 1, msg: "internal error" }],
  timeout: [0, {}],
} as const;
type Failure = keyof typeof FAILURES;

/** The long connection's settings: a ping every 120 s, as Feishu gives them, and reconnecting at once
 *  and then every second, unlike Feishu, so tests need not wait minutes. */
const CLIENT_CONFIG = { PingInterval: 120, ReconnectCount: -1, ReconnectInterval: 1, ReconnectNonce: 0 };

type Event = { schema: "2.0"; header: Record<string, string>; event: Record<string, unknown> };
/** A message the bot sent or edited: where to, its type and content parsed (a card, or a picture's or
 *  a file's key). */
type Sent = { method: "POST" | "PATCH"; message_id: string; receive_id?: string; receive_id_type?: string; msg_type?: string; card: any };
/** A picture or a file the bot uploaded: its form's fields, and the file's own bytes. */
type Upload = { kind: "image" | "file"; key: string; fields: Record<string, string>; bytes: Uint8Array };
/** A slash command of the app's / menu, as Feishu lists it. */
type Command = { command: string; command_id: string; create_time: string; description: { default_value: string }; icon: { icon_key: string }; update_time: string };
const SLASH = "/open-apis/application/v7/app_slash_commands";

export function feishuApi() {
  let n = 0;
  let sock: Bun.ServerWebSocket<unknown> | undefined;
  let connected = Promise.withResolvers<void>();
  const connects: number[] = []; // when each long connection came up
  const events = new Map<string, Event>(); // by the frame's message_id, for its ack
  // Each ack the SDK sent: the event's id, its code (200 taken, 500 not), what the handler gave back.
  const acks: { event_id: string; event_type: string; code: number; data?: unknown }[] = [];
  const sent: Sent[] = [];
  // How the next calls go wrong, in order; method: the first waits for a call of that method (POST
  // sends and uploads, PATCH edits, GET reads), and other calls go through meanwhile.
  const next: { how: Failure; method?: "GET" | "POST" | "PATCH"; reset?: number }[] = [];
  const files = new Map<string, Uint8Array<ArrayBuffer>>(); // what a message's picture or file key downloads as
  const downloads: { message_id: string; key: string; type: string | null }[] = [];
  const forwards = new Map<string, unknown[]>(); // a forward's messages, by its id, as message.get gives them
  const uploads: Upload[] = [];
  const token = { hangs: false }; // hangs: the token's endpoint takes the connection and never answers
  // down: the long connection's address is not given (HTTP 503), so the SDK can't connect and tries
  // again; refused counts those. listDelay: ms the list of a chat's messages takes to answer.
  const link = { down: false, refused: 0, listDelay: 0 };
  // The chats' messages as their list gives them, yours and the bot's, oldest first.
  const history: Record<string, unknown>[] = [];
  const item = (chat_id: string, message_id: string, msg_type: string, content: string, sender: object, create_time: string) =>
    history.push({ body: { content }, chat_default_name: "", chat_id, chat_type: "p2p", create_time, deleted: false, message_id, message_position: String(history.length), msg_type, sender, update_time: create_time, updated: false });
  // Every open platform call but the token's, the profile's, the scan's and the / menu's: rhodium
  // pushes the menu as it starts, which would take a failure a test means for a send.
  const calls: { method: string; path: string; query: Record<string, string>; at: number }[] = [];
  const commands: Command[] = []; // the app's / menu, oldest first
  const menuCalls: string[] = []; // the method of each call on the / menu
  // A Feishu id has its creation second in its top bits: here the fixtures' synthetic 2026-01-01.
  const ID_BASE = 1767225600n << 32n;
  const command = (name: string, description: string) => {
    const at = String(Math.floor(Date.now() / 1000));
    const c = { command: name, command_id: String(ID_BASE + BigInt(++n)), create_time: at, description: { default_value: description }, icon: { icon_key: "skill_outlined" }, update_time: at };
    commands.push(c);
    return c;
  };
  // The scan (rh bot): its first expire links expire unscanned; then it is scanned, by an account of
  // brand, whose open_id is by. Each link's first poll is still pending.
  const scan = { expire: 0, brand: "feishu" as "feishu" | "lark", by: ME, links: 0 };
  // granted: the app may read your name and avatar (contact:user.base:readonly); without it Feishu
  // gives your open_id alone.
  const contact = { granted: false };
  // bot: the app has the bot capability, in a published version. Off, as for an app just made in the
  // console, the bot's info is turned down; Feishu's own code for that is not recorded.
  const ability = { bot: true };
  const pending = new Set<string>();

  const push = (event_type: string, event: Record<string, unknown>, create_time = String(Date.now())) => {
    const event_id = `ev_${++n}`;
    const id = `f_${n}`;
    const e: Event = { schema: "2.0", header: { event_id, token: "", create_time, event_type, tenant_key: TENANT, app_id: APP }, event };
    events.set(id, e);
    sock?.send(frame(1, { type: "event", message_id: id, sum: "1", seq: "0", trace_id: `tr_${n}` }, e));
    return event_id;
  };

  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const ok = (data: object = {}, msg = "success") => Response.json({ code: 0, data, msg });
      if (path === "/ws") return srv.upgrade(req) ? undefined : new Response("no", { status: 400 });
      if (path === "/open-apis/auth/v3/tenant_access_token/internal") {
        if (token.hangs) return new Promise<Response>(() => {});
        const body = (await req.json()) as { app_id: string; app_secret: string };
        // Any app of the SDK's shape: the SDK keeps a token by App ID for the whole process.
        if (!/^cli_[0-9a-f]{16}$/.test(body.app_id) || body.app_secret !== SECRET) return Response.json({ code: 10014, msg: "app secret invalid" }, { status: 400 });
        return Response.json({ code: 0, msg: "ok", tenant_access_token: "t-fake-tenant-token-0123456789", expire: 7200 });
      }
      if (path === "/callback/ws/endpoint") {
        if (link.down) return link.refused++, new Response("unavailable", { status: 503 });
        const body = (await req.json()) as { AppID: string; AppSecret: string };
        if (body.AppID !== APP || body.AppSecret !== SECRET) return Response.json({ code: 1000040351, msg: "incorrect app secret", data: {} });
        return ok({ URL: `ws://127.0.0.1:${srv.port}/ws?device_id=d1&service_id=7`, ClientConfig: CLIENT_CONFIG });
      }
      const base = `http://127.0.0.1:${srv.port}`;
      // The scan's calls to accounts.feishu.cn and accounts.larksuite.com, which rh sends here too.
      if (path === "/oauth/v1/app/registration") {
        const form = new URLSearchParams(await req.text());
        if (form.get("action") === "begin") {
          const n = ++scan.links;
          return Response.json({ device_code: `dc${n}`, user_code: `FAKE-${n}`, verification_uri_complete: `https://open.feishu.cn/page/launcher?user_code=FAKE-${n}`, expires_in: 3600, interval: 0.02 });
        }
        const code = form.get("device_code")!;
        if (Number(code.slice(2)) <= scan.expire) return Response.json({ error: "expired_token", error_description: "The device code has expired" }, { status: 400 });
        if (!pending.has(code)) return pending.add(code), Response.json({ error: "authorization_pending" }, { status: 400 });
        return Response.json({ client_id: APP, client_secret: SECRET, user_info: { open_id: scan.by, tenant_brand: scan.brand } });
      }
      if (path === "/open-apis/bot/v3/info" && !ability.bot) return Response.json({ code: 99999, msg: "the app has no bot" }, { status: 400 });
      if (path === "/open-apis/bot/v3/info") return Response.json({ bot: { activate_status: 2, app_name: "Rhodium 测试机", avatar_url: `${base}/avatar/bot`, ip_white_list: [], open_id: BOT }, code: 0, msg: "ok" });
      if (path === "/open-apis/application/v6/scopes") {
        const scope = (scope_name: string) => ({ grant_status: 1, scope_name, scope_type: "tenant" });
        return ok({ scopes: [scope("im:message:send_as_bot"), ...(contact.granted ? [scope("contact:user.base:readonly")] : [])] });
      }
      const user = /^\/open-apis\/contact\/v3\/users\/([^/]+)$/.exec(path)?.[1];
      if (user) {
        const avatar = { avatar_72: `${base}/avatar/you-72`, avatar_240: `${base}/avatar/you-240`, avatar_640: `${base}/avatar/you-640`, avatar_origin: `${base}/avatar/you` };
        return ok({ user: { mobile_visible: true, open_id: user, union_id: "on_owner", ...(contact.granted && { name: "你", avatar }) } });
      }
      // Avatars need no token.
      if (path.startsWith("/avatar/")) return new Response(`fake ${path.slice(8)} avatar`, { headers: { "content-type": "image/png" } });
      if (path.startsWith(SLASH)) menuCalls.push(req.method);
      // The / menu: listed newest first, as Feishu does; a command made answered without its update_time.
      if (path === SLASH && req.method === "GET") return ok({ items: commands.toReversed() }, "");
      if (path === SLASH && req.method === "POST") {
        const body = (await req.json()) as { command: string; description: { default_value: string } };
        if (commands.some((c) => c.command === body.command)) return Response.json({ code: 40000000, msg: "command already exists" }, { status: 400 });
        const { update_time, ...made } = command(body.command, body.description.default_value);
        return ok(made, "");
      }
      const slash = path.startsWith(`${SLASH}/`) && commands.findIndex((c) => c.command_id === path.slice(SLASH.length + 1));
      if (slash !== false) {
        if (slash < 0) return Response.json({ code: 40400000, msg: "command not found" }, { status: 400 });
        if (req.method === "DELETE") return (commands.splice(slash, 1), ok({}, ""));
        const body = (await req.json()) as { description: { default_value: string } };
        Object.assign(commands[slash]!, { description: body.description, update_time: String(Math.floor(Date.now() / 1000)) });
        return ok(commands[slash]!, "");
      }
      calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), at: Date.now() });
      if (next[0] && (!next[0].method || next[0].method === req.method)) {
        const { how, reset } = next.shift()!;
        if (how === "timeout") return new Promise<Response>(() => {}); // never answered
        const [status, body] = FAILURES[how];
        return Response.json(body, { status, headers: reset === undefined ? {} : { "x-ogw-ratelimit-reset": String(reset) } });
      }
      if (path === "/open-apis/im/v1/messages" && req.method === "POST") {
        const body = (await req.json()) as { receive_id: string; msg_type: string; content: string };
        const s: Sent = { method: "POST", message_id: `om_${++n}`, receive_id: body.receive_id, receive_id_type: url.searchParams.get("receive_id_type") ?? undefined, msg_type: body.msg_type, card: JSON.parse(body.content) };
        sent.push(s);
        const at = String(Date.now());
        const placeholder = JSON.stringify({ title: null, elements: [[{ tag: "img", image_key: "img_v3_01" }, { tag: "text", text: "请升级至最新版本客户端，以查看内容" }, { tag: "text", text: "" }]] });
        item(CHAT, s.message_id, body.msg_type, body.msg_type === "interactive" ? placeholder : body.content, { id: APP, id_type: "app_id", sender_type: "app", tenant_key: TENANT }, at);
        return ok({
          body: { content: body.msg_type === "interactive" ? placeholder : body.content },
          chat_id: CHAT,
          create_time: at,
          deleted: false,
          message_id: s.message_id,
          msg_type: body.msg_type,
          sender: { id: APP, id_type: "app_id", sender_type: "app", tenant_key: TENANT },
          update_time: at,
          updated: false,
        });
      }
      const upload = /^\/open-apis\/im\/v1\/(image|file)s$/.exec(path)?.[1] as Upload["kind"] | undefined;
      if (upload && req.method === "POST") {
        const form = await req.formData();
        const file = form.get(upload) as File;
        const fields = Object.fromEntries([...form].filter(([, v]) => typeof v === "string")) as Record<string, string>;
        const u: Upload = { kind: upload, key: `${upload === "image" ? "img" : "file"}_v3_up${++n}`, fields, bytes: new Uint8Array(await file.arrayBuffer()) };
        uploads.push(u);
        return ok({ [`${upload}_key`]: u.key });
      }
      const resource = /^\/open-apis\/im\/v1\/messages\/([^/]+)\/resources\/([^/]+)$/.exec(path);
      if (resource && req.method === "GET") {
        const [, message_id, key] = resource as unknown as [string, string, string];
        downloads.push({ message_id, key, type: url.searchParams.get("type") });
        const bytes = files.get(key);
        return bytes ? new Response(bytes, { headers: { "content-type": "application/octet-stream" } }) : Response.json({ code: 234003, msg: "File not in msg." }, { status: 400 });
      }
      // A chat's messages from start_time to end_time (seconds), oldest first, page by page.
      if (path === "/open-apis/im/v1/messages" && req.method === "GET") {
        const q = (k: string) => url.searchParams.get(k);
        const [from, to] = [Number(q("start_time") ?? 0) * 1000, Number(q("end_time") ?? Infinity) * 1000];
        const all = history.filter((m) => m.chat_id === q("container_id") && Number(m.create_time) >= from && Number(m.create_time) <= to);
        const start = Number(q("page_token") || 0);
        const end = start + Number(q("page_size") ?? 20);
        await Bun.sleep(link.listDelay);
        return ok({ has_more: end < all.length, page_token: end < all.length ? String(end) : "", items: all.slice(start, end) });
      }
      const one = /^\/open-apis\/im\/v1\/messages\/([^/]+)$/.exec(path)?.[1];
      if (one && req.method === "GET") {
        const items = forwards.get(one);
        return items ? ok({ items }) : Response.json({ code: 230001, msg: "message not found" }, { status: 400 });
      }
      if (one && req.method === "PATCH") {
        const body = (await req.json()) as { content: string };
        sent.push({ method: "PATCH", message_id: one, card: JSON.parse(body.content) });
        return ok();
      }
      return Response.json({ code: 404, msg: `no ${req.method} ${path} here` }, { status: 404 });
    },
    websocket: {
      open(ws) {
        sock = ws;
        connects.push(Date.now());
        connected.resolve();
      },
      message(ws, msg) {
        const f = parse(typeof msg === "string" ? enc.encode(msg) : new Uint8Array(msg));
        // The SDK's ping, answered with a pong carrying the settings, as Feishu does.
        if (f.method === 0 && f.headers.type === "ping") return void ws.send(frame(0, { type: "pong" }, CLIENT_CONFIG));
        // The SDK's ack of an event: {"code":200}, and the base64 of what the handler gave back, if anything.
        const e = events.get(f.headers.message_id ?? "");
        if (!e) return;
        const { code, data } = JSON.parse(f.payload) as { code: number; data?: string };
        acks.push({ event_id: e.header.event_id!, event_type: e.header.event_type!, code, ...(data && { data: JSON.parse(Buffer.from(data, "base64").toString()) }) });
      },
      close(ws) {
        if (sock === ws) {
          sock = undefined;
          connected = Promise.withResolvers();
        }
      },
    },
  });

  /** A message in a chat as Feishu pushes it: from you in your private chat, unless said otherwise.
   *  message_id: the one Feishu pushes again with a new event id. A new one is kept in the chat's
   *  messages, and pushed only while the long connection is up. Gives the event id and the message id. */
  function message(message_type: string, content: unknown, o: { message_id?: string; chat_type?: string; chat_id?: string; sender?: string; create_time?: string; parent_id?: string } = {}) {
    const message_id = o.message_id ?? `om_${++n}`;
    const create_time = o.create_time ?? String(Date.now());
    const text = typeof content === "string" ? content : JSON.stringify(content);
    if (!o.message_id) item(o.chat_id ?? CHAT, message_id, message_type, text, { id: o.sender ?? ME, id_type: "open_id", sender_type: "user", tenant_key: TENANT }, create_time);
    const event_id = push("im.message.receive_v1", {
      message: {
        chat_id: o.chat_id ?? CHAT,
        chat_type: o.chat_type ?? "p2p",
        content: text,
        create_time,
        message_id,
        message_type,
        // A reply names the message it replies to, and the first of the thread, the same in a private chat.
        ...(o.parent_id && { parent_id: o.parent_id, root_id: o.parent_id }),
        update_time: create_time,
      },
      sender: { sender_id: { open_id: o.sender ?? ME, union_id: "on_owner", user_id: null }, sender_type: "user", tenant_key: TENANT },
    });
    return { event_id, message_id, create_time };
  }

  /** You press a button on a card the bot sent, its value {d: data}; another one, as sender, on a card
   *  passed on to them. Gives the event id: Feishu's answer to the press is that event's ack. */
  const press = (message_id: string, data: string, o: { sender?: string } = {}) =>
    push(
      "card.action.trigger",
      {
        operator: { tenant_key: TENANT, open_id: o.sender ?? ME, union_id: "on_owner" },
        token: "c-fake",
        action: { value: { d: data }, tag: "button" },
        host: "im_message",
        context: { open_message_id: message_id, open_chat_id: CHAT },
      },
      String(Date.now() * 1000), // a press's create_time is in microseconds
    );

  return {
    url: `http://127.0.0.1:${server.port}`,
    acks,
    sent,
    next,
    token,
    link,
    calls,
    scan,
    contact,
    ability,
    connects,
    files,
    downloads,
    forwards,
    uploads,
    history,
    commands,
    menuCalls,
    /** The app has a slash command of its own, or one Rhodium pushed before. */
    command,
    press,
    /** Settles once the long connection is up. */
    connected: () => connected.promise,
    /** Whether the long connection is up. */
    up: () => sock !== undefined,
    /** You send text in your private chat with the bot. */
    say: (text: string, o?: Parameters<typeof message>[2]) => message("text", { text }, o),
    message,
    /** Feishu drops the long connection, as on a network fault. */
    drop: () => sock?.close(),
    stop: () => server.stop(true),
  };
}
