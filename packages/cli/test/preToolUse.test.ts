import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { PlumbEvent } from "oh-my-plumb-schema";
import type * as AiModule from "ai";
import { handlePreToolUse } from "../src/hooks/preToolUse.js";
import { handlePostToolUse } from "../src/hooks/postToolUse.js";
import { readEvents } from "../src/lib/events.js";
import { emit } from "../src/lib/output.js";

// The gateway is the one boundary no offline test can reach, so only its
// answers are stubbed: banding, bands-to-decision and the deny payload all run
// the real code. The key env is set here so the first credential lookup in this
// file sees it — a real key must never be read in a test.
const saved = { typesafe: process.env.TYPESAFE_AI_API_KEY, home: process.env.OH_MY_PLUMB_HOME_DIR };
process.env.TYPESAFE_AI_API_KEY = "unit-test-key";

const model = vi.hoisted((): { answer?: Record<string, unknown>; failure?: Error } => ({}));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    experimental_evaluate: async () => {
      if (model.failure !== undefined) throw model.failure;
      return { answers: model.answer ?? {}, usage: { inputTokens: 12, outputTokens: 4 } };
    },
  };
});

const rule = {
  id: "no-blind-shell",
  text: "Never run a destructive shell command",
  source: { path: "AGENTS.md" },
  target: "toolCall",
  when: "edit",
  scope: ["Bash"],
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
};

const repoWith = (): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".oh-my-plumb"));
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [rule],
    }),
  );
  return root;
};

const payload = (cwd: string) => ({
  session_id: "t",
  cwd,
  hook_event_name: "PreToolUse",
  tool_name: "Bash",
  tool_input: { command: "rm -rf /" },
  tool_use_id: "b1",
});

const violation = (probability: number): void => {
  model.answer = { "no-blind-shell": { type: "boolean", probability } };
};

const checksIn = (root: string): Extract<PlumbEvent, { kind: "check" }>[] =>
  readEvents(root).filter(
    (event): event is Extract<PlumbEvent, { kind: "check" }> => event.kind === "check",
  );

beforeEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  process.env.TYPESAFE_AI_API_KEY = "unit-test-key";
  model.answer = undefined;
  model.failure = undefined;
});

afterEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = saved.home;
  process.env.TYPESAFE_AI_API_KEY = saved.typesafe;
});

describe("blocking a recorded call before it runs", () => {
  it("an act verdict blocks with the rule's name in the reason", async () => {
    violation(0.97);
    const root = repoWith();
    const out = await handlePreToolUse(payload(root));
    expect(out.kind).toBe("block");
    if (out.kind !== "block") return;
    expect(out.reason).toContain('Rule "no-blind-shell"');
    expect(out.reason).toContain("Bash");
    expect(checksIn(root)[0]?.blocked).toBe(true);
  });

  it("a flag lets the call run and carries the note to the user", async () => {
    violation(0.6);
    const root = repoWith();
    const out = await handlePreToolUse(payload(root));
    expect(out.kind).toBe("notice");
    if (out.kind !== "notice") return;
    expect(out.systemMessage).toContain("no-blind-shell");
    expect(checksIn(root)[0]?.blocked).toBe(false);
  });

  it("a clear verdict passes the call silently", async () => {
    violation(0.1);
    const out = await handlePreToolUse(payload(repoWith()));
    expect(out).toEqual({ kind: "silent" });
  });

  it("judges a call once: the pre-hook decides, the post-hook only logs it", async () => {
    violation(0.97);
    const root = repoWith();
    const pre = await handlePreToolUse({ ...payload(root), session_id: "once" });
    expect(pre.kind).toBe("block");
    const checksBefore = readEvents(root).filter((event) => event.kind === "check").length;
    const post = await handlePostToolUse({
      ...payload(root),
      hook_event_name: "PostToolUse",
      session_id: "once",
      tool_response: undefined,
    });
    expect(post).toEqual({ kind: "silent" });
    expect(readEvents(root).filter((event) => event.kind === "check")).toHaveLength(checksBefore);
  });

  it("denies a rule-breaking call every time, never letting a repeat through", async () => {
    violation(0.97);
    const root = repoWith();
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const out = await handlePreToolUse({ ...payload(root), session_id: "repeats" });
      expect(out.kind).toBe("block");
    }
  });

  it("a check that fails lets the call run and logs the error", async () => {
    model.failure = new Error("gateway exploded");
    const root = repoWith();
    const out = await handlePreToolUse(payload(root));
    expect(out).toEqual({ kind: "silent" });
    const events = readEvents(root);
    expect(events.some((event) => event.kind === "error" && event.code === "CHECK_FAILED")).toBe(
      true,
    );
  });

  it("a check that times out lets the call run and logs the timeout", async () => {
    model.failure = Object.assign(new Error("no answer"), { name: "TimeoutError" });
    const root = repoWith();
    const out = await handlePreToolUse(payload(root));
    expect(out).toEqual({ kind: "silent" });
    const events = readEvents(root);
    expect(events.some((event) => event.kind === "error" && event.code === "CHECK_TIMEOUT")).toBe(
      true,
    );
  });
});

describe("what each host is told", () => {
  const captureStdout = (): { written: string[]; restore: () => void } => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    return { written, restore: () => spy.mockRestore() };
  };

  it("a block before a call runs is the deny Claude and Codex read", () => {
    const { written, restore } = captureStdout();
    emit({ kind: "block", reason: "Rule no-blind-shell says no" }, "PreToolUse", () => {});
    restore();
    expect(JSON.parse(written.join(""))).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Rule no-blind-shell says no",
      },
    });
  });

  it("a note before a call runs carries no decision, so the call proceeds", () => {
    const { written, restore } = captureStdout();
    emit(
      { kind: "notice", systemMessage: "uncertain about no-blind-shell" },
      "PreToolUse",
      () => {},
    );
    restore();
    expect(JSON.parse(written.join(""))).toEqual({
      systemMessage: "uncertain about no-blind-shell",
    });
  });

  it("after a call runs the block keeps the shape the post-hook always sent", () => {
    const { written, restore } = captureStdout();
    emit({ kind: "block", reason: "repair this" }, "PostToolUse", () => {});
    restore();
    expect(JSON.parse(written.join(""))).toEqual({ decision: "block", reason: "repair this" });
  });
});
