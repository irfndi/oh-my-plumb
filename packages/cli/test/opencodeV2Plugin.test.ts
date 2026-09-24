/**
 * The v2 plugin against recorded v2 events. Field names were read from
 * anomalyco/opencode at commit 0bc8b8dbeb9540842ae5a69bb5c9af3182999522
 * (packages/plugin/src/promise/tool.ts and session.ts), not from the docs.
 * Every hook runs the real built hook script; only the pre-tool-use answers,
 * which no offline test can reach through the gateway, are canned.
 */
import type * as ChildProcessModule from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PlumbEvent } from "oh-my-plumb-schema";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { readEvents } from "../src/lib/events.js";

// A real model verdict is the only thing that makes the hook deny a call, and no
// offline test can reach the gateway. With a reply set here the hook child is
// swapped for one that only prints that answer; unset, every spawn is the real one.
const canned = vi.hoisted(() => {
  const state: { reply?: string } = {};
  return state;
});
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcessModule>();
  return {
    ...actual,
    spawn: (command: string, args: string[], options: Parameters<typeof actual.spawn>[2]) =>
      canned.reply === undefined
        ? actual.spawn(command, args, options)
        : actual.spawn(
            command,
            ["-e", `process.stdout.write(${JSON.stringify(canned.reply)})`],
            options,
          ),
  };
});

// A computed specifier keeps tsc out of the plugin, which OpenCode loads as untyped JS.
const v2Plugin = "../opencode/oh-my-plumb-v2.js";
const { default: plugin } = await import(v2Plugin);

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
});

const savedKeys = {
  gateway: process.env.AI_GATEWAY_API_KEY,
  typesafe: process.env.TYPESAFE_AI_API_KEY,
  homeDir: process.env.OH_MY_PLUMB_HOME_DIR,
};
beforeEach(() => {
  process.env.AI_GATEWAY_API_KEY = "";
  process.env.TYPESAFE_AI_API_KEY = "";
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
});
afterEach(() => {
  canned.reply = undefined;
  for (const [name, value] of Object.entries(savedKeys)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const AFTER = "export interface Greeter {\n  greet(): string;\n}\n";

// One model rule whose pattern matches the added lines, so Tier 1 resolves
// every loaded rule locally: no model call, no network, no key, and the
// check event still lands. The recorded sha keeps session-start quiet, so the
// turn test sees only the events it is about.
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
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-v2-repo-"));
  const source = "- Name every interface\n";
  writeFileSync(path.join(root, "AGENTS.md"), source);
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md", sha: createHash("sha256").update(source).digest("hex") }],
      rules,
    }),
  );
  return root;
};

const repoWithToolCallRule = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-v2-repo-"));
  const source = "- rule\n";
  writeFileSync(path.join(root, "AGENTS.md"), source);
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md", sha: createHash("sha256").update(source).digest("hex") }],
      rules: [
        {
          id: "no-blind-shell",
          text: "t",
          source: { path: "AGENTS.md" },
          target: "toolCall",
          when: "edit",
          check: { type: "model", question: { type: "boolean", instructions: "?" } },
        },
      ],
    }),
  );
  return root;
};

type Hook = (event: unknown) => Promise<void>;

/** The recorded shape of a primary session request, as `session.hook("context")` receives it. */
const turnRequest = (sessionID: string, messages: unknown[]) => ({
  sessionID,
  model: { providerID: "test", id: "m" },
  system: [],
  messages,
  options: {},
  agent: "build",
  tools: {},
});
const loadPlugin = async (directory: string) => {
  const tool = new Map<string, Hook>();
  const session = new Map<string, Hook>();
  await plugin.setup({
    location: { directory },
    tool: {
      hook: async (name: string, callback: Hook) => {
        tool.set(name, callback);
        return { dispose: () => {} };
      },
    },
    session: {
      hook: async (name: string, callback: Hook) => {
        session.set(name, callback);
        return { dispose: () => {} };
      },
    },
  });
  return { tool, session };
};

type CheckEvent = Extract<PlumbEvent, { kind: "check" }>;
const isCheck = (event: PlumbEvent): event is CheckEvent => event.kind === "check";
const checksIn = (root: string): CheckEvent[] => readEvents(root).filter(isCheck);

/** The index-th check event, or say how many there were instead. */
const checkAt = (checks: readonly CheckEvent[], index: number): CheckEvent => {
  const check = checks[index];
  if (check === undefined)
    throw new Error(`expected a check event at ${index}, found ${checks.length}`);
  return check;
};

const expectFastCheck = (check: CheckEvent, file: string): void => {
  expect(check.files).toEqual([file]);
  expect(check.verdicts).toEqual([
    {
      ruleId: "no-loose-interfaces",
      probability: 1,
      band: "act",
      answer: `${file}: export interface Greeter {`,
    },
  ]);
  expect(check.blocked).toBe(true);
  expect(check.usage).toEqual({});
  expect(check.modelLatencyMs).toBe(0);
};

/** The recorded shape of a successful edit of `src/oc.ts` from BEFORE to AFTER. */
const editEvent = (root: string, sessionID = "v2-edit") => ({
  tool: "edit",
  sessionID,
  agent: "build",
  messageID: "m1",
  id: "c1",
  input: { path: "src/oc.ts", oldString: "export type Greeter = string;", newString: AFTER },
  status: "completed",
  result: {
    content: "Edited src/oc.ts (1 replacement)",
    metadata: {
      files: [
        {
          file: path.join(root, "src", "oc.ts"),
          patch: [
            "--- a/src/oc.ts",
            "+++ b/src/oc.ts",
            "@@ -1,1 +1,3 @@",
            " export type Greeter = string;",
            "+export interface Greeter {",
            "+  greet(): string;",
            "+}",
          ].join("\n"),
          additions: 3,
          deletions: 1,
          status: "modified",
        },
      ],
    },
  },
});

describe("opencode v2 plugin", () => {
  it("is the definition v2's loader reads", () => {
    expect(plugin.id).toBe("oh-my-plumb");
    expect(typeof plugin.setup).toBe("function");
  });

  it("an edit through the plugin checks, and the repair lands in the tool result", async () => {
    const root = repoWith([patternRule]);
    const hooks = await loadPlugin(root);
    const file = path.join(root, "src", "oc.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, AFTER);
    const event = editEvent(root);
    await hooks.tool.get("execute.after")?.(event);
    expect(event.result.content).toContain("oh-my-plumb:");
    expect(event.result.content).toContain("no-loose-interfaces");
    const checks = checksIn(root);
    expect(checks).toHaveLength(1);
    expectFastCheck(checkAt(checks, 0), "src/oc.ts");
  }, 60_000);

  it("a write through the plugin checks with v2's write payload", async () => {
    const root = repoWith([patternRule]);
    const hooks = await loadPlugin(root);
    const file = path.join(root, "src", "oc.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, AFTER);
    const event = {
      tool: "write",
      sessionID: "v2-write",
      agent: "build",
      messageID: "m1",
      id: "c2",
      input: { path: "src/oc.ts", content: AFTER },
      status: "completed",
      result: {
        content: "Wrote file successfully: src/oc.ts",
        output: {
          operation: "write",
          target: path.join(root, "src", "oc.ts"),
          resource: path.join(root, "src", "oc.ts"),
          existed: true,
        },
      },
    };
    await hooks.tool.get("execute.after")?.(event);
    expect(event.result.content).toContain("oh-my-plumb:");
    const checks = checksIn(root);
    expect(checks).toHaveLength(1);
    expectFastCheck(checkAt(checks, 0), "src/oc.ts");
  }, 60_000);

  it("the turn's repair note lands ahead of the next prompt", async () => {
    const root = repoWith([patternRule]);
    const hooks = await loadPlugin(root);
    const home = process.env.OH_MY_PLUMB_HOME_DIR ?? "";
    const messages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
    await hooks.session.get("context")?.(turnRequest("v2-turn", messages));
    expect(messages).toHaveLength(1);
    // The real turn-start ran: the prompt it recorded is on disk for stop to read.
    expect(
      readFileSync(
        path.join(home, ".oh-my-plumb", "sessions", "v2-turn", "turn", "prompt"),
        "utf8",
      ),
    ).toBe("start");

    // A blocking stop, as the script answers when Jev's verdict lands in the act
    // band. No offline test can reach the gateway, so the answer is canned, like
    // the deny's below.
    canned.reply = JSON.stringify({
      decision: "block",
      reason:
        'oh-my-plumb: This turn appears to break a rule from this repository\'s instructions.\n- Rule "no-loose-interfaces" from AGENTS.md: "Name every interface for the domain concept it models".',
    });
    messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    messages.push({ role: "user", content: [{ type: "text", text: "next" }] });
    await hooks.session.get("context")?.(turnRequest("v2-turn", messages));
    canned.reply = undefined;

    expect(messages).toHaveLength(4);
    const followup = messages[2];
    expect(followup?.role).toBe("user");
    expect(JSON.stringify(followup)).toContain("oh-my-plumb:");
    expect(JSON.stringify(followup)).toContain("no-loose-interfaces");
  }, 60_000);

  it("the real turn check runs against the turn's edits, and a miss only logs", async () => {
    const root = repoWith([patternRule]);
    const hooks = await loadPlugin(root);
    const messages = [{ role: "user", content: [{ type: "text", text: "start" }] }];
    await hooks.session.get("context")?.(turnRequest("v2-real", messages));

    const file = path.join(root, "src", "oc.ts");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, AFTER);
    await hooks.tool.get("execute.after")?.(editEvent(root, "v2-real"));

    messages.push({ role: "assistant", content: [{ type: "text", text: "done" }] });
    messages.push({ role: "user", content: [{ type: "text", text: "next" }] });
    await hooks.session.get("context")?.(turnRequest("v2-real", messages));

    // Without a key the turn check logs the miss and passes: no note, no throw.
    expect(messages).toHaveLength(3);
    const skips = readEvents(root).filter(
      (event) => event.kind === "skip" && event.phase === "turn" && event.sessionId === "v2-real",
    );
    expect(skips).toHaveLength(1);
    const checks = checksIn(root);
    expect(checks).toHaveLength(1);
    expectFastCheck(checkAt(checks, 0), "src/oc.ts");
  }, 60_000);

  it("a denied call throws the reason naming the rule; a flag or silence never blocks", async () => {
    const root = repoWithToolCallRule();
    const hooks = await loadPlugin(root);
    const call = {
      tool: "shell",
      sessionID: "s1",
      agent: "build",
      messageID: "m1",
      id: "c1",
      input: { command: "rm -rf /" },
    };
    canned.reply = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          'oh-my-plumb: The call to shell appears to break a rule from this repository\'s instructions.\n- Rule "no-blind-shell" from AGENTS.md: "t". Judged: bad (0.97).',
      },
    });
    await expect(hooks.tool.get("execute.before")?.(call)).rejects.toThrow("no-blind-shell");

    canned.reply = JSON.stringify({
      systemMessage: "oh-my-plumb: uncertain about no-blind-shell 0.60 on shell (toolCall).",
    });
    await expect(hooks.tool.get("execute.before")?.(call)).resolves.toBeUndefined();

    canned.reply = "";
    await expect(hooks.tool.get("execute.before")?.(call)).resolves.toBeUndefined();
  });

  it("an unknown tool, a malformed event and a failed edit all pass without a trace", async () => {
    const root = repoWith([patternRule]);
    const hooks = await loadPlugin(root);
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");
    const result = { content: "kept" };
    await hooks.tool.get("execute.after")?.({
      tool: "read",
      sessionID: "s1",
      id: "c1",
      input: { path: "src/oc.ts" },
      status: "completed",
      result,
    });
    await hooks.tool.get("execute.after")?.({
      tool: "edit",
      sessionID: "s1",
      id: "c2",
      input: {},
      status: "completed",
      result,
    });
    const error = { _tag: "Tool.Error", message: "unchanged" };
    await hooks.tool.get("execute.after")?.({
      tool: "edit",
      sessionID: "s1",
      id: "c3",
      input: { path: "src/oc.ts", oldString: "a", newString: "b" },
      status: "error",
      error,
    });
    await hooks.tool.get("execute.after")?.({
      tool: "shell",
      sessionID: "s1",
      id: "c4",
      input: { command: "ls" },
      status: "completed",
      result,
    });
    expect(result.content).toBe("kept");
    expect(error.message).toBe("unchanged");
    expect(existsSync(events)).toBe(false);
  }, 30_000);

  it("judges a call before it runs, and without a key lets it run and logs the skip", async () => {
    const root = repoWithToolCallRule();
    const hooks = await loadPlugin(root);
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");
    await expect(
      hooks.tool.get("execute.before")?.({
        tool: "shell",
        sessionID: "s1",
        agent: "build",
        messageID: "m1",
        id: "c1",
        input: { command: "ls" },
      }),
    ).resolves.toBeUndefined();
    const log = readFileSync(events, "utf8");
    expect(log).toContain('"kind":"skip"');
    expect(log).toContain('"reason":"no api key"');
  }, 30_000);
});
