import { assertNever, type Band, type Question, type Thresholds } from "oh-my-plumb-schema";

export type ModelAnswer =
  | { type: "boolean"; probability: number }
  | { type: "choice"; choice: string; probabilities?: Record<string, number> }
  | { type: "score"; score: number; probabilities?: Record<string, number> };

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** Probability that the rule is violated, whatever the question type. */
export const violationProbability = (
  question: Question,
  answer: ModelAnswer,
): { probability: number; answer?: string } => {
  switch (question.type) {
    case "boolean":
      return answer.type === "boolean"
        ? { probability: clamp01(answer.probability) }
        : { probability: 0 };
    case "choice": {
      if (answer.type !== "choice") return { probability: 0 };
      const violating = new Set(question.violating);
      if (answer.probabilities) {
        const mass = Object.entries(answer.probabilities)
          .filter(([name]) => violating.has(name))
          .reduce((sum, [, p]) => sum + p, 0);
        return { probability: clamp01(mass), answer: answer.choice };
      }
      return { probability: violating.has(answer.choice) ? 1 : 0, answer: answer.choice };
    }
    case "score": {
      if (answer.type !== "score") return { probability: 0 };
      const level = Math.round(answer.score);
      const label = question.criteria[level] ?? String(level);
      if (answer.probabilities) {
        const mass = Object.entries(answer.probabilities)
          .filter(([index]) => Number(index) >= question.violatingFrom)
          .reduce((sum, [, p]) => sum + p, 0);
        return { probability: clamp01(mass), answer: label };
      }
      return { probability: answer.score >= question.violatingFrom ? 1 : 0, answer: label };
    }
    default:
      return assertNever(question);
  }
};

export const bandFor = (probability: number, thresholds: Thresholds): Band =>
  probability >= thresholds.act ? "act" : probability >= thresholds.flag ? "flag" : "clear";
