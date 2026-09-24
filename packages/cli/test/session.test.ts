import { mkdirSync, mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_STRING_CHARS,
  MAX_TOOL_SUMMARY_CHARS,
} from "../src/lib/constants.js";
import {
  markBaseline,
  readBaselineStatus,
  blockCount,
  callSummary,
  clearTurn,
  hasTurnState,
  incrementBlock,
  incrementStopChecks,
  readBaseline,
  readChecked,
  readFileStarts,
  readToolCalls,
  recordChecked,
  recordFileStart,
  recordToolCall,
  stopCheckCount,
  turnDir,
  writeBaseline,
} from "../src/lib/session.js";

describe("turn state on disk", () => {
  beforeEach(() => {
    process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  });
  afterEach(() => {
    delete process.env.OH_MY_PLUMB_HOME_DIR;
  });

  it("keeps the first record of a file and every file two hooks record in parallel", () => {
    const dir = turnDir("s", "p");
    recordFileStart(dir, "/r/a.ts", "a v1");
    recordFileStart(dir, "/r/b.ts", "b v1");
    recordFileStart(dir, "/r/a.ts", "a v2");
    expect(readFileStarts(dir).sort((x, y) => x.path.localeCompare(y.path))).toEqual([
      { path: "/r/a.ts", original: "a v1" },
      { path: "/r/b.ts", original: "b v1" },
    ]);
    expect(hasTurnState(dir)).toBe(true);
  });

  it("counts blocks and stop checks without a read-modify-write", () => {
    const dir = turnDir("s", "p");
    expect(blockCount(dir, "k")).toBe(0);
    expect(incrementBlock(dir, "k")).toBe(1);
    expect(incrementBlock(dir, "k")).toBe(2);
    expect(blockCount(dir, "k")).toBe(2);
    expect(blockCount(dir, "other")).toBe(0);
    expect(stopCheckCount(dir)).toBe(0);
    incrementStopChecks(dir);
    expect(stopCheckCount(dir)).toBe(1);
  });

  it("keeps a baseline once and clears the turn whole", () => {
    const dir = turnDir("s", "p");
    writeBaseline(dir, "a".repeat(40));
    writeBaseline(dir, "b".repeat(40));
    expect(readBaseline(dir)).toBe("a".repeat(40));
    clearTurn(dir);
    expect(hasTurnState(dir)).toBe(false);
    expect(() => readdirSync(dir)).toThrow();
  });

  it("records the baseline attempt and counts it as turn state", () => {
    const dir = turnDir("s", "p");
    expect(readBaselineStatus(dir)).toBeUndefined();
    markBaseline(dir, "pending");
    expect(readBaselineStatus(dir)).toBe("pending");
    expect(hasTurnState(dir)).toBe(true);
    markBaseline(dir, "failed");
    expect(readBaselineStatus(dir)).toBe("failed");
    markBaseline(dir, "ok");
    expect(readBaselineStatus(dir)).toBe("ok");
  });

  it("keeps every judged edit once", () => {
    const dir = turnDir("s", "p");
    expect(readChecked(dir)).toEqual([]);
    recordChecked(dir, { path: "a.ts", before: null, after: "1" });
    recordChecked(dir, { path: "a.ts", before: "1", after: "2" });
    recordChecked(dir, { path: "a.ts", before: "1", after: "2" });
    expect(readChecked(dir).sort((x, y) => x.after.localeCompare(y.after))).toEqual([
      { path: "a.ts", before: null, after: "1" },
      { path: "a.ts", before: "1", after: "2" },
    ]);
  });

  it("writes its state owner-only, since a snapshot holds whatever the agent edited", () => {
    const dir = turnDir("s", "p");
    recordFileStart(dir, "/r/a.ts", "SECRET=1");
    markBaseline(dir, "ok");
    const mode = (p: string): number => statSync(p).mode & 0o777;
    expect(mode(dir)).toBe(0o700);
    expect(mode(path.join(dir, "files"))).toBe(0o700);
    for (const name of readdirSync(path.join(dir, "files"))) {
      expect(mode(path.join(dir, "files", name))).toBe(0o600);
    }
    expect(mode(path.join(dir, "baseline-status"))).toBe(0o600);
  });

  it("separates prompts and sessions", () => {
    recordFileStart(turnDir("s", "p1"), "/r/a.ts", null);
    expect(readFileStarts(turnDir("s", "p2"))).toEqual([]);
    expect(readFileStarts(turnDir("t", "p1"))).toEqual([]);
  });

  it("logs each call in order with a redacted summary, never file contents", () => {
    const dir = turnDir("s", "log-p1");
    const body = "F".repeat(5_000);
    recordToolCall(dir, "Write", { file_path: "/r/a.ts", content: body, replace_all: false });
    recordToolCall(dir, "Bash", { command: "ls -la" });
    const log = readToolCalls(dir);
    expect(log).toEqual([
      {
        order: 1,
        name: "Write",
        summary: expect.stringContaining("file_path=/r/a.ts"),
      },
      { order: 2, name: "Bash", summary: "{command=ls -la}" },
    ]);
    expect(log[0]?.summary).toContain(`[${body.length} chars]`);
    expect(JSON.stringify(log)).not.toContain(body);
  });

  it("caps the turn's log on disk and as read", () => {
    const dir = turnDir("s", "log-cap");
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 10; i += 1) {
      recordToolCall(dir, "Bash", { command: `c${i}` });
    }
    expect(readToolCalls(dir)).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(readdirSync(path.join(dir, "tool-calls"))).toHaveLength(MAX_TOOL_CALLS_PER_TURN);
    expect(readToolCalls(dir)[0]?.order).toBe(1);
    expect(readToolCalls(dir).at(-1)?.order).toBe(MAX_TOOL_CALLS_PER_TURN);
  });

  it("keeps one turn's log out of the next turn's", () => {
    const first = turnDir("s", "log-rot");
    recordToolCall(first, "Bash", { command: "ls" });
    expect(readToolCalls(turnDir("s", "log-rot2"))).toEqual([]);
    expect(readToolCalls(turnDir("other", "log-rot"))).toEqual([]);
    // A host with no turn id shares one directory; turn-start clears it between turns.
    const shared = turnDir("s", undefined);
    recordToolCall(shared, "Bash", { command: "ls" });
    clearTurn(shared);
    recordToolCall(shared, "Bash", { command: "pwd" });
    expect(readToolCalls(shared).map((e) => e.summary)).toEqual(["{command=pwd}"]);
    expect(readToolCalls(first)).toHaveLength(1);
  });

  it("degrades a missing or corrupt log to no log, never a throw", () => {
    const dir = turnDir("s", "log-corrupt");
    expect(readToolCalls(dir)).toEqual([]);
    const calls = path.join(dir, "tool-calls");
    mkdirSync(calls, { recursive: true });
    writeFileSync(path.join(calls, "call.000001"), "{not json");
    writeFileSync(
      path.join(calls, "call.000002"),
      JSON.stringify({ order: 1, name: "Bash", summary: "x".repeat(MAX_TOOL_SUMMARY_CHARS + 1) }),
    );
    expect(readToolCalls(dir)).toEqual([]);
    // A good entry next to corrupt ones survives.
    writeFileSync(
      path.join(calls, "call.000003"),
      JSON.stringify({ order: 3, name: "Bash", summary: "{command=ls}" }),
    );
    expect(readToolCalls(dir).map((e) => e.order)).toEqual([3]);
  });

  it("collapses strings at the bound and file text at any length", () => {
    expect(callSummary({ command: "x".repeat(MAX_TOOL_STRING_CHARS) })).toBe(
      `{command=${"x".repeat(MAX_TOOL_STRING_CHARS)}}`,
    );
    expect(callSummary({ command: "x".repeat(MAX_TOOL_STRING_CHARS + 1) })).toBe(
      `{command=[${MAX_TOOL_STRING_CHARS + 1} chars]}`,
    );
    // A short .env body is still a file body.
    expect(callSummary({ file_path: ".env", content: "KEY=1" })).toBe(
      "{file_path=.env, content=[5 chars]}",
    );
    expect(callSummary({ edits: [{ oldText: "a", newText: "b" }] })).toBe(
      "{edits=[{oldText=[1 chars], newText=[1 chars]}]}",
    );
    const wide = Object.fromEntries(
      Array.from({ length: 50 }, (_, i) => [`k${i}`, "v".repeat(60)]),
    );
    const long = callSummary(wide);
    expect(long.length).toBe(MAX_TOOL_SUMMARY_CHARS);
    expect(long.endsWith("...")).toBe(true);
  });

  it("logs only the length of an apply_patch, however short", () => {
    const dir = turnDir("s", "patch-log");
    recordToolCall(dir, "apply_patch", { command: "*** Begin Patch\n+KEY=1\n*** End Patch" });
    expect(readToolCalls(dir)[0]?.summary).toMatch(/^\{command=\[\d+ chars\]\}$/);
  });

  it("counts a turn that only ran tools as turn state", () => {
    const dir = turnDir("s", "tools-only");
    expect(hasTurnState(dir)).toBe(false);
    recordToolCall(dir, "Bash", { command: "pnpm test" });
    expect(hasTurnState(dir)).toBe(true);
  });
});
