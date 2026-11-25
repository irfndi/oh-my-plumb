import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { rubricSchema, ruleSchema, type Rule, type Rubric } from "oh-my-plumb-schema";
import { collectReport, reportJson } from "../src/commands/report.js";
import { loadRubric } from "../src/lib/loadRubric.js";
import { uninstallHost } from "../src/lib/hosts.js";
import { mergeRules } from "../src/lib/rubricFile.js";
import { resolveRepoRoot } from "../src/lib/paths.js";
import { readEvents } from "../src/lib/events.js";

const home = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  process.env.OH_MY_PLUMB_HOME_DIR = dir;
  return dir;
};

/** A repo root with a git file, which is what makes it a repository rather than a folder under home. */
const repo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  writeFileSync(path.join(root, ".git"), "gitdir: elsewhere\n");
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  return root;
};

const rule = (id: string, over: Record<string, unknown> = {}): Rule =>
  ruleSchema.parse({
    id,
    text: "Never use npx; use bun x.",
    source: { path: "AGENTS.md", line: 3 },
    target: "toolCall",
    scope: ["Bash"],
    when: "edit",
    check: { type: "model", question: { type: "boolean", instructions: "Did it use npx?" } },
    status: "active",
    ...over,
  });

const rubric = (rules: Rule[]): Rubric =>
  rubricSchema.parse({
    version: 1,
    compiledAt: "2026-01-01T00:00:00.000Z",
    sources: [{ path: "AGENTS.md" }],
    rules,
  });

const writeProject = (root: string, rules: Rule[]): void => {
  writeFileSync(path.join(root, ".oh-my-plumb", "rubric.json"), JSON.stringify(rubric(rules)));
};

describe("#85 a compile outside a repository does not read as a project", () => {
  it("says a directory with no .git is not a repository, even under a marked ancestor", () => {
    home();
    const scratch = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-scratch-"));
    expect(resolveRepoRoot(scratch).repository).toBe(false);
    mkdirSync(path.join(scratch, ".git"));
    expect(resolveRepoRoot(scratch)).toEqual({ root: scratch, repository: true });
  });

  it("still names the nearest marked ancestor as the root, so the report can show where a rubric landed", () => {
    const h = home();
    writeFileSync(path.join(h, "AGENTS.md"), "- rule\n");
    const scratch = path.join(h, "scratch", "task");
    mkdirSync(scratch, { recursive: true });
    expect(resolveRepoRoot(scratch)).toEqual({ root: h, repository: false });
  });

  it("reports a rubric in a non-repository project slot, with the same shape either way", () => {
    const h = home();
    mkdirSync(path.join(h, ".oh-my-plumb"), { recursive: true });
    writeFileSync(path.join(h, ".oh-my-plumb", "rubric.json"), JSON.stringify(rubric([rule("a")])));
    const found = resolveRepoRoot(h);
    const data = collectReport(found.root, found.repository);
    expect(data?.misfiledRubric).toBe(path.join(h, ".oh-my-plumb", "rubric.json"));
    expect(reportJson(data, found.root).misfiledRubric).toBe(data?.misfiledRubric);
    expect(reportJson(undefined, "/nowhere")).toEqual({
      root: "/nowhere",
      rules: [],
      stats: {},
      dead: [],
      middle: [],
      events: [],
      compileNeeded: 0,
      misfiledRubric: null,
      foreignToolRules: 0,
      problems: [],
    });
  });
});

describe("#86 a tool-call rule from another repository does not judge this one", () => {
  // One question each: these must be kept apart, or #87's collapse hides the confinement.
  const foreign = (id: string, sourcePath: string): Rule =>
    rule(id, {
      source: { path: sourcePath, line: 1 },
      check: { type: "model", question: { type: "boolean", instructions: `Did it ${id}?` } },
    });

  it("drops a tool-call rule authored outside this root, and keeps the global and local ones", () => {
    const h = home();
    expect(h).not.toBe("");
    const root = repo();
    writeProject(root, [
      foreign("local-rule", "AGENTS.md"),
      foreign("sibling-rule", "~/Coding/2026/other-repo/AGENTS.md"),
      foreign("elsewhere-rule", "/opt/other/AGENTS.md"),
    ]);
    mkdirSync(path.join(h, ".oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(h, ".oh-my-plumb", "global.json"),
      JSON.stringify(rubric([foreign("home-rule", "~/.claude/CLAUDE.md")])),
    );
    const loaded = loadRubric(root);
    expect(loaded.rules.map((r) => r.id).sort()).toEqual(["home-rule", "local-rule"]);
    expect(loaded.foreignToolRules).toBe(2);
  });

  it("leaves a diff rule from another repository alone: its scope globs match nothing here", () => {
    home();
    const root = repo();
    writeProject(root, [
      rule("foreign-diff", {
        source: { path: "~/Coding/2026/other-repo/AGENTS.md", line: 1 },
        target: "diff",
        scope: ["apps/frontend/**"],
        when: "edit",
      }),
    ]);
    expect(loadRubric(root).rules.map((r) => r.id)).toEqual(["foreign-diff"]);
  });
});

describe("#87 one question is one rule, however many files write it", () => {
  const write = (id: string, source: string, scope?: string[]): Rule =>
    rule(id, {
      source: { path: source, line: 1 },
      scope,
      text: "Make architectural decisions for the long term.",
    });

  it("collapses copies with one question into the first rule and keeps the rest as aliases", () => {
    const merged = mergeRules(
      rubric([write("from-root", "AGENTS.md"), write("from-worktree", "worktree/AGENTS.md")]),
      undefined,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("from-root");
    expect(merged[0]?.aliases).toEqual([
      { id: "from-worktree", path: "worktree/AGENTS.md", line: 1 },
    ]);
  });

  it("keeps rules that ask different questions apart", () => {
    const merged = mergeRules(
      rubric([
        write("root", "AGENTS.md"),
        rule("other", { source: { path: "AGENTS.md", line: 9 }, target: "diff", when: "edit" }),
      ]),
      undefined,
    );
    expect(merged.map((r) => r.id).sort()).toEqual(["other", "root"]);
  });

  it("unions the file scope so a collapsed rule still watches every file its copies did", () => {
    const merged = mergeRules(
      rubric([
        write("front", "AGENTS.md", ["apps/frontend/**"]),
        write("back", "AGENTS.md", ["apps/backend/**"]),
      ]),
      undefined,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.scope).toEqual(["apps/frontend/**", "apps/backend/**"]);
  });

  it("never lets a collapsed alias name a rule that still exists", () => {
    // Aliases are derived at load, not stored, so the guard lives here: a copy
    // that is still its own rule cannot also read as another rule's history.
    const merged = mergeRules(
      rubric([write("kept", "AGENTS.md"), write("taken", "AGENTS.md")]),
      undefined,
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("kept");
    for (const alias of merged[0]?.aliases ?? []) expect(alias.id).not.toBe(merged[0]?.id);
  });
});

describe("#89 report --json keeps one shape", () => {
  it("carries events as a list in both branches and counts them with .length", () => {
    const root = repo();
    writeProject(root, [rule("a")]);
    writeFileSync(
      path.join(root, ".oh-my-plumb", "events.jsonl"),
      `${JSON.stringify({ kind: "skip", at: "t", phase: "edit", reason: "no api key" })}\n`,
    );
    const data = collectReport(root);
    const json = reportJson(data, root);
    expect(Array.isArray(json.events)).toBe(true);
    expect(json.events).toHaveLength(1);
    const empty = reportJson(undefined, root);
    expect(Array.isArray(empty.events)).toBe(true);
    expect(empty.events).toHaveLength(0);
  });
});

describe("#90 compile-needed is counted, not just logged", () => {
  it("counts every session that asked and names the newest reason", () => {
    const root = repo();
    writeProject(root, [rule("a")]);
    const events = [
      { kind: "compile-needed", at: "t1", reason: "project: missing", sources: ["AGENTS.md"] },
      { kind: "compile-needed", at: "t2", reason: "project: stale", sources: ["AGENTS.md"] },
    ];
    writeFileSync(
      path.join(root, ".oh-my-plumb", "events.jsonl"),
      `${events.map((e) => JSON.stringify(e)).join("\n")}\n`,
    );
    expect(readEvents(root)).toHaveLength(2);
    const json = reportJson(collectReport(root), root);
    expect(json.compileNeeded).toBe(2);
    expect(json.events.filter((e) => e.kind === "compile-needed").at(-1)).toMatchObject({
      reason: "project: stale",
    });
  });
});

// A computed specifier keeps tsc out of the extension, which Pi loads as untyped JS.
const extensionSpecifier = (): string => "../pi/oh-my-plumb.ts";

describe("#78 the Pi extension resolves where it is installed", () => {
  it("imports nothing but node builtins, so a host's own module graph cannot fail it", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "..", "pi", "oh-my-plumb.ts"),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from "([^"]+)"/g)].map((m) => m[1]);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s?.startsWith("node:"))).toEqual([]);
  });

  it("recognises a pi packages entry the way the CLI does", async () => {
    const extension = (await import(extensionSpecifier())) as {
      packageInstalled: (host: string, cwd: string) => boolean;
    };
    const h = home();
    const agent = path.join(h, ".pi", "agent");
    mkdirSync(path.join(agent, "npm", "node_modules", "oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(agent, "settings.json"),
      JSON.stringify({ packages: ["npm:other", "npm:oh-my-plumb"] }),
    );
    writeFileSync(
      path.join(agent, "npm", "node_modules", "oh-my-plumb", "package.json"),
      JSON.stringify({ version: "0.3.9" }),
    );
    expect(extension.packageInstalled("pi", path.join(h, "project"))).toBe(true);
    writeFileSync(path.join(agent, "settings.json"), JSON.stringify({ packages: ["npm:other"] }));
    expect(extension.packageInstalled("pi", path.join(h, "project"))).toBe(false);
  });
});

describe("#88 uninstall finds a package install, not only a shim file", () => {
  it("removes the pi package entry the extension is actually loaded from", () => {
    const h = home();
    const agent = path.join(h, ".pi", "agent");
    const target = path.join(agent, "extensions", "oh-my-plumb.ts");
    const settings = path.join(agent, "settings.json");
    mkdirSync(path.dirname(target), { recursive: true });
    mkdirSync(path.join(agent, "npm", "node_modules", "oh-my-plumb"), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({ packages: ["npm:other", "npm:oh-my-plumb"], theme: "dark" }),
    );
    writeFileSync(
      path.join(agent, "npm", "node_modules", "oh-my-plumb", "package.json"),
      JSON.stringify({ version: "0.3.9" }),
    );
    const removed = uninstallHost(
      "pi",
      mkdtempSync(path.join(tmpdir(), "oh-my-plumb-other-")),
      false,
    );
    expect(removed).toEqual({ count: 1, mechanisms: ["package"] });
    expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual({
      packages: ["npm:other"],
      theme: "dark",
    });
    expect(uninstallHost("pi", process.cwd(), false)).toEqual({ count: 0, mechanisms: [] });
  });
});

// The findings on PR #91. Each one is a case the first pass got wrong: the
// uninstall reports success for a write that removes nothing, a "_project_"
// flag crosses scopes, and a prefix match deletes a package nobody asked about.
describe("review findings on the uninstall and merge path", () => {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "bin.js");
  const cliHome = (): string => {
    const dir = home();
    return dir;
  };
  const run = (args: string[], cwd: string, env: string) =>
    spawnSync("node", [cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, OH_MY_PLUMB_HOME_DIR: env, TYPESAFE_AI_API_KEY: "" },
      timeout: 30_000,
    });

  it("removes the omp dependency, not a `packages` key that was never there", () => {
    const h = cliHome();
    const root = repo();
    const plugins = path.join(h, ".omp", "plugins");
    mkdirSync(path.join(plugins, "node_modules", "oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(plugins, "package.json"),
      JSON.stringify({ name: "plugins", dependencies: { "oh-my-plumb": "^0.3.9", left: "1" } }),
    );
    writeFileSync(
      path.join(plugins, "node_modules", "oh-my-plumb", "package.json"),
      JSON.stringify({ version: "0.3.9" }),
    );
    const r = run(["uninstall", "omp"], root, h);
    expect(r.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(plugins, "package.json"), "utf8"))).toEqual({
      name: "plugins",
      dependencies: { left: "1" },
    });
  });

  it("keeps --project off the machine-wide install, and the machine-wide flag off the project", () => {
    const h = cliHome();
    const root = repo();
    const globalSettings = path.join(h, ".pi", "agent", "settings.json");
    const projectSettings = path.join(root, ".pi", "settings.json");
    for (const dir of [
      path.join(h, ".pi", "agent", "npm", "node_modules", "oh-my-plumb"),
      path.join(root, ".pi", "npm", "node_modules", "oh-my-plumb"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.3.9" }));
    }
    const both = JSON.stringify({ packages: ["npm:oh-my-plumb"] });
    writeFileSync(globalSettings, both);
    writeFileSync(projectSettings, both);

    expect(run(["uninstall", "--project", "pi"], root, h).status).toBe(0);
    expect(readFileSync(globalSettings, "utf8")).toBe(both);
    expect(JSON.parse(readFileSync(projectSettings, "utf8")).packages).toEqual([]);

    writeFileSync(projectSettings, both);
    expect(run(["uninstall", "pi"], root, h).status).toBe(0);
    expect(JSON.parse(readFileSync(globalSettings, "utf8")).packages).toEqual([]);
    expect(readFileSync(projectSettings, "utf8")).toBe(both);
  });

  it("removes only the exact package spec, in either entry shape", () => {
    const h = cliHome();
    const root = repo();
    const settings = path.join(h, ".pi", "agent", "settings.json");
    mkdirSync(path.join(h, ".pi", "agent", "npm", "node_modules", "oh-my-plumb"), {
      recursive: true,
    });
    writeFileSync(
      path.join(h, ".pi", "agent", "npm", "node_modules", "oh-my-plumb", "package.json"),
      JSON.stringify({ version: "0.3.9" }),
    );
    const neighbors = ["npm:oh-my-plumb-extra", "npm:oh-my-plumbish", "npm:other"];
    writeFileSync(settings, JSON.stringify({ packages: ["npm:oh-my-plumb", ...neighbors] }));
    expect(run(["uninstall", "pi"], root, h).status).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual(neighbors);

    writeFileSync(
      settings,
      JSON.stringify({
        packages: [{ source: "npm:oh-my-plumb@0.3.9" }, { source: neighbors[0] }, neighbors[2]],
      }),
    );
    expect(run(["uninstall", "pi"], root, h).status).toBe(0);
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual([
      { source: neighbors[0] },
      neighbors[2],
    ]);
  });

  it("compiles only the global rubric when --global is what made it legal", () => {
    const h = cliHome();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-outside-"));
    writeFileSync(path.join(root, "AGENTS.md"), "- never use npx\n");
    const refused = run(["compile"], root, h);
    expect(refused.status).toBe(1);
    expect(refused.stdout + refused.stderr).toContain("not a repository");
    // --global must not smuggle the project target past the guard it exists for.
    const allowed = run(["compile", "--global", "--print"], root, h);
    expect(allowed.status).toBe(0);
    expect(allowed.stdout).not.toContain("Project rubric:");
    expect(allowed.stdout).not.toContain(path.join(root, "AGENTS.md"));
  });

  it("keeps a compile-needed event in a report that has no rules yet", () => {
    home();
    const root = repo();
    writeFileSync(
      path.join(root, ".oh-my-plumb", "events.jsonl"),
      `${JSON.stringify({ kind: "compile-needed", at: "t", reason: "project: missing", sources: ["AGENTS.md"] })}\n`,
    );
    const json = reportJson(collectReport(root), root);
    expect(json.rules).toEqual([]);
    expect(json.compileNeeded).toBe(1);
  });

  it("keeps rules apart when a status or a pattern would change the verdict", () => {
    const question = { type: "boolean" as const, instructions: "Did it?" };
    const base = {
      text: "x",
      source: { path: "AGENTS.md", line: 1 },
      target: "diff" as const,
      when: "edit" as const,
    };
    const active = rule("active-copy", {
      ...base,
      check: { type: "model", question, pattern: "foo" },
    });
    const plain = rule("plain-copy", { ...base, check: { type: "model", question } });
    const off = rule("off-copy", {
      ...base,
      status: "disabled",
      check: { type: "model", question },
    });
    expect(mergeRules(rubric([active, plain]), undefined)).toHaveLength(2);
    expect(mergeRules(rubric([plain, off]), undefined)).toHaveLength(2);
    expect(
      mergeRules(
        rubric([plain, rule("same", { ...base, check: { type: "model", question } })]),
        undefined,
      ),
    ).toHaveLength(1);
  });
});

describe("host settings files are not ours to break", () => {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "bin.js");
  const run = (args: string[], cwd: string, env: string) =>
    spawnSync("node", [cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, OH_MY_PLUMB_HOME_DIR: env, TYPESAFE_AI_API_KEY: "" },
      timeout: 30_000,
    });

  const piInstall = (h: string): void => {
    const dir = path.join(h, ".pi", "agent", "npm", "node_modules", "oh-my-plumb");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ version: "0.3.9" }));
  };

  it("refuses a symlinked settings file rather than rewriting what it points at", () => {
    const h = home();
    piInstall(h);
    const root = repo();
    const elsewhere = path.join(
      mkdtempSync(path.join(tmpdir(), "oh-my-plumb-elsewhere-")),
      "s.json",
    );
    writeFileSync(elsewhere, JSON.stringify({ packages: ["npm:oh-my-plumb"] }));
    mkdirSync(path.join(root, ".pi"), { recursive: true });
    symlinkSync(elsewhere, path.join(root, ".pi", "settings.json"));
    const nodeModules = path.join(root, ".pi", "npm", "node_modules", "oh-my-plumb");
    mkdirSync(nodeModules, { recursive: true });
    writeFileSync(path.join(nodeModules, "package.json"), JSON.stringify({ version: "0.3.9" }));

    expect(run(["uninstall", "--project", "pi"], root, h).status).toBe(0);
    expect(readFileSync(elsewhere, "utf8")).toBe(JSON.stringify({ packages: ["npm:oh-my-plumb"] }));
  });

  it("writes through a rename, so a failed write leaves the file it found", () => {
    const h = home();
    piInstall(h);
    const root = repo();
    const settings = path.join(h, ".pi", "agent", "settings.json");
    writeFileSync(settings, JSON.stringify({ packages: ["npm:oh-my-plumb"] }));
    expect(run(["uninstall", "pi"], root, h).status).toBe(0);
    expect(readdirSync(path.dirname(settings)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual([]);
  });

  it("still removes the package entry when the shim cannot be removed", () => {
    const h = home();
    piInstall(h);
    const root = repo();
    const settings = path.join(h, ".pi", "agent", "settings.json");
    writeFileSync(settings, JSON.stringify({ packages: ["npm:oh-my-plumb"] }));
    const extensions = path.join(h, ".pi", "agent", "extensions");
    mkdirSync(extensions, { recursive: true });
    writeFileSync(path.join(extensions, "oh-my-plumb.ts"), "// oh-my-plumb-pi-extension\n");
    chmodSync(extensions, 0o500);
    try {
      const r = run(["uninstall", "pi"], root, h);
      expect(r.status).toBe(0);
      expect(JSON.parse(readFileSync(settings, "utf8")).packages).toEqual([]);
    } finally {
      chmodSync(extensions, 0o700);
    }
  });
});

describe("a collapsed rule keeps the history of the copies it stands for", () => {
  it("adds an aliased rule's checks to the survivor's count", () => {
    const root = repo();
    const question = { type: "boolean" as const, instructions: "Long term?" };
    const base = {
      text: "Make architectural decisions for the long term.",
      target: "diff" as const,
      when: "edit" as const,
    };
    writeProject(root, [
      rule("survivor", {
        ...base,
        source: { path: "AGENTS.md", line: 1 },
        check: { type: "model", question },
      }),
      rule("folded", {
        ...base,
        source: { path: "worktree/AGENTS.md", line: 1 },
        check: { type: "model", question },
      }),
    ]);
    writeFileSync(
      path.join(root, ".oh-my-plumb", "events.jsonl"),
      [
        {
          kind: "check",
          at: "t1",
          phase: "edit",
          files: ["a.ts"],
          latencyMs: 1,
          blocked: true,
          verdicts: [{ ruleId: "folded", probability: 0.9, band: "act" }],
        },
        {
          kind: "check",
          at: "t2",
          phase: "edit",
          files: ["a.ts"],
          latencyMs: 1,
          blocked: false,
          verdicts: [{ ruleId: "survivor", probability: 0.1, band: "clear" }],
        },
      ]
        .map((e) => JSON.stringify(e))
        .join("\n"),
    );
    const data = collectReport(root);
    expect(data?.rules.map((r) => r.id)).toEqual(["survivor"]);
    expect(data?.stats.get("survivor")).toEqual({ checks: 2, fired: 1, flagged: 0 });
    expect(data?.collapsed[0]?.aliases.map((a) => a.id)).toEqual(["folded"]);
    expect(data?.collapsed[0]?.aliases[0]?.path).toBe("worktree/AGENTS.md");
  });
});

describe("one rubric's problem never blocks the other", () => {
  const cli = path.resolve(import.meta.dirname, "..", "dist", "bin.js");
  const run = (args: string[], cwd: string, env: string) =>
    spawnSync("node", [cli, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, OH_MY_PLUMB_HOME_DIR: env, TYPESAFE_AI_API_KEY: "" },
      timeout: 30_000,
    });

  it("compiles the global rubric even when the project's rubric will not parse", () => {
    const h = home();
    const root = repo();
    writeFileSync(path.join(root, ".oh-my-plumb", "rubric.json"), "{ not json");
    mkdirSync(path.join(h, ".claude"), { recursive: true });
    writeFileSync(path.join(h, ".claude", "CLAUDE.md"), "- prefer rg over grep\n");
    const r = run(["compile", "--global", "--print"], root, h);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("Global rubric:");
    expect(r.stdout).not.toContain("Fix the rubric first");
  });

  it("still refuses a project compile whose own rubric will not parse", () => {
    const h = home();
    const root = repo();
    writeFileSync(path.join(root, "AGENTS.md"), "- never use npx\n");
    writeFileSync(path.join(root, ".oh-my-plumb", "rubric.json"), "{ not json");
    const r = run(["compile", "--print"], root, h);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain("Fix the rubric first");
  });
});
