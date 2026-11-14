import { describe, expect, it } from "vite-plus/test";
import type { Rule } from "oh-my-plumb-schema";
import { callLabel, flagNotice, toolCallReason } from "../src/lib/reason.js";

const rule = (id: string, line: number): Rule => ({
  id,
  text: "Always prefix shell commands with rtk",
  source: { path: "RTK.md", line },
  target: "toolCall",
  status: "active",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
});

describe("toolCallReason", () => {
  it("names the rule, its source, and the call to redo", () => {
    const reason = toolCallReason(
      [
        {
          rule: rule("use-rtk", 2),
          verdict: { ruleId: "use-rtk", probability: 0.95, band: "act" },
        },
      ],
      "Bash",
    );
    expect(reason).toContain('Rule "use-rtk" from RTK.md line 2');
    expect(reason).toContain('"Always prefix shell commands with rtk"');
    expect(reason).toContain("The call to Bash");
    expect(reason).toContain("Redo the call the way the rule asks");
  });
});

describe("flagNotice", () => {
  it("names the call, its rule, and where the rule came from", () => {
    const notice = flagNotice(
      [
        {
          rule: rule("use-make", 61),
          verdict: { ruleId: "use-make", probability: 0.55, band: "flag" },
        },
      ],
      ['bash "bun run lint"'],
    );
    expect(notice).toContain('use-make 0.55 (RTK.md line 61) on bash "bun run lint"');
    expect(notice).toContain("A rule in the middle is noted once a session");
  });

  it("keeps a wide turn to one line, and names how many files it left out", () => {
    const notice = flagNotice(
      [
        {
          rule: rule("use-make", 61),
          verdict: { ruleId: "use-make", probability: 0.6, band: "flag" },
        },
      ],
      ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"],
    );
    expect(notice).toContain("on a.ts, b.ts, c.ts and 2 more");
  });

  it("counts several rules and lists each with its own score and source", () => {
    const notice = flagNotice(
      [
        {
          rule: rule("use-make", 61),
          verdict: { ruleId: "use-make", probability: 0.55, band: "flag" },
        },
        {
          rule: rule("use-rtk", 2),
          verdict: { ruleId: "use-rtk", probability: 0.62, band: "flag" },
        },
      ],
      ['bash "bun run lint"'],
    );
    expect(notice).toContain('2 rules on bash "bun run lint"');
    expect(notice).toContain("use-make 0.55 (RTK.md line 61)");
    expect(notice).toContain("use-rtk 0.62 (RTK.md line 2)");
  });
});

describe("callLabel", () => {
  it("names a shell call by its command, not its description", () => {
    expect(
      callLabel({ tool: "Bash", input: { description: "lint", command: "bun run lint" } }),
    ).toBe('Bash "bun run lint"');
  });

  it("falls back to the tool name when the call carries nothing short enough to quote", () => {
    expect(callLabel({ tool: "Bash", input: { command: "x".repeat(500) } })).toBe("Bash");
    expect(callLabel({ tool: "Bash" })).toBe("Bash");
  });

  it("never quotes a file body, however short", () => {
    expect(callLabel({ tool: "Write", input: { file_path: "a.ts", content: "x" } })).toBe(
      'Write "a.ts"',
    );
  });

  it("cuts a long command", () => {
    expect(callLabel({ tool: "Bash", input: { command: "x".repeat(150) } })).toBe(
      `Bash "${"x".repeat(77)}..."`,
    );
  });
});
