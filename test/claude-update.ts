// A claude that rh doctor finds healthy (architecture §12), for tests: a fake claude install dir,
// with package.json one level above bin/claude, a "binary" holding the protocol names, and a fake
// agent that answers the handshake.
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROTOCOL } from "../src/doctor";
import { installFakeAgent, type Script } from "./fake-agent/fake-agent";
import { endTurn, startTurn } from "./fake-agent/scripts";
import type { Instance } from "./instance";

const j = JSON.stringify;

/** names: the protocol names its bytes hold (all of them). without, extra, context, fail: see handshake. */
export type UpdateOptions = { names?: string[]; without?: string[]; extra?: object; context?: object; bare?: boolean; fail?: boolean };

/** Handlers answering the handshake as 2.1.304 does, trimmed: initialize's inner response without
 *  the keys in `without` and with `extra`, and get_context_usage's with `context`. fail: initialize
 *  answers an error. */
function handshake(version: string, without: string[], extra: object, context: object, fail = false): NonNullable<Script["on"]> {
  const init: Record<string, unknown> = {
    commands: [{ name: "review", description: "Review a pull request", argumentHint: "" }],
    models: [{ value: "haiku", displayName: "Haiku" }],
    account: { email: "user@example.com", subscriptionType: "Claude Max", apiProvider: "firstParty" },
    claude_code_version: version,
    capabilities: [],
    ...extra,
  };
  for (const k of without) delete init[k];
  const answer = (response: object, outer: object = {}) =>
    j({ type: "control_response", response: { subtype: "success", request_id: "{{in.request_id}}", response, ...outer } });
  return [
    {
      match: { type: "control_request", request: { subtype: "initialize" } },
      emit: fail
        ? [j({ type: "control_response", response: { subtype: "error", request_id: "{{in.request_id}}", error: "busy" } })]
        : [answer(init, { pending_permission_requests: [], pending_user_dialog_requests: [] })],
    },
    {
      match: { type: "control_request", request: { subtype: "get_context_usage" } },
      emit: [
        answer({
          totalTokens: 100,
          maxTokens: 200000,
          percentage: 0,
          model: "claude-haiku",
          mcpTools: [{ name: "mcp__qq__send", serverName: "qq" }],
          ...context,
        }),
      ],
    },
    { match: { type: "control_request" }, emit: [answer({})] },
  ];
}

/**
 * Puts claude <version> in place, as an update does: package.json and bin/claude, whose bytes hold
 * `names`. It answers the handshake (see handshake) and runs turns that end with "pong". bare: a
 * wrapper launches it with --bare added.
 */
export function updateClaude(rhodium: Instance, version: string, o: UpdateOptions = {}): void {
  const bin = join(rhodium.dir, "bin");
  const on = handshake(version, o.without ?? [], o.extra ?? {}, o.context ?? {}, o.fail);
  const script: Script = { on, steps: [...startTurn, ...endTurn("pong")] };
  const names = (o.names ?? Object.keys(PROTOCOL)).join(" ");
  if (o.bare) {
    const real = installFakeAgent(bin, { script, log: `${rhodium.claude.path}.log` }, "claude-real");
    writeFileSync(rhodium.claude.path, `#!/bin/sh\nexec ${real.path} --bare "$@"\n# ${names}\n`, { mode: 0o755 });
  } else {
    installFakeAgent(bin, { script }, "claude");
    appendFileSync(rhodium.claude.path, `// ${names}\n`);
  }
  writeFileSync(join(rhodium.dir, "package.json"), j({ name: "@anthropic-ai/claude-code", version }));
}
