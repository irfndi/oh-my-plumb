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
import { hookScriptPath } from "../lib/packageRoot.js";
import { ohMyPlumbDir, findRepoRoot, rubricPath } from "../lib/paths.js";
import { readRubric, writeRubric } from "../lib/rubricFile.js";
import { discoverGlobalSources, discoverProjectSources } from "../lib/sources.js";
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
      scope: [guard.trigger],
      check: {
        type: "guard",
        server: guard.mcp.server,
        tool: guard.mcp.tool,
        scope: guard.trigger,
        text: guard.action,
      },
    });
    // A rule already in the rubric is the user's to edit or disable; init never resets it.
    if (rules.some((existing) => existing.id === rule.id)) continue;
    rules.push(rule);
    if (!sources.some((source) => source.path === rule.source.path))
      sources.push({ path: rule.source.path });
  }
  return { ...base, sources, rules };
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
      text: `${project.length + global.length} instruction ${project.length + global.length === 1 ? "file" : "files"} found`,
    },
  ];
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
        sources: [
          ...project.map((c) => ({ path: c.path, scope: c.scope, global: false })),
          ...global.map((c) => ({ path: c.path, scope: c.scope, global: true })),
        ],
        rubric:
          rubric.kind === "ok" ? { path: rubric.path, rules: rubric.rubric.rules.length } : null,
      },
    }),
  );
  return 0;
};
