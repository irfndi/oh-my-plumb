import type { CalibrationVerdict, Thresholds } from "oh-my-plumb-schema";
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
