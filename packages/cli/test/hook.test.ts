import { execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

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

describe("the hook never breaks the agent (needs `pnpm build` first)", () => {
  for (const name of ["session-start", "turn-start", "post-tool-use", "stop"]) {
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

  it("judges a shell call under a toolCall rule scoped to Bash", () => {
    const root = repoWith([toolCallRule(["Bash"])]);
    const r = run(
      "post-tool-use",
      JSON.stringify(shellPayload(root, "Bash", { command: "rm -rf /" })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    const events = readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8");
    expect(events).toContain('"reason":"no api key"');
    expect(events).toContain('"files":["Bash"]');
  });

  it("judges an MCP call under a toolCall rule scoped to mcp__*", () => {
    const root = repoWith([toolCallRule(["mcp__*"])]);
    const r = run(
      "post-tool-use",
      JSON.stringify(
        shellPayload(root, "mcp__puppeteer__screenshot", { url: "https://example.com" }),
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
    expect(existsSync(path.join(root, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  });

  it("stays silent on a call no rule's scope covers, and a diff rule never sees a call", () => {
    const scoped = repoWith([toolCallRule(["Bash"])]);
    for (const payload of [
      shellPayload(scoped, "mcp__a__b", {}),
      shellPayload(scoped, "Grep", { pattern: "x" }),
    ]) {
      const r = run("post-tool-use", JSON.stringify(payload));
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
    const r = run(
      "post-tool-use",
      JSON.stringify(shellPayload(diffRoot, "Bash", { command: "ls" })),
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(existsSync(path.join(diffRoot, ".oh-my-plumb", "events.jsonl"))).toBe(false);
  });

  it("rejects malformed and schema-invalid payloads: exit 0, empty stdout, no event", () => {
    const root = repoWith([toolCallRule(["Bash"])]);
    for (const input of [
      "not json",
      JSON.stringify({
        session_id: "t",
        cwd: root,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
      }),
    ]) {
      const r = run("post-tool-use", input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      expect(existsSync(path.join(root, ".oh-my-plumb", "events.jsonl"))).toBe(false);
    }
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
