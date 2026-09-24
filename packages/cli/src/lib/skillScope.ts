import type { Rule } from "oh-my-plumb-schema";
import type { ToolCallEntry } from "./session.js";

/**
 * A skill's rules judge only a turn where that skill was loaded, so a skill nobody
 * used costs nothing. The signal: the skill's directory name — the segment before a
 * rule's SKILL.md source — appearing in any call of the turn's tool-call log, by
 * tool name or argument summary.
 */
export const filterToLoadedSkills = <T extends Rule>(
  rules: readonly T[],
  calls: readonly ToolCallEntry[],
): T[] =>
  rules.filter((rule) => {
    const segments = rule.source.path.split("/");
    const skill =
      segments.length > 1 && segments.at(-1) === "SKILL.md"
        ? segments[segments.length - 2]
        : undefined;
    return (
      skill === undefined ||
      calls.some((call) => call.name.includes(skill) || call.summary.includes(skill))
    );
  });
