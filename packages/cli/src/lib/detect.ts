import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findLintConfigs } from "./lintConfig.js";
import { homeDir } from "./paths.js";
import { routeGaps, type McpRoute, type Tier2Route } from "./guards.js";

/**
 * Phase 2: zero-config project auto-detection. Inspects the repo and emits
 * the data `oh-my-plumb init` synthesizes into `.oh-my-plumb/rules.yaml`.
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

const MCP_PATHS = [".pi/mcp.json", ".claude/mcp.json", ".codex/mcp.json", ".opencode/mcp.json"];

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

/** MCP server names from a config file, tolerating the common shapes. */
const serversIn = (file: string): string[] => {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    if (raw && typeof raw === "object") {
      const rec = raw as Record<string, unknown>;
      for (const key of ["mcpServers", "servers", "mcp"]) {
        const v = rec[key];
        if (v && typeof v === "object" && !Array.isArray(v)) return Object.keys(v);
      }
      if (Array.isArray(rec.servers)) {
        return rec.servers.flatMap((s) =>
          s && typeof s === "object" && "name" in s && typeof s.name === "string" ? [s.name] : [],
        );
      }
    }
  } catch {}
  return [];
};

export const detectStack = (root: string): DetectedStack => {
  const at = (rel: string): string => path.join(root, rel);
  const manifests = MANIFESTS.filter((m) => existsSync(at(m)));
  const lintConfigs = findLintConfigs(root);
  const mcpServers = MCP_PATHS.filter((m) => existsSync(at(m))).flatMap((m) =>
    serversIn(at(m)).map((s) => `${m}:${s}`),
  );
  const skills = SKILL_DIRS.filter((d) => existsSync(at(d)));
  const globalMcp = ["~/.pi/mcp.json", "~/.claude/mcp.json"]
    .map((m) => (m.startsWith("~/") ? path.join(homeDir(), m.slice(2)) : m))
    .filter((m) => existsSync(m))
    .flatMap((m) => serversIn(m).map((s) => `global:${s}`));
  const pkgScripts = existsSync(at("package.json")) ? namesIn(at("package.json")) : [];
  const scriptSkills = pkgScripts.filter((s) =>
    /^(lint|check|test|typecheck|guard|validate)/.test(s),
  );
  return {
    manifests,
    lintConfigs,
    mcpServers: [...mcpServers, ...globalMcp],
    skills: [...skills, ...scriptSkills.map((s) => `package.json#scripts.${s}`)],
  };
};

export type TierRoute =
  | { tier: 1 | 3; trigger: string; action: string }
  | { tier: 2; trigger: string; action: string; mcp: McpRoute };

/** The migration guard init looks for: a named MCP server running a local script. */
const MIGRATION_GUARD = {
  trigger: "{prisma/migrations,drizzle}/**",
  mcp: {
    server: "postgres-inspector",
    tool: "validate_migration",
    command: ["node", "./scripts/validate-migration.mjs"],
  },
} satisfies Tier2Route;

/** Thin adapter: detected stack → tier routes for rules.yaml. rubric.json stays the Tier-3 store. */
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
  // Only a route whose guard is really here: detected server plus existing script.
  if (routeGaps(root, MIGRATION_GUARD, stack.mcpServers).length === 0) {
    routes.push({
      tier: 2,
      trigger: MIGRATION_GUARD.trigger,
      action: "local migration guard (Tier 2); MCP validate_migration in Phase 3",
      mcp: MIGRATION_GUARD.mcp,
    });
  }
  routes.push({ tier: 3, trigger: "**/*", action: "Jev micro-eval over rubric.json" });
  return routes;
};
