import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
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

/**
 * An npx cache laid out the way npm lays one out: a flat `node_modules` where
 * every package's dependencies are siblings, not the deep store pnpm uses. The
 * fixture has to reproduce that, because `init` copies the tree with
 * `dereference: true` and the copy must stand alone: under pnpm, `ai`'s own
 * `@ai-sdk/gateway` lives beside it in the store, so flattening the symlinks
 * alone would drop it and every hook would fail to import `ai`.
 */
const fakeNpxCache = (): { cache: string; bin: string } => {
  const cache = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-npm-"));
  const nodeModules = path.join(cache, "_npx", "0a1b2c3d4e5f6a7b", "node_modules");
  const pkg = path.join(nodeModules, "oh-my-plumb");
  for (const entry of ["package.json", "dist", "pi", "opencode", "skills"])
    cpSync(path.join(cliRoot, entry), path.join(pkg, entry), { recursive: true });
  // pnpm resolves a package's dependencies through its own nested store entry, so
  // each package's real path is the place to look, not one shared sibling list.
  const linked = new Map<string, string>();
  // `store/name` for a plain package, `store/@scope/name` for a scoped one.
  const storeOf = (real: string): string =>
    path.basename(path.dirname(real)).startsWith("@")
      ? path.dirname(path.dirname(real))
      : path.dirname(real);
  const walk = (real: string): void => {
    const store = storeOf(real);
    for (const name of readdirSync(store)) {
      if (name === path.basename(real) || name.startsWith(".")) continue;
      const names =
        name.startsWith("@") && !name.includes("/")
          ? readdirSync(path.join(store, name)).map((scoped) => `${name}/${scoped}`)
          : [name];
      for (const dep of names) {
        if (linked.has(dep)) continue;
        const found = path.join(store, dep);
        if (!existsSync(found)) continue;
        const depReal = realpathSync(found);
        linked.set(dep, depReal);
        walk(depReal);
      }
    }
  };
  // Production dependencies only, then what they need: an npm install never
  // puts a devDependency beside the package, and linking the whole workspace
  // tree here copies 317 MB of typescript and vite-plus into every runtime.
  const dependencies =
    (
      JSON.parse(readFileSync(path.join(cliRoot, "package.json"), "utf8")) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies ?? {};
  for (const name of Object.keys(dependencies)) {
    const real = realpathSync(path.join(cliRoot, "node_modules", name));
    linked.set(name, real);
    walk(real);
  }
  for (const [name, real] of linked) {
    const target = path.join(nodeModules, name);
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(real, target);
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
    // The runtime copy is the whole production closure, dereferenced: tens of
    // seconds on a busy machine, and this test asserts the copy works, not that
    // it is quick.
    const init = spawnSync("node", [bin, "init", "claude", "pi", "--project"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(init.stderr).toBe("");
    expect(init.status).toBe(0);
    expect(init.stdout).toContain("npx cache");

    // A trimmed copy is rebuilt on the next init.
    const copyRoot = path.join(home, ".oh-my-plumb", "runtime");
    const [version] = readdirSync(copyRoot);
    const copiedPkg = path.join(copyRoot, version ?? "", "node_modules", "oh-my-plumb");
    rmSync(path.join(copiedPkg, "dist", "bin.js"));
    rmSync(path.join(copiedPkg, "opencode", "oh-my-plumb.mjs"));
    const repair = spawnSync("node", [bin, "init", "claude", "pi", "--project"], {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 180_000,
    });
    expect(repair.status).toBe(0);
    expect(existsSync(path.join(copiedPkg, "dist", "bin.js"))).toBe(true);
    expect(existsSync(path.join(copiedPkg, "opencode", "oh-my-plumb.mjs"))).toBe(true);
    rmSync(cache, { recursive: true, force: true });

    const runtime = path.join(home, ".oh-my-plumb", "runtime");
    const command = (
      readSettings(path.join(root, ".claude", "settings.json")).hooks?.PostToolUse ?? []
    )
      .flatMap((group) => group.hooks)
      .find((hook) => hook.command?.includes(OH_MY_PLUMB_HOOK_MARKER))?.command;
    expect(command).toContain(runtime);

    // The runtime copy must stand alone: no dependency may reach outside it.
    const copiedModules = path.join(runtime, version ?? "", "node_modules");
    for (const dep of readdirSync(copiedModules)) {
      if (dep.startsWith(".")) continue;
      const packages = dep.startsWith("@")
        ? readdirSync(path.join(copiedModules, dep)).map((name) =>
            path.join(copiedModules, dep, name),
          )
        : [path.join(copiedModules, dep)];
      for (const pkg of packages)
        expect(lstatSync(path.join(pkg, "package.json")).isSymbolicLink()).toBe(false);
    }

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
  }, 420_000);
});
