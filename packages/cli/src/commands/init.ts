import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { PlumbError, HOSTS, type Host } from "oh-my-plumb-schema";
import { resolveCredentials } from "../lib/credentials.js";
import { detectHosts, hostLabel, installHost, parseHost, type Installed } from "../lib/hosts.js";
import { hookScriptPath } from "../lib/packageRoot.js";
import { ohMyPlumbDir, findRepoRoot, rubricPath } from "../lib/paths.js";
import { readRubric } from "../lib/rubricFile.js";
import { discoverGlobalSources, discoverProjectSources } from "../lib/sources.js";
import { detectStack, routesFor } from "../lib/detect.js";
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
  const rulesYaml = [
    `version: "1.0"`,
    `detected:`,
    `  manifests: [${stack.manifests.join(", ")}]`,
    `  mcpServers: [${stack.mcpServers.join(", ")}]`,
    `  skills: [${stack.skills.join(", ")}]`,
    `routes:`,
    ...routes.flatMap((r) =>
      r.tier === 2
        ? [
            `  - tier: ${r.tier} trigger: "${r.trigger}" action: "${r.action}"`,
            `    mcp: ${r.mcp.server} ${r.mcp.tool} ${r.mcp.command.join(" ")}`,
          ]
        : [`  - tier: ${r.tier} trigger: "${r.trigger}" action: "${r.action}"`],
    ),
    ``,
  ].join("\n");
  writeFileSync(path.join(ohMyPlumbDir(root), "rules.yaml"), rulesYaml);
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
