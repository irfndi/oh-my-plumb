import {
  isPlumbError,
  turnIdOf,
  type HookOutput,
  type Rule,
  type Verdict,
} from "oh-my-plumb-schema";
import { runToolCallCheck, selectToolCallRules, type CheckOutcome } from "./checkRunner.js";
import { EDIT_CHECK_TIMEOUT_MS } from "./constants.js";
import { hasApiKey } from "./credentials.js";
import { appendEvent } from "./events.js";
import { loadRubric } from "./loadRubric.js";
import { debug } from "./output.js";
import { findRepoRoot } from "./paths.js";
import { flagNotice, toolCallReason } from "./reason.js";
import { readPrompt, turnDir } from "./session.js";
import { lastUserPrompt } from "./transcript.js";

export type Pair = { rule: Rule; verdict: Verdict };

/** Edit tools, in every host's spelling: their calls are judged as diffs, never as tool calls. */
const EDIT_TOOL_NAMES = new Set(["edit", "write", "multiedit", "apply_patch"]);

/** The host fields every recorded call carries, whichever hook event delivered it. */
export type ToolCallInput = {
  session_id: string;
  prompt_id?: string;
  turn_id?: string;
  transcript_path?: string | null;
  cwd: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
};

/** One shell or MCP call a tool-call rule covers: judged on its input, no diff involved. Every host judges a call here before it runs, so each call is judged once and can be stopped. Only the act band blocks; a flag rides along as a note for the user. */
export const handleToolCall = async (input: ToolCallInput): Promise<HookOutput> => {
  const started = performance.now();
  const at = new Date().toISOString();
  const root = findRepoRoot(input.cwd);
  const loaded = loadRubric(root);
  for (const problem of loaded.problems) debug(problem);
  const call = { tool: input.tool_name, input: input.tool_input };
  // An edit tool's payload that the edit schema rejected is malformed, not a tool call.
  if (EDIT_TOOL_NAMES.has(call.tool.toLowerCase())) return { kind: "silent" };
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
  // No per-turn cap: the call has not run, so letting it through after a few denials would run it.
  const acting = pairs("act");

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

  const flagged = pairs("flag");
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
