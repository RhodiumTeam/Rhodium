// One binary, two faces: invoked as `rh` (or as `rhodium rh ...`) it is the command line,
// otherwise it is the `rhodium` daemon. Each loads only its own face: rh starts without the
// daemon's IM SDKs and board.
import { basename, join } from "node:path";
import { BUILD } from "./config";

const args = process.argv.slice(2);

if (args[0] === "--version") {
  console.log(BUILD);
} else if (process.platform === "win32" && (args[0] === "--internal-tui-agent" || args[0] === "--internal-tui-codex") && args.length === 2) {
  try { process.exit(await (await import("./windows-tui-launch")).runWindowsPane(args[1]!, args[0] === "--internal-tui-codex")); }
  catch (err) { console.error((err as Error).message); process.exit(1); }
} else if (args[0] === "--schema" && args[1] === "--config" && args.length === 3) {
  // For deploy/upgrade.sh: the schema of the database the daemon run with this config uses.
  const [{ loadConfig }, { schemaOf }] = await Promise.all([import("./config"), import("./store")]);
  console.log(schemaOf(join(loadConfig(args[2]!).stateDir, "rh.db")));
} else if (basename(process.argv0) === "rh" || (process.platform === "win32" && basename(process.execPath).toLowerCase() === "rh.exe")) {
  process.exit(await (await import("./rh")).rh(args));
} else if (args[0] === "rh") {
  process.exit(await (await import("./rh")).rh(args.slice(1)));
} else {
  await (await import("./daemon")).runDaemon(args);
}
