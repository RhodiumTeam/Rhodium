// rh bot, the terminal side (product §5.11, architecture §8.5). rhodium checks the name and the slot
// first, so nothing is scanned or pasted for a bot it would refuse. QQ: scan a QR code with mobile
// QQ, as qq-cli's `qq init --qr` does. Telegram: paste the token, never echoed, and getMe checks it.
// Feishu: scan, or paste the App ID and the secret, never echoed (docs/spec/feishu.md "rh bot").
// rhodium writes the bot into its config file and takes it in as it runs; rh gives the pairing code.
import type * as Lark from "@larksuiteoapi/node-sdk";
import { parseArgs } from "node:util";
import { Api } from "grammy";
import { amid, PLATFORMS, type Made } from "./platforms";
import type { RhReply } from "./router";

/** One rh call to rhodium; throws when rhodium cannot be reached. */
export type Ask = (argv: string[], credentials?: Record<string, string>) => Promise<RhReply>;

const say = (text: string) => void process.stdout.write(text.endsWith("\n") ? text : text + "\n");

/** How rh bot gets a platform's credentials at the terminal (apiRoot: --api-root; paste: --paste,
 *  where the platform takes it), and what it says once the bot is in and paired. */
type Onboard = {
  credentials(apiRoot: string | undefined, paste: boolean): Promise<Record<string, string>>;
  done?(credentials: Record<string, string>, apiRoot: string | undefined): Promise<void>;
};

export const ONBOARD: Record<Made, Onboard> = {
  qq: { credentials: () => scan() },
  telegram: { credentials: (apiRoot) => paste(apiRoot) },
  feishu: {
    credentials: (apiRoot, paste) => (paste ? feishuPaste(apiRoot) : feishuScan(apiRoot)),
    async done(credentials, apiRoot) {
      if (await readsYou(credentials, apiRoot)) return;
      say("看板要显示你的飞书头像和名字，还要在开发者后台给这个应用加权限“获取用户基本信息”（contact:user.base:readonly），再发布一个版本。");
    },
  },
};

export async function bot(args: string[], ask: Ask): Promise<number> {
  const fail = (text: string) => (process.stderr.write(`rh: ${text}\n`), 1);
  const first = await ask(["bot", ...args]);
  if (!first.ok) return fail(first.error);
  say(first.text);
  const { values, positionals } = parseArgs({ args, options: { "api-root": { type: "string" }, paste: { type: "boolean" } }, allowPositionals: true });
  // rhodium took the platform: one rh bot makes.
  const [name, platform] = positionals as [string, Made];
  const apiRoot = values["api-root"];

  let credentials: Record<string, string>;
  try {
    credentials = await ONBOARD[platform].credentials(apiRoot, values.paste === true);
  } catch (err) {
    return fail((err as Error).message);
  }
  const added = await ask(["bot", ...args], credentials);
  if (!added.ok) return fail(added.error);
  say(added.text);
  if (credentials.owner) say(`扫码的${amid(PLATFORMS[platform].label)}账号已记为你，Bot ${name} 不用再配对。`);
  else {
    // Only now: Feishu's console saves the long connection only once a program holds one.
    if (values.paste) say(FEISHU_SETUP);
    const pair = await ask(["pair", name]);
    if (!pair.ok) return fail(pair.error);
    say(pair.text);
  }
  await ONBOARD[platform].done?.(credentials, apiRoot);
  return 0;
}

// QQ's QR flow is ported from src/qqbot_agent_sdk/onboard.py of Tencent's qqbot-agent-sdk
// (github.com/tencent-connect/qqbot-agent-sdk, commit 6163b5d), under this notice:
//
// MIT License
//
// Copyright (c) 2025 walli
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

/** One call to QQ's QR service: its data, or an error with its reason. A try with no answer in 10 s
 *  (offline, timed out, not JSON) is tried again 2 s later; the fifth in a row gives up, saying
 *  "连不上 QQ 的扫码服务。" (with the HTTP status if the last try got a page) and then what else. */
async function qqPortal(path: string, body: object, giveUp = ""): Promise<any> {
  for (let tries = 1; ; tries++) {
    const res = await fetch(`https://q.qq.com/lite/${path}`, {
      method: "POST",
      // Without Accept, q.qq.com answers with a page that checks for bots.
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => undefined);
    // A whole page that is not JSON (a 404, a gateway's 502) is asked again too, but QQ did answer: keep its status.
    let status = "";
    const answer = await res?.json().catch((e: unknown) => {
      if (e instanceof SyntaxError) status = `（HTTP ${res.status}）`;
    });
    if (answer?.retcode === 0) return answer.data ?? {};
    if (answer) throw new Error(`QQ 的扫码服务出错：${answer.msg ?? `HTTP ${res!.status}`}`);
    if (tries === 5) throw new Error(`连不上 QQ 的扫码服务${status}。${giveUp}`);
    await Bun.sleep(2000);
  }
}

/** QQ's QR flow, as qq-cli's `qq init --qr`: QQ makes the bot under a bind task, polled every 2 s
 *  until it is done, a new one when it expires. The secret comes sealed with a key only rh has
 *  (AES-256-GCM: IV, ciphertext, tag). The scanner's openid, when QQ gives it, is you under the bot. */
async function scan(): Promise<Record<string, string>> {
  for (;;) {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const task: unknown = (await qqPortal("create_bind_task", { key: Buffer.from(key).toString("base64") })).task_id;
    if (!task) throw new Error("QQ 的扫码服务没有给二维码。");
    const url = `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(String(task))}&_wv=2`;
    qrCode(url);
    // The page lists your bots too: one marked 在线 is in use elsewhere, and QQ moves it here if picked.
    say(`用手机 QQ 扫上面的二维码，点“创建新机器人”建一个新的（或在 QQ 里打开这个链接）：${url}\n标“在线”的 Bot 别选：它正被别的服务用着，选了会从那边断开。`);
    let bound: any;
    // 1: not scanned yet, 2: done, 3: expired.
    const poll = () => qqPortal("poll_bind_result", { task_id: task }, "扫了码的话，QQ 那边可能已经建好了 Bot，去 QQ 开放平台（q.qq.com）看看。");
    while (![2, 3].includes((bound = await poll()).status)) await Bun.sleep(2000);
    if (bound.status === 3) {
      say("二维码过期了，正在换一个……");
      continue;
    }
    const appId = String(bound.bot_appid ?? "");
    const sealed = Buffer.from(String(bound.bot_encrypt_secret ?? ""), "base64");
    const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const secret = await crypto.subtle.decrypt({ name: "AES-GCM", iv: sealed.subarray(0, 12) }, aes, sealed.subarray(12)).then(
      (s) => new TextDecoder().decode(s),
      () => "",
    );
    if (!appId || !secret) throw new Error("扫码没有拿到 Bot 的 AppID 和 AppSecret。");
    say(`扫码成功：AppID ${appId}。`);
    return { appId, secret, ...(bound.user_openid && { owner: String(bound.user_openid) }) };
  }
}

/** text's QR code, drawn on the terminal. */
const qrCode = (text: string): void =>
  (require("qrcode-terminal") as { generate(text: string, o: { small: boolean }, done: (qr: string) => void): void }).generate(text, { small: true }, say);

/** Telegram: the token as pasted, once getMe takes it. */
async function paste(apiRoot: string | undefined): Promise<Record<string, string>> {
  const token = await readLine("粘贴 @BotFather 给的 token（不回显），回车：", true);
  if (!token) throw new Error("没有粘贴 token。");
  try {
    const me = await new Api(token, apiRoot === undefined ? {} : { apiRoot }).getMe();
    say(`token 有效：@${me.username}`);
  } catch (err) {
    // grammY leaves the token out of its errors; this makes sure of it.
    throw new Error(`Telegram 不认这个 token：${String((err as Error).message).replaceAll(token, "<token>")}`);
  }
  return { token };
}

const FEISHU_SETUP = [
  "在开发者后台给这个应用做完这几步，再私聊 Bot 发配对码：",
  "1. 添加机器人能力。",
  "2. 事件与回调：订阅方式选长连接；加事件“接收消息”（im.message.receive_v1）；加回调“卡片回传交互”（card.action.trigger）。",
  "3. 发布一个版本。",
].join("\n");

/** Feishu's SDK, its calls given up after 30 s: unset, they have none. */
async function lark(): Promise<typeof Lark> {
  const sdk = await import("@larksuiteoapi/node-sdk");
  sdk.defaultHttpInstance.defaults.timeout = 30_000;
  return sdk;
}

/** One GET to Feishu's open platform as the app, or with no url only its access token: Feishu's
 *  answer, or an error with its reason and never the secret. The SDK logs nothing: its errors hold
 *  the request, secret and all. */
async function feishuGet(c: Record<string, string>, apiRoot: string | undefined, url?: string): Promise<any> {
  const sdk = await lark();
  const quiet = () => {};
  const logger = { error: quiet, warn: quiet, info: quiet, debug: quiet, trace: quiet };
  const client = new sdk.Client({ appId: c.appId!, appSecret: c.secret!, domain: apiRoot ?? sdk.Domain.Feishu, logger });
  const call = url === undefined ? client.tokenManager.getTenantAccessToken().then(() => ({ code: 0 })) : client.request({ method: "GET", url });
  const answer = await call.catch((e: any) => e?.response?.data ?? { msg: String(e?.message ?? e) });
  if (answer?.code !== 0) throw new Error(`${answer?.code ?? ""} ${answer?.msg ?? ""}`.trim().replaceAll(c.secret!, "<secret>"));
  return answer;
}

/** Whether the app may read your name and avatar; a list that can't be had is a no. */
const readsYou = (c: Record<string, string>, apiRoot: string | undefined): Promise<boolean> =>
  feishuGet(c, apiRoot, "/open-apis/application/v6/scopes").then(
    (a) => a.data?.scopes?.some((s: any) => s.scope_name === "contact:user.base:readonly" && s.grant_status === 1) === true,
    () => false,
  );

/** Feishu's scan (registerApp), with nothing added to the app: with more, a scan on 2026-10-26 made
 *  the app and gave no credentials (spec "rh bot"). A link that expires gives way to a new one. The
 *  scanner is you, unless it is the bot itself. apiRoot: the scan goes there too. */
async function feishuScan(apiRoot: string | undefined): Promise<Record<string, string>> {
  const sdk = await lark();
  if (apiRoot !== undefined) sdk.defaultHttpInstance.interceptors.request.use((c) => ((c.url = c.url?.replace(/^https:\/\/accounts\.(feishu\.cn|larksuite\.com)/, apiRoot)), c));
  say("页面上可以新建应用，也可以选已有的。选已有的，先停掉正连着它的程序：一个应用连着两处时，每条消息只随机推给其中一处。");
  let app: Awaited<ReturnType<typeof Lark.registerApp>> | undefined;
  while (!app) {
    app = await sdk
      .registerApp({
        source: "rhodium",
        onQRCodeReady: ({ url, expireIn }) => {
          const within = expireIn % 3600 ? `${Math.round(expireIn / 60)} 分钟` : `${expireIn / 3600} 小时`;
          say(`用飞书扫下面的二维码，或在手机上点这个链接（${within}内有效）：\n${url}`);
          qrCode(url);
        },
      })
      .catch((e) => {
        if (e?.code !== "expired_token") throw new Error(`扫码没有建成应用：${e?.description ?? e?.message ?? e}`);
        say("链接过期了，正在换一个……");
        return undefined;
      });
  }
  if (app.user_info?.tenant_brand === "lark") throw new Error("暂不支持 Lark（飞书国际版）。刚建的应用在 Lark 的开发者后台，用不着可以删掉。");
  say(`扫码成功：App ID ${app.client_id}。`);
  const c = { appId: app.client_id, secret: app.client_secret };
  const bot = await feishuGet(c, apiRoot, "/open-apis/bot/v3/info").catch((e) =>
    say(`问不到这个应用的 Bot 信息（${e.message}），认不出扫码的是你还是 Bot 自己，改用配对码。`),
  );
  const scanner = app.user_info?.open_id;
  return { ...c, ...(bot && scanner && scanner !== bot.bot?.open_id && { owner: scanner }) };
}

/** The App ID and secret of an app made in Feishu's console, as pasted, the secret unechoed, once
 *  Feishu gives an access token for them: its bot's info would need the bot, which comes only with
 *  the steps listed after. */
async function feishuPaste(apiRoot: string | undefined): Promise<Record<string, string>> {
  const appId = await readLine("App ID：");
  const secret = await readLine("App Secret（不回显）：", true);
  if (!appId || !secret) throw new Error("没有粘贴 App ID 和密钥。");
  await feishuGet({ appId, secret }, apiRoot).catch((e) => Promise.reject(new Error(`飞书不认这组 App ID 和密钥：${e.message}`)));
  say("App ID 和密钥有效。");
  return { appId, secret };
}

let lines: AsyncIterator<string> | undefined;
/** A line from the terminal on stdin; hidden: with its echo off while it is typed. */
async function readLine(prompt: string, hidden = false): Promise<string> {
  const stty = (arg: string) => Bun.spawnSync(["stty", arg], { stdin: "inherit", stdout: "ignore", stderr: "ignore" }).success;
  if (hidden) {
    if (!stty("-echo")) throw new Error("rh bot 要在终端里运行，粘贴的才能不回显。");
    process.once("SIGINT", () => {
      stty("echo");
      process.exit(130);
    });
  }
  try {
    process.stderr.write(prompt); // after echo is off, so nothing typed on seeing it shows
    const line = await (lines ??= console[Symbol.asyncIterator]()).next();
    return line.done ? "" : line.value.trim();
  } finally {
    if (hidden) {
      stty("echo");
      process.stderr.write("\n");
    }
  }
}
