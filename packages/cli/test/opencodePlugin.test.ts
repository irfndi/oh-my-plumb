import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { preToolUseInputSchema, toolCallPostToolUseSchema } from "oh-my-plumb-schema";

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
const opencodePlugin = "../opencode/oh-my-plumb.mjs";
const {
  toolCallPayload,
  toolCallRulesFor,
  preToolCallPayload,
  preToolCallResult,
  default: plugin,
} = await import(opencodePlugin);

// The forwarded call runs the real hook child, so the keys are blanked: the
// skip path must be what a machine without a key exercises.
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

const repoWithToolCallRule = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  const source = "- rule\n";
  writeFileSync(path.join(root, "AGENTS.md"), source);
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      // A recorded sha that matches the file keeps session-start from logging a
      // compile-needed event, so this log holds only what the forwarded call wrote.
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

describe("opencode plugin tool calls", () => {
  it("passes the hook schema as a shell call", () => {
    const payload = toolCallPayload({
      tool: "bash",
      args: { command: "rtk ls" },
      sessionID: "s1",
      turnId: "m1",
      directory: "/repo",
      callID: "c1",
    });
    expect(toolCallPostToolUseSchema.parse(payload).tool_name).toBe("bash");
    const pre = preToolCallPayload({
      tool: "bash",
      args: { command: "rm -rf /" },
      sessionID: "s1",
      turnId: "m1",
      directory: "/repo",
      callID: "c1",
    });
    const parsed = preToolUseInputSchema.parse(pre);
    expect(parsed.tool_name).toBe("bash");
    expect(parsed.hook_event_name).toBe("PreToolUse");
  });

  it("reads the hook's answer: a deny stops the call, a note is only shown", () => {
    expect(
      preToolCallResult({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: 'Rule "no-blind-shell" says no',
        },
      }),
    ).toEqual({ block: true, reason: 'Rule "no-blind-shell" says no' });
    expect(preToolCallResult({ systemMessage: "uncertain about no-blind-shell" })).toEqual({
      note: "uncertain about no-blind-shell",
    });
    expect(preToolCallResult(undefined)).toBeUndefined();
  });

  it("judges an MCP tool before it runs, and after a call only logs it", async () => {
    const root = repoWithToolCallRule();
    const api = await plugin({ client: {}, directory: root });
    await api["chat.message"]({ sessionID: "s1" }, { message: { id: "m1" }, parts: [] });
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");

    await api["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "rtk ls" } },
      { output: "" },
    );
    expect(existsSync(events)).toBe(false);

    await api["tool.execute.before"](
      { tool: "postgres_query", sessionID: "s1", callID: "c3" },
      { args: { sql: "select 1" } },
    );
    expect(readFileSync(events, "utf8")).toContain('"files":["postgres_query"]');
  }, 20_000);

  it("forwards tool calls only while a project or global rubric has an active tool-call rule", () => {
    const root = repoWithToolCallRule();
    const nested = path.join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });
    expect(toolCallRulesFor(nested)).toBe(true);
    const rubric = path.join(root, ".oh-my-plumb", "rubric.json");
    const parsed = JSON.parse(readFileSync(rubric, "utf8"));
    writeFileSync(
      rubric,
      JSON.stringify({ ...parsed, rules: [{ ...parsed.rules[0], status: "disabled" }] }),
    );
    expect(toolCallRulesFor(nested)).toBe(false);
    writeFileSync(rubric, JSON.stringify({ ...parsed, rules: [] }));
    expect(toolCallRulesFor(nested)).toBe(false);
    const home = process.env.OH_MY_PLUMB_HOME_DIR ?? "";
    mkdirSync(path.join(home, ".oh-my-plumb"), { recursive: true });
    writeFileSync(path.join(home, ".oh-my-plumb", "global.json"), JSON.stringify(parsed));
    try {
      expect(toolCallRulesFor(nested)).toBe(true);
    } finally {
      rmSync(path.join(home, ".oh-my-plumb", "global.json"));
    }
  });

  it("judges a bash call before it runs, and leaves other tools and rule-less repos alone", async () => {
    const root = repoWithToolCallRule();
    const api = await plugin({ client: {}, directory: root });
    await api["chat.message"]({ sessionID: "s1" }, { message: { id: "m1" }, parts: [] });
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");

    const outcome = await api["tool.execute.before"](
      { tool: "bash", sessionID: "s1", callID: "c1" },
      { args: { command: "rtk ls" } },
    );
    expect(outcome).toBeUndefined();
    expect(readFileSync(events, "utf8")).toContain('"reason":"no api key"');

    await api["tool.execute.before"](
      { tool: "grep", sessionID: "s1", callID: "c2" },
      { args: { pattern: "x" } },
    );
    expect(readFileSync(events, "utf8").trim().split("\n")).toHaveLength(1);

    const bare = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
    const bareApi = await plugin({ client: {}, directory: bare });
    await bareApi["chat.message"]({ sessionID: "s2" }, { message: { id: "m2" }, parts: [] });
    await bareApi["tool.execute.before"](
      { tool: "bash", sessionID: "s2", callID: "c3" },
      { args: { command: "ls" } },
    );
    expect(existsSync(path.join(bare, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  }, 30_000);

  it("stops a bash call when the hook denies it, and only warns when it flags", async () => {
    const root = repoWithToolCallRule();
    const logs: string[] = [];
    const api = await plugin({
      client: {
        app: {
          log: async ({ body }: { body: { message: string } }) => void logs.push(body.message),
        },
      },
      directory: root,
    });
    await api["chat.message"]({ sessionID: "s1" }, { message: { id: "m1" }, parts: [] });
    const before = { tool: "bash", sessionID: "s1", callID: "c9" };

    canned.reply = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          'oh-my-plumb: The call to bash appears to break a rule from this repository\'s instructions.\n- Rule "no-blind-shell" from AGENTS.md: "t". Judged: bad (0.97).',
      },
    });
    await expect(
      api["tool.execute.before"](before, { args: { command: "rm -rf /" } }),
    ).rejects.toThrow("no-blind-shell");

    canned.reply = JSON.stringify({
      systemMessage: "oh-my-plumb: uncertain about no-blind-shell 0.60 on bash (edit).",
    });
    await expect(
      api["tool.execute.before"](before, { args: { command: "ls" } }),
    ).resolves.toBeUndefined();
    expect(logs.some((message) => message.includes("no-blind-shell"))).toBe(true);

    // A child that dies without an answer is a failure, and a failure passes the call through.
    canned.reply = "";
    await expect(
      api["tool.execute.before"](before, { args: { command: "ls" } }),
    ).resolves.toBeUndefined();

    canned.reply = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: 'Rule "no-blind-shell"',
      },
    });
    await expect(
      api["tool.execute.before"]({ tool: "grep", sessionID: "s1", callID: "c10" }, { args: {} }),
    ).resolves.toBeUndefined();
  });
});
