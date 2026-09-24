import { describe, expect, it } from "vite-plus/test";
import type { Rule, Verdict } from "oh-my-plumb-schema";
import {
  mergeOutcomes,
  renderToolInput,
  runTurnToolCallCheck,
  selectTurnToolCallRules,
  stateFor,
  type CheckOutcome,
  type CheckRequest,
} from "../src/lib/checkRunner.js";
import { MAX_STATE_CHARS } from "../src/lib/constants.js";

describe("rendering a tool call's input for the judge", () => {
  it("renders JSON as it is, and cuts past the same bound a diff gets", () => {
    expect(renderToolInput({ tool: "Bash", input: { command: "rtk ls" } })).toBe(
      '{"command":"rtk ls"}',
    );
    expect(renderToolInput({ tool: "Bash" })).toBe("");
    const big = renderToolInput({
      tool: "Write",
      input: { content: "x".repeat(MAX_STATE_CHARS + 10) },
    });
    expect(big.startsWith('{"content":"')).toBe(true);
    expect(big).toContain(`input cut at ${MAX_STATE_CHARS} characters`);
    expect(big.length).toBeLessThan(MAX_STATE_CHARS + 100);
  });
});

describe("handing the judge a turn's state", () => {
  const request = (extra?: Partial<CheckRequest>): CheckRequest => ({
    phase: "turn",
    fileDiffs: [{ file: "a.ts", text: "+x" }],
    rules: [],
    thresholds: { act: 0.8, flag: 0.5 },
    timeoutMs: 1,
    ...extra,
  });

  it("hands a diff rule only the diff: the tool-call log never rides along", () => {
    expect(stateFor(request(), request().fileDiffs)).toEqual({
      files: ["a.ts"],
      diff: "--- a/a.ts\n+++ b/a.ts\n+x",
    });
    expect(stateFor(request({ phase: "edit" }), request().fileDiffs)).toEqual({
      file: "a.ts",
      diff: "+x",
    });
  });
});

describe("turn-phase tool-call rules", () => {
  const rule = (id: string, over: Partial<Rule>): Rule => ({
    id,
    text: "t",
    source: { path: "AGENTS.md" },
    status: "active",
    target: "toolCall",
    when: "turn",
    check: { type: "model", question: { type: "boolean", instructions: "?" } },
    ...over,
  });
  const log = [
    { order: 1, name: "Edit", summary: "{file_path=package.json}" },
    { order: 2, name: "Bash", summary: "{command=pnpm test}" },
  ];

  it("judge the log only: diff rules, edit-phase rules and off-scope rules stay out", () => {
    const rules = [
      rule("uses-context7", {}),
      rule("no-npm", { scope: ["bash"] }),
      rule("mcp-only", { scope: ["mcp__*"] }),
      rule("per-call", { when: "edit" }),
      rule("diff-rule", { target: "diff" }),
      rule("off", { status: "disabled" }),
    ];
    expect(selectTurnToolCallRules(rules, log).map((r) => r.id)).toEqual([
      "uses-context7",
      "no-npm",
    ]);
  });

  it("makes no model call for an empty log", async () => {
    const out = await runTurnToolCallCheck({
      log: [],
      rules: [rule("uses-context7", {})],
      thresholds: { act: 0.8, flag: 0.5 },
      timeoutMs: 1,
    });
    expect(out.calls).toBe(0);
  });
});

const outcome = (verdicts: Verdict[], calls = 1): CheckOutcome => ({
  verdicts,
  modelRules: [],
  calls,
  usage: { inputTokens: 10, costUsd: 0.5 },
  modelLatencyMs: calls * 100,
});

describe("merging the outcomes of several checks", () => {
  it("keeps the loudest verdict per rule, so a file that broke a rule is not hidden by one that kept it", () => {
    const merged = mergeOutcomes([
      outcome([{ ruleId: "r", probability: 0.05, band: "clear" }]),
      outcome([{ ruleId: "r", probability: 0.95, band: "act" }], 2),
      outcome([{ ruleId: "s", probability: 0.6, band: "flag" }]),
    ]);
    expect(merged.verdicts).toEqual([
      { ruleId: "r", probability: 0.95, band: "act" },
      { ruleId: "s", probability: 0.6, band: "flag" },
    ]);
    expect(merged.calls).toBe(4);
    expect(merged.usage).toEqual({ inputTokens: 30, outputTokens: 0, costUsd: 1.5 });
    expect(merged.modelLatencyMs).toBe(200);
  });

  it("merges nothing into an empty outcome", () => {
    expect(mergeOutcomes([])).toEqual({
      verdicts: [],
      modelRules: [],
      calls: 0,
      usage: {},
      modelLatencyMs: 0,
    });
  });
});
