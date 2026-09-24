import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { ruleSchema } from "oh-my-plumb-schema";
import { collectReport } from "../src/commands/report.js";
import { detectStack, routesFor, type DetectedStack } from "../src/lib/detect.js";
import { fastCheck } from "../src/lib/tier1.js";
import { guardRoutes, routeGaps, routesForFile, runGuard } from "../src/lib/guards.js";
import { withGuards } from "../src/commands/init.js";

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

  it("leaves tool-call rules to the tool-call check", () => {
    const rules = [
      rule({
        id: "use-rtk",
        target: "toolCall",
        when: "edit",
        check: {
          type: "model",
          question: { type: "boolean", instructions: "q" },
          pattern: "npm install",
        },
      }),
    ];
    const { verdicts, skipped } = fastCheck(
      rules,
      "edit",
      [{ file: "src/a.ts", text: "@@ -0,0 +1 @@\n+npm install" }],
      { act: 0.8, flag: 0.5 },
    );
    expect(verdicts).toHaveLength(0);
    expect(skipped).toHaveLength(0);
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

  it("reads MCP servers from the files each host actually uses", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-detect-"));
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    const saved = process.env.OH_MY_PLUMB_HOME_DIR;
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      writeFileSync(
        path.join(root, ".mcp.json"),
        JSON.stringify({ mcpServers: { repoClaude: {} } }),
      );
      writeFileSync(path.join(root, "opencode.json"), JSON.stringify({ mcp: { projectOc: {} } }));
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(
        path.join(home, ".codex", "config.toml"),
        '[mcp_servers.codexPg]\ncommand = "pg"\n',
      );
      writeFileSync(
        path.join(home, ".claude.json"),
        JSON.stringify({
          mcpServers: { userClaude: {} },
          projects: { "/x": {}, [root]: { mcpServers: { localClaude: {} } } },
        }),
      );
      mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
      // OpenCode allows comments and trailing commas in its config.
      writeFileSync(
        path.join(home, ".config", "opencode", "opencode.json"),
        '{\n  // servers\n  "mcp": { "globalOc": {}, },\n}\n',
      );
      // The legacy per-host path and the array shape still read.
      mkdirSync(path.join(root, ".pi"), { recursive: true });
      writeFileSync(
        path.join(root, ".pi", "mcp.json"),
        JSON.stringify({ servers: [{ name: "piArray" }, { nope: 1 }] }),
      );
      expect(detectStack(root).mcpServers).toEqual([
        ".pi/mcp.json:piArray",
        ".mcp.json:repoClaude",
        "opencode.json:projectOc",
        "~/.claude.json:userClaude",
        "~/.claude.json:localClaude",
        "~/.codex/config.toml:codexPg",
        "~/.config/opencode/opencode.json:globalOc",
      ]);
    } finally {
      if (saved === undefined) delete process.env.OH_MY_PLUMB_HOME_DIR;
      else process.env.OH_MY_PLUMB_HOME_DIR = saved;
    }
  });

  it("skips missing and malformed host config files without throwing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-detect-"));
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    const saved = process.env.OH_MY_PLUMB_HOME_DIR;
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      writeFileSync(path.join(root, ".mcp.json"), "{ not json");
      writeFileSync(path.join(root, "opencode.json"), JSON.stringify({ mcp: "nope" }));
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(path.join(home, ".codex", "config.toml"), "mcp_servers = [broken");
      writeFileSync(path.join(home, ".claude.json"), "also not json");
      expect(detectStack(root).mcpServers).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.OH_MY_PLUMB_HOME_DIR;
      else process.env.OH_MY_PLUMB_HOME_DIR = saved;
    }
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
            ruleId: "migration-guard",
            trigger: "{prisma/migrations,drizzle}/**",
            command: ["echo"],
          },
        ],
        "prisma/migrations/001.sql",
      ),
    ).toHaveLength(1);
    expect(
      guards.routesForFile(
        [{ ruleId: "no-console", trigger: "src/**" }],
        "prisma/migrations/001.sql",
      ),
    ).toHaveLength(0);
  });

  it("missing guard binary is a silent pass, error output is a hit", async () => {
    const guards = await import("../src/lib/guards.js");
    expect(
      await guards.runGuard("r", "s", ["/nonexistent-guard-bin", "x"], "f.sql", "text", 500),
    ).toBeUndefined();
    const hit = await guards.runGuard(
      "migration-guard",
      "migration-guard",
      ["node", "-e", "console.log(JSON.stringify({isError:true,content:'nope'}))"],
      "f.sql",
      "text",
      5000,
    );
    expect(hit?.reason).toContain("nope");
  });

  it("a guard that hangs or prints garbage is a silent pass", async () => {
    // Genuine delay: the hang must happen in the spawned child, whose clock fake timers cannot reach.
    expect(
      await runGuard(
        "r",
        "s",
        ["node", "-e", "setTimeout(() => {}, 60_000)"],
        "f.sql",
        "text",
        300,
      ),
    ).toBeUndefined();
    expect(
      await runGuard("r", "s", ["node", "-e", "console.log('not json')"], "f.sql", "text", 5000),
    ).toBeUndefined();
  });
});

describe("init rubric round-trip", () => {
  it("records a detected guard as a rubric rule and reads it back as a route", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-roundtrip-"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "validate-migration.mjs"), "");
    const stack: DetectedStack = {
      manifests: ["package.json"],
      lintConfigs: [],
      mcpServers: [".pi/mcp.json:postgres-inspector"],
      skills: [],
    };
    const routes = routesFor(stack, root);

    const rubric = withGuards(undefined, stack, routes);
    expect(rubric?.rules.map((r) => r.check.type)).toContain("guard");
    expect(rubric?.sources.map((s) => s.path)).toContain(".pi/mcp.json");

    // Running init again upserts the same rule instead of duplicating it.
    const again = withGuards(rubric, stack, routes);
    expect(again?.rules.filter((r) => r.check.type === "guard")).toHaveLength(1);

    // A guard the user disabled stays disabled across init and never routes.
    const disabled = withGuards(
      again && { ...again, rules: again.rules.map((r) => ({ ...r, status: "disabled" as const })) },
      stack,
      routes,
    );
    expect(disabled?.rules.every((r) => r.status === "disabled")).toBe(true);
    expect(guardRoutes(disabled?.rules ?? [], root)).toEqual([]);

    const [route] = guardRoutes(again?.rules ?? [], root);
    if (route === undefined) throw new Error("guard route missing");
    expect(route.trigger).toBe("{prisma/migrations,drizzle}/**");
    expect(route.command).toEqual(["node", "./scripts/validate-migration.mjs"]);
    expect(routesForFile([route], "prisma/migrations/001.sql")).toHaveLength(1);

    const hit = await runGuard(
      route.ruleId,
      route.ruleId,
      ["node", "-e", "console.log(JSON.stringify({isError:true,content:'nope'}))"],
      "prisma/migrations/001.sql",
      "text",
      5000,
    );
    expect(hit?.ruleId).toBe("guard-postgres-inspector-validate-migration");
    expect(again?.rules.some((r) => r.id === hit?.ruleId)).toBe(true);
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

describe("route gaps", () => {
  it("finds the script past node's own flags", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-gaps-"));
    mkdirSync(path.join(root, "scripts"), { recursive: true });
    writeFileSync(path.join(root, "scripts", "x.mjs"), "");
    expect(
      routeGaps(root, { command: ["node", "--env-file=.env", "./scripts/x.mjs"] }, []),
    ).toEqual([]);
    expect(routeGaps(root, { command: ["node", "--inspect"] }, [])).toEqual([
      'command "node --inspect" names no script',
    ]);
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
          {
            id: "migration-guard",
            text: "Migration files must pass the validate_migration guard",
            source: { path: "AGENTS.md" },
            check: {
              type: "guard",
              command: ["node", "./scripts/validate-migration.mjs"],
              server: "postgres-inspector",
              tool: "validate_migration",
              scope: "{prisma/migrations,drizzle}/**",
              text: "Migration files must pass the validate_migration guard",
            },
          },
        ],
      }),
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
