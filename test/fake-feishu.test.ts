// The fake Feishu (test/feishu-api.ts) answers as Feishu did when the probe recorded it
// (test/fixtures/feishu/session.jsonl): the same fields, of the same types. Values differ.
import * as lark from "@larksuiteoapi/node-sdk";
import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP, feishuApi, SECRET } from "./feishu-api";
import { until } from "./instance";

const recorded = readFileSync(join(import.meta.dir, "fixtures/feishu/session.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l) as { ev: string; name?: string; res?: any; event?: any });
const answer = (name: string) => recorded.find((r) => r.ev === "api" && r.name === name)!.res;
/** The first message of the type recorded. */
const event = (type: string) => recorded.find((r) => r.event?.message?.message_type === type)!.event;

/** Fields and the types of their values, an array's by its first item. */
function shape(x: unknown): unknown {
  if (Array.isArray(x)) return x.length ? [shape(x[0])] : [];
  if (x && typeof x === "object") return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, shape(v)]));
  return x === null ? null : typeof x;
}

let api: ReturnType<typeof feishuApi>;
afterEach(() => api.stop());

test("the fake's answers to sending a card and editing it have the fields and types of Feishu's", async () => {
  api = feishuApi();
  const content = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "hi" }] } });
  const post = await fetch(`${api.url}/open-apis/im/v1/messages?receive_id_type=open_id`, { method: "POST", body: JSON.stringify({ receive_id: "ou_owner", msg_type: "interactive", content }) });
  expect(shape(await post.json())).toEqual(shape(answer("message.create interactive")));
  const patch = await fetch(`${api.url}/open-apis/im/v1/messages/om_1`, { method: "PATCH", body: JSON.stringify({ content }) });
  expect(shape(await patch.json())).toEqual(shape(answer("message.patch")));
});

test("the fake's answers to uploading a picture and a file, sending them, and reading a forward have the fields and types of Feishu's", async () => {
  api = feishuApi();
  const post = async (path: string, form: Record<string, string | Blob>) => {
    const body = new FormData();
    for (const [k, v] of Object.entries(form)) body.append(k, v);
    return (await (await fetch(`${api.url}${path}`, { method: "POST", body })).json()) as any;
  };
  const image = await post("/open-apis/im/v1/images", { image_type: "message", image: new Blob(["png"]) });
  expect(shape(image.data)).toEqual(shape(answer("image.create")));
  const file = await post("/open-apis/im/v1/files", { file_type: "stream", file_name: "a.html", file: new Blob(["html"]) });
  expect(shape(file.data)).toEqual(shape(answer("file.create")));
  expect(api.uploads.map((u) => [u.kind, u.fields, Buffer.from(u.bytes).toString()])).toEqual([
    ["image", { image_type: "message" }, "png"],
    ["file", { file_type: "stream", file_name: "a.html" }, "html"],
  ]);
  for (const [type, content] of [["image", { image_key: image.data.image_key }], ["file", { file_key: file.data.file_key }]] as const) {
    const sent = await fetch(`${api.url}/open-apis/im/v1/messages?receive_id_type=open_id`, { method: "POST", body: JSON.stringify({ receive_id: "ou_owner", msg_type: type, content: JSON.stringify(content) }) });
    expect(shape(await sent.json())).toEqual(shape(answer(`message.create ${type}`)));
  }
  const recorded = answer("message.get");
  api.forwards.set("om_f", recorded.data.items);
  expect(shape(await (await fetch(`${api.url}/open-apis/im/v1/messages/om_f`)).json())).toEqual(shape(recorded));
});

test("the fake's list of a chat's messages, yours and the bot's cards, has the fields and types of Feishu's", async () => {
  api = feishuApi();
  api.say("你好");
  const content = JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "hi" }] } });
  await fetch(`${api.url}/open-apis/im/v1/messages?receive_id_type=open_id`, { method: "POST", body: JSON.stringify({ receive_id: "ou_owner", msg_type: "interactive", content }) });
  const list = await fetch(`${api.url}/open-apis/im/v1/messages?container_id_type=chat&container_id=oc_p2p&sort_type=ByCreateTimeAsc&page_size=50`);
  const got = (await list.json()) as any;
  const want = answer("message.list");
  expect(shape(got)).toEqual(shape(want));
  // Items as recorded: the user's and the app's, each by its own fields.
  const by = (r: any, t: string) => shape(r.data.items.find((i: any) => i.sender.sender_type === t));
  expect([by(got, "user"), by(got, "app")]).toEqual([by(want, "user"), by(want, "app")]);
});

test("the fake's text and rich text messages reach the SDK's handler with the fields and types of Feishu's, and the SDK acks each", async () => {
  api = feishuApi();
  const got: any[] = [];
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({ "im.message.receive_v1": async (d) => void got.push(d) });
  const ws = new lark.WSClient({ appId: APP, appSecret: SECRET, domain: api.url, loggerLevel: lark.LoggerLevel.error });
  await ws.start({ eventDispatcher: dispatcher });
  await api.connected();
  const text = event("text");
  const post = event("post");
  api.say("你好");
  api.message("post", post.message.content);
  await until(() => api.acks.length === 2, 5_000);
  ws.close({ force: true });
  expect(shape(got[0])).toEqual(shape(text));
  // A reply's parent_id and root_id are the only fields the recorded one has more.
  const { parent_id, root_id, ...unreplied } = post.message;
  expect(shape(got[1])).toEqual(shape({ ...post, message: unreplied }));
  expect(api.acks.map((a) => a.code)).toEqual([200, 200]);
});

test("the fake's pictures, files, voice, stickers and forwards reach the SDK's handler with the fields and types of Feishu's", async () => {
  api = feishuApi();
  const got: any[] = [];
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({ "im.message.receive_v1": async (d) => void got.push(d) });
  const ws = new lark.WSClient({ appId: APP, appSecret: SECRET, domain: api.url, loggerLevel: lark.LoggerLevel.error });
  await ws.start({ eventDispatcher: dispatcher });
  await api.connected();
  const types = ["image", "file", "audio", "sticker", "merge_forward"];
  for (const type of types) api.message(type, event(type).message.content);
  await until(() => api.acks.length === types.length, 5_000);
  ws.close({ force: true });
  expect(got.map(shape)).toEqual(types.map((type) => shape(event(type))));
});

test("the fake's bot info, scope list and contact book (without the permission to read your name) have the fields and types of Feishu's", async () => {
  api = feishuApi();
  const get = async (path: string) => (await fetch(`${api.url}${path}`)).json();
  expect(shape(await get("/open-apis/bot/v3/info"))).toEqual(shape(answer("bot.info")));
  expect(shape(await get("/open-apis/application/v6/scopes"))).toEqual(shape(answer("scope.list")));
  expect(shape(await get("/open-apis/contact/v3/users/ou_owner?user_id_type=open_id"))).toEqual(shape(answer("contact.user.get")));
});

test("the fake's answers to listing the / menu and making a command have the fields and types of Feishu's", async () => {
  api = feishuApi();
  const slash = `${api.url}/open-apis/application/v7/app_slash_commands`;
  const made = await fetch(slash, { method: "POST", body: JSON.stringify({ command: "stop", description: { default_value: "停下这一回合" } }) });
  expect(shape(await made.json())).toEqual(shape(answer("slash.create")));
  const listed = recorded.filter((r) => r.ev === "api" && r.name === "slash.list").at(-1)!.res;
  expect(shape(await (await fetch(slash)).json())).toEqual(shape(listed));
});

test("the fake's press reaches the SDK's card handler with the fields and types of Feishu's, and what the handler gives back comes with its ack", async () => {
  api = feishuApi();
  const got: any[] = [];
  const dispatcher = new lark.EventDispatcher({ loggerLevel: lark.LoggerLevel.error }).register({
    "card.action.trigger": async (d: any) => (got.push(d), { toast: { type: "info", content: "收到" } }),
  });
  const ws = new lark.WSClient({ appId: APP, appSecret: SECRET, domain: api.url, loggerLevel: lark.LoggerLevel.error });
  await ws.start({ eventDispatcher: dispatcher });
  await api.connected();
  const id = api.press("om_1", "ask:A1:1");
  await until(() => api.acks.length === 1, 5_000);
  ws.close({ force: true });
  const press = recorded.find((r) => r.event?.event_type === "card.action.trigger")!.event;
  // The recorded value is the probe's own; Rhodium's is {d}.
  expect(shape({ ...got[0], action: { ...got[0].action, value: {} } })).toEqual(shape({ ...press, action: { ...press.action, value: {} } }));
  expect(got[0].action.value).toEqual({ d: "ask:A1:1" });
  expect(api.acks).toEqual([{ event_id: id, event_type: "card.action.trigger", code: 200, data: { toast: { type: "info", content: "收到" } } }]);
});
