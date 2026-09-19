import { describe, expect, it } from "vite-plus/test";
import { ruleAppliesTo } from "../src/lib/scope.js";
import { groupByScope, selectRules } from "../src/lib/checkRunner.js";
import type { Rule } from "oh-my-plumb-schema";

const rule = (over: Partial<Rule> & Pick<Rule, "id" | "check">): Rule => ({
  text: "t",
  source: { path: "AGENTS.md" },
  status: "active",
  ...over,
});

describe("scope", () => {
  it("applies everywhere without a scope, and only inside its globs with one", () => {
    expect(ruleAppliesTo({ scope: undefined }, "any/file.ts")).toBe(true);
    expect(
      ruleAppliesTo(
        { scope: ["apps/web/src/server/**/*.service.ts"] },
        "apps/web/src/server/Run.service.ts",
      ),
    ).toBe(true);
    expect(
      ruleAppliesTo(
        { scope: ["apps/web/src/server/**/*.service.ts"] },
        "apps/web/src/pages/index.tsx",
      ),
    ).toBe(false);
    expect(ruleAppliesTo({ scope: ["**/*.tsx"] }, "a/.hidden/x.tsx")).toBe(true);
  });

  it("selects by status, phase, and scope", () => {
    const rules: Rule[] = [
      rule({ id: "lint", check: { type: "lint", how: "x" } }),
      rule({
        id: "edit",
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      }),
      rule({
        id: "turn",
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      }),
      rule({
        id: "weak",
        when: "edit",
        status: "weak",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      }),
      rule({
        id: "scoped",
        when: "edit",
        scope: ["src/**"],
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      }),
      rule({ id: "deferred", check: { type: "deferred", reason: "r" } }),
    ];
    expect(selectRules(rules, "edit", ["lib/a.ts"]).map((r) => r.id)).toEqual(["edit"]);
    expect(selectRules(rules, "edit", ["src/a.ts"]).map((r) => r.id)).toEqual(["edit", "scoped"]);
    expect(selectRules(rules, "turn", ["src/a.ts"]).map((r) => r.id)).toEqual(["turn"]);
  });
});

describe("turn grouping", () => {
  it("sends each rule only the files inside its scope", () => {
    const model = (id: string, scope?: string[]): Rule & { check: { type: "model" } } => ({
      ...rule({
        id,
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      }),
      ...(scope ? { scope } : {}),
      check: { type: "model", question: { type: "boolean", instructions: "?" } },
    });
    const groups = groupByScope(
      [
        model("everywhere"),
        model("web-only", ["web/**"]),
        model("web-too", ["web/**"]),
        model("css", ["**/*.css"]),
      ],
      [
        { file: "web/a.ts", text: "+a" },
        { file: "server/b.ts", text: "+b" },
      ],
    );
    expect(groups.map((g) => [g.rules.map((r) => r.id), g.fileDiffs.map((f) => f.file)])).toEqual([
      [["everywhere"], ["web/a.ts", "server/b.ts"]],
      [["web-only", "web-too"], ["web/a.ts"]],
    ]);
  });
});
