// The platform table (architecture §8.1): every platform has its row, its constructor and, where
// rh bot makes it, its onboarding; the row loads no IM SDK, so neither does an ordinary rh call.
import { expect, test } from "bun:test";
import { getMaxUploadSize, MediaFileType } from "@tencent-connect/qqbot-nodejs";
import { ONBOARD } from "../src/bot";
import type { AdapterDeps, Platform } from "../src/contracts";
import { ADAPTERS } from "../src/daemon";
import { FakeBot } from "../src/fake-im";
import { FeishuAdapter } from "../src/feishu";
import { PLATFORMS } from "../src/platforms";
import { QQAdapter } from "../src/qq";
import { TelegramAdapter } from "../src/telegram";
import { exec } from "./instance";

const PLATFORM_KEYS = Object.keys(PLATFORMS) as Platform[];

test("every platform has a constructor, and each builds its own adapter, with its row's capabilities: none falls back to another's", () => {
  expect(Object.keys(ADAPTERS)).toEqual(PLATFORM_KEYS);
  const own = { qq: QQAdapter, telegram: TelegramAdapter, feishu: FeishuAdapter, fake: FakeBot };
  const deps: AdapterDeps = { kept: { get: () => undefined, set() {}, event() {} }, seen: () => false, durations: { feishuEdit: 1234 } };
  for (const platform of PLATFORM_KEYS) {
    const bot = { platform, token: "1:t", appId: "1", secret: "s", like: "feishu", socket: "/nowhere" };
    const adapter = ADAPTERS[platform]("B1", "b", bot, deps);
    expect(adapter).toBeInstanceOf(own[platform]);
    expect(adapter.capabilities).toEqual(PLATFORMS[platform].capabilities(bot, deps.durations));
  }
});

test("rh bot has a scan or paste for every platform it makes, and only those", () => {
  expect(Object.keys(ONBOARD)).toEqual(PLATFORM_KEYS.filter((p) => "bot" in PLATFORMS[p]));
  expect(PLATFORM_KEYS.filter((p) => !("bot" in PLATFORMS[p]))).toEqual(["fake"]);
});

test("QQ's file limits in the table are the SDK's", () => {
  expect(PLATFORMS.qq.capabilities({ platform: "qq" }, { feishuEdit: 0 }).maxFileBytes).toEqual({ image: getMaxUploadSize(MediaFileType.IMAGE), file: getMaxUploadSize(MediaFileType.FILE) });
});

test("rh, its help and the platform table load no IM SDK: only rh bot and rhodium do", async () => {
  const loaded = 'await import("./src/rh.ts"); await import("./src/platforms.ts"); console.log(Object.keys(require.cache).filter((k) => /grammy|qqbot|larksuite/.test(k)).length)';
  const r = await exec(["bun", "-e", loaded], { cwd: `${import.meta.dir}/..` });
  expect({ code: r.code, out: r.out.trim(), err: r.err }).toEqual({ code: 0, out: "0", err: "" });
});
