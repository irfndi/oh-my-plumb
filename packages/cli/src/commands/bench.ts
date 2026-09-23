import { spawnSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { PlumbError } from "oh-my-plumb-schema";
import { runCheck } from "../lib/checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, TURN_CHECK_TIMEOUT_MS } from "../lib/constants.js";
import { readEvents } from "../lib/events.js";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { loadRubric } from "../lib/loadRubric.js";
import { hookScriptPath } from "../lib/packageRoot.js";
import { findRepoRoot } from "../lib/paths.js";
import { clearTurn, turnDir } from "../lib/session.js";
import { median, percentile, say } from "../lib/ui.js";
import { Header } from "../ui/components/Header.js";
import { showLive } from "../ui/render.js";
import { BenchView, type BenchData, type BenchRow } from "../ui/views/BenchView.js";

const smallDiff = `@@ -10,6 +10,12 @@ export const loadUser = async (id: string) => {
   const row = await db.users.find(id);
+  if (!row) {
+    return null;
+  }
+  const name = row.name.trim();
+  const email = row.email.toLowerCase();
+  const createdAt = new Date(row.created_at);
+  const plan = row.plan ?? "free";
+  const seats = Number(row.seats ?? 1);
+  return { id, name, email, createdAt, plan, seats };
-  return row;
 };`;

const largeDiff = [
  "@@ -1,4 +1,54 @@",
  '+import { z } from "zod";',
  "+",
  "+const inputSchema = z.object({ id: z.string(), limit: z.number().int().min(1).max(100) });",
  "+",
  ...Array.from(
    { length: 46 },
    (_, i) => `+  const step${i} = compute(step${Math.max(0, i - 1)}, ${i});`,
  ),
  "+export const handler = async (req: Request) => {",
  "+  const input = inputSchema.parse(await req.json());",
  "+  return Response.json({ ok: true, input });",
  "+};",
].join("\n");

const SAMPLE = "src/oh-my-plumb-bench-sample.ts";

const spawnHook = (script: string, name: string, payload: unknown): number => {
  const started = performance.now();
  spawnSync("node", [script, name], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
  return performance.now() - started;
};

const times = async (n: number, fn: () => Promise<number>): Promise<number[]> => {
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) out.push(await fn());
  return out;
};

const row = (what: string, values: number[]): BenchRow => ({
  what,
  median: median(values) ?? 0,
  p90: percentile(values, 90) ?? 0,
});

/** Measures the check path on this machine: process start, Jev latency, tokens, spend, and real sessions. */
export const runBench = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { runs: { type: "string", default: "5" }, json: { type: "boolean", default: false } },
  });
  const runs = Math.max(1, Number(values.runs));
  const root = findRepoRoot(process.cwd());
  if (!hasApiKey(root)) throw new PlumbError("NO_API_KEY", NO_KEY_HINT);
  const loaded = loadRubric(root);
  if (loaded.rules.length === 0)
    throw new PlumbError(
      "RUBRIC_MISSING",
      "no rubric to bench with; run oh-my-plumb compile first",
    );
  const script = hookScriptPath();
  const sample = path.join(root, SAMPLE);
  const activeModelRules = loaded.rules.filter(
    (r) => r.status === "active" && r.check.type === "model",
  ).length;

  const run = async (progress: (label: string) => void): Promise<BenchData> => {
    progress("hook process start");
    const startup = await times(runs, async () =>
      spawnHook(script, "session-start", { hook_event_name: "nope" }),
    );

    const edit = async (diff: string) => {
      const out = await runCheck({
        phase: "edit",
        fileDiffs: [{ file: SAMPLE, text: diff }],
        task: "Add a user loader",
        rules: loaded.rules,
        thresholds: loaded.thresholds,
        timeoutMs: EDIT_CHECK_TIMEOUT_MS,
        retries: 2,
      });
      return {
        latency: out.modelLatencyMs,
        tokens: out.usage.inputTokens ?? 0,
        cost: out.usage.costUsd ?? 0,
        rules: out.modelRules.length,
      };
    };
    progress("warming the connection");
    const warm = await edit(smallDiff);
    let i = 0;
    const small = await times(runs, async () => {
      progress(`edit check, small diff ${(i += 1)}/${runs}`);
      return (await edit(smallDiff)).latency;
    });
    i = 0;
    const large = await times(runs, async () => {
      progress(`edit check, large diff ${(i += 1)}/${runs}`);
      return (await edit(largeDiff)).latency;
    });
    const largeOnce = await edit(largeDiff);

    const turnCheck = () =>
      runCheck({
        phase: "turn",
        fileDiffs: [{ file: SAMPLE, text: largeDiff }],
        task: "Add a user loader",
        rules: loaded.rules,
        thresholds: loaded.thresholds,
        timeoutMs: TURN_CHECK_TIMEOUT_MS,
        retries: 2,
      });
    const turnOut = await turnCheck();
    i = 0;
    const turn =
      turnOut.modelRules.length === 0
        ? []
        : await times(runs, async () => {
            progress(`turn check ${(i += 1)}/${runs}`);
            return (await turnCheck()).modelLatencyMs;
          });

    i = 0;
    const fullHook = await times(runs, async () => {
      progress(`whole PostToolUse hook ${(i += 1)}/${runs}`);
      return spawnHook(script, "post-tool-use", {
        session_id: "oh-my-plumb-bench",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: sample,
          content: largeDiff
            .split("\n")
            .slice(1)
            .map((l) => l.slice(1))
            .join("\n"),
        },
        tool_response: {
          type: "create",
          filePath: sample,
          originalFile: null,
          structuredPatch: [],
        },
      });
    });
    clearTurn(turnDir("oh-my-plumb-bench", undefined));

    const sessions = new Map<string, { edits: number; latency: number; cost: number }>();
    for (const e of readEvents(root)) {
      if (e.kind !== "check" || e.sessionId === undefined || e.sessionId === "oh-my-plumb-bench")
        continue;
      const s = sessions.get(e.sessionId) ?? { edits: 0, latency: 0, cost: 0 };
      s.edits += 1;
      s.latency += e.latencyMs;
      s.cost += e.usage?.costUsd ?? 0;
      sessions.set(e.sessionId, s);
    }
    const all = [...sessions.values()];
    return {
      root,
      runs,
      activeModelRules,
      rows: [
        row("hook process start, no network", startup),
        row(`edit check, small diff, ${warm.rules} rules`, small),
        row(`edit check, large diff, ${largeOnce.rules} rules`, large),
        ...(turn.length > 0 ? [row(`turn check, ${turnOut.modelRules.length} rules`, turn)] : []),
        row("whole PostToolUse hook, large diff", fullHook),
      ],
      tokens: { small: warm.tokens, large: largeOnce.tokens },
      cost: { small: warm.cost, large: largeOnce.cost },
      perTurn: {
        latencyMs: 15 * (median(fullHook) ?? 0) + (median(turn) ?? 0),
        costUsd: 15 * largeOnce.cost + (turnOut.usage.costUsd ?? 0),
      },
      sessions:
        all.length === 0
          ? null
          : {
              count: all.length,
              medianChecks: median(all.map((s) => s.edits)) ?? 0,
              medianLatencyMs: median(all.map((s) => s.latency)) ?? 0,
              medianCostUsd: median(all.map((s) => s.cost)) ?? 0,
            },
    };
  };

  if (values.json) {
    say(JSON.stringify(await run(() => {})));
    return 0;
  }
  return showLive<BenchData>({
    header: Header({
      command: "bench",
      where: root,
      note: `${activeModelRules} active model rules, ${runs} runs each`,
    }),
    run,
    done: (data) => BenchView({ data }),
  });
};
