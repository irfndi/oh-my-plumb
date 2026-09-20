import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PlumbError, postToolUseInputSchema } from "oh-my-plumb-schema";
import { MAX_TASK_CHARS } from "./constants.js";
import type { ReplaySession, ReplayTurn } from "./replay.js";

/** Sessions live in SQLite. The `sqlite3` binary reads it so the CLI needs no driver. */
export const opencodeDbPath = (): string =>
  path.join(homedir(), ".local", "share", "opencode", "opencode.db");

export type OpencodeRow = {
  sessionId: string;
  directory: string;
  messageId: string;
  role: string;
  created: number;
  part: string;
};

const asRecord = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record: Record<string, unknown> = { ...value };
  return record;
};

const query = (db: string, sql: string): unknown[] => {
  const result = spawnSync("sqlite3", ["-json", "-readonly", db, sql], {
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.error !== undefined)
    throw new PlumbError(
      "GIT_UNAVAILABLE",
      "sqlite3 is not on PATH, and OpenCode sessions live in a SQLite database",
      {
        cause: result.error,
      },
    );
  if (result.status !== 0)
    throw new PlumbError(
      "GIT_UNAVAILABLE",
      `sqlite3 could not read ${db}: ${result.stderr.trim()}`,
    );
  if (result.stdout.trim() === "") return [];
  const parsed: unknown = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [];
};

export const readOpencodeRows = (db: string): OpencodeRow[] =>
  query(
    db,
    `select s.id as sessionId, s.directory as directory, m.id as messageId,
            json_extract(m.data, '$.role') as role, m.time_created as created, p.data as part
       from part p
       join message m on m.id = p.message_id
       join session s on s.id = m.session_id
      order by s.id, m.time_created, m.id, p.id`,
  ).flatMap((row) => {
    const r = asRecord(row);
    if (
      r === undefined ||
      typeof r.sessionId !== "string" ||
      typeof r.directory !== "string" ||
      typeof r.messageId !== "string" ||
      typeof r.role !== "string" ||
      typeof r.created !== "number" ||
      typeof r.part !== "string"
    )
      return [];
    return [
      {
        sessionId: r.sessionId,
        directory: r.directory,
        messageId: r.messageId,
        role: r.role,
        created: r.created,
        part: r.part,
      },
    ];
  });

/** The same payload the live plugin builds. */
const editPayload = (
  sessionId: string,
  directory: string,
  callId: string,
  tool: string,
  input: Record<string, unknown>,
): unknown => {
  const file = typeof input.filePath === "string" ? input.filePath : "";
  if (file === "") return undefined;
  const file_path = path.isAbsolute(file) ? file : path.join(directory, file);
  const base = {
    session_id: sessionId,
    cwd: directory,
    hook_event_name: "PostToolUse",
    tool_use_id: callId,
  };
  switch (tool) {
    case "edit":
      return {
        ...base,
        tool_name: "Edit",
        tool_input: {
          file_path,
          old_string: String(input.oldString ?? ""),
          new_string: String(input.newString ?? ""),
          replace_all: Boolean(input.replaceAll),
        },
      };
    case "write":
      return {
        ...base,
        tool_name: "Write",
        tool_input: { file_path, content: String(input.content ?? "") },
        tool_response: { filePath: file_path, originalFile: null },
      };
    default:
      return undefined;
  }
};

export const opencodeSessionsFromRows = (
  root: string,
  rows: readonly OpencodeRow[],
): ReplaySession[] => {
  const sessions = new Map<string, ReplaySession & { turnIndex: number; lastMessage?: string }>();
  for (const row of rows) {
    const rel = path.relative(root, row.directory);
    if (rel !== "" && (rel.startsWith("..") || path.isAbsolute(rel))) continue;
    let session = sessions.get(row.sessionId);
    if (session === undefined) {
      session = { file: row.sessionId, cwd: row.directory, turns: [], turnIndex: 0 };
      sessions.set(row.sessionId, session);
    }
    let part: Record<string, unknown> | undefined;
    try {
      part = asRecord(JSON.parse(row.part));
    } catch {
      continue;
    }
    if (part === undefined) continue;
    if (row.role === "user") {
      if (session.lastMessage !== row.messageId) {
        session.lastMessage = row.messageId;
        session.turnIndex += 1;
        session.turns.push({ index: session.turnIndex, prompt: undefined, edits: [] });
      }
      const turn = session.turns.at(-1);
      if (turn !== undefined && part.type === "text" && typeof part.text === "string") {
        const text = part.text.trim();
        if (text !== "" && !text.startsWith("oh-my-plumb:"))
          turn.prompt = `${turn.prompt === undefined ? "" : `${turn.prompt}\n`}${text}`.slice(
            0,
            MAX_TASK_CHARS,
          );
      }
      continue;
    }
    if (part.type !== "tool" || typeof part.tool !== "string" || typeof part.callID !== "string")
      continue;
    const state = asRecord(part.state);
    const input = asRecord(state?.input);
    if (state?.status !== "completed" || input === undefined) continue;
    const payload = editPayload(row.sessionId, row.directory, part.callID, part.tool, input);
    if (payload === undefined) continue;
    const parsed = postToolUseInputSchema.safeParse(payload);
    if (!parsed.success) continue;
    let turn: ReplayTurn | undefined = session.turns.at(-1);
    if (turn === undefined) {
      turn = { index: 0, prompt: undefined, edits: [] };
      session.turns.push(turn);
    }
    turn.edits.push({ turn: turn.index, input: parsed.data });
  }
  return [...sessions.values()]
    .map(({ file, cwd, turns }) => ({ file, cwd, turns: turns.filter((t) => t.edits.length > 0) }))
    .filter((s) => s.turns.length > 0);
};

export const opencodeSessionsFor = (root: string, db = opencodeDbPath()): ReplaySession[] => {
  if (!existsSync(db)) throw new PlumbError("RUBRIC_MISSING", `no OpenCode database at ${db}`);
  return opencodeSessionsFromRows(root, readOpencodeRows(db));
};
