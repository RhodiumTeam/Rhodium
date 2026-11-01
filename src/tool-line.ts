// The short tool line (docs/im-style.md §3.1), which IM's tool lines (render.ts) and the board's
// chat (web/src/tools.tsx) both write. No Node imports: the board's page has it too.

/** One tool call as a tool line shows it: its name, and what it was given where that says
 *  something. code: the argument is a command, a path or the like, set as code in Markdown. */
export type Call = { name: string; arg: string | null; code: boolean };

// Not tool work: they come to you as asks, or are the agent's own bookkeeping (im-style §3.1).
export const NOT_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite", "update_plan"]);

const MAX_ITEMS = 4; // the most items of a short tool line

/** A run of calls to one tool: how many, their arguments, and how many of them failed. */
type Run = { name: string; n: number; args: string[]; code: boolean; failed: number };

/** The calls in order, those in a row to one tool as one run. failed: the call failed, as the board knows. */
export function runs(calls: (Call & { failed?: boolean })[]): Run[] {
  const out: Run[] = [];
  for (const c of calls) {
    const last = out.at(-1);
    if (last?.name !== c.name) out.push({ name: c.name, n: 1, args: c.arg === null ? [] : [c.arg], code: c.code, failed: Number(!!c.failed) });
    else {
      last.n++;
      last.failed += Number(!!c.failed);
      if (c.arg !== null && !last.args.includes(c.arg)) last.args.push(c.arg);
    }
  }
  return out;
}

export const named = (r: Pick<Run, "name" | "n">) => `${r.name}${r.n > 1 ? ` ×${r.n}` : ""}`;

/** The short writing in parts, for the board to draw (#495): its runs, and the calls after them, more,
 *  each with how many failed. */
export type ShortParts = { runs: Run[]; more: { n: number; failed: number } };

export function shortParts(calls: (Call & { failed?: boolean })[]): ShortParts {
  const rs = runs(calls);
  const rest = rs.slice(MAX_ITEMS);
  return { runs: rs.slice(0, MAX_ITEMS), more: { n: rest.reduce((n, r) => n + r.n, 0), failed: rest.reduce((n, r) => n + r.failed, 0) } };
}

/** The parts written out: Read ×6、Bash ×4、Edit、Grep ×2，另外 3 次. */
export const shortText = ({ runs, more }: ShortParts) => `${runs.map(named).join("、")}${more.n ? `，另外 ${more.n} 次` : ""}`;

/** The calls in the short writing (im-style §3.1): Read ×6、Bash ×4、Edit、Grep ×2，另外 3 次. */
export const shortLine = (calls: Call[]) => shortText(shortParts(calls));
