import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ruleSchema } from "oh-my-plumb-schema";
import { collectReport } from "../src/commands/report.js";
import { detectStack, routesFor, type DetectedStack } from "../src/lib/detect.js";
import { fastCheck } from "../src/lib/tier1.js";

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

  it("scopes hits per file: a hit in A leaves B clean", () => {
    const rules = [
      rule({
        id: "scoped-hit",
        scope: ["src/a.ts"],
        when: "edit",
        check: {
          type: "model",
          question: { type: "boolean", instructions: "q" },
          pattern: "console\\.log",
        },
      }),
    ];
    const thresholds = { act: 0.8, flag: 0.5 };
    const diffA = "@@ -0,0 +1 @@\n+console.log(1)";
    const diffB = "@@ -0,0 +1 @@\n+console.log(1)";
    expect(
      fastCheck(rules, "edit", [{ file: "src/a.ts", text: diffA }], thresholds).verdicts,
    ).toHaveLength(1);
    expect(
      fastCheck(rules, "edit", [{ file: "src/b.ts", text: diffB }], thresholds).verdicts,
    ).toHaveLength(0);
  });
});

describe("detect", () => {
  it("finds this repo's own manifests and routes only the guards this repo has", () => {
    const root = path.resolve(import.meta.dirname, "..", "..", "..");
    const stack = detectStack(root);
    expect(stack.manifests).toContain("package.json");
    // This repo has no migration script, so init must not invent the tier-2 route (issue #16).
    expect(
      routesFor(stack, root)
        .map((r) => r.tier)
        .sort(),
    ).toEqual([1, 3]);
  });
});

describe("phase 3 guards", () => {
  it("parses guard JSON output and routes files by trigger", async () => {
    const guards = await import("../src/lib/guards.js");
    expect(guards.parseGuardOutput('{"isError":true,"content":"bad fk"}')).toEqual({
      isError: true,
      content: "bad fk",
    });
    expect(guards.parseGuardOutput("not json")).toBeUndefined();
    expect(guards.parseGuardOutput('{"content":"x"}')).toBeUndefined();
    expect(guards.parseGuardOutput('{"isError":true}')).toEqual({ isError: true, content: '""' });
    expect(
      guards.parseGuardOutput('{"isError":true,"content":[{"text":"a"},{"x":1},null,{"text":2}]}'),
    ).toEqual({ isError: true, content: "a\n2" });
    expect(
      guards.routesForFile(
        [
          {
            trigger: "{prisma/migrations,drizzle}/**",
            mcp: { server: "pg", tool: "v", command: ["echo"] },
          },
        ],
        "prisma/migrations/001.sql",
      ),
    ).toHaveLength(1);
    expect(guards.routesForFile([{ trigger: "src/**" }], "prisma/migrations/001.sql")).toHaveLength(
      0,
    );
  });

  it("missing guard binary is a silent pass, error output is a hit", async () => {
    const guards = await import("../src/lib/guards.js");
    expect(
      await guards.runGuard("r", "s", ["/nonexistent-guard-bin", "x"], "f.sql", "text", 500),
    ).toBeUndefined();
    const hit = await guards.runGuard(
      "tier2:skill:t",
      "tier2:skill:t",
      ["node", "-e", "console.log(JSON.stringify({isError:true,content:'nope'}))"],
      "f.sql",
      "text",
      5000,
    );
    expect(hit?.reason).toContain("nope");
  });
});

describe("init rules.yaml round-trip", () => {
  it("emitted tier-2 lines parse back with mcp guard attached", async () => {
    const guards = await import("../src/lib/guards.js");
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-roundtrip-"));
    mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
    const { routesFor } = await import("../src/lib/detect.js");
    const { detectStack } = await import("../src/lib/detect.js");
    void routesFor;
    void detectStack;
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rules.yaml"),
      [
        `version: "1.0"`,
        `routes:`,
        `  - tier: 2 trigger: "{prisma/migrations,drizzle}/**" action: "x"`,
        `    mcp: postgres-inspector validate_migration node ./scripts/validate-migration.mjs`,
        ``,
      ].join("\n"),
    );
    const routes = guards.readTier2Routes(root);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.trigger).toBe("{prisma/migrations,drizzle}/**");
    expect(routes[0]?.mcp?.server).toBe("postgres-inspector");
    expect(routes[0]?.mcp?.tool).toBe("validate_migration");
    expect(routes[0]?.mcp?.command).toEqual(["node", "./scripts/validate-migration.mjs"]);
    expect(guards.routesForFile(routes, "prisma/migrations/001.sql")).toHaveLength(1);
  });
});

describe("init route gating", () => {
  const stackWith = (mcpServers: string[]): DetectedStack => ({
    manifests: ["package.json"],
    lintConfigs: [],
    mcpServers,
    skills: [],
  });

  it("emits no tier-2 route unless the MCP server and the script are both here", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-init-route-"));
    const tiers = (stack: DetectedStack): (1 | 2 | 3)[] =>
      routesFor(stack, root).map((r) => r.tier);

    expect(tiers(stackWith([]))).not.toContain(2);
    expect(tiers(stackWith([".pi/mcp.json:postgres-inspector"]))).not.toContain(2);

    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "validate-migration.mjs"), "");
    expect(tiers(stackWith([".pi/mcp.json:postgres-inspector"]))).toContain(2);
  });
});

describe("report missing routes", () => {
  it("lists a configured route whose script is missing, then drops it once it resolves", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-report-route-"));
    mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rubric.json"),
      JSON.stringify({
        version: 1,
        compiledAt: "2026-09-23T00:00:00.000Z",
        sources: [],
        rules: [
          {
            id: "one-rule",
            text: "One rule.",
            source: { path: "AGENTS.md" },
            when: "edit",
            check: { type: "model", question: { type: "boolean", instructions: "q" } },
          },
        ],
      }),
    );
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rules.yaml"),
      [
        `version: "1.0"`,
        `routes:`,
        `  - tier: 2 trigger: "{prisma/migrations,drizzle}/**" action: "x"`,
        `    mcp: postgres-inspector validate_migration node ./scripts/validate-migration.mjs`,
        ``,
      ].join("\n"),
    );

    const listed = collectReport(root)?.missingRoutes;
    expect(listed).toHaveLength(1);
    expect(listed?.[0]?.trigger).toBe("{prisma/migrations,drizzle}/**");
    expect(listed?.[0]?.gaps.join(" ")).toContain("scripts/validate-migration.mjs");

    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "validate-migration.mjs"), "");
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    writeFileSync(
      path.join(root, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { "postgres-inspector": {} } }),
    );
    expect(collectReport(root)?.missingRoutes).toEqual([]);
  });
});
