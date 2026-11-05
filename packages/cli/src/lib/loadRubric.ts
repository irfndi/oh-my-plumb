import { DEFAULT_THRESHOLDS, type Rubric, type Thresholds } from "oh-my-plumb-schema";
import { globalRubricPath, rubricPath } from "./paths.js";
import { mergeRules, readRubric, type MergedRule } from "./rubricFile.js";

export type LoadedRules = {
  project: Rubric | undefined;
  global: Rubric | undefined;
  rules: MergedRule[];
  thresholds: Thresholds;
  problems: string[];
  /** Which scope stood the checks down: project off outranks global off. */
  off: "project" | "global" | undefined;
};

/**
 * Project rubric plus the global one, project winning on a clash. `enabled:
 * false` in either file stands every check down for that scope.
 *
 * Read here, in the one place every hook and command already goes through, so
 * a flip takes effect on the next edit with no hook rewrite.
 */
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
  // A file that is off is off for its scope; the other scope still speaks.
  const off: LoadedRules["off"] =
    project?.enabled === false ? "project" : global?.enabled === false ? "global" : undefined;
  return {
    project,
    global,
    rules: off === undefined ? mergeRules(project, global) : [],
    thresholds: project?.thresholds ?? global?.thresholds ?? DEFAULT_THRESHOLDS,
    problems,
    off,
  };
};

/** What the user is told when a scope is off, so silence is never mistaken for a clean run. */
export const offNotice = (off: "project" | "global", root: string): string => {
  const where = off === "project" ? root : globalRubricPath();
  return `oh-my-plumb: checks are off for ${off === "project" ? "this project" : "this machine"} (${where}). Rules are not being enforced. \`oh-my-plumb enable${off === "project" ? " --project" : ""}\` turns them back on.`;
};
