// rh bot qq's scan against the stand-in for QQ's QR service (test/fake-qq-connect.ts), in process:
// a call with no answer is asked again, and only five in a row give up, in Chinese (#535).
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { ONBOARD } from "../src/bot";
import { outage, QR } from "./fake-qq-connect";

const CREATE = "/lite/create_bind_task";
const POLL = "/lite/poll_bind_result";
const scan = () => ONBOARD.qq.credentials(undefined, false);

beforeEach(() => {
  spyOn(Bun, "sleep").mockResolvedValue(undefined); // its 2 s waits
  spyOn(process.stdout, "write").mockReturnValue(true); // its QR codes
});
afterEach(() => {
  mock.restore();
  for (const path in outage) delete outage[path];
});

test("rh bot qq rides out calls to QQ's QR service that time out, four in a row on making the QR code and on polling it", async () => {
  Object.assign(outage, { [CREATE]: 4, [POLL]: 4 });
  expect(await scan()).toEqual({ appId: QR.appId, secret: QR.secret, owner: QR.openid });
  expect(outage).toEqual({ [CREATE]: 0, [POLL]: 0 });
});

test("rh bot qq gives up after five calls in a row with no answer, saying so in Chinese; while polling, that QQ may have made the bot already", async () => {
  outage[CREATE] = 5;
  await expect(scan()).rejects.toThrow(/^连不上 QQ 的扫码服务。$/);
  outage[POLL] = 5;
  await expect(scan()).rejects.toThrow(/^连不上 QQ 的扫码服务。扫了码的话，QQ 那边可能已经建好了 Bot，去 QQ 开放平台（q\.qq\.com）看看。$/);
});

test("rh bot qq, given five pages in a row that are not JSON, gives up with the last one's HTTP status, but not when a reply stops halfway", async () => {
  const reply = (page: () => Response) => spyOn(globalThis, "fetch").mockImplementation((async (_: string) => page()) as typeof fetch);
  reply(() => new Response("<html>Not Found</html>", { status: 404 }));
  await expect(scan()).rejects.toThrow(/^连不上 QQ 的扫码服务（HTTP 404）。$/);
  const stalled = new DOMException("The operation timed out.", "TimeoutError");
  reply(() => new Response(new ReadableStream({ pull: (c) => c.error(stalled) })));
  await expect(scan()).rejects.toThrow(/^连不上 QQ 的扫码服务。$/);
});
