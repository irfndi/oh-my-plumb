import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { toolCallPostToolUseSchema } from "oh-my-plumb-schema";

// A computed specifier keeps tsc out of the plugin, which OpenCode loads as untyped JS.
const opencodePlugin = "../opencode/oh-my-plumb.mjs";
const { toolCallPayload, toolCallRulesFor, default: plugin } = await import(opencodePlugin);

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
  });

  it("forwards a bash result to the hook, and leaves a tool it never forwards alone", async () => {
    const root = repoWithToolCallRule();
    const api = await plugin({ client: {}, directory: root });
    await api["chat.message"]({ sessionID: "s1" }, { message: { id: "m1" }, parts: [] });
    const events = path.join(root, ".oh-my-plumb", "events.jsonl");

    await api["tool.execute.after"](
      { tool: "bash", sessionID: "s1", callID: "c1", args: { command: "rtk ls" } },
      { output: "" },
    );
    expect(readFileSync(events, "utf8")).toContain('"reason":"no api key"');

    await api["tool.execute.after"](
      { tool: "grep", sessionID: "s1", callID: "c2", args: { pattern: "x" } },
      { output: "" },
    );
    expect(readFileSync(events, "utf8").trim().split("\n")).toHaveLength(1);
    expect(existsSync(path.join(root, ".oh-my-plumb"))).toBe(true);

    // An MCP tool is forwarded like bash: rule scopes decide what it is judged by.
    await api["tool.execute.after"](
      { tool: "postgres_query", sessionID: "s1", callID: "c3", args: { sql: "select 1" } },
      { output: "" },
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
});
