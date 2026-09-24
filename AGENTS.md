# oh-my-plumb — Agent Instructions

Hard rules for anyone (human or agent) working in this repo. Read fully before writing code.

## Hard requirements

- **The hook must never break the agent.** Every hook path exits 0, bounds its own time, and writes nothing to stdout but the JSON the host expects. A hook that hangs, crashes or chatters takes the user's whole coding session with it. This outranks every other goal in this repo: a check that did not run is a missed violation, and a check that wedged the agent is a bug report.
- **No secrets in this repo, ever.** The API key is read from the environment, from a `.env` at the repo root, or from `~/.oh-my-plumb/.env`, which `oh-my-plumb login` writes with owner-only permissions and which is the only file oh-my-plumb may ever write a key to. Never accept it as a flag — a flag lands in shell history and in CI logs — and never log it.
- **Verify before claiming done**: tests green, `pnpm build` + typecheck clean, and the end-to-end path exercised against live Jev with latency measured. A rule checker that has never checked a real diff is not done.
- **No AI attribution in commits or pull requests.** No `Co-Authored-By` line for a model, no "Generated with" footer, no session link, no bot listed as an author. Whoever opened the pull request is the author of every commit in it. Coding agents add these by default: `.claude/settings.json` in this repo turns them off for Claude Code, and if you use another tool, find its switch before your first commit. A squash merge carries a co-author trailer over from the branch, so check the merge box too.
- **Pass user-facing words through the humanizer before shipping them.** Anything a person reads — CLI output, rule instructions, README prose, error messages, the compile skill — goes through the [humanizer skill](https://github.com/blader/humanizer/blob/main/SKILL.md) first. Copy that reads as machine-written spends trust the tool then has to earn back.

# General

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:

- Don't "improve" adjacent code, comments, or formatting.
- Preserve intentional blank lines between methods and logical blocks. Do not compact whitespace to reduce line count or satisfy a file-size target; restructure the code instead if length is a problem.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:

- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Comment Sparingly

**Default to no comment. Code says WHAT; comments say WHY — and only when the WHY isn't obvious.**

- Don't narrate what the code does — the reader sees the `map`, the `switch`, the names. Restating them is noise.
- Comment only the non-obvious: a reason, a gotcha, a workaround, a constraint, a "looks wrong but isn't."
- If code needs a comment to be understood, first make the code clearer (rename, extract). Comment only what better code can't express.
- Delete comments that restate the adjacent line. One earned comment beats ten obvious ones.
- Every comment must earn its place: if you can't name what it tells the reader that the code doesn't, drop it.

## 6. Build for the Long Term

- Do not preserve backward compatibility. Remove obsolete paths instead of adding compatibility layers, fallbacks, or migrations.
- Choose the simplest implementation that fully meets the current requirements. Avoid speculative abstractions, configuration, and indirection.
- Grow the system in layers. Start from the smallest version that works end to end, and add each new capability on top of a product that already works. Never trade a working product for unfinished complexity.
- Keep components modular and concerns clearly separated.
- Prefer established, well-maintained libraries when they reduce overall complexity or improve reliability. Do not reimplement common functionality without a clear reason.
- Lean on the dependencies already in the project before writing your own implementation or adding packages. Do not assume a library lacks a capability without checking its documentation and types.
- Make architectural decisions for the long term. Do not accept a stopgap that only works for now and is meant to be replaced later.
- Highly prefer E2E tests as the sole testing mechanism. Use them to verify complex features work. At the end of E2E tests, produce a verifiable and repeatable artifact.
- If you must test a system in isolation, FIRST write all the ways it could fail, THEN write the code.

# TypeScript quality — exhaustive, deterministic types

Quality software is built on types the compiler can enforce. These are non-negotiable in this codebase.

- **Closed sets use an exhaustive `switch` + `assertNever`.** For discriminated unions / enums, `switch` on the discriminant and end with `default: return assertNever(value)` so adding a variant fails to compile until every consumer handles it. Never use if/else-if chains for mutually-exclusive variants. When behavior depends on several related status checks, derive one closed decision/status type and switch over that — don't scatter conditionals through a method. Define `assertNever` once in the schema package's utils and import it everywhere:

  ```ts
  export const assertNever = (value: never, message = "Unhandled variant"): never => {
    throw new Error(`${message}: ${JSON.stringify(value)}`);
  };
  ```

- **Use `type`, not `interface`.**
- **Discriminated unions for state** — every multi-shape value carries a `type`/`kind` discriminant. No optional-field soup where one shape is meant.
- **No type casting.** `as` is a bug until proven otherwise — narrow with `typeof`/discriminants/schema parsing instead. (`as const` and zod `.parse()` outputs are fine.)
- **Expected failures use typed domain errors** with a stable machine-readable `code` (SCREAMING_SNAKE_CASE) callers can switch on exhaustively. Concise messages, no terminal punctuation.
- **Deterministic ID/key formats have a single owner**: one named creation function per format (rule ids, source hashes, rubric cache keys). Never inline-format the same ID in two places.
- **Schema-first boundaries**: anything crossing a process/API boundary is zod-parsed at the edge; internal code trusts parsed types, never re-validates ad hoc. The hook payload, the rubric file and the model's answers are all boundaries.

# Repo specifics

- pnpm monorepo: `packages/schema` (the contract — everything else consumes it), `packages/cli`, `packages/hooks` (the scripts each host registers), `skills/oh-my-plumb-compile` (what SessionStart hands to the agent). MIT © irfndi.
- **Zero Coldtea dependency.** This runs in anyone's repo on anyone's machine. Nothing here may require Coldtea to be installed, running, or reachable. The animated character is a separate product in a separate repo and is not this package's concern.
- **The rubric is the product's trust surface.** It is a committed, human-readable, hand-editable file. Every verdict must trace to a named rule a person can read and rewrite. A verdict that cannot be explained by pointing at a rule is a bug.
- **No default rules.** Rules come only from the user's own instruction files. Shipping a built-in ruleset turns this into a generic linter and loses the premise, which is enforcing _their_ rules.
- **Band verdicts, never threshold at 0.5.** Act above a high score, flag the middle, ignore below. Measured calibration is good at the ends and genuinely uncertain in the middle, so the middle belongs to the human.
- **Latency is flat with rule count; cost is not.** Rule instructions are input tokens billed on every edit whether or not a rule fires. Trim instructions for tokens as well as for readability, and use `scope` globs to keep out-of-scope questions out of the request entirely.
- Prefer the mechanical check. A rule a linter can enforce exactly, for free, must never be sent to a model.
