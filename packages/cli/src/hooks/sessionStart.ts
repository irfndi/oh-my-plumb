import {
  assertNever,
  sessionStartInputSchema,
  type HookOutput,
  type Rubric,
} from "oh-my-plumb-schema";
import { compilePrompt, type CompileTarget } from "../lib/compilePrompt.js";
import { appendEvent, trimEvents } from "../lib/events.js";
import { rejectedKeyNotice, resolveCredentials } from "../lib/credentials.js";
import { probeKey } from "../lib/keyProbe.js";
import { isKeyRejected, noteKeyAccepted, noteKeyRejected, probeIsDue } from "../lib/keyState.js";
import { findLintConfigs } from "../lib/lintConfig.js";
import { placeCompileSkill, runningVersion } from "../lib/packageRoot.js";
import { updateNotice } from "../lib/updateCheck.js";
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

const NO_KEY_NOTICE =
  "oh-my-plumb: no API key was found, so edits are not being checked. Run oh-my-plumb login, or put TYPESAFE_AI_API_KEY in the environment or a .env at the repo root, then start a new session.";

/**
 * A present key is not a working key, so one bounded probe says which it is.
 * A latched key gets that probe once a day too: a refusal is worth repeating
 * about once, not on every edit, and a fix on the provider's side should not
 * need a new key before it is believed.
 */
const keyNotice = async (root: string, sessionId: string): Promise<string | undefined> => {
  const creds = resolveCredentials(root);
  if (creds.kind === "none") return NO_KEY_NOTICE;
  if (probeIsDue(creds.key)) {
    const probe = await probeKey(creds);
    switch (probe.kind) {
      case "accepted":
        noteKeyAccepted(creds.key);
        return undefined;
      case "rejected":
        noteKeyRejected(creds.key, probe.message);
        return rejectedKeyNotice(root, sessionId);
      case "unknown":
        break;
      default:
        return assertNever(probe);
    }
  }
  return isKeyRejected(creds.key) ? rejectedKeyNotice(root, sessionId) : undefined;
};

export const handleSessionStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = sessionStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  pruneOldTurns();
  trimEvents(root);

  const plan = await planCompile(root);
  const notices: string[] = [];
  const keyProblem = await keyNotice(root, input.session_id);
  if (keyProblem !== undefined) notices.push(keyProblem);
  for (const problem of plan.invalid) {
    notices.push(`oh-my-plumb: rubric could not be read and is being ignored: ${problem}`);
  }
  const update = updateNotice(runningVersion());
  if (update !== undefined) notices.push(update);
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
