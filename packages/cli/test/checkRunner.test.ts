import { describe, expect, it } from "vite-plus/test";
import type { Verdict } from "oh-my-plumb-schema";
import { mergeOutcomes, renderToolInput, type CheckOutcome } from "../src/lib/checkRunner.js";
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
