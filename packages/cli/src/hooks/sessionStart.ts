import { sessionStartInputSchema, type HookOutput, type Rubric } from "oh-my-plumb-schema";
import { compilePrompt, type CompileTarget } from "../lib/compilePrompt.js";
import { appendEvent } from "../lib/events.js";
import { hasApiKey } from "../lib/credentials.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill } from "../lib/packageRoot.js";
import {
  canonicalSourcePath,
  findRepoRoot,
  globalRubricPath,
  homeDir,
  rubricPath,
} from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { pruneOldTurns } from "../lib/session.js";
import {
  checkStaleness,
  discoverGlobalSources,
  discoverProjectSources,
  optedInServers,
  type McpSourceCandidate,
  type SourceCandidate,
} from "../lib/sources.js";
import { discoverMcpSources } from "../lib/mcpSources.js";

export type CompilePlan = {
  targets: CompileTarget[];
  invalid: string[];
  /** The project's opted-in MCP instructions captured during this plan; staleness itself never fetches. */
  mcp: McpSourceCandidate[];
  noSources: boolean;
};

/**
 * A rubric's opted-in MCP servers, started only when a compile may be due: the
 * rubric is missing, its files changed, or a listed server has no source yet.
 */
const mcpWhenDue = async (
  rubric: Rubric | undefined,
  files: readonly SourceCandidate[],
  root: string,
  capture: "always" | "when-due",
): Promise<McpSourceCandidate[]> => {
  const optedIn = optedInServers(rubric, root);
  if (optedIn.size === 0) return [];
  const listed = new Set(rubric?.sources.map((source) => canonicalSourcePath(root, source.path)));
  const due =
    capture === "always" ||
    checkStaleness(rubric, [...files], root).status !== "fresh" ||
    [...optedIn].some((server) => !listed.has(server));
  return due ? discoverMcpSources(root, rubric) : [];
};

/**
 * What, if anything, needs compiling for this repository and this machine.
 * Opted-in MCP servers are started only when a compile may be due ("when-due"):
 * the rubric is missing, its files changed, or a listed server has no source
 * yet. A session on a fresh rubric starts none. "always" is for explicit compiles.
 */
export const planCompile = async (
  root: string,
  capture: "always" | "when-due" = "when-due",
): Promise<CompilePlan> => {
  const targets: CompileTarget[] = [];
  const invalid: string[] = [];

  const files = discoverProjectSources(root);
  const projectRead = readRubric(rubricPath(root));
  if (projectRead.kind === "invalid") {
    invalid.push(`${projectRead.path}: ${projectRead.issues.slice(0, 3).join("; ")}`);
  }
  const projectRubric = projectRead.kind === "ok" ? projectRead.rubric : undefined;
  const mcp = await mcpWhenDue(projectRubric, files, root, capture);
  const project = [...files, ...mcp];
  const projectStale = checkStaleness(projectRubric, project, root);
  if (
    project.some((c) => c.required) &&
    projectStale.status !== "fresh" &&
    projectRead.kind !== "invalid"
  ) {
    targets.push({
      which: "project",
      root,
      candidates: project,
      staleness: projectStale,
      lintConfigs: findLintConfigs(root),
    });
  }

  const globalFiles = discoverGlobalSources();
  const globalRead = readRubric(globalRubricPath());
  if (globalRead.kind === "invalid") {
    invalid.push(`${globalRead.path}: ${globalRead.issues.slice(0, 3).join("; ")}`);
  }
  const globalRubric = globalRead.kind === "ok" ? globalRead.rubric : undefined;
  const globalMcp = await mcpWhenDue(globalRubric, globalFiles, homeDir(), capture);
  const global = [...globalFiles, ...globalMcp];
  const globalStale = checkStaleness(globalRubric, global, homeDir());
  if (global.length > 0 && globalStale.status !== "fresh" && globalRead.kind !== "invalid") {
    targets.push({
      which: "global",
      root: homeDir(),
      candidates: global,
      staleness: globalStale,
      lintConfigs: [],
    });
  }

  return {
    targets,
    invalid,
    mcp,
    noSources: project.length === 0 && global.length === 0,
  };
};

export const handleSessionStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = sessionStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  pruneOldTurns();

  const plan = await planCompile(root);
  const notices: string[] = [];
  if (!hasApiKey(root)) {
    notices.push(
      "oh-my-plumb: no API key was found, so edits are not being checked. Run oh-my-plumb login, or put TYPESAFE_AI_API_KEY in the environment or a .env at the repo root, then start a new session.",
    );
  }
  for (const problem of plan.invalid) {
    notices.push(`oh-my-plumb: rubric could not be read and is being ignored: ${problem}`);
  }
  const systemMessage = notices.length > 0 ? notices.join("\n") : undefined;

  if (plan.targets.length === 0) {
    return systemMessage === undefined ? { kind: "silent" } : { kind: "notice", systemMessage };
  }

  appendEvent(root, {
    kind: "compile-needed",
    at: new Date().toISOString(),
    sessionId: input.session_id,
    reason: plan.targets.map((t) => `${t.which}: ${t.staleness.status}`).join(", "),
    sources: plan.targets.flatMap((t) => t.candidates.map((c) => c.path)),
  });

  return {
    kind: "session-context",
    additionalContext: compilePrompt(placeCompileSkill(root), plan.targets),
    ...(systemMessage === undefined ? {} : { systemMessage }),
  };
};
