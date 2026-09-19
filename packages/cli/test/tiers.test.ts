import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ruleSchema } from "oh-my-plumb-schema";
import { detectStack, routesFor } from "../src/lib/detect.js";
import { fastCheck } from "../src/lib/tier1.js";
import { tier2Check } from "../src/lib/tier2.js";

describe("tier1 fast path", () => {
  const rule = (overrides: object) =>
    ruleSchema.parse({
      id: "tmp",
      text: "Tmp.",
      source: { path: "AGENTS.md", line: 1 },
      ...overrides,
    });
  it("hits on an overlaps pattern in added lines, zero model calls", () => {
    const rules = [
      rule({
        id: "no-console",
        text: "No console.log.",
        source: { path: "AGENTS.md", line: 1 },
        scope: ["**/*.ts"],
        status: "active",
        when: "edit",
        check: {
          type: "model",
          question: { type: "boolean", instructions: "q" },
          pattern: "console\\.log",
        },
      }),
    ];
    const { verdicts, skipped } = fastCheck(
      rules,
      "edit",
      [{ file: "src/a.ts", text: "@@ -0,0 +1 @@\n+console.log(1)" }],
      { act: 0.8, flag: 0.5 },
    );
    expect(verdicts).toHaveLength(1);
    expect(verdicts[0]?.band).toBe("act");
    expect(skipped).toHaveLength(0);
  });

  it("skips pattern-less rules for the model", () => {
    const rules = [
      rule({
        id: "vague",
        text: "Be nice.",
        source: { path: "AGENTS.md", line: 2 },
        status: "active",
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "q" } },
      }),
    ];
    const { verdicts, skipped } = fastCheck(
      rules,
      "edit",
      [{ file: "src/a.ts", text: "@@ -0,0 +1 @@\n+x()" }],
      { act: 0.8, flag: 0.5 },
    );
    expect(verdicts).toHaveLength(0);
    expect(skipped).toHaveLength(1);
  });
});

describe("tier2 migration guard", () => {
  it("blocks a foreign key to an unknown table", () => {
    const hit = tier2Check(
      "Write",
      "prisma/migrations/001_init.sql",
      "CREATE TABLE users (id INT, workspace_id INT REFERENCES workspaces(id));",
    );
    expect(hit?.ruleId).toBe("db-schema-guard");
  });

  it("passes self-contained migrations and non-migration files", () => {
    expect(
      tier2Check(
        "Write",
        "prisma/migrations/001_init.sql",
        "CREATE TABLE workspaces (id INT); CREATE TABLE users (id INT, workspace_id INT REFERENCES workspaces(id));",
      ),
    ).toBeUndefined();
    expect(tier2Check("Edit", "src/a.ts", "REFERENCES whatever")).toBeUndefined();
  });
});

describe("detect", () => {
  it("finds this repo's own manifests and routes all three tiers", () => {
    const root = path.resolve(import.meta.dirname, "..", "..", "..");
    const stack = detectStack(root);
    expect(stack.manifests).toContain("package.json");
    expect(
      routesFor(stack)
        .map((r) => r.tier)
        .sort(),
    ).toEqual([1, 2, 3]);
  });
});
