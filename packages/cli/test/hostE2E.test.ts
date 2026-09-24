import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlumbEvent } from "oh-my-plumb-schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { readEvents } from "../src/lib/events.js";
import { installHost } from "../src/lib/hosts.js";
import { eventsPath } from "../src/lib/paths.js";
import { OH_MY_PLUMB_HOOK_MARKER, readSettings } from "../src/lib/settings.js";

// Computed specifiers keep tsc out of the host modules, which ship as
// untyped JS: Pi loads the extension into its process, OpenCode loads the
// plugin into its server.
const piExtension = "../pi/oh-my-plumb.ts";
const opencodePlugin = "../opencode/oh-my-plumb.mjs";

const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-host-e2e-home-"));

// The hosts run the built hook, so a missing or stale build would test old code and pass.
const cliRoot = path.resolve(import.meta.dirname, "..");
const newestIn = (dir: string): number =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .reduce((newest, e) => Math.max(newest, statSync(path.join(e.parentPath, e.name)).mtimeMs), 0);
beforeAll(() => {
  const hook = path.join(cliRoot, "dist", "oh-my-plumb-hook.js");
  if (!existsSync(hook)) throw new Error("dist/oh-my-plumb-hook.js is missing: run pnpm build");
  if (statSync(hook).mtimeMs < newestIn(path.join(cliRoot, "src")))
    throw new Error("dist is older than src: run pnpm build");
  // The hook imports the schema package's build too, so that one must be fresh as well.
  const schemaRoot = path.resolve(cliRoot, "..", "schema");
  const schemaDist = path.join(schemaRoot, "dist", "index.js");
  if (
    !existsSync(schemaDist) ||
    statSync(schemaDist).mtimeMs < newestIn(path.join(schemaRoot, "src"))
  )
    throw new Error("the schema package's dist is missing or older than its src: run pnpm build");
});

// The Pi and OpenCode children inherit this process's env, so the keys are
// blanked for the whole run: a developer's key must never reach the model in
// a test that promises to run without one.
const savedKeys = {
  gateway: process.env.AI_GATEWAY_API_KEY,
  typesafe: process.env.TYPESAFE_AI_API_KEY,
  homeDir: process.env.OH_MY_PLUMB_HOME_DIR,
};
const restore = (name: string, value: string | undefined): void => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};
beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = "";
  process.env.TYPESAFE_AI_API_KEY = "";
  process.env.OH_MY_PLUMB_HOME_DIR = home;
});
afterEach(() => {
  restore("AI_GATEWAY_API_KEY", savedKeys.gateway);
  restore("TYPESAFE_AI_API_KEY", savedKeys.typesafe);
  restore("OH_MY_PLUMB_HOME_DIR", savedKeys.homeDir);
});

const AFTER = "export interface Greeter {\n  greet(): string;\n}\n";

// One model rule whose pattern matches the added lines, so Tier 1 resolves
// every loaded rule locally: no model call, no network, no key, and the
// check event still lands. Any other model rule would fall through to the
// gateway and log an error event instead.
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

const repoWith = (rules: unknown[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-host-e2e-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- Name every interface\n");
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({ version: 1, compiledAt: "x", sources: [{ path: "AGENTS.md" }], rules }),
  );
  return root;
};

const run = (command: string, input: string) => {
  const r = spawnSync(command, {
    input,
    encoding: "utf8",
    shell: true,
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: "",
      TYPESAFE_AI_API_KEY: "",
      OH_MY_PLUMB_HOME_DIR: home,
    },
    timeout: 25_000,
  });
  // A shell that failed to start or timed out has no status to assert; say which.
  if (r.error !== undefined) throw new Error(`hook command did not run: ${r.error.message}`);
  return r;
};

type CheckEvent = Extract<PlumbEvent, { kind: "check" }>;
const isCheck = (event: PlumbEvent): event is CheckEvent => event.kind === "check";

const checksIn = (root: string): CheckEvent[] => readEvents(root).filter(isCheck);

/** The one check event a host run wrote; silence is the regression this suite exists for, so name it. */
const onlyCheck = (root: string): CheckEvent => {
  const checks = checksIn(root);
  if (checks.length !== 1) throw new Error(`expected one check event, found ${checks.length}`);
  const [check] = checks;
  if (check === undefined) throw new Error("expected one check event, found none");
  return check;
};

/** The PostToolUse command `oh-my-plumb init` wrote for this host. */
const ourCommand = (file: string): string => {
  const entry = (readSettings(file).hooks?.PostToolUse ?? [])
    .flatMap((g) => g.hooks)
    .find((h) => h.command?.includes(OH_MY_PLUMB_HOOK_MARKER));
  if (entry?.command === undefined) throw new Error(`no oh-my-plumb command in ${file}`);
  return entry.command;
};

const expectFastCheck = (check: CheckEvent, file: string): void => {
  expect(check?.files).toEqual([file]);
  expect(check?.verdicts).toEqual([
    {
      ruleId: "no-loose-interfaces",
      probability: 1,
      band: "act",
      answer: `${file}: export interface Greeter {`,
    },
  ]);
  expect(check?.blocked).toBe(true);
  expect(check?.usage).toEqual({});
  expect(check?.modelLatencyMs).toBe(0);
};

describe("one recorded payload per host, end to end (needs `pnpm build` first)", () => {
  it("pi: an edit through the extension checks, and the block reaches Pi", async () => {
    const root = repoWith([patternRule]);
    const file = path.join(root, "src", "pi.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "export type Greeter = string;\n");
    const { default: ohMyPlumb } = await import(piExtension);
    type Handler = (
      event: Record<string, unknown>,
      ctx: Record<string, unknown>,
    ) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    ohMyPlumb({
      on: (name: string, fn: Handler) => {
        handlers.set(name, fn);
      },
      sendUserMessage: () => {},
    });
    const ctx = { cwd: root, sessionManager: { getSessionId: () => "pi-e2e" } };
    await handlers.get("tool_call")?.(
      { toolName: "edit", input: { path: "src/pi.ts" }, toolCallId: "t1" },
      ctx,
    );
    writeFileSync(file, AFTER);
    const out = await handlers.get("tool_result")?.(
      {
        toolName: "edit",
        toolCallId: "t1",
        isError: false,
        content: [{ type: "text", text: "done" }],
      },
      ctx,
    );
    expect(JSON.stringify(out)).toContain("oh-my-plumb:");
    const check = onlyCheck(root);
    expectFastCheck(check, "src/pi.ts");
  }, 30_000);

  it("opencode: a write through the plugin checks with the recorded event shape", async () => {
    const root = repoWith([patternRule]);
    const { default: plugin } = await import(opencodePlugin);
    const hooks = await plugin({ client: {}, directory: root });
    const sessionID = "opencode-e2e";
    await hooks["chat.message"](
      { sessionID },
      { message: { id: "m1" }, parts: [{ type: "text", text: "add a greeter" }] },
    );
    const toolOutput = { metadata: {}, output: "" };
    await hooks["tool.execute.after"](
      {
        tool: "write",
        sessionID,
        callID: "w1",
        args: { filePath: "src/oc.ts", content: AFTER },
      },
      toolOutput,
    );
    expect(toolOutput.output).toContain("oh-my-plumb:");
    const check = onlyCheck(root);
    expectFastCheck(check, "src/oc.ts");
  }, 60_000);

  it("claude: the installed PostToolUse command checks an Edit payload", () => {
    const root = repoWith([patternRule]);
    installHost("claude", root, true);
    const command = ourCommand(path.join(root, ".claude", "settings.json"));
    const file = path.join(root, "src", "claude.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, AFTER);
    const r = run(
      command,
      JSON.stringify({
        session_id: "claude-e2e",
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
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    const check = onlyCheck(root);
    expectFastCheck(check, "src/claude.ts");
  }, 30_000);

  it("codex: the installed hooks.json command checks an apply_patch payload", () => {
    const root = repoWith([patternRule]);
    installHost("codex", root, true);
    const command = ourCommand(path.join(root, ".codex", "hooks.json"));
    const r = run(
      command,
      JSON.stringify({
        session_id: "codex-e2e",
        turn_id: "t1",
        transcript_path: null,
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_input: {
          command: [
            "*** Begin Patch",
            "*** Update File: src/codex.ts",
            "@@",
            " export const keep = 1;",
            "+export interface Greeter {",
            "*** End Patch",
          ].join("\n"),
        },
        tool_use_id: "c1",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('"decision":"block"');
    const check = onlyCheck(root);
    expectFastCheck(check, "src/codex.ts");
  }, 30_000);

  it("silence is explicit: the 0.1.0 payload shape is rejected and logs nothing", () => {
    const root = repoWith([patternRule]);
    installHost("claude", root, true);
    const command = ourCommand(path.join(root, ".claude", "settings.json"));
    // 0.1.0 sent a path with no content. The schema must reject it, and the
    // hook stays silent by design: no event, no stdout, exit 0.
    const r = run(
      command,
      JSON.stringify({
        session_id: "silent-e2e",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: path.join(root, "src", "ghost.ts") },
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(eventsPath(root))).toBe(false);
  }, 30_000);
});
