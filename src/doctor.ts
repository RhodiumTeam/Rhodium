// rh doctor (architecture §12): checks that Rhodium and the installed claude and codex still fit together,
// above all after Claude updates itself, plus the daily health checks. It only reports, by
// level: errors and warnings. It never refuses to start a slot.
import type { Subprocess } from "bun";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { headlessEnv } from "./agents";
import { ClaudeDriver, refuseBare } from "./claude";
import { CodexDriver, codexModelNames } from "./codex";
import { formatGB, formatMB, hasHerdr, locate, type Config } from "./config";
import { log } from "./daemon";
import { request, sessionSocket } from "./herdr";
import { daily, freeDisk } from "./ops";
import { activeHolders, agentBaseEnv } from "./runner";
import { modelNames, setMeta, setModelNames, type Store } from "./store";

/**
 * The protocol names v1 uses, each with what degrades without it. A claude binary missing any of
 * them is not handshaken with (probe 1, docs/spec/v1.md "真机探针").
 */
export const PROTOCOL: Record<string, string> = {
  initialize: "握手，也就是和 Claude 的全部通信",
  can_use_tool: "审批、选择题和计划确认",
  control_cancel_request: "撤回 Claude 不再等的提问",
  interrupt: "/stop 和 ! 打断",
  set_model: "/model",
  apply_flag_settings: "/effort 和 /ultracode",
  get_settings: "/ultracode",
  ultracodeAvailable: "/ultracode",
  get_context_usage: "/context",
  get_usage: "/usage",
  set_permission_mode: "审批模式立即生效",
  session_state_changed: "判断回合开始和结束，也就是代发最终回复",
  rate_limit_event: "额度用完时的等待和续跑",
  background_tasks_changed: "跟踪后台任务，有后台任务时不关进程",
  compact_boundary: "/compact",
  stream_event: "过程展示里的流式文字",
  command_lifecycle: "认出开始回合的那条输入，免得把内部回合的话发到你某条旧消息的窗口",
  pending_permission_requests: "Rhodium 重启后拿回没答的提问",
  perTaskStopAffordance: "后台任务逐个停止的握手选项",
  interrupt_receipt_v1: "打断后等 Claude 确认已停",
  effortLevel: "/effort",
  AskUserQuestion: "选择题",
  ExitPlanMode: "计划确认",
  "--permission-prompt-tool": "审批、选择题和计划确认",
  "--input-format": "无头模式，也就是和 Claude 的全部通信",
  "--include-partial-messages": "过程展示里的流式文字",
  "--append-system-prompt-file": "槽位的追加系统提示",
  "--system-prompt-snapshot": "恢复对话时用上改过的追加系统提示",
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "判断回合开始和结束，也就是代发最终回复",
  CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "崩溃续跑",
};

/** The names of PROTOCOL that the file's bytes do not hold, read in chunks without running it. */
export async function missingNames(bin: string): Promise<string[]> {
  const left = new Set(Object.keys(PROTOCOL));
  const overlap = Math.max(...[...left].map((n) => n.length)) - 1; // a name may straddle two chunks
  let tail = Buffer.alloc(0);
  for await (const chunk of Bun.file(bin).stream()) {
    const buf = Buffer.concat([tail, chunk]);
    for (const n of left) if (buf.includes(n)) left.delete(n);
    if (!left.size) break;
    tail = buf.subarray(Math.max(0, buf.length - overlap));
  }
  return [...left];
}

/** The version in the nearest package.json above the program's real file; it is never run for this.
 *  null when there is none, as for a claude from the native installer. */
export function packageVersion(program: string): string | null {
  for (let dir = dirname(realpathSync(program)); ; dir = dirname(dir)) {
    const file = join(dir, "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")).version ?? null;
    if (dir === dirname(dir)) return null;
  }
}


/** Every key path in v, with [] for array elements: {a: [{b: 1}]} gives a, a[].b. */
function fieldsOf(v: unknown, at: string, out = new Set<string>()): Set<string> {
  if (Array.isArray(v)) for (const x of v) fieldsOf(x, `${at}[]`, out);
  else if (v !== null && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      out.add(`${at}.${k}`);
      fieldsOf(x, `${at}.${k}`, out);
    }
  return out;
}

/** The paths not inside another one given: a.b, without a.b.c or a.b[].c. */
const outermost = (paths: string[]) => paths.filter((f) => !paths.some((p) => f.startsWith(`${p}.`) || f.startsWith(`${p}[]`)));

const HANDSHAKE_TIMEOUT = 60_000;
const HANDSHAKE = [
  ["initialize", { perTaskStopAffordance: true }],
  ["get_context_usage", { detail: "summary" }],
] as const;

/**
 * Starts claude the way a slot's agent starts (architecture §6.2) and sends only initialize and
 * get_context_usage, which use no quota (probe 2), then closes it. Returns the answers' key paths,
 * whether the process runs with --bare, and how it is logged in (login).
 */
async function handshake(cfg: Config): Promise<{ fields: string[]; bare: boolean; login: string | null; models: unknown }> {
  const spec = new ClaudeDriver({ conv: "doctor", boot: 0, emit: () => {} }).spawn({ ...launch(cfg), approval: cfg.defaults.approval, program: cfg.programs.claude });
  // No session file: a check a day would leave an empty one in ~/.claude/projects each time.
  const proc = Bun.spawn([...spec.argv, "--no-session-persistence"], { cwd: spec.cwd, env: spec.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const answers: Record<string, any>[] = [];
  const ask = () => {
    const [subtype, fields] = HANDSHAKE[answers.length]!;
    proc.stdin.write(JSON.stringify({ type: "control_request", request_id: `doctor-${answers.length}`, request: { subtype, ...fields } }) + "\n");
    proc.stdin.flush();
  };
  let answered!: () => void;
  const done = new Promise<void>((r) => (answered = r));
  // Reads to the end, so claude never writes into a closed pipe.
  const reading = (async () => {
    for await (const m of jsonLines(proc.stdout)) {
      if (m?.type !== "control_response" || m.response?.request_id !== `doctor-${answers.length}`) continue;
      answers.push(m.response);
      if (answers.length === HANDSHAKE.length) answered();
      else ask();
    }
  })();
  try {
    ask();
    await Promise.race([done, reading, Bun.sleep(HANDSHAKE_TIMEOUT)]);
    if (answers.length < HANDSHAKE.length) {
      const why = proc.exitCode === null ? `${HANDSHAKE_TIMEOUT / 1000} 秒内没有应答` : `claude 退出了（${proc.exitCode}）`;
      throw new Error(`${HANDSHAKE[answers.length]![0]} ${why}`);
    }
    const failed = answers.find((a) => a.subtype !== "success");
    if (failed) throw new Error(`${HANDSHAKE[answers.indexOf(failed)]![0]} 应答出错：${failed.error}`);
    // What the process really got, a wrapper's additions included.
    const argv = readFileSync(`/proc/${proc.pid}/cmdline`, "utf8").split("\0");
    const env = Object.fromEntries(
      readFileSync(`/proc/${proc.pid}/environ`, "utf8")
        .split("\0")
        .map((kv) => [kv.slice(0, kv.indexOf("=")), kv.slice(kv.indexOf("=") + 1)]),
    );
    let bare = false;
    try {
      refuseBare({ argv, env, cwd: "" });
    } catch {
      bare = true;
    }
    const fields = new Set<string>();
    answers.forEach((a, i) => fieldsOf(a, HANDSHAKE[i]![0], fields));
    return { fields: [...fields].sort(), bare, login: login(answers[0]!.response?.account), models: answers[0]!.response?.models };
  } finally {
    await end(proc);
  }
}

/** How rh doctor starts an agent as a slot's would be: in a directory of its own, with an empty prompt. */
function launch(cfg: Config) {
  const dir = join(cfg.stateDir, "doctor");
  mkdirSync(dir, { recursive: true });
  const prompt = join(dir, "prompt.md");
  writeFileSync(prompt, "", { flag: "a" });
  return { cwd: dir, session: { new: randomUUID() }, systemPromptFile: prompt, env: agentBaseEnv(cfg) };
}

/** Each line of out that is JSON, parsed, as it comes. */
async function* jsonLines(out: ReadableStream<Uint8Array>): AsyncGenerator<any> {
  let buf = "";
  const text = new TextDecoder();
  for await (const chunk of out) {
    buf += text.decode(chunk, { stream: true });
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      let m: unknown;
      try {
        m = JSON.parse(buf.slice(0, nl));
      } catch {}
      buf = buf.slice(nl + 1);
      if (m !== undefined) yield m;
    }
  }
}

/** Closes the process's stdin, and kills it if it has not gone 5 s on. */
async function end(proc: Subprocess<"pipe", "pipe", "ignore">) {
  try {
    proc.stdin.end();
  } catch {} // gone already
  await Promise.race([proc.exited, Bun.sleep(5000)]);
  proc.kill("SIGKILL");
}

/** The version the Codex driver was written and recorded against (architecture §6.4). */
const CODEX_RECORDED = "0.162.1";
const CODEX_META = "doctorCodex"; // the codex version rh doctor checked last

/**
 * Asks a codex app-server, started as a slot's is (architecture §6.4), what rh doctor checks (§12),
 * none of it calling a model: its login; with none needed, its config, for the provider of yours; its
 * models; and whether an ephemeral thread, never written down, takes untrusted (thread: Codex's
 * answer, an error included). env: what Codex was given.
 */
async function askCodex(cfg: Config) {
  const spec = new CodexDriver({ conv: "doctor", boot: 0, emit: () => {} }).spawn({ ...launch(cfg), approval: false, program: cfg.programs.codex });
  const { cwd } = spec;
  const proc = Bun.spawn(spec.argv, { cwd, env: spec.env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const waiting = new Map<number, (m: any) => void>();
  const reading = (async () => {
    for await (const m of jsonLines(proc.stdout)) if (m?.method === undefined) waiting.get(m?.id)?.(m);
  })();
  let step = "";
  const write = (m: object) => {
    proc.stdin.write(JSON.stringify(m) + "\n");
    proc.stdin.flush();
  };
  const ask = (method: string, params: object): Promise<any> => {
    const id = waiting.size;
    step = method;
    write({ id, method, params });
    return new Promise((r) => waiting.set(id, r));
  };
  const result = async (method: string, params: object) => {
    const m = await ask(method, params);
    if (m.error) throw new Error(`${method} 应答出错：${m.error.message}`);
    return m.result;
  };
  const exchange = (async () => {
    await result("initialize", { clientInfo: { name: "rhodium", title: "Rhodium", version: "doctor" }, capabilities: { experimentalApi: false } });
    write({ method: "initialized" });
    const account = await result("account/read", { refreshToken: false });
    const config = !account.account && !account.requiresOpenaiAuth ? (await result("config/read", { cwd })).config : null;
    const models = (await result("model/list", {})).data;
    const thread = await ask("thread/start", { cwd, ephemeral: true, approvalPolicy: "untrusted", sandbox: "danger-full-access" });
    return { account: account.account, config, models, thread, env: spec.env };
  })();
  exchange.catch(() => {}); // an answer after the deadline settles it with no one waiting
  try {
    const out = await Promise.race([exchange, reading.then(() => null), Bun.sleep(HANDSHAKE_TIMEOUT).then(() => null)]);
    if (out) return out;
    throw new Error(`${step} ${proc.exitCode === null ? `${HANDSHAKE_TIMEOUT / 1000} 秒内没有应答` : `codex 退出了（${proc.exitCode}）`}`);
  } finally {
    await end(proc);
  }
}

/** How codex is logged in, from account/read's account, as rh doctor names it. With none, and none
 *  needed, the provider of yours in its config, by its name and its base_url's host. null: neither. */
function codexLogin(account: Record<string, any> | null, config: Record<string, any> | null): string | null {
  if (account?.type === "chatgpt") return `ChatGPT${account.planType ? `（${account.planType}）` : ""}`;
  if (account?.type === "apiKey") return "API key，按用量计费";
  if (account) return `${account.type}，按用量计费`;
  const name = config?.model_provider;
  if (!name) return null;
  let host = "";
  try {
    host = new URL(config.model_providers?.[name]?.base_url).hostname;
  } catch {} // a provider built into codex, with no base_url of yours
  return `自定义服务商（${[name, host].filter(Boolean).join("，")}），按服务商计费`;
}

/** rh doctor's Codex part (architecture §12): its version against the last check's; its login, or a
 *  provider of yours and whether the service has the variable its key comes from; whether it still
 *  takes untrusted; and its models, kept for naming a remembered one. Each error of your codex's
 *  begins Codex: upgrade.sh goes back on none of them, as going back fixes none; a failed handshake
 *  it does go back on, as the new version may have launched Codex wrong. */
async function checkCodex(cfg: Config, store: Store, codex: string, info: string[], error: (text: string) => void, warn: (text: string) => void) {
  const said = Bun.spawn([codex, "--version"], { env: headlessEnv("codex", agentBaseEnv(cfg)), stdout: "pipe", stderr: "ignore", timeout: 10_000 });
  const version = (await new Response(said.stdout).text()).trim().split(/\s+/).at(-1) || null; // codex-cli 0.162.1
  const last = store.tx((tx) => tx.get("meta", CODEX_META))?.value ?? null;
  const changed = version !== last;
  info.push(`Codex ${version ?? "（读不到版本号）"}${changed ? (last ? `（上次核对的是 ${last}）` : "（第一次核对）") : ""}`);
  if (last && version && changed) warn(`Codex 从 ${last} 换成了 ${version}。Codex 驱动照 ${CODEX_RECORDED} 的录制写成，跑一遍 scripts/probes/codex/ 的探针核对`);
  if (version) setMeta(store, CODEX_META, version);
  try {
    const { account, config, models, thread, env } = await askCodex(cfg);
    if (Array.isArray(models)) setMeta(store, modelNames("codex"), JSON.stringify(codexModelNames(models)));
    const login = codexLogin(account, config);
    if (login) info.push(`Codex 登录：${login}`);
    else error("Codex 没有登录，也没有配自定义服务商。在终端里运行 codex login，用 ChatGPT 或 API key 登录；或者在 ~/.codex/config.toml 里配 model_provider");
    const key = config?.model_providers?.[config.model_provider]?.env_key;
    if (key && !env[key])
      error(
        `Codex 的服务商 ${config!.model_provider} 从环境变量 ${key} 取令牌，Rhodium 的服务环境里却没有它：服务看不到 .bashrc、.zshrc 里 export 的变量。` +
          "改用服务商的 auth 命令（例如读一个 0600 的文件），或者别的不靠环境变量的办法",
      );
    if (thread.result?.approvalPolicy !== "untrusted")
      error(
        `Codex 这一版不再接受“每条都问”的审批设置（${thread.error?.message ?? `应答里是 ${thread.result?.approvalPolicy}`}），审批开的 Codex 槽位起不来。` +
          "关掉这些槽位的审批，或者换回旧版 codex",
      );
  } catch (err) {
    error(`和 codex 握手失败：${(err as Error).message}`);
  }
}

/** How claude says it is logged in, from initialize's account (2.1.311), as rh doctor names it;
 *  null: not at all. claude setup-token's CLAUDE_CODE_OAUTH_TOKEN is a subscription's; a backend
 *  other than Anthropic's, Bedrock say, has its own login outside claude and no other field.
 *  An API key is what requests carry unless a subscription login is active (subscriptionType),
 *  even beside a CLAUDE_CODE_OAUTH_TOKEN, as claude's /status decides. */
function login(a: Record<string, string> | undefined): string | null {
  if (!a) return null;
  if (a.subscriptionType) return `订阅（${a.subscriptionType}）`;
  if (a.apiKeySource) return `API（${a.apiKeySource}），按用量计费`;
  if (a.tokenSource?.startsWith("CLAUDE_CODE_OAUTH_TOKEN")) return `订阅（${a.tokenSource}）`;
  const api = (a.tokenSource !== "none" && a.tokenSource) || (a.apiProvider !== "firstParty" && a.apiProvider);
  return api ? `API（${api}），按用量计费` : null;
}

/** What the checks of claude found, kept in the meta table: the version whose bytes were searched
 *  last and the protocol names it lacked, and the key paths of the last handshake that went through
 *  with the version that gave them (null: never handshaken). A failed handshake leaves those as they were. */
type Checked = { version: string | null; missing: string[]; fields: string[] | null; fieldsVersion: string | null };
const META = "doctor";
const LAST_RUN = "doctorAt"; // when rh doctor last started, in ms since the epoch

function lastChecked(store: Store): Checked | null {
  const row = store.tx((tx) => tx.get("meta", META));
  return row ? JSON.parse(row.value) : null;
}

/** The Herdr protocol the Herdr bridge was written and probed against (Herdr 0.9.1, probe 18). */
const HERDR_PROTOCOL = 22;

/** Herdr's resume_agents_on_restore, from its config file; unset, its default, on in 0.9.1.
 *  ponytail: the file rhodium's own HERDR_CONFIG_PATH names; Herdr's server may run with another. */
function herdrResumes(): boolean {
  const file = process.env.HERDR_CONFIG_PATH || join(homedir(), ".config/herdr/config.toml");
  try {
    return (Bun.TOML.parse(readFileSync(file, "utf8")) as any).session?.resume_agents_on_restore ?? true;
  } catch {
    return true; // no file, or one Herdr would refuse too: its default
  }
}

type Finding = { level: "错误" | "告警"; text: string };

/** GETs url as a stranger on the internet would: no login, no following a redirect, 5 s at most. */
const asStranger = (url: string) => fetch(url, { redirect: "manual", signal: AbortSignal.timeout(5_000) });

/** What rh doctor finds of the board's exposure (ADR-0013): [board] written wrong; listening beyond
 *  this machine; with auth none, any of hosts that opens the board with no login, the proxy in front
 *  letting a stranger through, as probe asks it. One probe cannot reach is a warning: not checked,
 *  maybe only from here, and no reason to wake you daily. Each error begins 看板: upgrade.sh goes
 *  back on none of them, as going back fixes none. */
export async function boardFindings(b: Config["board"], probe = asStranger): Promise<Finding[]> {
  if (b.closed) return [{ level: "错误", text: `看板关着：配置文件 [board] 写错了，${b.closed}` }];
  const found: Finding[] = [];
  if (!/^127\./.test(b.bind) && b.bind !== "::1")
    found.push({
      level: "错误",
      text:
        b.auth === "none"
          ? `看板不认身份（auth = "none"），却听着 ${b.bind}：连得到这个地址的人都能完全控制看板，包括终端。只听本机，由反代转发`
          : `看板听着 ${b.bind}：连得到这个地址的人能自己带上 Tailscale-User-Login，冒充你。只听本机，由 tailscale serve 转发`,
    });
  if (b.auth !== "none") return found;
  const hosts = await Promise.all(
    b.hosts.map(async (host): Promise<Finding | null> => {
      const url = `https://${host}/`;
      try {
        // The board answers its ping with 204; a proxy wanting a login, with a redirect to it, 401 or 403.
        if ((await probe(`${url}api/ping`)).status !== 204) return null;
        return { level: "错误", text: `看板在 ${url} 上不登录就能打开：它前面的反代没要登录，例如 Access 漏配了。谁都能完全控制看板，包括终端` };
      } catch (err) {
        return { level: "告警", text: `连不上 ${url}，没核对它要不要登录：${(err as Error).message}` };
      }
    }),
  );
  return [...found, ...hosts.filter((f) => f !== null)];
}

// ponytail: a guess at "too big", well past limits.outRestartMB, past which an agent process goes between turns (architecture §4.3).
const BIG_OUT_LOG = 512 * 2 ** 20;

/** Runs every check. notify: something you should hear about even without asking. */
async function check(cfg: Config, store: Store): Promise<{ text: string; notify: boolean }> {
  const info: string[] = [];
  const found: Finding[] = [];
  const error = (text: string) => found.push({ level: "错误", text });
  const warn = (text: string) => found.push({ level: "告警", text });
  let notify = false;

  // Claude: protocol names and the handshake when its version changed, the handshake each time.
  const last = lastChecked(store);
  const claude = locate(cfg.programs.claude, cfg.agentPath);
  if (!claude || !existsSync(claude)) error(`找不到 claude：${cfg.programs.claude}`);
  else {
    let version: string | null = null;
    try {
      version = packageVersion(claude);
    } catch {}
    const changed = !last || version !== last.version;
    const before = last ? `（上次核对的是 ${last.version ?? "版本号不明的一版"}）` : "（第一次核对）";
    info.push(`Claude ${version ?? "（读不到版本号）"}${changed ? before : ""}`);
    const missing = changed ? await missingNames(realpathSync(claude)) : last!.missing;
    for (const n of missing) error(`claude 里找不到协议名字 ${n}，这项功能会降级：${PROTOCOL[n]}`);
    let { fields, fieldsVersion } = last ?? { fields: null, fieldsVersion: null };
    if (!missing.length) {
      try {
        const h = await handshake(cfg);
        // The latest list of models, for /status to name a remembered one by (store's MODEL_NAMES).
        if (Array.isArray(h.models)) setModelNames(store, h.models);
        if (h.bare) error("claude 的启动参数或环境里有 --bare（CLAUDE_CODE_SIMPLE），它会跳过订阅登录");
        if (h.login) info.push(`Claude 登录：${h.login}`);
        else
          error(
            "claude 没有登录。在终端里运行 claude，用订阅登录；或者在 ~/.claude/settings.json 的 env 里写上 ANTHROPIC_BASE_URL 和 ANTHROPIC_AUTH_TOKEN。" +
              "Rhodium 是 systemd 服务，看不到 shell 里 export 的变量",
          );
        if (fields && fieldsVersion !== version) {
          const was = new Set(fields);
          const now = new Set(h.fields);
          // Which keys account has follows how claude is logged in, not the protocol.
          const ofLogin = (f: string) => f.startsWith("initialize.response.account.");
          const lost = outermost(fields.filter((f) => !now.has(f) && !ofLogin(f)));
          const added = outermost(h.fields.filter((f) => !was.has(f) && !ofLogin(f)));
          const than = `握手应答比${fieldsVersion ? ` ${fieldsVersion} ` : "上一版"}`;
          // What an array holds, say your MCP tools or agents, follows your config, not only the protocol.
          const gone = lost.filter((f) => !f.includes("[]"));
          const emptied = lost.filter((f) => f.includes("[]"));
          if (gone.length) error(`${than}少了字段：${gone.join("、")}`);
          if (emptied.length) warn(`${than}少了数组里的字段，可能只是你的配置变了：${emptied.join("、")}`);
          if (added.length) warn(`${than}多了字段：${added.join("、")}`);
          notify ||= lost.length + added.length > 0;
        }
        fields = h.fields;
        fieldsVersion = version;
      } catch (err) {
        error(`和 claude 握手失败：${(err as Error).message}`);
      }
    }
    setMeta(store, META, JSON.stringify({ version, missing, fields, fieldsVersion } satisfies Checked));
  }

  // A conversation by its slot's name, as rh ls shows it.
  const { refs, holders } = store.tx((tx) => ({
    refs: new Map(
      tx.find("conversation", {}).map((c) => {
        const slot = tx.get("slot", c.slot);
        const ws = slot && tx.get("workspace", slot.workspace);
        return [c.id, slot && ws ? `${ws.name}/${slot.name}` : c.id];
      }),
    ),
    holders: tx.find("holder", { exited: 0 }), // those the store takes for running
  }));
  const ref = (conversation: string) => refs.get(conversation) ?? conversation;

  // Holders: the store and systemd agree (§5), and which still run an older rh-hold (§4.7).
  const units = await activeHolders(cfg);
  const known = new Set(holders.map((h) => h.unit));
  for (const u of units) if (!known.has(u)) warn(`systemd 里有、库里没有的托管进程：${u}`);
  const holdBin = cfg.holdBin || join(dirname(process.execPath), "rh-hold");
  for (const h of holders) {
    if (!units.has(h.unit)) {
      error(`库里有、systemd 里没有的托管进程：${ref(h.conversation)}（${h.unit}）`);
      continue;
    }
    const show = Bun.spawn(["systemctl", "--user", "show", "--property=ExecStart", "--value", `${h.unit}.service`], { stdout: "pipe" });
    const path = (await new Response(show.stdout).text()).match(/\bpath=(\S+)/)?.[1];
    if (path && path !== holdBin) warn(`还在跑旧版的托管进程：${ref(h.conversation)}（${path}）`);
  }

  // Disk (§7.8).
  const free = freeDisk(cfg.stateDir);
  const min = cfg.limits.minFreeMB * 2 ** 20;
  info.push(`磁盘剩余 ${formatGB(free)}`);
  // Below it no slot is made or started, so you hear of it (product §5.10).
  if (free < min) warn(`磁盘剩余不到 ${formatGB(min)}`);
  notify ||= free < min;

  // out.log is never cut while its agent runs, only once the next one starts (§4.3), so its size is watched here.
  const hold = join(cfg.stateDir, "hold");
  const logs = (existsSync(hold) ? readdirSync(hold) : [])
    .map((c) => ({ conversation: c, size: statSync(join(hold, c, "out.log"), { throwIfNoEntry: false })?.size ?? -1 }))
    .filter((l) => l.size >= 0)
    .sort((a, b) => b.size - a.size);
  if (logs.length) {
    const total = logs.reduce((n, l) => n + l.size, 0);
    info.push(`out.log 共 ${formatMB(total)}，最大的是 ${ref(logs[0]!.conversation)} 的 ${formatMB(logs[0]!.size)}`);
    for (const l of logs) if (l.size > BIG_OUT_LOG) warn(`${ref(l.conversation)} 的 out.log 有 ${formatMB(l.size)}`);
  }

  // Backups (§7.8): the newest file in the backup dir, no older than two backup periods.
  const backups = join(cfg.stateDir, "backup");
  const newest = Math.max(0, ...(existsSync(backups) ? readdirSync(backups) : []).map((f) => statSync(join(backups, f)).mtimeMs));
  if (!newest) warn(`还没有数据库备份（${backups}）`);
  else {
    const hours = Math.floor((Date.now() - newest) / 3_600_000);
    info.push(`最近的数据库备份：${hours} 小时前`);
    if (Date.now() - newest > 2 * cfg.durations.backupEvery) warn(`数据库备份不新鲜：最近一份是 ${hours} 小时前`);
  }

  // pi's version, read the way claude's is.
  const pi = locate(cfg.programs.pi, cfg.agentPath);
  let piVersion: string | null = null;
  try {
    piVersion = pi && packageVersion(pi);
  } catch {}
  if (!pi) warn(`找不到 pi：${cfg.programs.pi}`);
  else if (!piVersion) warn(`读不到 pi 的版本号（${pi}）`);
  else info.push(`pi ${piVersion}`);

  // Codex, only when installed.
  const codex = locate(cfg.programs.codex, cfg.agentPath);
  if (codex && existsSync(codex)) await checkCodex(cfg, store, codex, info, error, warn);

  // Herdr (§10.2, §10.3), only when installed (product §4.2): the protocol the Herdr bridge was
  // written for, and auto-resume. Probe 18: Rhodium closes the tab before Herdr resumes the agent,
  // but not while rhodium itself is down.
  if (hasHerdr(cfg)) {
    try {
      const herdr = locate(cfg.programs.herdr, cfg.agentPath)!;
      const { version, protocol } = await request(await sessionSocket(herdr, cfg.herdr.session), "ping");
      info.push(`Herdr ${version}（protocol ${protocol}）`);
      if (protocol !== HERDR_PROTOCOL) warn(`Herdr 的协议版本是 ${protocol}，Herdr 桥是照 ${HERDR_PROTOCOL} 写的，切 TUI 可能出错`);
    } catch (err) {
      warn(`连不上 Herdr，没核对它的协议版本：${(err as Error).message}`);
    }
    if (herdrResumes())
      warn(
        "Herdr 的 resume_agents_on_restore 开着：Herdr 重启回来时 Rhodium 若不在线，它会把已切回无头的对话再开一份。" +
          "Rhodium 不改你的 Herdr 配置，请在它的 config.toml 里写上 [session] resume_agents_on_restore = false",
      );
  }

  found.push(...(await boardFindings(cfg.board)));

  notify ||= found.some((f) => f.level === "错误");
  const lines = [...info, ...found.map((f) => `${f.level}：${f.text}`)];
  if (!found.length) lines.push("没有发现问题。");
  return { text: lines.join("\n"), notify };
}

/**
 * rh doctor as rhodium runs it: when you ask (rh doctor), once a day, and when a Claude process
 * reports a version the last check did not see. A run nobody asked for tells you through notify
 * what needs you. Creating it arms the daily run. No check runs before `ready`: till the restart's
 * takeover is done, the holder rows say what the last rhodium left (architecture §5).
 */
export function createDoctor(o: { cfg: Config; store: Store; notify: (text: string) => void; ready: Promise<unknown> }) {
  let running: Promise<string> | null = null;
  const failed = (err: unknown) => log("rh doctor failed", { error: String(err) });
  /** Runs the checks, or joins the run under way, and resolves with the report. */
  function run(asked: boolean): Promise<string> {
    if (running) return running;
    setMeta(o.store, LAST_RUN, String(Date.now()));
    return (running = o.ready
      .then(() => check(o.cfg, o.store))
      .then((r) => {
        if (!asked && r.notify) o.notify(r.text);
        return r.text;
      })
      .finally(() => (running = null)));
  }
  // The daily run, durations.doctorEvery after the last run of any kind.
  daily(o.store, LAST_RUN, o.cfg.durations.doctorEvery, () => run(false).catch(failed));
  return {
    run,
    /** Before any check has run there is nothing to compare with; the daily run makes the first.
     *  Nor is there with no version on record, say for a claude without package.json. */
    versionSeen(version: string): void {
      const last = lastChecked(o.store)?.version;
      if (!last || last === version || running) return;
      run(false).catch(failed);
    },
  };
}
