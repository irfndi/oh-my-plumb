import { mkdirSync, readFileSync } from "node:fs";
import { z } from "zod";
import { eventSchema, toolNameSchema, type PlumbEvent } from "oh-my-plumb-schema";
import { MAX_UNKNOWN_PAYLOADS_PER_TURN } from "./constants.js";
import { findRepoRoot, ohMyPlumbDir, eventsPath } from "./paths.js";
import { writeRegularFile } from "./regularFile.js";
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
