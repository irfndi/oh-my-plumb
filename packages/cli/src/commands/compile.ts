import { parseArgs } from "node:util";
import { PlumbError, type Rubric } from "oh-my-plumb-schema";
import { claudeAvailable, runClaude } from "../lib/claude.js";
import { compilePrompt, type TuneStats } from "../lib/compilePrompt.js";
import { readEvents } from "../lib/events.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill } from "../lib/packageRoot.js";
import { findRepoRoot, globalRubricPath, homeDir, rubricPath } from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { checkStaleness, discoverGlobalSources, discoverProjectSources } from "../lib/sources.js";
import { say } from "../lib/ui.js";
import { Callout } from "../ui/components/Callout.js";
import { Header } from "../ui/components/Header.js";
import { showStatic } from "../ui/render.js";
import { planCompile } from "../hooks/sessionStart.js";

const tuneStats = (
  root: string,
  file: string,
): { rubric: Rubric; stats: TuneStats[] } | undefined => {
  const read = readRubric(file);
  if (read.kind !== "ok") return undefined;
  const fired = new Map<string, number>();
  const checks = new Map<string, number>();
  for (const event of readEvents(root)) {
    if (event.kind !== "check") continue;
    for (const v of event.verdicts) {
      checks.set(v.ruleId, (checks.get(v.ruleId) ?? 0) + 1);
      if (v.band === "act") fired.set(v.ruleId, (fired.get(v.ruleId) ?? 0) + 1);
    }
  }
  const stats = read.rubric.rules
    .filter((r) => r.check.type === "model")
    .map((r) => ({
      rule: r.id,
      status: r.status,
      median: r.calibration?.median,
      fired: fired.get(r.id) ?? 0,
      checks: checks.get(r.id) ?? 0,
    }));
  return { rubric: read.rubric, stats };
};

/** Compiles now, in a headless Claude Code turn, instead of waiting for the next session. */
export const runCompile = async (argv: string[], tune: boolean): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: {
      print: { type: "boolean", default: false },
      global: { type: "boolean", default: false },
    },
  });
  const root = findRepoRoot(process.cwd());
  const plan = await planCompile(root, "always");
  if (plan.invalid.length > 0) {
    await showStatic(
      Callout({
        tone: "bad",
        title: "Fix the rubric first",
        children: plan.invalid.map((p) => p).join("\n"),
      }),
    );
    return 1;
  }
  if (plan.noSources)
    throw new PlumbError(
      "NO_INSTRUCTION_FILES",
      "found 0 instruction files, so there is nothing to compile. Add an AGENTS.md.",
    );

  let prompt: string;
  if (tune) {
    const stats = tuneStats(root, values.global ? globalRubricPath() : rubricPath(root));
    if (stats === undefined)
      throw new PlumbError("RUBRIC_MISSING", "nothing to tune yet; compile first");
    const project = [...discoverProjectSources(root), ...plan.mcp];
    const target = values.global
      ? {
          which: "global" as const,
          root: homeDir(),
          candidates: discoverGlobalSources(),
          staleness: checkStaleness(stats.rubric, discoverGlobalSources(), homeDir()),
          lintConfigs: [],
        }
      : {
          which: "project" as const,
          root,
          candidates: project,
          staleness: checkStaleness(stats.rubric, project, root),
          lintConfigs: findLintConfigs(root),
        };
    prompt = compilePrompt(placeCompileSkill(root), [target], stats);
  } else {
    if (plan.targets.length === 0) {
      await showStatic(Callout({ tone: "ok", title: "Rubric is up to date. Nothing to compile." }));
      return 0;
    }
    prompt = compilePrompt(placeCompileSkill(root), plan.targets);
  }

  if (values.print) {
    say(prompt);
    return 0;
  }
  if (!claudeAvailable()) {
    await showStatic(
      Callout({
        tone: "warn",
        title: "claude is not on PATH. Paste this into a Claude Code session in this repo:",
      }),
    );
    say(prompt);
    return 0;
  }
  await showStatic(
    Header({
      command: tune ? "tune" : "compile",
      where: root,
      note:
        "Starting a headless Claude Code turn to " +
        (tune ? "rewrite the weak rules" : "compile the rubric") +
        ". This runs on your subscription.",
    }),
  );
  const code = await runClaude(root, prompt);
  if (code !== 0) throw new PlumbError("CLAUDE_UNAVAILABLE", `claude exited with ${code}`);
  return 0;
};
