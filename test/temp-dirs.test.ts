// A test file that makes a temp dir also removes it, or every run leaves one under /tmp: nine files
// once did, and their dirs piled up by the hundred. A check on the text, as bun test has no hook
// that reports what a file left behind.
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

test("every test file that makes a temp dir removes it", () => {
  const leaky = readdirSync(import.meta.dir)
    .filter((f) => f.endsWith(".ts"))
    .filter((f) => {
      const text = readFileSync(join(import.meta.dir, f), "utf8");
      return /\bmkdtemp(Sync)?\(/.test(text) && !/\brmSync\(/.test(text);
    });
  expect(leaky).toEqual([]);
});
