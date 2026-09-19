import { describe, expect, it } from "vite-plus/test";
import { summarizeCalibration } from "../src/lib/calibration.js";

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
