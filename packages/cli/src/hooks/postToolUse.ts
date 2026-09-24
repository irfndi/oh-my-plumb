import {
  createBlobId,
  createBlockKey,
  isPlumbError,
  postToolUseInputSchema,
  toolCallPostToolUseSchema,
  turnIdOf,
  type HookOutput,
  type PostToolUseInput,
  type Rule,
  type ToolCallPostToolUseInput,
  type Verdict,
} from "oh-my-plumb-schema";
import {
  runCheck,
  runToolCallCheck,
  selectToolCallRules,
  type CheckOutcome,
} from "../lib/checkRunner.js";
import { fastCheck } from "../lib/tier1.js";
import { findMcpServer } from "../lib/detect.js";
import {
  GUARD_TIMEOUT_MS,
  guardRoutes,
  routesForFile,
  runGuard,
  runMcpGuard,
  type GuardHit,
} from "../lib/guards.js";
import { EDIT_CHECK_TIMEOUT_MS, MAX_BLOCKS_PER_RULE_PER_TURN } from "../lib/constants.js";
import { hasApiKey } from "../lib/credentials.js";
import { boundState, editsFromPostToolUse, type EditHunk } from "../lib/diff.js";
import { appendEvent } from "../lib/events.js";
import { loadRubric } from "../lib/loadRubric.js";
import { debug } from "../lib/output.js";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "../lib/paths.js";
import { flagNotice, repairReason, toolCallReason } from "../lib/reason.js";
import {
  blockCount,
  incrementBlock,
  readPrompt,
  recordBlockedFile,
  recordChecked,
  recordFileStart,
  turnDir,
} from "../lib/session.js";
import { lastUserPrompt } from "../lib/transcript.js";

type Pair = { rule: Rule; verdict: Verdict };

type Checked = { edit: EditHunk; relative: string; outcome: CheckOutcome };

export const handlePostToolUse = async (raw: unknown): Promise<HookOutput> => {
  const edit = postToolUseInputSchema.safeParse(raw);
  if (edit.success) return handleEdit(edit.data);
  const call = toolCallPostToolUseSchema.safeParse(raw);
  if (!call.success) return { kind: "silent" };
  return handleToolCall(call.data);
};

const handleEdit = async (input: PostToolUseInput): Promise<HookOutput> => {
  const started = performance.now();
  const at = new Date().toISOString();
  const all = editsFromPostToolUse(input);
  const root = findRepoRoot(all[0]?.filePath ?? input.cwd);
  const edits = all.filter((e) => !isExcludedPath(relativeToRoot(root, e.filePath)));
  if (edits.length === 0) return { kind: "silent" };

  const turn = turnDir(input.session_id, turnIdOf(input));
  for (const edit of edits) recordFileStart(turn, edit.filePath, edit.original);

  const loaded = loadRubric(root);
  for (const problem of loaded.problems) debug(problem);
  if (loaded.rules.length === 0) return { kind: "silent" };

  const checkable: { edit: EditHunk; relative: string; diff: string }[] = [];
  for (const edit of edits) {
    const relative = relativeToRoot(root, edit.filePath);
    if (edit.text === undefined) {
      appendEvent(root, {
        kind: "skip",
        at,
        phase: "edit",
        sessionId: input.session_id,
        reason: "diff too large to compute in time",
        files: [relative],
      });
      continue;
    }
    const { text: diff } = boundState(edit.text);
    if (diff.trim() !== "") checkable.push({ edit, relative, diff });
  }
  if (checkable.length === 0) return { kind: "silent" };
  const files = checkable.map((c) => c.relative);

  const tier2Hits: { relative: string; hit: GuardHit }[] = [];
  const routes = guardRoutes(loaded.rules, root);
  if (routes.length > 0) {
    const external = await Promise.all(
      checkable.flatMap(({ edit, relative }) =>
        routesForFile(routes, relative).flatMap((r) => {
          const jobs: Promise<{ relative: string; hit: GuardHit } | undefined>[] = [];
          if (r.command !== undefined) {
            jobs.push(
              runGuard(
                r.ruleId,
                r.ruleId,
                r.command,
                relative,
                edit.after ?? "",
                GUARD_TIMEOUT_MS,
                root,
              ).then((hit) => (hit === undefined ? undefined : { relative, hit })),
            );
          }
          if (r.command === undefined && r.server !== undefined && r.tool !== undefined) {
            jobs.push(
              runMcpGuard(
                r.ruleId,
                findMcpServer(root, r.server),
                { server: r.server, tool: r.tool },
                root,
                relative,
                edit.after ?? "",
              ).then((hit) => (hit === undefined ? undefined : { relative, hit })),
            );
          }
          if (r.skill !== undefined) {
            jobs.push(
              runGuard(
                r.ruleId,
                r.ruleId,
                [r.skill],
                relative,
                edit.after ?? "",
                GUARD_TIMEOUT_MS,
                root,
              ).then((hit) => (hit === undefined ? undefined : { relative, hit })),
            );
          }
          return jobs;
        }),
      ),
    );
    for (const found of external) {
      if (found !== undefined) tier2Hits.push(found);
    }
  }
  if (tier2Hits.length > 0) {
    const actedOn = [...new Set(tier2Hits.map((h) => h.relative))];
    for (const { relative } of tier2Hits) recordBlockedFile(turn, relative);
    appendEvent(root, {
      kind: "check",
      at,
      phase: "edit",
      sessionId: input.session_id,
      promptId: turnIdOf(input),
      files: actedOn,
      rules: tier2Hits.length,
      latencyMs: Math.round(performance.now() - started),
      modelLatencyMs: 0,
      usage: {},
      verdicts: tier2Hits.map((h) => ({ ruleId: h.hit.ruleId, probability: 1, band: "act" })),
      blocked: true,
    });
    return {
      kind: "block",
      reason: tier2Hits.map((h) => h.hit.reason).join("\n"),
    };
  }

  if (!hasApiKey(root)) {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "edit",
      sessionId: input.session_id,
      reason: "no api key",
      files,
    });
  }

  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(turn);
  let checked: Checked[];
  try {
    checked = await Promise.all(
      checkable.map(async ({ edit, relative, diff }) => {
        const fast = fastCheck(
          loaded.rules,
          "edit",
          [{ file: relative, text: diff }],
          loaded.thresholds,
        );
        const fastIds = new Set(fast.verdicts.map((v) => v.ruleId));
        const modelRules = loaded.rules.filter((r) => !fastIds.has(r.id));
        if (modelRules.length === 0) {
          return {
            edit,
            relative,
            outcome: {
              verdicts: fast.verdicts,
              modelRules: [],
              calls: 0,
              usage: {},
              modelLatencyMs: 0,
            },
          };
        }
        const outcome = await runCheck({
          phase: "edit",
          fileDiffs: [{ file: relative, text: diff }],
          task,
          rules: modelRules,
          thresholds: loaded.thresholds,
          timeoutMs: EDIT_CHECK_TIMEOUT_MS,
        });
        return {
          edit,
          relative,
          outcome: { ...outcome, verdicts: [...outcome.verdicts, ...fast.verdicts] },
        };
      }),
    );
  } catch (error) {
    appendEvent(root, {
      kind: "error",
      at,
      phase: "edit",
      sessionId: input.session_id,
      code: isPlumbError(error) ? error.code : "CHECK_FAILED",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    });
    return { kind: "silent" };
  }

  for (const { edit, relative } of checked) {
    if (edit.after === null) continue;
    recordChecked(turn, {
      path: relative,
      before: edit.original === null ? null : createBlobId(edit.original),
      after: createBlobId(edit.after),
    });
  }

  const byId = new Map(loaded.rules.map((r) => [r.id, r]));
  const acting: Pair[] = [];
  const flagged: Pair[] = [];
  const actedOn: string[] = [];
  for (const { relative, outcome } of checked) {
    const pairs = (band: Verdict["band"]): Pair[] =>
      outcome.verdicts.flatMap((verdict) => {
        const rule = byId.get(verdict.ruleId);
        return rule !== undefined && verdict.band === band ? [{ rule, verdict }] : [];
      });
    const actPairs = pairs("act");
    const actingHere = actPairs.filter(
      ({ rule }) =>
        blockCount(turn, createBlockKey(rule.id, relative)) < MAX_BLOCKS_PER_RULE_PER_TURN,
    );
    for (const { rule } of actingHere) incrementBlock(turn, createBlockKey(rule.id, relative));
    if (actingHere.length > 0) {
      actedOn.push(relative);
      recordBlockedFile(turn, relative);
    }
    acting.push(...actingHere);
    flagged.push(...pairs("flag"), ...actPairs.filter((p) => !actingHere.includes(p)));

    appendEvent(root, {
      kind: "check",
      at,
      phase: "edit",
      sessionId: input.session_id,
      promptId: turnIdOf(input),
      files: [relative],
      rules: outcome.modelRules.length,
      latencyMs: Math.round(performance.now() - started),
      modelLatencyMs: outcome.modelLatencyMs,
      usage: outcome.usage,
      verdicts: outcome.verdicts,
      blocked: actingHere.length > 0,
    });
  }

  const systemMessage = flagged.length > 0 ? flagNotice("edit", flagged, files) : undefined;
  if (acting.length > 0) {
    return {
      kind: "block",
      reason: repairReason("edit", acting, actedOn),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    };
  }
  return systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage };
};

/** One shell or MCP call a tool-call rule covers: judged on its own input, no diff involved. */
const handleToolCall = async (input: ToolCallPostToolUseInput): Promise<HookOutput> => {
  const started = performance.now();
  const at = new Date().toISOString();
  const root = findRepoRoot(input.cwd);
  const loaded = loadRules(root);
  for (const problem of loaded.problems) debug(problem);
  const call = { tool: input.tool_name, input: input.tool_input };
  if (selectToolCallRules(loaded.rules, "edit", call.tool).length === 0) return { kind: "silent" };

  const turn = turnDir(input.session_id, turnIdOf(input));
  if (!hasApiKey(root)) {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "edit",
      sessionId: input.session_id,
      reason: "no api key",
      files: [call.tool],
    });
    return { kind: "silent" };
  }

  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(turn);
  let outcome: CheckOutcome;
  try {
    outcome = await runToolCallCheck({
      phase: "edit",
      call,
      task,
      rules: loaded.rules,
      thresholds: loaded.thresholds,
      timeoutMs: EDIT_CHECK_TIMEOUT_MS,
    });
  } catch (error) {
    appendEvent(root, {
      kind: "error",
      at,
      phase: "edit",
      sessionId: input.session_id,
      code: isPlumbError(error) ? error.code : "CHECK_FAILED",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    });
    return { kind: "silent" };
  }

  const byId = new Map(loaded.rules.map((r) => [r.id, r]));
  const pairs = (band: Verdict["band"]): Pair[] =>
    outcome.verdicts.flatMap((verdict) => {
      const rule = byId.get(verdict.ruleId);
      return rule !== undefined && verdict.band === band ? [{ rule, verdict }] : [];
    });
  const actPairs = pairs("act");
  const acting = actPairs.filter(
    ({ rule }) =>
      blockCount(turn, createBlockKey(rule.id, call.tool)) < MAX_BLOCKS_PER_RULE_PER_TURN,
  );
  for (const { rule } of acting) incrementBlock(turn, createBlockKey(rule.id, call.tool));

  appendEvent(root, {
    kind: "check",
    at,
    phase: "edit",
    sessionId: input.session_id,
    promptId: turnIdOf(input),
    files: [call.tool],
    rules: outcome.modelRules.length,
    latencyMs: Math.round(performance.now() - started),
    modelLatencyMs: outcome.modelLatencyMs,
    usage: outcome.usage,
    verdicts: outcome.verdicts,
    blocked: acting.length > 0,
  });

  const flagged = [...pairs("flag"), ...actPairs.filter((p) => !acting.includes(p))];
  const systemMessage = flagged.length > 0 ? flagNotice("edit", flagged, [call.tool]) : undefined;
  if (acting.length > 0) {
    return {
      kind: "block",
      reason: toolCallReason(acting, call.tool),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    };
  }
  return systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage };
};
