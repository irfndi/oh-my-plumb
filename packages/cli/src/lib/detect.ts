import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { findLintConfigs } from "./lintConfig.js";
import { homeDir } from "./paths.js";
import { routeGaps, type McpRoute } from "./guards.js";
import type { McpLaunch } from "./mcp.js";

/**
 * Phase 2: zero-config project auto-detection. Inspects the repo and emits
 * the data `oh-my-plumb init` records as guard rules in the rubric.
 * Read-only: never writes, never spawns.
 */

export type DetectedStack = {
  manifests: string[];
  lintConfigs: string[];
  mcpServers: string[];
  skills: string[];
};
const MANIFESTS = [
  "vite.config.ts",
  "biome.json",
  "biome.jsonc",
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  ".eslintrc.json",
  "tsconfig.base.json",
  "tsconfig.json",
  "Cargo.toml",
  "ruff.toml",
  ".ruff.toml",
  "pyproject.toml",
  "package.json",
];

const MCP_PATHS = [
  ".pi/mcp.json",
  ".claude/mcp.json",
  ".codex/mcp.json",
  ".opencode/mcp.json",
  ".mcp.json",
  "opencode.json",
  "opencode.jsonc",
];

const SKILL_DIRS = [".pi/skills", "skills", ".claude/skills"];

const namesIn = (pkgJson: string): string[] => {
  try {
    const pkg = JSON.parse(readFileSync(pkgJson, "utf8")) as {
      scripts?: Record<string, string>;
    };
    return Object.keys(pkg.scripts ?? {});
  } catch {
    return [];
  }
};

/** How a stdio MCP server is started, from the host's own config; undefined for a remote server. */
type McpServerDef = { name: string; launch: McpLaunch | undefined };

const stringMap = z.record(z.string(), z.string()).optional().catch(undefined);

// Claude Code, Codex and pi spell a stdio server as command plus args; OpenCode gives the whole argv as one array.
const launchSchema = z
  .object({
    command: z.union([
      z
        .string()
        .min(1)
        .transform((c) => [c]),
      z.array(z.string()).min(1),
    ]),
    args: z
      .array(z.union([z.string(), z.number()]))
      .optional()
      .catch(undefined),
    env: stringMap,
    environment: stringMap,
  })
  .transform((s): McpLaunch => ({
    command: [...s.command, ...(s.args ?? []).map(String)],
    env: { ...s.environment, ...s.env },
  }));

const launchOf = (value: unknown): McpLaunch | undefined => {
  const parsed = launchSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const serverMap = z
  .record(z.string(), z.unknown())
  .transform((rec) =>
    Object.entries(rec).map(([name, value]): McpServerDef => ({ name, launch: launchOf(value) })),
  );

const namedServer = z.object({ name: z.string() });

const serverList = z.array(z.unknown()).transform((list) =>
  list.flatMap((s): McpServerDef[] => {
    const parsed = namedServer.safeParse(s);
    return parsed.success ? [{ name: parsed.data.name, launch: launchOf(s) }] : [];
  }),
);

// A wrong-typed key skips only that shape, matching the old key-by-key tolerance.
const jsonMcpDoc = z
  .object({
    mcpServers: serverMap.optional().catch(undefined),
    servers: z.union([serverList, serverMap]).optional().catch(undefined),
    mcp: serverMap.optional().catch(undefined),
  })
  .transform((doc) => doc.mcpServers ?? doc.servers ?? doc.mcp ?? []);

const codexMcpDoc = z
  .object({ mcp_servers: serverMap.optional().catch(undefined) })
  .transform((doc) => doc.mcp_servers ?? []);

/** `claude mcp add` defaults to the local scope, which Claude Code keeps per project in ~/.claude.json. */
const claudeLocalDoc = (root: string) =>
  z
    .object({
      projects: z
        .record(z.string(), z.object({ mcpServers: serverMap.optional().catch(undefined) }))
        .optional()
        .catch(undefined),
    })
    .transform((doc) => doc.projects?.[path.resolve(root)]?.mcpServers ?? []);

/** MCP servers from a host config file, tolerating the common shapes. */
const serversIn = (file: string, root: string): McpServerDef[] => {
  try {
    const text = readFileSync(file, "utf8");
    if (file.endsWith(".toml")) {
      const doc = codexMcpDoc.safeParse(parseToml(text));
      return doc.success ? doc.data : [];
    }
    // JSON5 also reads the comments and trailing commas OpenCode allows in its config.
    const raw: unknown = JSON5.parse(text);
    const doc = jsonMcpDoc.safeParse(raw);
    const local =
      path.basename(file) === ".claude.json" ? claudeLocalDoc(root).safeParse(raw) : undefined;
    return [...(doc.success ? doc.data : []), ...(local?.success ? local.data : [])];
  } catch {
    return [];
  }
};

const GLOBAL_MCP_PATHS = [
  "~/.pi/mcp.json",
  "~/.claude/mcp.json",
  "~/.claude.json",
  "~/.codex/config.toml",
  "~/.config/opencode/opencode.json",
  "~/.config/opencode/opencode.jsonc",
];

const inHome = (spelling: string): string => path.join(homeDir(), spelling.slice(2));

/** How to start the named MCP server, from the project's host configs first, then the global ones. */
export const findMcpServer = (root: string, name: string): McpLaunch | undefined => {
  const files = [
    ...MCP_PATHS.map((m) => path.join(root, m)),
    ...GLOBAL_MCP_PATHS.map(inHome),
  ].filter((f) => existsSync(f));
  for (const file of files)
    for (const server of serversIn(file, root))
      if (server.name === name && server.launch !== undefined) return server.launch;
  return undefined;
};

export const detectStack = (root: string): DetectedStack => {
  const at = (rel: string): string => path.join(root, rel);
  const manifests = MANIFESTS.filter((m) => existsSync(at(m)));
  const lintConfigs = findLintConfigs(root);
  const mcpServers = MCP_PATHS.filter((m) => existsSync(at(m))).flatMap((m) =>
    serversIn(at(m), root).map((s) => `${m}:${s.name}`),
  );
  const skills = SKILL_DIRS.filter((d) => existsSync(at(d)));
  const globalMcp = GLOBAL_MCP_PATHS.flatMap((m) => {
    const file = inHome(m);
    // The "~/" spelling stays in the entry so it can be listed as a rubric source.
    return existsSync(file) ? serversIn(file, root).map((s) => `${m}:${s.name}`) : [];
  });
  const pkgScripts = existsSync(at("package.json")) ? namesIn(at("package.json")) : [];
  const scriptSkills = pkgScripts.filter((s) =>
    /^(lint|check|test|typecheck|guard|validate)/.test(s),
  );
  return {
    manifests,
    lintConfigs,
    mcpServers: [...new Set([...mcpServers, ...globalMcp])],
    skills: [...skills, ...scriptSkills.map((s) => `package.json#scripts.${s}`)],
  };
};

export type TierRoute =
  | { tier: 1 | 3; trigger: string; action: string }
  | { tier: 2; trigger: string; action: string; mcp: McpRoute };

/** The migration guard init looks for: a named MCP server's validate tool. */
const MIGRATION_GUARD = {
  trigger: "{prisma/migrations,drizzle}/**",
  mcp: { server: "postgres-inspector", tool: "validate_migration" },
} satisfies { trigger: string; mcp: McpRoute };

/** Thin adapter: detected stack → tier routes; init records the tier-2 guard in the rubric. */
export const routesFor = (stack: DetectedStack, root: string): TierRoute[] => {
  const routes: TierRoute[] = [];
  if (
    stack.lintConfigs.length > 0 ||
    stack.manifests.some((m) => /tsconfig|Cargo|ruff|pyproject/.test(m))
  ) {
    routes.push({
      tier: 1,
      trigger: "src/**/*",
      action: "overlaps-pattern fast path (Tier 1); full linter in audit/check",
    });
  }
  // Only a route whose guard is really here: the server is configured in a host MCP config.
  if (routeGaps(root, { server: MIGRATION_GUARD.mcp.server }, stack.mcpServers).length === 0) {
    routes.push({
      tier: 2,
      trigger: MIGRATION_GUARD.trigger,
      action: "Migration files must pass the validate_migration guard",
      mcp: MIGRATION_GUARD.mcp,
    });
  }
  routes.push({ tier: 3, trigger: "**/*", action: "Jev micro-eval over rubric.json" });
  return routes;
};
