// The board page (web/) in a real Chromium the size of a phone: a few smoke tests of
// what only a browser shows, against rhodium's board serving a store the tests write to. They run on
// the Chromium playwright-core finds in its cache (~/.cache/ms-playwright), and are skipped without it.
import { afterAll, beforeAll, expect, onTestFinished, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices, type Locator, type Page, type Route } from "playwright-core";
import { serveBoard, type Hear } from "../src/board";
import type { RhReply } from "../src/router";
import { loadConfig } from "../src/config";
import { openStore, type Slot } from "../src/store";
import { call, installFakeHerdr, startFakeHerdr } from "./fake-herdr/fake-herdr";
import { BOARD_LOGIN, run, settles, until } from "./instance";

// Without playwright's own SIGTERM handler, which only closes the browsers: timeout's SIGTERM ends a
// run that is stuck (#277).
const browser = await chromium.launch({ handleSIGTERM: false }).catch((e: Error) => {
  if (!/Executable doesn't exist/.test(e.message)) throw e;
  console.warn(`board-smoke: skipped, no Chromium for playwright-core: ${e.message.split("\n")[0]}`);
  return null;
});
// A waitFor gives up at 5 s, and says what it waited for.
const smoke = (name: string, fn: () => Promise<void>) => (browser ? test : test.skip)(name, fn, 15_000);

const base = mkdtempSync(join(tmpdir(), "rhodium-test-smoke-"));
// The terminal's Herdr is a fake one under the tests' own home, never yours: the board runs it with
// the environment it started with, so it is told that home.
const herdrBin = installFakeHerdr(base);
const herdrSession = "rhodium-test-smoke";
writeFileSync(join(base, "herdr-here"), `#!/bin/sh\nHOME=${base} exec ${herdrBin} "$@"\n`, { mode: 0o755 });
writeFileSync(join(base, "config.toml"), `stateDir = "${base}/state"\n[programs]\nherdr = "${base}/herdr-here"\n[herdr]\nsession = "${herdrSession}"\n[board]\nport = 0\nlogin = "${BOARD_LOGIN}"\n`, { mode: 0o600 });
const store = openStore(join(base, "rh.db"));

// Workspace w with a slot in each of the four groups, one in the terminal, one in the middle of
// switching to it, one with a pi conversation of 60 turns, its transcript in a home of the tests' own,
// and 30 more idle ones, more than a wide screen shows.
const { ws, asking, works, finished, term, switching, talks, rests } = store.tx((tx) => {
  const ws = tx.insert("workspace", { name: "w", dir: "/w" }).id;
  const slot = (name: string, more: Partial<Slot> = {}) =>
    tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", ...more }).id;
  const asking = slot("asks", { state: "waiting" });
  const works = slot("works", { state: "running" });
  const finished = slot("finished", { turnEndedAt: Date.now() });
  tx.append({ source: "rh", type: "final_reply", slot: finished });
  const rests = slot("rests");
  const term = slot("term", { mode: "tui", herdrPane: "p7", tuiPid: 1 });
  // /rh_tui while it runs: in the terminal once its turn ends and the pane opens.
  const switching = slot("switching", { mode: "tui", state: "running" });
  const talks = slot("talks");
  for (let i = 0; i < 30; i++) slot(`more${i}`);
  // And earlier ones, which left no transcript: its timeline is longer than a third of a phone.
  for (let i = 0; i < 6; i++) tx.insert("conversation", { slot: talks, agent: "pi", sessionId: `old${i}`, startedAt: Date.now() - (i + 1) * 60_000 });
  const conversation = tx.insert("conversation", { slot: talks, agent: "pi", sessionId: "t1", startedAt: Date.now() }).id;
  tx.update("slot", { id: talks }, { conversation });
  return { ws, asking, works, finished, term, switching, talks, rests };
});
const said = (role: string, text: string) => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message: { role, content: [{ type: "text", text }] } }) + "\n";
const talked = join(base, ".pi/agent/sessions/--w--/2026-10-23_t1.jsonl");
mkdirSync(join(talked, ".."), { recursive: true });
writeFileSync(talked, Array.from({ length: 60 }, (_, i) => said("user", `q${i}`) + said("assistant", `a${i}`)).join(""));
// Chromium found, the board reads the transcripts there.
const home = process.env.HOME;
process.env.HOME = base;
/** Makes slot name in w, as rh new does: the event it brings tells the page. */
const create = (name: string) =>
  store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    tx.append({ source: "rh", type: "slot_created", slot: id, data: { ref: `w/${name}` } });
  });

let server: ReturnType<typeof serveBoard> | undefined;
let herdr: Awaited<ReturnType<typeof startFakeHerdr>> | undefined;
/** The lines the fake Herdr's terminal session controls got so far, as fake.calls has them. */
const herdrCalls = async () => ((await call(herdr!.socket, "fake.calls")).result.calls as { method: string; params: any }[]).filter((c) => c.method.startsWith("terminal."));
/** What a headless agent writes, told to the board as the runner tells it. */
const hearing = new Set<Hear>();
/** What the page sent to POST /api/act, and how rhodium answers the next one: by default at once, as /stop does. */
const acted: { id: string; act: unknown }[] = [];
let answer = (): Promise<RhReply> => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
beforeAll(async () => {
  if (!browser) return;
  const web = join(base, "web");
  await run([process.execPath, "--bun", "vite", "build", "web", "--outDir", web, "--emptyOutDir", "--logLevel", "warn"], {
    cwd: join(import.meta.dir, ".."),
    timeoutMs: 60_000,
    env: { ...process.env, NODE_DISABLE_COMPILE_CACHE: "1" },
  });
  server = serveBoard(store, loadConfig(join(base, "config.toml")), hearing, web, (id, act) => (acted.push({ id, act }), answer()));
  // w/term's agent runs in a pane of the fake Herdr.
  herdr = await startFakeHerdr(herdrBin, herdrSession, { HOME: base, PATH: process.env.PATH! });
  const herdrPane = (await call(herdr.socket, "workspace.create", { cwd: base, label: "w" })).result.root_pane.pane_id;
  store.tx((tx) => tx.update("slot", { id: term }, { herdrPane }));
}, 60_000);
afterAll(async () => {
  process.env.HOME = home;
  // A page's /api/topology route may be fetching as the browser closes, which would fail the file.
  for (const c of browser?.contexts() ?? []) for (const p of c.pages()) await p.unrouteAll({ behavior: "ignoreErrors" });
  await browser?.close();
  server?.stop(true);
  await herdr?.stop();
  store.close();
  rmSync(base, { recursive: true, force: true });
});

/** The page at hash on an Android phone, or on device, with your login as tailscale serve adds it.
 *  It closes when the test ends: pages left open pile up until the file outgrows its memory cap. */
async function open(hash = "", before?: (page: Page) => Promise<void>, device = devices["Pixel 7"]) {
  const context = await browser!.newContext({ ...device, extraHTTPHeaders: { "Tailscale-User-Login": BOARD_LOGIN } });
  // A /api/topology route may be fetching as the context closes; unrouting first keeps that from failing the file.
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

smoke("stories 139, 146: the slot that needs you is on top by its full name; the rest of w under its name, each with its state", async () => {
  const page = await open();
  const asks = page.getByRole("link", { name: /^w \/ asks 需要你/ });
  const w = page.getByRole("button", { name: "w", exact: true });
  for (const name of [/^works 运行中/, /^finished 刚刚结束/, /^rests/]) await page.getByRole("link", { name }).waitFor();
  expect((await asks.boundingBox())!.y).toBeLessThan((await w.boundingBox())!.y);
});

smoke("#209, story 436: a workspace's card folds as you tap its name, and stays folded when the page loads again, a blue dot before how many slots it has as one runs; what needs you stays on top", async () => {
  const page = await open();
  const rests = page.getByText("rests", { exact: true });
  await rests.waitFor();
  await page.getByRole("button", { name: "w", exact: true }).click();
  await rests.waitFor({ state: "detached" });
  await page.reload();
  await page.getByRole("button", { name: /^w\s*有在运行的\s*\d+$/ }).waitFor();
  await page.getByRole("link", { name: /^w \/ asks/ }).waitFor();
  expect(await rests.count()).toBe(0);
});

smoke("stories 205, 206: a slot's card opens its chat, named in its top bar, with its events in 详情", async () => {
  const page = await open();
  await page.getByRole("link", { name: /finished/ }).click();
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
  await page.getByRole("button", { name: "详情" }).click();
  await page.getByRole("dialog").getByText("回合结束").waitFor();
});

smoke("#255: on a phone the chat's top bar buttons take a 44px tap: back, 拓扑图 and 详情", async () => {
  const big = async (page: Page, name: string, role: "button" | "link" = "button") => {
    const box = (await page.getByRole(role, { name, exact: true }).last().boundingBox())!;
    expect([name, box.width >= 44 && box.height >= 44]).toEqual([name, true]);
  };
  const page = await open(`/slot/${finished}`);
  await page.getByRole("log", { name: "对话" }).waitFor();
  await big(page, "全部槽位", "link");
  await big(page, "拓扑图");
  await big(page, "详情");
  // 详情 still looks as it did: a bordered pill.
  const pill = page.getByRole("button", { name: "详情", exact: true }).locator("span");
  expect(await pill.evaluate((n) => getComputedStyle(n).borderTopColor)).not.toBe("rgba(0, 0, 0, 0)");
  expect((await pill.boundingBox())!.height).toBe(28);
  // Opened from the topology, its back goes there.
  await page.goto(`http://127.0.0.1:${server!.port}/#/topology/slot/${finished}`);
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("log", { name: "对话" }).waitFor();
  await big(page, "返回");
});

smoke("#616: on a phone 详情 ends as far from the screen's right edge as your bubbles do", async () => {
  const page = await open(`/slot/${talks}`);
  const said = page.getByRole("log", { name: "对话" }).getByText("q59", { exact: true });
  await said.waitFor();
  const bubble = await said.evaluate((n) => n.closest(".rounded-2xl")!.getBoundingClientRect().right);
  const pill = (await page.getByRole("button", { name: "详情", exact: true }).locator("span").boundingBox())!;
  expect(pill.x + pill.width).toBe(bubble);
  // And it stands as far from ⋯ as the icons do from each other.
  const [graph, more] = await Promise.all(["拓扑图", "更多"].map(async (name) => (await page.getByRole("button", { name, exact: true }).locator("span").first().boundingBox())!));
  expect(pill.x - (more!.x + more!.width)).toBe(more!.x - (graph!.x + graph!.width));
});

smoke("#616: renaming a slot in the terminal on the narrowest phone keeps its agent's logo and the whole box in the title; a long workspace name gives way to the box", async () => {
  // A terminal slot's bar holds one button more, 对话记录: its title is the narrowest.
  const [slot, other, far] = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "renamed-in-the-terminal", dir: "/w", mode: "tui", state: "idle", lifetime: "longterm", herdrPane: "nowhere", tuiPid: 1 }).id;
    tx.update("slot", { id }, { conversation: tx.insert("conversation", { slot: id, agent: "claude", sessionId: "t616", startedAt: Date.now() }).id });
    const other = tx.insert("workspace", { name: "orchardvalley", dir: "/o" }).id;
    return [id, other, tx.insert("slot", { workspace: other, name: "pebble", dir: "/o", mode: "headless", state: "idle", lifetime: "longterm" }).id];
  });
  const rename = async (page: Page) => {
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "改名" }).click();
    const box = page.getByRole("textbox", { name: "槽位名" });
    await box.waitFor();
    return box;
  };
  try {
    // The workspace shrinks well before the box does: the box keeps its 96px, give or take a fraction, a short name whole in it.
    const wide = (await (await rename(await open(`/slot/${far}`))).boundingBox())!;
    expect(Math.round(wide.width)).toBeGreaterThanOrEqual(96);
    const box = await rename(await open(`/slot/${slot}`, undefined, { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } }));
    // Scrolled to show the box, the title would hide the logo, and keep it hidden after.
    const { scrolled, past, ring } = await box.evaluate((n) => {
      const h2 = n.closest("h2")!;
      const cs = getComputedStyle(n);
      return { scrolled: h2.scrollLeft, past: n.getBoundingClientRect().right - h2.getBoundingClientRect().right, ring: parseFloat(cs.outlineOffset) + parseFloat(cs.outlineWidth) };
    });
    expect(scrolled).toBe(0);
    expect(past).toBeLessThanOrEqual(0);
    // As tall as the title, the box has its focus ring drawn inside it, where the title clips none of it.
    expect(ring).toBeLessThanOrEqual(0);
  } finally {
    store.tx((tx) => (tx.delete("slot", { id: slot }), tx.delete("slot", { id: far }), tx.delete("workspace", { id: other })));
  }
});

smoke("#644: 改名 opens with the name all picked, shown from its start, the focus ring whole around it; still all picked, a box resized shows the start again; once you move in it, where you are stays", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "quill-and-a-much-longer-name", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  try {
    const page = await open(`/slot/${slot}`, undefined, { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } });
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "改名" }).click();
    const box = page.getByRole("textbox", { name: "槽位名" });
    await box.waitFor();
    // All picked, and how far it is scrolled.
    const where = () => box.evaluate((n: HTMLInputElement): [boolean, number] => [n.selectionStart === 0 && n.selectionEnd === n.value.length, n.scrollLeft]);
    await settles(where, [true, 0], 1_000);
    // The ring as drawn: its top, over the picked name, the colour of its left side, clear of the name.
    const png = await page.screenshot();
    const [top, left] = await box.evaluate(async (el, src) => {
      const img = Object.assign(new Image(), { src });
      await img.decode();
      const g = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
      g.drawImage(img, 0, 0);
      const [r, d] = [el.getBoundingClientRect(), devicePixelRatio];
      const at = (x: number, y: number) => [...g.getImageData(Math.round(x * d), Math.round(y * d), 1, 1).data.slice(0, 3)];
      return [at(r.left + r.width / 2, r.top + 2), at(r.left + 2, r.top + r.height / 2)];
    }, `data:image/png;base64,${png.toString("base64")}`);
    expect(top!.map((c, i) => Math.abs(c - left![i]!) <= 2)).toEqual([true, true, true]);

    // Picked all again, the browser shows its end; a wider box, its start.
    await box.press("Home");
    await box.press("Shift+End");
    expect((await where())[1]).toBeGreaterThan(0);
    await page.setViewportSize({ width: 412, height: 780 });
    await settles(where, [true, 0], 1_000);
    // Moved to its end, you are editing: a narrower box leaves it where it is.
    await box.press("End");
    const end = (await where())[1];
    expect(end).toBeGreaterThan(0);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    expect(await where()).toEqual([false, end]);
  } finally {
    store.tx((tx) => tx.delete("slot", { id: slot }));
  }
});

smoke("story 252, #646: 详情 opens at the newest event, its top fading under a phone's floating bar; scrolled to the top it brings the ones before without moving, back to the first", async () => {
  // 60 events, more than a page: the first ten come only once you scroll up.
  store.tx((tx) => {
    for (let i = 0; i < 60; i++) tx.append({ source: "rh", type: "slot_renamed", slot: talks, data: { n: i } });
  });
  // Once the stream is open, and has brought the page up to date: an update between the scroll and
  // its event would take it back to the newest.
  let streaming: Promise<unknown> | undefined;
  const page = await open(`/slot/${talks}`, async (page) => void (streaming = page.waitForResponse((r) => r.url().includes(`/api/events?slot=${talks}`))));
  await streaming;
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "详情" }).click();
  const log = page.getByRole("dialog").getByRole("log", { name: "事件" });
  const toEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const nth = (i: number) => log.locator("li").filter({ hasText: `{"n":${i}}` });
  await nth(59).waitFor({ state: "attached" });
  await until(async () => (await toEnd()) < 1);
  expect(await nth(0).count()).toBe(0);
  // As the timeline's above it: the phone's thin bar, floating over the text (#646), and its top fades while there is more above.
  expect(await log.evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("thin");
  await until(async () => (await fadesY(log)).join() === "32,0");
  // In one go: the page before may come in as soon as the scroll is told.
  const [top, first] = await log.evaluate((el) => ((el.scrollTop = 0), [el.querySelectorAll("li")[0]!.getBoundingClientRect().top, el.querySelectorAll("li")[0]!.textContent] as const));
  await nth(0).waitFor({ state: "attached" });
  expect(await log.evaluate((el, text) => [...el.querySelectorAll("li")].find((li) => li.textContent === text)!.getBoundingClientRect().top, first)).toBeCloseTo(top, 0);
});

smoke("story 588: a conversation previewed in the timeline brings the pages before as you scroll to its top, back to the first thing said", async () => {
  const page = await open(`/slot/${talks}`);
  // A phone's chat keeps the browser's thin bar, which floats over the text (#630).
  expect(await page.getByRole("log", { name: "对话" }).evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("thin");
  await page.getByRole("button", { name: "详情" }).click();
  await page.getByText("时间线").click();
  await page.getByRole("dialog").getByRole("button", { name: /q0/ }).click();
  const log = page.getByRole("dialog").getByRole("log", { name: "预览" });
  // 120 things said: the newest page has the last of them, not the first.
  await log.getByText("a59", { exact: true }).waitFor();
  const first = log.getByText("q0", { exact: true });
  expect(await first.count()).toBe(0);
  // In the chat's 详情 too, the timeline's scroller keeps the phone's thin bar, floating over the text (#646).
  expect(await log.locator("xpath=ancestor::details").evaluate((el) => getComputedStyle(el).scrollbarWidth)).toBe("thin");
  await until(async () => (await log.evaluate((el) => void (el.scrollTop = 0)), (await first.count()) > 0));
});

/** Whether what l finds is whole inside the box of the scroller in, the fades at its ends left clear. */
const shownIn = async (l: Locator, scroller: Locator) => {
  const [r, s, [top, bottom]] = [(await l.boundingBox())!, (await scroller.boundingBox())!, await fadesY(scroller)];
  return r.y >= s.y + top! && r.y + r.height <= s.y + s.height - bottom!;
};

smoke("story 231, #637: on a phone, a preview opened in the half-height sheet is scrolled into view, down to its newest lines, its row with it", async () => {
  // The height Chrome leaves a Pixel 7 under its address bar: the sheet's half has no room below the row.
  const page = await open(`/topology/slot/${talks}`, undefined, { ...devices["Pixel 7"], viewport: { width: 412, height: 740 } });
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "展开详情" }).click();
  await page.waitForTimeout(400);
  await sheet.getByRole("button", { name: /q0/ }).click();
  const log = sheet.getByRole("log", { name: "预览" });
  await log.getByText("a59", { exact: true }).waitFor();
  const box = (await log.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  // Its row whole above it, in the sheet (#637).
  expect(await shownIn(sheet.getByRole("button", { name: /q0/ }), page.locator("[data-body]"))).toBe(true);
});

smoke("#648: a phone's sheet turned on its side keeps two thirds of the graph's room at most, the page not scrolled, and turned back has its own height again", async () => {
  const page = await open(`/topology/slot/${talks}`);
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "展开详情" }).click();
  await sheet.getByRole("button", { name: /q0/ }).click();
  await sheet.getByRole("log", { name: "预览" }).getByText("a59", { exact: true }).waitFor();
  await page.setViewportSize({ width: 915, height: 412 });
  // As a reload there has it: (412 - 92) * 2 / 3.
  await until(async () => Math.round((await sheet.boundingBox())!.height) === 213);
  expect(await page.evaluate(() => [scrollY, document.documentElement.scrollHeight])).toEqual([0, 412]);
  // Its stored height untouched: as it opened upright, 839 * 0.46.
  await page.setViewportSize({ width: 412, height: 839 });
  await until(async () => Math.round((await sheet.boundingBox())!.height) === 386);
});

smoke("#637: a preview with room in the details but not with its row above it is made shorter, the two whole in view, in the topology's details and in the chat's", async () => {
  // Heights where a full-height preview fits with the gap under it, its row with it does not.
  const page = await open(`/topology/slot/${talks}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 565 } });
  const row = sheetOf(page).getByRole("button", { name: /q0/ });
  await row.click();
  const log = sheetOf(page).getByRole("log", { name: "预览" });
  await log.getByText("a59", { exact: true }).waitFor();
  const body = page.locator("[data-body]");
  expect([await shownIn(row, body), await shownIn(log, body)]).toEqual([true, true]);
  const chat = await open(`/slot/${talks}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 600 } });
  await chat.getByRole("button", { name: "详情" }).click();
  await chat.getByText("时间线").click();
  const crow = chat.getByRole("dialog").getByRole("button", { name: /q0/ });
  await crow.click();
  const clog = chat.getByRole("dialog").getByRole("log", { name: "预览" });
  await clog.getByText("a59", { exact: true }).waitFor();
  const timeline = chat.getByRole("dialog").locator("details", { hasText: "时间线" });
  expect([await shownIn(crow, timeline), await shownIn(clog, timeline)]).toEqual([true, true]);
});

smoke("#637: an open preview follows the details as they change size, scrolled back in should it grow out of them or they shrink from under it, its row to their top should it not fit", async () => {
  // Its row low in the details, little under it: the slot has one above and two under it.
  const [deep, low, conversation] = store.tx((tx) => {
    const deep = tx.insert("workspace", { name: "deep", dir: "/w" }).id;
    const slot = (name: string, parent?: string) => tx.insert("slot", { workspace: deep, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", parent }).id;
    const low = slot("low", slot("high"));
    for (const name of ["under1", "under2"]) slot(name, low);
    const conversation = tx.insert("conversation", { slot: low, agent: "pi", sessionId: "t-low", startedAt: Date.now() }).id;
    tx.update("slot", { id: low }, { conversation });
    return [deep, low, conversation];
  });
  onTestFinished(() => store.tx((tx) => (tx.delete("slot", { workspace: deep }), tx.delete("workspace", { id: deep }), tx.delete("conversation", { id: conversation }))));
  writeFileSync(join(talked, "../2026-10-23_t-low.jsonl"), said("user", "d0") + said("assistant", "d1"));
  const page = await open(`/topology/slot/${low}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 555 } });
  const row = sheetOf(page).getByRole("button", { name: /d0/ });
  await row.click();
  const log = sheetOf(page).getByRole("log", { name: "预览" });
  await log.getByText("d1", { exact: true }).waitFor();
  // Taller, the details hold all of it with the preview as short as it was, and go back to their top;
  // the preview grown would end below them.
  await page.setViewportSize({ width: 1280, height: 760 });
  const body = page.locator("[data-body]");
  await until(async () => (await shownIn(log, body)) && (await shownIn(row, body)));
  // Shorter at once, its row high enough: the preview shortened to fit and scrolled back in whole.
  await page.setViewportSize({ width: 1280, height: 555 });
  await until(async () => (await shownIn(log, body)) && (await shownIn(row, body)));
  // Back to the top, then too short for the preview: its row, left in the bottom fade, goes to the top.
  // As short as at 470px high, a scroll told before the observer sees them shrink, as the browser may
  // tell one: theirs, not yours, so the preview is still followed.
  await page.setViewportSize({ width: 1280, height: 900 });
  await until(() => body.evaluate((el) => el.scrollTop === 0));
  await body.evaluate((el) => ((el.style.maxHeight = "275px"), el.dispatchEvent(new Event("scroll"))));
  await until(() => shownIn(row, body));
});

smoke("#637: a preview scrolled away from by hand is left there as the details change size", async () => {
  const page = await open(`/slot/${talks}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 600 } });
  await page.getByRole("button", { name: "详情" }).click();
  await page.getByText("时间线").click();
  await page.getByRole("dialog").getByRole("button", { name: /q0/ }).click();
  const log = page.getByRole("dialog").getByRole("log", { name: "预览" });
  await log.getByText("a59", { exact: true }).waitFor();
  const timeline = page.getByRole("dialog").locator("details", { hasText: "时间线" });
  const preview = log.locator("xpath=ancestor::div[contains(@class, 'lg:h-80')]");
  const was = (await preview.boundingBox())!.height;
  // Back to the top, its scroll told; then a taller window, the preview growing below them.
  await timeline.evaluate((el) => new Promise((ok) => ((el.scrollTop = 0), requestAnimationFrame(() => requestAnimationFrame(ok)))));
  await page.setViewportSize({ width: 1280, height: 620 });
  await until(async () => (await preview.boundingBox())!.height > was);
  expect(await timeline.evaluate((el) => el.scrollTop)).toBe(0);
});

smoke("#637: a preview the details can grow to hold is not shortened", async () => {
  // Only its row in the details, the card as tall as what it holds and room under it.
  const [lone, alone, conversation] = store.tx((tx) => {
    const lone = tx.insert("workspace", { name: "lone", dir: "/w" }).id;
    const alone = tx.insert("slot", { workspace: lone, name: "alone", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: alone, agent: "pi", sessionId: "t-alone", startedAt: Date.now() }).id;
    tx.update("slot", { id: alone }, { conversation });
    return [lone, alone, conversation];
  });
  onTestFinished(() => store.tx((tx) => (tx.delete("slot", { workspace: lone }), tx.delete("workspace", { id: lone }), tx.delete("conversation", { id: conversation }))));
  writeFileSync(join(talked, "../2026-10-23_t-alone.jsonl"), said("user", "e0") + said("assistant", "e1"));
  const page = await open(`/topology/slot/${alone}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } });
  await sheetOf(page).getByRole("button", { name: /e0/ }).click();
  const log = sheetOf(page).getByRole("log", { name: "预览" });
  await log.getByText("e1", { exact: true }).waitFor();
  expect((await log.locator("xpath=ancestor::div[contains(@class, 'lg:h-80')]").boundingBox())!.height).toBe(320);
});

smoke("#611: in a wide window too short for a preview, the row opened goes to the top of the details, under its fade, to fold it from, the preview under it, not shortened", async () => {
  const page = await open(`/topology/slot/${talks}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 530 } });
  const row = sheetOf(page).getByRole("button", { name: /q0/ });
  await row.click();
  const log = sheetOf(page).getByRole("log", { name: "预览" });
  await log.getByText("a59", { exact: true }).waitFor();
  const body = page.locator("[data-body]");
  expect([await shownIn(row, body), await shownIn(log, body)]).toEqual([true, false]);
  // Both bars, side by side here, are the board's thin round ones with no arrows (card-scroll), not the browser's.
  const bars = [sheetOf(page).getByRole("log", { name: "预览" }), page.locator("[data-body]")].map((l) => l.evaluate((el) => getComputedStyle(el).scrollbarWidth));
  expect(await Promise.all(bars)).toEqual(["auto", "auto"]);
});

smoke("story 231: a preview closed again leaves the timeline as it was", async () => {
  const page = await open(`/slot/${talks}`);
  await page.getByRole("button", { name: "详情" }).click();
  await page.getByText("时间线").click();
  const row = page.getByRole("dialog").getByRole("button", { name: /q0/ });
  await row.click();
  await page.getByRole("dialog").getByRole("log", { name: "预览" }).getByText("a59", { exact: true }).waitFor();
  await row.click();
  expect(await row.getAttribute("aria-expanded")).toBe("false");
});

smoke("story 209: on a wide screen a slot's chat is to the right of the board, the line between them dragged to move it; on a phone the chat has the screen to itself", async () => {
  const phone = await open(`/slot/${finished}`);
  await phone.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(await phone.getByText("rests", { exact: true }).count()).toBe(0);

  const page = await open("", undefined, devices["Desktop Chrome"]);
  await page.getByRole("link", { name: /finished/ }).click();
  const chat = page.getByRole("heading", { name: "w/finished" });
  await chat.waitFor();
  const card = (await page.getByText("rests", { exact: true }).boundingBox())!;
  const left = (await chat.boundingBox())!.x;
  expect(left).toBeGreaterThan(card.x + card.width);
  const line = (await page.getByRole("separator").boundingBox())!;
  await page.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + 200, line.y + line.height / 2, { steps: 5 });
  await page.mouse.up();
  expect((await chat.boundingBox())!.x).toBeCloseTo(left + 200, -1);
});

smoke("story 209: on a wide screen the board scrolls on its own, the chat staying on screen, and keeps its place as you open another slot", async () => {
  const page = await open(`/slot/${finished}`, undefined, devices["Desktop Chrome"]);
  const chat = page.getByRole("heading", { name: "w/finished" });
  await chat.waitFor();
  const card = page.locator('a[href^="#/slot/"]').last(); // the board's last row
  await card.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => scrollY)).toBe(0);
  expect((await chat.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  const at = await card.boundingBox();
  const href = await card.getAttribute("href");
  await card.click();
  await page.waitForURL((u) => u.hash === href);
  await chat.waitFor({ state: "detached" });
  await page.getByRole("heading", { name: /^w\// }).waitFor();
  expect(await card.boundingBox()).toEqual(at);
});

smoke("stories 210, 211: a page left open over an upgrade, whose chat code is gone, loads the page again at the slot", async () => {
  // The chat's file has a new name after the upgrade: the page opened before asks for the old one,
  // which is not there, until it loads again.
  let loads = 0;
  const page = await open("", async (page) => {
    page.on("request", (r) => void (r.isNavigationRequest() && loads++));
    await page.route("**/assets/slot-*.js", (r) => (loads > 1 ? r.fallback() : r.fulfill({ status: 404 })));
  });
  await page.getByRole("link", { name: /finished/ }).click();
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(loads).toBe(2);
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
});

smoke("a chat whose code the browser cannot run, as Safari before 16.4 cannot parse the chat's lookbehinds, loads the page again only once", async () => {
  let loads = 0;
  let chunks = 0;
  const page = await open("", async (page) => {
    page.on("request", (r) => void (r.isNavigationRequest() && loads++));
    await page.route("**/assets/slot-*.js", (r) => (chunks++, r.fulfill({ contentType: "text/javascript", body: "export default (" })));
  });
  await page.getByRole("link", { name: /finished/ }).click();
  await until(() => chunks >= 2);
  await page.waitForTimeout(1_000); // a reload comes within milliseconds of the failure
  expect(loads).toBe(2);
});

smoke("stories 200, 201: a chat opens at its newest; scrolled to the top it brings what came before without moving, back to the first; new messages below show 新消息", async () => {
  const page = await open(`/slot/${talks}`);
  const log = page.getByRole("log");
  const toEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await page.getByText("a59", { exact: true }).waitFor();
  expect(await toEnd()).toBeLessThan(1);

  // At the top of the newest page, the page before comes in above it: q50 stays where it was.
  const top = await log.evaluate((el) => ((el.scrollTop = 0), [...el.querySelectorAll("p")].find((p) => p.textContent === "q50")!.getBoundingClientRect().top));
  await page.getByText("a49", { exact: true }).waitFor({ state: "attached" });
  expect((await page.getByText("q50", { exact: true }).boundingBox())!.y).toBeCloseTo(top, 0);
  await until(async () => (await log.evaluate((el) => (el.scrollTop = 0)), (await page.getByText("q0", { exact: true }).count()) > 0));

  // The agent says more while you read its first words.
  const reading = await page.getByText("q0", { exact: true }).boundingBox();
  appendFileSync(talked, said("assistant", "a60"));
  store.tx((tx) => tx.append({ source: "rh", type: "final_reply", slot: talks }));
  const fresh = page.getByRole("button", { name: "新消息" });
  await fresh.waitFor();
  expect(await page.getByText("q0", { exact: true }).boundingBox()).toEqual(reading);
  await fresh.click();
  await page.getByText("a60", { exact: true }).waitFor();
  expect(await toEnd()).toBeLessThan(1);
  await fresh.waitFor({ state: "detached" });
});

smoke("stories 196, 197: a tool call is one line; opened, then its call opened, it shows the start of a long result, and 看全文 the whole", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "tools", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t2", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const line = (message: unknown) => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n";
  const out = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
  const transcript = join(talked, "../2026-10-23_t2.jsonl");
  writeFileSync(
    transcript,
    said("user", "count") +
      line({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "seq 0 999" } }] }) +
      line({ role: "toolResult", toolCallId: "c1", content: [{ type: "text", text: out }], isError: false }) +
      said("assistant", "counted"),
  );
  const page = await open(`/slot/${slot}`, async (page) => void (await page.route("**/api/full?*", (r) => r.fulfill({ status: 502 }), { times: 1 })));
  await page.getByText("counted").waitFor();
  await page.locator("summary", { hasText: /^Bash$/ }).click();
  const call = page.locator("summary", { hasText: "seq 0 999" });
  await call.click();
  await page.locator("pre", { hasText: /^line 0\n/ }).waitFor();
  expect(await page.getByText("line 999").count()).toBe(0);

  // Opened at the bottom of the chat, the call stays where it is as the agent says more (story 201).
  const y = (await call.boundingBox())!.y;
  appendFileSync(transcript, said("assistant", "more"));
  store.tx((tx) => tx.append({ source: "rh", type: "final_reply", slot }));
  await page.getByRole("button", { name: "新消息" }).waitFor();
  expect((await call.boundingBox())!.y).toBe(y);

  // 看全文 fails once, as while rhodium restarts, then brings the whole.
  await page.getByRole("button", { name: /看全文/ }).click();
  await page.getByText("取不到全文。").waitFor();
  await page.getByRole("button", { name: /看全文/ }).click();
  await page.locator("pre", { hasText: /line 999$/ }).waitFor();
  expect(await page.getByText("取不到全文。").count()).toBe(0);
});

smoke("#495: a fold with one failed Bash among four marks that run, red, with how many failed, and no 出错 at the line's end", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "fails", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t9", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const line = (message: unknown) => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n";
  const bash = (i: number) =>
    line({ role: "assistant", content: [{ type: "toolCall", id: `c${i}`, name: "bash", arguments: { command: `step ${i}` } }] }) +
    line({ role: "toolResult", toolCallId: `c${i}`, content: [{ type: "text", text: "out" }], isError: i === 2 });
  writeFileSync(join(talked, "../2026-10-23_t9.jsonl"), said("user", "go") + line({ role: "assistant", content: [{ type: "toolCall", id: "c0", name: "read", arguments: { path: "a" } }] }) + line({ role: "toolResult", toolCallId: "c0", content: [{ type: "text", text: "a" }], isError: false }) + [1, 2, 3, 4].map(bash).join("") + said("assistant", "done"));
  const page = await open(`/slot/${slot}`);
  const mark = page.locator("summary").first().getByRole("img", { name: "出错 1 次" });
  await mark.waitFor();
  // Right after Bash ×4, its count 1 of four.
  expect(await page.locator("summary").first().textContent()).toBe("Read、Bash ×4 1");
  expect(await mark.textContent()).toBe("1");
});

smoke("story 202: what the agent writes to its transcript comes into its chat as it writes, with no event", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "writes", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t3", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const transcript = join(talked, "../2026-10-23_t3.jsonl");
  writeFileSync(transcript, said("user", "go on"));
  const page = await open(`/slot/${slot}`);
  await page.getByText("go on").waitFor();
  appendFileSync(transcript, said("assistant", "first step done"));
  await page.getByText("first step done").waitFor();
});

smoke("story 202: what the agent writes after the chat's first page came, before the chat is drawn, comes in as it is drawn", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "late", dir: "/w", mode: "tui", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t4", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const transcript = join(talked, "../2026-10-23_t4.jsonl");
  writeFileSync(transcript, said("user", "finish up"));
  // The slot's answer is held, and so the chat is not drawn, until its first page has come, the
  // stream has opened, the transcript has grown and the stream has said so.
  let read = 0;
  const held = { stream: [] as Route[], slot: [] as Route[] };
  const page = await open(`/slot/${slot}`, async (page) => {
    // What the page's stream says, counted.
    await page.addInitScript(() => {
      const w = globalThis as unknown as { seen: Record<string, number>; EventSource: typeof EventSource };
      w.seen = { open: 0, grew: 0 };
      w.EventSource = class extends EventSource {
        constructor(url: string | URL) {
          super(url);
          for (const name of ["open", "grew"]) this.addEventListener(name, () => w.seen[name]!++);
        }
      };
    });
    page.on("requestfinished", (r) => void (r.url().includes("/api/messages?") && read++));
    await page.route("**/api/events?*", (r) => void held.stream.push(r));
    await page.route("**/api/slot?*", (r) => void held.slot.push(r));
  });
  await until(() => read === 1);
  for (const r of held.stream) await r.fallback();
  const seen = (name: string) => page.waitForFunction((name) => (globalThis as unknown as { seen: Record<string, number> }).seen[name]! > 0, name);
  await seen("open");
  appendFileSync(transcript, said("assistant", "all done"));
  await seen("grew");
  await page.unroute("**/api/slot?*");
  for (const r of held.slot) await r.fallback();
  await page.getByText("finish up").waitFor();
  await page.getByText("all done").waitFor();
});

smoke("story 203: what a headless agent writes comes into its chat as it writes, then the transcript's message takes its place", async () => {
  const { slot, conversation } = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "drafts", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot, agent: "pi", sessionId: "t5", startedAt: Date.now() }).id;
    tx.update("slot", { id: slot }, { conversation });
    return { slot, conversation };
  });
  const transcript = join(talked, "../2026-10-23_t5.jsonl");
  writeFileSync(transcript, said("user", "read the notes"));
  // The agent's turn, told to the board as the runner tells it.
  const write = (e: Parameters<Hear>[1]) => hearing.forEach((hear) => hear(conversation, e));
  const turn = { conv: conversation, proc: 1 };
  let streaming: Promise<unknown> | undefined;
  const page = await open(`/slot/${slot}`, async (page) => void (streaming = page.waitForResponse((r) => r.url().includes(`/api/events?slot=${slot}`))));
  await page.getByText("read the notes").waitFor();
  await streaming;

  write({ ...turn, type: "text_delta", text: "Draft: the **no" });
  // Markdown half written shows as it will.
  await page.locator('[data-streamdown="strong"]', { hasText: "no" }).waitFor();
  write({ ...turn, type: "text_delta", text: "tes** say" });
  await page.getByText("Draft: the notes say").waitFor();
  write({ ...turn, type: "item", item: { kind: "message", text: "Draft: the **notes** say" } });
  // What the transcript has differs here, to tell it from the draft.
  appendFileSync(transcript, said("assistant", "The notes say ship it."));
  await page.getByText("The notes say ship it.").waitFor();
  await page.getByText("Draft:").waitFor({ state: "detached" });
});

smoke("stories 201, 203: what the agent starts to write while you read above shows 新消息", async () => {
  const conversation = store.tx((tx) => tx.get("slot", talks)!.conversation!);
  let streaming: Promise<unknown> | undefined;
  const page = await open(`/slot/${talks}`, async (page) => void (streaming = page.waitForResponse((r) => r.url().includes(`/api/events?slot=${talks}`))));
  const log = page.getByRole("log");
  await page.getByText("a59", { exact: true }).waitFor();
  await streaming;
  await log.evaluate((el) => (el.scrollTop = 0));
  await page.waitForTimeout(200); // the scroll is told
  hearing.forEach((hear) => hear(conversation, { conv: conversation, proc: 1, type: "text_delta", text: "Starting to" }));
  await page.getByRole("button", { name: "新消息" }).waitFor();
  hearing.forEach((hear) => hear(conversation, { conv: conversation, proc: 1, type: "exit", code: 0, signal: null, from: "agent" }));
});

smoke("#236: back on a chat seen lately, it shows what it showed before its answers come, where you were, and brings only what was written since", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "again", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t6", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const transcript = join(talked, "../2026-10-23_t6.jsonl");
  writeFileSync(transcript, Array.from({ length: 60 }, (_, i) => said("user", `r${i}`) + said("assistant", `b${i}`)).join(""));
  const page = await open(`/slot/${slot}`);
  const log = page.getByRole("log");
  const toEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  await page.getByText("b59", { exact: true }).waitFor();
  await until(async () => (await toEnd()) < 1);
  const go = async (id: string, name: string) => (await page.evaluate((id) => (location.hash = `#/slot/${id}`), id), await page.getByRole("heading", { name }).waitFor());
  /** Away on another slot's chat and back, its answers held until what was seen is checked. */
  const back = async (seen: () => Promise<void>) => {
    await go(finished, "w/finished");
    const asked: string[] = [];
    const held: Route[] = [];
    page.on("request", (r) => void (r.url().includes(`/api/messages?slot=${slot}`) && asked.push(new URL(r.url()).search)));
    await page.route("**/api/{slot,messages}?*", (r) => void held.push(r));
    await go(slot, "w/again");
    await seen();
    await page.unroute("**/api/{slot,messages}?*");
    for (const r of held) await r.fallback();
    return asked;
  };

  // Read a little above the newest, near enough the top that the page before comes, whatever the screen's height.
  await log.evaluate((el) => (el.scrollTop = Math.min(el.scrollHeight - el.clientHeight - 300, 300)));
  await page.getByText("b49", { exact: true }).waitFor({ state: "attached" }); // the page before came in above
  const top = await log.evaluate((el) => el.scrollTop);
  appendFileSync(transcript, said("assistant", "while away"));
  const asked = await back(async () => expect(await log.evaluate((el) => el.scrollTop)).toBe(top));
  await page.getByRole("button", { name: "新消息" }).waitFor();
  await page.getByText("while away").waitFor({ state: "attached" });
  expect(asked.length).toBeGreaterThan(0);
  for (const q of asked) expect(q).toContain("after=");
  // 新消息 is lit as it was left, with nothing new since.
  await back(async () => await page.getByRole("button", { name: "新消息" }).waitFor());

  // At the newest, it is there again, and goes on down with what comes.
  await page.getByRole("button", { name: "新消息" }).click();
  await until(async () => (await toEnd()) < 1);
  appendFileSync(transcript, said("assistant", "then more"));
  await back(async () => expect(await toEnd()).toBeLessThan(1));
  await page.getByText("then more").waitFor();
  await until(async () => (await toEnd()) < 1);

  // Read above, and left as the stream says it grew: what that brings once the chat is gone shows 新消息 back on it (#294).
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 300));
  const late: Route[] = [];
  const since = (u: URL) => u.search.startsWith(`?slot=${slot}&after=`);
  await page.route(since, (r) => void late.push(r));
  appendFileSync(transcript, said("assistant", "as it went"));
  await until(() => late.length === 1);
  await go(finished, "w/finished");
  await page.unroute(since);
  const landed = page.waitForResponse((r) => since(new URL(r.url())));
  await late[0]!.fallback();
  await landed;
  await back(async () => await page.getByRole("button", { name: "新消息" }).waitFor());
  await page.getByText("as it went").waitFor({ state: "attached" });

  // Left while the page before is on its way: it comes, and no more are brought for the chat gone.
  const before: Route[] = [];
  await page.route("**/api/messages?*before=*", (r) => void before.push(r));
  await log.evaluate((el) => (el.scrollTop = 0));
  await until(() => before.length === 1);
  await go(finished, "w/finished");
  await page.unroute("**/api/messages?*before=*");
  let more = 0;
  page.on("request", (r) => void (r.url().includes("before=") && more++));
  await before[0]!.fallback();
  await page.waitForTimeout(500);
  expect(more).toBe(0);
});

smoke("story 139, #286: a slot made while the board is open comes onto it; the header has the round trip in ms where it said 实时", async () => {
  const page = await open();
  await page.getByText(/^\d+ms$/).waitFor();
  expect(await page.getByText("实时").count()).toBe(0);
  create("fresh");
  await page.getByText("fresh", { exact: true }).waitFor();
});

smoke("story 140: when the event stream drops and then gets a 502, as while rhodium restarts, the page opens a new one and catches up", async () => {
  let asked = 0;
  const page = await open("", async (page) => {
    await page.clock.install();
    // The first stream ends at once, and the browser tries it again 10 ms on, to a 502.
    await page.route("**/api/events", (r) =>
      ++asked === 1 ? r.fulfill({ contentType: "text/event-stream", body: "retry: 10\n\n" }) : asked === 2 ? r.fulfill({ status: 502 }) : r.fallback(),
    );
  });
  await page.getByText("rests", { exact: true }).waitFor();
  await until(() => asked === 2);
  await page.getByText("重连中").waitFor();
  create("missed"); // no stream to tell the page
  // The browser gave up on the stream; the page opens a new one 3 s on, and brings itself up to date.
  await until(async () => (await page.clock.runFor(1_000), asked === 3));
  await page.getByText(/^\d+ms$/).waitFor();
  await page.getByText("missed", { exact: true }).waitFor();
});

smoke("stories 340, 344, 352, 354: a slot in the terminal opens to its pane's terminal at the phone's width, WebAssembly running under the page's CSP with no error, and draws nothing while idle; 更多 holds 收回终端; back to headless, the page shows the chat", async () => {
  const errors: string[] = [];
  const page = await open(`/slot/${term}`, async (page) => {
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => void (m.type() === "error" && errors.push(m.text())));
    // Each animation frame the page asks for, counted.
    await page.addInitScript(() => {
      const ask = requestAnimationFrame.bind(window);
      const w = window as unknown as { frames: number };
      w.frames = 0;
      window.requestAnimationFrame = (f) => ask((t) => (w.frames++, f(t)));
    });
  });
  const from = (await herdrCalls()).length;
  const terminal = page.getByRole("region", { name: "终端" });
  await terminal.waitFor();
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  // Attached at the phone's width: Pixel 7's 412px of 13px monospace.
  const [attached] = (await herdrCalls()).slice(from);
  expect(attached!.method).toBe("terminal.session.control");
  expect([attached!.params.cols >= 40 && attached!.params.cols <= 60, attached!.params.rows >= 30, attached!.params.takeover]).toEqual([true, true, true]);
  expect(await page.getByRole("log", { name: "对话" }).count()).toBe(0);
  expect(await page.getByText(/herdr-web|在终端里/).count()).toBe(0);
  // A wider window, more columns for the pane.
  await page.setViewportSize({ width: 599, height: 915 });
  await until(async () => (await herdrCalls()).some((c) => c.method === "terminal.resize" && c.params.cols > attached!.params.cols + 10));
  // Drawn once its frame came; idle, no frame drawn.
  await page.waitForTimeout(300);
  const frames = () => page.evaluate(() => (window as unknown as { frames: number }).frames);
  const idle = await frames();
  await page.waitForTimeout(1_000);
  expect((await frames()) - idle).toBeLessThan(3);
  expect(errors).toEqual([]);

  let n = acted.length;
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "收回终端" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "收回" }).click();
  await until(() => acted.length > n);
  expect(acted.at(-1)!.act).toEqual({ kind: "rh", argv: ["release", term], sure: true });
  // Sure, the chat shows at once, the slot still in the terminal: not the agent quitting there (#372).
  await page.getByRole("log", { name: "对话" }).waitFor();
  expect(await page.locator("section[aria-label=终端]").isVisible()).toBe(false);
  expect(store.tx((tx) => tx.get("slot", term))!.mode).toBe("tui");

  // Back to headless, as the event stream tells: the chat, and Herdr lets go.
  store.tx((tx) => {
    tx.update("slot", { id: term }, { mode: "headless" });
    tx.append({ source: "rh", type: "slot_state", slot: term, data: { mode: "headless", state: "idle" } });
  });
  await page.getByRole("log", { name: "对话" }).waitFor();
  await terminal.waitFor({ state: "detached" });
  await until(async () => (await herdrCalls()).at(-1)?.method === "terminal.release");
  store.tx((tx) => tx.update("slot", { id: term }, { mode: "tui" }));
});

smoke("story 345: the terminal draws Claude's ⏵ of its ⏵⏵ mode line and its ⏸ with glyphs of their own, one cell wide, where the system's fonts have none, as on Android", async () => {
  const page = await open(`/slot/${term}`);
  const terminal = page.getByRole("region", { name: "终端" });
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  // Each one's ink in the font the terminal draws with, at 100px; and that of a code point no font has, the missing-glyph box.
  const ink = await terminal.locator("canvas").evaluate((c: HTMLCanvasElement) => {
    const pen = document.createElement("canvas").getContext("2d")!;
    pen.font = c.getContext("2d")!.font.replace(/\d+px/, "100px");
    return ["⏵", "⏸", "\u{10FFFD}"].map((ch) => {
      const m = pen.measureText(ch);
      return { box: [m.width, m.actualBoundingBoxLeft, m.actualBoundingBoxRight, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].join(), right: m.actualBoundingBoxRight };
    });
  });
  const [play, pause, none] = ink;
  // A cell of 100px monospace is about 60px wide; a colour emoji's ink runs to about 125.
  expect([play!.box !== none!.box, pause!.box !== none!.box, play!.right <= 70, pause!.right <= 70]).toEqual([true, true, true, true]);
});

smoke("#381: a slot's terminal opened after another's shows none of the other's text before its own first frame", async () => {
  // Another slot in the terminal, whose connection the page's route holds: no frame of it ever comes.
  const other = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "held", dir: "/w", mode: "tui", state: "idle", lifetime: "longterm", herdrPane: "nowhere", tuiPid: 1 }).id);
  try {
    const page = await open(`/slot/${term}`, (page) => page.routeWebSocket((u) => u.searchParams.get("slot") === other, () => {}));
    const terminal = page.getByRole("region", { name: "终端" });
    await terminal.waitFor();
    await terminal.getByLabel("连接中").waitFor({ state: "detached" });
    const lit = () => terminal.locator("canvas").evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 0 && v > 0x40).length);
    // What came is drawn at the next animation frame.
    const drawn = () => page.evaluate(() => new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok))));
    await drawn();
    const text = await lit();
    await page.evaluate((id) => (location.hash = `#/slot/${id}`), other);
    await page.getByRole("heading", { name: "w/held" }).waitFor();
    await terminal.getByLabel("连接中").waitFor();
    await drawn();
    // The cursor alone.
    expect(await lit()).toBeLessThan(text / 2);
    await page.context().close();
  } finally {
    store.tx((tx) => tx.delete("slot", { id: other }));
  }
});

smoke("#381: a slot in the terminal opened from the list for the first time draws its top bar and terminal, and connects, before /api/slot answers", async () => {
  // /api/slot never answers.
  const page = await open("/", async (page) => void (await page.route(/\/api\/slot\?/, () => {})));
  const from = (await herdrCalls()).length;
  await page.locator(`a[href*="/slot/${term}"]`).first().tap();
  await page.getByRole("heading", { name: "w/term" }).waitFor();
  await page.getByRole("region", { name: "终端" }).getByLabel("连接中").waitFor({ state: "detached" });
  expect((await herdrCalls()).slice(from).map((c) => c.method)).toEqual(["terminal.session.control"]);
  await page.context().close();
});

/** The page's terminal of w/term once drawn, on page, and what the fake Herdr got of each kind since. */
async function typing(page: Page) {
  const terminal = page.getByRole("region", { name: "终端" });
  await terminal.waitFor();
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  const from = (await herdrCalls()).length;
  const got = async (method: string) => (await herdrCalls()).slice(from).filter((c) => c.method === method).map((c) => c.params);
  return { terminal, got, texts: async () => (await got("terminal.input")).map((p) => p.text as string) };
}

smoke("stories 343, 347, 348: on a phone, the box under the terminal sends its words as one paste, then Enter on its own tens of ms later, and empties; the keys over it send what they say, Shift+Tab as ESC [ Z; a swipe down scrolls the pane up and brings up no keyboard, a tap does", async () => {
  // When the page sends each frame.
  const page = await open(`/slot/${term}`, async (page) => {
    await page.addInitScript(() => {
      const send = WebSocket.prototype.send;
      const w = window as unknown as { sent: [number, string][] };
      w.sent = [];
      WebSocket.prototype.send = function (d) {
        w.sent.push([performance.now(), String(d)]);
        send.call(this, d);
      };
    });
  });
  const { terminal, got, texts } = await typing(page);
  const box = page.getByRole("textbox", { name: "发给终端" });
  await box.fill("两行\n中文");
  await page.getByRole("button", { name: "发送" }).click();
  await until(async () => (await texts()).length === 2);
  expect(await texts()).toEqual(["\x1b[200~两行\n中文\x1b[201~", "\r"]);
  expect(await box.inputValue()).toBe("");
  const [paste, enter] = await page.evaluate(() => (window as unknown as { sent: [number, string][] }).sent.filter(([, d]) => d.startsWith('{"t":"in"')).map(([t]) => t));
  expect([enter! - paste! >= 30, enter! - paste! < 1_000]).toEqual([true, true]);

  const keys = [["Shift+Tab", "\x1b[Z"], ["Esc", "\x1b"], ["Tab", "\t"], ["Ctrl+C", "\x03"], ["上", "\x1b[A"], ["下", "\x1b[B"], ["左", "\x1b[D"], ["右", "\x1b[C"], ["回车", "\r"]];
  const row = page.getByRole("toolbar", { name: "特殊键" });
  for (const [name] of keys) await row.getByRole("button", { name, exact: true }).click();
  await until(async () => (await texts()).length === 2 + keys.length);
  expect((await texts()).slice(2)).toEqual(keys.map(([, sent]) => sent!));

  // A finger 200px down the terminal: the lines above.
  const cdp = await page.context().newCDPSession(page);
  const at = (await terminal.boundingBox())!;
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", dy?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: dy === undefined ? [] : [{ x: at.x + at.width / 2, y: at.y + 100 + dy }] });
  const keyboard = () => page.evaluate(() => !!document.activeElement?.matches('textarea[aria-label="Terminal input"]'));
  await touch("touchStart", 0);
  for (let dy = 20; dy <= 200; dy += 20) await touch("touchMove", dy);
  await touch("touchEnd");
  await until(async () => (await got("terminal.scroll")).length > 0);
  await Bun.sleep(100);
  const scrolled = await got("terminal.scroll");
  const lines = scrolled.reduce((n, s) => n + s.lines, 0);
  expect([scrolled.every((s) => s.direction === "up"), lines >= 8 && lines <= 16, await keyboard()]).toEqual([true, true, false]);
  // At the cell where the finger came down (story 357).
  expect([typeof scrolled[0]!.column, new Set(scrolled.map((s) => `${s.column},${s.row}`)).size]).toEqual(["number", 1]);
  await touch("touchStart", 0);
  await touch("touchEnd");
  await until(keyboard);
  await page.context().close();
});

smoke("stories 343, 346: on a computer, the terminal clicked takes what you type as typed, Shift+Tab as ESC [ Z, Ctrl+K and Alt+↑ its own, words an input method made, a paste as one; on a Mac ⌘K is still the jump box and ⌘F, ⌘+ the browser's; the wheel scrolls the pane; no keys or box under it", async () => {
  const page = await open(`/slot/${term}`, undefined, wide());
  const { terminal, got, texts } = await typing(page);
  expect([await page.getByRole("textbox", { name: "发给终端" }).isVisible(), await page.getByRole("toolbar", { name: "特殊键" }).isVisible()]).toEqual([false, false]);
  const hash = new URL(page.url()).hash;
  await terminal.click();
  await page.keyboard.type("hi");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Control+K");
  await page.keyboard.press("Alt+ArrowUp");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
  await cdp.send("Input.insertText", { text: "中文" });
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData("text/plain", "a\nb");
    document.activeElement!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await until(async () => (await texts()).length >= 7);
  expect(await texts()).toEqual(["h", "i", "\x1b[Z", "\x0b", "\x1b[1;3A", "中文", "\x1b[200~a\nb\x1b[201~"]);
  expect([await page.getByRole("dialog", { name: "跳转" }).count(), new URL(page.url()).hash]).toEqual([0, hash]);
  await page.mouse.wheel(0, -200);
  await until(async () => (await got("terminal.scroll")).length > 0);
  await page.mouse.wheel(0, 200);
  await until(async () => (await got("terminal.scroll")).some((s) => s.direction === "down"));
  expect((await got("terminal.scroll")).map((s) => s.direction)).toEqual(["up", "down"]);
  await page.context().close();

  const mac = await open(`/slot/${term}`, async (p) => void (await p.addInitScript(() => Object.defineProperty(Navigator.prototype, "platform", { get: () => "MacIntel" }))), wide());
  const onMac = await typing(mac);
  await onMac.terminal.click();
  // The browser's own ⌘ keys, as ⌘F and ⌘+, left to it.
  await mac.evaluate(() => {
    const w = window as unknown as { prevented: string[] };
    w.prevented = [];
    addEventListener("keydown", (e: KeyboardEvent) => void (e.metaKey && e.defaultPrevented && w.prevented.push(e.key)));
  });
  await mac.keyboard.press("Meta+F");
  await mac.keyboard.press("Meta+Equal");
  expect(await mac.evaluate(() => (window as unknown as { prevented: string[] }).prevented)).toEqual([]);
  await mac.keyboard.press("Meta+K");
  await mac.getByRole("dialog", { name: "跳转" }).waitFor();
  expect(await onMac.texts()).toEqual([]);
  await mac.context().close();
});

smoke("story 346: on a computer, an input method's words go in as it made them: ， Windows' types after a key of 229 with no composition, 。 a Mac's types with the key of .; the browser's caret never shows, and the words being made show at the pane's cursor, where the input method opens its window", async () => {
  const page = await open(`/slot/${term}`, undefined, wide());
  const { terminal, texts } = await typing(page);
  await terminal.click();
  const cdp = await page.context().newCDPSession(page);
  const key = (type: "rawKeyDown" | "keyDown" | "keyUp", key: string, code: string, vk: number, text?: string) => cdp.send("Input.dispatchKeyEvent", { type, key, code, windowsVirtualKeyCode: vk, ...(text && { text, unmodifiedText: text }) });
  await key("rawKeyDown", "Process", "Comma", 229);
  await cdp.send("Input.insertText", { text: "，" });
  await key("keyUp", "Process", "Comma", 229);
  await key("keyDown", ".", "Period", 190, "。");
  await key("keyUp", ".", "Period", 190);
  await until(async () => (await texts()).length === 2);
  // The fake pane writes each input at row 2: its cursor is after 。, column 2 of row 1, counted from 0.
  const size = (await herdrCalls()).filter((c) => c.method === "terminal.session.control" || c.method === "terminal.resize").at(-1)!.params;
  const seen = () =>
    page.evaluate(({ cols, rows }) => {
      const at = document.activeElement as HTMLElement;
      const region = document.querySelector('[aria-label="终端"]')!;
      const canvas = region.querySelector("canvas")!.getBoundingClientRect();
      const box = region.querySelector("textarea")!;
      const r = box.getBoundingClientRect();
      return {
        typing: at === box,
        editable: !!region.querySelector("[contenteditable]"),
        caret: getComputedStyle(at).caretColor,
        shown: getComputedStyle(box).opacity,
        front: getComputedStyle(box).zIndex,
        cell: [Math.round(((r.x - canvas.x) * cols) / canvas.width), Math.round(((r.y - canvas.y) * rows) / canvas.height)],
        words: box.value,
      };
    }, size);
  await until(async () => (await seen()).cell[1] === 1);
  // A right click, then a click: ghostty-web leaves the box fixed at the page's top-left, behind the terminal.
  await terminal.click({ button: "right" });
  await terminal.click();
  await key("rawKeyDown", "Process", "KeyZ", 229);
  await cdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
  await key("keyUp", "Process", "KeyZ", 229);
  expect(await seen()).toEqual({ typing: true, editable: false, caret: "rgba(0, 0, 0, 0)", shown: "1", front: "auto", cell: [2, 1], words: "zhong" });
  await cdp.send("Input.insertText", { text: "中文" });
  await until(async () => (await texts()).length === 3);
  expect(await texts()).toEqual(["，", "。", "中文"]);
  await until(async () => (await seen()).cell[0] === 4);
  expect(await seen()).toEqual({ typing: true, editable: false, caret: "rgba(0, 0, 0, 0)", shown: "0", front: "auto", cell: [4, 1], words: "" });
  // Made 3 cells from the right edge, the words grow the box leftwards, all shown, the terminal never scrolled sideways.
  await cdp.send("Input.insertText", { text: "x".repeat(size.cols - 3) });
  await until(async () => (await seen()).cell[0] === size.cols - 3);
  const edge = () =>
    page.evaluate(() => {
      const box = document.querySelector('[aria-label="终端"] textarea')!;
      const canvas = box.parentElement!.querySelector("canvas")!.getBoundingClientRect();
      return { scrolled: box.parentElement!.scrollLeft, inside: box.getBoundingClientRect().right <= canvas.right + 0.5, all: box.scrollWidth <= box.clientWidth };
    });
  for (const n of [5, 10, 15]) {
    await cdp.send("Input.imeSetComposition", { text: "zhongwenshurufa".slice(0, n), selectionStart: n, selectionEnd: n });
    expect(await edge()).toEqual({ scrolled: 0, inside: true, all: true });
  }
  // Wider than the terminal, they scroll inside the box.
  const long = "zhongwenshurufa".repeat(8);
  await cdp.send("Input.imeSetComposition", { text: long, selectionStart: long.length, selectionEnd: long.length });
  expect(await edge()).toEqual({ scrolled: 0, inside: true, all: false });
  await cdp.send("Input.insertText", { text: "中文输入法" });
  await until(async () => (await texts()).length === 5);
  // A click beside the drawn lines, under the last row, still types into it.
  const corner = (await terminal.boundingBox())!;
  await page.mouse.click(corner.x + corner.width - 2, corner.y + corner.height - 2);
  await page.keyboard.type("x");
  await until(async () => (await texts()).length === 6);
  expect((await texts()).slice(4)).toEqual(["中文输入法", "x"]);
  await page.context().close();
});

smoke("story 357: on a computer, the mouse's left button pressed, dragged and let go on the terminal goes to the pane at the cells under it, a drag only as the cell changes, the right button not; the wheel scrolls at the cell under it; on a phone a tap is no click", async () => {
  const page = await open(`/slot/${term}`, undefined, wide());
  const { terminal, got } = await typing(page);
  await page.waitForTimeout(300);
  const { cols, rows } = (await herdrCalls()).filter((c) => c.method === "terminal.session.control" || c.method === "terminal.resize").at(-1)!.params;
  const at = (await terminal.locator("canvas").boundingBox())!;
  const cell = (c: number, r: number, dx = 0.5) => [at.x + ((c + dx) * at.width) / cols, at.y + ((r + 0.5) * at.height) / rows] as const;
  await page.mouse.move(...cell(9, 4));
  await page.mouse.down();
  await page.mouse.move(...cell(9, 4, 0.8));
  await page.mouse.move(...cell(11, 4));
  await page.mouse.move(...cell(12, 5));
  await page.mouse.up();
  await page.mouse.click(...cell(3, 3), { button: "right" });
  await page.mouse.move(...cell(20, 6));
  await page.mouse.wheel(0, -200);
  await until(async () => (await got("terminal.scroll")).length > 0);
  expect(await got("terminal.mouse")).toEqual([
    { action: "down", column: 9, row: 4 },
    { action: "drag", column: 11, row: 4 },
    { action: "drag", column: 12, row: 5 },
    { action: "up", column: 12, row: 5 },
  ]);
  expect((await got("terminal.scroll")).map((s) => [s.direction, s.column, s.row])).toEqual((await got("terminal.scroll")).map(() => ["up", 20, 6]));
  await page.context().close();

  const phone = await open(`/slot/${term}`);
  const onPhone = await typing(phone);
  await onPhone.terminal.tap();
  await phone.waitForTimeout(300);
  expect(await onPhone.got("terminal.mouse")).toEqual([]);
  await phone.context().close();
});

smoke("story 357: the left button let go while the right is still down lets go in the pane too, and a move after drags nothing", async () => {
  const page = await open(`/slot/${term}`, undefined, wide());
  const { terminal, got } = await typing(page);
  await page.waitForTimeout(300);
  const { cols, rows } = (await herdrCalls()).filter((c) => c.method === "terminal.session.control" || c.method === "terminal.resize").at(-1)!.params;
  const at = (await terminal.locator("canvas").boundingBox())!;
  const cell = (c: number, r: number) => [at.x + ((c + 0.5) * at.width) / cols, at.y + ((r + 0.5) * at.height) / rows] as const;
  await page.mouse.move(...cell(9, 4));
  await page.mouse.down();
  await page.mouse.down({ button: "right" });
  await page.mouse.up();
  await page.mouse.up({ button: "right" });
  await page.mouse.move(...cell(15, 6));
  await page.waitForTimeout(300);
  expect(await got("terminal.mouse")).toEqual([
    { action: "down", column: 9, row: 4 },
    { action: "up", column: 9, row: 4 },
  ]);
  await page.context().close();
});

/** w/term's page on a phone, its terminal drawn. */
async function termPage() {
  const page = await open(`/slot/${term}`);
  const terminal = page.getByRole("region", { name: "终端" });
  await terminal.waitFor();
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  return page;
}

/** Puts page in the background, or back in front, as a phone switching apps does: what the page reads of it, and visibilitychange. */
const inFront = (page: Page, front: boolean) =>
  page.evaluate((front) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => !front });
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (front ? "visible" : "hidden") });
    document.dispatchEvent(new Event("visibilitychange"));
  }, front);

smoke("stories 349, 350: another page opening the slot takes its terminal over: the first says 已在别处打开 and waits; 在这里继续 takes it back, and the other says so", async () => {
  const first = await termPage();
  const second = await termPage();
  const elsewhere = (page: Page) => page.getByText("已在别处打开");
  await elsewhere(first).waitFor();
  expect(await elsewhere(second).count()).toBe(0);
  // Not again by itself, past the first wait to connect again.
  const from = (await herdrCalls()).length;
  await first.waitForTimeout(1_500);
  expect((await herdrCalls()).slice(from)).toEqual([]);

  await first.getByRole("button", { name: "在这里继续" }).click();
  await elsewhere(second).waitFor();
  await elsewhere(first).waitFor({ state: "detached" });
  await first.getByRole("region", { name: "终端" }).getByLabel("连接中").waitFor({ state: "detached" });
  expect((await herdrCalls()).slice(from).map((c) => c.method)).toEqual(["terminal.release", "terminal.session.control"]);
  for (const p of [first, second]) await p.context().close();
});

smoke("story 351: a page put in the background lets go of its terminal, and takes it again back in front; back in front with another page on it, it says 已在别处打开 and the other goes on", async () => {
  const phone = await termPage();
  const since = async (from: number) => (await herdrCalls()).slice(from).map((c) => c.method);
  let from = (await herdrCalls()).length;
  await inFront(phone, false);
  await until(async () => (await since(from)).includes("terminal.release"));
  await inFront(phone, true);
  await until(async () => (await since(from)).includes("terminal.session.control"));
  await phone.getByRole("region", { name: "终端" }).getByLabel("连接中").waitFor({ state: "detached" });

  from = (await herdrCalls()).length;
  await inFront(phone, false);
  await until(async () => (await since(from)).includes("terminal.release"));
  const computer = await termPage();
  from = (await herdrCalls()).length;
  await inFront(phone, true);
  await phone.getByText("已在别处打开").waitFor();
  // Nor once more, as it shows that.
  await inFront(phone, false);
  await inFront(phone, true);
  await phone.waitForTimeout(500);
  expect([await computer.getByText("已在别处打开").count(), await since(from)]).toEqual([0, []]);
  for (const p of [phone, computer]) await p.context().close();
});

smoke("story 351: a page opened in the background, as a tab opened by a middle click, leaves the terminal to the page in front; brought to front, it says 已在别处打开", async () => {
  const phone = await termPage();
  const from = (await herdrCalls()).length;
  const tab = await open(`/slot/${term}`, async (page) => void (await page.addInitScript(() => Object.defineProperty(document, "hidden", { configurable: true, get: () => true }))), devices["Desktop Chrome"]);
  // Its terminal there: ghostty-web loaded and drawing into the page.
  await tab.getByRole("region", { name: "终端" }).locator("canvas").waitFor({ state: "attached" });
  await tab.waitForTimeout(500);
  expect([await phone.getByText("已在别处打开").count(), await herdrCalls().then((c) => c.slice(from))]).toEqual([0, []]);
  await inFront(tab, true);
  await tab.getByText("已在别处打开").waitFor();
  for (const p of [phone, tab]) await p.context().close();
});

smoke("story 353: a page whose terminal dropped connects again by itself, leaving it to a page elsewhere if there is one (resume=1)", async () => {
  const urls: string[] = [];
  const page = await open(`/slot/${term}`, async (page) => void page.on("websocket", (ws) => urls.push(ws.url())));
  const terminal = page.getByRole("region", { name: "终端" });
  await terminal.waitFor();
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  // Its Herdr gone without a word: 4002.
  // This run's own, not another's running at the same time with the same session.
  await run(["pkill", "-KILL", "-f", `${base}/herdr --session ${herdrSession} terminal session control`]);
  await until(() => urls.length === 2, 5_000);
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  expect(urls.map((u) => new URL(u).searchParams.get("resume"))).toEqual([null, "1"]);
  // As the same page: the board lets it take over a connection of its own it has not seen drop.
  const [a, b] = urls.map((u) => new URL(u).searchParams.get("page"));
  expect([!!a, a === b]).toEqual([true, true]);
  await page.context().close();
});

smoke("the terminal is sharp: its canvas has a device pixel for each of its own at a fractional ratio, a 4K screen's at 132.5%, and again, its text drawn afresh, once a zoom changes the ratio, to 150% of it or to 2", async () => {
  const page = await open(
    `/slot/${term}`,
    // A zoom's new ratio, told as the browser tells it: an emulated ratio tells no media query.
    async (page) =>
      void (await page.addInitScript(() => {
        const lists: MediaQueryList[] = [];
        const match = window.matchMedia.bind(window);
        window.matchMedia = (q) => {
          const l = match(q);
          if (q.startsWith("(resolution")) lists.push(l);
          return l;
        };
        (window as unknown as { zoom(ratio: number): void }).zoom = (ratio) => {
          Object.defineProperty(window, "devicePixelRatio", { value: ratio, configurable: true });
          lists.splice(0).forEach((l) => l.dispatchEvent(new Event("change")));
        };
      })),
    { ...wide(), deviceScaleFactor: 1.325 },
  );
  await typing(page);
  const canvas = page.getByRole("region", { name: "终端" }).locator("canvas");
  // How far its pixels are from its CSS size times the ratio, across and down.
  const off = () =>
    canvas.evaluate((c: HTMLCanvasElement) => {
      const r = c.getBoundingClientRect();
      return [c.width - r.width * devicePixelRatio, c.height - r.height * devicePixelRatio].map((d) => Math.abs(d) < 0.05);
    });
  // How much of it is text: pixels lighter than the dark background.
  const lit = () => canvas.evaluate((c: HTMLCanvasElement) => c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data.filter((v, i) => i % 4 === 0 && v > 0x40).length / (c.width * c.height));
  expect(await off()).toEqual([true, true]);
  await until(async () => (await lit()) > 0);
  const text = await lit();
  // 150% of it, then 2, which its cells fit whole, as ghostty-web's own check takes for drawn.
  for (const ratio of [1.9875, 2]) {
    await page.evaluate((ratio) => (window as unknown as { zoom(ratio: number): void }).zoom(ratio), ratio);
    // All its text again, not just the cursor.
    await until(async () => (await off()).every(Boolean) && (await page.evaluate(() => devicePixelRatio)) === ratio && (await lit()) > text / 2);
  }
  await page.context().close();
});

smoke("stories 342, 355: the top bar's switch shows the chat and back, Herdr attached all along and told no size while the terminal is hidden; 更多's 放大字号, its menu staying open, gives the pane fewer columns, kept on this device", async () => {
  const page = await open(`/slot/${term}`);
  const terminal = page.getByRole("region", { name: "终端" });
  const chat = page.getByRole("log", { name: "对话" });
  await terminal.waitFor();
  await terminal.getByLabel("连接中").waitFor({ state: "detached" });
  const attaches = async () => (await herdrCalls()).filter((c) => c.method === "terminal.session.control");
  const cols = (await attaches()).at(-1)!.params.cols as number;
  const from = (await herdrCalls()).length;
  await page.getByRole("button", { name: "对话记录", exact: true }).click();
  await chat.waitFor();
  await terminal.waitFor({ state: "hidden" });
  // Hidden, it is not measured: a wider window tells Herdr nothing till the terminal shows again.
  await page.setViewportSize({ width: 599, height: 915 });
  await page.waitForTimeout(400);
  expect((await herdrCalls()).slice(from)).toEqual([]);
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await terminal.waitFor();
  await chat.waitFor({ state: "detached" });
  await until(async () => (await herdrCalls()).length > from);
  await page.waitForTimeout(400);
  const wide = (await herdrCalls()).slice(from);
  expect(wide.map((c) => c.method)).toEqual(wide.map(() => "terminal.resize"));
  const wideCols = wide.at(-1)!.params.cols as number;
  expect(wideCols).toBeGreaterThan(cols + 10);

  // Two steps bigger, the menu open all along.
  await page.getByRole("button", { name: "更多" }).click();
  const bigger = page.getByRole("menuitem", { name: "放大字号" });
  await bigger.click();
  await bigger.click();
  await page.getByRole("menuitem", { name: "缩小字号" }).waitFor();
  await page.waitForTimeout(400);
  const big = (await herdrCalls()).at(-1)!;
  expect([big.method, big.params.cols < wideCols - 5]).toEqual(["terminal.resize", true]);
  // Loaded again, the page attaches at the size kept.
  const n = (await attaches()).length;
  await page.reload();
  await until(async () => (await attaches()).length > n);
  expect((await attaches()).at(-1)!.params.cols).toBe(big.params.cols);
  await page.context().close();
});

smoke("story 355, #576: on a phone, the chat shown in place of the terminal has the box under it and no keys, the box keeping its edge focused; what it sends goes to the pane still attached, one paste, then Enter on its own", async () => {
  const page = await open(`/slot/${term}`);
  const { terminal, got, texts } = await typing(page);
  await page.getByRole("button", { name: "对话记录", exact: true }).click();
  const chat = page.getByRole("log", { name: "对话" });
  await chat.waitFor();
  await terminal.waitFor({ state: "hidden" });
  const box = page.getByRole("textbox", { name: "发给终端" });
  expect([await box.isVisible(), await page.getByRole("toolbar", { name: "特殊键" }).isVisible()]).toEqual([true, false]);
  // Under the chat, clear of the screen's edge.
  const [under, at] = [(await chat.boundingBox())!, (await box.boundingBox())!];
  expect(at.y).toBeGreaterThanOrEqual(under.y + under.height - 1);
  const edge = () => box.locator("xpath=..").evaluate((e) => getComputedStyle(e).borderTopColor);
  const rest = await edge();
  await box.focus();
  await page.waitForTimeout(250);
  expect(await edge()).toBe(rest);
  await box.fill("读完了");
  await page.getByRole("button", { name: "发送" }).click();
  await until(async () => (await texts()).length === 2);
  expect(await texts()).toEqual(["\x1b[200~读完了\x1b[201~", "\r"]);
  expect([await got("terminal.release"), await got("terminal.session.control")]).toEqual([[], []]);
  await page.getByRole("button", { name: "终端", exact: true }).click();
  await terminal.waitFor();
  await page.getByRole("toolbar", { name: "特殊键" }).waitFor();
  await page.context().close();
});

smoke("stories 207, 208: a slot still switching to the terminal shows its chat; an ask is a card below the chat until it is answered", async () => {
  const switches = await open(`/slot/${switching}`);
  await switches.getByRole("heading", { name: "w/switching" }).waitFor();
  await switches.getByRole("log", { name: "对话" }).waitFor();
  expect(await switches.getByRole("region", { name: "终端" }).count()).toBe(0);

  const chat = await open(`/slot/${asking}`);
  await chat.getByText("还没有对话").waitFor();
  const question = { questions: [{ question: "部署到哪个环境？", options: [{ label: "staging" }, { label: "production" }] }] };
  const ask = store.tx((tx) => {
    const ask = tx.insert("ask", { slot: asking, kind: "question", status: "open", prompt: JSON.stringify({ tool: "AskUserQuestion", input: question }), deadline: Date.now() + 1_800_000 }).id;
    tx.append({ source: "agent", type: "ask", slot: asking, data: { ask, kind: "question" } });
    return ask;
  });
  const card = chat.getByRole("region", { name: "选择题" });
  await card.getByText("部署到哪个环境？").waitFor();
  await card.getByText(/超时$/).waitFor();
  store.tx((tx) => {
    tx.update("ask", { id: ask }, { status: "answered" });
    tx.append({ source: "im", type: "ask_answered", slot: asking, data: { ask } });
  });
  await card.waitFor({ state: "detached" });
});

/** The topology view's sheet (or a wide screen's card) and its height. */
const sheetOf = (page: Page) => page.getByRole("complementary", { name: "详情" });
/** The directory picker in sheet (spec web-write "目录选择器"): its path, a workspace's button, a folder's row. */
const picker = (sheet: Locator) => ({
  path: sheet.getByRole("textbox", { name: "路径" }),
  ws: (name: string) => sheet.getByRole("group", { name: "工作区" }).getByRole("button", { name, exact: true }),
  folders: sheet.getByRole("list", { name: "文件夹" }),
});
/** A folder under the tests' home, made if need be. */
const folder = (name: string) => (mkdirSync(join(base, name), { recursive: true }), join(base, name));
const node = (page: Page, kind: string, text: string) => page.locator(`[data-node=${kind}]`, { hasText: new RegExp(`^${text}`) }).first();

smoke("stories 218, 219, 226, 245: on the topology, a workspace then a slot is tapped; with nothing more to show the sheet is one row; 打开槽位 opens its chat, and back is on the slot again; tapping it lets go of it", async () => {
  const page = await open("/topology");
  await node(page, "ws", "w").click();
  expect(new URL(page.url()).hash).toBe(`#/topology/ws/${ws}`);
  await node(page, "slot", "finished").click();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}`);
  const sheet = sheetOf(page);
  await sheet.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(await sheet.getByRole("button", { name: "展开详情" }).count()).toBe(0);
  expect((await sheet.boundingBox())!.height).toBeLessThan(80);

  // The camera, moved by hand, is where it was when you come back.
  await page.mouse.move(200, 400);
  await page.mouse.down();
  await page.mouse.move(150, 350, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  const at = await node(page, "slot", "finished").boundingBox();
  await sheet.getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
  await page.goBack();
  await sheetOf(page).getByRole("heading", { name: "w/finished" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}`);
  await page.waitForTimeout(400);
  expect(await node(page, "slot", "finished").boundingBox()).toEqual(at);

  await node(page, "slot", "finished").click();
  await sheetOf(page).getByRole("heading", { name: "总览" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}?x`);
  // Still open: the slot is on the canvas, and back goes to the workspace.
  await node(page, "slot", "finished").waitFor();
  await page.goBack();
  expect(new URL(page.url()).hash).toBe(`#/topology/ws/${ws}`);
});

smoke("#242: on a phone a workspace tapped stays where it was as it opens; with the sheet open, 总览 or the sheet folded, a drag of 3px moves the view 3px at most", async () => {
  const page = await open("/topology");
  const sheet = sheetOf(page);
  const w = node(page, "ws", "w");
  const at = async () => (({ x, y }) => ({ x, y }))((await w.boundingBox())!);
  await w.waitFor();
  await page.waitForTimeout(400);
  const before = await at();
  // Open, it is far taller than the screen: the view kept is past the graph's own bounds.
  await w.click();
  await node(page, "slot", "talks").waitFor();
  await page.waitForTimeout(400);
  expect(await at()).toEqual(before);

  // A drag of 3px on the canvas moves the view 3px at most: the graph, shorter than the screen, stays put.
  const nudge = async () => {
    const { x, y } = await at();
    await page.mouse.move(40, 200);
    await page.mouse.down();
    await page.mouse.move(40, 203, { steps: 3 });
    await page.mouse.up();
    const to = await at();
    expect(to.x).toBe(x);
    expect(Math.abs(to.y - y)).toBeLessThanOrEqual(3);
  };
  // 总览 shortens the sheet as it glides: what the screen shows midway is no bound of the view.
  await node(page, "slot", "talks").click();
  await sheet.getByRole("button", { name: "展开详情" }).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "总览" }).click();
  await sheet.getByRole("heading", { name: "总览" }).waitFor();
  await page.waitForTimeout(600);
  await nudge();
  // The sheet folded, the view stays where it was.
  await sheet.getByRole("button", { name: "收起详情" }).click();
  await page.waitForTimeout(400);
  await nudge();
});

smoke("#282: on a phone a graph shorter than the screen sits 16px under the path, and a drag leaves it there", async () => {
  const page = await open("/topology");
  await node(page, "ws", "w").waitFor();
  await page.waitForTimeout(400);
  const canvas = (await page.locator(".react-flow").boundingBox())!;
  // The graph's top and bottom on the screen.
  const ends = async () => {
    const boxes = await Promise.all((await page.locator(".react-flow__node").all()).map(async (n) => (await n.boundingBox())!));
    return [Math.min(...boxes.map((b) => b.y)) - canvas.y, Math.max(...boxes.map((b) => b.y + b.height)) - canvas.y] as const;
  };
  const [top, bottom] = await ends();
  expect(bottom - top).toBeLessThan(canvas.height - 64);
  expect(Math.round(top)).toBe(16);
  // Dragged down, it goes no further than the graph's 32px margin, and is not centred when let go of.
  await page.mouse.move(40, canvas.y + 200);
  await page.mouse.down();
  await page.mouse.move(40, canvas.y + 260, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
  expect((await ends())[0]).toBeLessThanOrEqual(32);
  // Dragged up as far as it goes, then zoomed in low on the screen and dragged up again: its top stays on the screen.
  const drag = async (dy: number) => {
    await page.mouse.move(40, canvas.y + 400);
    await page.mouse.down();
    await page.mouse.move(40, canvas.y + 400 + dy, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  await drag(-300);
  await page.mouse.move(200, canvas.y + canvas.height - 40);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -300);
  await page.waitForTimeout(600);
  expect((await ends())[0]).toBeGreaterThanOrEqual(0);
  await drag(-300);
  expect((await ends())[0]).toBeGreaterThanOrEqual(0);
});

smoke("#255: on a phone, archived slots shown or hidden around the focus leave it where it was on the screen", async () => {
  // An archived child of the first slot: shown, it pushes talks down the tree.
  const gone = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "gone", parent: asking, dir: "/w", mode: "headless", state: "idle", lifetime: "oneoff", archivedAt: Date.now() }).id);
  try {
    const page = await open(`/topology/slot/${talks}`);
    const talksY = async () => (await node(page, "slot", "talks").boundingBox())!.y;
    await node(page, "slot", "talks").waitFor();
    await page.waitForTimeout(400);
    const before = await talksY();
    await page.getByRole("button", { name: "已归档" }).click();
    await node(page, "slot", "gone").waitFor();
    await page.waitForTimeout(400);
    expect(await talksY()).toBe(before);
    await page.getByRole("button", { name: "已归档" }).click();
    await node(page, "slot", "gone").waitFor({ state: "detached" });
    await page.waitForTimeout(400);
    expect(await talksY()).toBe(before);
  } finally {
    store.tx((tx) => tx.delete("slot", { id: gone }));
  }
});

smoke("stories 374, 375: 展开全部工作区 opens every workspace, the focus staying where it was on the screen, and stays on when the page loads again; both switches say what they do under a mouse", async () => {
  // A workspace above w, its slots pushing w down once it opens.
  const a = store.tx((tx) => {
    const id = tx.insert("workspace", { name: "a", dir: "/a" }).id;
    for (let i = 0; i < 3; i++) tx.insert("slot", { workspace: id, name: `a${i}`, dir: "/a", mode: "headless", state: "idle", lifetime: "longterm" });
    return id;
  });
  try {
    const page = await open(`/topology/slot/${talks}`);
    const unfold = page.getByRole("button", { name: "展开全部工作区" });
    expect(await unfold.getAttribute("title")).toBe("展开全部工作区");
    expect(await page.getByRole("button", { name: "显示已归档" }).getAttribute("title")).toBe("显示已归档");
    const talksY = async () => (await node(page, "slot", "talks").boundingBox())!.y;
    await node(page, "slot", "talks").waitFor();
    expect((await node(page, "ws", "a").boundingBox())!.y).toBeLessThan(await talksY());
    await page.waitForTimeout(400);
    const before = await talksY();
    await unfold.click();
    await node(page, "slot", "a0").waitFor();
    expect(await unfold.getAttribute("aria-pressed")).toBe("true");
    await page.waitForTimeout(400);
    expect(await talksY()).toBe(before);
    // Kept on the device: the overview, loaded again, has every workspace open.
    await page.goto(`http://127.0.0.1:${server!.port}/#/topology`);
    await page.reload();
    await node(page, "slot", "a0").waitFor();
    await node(page, "slot", "finished").waitFor();
    await unfold.click();
    await node(page, "slot", "a0").waitFor({ state: "detached" });
  } finally {
    store.tx((tx) => {
      tx.delete("slot", { workspace: a });
      tx.delete("workspace", { id: a });
    });
  }
});

smoke("story 227: the sheet dragged to a third of the screen stays at that height as the focus changes, and when the page loads again", async () => {
  const page = await open("/topology");
  const sheet = sheetOf(page);
  await sheet.getByRole("button", { name: "展开详情" }).waitFor(); // the overview: what needs you and runs
  const bar = (await sheet.boundingBox())!;
  const screen = page.viewportSize()!.height;
  await page.mouse.move(bar.x + 40, bar.y + 20);
  await page.mouse.down();
  await page.mouse.move(bar.x + 40, bar.y - 100, { steps: 5 });
  await page.mouse.move(bar.x + 40, (screen * 2) / 3 + 20, { steps: 5 });
  await page.mouse.up();
  const height = Math.round((await sheet.boundingBox())!.height);
  expect(Math.abs(height - screen / 3)).toBeLessThan(30);

  // A slot with a conversation has its timeline to show.
  await node(page, "ws", "w").click();
  await node(page, "slot", "talks").click();
  await sheet.getByRole("heading", { name: "w/talks" }).waitFor();
  await until(async () => Math.round((await sheet.boundingBox())!.height) === height);
  await page.reload();
  await sheet.getByRole("heading", { name: "w/talks" }).waitFor();
  await until(async () => Math.round((await sheet.boundingBox())!.height) === height);
});

smoke("story 376: on a phone a tap beside a Bot's thin line focuses it, one on its title the Bot: the path and the sheet have it, 打开槽位 with it; tapped again it is let go of; back is on the overview", async () => {
  // Bot q, its private chat 我 following its default, w/finished: over what the store has, which has no bots.
  const page = await open("/topology", async (p) => {
    await p.route("**/api/topology", async (route) => {
      const g = await (await route.fetch({ maxRetries: 1 })).json();
      const bots = [{ id: "q", name: "q", platform: "qq", main: true, conn: "online", target: finished, avatar: `data:image/png;base64,${PIXEL}` }];
      await route.fulfill({ json: { ...g, bots, chats: [{ id: "c1", bot: "q", kind: "private", yours: true, name: "我", main: true, avatar: `data:image/png;base64,${PIXEL}`, verbose: false }], bindings: [{ chat: "c1", slot: finished, use: false }] } });
    });
  });
  await node(page, "bot", "q").waitFor();
  await page.waitForTimeout(400);
  // Halfway along the Bot's line, 10px to the side of it.
  const at = await page.evaluate(() => {
    const p = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="bot:q"] .react-flow__edge-path`)!;
    const m = p.getPointAtLength(p.getTotalLength() / 2).matrixTransform(p.getScreenCTM()!);
    return { x: m.x, y: m.y };
  });
  // 10px under the Bot's end, where the chat's link runs over its title: the title is the Bot's.
  const head = await page.evaluate(() => {
    const p = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="link:c1"] .react-flow__edge-path`)!;
    const m = p.getScreenCTM()!;
    const e = p.getPointAtLength(p.getTotalLength()).matrixTransform(m);
    return { x: e.x, y: e.y + 10 * m.a };
  });
  await page.mouse.click(head.x, head.y);
  await until(() => new URL(page.url()).hash === "#/topology/bot/q");
  // The kind mark on its chat's face, on a row of the folded card, ringed in the row's ground (#534).
  expect(await sheetOf(page).getByRole("img", { name: "私聊", includeHidden: true }).getAttribute("class")).toContain("ring-background");
  await page.mouse.click(at.x + 10, at.y);
  await until(() => new URL(page.url()).hash === "#/topology/line/q");
  await page.getByRole("navigation", { name: "路径" }).getByText("finished").waitFor();
  // The mark on the Bot's face in the path ringed in the path's ground, not the card's (#534).
  expect(await page.getByRole("navigation", { name: "路径" }).getByRole("img", { name: "QQ" }).getAttribute("class")).toContain("ring-background");
  const sheet = sheetOf(page);
  await sheet.getByRole("heading", { name: "w/finished" }).waitFor();
  await sheet.getByRole("button", { name: /打开槽位/ }).waitFor();
  expect(await sheet.getByRole("button", { name: "展开详情" }).count()).toBe(0);
  await page.mouse.click(at.x + 10, at.y);
  await until(() => new URL(page.url()).hash === "#/topology/line/q?x");
  await sheet.getByRole("heading", { name: "总览" }).waitFor();
  await page.goBack();
  await until(() => new URL(page.url()).hash === "#/topology");
});

smoke("#310: on a phone no name on the topology is cut short: 匿名用户, Echo Agent and the rest in full", async () => {
  // As the real instance has it: Bots main (the main one, its private chat the main chat), Echo Agent
  // and telegram, a private chat each, QQ's with no name; and a group.
  const slot = (workspace: string, name: string) => ({ id: `${workspace}/${name}`, ref: `${workspace}/${name}`, name, workspace, parent: null, agent: "claude", mode: "headless", phase: "idle", state: "空闲", group: "idle", lifetime: "longterm", archived: false, contact: null });
  const slots = [slot("dispatcher", "main"), slot("dispatcher", "DeepSeek"), slot("HomeProject", "homehelp"), slot("Rhodium", "dev"), slot("Rhodium", "open-source")];
  const bot = (id: string, name: string, platform: string, target: string) => ({ id, name, platform, main: id === "main", conn: "online", target, avatar: null });
  const chat = (id: string, bot: string, kind: string, name: string | null) => ({ id, bot, kind, name, main: id === "c-main", avatar: null, verbose: false });
  const topology = {
    bots: [bot("main", "main", "qq", "Rhodium/dev"), bot("mc", "Echo Agent", "qq", "HomeProject/homehelp"), bot("tg", "telegram", "telegram", "dispatcher/main")],
    chats: [chat("c-main", "main", "private", null), chat("c-mc", "mc", "private", null), chat("g-mc", "mc", "group", null), chat("c-tg", "tg", "private", "Iris Morgan")],
    bindings: [
      { chat: "c-main", slot: "Rhodium/dev", use: false },
      { chat: "c-mc", slot: "HomeProject/homehelp", use: false },
      { chat: "g-mc", slot: "dispatcher/main", use: true },
      { chat: "c-tg", slot: "dispatcher/DeepSeek", use: true },
    ],
    workspaces: ["dispatcher", "HomeProject", "Rhodium"].map((w) => ({ id: w, name: w })),
    slots,
  };
  const page = await open("/topology", async (p) => void (await p.route("**/api/topology", (route) => route.fulfill({ json: topology }))));
  await node(page, "bot", "Echo Agent").waitFor();
  const names = page.locator(".react-flow__node .truncate");
  expect(await names.allTextContents()).toEqual(expect.arrayContaining(["main", "Echo Agent", "telegram", "匿名用户", "群聊", "Iris Morgan", "dispatcher", "HomeProject", "DeepSeek", "homehelp"]));
  expect(await names.evaluateAll((all) => all.filter((e) => e.scrollWidth > e.clientWidth || e.textContent!.includes("…")).map((e) => e.textContent))).toEqual([]);
});

smoke("stories 244, 247: the home switches to the topology, and opens there again with no address; a chat's 拓扑图 button opens it on that slot, and is back when the chat was opened from there", async () => {
  const page = await open();
  await page.getByRole("button", { name: "拓扑图" }).click();
  expect(new URL(page.url()).hash).toBe("#/topology");
  await page.goto(`http://127.0.0.1:${server!.port}/`);
  await sheetOf(page).getByRole("heading", { name: "总览" }).waitFor();
  expect(new URL(page.url()).hash).toBe("#/topology");

  // From the chat, the topology on its slot, a step of its own.
  await page.goto(`http://127.0.0.1:${server!.port}/#/slot/${finished}`);
  await page.getByRole("button", { name: "拓扑图" }).click();
  await sheetOf(page).getByRole("heading", { name: "w/finished" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}`);
  // Its 打开槽位 goes back to that chat, and the chat's button back to it again: the steps don't pile up.
  const steps = await page.evaluate(() => history.length);
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await until(() => new URL(page.url()).hash === `#/slot/${finished}`);
  await page.getByRole("button", { name: "拓扑图" }).click();
  await until(() => new URL(page.url()).hash === `#/topology/slot/${finished}`);
  await sheetOf(page).getByRole("heading", { name: "w/finished" }).waitFor();
  expect(await page.evaluate(() => history.length)).toBe(steps);

  // A chat opened from the topology: its back arrow goes back there too.
  await page.goto(`http://127.0.0.1:${server!.port}/#/topology/slot/${finished}`);
  await page.reload();
  const before = await page.evaluate(() => history.length);
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("log", { name: "对话" }).waitFor();
  await page.getByRole("button", { name: "返回" }).click();
  await sheetOf(page).getByRole("heading", { name: "w/finished" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}`);
  expect(await page.evaluate(() => history.length)).toBe(before + 1); // the chat's step, ahead

  await page.getByRole("button", { name: "列表" }).click();
  expect(new URL(page.url()).hash).toBe("#/");
  await page.goto(`http://127.0.0.1:${server!.port}/`);
  await page.getByRole("link", { name: /^w \/ asks/ }).waitFor();
  // #/ is the list, whichever this device chose last.
  await page.getByRole("button", { name: "拓扑图" }).click();
  await page.goto(`http://127.0.0.1:${server!.port}/#/`);
  await page.reload();
  await page.getByRole("link", { name: /^w \/ asks/ }).waitFor();
  expect(new URL(page.url()).hash).toBe("#/");
});

smoke("story 244: on a wide screen a slot's chat beside the list has 列表 pressed, and pressing it leaves the chat open", async () => {
  const page = await open(`/slot/${finished}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await page.getByRole("log", { name: "对话" }).waitFor();
  const list = page.getByRole("button", { name: "列表" });
  expect(await list.getAttribute("aria-pressed")).toBe("true");
  await list.click();
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
});

/** A wide screen width px wide. */
const wide = (width = 1440) => ({ viewport: { width, height: 900 } }) as (typeof devices)[string];
/** Drags the line between the split's sides to x px from the page's left. */
async function dragTo(page: Page, x: number) {
  const at = (await page.getByRole("separator").boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, at.y + at.height / 2, { steps: 5 });
  await page.mouse.up();
}

smoke("stories 415, 417: on a wide screen 放大 puts the sidebar, 288px, in the list's place, the chat from its edge to the page's; a step of its own, kept on reload; back goes to the split as it was", async () => {
  for (const width of [1440, 1180]) {
    const page = await open(`/slot/${finished}`, undefined, wide(width));
    const chat = page.getByRole("log", { name: "对话" });
    const side = page.getByRole("navigation", { name: "槽位" });
    const hash = () => new URL(page.url()).hash;
    await chat.waitFor();
    // The line moved, so the split goes back to where you left it, not where it opens.
    await dragTo(page, width * 0.4 + 150);
    const split = (await chat.boundingBox())!.x;
    const steps = await page.evaluate(() => history.length);

    await page.getByRole("button", { name: "放大" }).click();
    // Under 1280px the sidebar starts collapsed (story 432), the chat filling the page.
    if (width < 1280) {
      await page.getByRole("button", { name: /^展开侧栏/ }).waitFor();
      expect(await chat.boundingBox()).toMatchObject({ x: 0, width });
      await page.getByRole("button", { name: /^展开侧栏/ }).click();
    }
    await side.waitFor();
    expect(hash()).toBe(`#/slot/${finished}?full`);
    expect(await page.evaluate(() => history.length)).toBe(steps + 1);
    await until(async () => (await chat.boundingBox())!.x === 288);
    const [s, c] = [(await side.boundingBox())!, (await chat.boundingBox())!];
    expect([s.x, s.width, c.x, c.width]).toEqual([0, 288, 288, width - 288]);
    expect(await page.getByRole("button", { name: "列表" }).count()).toBe(0);
    await page.reload();
    await side.waitFor();
    await page.getByRole("button", { name: "缩小" }).waitFor();
    await page.goBack();
    await page.getByRole("button", { name: "放大" }).waitFor();
    expect(hash()).toBe(`#/slot/${finished}`);
    expect(await side.count()).toBe(0);
    expect((await chat.boundingBox())!.x).toBeCloseTo(split, -1);
    await page.context().close();
  }
});

/** How much wider than its box what is in it is. */
const over = (l: Locator) => l.evaluate((el) => el.scrollWidth - el.clientWidth);

smoke("#488: a long line in the agent's code block, 自动换行 off, scrolls inside the block, the chat no wider, nor for a wide table, in maximize mode and on a phone", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "longcode", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t-code", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const line = "Get-ChildItem -Path C:\\Users -Recurse -Filter *.log | ".repeat(12) + "Remove-Item";
  const table = `|${" column |".repeat(30)}\n|${"---|".repeat(30)}`;
  writeFileSync(join(talked, "../2026-10-23_t-code.jsonl"), said("user", "how") + said("assistant", `Run:\n\n\`\`\`powershell\n${line}\n\`\`\`\n\n${table}`));
  for (const device of [wide(), devices["Pixel 7"]]) {
    const page = await open(`/slot/${slot}?full`, undefined, device);
    const code = page.locator("pre", { hasText: "Remove-Item" });
    await code.waitFor();
    await page.getByRole("button", { name: "自动换行" }).click();
    expect(await over(page.getByRole("log", { name: "对话" }))).toBe(0);
    expect(await over(code)).toBeGreaterThan(0);
    await page.context().close();
  }
});

smoke("#510: on a 360px phone the chat is no wider for a long source label over your bubble, from a slot's rh send, which wraps to two lines, the bubble inside the chat; nor for a long file's name in one still sending, cut", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "sourced", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t-sourced", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  writeFileSync(join(talked, "../2026-10-23_t-sourced.jsonl"), said("user", "[来自 槽位 HomeProject/homehelp，经 rh send]\n用户转来的 Rhodium 需求") + said("assistant", "ok"));
  const page = await open(`/slot/${slot}`, undefined, { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } });
  const log = page.getByRole("log", { name: "对话" });
  const bubble = log.getByText("用户转来的 Rhodium 需求");
  const badge = log.getByText("槽位 HomeProject/homehelp，经 rh send");
  await badge.waitFor();
  const [b, l, s] = [(await bubble.boundingBox())!, (await log.boundingBox())!, (await badge.boundingBox())!];
  // Two 16px lines, 1px of padding and of border above and below.
  expect([await over(log), b.x + b.width <= l.x + l.width, Math.round(s.height)]).toEqual([0, true, 36]);

  let sent = (_: RhReply) => {};
  answer = () => new Promise((done) => (sent = done));
  try {
    const name = `${"quarterly-requirements-".repeat(4)}final.pdf`;
    await page.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/pdf", buffer: Buffer.from("x") });
    await page.getByRole("textbox", { name: "消息" }).fill("看看这个");
    await page.getByRole("button", { name: "发送" }).click();
    const file = log.locator(".opacity-60").getByText(name);
    await file.waitFor();
    expect([await over(log), await over(file) > 0]).toEqual([0, true]);
    sent({ ok: true, text: "开始新回合" });
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
  await page.context().close();
});

smoke("#498: a code block is one box, its language, if the fence has one, in a slim row with 自动换行 and 复制; 复制 puts its code on the clipboard as written; blocks wrap by default, and 自动换行 off on one unwraps the other too, kept on reload", async () => {
  const slot = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "codes", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: "t-codes", startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return id;
  });
  const ts = `function go() {\n  return "${"long ".repeat(40)}";\n}`;
  const url = `https://example.com/${"a/".repeat(120)}`;
  writeFileSync(join(talked, "../2026-10-23_t-codes.jsonl"), said("user", "how") + said("assistant", `\`\`\`ts\n${ts}\n\`\`\`\n\n\`\`\`\n${url}\n\`\`\``));
  const page = await open(`/slot/${slot}`, (page) => page.context().grantPermissions(["clipboard-read", "clipboard-write"]));
  const log = page.getByRole("log", { name: "对话" });
  const [first, second] = [log.locator("pre", { hasText: "function go" }), log.locator("pre", { hasText: "example.com" })];
  await second.waitFor();
  expect(await log.locator('[data-streamdown="code-block-header"]').count()).toBe(0);
  await log.getByText("ts", { exact: true }).waitFor();
  expect([await over(first), await over(second)]).toEqual([0, 0]);
  // The block's own, not the message's under it (story 571).
  await first.locator("..").getByRole("button", { name: "复制" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ts);
  const wraps = log.getByRole("button", { name: "自动换行" });
  expect(await wraps.count()).toBe(2);
  await wraps.first().click();
  for (const reload of [false, true]) {
    if (reload) await page.reload();
    await second.waitFor();
    expect(await wraps.nth(1).getAttribute("aria-pressed")).toBe("false");
    expect(await over(second)).toBeGreaterThan(0);
  }
});

/** A slot named name whose chat has the agent say text, gone when the test ends: just used, it
 *  would sit atop the list, pushing the rows other tests open out of the sidebar's sight. */
const saying = (name: string, text: string) => {
  const [slot, conversation] = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot: id, agent: "pi", sessionId: `t-${name}`, startedAt: Date.now() }).id;
    tx.update("slot", { id }, { conversation });
    return [id, conversation];
  });
  onTestFinished(() => store.tx((tx) => (tx.delete("slot", { id: slot }), tx.delete("conversation", { id: conversation }))));
  writeFileSync(join(talked, `../2026-10-23_t-${name}.jsonl`), said("user", "how") + said("assistant", text));
  return slot;
};

smoke("stories 561, 562, 565: an rh send to you shows its words and picture under its fold, folded; a picture gone keeps its box; a picture you send shows as big while it waits as once sent, then as its preview, which opens the viewer, its download the picture itself; back closes it, the chat still there", async () => {
  const one = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const [chart, shot] = await Promise.all([new Bun.Image(one).resize(800, 450).png().bytes(), new Bun.Image(one).resize(600, 1300).jpeg().bytes()]);
  const hash = (data: Uint8Array) => new Bun.CryptoHasher("sha256").update(data).digest("hex");
  const media = join(base, "state/media");
  mkdirSync(media, { recursive: true });
  writeFileSync(join(media, hash(chart)), chart);
  const slot = saying("pics", "看看");
  const transcript = join(talked, "../2026-10-23_t-pics.jsonl");
  const line = (message: unknown) => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n";
  const bash = (id: string, command: string) => line({ role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] }) + line({ role: "toolResult", toolCallId: id, content: [{ type: "text", text: "ok" }], isError: false });
  const lost = line({ role: "user", content: [{ type: "text", text: `[来自 网页]\n[图片] ${join(media, "0".repeat(64))}` }] });
  appendFileSync(transcript, lost + bash("c1", "rh send me --file chart.png 测试过了") + bash("c2", "ls"));
  store.tx((tx) => tx.append({ source: "rh", type: "send_me", slot, data: { files: [{ kind: "image", hash: hash(chart), name: "chart.png" }] } }));
  const page = await open(`/slot/${slot}`);
  const log = page.getByRole("log", { name: "对话" });
  // One gone from the media dir: a box as big as the one it showed in first, bordered as the others.
  const gone = log.getByText("图片已清理");
  await gone.waitFor();
  expect(await gone.evaluate((e: HTMLElement) => [e.offsetWidth, e.offsetHeight, getComputedStyle(e).borderTopWidth])).toEqual([160, 160, "1px"]);
  await log.getByText("测试过了", { exact: true }).waitFor();
  await log.getByRole("button", { name: "图片" }).waitFor();

  await page.locator('input[type="file"]').setInputFiles({ name: "shot.jpg", mimeType: "image/jpeg", buffer: Buffer.from(shot) });
  await page.getByRole("button", { name: "发送" }).click();
  // Waiting for the record, it shows as big as once it is there: the page does not jump.
  const waiting = log.getByRole("img", { name: "shot.jpg" });
  await until(async () => ((await waiting.boundingBox())?.height ?? 0) > 100);
  const before = (await waiting.boundingBox())!;
  // The board kept it by its content; the agent's record has your message with its line, as Rhodium wrote it.
  await until(() => existsSync(join(media, hash(shot))));
  appendFileSync(transcript, line({ role: "user", content: [{ type: "text", text: `[来自 网页]\n[图片] ${join(media, hash(shot))}` }] }));
  const pictures = log.getByRole("button", { name: "图片" });
  await until(async () => (await pictures.count()) === 2);
  const after = (await pictures.last().boundingBox())!;
  expect([Math.abs(after.width - before.width), Math.abs(after.height - before.height)].every((d) => d < 2)).toBe(true);
  await pictures.last().click();
  const viewer = page.getByRole("dialog", { name: "图片" });
  await viewer.waitFor();
  const download = viewer.getByRole("link", { name: "下载原图" });
  expect([await download.getAttribute("href"), await download.getAttribute("download")]).toEqual([`api/media?h=${hash(shot)}`, `${hash(shot)}.jpeg`]);
  await page.goBack();
  await viewer.waitFor({ state: "detached" });
  expect(new URL(page.url()).hash).toBe(`#/slot/${slot}`);
  await log.getByText("测试过了", { exact: true }).waitFor();
});

smoke("story 563: a picture the agent read shows in its call's result, with no empty box for the text it had none of, nor for a command that printed nothing; tapped, the viewer", async () => {
  const one = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const shot = await new Bun.Image(one).resize(600, 400).png().bytes();
  const slot = saying("looked", "看看");
  const line = (message: unknown) => JSON.stringify({ type: "message", timestamp: new Date().toISOString(), message }) + "\n";
  const read = line({ role: "assistant", content: [{ type: "toolCall", id: "r1", name: "read", arguments: { path: "/w/shot.png" } }] });
  const result = line({ role: "toolResult", toolCallId: "r1", content: [{ type: "image", data: Buffer.from(shot).toString("base64"), mimeType: "image/png" }], isError: false });
  const touch = line({ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "touch seen" } }] }) + line({ role: "toolResult", toolCallId: "t1", content: [{ type: "text", text: "" }], isError: false });
  appendFileSync(join(talked, "../2026-10-23_t-looked.jsonl"), read + result + touch + said("assistant", "是一张图"));
  const page = await open(`/slot/${slot}`);
  const log = page.getByRole("log", { name: "对话" });
  await log.locator("summary").first().click();
  for (const step of await log.locator("details details > summary").all()) await step.click();
  await log.locator("details details").first().getByRole("button", { name: "图片" }).click();
  expect(await log.locator("details details pre").count()).toBe(2); // their arguments' alone
  await page.getByRole("dialog", { name: "图片" }).waitFor();
});

smoke("#588: a picture and a file sent alone that failed are both red; a picture the chat will show as a file shows as one while it waits", async () => {
  answer = async () => ({ ok: false, error: "" });
  try {
    const page = await open(`/slot/${rests}`);
    await page.locator('input[type="file"]').setInputFiles([
      { name: "a.png", mimeType: "image/png", buffer: Buffer.from(PIXEL, "base64") },
      { name: "b.heic", mimeType: "image/heic", buffer: Buffer.from("x") },
    ]);
    await page.getByRole("button", { name: "发送" }).click();
    const retry = page.getByRole("button", { name: "重试" });
    await retry.waitFor();
    const log = page.getByRole("log", { name: "对话" });
    expect(await log.getByRole("img", { name: "b.heic" }).count()).toBe(0);
    const red = await retry.evaluate((e) => getComputedStyle(e).color);
    const borders = [log.getByRole("img", { name: "a.png" }), log.getByText("b.heic").locator("..")].map((l) => l.evaluate((e) => getComputedStyle(e).borderTopColor));
    expect(await Promise.all(borders)).toEqual([red, red]);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("#507: a code block whose fence names no language says text over it", async () => {
  const page = await open(`/slot/${saying("plain", "```\nhello\n```")}`);
  await page.getByRole("log", { name: "对话" }).getByText("text", { exact: true }).waitFor();
});

/** How wide the clear strip of a scroller's edge fade is at its left and its right, as its mask has it, 0 for none. */
const fades = (l: Locator) =>
  l.evaluate((el) => {
    const mask = getComputedStyle(el).maskImage;
    return [/^linear-gradient\(to right, rgba\(0, 0, 0, 0\) ([\d.]+)px/, /rgba\(0, 0, 0, 0\) calc\(100% - ([\d.]+)px\)\)/].map((re) => Number(re.exec(mask)?.[1] ?? 0));
  });

/** Whether a scroller clips what it draws, a phone's floating bar too, to round corners as its box's at
 *  its end, the top or the bottom (#646): Chromium draws that bar over a scroller's own round corners. */
const cornered = (l: Locator, end: "top" | "bottom") =>
  l.evaluate((el, end) => {
    const radii = (e: Element) => ["left", "right"].map((side) => getComputedStyle(e).getPropertyValue(`border-${end}-${side}-radius`)).join();
    return getComputedStyle(el).clipPath === "border-box" && radii(el) === radii(el.parentElement!) && radii(el) !== "0px,0px";
  }, end);

smoke("#507: 自动换行 off, a code block fades its text out 12px inside an edge only while there is more to scroll that way, its end clear of the border, and one that fits not at all", async () => {
  const line = "kjj.wuhan.gov.cn/wmfw/tzgg/".repeat(8) + "end";
  const page = await open(`/slot/${saying("fades", `\`\`\`\n${line}\n\`\`\`\n\n\`\`\`\nshort\n\`\`\``)}`);
  const log = page.getByRole("log", { name: "对话" });
  const [long, short] = [log.locator("pre", { hasText: "end" }), log.locator("pre", { hasText: "short" })];
  await short.waitFor();
  await log.getByRole("button", { name: "自动换行" }).first().click();
  await until(async () => (await fades(long))[1]! > 0);
  expect([await fades(long), await fades(short)]).toEqual([[0, 12], [0, 0]]);
  await long.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await until(async () => (await fades(long))[0]! > 0);
  expect(await fades(long)).toEqual([12, 0]);
  const gap = await long.evaluate((el) => {
    const text = el.querySelector("code")!.firstChild!;
    const last = document.createRange();
    last.setStart(text, text.textContent!.length - 1);
    last.setEnd(text, text.textContent!.length);
    return el.parentElement!.getBoundingClientRect().right - last.getBoundingClientRect().right;
  });
  expect(gap).toBeGreaterThanOrEqual(12);
  // On a phone its bar floats, kept inside the box's round corners (#646).
  expect(await cornered(long, "bottom")).toBe(true);
});

smoke("#507: wrapped, a line keeps its indent as far as the box goes, and its continuation starts under it, a tab counted as shown, but never past a third of the box; 复制 copies the block as written", async () => {
  const ts = `function go() {\n\t  return f("${"long ".repeat(40)}");\n${" ".repeat(48)}deep("${"x ".repeat(40)}");\n${" ".repeat(16)}one();\n${" ".repeat(32)}two();\n}`;
  const page = await open(`/slot/${saying("indent", `\`\`\`ts\n${ts}\n\`\`\``)}`, (page) => page.context().grantPermissions(["clipboard-read", "clipboard-write"]));
  const log = page.getByRole("log", { name: "对话" });
  const pre = log.locator("pre", { hasText: "function go" });
  await pre.waitFor();
  /** Where each screen line of a line's words, from word to its end, starts, from the box's left. */
  const starts = (word: string) =>
    pre.evaluate((el, word) => {
      const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      while (!walk.nextNode()!.textContent!.includes(word));
      const text = walk.currentNode, from = text.textContent!.indexOf(word);
      const words = document.createRange();
      words.setStart(text, from);
      words.setEnd(text, text.textContent!.trimEnd().length);
      const lines = new Map<number, number>();
      for (const r of words.getClientRects()) lines.set(Math.round(r.top), Math.min(lines.get(Math.round(r.top)) ?? r.left, r.left));
      return [...lines.values()].map((x) => Math.round(x - el.getBoundingClientRect().left));
    }, word);
  const [indented, deep] = [await starts("return"), await starts("deep")];
  expect([indented.length > 1, deep.length > 1]).toEqual([true, true]);
  expect([new Set(indented).size, new Set(deep).size]).toEqual([1, 1]);
  // A third of the box, past the code's own 12px padding.
  expect(deep[0]).toBeLessThanOrEqual((await pre.evaluate((el) => el.clientWidth)) / 3 + 12);
  // Past a third of the box, yet short of its edge on a phone: drawn as deep as written.
  const [one, two] = [await starts("one"), await starts("two")];
  const ch = await pre.evaluate((el) => Object.assign(document.createElement("canvas").getContext("2d")!, { font: getComputedStyle(el).font }).measureText("0").width);
  expect(Math.abs(two[0]! - one[0]! - 16 * ch)).toBeLessThanOrEqual(1);
  expect(await over(pre)).toBe(0);
  await pre.locator("..").getByRole("button", { name: "复制" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ts);
});

/** A chat of two things you said and two the agent said, the first in Markdown, your first with a picture's line. */
const twice = (name: string) => {
  const slot = saying(name, "**第一段**");
  const hash = "0".repeat(64);
  writeFileSync(join(talked, `../2026-10-23_t-${name}.jsonl`), said("user", `看看这张图\n[图片] /w/state/media/${hash}`) + said("assistant", "**第一段**") + said("user", "再说") + said("assistant", "第二段"));
  return slot;
};
/** How opaque the row l, a key, is in, once it stopped fading. */
const opacity = (l: Locator) => l.evaluate(async (el) => (await Promise.all(el.parentElement!.getAnimations().map((a) => a.finished)), getComputedStyle(el.parentElement!).opacity));

smoke("stories 571-573: on a phone each thing the agent said has 复制 and 引用 under it, yours 复制 alone; 复制 copies it as written, yours without its picture's line; 引用 puts it over where you type, another 引用 in its place, × takes it off; sent, it goes first and is gone", async () => {
  const slot = twice("quoting");
  const page = await open(`/slot/${slot}`, (page) => page.context().grantPermissions(["clipboard-read", "clipboard-write"]));
  const log = page.getByRole("log", { name: "对话" });
  await log.getByText("第二段", { exact: true }).waitFor();
  const [copies, quotes] = [log.getByRole("button", { name: "复制", exact: true }), log.getByRole("button", { name: "引用", exact: true })];
  expect([await copies.count(), await quotes.count()]).toEqual([4, 2]);
  expect([await opacity(copies.first()), await opacity(quotes.first())]).toEqual(["1", "1"]);
  await copies.nth(1).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("**第一段**");
  await copies.first().click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("看看这张图");

  const bar = page.getByText(/^引用：/);
  await quotes.first().click();
  // Its Markdown marks gone, as you read it; the agent still gets them (below).
  expect(await bar.textContent()).toBe("引用：第一段");
  await quotes.nth(1).click();
  expect([await bar.count(), await bar.textContent()]).toEqual([1, "引用：第二段"]);
  await page.getByRole("button", { name: "取消引用" }).click();
  await bar.waitFor({ state: "detached" });

  await quotes.nth(1).click();
  await page.getByRole("textbox", { name: "消息" }).fill("那第二处呢");
  // Not sent, it stays with the slot, as its words do.
  const go = async (id: string, name: string) => (await page.evaluate((id) => (location.hash = `#/slot/${id}`), id), await page.getByRole("heading", { name }).waitFor());
  await go(finished, "w/finished");
  await go(slot, "w/quoting");
  expect(await bar.textContent()).toBe("引用：第二段");
  const n = acted.length;
  await page.getByRole("button", { name: "发送", exact: true }).click();
  await until(() => acted.length === n + 1);
  expect(acted.at(-1)!.act).toEqual({ kind: "say", slot, text: "> 第二段\n\n那第二处呢" });
  await bar.waitFor({ state: "detached" });
});

smoke("story 571: on a computer, with the mouse on no message only the agent's last has 复制 and 引用 showing; on one, its own show too, and so do those a key reaches; hidden or not, they sit in the gap under it, not a row of their own", async () => {
  const page = await open(`/slot/${twice("hovering")}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const log = page.getByRole("log", { name: "对话" });
  await log.getByText("第二段", { exact: true }).waitFor();
  const [copies, quotes] = [log.getByRole("button", { name: "复制", exact: true }), log.getByRole("button", { name: "引用", exact: true })];
  await page.mouse.move(1, 1);
  expect([await opacity(copies.first()), await opacity(quotes.first()), await opacity(quotes.last())]).toEqual(["0", "0", "1"]);
  await log.getByText("第一段", { exact: true }).hover();
  expect([await opacity(copies.first()), await opacity(quotes.first())]).toEqual(["0", "1"]);
  // From its words' bottom to the next block, at most 8px over the chat's 16px gap, its icons clear of both.
  const gap = await quotes.first().evaluate((key) => {
    const said = key.closest(".group")!, words = said.querySelector("p")!.getBoundingClientRect(), next = said.nextElementSibling!.getBoundingClientRect(), icon = key.querySelector("svg")!.getBoundingClientRect();
    return { space: next.top - words.bottom, above: icon.top - words.bottom, below: next.top - icon.bottom };
  });
  expect(gap.space).toBeLessThanOrEqual(24);
  expect([gap.above, gap.below].every((x) => x >= 2)).toBe(true);
  await page.mouse.move(1, 1);
  await page.keyboard.press("Shift");
  await copies.first().focus();
  expect(await opacity(copies.first())).toBe("1");
});

smoke("story 573: on a computer, a long quote does not stretch a short reply's bubble; cut to it, it still shows how it starts; on a screen too narrow for that, it stays inside the bubble", async () => {
  const slot = saying("short", "好");
  writeFileSync(join(talked, `../2026-10-23_t-short.jsonl`), said("user", `> ${"一段很长的回复，".repeat(30)}\n\n嗯`) + said("assistant", "好"));
  /** On a screen width wide, the quote's bubble, how much of the quote shows, and how far its line passes the bubble's inner right edge. */
  const measure = async (width: number) => {
    const page = await open(`/slot/${slot}`, undefined, { viewport: { width, height: 900 } } as (typeof devices)[string]);
    const quote = page.getByRole("log", { name: "对话" }).getByText(/^一段很长的回复/);
    await quote.waitFor();
    return quote.evaluate((el) => {
      const [line, bubble] = [el.parentElement!, el.parentElement!.parentElement!];
      const [b, s] = [bubble.getBoundingClientRect(), getComputedStyle(bubble)];
      return [b.width, el.clientWidth, line.getBoundingClientRect().right - (b.right - parseFloat(s.paddingRight) - parseFloat(s.borderRightWidth))];
    });
  };
  const [bubble, shown] = await measure(1440);
  expect(bubble).toBeLessThan(300);
  expect(shown).toBeGreaterThan(120);
  expect((await measure(280))[2]).toBeLessThanOrEqual(0);
});

/** How wide the focus ring l draws is, outer edge to outer edge, once still, and the round in it: what its padding leaves. */
const ringed = (l: Locator) =>
  l.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
    const s = getComputedStyle(el), r = el.getBoundingClientRect();
    return { ring: r.width + 2 * (parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth)), round: r.width - parseFloat(s.paddingLeft) - parseFloat(s.paddingRight) };
  });

/** A key's ring: its style, and how far inside the key's edge its outer edge is. */
const rung = (l: Locator) =>
  l.evaluate(async (el) => {
    await Promise.all(el.getAnimations().map((a) => a.finished));
    const s = getComputedStyle(el);
    return { style: s.outlineStyle, inset: -parseFloat(s.outlineOffset) - parseFloat(s.outlineWidth) };
  });

smoke("#503: a small control reached by Tab rings what you see along its edge, not its 44px tap: 全部槽位's and a code block's 复制's hover round, so inside the block's 28px top row, the send key's round and 更多's and 详情's button, so in their box, 模型和思考强度 and the topology path's 总览, as tall as their row, a little inside them, 模型和思考强度's words and arrow as far from its ring (#560), and 新建槽位's agents a round apart from their group's edge; the topology sheet's 操作 is in the sheet, rung on its three dots alone (#560)", async () => {
  const page = await open(`/slot/${saying("ring", "```\nhi\n```")}`);
  const log = page.getByRole("log", { name: "对话" });
  await log.getByRole("button", { name: "自动换行" }).focus();
  await page.keyboard.press("Tab");
  expect(await ringed(log.locator("pre").locator("..").getByRole("button", { name: "复制" }))).toEqual({ ring: 24, round: 24 });
  // Moved there by a script after a key, it shows as reached by a key.
  await page.getByRole("link", { name: "全部槽位" }).focus();
  expect(await ringed(page.getByRole("link", { name: "全部槽位" }))).toEqual({ ring: 36, round: 36 });
  for (const name of ["发送", "更多", "详情"]) {
    const tap = page.getByRole("button", { name, exact: true });
    await tap.focus();
    expect(await tap.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
    expect(await rung(tap.locator(":scope > span"))).toEqual({ style: "solid", inset: 0 });
  }
  // 模型和思考强度, as tall as its row: rung on a round inside it, as tall as its neighbours'.
  const claude = await open(`/slot/${withClaude("ringing")}`);
  const model = claude.getByRole("button", { name: "模型和思考强度" });
  await claude.keyboard.press("Tab");
  await model.focus();
  expect(await rung(model)).toEqual({ style: "solid", inset: 4 });
  // Its words' left edge and its arrow's drawn right one, each from the key's edge: the ring is as far in on both sides.
  const [left, right] = await model.evaluate((el) => {
    const [r, arrow] = [el.getBoundingClientRect(), el.querySelector(":scope > svg:last-child path")!.getBoundingClientRect()];
    return [el.firstElementChild!.getBoundingClientRect().left - r.left, r.right - arrow.right];
  });
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  // In a box that clips what sticks out: 新建槽位's agents, rung on the round in them, clear of the box's edge.
  await page.getByRole("link", { name: "全部槽位" }).click();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建槽位" }).click();
  await page.getByRole("dialog").getByRole("textbox", { name: "槽位名" }).focus();
  await page.keyboard.press("Tab");
  const agents = page.getByRole("dialog").getByRole("radio");
  expect(await ringed(agents.first().locator(":scope > span"))).toEqual({ ring: 36, round: 36 });
  // One not picked, dim at rest, is not so with the key on it: its ring would be too.
  await page.keyboard.press("Tab");
  expect(await ringed(agents.nth(1).locator(":scope > span"))).toEqual({ ring: 36, round: 36 });
  expect(await agents.nth(1).evaluate(async (el) => (await Promise.all(el.getAnimations().map((a) => a.finished)), getComputedStyle(el).opacity))).toBe("1");
  // 操作, its 44px tap hung on the collapsed sheet's status line: in the sheet, so a key on it scrolls
  // nothing, and rung on its three dots alone, not as a key beside 打开槽位 lower than it; the path's
  // 总览, as tall as its row, a little inside its edge.
  const top = await open(`/topology/slot/${finished}`);
  const ops = sheetOf(top).getByRole("button", { name: "操作" });
  await top.keyboard.press("Tab");
  await ops.focus();
  expect(await sheetOf(top).evaluate((el) => el.scrollTop)).toBe(0);
  const [s, o] = [(await sheetOf(top).boundingBox())!, (await ops.boundingBox())!];
  expect(o.y + o.height).toBeLessThanOrEqual(s.y + s.height);
  expect(await ops.evaluate((el) => getComputedStyle(el).outlineStyle)).toBe("none");
  const dots = ops.locator(":scope > span");
  expect(await rung(dots)).toEqual({ style: "solid", inset: 0 });
  expect(await dots.evaluate((el) => [el.getBoundingClientRect().width, el.getBoundingClientRect().height])).toEqual([32, 24]);
  const home = top.getByRole("button", { name: "总览" });
  await home.focus();
  expect(await rung(home)).toEqual({ style: "solid", inset: 2 });
});

smoke("#503: a workspace's name reached by Tab rings its name and arrow, as far from them above as below, clear of its card under it; 已归档 its arrow and words, as far from them left as right; a card's first and last rows round as its corners inside its border; an archived row's 恢复 on its hover round", async () => {
  const gone = binned("ringed");
  onTestFinished(() => store.tx((tx) => tx.delete("slot", { id: gone })));
  const page = await open("", undefined, wide());
  const w = page.getByRole("button", { name: "w", exact: true });
  await page.keyboard.press("Tab");
  await w.focus();
  expect(await rung(w)).toEqual({ style: "solid", inset: 0 });
  const [above, below, clear] = await w.evaluate((el) => {
    const what = document.createRange();
    what.selectNodeContents(el);
    const [r, inner] = [el.getBoundingClientRect(), what.getBoundingClientRect()];
    const card = el.parentElement!.querySelector('a[href^="#/slot/"]')!.parentElement!.parentElement!.getBoundingClientRect();
    return [inner.top - r.top, r.bottom - inner.bottom, card.top - r.bottom];
  });
  expect(Math.abs(above - below)).toBeLessThanOrEqual(1);
  expect(clear).toBeGreaterThanOrEqual(2);
  expect(await w.evaluate((el) => ((r) => [r[0], r.at(-1)])([...el.parentElement!.querySelectorAll('a[href^="#/slot/"]')].map((a) => getComputedStyle(a).borderRadius)))).toEqual(["17px 17px 0px 0px", "0px 0px 17px 17px"]);
  const archived = page.getByRole("button", { name: /^已归档/ });
  await archived.focus();
  expect(await rung(archived)).toEqual({ style: "solid", inset: 0 });
  const [left, right] = await archived.evaluate((el) => {
    const what = document.createRange();
    what.selectNodeContents(el);
    const [r, inner] = [el.getBoundingClientRect(), what.getBoundingClientRect()];
    return [inner.left - r.left, r.right - inner.right];
  });
  expect(Math.abs(left - right)).toBeLessThanOrEqual(1);
  await page.keyboard.press("Enter");
  const restore = page.getByRole("button", { name: "恢复" });
  await restore.focus();
  expect(await rung(restore)).toEqual({ style: "solid", inset: 4 });
});

smoke("#560, #595: on a wide screen the topology sheet's 操作 under a mouse grounds its three dots, as a key rings them, not its 44px; a long name in the path ends in an ellipsis; the card's right edge is the header's, as the settings' card's", async () => {
  const long = "averyveryverylongslotnamethatgoesonandon";
  const page = await open(`/topology/slot/${finished}`, async (p) => {
    await p.route("**/api/topology", async (route) => {
      const g = await (await route.fetch({ maxRetries: 1 })).json();
      await route.fulfill({ json: { ...g, slots: g.slots.map((s: { id: string }) => (s.id === finished ? { ...s, name: long } : s)) } });
    });
  }, wide());
  const ops = sheetOf(page).getByRole("button", { name: "操作" });
  await ops.hover();
  expect(await ops.evaluate(async (el) => {
    const dots = el.firstElementChild!;
    await Promise.all(dots.getAnimations().map((a) => a.finished));
    return [getComputedStyle(el).backgroundColor, getComputedStyle(dots).backgroundColor !== "rgba(0, 0, 0, 0)"];
  })).toEqual(["rgba(0, 0, 0, 0)", true]);
  // What holds the name is a box text-overflow works in, not the flex button, which only clips it.
  const name = page.getByRole("navigation", { name: "路径" }).getByText(long);
  expect(await name.evaluate((el) => [getComputedStyle(el).display, getComputedStyle(el).textOverflow, el.scrollWidth > el.clientWidth])).toEqual(["block", "ellipsis", true]);
  const right = async (l: Locator) => ((b) => Math.round(b.x + b.width))((await l.boundingBox())!);
  expect(await right(sheetOf(page))).toBe(await right(page.locator("header", { has: page.getByRole("button", { name: "设置" }) })));
});

smoke("#560: on a phone, 打开槽位 and 新槽位 last in the details' top row, with no key to fold them after, stand as far in from its right edge as the title from its left", async () => {
  for (const [at, label] of [[`slot/${finished}`, "打开槽位"], [`ws/${ws}`, "新槽位"]]) {
    const page = await open(`/topology/${at}`);
    const [right, left] = await sheetOf(page).getByRole("button", { name: label }).evaluate((el) => {
      const bar = el.parentElement!;
      return [bar.getBoundingClientRect().right - el.getBoundingClientRect().right, parseFloat(getComputedStyle(bar).paddingLeft)];
    });
    expect(right).toBe(left);
  }
});

smoke("#502, #646: a table in the agent's message is one box, none around it, narrow or wide; a wide one scrolls inside it with the phone's thin bar, the chat no wider", async () => {
  const narrow = "| a | b |\n|---|---|\n| 1 | 2 |";
  const broad = `|${" column |".repeat(30)}\n|${"---|".repeat(30)}`;
  const page = await open(`/slot/${saying("tables", `${narrow}\n\n${broad}\n\n\`\`\`\ncode\n\`\`\``)}`);
  const log = page.getByRole("log", { name: "对话" });
  const [small, big] = [log.locator("table").first(), log.locator("table").nth(1)];
  await big.waitFor();
  /** How many boxes with a border are there from a table out to the chat. */
  const boxes = (table: Locator) =>
    table.evaluate((el) => {
      let n = 0;
      for (let e = el; !e.matches('[role="log"]'); e = e.parentElement!) if (parseFloat(getComputedStyle(e).borderTopWidth) > 0) n++;
      return n;
    });
  expect([await boxes(small), await boxes(big)]).toEqual([1, 1]);
  const box = big.locator("..");
  expect([await over(log), (await over(box)) > 0, await box.evaluate((el) => getComputedStyle(el).scrollbarWidth)]).toEqual([0, true, "thin"]);
  // A cell's words start as far inside its box as a code block's do.
  const inset = (l: Locator) => l.evaluate((el) => getComputedStyle(el).paddingLeft);
  expect([await inset(small.locator("th").first()), await inset(small.locator("td").first())]).toEqual(Array(2).fill(await inset(log.locator("pre code"))));
});

smoke("#502: a wide table fades its words out 12px inside an edge only while there is more to scroll that way, a narrow one not at all", async () => {
  const narrow = "| a | b |\n|---|---|\n| 1 | 2 |";
  const broad = `|${" column |".repeat(30)}\n|${"---|".repeat(30)}`;
  const page = await open(`/slot/${saying("table-fades", `${narrow}\n\n${broad}`)}`);
  const log = page.getByRole("log", { name: "对话" });
  const [small, big] = [log.locator("table").first().locator(".."), log.locator("table").nth(1).locator("..")];
  await big.waitFor();
  await until(async () => (await fades(big))[1]! > 0);
  expect([await fades(small), await fades(big)]).toEqual([[0, 0], [0, 12]]);
  await big.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await until(async () => (await fades(big))[0]! > 0);
  expect(await fades(big)).toEqual([12, 0]);
});

smoke("#502: in dark mode a table's header is one even ground on a phone, no seam between its columns", async () => {
  const page = await open(`/slot/${saying("seams", "| name | state | kind | when |\n|---|---|---|---|\n| a | b | c | d |")}`, (page) => page.emulateMedia({ colorScheme: "dark" }));
  const head = page.getByRole("log", { name: "对话" }).locator("thead");
  await head.waitFor();
  // The screen as drawn: a clip drawn again at a part-pixel offset would move the seams.
  const png = await page.screenshot();
  const reds = await head.evaluate(async (el, src) => {
    const img = Object.assign(new Image(), { src });
    await img.decode();
    const g = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
    g.drawImage(img, 0, 0);
    // A line in the header's top padding, clear of its words and of the box's round corners, in device pixels.
    const [r, d] = [el.getBoundingClientRect(), devicePixelRatio];
    const [from, to] = [Math.ceil((r.left + 12) * d), Math.floor((r.right - 12) * d)];
    return [...g.getImageData(from, Math.round((r.top + 4) * d), to - from, 1).data.filter((_, i) => i % 4 === 0)];
  }, `data:image/png;base64,${png.toString("base64")}`);
  expect(Math.max(...reds) - Math.min(...reds)).toBeLessThanOrEqual(1);
  // WebKit, every iPhone's browser, paints no shadow on a row group: the ground it shows is this.
  expect(await head.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
});

/** How many lines a table cell's words take. */
const lines = (table: Locator, text: string) =>
  table.getByRole("cell", { name: text }).evaluate((el) => {
    const r = document.createRange();
    r.selectNodeContents(el);
    return new Set([...r.getClientRects()].map((x) => x.top)).size;
  });

smoke("#559: on a phone a table cell's word keeps whole, a link's too, a long one widening the table, which scrolls in its box", async () => {
  const hash = `sha256:${"4f9c2e7b1d0a8c6e".repeat(4)}`;
  const url = "https://example.com/a/long/way/down/to/the/page";
  const page = await open(`/slot/${saying("whole-words", `| name | who |\n|---|---|\n| ${hash} | alpha |\n| beta | ${url} |`)}`);
  const table = page.getByRole("log", { name: "对话" }).locator("table");
  await table.waitFor();
  expect([await lines(table, hash), await lines(table, "alpha"), await lines(table, url), (await over(table.locator(".."))) > 0]).toEqual([1, 1, 1, true]);
});

smoke("#559: on a phone a long path widening a table leaves the column beside it its share of the box, its words a few lines, not two characters a line", async () => {
  const says = "握手时先比版本号，不一致就断开并在日志里写明原因";
  const page = await open(`/slot/${saying("path-beside", `| 文件 | 说明 |\n|---|---|\n| src/holder/protocol/handshake_version_negotiation.rs | ${says} |`)}`);
  const table = page.getByRole("log", { name: "对话" }).locator("table");
  await table.waitFor();
  expect(await lines(table, says)).toBeLessThanOrEqual(4);
});

smoke("#559: on a phone a table with long words in every column still gives the longest cell the most width, not each column an equal share", async () => {
  const what = "Make the dropdown keep its width when the label is long";
  const page = await open(`/slot/${saying("every-long", `| Name | What | Why |\n|---|---|---|\n| configuration | ${what} | Because the menu is narrow on a phone |`)}`);
  const table = page.getByRole("log", { name: "对话" }).locator("table");
  await table.waitFor();
  expect(await lines(table, what)).toBeLessThanOrEqual(4);
});

smoke("story 430: in maximize mode the line moves the sidebar alone, 256 to 448px, the chat keeping 360px, and back to 288 on a double click; kept on this device, a wider window widens only the chat; dragged wider than a phone's list, its rows are a phone's", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const chat = page.getByRole("log", { name: "对话" });
  const width = async () => (await side.boundingBox())!.width;
  const logo = page.locator(`a[href="#/slot/${rests}?full"] > span`).first();
  await side.waitFor();
  expect((await logo.boundingBox())!.width).toBe(28);
  await dragTo(page, 700);
  expect(await width()).toBe(448);
  // The chat keeps 360px, the width kept as it was.
  await page.setViewportSize({ width: 720, height: 900 });
  await until(async () => (await width()) === 360);
  await page.setViewportSize({ width: 1440, height: 900 });
  await until(async () => (await width()) === 448);
  await dragTo(page, 200);
  expect(await width()).toBe(256);
  await dragTo(page, 400);
  expect(await width()).toBe(400);
  expect((await logo.boundingBox())!.width).toBe(40);
  // Kept a moment after the drag is over.
  await until(() => page.evaluate(() => localStorage.getItem("side-width") === "400"));
  await page.reload();
  await side.waitFor();
  expect(await width()).toBe(400);
  await page.setViewportSize({ width: 1600, height: 900 });
  expect(await width()).toBe(400);
  expect((await chat.boundingBox())!.width).toBe(1200);
  await page.getByRole("separator").dblclick();
  expect(await width()).toBe(288);
  // By the arrow keys too, the line focused.
  await page.getByRole("separator").focus();
  await page.keyboard.press("ArrowRight");
  expect(await width()).toBe(304);
  // Narrower than a wide screen, a medium one's maximize mode, the sidebar as it was.
  await page.setViewportSize({ width: 900, height: 900 });
  expect(await width()).toBe(304);
  await page.setViewportSize({ width: 1440, height: 900 });
  expect(await width()).toBe(304);
  await page.context().close();
});

smoke("stories 517, 518: a medium screen opens a slot's chat in maximize mode, the sidebar collapsed, 全屏 in ⋯; its 拓扑图 is a phone's; 缩小 goes back to the list, the row flashing, a step back right after it opened from there, the jump box's or the +'s too, or to the topology on the slot open last; 900×412 is a phone", async () => {
  const page = await open("", undefined, { viewport: { width: 720, height: 680 } } as (typeof devices)[string]);
  const hash = () => new URL(page.url()).hash;
  // The list's last row, out of sight once the list is back at its top.
  await page.locator(`a[href="#/slot/${finished}"]`).waitFor();
  const href = (await page.locator('main a[href^="#/slot/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!))).at(-1)!;
  const row = page.locator(`main a[href="${href}"]`);
  await row.click();
  await page.getByRole("button", { name: /^展开侧栏/ }).waitFor();
  expect(hash()).toBe(href);
  expect(await page.getByRole("button", { name: "放大" }).count()).toBe(0);
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "全屏" }).waitFor();
  await page.keyboard.press("Escape");
  // The topology on the slot, a step of its own; its 打开槽位 back.
  await page.getByRole("button", { name: "拓扑图" }).click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("button", { name: "缩小" }).click();
  await until(() => row.evaluate((e) => e.getAnimations().length > 0));
  const box = (await row.boundingBox())!;
  expect(box.y >= 0 && box.y + box.height <= 680).toBe(true);
  // Back a step, to the page as it loaded.
  expect(hash()).toBe("");
  // So too from the jump box, opened on the home.
  await page.keyboard.press("Control+K");
  await page.getByRole("dialog", { name: "跳转" }).waitFor();
  await page.keyboard.press("Enter");
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "缩小" }).waitFor({ state: "detached" });
  expect(hash()).toBe("");
  // And from what the home's + makes.
  answer = async () => ({ ok: true, text: "已建槽位 w/s", slot: rests });
  try {
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "新建槽位" }).click();
    await page.getByRole("dialog").getByRole("textbox", { name: "槽位名" }).fill("s");
    await page.getByRole("dialog").getByRole("button", { name: "新建" }).click();
    await page.getByRole("button", { name: "缩小" }).click();
    await page.getByRole("button", { name: "缩小" }).waitFor({ state: "detached" });
    expect(hash()).toBe("");
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }

  await page.getByRole("button", { name: "拓扑图" }).click();
  await node(page, "ws", "w").click();
  await node(page, "slot", "finished").click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("button", { name: /^展开侧栏/ }).click();
  expect(hash()).toBe(`#/topology/slot/${finished}?chat`);
  await page.locator(`a[href="#/topology/slot/${rests}?chat&full"]`).click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  await page.getByRole("button", { name: "缩小" }).click();
  await sheetOf(page).getByRole("heading", { name: "w/rests" }).waitFor();
  expect(hash()).toBe(`#/topology/slot/${rests}`);

  await page.setViewportSize({ width: 900, height: 412 });
  await page.goto(`http://127.0.0.1:${server!.port}/#/slot/${finished}`);
  await page.getByRole("link", { name: "全部槽位" }).waitFor();
  expect(await page.getByRole("button", { name: "缩小" }).count()).toBe(0);
  await page.context().close();
});

smoke("story 209: the split's line, moved by the arrow keys after the window widened, moves from where it is", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide());
  await page.getByRole("log", { name: "对话" }).waitFor();
  await page.setViewportSize({ width: 1600, height: 900 });
  const line = page.getByRole("separator");
  await line.focus();
  await page.keyboard.press("ArrowRight");
  // The left side's edge, where the line is.
  expect(await line.evaluate((e) => e.previousElementSibling!.getBoundingClientRect().right)).toBeCloseTo(1600 * 0.4 + 16, 0);
  await page.context().close();
});

smoke("story 430: on a wide touch screen a finger drags the line, the page not taking it as a scroll", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, { ...wide(), hasTouch: true });
  const side = page.getByRole("navigation", { name: "槽位" });
  await side.waitFor();
  const at = (await page.getByRole("separator").boundingBox())!;
  const y = at.y + at.height / 2;
  const cdp = await page.context().newCDPSession(page);
  const touch = (type: "touchStart" | "touchMove" | "touchEnd", x?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: x === undefined ? [] : [{ x, y }] });
  await touch("touchStart", 288);
  for (let x = 300; x <= 408; x += 12) await touch("touchMove", x);
  await touch("touchEnd");
  expect((await side.boundingBox())!.width).toBe(408);
  await page.context().close();
});

/** Whether the page kept Ctrl+B from the browser, pressed where you type. */
async function taken(page: Page) {
  await page.getByRole("textbox", { name: "消息" }).focus();
  await page.evaluate(() => addEventListener("keydown", (e: KeyboardEvent) => e.key === "b" && ((window as { taken?: boolean } & Window).taken = e.defaultPrevented)));
  await page.keyboard.press("Control+b");
  return page.evaluate(() => (window as { taken?: boolean } & Window).taken);
}

smoke("stories 431, 445: 收起侧栏 slides the sidebar out whole, its rows and line drawn till it is gone, then out of Tab's way, the chat from the page's edge; no step, kept on reload; Ctrl+B, where you type too, expands it, the focus kept, and collapses it, the focus in it going where you type", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const chat = page.getByRole("log", { name: "对话" });
  const line = page.getByRole("separator");
  const box = page.getByRole("textbox", { name: "消息" });
  const row = page.locator(`a[href="#/slot/${rests}?full"]`);
  const focused = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName);
  await side.waitFor();
  const steps = await page.evaluate(() => history.length);
  const at = (await row.boundingBox())!;
  // Slowed tenfold, the slide is caught halfway.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Animation.enable");
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 0.1 });
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await until(async () => (await chat.boundingBox())!.x < 200);
  expect([(await chat.boundingBox())!.x > 0, await row.isVisible(), await line.isVisible()]).toEqual([true, true, true]);
  const halfway = (await row.boundingBox())!;
  expect([halfway.x < at.x, halfway.width]).toEqual([true, at.width]);
  await side.waitFor({ state: "hidden" });
  await cdp.send("Animation.setPlaybackRate", { playbackRate: 1 });
  expect(await chat.boundingBox()).toMatchObject({ x: 0, width: 1440 });
  expect(await line.isVisible()).toBe(false);
  // Shift+Tab from the button, the first thing in the chat, goes into neither the sidebar nor the line.
  expect(await focused()).toMatch(/^展开侧栏/);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => !!document.activeElement?.closest('nav, [role="separator"]'))).toBe(false);
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}?full`);
  expect(await page.evaluate(() => history.length)).toBe(steps);
  await page.reload();
  await page.getByRole("button", { name: /^展开侧栏/ }).waitFor();
  expect((await chat.boundingBox())!.x).toBe(0);

  expect(await taken(page)).toBe(true);
  await side.waitFor();
  await until(async () => (await chat.boundingBox())!.x === 288);
  expect(await focused()).toBe("消息");
  await row.focus();
  await page.keyboard.press("Control+b");
  await side.waitFor({ state: "hidden" });
  expect(await focused()).toBe("消息");
  // Ctrl+B is the sidebar's alone: the chat stays.
  await Bun.sleep(200);
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}?full`);
  await page.context().close();
});

smoke("story 445: Ctrl+B with the focus on the line collapses the sidebar, the focus going where you type; with a sheet from the sidebar open, Ctrl+B is the sheet's, its Esc giving the focus back to what opened it", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const make = side.getByRole("button", { name: "新建槽位" });
  await side.waitFor();
  await make.click();
  await page.getByRole("dialog").waitFor();
  await page.keyboard.press("Control+b");
  await page.keyboard.press("Escape");
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  expect(await page.getByRole("button", { name: "收起侧栏" }).isVisible()).toBe(true);
  expect(await make.evaluate((e) => e === document.activeElement)).toBe(true);

  await page.getByRole("separator").focus();
  await page.keyboard.press("Control+b");
  await side.waitFor({ state: "hidden" });
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("消息");
  await page.context().close();
});

smoke("story 445: dragged past half its least the sidebar collapses, the focus in nothing going where you type; expanded, it is as wide as before the drag", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const chat = page.getByRole("log", { name: "对话" });
  await side.waitFor();
  await dragTo(page, 300);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await dragTo(page, 100);
  await side.waitFor({ state: "hidden" });
  expect((await chat.boundingBox())!.x).toBe(0);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("消息");
  await page.getByRole("button", { name: /^展开侧栏/ }).click();
  await until(async () => (await chat.boundingBox())!.x === 300);
  expect((await side.boundingBox())!.width).toBe(300);
  await page.context().close();
});

smoke("stories 431, 432: at 1180px maximize mode starts with the sidebar collapsed, Ctrl+B the browser's in the split; collapsed, 展开侧栏 has an amber dot while a slot but this one needs you; expanded, it stays so on reload", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide(1180));
  const chat = page.getByRole("log", { name: "对话" });
  const side = page.getByRole("navigation", { name: "槽位" });
  await chat.waitFor();
  expect(await taken(page)).toBe(false);
  await page.getByRole("button", { name: "放大" }).click();
  await page.getByRole("button", { name: "展开侧栏，有需要你的" }).waitFor();
  expect(await chat.boundingBox()).toMatchObject({ x: 0, width: 1180 });
  const dot = page.getByRole("button", { name: "展开侧栏，有需要你的" }).locator("span > span");
  const icon = (await page.getByRole("button", { name: /^展开侧栏/ }).locator("svg").boundingBox())!;
  const d = (await dot.boundingBox())!;
  // At the top right, clear of the icon's lines, which start 2px into its box.
  expect(d.x >= icon.x + icon.width - 2 || d.y + d.height <= icon.y + 2).toBe(true);
  // The one that needs you open, it is in sight: no dot.
  await page.goto(`http://127.0.0.1:${server!.port}/#/slot/${asking}?full`);
  await page.getByRole("heading", { name: "w/asks" }).waitFor();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).waitFor();
  await page.getByRole("button", { name: "展开侧栏", exact: true }).click();
  await side.waitFor();
  await page.reload();
  await side.waitFor();
  await page.getByRole("button", { name: "收起侧栏" }).waitFor();
  await page.context().close();
});

smoke("stories 418, 419: 缩小 lands on the slot opened last, the focus kept: the list's row marked, in sight and flashing, or the topology on it; right after 放大 it is back", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide());
  const hash = () => new URL(page.url()).hash;
  const steps = () => page.evaluate(() => history.length);
  await page.getByRole("button", { name: "放大" }).click();
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "放大" }).waitFor();
  expect(hash()).toBe(`#/slot/${finished}`);
  await page.goForward();
  await page.getByRole("button", { name: "缩小" }).waitFor();
  // Another slot from the sidebar, a step of its own; 缩小 then takes its place.
  const n = await steps();
  await page.locator(`a[href="#/slot/${rests}?full"]`).click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  expect(hash()).toBe(`#/slot/${rests}?full`);
  expect(await steps()).toBe(n + 1);
  await page.getByRole("button", { name: "缩小" }).click();
  await page.getByRole("button", { name: "放大" }).waitFor();
  expect(hash()).toBe(`#/slot/${rests}`);
  expect(await steps()).toBe(n + 1);
  const row = page.locator(`a[href="#/slot/${rests}"]`);
  expect(await row.getAttribute("aria-current")).toBe("page");
  await until(() => row.evaluate((e) => e.getAnimations().length > 0));
  const box = (await row.boundingBox())!;
  expect(box.y >= 0 && box.y + box.height <= 900).toBe(true);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("放大");

  // From beside the topology, the topology on it.
  await page.goto(`http://127.0.0.1:${server!.port}/#/topology/slot/${finished}?chat`);
  await page.locator(".react-flow").waitFor();
  await page.getByRole("button", { name: "放大" }).click();
  expect(hash()).toBe(`#/topology/slot/${finished}?chat&full`);
  await page.locator(`a[href="#/topology/slot/${rests}?chat&full"]`).click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  await page.getByRole("button", { name: "缩小" }).click();
  await page.locator(".react-flow").waitFor();
  expect(hash()).toBe(`#/topology/slot/${rests}?chat`);
  await until(async () => {
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const slot = (await node(page, "slot", "rests").boundingBox())!;
    return slot.x >= pane.x && slot.x + slot.width <= pane.x + pane.width && slot.y >= pane.y && slot.y + slot.height <= pane.y + pane.height;
  });
  await page.context().close();
});

smoke("stories 427, 428: the sidebar comes at its top, scrolled only as far as the open row needs to show; one clicked opens with the sidebar still", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const top = () => side.evaluate((e) => e.parentElement!.scrollTop);
  await side.waitFor();
  expect(await top()).toBe(0);
  const last = side.locator("a").last();
  await page.goto(`http://127.0.0.1:${server!.port}/${await last.getAttribute("href")}`);
  await page.reload();
  await until(async () => (await last.getAttribute("aria-current")) === "page" && (await top()) > 0);
  const box = (await last.boundingBox())!;
  // At the list's bottom, over the settings' gear (#491).
  const bottom = await side.evaluate((e) => e.parentElement!.getBoundingClientRect().bottom);
  expect(box.y + box.height).toBeLessThanOrEqual(bottom);
  expect(box.y + box.height).toBeGreaterThan(bottom - 50);
  const at = await top();
  const other = side.locator("a").nth(-3);
  await other.click();
  await until(async () => (await other.getAttribute("aria-current")) === "page");
  expect(await top()).toBe(at);
  await page.context().close();
});

/** A board for the sidebar: x/ask, which needs you, then workspaces a to f of n slots each, and 20
 *  archived. */
function sideBoard(n: number, names = ["a", "b", "c", "d", "e", "f"]) {
  const named = (ws: string, name: string, more = {}) => ({ id: `${ws}/${name}`, ref: `${ws}/${name}`, name, parent: null, agent: "claude", state: "空闲", lifetime: "longterm", turnEndedAt: null, archivedAt: null, activeAt: 0, pinnedAt: null, last: { role: "assistant", text: "好的", at: null }, bots: [], ...more });
  const groups = (idle: unknown[], needsYou: unknown[] = []) => ({ needsYou, running: [], done: [], idle });
  return {
    workspaces: [
      { name: "x", dir: "/x", groups: groups([], [named("x", "ask", { state: "需要你" })]), archived: Array.from({ length: 20 }, (_, i) => named("x", `old${i}`, { archivedAt: Date.now() - i })) },
      ...names.map((ws) => ({ name: ws, dir: `/${ws}`, groups: groups(Array.from({ length: n }, (_, i) => named(ws, `s${i}`))), archived: [] })),
    ],
    bots: [],
  };
}

/** Maximize mode's sidebar at 1440 by height, on board if given, else the store's, the workspaces in
 *  folded folded on this device, on a touch screen if hasTouch: its buttons on top, and ways to scroll it
 *  and see where things are in it. */
async function sidebar(board?: ReturnType<typeof sideBoard>, height = 900, folded: string[] = [], hasTouch = false) {
  const page = await open(
    `/slot/${finished}?full`,
    board &&
      (async (p) => {
        await p.addInitScript((ns) => ns.forEach((n) => localStorage.setItem(`folded:${n}`, "1")), folded);
        await p.route("**/api/board", (r) => r.fulfill({ json: board }));
      }),
    { viewport: { width: 1440, height }, hasTouch } as (typeof devices)[string],
  );
  const side = page.getByRole("navigation", { name: "槽位" });
  await side.locator("a").first().waitFor();
  const buttons = ["新建槽位", "跳转", "导入"].map((name) => side.getByRole("button", { name, exact: true })) as [Locator, Locator, Locator];
  const head = buttons[0].locator("..");
  /** The head's bottom and height, and whether its buttons are in one row. */
  const shape = async () => {
    const box = (await head.boundingBox())!;
    const ys = await Promise.all(buttons.map(async (b) => (await b.boundingBox())!.y));
    return { row: new Set(ys).size === 1, height: box.height, bottom: box.y + box.height };
  };
  return {
    page,
    side,
    buttons,
    shape,
    /** Waits for the buttons to settle in a row of icons, or as three with their names. */
    settled: (row: boolean) => until(async () => (await shape()).row === row && (await shape()).height === (row ? 57 : 128)),
    top: () => side.evaluate((e) => e.parentElement!.scrollTop),
    scroll: (y: number) => side.evaluate((e, y) => e.parentElement!.scrollTo(0, y), y),
    /** Workspace or fold name's tab. */
    tab: (name: string) => side.getByRole("button", { name: new RegExp(`^${name}(\\s*\\d+)?$`) }),
    /** How far down the list fold name begins. */
    at: (name: string) => side.getByRole("button", { name: new RegExp(`^${name}(\\s*\\d+)?$`) }).evaluate((t) => t.closest("[data-slot=collapsible]")!.getBoundingClientRect().top + t.closest("nav")!.parentElement!.scrollTop),
    /** Whether row href shows whole, covered by neither the buttons nor a stuck tab. */
    clear: (href: string) =>
      side.locator(`a[href="${href}"]`).evaluate((a) => {
        const r = a.getBoundingClientRect();
        return [r.top + 2, r.bottom - 2].every((y) => a.contains(document.elementFromPoint(r.left + 40, y)));
      }),
  };
}

smoke("stories 425, 429: scrolled past a little, the sidebar's buttons shrink to a row of three icons, as tall as the chat's top bar, no row moving, and grow back only at the top; what needs you scrolled out of sight, 需要你 at the end of their first row goes back up; its scroll bar only under the pointer", async () => {
  const { page, side, buttons, shape, settled, top, scroll } = await sidebar();
  const [made, jump, imp] = buttons;
  /** Where each row is in the list, the scroll taken off. */
  const rows = () => side.evaluate((e) => [...e.querySelectorAll("a")].map((a) => Math.round(a.getBoundingClientRect().top + e.parentElement!.scrollTop)));
  const up = side.getByRole("button", { name: "需要你" });
  const bar = () => side.evaluate((e) => getComputedStyle(e.parentElement!, "::-webkit-scrollbar-thumb").backgroundColor);
  await page.mouse.move(1000, 450);
  expect(await bar()).toBe("rgba(0, 0, 0, 0)");
  await page.mouse.move(100, 450);
  expect(await bar()).not.toBe("rgba(0, 0, 0, 0)");
  // The board's thin round bar with no arrows, the chat's too (#630).
  expect(await page.getByRole("log", { name: "对话" }).evaluate((e) => getComputedStyle(e).scrollbarWidth)).toBe("auto");

  await settled(false);
  const was = await rows();
  expect(await up.count()).toBe(0);
  await jump.focus();
  await scroll(40);
  await page.waitForTimeout(400);
  expect((await shape()).row).toBe(false);
  // What needs you gone under them, the buttons still with their names: 需要你 at the end of the first.
  await scroll(80);
  await up.waitFor();
  const [u, m] = [(await up.boundingBox())!, (await made.boundingBox())!];
  expect(u.y >= m.y && u.y + u.height <= m.y + m.height && u.x > m.x + 100).toBe(true);
  expect((await shape()).row).toBe(false);

  await scroll(100);
  await settled(true);
  const bar57 = (await page.locator("header").filter({ has: page.getByRole("heading", { name: "w/finished" }) }).boundingBox())!;
  expect((await shape()).bottom).toBe(bar57.y + bar57.height);
  expect(await rows()).toEqual(was);
  // Still the three, by name, their names on hover; the focus where it was.
  expect(await Promise.all([made, jump, imp].map((b) => b.getAttribute("title")))).toEqual(["新建槽位", "跳转 Ctrl+K", "导入"]);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("跳转");
  // Further down, what needs you all gone under them: 需要你 right of the icons, over no row.
  await scroll(300);
  const [u2, i2] = [(await up.boundingBox())!, (await imp.boundingBox())!];
  expect(u2.x > i2.x + i2.width && u2.y + u2.height <= (await shape()).bottom).toBe(true);

  await scroll(40);
  await page.waitForTimeout(400);
  expect((await shape()).row).toBe(true);
  await scroll(0);
  await settled(false);
  expect(await rows()).toEqual(was);
  expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("跳转");
  await scroll(300);
  await settled(true);
  await up.click();
  await until(async () => (await top()) === 0);
  // The focus with what needs you, its first row.
  expect(await side.evaluate((e) => document.activeElement === e.querySelector("a") && document.activeElement!.textContent!.includes("需要你"))).toBe(true);
  await settled(false);
  await up.waitFor({ state: "detached" });
  await page.context().close();
});

smoke("#645: the line under the sidebar's buttons runs on under its list's bar to the chat's top bar's, the bar starts under them, the line down between them runs beside the top bar, and leaves the bar's thumb whole", async () => {
  // Bars drawn as Chrome draws them on Windows or Linux, which playwright hides.
  const drawn = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"], handleSIGTERM: false });
  onTestFinished(() => drawn.close());
  const page = await drawn.newPage({ viewport: { width: 1440, height: 900 }, extraHTTPHeaders: { "Tailscale-User-Login": BOARD_LOGIN } });
  page.setDefaultTimeout(5_000);
  await page.goto(`http://127.0.0.1:${server!.port}/#/slot/${finished}?full`);
  const made = page.getByRole("button", { name: "新建槽位", exact: true });
  await page.getByRole("navigation", { name: "槽位" }).locator("a").first().waitFor();
  const chat = (await page.locator("header").filter({ has: page.getByRole("heading", { name: "w/finished" }) }).boundingBox())!.x;
  /** The list's bar, how tall the buttons on top are, and how far right of the chat's line and below
   *  their bottom the line drawn across the sidebar and the bar's track reach. */
  const at = () =>
    made.evaluate((b, chat) => {
      const list = b.closest("nav")!.parentElement!;
      const [head, line] = [b.parentElement!.getBoundingClientRect(), list.previousElementSibling!.getBoundingClientRect()];
      const track = parseFloat(getComputedStyle(list, "::-webkit-scrollbar-track").marginTop) + list.getBoundingClientRect().top;
      return { bar: list.offsetWidth - list.clientWidth, head: head.height, line: [line.right - chat, line.bottom - head.bottom], track: track - head.bottom };
    }, chat);
  await settles(at, { bar: 10, head: 128, line: [0, 0], track: 0 });
  // A press on the bar's thumb where it is drawn furthest right, 3px in from the edge, drags it, not
  // the line beside it.
  await page.mouse.move(chat - 4, 133);
  await page.mouse.down();
  await page.mouse.move(chat - 4, 233, { steps: 5 });
  await page.mouse.up();
  expect(await made.evaluate((b) => b.closest("nav")!.parentElement!.scrollTop)).toBeGreaterThan(0);
  await made.evaluate((b) => b.closest("nav")!.parentElement!.scrollTo(0, 300));
  await settles(at, { bar: 10, head: 57, line: [0, 0], track: 0 });
  /** The line's red as drawn under the buttons, under the list's bar, and under the chat's top bar;
   *  and the one between the sidebar and the chat's, beside the top bar and below it. */
  const inks = async () => {
    const src = `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
    return made.evaluate(
      async (b, [chat, src]) => {
        const img = Object.assign(new Image(), { src });
        await img.decode();
        const g = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
        g.drawImage(img, 0, 0);
        const red = (x: number, y: number) => g.getImageData(x, y, 1, 1).data[0]!;
        const y = Math.floor(b.parentElement!.getBoundingClientRect().bottom - 1);
        const x = Math.floor(document.querySelector('[role="separator"] > div')!.getBoundingClientRect().left + 0.5);
        return { across: [chat - 40, chat - 5, chat + 40].map((x) => red(x, y)), down: [20, 400].map((y) => red(x, y)) };
      },
      [chat, src] as const,
    );
  };
  // One line across the seam, light and dark, though the sidebar's ground is not the chat's; and one
  // down it, whole beside the chat's top bar too.
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const red of Object.values(await inks())) expect(Math.max(...red) - Math.min(...red), `${scheme} ${red}`).toBeLessThanOrEqual(1);
  }
});

smoke("#645: the wheel on the sidebar's buttons on top, and the keys with the focus on one, scroll its list", async () => {
  const { page, buttons, settled, top, scroll } = await sidebar(sideBoard(10));
  const [made, jump] = buttons;
  await page.mouse.move(250, 30);
  await page.mouse.wheel(0, 300);
  await until(async () => (await top()) === 300);
  await settled(true);
  await page.mouse.wheel(0, -200);
  await until(async () => (await top()) === 100);
  await scroll(0);
  await made.focus();
  await page.keyboard.press("PageDown");
  await until(async () => (await top()) > 300);
  await jump.focus();
  await page.keyboard.press("End");
  const end = await made.evaluate((b) => b.closest("nav")!.parentElement!.scrollHeight - b.closest("nav")!.parentElement!.clientHeight);
  await until(async () => (await top()) === end);
  await page.keyboard.press("ArrowUp");
  await until(async () => (await top()) < end);
  await page.context().close();
});

smoke("#650: the split's grip is its line's colour at rest, hovered and focused, light and dark, the line not showing through it, and the focus line is centred on the line", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide());
  await page.getByRole("log", { name: "对话" }).waitFor();
  const line = page.getByRole("separator");
  /** The reds 2px each side of the line's middle: through the grip's middle, and 100px below it. */
  const reds = async () => {
    await line.evaluate((s) => Promise.all(s.getAnimations({ subtree: true }).map((a) => a.finished)));
    const src = `data:image/png;base64,${(await page.screenshot()).toString("base64")}`;
    return line.evaluate(async (s, src) => {
      const img = Object.assign(new Image(), { src });
      await img.decode();
      const g = Object.assign(document.createElement("canvas"), { width: img.width, height: img.height }).getContext("2d")!;
      g.drawImage(img, 0, 0);
      const [l, grip] = [s.firstElementChild!.getBoundingClientRect(), s.lastElementChild!.getBoundingClientRect()];
      const x = Math.floor(l.left + l.width / 2);
      const row = (y: number) => [-2, -1, 0, 1, 2].map((d) => g.getImageData(x + d, Math.floor(y), 1, 1).data[0]!);
      return [row(grip.top + grip.height / 2), row(grip.bottom + 100)] as const;
    }, src);
  };
  const box = (await line.boundingBox())!;
  for (const scheme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    for (const state of ["rest", "hover", "focus"] as const) {
      await page.mouse.move(state === "hover" ? box.x + box.width / 2 : 900, 800);
      if (state === "focus") (await line.focus(), await page.keyboard.press("Shift"));
      const [grip, below] = await reds();
      const off = (a: number[], b: number[]) => Math.max(...a.map((c, i) => Math.abs(c - b[i]!)));
      expect(off(grip, grip.map(() => below[2]!)), `${scheme} ${state} grip ${grip} line ${below}`).toBeLessThanOrEqual(1);
      expect(off(below, below.toReversed()), `${scheme} ${state} line ${below}`).toBeLessThanOrEqual(1);
      if (state === "focus") await line.blur();
    }
  }
  await page.context().close();
});

smoke("story 425: a list a little taller than the sidebar gets room at its end to scroll far enough for the buttons to shrink; one of 5 slots, which does not scroll, keeps them with their names", async () => {
  const five = sideBoard(5, ["a"]);
  five.workspaces[0]!.groups.needsYou = [];
  five.workspaces[0]!.archived = [];
  const { page, side, settled, top, scroll } = await sidebar(five);
  await scroll(200);
  await page.waitForTimeout(400);
  expect(await top()).toBe(0);
  await settled(false);
  // As tall as the list less 30px: it scrolls 30px and the room at its end.
  const tall = await side.evaluate((e) => e.getBoundingClientRect().height);
  await page.setViewportSize({ width: 1440, height: Math.floor(tall) - 30 });
  await until(async () => (await side.evaluate((e) => e.parentElement!.scrollHeight - e.parentElement!.clientHeight)) === 88);
  await scroll(1000);
  await settled(true);
  await page.context().close();
});

smoke("story 531: shrunk to a row, the sidebar's buttons grow back over the rows while the mouse rests on its blank, and shrink a second after it leaves; on a touch screen a tap there grows them, one more at the same spot shrinks them", async () => {
  for (const touch of [false, true]) {
    const { page, side, buttons, shape, settled, scroll } = await sidebar(sideBoard(10), 900, [], touch);
    await scroll(300);
    await settled(true);
    const rows = () => side.evaluate((e) => [...e.querySelectorAll("a")].map((a) => a.getBoundingClientRect().top));
    const was = await rows();
    // Under the icons is no blank: grown, 跳转 would be there.
    const jump = (await buttons[1].boundingBox())!;
    if (touch) await page.touchscreen.tap(jump.x + 10, jump.y + jump.height + 5);
    else await page.mouse.move(jump.x + 10, jump.y + jump.height + 5);
    await page.waitForTimeout(500);
    expect((await shape()).height).toBe(57);
    // Right of the icons, left of 需要你.
    const imp = (await buttons[2].boundingBox())!;
    const [x, y] = [imp.x + imp.width + 30, imp.y + imp.height / 2];
    if (touch) await page.touchscreen.tap(x, y);
    else await page.mouse.move(x, y);
    await settled(false);
    expect(await rows()).toEqual(was);
    if (touch) {
      await page.touchscreen.tap(x, y);
      await settled(true);
      expect(await page.getByRole("dialog").count()).toBe(0);
    } else {
      await page.mouse.move(1000, 450);
      await page.waitForTimeout(600);
      expect((await shape()).height).toBe(128);
      await settled(true);
    }
    await page.context().close();
  }
});

smoke("story 426: scrolled into a workspace, its tab sticks under the buttons as they are now, its ground the sidebar's, till the next one's pushes it off; one tapped there folds and stays where it is", async () => {
  const { page, side, shape, settled, scroll, tab, at } = await sidebar(sideBoard(10));
  await scroll((await at("b")) - 57 + 40);
  await settled(true);
  const y = async (name: string) => (await tab(name).boundingBox())!.y;
  await until(async () => Math.abs((await y("b")) - (await shape()).bottom) < 1);
  expect(await tab("b").evaluate((t) => getComputedStyle(t.parentElement!).backgroundColor)).toBe(await side.evaluate((e) => getComputedStyle(e.closest(".bg-sidebar")!).backgroundColor));
  await scroll((await at("c")) - 57 + 40);
  await until(async () => Math.abs((await y("c")) - (await shape()).bottom) < 1);
  expect((await y("b")) + 32).toBeLessThanOrEqual((await shape()).bottom);
  // Tapped where it sticks, it folds, staying there, the next workspace right under it.
  const was = await y("c");
  // By the pointer where it is: playwright's click would first scroll it to where it would be unstuck.
  await page.mouse.click(300 / 2, was + 16);
  expect(await tab("c").getAttribute("aria-expanded")).toBe("false");
  expect(Math.abs((await y("c")) - was)).toBeLessThan(1);
  const gap = (await y("d")) - (was + 32);
  expect(gap >= 0 && gap <= 10).toBe(true);
  // The archived, open, sticks as a workspace does.
  await tab("已归档").click();
  await scroll((await at("已归档")) - 57 + 10);
  await until(async () => Math.abs((await y("已归档")) - (await shape()).bottom) < 1);
  await page.context().close();
});

smoke("rows paged to by PageDown, space and PageUp, or scrolled to as another slot opens, as by Alt+↑↓ or the jump box, show clear of the buttons on top and a stuck tab", async () => {
  const { page, side, shape, settled, scroll, clear, top } = await sidebar(sideBoard(10));
  /** The rows that show whole, top to bottom. */
  const whole = async () => {
    const out: string[] = [];
    for (const href of await side.locator("a").evaluateAll((as) => as.map((a) => a.getAttribute("href")!))) if (await clear(href)) out.push(href);
    return out;
  };
  await scroll(500);
  await settled(true);
  await side.locator(`a[href="${(await whole())[0]}"]`).focus();
  for (const key of ["PageDown", "Space"]) {
    const last = (await whole()).at(-1)!;
    const before = await top();
    await page.keyboard.press(key);
    await until(async () => (await top()) > before + 100);
    await page.waitForTimeout(300);
    expect([key, await clear(last)]).toEqual([key, true]);
  }
  const first = (await whole())[0]!;
  const before = await top();
  await page.keyboard.press("PageUp");
  await until(async () => (await top()) < before - 100);
  await page.waitForTimeout(300);
  expect(await clear(first)).toBe(true);

  // Another slot opens: its row, out of sight above, is scrolled to only as far as it shows whole:
  // right under the tab stuck under the buttons; one under no tab, as what needs you, right under them.
  for (const [id, tab] of [["b/s0", 32], ["x/ask", 0]] as const) {
    await scroll(3000);
    await page.evaluate((id) => (location.hash = `#/slot/${encodeURIComponent(id)}?full`), id);
    const row = side.locator(`a[href="#/slot/${encodeURIComponent(id)}?full"]`);
    await until(async () => (await row.getAttribute("aria-current")) === "page");
    await page.waitForTimeout(300);
    expect([id, Math.round((await row.boundingBox())!.y - (await shape()).bottom)]).toEqual([id, tab]);
  }
  await page.context().close();
});

smoke("a page of folded workspaces only, with no row to page to, PageDown, space and PageUp page as the browser does, on to the list's end", async () => {
  const names = Array.from({ length: 40 }, (_, i) => `f${i}`);
  const { page, side, top } = await sidebar(sideBoard(3, ["a", ...names]), 900, names);
  const end = await side.evaluate((e) => e.parentElement!.scrollHeight - e.parentElement!.clientHeight);
  expect(end).toBeGreaterThan(1000);
  await side.locator(`a[href="#/slot/${encodeURIComponent("a/s0")}?full"]`).focus();
  for (const [key, want] of [["PageDown", end], ["PageUp", 0], ["Space", end]] as const) {
    for (let i = 0; i < 8; i++) await page.keyboard.press(key);
    await until(async () => (await top()) === want);
  }
  await page.context().close();
});

smoke("stories 434-436, 442: on a wide screen the list's rows stay put while the mouse is on it, each as it is now, one new coming once it leaves, Alt+↑↓ going by them; folded, a workspace has a blue dot for one running and the open slot's row, in the list and the sidebar", async () => {
  const [h, h1, h2, h3] = store.tx((tx) => {
    const h = tx.insert("workspace", { name: "h", dir: "/h" }).id;
    const slot = (name: string) => tx.insert("slot", { workspace: h, name, dir: "/h", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    return [h, slot("h1"), slot("h2"), slot("h3")];
  });
  try {
    const page = await open(`/slot/${h2}`, undefined, wide());
    // h's rows top to bottom, each by its name and state: what follows its logo.
    const rows = () => page.locator('a[href^="#/slot/"]').evaluateAll((as) => as.map((a) => [...a.children].slice(1).map((e) => e.textContent).join("")).filter((t) => /^h\d/.test(t)));
    await page.getByRole("log", { name: "对话" }).waitFor();
    await until(async () => (await rows()).length === 3);
    expect(await rows()).toEqual(["h1", "h2", "h3"]);
    await page.mouse.move(100, 400);
    // h3 runs and h4 is new, in one go: as h3 says 运行中, the page has h4 too.
    store.tx((tx) => {
      tx.update("slot", { workspace: h, name: "h3" }, { state: "running" });
      tx.insert("slot", { workspace: h, name: "h4", dir: "/h", mode: "headless", state: "idle", lifetime: "longterm" });
      tx.append({ source: "board", type: "board_act" });
    });
    await until(async () => (await rows()).includes("h3运行中"));
    expect(await rows()).toEqual(["h1", "h2", "h3运行中"]);
    // Alt+↑↓ goes by the rows as they stand (story 442): below h2 is h3, not h4.
    const hash = () => new URL(page.url()).hash;
    await page.keyboard.press("Alt+ArrowDown");
    await until(() => hash() !== `#/slot/${h2}`);
    expect(hash()).toBe(`#/slot/${h3}`);
    expect(await rows()).toEqual(["h1", "h2", "h3运行中"]);
    await page.keyboard.press("Alt+ArrowUp");
    await until(() => hash() === `#/slot/${h2}`);
    await page.mouse.move(1000, 400);
    await until(async () => (await rows()).length === 4);
    expect(await rows()).toEqual(["h3运行中", "h1", "h2", "h4"]);

    // Folded, a blue dot for h3 and h2's row, the slot open.
    await page.getByRole("button", { name: "h", exact: true }).click();
    await page.getByRole("button", { name: /^h\s*有在运行的\s*4$/ }).waitFor();
    expect(await rows()).toEqual(["h2"]);
    expect(await page.locator(`a[href="#/slot/${h2}"]`).getAttribute("aria-current")).toBe("page");
    // So too in the sidebar, the fold kept on this device.
    await page.getByRole("button", { name: "放大" }).click();
    const side = page.getByRole("navigation", { name: "槽位" });
    await side.getByRole("button", { name: /^h\s*有在运行的\s*4$/ }).waitFor();
    expect(await rows()).toEqual(["h2"]);
    expect(await side.locator(`a[href="#/slot/${h1}?full"]`).count()).toBe(0);
    expect(await side.locator(`a[href="#/slot/${h2}?full"]`).getAttribute("aria-current")).toBe("page");

    // The sidebar's rows stay put too while the mouse is on them.
    await side.getByRole("button", { name: /^h\s/ }).click();
    await until(async () => (await rows()).length === 4);
    await page.mouse.move(100, 400);
    store.tx((tx) => (tx.update("slot", { id: h1 }, { state: "running" }), tx.append({ source: "board", type: "board_act" })));
    await until(async () => (await rows()).includes("h1运行中"));
    expect(await rows()).toEqual(["h3运行中", "h1运行中", "h2", "h4"]);
    await page.mouse.move(1000, 400);
    await until(async () => (await rows())[0] === "h1运行中");
    await page.context().close();
  } finally {
    store.tx((tx) => (tx.delete("slot", { workspace: h }), tx.delete("workspace", { id: h }), tx.append({ source: "board", type: "board_act" })));
  }
});

smoke("#506: on a touch screen the list's rows stay put while a finger is on it, each as it is now, and go by the data 3 s after the last one lifts", async () => {
  const [h, h2] = store.tx((tx) => {
    const h = tx.insert("workspace", { name: "h", dir: "/h" }).id;
    const slot = (name: string, ago: number) => tx.insert("slot", { workspace: h, name, dir: "/h", mode: "headless", state: "idle", lifetime: "longterm", activeAt: Date.now() - ago }).id;
    slot("h1", 60_000);
    return [h, slot("h2", 120_000)];
  });
  try {
    const page = await open();
    const rows = () => page.locator('a[href^="#/slot/"]').evaluateAll((as) => as.map((a) => [...a.children].slice(1).map((e) => e.textContent).join("")).filter((t) => /^h\d/.test(t)));
    await until(async () => (await rows()).length === 2);
    expect(await rows()).toEqual(["h11分钟前", "h22分钟前"]);
    // A finger down on h1's row, and moved, as a scroll of the list: no tap.
    const h1 = page.getByText("h1", { exact: true });
    await h1.scrollIntoViewIfNeeded();
    const at = (await h1.boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", dy?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: dy === undefined ? [] : [{ x: at.x, y: at.y + dy }] });
    await touch("touchStart", 0);
    await touch("touchMove", 30);
    store.tx((tx) => (tx.update("slot", { id: h2 }, { state: "running", activeAt: Date.now() }), tx.append({ source: "board", type: "board_act" })));
    await until(async () => (await rows()).includes("h2运行中"));
    expect(await rows()).toEqual(["h11分钟前", "h2运行中"]);
    await touch("touchEnd");
    const lifted = Date.now();
    await until(async () => (await rows())[0] === "h2运行中", 6_000);
    expect(Date.now() - lifted).toBeGreaterThan(2_500);
    await page.context().close();
  } finally {
    store.tx((tx) => (tx.delete("slot", { workspace: h }), tx.delete("workspace", { id: h }), tx.append({ source: "board", type: "board_act" })));
  }
});

smoke("stories 424, 540: the sidebar's 新建槽位 and 导入 start in the open slot's workspace's directory; what it makes, or 导入 imports, opens in maximize mode from where it came", async () => {
  const z = folder("z");
  const [other, zs] = store.tx((tx) => {
    const other = tx.insert("workspace", { name: "z", dir: z }).id;
    return [other, tx.insert("slot", { workspace: other, name: "zs", dir: z, mode: "headless", state: "idle", lifetime: "longterm" }).id];
  });
  const argv = () => (acted.at(-1)!.act as { argv: string[] }).argv;
  const candidates = [{ label: "Herdr 里 ~/w", command: "/rh_import w1:p1 --name" }];
  answer = async () =>
    argv()[0] === "new" ? { ok: true, text: "已建槽位 z/s", slot: rests } : argv()[1] === "--dir" ? { ok: true, text: "导入哪一个？", panel: { head: ["导入哪一个？"], candidates } } : { ok: true, text: "已导入成 w/doc", slot: finished };
  try {
    const page = await open(`/topology/slot/${zs}?chat&full`, undefined, wide());
    const sheet = page.getByRole("dialog");
    await page.getByRole("button", { name: "新建槽位" }).click();
    await picker(sheet).ws("z").and(page.locator("[aria-pressed=true]")).waitFor();
    await until(async () => (await picker(sheet).path.inputValue()) === "~/z/");
    await sheet.getByRole("textbox", { name: "槽位名" }).fill("s");
    await sheet.getByRole("button", { name: "新建" }).click();
    expect(argv()).toEqual(["new", "z/s", "--agent", "claude"]);
    await page.waitForURL(`**/#/topology/slot/${rests}?chat&full`);
    // Back in z/zs, 导入 too.
    await page.goto(`http://127.0.0.1:${server!.port}/#/topology/slot/${zs}?chat&full`);
    await page.getByRole("navigation", { name: "槽位" }).getByRole("button", { name: "导入" }).click();
    await picker(sheet).ws("z").and(page.locator("[aria-pressed=true]")).waitFor();
    await sheet.getByRole("button", { name: "列出" }).click();
    await sheet.getByRole("radio", { name: "Herdr 里 ~/w" }).click();
    expect(argv()).toEqual(["import", "--dir", "~/z"]);
    await sheet.getByRole("button", { name: "导入" }).click();
    await page.waitForURL(`**/#/topology/slot/${finished}?chat&full`);
    await page.context().close();
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
    store.tx((tx) => (tx.delete("slot", { id: zs }), tx.delete("workspace", { id: other })));
  }
});

smoke("from the list, maximize mode's 拓扑图 puts the topology beside the chat, in place of the step; /rh_ls stays in maximize mode, the sidebar expanded and its row flashing (story 446)", async () => {
  const before = acted.length;
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const box = page.getByRole("textbox", { name: "消息" });
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.getByRole("navigation", { name: "槽位" }).waitFor({ state: "hidden" });
  await box.fill("/rh_ls");
  await page.getByRole("button", { name: "发送" }).click();
  const row = page.locator(`a[href="#/slot/${finished}?full"]`);
  await until(() => row.evaluate((e) => e.getAnimations().length > 0));
  await page.getByRole("navigation", { name: "槽位" }).waitFor();
  await page.getByRole("button", { name: "收起侧栏" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}?full`);
  expect(acted.length).toBe(before);

  const steps = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "拓扑图", exact: true }).click();
  await page.locator(".react-flow").waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}?chat`);
  expect(await page.evaluate(() => history.length)).toBe(steps);
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  await page.context().close();
});

smoke("stories 441, 443, 444: ⌘K opens the jump box over the chat, its code fetched only then; Enter goes back to the slot before, a step of its own, the caret where you type; typed, it finds a slot by name; Esc, ⌘K again or a tap off it close it, the caret back; not while an input method composes", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide());
  const fetched: string[] = [];
  page.on("request", (r) => void fetched.push(new URL(r.url()).pathname));
  const chat = page.getByRole("log", { name: "对话" });
  const box = page.getByRole("textbox", { name: "消息" });
  const jump = page.getByRole("dialog", { name: "跳转" });
  const typing = () => box.evaluate((b) => b === document.activeElement);
  const hash = () => new URL(page.url()).hash;
  await chat.waitFor();
  await until(typing);
  await page.locator(`a[href="#/slot/${rests}"]`).click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  await until(typing);
  await box.dispatchEvent("keydown", { key: "k", ctrlKey: true, isComposing: true, bubbles: true });
  await Bun.sleep(200);
  expect(await jump.count()).toBe(0);
  expect(fetched.filter((f) => f.includes("/assets/jump-"))).toEqual([]);

  const steps = await page.evaluate(() => history.length);
  await page.keyboard.press("Control+K");
  await jump.waitFor();
  expect(fetched.filter((f) => f.includes("/assets/jump-"))).toHaveLength(1);
  const [d, c] = [(await jump.boundingBox())!, (await chat.boundingBox())!];
  expect(d.x >= c.x && d.x + d.width <= c.x + c.width).toBe(true);
  expect(await jump.getByRole("option", { selected: true }).textContent()).toContain("w/finished");
  await page.keyboard.press("Enter");
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  await jump.waitFor({ state: "detached" });
  expect(hash()).toBe(`#/slot/${finished}`);
  expect(await page.evaluate(() => history.length)).toBe(steps + 1);
  await until(typing);

  await page.keyboard.press("Control+K");
  await jump.getByRole("combobox").fill("TALK");
  expect(await jump.getByRole("option", { selected: true }).textContent()).toContain("w/talks");
  await page.keyboard.press("Escape");
  await jump.waitFor({ state: "detached" });
  await until(typing);
  await page.keyboard.press("Control+K");
  await jump.waitFor();
  await page.keyboard.press("Control+K");
  await jump.waitFor({ state: "detached" });
  await page.keyboard.press("Control+K");
  await page.mouse.click(8, 890);
  await jump.waitFor({ state: "detached" });
  await until(typing);
  expect(hash()).toBe(`#/slot/${finished}`);
  await page.context().close();

  // A phone brings up no keyboard as a slot opens.
  const phone = await open(`/slot/${finished}`);
  await phone.getByRole("textbox", { name: "消息" }).waitFor();
  await Bun.sleep(200);
  expect(await phone.evaluate(() => document.activeElement?.tagName)).not.toBe("TEXTAREA");
  await phone.context().close();
});

smoke("stories 441, 442: from the home the jump box opens a slot beside the list, from the whole topology beside it; Alt+↓ goes to the next row as the list has it, in place of the step, round at the ends, the row in sight; the palette takes it first; in maximize mode 缩小 after it lands on that slot", async () => {
  const page = await open("", undefined, wide());
  const jump = page.getByRole("dialog", { name: "跳转" });
  const box = page.getByRole("textbox", { name: "消息" });
  const hash = () => new URL(page.url()).hash;
  const steps = () => page.evaluate(() => history.length);
  const go = async (name: string) => (await page.keyboard.press("Control+K"), await jump.getByRole("combobox").fill(name), await page.keyboard.press("Enter"));
  await page.getByRole("link", { name: /finished/ }).waitFor();
  await go("finished");
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(hash()).toBe(`#/slot/${finished}`);
  const rows = await page.locator('main a[href^="#/slot/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")!));
  const at = rows.indexOf(`#/slot/${finished}`);
  const n = await steps();
  await page.keyboard.press("Alt+ArrowDown");
  await until(() => hash() === rows[at + 1]);
  await page.keyboard.press("Alt+ArrowUp");
  await page.keyboard.press("Alt+ArrowUp");
  await until(() => hash() === rows[at - 1]);
  expect(await steps()).toBe(n);
  // The command palette open, Alt+↓ is its own.
  await box.fill("/");
  await page.keyboard.press("Alt+ArrowDown");
  await Bun.sleep(200);
  expect(hash()).toBe(rows[at - 1]!);
  await box.fill("");
  // Round from the top to the bottom, scrolled into sight.
  await page.evaluate((h) => (location.hash = h), rows[0]!);
  await page.keyboard.press("Alt+ArrowUp");
  const bottom = rows.at(-1)!;
  await until(() => hash() === bottom);
  const last = page.locator(`main a[href="${bottom}"]`);
  await until(async () => (await last.getAttribute("aria-current")) === "page");
  await until(async () => {
    const b = (await last.boundingBox())!;
    return b.y >= 0 && b.y + b.height <= 900;
  });

  await page.goto(`http://127.0.0.1:${server!.port}/#/topology`);
  await page.locator(".react-flow").waitFor();
  await go("rests");
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  expect(hash()).toBe(`#/topology/slot/${rests}?chat`);
  await page.getByRole("button", { name: "放大" }).click();
  await page.getByRole("button", { name: "缩小" }).waitFor();
  const next = rows[(rows.indexOf(`#/slot/${rests}`) + 1) % rows.length]!.slice("#/slot/".length);
  const m = await steps();
  await page.keyboard.press("Alt+ArrowDown");
  await until(() => hash() === `#/topology/slot/${next}?chat&full`);
  await page.getByRole("button", { name: "缩小" }).click();
  await page.locator(".react-flow").waitFor();
  expect(hash()).toBe(`#/topology/slot/${next}?chat`);
  expect(await steps()).toBe(m);
  await page.context().close();
});

smoke("story 442: in the sidebar the slot Alt+↑ goes to, hidden under the buttons on top and a stuck tab, scrolls just clear of them; its 跳转 opens the jump box", async () => {
  const page = await open(`/slot/${finished}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  await side.waitFor();
  const rows = side.locator('a[href^="#/slot/"]');
  // Far enough down for the buttons to shrink, with room under it to scroll it up to them.
  const current = rows.nth(10);
  const above = rows.nth(9);
  await page.goto(`http://127.0.0.1:${server!.port}/${await current.getAttribute("href")}`);
  await until(async () => (await current.getAttribute("aria-current")) === "page");
  // The open row just clear of the buttons, shrunk once scrolled, and a stuck tab, as the scroll
  // padding has it; the one above it under them.
  await side.evaluate((e) => (e.parentElement!.scrollTop = 200));
  await page.waitForTimeout(300);
  await current.evaluate((a) => a.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(300);
  const edge = (await current.boundingBox())!.y;
  expect(await above.evaluate((a) => a.contains(document.elementFromPoint(a.getBoundingClientRect().left + 40, a.getBoundingClientRect().top + 2)))).toBe(false);
  await page.keyboard.press("Alt+ArrowUp");
  await until(async () => (await above.getAttribute("aria-current")) === "page");
  await until(async () => Math.abs((await above.boundingBox())!.y - edge) <= 1);

  await side.getByRole("button", { name: "跳转" }).click();
  await page.getByRole("dialog", { name: "跳转" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("dialog", { name: "跳转" }).waitFor({ state: "detached" });
  await page.context().close();
});

smoke("stories 441, 442: while the jump box is open the caret stays in its input: Tab, Shift+Tab and a click on its text don't move it, Alt+↑↓ with nothing found doesn't change the chat; Esc then closes it", async () => {
  const page = await open(`/slot/${finished}`, undefined, wide());
  const jump = page.getByRole("dialog", { name: "跳转" });
  const input = jump.getByRole("combobox");
  const inside = () => input.evaluate((i) => i === document.activeElement);
  await page.getByRole("log", { name: "对话" }).waitFor();
  await page.keyboard.press("Control+K");
  await input.fill("zzz");
  await page.keyboard.press("Alt+ArrowDown");
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Shift+Tab");
  await jump.getByText("没有这个槽位。").click();
  await Bun.sleep(200);
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
  expect(await inside()).toBe(true);
  await page.keyboard.press("Escape");
  await jump.waitFor({ state: "detached" });
  await page.context().close();
});

smoke("story 442: after 打开槽位 beside the topology, Alt+↓ then the chat's back closes it on the slot gone to", async () => {
  const page = await open(`/topology/ws/${ws}`, undefined, wide());
  await node(page, "slot", "finished").click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  await page.keyboard.press("Alt+ArrowDown");
  await until(() => !new URL(page.url()).hash.includes(finished));
  const at = new URL(page.url()).hash;
  expect(at).toMatch(/^#\/topology\/slot\/[^?]+\?chat$/);
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
  expect(new URL(page.url()).hash).toBe(at.replace("?chat", ""));
  await page.context().close();
});

smoke("#285: on a wide screen 列表 and 拓扑图 keep a slot's chat open, the topology on that slot", async () => {
  const page = await open(`/slot/${finished}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const chat = page.getByRole("heading", { name: "w/finished" });
  await chat.waitFor();
  await page.getByRole("button", { name: "拓扑图", exact: true }).first().click(); // the header's tab, before the chat's
  await page.locator(".react-flow").waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}?chat`);
  await chat.waitFor();
  await page.getByRole("button", { name: "列表" }).click();
  await page.getByText("rests", { exact: true }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/slot/${finished}`);
  await chat.waitFor();
});

smoke("story 421: on a wide screen the chat's 拓扑图 button puts the topology on its slot in the list's place, the chat staying, in place of the step", async () => {
  const page = await open(`/slot/${finished}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const chat = page.getByRole("heading", { name: "w/finished" });
  await chat.waitFor();
  const steps = await page.evaluate(() => history.length);
  await page.getByRole("button", { name: "拓扑图", exact: true }).last().click(); // the chat's, after the header's tab
  await page.locator(".react-flow").waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}?chat`);
  await chat.waitFor();
  expect(await page.evaluate(() => history.length)).toBe(steps);
  // As the header's tab would have it: the tab pressed, the only 拓扑图 button left.
  expect(await page.getByRole("button", { name: "拓扑图", exact: true }).getAttribute("aria-pressed")).toBe("true");
});

/** How far the settings' gear sticks out past the list's cards at the right, with a two-digit round trip; at most 0 where the header fits. */
async function gearOut(page: Page) {
  await page.getByRole("link", { name: "状态" }).getByText(/^\d+ms$/).evaluate((e) => (e.textContent = "99ms"));
  const gear = (await page.getByRole("button", { name: "设置" }).locator("svg").boundingBox())!;
  const row = (await page.locator('main a[href^="#/slot/"]').first().boundingBox())!;
  return gear.x + gear.width - (row.x + row.width);
}

smoke("#635: the board's header fits over the list's cards beside a chat on a 1024px wide screen, the list's bar's room taken, and on a 390px phone", async () => {
  for (const [hash, device] of [[`/slot/${finished}`, wide(1024)], ["", { ...devices["Pixel 7"], viewport: { width: 390, height: 780 } }]] as const) {
    const page = await open(hash, undefined, device);
    await page.locator('main a[href^="#/slot/"]').first().waitFor();
    expect(await gearOut(page)).toBeLessThanOrEqual(0);
  }
});

smoke("story 422: on a wide screen the list beside a chat is 370px at its narrowest, the list's bar's room past a 360px phone's, its header whole in it", async () => {
  const page = await open(`/slot/${finished}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  const line = page.getByRole("separator");
  const at = (await line.boundingBox())!;
  await page.mouse.move(at.x + at.width / 2, at.y + at.height / 2);
  await page.mouse.down();
  await page.mouse.move(50, at.y + at.height / 2, { steps: 5 });
  await page.mouse.up();
  const box = (await line.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - 370)).toBeLessThan(1);
  expect(await gearOut(page)).toBeLessThanOrEqual(0);
});

smoke("#617: on a wide screen the board's header beside a chat is level with the chat's top bar: the same middle, a line under each at the same height, the board's across its side", async () => {
  for (const hash of [`/slot/${finished}`, `/topology/slot/${finished}?chat`]) {
    const page = await open(hash, undefined, wide());
    await page.getByRole("heading", { name: "w/finished" }).waitFor();
    const [board, chat] = await page.locator("header").evaluateAll((hs) =>
      hs.map((h) => {
        // Its line: its own bottom border, or the box's it is drawn in.
        let lined: Element | null = h;
        while (lined && getComputedStyle(lined).borderBottomWidth !== "1px") lined = lined.parentElement;
        // Where it stands with nothing scrolled: the list brings the open slot's row into sight.
        let up = 0;
        for (let n = h.parentElement; n; n = n.parentElement) up += n.scrollTop;
        const first = h.firstElementChild!.getBoundingClientRect();
        const line = lined?.getBoundingClientRect();
        return { mid: first.y + up + first.height / 2, line: line && ([line.left, line.right, line.bottom + up] as const) };
      }),
    );
    // Up to the line drawn between the sides.
    const side = (await page.getByRole("separator").locator("> div").first().boundingBox())!;
    expect(board!.mid).toBe(chat!.mid);
    expect(board!.line).toEqual([0, side.x, chat!.line![2]]);
  }
});

smoke("#635, #630: on a wide screen the board's header stays atop the list, a chat beside it or not; the list scrolls under its line, with the board's bar with no arrows, and brings a row far down into sight clear of it; its 列表 and 拓扑图 ring inside their round control", async () => {
  const page = await open("", undefined, wide(1024));
  const last = page.locator('main a[href^="#/slot/"]').last();
  await last.waitFor();
  /** The header's line, where what scrolls the list starts and its bar, the room both keep for the bar,
   *  so the header stays level with the list as its bar comes, and whether the last row shows whole
   *  under the line, its card's bottom too. */
  const at = () =>
    last.evaluate((row) => {
      let lined = document.querySelector("main header")!;
      while (getComputedStyle(lined).borderBottomWidth !== "1px") lined = lined.parentElement!;
      let list = row.parentElement!;
      while (list.parentElement && getComputedStyle(list).overflowY !== "auto") list = list.parentElement;
      const [line, r, card] = [lined.getBoundingClientRect().bottom, row.getBoundingClientRect(), row.parentElement!.parentElement!.getBoundingClientRect()];
      const gutter = [lined, list].map((e) => `${getComputedStyle(e).overflowY} ${getComputedStyle(e).scrollbarGutter}`);
      return { line, list: list.getBoundingClientRect().top, bar: getComputedStyle(list).scrollbarWidth, gutter, row: r.top >= line && card.bottom <= innerHeight };
    });
  const pinned = { line: 57, list: 57, bar: "auto", gutter: ["hidden stable", "auto stable"], row: true };
  // The keys that scrolled the window scroll the list, nothing focused or a header's button or link.
  const top = () => page.evaluate(() => document.querySelector("main")!.lastElementChild!.scrollTop);
  await page.keyboard.press("PageDown");
  await until(async () => (await top()) > 0);
  await page.getByRole("button", { name: "列表" }).click();
  await page.keyboard.press("End");
  await settles(at, pinned);
  // 列表 and 拓扑图 ring inside them, round as the control's corners inside its border: what is outside, it clips.
  const tabs = page.getByRole("button", { name: /^(列表|拓扑图)$/ });
  await tabs.first().focus();
  expect(await rung(tabs.first())).toEqual({ style: "solid", inset: 0 });
  expect(await tabs.evaluateAll((t) => t.map((e) => getComputedStyle(e).borderRadius))).toEqual(["9px 0px 0px 9px", "0px 9px 9px 0px"]);
  // The list, opened from Rhodium's page scrolled down, starts at its top, as the window did.
  const bots = Array.from({ length: 30 }, (_, i) => ({ name: `bot${i}`, platform: "qq", state: "online" }));
  await page.route("**/api/rhodium", (r) => r.fulfill({ json: { boot: 1, pid: 1, startedAt: Date.now(), unit: null, logs: null, bots } }));
  // Space on the header's link scrolls it too, as only a button takes Space.
  await page.getByRole("link", { name: "状态" }).click();
  await page.getByText("bot29").waitFor();
  await page.keyboard.press("Space");
  // Till it stops, as the browser's glide down would go on past 列表 putting the list at its top.
  await until(async () => (await top()) > 0 && (await top()) === (await Bun.sleep(100), await top()));
  await page.getByRole("button", { name: "列表" }).click();
  await last.waitFor();
  expect(await top()).toBe(0);
  // Its chat opened by its address, the list beside it brings it into sight.
  await page.evaluate((h) => (location.hash = h), (await last.getAttribute("href"))!);
  await page.getByRole("separator").waitFor();
  await settles(at, pinned);
});

smoke("story 433: out of room, a full name's workspace gives way first, down to three letters and a \"…\" right before the \"/\"; on a phone, the home and the list beside a chat at its narrowest", async () => {
  const named = (ws: string, name: string) => ({ id: `${ws}/${name}`, ref: `${ws}/${name}`, name, parent: null, agent: "claude", state: "空闲", lifetime: "longterm", turnEndedAt: null, archivedAt: null, activeAt: 0, pinnedAt: null, last: null, bots: [] });
  const alone = (ws: string, name: string) => ({ name: ws, dir: "/x", groups: { needsYou: [], running: [], done: [], idle: [named(ws, name)] }, archived: [] });
  // Each the only slot of its workspace: together in one card, by full names.
  const board = { bots: [], workspaces: [alone("HomeProjectProjectsArchive2026", "homehelp"), alone("研究所里很长很长的工作区名字", "a-slot-name-far-too-long-for-any-row-to-hold"), alone("w", "short")] };
  const stub = async (page: Page) => void (await page.route("**/api/board", (r) => r.fulfill({ json: board })));
  /** What row id's name shows: its workspace's letters k of n, as many as fit in its box with a "…",
   *  the box's room past them, whether it shows whole, the gap to the "/", and whether the slot's own name is cut. */
  const row = (page: Page, id: string) =>
    page.evaluate((id) => {
      const [ws, slash, name] = document.querySelector(`a[href="#/slot/${encodeURIComponent(id)}"] > span:nth-child(2)`)!.children as unknown as HTMLElement[];
      const text = ws!.firstChild as Text;
      const range = document.createRange();
      const w = (k: number) => (range.setStart(text, 0), range.setEnd(text, k), range.getBoundingClientRect().width);
      const pen = document.createElement("canvas").getContext("2d")!;
      const cs = getComputedStyle(ws!);
      pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const ell = pen.measureText("…").width;
      const box = ws!.getBoundingClientRect();
      let k = text.length - 1;
      while (k > 0 && w(k) + ell > box.width) k--;
      return { k, n: text.length, room: box.width - w(k) - ell, whole: w(text.length) <= box.width + 0.5, gap: slash!.getBoundingClientRect().left - box.right, cut: name!.scrollWidth > name!.clientWidth };
    }, id);
  const check = async (page: Page) => {
    const qq = await row(page, "HomeProjectProjectsArchive2026/homehelp");
    expect([qq.whole, qq.k >= 3 && qq.k < qq.n, qq.room < 1, Math.abs(qq.gap) < 0.5, qq.cut]).toEqual([false, true, true, true, false]);
    const long = await row(page, "研究所里很长很长的工作区名字/a-slot-name-far-too-long-for-any-row-to-hold");
    expect([long.k, long.room < 1, long.cut]).toEqual([3, true, true]);
    expect((await row(page, "w/short")).whole).toBe(true);
  };

  const phone = await open("", stub);
  await phone.getByText("short", { exact: true }).waitFor();
  await check(phone);
  const home = await open("", stub, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await home.getByText("short", { exact: true }).waitFor();
  await check(home);
  const split = await open(`/slot/${finished}`, stub, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await split.getByRole("heading", { name: "w/finished" }).waitFor();
  const line = (await split.getByRole("separator").boundingBox())!;
  await split.mouse.move(line.x + line.width / 2, line.y + line.height / 2);
  await split.mouse.down();
  await split.mouse.move(50, line.y + line.height / 2, { steps: 5 });
  await split.mouse.up();
  await check(split);
});

smoke("story 433: a full name cut, gone back under its parent by its own name, is cut only as its row is", async () => {
  const ws = "研究所里很长很长的工作区名字";
  const named = (name: string, parent: string | null = null) => ({ id: `${ws}/${name}`, ref: `${ws}/${name}`, name, parent, agent: "claude", state: "空闲", lifetime: "longterm", turnEndedAt: null, archivedAt: null, activeAt: 0, pinnedAt: null, last: null, bots: [] });
  const parent = named("p");
  const kid = named("a-slot-name-far-too-long-for-any-row-to-hold", parent.ref);
  // While its parent needs you, the kid stands alone by its full name; then under it, by its own.
  const card = (needs: boolean) => ({ bots: [], workspaces: [{ name: ws, dir: "/x", groups: { needsYou: needs ? [{ ...parent, state: "等你回答" }] : [], running: [], done: [], idle: needs ? [kid] : [parent, kid] }, archived: [] }] });
  let board = card(true);
  const page = await open("", async (page) => void (await page.route("**/api/board", (r) => r.fulfill({ json: board }))));
  const name = page.locator(`a[href="#/slot/${encodeURIComponent(kid.id)}"] > span:nth-child(2)`);
  await name.getByText("/").waitFor();
  board = card(false);
  store.tx((tx) => tx.append({ source: "rh", type: "slot_renamed", slot: talks, data: { n: -3 } }));
  await name.getByText("/").waitFor({ state: "detached" });
  const [own, room] = await name.evaluate((box) => [box.lastElementChild!.getBoundingClientRect().width, box.getBoundingClientRect().width]);
  expect(Math.abs(own! - room!)).toBeLessThan(1);
});

smoke("stories 437-439: after a slot's name, the Bots whose chats land in it: on a 360px phone 18px, the row no taller and nothing to scroll sideways; in one line at 820px 24px, the names whole and the last lines in one column; in the sidebar a cut name keeps 6 letters", async () => {
  const face = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 2"><rect width="2" height="2" fill="#333"/></svg>')}`;
  const bots = [
    { id: "q", name: "QQ 主号", platform: "qq", avatar: face },
    { id: "t", name: "电报", platform: "telegram", avatar: face },
    { id: "x", name: "小号", platform: "qq", avatar: null },
  ];
  const named = (ws: string, name: string, o: object = {}) => ({ id: `${ws}/${name}`, ref: `${ws}/${name}`, name, parent: null, agent: "claude", state: "空闲", lifetime: "longterm", turnEndedAt: null, archivedAt: null, activeAt: 0, pinnedAt: null, last: { role: "assistant", text: "好的，改完了，测试都过了。", at: Date.now() - 60_000 }, bots: [], ...o });
  const all = ["q", "t", "x"];
  const board = {
    bots,
    workspaces: [
      { name: "HomeProject", dir: "/q", groups: { needsYou: [named("HomeProject", "asks-about-the-deploy-target", { state: "需要你", bots: ["q", "t"] })], running: [], done: [], idle: [] }, archived: [] },
      { name: "w", dir: "/w", groups: { needsYou: [], running: [], done: [], idle: [named("w", "three", { bots: all }), named("w", "web-terminal-embed", { bots: all }), named("w", "a-slot-name-far-too-long-for-any-row", { bots: all }), named("w", "plain")] }, archived: [named("w", "old", { archivedAt: Date.now() - 60_000, bots: ["t"] })] },
    ],
  };
  const stub = async (page: Page) => void (await page.route("**/api/board", (r) => r.fulfill({ json: board })));
  /** What row id shows: its height; its faces' sizes, and their right and middle against its name's; the
   *  left of its state and of its last line; how many of its own name's letters show, and whether all. */
  const row = (page: Page, id: string) =>
    page.evaluate((id) => {
      const a = document.querySelector(`a[href^="#/slot/${encodeURIComponent(id)}"]`)!;
      const [, box, state, last] = a.children as unknown as HTMLElement[];
      const own = box!.querySelector<HTMLElement>("[data-own]")!;
      const text = own.firstChild as Text;
      const range = document.createRange();
      const w = (k: number) => (range.setStart(text, 0), range.setEnd(text, k), range.getBoundingClientRect().width);
      const pen = document.createElement("canvas").getContext("2d")!;
      const cs = getComputedStyle(own);
      pen.font = `${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      let k = text.length;
      while (k > 0 && w(k) + (k < text.length ? pen.measureText("…").width : 0) > own.getBoundingClientRect().width + 0.5) k--;
      const faces = [...box!.querySelectorAll<HTMLElement>("span[title]")].map((f) => f.getBoundingClientRect());
      const mid = (r: DOMRect) => r.top + r.height / 2;
      return {
        height: a.getBoundingClientRect().height,
        sizes: faces.map((f) => f.width),
        right: Math.max(0, ...faces.map((f) => f.right)),
        level: faces.every((f) => Math.abs(mid(f) - mid(own.getBoundingClientRect())) < 2),
        state: state!.getBoundingClientRect().left,
        last: last!.getBoundingClientRect().left,
        letters: k,
        whole: k === text.length,
      };
    }, id);

  const phone = await open("", stub, { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } });
  await phone.getByText("plain", { exact: true }).waitFor();
  const [three, long, plain] = [await row(phone, "w/three"), await row(phone, "w/a-slot-name-far-too-long-for-any-row"), await row(phone, "w/plain")];
  expect([three.sizes, three.height, three.level, three.right <= three.state]).toEqual([[18, 18, 18], plain.height, true, true]);
  expect([long.height, long.level, long.right <= long.state, !long.whole && long.letters >= 6]).toEqual([plain.height, true, true, true]);
  expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  // Named when pointed at; archived rows have theirs too.
  expect(await phone.locator('a[href="#/slot/w%2Fthree"] span[title]').evaluateAll((fs) => fs.map((f) => f.getAttribute("title")))).toEqual(["QQ 主号", "电报", "小号"]);
  await phone.getByRole("button", { name: /已归档/ }).click();
  expect((await row(phone, "w/old")).sizes).toEqual([18]);

  const line = await open("", stub, { ...devices["Pixel 7"], viewport: { width: 820, height: 1000 } });
  await line.getByText("plain", { exact: true }).waitFor();
  // A name that fits the column alone, not with its faces but for the room they add.
  const rows = [await row(line, "w/web-terminal-embed"), await row(line, "w/a-slot-name-far-too-long-for-any-row"), await row(line, "w/plain")];
  expect(rows[0]!.sizes).toEqual([24, 24, 24]);
  expect(rows.map((r) => r.whole)).toEqual([true, false, true]);
  expect(rows.slice(0, 2).every((r) => r.right <= r.last)).toBe(true);
  expect(new Set(rows.map((r) => Math.round(r.last))).size).toBe(1);

  const side = await open(`/slot/${finished}?full`, stub, wide());
  await side.getByRole("navigation", { name: "槽位" }).getByText("plain", { exact: true }).waitFor();
  for (const x of [288, 256]) {
    if (x !== 288) await dragTo(side, x);
    const asks = await row(side, "HomeProject/asks-about-the-deploy-target");
    expect([x, asks.letters >= 6, asks.right <= asks.state, asks.level]).toEqual([x, true, true, true]);
    expect((await row(side, "w/three")).sizes.every((s) => s === 18)).toBe(true);
  }
  for (const p of [phone, line, side]) await p.context().close();
});

smoke("stories 447, 448: on a wide screen ⋯ has 全屏, the page as it was in the browser's fullscreen, and 退出全屏; there a short Esc stops the turn once let go, a held one never, nor as it goes on after leaving; on a phone ⋯ has neither", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "fullscreens", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id);
  const phone = await open(`/slot/${slot}`);
  await phone.getByRole("button", { name: "更多" }).click();
  await phone.getByRole("menuitem", { name: "改名" }).waitFor();
  expect(await phone.getByRole("menuitem", { name: /全屏/ }).count()).toBe(0);

  const page = await open(`/slot/${slot}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const isFull = () => page.evaluate(() => !!document.fullscreenElement);
  const stops = () => acted.filter((a) => JSON.stringify(a.act) === JSON.stringify({ kind: "common", slot, name: "stop" })).length;
  const more = page.getByRole("button", { name: "更多" });
  const box = page.getByRole("textbox", { name: "消息" });
  const typing = () => box.evaluate((b) => b === document.activeElement);
  await page.getByRole("button", { name: "停止" }).waitFor();
  await more.click();
  await page.getByRole("menuitem", { name: "全屏" }).click();
  await until(isFull);
  // The caret back where you type, not lost with the menu: a short Esc goes there.
  await until(typing);
  expect(await page.getByRole("separator").count()).toBe(1);
  expect(new URL(page.url()).hash).toBe(`#/slot/${slot}`);
  // A short Esc goes to what has the focus once let go: the menu closes.
  await more.click();
  await page.getByRole("menuitem", { name: "退出全屏" }).waitFor();
  await page.keyboard.press("Escape");
  await page.getByRole("menu").waitFor({ state: "detached" });

  // Held, Esc stops nothing: neither as pressed nor as let go.
  await box.focus();
  await page.keyboard.down("Escape");
  await page.waitForTimeout(600);
  await page.keyboard.up("Escape");
  await page.waitForTimeout(200);
  expect(stops()).toBe(0);
  // Short, it does once let go; the page stays in fullscreen.
  await page.keyboard.down("Escape");
  await page.waitForTimeout(150);
  expect(stops()).toBe(0);
  await page.keyboard.up("Escape");
  await until(() => stops() === 1);
  expect(await isFull()).toBe(true);
  // Held until the browser leaves fullscreen, the Esc it goes on sending is not a press.
  await page.keyboard.down("Escape");
  await page.waitForTimeout(600);
  await page.evaluate(() => document.exitFullscreen());
  await until(async () => !(await isFull()));
  await page.keyboard.down("Escape"); // a second down: playwright's held key, repeat
  await page.keyboard.up("Escape");
  await page.waitForTimeout(200);
  expect(stops()).toBe(1);
  // Out of fullscreen, Esc stops the turn as pressed.
  await page.keyboard.down("Escape");
  await until(() => stops() === 2);
  await page.keyboard.up("Escape");

  await more.click();
  await page.getByRole("menuitem", { name: "全屏" }).click();
  await until(isFull);
  await more.click();
  await page.getByRole("menuitem", { name: "退出全屏" }).click();
  await until(async () => !(await isFull()));
  await until(typing);
});

smoke("story 420, #285: what the agent is writing stays whole as its chat goes into maximize mode and back, and moves between 列表 and 拓扑图; the chat is never drawn afresh", async () => {
  const { slot, conversation } = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "streams", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot, agent: "pi", sessionId: "t7", startedAt: Date.now() }).id;
    tx.update("slot", { id: slot }, { conversation });
    return { slot, conversation };
  });
  writeFileSync(join(talked, "../2026-10-23_t7.jsonl"), said("user", "stream it"));
  const write = (text: string) => hearing.forEach((hear) => hear(conversation, { conv: conversation, proc: 1, type: "text_delta", text }));
  let streaming: Promise<unknown> | undefined;
  const page = await open(`/slot/${slot}`, async (page) => void (streaming = page.waitForResponse((r) => r.url().includes(`/api/events?slot=${slot}`))), {
    viewport: { width: 1440, height: 900 },
  } as (typeof devices)[string]);
  await page.getByRole("log").getByText("stream it").waitFor();
  await streaming;
  write("Begun: one");
  await page.getByText("Begun: one").waitFor();
  // A mark on the chat as drawn: one drawn anew has none.
  await page.getByRole("log").evaluate((el) => (el.dataset.mark = "1"));
  const marked = () => page.locator('[role="log"][data-mark="1"]').count();

  await page.getByRole("button", { name: "放大" }).click();
  write(" two");
  await page.getByText("Begun: one two").waitFor();
  expect(await marked()).toBe(1);
  await page.getByRole("button", { name: "收起侧栏" }).click();
  write(" 2a");
  await page.getByText("Begun: one two 2a").waitFor();
  await page.getByRole("button", { name: /^展开侧栏/ }).click();
  write(" 2b");
  await page.getByText("Begun: one two 2a 2b").waitFor();
  expect(await marked()).toBe(1);
  await page.getByRole("button", { name: "缩小" }).click();
  write(" three");
  await page.getByText("Begun: one two 2a 2b three").waitFor();
  expect(await marked()).toBe(1);
  await page.getByRole("button", { name: "拓扑图", exact: true }).first().click();
  await page.locator(".react-flow").waitFor();
  write(" four");
  await page.getByText("Begun: one two 2a 2b three four").waitFor();
  await page.getByRole("button", { name: "列表" }).click();
  await page.getByText("rests", { exact: true }).waitFor();
  write(" five");
  await page.getByText("Begun: one two 2a 2b three four five").waitFor();
  hearing.forEach((hear) => hear(conversation, { conv: conversation, proc: 1, type: "exit", code: 0, signal: null, from: "agent" }));
});

smoke("#285, story 449: on a phone the chat, which fills the screen already, has no 放大; an address in maximize mode is the chat alone, Ctrl+B the browser's", async () => {
  const page = await open(`/slot/${finished}?full`);
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(await page.getByRole("button", { name: /放大|缩小/ }).count()).toBe(0);
  expect(await page.getByRole("navigation", { name: "槽位" }).count()).toBe(0);
  expect(await taken(page)).toBe(false);
  expect(await page.getByRole("button", { name: /侧栏/ }).count()).toBe(0);
});

smoke("story 246: on a wide screen a slot's chat opens beside the topology; another slot tapped takes its place, anything else closes it", async () => {
  const page = await open(`/topology/ws/${ws}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  // The archived switch, not a step, stays on as the chat opens.
  const archived = page.getByRole("button", { name: "已归档" });
  await archived.click();
  await node(page, "slot", "finished").click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("log", { name: "对话" }).waitFor();
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}?chat`);
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(await sheetOf(page).isVisible()).toBe(false);
  expect(await page.getByRole("button", { name: "拓扑图", exact: true }).count()).toBe(1); // the header's tab, not the chat's
  expect(await archived.getAttribute("aria-pressed")).toBe("true");
  // The graph is fitted afresh in its narrower pane, in a glide once the pane has its width: the focus shows whole.
  await until(async () => {
    const pane = (await page.locator(".react-flow").boundingBox())!;
    const slot = (await node(page, "slot", "finished").boundingBox())!;
    return slot.x >= pane.x && slot.x + slot.width <= pane.x + pane.width && slot.y >= pane.y && slot.y + slot.height <= pane.y + pane.height;
  });

  await node(page, "slot", "rests").click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  expect(new URL(page.url()).hash).toMatch(/\?chat$/);
  // Its back closes the chat, the focus staying on it, as for any slot tapped beside a chat.
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${rests}`);
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  await page.getByRole("navigation", { name: "路径" }).getByRole("button", { name: "w", exact: true }).click();
  await page.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
  expect(new URL(page.url()).hash).toBe(`#/topology/ws/${ws}`);

  // The chat's back closes it, the topology staying.
  await node(page, "slot", "finished").click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("log", { name: "对话" }).waitFor();
  await page.getByRole("button", { name: "返回" }).click();
  await page.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
  expect(new URL(page.url()).hash).toBe(`#/topology/slot/${finished}`);
  await sheetOf(page).getByRole("heading", { name: "w/finished" }).waitFor();
});

smoke("#290: with a chat beside the topology, a Shift typed in its composer is the IME's, not React Flow's", async () => {
  const page = await open(`/topology/slot/${finished}?chat`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await page.locator(".react-flow").waitFor();
  const box = page.getByRole("textbox", { name: "消息" });
  await box.focus();
  // Last on window, after React Flow's own listener there.
  await page.evaluate(() => addEventListener("keydown", (e) => ((window as unknown as { kept: boolean[] }).kept ??= []).push(!e.defaultPrevented)));
  await page.keyboard.down("Shift");
  await page.keyboard.up("Shift");
  expect(await page.evaluate(() => (window as unknown as { kept: boolean[] }).kept)).toEqual([true]);
});

smoke("#293, story 540: 新槽位 from a workspace's details on the topology starts in that workspace's directory, not the first's", async () => {
  const other = store.tx((tx) => tx.insert("workspace", { name: "z", dir: folder("z") }).id);
  try {
    const page = await open(`/topology/ws/${other}`);
    await sheetOf(page).getByRole("button", { name: "新槽位" }).click();
    await picker(page.getByRole("dialog")).ws("z").and(page.locator("[aria-pressed=true]")).waitFor();
  } finally {
    store.tx((tx) => tx.delete("workspace", { id: other }));
  }
});

smoke("#255: on a wide screen a slot's full name too long for the card's title breaks after its workspace, not inside a word", async () => {
  const [other, long] = store.tx((tx) => {
    const other = tx.insert("workspace", { name: "HomeProjectArchive", dir: "/q" }).id;
    return [other, tx.insert("slot", { workspace: other, name: "homehelpworker", dir: "/q", mode: "headless", state: "idle", lifetime: "longterm" }).id];
  });
  try {
    const page = await open(`/topology/slot/${long}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
    const title = sheetOf(page).getByRole("heading", { name: "HomeProjectArchive/homehelpworker" });
    // Its text, line by line as drawn.
    const lines = await title.evaluate((h) => {
      const at = new Map<number, string>();
      const walk = document.createTreeWalker(h, NodeFilter.SHOW_TEXT);
      for (let n = walk.nextNode(); n; n = walk.nextNode())
        for (let i = 0; i < n.textContent!.length; i++) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 1);
          const top = Math.round(r.getBoundingClientRect().top);
          at.set(top, (at.get(top) ?? "") + n.textContent![i]);
        }
      return [...at.values()];
    });
    expect(lines).toEqual(["HomeProjectArchive/", "homehelpworker"]);
  } finally {
    store.tx((tx) => (tx.delete("slot", { id: long }), tx.delete("workspace", { id: other })));
  }
});

smoke("stories 256, 257, 264, 543: on a phone the stop key, there while a turn runs, spins until rhodium answers; the answer is a toast over it that goes by itself, an error one after 8 s, a bar along its foot running out, or when tapped", async () => {
  const blocked: string[] = [];
  const page = await open(`/slot/${works}`, async (page) => (await page.clock.install(), void page.on("console", (m) => /Content Security Policy/.test(m.text()) && blocked.push(m.text()))));
  const stop = page.getByRole("button", { name: "停止" });
  const box = (await stop.boundingBox())!;
  expect(box.width >= 44 && box.height >= 44).toBe(true);
  let reply!: (r: RhReply) => void;
  answer = () => new Promise((r) => (reply = r));
  const before = acted.length;
  await stop.click();
  await until(() => acted.length === before + 1);
  expect(acted.at(-1)!.act).toEqual({ kind: "common", slot: works, name: "stop" });
  expect(await stop.isDisabled()).toBe(true);
  reply({ ok: true, text: "已停下这一回合，对话留着。" });
  const done = page.getByRole("status").getByText("已停下这一回合，对话留着。");
  await done.waitFor();
  expect(await stop.isDisabled()).toBe(false);
  const toast = (await done.boundingBox())!;
  expect(toast.y + toast.height).toBeLessThanOrEqual((await stop.boundingBox())!.y);
  await page.clock.runFor(3_000);
  await done.waitFor({ state: "detached" });

  answer = async () => ({ ok: false, error: "w/works 还在启动，过几秒再试。" });
  await stop.click();
  const error = page.getByRole("status").getByText("w/works 还在启动，过几秒再试。");
  await error.click();
  await error.waitFor({ state: "detached" });
  await stop.click();
  await page.getByRole("status").locator(".animate-undo").waitFor();
  await page.clock.runFor(7_000);
  expect(await error.isVisible()).toBe(true);
  await page.clock.runFor(1_000);
  await error.waitFor({ state: "detached" });
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  expect(blocked).toEqual([]);
});

smoke("story 258: a page elsewhere, on another port of this machine or on localhost, cannot write to the board: what it sends is refused, and nothing is done", async () => {
  const elsewhere = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("<!doctype html><title>elsewhere</title>", { headers: { "content-type": "text/html" } }) });
  const context = await browser!.newContext({ ...devices["Pixel 7"], extraHTTPHeaders: { "Tailscale-User-Login": BOARD_LOGIN } });
  try {
    const before = acted.length;
    const url = `http://127.0.0.1:${server!.port}/api/act`;
    const body = JSON.stringify({ id: "elsewhere", act: { kind: "common", slot: works, name: "stop" } });
    for (const [host, site] of [["127.0.0.1", "same-site"], ["localhost", "cross-site"]]) {
      const page = await context.newPage();
      await page.goto(`http://${host}:${elsewhere.port}/`);
      // As JSON the browser asks first, and the board says no.
      expect(await page.evaluate(([url, body]) => fetch(url!, { method: "POST", headers: { "content-type": "application/json" }, body }).then(() => "sent", () => "refused"), [url, body])).toBe("refused");
      // As plain text it goes without asking, saying where it comes from.
      const sent = page.waitForResponse((r) => r.url() === url);
      await page.evaluate(([url, body]) => void fetch(url!, { method: "POST", mode: "no-cors", body }), [url, body]);
      const r = await sent;
      expect([host, (await r.request().allHeaders())["sec-fetch-site"], r.status()]).toEqual([host, site, 403]);
      // So does a message with a file, as a form, which the browser never asks about.
      const form = `http://127.0.0.1:${server!.port}/api/send`;
      const posted = page.waitForResponse((r) => r.url() === form);
      await page.evaluate(([url, slot]) => {
        const f = new FormData();
        for (const [k, v] of [["id", "elsewhere"], ["slot", slot!], ["text", "hi"]]) f.set(k!, v!);
        f.append("file", new File(["x"], "x.txt"));
        void fetch(url!, { method: "POST", mode: "no-cors", body: f });
      }, [form, works]);
      expect([host, (await posted).status()]).toEqual([host, 403]);
    }
    expect(acted.length).toBe(before);
  } finally {
    await context.close();
    elsewhere.stop(true);
  }
});

smoke("stories 263, 265-269, 476: on a phone a slot's buttons send what they say: the terminal key once confirmed, asking while a turn runs whether to cut it short; 收回终端 once confirmed; 改名 in the title; 归档 with 撤销 for 8 s; an archived slot's 恢复 on the board", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  // A turn runs: the terminal key asks first, after it or cutting it short; its dialog is over a toast
  // still up. It is at the left of the bar under where you type, the stop key at its right.
  const runs = await open(`/slot/${works}`);
  const key = (await runs.getByRole("button", { name: "切到终端", exact: true }).boundingBox())!;
  const typing = (await runs.getByRole("textbox", { name: "消息" }).boundingBox())!;
  const stops = (await runs.getByRole("button", { name: "停止" }).boundingBox())!;
  expect([key.y >= typing.y + typing.height, key.x < typing.x + 20, Math.abs(key.y - stops.y) < 1, key.width >= 44 && key.height >= 44]).toEqual([true, true, true, true]);
  const asks = runs.getByRole("alertdialog");
  await runs.getByRole("button", { name: "切到终端", exact: true }).click();
  expect(await asks.getByRole("button").allInnerTexts()).toEqual(["取消", "跑完再切", "打断，马上切"]);
  await asks.getByRole("button", { name: "取消" }).click();
  await asks.waitFor({ state: "detached" });
  await runs.waitForTimeout(200);
  expect(acted.length).toBe(n);
  answer = async () => ({ ok: false, error: "没能切到终端：w/works 正在切换，等这次切完再说，或者先收回终端。" });
  await runs.getByRole("button", { name: "切到终端", exact: true }).click();
  await asks.getByRole("button", { name: "跑完再切" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["tui", works] });
  await runs.getByRole("status").getByText(/^没能切到终端/).waitFor();
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  await runs.getByRole("button", { name: "切到终端", exact: true }).click();
  await asks.getByRole("button", { name: "打断，马上切" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["tui", works, "!"] });

  // 收回终端, in the top bar's 更多, asks first, the one that does.
  const inTerm = await open(`/slot/${term}`);
  const takeBack = async () => (await inTerm.getByRole("button", { name: "更多" }).click(), await inTerm.getByRole("menuitem", { name: "收回终端" }).click());
  await takeBack();
  const dialog = inTerm.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "取消" }).click();
  await dialog.waitFor({ state: "detached" });
  expect(acted.length).toBe(n);
  await takeBack();
  await dialog.getByRole("button", { name: "收回" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["release", term], sure: true });

  // 改名: the title becomes a box, its name picked; Enter sends it, not the Enter that picks an input
  // method's word.
  const page = await open(`/slot/${rests}`);
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "改名" }).click();
  const box = page.getByRole("textbox", { name: "槽位名" });
  await box.waitFor();
  expect(await box.evaluate((b: HTMLInputElement) => b === document.activeElement && b.value.slice(b.selectionStart!, b.selectionEnd!))).toBe("rests");
  await box.fill("rested");
  await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await page.waitForTimeout(200);
  expect([acted.length, await box.isVisible()]).toEqual([n, true]);
  await box.press("Enter");
  expect(await sent()).toEqual({ kind: "rh", argv: ["rename", rests, "rested"] });
  await box.waitFor({ state: "detached" });

  // 归档 at once; its toast has 撤销, a bar along its foot shrinking smoothly, which sends the undo,
  // back on the list too.
  const undo = { kind: "bind" as const, unarchive: rests, changes: [] };
  answer = async () => ({ ok: true, text: "已归档 w/rests，对话保留。", undo });
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "归档" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["archive", rests] });
  await page.getByRole("status").getByText("已归档 w/rests，对话保留。").waitFor();
  const bar = page.getByRole("status").locator(".animate-undo");
  const before = (await bar.boundingBox())!.width;
  await page.waitForTimeout(400);
  const after = (await bar.boundingBox())!.width;
  expect(after).toBeLessThan(before);
  expect(before - after).toBeLessThan(before * 0.1);
  await page.getByRole("link", { name: "全部槽位" }).click();
  answer = async () => ({ ok: true, text: "已恢复 w/rests。" });
  await page.getByRole("button", { name: "撤销" }).click();
  expect(await sent()).toEqual(undo);
  await page.getByRole("status").getByText("已恢复 w/rests。").waitFor();

  // On the board, an archived slot has 恢复.
  const old = store.tx((tx) => {
    const id = tx.insert("slot", { workspace: ws, name: "old", dir: "/w", mode: "headless", state: "off", lifetime: "longterm", archivedAt: Date.now() }).id;
    tx.append({ source: "rh", type: "slot_archived", slot: id });
    return id;
  });
  const board = await open();
  await board.getByRole("button", { name: /^已归档/ }).click();
  await board.getByRole("button", { name: "恢复" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["unarchive", old] });
  await board.getByRole("status").getByText("已恢复 w/rests。").waitFor();
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

/** Slot name in w, archived and off, as one rh rm takes. */
const binned = (name: string) => store.tx((tx) => tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "off", lifetime: "longterm", archivedAt: Date.now() }).id);
/** rhodium's answer to rh rm id, which it does as rh rm does, telling the page. */
const removes = (id: string, ref: string) => async (): Promise<RhReply> => (
  store.tx((tx) => (tx.delete("slot", { id }), tx.append({ source: "rh", type: "slot_deleted", slot: id, data: { ref } }))), { ok: true, text: `已删除 ${ref}。` }
);

smoke("stories 535, 537: a row's right click, as Android's long press, opens its menu where it was: 归档 with 撤销 on a live headless slot, 恢复 and 删除 on an archived one, none on one in the terminal; 删除 asks first, then the row is gone", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  const old = binned("binned");
  const more5 = store.tx((tx) => tx.find("slot", { name: "more5" }))[0]!.id;
  const row = (id: string) => page.locator(`a[href$="/slot/${id}"]`);
  const page = await open();
  const items = page.getByRole("menuitem");
  await row(more5).click({ button: "right" });
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["置顶", "开新对话", "改名", "切到终端", "归档"]);
  answer = async () => ({ ok: true, text: "已归档 w/more5，对话保留。", undo: { kind: "bind", unarchive: more5, changes: [] } });
  await page.getByRole("menuitem", { name: "归档" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["archive", more5] });
  await page.getByRole("status").getByRole("button", { name: "撤销" }).waitFor();
  // Tapped, the toast goes, off what is under it.
  await page.getByRole("status").getByText("已归档 w/more5，对话保留。").click();
  await row(term).click({ button: "right" });
  await page.waitForTimeout(300);
  expect(await items.count()).toBe(0);

  await page.getByRole("button", { name: /^已归档 \d+$/ }).click();
  await row(old).click({ button: "right" });
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["恢复", "删除"]);
  await page.getByRole("menuitem", { name: "删除" }).click();
  const asks = page.getByRole("alertdialog");
  expect([await asks.getByRole("heading").innerText(), await asks.getByRole("button").allInnerTexts()]).toEqual(["删除 w/binned？", ["取消", "删除"]]);
  answer = removes(old, "w/binned");
  await asks.getByRole("button", { name: "删除" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["rm", old] });
  await row(old).waitFor({ state: "detached" });
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("#491: a running headless slot's row menu has 停止 first; 切到终端 asks as the bar's key does, 跑完再切 or 打断; 改名 turns the row's name into a box, the caret in it, where space is the box's, not the sidebar's page key, and Enter renames the slot", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  const page = await open(`/slot/${rests}?full`, undefined, wide());
  const row = (id: string) => page.getByRole("navigation", { name: "槽位" }).locator(`a[href$="/slot/${id}?full"]`);
  const items = page.getByRole("menuitem");
  await row(works).click({ button: "right" });
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["停止", "置顶", "开新对话", "改名", "切到终端", "归档"]);
  await page.getByRole("menuitem", { name: "切到终端" }).click();
  expect(await page.getByRole("alertdialog").getByRole("button").allInnerTexts()).toEqual(["取消", "跑完再切", "打断，马上切"]);
  await page.keyboard.press("Escape");
  await page.getByRole("alertdialog").waitFor({ state: "detached" });
  await items.first().waitFor({ state: "detached" });

  // Near the top, where the list has a page to turn below it.
  await row(finished).click({ button: "right" });
  await page.getByRole("menuitem", { name: "改名" }).click();
  const box = page.getByRole("textbox", { name: "槽位名" });
  expect(await box.inputValue()).toBe("finished");
  await page.keyboard.type("done ");
  expect(await box.inputValue()).toBe("done ");
  await page.keyboard.press("Enter");
  expect(await sent()).toEqual({ kind: "rh", argv: ["rename", finished, "done"] });
  await box.waitFor({ state: "detached" });
  await page.context().close();
});

smoke("#647: a row's rename box starts its workspace where the row's logo is, a child's as far in as it is, and goes at most as far right as the row's text: on a phone, on a tablet's wider list and in the sidebar", async () => {
  const [top, kid] = store.tx((tx) => {
    const top = tx.insert("slot", { workspace: ws, name: "quill", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    return [top, tx.insert("slot", { workspace: ws, name: "ember", parent: top, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id];
  });
  try {
    for (const [where, hash, device, end] of [["phone", "", devices["Pixel 7"], ""], ["tablet", "", wide(768), ""], ["sidebar", `/slot/${rests}?full`, wide(), "?full"]] as const) {
      const page = await open(hash, undefined, device);
      for (const [which, id] of [["top", top], ["kid", kid]] as const) {
        const row = page.locator(`a[href$="/slot/${id}${end}"]`);
        await row.click({ button: "right" });
        await page.getByRole("menuitem", { name: "改名" }).click();
        const box = page.getByRole("textbox", { name: "槽位名" });
        const prefix = await box.evaluate((n) => n.previousElementSibling!.getBoundingClientRect().left);
        const logo = await row.locator(":scope > span").first().evaluate((n) => n.getBoundingClientRect().left);
        // Where the text inside each ends at the right.
        const inner = (n: Element) => n.getBoundingClientRect().right - parseFloat(getComputedStyle(n).paddingRight);
        const ends = (await box.locator("xpath=../..").evaluate(inner)) - (await row.evaluate(inner));
        expect([where, which, Math.round(prefix - logo), Math.round(ends)]).toEqual([where, which, 0, 0]);
        await box.press("Escape");
        await box.waitFor({ state: "detached" });
        await page.getByRole("menu").waitFor({ state: "detached" });
      }
    }
  } finally {
    store.tx((tx) => (tx.delete("slot", { id: kid }), tx.delete("slot", { id: top })));
  }
});

smoke("#506: a live headless row's menu has 置顶; pinned, the slot is under 置顶's pin by its full name, below what needs you, a line under them, and its menu has 取消置顶", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  const more5 = store.tx((tx) => tx.find("slot", { name: "more5" }))[0]!.id;
  const page = await open(`/slot/${rests}?full`, undefined, wide());
  const side = page.getByRole("navigation", { name: "槽位" });
  const row = side.locator(`a[href$="/slot/${more5}?full"]`);
  const items = page.getByRole("menuitem");
  // Nothing pinned, no line.
  const line = side.getByRole("separator");
  expect(await line.count()).toBe(0);
  await row.click({ button: "right" });
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["置顶", "开新对话", "改名", "切到终端", "归档"]);
  answer = async () => ({ ok: true, text: "已置顶 w/more5。" });
  await page.getByRole("menuitem", { name: "置顶" }).click();
  expect(await sent()).toEqual({ kind: "pin", slot: more5, on: true });
  try {
    // As the router does it; the list goes by it once the mouse leaves.
    store.tx((tx) => (tx.update("slot", { id: more5 }, { pinnedAt: Date.now() }), tx.append({ source: "board", type: "board_act" })));
    await page.mouse.move(100, 400);
    await page.mouse.move(1000, 400);
    const pin = side.getByRole("img", { name: "置顶" });
    await pin.waitFor();
    const y = async (l: Locator) => (await l.boundingBox())!.y;
    await until(async () => (await y(row)) < (await y(side.getByRole("button", { name: "w", exact: true }))));
    expect([await y(side.locator(`a[href$="/slot/${asking}?full"]`)) < (await y(pin)), (await y(pin)) < (await y(row))]).toEqual([true, true]);
    // A line ends 置顶: under its last row, above the next block.
    expect([(await y(row)) < (await y(line)), (await y(line)) < (await y(side.getByRole("button", { name: "w", exact: true })))]).toEqual([true, true]);
    await side.getByRole("link", { name: /^w \/ more5/ }).waitFor();
    await row.click({ button: "right" });
    await items.first().waitFor();
    expect(await items.allInnerTexts()).toEqual(["取消置顶", "开新对话", "改名", "切到终端", "归档"]);
    answer = async () => ({ ok: true, text: "已取消置顶 w/more5。" });
    await page.getByRole("menuitem", { name: "取消置顶" }).click();
    expect(await sent()).toEqual({ kind: "pin", slot: more5, on: false });
    await page.context().close();
  } finally {
    store.tx((tx) => (tx.update("slot", { id: more5 }, { pinnedAt: null }), tx.append({ source: "board", type: "board_act" })));
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

/** Where a finger goes on slot id's row on the list, scrolled to the middle, and the row. */
const fingerOn = async (page: Page, id: string) => {
  const row = page.locator(`a[href$="/slot/${id}"]`);
  await row.evaluate((a) => a.scrollIntoView({ block: "center" }));
  const b = (await row.boundingBox())!;
  return { row, at: { x: b.x + 80, y: b.y + b.height / 2 } };
};

smoke("#504: on an iPad, which turns a long press into no right click, a finger held still on a row opens its menu where it is, its lift following no link, nor can it select the row's text; one that moves opens none; a tap opens the slot", async () => {
  const page = await open("", undefined, devices["iPad Mini"]);
  const { row, at } = await fingerOn(page, finished);
  const f = await finger(page);
  const items = page.getByRole("menuitem");
  expect(await row.evaluate((a) => getComputedStyle(a).userSelect)).toBe("none");

  // Moved less than a tap may, held: no menu. Then on, so it lifts as no tap.
  await f.down(at);
  await f.move({ x: at.x + 14, y: at.y });
  await page.waitForTimeout(700);
  expect(await items.count()).toBe(0);
  await f.move({ x: at.x + 60, y: at.y });
  await f.up();

  // WebKit clicks the link as a held finger lifts, unless its touchend is prevented.
  await page.evaluate(() => addEventListener("touchend", (e) => ((window as unknown as { kept: boolean }).kept = e.defaultPrevented)));
  await f.down(at);
  await items.first().waitFor({ timeout: 1_000 });
  await f.up();
  expect(await items.allInnerTexts()).toEqual(["置顶", "开新对话", "改名", "切到终端", "归档"]);
  const menu = (await page.getByRole("menu").boundingBox())!;
  expect([Math.abs(menu.x - at.x) < 2, Math.abs(menu.y - at.y) < 2, await page.evaluate(() => (window as unknown as { kept: boolean }).kept)]).toEqual([true, true, true]);
  await page.keyboard.press("Escape");
  await items.first().waitFor({ state: "detached" });

  await page.touchscreen.tap(at.x, at.y);
  await until(() => new URL(page.url()).hash === `#/slot/${finished}`);
  expect(await items.count()).toBe(0);
  await page.context().close();
});

smoke("#504: on Android, whose long press is a right click too, coming before the row's own or after it, on the menu by then, or as the finger lifts, as on Windows, the menu opens once and stays, and the browser's own does not", async () => {
  const page = await open();
  const { at } = await fingerOn(page, finished);
  const f = await finger(page);
  for (const [ms, lifted] of [[300, false], [800, false], [800, true]] as const) {
    await f.down(at);
    await page.waitForTimeout(ms);
    if (lifted) await f.up();
    // The browser's own, on what is under the finger, which shows its menu unless prevented.
    const prevented = await page.evaluate(({ x, y }) => !document.elementFromPoint(x, y)!.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: x, clientY: y })), at);
    await page.waitForTimeout(1000 - ms);
    if (!lifted) await f.up();
    expect([ms, lifted, prevented, await page.getByRole("menu").count(), new URL(page.url()).hash]).toEqual([ms, lifted, true, 1, ""]);
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
  }
  // Closed, a right click elsewhere is the browser's again.
  expect(await page.evaluate(() => document.body.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })))).toBe(true);
  await page.context().close();
});

smoke("stories 536, 537: an archived headless slot's 更多 has 删除, an archived TUI one's not; 删除 asks first; sure, its chat, open in maximize mode, closes; its row in the sidebar has the same menu as on the list", async () => {
  const tui = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "tuibin", dir: "/w", mode: "tui", state: "off", lifetime: "longterm", archivedAt: Date.now() }).id);
  const page = await open(`/slot/${tui}?full`, undefined, wide());
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "恢复" }).waitFor();
  expect(await page.getByRole("menuitem").allInnerTexts()).not.toContain("删除");
  await page.keyboard.press("Escape");
  const old = binned("binned2");
  await page.evaluate((h) => void (location.hash = h), `#/slot/${old}?full`);
  await page.getByRole("navigation", { name: "槽位" }).locator(`a[href$="/slot/${old}?full"]`).click({ button: "right" });
  const items = page.getByRole("menuitem");
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["恢复", "删除"]);
  await page.keyboard.press("Escape");
  await items.first().waitFor({ state: "detached" });
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  answer = removes(old, "w/binned2");
  await page.getByRole("alertdialog").getByRole("button", { name: "删除" }).click();
  await until(() => new URL(page.url()).hash === "#/");
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("story 537: 删除 in a chat opened from the topology goes back there, archived slots still shown", async () => {
  const old = binned("binned3");
  const page = await open(`/topology/ws/${ws}`, undefined, wide());
  const shown = page.getByRole("button", { name: "显示已归档" });
  await shown.click();
  await node(page, "slot", "binned3").click();
  await sheetOf(page).getByRole("button", { name: /打开槽位/ }).click();
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "删除" }).click();
  answer = removes(old, "w/binned3");
  await page.getByRole("alertdialog").getByRole("button", { name: "删除" }).click();
  await page.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
  expect(await shown.getAttribute("aria-pressed")).toBe("true");
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  await page.context().close();
});

smoke("story 271: a slot's details on the topology hold what its chat has, a mouse picking from it as a finger does; on a wide screen a right click on the slot opens the same", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  const page = await open(`/topology/slot/${works}`);
  await sheetOf(page).getByRole("button", { name: "操作" }).click();
  const items = page.getByRole("menuitem");
  await items.first().waitFor();
  expect(await items.allInnerTexts()).toEqual(["停下这一回合", "停掉进程", "切到终端", "归档"]);
  answer = async () => ({ ok: false, error: "w/works 还在启动，过几秒再试。" });
  await page.getByRole("menuitem", { name: "停掉进程" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["stop", works] });
  await page.getByRole("status").getByText("w/works 还在启动，过几秒再试。").waitFor();
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  // The toast, which stays, is over the canvas, not the sheet.
  await sheetOf(page).getByRole("button", { name: "操作" }).click({ timeout: 2_000 });
  await page.getByRole("menuitem", { name: "停掉进程" }).waitFor();
  await page.keyboard.press("Escape");

  // A half screen's width, its details a sheet that folds: a mouse's pick is sent, the sheet stays folded.
  const half = await open(`/topology/slot/${talks}`, undefined, { viewport: { width: 960, height: 1000 } } as (typeof devices)[string]);
  const folded = sheetOf(half).getByRole("button", { name: "展开详情" });
  await folded.waitFor();
  await sheetOf(half).getByRole("button", { name: "操作" }).click();
  await half.getByRole("menuitem", { name: "停掉进程" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["stop", talks] });
  expect(await folded.isVisible()).toBe(true);

  const wide = await open(`/topology/ws/${ws}`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await node(wide, "slot", "works").click({ button: "right" });
  await wide.getByRole("menuitem", { name: "停下这一回合" }).click();
  expect(await sent()).toEqual({ kind: "common", slot: works, name: "stop" });
  // In the terminal: 收回终端, which asks first.
  await node(wide, "slot", "term").click({ button: "right" });
  await wide.getByRole("menuitem", { name: "收回终端" }).click();
  await wide.getByRole("alertdialog").getByRole("button", { name: "收回" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["release", term], sure: true });
  // Headless: 切到终端, which asks first too (story 476), cutting the turn short only if you say so.
  const asks = wide.getByRole("alertdialog");
  await node(wide, "slot", "works").click({ button: "right" });
  await wide.getByRole("menuitem", { name: "切到终端" }).click();
  await asks.getByRole("button", { name: "取消" }).click();
  await asks.waitFor({ state: "detached" });
  await wide.waitForTimeout(200);
  expect(acted.length).toBe(n);
  await node(wide, "slot", "works").click({ button: "right" });
  await wide.getByRole("menuitem", { name: "切到终端" }).click();
  await asks.getByRole("button", { name: "打断，马上切" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["tui", works, "!"] });
  await node(wide, "slot", "rests").click({ button: "right" });
  await wide.getByRole("menuitem", { name: "切到终端" }).click();
  expect(await asks.getByRole("button").allInnerTexts()).toEqual(["取消", "切换"]);
  await asks.getByRole("button", { name: "切换" }).click();
  expect(await sent()).toEqual({ kind: "rh", argv: ["tui", rests] });
});

smoke("story 476: on a computer and a phone the terminal key of an idle slot asks first: 取消 sends nothing, 切换 switches; in the terminal, the top bar's switch to the chat log asks nothing", async () => {
  for (const device of [{ viewport: { width: 1440, height: 900 } } as (typeof devices)[string], devices["Pixel 7"]]) {
    let n = acted.length;
    const page = await open(`/slot/${talks}`, undefined, device);
    const asks = page.getByRole("alertdialog");
    await page.getByRole("button", { name: "切到终端", exact: true }).click();
    expect(await asks.getByRole("button").allInnerTexts()).toEqual(["取消", "切换"]);
    await asks.getByRole("button", { name: "取消" }).click();
    await asks.waitFor({ state: "detached" });
    await page.waitForTimeout(200);
    expect(acted.length).toBe(n);
    // A turn starting with it open grows a row under it: 跑完再切 is where 切换 was, not 打断.
    await page.getByRole("button", { name: "切到终端", exact: true }).click();
    await page.waitForTimeout(250);
    const at = (await asks.getByRole("button", { name: "切换" }).boundingBox())!;
    const runs = (state: "idle" | "running") =>
      store.tx((tx) => {
        tx.update("slot", { id: talks }, { state });
        tx.append({ source: "agent", type: "slot_state", slot: talks, data: { state, mode: "headless" } });
      });
    runs("running");
    try {
      const after = (await asks.getByRole("button", { name: "跑完再切" }).boundingBox())!;
      expect([Math.abs(after.x - at.x) < 1, Math.abs(after.y - at.y) < 1]).toEqual([true, true]);
    } finally {
      runs("idle");
    }
    await asks.getByRole("button", { name: "切换" }).click();
    await until(() => acted.length === n + 1);
    expect(acted.at(-1)!.act).toEqual({ kind: "rh", argv: ["tui", talks] });
    await asks.waitFor({ state: "detached" });

    const inTerm = await open(`/slot/${term}`, undefined, device);
    await inTerm.getByRole("region", { name: "终端" }).waitFor();
    await inTerm.getByRole("button", { name: "对话记录", exact: true }).click();
    await inTerm.getByRole("log", { name: "对话" }).waitFor();
    await inTerm.getByRole("button", { name: "终端", exact: true }).click();
    await inTerm.getByRole("log", { name: "对话" }).waitFor({ state: "detached" });
    expect(await inTerm.getByRole("alertdialog").count()).toBe(0);
    await page.context().close();
    await inTerm.context().close();
  }
});

smoke("stories 477, #576: on a computer a control under the mouse shows it, the bar's keys a faint round ground; on a phone, which hovers nothing, none; where you type keeps its edge, under the mouse or focused", async () => {
  for (const [device, hovers] of [[{ viewport: { width: 1440, height: 900 } } as (typeof devices)[string], true], [devices["Pixel 7"], false]] as const) {
    const page = await open(`/slot/${talks}`, undefined, device);
    const box = page.getByRole("textbox", { name: "消息" });
    await box.waitFor();
    await box.blur();
    const card = box.locator("xpath=..");
    const looks = async () => [
      ...(await Promise.all(["切到终端", "添加图片或文件", "换 agent"].map((name) => page.getByRole("button", { name, exact: true }).evaluate((e) => getComputedStyle(e).backgroundColor)))),
      await card.evaluate((e) => getComputedStyle(e).borderTopColor),
    ];
    // Away from it all.
    await page.mouse.move(1, 1);
    await page.waitForTimeout(250);
    const rest = await looks();
    const under = [];
    for (const name of ["切到终端", "添加图片或文件", "换 agent"]) {
      await page.getByRole("button", { name, exact: true }).hover();
      await page.waitForTimeout(250);
      under.push((await looks())[under.length]);
    }
    await box.hover();
    await page.waitForTimeout(250);
    const edges = [(await looks())[3]];
    await box.focus();
    await page.waitForTimeout(250);
    edges.push((await looks())[3]);
    expect([device === devices["Pixel 7"] ? "phone" : "computer", under.map((u, i) => u !== rest[i]), edges]).toEqual([hovers ? "computer" : "phone", under.map(() => hovers), [rest[3], rest[3]]]);
    await page.context().close();
  }
});

/** Where line id ends on the screen; null while it is not drawn. */
const lineEnd = (page: Page, id: string) =>
  page.evaluate((id) => {
    const p = document.querySelector<SVGPathElement>(`.react-flow__edge[data-id="${id}"] .react-flow__edge-path`);
    const at = p?.getPointAtLength(p.getTotalLength()).matrixTransform(p.getScreenCTM()!);
    return at ? { x: at.x, y: at.y } : null;
  }, id);
/** Whether line id comes to end at the left of node, at a height inside it: a line is drawn a frame or
 *  more after what moved it shows, so this waits for it, as until does (#575). */
const endsAt = (page: Page, id: string, node: ReturnType<typeof page.locator>) =>
  until(async () => {
    const [end, box] = [await lineEnd(page, id), await node.boundingBox()];
    return !!end && !!box && Math.abs(end.x - box.x) < 3 && end.y > box.y && end.y < box.y + box.height;
  }).then(
    () => true,
    () => false,
  );

/** Where the topology draws dot k ("s:<start>" or "e:<end>") on the screen. */
const dotAt = async (page: Page, k: string) => {
  const b = (await page.locator(`[data-dot="${k}"]`).boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Taps dot k where the topology draws it. */
const tapDot = async (page: Page, k: string) => {
  const at = await dotAt(page, k);
  await page.mouse.click(at.x, at.y);
};
/** Whether line id is on the graph. */
const drawn = async (page: Page, id: string) => (await page.locator(`.react-flow__edge[data-id="${id}"]`).count()) === 1;
/** The topology with Bot q, its private chat 我 following its default w/finished, over what the store has, which has no bots; and more chats, as bindings has them, a stranger's only while it has a slot of its own. */
const editing = (bindings: () => { chat: string; slot: string; use: boolean }[], hash = `/topology/ws/${ws}`, device?: (typeof devices)[string]) =>
  open(hash, async (p) => {
    await p.route("**/api/topology", async (route) => {
      const g = await (await route.fetch({ maxRetries: 1 })).json();
      const bots = [{ id: "q", name: "q", platform: "qq", main: true, conn: "online", target: finished, avatar: null }];
      const chats = [{ id: "c1", bot: "q", kind: "private", yours: true, name: "我", main: true, avatar: null, verbose: false }];
      if (bindings().some((b) => b.chat === "c2" && b.use)) chats.push({ id: "c2", bot: "q", kind: "private", yours: false, name: "Kai", main: false, avatar: null, verbose: false });
      await route.fulfill({ json: { ...g, bots, chats, bindings: bindings().filter((b) => chats.some((c) => c.id === b.chat)) } });
    });
  }, device);

smoke("stories 307, 377, 378, 383, 384, 385, 316, 319: on a phone, editing, a chat's row then its end then a slot is a draft, sent with what it was once confirmed, and 撤销 sends it back; on its Bot's default slot it is its own pick; a Bot's line moves its default; 全部撤销 lets go", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  let bindings = [{ chat: "c1", slot: finished, use: false }];
  const page = await editing(() => bindings);
  const [atFinished, atRests, atTalks] = [node(page, "slot", "finished"), node(page, "slot", "rests"), node(page, "slot", "talks")];
  const sheet = sheetOf(page);
  await atRests.waitFor();
  // Not editing, a slot no line points at has no end; editing, every live one has.
  expect(await page.locator(`[data-dot="e:${rests}"]`).count()).toBe(0);
  await page.getByRole("button", { name: "改绑定" }).click();
  await page.locator(`[data-dot="e:${rests}"]`).waitFor();

  // Its row selects its line, its end (its Bot's) picks it up, a slot takes it: a draft, dashed blue, the link it was dark red.
  await node(page, "chat", "我").click();
  await sheet.getByRole("button", { name: "取消" }).waitFor();
  await tapDot(page, "e:q");
  await sheet.getByRole("button", { name: "放下" }).waitFor();
  await atRests.click();
  await page.getByText("改了 1 处").waitFor();
  expect(await endsAt(page, "own:c1", atRests)).toBe(true);
  await settles(() => drawn(page, "was:link:c1"), true);
  expect(await page.getByRole("button", { name: "改绑定" }).isDisabled()).toBe(true);
  answer = async () => ((bindings = [{ chat: "c1", slot: rests, use: true }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: finished, use: false }, to: rests }] });
  await page.getByText("已改 1 处。").waitFor();
  expect(await endsAt(page, "own:c1", atRests)).toBe(true);
  await settles(() => drawn(page, "was:link:c1"), false);
  expect(await page.getByRole("button", { name: "改绑定" }).isDisabled()).toBe(false);

  // 撤销 sends it back, from where it went: it follows the default again.
  answer = async () => ((bindings = [{ chat: "c1", slot: finished, use: false }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "撤销" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: rests, use: true }, to: null }] });
  await until(() => drawn(page, "link:c1"));

  // Put on the slot its Bot's default is, it picks it: a line of its own (story 383). 全部撤销 lets it go.
  await node(page, "chat", "我").click();
  await tapDot(page, "e:q");
  await atFinished.click();
  await page.getByText("改了 1 处").waitFor();
  expect(await endsAt(page, "own:c1", atFinished)).toBe(true);
  await page.getByRole("button", { name: "全部撤销" }).click();
  await page.getByText("改了 1 处").waitFor({ state: "detached" });
  await settles(async () => [await drawn(page, "own:c1"), await drawn(page, "link:c1")], [false, true]);

  // The Bot's title selects its line; its end on a slot moves its default (story 384).
  await node(page, "bot", "q").click({ position: { x: 24, y: 12 } });
  await tapDot(page, `e:${finished}`);
  await atTalks.click();
  await page.getByText("改了 1 处").waitFor();
  expect(await endsAt(page, "bot:q", atTalks)).toBe(true);
  await page.getByRole("button", { name: "全部撤销" }).click();
  expect(await endsAt(page, "bot:q", atFinished)).toBe(true);

  // Not editing, the Bot's details have its chat, whose tool lines switch from there.
  await page.getByRole("button", { name: "改绑定" }).click();
  await node(page, "bot", "q").click({ position: { x: 24, y: 12 } });
  await sheet.getByRole("button", { name: "展开详情" }).click();
  await sheet.getByRole("button", { name: "详细工具行" }).click();
  expect(await sent()).toEqual({ kind: "verbose", chat: "c1", on: true });
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("story 380: on a wide screen with a slot's chat beside the topology, which has no card, what is selected while editing shows under the graph", async () => {
  const page = await editing(() => [{ chat: "c1", slot: finished, use: false }], `/topology/slot/${finished}?chat`, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  await page.getByRole("button", { name: "改绑定" }).click();
  await node(page, "chat", "我").click();
  await page.getByRole("button", { name: "取消" }).click();
  await page.getByRole("button", { name: "取消" }).waitFor({ state: "detached" });
});

/** A finger on the page, as Chromium has a touch screen's: down, moved to a place in steps a few ms apart, up. */
const finger = async (page: Page) => {
  const cdp = await page.context().newCDPSession(page);
  let at = { x: 0, y: 0 };
  const send = (type: "touchStart" | "touchMove" | "touchEnd", to?: { x: number; y: number }) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: to ? [{ x: to.x, y: to.y }] : [] });
  return {
    down: (to: { x: number; y: number }) => ((at = to), send("touchStart", to)),
    move: async (to: { x: number; y: number }) => {
      const from = at;
      for (let i = 1; i <= 8; i++) await send("touchMove", (at = { x: from.x + ((to.x - from.x) * i) / 8, y: from.y + ((to.y - from.y) * i) / 8 }));
    },
    up: () => send("touchEnd"),
  };
};
const camera = (page: Page) => page.locator(".react-flow__viewport").getAttribute("style");

smoke("stories 381, 382: on a phone, editing, a finger moved at once from a start pans; held 0.3 s on it, then on a slot, it previews the line there and lets go a draft; so from a slot's end back to a start", async () => {
  const page = await editing(() => [{ chat: "c1", slot: finished, use: false }]);
  const atRests = node(page, "slot", "rests");
  await atRests.waitFor();
  await page.getByRole("button", { name: "改绑定" }).click();
  await page.locator(`[data-dot="e:${rests}"]`).waitFor();
  const f = await finger(page);

  // Moved at once: the graph pans, nothing is drawn.
  const was = await camera(page);
  const start = await dotAt(page, "s:c1");
  await f.down(start);
  await f.move({ x: start.x, y: start.y - 60 });
  await f.up();
  await until(async () => (await camera(page)) !== was);
  expect(await page.getByText("改了 1 处").count()).toBe(0);
  // And back, from where it went.
  await f.down({ x: start.x, y: start.y - 60 });
  await f.move(start);
  await f.up();
  await until(async () => (await camera(page)) === was);

  // Held, then moved to rests: the line to it previewed, its link faded; let go, a draft.
  const [from, to, still] = [await dotAt(page, "s:c1"), await dotAt(page, `e:${rests}`), await camera(page)];
  await f.down(from);
  await page.waitForTimeout(400);
  await f.move(to);
  await page.locator(`[data-preview="${rests}"]`).waitFor();
  expect(await camera(page)).toBe(still);
  await f.up();
  await page.getByText("改了 1 处").waitFor();
  expect(await endsAt(page, "own:c1", atRests)).toBe(true);
  expect(await page.locator("[data-preview]").count()).toBe(0);
  await page.getByRole("button", { name: "全部撤销" }).click();

  // Back: held on rests's end, then on the chat's start, its line goes to rests.
  const [end, chat] = [await dotAt(page, `e:${rests}`), await dotAt(page, "s:c1")];
  await f.down(end);
  await page.waitForTimeout(400);
  await f.move(chat);
  await page.locator(`[data-preview="c1"]`).waitFor();
  await f.up();
  await page.getByText("改了 1 处").waitFor();
  expect(await endsAt(page, "own:c1", atRests)).toBe(true);
});

smoke("stories 381, 382: on a wide screen a mouse draws from a start at once, the graph still; let go elsewhere, nothing; from its Bot's end back to a chat with a slot of its own, the chat follows the default", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  let bindings = [{ chat: "c1", slot: finished, use: false }];
  const page = await editing(() => bindings, `/topology/ws/${ws}`, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const atRests = node(page, "slot", "rests");
  await atRests.waitFor();
  await page.getByRole("button", { name: "改绑定" }).click();
  await page.locator(`[data-dot="e:${rests}"]`).waitFor();
  const was = await camera(page);
  const drag = async (a: { x: number; y: number }, b: { x: number; y: number }, preview?: string) => {
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    if (preview) await page.locator(`[data-preview="${preview}"]`).waitFor();
    await page.mouse.up();
  };
  // Let go on nothing it can go to: nothing changes, the line stays selected.
  const from = await dotAt(page, "s:c1");
  await drag(from, { x: from.x + 40, y: from.y + 300 });
  await sheetOf(page).getByRole("button", { name: "取消" }).waitFor();
  expect(await page.getByText("改了 1 处").count()).toBe(0);
  // A tap on the blank straight after is a tap: the line let go of.
  await drag(from, { x: from.x + 40, y: from.y + 300 });
  await page.mouse.click(20, 880);
  await sheetOf(page).getByRole("button", { name: "取消" }).waitFor({ state: "detached" });
  // Esc while drawing lets go of it: let go on rests then, nothing changes.
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((await dotAt(page, `e:${rests}`)).x, (await dotAt(page, `e:${rests}`)).y, { steps: 8 });
  await page.locator(`[data-preview="${rests}"]`).waitFor();
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await page.getByText("改了 1 处").count()).toBe(0);
  await drag(from, await dotAt(page, `e:${rests}`), rests);
  await page.getByText("改了 1 处").waitFor();
  expect(await camera(page)).toBe(was);
  expect(await endsAt(page, "own:c1", atRests)).toBe(true);
  answer = async () => ((bindings = [{ chat: "c1", slot: rests, use: true }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: finished, use: false }, to: rests }] });
  await page.getByText("已改 1 处。").waitFor();

  // From its Bot's end to the chat now with a slot of its own: back to following the default.
  await drag(await dotAt(page, "e:q"), await dotAt(page, "s:c1"), "c1");
  await page.getByText("改了 1 处").waitFor();
  answer = async () => ((bindings = [{ chat: "c1", slot: finished, use: false }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: rests, use: true }, to: null }] });
  await until(() => drawn(page, "link:c1"));
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("stories 315, 380, 386: a draft changed elsewhere since is red with a mark at its start, and 确认 waits; with a batch out, a tap does nothing; a stranger's chat put back on its Bot's end leaves the graph, and 撤销 brings it back", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  let bindings = [{ chat: "c1", slot: finished, use: false }];
  const page = await editing(() => bindings);
  const [atRests, atTalks] = [node(page, "slot", "rests"), node(page, "slot", "talks")];
  const sheet = sheetOf(page);
  await atRests.waitFor();
  await page.getByRole("button", { name: "改绑定" }).click();

  // A draft to rests; another tab then puts the chat there itself: a mark at its start, and 确认 waits.
  await node(page, "chat", "我").click();
  await tapDot(page, "e:q");
  await atRests.click();
  await page.getByText("改了 1 处").waitFor();
  bindings = [{ chat: "c1", slot: rests, use: true }];
  store.tx((tx) => tx.append({ source: "rh", type: "slot_renamed", slot: talks, data: { n: -1 } }));
  await page.getByRole("img", { name: "冲突" }).waitFor();
  expect(await page.getByRole("button", { name: "确认" }).isDisabled()).toBe(true);
  await page.getByRole("button", { name: "全部撤销" }).click();

  // An end tapped with one line into it selects that line.
  await tapDot(page, `e:${rests}`);
  await sheet.getByRole("button", { name: "取消" }).waitFor();
  await tapDot(page, `e:${rests}`);
  await sheet.getByRole("button", { name: "放下" }).waitFor();
  await atTalks.click();
  // With a batch out, a tap does nothing.
  let reply!: (r: RhReply) => void;
  answer = () => new Promise((r) => (reply = r));
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: rests, use: true }, to: talks }] });
  await node(page, "chat", "我").click();
  expect(await sheet.getByRole("button", { name: "取消" }).count()).toBe(0);
  bindings = [{ chat: "c1", slot: talks, use: true }];
  reply({ ok: true, text: "已改 1 处。" });
  await page.getByText("已改 1 处。").waitFor();

  // A stranger's chat with a slot of its own, put back on its Bot's end: once made, it is gone; 撤销 brings it back.
  bindings = [{ chat: "c1", slot: finished, use: false }, { chat: "c2", slot: talks, use: true }];
  store.tx((tx) => tx.append({ source: "rh", type: "slot_renamed", slot: talks, data: { n: -2 } }));
  await node(page, "chat", "Kai").click();
  await tapDot(page, `e:${talks}`);
  await tapDot(page, "e:q");
  await page.getByText("改了 1 处").waitFor();
  await settles(() => drawn(page, "link:c2"), true);
  answer = async () => ((bindings = [{ chat: "c1", slot: finished, use: false }, { chat: "c2", slot: finished, use: false }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c2", from: { slot: talks, use: true }, to: null }] });
  await node(page, "chat", "Kai").waitFor({ state: "detached" });
  answer = async () => ((bindings = [{ chat: "c1", slot: finished, use: false }, { chat: "c2", slot: talks, use: true }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "撤销" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c2", from: { slot: finished, use: false }, to: talks }] });
  await node(page, "chat", "Kai").waitFor();
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("stories 379, 385: on a phone, editing, a chat's start picked up and another chat tapped swaps their slots, two changes in one step; 撤销一步 brings the draft back as it was before that step", async () => {
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, acted.at(-1)!.act);
  // 我 follows q's default, finished; Kai picked rests.
  let bindings = [{ chat: "c1", slot: finished, use: false }, { chat: "c2", slot: rests, use: true }];
  const page = await editing(() => bindings);
  const [atFinished, atRests, atTalks] = [node(page, "slot", "finished"), node(page, "slot", "rests"), node(page, "slot", "talks")];
  const sheet = sheetOf(page);
  await atRests.waitFor();
  await page.getByRole("button", { name: "改绑定" }).click();

  // 我's start picked up, Kai tapped: each picks the slot the other reached.
  await node(page, "chat", "我").click();
  await tapDot(page, "s:c1");
  await sheet.getByRole("button", { name: "放下" }).waitFor();
  await node(page, "chat", "Kai").click();
  await page.getByText("改了 2 处").waitFor();
  expect([await endsAt(page, "own:c1", atRests), await endsAt(page, "own:c2", atFinished)]).toEqual([true, true]);
  // 撤销一步 takes back both.
  await page.getByRole("button", { name: "撤销一步" }).click();
  await page.getByText("改了 2 处").waitFor({ state: "detached" });
  await settles(() => drawn(page, "link:c1"), true);
  expect(await endsAt(page, "own:c2", atRests)).toBe(true);

  // 我 to talks, then swapped with Kai by their dots: 撤销一步 leaves 我 on talks, Kai on rests, which 确认 sends.
  await node(page, "chat", "我").click();
  await tapDot(page, "e:q");
  await atTalks.click();
  await page.getByText("改了 1 处").waitFor();
  await node(page, "chat", "我").click();
  await tapDot(page, "s:c1");
  await tapDot(page, "s:c2");
  await page.getByText("改了 2 处").waitFor();
  expect([await endsAt(page, "own:c1", atRests), await endsAt(page, "own:c2", atTalks)]).toEqual([true, true]);
  await page.getByRole("button", { name: "撤销一步" }).click();
  await page.getByText("改了 1 处").waitFor();
  expect([await endsAt(page, "own:c1", atTalks), await endsAt(page, "own:c2", atRests)]).toEqual([true, true]);
  answer = async () => ((bindings = [{ chat: "c1", slot: talks, use: true }, { chat: "c2", slot: rests, use: true }]), { ok: true, text: "已改 1 处。" });
  await page.getByRole("button", { name: "确认" }).click();
  expect(await sent()).toEqual({ kind: "bind", changes: [{ chat: "c1", from: { slot: finished, use: false }, to: talks }] });
  await page.getByText("已改 1 处。").waitFor();
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("stories 264, 289, 293: on a phone a choice's card answers with a tap and goes; its stop key stops the turn; one answered elsewhere, or whose answer is turned down, leaves a line saying so that goes by itself", async () => {
  const ask = (question: string) =>
    store.tx((tx) => {
      const options = [{ label: "staging" }, { label: "production" }];
      const id = tx.insert("ask", { slot: asking, kind: "question", status: "open", prompt: JSON.stringify({ tool: "AskUserQuestion", input: { questions: [{ question, options }] } }), deadline: null }).id;
      tx.append({ source: "agent", type: "ask", slot: asking, data: { ask: id, kind: "question" } });
      return id;
    });
  const settle = (id: string, by: string) =>
    store.tx((tx) => {
      tx.update("ask", { id }, { status: "answered", answeredBy: by });
      tx.append({ source: "im", type: "ask_answered", slot: asking, data: { ask: id, by } });
    });
  const first = ask("部署到哪个环境？");
  const page = await open(`/slot/${asking}`);
  const card = page.getByRole("region", { name: "选择题" });
  await card.getByText("部署到哪个环境？").waitFor();
  for (const name of ["staging", "停止"]) {
    const box = (await card.getByRole("button", { name }).boundingBox())!;
    expect([name, box.width >= 44 && box.height >= 44]).toEqual([name, true]);
  }
  // The stop key is on the card, the bar gone: an ask waiting does not keep the turn from stopping.
  const before = acted.length;
  await card.getByRole("button", { name: "停止" }).click();
  await until(() => acted.length === before + 1);
  expect(acted.at(-1)!.act).toEqual({ kind: "common", slot: asking, name: "stop" });

  answer = async () => (settle(first, "web"), { ok: true, text: "已回答：staging。" });
  await card.getByRole("button", { name: "staging" }).click();
  await page.getByRole("status").getByText("已回答：staging。").waitFor();
  await card.waitFor({ state: "detached" });
  expect(acted.at(-1)!.act).toEqual({ kind: "answer", ask: first, text: "1" });
  // The page that answered it says nothing more of it.
  expect(await page.getByText("已在网页回答").count()).toBe(0);

  // Answered elsewhere while it shows: in its place, where.
  const second = ask("推到哪？");
  await card.getByText("推到哪？").waitFor();
  settle(second, "timeout");
  const timedOut = page.getByText("已超时", { exact: true });
  await timedOut.waitFor();
  expect(await card.count()).toBe(0);
  await timedOut.waitFor({ state: "detached" });

  // An answer that fails, the ask still open: the card stays, your words in it, and the error shows.
  const third = ask("哪个分支？");
  await card.getByText("哪个分支？").waitFor();
  answer = async () => ({ ok: false, error: "连不上 Rhodium。" });
  await card.getByLabel("自己写").fill("先不推");
  await card.getByRole("button", { name: "发送" }).click();
  await page.getByRole("status").getByText("连不上 Rhodium。").waitFor();
  expect(await card.getByLabel("自己写").inputValue()).toBe("先不推");
  expect(await page.getByText("连不上 Rhodium。").count()).toBe(1);

  // An answer turned down, as one answered in QQ a moment before: in its place, where.
  answer = async () => ({ ok: false, error: "已在 QQ 私聊回答", gone: true });
  await card.getByRole("button", { name: "production" }).click();
  await page.getByText("已在 QQ 私聊回答", { exact: true }).waitFor();
  expect(await card.count()).toBe(0);
  settle(third, "im");
  answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
});

smoke("stories 272, 273, 277, 280: what you type to an idle slot goes with the send key, shows at once as yours, faint, and is the transcript's once it is there; what you have not sent stays when the page loads again", async () => {
  const { slot, transcript } = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "talk", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot, agent: "pi", sessionId: "t7", startedAt: Date.now() }).id;
    tx.update("slot", { id: slot }, { conversation });
    return { slot, transcript: join(talked, "../2026-10-23_t7.jsonl") };
  });
  writeFileSync(transcript, said("user", "q") + said("assistant", "a"));
  answer = async () => ({ ok: true, text: "开始新回合" });
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const send = page.getByRole("button", { name: "发送" });
    expect(await send.isDisabled()).toBe(true);
    const tap = (await send.boundingBox())!;
    expect(tap.width >= 44 && tap.height >= 44).toBe(true);
    await box.fill("写了一半");
    await page.reload();
    expect(await box.inputValue()).toBe("写了一半");
    await box.fill("还有一件事\n顺便看看日志");
    await send.click();
    const faint = page.locator(".opacity-60", { hasText: "还有一件事" });
    await faint.waitFor();
    await until(() => acted.at(-1)?.act !== undefined && JSON.stringify(acted.at(-1)!.act).includes("还有一件事"));
    expect(acted.at(-1)!.act).toEqual({ kind: "say", slot, text: "还有一件事\n顺便看看日志" });
    expect(await box.inputValue()).toBe("");
    // The agent read it: the transcript's bubble takes its place, with no source on it.
    appendFileSync(transcript, said("user", "[来自 网页]\n还有一件事\n顺便看看日志") + said("assistant", "好的"));
    store.tx((tx) => tx.append({ source: "rh", type: "final_reply", slot }));
    await page.getByText("好的").waitFor();
    await faint.waitFor({ state: "detached" });
    expect(await page.getByText("还有一件事").count()).toBe(1);
    expect(await page.getByText("网页").count()).toBe(0);

    // One turned away is red, why under it, with a retry, which sends it again under the same id.
    answer = async () => ({ ok: false, error: "w/talk 有提问在等你，先答提问。" });
    await box.fill("再来");
    await send.click();
    await page.getByRole("button", { name: "重试" }).waitFor();
    await page.getByRole("log").getByText("w/talk 有提问在等你，先答提问。").waitFor();
    const id = acted.at(-1)!.id;
    answer = async () => ({ ok: true, text: "开始新回合" });
    await page.getByRole("button", { name: "重试" }).click();
    await page.locator(".opacity-60", { hasText: "再来" }).waitFor();
    expect(acted.at(-1)!.id).toBe(id);
    expect(await page.getByText("w/talk 有提问在等你，先答提问。").count()).toBe(0);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("story 511: on a computer, a right click on the send key picks Ctrl+Enter, ⌘ Enter on a Mac, or Enter to send, the one now ticked, kept on this device; with Enter, Ctrl, ⌘ or Shift with it makes a new line at the caret, an input method's Enter and an empty box send nothing, not even a stop while a turn runs, and the palette's Enter still picks; storage that cannot be used keeps the default", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "keys", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  answer = async () => ({ ok: true, text: "开始新回合" });
  let n = acted.length;
  const sent = async () => (await until(() => acted.length === n + 1), n++, (acted.at(-1)!.act as { text: string }).text);
  try {
    const page = await open(`/slot/${slot}`, undefined, wide());
    const box = page.getByRole("textbox", { name: "消息" });
    const nothing = async () => (await page.waitForTimeout(200), expect(acted.length).toBe(n));
    // Empty, the key takes no press, but a right click still opens its menu: Firefox sends none to a disabled button.
    expect(await page.getByRole("button", { name: "发送" }).evaluate((b) => (b as HTMLButtonElement).disabled)).toBe(false);
    const menu = async () => (await page.getByRole("button", { name: "发送" }).click({ button: "right", force: true }), await page.getByRole("menuitem").first().waitFor());
    const ticked = () => page.getByRole("menuitem").filter({ has: page.getByLabel("现在") }).allInnerTexts();
    // At first, as before: Enter makes a new line, Ctrl+Enter sends, but not with nothing to send.
    await box.press("Control+Enter");
    await nothing();
    await box.fill("a");
    await box.press("Enter");
    expect(await box.inputValue()).toBe("a\n");
    await nothing();
    await box.press("Control+Enter");
    expect(await sent()).toBe("a");
    await menu();
    expect(await page.getByRole("menuitem").allInnerTexts()).toEqual(["Ctrl+Enter 发送", "Enter 发送"]);
    expect(await ticked()).toEqual(["Ctrl+Enter 发送"]);
    await page.getByRole("menuitem", { name: /^Enter 发送/ }).click();
    // Enter sends; with Ctrl, ⌘ or Shift, a new line where the caret is. Picked, the caret is back in the box.
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.keyboard.type("bc");
    expect(await box.inputValue()).toBe("bc");
    await box.press("ArrowLeft");
    for (const k of ["Control+Enter", "Meta+Enter", "Shift+Enter"]) await box.press(k);
    expect(await box.inputValue()).toBe("b\n\n\nc");
    await box.dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await nothing();
    await box.press("Enter");
    expect(await sent()).toBe("b\n\n\nc");
    await box.press("Enter");
    expect(await box.inputValue()).toBe("");
    await nothing();
    await box.fill("/压缩");
    await page.getByRole("listbox", { name: "命令" }).waitFor();
    await box.press("Enter");
    expect(await sent()).toBe("/compact");
    // Kept on this device.
    await page.reload();
    await box.fill("d");
    await box.press("Enter");
    expect(await sent()).toBe("d");
    await menu();
    expect(await ticked()).toEqual(["Enter 发送"]);
    await page.keyboard.press("Escape");
    // Where storage cannot be used, the default; picked, Enter sends on this page.
    await page.addInitScript(() =>
      Object.defineProperty(window, "localStorage", {
        get: () => {
          throw new DOMException("", "SecurityError");
        },
      }),
    );
    await page.reload();
    await box.fill("e");
    await box.press("Enter");
    expect(await box.inputValue()).toBe("e\n");
    await nothing();
    await menu();
    expect(await ticked()).toEqual(["Ctrl+Enter 发送"]);
    await page.getByRole("menuitem", { name: /^Enter 发送/ }).click();
    await box.press("Enter");
    expect(await sent()).toBe("e");
    // On a Mac, ⌘ is what the menu says. While a turn runs, Enter in an empty box does not stop it.
    const mac = await open(`/slot/${works}`, async (p) => void (await p.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }))), wide());
    await mac.getByRole("button", { name: "停止" }).click({ button: "right" });
    await mac.getByRole("menuitem").first().waitFor();
    expect(await mac.getByRole("menuitem").allInnerTexts()).toEqual(["⌘ Enter 发送", "Enter 发送"]);
    await mac.getByRole("menuitem", { name: /^Enter 发送/ }).click();
    await mac.getByRole("menu").waitFor({ state: "detached" });
    await mac.keyboard.press("Enter");
    await mac.waitForTimeout(200);
    expect(acted.length).toBe(n);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("story 279: a command turned away goes back where you typed it, unless you typed something else while it went", async () => {
  const page = await open(`/slot/${rests}`);
  const box = page.getByRole("textbox", { name: "消息" });
  const send = page.getByRole("button", { name: "发送" });
  let reply!: (r: RhReply) => void;
  answer = () => new Promise((r) => (reply = r));
  const turnedAway = async () => {
    const before = acted.length;
    await send.click();
    await until(() => acted.length === before + 1);
    expect(await box.inputValue()).toBe("");
  };
  try {
    await box.fill("/context");
    await turnedAway();
    reply({ ok: false, error: "看板还不能发 /context。" });
    await page.getByRole("status").getByText("看板还不能发 /context。").first().waitFor();
    await until(async () => (await box.inputValue()) === "/context");
    await turnedAway();
    await box.fill("别的话");
    reply({ ok: false, error: "看板还不能发 /context。" });
    await until(async () => (await page.getByRole("status").getByText("看板还不能发 /context。").count()) === 2);
    expect(await box.inputValue()).toBe("别的话");
    await page.reload();
    expect(await box.inputValue()).toBe("别的话");
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("stories 294, 296, 297, 299, 300, 301, #289: / brings up the slot's commands over where you type, as wide, no rh_ one; typed on, fewer; one picked goes as typed, one with a list shows it in a sheet, whose pick goes as typed too", async () => {
  // Rhodium answers each command as the router would.
  const replies: Record<string, RhReply> = {
    "/compact": { ok: true, text: "已压缩上下文。" },
    "/model": { ok: true, text: "换哪个模型？\n现在：Opus", panel: { head: ["换哪个模型？", "现在：Opus"], candidates: [{ label: "Opus", command: "/model opus", current: true }, { label: "Haiku", command: "/model haiku" }] } },
    "/model haiku": { ok: true, text: "已切到 Haiku。" },
    "/resume": { ok: true, text: "回到哪段对话？", panel: { head: ["回到哪段对话？"], candidates: [{ label: "09:10 修登录", command: "/resume s1" }, { label: "昨天 22:10 写文档", command: "/resume s2", current: true }] } },
    "/resume s1": { ok: true, text: "已回到 修登录 那段对话。" },
    "/resume s2": { ok: true, text: "已回到 写文档 那段对话。" },
  };
  answer = async () => replies[(acted.at(-1)!.act as { text: string }).text]!;
  const sent = () => (acted.at(-1)!.act as { text: string }).text;
  try {
    const page = await open(`/slot/${rests}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const palette = page.getByRole("listbox", { name: "命令" });
    await box.fill("/");
    await palette.getByRole("option", { name: /^\/compact/ }).waitFor();
    expect((await palette.getByRole("option").allTextContents()).filter((t) => t.startsWith("/rh_"))).toEqual([]);
    const [p, b] = [(await palette.boundingBox())!, (await box.locator("xpath=..").boundingBox())!];
    expect([p.x, p.width]).toEqual([b.x, b.width]);
    expect(p.y + p.height).toBeLessThanOrEqual(b.y);
    // Typed on, fewer: Chinese finds a command by what it does. Enter picks it, and it runs.
    await box.fill("/压缩");
    expect(await palette.getByRole("option").allTextContents()).toEqual(["/compact压缩上下文"]);
    await box.press("Enter");
    await page.getByRole("status").getByText("已压缩上下文。").waitFor();
    expect([sent(), await box.inputValue()]).toEqual(["/compact", ""]);
    // Esc closes it.
    await box.fill("/mo");
    await palette.waitFor();
    await box.press("Escape");
    await palette.waitFor({ state: "detached" });
    // Closed on / alone, then wiped and / again: it is back.
    await box.fill("/");
    await palette.waitFor();
    await box.press("Escape");
    await palette.waitFor({ state: "detached" });
    await box.fill("");
    await box.fill("/");
    await palette.waitFor();
    // Typed on, it is back. One to pick from: the sheet, the one now ticked; tapped, a pick goes as
    // typed, and the sheet goes.
    await box.fill("/resu");
    await palette.getByRole("option", { name: /^\/resume/ }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByText("回到哪段对话？").waitFor();
    await sheet.getByRole("button", { name: /写文档/ }).getByLabel("现在").waitFor();
    // Where you type keeps the keyboard (story 389), not the sheet's first pick, which would look picked beside the tick.
    expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-label"))).toBe("消息");
    await sheet.getByRole("button", { name: "昨天 22:10 写文档" }).click();
    await page.getByRole("status").getByText("已回到 写文档 那段对话。").waitFor();
    await sheet.waitFor({ state: "detached" });
    expect(sent()).toBe("/resume s2");
    // No rh_ one, however typed: the palette closes.
    await box.fill("/rh_re");
    await palette.waitFor({ state: "detached" });
    // /resume with a word: the conversations that have it.
    await box.fill("/resume 登录");
    await page.getByRole("button", { name: "发送" }).click();
    await sheet.getByText("回到哪段对话？").waitFor();
    // Its candidates, ✕ aside.
    expect((await sheet.getByRole("button").allTextContents()).filter(Boolean)).toEqual(["09:10 修登录"]);
    // Picked, it goes back to that conversation.
    await sheet.getByRole("button", { name: "09:10 修登录" }).click();
    await page.getByRole("status").getByText("已回到 修登录 那段对话。").waitFor();
    expect(acted.slice(-2).map((a) => (a.act as { text: string }).text)).toEqual(["/resume", "/resume s1"]);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

/** Rhodium's answers to /context, the first 19% used, Claude's with what holds it; the next 96%, pi's
 *  with nothing on what holds it; and to /compact, a receipt. */
function contextAnswers(): () => Promise<RhReply> {
  let n = 0;
  return async () => {
    const text = (acted.at(-1)!.act as { text: string }).text;
    if (text === "/compact") return { ok: true, text: "已压缩上下文。" };
    if (n++) return { ok: true, text: "上下文", card: { command: "context", usedTokens: 960_000, maxTokens: 1_000_000 } };
    return { ok: true, text: "上下文", card: { command: "context", usedTokens: 186_000, maxTokens: 1_000_000, categories: [{ name: "消息", tokens: 132_000 }] } };
  };
}

smoke("stories 387, 389, 390, 400: on a phone /context is an info card over where you type, its parts a tap away; the next answer takes its place, Esc closes it, and /compact's receipt is a toast", async () => {
  answer = contextAnswers();
  try {
    const page = await open(`/slot/${rests}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const card = page.getByRole("dialog", { name: "上下文" });
    await box.fill("/context");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByText("186k / 1M").waitFor();
    const [c, b] = [(await card.boundingBox())!, (await box.locator("xpath=..").boundingBox())!];
    expect([c.x, c.width]).toEqual([b.x, b.width]);
    expect(c.y + c.height).toBeLessThanOrEqual(b.y);
    // Its parts, tapped.
    await card.getByRole("button", { name: "分项" }).click();
    await card.getByText("消息").waitFor();
    // Open, where you type still takes words, and the next answer takes its place, one with no parts
    // (pi's) too, though the last was unfolded.
    await box.fill("/context");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByText("960k / 1M").waitFor();
    expect(await card.getByText("96%").evaluate((e) => getComputedStyle(e).color)).not.toBe(await card.getByText("960k / 1M").evaluate((e) => getComputedStyle(e).color));
    // Esc shuts the commands / brings up first, and only then the card.
    await box.fill("/");
    await page.getByRole("listbox").waitFor();
    await box.press("Escape");
    await page.getByRole("listbox").waitFor({ state: "detached" });
    expect(await card.count()).toBe(1);
    await box.press("Escape");
    await card.waitFor({ state: "detached" });
    // A tap on the transcript closes it too.
    await box.fill("/context");
    await page.getByRole("button", { name: "发送" }).click();
    await card.waitFor();
    await page.mouse.click(200, 200);
    await card.waitFor({ state: "detached" });
    await box.fill("/compact");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("status").getByText("已压缩上下文。").waitFor();
    expect(await card.count()).toBe(0);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("story 388: on a wide screen beside the topology, the info card is in the chat's column alone, where you type still taking words", async () => {
  answer = contextAnswers();
  try {
    const page = await open(`/topology/slot/${finished}?chat`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
    const box = page.getByRole("textbox", { name: "消息" });
    const card = page.getByRole("dialog", { name: "上下文" });
    await box.fill("/context");
    await page.getByRole("button", { name: "发送" }).click();
    await card.waitFor();
    const [c, chat, graph] = [(await card.boundingBox())!, (await page.getByRole("log", { name: "对话" }).boundingBox())!, (await page.locator(".react-flow").boundingBox())!];
    expect(c.x).toBeGreaterThanOrEqual(chat.x);
    expect(c.x + c.width).toBeLessThanOrEqual(chat.x + chat.width);
    expect(c.x).toBeGreaterThanOrEqual(graph.x + graph.width);
    expect(c.height).toBeLessThanOrEqual(900 * 0.7);
    await box.fill("still typing");
    expect(await box.inputValue()).toBe("still typing");
    await card.waitFor();
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("stories 393-396: on a phone /usage is an info card over where you type, a bar for each window, the full one amber; the tokens tapped show their kinds and the cost by model", async () => {
  const tokens = { input: 1_800, output: 96_000, cacheRead: 18_200_000, cacheWrite: 612_000, total: 18_909_800 };
  answer = async () => ({
    ok: true,
    text: "用量",
    card: {
      command: "usage",
      agent: "claude",
      limits: [
        { window: "5h", usedPercent: 28, resetsAt: Date.now() + 106 * 60_000 },
        { window: "7d", usedPercent: 91, resetsAt: Date.now() + 9 * 3_600_000 },
      ],
      session: { cost: 15.35, tokens, models: [{ name: "Opus 5.5", cost: 14.92, tokens }] },
    },
  });
  try {
    const page = await open(`/slot/${rests}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const card = page.getByRole("dialog", { name: "用量" });
    await box.fill("/usage");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByText("等效 API 价格").waitFor();
    const [c, b] = [(await card.boundingBox())!, (await box.locator("xpath=..").boundingBox())!];
    expect(c.y + c.height).toBeLessThanOrEqual(b.y);
    expect(await card.getByText("91%").evaluate((e) => getComputedStyle(e).color)).not.toBe(await card.getByText("28%").evaluate((e) => getComputedStyle(e).color));
    expect(await card.getByText("缓存读").count()).toBe(0);
    await card.getByRole("button", { name: /Tokens/ }).click();
    await card.getByText("缓存读").waitFor();
    await card.getByText("Opus 5.5").waitFor();
    await card.getByText("$14.92").waitFor();
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

/** A slot named name in w with a Claude conversation, so its bar has the agent and model buttons. */
const withClaude = (name: string) =>
  store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name, dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", model: "Opus", effort: "high" }).id;
    tx.update("slot", { id: slot }, { conversation: tx.insert("conversation", { slot, agent: "claude", sessionId: `s-${name}`, startedAt: Date.now() }).id });
    return slot;
  });

/** /status's card for w/<name>, idle, its 7 days nearly full. */
const statusCard = (name: string): RhReply => ({
  ok: true,
  text: `w/${name}\n空闲`,
  card: {
    command: "status",
    model: "Opus 5.5",
    effort: "high",
    context: { usedTokens: 52_000, maxTokens: 200_000 },
    limits: [{ window: "7d", usedPercent: 91, resetsAt: Date.now() + 9 * 3_600_000 }],
    ref: `w/${name}`,
    agent: "claude",
    dir: "~/w",
    line: "空闲",
    actions: ["/model", "/compact", "/new"],
  },
});

/** Rhodium's answers to /status, its card, to /context from it, and to what the model sheet asks on opening. */
function statusAnswers(name: string): () => Promise<RhReply> {
  const panel = (head: string[], items: [string, string][], now?: string) => ({ ok: true as const, text: head.join("\n"), panel: { head, candidates: items.map(([label, command]) => ({ label, command, ...(label === now && { current: true as const }) })) } });
  const replies: Record<string, RhReply> = {
    "/status": statusCard(name),
    "/context": { ok: true, text: "已使用 26% 上下文 (~52k / 200k Tokens)", card: { command: "context", usedTokens: 52_000, maxTokens: 200_000 } },
    "/model": panel(["换哪个模型？", "现在：Opus"], [["Opus", "/model opus"], ["Haiku", "/model haiku"]], "Opus"),
    "/effort": panel(["思考强度改成哪档？"], [["low", "/effort low"], ["high", "/effort high"]], "high"),
    "/ultracode": panel(["ultracode 开还是关？"], [["开", "/ultracode on"], ["关", "/ultracode off"]], "关"),
  };
  return async () => replies[(acted.at(-1)!.act as { text: string }).text] ?? { ok: true, text: "好。" };
}
const reset = () => (answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" }));
/** What the page said to slot, in order. */
const saidTo = (slot: string) => acted.filter((a) => (a.act as { slot?: string }).slot === slot).map((a) => (a.act as { text?: string }).text);

smoke("stories 389, 391, 406: on a phone /status is the info card over where you type, in IM's sections; its 模型 opens the model sheet there, as the bar's button does; the directory tapped is copied, the context tapped opens /context", async () => {
  const slot = withClaude("picks");
  answer = statusAnswers("picks");
  try {
    const page = await open(`/slot/${slot}`, (page) => page.context().grantPermissions(["clipboard-read", "clipboard-write"]));
    const box = page.getByRole("textbox", { name: "消息" });
    const card = page.getByRole("dialog");
    const where = async () => {
      const [c, b] = [(await card.boundingBox())!, (await box.locator("xpath=..").boundingBox())!];
      expect([c.x, c.width]).toEqual([b.x, b.width]);
      expect(c.y + c.height).toBeLessThanOrEqual(b.y);
    };
    await box.fill("/status");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByRole("button", { name: "模型", exact: true }).waitFor();
    expect(await card.getAttribute("aria-label")).toBe("w/picks");
    for (const text of ["模型设置", "Claude Code", "Opus 5.5", "状态", "~/w", "26%", "额度信息", "7 天", "91%"]) await card.getByText(text, { exact: true }).waitFor();
    expect(await card.getByRole("button", { name: "停止" }).count()).toBe(0);
    await where();
    // 模型: the model sheet, with the levels and ultracode, in the card's place; not /model's list.
    await card.getByRole("button", { name: "模型", exact: true }).click();
    await card.getByRole("slider", { name: "思考强度" }).waitFor();
    await card.getByRole("switch", { name: "ultracode" }).waitFor();
    expect(await card.getAttribute("aria-label")).toBe("模型");
    expect(await page.getByText("换哪个模型？").count()).toBe(0);
    await where();
    expect(saidTo(slot).slice(0, 1)).toEqual(["/status"]);
    expect(saidTo(slot).slice(1).toSorted()).toEqual(["/effort", "/model", "/ultracode"]);
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
    // The directory, copied; the context, /context's card in its place.
    await box.fill("/status");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByRole("button", { name: /^目录/ }).click();
    await page.getByRole("status").getByText("已复制目录。").waitFor();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("~/w");
    await card.getByRole("button", { name: /^上下文/ }).click();
    await page.getByRole("dialog", { name: "上下文" }).getByText("52k / 200k").waitFor();
    expect(saidTo(slot).at(-1)).toBe("/context");
    // The bar's button: the same card, in the same place, which the agent's takes over.
    await page.keyboard.press("Escape");
    await card.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "模型和思考强度" }).click();
    await card.getByRole("group", { name: "思考强度" }).waitFor();
    await where();
    await page.getByRole("button", { name: "换 agent" }).click();
    await card.getByRole("button", { name: /Claude/ }).getByLabel("现在").waitFor();
    expect(await card.count()).toBe(1);
    await where();
  } finally {
    reset();
  }
});

smoke("stories 388, 389, 391: on a wide screen beside the topology, /status, the model sheet from its 模型 and the agent sheet are in the chat's column alone; where you type still takes words", async () => {
  const slot = withClaude("wide-picks");
  answer = statusAnswers("wide-picks");
  try {
    const page = await open(`/topology/slot/${slot}?chat`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
    const box = page.getByRole("textbox", { name: "消息" });
    const card = page.getByRole("dialog");
    const inChat = async () => {
      const [c, chat, graph] = [(await card.boundingBox())!, (await page.getByRole("log", { name: "对话" }).boundingBox())!, (await page.locator(".react-flow").boundingBox())!];
      expect(c.x).toBeGreaterThanOrEqual(chat.x);
      expect(c.x + c.width).toBeLessThanOrEqual(chat.x + chat.width);
      expect(c.x).toBeGreaterThanOrEqual(graph.x + graph.width);
      expect(c.height).toBeLessThanOrEqual(900 * 0.7);
    };
    await box.fill("/status");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByRole("button", { name: "模型", exact: true }).waitFor();
    await inChat();
    await box.pressSequentially("hi");
    expect(await box.inputValue()).toBe("hi");
    await box.fill("");
    await card.getByRole("button", { name: "模型", exact: true }).click();
    await card.getByRole("slider", { name: "思考强度" }).waitFor();
    await inChat();
    await page.getByRole("button", { name: "换 agent" }).click();
    await card.getByRole("button", { name: /Claude/ }).waitFor();
    await inChat();
  } finally {
    reset();
  }
});

smoke("story 519: the model button or the agent's logo tapped again closes its sheet; /model typed while the sheet is open leaves it open", async () => {
  const slot = withClaude("toggles");
  answer = statusAnswers("toggles");
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const sheet = page.getByRole("dialog");
    const key = page.getByRole("button", { name: "模型和思考强度" });
    await key.click();
    await sheet.getByRole("group", { name: "思考强度" }).waitFor();
    expect(await key.getAttribute("aria-expanded")).toBe("true");
    await box.fill("/model");
    await page.getByRole("button", { name: "发送" }).click();
    await until(async () => (await box.inputValue()) === "");
    expect(await sheet.count()).toBe(1);
    await key.click();
    await sheet.waitFor({ state: "detached" });
    expect(await key.getAttribute("aria-expanded")).toBe("false");
    const logo = page.getByRole("button", { name: "换 agent" });
    await logo.click();
    await sheet.getByRole("button", { name: /Claude/ }).waitFor();
    await logo.click();
    await sheet.waitFor({ state: "detached" });
  } finally {
    reset();
  }
});

smoke("story 520: with many models the sheet's title and its levels stay in sight as the list scrolls; under 480px high the whole card scrolls", async () => {
  const slot = withClaude("many");
  const rest = statusAnswers("many");
  const models: RhReply = { ok: true, text: "换哪个模型？", panel: { head: ["换哪个模型？"], candidates: Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, command: `/model m${i}` })) } };
  answer = async () => ((acted.at(-1)!.act as { text: string }).text === "/model" ? models : rest());
  try {
    const page = await open(`/slot/${slot}`);
    const sheet = page.getByRole("dialog");
    await page.getByRole("button", { name: "模型和思考强度" }).click();
    const level = sheet.getByRole("group", { name: "思考强度" });
    await level.getByRole("slider").waitFor();
    const card = (await sheet.boundingBox())!;
    const clip = () => sheet.evaluate((el) => getComputedStyle(el).clipPath);
    expect(await clip()).toBe("none"); // its shadow whole
    // The list at its top, m0 in sight: the levels are in sight too.
    const l = (await level.boundingBox())!;
    expect(l.y + l.height).toBeLessThanOrEqual(card.y + card.height);
    await sheet.getByRole("button", { name: "m29" }).scrollIntoViewIfNeeded();
    expect((await sheet.getByRole("button", { name: "关闭" }).boundingBox())!.y).toBeGreaterThanOrEqual(card.y);
    // A phone held sideways: the title scrolls away with the list.
    await page.setViewportSize({ width: 839, height: 412 });
    await sheet.getByRole("button", { name: "m0" }).scrollIntoViewIfNeeded();
    await sheet.getByRole("button", { name: "m29" }).scrollIntoViewIfNeeded();
    expect((await sheet.getByRole("button", { name: "关闭" }).boundingBox())!.y).toBeLessThan((await sheet.boundingBox())!.y);
    // Its floating bar, drawn square, kept inside its round corners (#646).
    expect(await clip()).toBe("border-box");
  } finally {
    reset();
  }
});

smoke("story 520: on a phone 480px high with a message queued, a long sheet's handle and ✕ stay below the top bar", async () => {
  const slot = withClaude("roomy");
  store.tx((tx) => tx.insert("agentInput", { conversation: tx.get("slot", slot)!.conversation!, source: "human", status: "queued", queueReason: "web_queue", body: "[来自 网页]\n等一下", trace: "roomy-q" }));
  const rest = statusAnswers("roomy");
  const models: RhReply = { ok: true, text: "换哪个模型？", panel: { head: ["换哪个模型？"], candidates: Array.from({ length: 30 }, (_, i) => ({ label: `m${i}`, command: `/model m${i}` })) } };
  answer = async () => ((acted.at(-1)!.act as { text: string }).text === "/model" ? models : rest());
  try {
    const page = await open(`/slot/${slot}`, (page) => page.setViewportSize({ width: 412, height: 480 }));
    await page.getByRole("region", { name: "待发队列" }).waitFor();
    const sheet = page.getByRole("dialog");
    await page.getByRole("button", { name: "模型和思考强度" }).click();
    await sheet.getByRole("button", { name: "m0" }).waitFor();
    const bar = (await page.locator("header").boundingBox())!;
    expect((await sheet.boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    expect((await sheet.getByRole("button", { name: "关闭" }).boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
    // 30 models: the search box shows, below the bar too (#455).
    expect((await sheet.getByRole("searchbox").boundingBox())!.y).toBeGreaterThanOrEqual(bar.y + bar.height);
  } finally {
    reset();
  }
});

smoke("stories 528, 529: over 8 models, a search box on top finds them by name or provider, any case, staying put as they filter; pi's in a group by provider, only the current one's open till a search opens those it finds", async () => {
  const slot = withClaude("finds");
  const rest = statusAnswers("finds");
  const candidates = Array.from({ length: 12 }, (_, i) => ({ label: `M${i}`, command: `/model ${i}`, group: i < 6 ? "deepseek" : "kimi", ...(i === 7 && { current: true }) }));
  const models: RhReply = { ok: true, text: "换哪个模型？", panel: { head: ["换哪个模型？"], candidates } };
  answer = async () => ((acted.at(-1)!.act as { text: string }).text === "/model" ? models : rest());
  try {
    const page = await open(`/slot/${slot}`);
    const sheet = page.getByRole("dialog");
    const model = (name: string) => sheet.getByRole("button", { name: new RegExp(`^${name}\\b`) });
    await page.getByRole("button", { name: "模型和思考强度" }).click();
    const search = sheet.getByRole("searchbox");
    await model("M7").waitFor();
    // A touch screen keeps its keyboard down.
    expect(await search.evaluate((e) => e === document.activeElement)).toBe(false);
    expect(await model("M0").count()).toBe(0);
    const deepseek = sheet.getByRole("button", { name: "deepseek" });
    expect(await deepseek.getAttribute("aria-expanded")).toBe("false");
    // As high as what is in it: no blank under the models.
    expect(await sheet.evaluate((d) => { const mid = d.children[1]!; return mid.clientHeight - [...mid.children].reduce((h, c) => h + c.getBoundingClientRect().height, 0); })).toBeLessThan(1);
    const at = (await search.boundingBox())!.y;
    await search.fill("DEEP");
    await model("M0").waitFor();
    expect(await model("M7").count()).toBe(0);
    expect((await search.boundingBox())!.y).toBe(at);
    await search.fill("m1");
    for (const m of ["M1", "M10", "M11"]) await model(m).waitFor();
    expect(await sheet.getByRole("group", { name: "模型" }).getByRole("button").count()).toBe(5);
    // Folded by hand; with nothing searched, back as it opened.
    await deepseek.click();
    await model("M1").waitFor({ state: "detached" });
    await search.fill("");
    await model("M7").waitFor();
    expect(await model("M0").count()).toBe(0);
    // With a mouse the search box takes the keyboard, and Esc gives it back where you type.
    const desk = await open(`/slot/${slot}`, undefined, wide());
    const box = desk.getByRole("textbox", { name: "消息" });
    await box.fill("/model");
    await box.press("Enter");
    await until(() => desk.getByRole("searchbox").evaluate((e) => e === document.activeElement));
    await desk.keyboard.press("Escape");
    await desk.getByRole("dialog").waitFor({ state: "detached" });
    expect(await box.evaluate((b) => b === document.activeElement)).toBe(true);
    await desk.context().close();
  } finally {
    reset();
  }
});

smoke("story 521: an info card's handle dragged a little springs back; a finger dragging it down past a third of the card closes it", async () => {
  const slot = withClaude("drags");
  answer = statusAnswers("drags");
  try {
    const page = await open(`/slot/${slot}`);
    const card = page.getByRole("dialog");
    await page.getByRole("textbox", { name: "消息" }).fill("/status");
    await page.getByRole("button", { name: "发送" }).click();
    await card.getByRole("button", { name: "模型", exact: true }).waitFor();
    const at = (await card.boundingBox())!;
    const [x, y] = [at.x + at.width / 2, at.y + 6];
    await page.mouse.move(x, y);
    // The right button takes nothing along.
    await page.mouse.down({ button: "right" });
    await page.mouse.move(x, y + 40, { steps: 4 });
    expect((await card.boundingBox())!.y).toBe(at.y);
    await page.mouse.up({ button: "right" });
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x, y + 40, { steps: 4 });
    expect(Math.round((await card.boundingBox())!.y - at.y)).toBe(40);
    await page.mouse.up();
    await until(async () => (await card.boundingBox())?.y === at.y);
    const cdp = await page.context().newCDPSession(page);
    const touch = (type: "touchStart" | "touchMove" | "touchEnd", dy?: number) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: dy === undefined ? [] : [{ x, y: y + dy }] });
    await touch("touchStart", 0);
    for (let dy = 20; dy < at.height / 3 + 40; dy += 20) await touch("touchMove", dy);
    await touch("touchEnd");
    await card.waitFor({ state: "detached" });
    // ✕ tapped at its top edge, by the handle, closes the card too.
    await page.getByRole("textbox", { name: "消息" }).fill("/status");
    await page.getByRole("button", { name: "发送" }).click();
    const shut = (await card.getByRole("button", { name: "关闭" }).boundingBox())!;
    await page.mouse.click(shut.x + shut.width / 2, shut.y + 5);
    await card.waitFor({ state: "detached" });
  } finally {
    reset();
  }
});

smoke("story 522: on a touch screen the model sheet opened takes the caret out of where you type; /status's card leaves it there", async () => {
  const slot = withClaude("keyboard");
  answer = statusAnswers("keyboard");
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const typing = () => page.evaluate(() => document.activeElement?.getAttribute("aria-label") === "消息");
    // Picked from the commands with Enter, which leaves the caret where it is.
    await box.fill("/model");
    await box.press("Enter");
    await page.getByRole("dialog", { name: "模型" }).getByRole("group", { name: "思考强度" }).waitFor();
    expect(await typing()).toBe(false);
    await box.fill("/status");
    await box.press("Enter");
    await page.getByRole("dialog", { name: "w/keyboard" }).waitFor();
    expect(await typing()).toBe(true);
  } finally {
    reset();
  }
});

smoke("stories 412, 413: on a phone /rh_help brings up the commands and /rh_ls goes back to the list, neither sent; /ultracode on pi goes, its no an error toast, no sheet", async () => {
  answer = async () => ({ ok: false, error: "pi 没有 ultracode。" });
  try {
    const page = await open(`/slot/${talks}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const before = acted.length;
    await box.fill("/rh_help");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("listbox", { name: "命令" }).waitFor();
    expect(await box.inputValue()).toBe("/");
    await box.fill("/ultracode");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("status").getByText("pi 没有 ultracode。").waitFor();
    expect(await page.getByRole("dialog").count()).toBe(0);
    expect(saidTo(talks).at(-1)).toBe("/ultracode");
    await box.fill("/rh_ls");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("link", { name: /talks/ }).waitFor();
    expect(new URL(page.url()).hash).toBe("#/");
    expect(acted.length).toBe(before + 1);
  } finally {
    reset();
  }
});

smoke("story 412: on a wide screen beside the topology, /rh_ls puts the list on the left, the slot's row flashing, its chat still beside it", async () => {
  const before = acted.length;
  const page = await open(`/topology/slot/${finished}?chat`, undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const box = page.getByRole("textbox", { name: "消息" });
  await box.fill("/rh_ls");
  await page.getByRole("button", { name: "发送" }).click();
  const row = page.locator(`a[href="#/slot/${finished}"]`);
  await row.waitFor();
  await until(() => row.evaluate((e) => e.getAnimations().length > 0));
  expect(await row.getAttribute("aria-current")).toBe("page");
  await page.getByRole("heading", { name: "w/finished" }).waitFor();
  expect(acted.length).toBe(before);
});

smoke("story 264: while a command waits for the agent, as /compact does for long, the stop key stops the turn; the command's answer shows when it comes", async () => {
  let compacted!: (r: RhReply) => void;
  answer = () => ((acted.at(-1)!.act as { kind: string }).kind === "common" ? Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" }) : new Promise((r) => (compacted = r)));
  try {
    const page = await open(`/slot/${works}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const before = acted.length;
    await box.fill("/compact");
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => acted.length === before + 1);
    const stop = page.getByRole("button", { name: "停止" });
    await stop.click();
    await page.getByRole("status").getByText("已停下这一回合，对话留着。").waitFor();
    expect(acted.at(-1)!.act).toEqual({ kind: "common", slot: works, name: "stop" });
    compacted({ ok: true, text: "已压缩上下文。" });
    await page.getByRole("status").getByText("已压缩上下文。").waitFor();
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("story 300: an answer that comes late, typed or picked from a sheet, leaves the sheet open now as it is", async () => {
  const replies: Record<string, RhReply> = {
    "/status": { ok: true, text: "状态", panel: { head: ["状态"], candidates: [{ label: "压缩上下文", command: "/compact" }] } },
    "/resume": { ok: true, text: "回到哪段对话？", panel: { head: ["回到哪段对话？"], candidates: [{ label: "修登录", command: "/resume s1", current: true }, { label: "写文档", command: "/resume s2" }] } },
    "/resume s2": { ok: true, text: "已回到 写文档 那段对话。" },
  };
  // Each /compact waits till let go.
  const held: ((r: RhReply) => void)[] = [];
  const sent = () => (acted.at(-1)!.act as { text: string }).text;
  answer = () => (replies[sent()] ? Promise.resolve(replies[sent()]!) : new Promise((r) => held.push(r)));
  try {
    const page = await open(`/slot/${rests}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const send = page.getByRole("button", { name: "发送" });
    const sheet = page.getByRole("dialog");
    await box.fill("/compact");
    await send.click();
    await until(() => held.length === 1);
    await box.fill("/status");
    await send.click();
    await sheet.getByRole("button", { name: "压缩上下文" }).click();
    await until(() => held.length === 2);
    // Closed while its pick waits, a tap on the transcript, then another: what it offers can be picked.
    await page.mouse.click(200, 200);
    await sheet.waitFor({ state: "detached" });
    await box.fill("/resume");
    await send.click();
    const other = sheet.getByRole("button", { name: "写文档" });
    await other.waitFor();
    expect(await other.isEnabled()).toBe(true);
    // The two answers come: each a toast, under the sheet, which stays open, to pick from.
    held[0]!({ ok: true, text: "已压缩上下文。" });
    held[1]!({ ok: true, text: "压缩完了。" });
    await page.locator("[role=status]").getByText("已压缩上下文。").waitFor();
    await page.locator("[role=status]").getByText("压缩完了。").waitFor();
    await other.click();
    await page.getByRole("status").getByText("已回到 写文档 那段对话。").waitFor();
    expect(sent()).toBe("/resume s2");
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("stories 302-306, 527: on a phone the bar's agent logo and model button open their sheets, as /model typed alone does; a model picked shows its levels; while a turn runs another agent asks how; ⋯ has 开新对话 and 压缩上下文; 详情's timeline goes back to a conversation", async () => {
  const { slot, old } = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "bars", dir: "/w", mode: "headless", state: "running", lifetime: "longterm", model: "Opus", effort: "high" }).id;
    const old = tx.insert("conversation", { slot, agent: "claude", sessionId: "s-old", startedAt: Date.now() - 60_000 }).id;
    const conversation = tx.insert("conversation", { slot, agent: "claude", sessionId: "s-now", startedAt: Date.now() }).id;
    tx.update("slot", { id: slot }, { conversation });
    return { slot, old };
  });
  // Old: said something, so the timeline has its title.
  const file = join(base, ".claude/projects/-w/s-old.jsonl");
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ type: "user", sessionId: "s-old", timestamp: new Date().toISOString(), message: { role: "user", content: "修登录" } }) + "\n");
  const models = { head: ["换哪个模型？"], candidates: [{ label: "Opus", command: "/model opus", current: true }, { label: "Haiku", command: "/model haiku" }] };
  const levels = (model: string, ids: string[], now?: string) => ids.map((l) => ({ label: l, command: `/model ${model} ${l}`, ...(l === now && { current: true }) }));
  const replies: Record<string, RhReply> = {
    "/model": { ok: true, text: "换哪个模型？", panel: models },
    "/effort": { ok: true, text: "思考强度改成哪档？", panel: { head: ["思考强度改成哪档？"], candidates: ["low", "medium", "high", "max"].map((l) => ({ label: l, command: `/effort ${l}`, ...(l === "high" && { current: true }) })) } },
    "/model haiku": { ok: true, text: "已切到 Haiku。\n思考强度要改吗？现在是 high。", panel: { head: ["已切到 Haiku。", "思考强度要改吗？现在是 high。"], candidates: levels("haiku", ["low", "medium", "high"], "high") } },
    "/model haiku low": { ok: true, text: "思考强度改成 low。" },
    "/rh_agent pi !": { ok: true, text: "w/bars 换成了 pi，开了一段新对话。" },
    [`/resume ${old}`]: { ok: true, text: "已回到今天 10:00 那段对话。" },
  };
  const said = () => acted.filter((a) => (a.act as { slot?: string }).slot === slot).map((a) => (a.act as { text?: string; name?: string }).text ?? `common ${(a.act as { name: string }).name}`);
  answer = async () => {
    const text = (acted.at(-1)!.act as { text?: string }).text;
    // What the slot keeps changes as rhodium's router changes it, and the page hears of it.
    store.tx((tx) => {
      if (text === "/model haiku low") tx.update("slot", { id: slot }, { model: "Haiku", effort: "low" });
      if (text === "/rh_agent pi !") tx.update("slot", { id: slot }, { conversation: tx.insert("conversation", { slot, agent: "pi", startedAt: Date.now() }).id });
      tx.append({ source: "board", type: "board_act", slot });
    });
    return (text && replies[text]) || { ok: true, text: "好。" };
  };
  try {
    const page = await open(`/slot/${slot}`);
    const sheet = page.getByRole("dialog");
    const modelKey = page.getByRole("button", { name: "模型和思考强度" });
    // The model on the bar, the top bar only the state (story 304).
    expect(await modelKey.textContent()).toBe("Opushigh");
    await page.getByRole("heading", { name: "w/bars" }).waitFor();
    expect(await page.getByText(/模型 Opus/).count()).toBe(0);

    // The models and the levels of the one in use, each the one now marked; a model picked is in use,
    // its levels in place of the others, drawn anew (story 527).
    await modelKey.click();
    const level = sheet.getByRole("slider", { name: "思考强度" });
    await until(async () => (await level.getAttribute("max")) === "3");
    await sheet.getByRole("group", { name: "模型" }).getByRole("button", { name: /Opus/ }).getByLabel("现在").waitFor();
    expect(await level.getAttribute("aria-valuetext")).toBe("high");
    await sheet.getByRole("button", { name: "Haiku" }).click();
    await until(async () => (await level.getAttribute("max")) === "2");
    await sheet.getByRole("button", { name: /Haiku/ }).getByLabel("现在").waitFor();
    await level.focus();
    await page.keyboard.press("Home");
    await until(async () => (await modelKey.textContent()) === "Haikulow");
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    // ultracode asked again for the model picked, which may not take it (#276); with no switch to show, none shows.
    expect(said().slice(-6).toSorted()).toEqual(["/effort", "/model", "/model haiku", "/model haiku low", "/ultracode", "/ultracode"]);
    expect(await sheet.getByRole("switch").count()).toBe(0);

    // Typed alone, /model opens the same sheet (story 297).
    await page.getByRole("textbox", { name: "消息" }).fill("/model");
    await page.getByRole("button", { name: "发送" }).click();
    await sheet.getByRole("group", { name: "思考强度" }).waitFor();
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });

    // Another agent while a turn runs: once it is over, or cutting it short (story 303).
    await page.getByRole("button", { name: "换 agent" }).click();
    await sheet.getByRole("button", { name: /Claude/ }).getByLabel("现在").waitFor();
    await sheet.getByRole("button", { name: /^pi/ }).click();
    await sheet.getByRole("button", { name: "跑完再换" }).waitFor();
    await sheet.getByRole("button", { name: "打断，马上换" }).click();
    await sheet.waitFor({ state: "detached" });
    expect(said().at(-1)).toBe("/rh_agent pi !");
    await page.getByRole("heading", { name: "w/bars" }).getByLabel("pi").waitFor();

    // ⋯: a new conversation and compacting (story 305).
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "压缩上下文" }).click();
    await page.getByRole("button", { name: "更多" }).click();
    await page.getByRole("menuitem", { name: "开新对话" }).click();
    await until(() => said().at(-1) === "common new");
    expect(said().at(-2)).toBe("common compact");

    // 详情's timeline: 回到这段 is no tap while a turn runs; once it is over, it goes back (story 306).
    await page.getByRole("button", { name: "详情" }).click();
    await page.getByText("时间线").click();
    const back = sheet.getByRole("button", { name: "回到这段" });
    expect(await back.isDisabled()).toBe(true);
    store.tx((tx) => (tx.update("slot", { id: slot }, { state: "idle" }), tx.append({ source: "board", type: "board_act", slot })));
    await until(() => back.isEnabled());
    await back.click();
    // The toast over the page, which 详情 leaves out of what is read aloud.
    await page.locator("[role=status]").getByText("已回到今天 10:00 那段对话。").waitFor();
    expect(said().at(-1)).toBe(`/resume ${old}`);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("stories 524-527: on a phone the thinking levels are a slider: the one let go on, or stepped to with an arrow key, is said and the sheet stays open; picked while one is on its way, only the last is said once its answer comes, the slider keeping the focus; max has motes drifting; one not set springs back with why; a model with one level has none", async () => {
  const slot = withClaude("slides");
  const panel = (head: string, items: [string, string][], now: string) => ({ ok: true as const, text: head, panel: { head: [head], candidates: items.map(([label, command]) => ({ label, command, ...(label === now && { current: true as const }) })) } });
  const replies: Record<string, RhReply> = {
    "/model": panel("换哪个模型？", [["Opus", "/model opus"], ["Haiku", "/model haiku"]], "Opus"),
    "/effort": panel("思考强度改成哪档？", ["low", "medium", "high", "max"].map((l) => [l, `/effort ${l}`]), "high"),
    "/model haiku": panel("思考强度要改吗？", [["high", "/model haiku high"]], "high"),
    "/effort max": { ok: false, error: "回合在跑，跑完再改。" },
  };
  let hold: Promise<void> | undefined;
  answer = async () => {
    const text = (acted.at(-1)!.act as { text: string }).text;
    if (text.startsWith("/effort ")) await hold;
    return replies[text] ?? { ok: true, text: "好。" };
  };
  try {
    const page = await open(`/slot/${slot}`);
    const sheet = page.getByRole("dialog");
    await page.getByRole("button", { name: "模型和思考强度" }).click();
    const slider = sheet.getByRole("slider", { name: "思考强度" });
    const level = () => slider.getAttribute("aria-valuetext");
    await until(async () => (await level()) === "high");
    expect(await sheet.locator(".stardust").count()).toBe(0);
    const levels = () => saidTo(slot).filter((t) => t?.startsWith("/effort "));
    // Dragged to the far left while its answer is held, then stepped right twice: low said, and once its
    // answer comes, medium never, high only.
    let release = () => {};
    hold = new Promise((r) => (release = r));
    const thumb = (await slider.locator("..").boundingBox())!;
    await page.mouse.move(thumb.x + thumb.width / 2, thumb.y + thumb.height / 2);
    await page.mouse.down();
    await page.mouse.move(0, thumb.y + thumb.height / 2, { steps: 5 });
    await page.mouse.up();
    await until(() => levels().length === 1);
    expect(await level()).toBe("low");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    expect(await level()).toBe("high");
    release();
    await until(() => levels().length === 2);
    expect(levels()).toEqual(["/effort low", "/effort high"]);
    expect(await slider.evaluate((e) => e === document.activeElement)).toBe(true);
    expect(await sheet.isVisible()).toBe(true);
    // Up to max, motes drifting over its fill; not set, it springs back to high, the toast saying why.
    hold = new Promise((r) => (release = r));
    await page.keyboard.press("ArrowRight");
    await until(() => sheet.locator(".stardust").evaluate((e) => e.getAnimations().length > 0));
    release();
    await page.getByRole("status").getByText("回合在跑，跑完再改。").waitFor();
    await until(async () => (await level()) === "high");
    expect(levels().at(-1)).toBe("/effort max");
    // A model with one level: no slider.
    await sheet.getByRole("button", { name: "Haiku" }).click();
    await sheet.getByRole("button", { name: /Haiku/ }).getByLabel("现在").waitFor();
    expect(await slider.count()).toBe(0);
  } finally {
    reset();
  }
});

smoke("#276: on a phone the model sheet has ultracode as a switch of its own, where the agent can take it: it stays open as you flip it, the bar marks it on, and /ultracode typed alone opens the sheet", async () => {
  const slot = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "ultra", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm", effort: "high" }).id;
    tx.update("slot", { id: slot }, { conversation: tx.insert("conversation", { slot, agent: "claude", sessionId: "s-ultra", startedAt: Date.now() }).id });
    return slot;
  });
  const panel = (head: string, items: [string, string][], now: string) => ({ ok: true as const, text: head, panel: { head: [head], candidates: items.map(([label, command]) => ({ label, command, ...(label === now && { current: true as const }) })) } });
  const replies: Record<string, RhReply> = {
    "/model": panel("换哪个模型？", [["Opus", "/model opus"]], "Opus"),
    "/effort": panel("思考强度改成哪档？", [["high", "/effort high"]], "high"),
    "/ultracode": panel("ultracode 开还是关？", [["开", "/ultracode on"], ["关", "/ultracode off"]], "关"),
    "/ultracode on": { ok: true, text: "ultracode 改成开。" },
  };
  const said = () => acted.filter((a) => (a.act as { slot?: string }).slot === slot).map((a) => (a.act as { text?: string }).text);
  let hold: Promise<void> | undefined;
  answer = async () => {
    const text = (acted.at(-1)!.act as { text?: string }).text!;
    if (text === "/ultracode on") await hold;
    store.tx((tx) => {
      if (text === "/ultracode on") tx.update("slot", { id: slot }, { ultracode: 1 });
      tx.append({ source: "board", type: "board_act", slot });
    });
    return replies[text] ?? { ok: true, text: "好。" };
  };
  try {
    const page = await open(`/slot/${slot}`);
    const sheet = page.getByRole("dialog");
    const modelKey = page.getByRole("button", { name: "模型和思考强度" });
    expect(await modelKey.getByLabel("ultracode").count()).toBe(0);
    await modelKey.click();
    const toggle = sheet.getByRole("switch", { name: "ultracode" });
    await toggle.waitFor();
    // No search box: it fits what is in it as that changes, never held at a height it had.
    expect(await sheet.evaluate((d) => (d as HTMLElement).style.minHeight)).toBe("");
    expect(await toggle.getAttribute("aria-checked")).toBe("false");
    expect((await toggle.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await toggle.click();
    await until(async () => (await toggle.getAttribute("aria-checked")) === "true");
    expect(said().at(-1)).toBe("/ultracode on");
    expect(await sheet.isVisible()).toBe(true);
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await modelKey.getByLabel("ultracode").waitFor();

    // Typed alone, /ultracode opens the same sheet, as its entry in the palette does.
    await page.getByRole("textbox", { name: "消息" }).fill("/ultracode");
    await page.getByRole("button", { name: "发送" }).click();
    await toggle.waitFor();

    // Closed while a flip is still on its way, the sheet opens again with the switch to tap, not spinning.
    let release = () => {};
    hold = new Promise((r) => (release = r));
    await until(() => toggle.isEnabled());
    await toggle.click();
    await until(() => toggle.isDisabled());
    await page.keyboard.press("Escape");
    await sheet.waitFor({ state: "detached" });
    await modelKey.click();
    await toggle.waitFor();
    await until(() => toggle.isEnabled());
    release();
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("story 272: as what you type grows over lines, the chat above stays at the newest", async () => {
  const page = await open(`/slot/${talks}`);
  const log = page.getByRole("log", { name: "对话" });
  await page.getByText("a59", { exact: true }).waitFor();
  const toEnd = () => log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  const before = (await log.boundingBox())!.height;
  await page.getByRole("textbox", { name: "消息" }).fill("一\n二\n三\n四\n五");
  await until(async () => (await log.boundingBox())!.height < before);
  await until(async () => (await toEnd()) < 1);
});

smoke("#646: on a phone, a box round itself that scrolls, as Rhodium's log, clips its floating bar to its corners", async () => {
  const log = (await open("/rhodium")).locator("pre").first();
  await log.waitFor();
  expect(await log.evaluate((el) => getComputedStyle(el).clipPath)).toBe("border-box");
});

smoke("stories 282, 283, 287, 288: on a phone, what you type while a turn runs goes with the key, now 排队, into the queue above where you type; 插话 sends it in from there, 编辑 takes it back where you type, and so does Rhodium giving it back; on a keyboard Esc stops the turn", async () => {
  const { slot, conversation } = store.tx((tx) => {
    const slot = tx.insert("slot", { workspace: ws, name: "queues", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id;
    const conversation = tx.insert("conversation", { slot, agent: "pi", sessionId: "t8", startedAt: Date.now() }).id;
    tx.update("slot", { id: slot }, { conversation });
    return { slot, conversation };
  });
  // Rhodium queues what you send mid-turn, and sends it in when told, as its router does; each act an event.
  answer = async () => {
    const { id, act } = acted.at(-1)! as { id: string; act: { kind: string; text?: string; input?: string } };
    store.tx((tx) => {
      if (act.kind === "say") tx.insert("agentInput", { conversation, source: "human", status: "queued", queueReason: "web_queue", body: `[来自 网页]\n${act.text}`, trace: id });
      if (act.kind === "queued" && (act as { op?: string }).op === "now") tx.update("agentInput", { trace: act.input! }, { status: "taken", queueReason: null, body: null });
      if (act.kind === "queued" && (act as { op?: string }).op === "drop") tx.delete("agentInput", { trace: act.input! });
      tx.append({ source: "board", type: "board_act", trace: id, data: act });
    });
    return { ok: true, text: act.kind === "say" ? "排队" : "插话" };
  };
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    await page.getByRole("button", { name: "停止" }).waitFor();
    await box.fill("顺便看看日志");
    await page.getByRole("button", { name: "排队" }).click();
    const queue = page.getByRole("region", { name: "待发队列" });
    await queue.getByText("顺便看看日志").waitFor();
    expect(await page.locator(".opacity-60", { hasText: "顺便看看日志" }).count()).toBe(0);
    expect(await cornered(queue.locator("ul").locator(".."), "bottom")).toBe(true);
    const sent = acted.at(-1)!.id;
    const cut = queue.getByRole("button", { name: "插话" });
    const tap = (await cut.boundingBox())!;
    expect(tap.width >= 44 && tap.height >= 44).toBe(true);
    await cut.click();
    await queue.waitFor({ state: "detached" });
    expect(acted.at(-1)!.act).toEqual({ kind: "queued", slot, op: "now", input: sent });

    await box.fill("再跑一遍测试");
    await page.getByRole("button", { name: "排队" }).click();
    await queue.getByRole("button", { name: "编辑" }).click();
    await queue.waitFor({ state: "detached" });
    await until(async () => (await box.inputValue()) === "再跑一遍测试");
    expect((acted.at(-1)!.act as { op: string }).op).toBe("drop");
    // Given back, as when the slot goes to the terminal: after what is typed, a toast says why.
    store.tx((tx) => tx.append({ source: "tui", type: "input_returned", slot, trace: "R9", data: { why: "切到 TUI 了", text: "跑完告诉我" } }));
    await until(async () => (await box.inputValue()) === "再跑一遍测试\n跑完告诉我");
    await page.getByRole("status").getByText("切到 TUI 了").waitFor();
    await box.fill("");

    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
    await box.focus();
    await page.keyboard.press("Escape");
    await until(() => (acted.at(-1)!.act as { kind: string }).kind === "common");
    expect(acted.at(-1)!.act).toEqual({ kind: "common", slot, name: "stop" });
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("one queued that fails to go comes back after what you typed meanwhile, with its files; Esc while an input method composes leaves the turn running", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "flaky", dir: "/w", mode: "headless", state: "running", lifetime: "longterm" }).id);
  let fail = (_: RhReply) => {};
  answer = () => new Promise((done) => (fail = done));
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    await page.getByRole("button", { name: "停止" }).waitFor();
    await box.fill("顺便看看日志");
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await page.getByRole("button", { name: "排队" }).click();
    await until(() => (acted.at(-1)?.act as { slot?: string } | undefined)?.slot === slot);
    await box.fill("新打的");
    fail({ ok: false, error: "连不上 Rhodium。" });
    await until(async () => (await box.inputValue()) === "新打的\n顺便看看日志");
    await page.getByRole("list", { name: "附件" }).getByText("notes.txt").waitFor();

    await box.fill("");
    await page.locator('[aria-label="附件"] [aria-label="移除"]').click();
    const before = acted.length;
    await box.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
    await Bun.sleep(300);
    expect(acted.length).toBe(before);

    // #582: failed while another slot is open, its words and files are back on coming back.
    const go = async (id: string, name: string) => (await page.evaluate((id) => (location.hash = `#/slot/${id}`), id), await page.getByRole("heading", { name }).waitFor());
    await box.fill("再看一眼");
    await page.locator('input[type="file"]').setInputFiles({ name: "more.txt", mimeType: "text/plain", buffer: Buffer.from("y") });
    await page.getByRole("button", { name: "排队" }).click();
    await until(() => acted.length === before + 1);
    await go(finished, "w/finished");
    fail({ ok: false, error: "还是连不上。" });
    await page.getByRole("status").getByText("还是连不上。").waitFor();
    await go(slot, "w/flaky");
    await page.getByRole("list", { name: "附件" }).getByText("more.txt").waitFor();
    expect(await box.inputValue()).toBe("再看一眼");
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("#286, #595: on a phone the home's header has the settings' gear, no theme button; its card picks 深色, which stays when the page loads again, set before the page's script runs", async () => {
  const page = await open();
  const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  // The phone's system is light.
  const light = await bg();
  const gear = page.getByRole("button", { name: "设置" });
  const card = page.getByRole("dialog");
  await page.getByRole("button", { name: "新建", exact: true }).waitFor();
  expect(await page.getByRole("button", { name: "跟随系统" }).count()).toBe(0);
  await gear.click();
  // Under the gear, its right edge on the header's, as the list's below: once placed, a frame or more
  // after it shows, past the gear's own right edge till then (#575).
  const [header, under] = [(await page.locator("header", { has: gear }).boundingBox())!, (await gear.boundingBox())!.y];
  const placed = async () => {
    const at = (await card.boundingBox())!;
    return [at.y > under, Math.round(at.x + at.width)];
  };
  await settles(placed, [true, Math.round(header.x + header.width)]);
  await card.getByRole("button", { name: "深色" }).click();
  const dark = await bg();
  expect(dark).not.toBe(light);
  // Loaded again with none of the page's script: it is dark from the first paint.
  await page.route("**/assets/*.js", (r) => r.abort());
  await page.reload();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await bg()).toBe(dark);
  await page.unroute("**/assets/*.js");
  await page.reload();
  await gear.click();
  expect(await card.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");
  await card.getByRole("button", { name: "跟随系统" }).click();
  expect(await bg()).toBe(light);
  await page.context().close();
});

/** A PNG of one pixel. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

smoke("#286, #577: a picture pasted where you type, or a file dropped on the chat, is attached as + attaches it, lined up with the words; words pasted are words; sent, the chat shows the picture", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "pastes", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  answer = async () => ({ ok: true, text: "开始新回合" });
  try {
    const page = await open(`/slot/${slot}`);
    const box = page.getByRole("textbox", { name: "消息" });
    const attached = page.getByRole("list", { name: "附件" });
    // Whether the page took the event for itself, as it does a file, rather than leaving it to the browser.
    const paste = (what: "picture" | "words") =>
      box.evaluate((el, [what, PIXEL]) => {
        const data = new DataTransfer();
        if (what === "picture") data.items.add(new File([Uint8Array.from(atob(PIXEL), (c) => c.charCodeAt(0))], "shot.png", { type: "image/png" }));
        else data.setData("text/plain", "几句话");
        return !el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
      }, [what, PIXEL] as const);
    expect(await paste("words")).toBe(false);
    expect(await attached.count()).toBe(0);
    expect(await paste("picture")).toBe(true);
    await attached.getByRole("img", { name: "shot.png" }).waitFor();
    const [first, at, pad] = [(await attached.locator("li").first().boundingBox())!, (await box.boundingBox())!, await box.evaluate((e) => parseFloat(getComputedStyle(e).paddingLeft))];
    expect(first.x).toBeCloseTo(at.x + pad, 0);
    await page.getByRole("log", { name: "对话" }).evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
      el.dispatchEvent(new DragEvent("dragover", { dataTransfer: data, bubbles: true, cancelable: true }));
      el.dispatchEvent(new DragEvent("drop", { dataTransfer: data, bubbles: true, cancelable: true }));
    });
    await attached.getByText("notes.txt").waitFor();
    // #582: what is attached and not sent stays with the slot, as its words do, till dropped or sent.
    const go = async (id: string, name: string) => (await page.evaluate((id) => (location.hash = `#/slot/${id}`), id), await page.getByRole("heading", { name }).waitFor());
    const away = async () => (await go(finished, "w/finished"), await go(slot, "w/pastes"));
    await away();
    await attached.getByText("notes.txt").waitFor();
    await attached.getByRole("button", { name: "移除" }).last().click();
    await attached.getByText("notes.txt").waitFor({ state: "detached" });
    await away();
    expect(await attached.locator("li").count()).toBe(1);
    await box.fill("看图");
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => (acted.at(-1)?.act as { slot?: string } | undefined)?.slot === slot);
    expect(acted.at(-1)!.act).toMatchObject({ kind: "say", slot, text: "看图", attachments: [{ kind: "image", name: "shot.png", mimeType: "image/png" }] });
    await page.getByRole("log", { name: "对话" }).getByRole("img", { name: "shot.png" }).waitFor();
    await away();
    expect(await attached.count()).toBe(0);
    // A command with a picture turned away while another slot is open: both are back for it.
    let reply!: (r: RhReply) => void;
    answer = () => new Promise((r) => (reply = r));
    await paste("picture");
    await box.fill("/context");
    const before = acted.length;
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => acted.length === before + 1);
    await go(finished, "w/finished");
    reply({ ok: false, error: "看板还不能发 /context。" });
    await page.getByRole("status").getByText("看板还不能发 /context。").waitFor();
    await go(slot, "w/pastes");
    await attached.getByRole("img", { name: "shot.png" }).waitFor();
    expect(await box.inputValue()).toBe("/context");
    // Typed in it after coming back and before the answer, the box keeps only what you typed.
    const again = acted.length;
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => acted.length === again + 1);
    await away();
    await box.fill("hi");
    reply({ ok: false, error: "这会儿发不了。" });
    await page.getByRole("status").getByText("这会儿发不了。").waitFor();
    expect(await box.inputValue()).toBe("hi");
    expect(await attached.count()).toBe(0);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

/** How tall the faded strip at a scroller's top and at its bottom is, as its edge-fade-y mask has it, 0 for none. */
const fadesY = (l: Locator) =>
  l.evaluate((el) => {
    const mask = getComputedStyle(el).maskImage;
    return [/^linear-gradient\(rgba\(0, 0, 0, 0\), rgb\(0, 0, 0\) ([\d.]+)px/, /rgb\(0, 0, 0\) calc\(100% - ([\d.]+)px\), rgba\(0, 0, 0, 0\)\)/].map((re) => Number(re.exec(mask)?.[1] ?? 0));
  });

smoke("#638: the topology's details, the chat's timeline and a preview fade where they are cut, only while there is more that way, as what they hold comes and opens", async () => {
  // The details come once the slot's data does, after the page.
  const page = await open(`/topology/slot/${talks}`, undefined, { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 400 } });
  const body = page.locator("[data-body]");
  await sheetOf(page).getByRole("button", { name: /q0/ }).waitFor();
  await until(async () => (await fadesY(body)).join() === "0,32");
  await body.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await until(async () => (await fadesY(body)).join() === "32,0");
  // A preview opened makes the chat's timeline taller than its box, not scrolled; closed, it fits again.
  const chat = await open(`/slot/${talks}`);
  await chat.getByRole("button", { name: "详情" }).click();
  await chat.getByText("时间线").click();
  const timeline = chat.getByRole("dialog").locator("details", { hasText: "时间线" });
  const row = timeline.getByRole("button", { name: /q0/ });
  await row.click();
  const log = timeline.getByRole("log", { name: "预览" });
  await log.getByText("a59", { exact: true }).waitFor();
  await until(async () => (await fadesY(timeline)).join() === "0,32");
  // The preview's own list, at its newest, fades at its top.
  await until(async () => (await fadesY(log)).join() === "32,0");
  await row.click();
  await until(async () => (await fadesY(timeline)).join() === "0,0");
});

/** Whether a scroller has the browser's thin bar, not the board's round one with no arrows (card-scroll). */
const thin = (l: Locator) => l.evaluate((el) => getComputedStyle(el).scrollbarWidth === "thin");

smoke("#579, #646: with a mouse, the row of attachments has the board's round bar, its thumb, inside a clear border, starting where the files and the typed text do", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "cut-wide", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  const page = await open(`/slot/${slot}`, undefined, wide());
  await page.locator('input[type="file"]').setInputFiles({ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
  const row = page.getByRole("list", { name: "附件" }).locator("..");
  await row.waitFor();
  expect(await thin(row)).toBe(false);
  const [track, rim, pad] = await row.evaluate((el) => [getComputedStyle(el, "::-webkit-scrollbar-track").marginLeft, getComputedStyle(el, "::-webkit-scrollbar-thumb").borderLeftWidth, getComputedStyle(el.firstElementChild!).paddingLeft].map(parseFloat));
  expect(track! + rim!).toBe(pad!);
});

smoke("#577, #579: on a phone, files attached past the box's edge, commands past the palette's height and lines past the message box's fade out where they are cut, only while there is more that way; ↑↓ scroll their command clear of the fade, the mouse scrolls nothing", async () => {
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "cut", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  const page = await open(`/slot/${slot}`);
  const box = page.getByRole("textbox", { name: "消息" });
  const attach = (...names: string[]) => page.locator('input[type="file"]').setInputFiles(names.map((name) => ({ name, mimeType: "text/plain", buffer: Buffer.from("x") })));
  const row = page.getByRole("list", { name: "附件" }).locator("..");
  // Its floating bar kept inside the box's round corners, where it has them: none with files over it (#646).
  expect(await cornered(box, "top")).toBe(true);
  await attach("a.txt");
  await row.waitFor();
  expect(await cornered(box, "top")).toBe(false);
  expect(await fades(row)).toEqual([0, 0]);
  await attach("b.txt", "c.txt", "d.txt");
  await settles(() => fades(row), [0, 12]); // as the row fills (#575)
  // Top to bottom: a phone's bar lies over the row, with none under it to keep clear.
  expect(await row.evaluate((el) => getComputedStyle(el).maskSize)).toBe("100% 100%, 100% 0px");
  await row.evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await until(async () => (await fades(row))[0]! > 0);
  expect(await fades(row)).toEqual([12, 0]);
  // Their bars are the phone's thin ones, floating over what scrolls as the page's do (#646).
  expect([await thin(row), await thin(box)]).toEqual([true, true]);
  // Written past its height, the message box fades at its cut ends too (#579), and reads them again as
  // what is written changes with the box no taller and not scrolled.
  await box.fill(Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join("\n"));
  // Typed at the end, the caret's line is scrolled clear of the fade, down to the true bottom.
  await box.press("ControlOrMeta+End");
  await box.pressSequentially("x");
  await until(async () => (await fadesY(box)).join() === "32,0");
  await box.evaluate((el) => (el.scrollTop = 0));
  await until(async () => (await fadesY(box)).join() === "0,32");
  const left = () => box.evaluate((el) => [el.style.getPropertyValue("--ob"), `${el.scrollHeight - el.clientHeight - el.scrollTop}px`]);
  await box.evaluate((el: HTMLTextAreaElement) => (el.focus({ preventScroll: true }), el.setSelectionRange(0, 0), document.execCommand("insertText", false, "x\n")));
  await until(async () => new Set(await left()).size === 1);

  await box.fill("/");
  const list = page.getByRole("listbox", { name: "命令" });
  const commands = list.locator("> div");
  // Each fade follows the list as it fills, and its scroll a frame after it (#575).
  await settles(() => fadesY(commands), [0, 32]);
  expect(await thin(commands)).toBe(true);
  // Down to the 7th, cut in half at first: scrolled till it ends where the fade starts.
  for (let i = 0; i < 6; i++) await box.press("ArrowDown");
  await settles(() => fadesY(commands), [32, 32]);
  const [at, view] = [(await list.getByRole("option", { selected: true }).boundingBox())!, (await commands.boundingBox())!];
  expect(at.y + at.height).toBeCloseTo(view.y + view.height - 32, 0);
  // The mouse on the 8th, in the fade: it is the one, where it is.
  const top = await commands.evaluate((el) => el.scrollTop);
  await page.mouse.move(at.x + at.width / 2, view.y + view.height - 8);
  await list.getByRole("option").nth(7).and(page.locator('[aria-selected="true"]')).waitFor();
  expect(await commands.evaluate((el) => el.scrollTop)).toBe(top);
});

smoke("stories 320, 321, 322, 539: on a phone the home's + makes a slot from ~, in a workspace by its button, or in a new one named after the folder picked, and imports one, each opening its chat; 详情's settings change as you change them, and go back to their default", async () => {
  const argv = () => (acted.at(-1)!.act as { argv: string[] }).argv;
  const replies: Record<string, RhReply> = {
    ws: { ok: true, text: "已建工作区 n，默认目录 /n" },
    new: { ok: true, text: "已建槽位 w/s：pi，无头，目录 /w", slot: rests },
    "import --dir": { ok: true, text: "导入哪一个？", panel: { head: ["导入哪一个？"], candidates: [{ label: "Herdr 里 ~/w", command: "/rh_import w1:p1 --name" }, { label: "~/w 写文档", command: "/rh_import s2 --name" }] } },
    import: { ok: true, text: "已导入成 w/doc", slot: finished },
    set: { ok: true, text: "已改。" },
  };
  answer = async () => replies[argv()[1] === "--dir" ? "import --dir" : argv()[0]!]!;
  let n = acted.length;
  // In the order sent: two sent within one look, as a new workspace and then its slot, are each told.
  const sent = async () => (await until(() => acted.length > n), (acted[n++]!.act as { argv: string[] }).argv);
  // finished's reap time is its own.
  const reap = store.tx((tx) => tx.get("slot", finished)!.reapAfter);
  store.tx((tx) => tx.update("slot", { id: finished }, { reapAfter: 600_000 }));
  // w's directory, there to go to; n, a folder no workspace has.
  store.tx((tx) => tx.update("workspace", { id: ws }, { dir: folder("w") }));
  folder("n");
  try {
    const page = await open();
    const plus = page.getByRole("button", { name: "新建", exact: true });
    const box = (await plus.boundingBox())!;
    expect(box.width >= 44 && box.height >= 44).toBe(true);
    await plus.click();
    await page.getByRole("menuitem", { name: "新建槽位" }).click();
    const sheet = page.getByRole("dialog");
    const { path, ws: wsButton, folders } = picker(sheet);
    expect(await path.inputValue()).toBe("~/");
    await wsButton("w").click();
    await wsButton("w").and(page.locator("[aria-pressed=true]")).waitFor();
    await sheet.getByRole("textbox", { name: "槽位名" }).fill("s");
    await sheet.getByRole("radio", { name: "pi" }).click();
    await sheet.getByRole("button", { name: "新建" }).click();
    expect(await sent()).toEqual(["new", "w/s", "--agent", "pi"]);
    await page.waitForURL(`**/#/slot/${rests}`);

    // A folder no workspace has: a new workspace first, named after it, then the slot in it.
    await page.goto(`http://127.0.0.1:${server!.port}/#`);
    await plus.click();
    await page.getByRole("menuitem", { name: "新建槽位" }).click();
    await folders.getByRole("button", { name: "n", exact: true }).click();
    expect(await path.inputValue()).toBe("~/n/");
    await until(async () => (await sheet.getByRole("textbox", { name: "工作区名" }).inputValue()) === "n");
    await sheet.getByRole("textbox", { name: "槽位名" }).fill("main");
    await sheet.getByRole("button", { name: "新建" }).click();
    expect(await sent()).toEqual(["ws", "n", "~/n"]);
    expect(await sent()).toEqual(["new", "n/main", "--agent", "claude"]);
    await page.waitForURL(`**/#/slot/${rests}`);

    // 导入: what there is, for the workspace's directory once listed; one picked and named.
    await page.goto(`http://127.0.0.1:${server!.port}/#`);
    await plus.click();
    await page.getByRole("menuitem", { name: "导入" }).click();
    await wsButton("w").click();
    await wsButton("w").and(page.locator("[aria-pressed=true]")).waitFor();
    await sheet.getByRole("button", { name: "列出" }).click();
    expect(await sent()).toEqual(["import", "--dir", "~/w"]);
    await sheet.getByRole("radio", { name: "~/w 写文档" }).click();
    await sheet.getByRole("textbox", { name: "槽位名" }).fill("doc");
    await sheet.getByRole("button", { name: "导入" }).click();
    expect(await sent()).toEqual(["import", "s2", "--name", "doc"]);
    await page.waitForURL(`**/#/slot/${finished}`);

    // 详情's settings, folded: a switch sends on, a duration as picked; one of its own goes back to its default.
    await page.getByRole("button", { name: "详情" }).click();
    const details = page.getByRole("dialog");
    await details.getByText("设置", { exact: true }).click();
    await details.getByRole("switch", { name: "审批模式" }).click();
    expect(await sent()).toEqual(["set", finished, "approval=on"]);
    expect(await details.getByRole("combobox", { name: "回收时长" }).inputValue()).toBe("600000");
    await details.getByRole("combobox", { name: "回收时长" }).selectOption({ label: "1 小时" });
    expect(await sent()).toEqual(["set", finished, "reap=3600s"]);
    await details.getByRole("button", { name: "回收时长回到默认" }).click();
    expect(await sent()).toEqual(["set", finished, "reap=default"]);
    await details.getByRole("switch", { name: "一次性" }).click();
    expect(await sent()).toEqual(["set", finished, "lifetime=oneoff"]);
  } finally {
    store.tx((tx) => (tx.update("slot", { id: finished }, { reapAfter: reap }), tx.update("workspace", { id: ws }, { dir: "/w" })));
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("#280, #286, #595: on a 360px phone the home's header fits, the + and the settings' gear in it, the round trip at three digits, and the page does not scroll sideways; the round trip goes to Rhodium's page", async () => {
  const page = await open("", undefined, { ...devices["Pixel 7"], viewport: { width: 360, height: 780 } });
  const status = page.getByRole("link", { name: "状态" });
  await status.getByText(/^\d+ms$/).evaluate((e) => (e.textContent = "999ms"));
  const box = (await page.getByRole("button", { name: "设置" }).boundingBox())!;
  expect([box.x + box.width <= 360, await page.evaluate(() => document.documentElement.scrollWidth)]).toEqual([true, 360]);
  const plus = (await page.getByRole("button", { name: "新建", exact: true }).boundingBox())!;
  expect(plus.width >= 44 && plus.height >= 44).toBe(true);
  expect(await status.locator("svg").isVisible()).toBe(false);
  await status.click();
  await until(() => new URL(page.url()).hash === "#/rhodium");
});

smoke("#288: on a wide screen the way to Rhodium's page has an icon beside the round trip; a file dropped off the chat, on the list or the header, does not take the page away", async () => {
  const page = await open("", undefined, { viewport: { width: 1440, height: 900 } } as (typeof devices)[string]);
  const status = page.getByRole("link", { name: "状态" });
  await status.getByText(/^\d+ms$/).waitFor();
  expect(await status.locator("svg").isVisible()).toBe(true);
  // Whether the page kept the browser from opening the file, for both events.
  const drop = (selector: string) =>
    page.locator(selector).first().evaluate((el) => {
      const data = new DataTransfer();
      data.items.add(new File(["x"], "notes.txt", { type: "text/plain" }));
      const kept = (type: string) => !el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
      return [kept("dragover"), kept("drop")];
    });
  expect(await drop("header")).toEqual([true, true]);
  expect(await drop("main")).toEqual([true, true]);
});

smoke("#288: the round trip's icon is for a wide screen only, there where it fits: not on a 768px home, but in the list of a 1180px split at its default width, the header whole in it at three digits", async () => {
  const narrow = await open("", undefined, { viewport: { width: 768, height: 900 } } as (typeof devices)[string]);
  const status = narrow.getByRole("link", { name: "状态" });
  await status.getByText(/^\d+ms$/).waitFor();
  expect(await status.locator("svg").isVisible()).toBe(false);

  const split = await open(`/slot/${finished}`, undefined, { viewport: { width: 1180, height: 900 } } as (typeof devices)[string]);
  await split.getByRole("heading", { name: "w/finished" }).waitFor();
  const icon = split.getByRole("link", { name: "状态" });
  await icon.getByText(/^\d+ms$/).evaluate((e) => (e.textContent = "999ms"));
  expect(await icon.locator("svg").isVisible()).toBe(true);
  const line = (await split.getByRole("separator").boundingBox())!;
  expect((await split.locator("main header > :last-child").evaluate((b) => b.getBoundingClientRect().right)) - (line.x + line.width / 2)).toBeLessThanOrEqual(0);
});

smoke("#280, story 542: the import sheet stays as wide as the phone with a long label, its check mark in sight; a folder is looked in once you list it, a pane picked there shows no workspace for it, and a conversation picked in one no workspace has imports with nothing sent first; an open chat does not ask for /api/board", async () => {
  const argv = () => (acted.at(-1)!.act as { argv: string[] }).argv;
  const long = "Herdr 里 ~/Rhodium-wt/ww-267-with-a-rather-long-worktree-name 10:15 改一下导入单子";
  answer = async () =>
    argv()[1] === "--dir" ? { ok: true, text: "导入哪一个？", panel: { head: ["导入哪一个？"], candidates: [{ label: long, command: "/rh_import w1:p1 --name" }, { label: "~/x 写文档", command: "/rh_import s2 --name" }] } } : { ok: true, text: "已导入成 x/s2", slot: finished };
  let n = acted.length;
  // In the order sent: two sent within one look, as a new workspace and then its slot, are each told.
  const sent = async () => (await until(() => acted.length > n), (acted[n++]!.act as { argv: string[] }).argv);
  try {
    folder("x");
    const page = await open();
    await page.getByRole("button", { name: "新建", exact: true }).click();
    await page.getByRole("menuitem", { name: "导入" }).click();
    const sheet = page.getByRole("dialog");
    await sheet.getByRole("button", { name: "列出" }).click();
    expect(await sent()).toEqual(["import", "--dir", "~"]);
    await sheet.getByRole("textbox", { name: "工作区名" }).fill("");
    await sheet.getByRole("radio", { name: long }).click();
    // A pane lands by its own directory: no workspace for this folder, shown or needed.
    expect([await sheet.getByRole("textbox", { name: "工作区名" }).count(), await sheet.getByRole("button", { name: "导入" }).isEnabled()]).toEqual([0, true]);
    const width = page.viewportSize()!.width;
    expect(await sheet.locator("form").evaluate((f) => f.scrollWidth <= f.clientWidth)).toBe(true);
    const check = (await sheet.getByRole("radio", { name: long }).locator("svg").boundingBox())!;
    expect(check.x + check.width <= width).toBe(true);

    // Another folder, no workspace's: looked in when you list it; the import makes its workspace, by the
    // name suggested.
    await picker(sheet).folders.getByRole("button", { name: "x", exact: true }).click();
    expect(await sheet.getByRole("radio").count()).toBe(0);
    await sheet.getByRole("button", { name: "列出" }).click();
    expect(await sent()).toEqual(["import", "--dir", "~/x"]);
    await sheet.getByRole("radio", { name: "~/x 写文档" }).click();
    await sheet.getByRole("button", { name: "导入" }).click();
    expect(await sent()).toEqual(["import", "s2"]);
    await page.waitForURL(`**/#/slot/${finished}`);

    // In the chat, the import sheet closed: what the page asks for again on an event is not the board's.
    await page.getByRole("log", { name: "对话" }).waitFor();
    const asked: string[] = [];
    page.on("request", (r) => void (r.url().includes("/api/") && asked.push(new URL(r.url()).pathname)));
    create("evented");
    await until(() => asked.includes("/api/slot"));
    expect(asked).not.toContain("/api/board");
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("stories 538, 541, 542: the picker's path completes as you type, by a folder's start in any case, and on Tab, which leaves it, as Shift+Tab does, when there is no more to add; a folder tapped is gone into, the sheet staying put while it is listed and the path showing its end, its branch, its new workspace's name and its files shown, how many more too; hidden folders show once you type a dot; Enter goes in without making anything", async () => {
  mkdirSync(join(base, "proj/.git"), { recursive: true });
  writeFileSync(join(base, "proj/.git/HEAD"), "ref: refs/heads/main\n");
  writeFileSync(join(folder("proj/src"), "index.ts"), "");
  folder("proj/sandbox");
  const long = "a-folder-named-long-enough-to-run-past-the-path-field";
  for (let i = 0; i < 9; i++) writeFileSync(join(folder(`proj/src/${long}`), `file-${i}.ts`), "");
  const before = acted.length;
  const page = await open();
  await page.getByRole("button", { name: "新建", exact: true }).click();
  await page.getByRole("menuitem", { name: "新建槽位" }).click();
  const sheet = page.getByRole("dialog");
  const { path, folders } = picker(sheet);
  await path.fill("~/PR");
  await folders.getByRole("button", { name: "proj", exact: true }).waitFor();
  await path.press("Tab");
  expect(await path.inputValue()).toBe("~/proj/");
  await folders.getByRole("button", { name: "src", exact: true }).click();
  expect(await path.inputValue()).toBe("~/proj/src/");
  await sheet.getByText("main", { exact: true }).waitFor();
  await sheet.getByText("index.ts").waitFor();
  expect(await sheet.getByRole("textbox", { name: "工作区名" }).inputValue()).toBe("src");
  await path.fill("~/proj/");
  await folders.getByRole("button", { name: "src", exact: true }).waitFor();
  expect(await folders.getByRole("button", { name: ".git" }).count()).toBe(0);
  await path.fill("~/proj/.");
  await folders.getByRole("button", { name: ".git" }).waitFor();
  const focused = () => path.evaluate((f) => f === document.activeElement);
  await path.fill("~/proj/s");
  await path.press("Tab");
  expect([await path.inputValue(), await focused()]).toEqual(["~/proj/s", false]);
  await path.fill("~/proj/sr");
  await path.press("Shift+Tab");
  expect([await path.inputValue(), await focused()]).toEqual(["~/proj/sr", false]);
  await path.fill("~/proj/src");
  await path.press("Enter");
  expect(await path.inputValue()).toBe("~/proj/src/");
  expect([await sheet.isVisible(), acted.length]).toEqual([true, before]);

  // Its answer held: what was there stays till it comes.
  let release!: () => void;
  const held = new Promise<void>((go) => (release = go));
  await page.route("**/api/dirs?*", async (r) => (await held, await r.continue()));
  const top = () => sheet.evaluate((e) => e.getBoundingClientRect().top);
  const was = await top();
  await folders.getByRole("button", { name: long }).click();
  expect([await path.inputValue(), await top()]).toEqual([`~/proj/src/${long}/`, was]);
  await until(() => path.evaluate((f) => f.scrollLeft > 0 && f.scrollLeft + f.clientWidth >= f.scrollWidth - 1));
  release();
  const more = (await sheet.getByText("+1", { exact: true }).boundingBox())!;
  expect(more.x + more.width <= page.viewportSize()!.width).toBe(true);
  await page.context().close();
});

/** The files the page's HTML lists to fetch ahead (web/vite.config.ts), as paths. */
const later = (page: Page) => page.locator('meta[name="later"]').evaluate((m) => (m as HTMLMetaElement).content.split(" ").map((f) => `/${f}`));

smoke("#356, #386: once the list has come and the page is idle, it fetches the chat's and the topology's files ahead at low priority, one at a time, with the topology's answer; the + comes then too, its files apart; then the chat's code runs, from the cache", async () => {
  const asked: { id: string; path: string; priority: string; at: number }[] = [];
  const done = new Map<string, number>();
  const cached = new Set<string>();
  const page = await open("", async (page) => {
    const cdp = await page.context().newCDPSession(page);
    const paths = new Map<string, string>();
    cdp.on("Network.requestWillBeSent", (e) => {
      const path = new URL(e.request.url).pathname;
      paths.set(e.requestId, path);
      asked.push({ id: e.requestId, path, priority: e.request.initialPriority, at: e.timestamp });
    });
    cdp.on("Network.requestServedFromCache", (e) => void cached.add(e.requestId));
    cdp.on("Network.responseReceived", (e) => void (e.response.fromDiskCache && cached.add(e.requestId)));
    cdp.on("Network.loadingFinished", (e) => void (cached.has(e.requestId) || done.set(paths.get(e.requestId)!, e.timestamp)));
    await cdp.send("Network.enable");
  });
  await page.getByText("rests", { exact: true }).waitFor();
  const files = await later(page);
  expect(files.length).toBeGreaterThan(3);
  await until(() => files.every((f) => done.has(f)) && done.has("/api/topology"), 10_000);
  await page.getByRole("button", { name: "新建" }).waitFor();
  expect(files.filter((f) => /\/(create|write|sheet|lib-shared)-/.test(f))).toEqual([]);
  expect(files.filter((f) => /\/(slot|lib~slot|topology|lib~topology)-/.test(f))).toHaveLength(5);
  // Each of the chat's files asked again, as its code runs, came from the cache.
  await until(() => files.filter((f) => /\/(slot|lib~slot)-/.test(f)).every((f) => asked.some((r) => r.path === f && cached.has(r.id))), 10_000);
  const ahead = asked.filter((r) => (files.includes(r.path) || r.path === "/api/topology") && !cached.has(r.id));
  expect(ahead.filter((r) => !["Low", "VeryLow"].includes(r.priority))).toEqual([]);
  // After the list's answer, each after the one before it came.
  expect(Math.min(...ahead.map((r) => r.at))).toBeGreaterThan(done.get("/api/board")!);
  for (const [i, f] of files.entries()) if (i > 0) expect([f, asked.find((r) => r.path === f)!.at >= done.get(files[i - 1]!)!]).toEqual([f, true]);
  // Once it ran, a row tapped asks for its slot at once: not through lazy, whose first draw React holds 300 ms.
  await page.evaluate((f) => import(f).then(() => {}), files.find((f) => f.startsWith("/assets/slot-"))!);
  const sent = await page.evaluate(async (id) => {
    const at = performance.now();
    document.querySelector<HTMLAnchorElement>(`a[href$="/slot/${id}"]`)!.click();
    const asked = () => performance.getEntriesByType("resource").find((e) => e.name.includes(`/api/slot?id=${id}`));
    while (!asked()) await new Promise((r) => setTimeout(r, 10));
    return asked()!.startTime - at;
  }, talks);
  expect(sent).toBeLessThan(250);
});

smoke("#386: the chat's files failing to come ahead, as the link drops, its code does not run then; once the link is back, a chat opens with no page loaded again", async () => {
  let loads = 0;
  const over = new Set<string>();
  const page = await open("", async (page) => {
    page.on("load", () => void loads++);
    page.on("requestfinished", (r) => void over.add(new URL(r.url()).pathname));
    page.on("requestfailed", (r) => void over.add(new URL(r.url()).pathname));
    await page.route("**/assets/slot-*", (r) => r.abort("internetdisconnected"));
  });
  await page.getByText("rests", { exact: true }).waitFor();
  const files = await later(page);
  await until(() => files.every((f) => over.has(f)), 10_000);
  await page.waitForTimeout(500); // what would run the chat's code then
  await page.unroute("**/assets/slot-*");
  await page.getByRole("link", { name: /^rests/ }).tap();
  await page.getByRole("heading", { name: "w/rests" }).waitFor();
  expect(loads).toBe(1);
});

smoke("#386: a chat seen lately, read above as you left it, whose slot has a new conversation by the time its turn ends, opens at the new one's newest, with no 新消息", async () => {
  const sessions = join(talked, "..");
  const begin = (slot: string, sessionId: string, at: string, p: string) => {
    writeFileSync(join(sessions, `2026-10-23_${sessionId}.jsonl`), Array.from({ length: 60 }, (_, i) => said("user", `${p}q${i}`) + said("assistant", `${p}a${i}`)).join(""));
    store.tx((tx) => {
      const conversation = tx.insert("conversation", { slot, agent: "pi", sessionId, startedAt: Date.now() }).id;
      tx.update("slot", { id: slot }, { conversation });
      if (at) tx.append({ source: "rh", type: "slot_state", slot, data: { mode: "headless", state: at } });
    });
  };
  const slot = store.tx((tx) => tx.insert("slot", { workspace: ws, name: "renewed", dir: "/w", mode: "headless", state: "idle", lifetime: "longterm" }).id);
  begin(slot, "t8", "", "o");
  const page = await open(`/slot/${slot}`);
  const log = page.getByRole("log");
  const go = async (id: string, name: string) => (await page.evaluate((id) => (location.hash = `#/slot/${id}`), id), await page.getByRole("heading", { name }).waitFor());
  await page.getByText("oa59", { exact: true }).waitFor();
  await log.evaluate((el) => (el.scrollTop = el.scrollHeight - el.clientHeight - 300));
  await go(finished, "w/finished");
  // /new from QQ, and its first turn ends: the chat is brought, the new conversation's newest page.
  const brought = page.waitForResponse((r) => r.url().endsWith(`/api/messages?slot=${slot}`));
  begin(slot, "t9", "idle", "n");
  await (await brought).finished();
  await page.waitForTimeout(200);
  await go(slot, "w/renewed");
  await page.getByText("na59", { exact: true }).waitFor();
  expect(await log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThan(1);
  expect(await page.getByRole("button", { name: "新消息" }).count()).toBe(0);
});

smoke("#356: in a browser that saves data, the page fetches nothing ahead; the + comes all the same", async () => {
  const asked: string[] = [];
  const page = await open("", async (page) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "connection", { value: { saveData: true } }));
    page.on("request", (r) => void asked.push(new URL(r.url()).pathname));
  });
  await page.getByRole("button", { name: "新建" }).waitFor();
  const files = await later(page);
  await Bun.sleep(500);
  expect(asked.filter((p) => p === "/api/topology" || files.includes(p))).toEqual([]);
});

smoke("#356: a page whose rhodium now serves another build loads itself again once, as you are idle; still another, not again", async () => {
  let streams = 0;
  let loads = 0;
  const page = await open("", async (page) => {
    page.on("load", () => void loads++);
    // Each stream says another build, ends, and the browser opens another 100 ms on.
    await page.route("**/api/events", (r) => (streams++, r.fulfill({ contentType: "text/event-stream", body: 'retry: 100\nevent: page\ndata: {"entry":"./assets/index-other.js"}\n\n' })));
  });
  await until(() => loads === 2);
  const after = streams;
  await until(() => streams >= after + 5);
  expect(loads).toBe(2);
  await page.getByText("rests", { exact: true }).waitFor();
});

smoke("#356: on a wide screen the mouse resting on a slot's row brings its chat's newest page before it is clicked", async () => {
  const asked: string[] = [];
  const page = await open("", undefined, devices["Desktop Chrome"]);
  page.on("request", (r) => void asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
  await page.locator(`a[href$="/slot/${talks}"]`).hover();
  await until(() => asked.includes(`/api/messages?slot=${talks}`));
  expect(asked).toContain(`/api/slot?id=${talks}`);
});

smoke("#356: a page that knows of another build is not loaded again under you: not while you are at it, only as it comes back in front; nor then with files attached, a send still going or words in a field, till they are gone", async () => {
  let other = false;
  let streams = 0;
  let loads = 0;
  let sent = (_: RhReply) => {};
  answer = () => new Promise((done) => (sent = done));
  try {
    const page = await open(`/slot/${rests}`, async (page) => {
      page.on("load", () => void loads++);
      // Each stream says the build, none at first, ends, and the browser opens another 100 ms on.
      await page.route(/\/api\/events/, (r) => (streams++, r.fulfill({ contentType: "text/event-stream", body: `retry: 100\nevent: page\ndata: {"entry":${other ? '"./assets/index-other.js"' : "null"}}\n\n` })));
    });
    const box = page.getByRole("textbox", { name: "消息" });
    await box.waitFor();
    /** Some streams on, and a tick of the page's clock. */
    const heard = async () => {
      const after = streams;
      await until(() => streams >= after + 5);
      await Bun.sleep(1_100);
    };
    const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    // Another build comes as you read, a key pressed: not under you.
    await page.keyboard.press("Shift");
    other = true;
    await heard();
    expect(loads).toBe(1);
    // Files attached, then back in front: nor then.
    await page.locator('input[type="file"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await comeBack();
    await heard();
    expect(loads).toBe(1);
    // Sent, still going up: nor then.
    await box.fill("带图");
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => (acted.at(-1)?.act as { slot?: string } | undefined)?.slot === rests);
    await page.getByRole("list", { name: "附件" }).waitFor({ state: "detached" });
    await comeBack();
    await heard();
    expect(loads).toBe(1);
    // It came back, but words wait in a field other than the message's, as an ask's 自己写: nor then.
    await page.evaluate(() => document.body.append(Object.assign(document.createElement("input"), { id: "own", value: "先不推" })));
    sent({ ok: true, text: "" });
    await heard();
    expect(loads).toBe(1);
    // Nothing left to lose: now.
    await page.evaluate(() => ((document.getElementById("own") as HTMLInputElement).value = ""));
    await until(() => loads === 2);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("#356: a message that failed to send, red to try again, keeps a page that knows of another build from loading again, in the chat open or one left, till you let it go", async () => {
  let other = false;
  let streams = 0;
  let loads = 0;
  answer = async () => ({ ok: false, error: "连不上 Rhodium。" });
  try {
    const page = await open(`/slot/${rests}`, async (page) => {
      page.on("load", () => void loads++);
      await page.route(/\/api\/events/, (r) => (streams++, r.fulfill({ contentType: "text/event-stream", body: `retry: 100\nevent: page\ndata: {"entry":${other ? '"./assets/index-other.js"' : "null"}}\n\n` })));
    });
    const heard = async () => {
      const after = streams;
      await until(() => streams >= after + 5);
      await Bun.sleep(1_100);
    };
    const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    const box = page.getByRole("textbox", { name: "消息" });
    await box.fill("升级时没发出去");
    await page.getByRole("button", { name: "发送" }).click();
    await page.getByRole("button", { name: "重试" }).waitFor();
    other = true;
    await comeBack();
    await heard();
    expect(loads).toBe(1);
    // Another chat open, the failed one kept in the one left: nor then.
    await page.evaluate((id) => (location.hash = `#/slot/${id}`), talks);
    await page.getByText("a59", { exact: true }).waitFor();
    await comeBack();
    await heard();
    expect(loads).toBe(1);
    // Back to it, and let go: now.
    await page.evaluate((id) => (location.hash = `#/slot/${id}`), rests);
    await page.getByRole("button", { name: "不发了" }).click();
    await comeBack();
    await until(() => loads === 2);
  } finally {
    answer = () => Promise.resolve({ ok: true, text: "已停下这一回合，对话留着。" });
  }
});

smoke("#356: the mouse brings a row's chat ahead only once it moves onto the row and rests, not as a wheel scrolls the row under it; leaving the row stops what is still coming", async () => {
  const asked: string[] = [];
  const page = await open("", async (page) => {
    // What the page stops, as fetch has it; and the chat's newest page, held up.
    await page.addInitScript(() => {
      const f = window.fetch;
      const w = window as unknown as { stopped: string[] };
      w.stopped = [];
      window.fetch = ((u: RequestInfo | URL, init?: RequestInit) => (init?.signal?.addEventListener("abort", () => w.stopped.push(String(u))), f(u, init))) as typeof fetch;
    });
    await page.route(/\/api\/messages\?slot=/, () => {});
  }, devices["Desktop Chrome"]);
  page.on("request", (r) => void asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
  const row = page.locator(`a[href$="/slot/${talks}"]`);
  await row.waitFor();
  // A wheel brings the row under the still mouse: over it, no move.
  await row.dispatchEvent("pointerover", { pointerType: "mouse", isPrimary: true });
  await Bun.sleep(400);
  expect(asked.filter((p) => p.includes(talks))).toEqual([]);
  await row.hover();
  await until(() => asked.includes(`/api/messages?slot=${talks}`));
  await page.mouse.move(2, 2);
  await until(async () => (await page.evaluate(() => (window as unknown as { stopped: string[] }).stopped)).includes(`api/messages?slot=${encodeURIComponent(talks)}`));
});

smoke("#356, spec web-write \"列表行的菜单\": on a phone a finger down on a slot's row, which may start a scroll of the list, brings none of its chat, nor the mouse's right button, which opens its menu; the mouse down does", async () => {
  const asked: string[] = [];
  const page = await open();
  page.on("request", (r) => void asked.push(new URL(r.url()).pathname + new URL(r.url()).search));
  const row = page.locator(`a[href$="/slot/${talks}"]`);
  await row.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true });
  await row.dispatchEvent("pointerdown", { pointerType: "mouse", isPrimary: true, button: 2 });
  await Bun.sleep(500);
  expect(asked.filter((p) => p.includes(talks))).toEqual([]);
  await row.dispatchEvent("pointerdown", { pointerType: "mouse", isPrimary: true });
  await until(() => asked.includes(`/api/messages?slot=${talks}`));
});

smoke("#356: our icons go with our code, so one more of them renames none of the libraries' files", async () => {
  const libs = readdirSync(join(base, "web/assets")).filter((f) => /^lib.*\.js$/.test(f));
  expect(libs.length).toBeGreaterThan(3);
  expect(libs.filter((f) => readFileSync(join(base, "web/assets", f), "utf8").includes("lucide"))).toEqual([]);
});

smoke("stories 470, 472, 473: a turn ending unseen lights a green dot on its row in the list and the sidebar, and on the collapsed sidebar's button, and counts in the title; opening its chat clears them; so on a phone", async () => {
  const slot = store.tx((tx) => tx.find("slot", { name: "more3" }))[0]!.id;
  /** slot's turn ends, as the event table has it. */
  const end = () =>
    store.tx((tx) => {
      for (const state of ["running", "idle"]) tx.append({ source: "agent", type: "slot_state", slot, data: { state, mode: "headless" } });
    });
  const dot = (page: Page | Locator) => page.getByRole("link", { name: /^more3(?!\d)/ }).getByRole("img", { name: "未读" });

  const page = await open(`/slot/${finished}`, undefined, wide());
  await page.getByText(/^\d+ms$/).waitFor();
  expect(await page.title()).toBe("Rhodium");
  end();
  await dot(page).waitFor();
  expect(await page.title()).toBe("(1) Rhodium");
  await page.getByRole("button", { name: "放大" }).click();
  const side = page.getByRole("navigation", { name: "槽位" });
  await dot(side).waitFor();
  // Amber for a slot that needs you comes first: green with none.
  await page.getByRole("button", { name: "收起侧栏" }).click();
  await page.getByRole("button", { name: "展开侧栏，有需要你的" }).waitFor();
  const asks = (state: "idle" | "waiting") =>
    store.tx((tx) => {
      tx.update("slot", { id: asking }, { state });
      tx.append({ source: "agent", type: "slot_state", slot: asking, data: { state, mode: "headless" } });
    });
  asks("idle");
  try {
    await page.getByRole("button", { name: "展开侧栏，有未读的" }).click();
    await side.getByRole("link", { name: /^more3(?!\d)/ }).click();
    await page.getByRole("heading", { name: "w/more3" }).waitFor();
    await dot(side).waitFor({ state: "detached" });
    expect(await page.title()).toBe("Rhodium");
    await page.getByRole("button", { name: "收起侧栏" }).click();
    await page.getByRole("button", { name: "展开侧栏", exact: true }).waitFor();
  } finally {
    asks("waiting");
  }
  await page.context().close();

  const phone = await open();
  await phone.getByText(/^\d+ms$/).waitFor();
  end();
  await dot(phone).waitFor();
  expect(await phone.title()).toBe("(1) Rhodium");
  await phone.getByRole("link", { name: /^more3(?!\d)/ }).click();
  await phone.getByRole("heading", { name: "w/more3" }).waitFor();
  await until(async () => (await phone.title()) === "Rhodium");
  await phone.context().close();
});

smoke("story 475: the first message sent from the web on this device asks for leave to remind you, the next ones do not", async () => {
  const page = await open(
    `/slot/${rests}`,
    async (p) =>
      void (await p.addInitScript(() => {
        const w = window as unknown as { asked: number };
        w.asked = 0;
        // A browser that has not asked yet; dismissed, it stays so.
        class Fake {
          static permission = "default";
          static requestPermission = async () => (w.asked++, "default");
          close() {}
        }
        Object.defineProperty(window, "Notification", { value: Fake, configurable: true, writable: true });
      })),
    wide(),
  );
  const box = page.getByRole("textbox", { name: "消息" });
  for (const words of ["先看看日志", "再跑一遍测试"]) {
    await box.fill(words);
    await page.getByRole("button", { name: "发送" }).click();
    await until(() => JSON.stringify(acted.at(-1)?.act ?? null).includes(words));
  }
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(1);
  await page.context().close();
});

smoke("#491: maximize mode's sidebar has a gear pinned at its bottom; its card picks the theme, as the home header's gear does, and turns reminders on this device on, asking for leave in that click, or off; denied, it says where to allow them", async () => {
  const page = await open(
    `/slot/${rests}?full`,
    async (p) =>
      void (await p.addInitScript(() => {
        const w = window as unknown as { asked: number };
        w.asked = 0;
        class Fake {
          static permission = "default";
          static requestPermission = async () => (w.asked++, (Fake.permission = "granted"));
          close() {}
        }
        Object.defineProperty(window, "Notification", { value: Fake, configurable: true, writable: true });
      })),
    wide(),
  );
  const gear = page.getByRole("button", { name: "设置" });
  // Where it is, the list scrolled to its top or its end.
  const at = async () => (await gear.boundingBox())!.y;
  const top = await at();
  await page.getByRole("navigation", { name: "槽位" }).evaluate((nav) => void (nav.parentElement!.scrollTop = 1e6));
  expect(await at()).toBe(top);
  expect(top).toBeGreaterThan(800);

  await gear.click();
  const card = page.getByRole("dialog");
  await card.getByRole("button", { name: "深色" }).click();
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("dark");
  expect(await card.getByRole("button", { name: "深色" }).getAttribute("aria-pressed")).toBe("true");
  const remind = card.getByRole("switch", { name: "通知" });
  expect(await remind.getAttribute("aria-checked")).toBe("false");
  await remind.click();
  await until(async () => (await remind.getAttribute("aria-checked")) === "true");
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(1);
  await remind.click();
  await until(async () => (await remind.getAttribute("aria-checked")) === "false");

  await page.evaluate(() => void ((window as unknown as { Notification: { permission: string } }).Notification.permission = "denied"));
  await page.keyboard.press("Escape");
  await card.waitFor({ state: "detached" });
  await gear.click();
  await card.getByText("要在浏览器的网站设置里重新允许").waitFor();
  expect(await remind.isDisabled()).toBe(true);
  await page.context().close();
});

smoke("#595: with 终端入口 off in the settings, no way to switch a slot to the terminal shows: the key under where you type, 切到终端 in a row's menu and the topology's; a slot in the terminal keeps its terminal and 收回终端. With no Herdr, the same, the switch greyed, saying so", async () => {
  const items = (p: Page) => p.getByRole("menuitem");
  /** Whether each way to switch an idle headless slot to the terminal shows on p: a row's menu, the key under where you type, the topology's menu. */
  const ways = async (p: Page) => {
    await p.goto(`http://127.0.0.1:${server!.port}/#/`);
    await p.locator(`a[href$="/slot/${rests}"]`).click({ button: "right" });
    await items(p).first().waitFor();
    const row = (await items(p).allInnerTexts()).includes("切到终端");
    await p.keyboard.press("Escape");
    await p.goto(`http://127.0.0.1:${server!.port}/#/slot/${talks}`);
    // The agent and the model stay.
    await p.getByRole("button", { name: "换 agent" }).waitFor();
    const key = (await p.getByRole("button", { name: "切到终端", exact: true }).count()) > 0;
    await p.goto(`http://127.0.0.1:${server!.port}/#/topology/slot/${talks}`);
    await sheetOf(p).getByRole("button", { name: "操作" }).click();
    await items(p).first().waitFor();
    const topology = (await items(p).allInnerTexts()).includes("切到终端");
    await p.keyboard.press("Escape");
    return { row, key, topology };
  };
  const page = await open();
  expect(await ways(page)).toEqual({ row: true, key: true, topology: true });
  await page.goto(`http://127.0.0.1:${server!.port}/#/`);
  await page.getByRole("button", { name: "设置" }).click();
  const entry = page.getByRole("dialog").getByRole("switch", { name: "终端入口" });
  expect(await entry.getAttribute("aria-checked")).toBe("true");
  await entry.click();
  expect(await entry.getAttribute("aria-checked")).toBe("false");
  await page.keyboard.press("Escape");
  expect(await ways(page)).toEqual({ row: false, key: false, topology: false });
  // In the terminal: its terminal, the switch to its chat log, and 收回终端 in 更多.
  await page.goto(`http://127.0.0.1:${server!.port}/#/slot/${term}`);
  await page.getByRole("region", { name: "终端" }).waitFor();
  await page.getByRole("button", { name: "对话记录" }).waitFor();
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "收回终端" }).waitFor();
  await page.context().close();

  // The board says it finds no Herdr.
  const none = await open("", async (p) => void (await p.route("**/api/board", async (r) => r.fulfill({ json: { ...(await (await r.fetch()).json()), noHerdr: true } }))));
  await none.getByRole("button", { name: "设置" }).click();
  const greyed = none.getByRole("dialog").getByRole("switch", { name: "终端入口" });
  expect(await greyed.isDisabled()).toBe(true);
  await none.getByRole("dialog").getByText("没装 Herdr", { exact: true }).waitFor();
  await none.keyboard.press("Escape");
  expect(await ways(none)).toEqual({ row: false, key: false, topology: false });
  await none.context().close();
});
