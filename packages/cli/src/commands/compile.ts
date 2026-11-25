import { parseArgs } from "node:util";
import { PlumbError, type Rubric } from "oh-my-plumb-schema";
import { claudeAvailable, runClaude } from "../lib/claude.js";
import { compilePrompt, type TuneStats } from "../lib/compilePrompt.js";
import { readEvents } from "../lib/events.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill } from "../lib/packageRoot.js";
import { resolveRepoRoot, globalRubricPath, homeDir, rubricPath } from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { checkStaleness, discoverGlobalSources, discoverProjectSources } from "../lib/sources.js";
import { say } from "../lib/ui.js";
import { Callout } from "../ui/components/Callout.js";
import { CompileBlockedView } from "../ui/views/CompileBlockedView.js";
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
    for (const ruleId of event.asked ?? []) checks.set(ruleId, (checks.get(ruleId) ?? 0) + 1);
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
  const found = resolveRepoRoot(process.cwd());
  // A compile outside a repository writes a home-wide rubric into the project
  // slot: every directory below ~ then reads it as its own, and no repository does.
  if (!found.repository && !values.global)
    throw new PlumbError(
      "NOT_A_REPOSITORY",
      `${found.root} is not a repository (no .git), so a rubric compiled here would apply to every folder below it and to no repository. Run this inside the repository the rules belong to, or pass --global for a machine-wide rubric.`,
    );
  const root = found.root;
  const plan = await planCompile(root, "always");
  // --global compiles one rubric, so another rubric's parse error is not its problem.
  const blocking = plan.invalid.filter((p) => !values.global || p.which === "global");
  if (blocking.length > 0) {
    await showStatic(CompileBlockedView({ problems: blocking }));
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
    // --global compiles the machine-wide rubric only: the project target
    // planCompile found is the one the guard above just refused.
    const targets = values.global ? plan.targets.filter((t) => t.which === "global") : plan.targets;
    if (targets.length === 0) {
      // "Up to date" and "nothing to compile from" read the same in a table and mean
      // opposite things, so a global run says which one it is.
      const nothingToRead = values.global && discoverGlobalSources().length === 0;
      await showStatic(
        Callout({
          tone: "ok",
          title: nothingToRead
            ? "No machine-wide instruction files, so there is no global rubric to compile"
            : values.global
              ? "Global rubric is up to date. Nothing to compile."
              : "Rubric is up to date. Nothing to compile.",
        }),
      );
      return 0;
    }
    prompt = compilePrompt(placeCompileSkill(root), targets);
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
