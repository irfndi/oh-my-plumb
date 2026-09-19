import { describe, expect, it } from "vite-plus/test";
import { bandFor, violationProbability } from "../src/lib/band.js";

const thresholds = { act: 0.8, flag: 0.5 };

describe("banding", () => {
  it("bands at the edges and leaves the middle to the human", () => {
    expect(bandFor(0.95, thresholds)).toBe("act");
    expect(bandFor(0.8, thresholds)).toBe("act");
    expect(bandFor(0.65, thresholds)).toBe("flag");
    expect(bandFor(0.49, thresholds)).toBe("clear");
  });

  it("reads a boolean answer as the violation probability", () => {
    const q = { type: "boolean" as const, instructions: "?" };
    expect(violationProbability(q, { type: "boolean", probability: 0.93 })).toEqual({
      probability: 0.93,
    });
  });

  it("sums the violating options of a choice", () => {
    const q = {
      type: "choice" as const,
      instructions: "?",
      criteria: { ok: "fine", loose: "bad", eager: "bad" },
      violating: ["loose", "eager"],
    };
    const r = violationProbability(q, {
      type: "choice",
      choice: "loose",
      probabilities: { ok: 0.2, loose: 0.5, eager: 0.3 },
    });
    expect(r.probability).toBeCloseTo(0.8);
    expect(r.answer).toBe("loose");
    expect(violationProbability(q, { type: "choice", choice: "ok" }).probability).toBe(0);
  });

  it("sums the mass at or above the violating level of a score", () => {
    const q = {
      type: "score" as const,
      instructions: "?",
      criteria: ["short", "longer", "double", "quadruple"],
      violatingFrom: 2,
    };
    const r = violationProbability(q, {
      type: "score",
      score: 2.1,
      probabilities: { "0": 0.1, "1": 0.1, "2": 0.5, "3": 0.3 },
    });
    expect(r.probability).toBeCloseTo(0.8);
    expect(r.answer).toBe("double");
    expect(violationProbability(q, { type: "score", score: 0.4 }).probability).toBe(0);
  });

  it("ignores an answer of the wrong shape", () => {
    const q = { type: "boolean" as const, instructions: "?" };
    expect(violationProbability(q, { type: "score", score: 3 }).probability).toBe(0);
  });
});
