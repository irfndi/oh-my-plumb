import type {
  CalibrationVerdict,
  CheckPhase,
  Rule,
  Thresholds,
  ToolCall,
} from "oh-my-plumb-schema";
import type { ReplayCall } from "./replay.js";
import { median } from "./ui.js";

export const MIN_CALIBRATION_STATES = 5;
/** Below this a "no" is confident. A rule whose median sits above it and whose max never reaches CLEAR_YES is dead. */
const CONFIDENT_NO = 0.25;
const CLEAR_YES = 0.7;
const NOISY_FIRE_RATE = 0.6;

export type CalibrationSummary = {
  hunks: number;
  median: number;
  min: number;
  max: number;
  fired: number;
  verdict: CalibrationVerdict;
};

/** Decisive rules answer near 0 or near 1 on real hunks. Weak ones sit in the middle. Noisy ones fire on most. */
export const summarizeCalibration = (
  probabilities: readonly number[],
  thresholds: Thresholds,
): CalibrationSummary => {
  const n = probabilities.length;
  const med = median(probabilities) ?? 0;
  const min = n === 0 ? 0 : Math.min(...probabilities);
  const max = n === 0 ? 0 : Math.max(...probabilities);
  const fired = probabilities.filter((p) => p >= thresholds.act).length;
  let verdict: CalibrationVerdict;
  if (n < MIN_CALIBRATION_STATES) verdict = "skipped";
  else if (fired / n >= NOISY_FIRE_RATE) verdict = "noisy";
  else if (max < CLEAR_YES && med >= CONFIDENT_NO) verdict = "weak";
  else verdict = "decisive";
  return { hunks: n, median: med, min, max, fired, verdict };
};

/** What a judge scores one rule on one state: the same numbers a hunk contributes. */
export type RuleProbability = { ruleId: string; probability: number };

export type ToolCallJudge = (
  call: ToolCall,
  phase: CheckPhase,
) => Promise<readonly RuleProbability[]>;

/** The phases a recorded call may be judged under: the "when" every model rule carries. */
const CALL_PHASES: readonly CheckPhase[] = ["edit", "turn"];

/**
 * One sample per rule per recorded call, the tool-call twin of calibrate's hunk
 * loop. The judge picks rules by phase and tool scope, so a rule only scores the
 * calls it could actually have seen, and summarizeCalibration reads the samples
 * unchanged.
 */
export const collectToolCallSamples = async (
  calls: readonly ReplayCall[],
  rules: readonly Rule[],
  judge: ToolCallJudge,
  progress: (label: string) => void,
): Promise<Map<string, number[]>> => {
  const samples = new Map<string, number[]>();
  const phases = CALL_PHASES.filter((phase) => rules.some((rule) => rule.when === phase));
  const total = calls.length * phases.length;
  let n = 0;
  for (const call of calls) {
    const recorded: ToolCall = { tool: call.tool, input: call.input };
    for (const phase of phases) {
      progress(`call ${(n += 1)} of ${total}  ${call.tool}`);
      try {
        for (const verdict of await judge(recorded, phase))
          samples.set(verdict.ruleId, [
            ...(samples.get(verdict.ruleId) ?? []),
            verdict.probability,
          ]);
      } catch {
        // a call that could not be judged is one fewer sample, nothing more
      }
    }
  }
  return samples;
};
