import type { Rule, Verdict } from "oh-my-plumb-schema";
import { shortArgument } from "./session.js";

const where = (rule: Rule): string =>
  rule.source.line === undefined
    ? rule.source.path
    : `${rule.source.path} line ${rule.source.line}`;

const quote = (text: string): string => {
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 220 ? `${trimmed.slice(0, 217)}...` : trimmed;
};

/** One violation as a sentence: which rule, from where, in the user's own words. */
const sentence = ({ rule, verdict }: { rule: Rule; verdict: Verdict }): string => {
  const evidence =
    rule.check.type === "lint" && verdict.answer !== undefined
      ? ` Matched: ${verdict.answer}`
      : verdict.answer !== undefined
        ? ` Judged: ${verdict.answer} (${verdict.probability.toFixed(2)}).`
        : ` (${verdict.probability.toFixed(2)})`;
  return `Rule "${rule.id}" from ${where(rule)}: "${quote(rule.text)}".${evidence}`;
};

/** One sentence per violation, naming the rule. Never the whole instruction file. */
export const repairReason = (
  phase: "edit" | "turn",
  violations: readonly { rule: Rule; verdict: Verdict }[],
  files: readonly string[],
): string => {
  const lines = violations.map(sentence);
  const subject = phase === "edit" ? "This edit" : "The changes in this turn";
  const target = files.length === 1 ? files[0] : `${files.length} files (${files.join(", ")})`;
  const ask =
    phase === "edit"
      ? `Repair ${target} now, then continue with the task.`
      : `Repair ${target} before you finish. Keep the fix to what the rule asks.`;
  return `oh-my-plumb: ${subject} appears to break ${lines.length === 1 ? "a rule" : `${lines.length} rules`} from this repository's instructions.\n${lines.map((l) => `- ${l}`).join("\n")}\n${ask}`;
};

/** What Stop says when a turn-phase tool-call rule fires: the rule, and that the turn's calls broke it. */
export const turnToolCallReason = (
  violations: readonly { rule: Rule; verdict: Verdict }[],
): string => {
  const lines = violations.map(sentence);
  const count = lines.length === 1 ? "a rule" : `${lines.length} rules`;
  return `oh-my-plumb: The tools this turn called appear to break ${count} from this repository's instructions.\n${lines.map((l) => `- ${l}`).join("\n")}\nDo what the rule asks before you finish.`;
};

/** What the hook says when a tool-call rule fires: the rule, from where, and which call to redo. */
export const toolCallReason = (
  violations: readonly { rule: Rule; verdict: Verdict }[],
  tool: string,
): string => {
  const lines = violations.map(sentence);
  const count = lines.length === 1 ? "a rule" : `${lines.length} rules`;
  return `oh-my-plumb: The call to ${tool} appears to break ${count} from this repository's instructions.\n${lines.map((l) => `- ${l}`).join("\n")}\nRedo the call the way the rule asks, then continue with the task.`;
};

const MAX_SUBJECTS = 3;

const MAX_CALL_CHARS = 80;

export const callLabel = (call: { tool: string; input?: unknown }): string => {
  const argument = call.input === undefined ? undefined : shortArgument(call.input);
  if (argument === undefined) return call.tool;
  const shown =
    argument.length > MAX_CALL_CHARS ? `${argument.slice(0, MAX_CALL_CHARS - 3)}...` : argument;
  return `${call.tool} "${shown}"`;
};

export const flagNotice = (
  flagged: readonly { rule: Rule; verdict: Verdict }[],
  subjects: readonly string[],
): string => {
  const shown = subjects.slice(0, MAX_SUBJECTS);
  const rest = subjects.length - shown.length;
  const on = rest === 0 ? shown.join(", ") : `${shown.join(", ")} and ${rest} more`;
  const list = flagged
    .map(({ rule, verdict }) => `${rule.id} ${verdict.probability.toFixed(2)} (${where(rule)})`)
    .join(", ");
  const what =
    flagged.length === 1 ? `${list} on ${on}` : `${flagged.length} rules on ${on}: ${list}`;
  return `oh-my-plumb: ${what}. Not sent to the agent. A rule in the middle is noted once a session; every verdict is in .oh-my-plumb/events.jsonl.`;
};
