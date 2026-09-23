import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { postToolUseInputSchema } from "oh-my-plumb-schema";
import { MAX_TASK_CHARS } from "./constants.js";
import { callSummary, type ReplayCall, type ReplaySession, type ReplayTurn } from "./replay.js";

/** One rollout file per session, one JSON object per line. An `apply_patch` call carries the same patch text the live hook receives. */
export const codexSessionsDir = (): string => path.join(homedir(), ".codex", "sessions");

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Codex's own additions to a user turn, not prompts. */
const INJECTED = [
  "# AGENTS.md instructions",
  "<environment_context>",
  "<permissions instructions>",
  "<turn_aborted>",
  "\n# Files mentioned by the user",
];

const promptOf = (payload: Record<string, unknown>): string | undefined => {
  const text = asList(payload.content)
    .flatMap((c) => {
      const part = asRecord(c);
      return part?.type === "input_text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
  if (text.trim() === "" || INJECTED.some((prefix) => text.startsWith(prefix))) return undefined;
  return text.slice(0, MAX_TASK_CHARS);
};

const FAILED_OUTPUT = /^apply_patch (verification )?failed|^error/i;

export const parseCodexRollout = (file: string): ReplaySession => {
  const turns: ReplayTurn[] = [];
  const calls: ReplayCall[] = [];
  const pending = new Map<string, { turn: ReplayTurn; command: string }>();
  let cwd: string | undefined;
  let turnIndex = 0;
  const current = (): ReplayTurn => {
    const last = turns.at(-1);
    if (last !== undefined) return last;
    const first: ReplayTurn = { index: 0, prompt: undefined, edits: [] };
    turns.push(first);
    return first;
  };
  const sessionId = path.basename(file, ".jsonl");
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    let entry: Record<string, unknown> | undefined;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      // a torn line, still being written
      continue;
    }
    const payload = asRecord(entry?.payload);
    if (entry === undefined || payload === undefined) continue;
    if (entry.type === "session_meta" && typeof payload.cwd === "string") cwd ??= payload.cwd;
    if (entry.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "user") {
      const prompt = promptOf(payload);
      if (prompt === undefined) continue;
      turnIndex += 1;
      turns.push({ index: turnIndex, prompt, edits: [] });
      continue;
    }
    if (payload.type === "custom_tool_call" && typeof payload.name === "string") {
      calls.push({ tool: payload.name, args: callSummary(payload.input) });
    }
    if (payload.type === "function_call" && typeof payload.name === "string") {
      calls.push({ tool: payload.name, args: callSummary(payload.arguments) });
    }
    if (
      payload.type === "custom_tool_call" &&
      payload.name === "apply_patch" &&
      typeof payload.call_id === "string" &&
      typeof payload.input === "string"
    ) {
      pending.set(payload.call_id, { turn: current(), command: payload.input });
      continue;
    }
    if (payload.type === "custom_tool_call_output" && typeof payload.call_id === "string") {
      const call = pending.get(payload.call_id);
      pending.delete(payload.call_id);
      if (call === undefined) continue;
      // a patch that did not apply changed nothing
      if (typeof payload.output === "string" && FAILED_OUTPUT.test(payload.output)) continue;
      const parsed = postToolUseInputSchema.safeParse({
        session_id: sessionId,
        cwd: cwd ?? process.cwd(),
        hook_event_name: "PostToolUse",
        tool_name: "apply_patch",
        tool_use_id: payload.call_id,
        tool_input: { command: call.command },
      });
      if (parsed.success) call.turn.edits.push({ turn: call.turn.index, input: parsed.data });
    }
  }
  return {
    file,
    cwd: cwd ?? process.cwd(),
    turns: turns.filter((t) => t.edits.length > 0),
    calls,
  };
};

const rolloutFiles = (dir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) return rolloutFiles(full);
    } catch {
      return [];
    }
    return name.startsWith("rollout-") && name.endsWith(".jsonl") ? [full] : [];
  });
};

const inside = (root: string, dir: string): boolean => {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const codexSessionsFor = (root: string, dir = codexSessionsDir()): ReplaySession[] =>
  rolloutFiles(dir)
    .sort()
    .map(parseCodexRollout)
    .filter((s) => inside(root, s.cwd) && (s.turns.length > 0 || s.calls.length > 0));
