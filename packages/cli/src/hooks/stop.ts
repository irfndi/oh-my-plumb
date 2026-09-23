import { existsSync } from "node:fs";
import path from "node:path";
import {
  createBlobId,
  isPlumbError,
  stopInputSchema,
  turnIdOf,
  type HookOutput,
  type Rule,
  type Verdict,
} from "oh-my-plumb-schema";
import { mergeOutcomes, runCheck, type CheckOutcome } from "../lib/checkRunner.js";
import {
  MAX_STOP_CHECKS_PER_TURN,
  STOP_FALLBACK_DIFF_TIMEOUT_MS,
  STOP_GIT_TIMEOUT_MS,
  TURN_CHECK_TIMEOUT_MS,
} from "../lib/constants.js";
import { editsCoverFile } from "../lib/coverage.js";
import { boundState, remainingMs, unifiedDiff } from "../lib/diff.js";
import { appendEvent } from "../lib/events.js";
import { blobIdsAt, diffTrees, snapshotTree, splitDiff, type FileDiff } from "../lib/git.js";
import { hasApiKey } from "../lib/credentials.js";
import { loadRubric } from "../lib/loadRubric.js";
import { debug } from "../lib/output.js";
import { findRepoRoot, isExcludedPath, relativeToRoot } from "../lib/paths.js";
import { readRegularFile, readRegularText } from "../lib/regularFile.js";
import { flagNotice, repairReason } from "../lib/reason.js";
import {
  clearTurn,
  hasTurnState,
  incrementStopChecks,
  readBaseline,
  readBlockedFiles,
  readBaselineStatus,
  readChecked,
  readFileStarts,
  readPrompt,
  stopCheckCount,
  turnDir,
} from "../lib/session.js";
import { lastUserPrompt } from "../lib/transcript.js";

export type TurnDiff =
  | {
      kind: "complete";
      files: string[];
      fileDiffs: FileDiff[];
      source: "git" | "files";
      /** Blob id at turn start per file; null if absent then, undefined if git could not say. */
      startIds: Map<string, string | null> | undefined;
    }
  /** Part of the turn could not be read back in time. A judgment on the rest would be a judgment on a different change. */
  | { kind: "incomplete"; reason: string; missing: string[] };

/**
 * Everything the turn changed. With a baseline from turn-start it is the git
 * diff between then and now, whichever tool made the change. Without one it
 * is each file's start-of-turn content against the disk, which sees only what
 * Edit and Write touched. Every diff here shares one budget, and a turn that
 * did not fit in it is reported as incomplete rather than checked in part.
 */
export const turnDiff = (root: string, dir: string): TurnDiff => {
  const status = readBaselineStatus(dir);
  if (status === "failed" || status === "pending") {
    return {
      kind: "incomplete",
      reason: "git could not snapshot the working tree at turn start",
      missing: [],
    };
  }
  const baseline = readBaseline(dir);
  if (baseline !== undefined) {
    const started = performance.now();
    const now = snapshotTree(root, path.join(dir, "index"), STOP_GIT_TIMEOUT_MS);
    const left = Math.floor(STOP_GIT_TIMEOUT_MS - (performance.now() - started));
    const patch = now === undefined || left <= 0 ? undefined : diffTrees(root, baseline, now, left);
    if (patch === undefined)
      return {
        kind: "incomplete",
        reason: "git could not snapshot the working tree in time",
        missing: [],
      };
    const fileDiffs = splitDiff(patch);
    const files = fileDiffs.map((f) => f.file);
    const stillLeft = Math.floor(STOP_GIT_TIMEOUT_MS - (performance.now() - started));
    const ids = stillLeft <= 0 ? undefined : blobIdsAt(root, baseline, files, stillLeft);
    return {
      kind: "complete",
      files,
      fileDiffs,
      source: "git",
      startIds: ids === undefined ? undefined : new Map(files.map((f) => [f, ids.get(f) ?? null])),
    };
  }
  const deadline = performance.now() + STOP_FALLBACK_DIFF_TIMEOUT_MS;
  const fileDiffs: FileDiff[] = [];
  const missing: string[] = [];
  const startIds = new Map<string, string | null>();
  for (const start of readFileStarts(dir)) {
    const relative = relativeToRoot(root, start.path);
    if (relative.startsWith("..") || isExcludedPath(relative)) continue;
    const after = readRegularText(start.path) ?? null;
    if (after === null && existsSync(start.path)) {
      missing.push(relative);
      continue;
    }
    if (start.original === after) continue;
    const patch = unifiedDiff(relative, start.original ?? "", after ?? "", remainingMs(deadline));
    if (patch === undefined) {
      missing.push(relative);
      continue;
    }
    fileDiffs.push(...splitDiff(patch));
    startIds.set(relative, start.original === null ? null : createBlobId(start.original));
  }
  if (missing.length > 0) {
    return {
      kind: "incomplete",
      reason: "some files changed this turn could not be diffed in time",
      missing,
    };
  }
  return {
    kind: "complete",
    files: fileDiffs.map((f) => f.file),
    fileDiffs,
    source: "files",
    startIds,
  };
};

type Pair = { rule: Rule; verdict: Verdict };

export const handleStop = async (raw: unknown): Promise<HookOutput> => {
  const parsed = stopInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const started = performance.now();
  const at = new Date().toISOString();
  const root = findRepoRoot(input.cwd);
  const dir = turnDir(input.session_id, turnIdOf(input));

  const finish = (output: HookOutput): HookOutput => {
    if (output.kind !== "block") clearTurn(dir);
    return output;
  };

  if (!hasTurnState(dir)) return finish({ kind: "silent" });
  if (stopCheckCount(dir) >= MAX_STOP_CHECKS_PER_TURN) return finish({ kind: "silent" });

  const loaded = loadRubric(root);
  for (const problem of loaded.problems) debug(problem);
  if (loaded.rules.length === 0) return finish({ kind: "silent" });

  const turn = turnDiff(root, dir);
  if (turn.kind === "incomplete") {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      reason: `turn diff incomplete: ${turn.reason}`,
      files: turn.missing,
    });
    return finish({ kind: "silent" });
  }
  const { files, fileDiffs } = turn;
  if (files.length === 0) return finish({ kind: "silent" });
  const bounded = fileDiffs.map((f) => ({
    file: f.file,
    text: boundState(f.text, 8_000).text,
  }));

  if (!hasApiKey(root)) {
    appendEvent(root, {
      kind: "skip",
      at,
      phase: "turn",
      sessionId: input.session_id,
      reason: "no api key",
      files,
    });
  }

  incrementStopChecks(dir);
  // Edit-phase rules rerun on files the edit checks did not see whole, and on
  // blocked ones: a block the agent ignored must not end the turn quietly.
  const checked = readChecked(dir);
  const blocked = readBlockedFiles(dir);
  const covered = (file: string): boolean => {
    if (turn.startIds === undefined || blocked.has(file)) return false;
    const now = readRegularFile(path.join(root, file));
    if (now === undefined) return false;
    const start = turn.startIds.get(file) ?? null;
    return editsCoverFile(
      start,
      checked.filter((e) => e.path === file),
      createBlobId(now),
    );
  };
  const unchecked = bounded.filter((f) => !covered(f.file));
  const task = lastUserPrompt(input.transcript_path ?? undefined) ?? readPrompt(dir);
  let outcome: CheckOutcome;
  try {
    const turnOutcome = await runCheck({
      phase: "turn",
      fileDiffs: bounded,
      task,
      rules: loaded.rules,
      thresholds: loaded.thresholds,
      timeoutMs: TURN_CHECK_TIMEOUT_MS,
    });
    const editOutcomes = await Promise.all(
      unchecked.map((f) =>
        runCheck({
          phase: "edit",
          fileDiffs: [f],
          task,
          rules: loaded.rules,
          thresholds: loaded.thresholds,
          timeoutMs: TURN_CHECK_TIMEOUT_MS,
        }),
      ),
    );
    outcome = mergeOutcomes([turnOutcome, ...editOutcomes]);
  } catch (error) {
    appendEvent(root, {
      kind: "error",
      at,
      phase: "turn",
      sessionId: input.session_id,
      code: isPlumbError(error) ? error.code : "CHECK_FAILED",
      message: error instanceof Error ? error.message : String(error),
      latencyMs: Math.round(performance.now() - started),
    });
    return finish({ kind: "silent" });
  }

  const byId = new Map(loaded.rules.map((r) => [r.id, r]));
  const pairs = (band: Verdict["band"]): Pair[] =>
    outcome.verdicts.flatMap((verdict) => {
      const rule = byId.get(verdict.ruleId);
      return rule !== undefined && verdict.band === band ? [{ rule, verdict }] : [];
    });
  const acting = pairs("act");
  const flagged = pairs("flag");

  appendEvent(root, {
    kind: "check",
    at,
    phase: "turn",
    sessionId: input.session_id,
    promptId: turnIdOf(input),
    files,
    rules: outcome.modelRules.length,
    latencyMs: Math.round(performance.now() - started),
    modelLatencyMs: outcome.modelLatencyMs,
    usage: outcome.usage,
    verdicts: outcome.verdicts,
    blocked: acting.length > 0,
  });

  const systemMessage = flagged.length > 0 ? flagNotice("turn", flagged, files) : undefined;
  if (acting.length > 0) {
    return finish({
      kind: "block",
      reason: repairReason("turn", acting, files),
      ...(systemMessage === undefined ? {} : { systemMessage }),
    });
  }
  return finish(
    systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage },
  );
};
