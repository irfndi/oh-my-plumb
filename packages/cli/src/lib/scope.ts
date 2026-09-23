import picomatch from "picomatch";
import type { Rule } from "oh-my-plumb-schema";

const matchers = new Map<string, (p: string) => boolean>();

const matcherFor = (globs: readonly string[]): ((p: string) => boolean) => {
  const key = globs.join("\n");
  let m = matchers.get(key);
  if (m === undefined) {
    m = picomatch([...globs], { dot: true });
    matchers.set(key, m);
  }
  return m;
};

/** Repo-relative posix path against the rule's globs. No scope means every file. */
export const ruleAppliesTo = (rule: Pick<Rule, "scope">, relativePath: string): boolean =>
  rule.scope === undefined || matcherFor(rule.scope)(relativePath);

/** Tool name against a tool-call rule's globs. No scope means every tool. */
export const ruleAppliesToTool = (rule: Pick<Rule, "scope">, tool: string): boolean =>
  rule.scope === undefined || matcherFor(rule.scope)(tool);
