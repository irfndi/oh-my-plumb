import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { postToolUseInputSchema } from "oh-my-plumb-schema";
import { MAX_TASK_CHARS } from "./constants.js";
import type { ReplaySession, ReplayTurn } from "./replay.js";

/** One JSONL file per session, in a directory named for the session's cwd. Pi persists no tool results, so the tool call's own arguments are all a replay gets. */
export const piSessionsDir = (): string => path.join(homedir(), ".pi", "agent", "sessions");

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const promptOf = (content: unknown): string | undefined => {
  const text = asList(content)
    .flatMap((c) => {
      const part = asRecord(c);
      return part?.type === "text" && typeof part.text === "string" ? [part.text] : [];
    })
    .join("\n");
  return text.trim() === "" ? undefined : text.slice(0, MAX_TASK_CHARS);
};

/**
 * The hook payload for one edit call. Pi's `write` carries the whole file and
 * its `edit` carries old/new pairs, so both map onto the tool shapes the live
 * hook would have seen; other tools changed nothing this payload can judge.
 */
const editPayload = (
  sessionId: string,
  cwd: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): unknown => {
  const file = typeof args.path === "string" ? args.path : "";
  if (file === "") return undefined;
  const file_path = path.isAbsolute(file) ? file : path.join(cwd, file);
  const base = {
    session_id: sessionId,
    cwd,
    hook_event_name: "PostToolUse",
    tool_use_id: callId,
  };
  switch (name) {
    case "write": {
      if (typeof args.content !== "string") return undefined;
      return {
        ...base,
        tool_name: "Write",
        tool_input: { file_path, content: args.content },
        tool_response: { filePath: file_path, originalFile: null },
      };
    }
    case "edit": {
      // Pi's edit is one call with a list of entries; an entry missing its text changed nothing.
      const edits = asList(args.edits).flatMap((e) => {
        const item = asRecord(e);
        return item !== undefined &&
          typeof item.oldText === "string" &&
          typeof item.newText === "string"
          ? [{ old_string: item.oldText, new_string: item.newText }]
          : [];
      });
      if (edits.length === 0) return undefined;
      return { ...base, tool_name: "MultiEdit", tool_input: { file_path, edits } };
    }
    default:
      return undefined;
  }
};

export const parsePiSession = (file: string): ReplaySession => {
  const turns: ReplayTurn[] = [];
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
    if (entry === undefined) continue;
    if (entry.type === "session" && typeof entry.cwd === "string") cwd ??= entry.cwd;
    if (entry.type !== "message") continue;
    const message = asRecord(entry.message);
    if (message === undefined) continue;
    if (message.role === "user") {
      const prompt = promptOf(message.content);
      if (prompt === undefined) continue;
      turnIndex += 1;
      turns.push({ index: turnIndex, prompt, edits: [] });
      continue;
    }
    for (const part of asList(message.content)) {
      const call = asRecord(part);
      if (call?.type !== "toolCall" || typeof call.name !== "string" || typeof call.id !== "string")
        continue;
      const args = asRecord(call.arguments);
      if (args === undefined) continue;
      const payload = editPayload(sessionId, cwd ?? process.cwd(), call.id, call.name, args);
      if (payload === undefined) continue;
      const parsed = postToolUseInputSchema.safeParse(payload);
      if (!parsed.success) continue;
      const turn = current();
      turn.edits.push({ turn: turn.index, input: parsed.data });
    }
  }
  return { file, cwd: cwd ?? process.cwd(), turns: turns.filter((t) => t.edits.length > 0) };
};

const sessionFiles = (dir: string): string[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const full = path.join(dir, name);
    try {
      if (statSync(full).isDirectory()) return sessionFiles(full);
    } catch {
      return [];
    }
    return name.endsWith(".jsonl") ? [full] : [];
  });
};

const inside = (root: string, dir: string): boolean => {
  const rel = path.relative(root, dir);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export const piSessionsFor = (root: string, dir = piSessionsDir()): ReplaySession[] =>
  sessionFiles(dir)
    .sort()
    .map(parsePiSession)
    .filter((s) => inside(root, s.cwd) && s.turns.length > 0);
