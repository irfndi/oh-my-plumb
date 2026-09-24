import type { Rubric } from "oh-my-plumb-schema";
import { binScriptPath } from "./packageRoot.js";
import { globalRubricPath, rubricPath } from "./paths.js";
import { describeStaleness, type SourceCandidate, type Staleness } from "./sources.js";

export type CompileTarget = {
  which: "project" | "global";
  root: string;
  candidates: SourceCandidate[];
  staleness: Staleness;
  lintConfigs: string[];
};

export type TuneStats = {
  rule: string;
  status: string;
  median: number | undefined;
  fired: number;
  checks: number;
};

const sourceLine = (c: SourceCandidate): string =>
  c.text === undefined
    ? `${c.path} (rules apply to ${c.scope}${c.required ? "" : "; include only if it carries imperative rules"})`
    : `${c.path} (rules apply to ${c.scope}; MCP server instructions captured at compile time, quoted here because this source is not a file; list it in sources with "kind": "mcp" and give its rules no line: ${JSON.stringify(c.text)})`;

const targetBlock = (t: CompileTarget): string => {
  const file = t.which === "project" ? rubricPath(t.root) : globalRubricPath();
  const lines = [
    `${t.which === "project" ? "Project" : "Global"} rubric: ${file} (${describeStaleness(t.staleness)})`,
    `  repo root: ${t.root}`,
    ...t.candidates.map((c) => `  source: ${sourceLine(c)}`),
  ];
  if (t.lintConfigs.length > 0)
    lines.push(`  lint config to read for overlaps: ${t.lintConfigs.join(", ")}`);
  return lines.join("\n");
};

/** The text SessionStart hands the agent, and what `oh-my-plumb compile` sends headless. */
export const compilePrompt = (
  skillPath: string,
  targets: readonly CompileTarget[],
  tune?: { rubric: Rubric; stats: TuneStats[] },
): string => {
  const head =
    tune === undefined
      ? "oh-my-plumb is installed here and its rubric is missing or out of date. Compile it before you start on the user's request."
      : "oh-my-plumb is installed here. Some rules in its rubric never fire or fire on everything. Rewrite those rules before you start on the user's request.";
  const parts = [
    head,
    `Read ${skillPath} and follow it to the end. Do not skip the validate and calibrate steps.`,
    `Run the oh-my-plumb CLI as: node "${binScriptPath()}" <command>`,
    ...targets.map(targetBlock),
  ];
  if (tune !== undefined) {
    parts.push(
      "Calibration and firing statistics per rule (median violation probability across recent real hunks, how often it fired, how many checks it saw):",
      ...tune.stats.map(
        (s) =>
          `  ${s.rule}: status ${s.status}, median ${s.median === undefined ? "n/a" : s.median.toFixed(2)}, fired ${s.fired} of ${s.checks}`,
      ),
      "A rule stuck between 0.3 and 0.7 is underspecified: split it, name the concrete shape it should catch, or add a criteria example. A rule that fires on most hunks is too broad: narrow its scope or its wording. Keep every other rule exactly as it is.",
    );
  }
  parts.push(
    "When you are done, tell the user in two or three plain sentences how many rules were compiled into which buckets and which rules, if any, came out weak or noisy. Then continue with their request.",
  );
  return parts.join("\n\n");
};
