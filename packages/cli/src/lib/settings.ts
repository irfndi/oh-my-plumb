import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PlumbError, type Host } from "oh-my-plumb-schema";

const hookEntrySchema = z
  .object({ type: z.string(), command: z.string().optional() })
  .passthrough();
const hookGroupSchema = z
  .object({ matcher: z.string().optional(), hooks: z.array(hookEntrySchema) })
  .passthrough();
const settingsSchema = z
  .object({ hooks: z.record(z.string(), z.array(hookGroupSchema)).optional() })
  .passthrough();
type Settings = z.infer<typeof settingsSchema>;
type HookEntry = z.infer<typeof hookEntrySchema>;
type HookGroup = z.infer<typeof hookGroupSchema>;

export const OH_MY_PLUMB_HOOK_MARKER = "oh-my-plumb-hook.js";

export type HookEvent = "SessionStart" | "UserPromptSubmit" | "PreToolUse" | "PostToolUse" | "Stop";

export type HookSpec = { event: HookEvent; matcher?: string; command: string; timeout: number };

export const hookSpecs = (
  hookScript: string,
  opts?: { host: Host; toolCallRules: boolean },
): HookSpec[] => {
  const cmd = (name: string): string => `node "${hookScript}" ${name}`;
  const editMatcher = "Edit|Write|MultiEdit|apply_patch";
  // A rubric with a tool-call rule needs shell and MCP calls delivered too:
  // Claude names them Bash and mcp__server__tool, Codex shell. A skill load (Claude's
  // Skill) is only logged after it runs, never judged before, so it joins PostToolUse alone.
  const toolCallRules = opts?.toolCallRules ?? false;
  const toolMatcher = opts?.host === "claude" ? "Bash|mcp__.*" : "shell";
  const logMatcher = opts?.host === "claude" ? `${toolMatcher}|Skill` : toolMatcher;
  const matcher = toolCallRules ? `${editMatcher}|${logMatcher}` : editMatcher;
  const specs: HookSpec[] = [
    { event: "SessionStart", command: cmd("session-start"), timeout: 10 },
    { event: "UserPromptSubmit", command: cmd("turn-start"), timeout: 10 },
  ];
  // The pre-execution hook exists only while something can judge a call; a
  // rubric without a tool-call rule gives it nothing to decide.
  if (toolCallRules) {
    specs.push({
      event: "PreToolUse",
      matcher: toolMatcher,
      command: cmd("pre-tool-use"),
      timeout: 20,
    });
  }
  specs.push(
    { event: "PostToolUse", matcher, command: cmd("post-tool-use"), timeout: 20 },
    { event: "Stop", command: cmd("stop"), timeout: 30 },
  );
  return specs;
};

const isOurs = (entry: HookEntry): boolean =>
  entry.command?.includes(OH_MY_PLUMB_HOOK_MARKER) ?? false;

/** Whether oh-my-plumb's hooks are installed in this settings file. */
export const hasOurHooks = (file: string): boolean =>
  Object.values(readSettings(file).hooks ?? {}).some((groups) =>
    (groups ?? []).some((group) => group.hooks.some(isOurs)),
  );

/** A group shared with someone else's hook keeps theirs. */
const withoutOurs = (groups: readonly HookGroup[]): { kept: HookGroup[]; removed: number } => {
  const kept: HookGroup[] = [];
  let removed = 0;
  for (const group of groups) {
    const hooks = group.hooks.filter((h) => !isOurs(h));
    removed += group.hooks.length - hooks.length;
    if (hooks.length > 0) kept.push({ ...group, hooks });
  }
  return { kept, removed };
};

export const readSettings = (file: string): Settings => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return {};
  }
  if (raw.trim() === "") return {};
  try {
    return settingsSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new PlumbError(
      "SETTINGS_INVALID",
      `${file} is not a settings file oh-my-plumb can edit`,
      {
        cause: error,
      },
    );
  }
};

export const installHooks = (file: string, specs: readonly HookSpec[]): void => {
  const settings = readSettings(file);
  // Ours are rewritten whole: an event the specs no longer name (PreToolUse after the
  // rubric lost its tool-call rules) must not keep a stale entry.
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks ?? {})) {
    const { kept } = withoutOurs(groups ?? []);
    if (kept.length > 0) hooks[event] = kept;
  }
  for (const spec of specs) {
    const kept = hooks[spec.event] ?? [];
    const group: HookGroup = {
      ...(spec.matcher === undefined ? {} : { matcher: spec.matcher }),
      hooks: [{ type: "command", command: spec.command, timeout: spec.timeout }],
    };
    hooks[spec.event] = [...kept, group];
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
};

export const uninstallHooks = (file: string): number => {
  const settings = readSettings(file);
  if (settings.hooks === undefined) return 0;
  let removed = 0;
  const hooks: Record<string, HookGroup[]> = {};
  for (const [event, groups] of Object.entries(settings.hooks)) {
    const result = withoutOurs(groups);
    removed += result.removed;
    if (result.kept.length > 0) hooks[event] = result.kept;
  }
  writeFileSync(file, `${JSON.stringify({ ...settings, hooks }, null, 2)}\n`);
  return removed;
};

export const installedHookEvents = (file: string): HookEvent[] => {
  const settings = readSettings(file);
  const events: HookEvent[] = [];
  for (const event of [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "Stop",
  ] satisfies HookEvent[]) {
    if ((settings.hooks?.[event] ?? []).some((g) => g.hooks.some(isOurs))) events.push(event);
  }
  return events;
};
