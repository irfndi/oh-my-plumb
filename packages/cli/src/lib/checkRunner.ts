import { assertNever } from "oh-my-plumb-schema";
import type { CheckPhase, Rule, RuleTarget, Thresholds, Usage, Verdict } from "oh-my-plumb-schema";
import type { ToolCall } from "oh-my-plumb-schema";
import type { FileDiff } from "./git.js";
import { checkWithModel, isModelRule, type CheckState, type ModelRule } from "./jev.js";
import { ruleAppliesTo, ruleAppliesToTool } from "./scope.js";
import { MAX_STATE_CHARS } from "./constants.js";
import type { ToolCallEntry } from "./session.js";

export type CheckRequest = {
  phase: CheckPhase;
  /** The change, one entry per touched file, paths repo-relative. */
  fileDiffs: readonly FileDiff[];
  task?: string;
  rules: readonly Rule[];
  thresholds: Thresholds;
  timeoutMs: number;
  /** The turn's tool-call log, judged with a turn-phase diff so a rule can ask what ran. */
  toolCalls?: readonly ToolCallEntry[];
  /** Transient gateway failures to retry. Hooks leave it at zero. */
  retries?: number;
};

export type ToolCallCheckRequest = {
  phase: CheckPhase;
  /** One recorded call: the tool's name plus its input. */
  call: ToolCall;
  task?: string;
  rules: readonly Rule[];
  thresholds: Thresholds;
  timeoutMs: number;
  retries?: number;
};

export type CheckOutcome = {
  verdicts: Verdict[];
  modelRules: ModelRule[];
  /** How many model calls the check took: one per distinct set of in-scope files; a tool-call check is one call. */
  calls: number;
  usage: Usage;
  modelLatencyMs: number;
};

/** Which pipeline judges a rule. A new target must be classified here or the build fails. */
export const judgesDiff = (rule: Rule): boolean => {
  switch (rule.target) {
    case "diff":
      return true;
    case "toolCall":
      return false;
    default:
      return assertNever(rule.target);
  }
};

/** Only model rules run, and only against what they target: a diff rule never sees a call, a call rule never sees a diff. */
const runsInPhase = (rule: Rule, phase: CheckPhase, target: RuleTarget): boolean =>
  rule.status === "active" &&
  rule.check.type === "model" &&
  rule.target === target &&
  rule.when === phase;

/** Rules that are active, belong to this phase, and apply to at least one touched file. */
export const selectRules = (
  rules: readonly Rule[],
  phase: CheckPhase,
  files: readonly string[],
): Rule[] =>
  rules.filter(
    (rule) => runsInPhase(rule, phase, "diff") && files.some((f) => ruleAppliesTo(rule, f)),
  );

/** Tool-call rules that are active, belong to this phase, and match the tool's name glob. */
export const selectToolCallRules = (
  rules: readonly Rule[],
  phase: CheckPhase,
  tool: string,
): Rule[] =>
  rules.filter((rule) => runsInPhase(rule, phase, "toolCall") && ruleAppliesToTool(rule, tool));

const renderFiles = (fileDiffs: readonly FileDiff[]): string =>
  fileDiffs.map((f) => `--- a/${f.file}\n+++ b/${f.file}\n${f.text}`).join("\n");

/** Rules grouped by the files each one applies to, so no rule ever sees a file outside its scope. */
export const groupByScope = (
  rules: readonly ModelRule[],
  fileDiffs: readonly FileDiff[],
): { rules: ModelRule[]; fileDiffs: FileDiff[] }[] => {
  const groups = new Map<string, { rules: ModelRule[]; fileDiffs: FileDiff[] }>();
  for (const rule of rules) {
    const inScope = fileDiffs.filter((f) => ruleAppliesTo(rule, f.file));
    if (inScope.length === 0) continue;
    const key = inScope.map((f) => f.file).join("\n");
    const group = groups.get(key) ?? { rules: [], fileDiffs: inScope };
    group.rules.push(rule);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const addUsage = (a: Usage, b: Usage): Usage => ({
  inputTokens: (a.inputTokens ?? 0) + (b.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b.outputTokens ?? 0),
  costUsd: (a.costUsd ?? 0) + (b.costUsd ?? 0),
});

/** One verdict per rule: the loudest. */
export const loudestVerdicts = (verdicts: readonly Verdict[]): Verdict[] => {
  const best = new Map<string, Verdict>();
  for (const v of verdicts) {
    const have = best.get(v.ruleId);
    if (have === undefined || v.probability > have.probability) best.set(v.ruleId, v);
  }
  return [...best.values()];
};

export const mergeOutcomes = (outcomes: readonly CheckOutcome[]): CheckOutcome => {
  const modelRules: ModelRule[] = [];
  for (const o of outcomes) {
    for (const rule of o.modelRules) if (!modelRules.includes(rule)) modelRules.push(rule);
  }
  return {
    verdicts: loudestVerdicts(outcomes.flatMap((o) => o.verdicts)),
    modelRules,
    calls: outcomes.reduce((sum, o) => sum + o.calls, 0),
    usage: outcomes.reduce<Usage>((sum, o) => addUsage(sum, o.usage), {}),
    modelLatencyMs: Math.max(0, ...outcomes.map((o) => o.modelLatencyMs)),
  };
};

/** What the judge sees: the turn's change, and alongside it the turn's tool-call log when Stop has one. */
export const stateFor = (request: CheckRequest, fileDiffs: readonly FileDiff[]): CheckState => ({
  ...(request.task === undefined ? {} : { task: request.task }),
  ...(request.phase === "edit" && fileDiffs.length === 1 && fileDiffs[0] !== undefined
    ? { file: fileDiffs[0].file, diff: fileDiffs[0].text }
    : { files: fileDiffs.map((f) => f.file), diff: renderFiles(fileDiffs) }),
  ...(request.toolCalls === undefined || request.toolCalls.length === 0
    ? {}
    : { toolCalls: [...request.toolCalls] }),
});

export const runCheck = async (request: CheckRequest): Promise<CheckOutcome> => {
  const files = request.fileDiffs.map((f) => f.file);
  const modelRules = selectRules(request.rules, request.phase, files).filter(isModelRule);

  const groups = groupByScope(modelRules, request.fileDiffs);
  if (groups.length === 0) {
    return { verdicts: [], modelRules, calls: 0, usage: {}, modelLatencyMs: 0 };
  }

  const started = performance.now();
  const results = await Promise.all(
    groups.map((group) =>
      checkWithModel(
        group.rules,
        stateFor(request, group.fileDiffs),
        request.thresholds,
        request.timeoutMs,
        request.retries ?? 0,
      ),
    ),
  );
  return {
    verdicts: results.flatMap((r) => r.verdicts),
    modelRules,
    calls: groups.length,
    usage: results.reduce<Usage>((sum, r) => addUsage(sum, r.usage), {}),
    modelLatencyMs: Math.round(performance.now() - started),
  };
};

/** The call's input as JSON, cut to the same bound a diff gets so one call cannot flood the judge. */
export const renderToolInput = (call: ToolCall): string => {
  const text = JSON.stringify(call.input) ?? "";
  return text.length <= MAX_STATE_CHARS
    ? text
    : `${text.slice(0, MAX_STATE_CHARS)}\n[oh-my-plumb: input cut at ${MAX_STATE_CHARS} characters]`;
};

/** One model call carrying every tool-call rule in scope for this one call. */
export const runToolCallCheck = async (request: ToolCallCheckRequest): Promise<CheckOutcome> => {
  const modelRules = selectToolCallRules(request.rules, request.phase, request.call.tool).filter(
    isModelRule,
  );
  if (modelRules.length === 0) {
    return { verdicts: [], modelRules, calls: 0, usage: {}, modelLatencyMs: 0 };
  }

  const started = performance.now();
  const result = await checkWithModel(
    modelRules,
    {
      ...(request.task === undefined ? {} : { task: request.task }),
      tool: request.call.tool,
      input: renderToolInput(request.call),
    },
    request.thresholds,
    request.timeoutMs,
    request.retries ?? 0,
  );
  return {
    verdicts: result.verdicts,
    modelRules,
    calls: 1,
    usage: result.usage,
    modelLatencyMs: Math.round(performance.now() - started),
  };
};
