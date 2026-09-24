import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as ChildProcessModule from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import {
  postToolUseInputSchema,
  preToolUseInputSchema,
  toolCallPostToolUseSchema,
} from "oh-my-plumb-schema";
import { editsFromPostToolUse } from "../src/lib/diff.js";

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

// A computed specifier keeps tsc out of the extension, which Pi loads as untyped JS.
const extension = "../pi/oh-my-plumb.ts";
const { postToolUsePayload, toolCallPayload, preToolCallPayload, preToolCallResult } = await import(
  extension
);

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
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
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

describe("pi extension payload", () => {
  it("passes the hook schema and diffs an edit against the original", () => {
    const payload = postToolUsePayload({
      filePath: "/repo/src/a.ts",
      original: "const a = 1;\n",
      after: "const a = 2;\n",
      sessionId: "s1",
      cwd: "/repo",
      toolCallId: "t1",
    });
    const parsed = postToolUseInputSchema.parse(payload);
    const [edit] = editsFromPostToolUse(parsed);
    expect(edit?.isNewFile).toBe(false);
    expect(edit?.text).toContain("+const a = 2;");
    expect(edit?.text).toContain("-const a = 1;");
  });

  it("treats a missing original as a new file", () => {
    const payload = postToolUsePayload({
      filePath: "/repo/src/b.ts",
      original: null,
      after: "export type B = 1;\n",
      sessionId: "s1",
      cwd: "/repo",
      toolCallId: "t2",
    });
    const [edit] = editsFromPostToolUse(postToolUseInputSchema.parse(payload));
    expect(edit?.isNewFile).toBe(true);
    expect(edit?.text).toContain("+export type B = 1;");
  });

  it("builds shell and extension tool payloads the hook schema accepts", () => {
    for (const tool of ["bash", "greet"]) {
      const payload = toolCallPayload({
        tool,
        input: { command: "ls -la" },
        sessionId: "s1",
        cwd: "/repo",
        toolCallId: "t3",
      });
      expect(toolCallPostToolUseSchema.parse(payload).tool_name).toBe(tool);
    }
  });

  it("builds a pre-call payload the hook schema accepts", () => {
    const payload = preToolCallPayload({
      tool: "bash",
      input: { command: "rm -rf /" },
      sessionId: "s1",
      cwd: "/repo",
      toolCallId: "t4",
    });
    const parsed = preToolUseInputSchema.parse(payload);
    expect(parsed.tool_name).toBe("bash");
    expect(parsed.hook_event_name).toBe("PreToolUse");
  });

  it("reads the hook's answer: a deny blocks, a note is only shown", () => {
    expect(
      preToolCallResult({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: 'Rule "no-blind-shell" says no',
        },
      }),
    ).toEqual({ block: true, reason: 'Rule "no-blind-shell" says no' });
    expect(
      preToolCallResult({
        hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
      }),
    ).toBeUndefined();
    expect(preToolCallResult({ systemMessage: "uncertain about no-blind-shell" })).toEqual({
      note: "uncertain about no-blind-shell",
    });
    expect(preToolCallResult(undefined)).toBeUndefined();
  });
});

describe("pi extension pre-call", () => {
  it("judges a bash call before it runs, and leaves read tools and rule-less repos alone", async () => {
    const { default: ohMyPlumb } = await import(extension);
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    ohMyPlumb({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[name] = handler;
      },
      sendUserMessage: () => {},
    });

    const root = repoWithToolCallRule();
    const ctx = {
      cwd: root,
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: () => {} },
    };
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");

    const blocked = await handlers["tool_call"]?.(
      { toolName: "bash", input: { command: "rtk ls" }, toolCallId: "t1" },
      ctx,
    );
    expect(blocked).toBeUndefined();
    expect(readFileSync(events, "utf8")).toContain('"reason":"no api key"');

    await handlers["tool_call"]?.(
      { toolName: "read", input: { path: "a" }, toolCallId: "t2" },
      ctx,
    );
    expect(readFileSync(events, "utf8").trim().split("\n")).toHaveLength(1);

    const bare = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
    await handlers["tool_call"]?.(
      { toolName: "bash", input: { command: "ls" }, toolCallId: "t3" },
      { cwd: bare, sessionManager: { getSessionId: () => "s2" }, ui: { notify: () => {} } },
    );
    expect(existsSync(path.join(bare, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  }, 30_000);

  it("returns pi's block when the hook denies the call, and only warns when it flags", async () => {
    const { default: ohMyPlumb } = await import(extension);
    const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<unknown>> = {};
    ohMyPlumb({
      on: (name: string, handler: (event: unknown, ctx: unknown) => Promise<unknown>) => {
        handlers[name] = handler;
      },
      sendUserMessage: () => {},
    });
    const notes: string[] = [];
    const ctx = {
      cwd: repoWithToolCallRule(),
      sessionManager: { getSessionId: () => "s1" },
      ui: { notify: (message: string) => void notes.push(message) },
    };
    const call = { toolName: "bash", input: { command: "rm -rf /" }, toolCallId: "t1" };

    canned.reply = JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          'oh-my-plumb: The call to bash appears to break a rule from this repository\'s instructions.\n- Rule "no-blind-shell" from AGENTS.md: "t". Judged: bad (0.97).',
      },
    });
    expect(await handlers["tool_call"]?.(call, ctx)).toEqual({
      block: true,
      reason: expect.stringContaining("no-blind-shell"),
    });
    expect(notes).toHaveLength(0);

    canned.reply = JSON.stringify({
      systemMessage: "oh-my-plumb: uncertain about no-blind-shell 0.60 on bash (edit).",
    });
    expect(await handlers["tool_call"]?.(call, ctx)).toBeUndefined();
    expect(notes.some((note) => note.includes("no-blind-shell"))).toBe(true);

    // A child that dies without an answer is a failure, and a failure passes the call through.
    canned.reply = "";
    expect(await handlers["tool_call"]?.(call, ctx)).toBeUndefined();
    expect(notes).toHaveLength(1);
  });
});

describe("pi extension events", () => {
  it("checks the whole turn once, when pi settles, not after every model round", async () => {
    const { default: ohMyPlumb } = await import(extension);
    const events: string[] = [];
    ohMyPlumb({ on: (name: string) => events.push(name), sendUserMessage: () => {} });
    expect(events).toContain("agent_before_settle");
    expect(events).not.toContain("turn_end");
  });

  it("registers session_stop, the turn check Oh My Pi fires instead of agent_before_settle", async () => {
    const { default: ohMyPlumb } = await import(extension);
    const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
    ohMyPlumb({
      on: (name: string, fn: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, fn),
    });
    expect(handlers.has("session_stop")).toBe(true);
  });
});
