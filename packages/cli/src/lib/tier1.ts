import type { Rule, Thresholds, Verdict } from "oh-my-plumb-schema";
import { ruleAppliesTo } from "./scope.js";

/**
 * Tier 1: zero-spawn deterministic fast path.
 *
 * A model rule carrying `check.overlaps` names a lint rule the repo already
 * configures — but when it ALSO carries a `check.pattern` (grep-shaped hint),
 * the pattern can be verified locally against the added lines before any Jev
 * call is paid for. A pattern hit at act-level confidence short-circuits the
 * model: same verdict shape, zero tokens, sub-millisecond.
 *
 * Rules without a pattern still go to the model. Full linter execution
 * belongs in `audit`/`check`, never in PostToolUse.
 */

export type FastHit = { rule: Rule; answer: string };

const addedLinesOf = (diff: string): string[] => {
  const out: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) out.push(line.slice(1));
  }
  return out;
};

const toRegExp = (pattern: string): RegExp | undefined => {
  try {
    return new RegExp(pattern);
  } catch {
    return undefined;
  }
};

/**
 * Model rules in phase + scope that carry an executable pattern. One verdict
 * per rule, probability 1 on hit (act band) — the pattern IS the violation
 * shape the rubric author recorded.
 */
export const fastCheck = (
  rules: readonly Rule[],
  phase: "edit" | "turn",
  fileDiffs: readonly { file: string; text: string }[],
  thresholds: Thresholds,
): { verdicts: Verdict[]; hits: FastHit[]; skipped: Rule[] } => {
  const verdicts: Verdict[] = [];
  const hits: FastHit[] = [];
  const skipped: Rule[] = [];
  const files = fileDiffs.map((f) => f.file);
  for (const rule of rules) {
    if (rule.status !== "active" || rule.check.type !== "model" || rule.when !== phase) continue;
    if (!files.some((f) => ruleAppliesTo(rule, f))) continue;
    const pattern = patternOf(rule);
    if (pattern === undefined) {
      skipped.push(rule);
      continue;
    }
    const re = toRegExp(pattern);
    if (re === undefined) {
      skipped.push(rule);
      continue;
    }
    const inScope = fileDiffs.filter((f) => ruleAppliesTo(rule, f.file));
    const matched = inScope.flatMap((f) =>
      addedLinesOf(f.text)
        .filter((line) => re.test(line))
        .map((line) => `${f.file}: ${line.trim().slice(0, 120)}`),
    );
    if (matched.length === 0) continue;
    const probability = 1;
    const band =
      probability >= thresholds.act ? "act" : probability >= thresholds.flag ? "flag" : "clear";
    verdicts.push({
      ruleId: rule.id,
      probability,
      band,
      answer: matched[0],
    });
    hits.push({ rule, answer: matched[0] ?? "" });
  }
  return { verdicts, hits, skipped };
};

const patternOf = (rule: Rule): string | undefined =>
  rule.check.type === "model" ? rule.check.pattern : undefined;
