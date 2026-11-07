import type { Precondition, Rule, Verdict } from "oh-my-plumb-schema";
import { boundedPattern } from "./pattern.js";
import { ruleAppliesTo, ruleAppliesToTool } from "./scope.js";
import type { ToolCallEntry } from "./session.js";

/**
 * The deterministic half of a model rule: what a turn did, read off the turn's
 * own state instead of asked of a judge.
 *
 * On a turn check the judge sees this turn's diff and log, so "did this turn
 * change a file in scope" looks answerable. It is not: a judge reads its own
 * priors and the session before it, so once a session has edited in scope the
 * question answers `true` on every later turn, even one that touched nothing,
 * and no turn can ever clear it. These two tests read one thing each — the
 * files this turn changed, and the calls this turn made — and nothing else.
 */
export type PreconditionState = {
  /** Repo-relative paths this turn changed. */
  files: readonly string[];
  /** The turn's tool-call log. */
  log: readonly ToolCallEntry[];
  logComplete?: boolean;
};

const preconditionOf = (rule: Rule): Precondition | undefined =>
  rule.check.type === "model" ? rule.check.precondition : undefined;

/**
 * The precondition's own globs decide, never the rule's scope: on a toolCall
 * rule that scope holds tool names, so reading it as paths would match nothing.
 */
const anyChangeMatches = (changes: readonly string[], files: readonly string[]): boolean =>
  files.some((file) => changes.some((glob) => ruleAppliesTo({ scope: [glob] }, file)));

/**
 * A call's argument text: the named arguments when the test names them, every
 * one otherwise. An entry written before arguments were logged falls back to
 * its summary, which is all such an entry carries.
 */
const argumentTexts = (entry: ToolCallEntry, arg: readonly string[] | undefined): string[] =>
  (entry.args ?? [{ name: "", text: entry.summary }])
    .filter((a) => arg === undefined || arg.includes(a.name))
    .map((a) => a.text);

const callRan = (log: readonly ToolCallEntry[], ran: NonNullable<Precondition["ran"]>) => {
  const pattern = boundedPattern(ran.pattern);
  if (pattern.kind === "refuse") return true;
  return log.some((entry) => argumentTexts(entry, ran.arg).some((text) => pattern.test(text)));
};

/**
 * What this turn settles without a judge, as the verdict a judge would have
 * given — or nothing, when the rule still needs one.
 *
 * `changes` decides whether the rule is in play at all: a turn that changed
 * nothing the rule watches has nothing to answer for, on any turn of any
 * session. `ran` is the rule's own requirement, so it settles both ways: the
 * call is there and the rule is met, or it is absent and the rule is broken.
 * Neither answer is a judgement, and asking a model either one is how a rule
 * ends up firing on every turn of a session or on none.
 */
export const settlePrecondition = (rule: Rule, state: PreconditionState): Verdict | undefined => {
  const precondition = preconditionOf(rule);
  if (precondition === undefined) return undefined;
  if (precondition.changes !== undefined && !anyChangeMatches(precondition.changes, state.files))
    return { ruleId: rule.id, probability: 0, band: "clear", precondition: "unmet" };
  if (precondition.ran !== undefined && state.logComplete !== false) {
    return callRan(state.log, precondition.ran)
      ? { ruleId: rule.id, probability: 0, band: "clear" }
      : {
          ruleId: rule.id,
          probability: 1,
          band: "act",
          answer: `no call this turn matched /${precondition.ran.pattern}/`,
        };
  }
  return undefined;
};

/**
 * Splits the rules the way the turn will judge them: those it settles itself,
 * with the verdict it settles them at, and those that still need a judge. A
 * cleared rule is recorded rather than dropped, so `report` shows a rule that
 * was never in play apart from a rule that was asked and passed.
 */
export const settlePreconditions = (
  rules: readonly Rule[],
  state: PreconditionState,
): { settled: Verdict[]; judgeable: Rule[] } => {
  const settled: Verdict[] = [];
  const judgeable: Rule[] = [];
  for (const rule of rules) {
    const verdict = settlePrecondition(rule, state);
    if (verdict === undefined) judgeable.push(rule);
    else settled.push(verdict);
  }
  return { settled, judgeable };
};

/**
 * Whether this turn is one the rule concerns at all.
 *
 * A turn-phase call rule is normally selected by the tools its scope names —
 * which means a rule demanding a call it never got is invisible, since the
 * call it wanted is exactly what the log is missing. A precondition's
 * `changes` globs are the other way in: the turn changed a file the rule
 * watches, so the rule is in play whatever tools the log happens to hold.
 */
export const concernsTurn = (rule: Rule, state: PreconditionState): boolean => {
  const precondition = preconditionOf(rule);
  if (precondition?.changes !== undefined && anyChangeMatches(precondition.changes, state.files))
    return true;
  // A rule with a `ran` test is asking about a call it may not have got: the
  // turn is in play whatever the log holds, so the test can answer `act`.
  if (precondition?.ran !== undefined) return true;
  if (rule.scope === undefined) return state.log.length > 0;
  return state.log.some((entry) => ruleAppliesToTool(rule, entry.name));
};
