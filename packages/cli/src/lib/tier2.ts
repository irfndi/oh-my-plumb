/**
 * Tier 2 prototype: local synchronous validators, no model call, no MCP
 * network. PostToolUse routes tool input by name; a validator returns a
 * block reason or undefined. Budgets: each validator must finish in
 * microseconds — regex/parse only, never spawn, never fetch.
 */

export type Tier2Result = { ruleId: string; source: string; reason: string };

const DDL = /\b(CREATE\s+TABLE|ALTER\s+TABLE|DROP\s+TABLE|CREATE\s+INDEX)\b/i;
const FK = /REFERENCES\s+["']?(\w+)["']?\s*\(/gi;
const CREATE_TABLE = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?/gi;

const tablesIn = (sql: string): Set<string> => {
  const out = new Set<string>();
  for (const m of sql.matchAll(CREATE_TABLE)) if (m[1] !== undefined) out.add(m[1].toLowerCase());
  return out;
};

const refsIn = (sql: string): string[] => {
  const out: string[] = [];
  for (const m of sql.matchAll(FK)) if (m[1] !== undefined) out.push(m[1]);
  return out;
};

/** Migration guard: every REFERENCES target must be created in the same file or be a known table. */
const validateMigration = (file: string, text: string): Tier2Result | undefined => {
  if (!DDL.test(text)) return undefined;
  const tables = tablesIn(text);
  const known = new Set(["users", "sessions", "events"]);
  for (const t of tables) known.add(t);
  const missing = refsIn(text).filter((r) => !known.has(r.toLowerCase()));
  if (missing.length === 0) return undefined;
  return {
    ruleId: "db-schema-guard",
    source: "tier2:validate_migration",
    reason: `Tier 2 migration guard: ${file} references unknown table(s) ${missing.join(", ")}. Create the table first or fix the reference.`,
  };
};

const MIGRATION_PATH = /(migrations?|prisma\/migrations|drizzle)\//i;

/** Route by tool + file. Returns a block reason or undefined. */
export const tier2Check = (
  toolName: string,
  filePath: string,
  afterText: string | null,
): Tier2Result | undefined => {
  void toolName;
  if (afterText === null) return undefined;
  if (MIGRATION_PATH.test(filePath)) return validateMigration(filePath, afterText);
  return undefined;
};
