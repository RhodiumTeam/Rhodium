// The dispatcher's CLAUDE.md (story 160): it works through rh, not Herdr commands or qq-cli.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("story 160: the dispatcher's CLAUDE.md uses rh spawn and rh send, with no Herdr commands, qq send or [QQ]", () => {
  const text = readFileSync(join(import.meta.dir, "../deploy/dispatcher/CLAUDE.md"), "utf8");
  expect(text).toContain("rh spawn");
  expect(text).toContain("rh send");
  expect(text).not.toMatch(/\bherdr\s+[a-z-]/i);
  expect(text).not.toMatch(/\bqq (send|ask)\b/);
  expect(text).not.toContain("[QQ]");
});
