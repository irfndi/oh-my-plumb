import { RetryError, type Experimental_EvaluationQuestion } from "ai";
import {
  PlumbError,
  assertNever,
  type Question,
  type Rule,
  type Thresholds,
  type Usage,
  type Verdict,
} from "oh-my-plumb-schema";
import { bandFor, violationProbability, type ModelAnswer } from "./band.js";
import {
  GATEWAY_KEY_ENV,
  GATEWAY_MODEL_ID,
  JEV_USD_PER_INPUT_TOKEN,
  TYPESAFE_MODEL_ID,
} from "./constants.js";
import { credentials, NO_KEY_HINT, type Credentials } from "./credentials.js";
import type { ToolCallEntry } from "./session.js";

export type ModelRule = Rule & { check: { type: "model" } };

export const isModelRule = (rule: Rule): rule is ModelRule => rule.check.type === "model";

const toSdkQuestion = (q: Question): Experimental_EvaluationQuestion => {
  switch (q.type) {
    case "boolean":
      return q.criteria
        ? { type: "boolean", instructions: q.instructions, criteria: q.criteria }
        : { type: "boolean", instructions: q.instructions };
    case "choice":
      return { type: "choice", instructions: q.instructions, criteria: q.criteria };
    case "score":
      return { type: "score", instructions: q.instructions, criteria: q.criteria };
    default:
      return assertNever(q);
  }
};

/** What the judge sees: the change, or one recorded tool call. */
export type CheckState =
  | {
      task?: string;
      file?: string;
      files?: string[];
      diff: string;
    }
  | {
      task?: string;
      /** The turn's tool-call log, in call order: what a turn-phase tool-call rule is judged on. */
      toolCalls: ToolCallEntry[];
    }
  | {
      task?: string;
      tool: string;
      input: string;
    };

export type ModelCheckResult = {
  verdicts: Verdict[];
  usage: Usage;
  latencyMs: number;
};

const toAnswer = (value: unknown): ModelAnswer | undefined => {
  if (typeof value !== "object" || value === null || !("type" in value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  const probabilities =
    typeof record.probabilities === "object" && record.probabilities !== null
      ? Object.fromEntries(
          Object.entries(record.probabilities).flatMap(([k, v]) =>
            typeof v === "number" ? [[k, v] as const] : [],
          ),
        )
      : undefined;
  switch (record.type) {
    case "boolean":
      return typeof record.probability === "number"
        ? { type: "boolean", probability: record.probability }
        : undefined;
    case "choice":
      return typeof record.choice === "string"
        ? { type: "choice", choice: record.choice, probabilities }
        : undefined;
    case "score":
      return typeof record.score === "number"
        ? { type: "score", score: record.score, probabilities }
        : undefined;
    default:
      return undefined;
  }
};

type GatewayFailure = { code: "CHECK_TIMEOUT" | "CHECK_FAILED"; message: string };

const isAbort = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === "TimeoutError" ||
    error.name === "AbortError" ||
    error.message === "Delay was aborted");

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" &&
  error !== null &&
  "statusCode" in error &&
  typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;

const bodyOf = (error: unknown): string | undefined => {
  if (
    typeof error !== "object" ||
    error === null ||
    !("responseBody" in error) ||
    typeof error.responseBody !== "string"
  )
    return undefined;
  try {
    const parsed: unknown = JSON.parse(error.responseBody);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "message" in parsed &&
      typeof parsed.message === "string"
    )
      return parsed.message;
  } catch {
    // not JSON
  }
  return error.responseBody.slice(0, 160);
};

/**
 * The gateway's own words, not the SDK's. A retry that ran out of time says
 * "Delay was aborted"; what the person needs is the answer that made the SDK
 * retry in the first place.
 */
const explain = (error: unknown): GatewayFailure => {
  const attempts: unknown[] = RetryError.isInstance(error) ? error.errors : [error];
  const answered = [...attempts].reverse().find((e) => statusOf(e) !== undefined);
  if (answered !== undefined) {
    const status = statusOf(answered);
    const body = bodyOf(answered);
    const tries = attempts.length > 1 ? ` after ${attempts.length} tries` : "";
    return {
      code: "CHECK_FAILED",
      message: `the gateway answered ${status}${tries}${body ? `: ${body}` : ""}`,
    };
  }
  if (attempts.some(isAbort))
    return { code: "CHECK_TIMEOUT", message: "the gateway did not answer within the time allowed" };
  const last = attempts.at(-1);
  return { code: "CHECK_FAILED", message: last instanceof Error ? last.message : String(last) };
};

export const describeGatewayFailure = (error: unknown): PlumbError => {
  const failure = explain(error);
  return new PlumbError(failure.code, failure.message, { cause: error });
};

/**
 * Direct calls carry the key explicitly. The gateway provider reads its key
 * from the environment by the SDK's own convention, so a key found in a file
 * is placed there for this process only.
 */
const evaluationModel = async (
  creds: Exclude<Credentials, { kind: "none" }>,
): Promise<Parameters<typeof import("ai").experimental_evaluate>[0]["model"]> => {
  switch (creds.kind) {
    case "typesafe": {
      const { createTypeSafeAi } = await import("@ai-sdk/typesafe-ai");
      return createTypeSafeAi({ apiKey: creds.key }).evaluationModel(TYPESAFE_MODEL_ID);
    }
    case "gateway":
      process.env[GATEWAY_KEY_ENV] = creds.key;
      return GATEWAY_MODEL_ID;
    default:
      return assertNever(creds);
  }
};

/** One call carrying every rule. The state is only the rule set and the change. */
export const checkWithModel = async (
  rules: readonly ModelRule[],
  state: CheckState,
  thresholds: Thresholds,
  timeoutMs: number,
  /** Transient gateway failures to retry. Zero inside a hook, where the budget is the agent's time. */
  retries = 0,
): Promise<ModelCheckResult> => {
  if (rules.length === 0) return { verdicts: [], usage: {}, latencyMs: 0 };
  const creds = credentials();
  if (creds.kind === "none") throw new PlumbError("NO_API_KEY", NO_KEY_HINT);

  const { experimental_evaluate: evaluate } = await import("ai");
  const model = await evaluationModel(creds);
  const questions: Record<string, Experimental_EvaluationQuestion> = {};
  for (const rule of rules) questions[rule.id] = toSdkQuestion(rule.check.question);

  const started = performance.now();
  let result: Awaited<ReturnType<typeof evaluate>>;
  try {
    result = await evaluate({
      model,
      state,
      questions,
      maxRetries: retries,
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions: { gateway: { zeroDataRetention: true } },
    });
  } catch (error) {
    throw describeGatewayFailure(error);
  }
  const latencyMs = Math.round(performance.now() - started);

  const verdicts: Verdict[] = [];
  for (const rule of rules) {
    const answer = toAnswer(result.answers[rule.id]);
    if (answer === undefined) continue;
    const { probability, answer: picked } = violationProbability(rule.check.question, answer);
    verdicts.push({
      ruleId: rule.id,
      probability,
      band: bandFor(probability, thresholds),
      ...(picked === undefined ? {} : { answer: picked }),
    });
  }

  const inputTokens = result.usage.inputTokens;
  const usage: Usage = {
    inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: inputTokens === undefined ? undefined : inputTokens * JEV_USD_PER_INPUT_TOKEN,
  };
  return { verdicts, usage, latencyMs };
};
