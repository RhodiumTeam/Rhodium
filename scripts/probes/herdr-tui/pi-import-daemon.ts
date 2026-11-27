// Test entry point only. The production executable has no switch to substitute its pi check.
import { isAbsolute } from "node:path";
import { runDaemon } from "../../../src/daemon";

const [config, decision] = process.argv.slice(2);
if (!config || !isAbsolute(config) || !config.includes("rhodium-test-") || !["unknown", "true", "false"].includes(decision ?? "")) {
  throw new Error("Expected an isolated test config and a fixture decision");
}
await runDaemon(["--config", config], async () => decision === "unknown" ? null : decision === "true");
