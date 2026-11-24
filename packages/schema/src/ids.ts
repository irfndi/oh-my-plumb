import { createHash } from "node:crypto";
import type { Rule } from "./rubric.js";

/** Rule ids are kebab-case slugs. The compiling agent writes them; the schema enforces the format. */
export const RULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

export const createRuleId = (text: string): string => {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/^[^a-z]+/, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug.length > 0 ? slug : "rule";
};

/** Source hash stored in the rubric header: sha256 of the file's bytes, hex. */
export const createSourceSha = (content: string | Uint8Array): string =>
  createHash("sha256").update(content).digest("hex");

/** Git's blob id, so content on disk, in a tree and in a hook payload compare equal. */
export const createBlobId = (content: string | Uint8Array): string => {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

/** Key for the per-turn block counter: one rule on one file. */
export const createBlockKey = (ruleId: string, relativePath: string): string =>
  `${ruleId}@${relativePath}`;

/**
 * What makes two rules the same question. Text is not part of it: two files can
 * word one requirement differently and still ask the judge the same thing, and
 * asking it twice bills twice for one answer.
 */
export const createQuestionKey = (rule: Rule): string =>
  JSON.stringify([
    rule.target,
    rule.when ?? null,
    rule.check.type,
    rule.check.type === "model" ? rule.check.question : rule.check,
    // A precondition decides whether the rule is judged at all: two copies that
    // ask one question but gate it differently are two rules.
    rule.check.type === "model" ? (rule.check.precondition ?? null) : null,
  ]);
