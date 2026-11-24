import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
    expect(merged[0]?.aliases).toEqual(["from-worktree"]);
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

  it("refuses a rubric whose alias is also a rule id", () => {
    const parsed = rubricSchema.safeParse({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [{ ...rule("kept"), aliases: ["taken"] }, rule("taken")],
    });
    expect(parsed.success).toBe(false);
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
