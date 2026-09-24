import { execSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { MAX_UNKNOWN_PAYLOADS_PER_TURN } from "../src/lib/constants.js";
import { readEvents } from "../src/lib/events.js";

const script = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dist",
  "oh-my-plumb-hook.js",
);
const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));

const run = (name: string, input: string) =>
  spawnSync("node", [script, name], {
    input,
    encoding: "utf8",
    env: {
      ...process.env,
      AI_GATEWAY_API_KEY: "",
      TYPESAFE_AI_API_KEY: "",
      OH_MY_PLUMB_HOME_DIR: home,
    },
    timeout: 25_000,
  });

const rubricWith = (rules: unknown[]): string =>
  JSON.stringify({ version: 1, compiledAt: "x", sources: [{ path: "AGENTS.md" }], rules });

const repoWith = (rules: unknown[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(path.join(root, ".oh-my-plumb", "rubric.json"), rubricWith(rules));
  return root;
};

const toolCallRule = (scope?: string[]) => ({
  id: "no-blind-shell",
  text: "Never run a destructive shell command",
  source: { path: "AGENTS.md" },
  target: "toolCall",
  when: "edit",
  ...(scope === undefined ? {} : { scope }),
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
});

const shellPayload = (cwd: string, tool_name: string, tool_input: unknown) => ({
  session_id: "t",
  cwd,
  hook_event_name: "PostToolUse",
  tool_name,
  tool_input,
  tool_use_id: "b1",
});

const prePayload = (cwd: string, tool_name: string, tool_input: unknown) => ({
  session_id: "t",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name,
  tool_input,
  tool_use_id: "b1",
});

describe("the hook never breaks the agent (needs `pnpm build` first)", () => {
  for (const name of ["session-start", "turn-start", "pre-tool-use", "post-tool-use", "stop"]) {
    it(`${name}: garbage in, exit 0 and nothing on stdout`, () => {
      for (const input of [
        "",
        "not json",
        "{}",
        '{"hook_event_name":"PostToolUse","tool_name":"Bash"}',
      ]) {
        const r = run(name, input);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
      }
    });
  }

  it("post-tool-use without a rubric or key is silent and exits 0", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
    const payload = {
      session_id: "t",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "a.ts"), content: "export interface X {}\n" },
      tool_response: { originalFile: null, structuredPatch: [] },
    };
    const r = run("post-tool-use", JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  it("judges a shell call before it runs, and after it runs only logs it for the turn", () => {
    const root = repoWith([toolCallRule(["Bash"])]);
    const post = run(
      "post-tool-use",
      JSON.stringify(shellPayload(root, "Bash", { command: "rm -rf /" })),
    );
    expect(post.status).toBe(0);
    expect(post.stdout).toBe("");
    // Judged once, before it ran: the post-hook writes no check event of its own.
    expect(existsSync(path.join(root, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  });

  it("pre-tool-use without a key lets the call run and logs the skip", () => {
    const root = repoWith([toolCallRule(["Bash"])]);
    const r = run(
      "pre-tool-use",
      JSON.stringify(prePayload(root, "Bash", { command: "rm -rf /" })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"kind":"skip"');
    expect(events).toContain('"reason":"no api key"');
    expect(events).toContain('"files":["Bash"]');
  });

  it("judges an MCP call under a toolCall rule scoped to mcp__*", () => {
    const root = repoWith([toolCallRule(["mcp__*"])]);
    const r = run(
      "pre-tool-use",
      JSON.stringify(
        prePayload(root, "mcp__puppeteer__screenshot", { url: "https://example.com" }),
      ),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"files":["mcp__puppeteer__screenshot"]');
  });

  it("keeps a malformed edit payload silent even under a tool-call rule with no scope", () => {
    const root = repoWith([toolCallRule()]);
    const r = run(
      "post-tool-use",
      JSON.stringify(shellPayload(root, "Write", { file_path: path.join(root, "a.ts") })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    // Nothing is judged; the payload is only counted, by tool name, as drift.
    expect(readEvents(root).map((e) => e.kind)).toEqual(["unknown_payload"]);
  });

  it("pre-tool-use for an MCP call without a key lets it run and logs the skip", () => {
    const root = repoWith([toolCallRule(["mcp__postgres__*"])]);
    const r = run(
      "pre-tool-use",
      JSON.stringify(prePayload(root, "mcp__postgres__query", { query: "DROP TABLE users" })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"kind":"skip"');
    expect(events).toContain('"reason":"no api key"');
    expect(events).toContain('"files":["mcp__postgres__query"]');
  });

  it("stays silent on a call no rule's scope covers, and a diff rule never sees a call", () => {
    const scoped = repoWith([toolCallRule(["Bash"])]);
    for (const payload of [
      shellPayload(scoped, "mcp__a__b", {}),
      shellPayload(scoped, "Grep", { pattern: "x" }),
      prePayload(scoped, "mcp__a__b", {}),
      prePayload(scoped, "Grep", { pattern: "x" }),
    ]) {
      const r = run(
        payload.hook_event_name === "PreToolUse" ? "pre-tool-use" : "post-tool-use",
        JSON.stringify(payload),
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(existsSync(path.join(scoped, ".oh-my-plumb", "events.jsonl"))).toBe(false);

    const diffRoot = repoWith([
      {
        id: "diff-rule",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    for (const [name, payload] of [
      ["pre-tool-use", prePayload(diffRoot, "Bash", { command: "ls" })],
      ["post-tool-use", shellPayload(diffRoot, "Bash", { command: "ls" })],
    ] as const) {
      const r = run(name, JSON.stringify(payload));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    expect(existsSync(path.join(diffRoot, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  });

  it("rejects malformed and schema-invalid payloads: exit 0, empty stdout, nothing judged", () => {
    const root = repoWith([toolCallRule(["Bash"])]);
    for (const input of [
      "not json",
      JSON.stringify({
        session_id: "t",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
      }),
      JSON.stringify({
        session_id: "t",
        cwd: root,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
      }),
    ]) {
      for (const name of ["pre-tool-use", "post-tool-use"]) {
        const r = run(name, input);
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
      }
    }
    // Only the drift counter writes, and only for payloads that named a tool and a repo.
    expect(readEvents(root).every((e) => e.kind === "unknown_payload")).toBe(true);
  });

  it("a rejected payload lands in the log by name only, and a repeat stops at the cap", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
    const marker = "SECRET-MARKER-DO-NOT-LOG";
    const base = {
      session_id: "u",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "a.ts") },
    };
    // A payload that matches the schema never writes an event, secret or not.
    const valid = { ...base, tool_input: { ...base.tool_input, content: marker } };
    const ok = run("post-tool-use", JSON.stringify(valid));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("");
    expect(existsSync(path.join(root, ".oh-my-plumb", "events.jsonl"))).toBe(false);
    // Rejected the 0.1.0 way (content is not a string): still exit 0 with
    // nothing on stdout, one name-only event per payload until the cap holds.
    const rejected = { ...base, tool_input: { ...base.tool_input, content: { marker } } };
    for (let i = 0; i < MAX_UNKNOWN_PAYLOADS_PER_TURN + 3; i += 1) {
      const r = run("post-tool-use", JSON.stringify(rejected));
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    const raw = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(raw).not.toContain(marker);
    const unknown = readEvents(root).filter((e) => e.kind === "unknown_payload");
    expect(unknown).toHaveLength(MAX_UNKNOWN_PAYLOADS_PER_TURN);
    expect(unknown[0]).toMatchObject({ kind: "unknown_payload", tool: "Write", sessionId: "u" });
  });

  it("a diff that cannot be computed in time is skipped, logged, and never holds the hook", () => {
    const root = repoWith([
      {
        id: "r",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "edit",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    const lines = (prefix: string) =>
      Array.from({ length: 30_000 }, (_, i) => `${prefix}${i} ${Math.random()}`).join("\n");
    const payload = {
      session_id: "t",
      prompt_id: "p",
      cwd: root,
      hook_event_name: "PostToolUse",
      tool_name: "Write",
      tool_input: { file_path: path.join(root, "big.ts"), content: lines("new") },
      tool_response: { originalFile: lines("old"), structuredPatch: [] },
    };
    const started = performance.now();
    const r = run("post-tool-use", JSON.stringify(payload));
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(10_000);
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain("diff too large to compute in time");
  }, 20_000);

  it("turn-start snapshots a git repo and stop then sees a change made by a shell", () => {
    const root = repoWith([
      {
        id: "scope-creep",
        text: "No features beyond what was asked",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    const start = run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    expect(start.status).toBe(0);
    expect(start.stdout).toBe("");
    writeFileSync(path.join(root, "made-by-shell.ts"), "export const x = 1;\n");
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"made-by-shell.ts"');
    expect(events).toContain('"reason":"no api key"');
  });

  it("a turn that only ran tools is still judged by its turn-phase tool-call rules", () => {
    const root = repoWith([
      {
        id: "docs-before-deps",
        text: "Look up library docs before changing a dependency",
        source: { path: "AGENTS.md" },
        target: "toolCall",
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "tools-only", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    const call = run(
      "post-tool-use",
      JSON.stringify({ ...shellPayload(root, "Bash", { command: "pnpm add zod" }), ...base }),
    );
    expect(call.stdout).toBe("");
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"reason":"no api key"');
    expect(events).toContain("the turn's tool calls");
  });

  it("a shell deletion is part of the turn diff", () => {
    const root = repoWith([
      {
        id: "scope-creep",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    writeFileSync(path.join(root, "doomed.ts"), "export const gone = 1;\n");
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    rmSync(path.join(root, "doomed.ts"));
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"doomed.ts"');
  });

  it("a git clean filter that hangs cannot hold turn-start past its budget", () => {
    const root = repoWith([]);
    execSync(
      "git init -q . && git config filter.slow.clean 'sleep 30; cat' && printf '*.ts filter=slow\\n' > .gitattributes && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    writeFileSync(path.join(root, "slow.ts"), "export const slow = 1;\n");
    const started = performance.now();
    const r = run(
      "turn-start",
      JSON.stringify({
        session_id: "slow-filter",
        prompt_id: "p",
        cwd: root,
        hook_event_name: "UserPromptSubmit",
        prompt: "go",
      }),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(8_000);
  }, 15_000);

  it("a turn whose files cannot all be diffed in time is skipped and named, not judged in part", () => {
    const root = repoWith([
      {
        id: "single-use-abstraction",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    const lines = (prefix: string) =>
      Array.from({ length: 30_000 }, (_, i) => `${prefix}${i} ${Math.random()}`).join("\n");
    const base = { session_id: "t", prompt_id: "p", cwd: root };
    // Not a git repository, so Stop takes the per-file path.
    base.session_id = "incomplete-files";
    writeFileSync(path.join(root, "helper.ts"), "export const helper = 1;\n");
    for (const name of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"]) {
      const file = path.join(root, name);
      writeFileSync(file, lines("new"));
      run(
        "post-tool-use",
        JSON.stringify({
          ...base,
          hook_event_name: "PostToolUse",
          tool_name: "Write",
          tool_input: { file_path: file, content: lines("new") },
          tool_response: { originalFile: lines("old"), structuredPatch: [] },
        }),
      );
    }
    run(
      "post-tool-use",
      JSON.stringify({
        ...base,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: {
          file_path: path.join(root, "helper.ts"),
          content: "export const helper = 1;\n",
        },
        tool_response: { originalFile: null, structuredPatch: [] },
      }),
    );
    const started = performance.now();
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    expect(performance.now() - started).toBeLessThan(15_000);
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    const turnEvents = events.filter((e) => e.phase === "turn");
    expect(turnEvents.map((e) => e.kind)).toEqual(["skip"]);
    expect(turnEvents[0].reason).toContain("turn diff incomplete");
    expect(turnEvents[0].files).toContain("a.ts");
  }, 90_000);

  it("a failed turn-start snapshot makes the turn incomplete, for mixed and shell-only turns alike", () => {
    const turnRule = {
      id: "single-use-abstraction",
      text: "t",
      source: { path: "AGENTS.md" },
      when: "turn",
      check: { type: "model", question: { type: "boolean", instructions: "?" } },
    };
    for (const mixed of [true, false]) {
      const root = repoWith([turnRule]);
      execSync(
        "git init -q . && git config filter.bad.clean false && git config filter.bad.required true && printf '*.ts filter=bad\\n' > .gitattributes && git add .gitattributes AGENTS.md .oh-my-plumb && git -c user.email=a@b -c user.name=a commit -q -m init",
        { cwd: root },
      );
      writeFileSync(path.join(root, "seed.ts"), "export const seed = 1;\n");
      const base = {
        session_id: mixed ? "failed-mixed" : "failed-shell-only",
        prompt_id: "p",
        cwd: root,
      };
      const start = run(
        "turn-start",
        JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
      );
      expect(start.status).toBe(0);
      if (mixed) {
        const helper = path.join(root, "helper.ts");
        writeFileSync(helper, "export const helper = 1;\n");
        run(
          "post-tool-use",
          JSON.stringify({
            ...base,
            hook_event_name: "PostToolUse",
            tool_name: "Write",
            tool_input: { file_path: helper, content: "export const helper = 1;\n" },
            tool_response: { originalFile: null, structuredPatch: [] },
          }),
        );
      }
      writeFileSync(path.join(root, "callers.ts"), "import { helper } from './helper';\n");
      const stop = run(
        "stop",
        JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
      );
      expect(stop.status).toBe(0);
      expect(stop.stdout).toBe("");
      const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      const turnEvents = events.filter((e) => e.phase === "turn");
      expect(turnEvents.map((e) => e.kind)).toEqual(["skip"]);
      expect(turnEvents[0].reason).toContain("turn start");
    }
  }, 60_000);

  it("keeps a redacted per-turn tool-call log that stops at the turn boundary", () => {
    const root = repoWith([]);
    const body = `NEW_BODY_MARKER${"n".repeat(30_000)}`;
    const original = `OLD_BODY_MARKER${"o".repeat(30_000)}`;
    const callsDir = (prompt: string): string =>
      path.join(home, ".oh-my-plumb", "sessions", "log-turn", prompt, "tool-calls");
    const readLog = (prompt: string): unknown[] =>
      readdirSync(callsDir(prompt))
        .sort()
        .map((name) => JSON.parse(readFileSync(path.join(callsDir(prompt), name), "utf8")));
    const first = run(
      "post-tool-use",
      JSON.stringify({
        session_id: "log-turn",
        prompt_id: "p1",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Write",
        tool_input: { file_path: path.join(root, "big.ts"), content: body },
        tool_response: {
          filePath: path.join(root, "big.ts"),
          originalFile: original,
          structuredPatch: [],
        },
      }),
    );
    expect(first.status).toBe(0);
    expect(first.stdout).toBe("");
    run(
      "post-tool-use",
      JSON.stringify({
        ...shellPayload(root, "Bash", { command: "ls -la" }),
        session_id: "log-turn",
        prompt_id: "p1",
      }),
    );
    const raw = JSON.stringify(readLog("p1"));
    expect(raw).toContain('"order":1,"name":"Write"');
    expect(raw).toContain(`[${body.length} chars]`);
    expect(raw).not.toContain("NEW_BODY_MARKER");
    expect(raw).not.toContain("OLD_BODY_MARKER");
    expect(raw).toContain('"order":2,"name":"Bash"');

    run(
      "post-tool-use",
      JSON.stringify({
        ...shellPayload(root, "Bash", { command: "pwd" }),
        session_id: "log-turn",
        prompt_id: "p2",
      }),
    );
    expect(JSON.stringify(readLog("p2"))).toBe(
      '[{"order":1,"name":"Bash","summary":"{command=pwd}"}]',
    );
    expect(readLog("p1")).toHaveLength(2);
  });

  it("a corrupt tool-call log degrades: stop exits 0 and still reaches its check", () => {
    const root = repoWith([
      {
        id: "turn-rule",
        text: "t",
        source: { path: "AGENTS.md" },
        when: "turn",
        check: { type: "model", question: { type: "boolean", instructions: "?" } },
      },
    ]);
    execSync(
      "git init -q . && git add -A && git -c user.email=a@b -c user.name=a commit -q -m init",
      { cwd: root },
    );
    const base = { session_id: "stop-corrupt", prompt_id: "p", cwd: root };
    run(
      "turn-start",
      JSON.stringify({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" }),
    );
    const calls = path.join(home, ".oh-my-plumb", "sessions", "stop-corrupt", "p", "tool-calls");
    mkdirSync(calls, { recursive: true });
    writeFileSync(path.join(calls, "call.000001"), "{corrupt");
    writeFileSync(path.join(root, "changed.ts"), "export const x = 1;\n");
    const stop = run(
      "stop",
      JSON.stringify({ ...base, hook_event_name: "Stop", stop_hook_active: false }),
    );
    expect(stop.status).toBe(0);
    expect(stop.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"files":["changed.ts"]');
    // The check ran to its missing key; a throw from the log itself would be CHECK_FAILED.
    expect(events).toContain('"code":"NO_API_KEY"');
    expect(events).not.toContain('"code":"CHECK_FAILED"');
  });

  it("session-start in a repo with an AGENTS.md and no rubric asks for a compile", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
    writeFileSync(path.join(root, "AGENTS.md"), "- Use type, never interface\n");
    const r = run(
      "session-start",
      JSON.stringify({
        session_id: "t",
        cwd: root,
        hook_event_name: "SessionStart",
        source: "startup",
      }),
    );
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(out.hookSpecificOutput.additionalContext).toContain("compile-skill.md");
    expect(out.hookSpecificOutput.additionalContext).toContain("AGENTS.md");
    expect(out.systemMessage).toContain("no API key");
  });
});
