// The new bot's wizard on the board (spec web-bots stories 670-679), in a real Chromium on a phone and
// a wide screen: against rhodium's board serving a store the tests write to, its bot-making flows a
// fake the tests move along, as rhodium's would as you scan, paste or send the code. Skipped without
// the Chromium playwright-core finds in its cache.
import { afterAll, beforeAll, expect, onTestFinished, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Page } from "playwright-core";
import { qrSvg, type BotFlows, type FlowView } from "../src/bot-flow";
import { serveBoard } from "../src/board";
import { loadConfig } from "../src/config";
import type { Made } from "../src/platforms";
import type { RhReply } from "../src/router";
import { openStore } from "../src/store";
import { botName, startTarget } from "../web/src/bot-wizard";
import { BOARD_LOGIN, run } from "./instance";

const browser = await chromium.launch({ handleSIGTERM: false }).catch((e: Error) => {
  if (!/Executable doesn't exist/.test(e.message)) throw e;
  console.warn(`board-bot-wizard: skipped, no Chromium for playwright-core: ${e.message.split("\n")[0]}`);
  return null;
});
const smoke = (name: string, fn: () => Promise<void>) => (browser ? test : test.skip)(name, fn, 20_000);

const base = mkdtempSync(join(tmpdir(), "rhodium-test-wizard-"));
writeFileSync(
  join(base, "config.toml"),
  [`stateDir = "${base}/state"`, `mainChat = "qq/you"`, "[board]", "port = 0", `login = "${BOARD_LOGIN}"`, "[bots.qq]", `platform = "qq"`, `appId = "1"`, `secret = "s"`, `owner = "you"`, `target = "w/a"`].join("\n") + "\n",
  { mode: 0o600 },
);
const store = openStore(join(base, "rh.db"));
const { a } = store.tx((tx) => {
  const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
  const slot = (name: string) => tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
  const a = slot("a");
  slot("b");
  tx.insert("bot", { name: "qq", platform: "qq", isMain: 1 });
  return { a };
});

/** The flows the page started, by the arguments rh bot would have; each moved along by set(). */
const flows = new Map<string, FlowView>();
const started: string[][] = [];
const cancelled: string[] = [];
const watchers = new Set<(id: string) => void>();
const set = (id: string, patch: Partial<FlowView>) => (Object.assign(flows.get(id)!, patch), watchers.forEach((w) => w(id)));
const reply = (f: FlowView | undefined): RhReply => (f ? { ok: true, text: "", flow: f } : { ok: false, error: "没有这个流程。" });
const URL_ = "https://q.qq.com/qqbot/openclaw/connect.html?task_id=T";
const fake = {
  watch: (w: (id: string) => void) => watchers.add(w),
  async start(argv: string[]) {
    started.push(argv);
    const [name, platform] = argv as [string, Made];
    // As the router: --paste is Feishu's own choice; Telegram always takes a pasted token.
    if (argv.includes("--paste") && platform !== "feishu") return { ok: false, error: "--paste 只用于飞书。" };
    const paste = platform === "telegram" || argv.includes("--paste");
    const f: FlowView = { id: crypto.randomUUID(), name, platform, state: paste ? "paste" : "scan", log: [], ...(!paste && { url: URL_, svg: qrSvg(URL_) }) };
    flows.set(f.id, f);
    return reply(f);
  },
  get: (id: string) => reply(flows.get(id)),
  async credentials(id: string, pasted: Record<string, string>): Promise<RhReply> {
    if (pasted.token === "bad") {
      set(id, { error: "Telegram 不认这个 token：401" });
      return { ok: false, error: "Telegram 不认这个 token：401" };
    }
    set(id, { state: "pairing", error: undefined, code: "K7QM2XPD", until: Date.now() + 600_000, target: "w/a" });
    return reply(flows.get(id));
  },
  cancel(id: string) {
    cancelled.push(id);
    set(id, { state: "cancelled" });
    return reply(flows.get(id));
  },
} as unknown as BotFlows;

let server: ReturnType<typeof serveBoard>["servers"][number] | undefined;
beforeAll(async () => {
  if (!browser) return;
  const web = join(base, "web");
  await run([process.execPath, "--bun", "vite", "build", "web", "--outDir", web, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: join(import.meta.dir, ".."),
    timeoutMs: 60_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  server = serveBoard(store, loadConfig(join(base, "config.toml")), undefined, web, undefined, undefined, undefined, fake).servers[0]!;
}, 60_000);
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
  store.close();
  rmSync(base, { recursive: true, force: true });
});

const PHONE = devices["Pixel 7"];
const WIDE = { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } };
async function open(device: typeof PHONE, hash = "", before?: (page: Page) => Promise<void>) {
  const context = await browser!.newContext({ ...device, extraHTTPHeaders: { "Tailscale-User-Login": BOARD_LOGIN } });
  onTestFinished(async () => {
    for (const p of context.pages()) await p.unrouteAll({ behavior: "ignoreErrors" });
    await context.close();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await before?.(page);
  await page.goto(`http://127.0.0.1:${server!.port}/#${hash}`);
  return page;
}
const menu = async (page: Page) => (await page.getByRole("menuitem").allTextContents()).map((t) => t.trim());
const plus = async (page: Page) => {
  await page.locator("header").getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建 Bot" }).waitFor();
};

test("story 672: a new bot's name is its platform's, -2, -3 after it while taken; 投递给 starts on the main bot's slot, else the one used last", () => {
  expect(botName("qq", [])).toBe("qq");
  expect(botName("qq", ["qq", "qq-2", "telegram"])).toBe("qq-3");
  const slots = [
    { id: "a", activeAt: 5 },
    { id: "b", activeAt: 9 },
  ];
  expect(startTarget(slots, [{ main: true, target: "a" }])).toBe("a");
  expect(startTarget(slots, [{ main: false, target: "a" }])).toBe("b");
  expect(startTarget(slots, [{ main: true, target: "gone" }])).toBe("b");
  expect(startTarget([], [])).toBeUndefined();
});

for (const [kind, device] of [
  ["a phone", PHONE],
  ["a wide screen", WIDE],
] as const) {
  smoke(`stories 670, 671, on ${kind}: the + has 新建 Bot after 新建槽位 and 导入; greyed with no slot`, async () => {
    const page = await open(device);
    await plus(page);
    expect(await menu(page)).toEqual(["新建槽位", "导入", "新建 Bot"]);
    expect(await page.getByRole("menuitem", { name: "新建 Bot" }).getAttribute("aria-disabled")).toBeNull();
    const empty = await open(device, "", async (p) => void await p.route("**/api/board", (r) => r.fulfill({ json: { workspaces: [], bots: [] } })));
    await plus(empty);
    expect(await empty.getByRole("menuitem", { name: "新建 Bot" }).getAttribute("aria-disabled")).toBe("true");
    // Why it is greyed: under the mouse, or tapped on a phone, where no tooltip comes.
    if (device === PHONE) await empty.getByRole("menuitem", { name: "新建 Bot" }).tap({ force: true });
    else await empty.getByRole("menuitem", { name: "新建 Bot" }).hover();
    await empty.getByText("先新建一个槽位，Bot 的消息才有地方去").waitFor();
    // A word on why, not a tick, as for something done.
    if (device === PHONE) expect(await empty.locator("[role=status] button").evaluate((b) => [!!b.querySelector(".lucide-info"), !!b.querySelector(".lucide-check")])).toEqual([true, false]);
    expect(await empty.getByRole("dialog").count()).toBe(0);
  });

  smoke(`story 670, on ${kind}: the topology's empty canvas has 新建槽位, 导入 and 新建 Bot, by a right click or a finger held there`, async () => {
    const page = await open(device, "/topology");
    const pane = page.locator(".react-flow__pane");
    await page.locator(".react-flow__node").first().waitFor();
    const box = (await pane.boundingBox())!;
    const at = { x: box.x + 8, y: box.y + box.height - 8 };
    if (device === PHONE) {
      await pane.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, clientX: at.x, clientY: at.y });
      await Bun.sleep(600);
    } else await page.mouse.click(at.x, at.y, { button: "right" });
    await page.getByRole("menuitem", { name: "新建 Bot" }).waitFor();
    expect(await menu(page)).toEqual(["新建槽位", "导入", "新建 Bot"]);
    if (device === PHONE) {
      // The browser's own long-press menu for that press is held back, and the next one is not.
      const kept = () => page.evaluate(() => !document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
      expect(await kept()).toBe(true);
      expect(await kept()).toBe(false);
    }
    await page.getByRole("menuitem", { name: "新建 Bot" }).click();
    await page.getByText("第 1 / 2 步").waitFor();
  });
}

smoke("story 670, on a phone: Android's long press, its right click before our 500ms, leaves the browser's own menu to the wizard's boxes", async () => {
  const page = await open(PHONE, "/topology");
  const pane = page.locator(".react-flow__pane");
  await page.locator(".react-flow__node").first().waitFor();
  const box = (await pane.boundingBox())!;
  const at = { clientX: box.x + 8, clientY: box.y + box.height - 8 };
  await pane.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true, ...at });
  await pane.dispatchEvent("contextmenu", { bubbles: true, cancelable: true, ...at });
  await Bun.sleep(600);
  await pane.dispatchEvent("pointerup", { pointerType: "touch", isPrimary: true, ...at });
  await page.getByRole("menuitem", { name: "新建 Bot" }).click();
  await page.getByText("第 1 / 2 步").waitFor();
  const kept = () => page.getByLabel("名称").evaluate((i) => !i.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })));
  expect(await kept()).toBe(false);
});

smoke("stories 672-674, 677, 679, on a phone: QQ by a scan to 创建成功, two steps; the name prefilled past the bot there, 投递给 the main bot's slot", async () => {
  const page = await open(PHONE);
  await plus(page);
  await page.getByRole("menuitem", { name: "新建 Bot" }).click();
  await page.getByText("第 1 / 2 步").waitFor();
  expect(await page.getByLabel("名称").inputValue()).toBe("qq-2");
  await page.getByRole("combobox").getByText("w/a").waitFor();
  await page.getByLabel("名称").fill("bad name");
  await page.getByText("名称只能用英文字母、数字和 _ -").waitFor();
  expect(await page.getByRole("button", { name: "下一步" }).isDisabled()).toBe(true);
  await page.getByLabel("名称").fill("qq-2");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("第 2 / 2 步").waitFor();
  expect(started.at(-1)).toEqual(["qq-2", "qq", a]);
  expect(await page.getByRole("link", { name: "在 QQ 里打开" }).getAttribute("href")).toBe(URL_);
  await page.getByRole("img", { name: "二维码" }).waitFor();
  await page.getByText("等你扫码").waitFor();
  const id = [...flows.values()].find((f) => f.name === "qq-2")!.id;
  set(id, { state: "done", target: "w/a" });
  await page.getByText("创建成功").waitFor();
  await page.getByRole("dialog").getByText("qq-2", { exact: true }).waitFor();
  await page.getByRole("dialog").getByText("w/a", { exact: true }).waitFor();
  // Gone from rhodium later (kept 10 minutes, or a restart) as the page reads everything again: 创建成功 stays.
  flows.delete(id);
  watchers.forEach((w) => w(id));
  await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));
  expect(await page.getByText("创建成功").count()).toBe(1);
  expect(await page.getByText("第 1 / 2 步").count()).toBe(0);
});

smoke("stories 673, 676, 678, 679, on a wide screen: Telegram's token turned down says why under it; taken, the pairing code, then 创建成功 once it is sent; closing a flow cancels it", async () => {
  const page = await open(WIDE);
  await plus(page);
  await page.getByRole("menuitem", { name: "新建 Bot" }).click();
  await page.getByRole("radio", { name: "Telegram" }).click();
  await page.getByText("第 1 / 3 步").waitFor();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("填写 token").waitFor();
  await page.getByText("第 2 / 3 步").waitFor();
  const token = page.getByLabel("token", { exact: true });
  expect(await token.getAttribute("type")).toBe("password");
  expect(await token.getAttribute("autocomplete")).toBe("off");
  await token.fill("bad");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("Telegram 不认这个 token：401").waitFor();
  await page.getByRole("button", { name: "显示" }).click();
  expect(await token.getAttribute("type")).toBe("text");
  await token.fill("123:good");
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("第 3 / 3 步").waitFor();
  await page.getByText("K7QM2XPD", { exact: true }).waitFor();
  await page.getByText("私聊 telegram，发送这个码").waitFor();
  await page.getByText(/^(10:00|9:5\d)$/).waitFor();
  expect(started.at(-1)).not.toContain("--paste");
  const id = [...flows.values()].find((f) => f.name === "telegram")!.id;
  set(id, { state: "done" });
  await page.getByText("创建成功").waitFor();
  await page.getByRole("button", { name: "完成" }).click();
  await page.getByRole("dialog").waitFor({ state: "detached" });

  // A flow left open is cancelled as the wizard closes.
  await plus(page);
  await page.getByRole("menuitem", { name: "新建 Bot" }).click();
  await page.getByRole("button", { name: "下一步" }).click();
  await page.getByText("等你扫码").waitFor();
  const open_ = [...flows.values()].find((f) => f.state === "scan")!.id;
  // Cancelled as it closes, it is no 创建成功, even as it fades.
  await page.evaluate(() => {
    const w = window as unknown as { saidDone: boolean };
    w.saidDone = false;
    new MutationObserver(() => void (document.body.textContent?.includes("创建成功") && (w.saidDone = true))).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "detached" });
  expect(await page.evaluate(() => (window as unknown as { saidDone: boolean }).saidDone)).toBe(false);
  for (let i = 0; i < 50 && !cancelled.includes(open_); i++) await Bun.sleep(100);
  expect(cancelled).toContain(open_);
});
