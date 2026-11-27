// Native executable for the Windows restart smoke test; no account or network.
import { appendFileSync } from "node:fs";
import { run } from "./fake-agent";
import { endTurn, on, startTurn } from "./scripts";

if (!process.argv.includes("--no-session-persistence")) appendFileSync("fake-agent-pids", process.pid + "\n");
// This test reads the holder log, so it never writes native account transcripts.
await run({ transcript: false, script: { on, steps: [...startTurn, { rm: "waiting-for-agent" }, { sleep: 2000 }, ...endTurn("Windows smoke reply"), { goto: 0 }] } });
