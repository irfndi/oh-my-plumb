import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as AiModule from "ai";
import type { PlumbEvent } from "oh-my-plumb-schema";
import { handlePostToolUse } from "../src/hooks/postToolUse.js";
import { handleStop } from "../src/hooks/stop.js";
import { handleTurnStart } from "../src/hooks/turnStart.js";
import { readEvents } from "../src/lib/events.js";
import { pruneOldTurns } from "../src/lib/session.js";

/**
 * Issue #79, driven through the Stop hook and the real check pipeline.
 *
 * The rule is the one the issue quoted, compiled as a tool-call rule whose two
 * questions are answered by the hook itself. The model boundary is the only
 * thing stubbed, so "no judgement reached the judge" is something this test
 * can see: `judged` records every state an evaluate call was handed.
 */
const judged = vi.hoisted(() => ({ states: [] as string[], answer: 0.95 }));

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    experimental_evaluate: async (options: { state: unknown; questions: object }) => {
      judged.states.push(JSON.stringify(options.state));
      const answers: Record<string, { type: "boolean"; probability: number }> = {};
      for (const id of Object.keys(options.questions))
        answers[id] = { type: "boolean", probability: judged.answer };
      return { answers, usage: { inputTokens: 10, outputTokens: 2 } };
    },
  };
});

const saved = {
  typesafe: process.env.TYPESAFE_AI_API_KEY,
  home: process.env.OH_MY_PLUMB_HOME_DIR,
};

const FRONTEND_RULE = {
  id: "frontend-lint-format-check",
  text: "Run `bun run check` (effect-tsgo lint + oxfmt) before pushing.",
  source: { path: "apps/frontend/AGENTS.md", line: 80 },
  target: "toolCall",
  scope: ["Bash", "shell"],
  when: "turn",
  check: {
    type: "model",
    question: { type: "boolean", instructions: "Answer only from the turn's tool-call log." },
    precondition: {
      changes: ["apps/frontend/**"],
      ran: { arg: ["command"], pattern: "\\b(bun run check|oxlint|oxfmt)(?:\\s|$)" },
    },
  },
  status: "active",
};

const repo = (rule: object = FRONTEND_RULE): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-79-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  mkdirSync(path.join(root, "apps", "frontend", "src"), { recursive: true });
  mkdirSync(path.join(root, "apps", "backend", "src"), { recursive: true });
  writeFileSync(path.join(root, "apps", "frontend", "src", "App.tsx"), "export const a = 1;\n");
  writeFileSync(path.join(root, "apps", "backend", "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [rule],
    }),
  );
  const git = (cmd: string): void => {
    execSync(cmd, { cwd: root, stdio: "ignore" });
  };
  git("git init -q");
  git("git add -A");
  git("git -c user.email=t@t -c user.name=t commit -qm base");
  return root;
};

let session = 0;

/** One whole turn: the prompt starts it, the calls are logged, the turn ends. */
const runTurn = async (
  root: string,
  options: { write?: string; commands: string[] },
): Promise<{ out: Awaited<ReturnType<typeof handleStop>>; session: string }> => {
  session += 1;
  const id = `s${session}`;
  const base = { session_id: id, prompt_id: `p${session}`, cwd: root };
  await handleTurnStart({ ...base, hook_event_name: "UserPromptSubmit", prompt: "do the task" });
  if (options.write !== undefined) {
    writeFileSync(path.join(root, options.write), "export const a = 2; // edited by this turn\n");
  }
  for (const [index, command] of options.commands.entries()) {
    await handlePostToolUse({
      ...base,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command },
      tool_use_id: `b${index}`,
    });
  }
  const out = await handleStop({ ...base, hook_event_name: "Stop" });
  return { out, session: id };
};

const errorEvents = (root: string): PlumbEvent[] =>
  readEvents(root).filter((event) => event.kind === "error");

beforeEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  process.env.TYPESAFE_AI_API_KEY = "unit-test-key";
  judged.states = [];
  judged.answer = 0.95;
  pruneOldTurns();
});

afterEach(() => {
  for (const [name, value] of [
    ["TYPESAFE_AI_API_KEY", saved.typesafe],
    ["OH_MY_PLUMB_HOME_DIR", saved.home],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("issue #79: a turn that changed nothing in scope", () => {
  it("never reaches the judge, even with the gate run and the rubric active", async () => {
    const root = repo();
    const { out } = await runTurn(root, { commands: ["bun run check"] });
    expect(judged.states).toEqual([]);
    expect(out).toEqual({ kind: "silent" });
    expect(errorEvents(root)).toEqual([]);
  });

  it("never reaches the judge when no gate ran either, because nothing asked for one", async () => {
    const root = repo();
    const { out } = await runTurn(root, { commands: ["git status"] });
    expect(judged.states).toEqual([]);
    expect(out).toEqual({ kind: "silent" });
  });

  it("does not fire on a turn that changed a file outside the rule's globs", async () => {
    const root = repo();
    const { out } = await runTurn(root, {
      write: "apps/backend/src/a.ts",
      commands: [],
    });
    expect(judged.states).toEqual([]);
    expect(out).toEqual({ kind: "silent" });
  });

  // A same-size rewrite inside one second is invisible to git's stat cache, which
  // is what `turnDiff` reads; every edit below therefore changes the file's length.
  it("does clear on the next turn, however much the session edited before", async () => {
    const root = repo();
    // A turn that edited the frontend and ran the gate: settled, never judged.
    const first = await runTurn(root, {
      write: "apps/frontend/src/App.tsx",
      commands: ["bun run check"],
    });
    expect(first.out).toEqual({ kind: "silent" });
    // Two more turns with nothing in scope: neither is judged, and neither warns.
    for (let i = 0; i < 2; i += 1) {
      const { out } = await runTurn(root, { commands: ["git status"] });
      expect(out).toEqual({ kind: "silent" });
    }
    expect(judged.states).toEqual([]);
  });
});

describe("issue #79: a turn that changed a file in scope", () => {
  it("still warns when the gate never ran, without asking a judge at all", async () => {
    const root = repo();
    const { out } = await runTurn(root, { write: "apps/frontend/src/App.tsx", commands: [] });
    // The precondition held (a file changed) and the gate is absent: the hook
    // knows the rule is broken, so no judgement is bought to find it out.

    expect(judged.states).toEqual([]);
    expect(out.kind).not.toBe("silent");
    expect(JSON.stringify(out)).toContain("frontend-lint-format-check");
  });

  it("clears the turn when the gate ran, without asking a judge either", async () => {
    const root = repo();
    const { out } = await runTurn(root, {
      write: "apps/frontend/src/App.tsx",
      commands: ["bun run check"],
    });
    expect(judged.states).toEqual([]);
    expect(out).toEqual({ kind: "silent" });
  });

  it("names the gate it looked for when it fires", async () => {
    const root = repo();
    const { out } = await runTurn(root, { write: "apps/frontend/src/App.tsx", commands: [] });
    expect(JSON.stringify(out)).toContain("bun run check|oxlint|oxfmt");
  });

  it("asks a judge only for the part no test can answer", async () => {
    // Drop the `ran` requirement: what is left is a question only a judge can answer.
    const root = repo({
      ...FRONTEND_RULE,
      check: { ...FRONTEND_RULE.check, precondition: { changes: ["apps/frontend/**"] } },
    });
    await runTurn(root, { write: "apps/frontend/src/App.tsx", commands: ["bun run check"] });
    expect(judged.states).toHaveLength(1);
    expect(judged.states[0] ?? "").toContain("toolCalls");
  });
});
