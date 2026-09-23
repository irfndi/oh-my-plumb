import { describe, expect, it } from "vite-plus/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Rule } from "oh-my-plumb-schema";
import {
  collectToolCallSamples,
  summarizeCalibration,
  type ToolCallJudge,
} from "../src/lib/calibration.js";
import { MAX_CALL_SUMMARY_CHARS } from "../src/lib/constants.js";
import { parseTranscript } from "../src/lib/replay.js";

const t = { act: 0.8, flag: 0.5 };

describe("calibration verdicts", () => {
  it("skips with too few states", () => {
    expect(summarizeCalibration([0.4, 0.5], t).verdict).toBe("skipped");
  });
  it("calls a rule stuck in the middle weak", () => {
    expect(summarizeCalibration([0.38, 0.42, 0.55, 0.47, 0.51, 0.6, 0.35], t).verdict).toBe("weak");
    expect(summarizeCalibration([0.11, 0.31, 0.4, 0.33, 0.28, 0.35], t).verdict).toBe("weak");
  });
  it("keeps a rule that clears confidently and fires once in a while", () => {
    expect(summarizeCalibration([0.05, 0.38, 0.1, 0.72, 0.2, 0.15], t).verdict).toBe("decisive");
  });
  it("calls a rule that fires on most hunks noisy", () => {
    expect(summarizeCalibration([0.9, 0.85, 0.95, 0.2, 0.88, 0.81], t).verdict).toBe("noisy");
  });
  it("calls a rule that leaves the middle decisive, even when it never fires", () => {
    const s = summarizeCalibration([0.05, 0.02, 0.1, 0.03, 0.08, 0.97], t);
    expect(s.verdict).toBe("decisive");
    expect(s.fired).toBe(1);
    expect(s.max).toBe(0.97);
  });
});

/** A transcript whose assistant message calls each input in order: the first as Write, the rest as Bash. */
const transcriptWith = (inputs: readonly Record<string, unknown>[]): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-calibrate-"));
  const file = path.join(dir, "t.jsonl");
  writeFileSync(
    file,
    [
      JSON.stringify({ cwd: dir, type: "user", message: { content: "do the work" } }),
      JSON.stringify({
        type: "assistant",
        message: {
          content: inputs.map((input, i) => ({
            type: "tool_use",
            id: `t${i}`,
            name: i === 0 ? "Write" : "Bash",
            input,
          })),
        },
      }),
    ].join("\n"),
  );
  return file;
};

const callRule: Rule = {
  id: "declare-new-deps",
  text: "Add a dependency only after checking it is already installed",
  source: { path: "AGENTS.md" },
  target: "toolCall",
  when: "edit",
  status: "active",
  check: { type: "model", question: { type: "boolean", instructions: "?" } },
};

/** A judge that scores the rule with the next probability in the list, call by call. */
const judgeWith = (ruleId: string, probabilities: readonly number[]): ToolCallJudge => {
  let seen = 0;
  return async () => {
    const probability = probabilities[Math.min(seen, probabilities.length - 1)] ?? 0;
    seen += 1;
    return [{ ruleId, probability }];
  };
};

const verdictForCalls = async (
  inputs: readonly Record<string, unknown>[],
  probabilities: readonly number[],
) => {
  const { calls } = parseTranscript(transcriptWith(inputs));
  const samples = await collectToolCallSamples(
    calls,
    [callRule],
    judgeWith(callRule.id, probabilities),
    () => {},
  );
  return { calls, verdict: summarizeCalibration(samples.get(callRule.id) ?? [], t).verdict };
};

describe("tool-call calibration from transcripts", () => {
  const bash = (n: number): Record<string, unknown>[] =>
    Array.from({ length: n }, () => ({ command: "pnpm test" }));

  it("scores a tool-call rule against recorded calls, bounded and redacted", async () => {
    const marker = "FILE_BODY_MARKER ".repeat(30);
    const { calls, verdict } = await verdictForCalls(
      [{ file_path: "/r/src/a.ts", content: marker }, ...bash(5)],
      [0.02, 0.95, 0.05, 0.9, 0.1, 0.85],
    );
    expect(calls).toHaveLength(6);
    expect(calls[0]?.tool).toBe("Write");
    expect(calls.every((c) => c.args.length <= MAX_CALL_SUMMARY_CHARS)).toBe(true);
    expect(calls.some((c) => c.args.includes("FILE_BODY_MARKER"))).toBe(false);
    expect(verdict).toBe("decisive");
  });

  it("calls a tool-call rule with middling scores weak", async () => {
    const { verdict } = await verdictForCalls(bash(6), [0.38, 0.42, 0.55, 0.47, 0.51, 0.6]);
    expect(verdict).toBe("weak");
  });

  it("calls a tool-call rule that fires on most calls noisy", async () => {
    const { verdict } = await verdictForCalls(bash(6), [0.9, 0.85, 0.95, 0.82, 0.88, 0.91]);
    expect(verdict).toBe("noisy");
  });

  it("skips a tool-call rule with too few recorded calls", async () => {
    const { calls, verdict } = await verdictForCalls(bash(2), [0.1, 0.9]);
    expect(calls).toHaveLength(2);
    expect(verdict).toBe("skipped");
  });
});
