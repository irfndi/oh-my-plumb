import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { assertNever, type Rule } from "oh-my-plumb-schema";
import { z } from "zod";
import { callMcpGuard, type McpLaunch } from "./mcp.js";
import { debug } from "./output.js";

/**
 * Phase 3: MCP dispatch + skill-as-guardrail execution.
 *
 * Tier 2 routes a file trigger to a guard the user configured:
 * 1. MCP server dispatch: a guard check names a server and a tool; the hook
 *    starts that server the way the host's own MCP config does and speaks
 *    real MCP (initialize handshake, then tools/call) under a hard deadline.
 *    A guard check may instead carry a `command` that prints one JSON line
 *    of `{ isError, content }`. No answer (timeout, bad output, missing
 *    server) = silent pass + logged skip. A guard NEVER breaks the agent.
 * 2. Skill guardrail — an executable script under a discovered skills dir
 *    (`<dir>/<name>/guard.{mjs,js,sh}`), run with `$FILE_PATH` in env,
 *    same deadline + silent-pass contract.
 *
 * Rubric guard checks (recorded by `init`) declare the trigger→guard mapping;
 * this module executes them, and every hit names the rule that owns it.
 */

// Rejecting an odd content shape would turn an isError hit into a silent pass.
const guardOutputSchema = z.object({ isError: z.boolean(), content: z.unknown().optional() });

export type McpRoute = { server: string; tool: string };
/** One guard check resolved for routing: where it triggers, what runs, which rule owns it. */
export type GuardRoute = {
  /** The owning rubric rule: the id a guard hit reports. */
  ruleId: string;
  trigger: string;
  command?: string[];
  server?: string;
  tool?: string;
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

/** Narrow one `{ isError, content }` result, shared by the line and MCP paths. */
export const guardOutputOf = (
  value: unknown,
): { isError: boolean; content: string } | undefined => {
  const result = guardOutputSchema.safeParse(value);
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
};

/** Parse one JSON line of `{ isError, content }` from a guard process. */
export const parseGuardOutput = (
  text: string,
): { isError: boolean; content: string } | undefined => {
  try {
    const last = text.trim().split("\n").pop() ?? "";
    if (last === "") return undefined;
    return guardOutputOf(JSON.parse(last));
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
    const { command, server, tool, skill, scope } = rule.check;
    const entry = skill === undefined ? undefined : resolveSkillGuard(root, SKILL_DIRS, skill);
    return [
      {
        ruleId: rule.id,
        trigger: scope,
        ...(command === undefined ? {} : { command }),
        ...(server === undefined ? {} : { server }),
        ...(tool === undefined ? {} : { tool }),
        ...(entry === undefined ? {} : { skill: entry }),
      },
    ];
  });

/** What a guard command runs, as far as a gap check can tell without running it. */
type CommandTarget =
  | { kind: "script"; file: string }
  | { kind: "inline" }
  | { kind: "unchecked" }
  | { kind: "none" };

const NODE_INLINE = new Set(["-e", "--eval", "-p", "--print"]);

const commandTarget = (command: readonly string[]): CommandTarget => {
  const first = command[0];
  if (first === "node") {
    const args = command.slice(1);
    if (args.some((arg) => NODE_INLINE.has(arg))) return { kind: "inline" };
    const file = args.find((arg) => !arg.startsWith("-"));
    return file === undefined ? { kind: "none" } : { kind: "script", file };
  }
  // ponytail: only local script targets are checked; a bare binary would need a PATH walk
  return first !== undefined && first.includes("/")
    ? { kind: "script", file: first }
    : { kind: "unchecked" };
};

/**
 * Read-only: why a configured guard cannot run here; empty means it resolves.
 * A skill route only parses when its guard file already resolved, so only a
 * guard whose server or script is gone, and one with nothing to run, are missing.
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
    const target = commandTarget(command);
    switch (target.kind) {
      case "script":
        if (!existsSync(path.resolve(root, target.file)))
          gaps.push(`${target.file} does not exist`);
        break;
      case "none":
        gaps.push(`command "${command.join(" ")}" names no script`);
        break;
      case "inline":
      case "unchecked":
        break;
      default:
        assertNever(target);
    }
  } else if (skill === undefined && server === undefined) {
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
  cwd?: string,
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
        cwd,
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

/**
 * MCP guard: call the tool on a server started from the host's own MCP config.
 * `launch` is undefined when no config names that server; that, like every
 * protocol failure, is a silent pass with a logged skip.
 */
export const runMcpGuard = async (
  ruleId: string,
  launch: McpLaunch | undefined,
  route: McpRoute,
  cwd: string,
  file: string,
  text: string,
  timeoutMs = GUARD_TIMEOUT_MS,
): Promise<GuardHit | undefined> => {
  if (launch === undefined) {
    debug(`mcp guard skipped: server "${route.server}" not found in host MCP config`);
    return undefined;
  }
  const result = await callMcpGuard(
    launch,
    cwd,
    route.tool,
    { file_path: file, content: text },
    timeoutMs,
  );
  const out = result === undefined ? undefined : guardOutputOf(result);
  if (out?.isError !== true) return undefined;
  return { ruleId, source: ruleId, reason: `${ruleId}: ${file}: ${out.content.slice(0, 500)}` };
};
