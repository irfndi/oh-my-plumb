import { describe, expect, it } from "vite-plus/test";
import type { Verdict } from "oh-my-plumb-schema";
import { mergeOutcomes, type CheckOutcome } from "../src/lib/checkRunner.js";

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
