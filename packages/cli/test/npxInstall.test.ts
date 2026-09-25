import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { readEvents } from "../src/lib/events.js";
import { OH_MY_PLUMB_HOOK_MARKER, readSettings } from "../src/lib/settings.js";

const cliRoot = path.resolve(import.meta.dirname, "..");

/** A package laid out the way npx leaves it: ~/.npm/_npx/<hash>/node_modules/oh-my-plumb. */
const fakeNpxCache = (): { cache: string; bin: string } => {
  const cache = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-npm-"));
  const nodeModules = path.join(cache, "_npx", "0a1b2c3d", "node_modules");
  const pkg = path.join(nodeModules, "oh-my-plumb");
  for (const entry of ["package.json", "dist", "pi", "opencode", "skills"])
    cpSync(path.join(cliRoot, entry), path.join(pkg, entry), { recursive: true });
  // Dependencies are linked by absolute path, so they outlive the deleted cache as npm's copies would.
  for (const dep of readdirSync(path.join(cliRoot, "node_modules"))) {
    if (dep.startsWith(".")) continue;
    symlinkSync(realpathSync(path.join(cliRoot, "node_modules", dep)), path.join(nodeModules, dep));
  }
  return { cache, bin: path.join(pkg, "dist", "bin.js") };
};

const patternRule = {
  id: "no-loose-interfaces",
  text: "Name every interface for the domain concept it models",
  source: { path: "AGENTS.md" },
  when: "edit",
  check: {
    type: "model",
    question: {
      type: "boolean",
      instructions: "Does this change introduce a loosely-named interface?",
    },
    pattern: "export\\s+interface\\s+\\w+",
  },
};

describe("init run by npx (needs `pnpm build` first)", () => {
  it("leaves every hook working after the npx cache is cleared", () => {
    expect(existsSync(path.join(cliRoot, "dist", "bin.js"))).toBe(true);
    const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-npx-home-"));
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-npx-repo-"));
    writeFileSync(path.join(root, "AGENTS.md"), "- Name every interface\n");
    mkdirSync(path.join(root, ".oh-my-plumb"));
    writeFileSync(
      path.join(root, ".oh-my-plumb", "rubric.json"),
      JSON.stringify({
        version: 1,
        compiledAt: "x",
        sources: [{ path: "AGENTS.md" }],
        rules: [patternRule],
      }),
    );
    const env = {
      ...process.env,
      OH_MY_PLUMB_HOME_DIR: home,
      TYPESAFE_AI_API_KEY: "",
      AI_GATEWAY_API_KEY: "test-key-never-sent",
    };

    const { cache, bin } = fakeNpxCache();
    const init = spawnSync("node", [bin, "init", "claude", "pi", "--project"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(init.stderr).toBe("");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("npx cache");
    rmSync(cache, { recursive: true, force: true });

    const runtime = path.join(home, ".oh-my-plumb", "runtime");
    const command = (
      readSettings(path.join(root, ".claude", "settings.json")).hooks?.PostToolUse ?? []
    )
      .flatMap((group) => group.hooks)
      .find((hook) => hook.command?.includes(OH_MY_PLUMB_HOOK_MARKER))?.command;
    expect(command).toContain(runtime);

    const shim = readFileSync(path.join(root, ".pi", "extensions", "oh-my-plumb.ts"), "utf8");
    const target = /from "(file:[^"]+)"/.exec(shim)?.[1];
    expect(target).toBeDefined();
    expect(existsSync(fileURLToPath(target ?? ""))).toBe(true);
    expect(fileURLToPath(target ?? "")).toContain(runtime);

    const file = path.join(root, "src", "claude.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export interface Greeter {\n  greet(): string;\n}\n");
    const hook = spawnSync(command ?? "", {
      shell: true,
      env: { ...env, AI_GATEWAY_API_KEY: "" },
      encoding: "utf8",
      timeout: 25_000,
      input: JSON.stringify({
        session_id: "npx-e2e",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Edit",
        tool_input: {
          file_path: file,
          old_string: "export type Greeter = string;",
          new_string: "export interface Greeter {\n  greet(): string;\n}",
        },
        tool_use_id: "u1",
      }),
    });
    expect(hook.status).toBe(0);
    expect(hook.stdout).toContain('"decision":"block"');
    expect(readEvents(root).filter((event) => event.kind === "check")).toHaveLength(1);
  }, 90_000);
});
