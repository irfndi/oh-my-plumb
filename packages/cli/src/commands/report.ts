import { existsSync } from "node:fs";
import { parseArgs } from "node:util";
import type { PlumbEvent, Rule, Verdict } from "oh-my-plumb-schema";
import { detectStack } from "../lib/detect.js";
import { readEvents } from "../lib/events.js";
import { guardRoutes, routeGaps } from "../lib/guards.js";
import { loadRubric } from "../lib/loadRubric.js";
import { installTarget } from "../lib/hosts.js";
import { resolveRepoRoot, rubricPath } from "../lib/paths.js";
import { readPiTrust } from "../lib/piTrust.js";
import { say } from "../lib/ui.js";
import type { RuleStats } from "../ui/components/RuleTable.js";
import { showStatic } from "../ui/render.js";
import { ReportView, type ReportData } from "../ui/views/ReportView.js";
import { InitView } from "../ui/views/InitView.js";

const statsFrom = (events: readonly PlumbEvent[]): Map<string, RuleStats> => {
  const stats = new Map<string, RuleStats>();
  const count = (ruleId: string, band: Verdict["band"] | undefined): void => {
    const s = stats.get(ruleId) ?? { checks: 0, fired: 0, flagged: 0 };
    s.checks += 1;
    if (band === "act") s.fired += 1;
    if (band === "flag") s.flagged += 1;
    stats.set(ruleId, s);
  };
  for (const event of events) {
    if (event.kind !== "check") continue;
    for (const v of event.verdicts) count(v.ruleId, v.band);
    for (const ruleId of event.asked ?? []) count(ruleId, undefined);
  }
  return stats;
};

const MIN_CHECKS_TO_CALL_DEAD = 20;
const MIN_FLAGS_TO_CALL_MIDDLE = 5;

/**
 * A rubric in the project slot of a directory that is nobody's repository: a
 * compile run from a scratch folder adopts every instruction file below home,
 * and no real repository ever loads it.
 */
const misfiledRubric = (root: string, repository: boolean): string | undefined => {
  const file = rubricPath(root);
  return !repository && existsSync(file) ? file : undefined;
};

export const collectReport = (root: string, repository = true): ReportData | undefined => {
  const loaded = loadRubric(root);
  if (loaded.rules.length === 0) return undefined;
  const events = readEvents(root);
  const stats = statsFrom(events);
  // Dead means it never answers: no fire, no flag, and a calibration that
  // never cleared confidently either. A rule at 0.02 on every check is not
  // dead, it is a rule nobody has broken yet.
  const dead: Rule[] = loaded.rules.filter((rule) => {
    const s = stats.get(rule.id);
    const middling = rule.calibration === undefined || rule.calibration.median >= 0.25;
    return (
      rule.status === "active" &&
      rule.check.type === "model" &&
      middling &&
      s !== undefined &&
      s.checks >= MIN_CHECKS_TO_CALL_DEAD &&
      s.fired === 0 &&
      s.flagged === 0
    );
  });
  // Never acted and never cleared: it enforces nothing, and its note is the only sign it exists.
  const middle = loaded.rules.flatMap((rule) => {
    const s = stats.get(rule.id);
    return rule.status === "active" &&
      rule.check.type === "model" &&
      s !== undefined &&
      s.fired === 0 &&
      s.flagged >= MIN_FLAGS_TO_CALL_MIDDLE
      ? [{ id: rule.id, flagged: s.flagged, checks: s.checks }]
      : [];
  });
  const mcpServers = detectStack(root).mcpServers;
  const missingRoutes = guardRoutes(loaded.rules, root)
    .map((route) => ({ trigger: route.trigger, gaps: routeGaps(root, route, mcpServers) }))
    .filter((route) => route.gaps.length > 0);
  return {
    root,
    rules: loaded.rules,
    events,
    stats,
    dead,
    middle,
    problems: loaded.problems,
    missingRoutes,
    misfiledRubric: misfiledRubric(root, repository),
    foreignToolRules: loaded.foreignToolRules,
    // Project trust gates pi's project extension; global installs need no decision.
    piTrust: existsSync(installTarget("pi", root, true)) ? readPiTrust(root) : null,
  };
};

/** The one shape `report --json` prints, rubric or no rubric: a script that reads it never branches on which. */
export type ReportJson = {
  root: string;
  rules: Rule[];
  stats: Record<string, RuleStats>;
  dead: string[];
  middle: ReportData["middle"];
  /** Every event the log holds, oldest first. A count is `events.length`, never this key. */
  events: PlumbEvent[];
  /** Sessions that asked for a rubric and never got one compiled. */
  compileNeeded: number;
  /**
   * A rubric sitting in the project slot of a directory that is not a repository.
   * Null, not absent: a key that vanishes is the shape bug #89 was.
   */
  misfiledRubric: string | null;
  foreignToolRules: number;
  problems: string[];
};

export const reportJson = (data: ReportData | undefined, root: string): ReportJson =>
  data === undefined
    ? {
        root,
        rules: [],
        stats: {},
        dead: [],
        middle: [],
        events: [],
        compileNeeded: 0,
        misfiledRubric: null,
        foreignToolRules: 0,
        problems: [],
      }
    : {
        root: data.root,
        rules: data.rules,
        stats: Object.fromEntries(data.stats),
        dead: data.dead.map((r) => r.id),
        middle: data.middle,
        events: data.events,
        compileNeeded: data.events.filter((e) => e.kind === "compile-needed").length,
        misfiledRubric: data.misfiledRubric ?? null,
        foreignToolRules: data.foreignToolRules,
        problems: data.problems,
      };

/** Rules, calibration, and what has fired so far in this repository. */
export const runReport = async (argv: string[]): Promise<number> => {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });
  const found = resolveRepoRoot(process.cwd());
  const root = found.root;
  const data = collectReport(root, found.repository);
  if (values.json) {
    say(JSON.stringify(reportJson(data, root)));
    return data === undefined ? 1 : 0;
  }
  if (data === undefined) {
    await showStatic(InitView({ data: { kind: "no-sources", root } }));
    return 1;
  }
  await showStatic(ReportView({ data }));
  return 0;
};
