import type { Rule, Verdict } from "oh-my-plumb-schema";

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

export const flagNotice = (
  phase: "edit" | "turn",
  flagged: readonly { rule: Rule; verdict: Verdict }[],
  files: readonly string[],
): string => {
  const list = flagged
    .map(({ rule, verdict }) => `${rule.id} ${verdict.probability.toFixed(2)}`)
    .join(", ");
  return `oh-my-plumb: uncertain about ${list} on ${files.join(", ")} (${phase}). Not sent to the agent. Details in .oh-my-plumb/events.jsonl.`;
};
