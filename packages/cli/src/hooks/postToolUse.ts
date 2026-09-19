import {
  createBlobId,
  createBlockKey,
  isPlumbError,
  postToolUseInputSchema,
  turnIdOf,
  type HookOutput,
  type Rule,
  type Verdict,
} from "oh-my-plumb-schema";
import { runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import { fastCheck } from "../lib/tier1.js";
import { tier2Check } from "../lib/tier2.js";
import { EDIT_CHECK_TIMEOUT_MS, MAX_BLOCKS_PER_RULE_PER_TURN } from "../lib/constants.js";
import { hasApiKey } from "../lib/credentials.js";
import { boundState, editsFromPostToolUse, type EditHunk } from "../lib/diff.js";
import { appendEvent } from "../lib/events.js";
import { loadRules } from "../lib/loadRules.js";
import { debug } from "../lib/output.js";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "../lib/paths.js";
import { flagNotice, repairReason } from "../lib/reason.js";
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
  const parsed = postToolUseInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const started = performance.now();
  const at = new Date().toISOString();
  const all = editsFromPostToolUse(input);
  const root = findRepoRoot(all[0]?.filePath ?? input.cwd);
  const edits = all.filter((e) => !isExcludedPath(relativeToRoot(root, e.filePath)));
  if (edits.length === 0) return { kind: "silent" };

  const turn = turnDir(input.session_id, turnIdOf(input));
  for (const edit of edits) recordFileStart(turn, edit.filePath, edit.original);

  const loaded = loadRules(root);
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

  const tier2Hits = checkable.flatMap(({ edit, relative }) => {
    const hit = tier2Check(input.tool_name, relative, edit.after);
    return hit === undefined ? [] : [{ relative, hit }];
  });
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
  const diffs = checkable.map((c) => ({ file: c.relative, text: c.diff }));
  const fast = fastCheck(loaded.rules, "edit", diffs, loaded.thresholds);
  const fastByRule = new Map(fast.verdicts.map((v) => [v.ruleId, v]));
  const modelRules = loaded.rules.filter((r) => !fastByRule.has(r.id));
  let checked: Checked[];
  try {
    checked =
      modelRules.length === 0
        ? checkable.map(({ edit, relative }) => ({
            edit,
            relative,
            outcome: {
              verdicts: fast.verdicts,
              modelRules: [],
              calls: 0,
              usage: {},
              modelLatencyMs: 0,
            },
          }))
        : await Promise.all(
            checkable.map(async ({ edit, relative, diff }) => {
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
