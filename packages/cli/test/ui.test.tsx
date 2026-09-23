import { render } from "ink-testing-library";
import { describe, expect, it } from "vite-plus/test";
import type { Rule } from "oh-my-plumb-schema";
import { Verdicts } from "../src/ui/components/Verdicts.js";
import { RuleTable } from "../src/ui/components/RuleTable.js";
import { ReportView } from "../src/ui/views/ReportView.js";
import { CheckView } from "../src/ui/views/CheckView.js";
import { scopeLabel, truncate, meter } from "../src/ui/theme.js";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "check">): Rule => ({
  text: "t",
  source: { path: "AGENTS.md" },
  status: "active",
  target: "diff",
  ...over,
});

const rules: Rule[] = [
  rule({
    id: "no-interface",
    check: { type: "lint", how: "@typescript-eslint/consistent-type-definitions" },
    scope: ["**/*.ts", "**/*.tsx"],
  }),
  rule({
    id: "raw-error-to-user",
    when: "edit",
    check: { type: "model", question: { type: "boolean", instructions: "?" } },
    calibration: {
      at: "x",
      hunks: 20,
      median: 0.04,
      min: 0,
      max: 0.9,
      fired: 1,
      verdict: "decisive",
    },
  }),
  rule({
    id: "imports-ordered-by-length",
    when: "edit",
    status: "weak",
    check: { type: "model", question: { type: "boolean", instructions: "?" } },
    calibration: {
      at: "x",
      hunks: 15,
      median: 0.32,
      min: 0.1,
      max: 0.4,
      fired: 0,
      verdict: "weak",
    },
  }),
  rule({ id: "ask-first", check: { type: "unenforceable", reason: "about the conversation" } }),
];

describe("theme helpers", () => {
  it("reads globs as extensions and truncates with an ellipsis", () => {
    expect(scopeLabel(["**/*.ts", "**/*.tsx"])).toBe("ts, tsx");
    expect(scopeLabel(["apps/web/**"])).toBe("apps/web/**");
    expect(scopeLabel(undefined)).toBe("everywhere");
    expect(truncate("abcdefgh", 5)).toBe("abcd…");
    expect(truncate("abcdefgh", 5, "tail")).toBe("…efgh");
    expect(meter(0.5, 10)).toBe("█████░░░░░");
  });
});

describe("views", () => {
  it("draws every runnable rule with its status and hides the rest", () => {
    const { lastFrame } = render(<RuleTable rules={rules} runnableOnly />);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("raw-error-to-user");
    expect(frame).toContain("weak");
    expect(frame).not.toContain("no-interface");
    expect(frame).not.toContain("ask-first");
  });

  it("folds clear verdicts into one line and shows the loud ones first", () => {
    const { lastFrame } = render(
      <Verdicts
        verdicts={[
          { ruleId: "quiet-a", probability: 0.05, band: "clear" },
          { ruleId: "loud", probability: 0.94, band: "act", answer: "loose-functions" },
          { ruleId: "quiet-b", probability: 0.1, band: "clear" },
          { ruleId: "maybe", probability: 0.62, band: "flag" },
        ]}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame.indexOf("loud")).toBeLessThan(frame.indexOf("maybe"));
    expect(frame).toContain("loose-functions");
    expect(frame).toContain("2 rules clear");
    expect(frame).not.toContain("quiet-a");
  });

  it("report names the dead rules out loud", () => {
    const { lastFrame } = render(
      <ReportView
        data={{
          root: "/r",
          rules,
          events: [],
          stats: new Map(),
          dead: [],
          problems: [],
          missingRoutes: [],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("1 rule is switched off");
    expect(frame).toContain("imports-ordered-by-length");
    expect(frame).toContain("none recorded yet");
    expect(frame).toContain("For your linter");
    expect(frame).toContain("consistent-type");
    expect(frame).toContain("not configured");
    expect(frame).toContain("Not checked");
    expect(frame).toContain("ask-first");
  });

  it("report calls out a tier 2 route whose guard is missing", () => {
    const { lastFrame } = render(
      <ReportView
        data={{
          root: "/r",
          rules,
          events: [],
          stats: new Map(),
          dead: [],
          problems: [],
          missingRoutes: [{ trigger: "drizzle/**", gaps: ["scripts/v.mjs does not exist"] }],
        }}
      />,
    );
    const frame = lastFrame() ?? "";
    expect(frame).toContain("route points at a guard that is not here");
    expect(frame).toContain("drizzle/**");
    expect(frame).toContain("scripts/v.mjs does not exist");
  });

  it("check ends with the repair count", () => {
    const { lastFrame } = render(
      <CheckView
        data={{
          root: "/r",
          all: false,
          spendUsd: 0.0001,
          sections: [
            {
              phase: "edit",
              files: ["a.ts"],
              modelRules: 3,
              calls: 1,
              latencyMs: 400,
              verdicts: [{ ruleId: "x", probability: 0.9, band: "act" }],
            },
          ],
        }}
      />,
    );
    expect(lastFrame()).toContain("1 to repair");
  });
});
