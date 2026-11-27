// The actual pane hosts only this test. Its outside observer owns the drain decision.
import { request, sessionSocket } from "../../../src/herdr";

const [herdr, session, python, fixture] = process.argv.slice(2);
if (!session?.startsWith("rhodium-test-") || !process.env.XDG_CONFIG_HOME || !herdr || !python || !fixture) throw new Error("expected test session and private profile");
const at = await sessionSocket(herdr, session);
const cwd = process.cwd();
const job = "Local\\" + session + "-" + crypto.randomUUID();
const { workspace } = await request(at, "workspace.create", { cwd, label: "drain-probe", focus: false });
const { layout } = await request(at, "layout.apply", { workspace_id: workspace.workspace_id,
  root: { type: "pane", cwd, command: [python, "-I", "-u", fixture, "host", job] } });
try {
  const observer = Bun.spawn([python, "-I", "-u", fixture, "observe", job], { cwd, stdin: "ignore", stdout: "inherit", stderr: "inherit", timeout: 50000 });
  if (await observer.exited !== 0) throw new Error("Windows Job drain probe failed");
} finally {
  // Once complete exists the fixture host can also exit naturally.
  await request(at, "pane.close", { pane_id: layout.root.pane_id }).catch(() => {});
}
