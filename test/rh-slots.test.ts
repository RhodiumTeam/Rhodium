import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { newInstance } from "./instance";

const rhodium = newInstance();
beforeAll(() => rhodium.start());
afterAll(() => rhodium.cleanup());

function project(name: string): string {
  const dir = join(rhodium.dir, "projects", name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("story 1: rh ws makes a workspace with a default dir, and rh new without a dir puts the slot there", async () => {
  const shop = project("shop");
  await rhodium.ok("ws", "shop", shop);
  expect(await rhodium.ok("ws")).toMatch(new RegExp(`^shop +${shop}$`, "m"));

  await rhodium.ok("new", "shop/fix-login");
  expect(await rhodium.ok("ls")).toMatch(new RegExp(`^shop/fix-login +claude +.+ ${shop}$`, "m"));
});

test("story 2: one workspace holds several slots with different names; a repeated name is refused", async () => {
  await rhodium.ok("ws", "web", project("web"));
  await rhodium.ok("new", "web/api");
  await rhodium.ok("new", "web/ui");

  const again = await rhodium.rh(["new", "web/api"]);
  expect(again.code).not.toBe(0);
  expect(again.err).toContain("api");

  const slots = (await rhodium.ok("ls")).split("\n").filter((l) => l.startsWith("web/"));
  expect(slots.map((l) => l.split(/ +/)[0])).toEqual(["web/api", "web/ui"]);
});

test("story 3: rh new --dir puts the slot in the given directory, relative to where rh runs", async () => {
  await rhodium.ok("ws", "shop3", project("shop3"));
  const next = project("shop-admin");
  await rhodium.ok("new", "shop3/admin", "--dir", next);
  const rel = await rhodium.rh(["new", "shop3/docs", "--dir", "docs"], { cwd: next });
  expect(rel.code).toBe(0);

  const ls = await rhodium.ok("ls");
  expect(ls).toMatch(new RegExp(`^shop3/admin +.+ ${next}$`, "m"));
  expect(ls).toMatch(new RegExp(`^shop3/docs +.+ ${next}/docs$`, "m"));
});

test("story 22: rh ls lists a new slot as headless and not running, with its agent", async () => {
  await rhodium.ok("ws", "lsws", project("lsws"));
  await rhodium.ok("new", "lsws/a");
  await rhodium.ok("new", "lsws/b", "--agent", "pi");
  const ls = await rhodium.ok("ls");
  expect(ls).toMatch(/^lsws\/a +claude +无头 +未运行 /m);
  expect(ls).toMatch(/^lsws\/b +pi +无头 +未运行 /m);
});

test("commands that don't make sense are refused with a reason, and change nothing", async () => {
  await rhodium.ok("ws", "refws", project("refws"));
  for (const args of [
    ["frobnicate"],
    ["ws", "refws", project("other")], // the name is taken
    ["ws", "a/b", "/tmp"], // a workspace name can't hold the slash
    ["ws", "only-a-name"],
    ["new", "nows/x"], // no such workspace
    ["new", "refws"], // not workspace/slot
    ["new", "refws/x", "--agent", "gemini"], // not one Rhodium runs
    ["new", "refws/x", "--colour", "red"],
    ["ls", "refws/missing"],
  ]) {
    const r = await rhodium.rh(args);
    expect({ args, code: r.code }).toEqual({ args, code: 1 });
    expect(r.err).toStartWith("rh: ");
  }
  expect(await rhodium.ok("ws")).toMatch(new RegExp(`^refws +${project("refws")}$`, "m"));
  expect(await rhodium.ok("ls")).not.toContain("refws/");
});

test("story 16: rh set changes the reap time and ask timeout, rh ls shows them, unknown settings are refused", async () => {
  await rhodium.ok("ws", "setws", project("setws"));
  await rhodium.ok("new", "setws/d");
  // Before: the config file's defaults (1h and 30m), marked as defaults.
  let detail = await rhodium.ok("ls", "setws/d");
  expect(detail).toMatch(/^回收时长: 1h（默认）$/m);
  expect(detail).toMatch(/^提问超时: 30m（默认）$/m);

  await rhodium.ok("set", "setws/d", "reap=off", "ask-timeout=90s");
  detail = await rhodium.ok("ls", "setws/d");
  expect(detail).toMatch(/^回收时长: 从不$/m);
  expect(detail).toMatch(/^提问超时: 90s$/m);

  await rhodium.ok("set", "setws/d", "reap=2h", "ask-timeout=default");
  detail = await rhodium.ok("ls", "setws/d");
  expect(detail).toMatch(/^回收时长: 2h$/m);
  expect(detail).toMatch(/^提问超时: 30m（默认）$/m);

  // A bad item refuses the whole call, so nothing in it changes.
  for (const bad of [["colour=red"], ["reap=3h", "colour=red"], ["reap=soon"], ["approval=maybe"], ["reap"]]) {
    const r = await rhodium.rh(["set", "setws/d", ...bad]);
    expect(r.code).not.toBe(0);
    expect(r.err).not.toBe("");
  }
  expect(await rhodium.ok("ls", "setws/d")).toMatch(/^回收时长: 2h$/m);

  // The flags work the same way.
  await rhodium.ok("set", "setws/d", "approval=on", "crash-resume=off");
  detail = await rhodium.ok("ls", "setws/d");
  expect(detail).toMatch(/^审批模式: 开$/m);
  expect(detail).toMatch(/^崩溃续跑: 关$/m);
  expect(detail).toMatch(/^额度续跑: 开（默认）$/m);

  expect((await rhodium.rh(["set", "setws/nope", "reap=1h"])).code).not.toBe(0);
});

test("story 81: rh set ask-timeout=0 means the slot's asks never time out", async () => {
  await rhodium.ok("ws", "zerows", project("zerows"));
  await rhodium.ok("new", "zerows/d");
  await rhodium.ok("set", "zerows/d", "ask-timeout=0");
  expect(await rhodium.ok("ls", "zerows/d")).toMatch(/^提问超时: 从不$/m);
});
