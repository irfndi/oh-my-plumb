import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  detectHosts,
  installHost,
  installTarget,
  parseHost,
  syncToolCallMatchers,
  uninstallHost,
} from "../src/lib/hosts.js";
import { OPENCODE_PLUGIN_MARKER, opencodeIsV2 } from "../src/lib/opencodePlugin.js";
import { PI_PLUGIN_MARKER } from "../src/lib/piPlugin.js";

let home: string;
let root: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  process.env.OH_MY_PLUMB_HOME_DIR = home;
  process.env.PATH = "/nonexistent";
});

afterEach(() => {
  delete process.env.OH_MY_PLUMB_HOME_DIR;
});

describe("hosts", () => {
  it("names the agents it knows and refuses the rest", () => {
    expect(parseHost("Codex")).toBe("codex");
    expect(() => parseHost("grok")).toThrow(/not one of/);
  });

  it("detects a host by its config directory", () => {
    expect(detectHosts()).toEqual([]);
    mkdirSync(path.join(home, ".codex"));
    mkdirSync(path.join(home, ".config", "opencode"), { recursive: true });
    expect(detectHosts()).toEqual(["codex", "opencode"]);
    mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    expect(detectHosts()).toEqual(["codex", "opencode", "omp"]);
  });

  it("writes Claude and Codex hooks into their own files and removes only its own entries", () => {
    for (const host of ["claude", "codex"] as const) {
      const target = installTarget(host, root, false);
      installHost(host, root, false);
      const json = JSON.parse(readFileSync(target, "utf8"));
      expect(Object.keys(json.hooks).sort()).toEqual([
        "PostToolUse",
        "SessionStart",
        "Stop",
        "UserPromptSubmit",
      ]);
      expect(json.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|apply_patch");
      expect(uninstallHost(host, root, false)).toBe(4);
      expect(uninstallHost(host, root, false)).toBe(0);
    }
    expect(installTarget("codex", root, true)).toBe(path.join(root, ".codex", "hooks.json"));
  });

  it("registers shell and MCP matchers only when the rubric has a toolCall rule", () => {
    // No rubric: today's matcher, nothing shell or MCP in it, and no hook that
    // could stop a call before it runs.
    installHost("claude", root, false);
    const base = JSON.parse(readFileSync(installTarget("claude", root, false), "utf8"));
    expect(base.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|apply_patch");
    expect(base.hooks.PreToolUse).toBeUndefined();
    expect(uninstallHost("claude", root, false)).toBe(4);

    mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rubric.json"),
      JSON.stringify({
        version: 1,
        compiledAt: "x",
        sources: [{ path: "AGENTS.md" }],
        rules: [
          {
            id: "no-blind-shell",
            text: "Never run a destructive shell command",
            source: { path: "AGENTS.md" },
            target: "toolCall",
            when: "edit",
            check: { type: "model", question: { type: "boolean", instructions: "?" } },
          },
        ],
      }),
    );
    installHost("claude", root, false);
    installHost("codex", root, false);
    const claude = JSON.parse(readFileSync(installTarget("claude", root, false), "utf8"));
    const codex = JSON.parse(readFileSync(installTarget("codex", root, false), "utf8"));
    expect(claude.hooks.PostToolUse[0].matcher).toBe(
      "Edit|Write|MultiEdit|apply_patch|Bash|mcp__.*|Skill",
    );
    expect(codex.hooks.PostToolUse[0].matcher).toBe("Edit|Write|MultiEdit|apply_patch|shell");
    expect(claude.hooks.PreToolUse).toHaveLength(1);
    expect(claude.hooks.PreToolUse[0].matcher).toBe("Bash|mcp__.*");
    expect(claude.hooks.PreToolUse[0].hooks[0].command).toContain("pre-tool-use");
    expect(codex.hooks.PreToolUse).toHaveLength(1);
    expect(codex.hooks.PreToolUse[0].matcher).toBe("shell");
    expect(codex.hooks.PreToolUse[0].hooks[0].command).toContain("pre-tool-use");
    expect(uninstallHost("claude", root, false)).toBe(5);
  });

  it("delivers skill loads while the rubric carries a skill's rules", () => {
    mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rubric.json"),
      JSON.stringify({
        version: 1,
        compiledAt: "x",
        sources: [{ path: "skills/deploy/SKILL.md" }],
        rules: [
          {
            id: "checksum-first",
            text: "Run the checksum before installing",
            source: { path: "skills/deploy/SKILL.md" },
            when: "turn",
            check: { type: "model", question: { type: "boolean", instructions: "?" } },
          },
        ],
      }),
    );
    installHost("claude", root, true);
    const settings = JSON.parse(readFileSync(installTarget("claude", root, true), "utf8"));
    expect(settings.hooks.PostToolUse[0].matcher).toContain("|Skill");
  });

  it("keeps a project install's matchers in step with the rubric", () => {
    const rubricFile = path.join(root, ".oh-my-plumb", "rubric.json");
    const rubricWith = (rules: unknown[]): void => {
      mkdirSync(path.dirname(rubricFile), { recursive: true });
      writeFileSync(
        rubricFile,
        JSON.stringify({ version: 1, compiledAt: "x", sources: [{ path: "AGENTS.md" }], rules }),
      );
    };
    const matcher = (): string =>
      JSON.parse(readFileSync(installTarget("claude", root, true), "utf8")).hooks.PostToolUse[0]
        .matcher;
    rubricWith([]);
    installHost("claude", root, true);
    expect(matcher()).toBe("Edit|Write|MultiEdit|apply_patch");
    // A compile adds a tool-call rule; validate's sync turns the shell and MCP matchers on.
    rubricWith([
      {
        id: "no-blind-shell",
        text: "Never run a destructive shell command",
        source: { path: "AGENTS.md" },
        target: "toolCall",
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    expect(syncToolCallMatchers(root)).toEqual(["claude"]);
    expect(matcher()).toBe("Edit|Write|MultiEdit|apply_patch|Bash|mcp__.*|Skill");
    const events = (): string[] =>
      Object.keys(JSON.parse(readFileSync(installTarget("claude", root, true), "utf8")).hooks);
    expect(events()).toContain("PreToolUse");
    rubricWith([]);
    syncToolCallMatchers(root);
    expect(matcher()).toBe("Edit|Write|MultiEdit|apply_patch");
    // With nothing left to judge, the pre-run hook goes too.
    expect(events()).not.toContain("PreToolUse");
  });

  it("installs OpenCode as a plugin file it can recognise, and leaves a stranger's file alone", () => {
    const target = installTarget("opencode", root, false);
    expect(target).toBe(path.join(home, ".config", "opencode", "plugins", "oh-my-plumb.js"));
    installHost("opencode", root, false);
    const text = readFileSync(target, "utf8");
    expect(text).toContain(OPENCODE_PLUGIN_MARKER);
    expect(text).toMatch(/export \{ default \} from "file:\/\/.*opencode\/oh-my-plumb\.mjs"/);
    expect(uninstallHost("opencode", root, false)).toBe(1);
    expect(existsSync(target)).toBe(false);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export default async () => ({});\n");
    expect(uninstallHost("opencode", root, false)).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("installs the v2 module when the version probe reports v2", () => {
    const bin = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-bin-"));
    const fake = path.join(bin, "opencode");
    writeFileSync(fake, "#!/bin/sh\necho 'opencode 2.0.15'\n");
    chmodSync(fake, 0o755);
    const savedPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(opencodeIsV2()).toBe(true);
      const target = installTarget("opencode", root, false);
      installHost("opencode", root, false);
      expect(readFileSync(target, "utf8")).toMatch(
        /export \{ default \} from "file:\/\/.*opencode\/oh-my-plumb-v2\.js"/,
      );
    } finally {
      process.env.PATH = savedPath;
    }
  });

  it("installs Pi as an extension file it can recognise, and leaves a stranger's file alone", () => {
    const target = installTarget("pi", root, false);
    expect(target).toBe(path.join(home, ".pi", "agent", "extensions", "oh-my-plumb.ts"));
    installHost("pi", root, false);
    const text = readFileSync(target, "utf8");
    expect(text).toContain(PI_PLUGIN_MARKER);
    expect(text).toMatch(/import ohMyPlumb from "file:\/\/.*pi\/oh-my-plumb\.ts"/);
    expect(text).toContain('shimFor: "pi"');
    expect(uninstallHost("pi", root, false)).toBe(1);
    expect(existsSync(target)).toBe(false);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, "export default () => ({});\n");
    expect(uninstallHost("pi", root, false)).toBe(0);
    expect(existsSync(target)).toBe(true);
  });

  it("tells a project Pi install that the project must be trusted first", () => {
    const globalInstall = installHost("pi", root, false);
    expect(globalInstall.afterwards).toBeUndefined();
    const projectInstall = installHost("pi", root, true);
    expect(projectInstall.target).toBe(path.join(root, ".pi", "extensions", "oh-my-plumb.ts"));
    expect(projectInstall.afterwards).toContain("accept pi's trust prompt");
    expect(projectInstall.afterwards).toContain("pi --approve");
  });

  it("installs Oh My Pi with the Pi extension under omp's own discovery roots", () => {
    const target = installTarget("omp", root, false);
    expect(target).toBe(path.join(home, ".omp", "agent", "extensions", "oh-my-plumb.ts"));
    expect(installTarget("omp", root, true)).toBe(
      path.join(root, ".omp", "extensions", "oh-my-plumb.ts"),
    );
    installHost("omp", root, false);
    expect(readFileSync(target, "utf8")).toMatch(
      /import ohMyPlumb from "file:\/\/.*pi\/oh-my-plumb\.ts"/,
    );
    expect(readFileSync(target, "utf8")).toContain('shimFor: "omp"');
    expect(readFileSync(target, "utf8")).toContain("oh-my-plumb uninstall omp");
    expect(uninstallHost("omp", root, false)).toBe(1);
    expect(existsSync(target)).toBe(false);
  });

  it("runs exactly one copy whichever of the package and init came first", async () => {
    // The file init writes is what the host loads; handlers it registers are the copy running.
    const handlersFrom = async (file: string): Promise<number> => {
      const { default: extension } = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
      let count = 0;
      extension({ on: () => (count += 1) });
      return count;
    };
    const packaged = path.resolve(import.meta.dirname, "..", "pi", "oh-my-plumb.ts");
    const piSettings = path.join(home, ".pi", "agent", "settings.json");
    const ompManifest = path.join(home, ".omp", "plugins", "package.json");

    // init first, then the package: the file stays but stands down.
    for (const host of ["pi", "omp"] as const) {
      installHost(host, root, false);
      expect(await handlersFrom(installTarget(host, root, false))).toBeGreaterThan(0);
    }
    mkdirSync(path.dirname(piSettings), { recursive: true });
    writeFileSync(piSettings, JSON.stringify({ packages: ["npm:oh-my-plumb@0.1.2"] }));
    mkdirSync(path.dirname(ompManifest), { recursive: true });
    writeFileSync(ompManifest, JSON.stringify({ dependencies: { "oh-my-plumb": "^0.2.0" } }));
    for (const host of ["pi", "omp"] as const)
      expect(await handlersFrom(installTarget(host, root, false))).toBe(0);
    expect(await handlersFrom(packaged)).toBeGreaterThan(0);

    // The package, then init: init removes its old file and says which copy runs.
    mkdirSync(path.join(home, ".pi", "agent", "npm", "node_modules", "oh-my-plumb"), {
      recursive: true,
    });
    writeFileSync(
      path.join(home, ".pi", "agent", "npm", "node_modules", "oh-my-plumb", "package.json"),
      JSON.stringify({ name: "oh-my-plumb", version: "0.1.2" }),
    );
    const pi = installHost("pi", root, false);
    expect(existsSync(installTarget("pi", root, false))).toBe(false);
    expect(pi.target).toBe(piSettings);
    expect(pi.what).toContain("npm:oh-my-plumb@0.1.2, 0.1.2 on disk");
    expect(pi.what).toContain("old extension file was removed");
    expect(pi.afterwards).toContain("`pi install npm:oh-my-plumb` unpins it");
    const omp = installHost("omp", root, false);
    expect(existsSync(installTarget("omp", root, false))).toBe(false);
    expect(omp.what).toContain("oh-my-plumb@^0.2.0");
    expect(omp.afterwards).toBeUndefined();
    // A project install is skipped too: the personal package already loads here.
    installHost("pi", root, true);
    expect(existsSync(installTarget("pi", root, true))).toBe(false);
  });
});
