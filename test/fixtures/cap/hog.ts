// A test that runs away: it takes memory and does not let go. test/cap.test.ts runs it under a cap of
// 256M; it stops at 2G, so that without one it ends by itself.
import { test } from "bun:test";

test("takes 2G of memory", () => {
  const held: Buffer[] = [];
  while (held.length < 32) held.push(Buffer.alloc(64 << 20, 1));
});
