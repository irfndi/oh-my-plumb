import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * Phase 3: MCP dispatch + skill-as-guardrail execution.
 *
 * Tier 2 routes a file trigger to an external guard in priority order:
 * 1. Local validator (tier2.ts) — sync, microsecond, no spawn. Always first.
 * 2. MCP server dispatch — the repo's MCP config maps a trigger to a
 *    server+tool; the hook spawns the configured command with a hard
 *    deadline and parses one JSON line of `{ isError, content }`.
 *    No response (timeout, bad JSON, missing binary) = silent pass + logged
 *    skip. An MCP guard NEVER breaks the agent by failing.
 * 3. Skill guardrail — an executable script under a discovered skills dir
 *    (`<dir>/<name>/guard.{mjs,js,sh}`), run with `$FILE_PATH` in env,
 *    same deadline + silent-pass contract.
 *
 * rules.yaml (written by `init`) declares the trigger→guard mapping;
 * this module executes it. rubric.json stays the Tier-3 store.
 */

export type McpRoute = { server: string; tool: string; command: string[] };
export type SkillRoute = { name: string; entry: string };
export type Tier2Route = {
  trigger: string;
  mcp?: McpRoute;
  skill?: SkillRoute;
};

export type GuardHit = { ruleId: string; source: string; reason: string };

const toRegExp = (glob: string): RegExp | undefined => {
  try {
    const escaped = glob
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    return new RegExp(`^${escaped}$`);
  } catch {
    return undefined;
  }
};

const matches = (trigger: string, file: string): boolean => {
  for (const part of trigger.split(/\s+/).filter(Boolean)) {
    const brace = part.match(/^\{(.+)\}(.*)$/);
    const alts =
      brace?.[1] === undefined ? [part] : brace[1].split(",").map((a) => `${a}${brace[2] ?? ""}`);
    for (const alt of alts) {
      const re = toRegExp(alt.trim());
      if (re?.test(file)) return true;
    }
  }
  return false;
};

export const routesForFile = (routes: readonly Tier2Route[], file: string): Tier2Route[] =>
  routes.filter((r) => matches(r.trigger, file));

/** Parse one JSON line of `{ isError, content }` from a guard process. */
export const parseGuardOutput = (
  text: string,
): { isError: boolean; content: string } | undefined => {
  try {
    const last = text.trim().split("\n").pop() ?? "";
    if (last === "") return undefined;
    const v = JSON.parse(last) as { isError?: unknown; content?: unknown };
    if (typeof v.isError !== "boolean") return undefined;
    const content = Array.isArray(v.content)
      ? v.content
          .filter((p) => p && typeof p === "object" && "text" in p)
          .map((p) => String((p as { text: unknown }).text))
          .join("\n")
      : typeof v.content === "string"
        ? v.content
        : JSON.stringify(v.content ?? "");
    return { isError: v.isError, content };
  } catch {
    return undefined;
  }
};

/** Resolve a skill guard entry under known skills dirs. Returns absolute path or undefined. */
export const resolveSkillGuard = (
  root: string,
  skillDirs: readonly string[],
  name: string,
): string | undefined => {
  for (const dir of skillDirs) {
    for (const entry of [`guard.mjs`, `guard.js`, `guard.sh`]) {
      const p = path.join(root, dir, name, entry);
      if (existsSync(p)) return p;
    }
  }
  return undefined;
};

export const SKILL_DIRS = [".pi/skills", "skills", ".claude/skills"];

/** Read rules.yaml routes section (minimal line parser; full YAML is Phase-4 polish). */
export const readTier2Routes = (root: string): Tier2Route[] => {
  let text: string;
  try {
    text = readFileSync(path.join(root, ".oh-my-plumb", "rules.yaml"), "utf8");
  } catch {
    return [];
  }
  const routes: Tier2Route[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const tier = line.match(/^\s*-\s*tier:\s*(\d+)/);
    i += 1;
    if (!tier || tier[1] !== "2") continue;
    const trigger = (lines[i - 1]?.match(/trigger:\s*"([^"]+)"/)?.[1] ?? "").trim();
    let mcp: McpRoute | undefined;
    let skill: SkillRoute | undefined;
    while (i < lines.length && !/^\s*-\s*tier:/.test(lines[i] ?? "")) {
      const l = lines[i] ?? "";
      const m = l.match(/mcp:\s*(\S+)\s+(\S+)\s+(.+)/);
      if (m?.[1] !== undefined && m[2] !== undefined && m[3] !== undefined) {
        mcp = { server: m[1], tool: m[2], command: m[3].split(/\s+/) };
      }
      const s = l.match(/skill:\s*(\S+)/);
      if (s?.[1] !== undefined) {
        const entry = resolveSkillGuard(root, SKILL_DIRS, s[1]);
        if (entry !== undefined) skill = { name: s[1], entry };
      }
      i += 1;
    }
    if (trigger !== "")
      routes.push({
        trigger,
        ...(mcp === undefined ? {} : { mcp }),
        ...(skill === undefined ? {} : { skill }),
      });
  }
  return routes;
};

/** Guard deadline: a guard that hangs is a skip, never a hold. */
export const GUARD_TIMEOUT_MS = 2_000;

/**
 * Run one guard command with FILE_PATH in env and the file text on stdin.
 * Resolves a block hit, or undefined on pass/timeout/bad-output/missing-binary.
 */
export const runGuard = (
  ruleId: string,
  source: string,
  command: string[],
  file: string,
  text: string,
  timeoutMs = GUARD_TIMEOUT_MS,
): Promise<GuardHit | undefined> =>
  new Promise((resolve) => {
    const [bin, ...args] = command;
    if (bin === undefined) {
      resolve(undefined);
      return;
    }
    let settled = false;
    const done = (v: GuardHit | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    let child;
    try {
      child = spawn(bin, args, {
        env: { ...process.env, FILE_PATH: file },
        stdio: ["pipe", "pipe", "ignore"],
      });
    } catch {
      done(undefined);
      return;
    }
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done(undefined);
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", () => done(undefined));
    child.on("close", () => {
      const out = parseGuardOutput(Buffer.concat(chunks).toString("utf8"));
      if (out?.isError) {
        done({ ruleId, source, reason: `${source}: ${file}: ${out.content.slice(0, 500)}` });
      } else {
        done(undefined);
      }
    });
    try {
      child.stdin.end(text);
    } catch {
      done(undefined);
    }
  });
