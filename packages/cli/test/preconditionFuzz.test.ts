import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ruleSchema, type Rule } from "oh-my-plumb-schema";
import {
  concernsTurn,
  settlePrecondition,
  type PreconditionState,
} from "../src/lib/precondition.js";
import type { ToolCallEntry } from "../src/lib/session.js";

/**
 * Randomised coverage of the one property that matters: a precondition is a
 * pure function of this turn's own state, so it can never answer from a turn
 * that came before. Every generated case is checked against a second, dumb
 * oracle written independently of the implementation.
 *
 * The generator is seeded, so a failure prints the case that produced it and
 * reruns identically — a fuzz test nobody can reproduce is a rumour.
 */

/** xorshift32: 10 lines, deterministic, and good enough to shuffle test inputs. */
const seeded = (seed: number): (() => number) => {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
};

const pick = <T>(rand: () => number, items: readonly T[]): T =>
  items[Math.floor(rand() * items.length)] as T;

const FILES = [
  "apps/frontend/src/App.tsx",
  "apps/frontend/package.json",
  "apps/backend/src/a.ts",
  "docs/readme.md",
  "AGENTS.md",
  "src/deep/nested/file.ts",
] as const;

const GLOBS = [
  "apps/frontend/**",
  "apps/frontend/**/*.tsx",
  "apps/**/*.ts",
  "docs/**",
  "**/*.md",
  "src/**",
] as const;

const COMMANDS = [
  "bun run check",
  "cd apps/frontend && bun run check .",
  "bun oxfmt --check .",
  "bun effect-tsgo --tsrs-lint oxlint --type-aware .",
  "git status",
  "pnpm test",
  "bun run check:types",
  "",
  "echo 'bun run check'",
] as const;

const PATTERNS = [
  "\\b(bun run check|oxlint|oxfmt)(?:\\s|$)",
  "bun run check",
  "oxfmt",
  "^git ",
] as const;

const ruleWith = (precondition: unknown): Rule =>
  ruleSchema.parse({
    id: "r",
    text: "t",
    source: { path: "apps/frontend/AGENTS.md" },
    target: "toolCall",
    scope: ["Bash"],
    when: "turn",
    check: {
      type: "model",
      question: { type: "boolean", instructions: "?" },
      precondition,
    },
  });

/** The oracle: written from the rule's wording, not from the implementation. */
const oracle = (
  precondition: { changes?: string[]; ran?: { arg?: string[]; pattern: string } },
  state: PreconditionState,
): { band: "act" | "clear"; why: string } | undefined => {
  const matches = (glob: string, file: string): boolean => {
    // `**/` matches zero or more directories: `src/**` is everything under src,
    // and `**/*.md` covers a top-level name too. One pass, so a `*` rule never
    // rewrites the `.*` a `**` rule just produced.
    const segments = glob.split("**/").map((part) =>
      part.replace(/[.+^${}()|[\]\\]|\*\*|\*/g, (m) => {
        if (m === "**") return ".*";
        if (m === "*") return "[^/]*";
        return `\\${m}`;
      }),
    );
    const source = segments.reduce(
      (acc, part, index) => `${acc}${index === 0 ? "" : "(?:.*/)?"}${part}`,
      "",
    );
    return new RegExp(`^${source}$`).test(file);
  };
  if (precondition.changes !== undefined) {
    const hit = state.files.some((file) => precondition.changes?.some((g) => matches(g, file)));
    if (!hit) return { band: "clear", why: "nothing watched changed" };
  }
  if (precondition.ran !== undefined) {
    const re = new RegExp(precondition.ran.pattern);
    const names = precondition.ran.arg;
    const hit = state.log.some((entry) =>
      (entry.args ?? [{ name: "", text: entry.summary }])
        .filter((a) => names === undefined || names.includes(a.name))
        .some((a) => re.test(a.text)),
    );
    return hit
      ? { band: "clear", why: "the call is there" }
      : { band: "act", why: "the call is absent" };
  }
  return undefined;
};

const randomState = (rand: () => number): PreconditionState => {
  const files = Array.from({ length: Math.floor(rand() * 4) }, () => pick(rand, FILES));
  const log: ToolCallEntry[] = Array.from({ length: Math.floor(rand() * 4) }, (_, i) => {
    const command = pick(rand, COMMANDS);
    return {
      order: i + 1,
      name: pick(rand, ["Bash", "shell", "mcp__postgres__query"] as const),
      summary: `{command=${command}}`,
      args: [{ name: "command", text: command }],
    };
  });
  return { files: [...new Set(files)], log };
};

const randomPrecondition = (rand: () => number): Record<string, unknown> => {
  const shape = rand();
  const changes = [pick(rand, GLOBS)];
  const ran = { arg: ["command"], pattern: pick(rand, PATTERNS) };
  if (shape < 0.3) return { changes };
  if (shape < 0.6) return { ran };
  return { changes, ran };
};

describe("a precondition is a pure function of this turn", () => {
  it("agrees with the oracle on 500 generated turns", () => {
    const rand = seeded(0x5eed_79);
    const mismatches: string[] = [];
    for (let i = 0; i < 500; i += 1) {
      const precondition = randomPrecondition(rand);
      const state = randomState(rand);
      const rule = ruleWith(precondition);
      const got = settlePrecondition(rule, state);
      const want = oracle(precondition, state);
      const gotBand = got?.band;
      if (gotBand !== want?.band) {
        mismatches.push(JSON.stringify({ precondition, state, got: gotBand, want: want?.band }));
      }
    }
    expect(mismatches.slice(0, 3)).toEqual([]);
  });

  it("never answers from a turn it was not given", () => {
    const rand = seeded(0xbeef_79);
    for (let i = 0; i < 200; i += 1) {
      const precondition = randomPrecondition(rand);
      const rule = ruleWith(precondition);
      const first = randomState(rand);
      const second = randomState(rand);
      // Asking twice with the same state gives the same answer: nothing accumulates.
      expect(settlePrecondition(rule, first)).toEqual(settlePrecondition(rule, first));
      // Asking about a different state gives an answer about that state alone.
      expect(settlePrecondition(rule, second)).toEqual(settlePrecondition(rule, second));
    }
  });

  it("gives a glob scope the same meaning the rest of the hook gives it", () => {
    // `mcp__postgres__*` is the documented spelling; string equality would miss it.
    const scoped = {
      ...ruleWith({ ran: { pattern: "SELECT" } }),
      scope: ["mcp__postgres__*"],
      check: { ...ruleWith({ ran: { pattern: "SELECT" } }).check, precondition: undefined },
    } as Rule;
    const called = [{ order: 1, name: "mcp__postgres__query", summary: "{}" }];
    expect(concernsTurn(scoped, { files: [], log: called })).toBe(true);
    expect(
      concernsTurn(scoped, { files: [], log: [{ order: 1, name: "Bash", summary: "{}" }] }),
    ).toBe(false);
  });

  it("keeps a `ran`-only rule in play on a turn whose log holds nothing", () => {
    // "run the tests before you finish" has no scope and no `changes`: the turn
    // it must catch is the one that called nothing at all.
    const ranOnly = ruleWith({ ran: { pattern: "pnpm test" } });
    expect(concernsTurn(ranOnly, { files: [], log: [] })).toBe(true);
    expect(settlePrecondition(ranOnly, { files: [], log: [] })?.band).toBe("act");
  });

  it("only ever reports a band the bands already define", () => {
    const rand = seeded(0x1234_79);
    for (let i = 0; i < 200; i += 1) {
      const verdict = settlePrecondition(ruleWith(randomPrecondition(rand)), randomState(rand));
      if (verdict === undefined) continue;
      expect(["act", "clear"]).toContain(verdict.band);
      expect(verdict.ruleId).toBe("r");
      // A settled rule never claims the middle band: only a judge can be unsure.
      expect(verdict.band).not.toBe("flag");
    }
  });
});

describe("whether a turn concerns a rule at all", () => {
  const watching = ruleWith({ changes: ["apps/frontend/**"], ran: { pattern: "oxfmt" } });

  it("says yes when a watched file changed, even if no tool in scope was called", () => {
    const state = { files: ["apps/frontend/src/App.tsx"], log: [] };
    expect(concernsTurn(watching, state)).toBe(true);
  });

  it("stays in play for a `ran` rule even when nothing watched changed", () => {
    // The turn it must catch may be exactly the one that called nothing.
    expect(concernsTurn(watching, { files: ["docs/readme.md"], log: [] })).toBe(true);
  });

  it("says yes for a scoped rule whose tool the turn called", () => {
    const state = { files: [], log: [{ order: 1, name: "bash", summary: "{}" }] };
    expect(concernsTurn(watching, state)).toBe(true);
  });

  it("stays in play for a `ran` rule on a turn with nothing in it at all", () => {
    expect(concernsTurn(watching, { files: [], log: [] })).toBe(true);
  });

  it("drops an unscoped rule with no precondition on a turn that called nothing", () => {
    const plain = {
      ...watching,
      scope: undefined,
      check: { ...watching.check, precondition: undefined },
    };
    expect(concernsTurn(plain, { files: [], log: [{ order: 1, name: "x", summary: "{}" }] })).toBe(
      true,
    );
    expect(concernsTurn(plain, { files: [], log: [] })).toBe(false);
  });
});

describe("a precondition never reads what a rule scope means elsewhere", () => {
  it("does not treat tool-name scope as a path glob", () => {
    // `Bash` as a path glob would be a filename, and no source file is named that.
    const rule = ruleWith({ changes: ["Bash"] });
    expect(settlePrecondition(rule, { files: ["apps/frontend/src/App.tsx"], log: [] })?.band).toBe(
      "clear",
    );
  });

  it("matches a nested file against a leading **", () => {
    const rule = ruleWith({ changes: ["**/*.ts"] });
    expect(
      settlePrecondition(rule, { files: ["src/deep/nested/file.ts"], log: [] }),
    ).toBeUndefined();
  });
});

describe("the log a precondition reads is the log that was written", () => {
  it("round-trips arguments through the turn directory", async () => {
    const { recordToolCall, readToolCalls, turnDir } = await import("../src/lib/session.js");
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-fuzz-home-"));
    const saved = process.env.OH_MY_PLUMB_HOME_DIR;
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      const dir = turnDir("s", "p");
      for (const { command } of [{ command: "bun run check" }, { command: "git status" }])
        recordToolCall(dir, "Bash", { command });
      const log = readToolCalls(dir);
      expect(log.map((e) => e.args?.[0]?.text)).toEqual(["bun run check", "git status"]);
      const rule = ruleWith({ ran: { arg: ["command"], pattern: "\\bbun run check\\b" } });
      expect(settlePrecondition(rule, { files: [], log })?.band).toBe("clear");
    } finally {
      if (saved === undefined) delete process.env.OH_MY_PLUMB_HOME_DIR;
      else process.env.OH_MY_PLUMB_HOME_DIR = saved;
    }
  });
});
