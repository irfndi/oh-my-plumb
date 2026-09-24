import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  MAX_TASK_CHARS,
  SESSION_STATE_MAX_AGE_MS,
  MAX_TOOL_CALLS_PER_TURN,
  MAX_TOOL_STRING_CHARS,
  MAX_TOOL_SUMMARY_CHARS,
} from "./constants.js";
import { sessionsDir } from "./paths.js";

/**
 * Turn state on disk, one directory per session and prompt, written as
 * first-write-wins files. Hooks for parallel tool calls run at the same time,
 * so nothing here is read, changed and written back: a file's start-of-turn
 * content is created once with `wx`, and a counter is the number of files
 * with its prefix, each created with `wx`.
 */

const safe = (part: string): string => part.replace(/[^A-Za-z0-9_-]/g, "_");
const shortHash = (value: string): string =>
  createHash("sha256").update(value).digest("hex").slice(0, 24);

export const NO_PROMPT_TURN = "turn";
/** Where a payload that never named a session keeps its turn state; hosts mint opaque session ids, so this name is theirs alone. */
export const NO_SESSION_ID = "_no-session";

export const turnDir = (sessionId: string, promptId: string | undefined): string =>
  path.join(sessionsDir(), safe(sessionId), safe(promptId ?? NO_PROMPT_TURN));

const fileStartSchema = z.object({ path: z.string(), original: z.string().nullable() });
export type FileStart = z.infer<typeof fileStartSchema>;

// Owner-only: a start-of-turn snapshot holds whatever the agent edited.
const writePrivate = (file: string, contents: string, flag: "w" | "wx" = "w"): void => {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, contents, { flag, mode: 0o600 });
};

const createOnce = (file: string, contents: string): boolean => {
  try {
    writePrivate(file, contents, "wx");
    return true;
  } catch {
    return false;
  }
};

const countWithPrefix = (dir: string, prefix: string): number => {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix)).length;
  } catch {
    return 0;
  }
};

/** Bumps a counter by creating the next numbered file. Two hooks racing both land: each retries past the other's number. */
const increment = (dir: string, prefix: string): number => {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const next = countWithPrefix(dir, prefix) + 1;
    if (createOnce(path.join(dir, `${prefix}${next}`), "")) return next;
  }
  return countWithPrefix(dir, prefix);
};

/** The content a file had when this turn first touched it. Only the first record counts. */
export const recordFileStart = (
  dir: string,
  absolutePath: string,
  original: string | null,
): void => {
  const record: FileStart = { path: absolutePath, original };
  createOnce(path.join(dir, "files", `${shortHash(absolutePath)}.json`), JSON.stringify(record));
};

const readRecords = <T>(dir: string, schema: z.ZodType<T>): T[] => {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: T[] = [];
  for (const name of names) {
    try {
      const parsed = schema.safeParse(JSON.parse(readFileSync(path.join(dir, name), "utf8")));
      if (parsed.success) records.push(parsed.data);
    } catch {
      // torn
    }
  }
  return records;
};

export const readFileStarts = (dir: string): FileStart[] =>
  readRecords(path.join(dir, "files"), fileStartSchema);

/** Stop judges these again: a block the agent ignored must not end the turn quietly. */
export const recordBlockedFile = (dir: string, relativePath: string): void => {
  createOnce(path.join(dir, "blocked", shortHash(relativePath)), relativePath);
};

export const readBlockedFiles = (dir: string): Set<string> => {
  const files = new Set<string>();
  try {
    for (const name of readdirSync(path.join(dir, "blocked"))) {
      try {
        files.add(readFileSync(path.join(dir, "blocked", name), "utf8"));
      } catch {
        // being written by the other hook
      }
    }
  } catch {
    // no blocks this turn
  }
  return files;
};

const checkedSchema = z.object({
  path: z.string(),
  /** Null when the file did not exist. */
  before: z.string().nullable(),
  after: z.string(),
});
/** An edit a check judged, as blob ids on either side of it. */
export type CheckedEdit = z.infer<typeof checkedSchema>;

/** All kept: Stop walks them as a chain from turn start to the file as it stands. */
export const recordChecked = (dir: string, record: CheckedEdit): void => {
  const contents = JSON.stringify(record);
  createOnce(path.join(dir, "checked", `${shortHash(contents)}.json`), contents);
};

export const readChecked = (dir: string): CheckedEdit[] =>
  readRecords(path.join(dir, "checked"), checkedSchema);

const toolCallEntrySchema = z.object({
  order: z.number().int().positive(),
  name: z.string().min(1).max(100),
  summary: z.string().max(MAX_TOOL_SUMMARY_CHARS),
});
/** One entry of the turn's tool-call log: which tool ran, in what order, with what shape of input. */
export type ToolCallEntry = z.infer<typeof toolCallEntrySchema>;

/** Fields that carry file text in some host's edit call: always reduced to their length, however short. */
const CONTENT_KEYS = new Set([
  "content",
  "old_string",
  "new_string",
  "oldString",
  "newString",
  "oldText",
  "newText",
  "patchText",
]);

const summaryValue = (value: unknown, depth: number, key?: string): string => {
  if (typeof value === "string") {
    if (value.length > MAX_TOOL_STRING_CHARS || (key !== undefined && CONTENT_KEYS.has(key)))
      return `[${value.length} chars]`;
    return value.replace(/\s+/g, " ").trim();
  }
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (depth <= 0) return `[${value.length} items]`;
    const head = value.slice(0, 3).map((item) => summaryValue(item, depth - 1));
    const more = value.length > 3 ? `, +${value.length - 3} more` : "";
    return `[${head.join(", ")}${more}]`;
  }
  if (typeof value === "object") {
    if (depth <= 0) return "{...}";
    // Walks at most nine keys, so a huge input costs no more than a small one.
    const head: string[] = [];
    let more = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (head.length === 8) {
        more = true;
        break;
      }
      const item: unknown = Reflect.get(value, key);
      head.push(`${key}=${summaryValue(item, depth - 1, key)}`);
    }
    return `{${head.join(", ")}${more ? ", ..." : ""}}`;
  }
  return String(value);
};

/** Names and argument shapes only: a long string, or any file-text field, collapses to "[N chars]", so no file body lands in the log. */
export const callSummary = (input: unknown): string => {
  const rendered = summaryValue(input, 3);
  return rendered.length <= MAX_TOOL_SUMMARY_CHARS
    ? rendered
    : `${rendered.slice(0, MAX_TOOL_SUMMARY_CHARS - 3)}...`;
};

const toolCallsDir = (dir: string): string => path.join(dir, "tool-calls");

/** One call joins the turn's log, numbered in call order and capped at the turn's bound. First-write-wins files, like the rest of the turn state. */
export const recordToolCall = (dir: string, name: string, input: unknown): void => {
  try {
    const calls = toolCallsDir(dir);
    // An apply_patch command is the patch itself, file text and all: only its length is logged.
    const shown =
      name.toLowerCase() === "apply_patch" &&
      typeof input === "object" &&
      input !== null &&
      "command" in input &&
      typeof input.command === "string"
        ? { command: `[${input.command.length} chars]` }
        : input;
    const entry = { name: name.slice(0, 100), summary: callSummary(shown) };
    for (let attempt = 0; attempt < 32; attempt += 1) {
      const order = countWithPrefix(calls, "call.") + 1;
      if (order > MAX_TOOL_CALLS_PER_TURN) return;
      if (
        createOnce(
          path.join(calls, `call.${String(order).padStart(6, "0")}`),
          JSON.stringify({ order, ...entry }),
        )
      )
        return;
    }
  } catch {
    // the log is best effort: absent is fine, held is not
  }
};

/** The turn's log in call order. A missing or corrupt entry degrades to no log, never a throw. */
export const readToolCalls = (dir: string): ToolCallEntry[] => {
  let names: string[];
  try {
    names = readdirSync(toolCallsDir(dir));
  } catch {
    return [];
  }
  const entries: ToolCallEntry[] = [];
  for (const name of names) {
    try {
      const parsed = toolCallEntrySchema.safeParse(
        JSON.parse(readFileSync(path.join(toolCallsDir(dir), name), "utf8")),
      );
      if (parsed.success) entries.push(parsed.data);
    } catch {
      // torn or corrupt: that entry is no log
    }
  }
  return entries.sort((a, b) => a.order - b.order).slice(0, MAX_TOOL_CALLS_PER_TURN);
};

const blockPrefix = (key: string): string => `${shortHash(key)}.`;

export const blockCount = (dir: string, key: string): number =>
  countWithPrefix(path.join(dir, "blocks"), blockPrefix(key));

export const incrementBlock = (dir: string, key: string): number =>
  increment(path.join(dir, "blocks"), blockPrefix(key));

export const stopCheckCount = (dir: string): number =>
  countWithPrefix(path.join(dir, "stops"), "stop.");

export const incrementStopChecks = (dir: string): number =>
  increment(path.join(dir, "stops"), "stop.");

const unknownPayloadPrefix = "unknown-payload.";

export const unknownPayloadCount = (dir: string): number =>
  countWithPrefix(path.join(dir, "unknown"), unknownPayloadPrefix);

export const incrementUnknownPayloads = (dir: string): number =>
  increment(path.join(dir, "unknown"), unknownPayloadPrefix);

/** The prompt that started the turn, for hosts that send it instead of a transcript. */
export const writePrompt = (dir: string, prompt: string): void => {
  createOnce(path.join(dir, "prompt"), prompt);
};

export const readPrompt = (dir: string): string | undefined => {
  try {
    const text = readFileSync(path.join(dir, "prompt"), "utf8").trim();
    return text === "" ? undefined : text.slice(0, MAX_TASK_CHARS);
  } catch {
    return undefined;
  }
};

/** The git tree the working tree was at when the turn began, when a turn-start hook recorded one. */
export const writeBaseline = (dir: string, tree: string): void => {
  createOnce(path.join(dir, "baseline"), tree);
};

export const readBaseline = (dir: string): string | undefined => {
  try {
    const tree = readFileSync(path.join(dir, "baseline"), "utf8").trim();
    return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
  } catch {
    return undefined;
  }
};

/**
 * What became of the turn-start snapshot. Absent on a repository without git,
 * where the per-file fallback is the documented mode. `pending` means the
 * hook died before it could say, which for the Stop check is the same as
 * failed: the turn cannot be read back whole.
 */
export type BaselineStatus = "pending" | "ok" | "failed";

const statusFile = (dir: string): string => path.join(dir, "baseline-status");

export const markBaseline = (dir: string, status: BaselineStatus): void => {
  try {
    writePrivate(statusFile(dir), status);
  } catch {
    // nothing to record on; Stop will see no status and take the fallback
  }
};

export const readBaselineStatus = (dir: string): BaselineStatus | undefined => {
  try {
    const raw = readFileSync(statusFile(dir), "utf8").trim();
    return raw === "ok" || raw === "pending" || raw === "failed" ? raw : undefined;
  } catch {
    return undefined;
  }
};

export const hasTurnState = (dir: string): boolean =>
  readFileStarts(dir).length > 0 ||
  readToolCalls(dir).length > 0 ||
  readBaseline(dir) !== undefined ||
  readBaselineStatus(dir) !== undefined;

export const clearTurn = (dir: string): void => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // already gone
  }
};

export const pruneOldTurns = (now = Date.now()): void => {
  try {
    for (const name of readdirSync(sessionsDir())) {
      const file = path.join(sessionsDir(), name);
      if (now - statSync(file).mtimeMs > SESSION_STATE_MAX_AGE_MS)
        rmSync(file, { recursive: true, force: true });
    }
  } catch {
    // no sessions dir yet
  }
};
