import { DEFAULT_THRESHOLDS, type Rubric, type Rule, type Thresholds } from "oh-my-plumb-schema";
import { globalRubricPath, resolveSourcePath, rubricPath } from "./paths.js";
import { mergeRules, readRubric, type MergedRule } from "./rubricFile.js";
import path from "node:path";

export type LoadedRules = {
  project: Rubric | undefined;
  global: Rubric | undefined;
  rules: MergedRule[];
  thresholds: Thresholds;
  problems: string[];
  /** Which scope stood the checks down: project off outranks global off. */
  off: "project" | "global" | undefined;
  /** Tool-call rules dropped because they were authored in another repository. */
  foreignToolRules: number;
};

const under = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
};

/**
 * A tool call has no path for a `scope` glob to read, so a rule authored in one
 * repository would judge every repository's shell calls. A diff rule is safe:
 * its scope always reads the file, and a foreign rule's globs match nothing
 * here anyway. Global rules stay: they were written for every repository.
 *
 * This runs before the merge, not after: a foreign copy of a question must not
 * be the copy that stands in for the local rule asking it.
 */
export const confineToolCallRules = (rules: readonly Rule[], root: string): Rule[] =>
  rules.filter(
    (rule) => rule.target !== "toolCall" || under(root, resolveSourcePath(root, rule.source.path)),
  );

/** Project rubric plus the global one, project winning on a clash. Read here, where every hook already looks, so a flip lands on the next edit. */
export const loadRubric = (root: string): LoadedRules => {
  const problems: string[] = [];
  const pick = (file: string): Rubric | undefined => {
    const read = readRubric(file);
    switch (read.kind) {
      case "ok":
        return read.rubric;
      case "invalid":
        problems.push(`${read.path}: ${read.issues[0] ?? "invalid"}`);
        return undefined;
      case "missing":
        return undefined;
      default:
        return undefined;
    }
  };
  const project = pick(rubricPath(root));
  const global = pick(globalRubricPath());
  const off: LoadedRules["off"] =
    project?.enabled === false ? "project" : global?.enabled === false ? "global" : undefined;
  const localProject =
    project === undefined
      ? undefined
      : { ...project, rules: confineToolCallRules(project.rules, root) };
  const rules = off === undefined ? mergeRules(localProject, global) : [];
  return {
    project,
    global,
    rules,
    thresholds: project?.thresholds ?? global?.thresholds ?? DEFAULT_THRESHOLDS,
    problems,
    off,
    foreignToolRules: (project?.rules.length ?? 0) - (localProject?.rules.length ?? 0),
  };
};

/** What the user is told when a scope is off, so silence is never mistaken for a clean run. */
export const offNotice = (off: "project" | "global", root: string): string => {
  const where = off === "project" ? root : globalRubricPath();
  return `oh-my-plumb: checks are off for ${off === "project" ? "this project" : "this machine"} (${where}). Rules are not being enforced. \`oh-my-plumb enable${off === "project" ? " --project" : ""}\` turns them back on.`;
};
