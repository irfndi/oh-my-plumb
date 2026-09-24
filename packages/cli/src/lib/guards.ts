import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Rule } from "oh-my-plumb-schema";
import { z } from "zod";

/**
 * Phase 3: MCP dispatch + skill-as-guardrail execution.
 *
 * Tier 2 routes a file trigger to a guard the user configured:
 * 1. MCP server dispatch — the repo's MCP config maps a trigger to a
 *    server+tool; the hook spawns the configured command with a hard
 *    deadline and parses one JSON line of `{ isError, content }`.
 *    No response (timeout, bad JSON, missing binary) = silent pass + logged
 *    skip. An MCP guard NEVER breaks the agent by failing.
 * 2. Skill guardrail — an executable script under a discovered skills dir
 *    (`<dir>/<name>/guard.{mjs,js,sh}`), run with `$FILE_PATH` in env,
 *    same deadline + silent-pass contract.
 *
 * Rubric guard checks (recorded by `init`) declare the trigger→guard mapping;
 * this module executes them, and every hit names the rule that owns it.
 */

// Rejecting an odd content shape would turn an isError hit into a silent pass.
const guardOutputSchema = z.object({ isError: z.boolean(), content: z.unknown().optional() });

export type McpRoute = { server: string; tool: string; command: string[] };
/** One guard check resolved for routing: where it triggers, what runs, which rule owns it. */
export type GuardRoute = {
  /** The owning rubric rule: the id a guard hit reports. */
  ruleId: string;
  trigger: string;
  command?: string[];
  server?: string;
  /** Resolved skill guard entry: the absolute path of `<dir>/<name>/guard.*`. */
  skill?: string;
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

export const routesForFile = (routes: readonly GuardRoute[], file: string): GuardRoute[] =>
  routes.filter((r) => matches(r.trigger, file));

/** Parse one JSON line of `{ isError, content }` from a guard process. */
export const parseGuardOutput = (
  text: string,
): { isError: boolean; content: string } | undefined => {
  try {
    const last = text.trim().split("\n").pop() ?? "";
    if (last === "") return undefined;
    const result = guardOutputSchema.safeParse(JSON.parse(last));
    if (!result.success) return undefined;
    const v = result.data;
    const content = Array.isArray(v.content)
      ? v.content
          .flatMap((p: unknown) =>
            typeof p === "object" && p !== null && "text" in p ? [String(p.text)] : [],
          )
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

/** Guard routes from the rubric: one per guard check, keyed to the rule that owns it. */
export const guardRoutes = (rules: readonly Rule[], root: string): GuardRoute[] =>
  rules.flatMap((rule) => {
    if (rule.status !== "active" || rule.check.type !== "guard") return [];
    const { command, server, skill, scope } = rule.check;
    const entry = skill === undefined ? undefined : resolveSkillGuard(root, SKILL_DIRS, skill);
    return [
      {
        ruleId: rule.id,
        trigger: scope,
        ...(command === undefined ? {} : { command }),
        ...(server === undefined ? {} : { server }),
        ...(entry === undefined ? {} : { skill: entry }),
      },
    ];
  });

/** The local file a guard command runs, or undefined when the command is not a local script. */
const commandFile = (command: readonly string[]): string | undefined => {
  const first = command[0];
  if (first === "node") return command.slice(1).find((arg) => !arg.startsWith("-"));
  // ponytail: only local script targets are checked; a bare binary would need a PATH walk
  return first !== undefined && first.includes("/") ? first : undefined;
};

/**
 * Read-only: why a configured guard cannot run here; empty means it resolves.
 * A skill route only parses when its guard file already resolved, so only a
 * guard whose server or script is gone, and one with no command, are missing.
 */
export const routeGaps = (
  root: string,
  route: Pick<GuardRoute, "command" | "server" | "skill">,
  mcpServers: readonly string[],
): string[] => {
  const gaps: string[] = [];
  const { command, server, skill } = route;
  if (server !== undefined && !mcpServers.some((detected) => detected.endsWith(`:${server}`)))
    gaps.push(`MCP server "${server}" is not configured here`);
  if (command !== undefined) {
    const file = commandFile(command);
    if (command[0] === "node" && file === undefined)
      gaps.push(`command "${command.join(" ")}" names no script`);
    else if (file !== undefined && !existsSync(path.resolve(root, file)))
      gaps.push(`${file} does not exist`);
  } else if (skill === undefined) {
    gaps.push("no guard command resolves here");
  }
  return gaps;
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
