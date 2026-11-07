import { describe, expect, it } from "vite-plus/test";
import { rubricSchema, ruleSchema, type Rule } from "oh-my-plumb-schema";
import { settlePreconditions, settlePrecondition } from "../src/lib/precondition.js";
import type { ToolCallEntry } from "../src/lib/session.js";

const rule = (id: string, over: Record<string, unknown> = {}): Rule =>
  ruleSchema.parse({
    id,
    text: "Run `bun run check` before pushing.",
    source: { path: "apps/frontend/AGENTS.md", line: 80 },
    target: "toolCall",
    scope: ["Bash", "shell"],
    when: "turn",
    check: { type: "model", question: { type: "boolean", instructions: "?" }, ...over },
    status: "active",
  });

const call = (name: string, text: string): ToolCallEntry => ({
  order: 1,
  name,
  summary: `{command=${text}}`,
  args: [{ name: "command", text }],
});

const lintGate = (): Rule =>
  rule("lint-format-check", {
    precondition: {
      changes: ["apps/frontend/**"],
      ran: { arg: ["command"], pattern: "\\bbun run check\\b" },
    },
  });

describe("a rule's precondition", () => {
  it("is read off the turn, not asked of a judge", () => {
    expect(settlePrecondition(lintGate(), { files: [], log: [] })).toBeDefined();
    expect(settlePrecondition(rule("plain"), { files: [], log: [] })).toBeUndefined();
  });

  it("clears a turn that changed nothing in scope, even when the gate ran", () => {
    const { settled, judgeable } = settlePreconditions([lintGate()], {
      files: ["apps/backend/src/a.ts"],
      log: [call("Bash", "bun run check")],
    });
    expect(judgeable).toEqual([]);
    expect(settled).toEqual([
      { ruleId: "lint-format-check", probability: 0, band: "clear", precondition: "unmet" },
    ]);
  });

  it("clears a turn that changed nothing at all", () => {
    const { settled } = settlePreconditions([lintGate()], { files: [], log: [] });
    expect(settled.map((v: { ruleId: string }) => v.ruleId)).toEqual(["lint-format-check"]);
  });

  it("judges a turn that changed a file in scope", () => {
    const { settled, judgeable } = settlePreconditions([lintGate()], {
      files: ["apps/frontend/src/App.tsx"],
      log: [call("Bash", "bun run check")],
    });
    // Both tests settle it: a watched file changed, and the gate ran.
    expect(settled).toEqual([{ ruleId: "lint-format-check", probability: 0, band: "clear" }]);
    expect(judgeable).toEqual([]);
  });

  it("judges a turn that changed nothing in scope but ran no gate, so a turn-phase precondition with only `changes` cannot fire", () => {
    const changesOnly = rule("changes-only", { precondition: { changes: ["apps/frontend/**"] } });
    expect(settlePreconditions([changesOnly], { files: [], log: [] }).settled).toHaveLength(1);
    // It changed a watched file, so the judge is the one that decides.
    expect(settlePreconditions([changesOnly], { files: ["apps/frontend/a.ts"], log: [] })).toEqual({
      settled: [],
      judgeable: [changesOnly],
    });
  });

  it("fires a turn whose in-scope edit never ran the gate, with no judge asked", () => {
    const { settled } = settlePreconditions([lintGate()], {
      files: ["apps/frontend/src/App.tsx"],
      log: [call("Bash", "git status")],
    });
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({ ruleId: "lint-format-check", probability: 1, band: "act" });
  });

  it("reads a precondition's own globs, never the rule scope's tool names", () => {
    // The rule is scoped to tool names; reading its scope as paths would match nothing.
    const scoped = rule("scoped", { precondition: { changes: ["**/*.ts"] } });
    expect(settlePreconditions([scoped], { files: ["a.ts"], log: [] }).judgeable).toHaveLength(1);
  });

  it.each([
    ["an inline gate", "bun run check", true],
    ["the gate after another command", "cd apps/frontend && bun run check .", true],
    ["oxlint alone", "bun effect-tsgo --tsrs-lint oxlint --type-aware .", true],
    ["oxfmt alone", "bun oxfmt --check .", true],
    ["a package script that merely starts the same words", "bun run check:types", false],
    ["a different runner", "npm run check", false],
    ["an unrelated command", "git status", false],
  ])("matches %s", (_name, text, ran) => {
    const gateOnly = rule("gate-only", {
      precondition: {
        ran: { arg: ["command"], pattern: "\\b(bun run check|oxlint|oxfmt)(?:\\s|$)" },
      },
    });
    // Either way the hook settles it: met is a pass, absent is a violation.
    const [verdict] = settlePreconditions([gateOnly], {
      files: [],
      log: [call("Bash", text)],
    }).settled;
    expect(verdict?.band).toBe(ran ? "clear" : "act");
  });

  it("is only as precise as the pattern the rubric author wrote", () => {
    const loose = rule("loose", { precondition: { ran: { pattern: "\\bbun run check\\b" } } });
    // A word boundary does not separate `check` from `check:types`: that is the author's call.
    expect(
      settlePreconditions([loose], { files: [], log: [call("Bash", "bun run check:types")] })
        .settled[0]?.band,
    ).toBe("clear");
  });

  it("falls back to the summary for an entry written before arguments were logged", () => {
    const legacy: ToolCallEntry = { order: 1, name: "Bash", summary: "{command=bun run check}" };
    const gateOnly = rule("gate-only", { precondition: { ran: { pattern: "bun run check" } } });
    expect(settlePreconditions([gateOnly], { files: [], log: [legacy] }).settled[0]?.band).toBe(
      "clear",
    );
  });

  it("reads only the arguments a test names", () => {
    const byName = rule("by-name", {
      precondition: { ran: { arg: ["command"], pattern: "oxfmt" } },
    });
    const log = [
      { order: 1, name: "Bash", summary: "{}", args: [{ name: "description", text: "run oxfmt" }] },
    ];
    // The argument it reads is `command`, and this call has none: the rule is broken.
    expect(settlePreconditions([byName], { files: [], log }).settled[0]?.band).toBe("act");
  });
});

describe("the schema refuses a precondition it cannot honour", () => {
  const parse = (over: Record<string, unknown>): ReturnType<typeof rubricSchema.safeParse> =>
    rubricSchema.safeParse({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "r",
          text: "t",
          source: { path: "AGENTS.md" },
          target: "toolCall",
          when: "turn",
          check: { type: "model", question: { type: "boolean", instructions: "?" }, ...over },
        },
      ],
    });

  it("needs when: turn, because a precondition reads the turn's log", () => {
    const out = rubricSchema.safeParse({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "r",
          text: "t",
          source: { path: "AGENTS.md" },
          when: "edit",
          check: {
            type: "model",
            question: { type: "boolean", instructions: "?" },
            precondition: { changes: ["**/*.ts"] },
          },
        },
      ],
    });
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain("needs");
  });

  it("refuses an invalid pattern", () => {
    expect(parse({ precondition: { ran: { pattern: "([unclosed" } } }).success).toBe(false);
  });

  it("reads a rule still under an edit phase as invalid, whatever its target", () => {
    const out = rubricSchema.safeParse({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "r",
          text: "t",
          source: { path: "AGENTS.md" },
          target: "toolCall",
          scope: ["Bash"],
          when: "edit",
          check: {
            type: "model",
            question: { type: "boolean", instructions: "?" },
            precondition: { changes: ["**/*.ts"] },
          },
        },
      ],
    });
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain("reads a precondition off the turn");
  });

  it("accepts both tests together", () => {
    expect(
      parse({
        precondition: {
          changes: ["apps/frontend/**"],
          ran: { arg: ["command"], pattern: "\\bbun run check\\b" },
        },
      }).success,
    ).toBe(true);
  });

  it("refuses a precondition on a diff target, where no log is ever handed to it", () => {
    const out = rubricSchema.safeParse({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "r",
          text: "t",
          source: { path: "AGENTS.md" },
          when: "turn",
          check: {
            type: "model",
            question: { type: "boolean", instructions: "?" },
            precondition: { ran: { arg: ["command"], pattern: "pnpm test" } },
          },
        },
      ],
    });
    expect(out.success).toBe(false);
    expect(JSON.stringify(out.error?.issues)).toContain("read off the turn's tool-call log");
  });
});
