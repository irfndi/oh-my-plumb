import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type * as AiModule from "ai";
import { runEnabled } from "../src/commands/enable.js";
import { handleSessionStart } from "../src/hooks/sessionStart.js";
import { handleStop } from "../src/hooks/stop.js";
import { handleTurnStart } from "../src/hooks/turnStart.js";
import { loadRubric } from "../src/lib/loadRubric.js";
import { globalRubricPath, rubricPath } from "../src/lib/paths.js";

// The judge is the only boundary a test cannot reach; a canned answer keeps this
// file about the switch, and `asked` proves whether the judge was reached at all.
const asked = vi.hoisted(() => ({ count: 0 }));
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiModule>();
  return {
    ...actual,
    experimental_evaluate: async (options: { questions: object }) => {
      asked.count += 1;
      const answers: Record<string, { type: "boolean"; probability: number }> = {};
      for (const id of Object.keys(options.questions))
        answers[id] = { type: "boolean", probability: 0.95 };
      return { answers, usage: { inputTokens: 10, outputTokens: 2 } };
    },
  };
});

const saved = {
  home: process.env.OH_MY_PLUMB_HOME_DIR,
  key: process.env.TYPESAFE_AI_API_KEY,
  gateway: process.env.AI_GATEWAY_API_KEY,
};

const rule = {
  id: "no-interface",
  text: "Use type, never interface.",
  source: { path: "AGENTS.md" },
  scope: ["**/*.ts"],
  when: "edit",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
};

// findRepoRoot walks up to the nearest `.git`, so each fixture must be its own repo.
const projectWith = (rubric: object): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-switch-"));
  execSync("git init -q", { cwd: root });
  writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  writeFileSync(path.join(root, ".oh-my-plumb", "rubric.json"), JSON.stringify(rubric));
  return root;
};

const rubricOf = (root: string | undefined, enabled?: boolean): object => ({
  version: 1,
  compiledAt: "x",
  sources: [{ path: "AGENTS.md" }],
  rules: [rule],
  ...(enabled === undefined ? {} : { enabled }),
  ...(root === undefined ? {} : {}),
});

const quiet = (): void => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
};

beforeEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  process.env.TYPESAFE_AI_API_KEY = "unit-test-key";
  asked.count = 0;
});

afterEach(() => {
  for (const [name, value] of [
    ["OH_MY_PLUMB_HOME_DIR", saved.home],
    ["TYPESAFE_AI_API_KEY", saved.key],
    ["AI_GATEWAY_API_KEY", saved.gateway],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe("the switch, read where every hook reads", () => {
  it("absent means on", () => {
    const loaded = loadRubric(projectWith(rubricOf(undefined)));
    expect(loaded.off).toBeUndefined();
    expect(loaded.rules).toHaveLength(1);
  });

  it("project off stands every rule down", () => {
    const loaded = loadRubric(projectWith(rubricOf(undefined, false)));
    expect(loaded.off).toBe("project");
    expect(loaded.rules).toEqual([]);
  });

  it("project off outranks a global rubric that is on", () => {
    const root = projectWith(rubricOf(undefined, false));
    mkdirSync(path.join(process.env.OH_MY_PLUMB_HOME_DIR ?? "", ".oh-my-plumb"), {
      recursive: true,
    });
    writeFileSync(globalRubricPath(), JSON.stringify(rubricOf(undefined, true)));
    expect(loadRubric(root).off).toBe("project");
    expect(loadRubric(root).rules).toEqual([]);
  });

  it("global off silences a project rubric that says nothing", () => {
    const root = projectWith(rubricOf(undefined));
    mkdirSync(path.join(process.env.OH_MY_PLUMB_HOME_DIR ?? "", ".oh-my-plumb"), {
      recursive: true,
    });
    writeFileSync(globalRubricPath(), JSON.stringify(rubricOf(undefined, false)));
    const loaded = loadRubric(root);
    expect(loaded.off).toBe("global");
    expect(loaded.rules).toEqual([]);
  });
});

describe("disable and enable write the file a person can read", () => {
  it("disable --project sets the flag and keeps the rules", async () => {
    quiet();
    const root = projectWith(rubricOf(undefined));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runEnabled(["--project"], false)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    const written = JSON.parse(readFileSync(rubricPath(root), "utf8"));
    expect(written.enabled).toBe(false);
    expect(written.rules).toHaveLength(1);
  });

  it("enable --project clears it again", async () => {
    quiet();
    const root = projectWith(rubricOf(undefined, false));
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runEnabled(["--project"], true)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    expect(JSON.parse(readFileSync(rubricPath(root), "utf8")).enabled).toBe(true);
    expect(loadRubric(root).rules).toHaveLength(1);
  });

  it("disable with no rubric creates one, so the switch has somewhere to live", async () => {
    quiet();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-bare-"));
    execSync("git init -q", { cwd: root });
    writeFileSync(path.join(root, "AGENTS.md"), "- rule\n");
    const cwd = process.cwd();
    process.chdir(root);
    try {
      expect(await runEnabled(["--project"], false)).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    const written = JSON.parse(readFileSync(rubricPath(root), "utf8"));
    expect(written.enabled).toBe(false);
    expect(written.rules).toEqual([]);
  });

  it("writes the global rubric when --project is absent", async () => {
    quiet();
    projectWith(rubricOf(undefined));
    expect(await runEnabled([], false)).toBe(0);
    expect(JSON.parse(readFileSync(globalRubricPath(), "utf8")).enabled).toBe(false);
  });
});

describe("the hooks honour it", () => {
  const turn = async (root: string): Promise<Awaited<ReturnType<typeof handleStop>>> => {
    const base = { session_id: "s", prompt_id: "p", cwd: root };
    await handleTurnStart({ ...base, hook_event_name: "UserPromptSubmit", prompt: "go" });
    writeFileSync(path.join(root, "a.ts"), "export interface A { a: string }\n");
    return handleStop({ ...base, hook_event_name: "Stop" });
  };

  it("a turn in a switched-off project never reaches the judge", async () => {
    const root = projectWith(rubricOf(undefined));
    mkdirSync(path.join(process.env.OH_MY_PLUMB_HOME_DIR ?? "", ".oh-my-plumb"), {
      recursive: true,
    });
    writeFileSync(globalRubricPath(), JSON.stringify(rubricOf(undefined, false)));
    expect(await turn(root)).toEqual({ kind: "silent" });
    expect(asked.count).toBe(0);
  });

  it("the same turn with the switch on does reach it", async () => {
    const root = projectWith(rubricOf(undefined, true));
    await turn(root);
    expect(asked.count).toBeGreaterThan(0);
  });

  it("session start says the checks are off rather than going quiet", async () => {
    const root = projectWith(rubricOf(undefined, false));
    const out = await handleSessionStart({
      session_id: "s",
      cwd: root,
      hook_event_name: "SessionStart",
    });
    expect(JSON.stringify(out)).toContain("checks are off");
    expect(asked.count).toBe(0);
  });

  it("a switched-off session compiles nothing, because quiet was the request", async () => {
    const root = projectWith(rubricOf(undefined, false));
    const out = await handleSessionStart({
      session_id: "s",
      cwd: root,
      hook_event_name: "SessionStart",
    });
    expect(out.kind).toBe("notice");
  });
});
