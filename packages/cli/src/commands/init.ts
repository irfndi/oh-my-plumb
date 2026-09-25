import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  PlumbError,
  HOSTS,
  RUBRIC_VERSION,
  createRuleId,
  ruleSchema,
  type Host,
  type Rubric,
} from "oh-my-plumb-schema";
import { resolveCredentials } from "../lib/credentials.js";
import { detectHosts, hostLabel, installHost, parseHost, type Installed } from "../lib/hosts.js";
import { hookScriptPath, installRoot, packageRoot } from "../lib/packageRoot.js";
import { ohMyPlumbDir, findRepoRoot, rubricPath } from "../lib/paths.js";
import { readRubric, writeRubric } from "../lib/rubricFile.js";
import {
  discoverGlobalSources,
  discoverProjectSources,
  type SourceCandidate,
} from "../lib/sources.js";
import { detectStack, routesFor, type DetectedStack, type TierRoute } from "../lib/detect.js";
import type { Step } from "../ui/components/Checklist.js";
import { showStatic } from "../ui/render.js";
import { InitView } from "../ui/views/InitView.js";

const selfTest = (script: string, root: string): boolean => {
  const payload = JSON.stringify({
    session_id: "oh-my-plumb-init-selftest",
    cwd: root,
    hook_event_name: "SessionStart",
    source: "startup",
  });
  const result = spawnSync("node", [script, "session-start"], {
    input: payload,
    encoding: "utf8",
    env: { ...process.env, OH_MY_PLUMB_DEBUG: "" },
    timeout: 15_000,
  });
  return result.status === 0;
};

export const chooseHosts = (names: readonly string[]): Host[] => {
  if (names.length > 0) return [...new Set(names.map(parseHost))];
  const found = detectHosts();
  if (found.length === 0)
    throw new PlumbError(
      "HOST_NOT_FOUND",
      `none of ${HOSTS.join(", ")} is installed here; name one to install anyway`,
    );
  return found;
};

/** The rubric with a rule for every detected tier-2 guard; undefined when there is none to record. */
export const withGuards = (
  rubric: Rubric | undefined,
  stack: Pick<DetectedStack, "mcpServers">,
  routes: readonly TierRoute[],
): Rubric | undefined => {
  const guards = routes.filter(
    (route): route is Extract<TierRoute, { tier: 2 }> => route.tier === 2,
  );
  if (guards.length === 0) return undefined;
  const base: Rubric = rubric ?? {
    version: RUBRIC_VERSION,
    compiledAt: new Date().toISOString(),
    sources: [],
    rules: [],
  };
  const sources = [...base.sources];
  const rules = [...base.rules];
  for (const guard of guards) {
    const entry = stack.mcpServers.find((detected) => detected.endsWith(`:${guard.mcp.server}`));
    // routesFor only routes guards whose server is configured here, so the config is named.
    if (entry === undefined) continue;
    const rule = ruleSchema.parse({
      id: createRuleId(`guard ${guard.mcp.server} ${guard.mcp.tool}`),
      text: guard.action,
      source: { path: entry.slice(0, entry.lastIndexOf(":")) },
      check: {
        type: "guard",
        server: guard.mcp.server,
        tool: guard.mcp.tool,
        scope: guard.trigger,
        text: guard.action,
      },
    });
    // A rule already in the rubric is the user's to edit or disable; init never resets it.
    const kept = rules.find((existing) => existing.id === rule.id) ?? rule;
    if (kept === rule) rules.push(rule);
    // Every rule's source must be listed, including a kept rule whose entry went missing.
    if (!sources.some((source) => source.path === kept.source.path))
      sources.push({ path: kept.source.path });
  }
  return { ...base, sources, rules };
};

const foundText = (files: number, skills: number): string => {
  const fileText = `${files} instruction ${files === 1 ? "file" : "files"}`;
  return skills === 0
    ? `${fileText} found`
    : `${fileText} and ${skills} ${skills === 1 ? "skill" : "skills"} found`;
};

const SKILL_ROOTS = [
  "~/.claude/skills",
  "~/.pi/agent/skills",
  ".claude/skills",
  ".pi/skills",
  "skills",
];

/** Where a skill lives, as one line: its skills folder, or the installed plugins as a whole. */
const skillFolder = (skillPath: string): string => {
  if (skillPath.startsWith("~/.claude/plugins/")) return "installed Claude Code plugins";
  return (
    SKILL_ROOTS.find((root) => skillPath.startsWith(`${root}/`)) ??
    path.dirname(path.dirname(skillPath))
  );
};

/** Skills counted per folder, in the order they were found. */
const skillFolders = (skills: readonly SourceCandidate[]): { folder: string; count: number }[] => {
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const folder = skillFolder(skill.path);
    counts.set(folder, (counts.get(folder) ?? 0) + 1);
  }
  return [...counts].map(([folder, count]) => ({ folder, count }));
};

export const runInit = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "boolean", default: false } },
  });
  const root = findRepoRoot(process.cwd());

  const creds = resolveCredentials(root);
  if (creds.kind === "none") {
    await showStatic(InitView({ data: { kind: "no-key", root } }));
    return 1;
  }

  const project = discoverProjectSources(root);
  const global = discoverGlobalSources();
  const all = [...project, ...global];
  // A machine can hold dozens of skills; they are listed per folder, not one line each.
  const skills = all.filter((c) => c.origin === "skill");
  const files = all.filter((c) => c.origin !== "skill");
  if (project.length === 0 && global.length === 0) {
    await showStatic(InitView({ data: { kind: "no-sources", root } }));
    return 1;
  }

  const hosts = chooseHosts(positionals);
  const script = hookScriptPath();
  const stack = detectStack(root);
  const routes = routesFor(stack, root);
  const steps: Step[] = [
    {
      ok: true,
      text: `${creds.kind === "typesafe" ? "TypeSafe" : "Vercel AI Gateway"} key found in ${creds.from}`,
    },
    {
      ok: true,
      text: foundText(files.length, skills.length),
    },
  ];
  if (installRoot() !== packageRoot())
    steps.push({
      ok: true,
      text: "running from the npx cache, which npm can clear, so hooks point at a copy",
      detail: installRoot(),
    });
  mkdirSync(ohMyPlumbDir(root), { recursive: true });
  writeFileSync(path.join(ohMyPlumbDir(root), ".gitignore"), "events.jsonl\ncompile-skill.md\n");
  const rubricFile = rubricPath(root);
  const before = readRubric(rubricFile);
  if (before.kind === "invalid") {
    steps.push({
      ok: false,
      text: `${before.path} cannot be read, so the detected guard was not recorded`,
    });
  } else {
    const guarded = withGuards(before.kind === "ok" ? before.rubric : undefined, stack, routes);
    if (guarded !== undefined) {
      writeRubric(rubricFile, guarded);
      steps.push({ ok: true, text: "detected guard recorded as a rubric rule" });
    }
  }
  steps.push({
    ok: true,
    text: `detected ${stack.manifests.length} manifests, ${stack.mcpServers.length} MCP servers, ${stack.skills.length} skills`,
  });
  if (!selfTest(script, root))
    throw new PlumbError(
      "SETTINGS_INVALID",
      `the hook at ${script} did not run cleanly; nothing was enabled`,
    );
  steps.push({ ok: true, text: "hook self-test passed" });

  const installed: Installed[] = hosts.map((host) => installHost(host, root, values.project));
  for (const i of installed) {
    steps.push({ ok: true, text: `${hostLabel(i.host)}: ${i.what}`, detail: i.target });
  }

  const rubric = readRubric(rubricPath(root));
  await showStatic(
    InitView({
      data: {
        kind: "installed",
        root,
        steps,
        hosts: installed.map((i) => hostLabel(i.host)),
        afterwards: installed.flatMap((i) => (i.afterwards === undefined ? [] : [i.afterwards])),
        sources: files.map((c) => ({
          path: c.path,
          scope: c.scope,
          global: global.includes(c),
        })),
        skills: skillFolders(skills),
        rubric:
          rubric.kind === "ok" ? { path: rubric.path, rules: rubric.rubric.rules.length } : null,
      },
    }),
  );
  return 0;
};
