import { z } from "zod";
import { RULE_ID_PATTERN } from "./ids.js";

export const RUBRIC_VERSION = 1;

export const ruleWhenSchema = z.enum(["edit", "turn"]);
export type RuleWhen = z.infer<typeof ruleWhenSchema>;

/** What a rule is judged against: a code diff (today's default) or one recorded tool call. */
export const ruleTargetSchema = z.enum(["diff", "toolCall"]);
export type RuleTarget = z.infer<typeof ruleTargetSchema>;

export const ruleStatusSchema = z.enum(["active", "weak", "noisy", "disabled"]);
export type RuleStatus = z.infer<typeof ruleStatusSchema>;

const instructionsSchema = z.string().min(1).max(2000);

export const booleanQuestionSchema = z.object({
  type: z.literal("boolean"),
  instructions: instructionsSchema,
  criteria: z
    .object({
      true: z.string().max(1000).optional(),
      false: z.string().max(1000).optional(),
    })
    .optional(),
});

export const choiceQuestionSchema = z
  .object({
    type: z.literal("choice"),
    instructions: instructionsSchema,
    criteria: z.record(z.string().min(1), z.string().max(1000)),
    /** Options that count as a violation. The rest are compliant. */
    violating: z.array(z.string().min(1)).min(1),
  })
  .refine(
    (q) => Object.keys(q.criteria).length >= 2,
    "a choice question needs at least two options",
  )
  .refine(
    (q) => q.violating.every((name) => name in q.criteria),
    "every violating option must be one of the criteria",
  )
  .refine(
    (q) => q.violating.length < Object.keys(q.criteria).length,
    "at least one option must be compliant",
  );

export const scoreQuestionSchema = z
  .object({
    type: z.literal("score"),
    instructions: instructionsSchema,
    /** Ordered levels from fully compliant (index 0) to worst. */
    criteria: z.array(z.string().max(1000)).min(2),
    /** Zero-based level index from which the answer counts as a violation. */
    violatingFrom: z.number().int().min(1),
  })
  .refine(
    (q) => q.violatingFrom < q.criteria.length,
    "violatingFrom must point at one of the levels",
  );

export const questionSchema = z.discriminatedUnion("type", [
  booleanQuestionSchema,
  choiceQuestionSchema,
  scoreQuestionSchema,
]);
export type Question = z.infer<typeof questionSchema>;

const overlapsSchema = z.string().max(200).optional();

/**
 * A rule a linter can enforce exactly. oh-my-plumb records it and reports it; it
 * never runs it and never sends it to the model. The judge is for what a
 * linter cannot express.
 */
export const lintCheckSchema = z
  .object({
    type: z.literal("lint"),
    /** How a real linter would enforce it: the rule name, or the AST or grep shape. */
    how: z.string().min(1).max(300).optional(),
    /** A grep-shaped hint for the reader, when one exists. Never executed. */
    pattern: z.string().min(1).max(500).optional(),
    /** Name of a lint rule already configured in the repo that covers this. */
    overlaps: overlapsSchema,
  })
  .refine(
    (c) => c.how !== undefined || c.pattern !== undefined,
    "say how a linter would enforce it, or give the pattern",
  );

export const modelCheckSchema = z.object({
  type: z.literal("model"),
  question: questionSchema,
  overlaps: overlapsSchema,
  /** Grep-shaped hint, executable by Tier 1 against added lines when present. */
  pattern: z.string().min(1).max(500).optional(),
});

/**
 * A rule an external guard enforces: `init` records the command or skill it
 * found, Tier 2 runs it with a hard deadline, the hit names the owning rule.
 */
export const guardCheckSchema = z
  .object({
    type: z.literal("guard"),
    /** Guard command, spawned with FILE_PATH in env and the file text on stdin. */
    command: z.array(z.string().min(1)).min(1).optional(),
    /** Named skill whose guard script runs instead of a command. */
    skill: z.string().min(1).max(200).optional(),
    /** MCP server whose tool the guard calls, started the way the host's MCP config says. */
    server: z.string().min(1).max(200).optional(),
    /** MCP tool the guard calls with the edited file's path and contents. */
    tool: z.string().min(1).max(200).optional(),
    /** File glob the guard watches: the trigger `init` detected. */
    scope: z.string().min(1).max(500),
    /** The rule the guard enforces, in a human's words. */
    text: z.string().min(1).max(600),
  })
  .refine(
    (c) =>
      c.command !== undefined ||
      c.skill !== undefined ||
      (c.server !== undefined && c.tool !== undefined),
    "say which guard command runs, name the skill, or name the MCP server and tool",
  );

export const deferredCheckSchema = z.object({
  type: z.literal("deferred"),
  reason: z.string().min(1).max(300),
});

export const unenforceableCheckSchema = z.object({
  type: z.literal("unenforceable"),
  reason: z.string().min(1).max(300),
});

export const checkSchema = z.discriminatedUnion("type", [
  lintCheckSchema,
  modelCheckSchema,
  guardCheckSchema,
  deferredCheckSchema,
  unenforceableCheckSchema,
]);
export type Check = z.infer<typeof checkSchema>;
export type CheckType = Check["type"];

export const calibrationVerdictSchema = z.enum(["decisive", "weak", "noisy", "skipped"]);
export type CalibrationVerdict = z.infer<typeof calibrationVerdictSchema>;

export const calibrationSchema = z.object({
  at: z.string(),
  hunks: z.number().int().min(0),
  median: z.number().min(0).max(1),
  min: z.number().min(0).max(1),
  max: z.number().min(0).max(1),
  fired: z.number().int().min(0),
  verdict: calibrationVerdictSchema,
});
export type Calibration = z.infer<typeof calibrationSchema>;

export const ruleSourceSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().min(1).optional(),
});

export const ruleSchema = z
  .object({
    id: z.string().regex(RULE_ID_PATTERN, "rule ids are kebab-case"),
    /** The rule as the user wrote it, quoted or lightly shortened. */
    text: z.string().min(1).max(600),
    source: ruleSourceSchema,
    /** What the rule judges: a diff (default) or one recorded tool call. */
    target: ruleTargetSchema.default("diff"),
    /** Globs relative to the repo root for a diff rule, tool names for a tool-call rule. Absent means all. */
    scope: z.array(z.string().min(1)).min(1).optional(),
    when: ruleWhenSchema.optional(),
    check: checkSchema,
    status: ruleStatusSchema.default("active"),
    calibration: calibrationSchema.optional(),
  })
  .superRefine((rule, ctx) => {
    if (rule.check.type === "model" && rule.when === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["when"],
        message: `rule "${rule.id}" is model-checked and needs "when": "edit" or "turn"`,
      });
    }
    if (rule.check.type === "guard" && rule.scope !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["scope"],
        message: `rule "${rule.id}" is a guard; its trigger lives in check.scope alone`,
      });
    }
    if (rule.target === "toolCall" && rule.check.type !== "model") {
      ctx.addIssue({
        code: "custom",
        path: ["target"],
        message: `rule "${rule.id}" targets tool calls, which only a model check can judge`,
      });
    }
  });
export type Rule = z.infer<typeof ruleSchema>;
export type RuleInput = z.input<typeof ruleSchema>;

export const rubricSourceSchema = z.object({
  /** Repo-relative path, or "~/..." for a file in the home directory. */
  path: z.string().min(1),
  /** sha256 hex of the file bytes. Filled by `oh-my-plumb rubric validate`. */
  sha: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  /** Glob the file's rules apply to. Defaults to the file's directory. */
  scope: z.string().optional(),
  /** "mcp" when the source is an opted-in MCP server's instructions, named by `path`; absent for a file. */
  kind: z.literal("mcp").optional(),
});
export type RubricSource = z.infer<typeof rubricSourceSchema>;

export const thresholdsSchema = z
  .object({
    act: z.number().min(0).max(1),
    flag: z.number().min(0).max(1),
  })
  .refine((t) => t.flag < t.act, "flag threshold must sit below act threshold");
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const DEFAULT_THRESHOLDS: Thresholds = { act: 0.8, flag: 0.5 };

export const rubricSchema = z
  .object({
    version: z.literal(RUBRIC_VERSION),
    compiledAt: z.string(),
    compiledBy: z.string().optional(),
    sources: z.array(rubricSourceSchema),
    thresholds: thresholdsSchema.optional(),
    /**
     * MCP servers whose `initialize` instructions compile as rule sources,
     * scoped to that server's tool calls. Absent means none: opt-in only.
     */
    mcpInstructions: z.array(z.string().min(1).max(200)).optional(),
    rules: z.array(ruleSchema),
  })
  .superRefine((rubric, ctx) => {
    const seen = new Set<string>();
    rubric.rules.forEach((rule, index) => {
      if (seen.has(rule.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["rules", index, "id"],
          message: `duplicate rule id "${rule.id}"`,
        });
      }
      seen.add(rule.id);
    });
  });
export type Rubric = z.infer<typeof rubricSchema>;
export type RubricInput = z.input<typeof rubricSchema>;
