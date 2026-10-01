import { closeSync, mkdirSync, readFileSync, readSync, renameSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { eventSchema, toolNameSchema, type PlumbEvent } from "oh-my-plumb-schema";
import { EVENTS_LOG_MAX_BYTES, MAX_UNKNOWN_PAYLOADS_PER_TURN } from "./constants.js";
import { findRepoRoot, ohMyPlumbDir, eventsPath } from "./paths.js";
import { openRegular, writeRegularFile } from "./regularFile.js";
import {
  incrementUnknownPayloads,
  turnDir,
  unknownPayloadCount,
  NO_SESSION_ID,
} from "./session.js";

/** Names a rejected payload may still carry; every other field it sent is dropped unread. */
const rejectedPayloadSchema = z.object({
  cwd: z.unknown().optional(),
  session_id: z.unknown().optional(),
  prompt_id: z.unknown().optional(),
  turn_id: z.unknown().optional(),
  tool_name: z.unknown().optional(),
  tool: z.unknown().optional(),
});

const firstString = (...values: readonly unknown[]): string | undefined =>
  values.find((value): value is string => typeof value === "string");

/** Best effort. The log must never take the hook down with it, or hold it. */
export const appendEvent = (root: string, event: PlumbEvent): void => {
  try {
    mkdirSync(ohMyPlumbDir(root), { recursive: true });
    writeRegularFile(eventsPath(root), `${JSON.stringify(event)}\n`, { use: "append" });
  } catch {
    // nothing to do: logging is optional
  }
};

/**
 * Reads a byte window ending at the file's end, without holding the whole file
 * in memory: a legacy log can be tens of megabytes.
 */
const readTail = (file: string, bytes: number): string | undefined => {
  const opened = openRegular(file);
  if (opened === undefined) return undefined;
  const { fd, size } = opened;
  try {
    const start = Math.max(0, size - bytes);
    const length = size - start;
    const buffer = Buffer.alloc(length);
    let read = 0;
    while (read < length) {
      const count = readSync(fd, buffer, read, length - read, start + read);
      if (count === 0) break;
      read += count;
    }
    return buffer.toString("utf8", 0, read);
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};

/**
 * Keeps the event log at a bounded size: past the cap, session start rewrites
 * it to its newest cap-sized window, cut on a line boundary, keeping only
 * lines the schema still accepts. One pass lands under the cap whatever the
 * log had grown to, and what report and tune read — recent checks — stays.
 * The rename is atomic and any check appended mid-trim is telemetry, safe to
 * lose. Best effort, like every reader and writer of this file.
 */
export const trimEvents = (root: string, maxBytes = EVENTS_LOG_MAX_BYTES): void => {
  try {
    const file = eventsPath(root);
    const opened = openRegular(file);
    if (opened === undefined) return;
    const { size } = opened;
    closeSync(opened.fd);
    if (size <= maxBytes) return;
    const raw = readTail(file, maxBytes);
    if (raw === undefined) return;
    const firstNewline = raw.indexOf("\n");
    if (firstNewline === -1) return;
    const kept: string[] = [];
    for (const line of raw.slice(firstNewline + 1).split("\n")) {
      if (line.trim() === "") continue;
      try {
        if (eventSchema.safeParse(JSON.parse(line)).success) kept.push(line);
      } catch {
        // a torn line is dropped here for good
      }
    }
    // Same directory, so the rename cannot cross a filesystem; a fixed name
    // because a rename replaces whole, and a crashed trim leaves one file.
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, kept.length === 0 ? "" : `${kept.join("\n")}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    // housekeeping must never take the hook down
  }
};

/**
 * A payload the schema rejected, kept as a name only — never its input, its
 * output, or its content — so `report` can count host drift instead of showing
 * silence. The per-turn cap stops a host stuck in a loop from filling the log.
 * Like appendEvent, best effort: this signal must never fail the hook.
 */
export const appendUnknownPayload = (payload: unknown): void => {
  try {
    const fields = rejectedPayloadSchema.safeParse(payload);
    if (!fields.success) return;
    const tool = toolNameSchema.safeParse(firstString(fields.data.tool_name, fields.data.tool));
    if (!tool.success) return;
    // Every real payload carries cwd; without it there is no honest repo to
    // write to, and a guess would drop drift into the wrong repository.
    const cwd = firstString(fields.data.cwd);
    if (cwd === undefined) return;
    const sessionId = firstString(fields.data.session_id);
    const turn = turnDir(
      sessionId ?? NO_SESSION_ID,
      firstString(fields.data.prompt_id, fields.data.turn_id),
    );
    if (unknownPayloadCount(turn) >= MAX_UNKNOWN_PAYLOADS_PER_TURN) return;
    incrementUnknownPayloads(turn);
    appendEvent(findRepoRoot(cwd), {
      kind: "unknown_payload",
      at: new Date().toISOString(),
      ...(sessionId === undefined ? {} : { sessionId }),
      tool: tool.data,
    });
  } catch {
    // nothing to do: a payload we already rejected must never fail the hook
  }
};

export const readEvents = (root: string): PlumbEvent[] => {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(root), "utf8");
  } catch {
    return [];
  }
  const events: PlumbEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = eventSchema.safeParse(JSON.parse(line));
      if (parsed.success) events.push(parsed.data);
    } catch {
      // skip a torn line
    }
  }
  return events;
};
