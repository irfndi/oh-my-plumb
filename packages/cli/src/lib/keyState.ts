import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { AUTH_FAILURE_LATCH_AFTER, KEY_PROBE_INTERVAL_MS } from "./constants.js";
import { globalOhMyPlumbDir } from "./paths.js";

/**
 * What oh-my-plumb knows about the key it holds: whether the provider refused
 * it, and how many calls in a row came back unauthorized. Rows are tied to the
 * key's fingerprint, so replacing the key starts clean without deleting anything.
 */
const keyStateSchema = z.object({
  keyHash: z.string(),
  checkedAt: z.number(),
  rejected: z.boolean(),
  failures: z.number().int(),
  /** The provider's own words the last time it refused the key. */
  message: z.string().optional(),
  /** The session already told about this, so one edit does not repeat the warning. */
  warnedSession: z.string().optional(),
});
type KeyState = z.infer<typeof keyStateSchema>;

const stateFile = (): string => path.join(globalOhMyPlumbDir(), "key-check.json");

const fingerprint = (key: string): string =>
  createHash("sha256").update(key).digest("hex").slice(0, 16);

const read = (): KeyState | undefined => {
  try {
    const parsed = keyStateSchema.safeParse(JSON.parse(readFileSync(stateFile(), "utf8")));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

const write = (state: KeyState): void => {
  try {
    mkdirSync(globalOhMyPlumbDir(), { recursive: true, mode: 0o700 });
    writeFileSync(stateFile(), JSON.stringify(state), { mode: 0o600 });
  } catch {
    // A read-only home must never break a check.
  }
};

const forKey = (key: string): KeyState | undefined => {
  const state = read();
  return state !== undefined && state.keyHash === fingerprint(key) ? state : undefined;
};

const carry = (state: KeyState | undefined, key: string, fields: Partial<KeyState>): KeyState => ({
  keyHash: fingerprint(key),
  checkedAt: state?.checkedAt ?? 0,
  rejected: state?.rejected ?? false,
  failures: state?.failures ?? 0,
  ...(state?.message === undefined ? {} : { message: state.message }),
  ...(state?.warnedSession === undefined ? {} : { warnedSession: state.warnedSession }),
  ...fields,
});

export const isKeyRejected = (key: string): boolean => forKey(key)?.rejected === true;

export const keyRejectionMessage = (key: string): string | undefined => forKey(key)?.message;

/** The refusal as a finished sentence, ended once whatever punctuation the provider sent. */
export const keyRejectionSentence = (key: string): string => {
  const message = keyRejectionMessage(key) ?? "the provider refused the key";
  return /[.!?]$/.test(message) ? message : `${message}.`;
};

/** A probe answered, and the key works. */
export const noteKeyAccepted = (key: string, now = Date.now()): void => {
  write({ keyHash: fingerprint(key), checkedAt: now, rejected: false, failures: 0 });
};

/** A definitive refusal needs no second opinion: latch at once, with the provider's words. */
export const noteKeyRejected = (key: string, message: string, now = Date.now()): void => {
  write(carry(forKey(key), key, { checkedAt: now, rejected: true, message }));
};

/** A 401 from a real check is evidence too: a few in a row latch without waiting for a probe. */
export const noteAuthFailure = (key: string, message: string): void => {
  const state = forKey(key);
  const failures = (state?.failures ?? 0) + 1;
  write(
    carry(state, key, {
      failures,
      rejected: state?.rejected === true || failures >= AUTH_FAILURE_LATCH_AFTER,
      message,
    }),
  );
};

/** A working call proves the key, so a since-repaired failure must not outlive it. */
export const noteKeyWorked = (key: string): void => {
  const state = forKey(key);
  if (state === undefined || (state.failures === 0 && !state.rejected)) return;
  write({ keyHash: fingerprint(key), checkedAt: state.checkedAt, rejected: false, failures: 0 });
};

export const probeIsDue = (key: string, now = Date.now()): boolean => {
  const state = forKey(key);
  return state === undefined || now - state.checkedAt >= KEY_PROBE_INTERVAL_MS;
};

/** True the first time this session asks: one warning per session, not one per edit. */
export const claimRejectedWarning = (key: string, sessionId: string): boolean => {
  const state = forKey(key);
  if (state?.warnedSession === sessionId) return false;
  write(carry(state, key, { warnedSession: sessionId }));
  return true;
};
