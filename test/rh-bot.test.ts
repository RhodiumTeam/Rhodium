// rh bot (seam one): you make a bot at your terminal; rhodium writes it into its config file bound
// to a slot, takes it in while it runs on and gives the pairing code (product §5.11, architecture
// §8.5). Telegram's Bot API is a local stand-in, and so is QQ's QR service, preloaded into rh, and
// Feishu (test/feishu-api.ts), its scan included.
import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { botApi } from "./bot-api";
import { APP, BOT, feishuApi, ME, SECRET } from "./feishu-api";
import type { Script } from "./fake-agent/fake-agent";
import { endTurn, on, startTurn } from "./fake-agent/scripts";
import { QR } from "./fake-qq-connect";
import { newInstance, until, type Instance } from "./instance";

const TOKEN = "123456:pasted-token-never-shown";
const ME_Q = "me-under-q";

let rhodium: Instance;
let api: ReturnType<typeof botApi> | undefined;
let fs: ReturnType<typeof feishuApi> | undefined;
afterEach(async () => {
  await rhodium.cleanup();
  api?.stop();
  fs?.stop();
  [api, fs] = [undefined, undefined];
});

/** The files under dir that hold s anywhere in their bytes. */
function filesWith(dir: string, s: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && readFileSync(join(e.parentPath, e.name), "latin1").includes(Buffer.from(s).toString("latin1")))
    .map((e) => join(e.parentPath, e.name));
}

test("story 29: rh bot takes a pasted Telegram token unechoed, checks it and takes the bot in while rhodium runs on; it pairs and works, the bot already there and its running turn go on; the token is nowhere but the config", async () => {
  api = botApi({ token: TOKEN });
  // q's slot w/a runs a slow turn on claude; w/b, the new bot's, runs pi, which replies at once.
  const slow: Script = { on, steps: [...startTurn, { sleep: 6000 }, ...endTurn("slow reply"), { goto: 0 }] };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" } }, claude: { script: slow } });
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  await rhodium.ok("new", "w/b", "--agent", "pi");
  await rhodium.im.inject("q", { chat: ME_Q, sender: ME_Q, text: "take your time" });
  await until(async () => (await rhodium.state("w/a")) === "运行中", 15_000);

  const r = await rhodium.rh(["bot", "t", "telegram", "w/b", "--api-root", api.url], { type: `${TOKEN}\n` });
  expect({ code: r.code, err: r.err }).toMatchObject({ code: 0 });
  expect(r.out).toContain("@rhodium_test_bot");
  expect(r.out).not.toContain("重启");
  const code = r.out.match(/配对码：(\S+)/)?.[1];
  expect(code).toBeString();
  expect(await rhodium.state("w/a")).toBe("运行中");

  // You pair the new bot with the code, then it hands your messages to w/b, and has its menu.
  api.say(code!);
  await until(() => api!.sent.some((m) => m.text === "已配对，以后 Bot t 只认这个账号。"), 15_000);
  // Your private chat with it is there now: your Telegram name under it comes at once, not with the next day's refresh.
  const avatars = join(rhodium.dir, "state/avatars");
  await until(() => readdirSync(avatars).some((f) => f.endsWith(".name")), 15_000);
  expect(readdirSync(avatars).filter((f) => f.endsWith(".name")).map((f) => readFileSync(join(avatars, f), "utf8"))).toEqual(["you"]);
  api.say("hello");
  await until(() => api!.sent.some((m) => m.text === "fake reply"), 15_000);
  await until(() => api!.calls.some((c) => c.method === "setMyCommands"), 15_000);
  // q's turn ends as it would have, and q is still connected.
  await until(async () => (await rhodium.im.log("q", ME_Q)).some((p) => p.text === "slow reply"), 15_000);
  expect(await rhodium.im.connected("q")).toBe(true);
  // The same rhodium all along.
  expect(daemon.proc.exitCode).toBeNull();
  expect(daemon.logs.filter((l) => l.msg === "ready")).toHaveLength(1);

  // The bot is in use now: the same token again is turned down.
  const twin = await rhodium.rh(["bot", "t2", "telegram", "w/b", "--api-root", api.url], { type: `${TOKEN}\n` });
  expect(twin.code).toBe(1);
  expect(twin.err).toContain("rh: 配置里已经有这个 Bot 了，叫 t。");

  expect(statSync(rhodium.config).mode & 0o777).toBe(0o600);
  expect(loadConfig(rhodium.config).bots.t).toEqual({ platform: "telegram", token: TOKEN, apiRoot: api.url, target: "w/b" });
  // Not echoed, not printed, not logged, not in the database's events or anywhere else rhodium keeps.
  expect(r.screen).toBe("");
  expect(r.out + r.err).not.toContain(TOKEN);
  expect(JSON.stringify(daemon.logs)).not.toContain(TOKEN);
  expect(filesWith(join(rhodium.dir, "state"), TOKEN)).toEqual([]);
}, 60_000);

test("story 29: a token Telegram turns down is not written, nor shown", async () => {
  api = botApi({ token: TOKEN });
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  const r = await rhodium.rh(["bot", "t", "telegram", "w/a", "--api-root", api.url], { type: "999:not-a-bot\n" });
  expect(r.code).toBe(1);
  expect(r.err).toContain("rh: Telegram 不认这个 token：");
  expect(r.out + r.err + r.screen).not.toContain("999:not-a-bot");
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

test("a config file the new bot would leave unloadable stays as it was, and rhodium runs on without the bot", async () => {
  api = botApi({ token: TOKEN });
  rhodium = newInstance();
  const daemon = await rhodium.start();
  await rhodium.slots("a");
  const broken = `nonsense = true\n${readFileSync(rhodium.config, "utf8")}`; // edited since rhodium read it
  writeFileSync(rhodium.config, broken);
  const r = await rhodium.rh(["bot", "t", "telegram", "w/a", "--api-root", api.url], { type: `${TOKEN}\n` });
  expect(r.code).toBe(1);
  expect(r.err).toContain("rh: 没能把 Bot t 写进配置文件");
  expect(r.err).toContain("unknown key nonsense");
  expect(readFileSync(rhodium.config, "utf8")).toBe(broken);
  expect(readdirSync(rhodium.dir).filter((f) => f.startsWith("config.toml"))).toEqual(["config.toml"]);
  expect(await rhodium.rh(["pair", "t"])).toMatchObject({ code: 1, err: "rh: 没有 Bot t。\n" });
  expect(api.polls).toEqual([]);
  expect(daemon.proc.exitCode).toBeNull();
}, 30_000);

test("rh bot checks the name, the platform and the slot before you scan or paste anything, and only you may run it", async () => {
  rhodium = newInstance({ bots: { q: { like: "qq", owner: "you-openid" } } }); // no target, no main chat
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  const refused = async (args: string[], error: string, opts: { tty?: boolean } = {}) => {
    const r = await rhodium.rh(["bot", ...args], opts);
    expect({ code: r.code, out: r.out }).toEqual({ code: 1, out: "" });
    expect(r.err).toStartWith(`rh: ${error}`);
  };
  await refused(["q", "telegram", "w/a"], "已经有 Bot q。");
  await refused(["t.1", "telegram", "w/a"], "Bot 名字只能由英文字母、数字和 _ - 组成");
  await refused(["t", "wechat", "w/a"], "平台只能是 qq、telegram 或 feishu：wechat");
  await refused(["t", "telegram", "w/nope"], "没有槽位 w/nope。");
  await refused(["t", "telegram"], "没有主 Bot 的默认目标可以照搬。写明绑定到哪个槽位：rh bot t telegram <工作区/槽位>");
  await refused(["t", "qq", "w/a", "--api-root", "http://127.0.0.1:1"], "--api-root 只用于 Telegram 和飞书。");
  await refused(["t", "telegram", "w/a", "--paste"], "--paste 只用于飞书。");
  await refused(["t", "telegram", "w/a"], "rh bot 只有用户本人能用。", { tty: false });
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

/** What rh bot qq says under each QR code it draws. */
const SCAN_QQ = (url: string) => `用手机 QQ 扫上面的二维码，点“创建新机器人”建一个新的（或在 QQ 里打开这个链接）：${url}\n标“在线”的 Bot 别选：它正被别的服务用着，选了会从那边断开。\n`;

test("story 28: rh bot scans a QR code for a QQ bot, as qq-cli does, a new one when it expires; the bot goes into the config bound to the main bot's target, the scanner as its owner, and rhodium takes it in", async () => {
  // The new bot's made-up AppID never reaches QQ: its requests go to a proxy that is not there.
  const env = { HTTPS_PROXY: "http://127.0.0.1:9", https_proxy: "http://127.0.0.1:9" };
  rhodium = newInstance({ bots: { q: { like: "qq", owner: ME_Q, target: "w/a" } }, toml: `mainChat = "q/${ME_Q}"`, env });
  await rhodium.start();
  await rhodium.slots("a");

  const r = await rhodium.rh(["bot", "q2", "qq"], { preload: join(import.meta.dir, "fake-qq-connect.ts") });
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toStartWith("建 QQ Bot q2，建完绑定到 w/a。\n");
  expect(r.out).toMatch(/[▀▄█]/); // the QR code
  // "创建新机器人": not a bot another service holds: picking it pulls it off there.
  expect(r.out).toContain(`${SCAN_QQ(QR.expired)}二维码过期了，正在换一个……\n`);
  expect(r.out).toEndWith(`${SCAN_QQ(QR.url)}扫码成功：AppID ${QR.appId}。\n已把 Bot q2 写进配置文件并启用，绑定到 w/a。\n扫码的 QQ 账号已记为你，Bot q2 不用再配对。\n`);
  // rhodium has the bot, with the owner its config gives.
  expect(await rhodium.rh(["pair", "q2"])).toMatchObject({ code: 1, err: "rh: Bot q2 的配置里写了 owner，以配置为准。要换账号，改配置文件里的 owner。\n" });
  expect(statSync(rhodium.config).mode & 0o777).toBe(0o600);
  expect(loadConfig(rhodium.config).bots.q2).toEqual({ platform: "qq", appId: QR.appId, secret: QR.secret, owner: QR.openid, target: "w/a" });
  expect(r.out).not.toContain(QR.secret);
  expect(filesWith(join(rhodium.dir, "state"), QR.secret)).toEqual([]);
}, 30_000);

test("rh bot turns down a bot the config has already, by its AppID or token: two connections to one bot push each other off", async () => {
  api = botApi({ token: TOKEN });
  rhodium = newInstance({ bots: { q: { like: "qq", owner: "me-under-q", target: "w/a", appId: QR.appId }, t: { like: "telegram", target: "w/a", token: TOKEN } } });
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  const qq = await rhodium.rh(["bot", "q2", "qq", "w/a"], { preload: join(import.meta.dir, "fake-qq-connect.ts") });
  expect({ code: qq.code, err: qq.err }).toEqual({ code: 1, err: "rh: 配置里已经有这个 Bot 了，叫 q。要再建一个，扫码后点“创建新机器人”。\n" });
  const tg = await rhodium.rh(["bot", "t2", "telegram", "w/a", "--api-root", api.url], { type: `${TOKEN}\n` });
  expect(tg.code).toBe(1);
  expect(tg.err).toEndWith("\nrh: 配置里已经有这个 Bot 了，叫 t。要再建一个，向 @BotFather 发 /newbot。\n"); // after the paste prompt
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

// ---- Feishu: the scan, or the App ID and secret pasted (docs/spec/feishu.md "rh bot"). ----

const PICK = "页面上可以新建应用，也可以选已有的。选已有的，先停掉正连着它的程序：一个应用连着两处时，每条消息只随机推给其中一处。";
const CONTACT = "看板要显示你的飞书头像和名字，还要在开发者后台给这个应用加权限“获取用户基本信息”（contact:user.base:readonly），再发布一个版本。";
/** What the fake claude was asked, user frame by user frame. */
const asked = () =>
  rhodium.claude
    .runs()
    .flatMap((r) => r.stdin.map((l) => JSON.parse(l)))
    .filter((m) => m.type === "user")
    .map((m) => m.message.content[0].text as string);

test("stories 450, 454: rh bot feishu scans: a link and its QR code, a new one when it expires; the scanner is you, with no pairing; the bot is taken in and works; its secret is nowhere but the config; a word on the permission to read your name", async () => {
  fs = feishuApi();
  fs.scan.expire = 1;
  rhodium = newInstance();
  const daemon = await rhodium.start();
  await rhodium.slots("a");

  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--api-root", fs.url]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toStartWith(`建飞书 Bot fs，建完绑定到 w/a。\n${PICK}\n用飞书扫下面的二维码，或在手机上点这个链接（1 小时内有效）：\nhttps://open.feishu.cn/page/launcher?user_code=FAKE-1&`);
  expect(r.out).toMatch(/[▀▄█]/); // the QR code
  expect(r.out).toContain("\n链接过期了，正在换一个……\n用飞书扫下面的二维码，或在手机上点这个链接（1 小时内有效）：\nhttps://open.feishu.cn/page/launcher?user_code=FAKE-2&");
  expect(r.out).toEndWith(`扫码成功：App ID ${APP}。\n已把 Bot fs 写进配置文件并启用，绑定到 w/a。\n扫码的飞书账号已记为你，Bot fs 不用再配对。\n${CONTACT}\n`);
  expect(loadConfig(rhodium.config).bots.fs).toEqual({ platform: "feishu", appId: APP, secret: SECRET, owner: ME, apiRoot: fs.url, target: "w/a" });

  // It takes your messages at once, with no pairing, and the board has its avatar.
  await fs.connected();
  fs.say("hello");
  await until(() => asked().some((t) => t.endsWith("\nhello")), 15_000);
  const avatars = join(rhodium.dir, "state/avatars");
  await until(() => existsSync(avatars) && readdirSync(avatars).some((f) => readFileSync(join(avatars, f), "utf8") === "fake bot avatar"), 15_000);

  expect(r.out).not.toContain(SECRET);
  expect(JSON.stringify(daemon.logs)).not.toContain(SECRET);
  expect(filesWith(join(rhodium.dir, "state"), SECRET)).toEqual([]);
}, 60_000);

test("story 453: a Lark account's scan is turned down, and nothing is written", async () => {
  fs = feishuApi();
  fs.scan.brand = "lark";
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--api-root", fs.url]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 1, err: "rh: 暂不支持 Lark（飞书国际版）。刚建的应用在 Lark 的开发者后台，用不着可以删掉。\n" });
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

test("story 450: a scan by the bot's own account records no owner: you pair instead", async () => {
  fs = feishuApi();
  fs.scan.by = BOT;
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");
  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--api-root", fs.url]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).not.toContain("不用再配对");
  expect(r.out).toMatch(/\n配对码：\S+\n/);
  expect(loadConfig(rhodium.config).bots.fs).toEqual({ platform: "feishu", appId: APP, secret: SECRET, apiRoot: fs.url, target: "w/a" });
}, 30_000);

test("story 450: a scan whose bot's info can't be had records no owner, and says why: you pair instead", async () => {
  fs = feishuApi();
  fs.ability.bot = false;
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");
  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--api-root", fs.url]);
  expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: "" });
  expect(r.out).toContain(`扫码成功：App ID ${APP}。\n问不到这个应用的 Bot 信息（99999 the app has no bot），认不出扫码的是你还是 Bot 自己，改用配对码。\n已把 Bot fs 写进配置文件并启用`);
  expect(r.out).toMatch(/\n配对码：\S+\n/);
  expect(loadConfig(rhodium.config).bots.fs).toEqual({ platform: "feishu", appId: APP, secret: SECRET, apiRoot: fs.url, target: "w/a" });
}, 30_000);

test("stories 452, 454: rh bot feishu --paste takes the App ID and, unechoed, the secret of an app with no bot yet; it says what to set up in the console, then pairs; your name and avatar come once paired", async () => {
  fs = feishuApi();
  fs.contact.granted = true;
  fs.ability.bot = false; // made in the console just now: its bot comes with the steps rh lists
  rhodium = newInstance();
  const daemon = await rhodium.start();
  await rhodium.slots("a");

  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--paste", "--api-root", fs.url], { type: [`${APP}\n`, `${SECRET}\n`] });
  expect({ code: r.code, err: r.err }).toMatchObject({ code: 0 });
  expect(r.screen).toContain(APP);
  expect(r.screen).not.toContain(SECRET);
  expect(r.out).toContain("App ID 和密钥有效。\n已把 Bot fs 写进配置文件并启用，绑定到 w/a。\n");
  expect(r.out).toContain(
    [
      "在开发者后台给这个应用做完这几步，再私聊 Bot 发配对码：",
      "1. 添加机器人能力。",
      "2. 事件与回调：订阅方式选长连接；加事件“接收消息”（im.message.receive_v1）；加回调“卡片回传交互”（card.action.trigger）。",
      "3. 发布一个版本。",
      "配对码：",
    ].join("\n"),
  );
  expect(r.out).not.toContain(CONTACT); // the app may read your name already
  expect(r.out).not.toContain(PICK);
  expect(loadConfig(rhodium.config).bots.fs).toEqual({ platform: "feishu", appId: APP, secret: SECRET, apiRoot: fs.url, target: "w/a" });

  // You do the steps and pair; then your Feishu name is there for the board.
  fs.ability.bot = true;
  const code = r.out.match(/配对码：(\S+)/)![1]!;
  await fs.connected();
  fs.say(code);
  await until(() => fs!.sent.some((m) => JSON.stringify(m.card).includes("已配对，以后 Bot fs 只认这个账号。")), 15_000);
  const avatars = join(rhodium.dir, "state/avatars");
  await until(() => readdirSync(avatars).some((f) => f.endsWith(".name")), 15_000);
  expect(readdirSync(avatars).filter((f) => f.endsWith(".name")).map((f) => readFileSync(join(avatars, f), "utf8"))).toEqual(["你"]);

  expect(r.out + r.err).not.toContain(SECRET);
  expect(JSON.stringify(daemon.logs)).not.toContain(SECRET);
  expect(filesWith(join(rhodium.dir, "state"), SECRET)).toEqual([]);
}, 60_000);

test("story 452: an App ID and secret Feishu turns down are not written, and the secret is not shown", async () => {
  fs = feishuApi();
  rhodium = newInstance();
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  // Another app: the SDK keeps the token it got by App ID.
  const r = await rhodium.rh(["bot", "fs", "feishu", "w/a", "--paste", "--api-root", fs.url], { type: ["cli_fedcba9876543210\n", "not-the-secret\n"] });
  expect(r.code).toBe(1);
  expect(r.err).toContain("rh: 飞书不认这组 App ID 和密钥：");
  expect(r.err).toContain("10014");
  expect(r.out + r.err + r.screen).not.toContain("not-the-secret");
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);

test("rh bot turns down a Feishu app the config has already, by its App ID", async () => {
  fs = feishuApi();
  const toml = ["[bots.fs]", 'platform = "feishu"', `appId = "${APP}"`, `secret = "${SECRET}"`, `apiRoot = "${fs.url}"`, `owner = "${ME}"`, 'target = "w/a"'].join("\n");
  rhodium = newInstance({ toml });
  await rhodium.start();
  await rhodium.slots("a");
  const before = readFileSync(rhodium.config, "utf8");
  const r = await rhodium.rh(["bot", "fs2", "feishu", "w/a", "--api-root", fs.url]);
  expect(r.code).toBe(1);
  expect(r.err).toBe("rh: 配置里已经有这个 Bot 了，叫 fs。要再建一个，扫码时选新建应用。\n");
  expect(readFileSync(rhodium.config, "utf8")).toBe(before);
}, 30_000);
