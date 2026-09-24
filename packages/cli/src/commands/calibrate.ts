import { parseArgs } from "node:util";
import {
  PlumbError,
  DEFAULT_THRESHOLDS,
  type CalibrationVerdict,
  type Host,
  type Rule,
  type RuleStatus,
} from "oh-my-plumb-schema";
import { collectToolCallSamples, summarizeCalibration } from "../lib/calibration.js";
import { runCheck, runToolCallCheck } from "../lib/checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS, TURN_CHECK_TIMEOUT_MS } from "../lib/constants.js";
import { recentHistory } from "../lib/git.js";
import { hasApiKey, NO_KEY_HINT } from "../lib/credentials.js";
import { findRepoRoot, globalRubricPath, homeDir, rubricPath } from "../lib/paths.js";
import { ruleAppliesToTool } from "../lib/scope.js";
import type { ReplayCall } from "../lib/replay.js";
import { readRubric, writeRubric } from "../lib/rubricFile.js";
import { say } from "../lib/ui.js";
import { Header } from "../ui/components/Header.js";
import { showLive, showStatic } from "../ui/render.js";
import { CalibrateView, type CalibrateData, type CalibrateRow } from "../ui/views/CalibrateView.js";
import { Callout } from "../ui/components/Callout.js";
import { sessionsFor } from "./replay.js";

const statusAfter = (rule: Rule, verdict: CalibrationVerdict): RuleStatus => {
  if (rule.status === "disabled") return "disabled";
  switch (verdict) {
    case "weak":
      return "weak";
    case "noisy":
      return "noisy";
    case "decisive":
      return "active";
    case "skipped":
      return rule.status;
    default:
      return rule.status;
  }
};

/** The hosts whose session transcripts replay reads. */
const SESSION_HOSTS: readonly Host[] = ["claude", "codex", "opencode", "pi"];

const recordedCallsFor = (root: string): ReplayCall[] =>
  SESSION_HOSTS.flatMap((host) => {
    try {
      return sessionsFor(host, root, []).flatMap((session) => session.calls);
    } catch {
      // a host with nothing recorded there contributes no calls
      return [];
    }
  });

/** Runs every model rule against the repo's own recent hunks and recorded tool calls and marks the ones that never decide. */
export const runCalibrate = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      global: { type: "boolean", default: false },
      hunks: { type: "string", default: "20" },
      commits: { type: "string", default: "8" },
      calls: { type: "string", default: "40" },
      json: { type: "boolean", default: false },
    },
  });
  const repoRoot = findRepoRoot(process.cwd());
  if (!hasApiKey(repoRoot)) throw new PlumbError("NO_API_KEY", NO_KEY_HINT);
  const file = values.global ? globalRubricPath() : rubricPath(repoRoot);
  const read = readRubric(file);
  if (read.kind === "missing")
    throw new PlumbError("RUBRIC_MISSING", `${file} does not exist yet; compile first`);
  if (read.kind === "invalid")
    throw new PlumbError("RUBRIC_INVALID", `${file}: ${read.issues[0] ?? "invalid"}`);
  const rubric = read.rubric;
  const thresholds = rubric.thresholds ?? DEFAULT_THRESHOLDS;
  const where = values.global ? homeDir() : repoRoot;

  // both targets calibrate: diff rules against hunks, tool-call rules against recorded calls
  const modelRules = rubric.rules.filter(
    (r) => r.check.type === "model" && r.status !== "disabled",
  );
  if (modelRules.length === 0) {
    await showStatic(Callout({ tone: "ok", title: "No model-checked rules to calibrate" }));
    return 0;
  }
  const rulesToRun = modelRules.map((r) => ({ ...r, status: "active" as const }));
  const toolCallRules = rulesToRun.filter((r) => r.target === "toolCall");
  // Only calls some rule could judge, and at most --calls of them, the most recently recorded.
  const recordedCalls = (toolCallRules.length === 0 ? [] : recordedCallsFor(repoRoot))
    .filter((call) => toolCallRules.some((rule) => ruleAppliesToTool(rule, call.tool)))
    .slice(-Number(values.calls));
  const history = recentHistory(repoRoot, Number(values.hunks), Number(values.commits));
  if (history.hunks.length === 0 && history.commits.length === 0 && recordedCalls.length === 0) {
    await showStatic(
      Callout({
        tone: "warn",
        title: "No usable history in this repository yet, so calibration is skipped",
        children: null,
      }),
    );
    return 0;
  }

  const run = async (progress: (label: string) => void): Promise<CalibrateData> => {
    const samples = new Map<string, number[]>();
    let spendUsd = 0;
    let calls = 0;
    const record = (verdicts: { ruleId: string; probability: number }[]): void => {
      for (const v of verdicts)
        samples.set(v.ruleId, [...(samples.get(v.ruleId) ?? []), v.probability]);
    };
    let n = 0;
    for (const hunk of history.hunks) {
      progress(`hunk ${(n += 1)} of ${history.hunks.length}  ${hunk.file}`);
      try {
        const out = await runCheck({
          phase: "edit",
          fileDiffs: [{ file: hunk.file, text: hunk.text }],
          task: hunk.subject,
          rules: rulesToRun,
          thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        record(out.verdicts);
        spendUsd += out.usage.costUsd ?? 0;
        calls += 1;
      } catch {
        // a hunk that could not be judged is one fewer sample, nothing more
      }
    }
    n = 0;
    for (const commit of history.commits) {
      progress(`commit ${(n += 1)} of ${history.commits.length}  ${commit.subject.slice(0, 60)}`);
      try {
        const out = await runCheck({
          phase: "turn",
          fileDiffs: commit.fileDiffs,
          task: commit.subject,
          rules: rulesToRun,
          thresholds,
          timeoutMs: TURN_CHECK_TIMEOUT_MS,
          retries: 2,
        });
        record(out.verdicts);
        spendUsd += out.usage.costUsd ?? 0;
        calls += 1;
      } catch {
        // as above
      }
    }
    if (recordedCalls.length > 0) {
      const callSamples = await collectToolCallSamples(
        recordedCalls,
        toolCallRules,
        async (call, phase) => {
          const out = await runToolCallCheck({
            phase,
            call,
            rules: toolCallRules,
            thresholds,
            timeoutMs: phase === "edit" ? EDIT_CHECK_TIMEOUT_MS : TURN_CHECK_TIMEOUT_MS,
            retries: 2,
          });
          spendUsd += out.usage.costUsd ?? 0;
          calls += out.calls;
          return out.verdicts;
        },
        progress,
      );
      for (const [id, probabilities] of callSamples)
        samples.set(id, [...(samples.get(id) ?? []), ...probabilities]);
    }
    const at = new Date().toISOString();
    const rows: CalibrateRow[] = [];
    const rules = rubric.rules.map((rule) => {
      if (rule.check.type !== "model" || rule.status === "disabled") return rule;
      const summary = summarizeCalibration(samples.get(rule.id) ?? [], thresholds);
      rows.push({ id: rule.id, when: rule.when ?? "", ...summary, states: summary.hunks });
      return {
        ...rule,
        status: statusAfter(rule, summary.verdict),
        calibration: { at, ...summary },
      };
    });
    writeRubric(file, { ...rubric, rules });
    return {
      root: where,
      file,
      hunks: history.hunks.length,
      commits: history.commits.length,
      calls,
      spendUsd,
      rows,
      weak: rules.filter((r) => r.status === "weak").map((r) => r.id),
      noisy: rules.filter((r) => r.status === "noisy").map((r) => r.id),
    };
  };

  if (values.json) {
    say(JSON.stringify(await run(() => {})));
    return 0;
  }
  return showLive<CalibrateData>({
    header: Header({
      command: "calibrate",
      where,
      note: `${modelRules.length} rules against ${history.hunks.length} hunks and ${history.commits.length} commits from git history${recordedCalls.length > 0 ? ` and ${recordedCalls.length} recorded tool calls` : ""}`,
    }),
    run,
    done: (data) => CalibrateView({ data }),
  });
};
