import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createSourceSha, type Rubric } from "oh-my-plumb-schema";
import {
  checkStaleness,
  discoverGlobalSources,
  discoverProjectSources,
  type SourceCandidate,
} from "../src/lib/sources.js";
import { fillSourceShas, mergeRules } from "../src/lib/rubricFile.js";
import { compilePrompt } from "../src/lib/compilePrompt.js";
import { planCompile } from "../src/hooks/sessionStart.js";

const repo = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-"));
  writeFileSync(path.join(root, "AGENTS.md"), "# rules\n- Use type\n");
  mkdirSync(path.join(root, "apps", "web"), { recursive: true });
  writeFileSync(path.join(root, "apps", "web", "CLAUDE.md"), "- web rule\n");
  mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep", "AGENTS.md"), "ignored\n");
  return root;
};

const rubricFor = (root: string): Rubric => ({
  version: 1,
  compiledAt: "x",
  sources: [
    { path: "AGENTS.md", sha: createSourceSha("# rules\n- Use type\n") },
    { path: "apps/web/CLAUDE.md", sha: createSourceSha("- web rule\n") },
  ],
  rules: [],
});

describe("source discovery", () => {
  it("finds root and nested files with scopes and skips node_modules", () => {
    const root = repo();
    const found = discoverProjectSources(root);
    expect(found.map((f) => [f.path, f.scope])).toEqual([
      ["AGENTS.md", "**/*"],
      ["apps/web/CLAUDE.md", "apps/web/**/*"],
    ]);
  });

  it("lists a CLAUDE.md that links to AGENTS.md once, as AGENTS.md", () => {
    const root = repo();
    symlinkSync("AGENTS.md", path.join(root, "CLAUDE.md"));
    expect(discoverProjectSources(root).map((f) => f.path)).toEqual([
      "AGENTS.md",
      "apps/web/CLAUDE.md",
    ]);
  });

  it("detects fresh, changed, new, and missing sources", () => {
    const root = repo();
    const rubric = rubricFor(root);
    expect(checkStaleness(rubric, discoverProjectSources(root), root)).toEqual({ status: "fresh" });
    expect(checkStaleness(undefined, discoverProjectSources(root), root)).toEqual({
      status: "missing",
    });

    writeFileSync(path.join(root, "AGENTS.md"), "# rules\n- Use type\n- New rule\n");
    const changed = checkStaleness(rubric, discoverProjectSources(root), root);
    expect(changed).toMatchObject({ status: "stale", changed: ["AGENTS.md"] });

    writeFileSync(path.join(root, "CLAUDE.md"), "Read ./AGENTS.md\n");
    const added = checkStaleness(rubricFor(root), discoverProjectSources(root), root);
    expect(added).toMatchObject({ status: "stale", added: ["CLAUDE.md"] });

    const unhashed = checkStaleness({ ...rubric, sources: [{ path: "AGENTS.md" }] }, [], root);
    expect(unhashed).toMatchObject({ status: "stale", unhashed: ["AGENTS.md"] });
  });
});

describe("MCP source staleness", () => {
  const captured = (root: string, text: string) => ({
    path: "fakeGuard",
    absolute: path.resolve(root, "fakeGuard"),
    scope: "mcp__fakeGuard__*",
    required: false,
    origin: "mcp" as const,
    text,
  });

  it("stays fresh with no capture and follows the captured hash when one exists", () => {
    const root = repo();
    const base = rubricFor(root);
    const rubric: Rubric = {
      ...base,
      mcpInstructions: ["fakeGuard"],
      sources: [
        ...base.sources,
        {
          path: "fakeGuard",
          kind: "mcp",
          scope: "mcp__fakeGuard__*",
          sha: createSourceSha("first words"),
        },
      ],
    };
    // No capture means nothing to compare against: the check stays quiet.
    expect(checkStaleness(rubric, discoverProjectSources(root), root)).toEqual({
      status: "fresh",
    });
    expect(
      checkStaleness(
        rubric,
        [...discoverProjectSources(root), captured(root, "first words")],
        root,
      ),
    ).toEqual({ status: "fresh" });
    expect(
      checkStaleness(
        rubric,
        [...discoverProjectSources(root), captured(root, "second words")],
        root,
      ),
    ).toMatchObject({ status: "stale", changed: ["fakeGuard"] });
    const neverHashed = checkStaleness(
      {
        ...rubric,
        sources: [...base.sources, { path: "fakeGuard", kind: "mcp", scope: "mcp__fakeGuard__*" }],
      },
      [...discoverProjectSources(root), captured(root, "first words")],
      root,
    );
    expect(neverHashed).toMatchObject({ status: "stale", unhashed: ["fakeGuard"] });
    // Taking the server off the opt-in list leaves its source dead, and that is stale.
    expect(
      checkStaleness({ ...rubric, mcpInstructions: [] }, discoverProjectSources(root), root),
    ).toMatchObject({ status: "stale", removed: ["fakeGuard"] });
    // A file source whose scope merely starts with mcp__ is still a file.
    expect(
      checkStaleness(
        { ...base, sources: [...base.sources, { path: "gone.md", scope: "mcp__x__*" }] },
        discoverProjectSources(root),
        root,
      ),
    ).toMatchObject({ status: "stale", removed: ["gone.md"] });
  });
});

describe("global sources", () => {
  it("accepts home-relative spellings and canonicalizes them to ~/", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      mkdirSync(path.join(home, ".codex"), { recursive: true });
      writeFileSync(path.join(home, ".codex", "AGENTS.md"), "- rule\n");
      const candidates = discoverGlobalSources();
      expect(candidates.map((c) => c.path)).toEqual(["~/.codex/AGENTS.md"]);
      const written: Rubric = {
        version: 1,
        compiledAt: "x",
        sources: [{ path: ".codex/AGENTS.md" }],
        rules: [
          {
            id: "r",
            text: "t",
            source: { path: ".codex/AGENTS.md", line: 1 },
            target: "diff",
            status: "active",
            check: { type: "lint", how: "x" },
          },
        ],
      };
      const { rubric, missing } = fillSourceShas(written, home);
      expect(missing).toEqual([]);
      expect(rubric.sources[0]?.path).toBe("~/.codex/AGENTS.md");
      expect(rubric.rules[0]?.source.path).toBe("~/.codex/AGENTS.md");
      expect(checkStaleness(rubric, candidates, home)).toEqual({ status: "fresh" });
      expect(checkStaleness(written, candidates, home)).toMatchObject({
        status: "stale",
        unhashed: [".codex/AGENTS.md"],
      });
    } finally {
      delete process.env.OH_MY_PLUMB_HOME_DIR;
    }
  });

  it("reads pi's global AGENTS.md and follows imports in the global CLAUDE.md", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
      writeFileSync(path.join(home, ".pi", "agent", "AGENTS.md"), "- pi rule\n");
      mkdirSync(path.join(home, ".claude"), { recursive: true });
      writeFileSync(path.join(home, ".claude", "CLAUDE.md"), "See @notes.md\n");
      writeFileSync(path.join(home, ".claude", "notes.md"), "- note\n");
      const found = discoverGlobalSources();
      expect(found.map((c) => c.path)).toEqual([
        "~/.claude/CLAUDE.md",
        "~/.pi/agent/AGENTS.md",
        "~/.claude/notes.md",
      ]);
      expect(found.find((c) => c.path === "~/.claude/notes.md")).toMatchObject({
        scope: "**/*",
        required: true,
        origin: "global",
      });
    } finally {
      delete process.env.OH_MY_PLUMB_HOME_DIR;
    }
  });
});

describe("merging", () => {
  it("lets the project rubric win on an id clash", () => {
    const mk = (text: string): Rubric => ({
      version: 1,
      compiledAt: "x",
      sources: [],
      rules: [
        {
          id: "same",
          text,
          source: { path: "AGENTS.md" },
          target: "diff",
          status: "active",
          check: { type: "lint", how: "x" },
        },
      ],
    });
    const merged = mergeRules(mk("project"), mk("global"));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ text: "project", origin: "project" });
  });
});

const moreSources = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-"));
  writeFileSync(path.join(root, "GEMINI.md"), "- gemini rule\n");
  writeFileSync(path.join(root, "CLAUDE.local.md"), "- local rule\n");
  writeFileSync(path.join(root, "AGENTS.override.md"), "- override rule\n");
  writeFileSync(path.join(root, ".windsurfrules"), "- windsurf rule\n");
  mkdirSync(path.join(root, ".github"), { recursive: true });
  writeFileSync(path.join(root, ".github", "copilot-instructions.md"), "- copilot rule\n");
  mkdirSync(path.join(root, ".cursor", "rules"), { recursive: true });
  writeFileSync(
    path.join(root, ".cursor", "rules", "scoped.mdc"),
    '---\ndescription: TS only\nglobs: "src/**/*.ts"\n---\n- scoped rule\n',
  );
  writeFileSync(path.join(root, ".cursor", "rules", "plain.mdc"), "- no front matter\n");
  writeFileSync(
    path.join(root, ".cursor", "rules", "broken.mdc"),
    "---\nglobs src/**/*.ts\n---\n- broken front matter\n",
  );
  mkdirSync(path.join(root, "apps", ".cursor", "rules"), { recursive: true });
  writeFileSync(path.join(root, "apps", ".cursor", "rules", "team.mdc"), "- team rule\n");
  mkdirSync(path.join(root, "node_modules", "dep", ".cursor", "rules"), { recursive: true });
  writeFileSync(path.join(root, "node_modules", "dep", ".cursor", "rules", "ignored.mdc"), "x\n");
  writeFileSync(
    path.join(root, ".cursor", "rules", "crlf.mdc"),
    '---\r\nglobs: "lib/**/*.ts"\r\n---\r\n- windows rule\r\n',
  );
  writeFileSync(
    path.join(root, ".cursor", "rules", "unterminated.mdc"),
    "---\nglobs: src/**/*.ts\n- never closed\n",
  );
  writeFileSync(
    path.join(root, ".cursor", "rules", "list.mdc"),
    "---\nglobs: src/**/*.ts, tests/**/*.ts # both\n---\n- two globs\n",
  );
  writeFileSync(
    path.join(root, ".cursor", "rules", "block.mdc"),
    '---\nglobs:\n  - "a/**"\n  - b/**\n---\n- block list\n',
  );
  writeFileSync(path.join(root, ".env"), "SECRET=1\n");
  writeFileSync(path.join(path.dirname(root), "outside-rules.md"), "- outside\n");
  writeFileSync(
    path.join(root, "CLAUDE.md"),
    "Rules live in @docs/more-rules.md and @missing.md. Keys live in @.env, " +
      "shared rules in @../outside-rules.md. See @docs/period.md.\n",
  );
  mkdirSync(path.join(root, "docs"), { recursive: true });
  writeFileSync(path.join(root, "docs", "more-rules.md"), "Back to @../CLAUDE.md\n");
  writeFileSync(path.join(root, "docs", "period.md"), "- ends a sentence\n");
  let deep = root;
  for (let i = 0; i < 7; i += 1) {
    deep = path.join(deep, `d${i}`);
    mkdirSync(deep, { recursive: true });
  }
  mkdirSync(path.join(deep, ".cursor", "rules"), { recursive: true });
  writeFileSync(path.join(deep, ".cursor", "rules", "too-deep.mdc"), "- too deep\n");
  return root;
};

describe("more instruction files", () => {
  it("discovers root tool files, cursor rules, and @path imports", () => {
    const root = moreSources();
    const found = discoverProjectSources(root);
    const mustFind = (p: string): SourceCandidate => {
      const hit = found.find((f) => f.path === p);
      if (hit === undefined) throw new Error(`missing candidate: ${p}`);
      return hit;
    };

    for (const name of ["GEMINI.md", ".windsurfrules", ".github/copilot-instructions.md"]) {
      expect(mustFind(name)).toMatchObject({ scope: "**/*", required: true, origin: "root" });
    }
    // Per-developer files are offered to compile, but a teammate without one is not stale.
    for (const name of ["CLAUDE.local.md", "AGENTS.override.md"]) {
      expect(mustFind(name)).toMatchObject({ scope: "**/*", required: false, origin: "root" });
    }
    expect(mustFind(".cursor/rules/crlf.mdc").scope).toBe("lib/**/*.ts");
    expect(mustFind(".cursor/rules/unterminated.mdc").scope).toBe("**/*");
    expect(mustFind(".cursor/rules/list.mdc").scope).toBe("{src/**/*.ts,tests/**/*.ts}");
    expect(mustFind(".cursor/rules/block.mdc").scope).toBe("{a/**,b/**}");

    expect(mustFind(".cursor/rules/scoped.mdc")).toMatchObject({
      scope: "src/**/*.ts",
      required: true,
      origin: "root",
    });
    expect(mustFind(".cursor/rules/plain.mdc")).toMatchObject({
      scope: "**/*",
      required: true,
      origin: "root",
    });
    expect(mustFind(".cursor/rules/broken.mdc")).toMatchObject({
      scope: "**/*",
      required: true,
      origin: "root",
    });
    expect(mustFind("apps/.cursor/rules/team.mdc")).toMatchObject({
      scope: "apps/**/*",
      required: true,
      origin: "nested",
    });

    expect(found.some((f) => f.path.endsWith("ignored.mdc"))).toBe(false);
    expect(found.some((f) => f.path.endsWith("too-deep.mdc"))).toBe(false);

    // An import is inlined into the file that imports it, so it takes that file's scope.
    expect(mustFind("docs/more-rules.md")).toMatchObject({
      scope: "**/*",
      required: true,
      origin: "root",
    });
    expect(mustFind("docs/period.md").scope).toBe("**/*");
    // Secrets and files outside the repo never become sources.
    expect(found.some((f) => f.path === ".env")).toBe(false);
    expect(found.some((f) => f.path.includes("outside-rules"))).toBe(false);
    expect(found.filter((f) => f.path === "CLAUDE.md")).toHaveLength(1);
    expect(found.some((f) => f.path === "missing.md")).toBe(false);
  });

  it("stays fresh only while the rubric lists the new sources", () => {
    const root = moreSources();
    const found = discoverProjectSources(root);
    const all: Rubric = {
      version: 1,
      compiledAt: "x",
      sources: found.map((f) => ({ path: f.path })),
      rules: [],
    };
    const filled = fillSourceShas(all, root);
    expect(filled.missing).toEqual([]);
    expect(checkStaleness(filled.rubric, found, root)).toEqual({ status: "fresh" });

    const withoutGemini = {
      ...all,
      sources: all.sources.filter((s) => s.path !== "GEMINI.md"),
    };
    const partial = fillSourceShas(withoutGemini, root);
    expect(checkStaleness(partial.rubric, found, root)).toMatchObject({
      status: "stale",
      added: ["GEMINI.md"],
    });
  });
});

describe("skill sources", () => {
  const skillText = "# deploy\n- Run the checksum before installing\n";
  const skillRepo = (): string => {
    const root = repo();
    mkdirSync(path.join(root, "skills", "deploy"), { recursive: true });
    writeFileSync(path.join(root, "skills", "deploy", "SKILL.md"), skillText);
    mkdirSync(path.join(root, ".claude", "skills", "archive"), { recursive: true });
    writeFileSync(path.join(root, ".claude", "skills", "archive", "SKILL.md"), "# archive\n");
    mkdirSync(path.join(root, "skills", "node_modules", "sneaky"), { recursive: true });
    writeFileSync(path.join(root, "skills", "node_modules", "sneaky", "SKILL.md"), "ignored\n");
    // A SKILL.md inside a skill's own folder belongs to that skill, not a second one.
    mkdirSync(path.join(root, "skills", "deploy", "scripts"), { recursive: true });
    writeFileSync(path.join(root, "skills", "deploy", "scripts", "SKILL.md"), "nested\n");
    return root;
  };

  it("finds every SKILL.md under the known skill dirs and skips node_modules", () => {
    const found = discoverProjectSources(skillRepo()).filter((c) => c.origin === "skill");
    expect(found.map((c) => [c.path, c.scope, c.required])).toEqual([
      ["skills/deploy/SKILL.md", "**/*", false],
      [".claude/skills/archive/SKILL.md", "**/*", false],
    ]);
  });

  it("lists the skill source in the compile plan and its prompt", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      const plan = await planCompile(skillRepo());
      const project = plan.targets.find((t) => t.which === "project");
      expect(project?.candidates.some((c) => c.path === "skills/deploy/SKILL.md")).toBe(true);
      expect(compilePrompt("SKILL.md", plan.targets)).toContain("skills/deploy/SKILL.md");
    } finally {
      delete process.env.OH_MY_PLUMB_HOME_DIR;
    }
  });

  it("reports a deleted SKILL.md in staleness instead of passing", () => {
    const root = skillRepo();
    const base = rubricFor(root);
    const rubric: Rubric = {
      ...base,
      sources: [
        ...base.sources,
        { path: "skills/deploy/SKILL.md", sha: createSourceSha(skillText) },
        { path: ".claude/skills/archive/SKILL.md", sha: createSourceSha("# archive\n") },
      ],
    };
    const candidates = discoverProjectSources(root);
    expect(checkStaleness(rubric, candidates, root)).toEqual({ status: "fresh" });
    rmSync(path.join(root, "skills", "deploy", "SKILL.md"));
    expect(checkStaleness(rubric, candidates, root)).toMatchObject({
      status: "stale",
      removed: ["skills/deploy/SKILL.md"],
    });
  });
});

describe("global skill sources", () => {
  it("finds user and installed-plugin skills under home", () => {
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
    process.env.OH_MY_PLUMB_HOME_DIR = home;
    try {
      mkdirSync(path.join(home, ".claude", "skills", "backup"), { recursive: true });
      writeFileSync(path.join(home, ".claude", "skills", "backup", "SKILL.md"), "# backup\n");
      const pluginRoot = path.join(home, ".claude", "plugins", "cache", "m", "foo", "1.0.0");
      mkdirSync(path.join(pluginRoot, "skills", "foo"), { recursive: true });
      writeFileSync(path.join(pluginRoot, "skills", "foo", "SKILL.md"), "# foo\n");
      writeFileSync(
        path.join(home, ".claude", "plugins", "installed_plugins.json"),
        JSON.stringify({
          version: 2,
          plugins: { "foo@m": [{ scope: "user", installPath: pluginRoot }] },
        }),
      );
      const found = discoverGlobalSources().filter((c) => c.origin === "skill");
      expect(found.map((c) => c.path)).toEqual([
        "~/.claude/skills/backup/SKILL.md",
        "~/.claude/plugins/cache/m/foo/1.0.0/skills/foo/SKILL.md",
      ]);
    } finally {
      delete process.env.OH_MY_PLUMB_HOME_DIR;
    }
  });
});
