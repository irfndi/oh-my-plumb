import type { Rule } from "oh-my-plumb-schema";
import type { ToolCallEntry } from "./session.js";

/**
 * A skill's rules judge only a turn where that skill was loaded, so a skill nobody
 * used costs nothing. The signal: the skill's directory name — the segment before a
 * rule's SKILL.md source — appearing as a whole word in any call of the turn's
 * tool-call log, by tool name or argument summary.
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
    if (skill === undefined) return true;
    // A whole-word match, so a skill named "e" or "read" is not loaded by every call that contains the letters.
    const escaped = skill.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const named = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`);
    return calls.some((call) => named.test(`${call.name} ${call.summary}`));
  });
