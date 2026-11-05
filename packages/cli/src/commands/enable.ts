import { mkdirSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PlumbError, RUBRIC_VERSION, type Rubric } from "oh-my-plumb-schema";
import { readRubric, writeRubric } from "../lib/rubricFile.js";
import { findRepoRoot, globalRubricPath, rubricPath } from "../lib/paths.js";
import { say } from "../lib/ui.js";

/**
 * The switch is written into the rubric file itself, so it survives a restart
 * and is something a person can read and edit by hand. A missing rubric is
 * created rather than refused: standing the checker down somewhere is a
 * legitimate thing to ask, and the new file says where the switch lives.
 */
export const runEnabled = async (argv: string[], enabled: boolean): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: { project: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());
  const file = values.project ? rubricPath(root) : globalRubricPath();
  const existing = readRubric(file);
  if (existing.kind === "invalid")
    throw new PlumbError(
      "RUBRIC_INVALID",
      `${existing.path} cannot be read: ${existing.issues[0]}`,
    );

  const rubric: Rubric =
    existing.kind === "ok"
      ? { ...existing.rubric, enabled }
      : {
          version: RUBRIC_VERSION,
          compiledAt: new Date().toISOString(),
          enabled,
          sources: [],
          rules: [],
        };

  mkdirSync(path.dirname(file), { recursive: true });
  writeRubric(file, rubric);
  const where = values.project ? "this project" : "this machine";
  say(
    enabled
      ? `oh-my-plumb: checks are on for ${where} (${file}).`
      : `oh-my-plumb: checks are off for ${where} (${file}). Rules are not enforced until you enable them again.`,
  );
  return 0;
};
