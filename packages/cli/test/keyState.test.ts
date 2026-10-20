import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { AUTH_FAILURE_LATCH_AFTER, KEY_PROBE_INTERVAL_MS } from "../src/lib/constants.js";
import {
  claimRejectedWarning,
  isKeyRejected,
  keyRejectionMessage,
  keyRejectionSentence,
  noteAuthFailure,
  noteKeyAccepted,
  noteKeyRejected,
  noteKeyWorked,
  probeIsDue,
} from "../src/lib/keyState.js";

const savedHome = process.env.OH_MY_PLUMB_HOME_DIR;

beforeEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.OH_MY_PLUMB_HOME_DIR;
  else process.env.OH_MY_PLUMB_HOME_DIR = savedHome;
});

const latchWith = (key: string): void => {
  for (let i = 0; i < AUTH_FAILURE_LATCH_AFTER; i += 1) noteAuthFailure(key, "refused");
};

describe("keyState", () => {
  it("starts clean, with the probe still owed", () => {
    expect(isKeyRejected("k")).toBe(false);
    expect(probeIsDue("k")).toBe(true);
  });

  it("holds a key below the latch, then stops trusting it", () => {
    for (let i = 1; i < AUTH_FAILURE_LATCH_AFTER; i += 1) {
      noteAuthFailure("k", `refusal ${i}`);
      expect(isKeyRejected("k")).toBe(false);
    }
    noteAuthFailure("k", "api.typesafe.ai refused the key (401)");
    expect(isKeyRejected("k")).toBe(true);
    expect(keyRejectionMessage("k")).toBe("api.typesafe.ai refused the key (401)");
  });

  it("latches at once on a definitive refusal from the probe", () => {
    noteKeyRejected("k", "api.typesafe.ai refused the key (401)");
    expect(isKeyRejected("k")).toBe(true);
    expect(probeIsDue("k")).toBe(false);
  });

  it("forgets an earlier key, so a replaced key is never rejected by name alone", () => {
    noteKeyRejected("old", "refused");
    expect(isKeyRejected("new")).toBe(false);
    expect(probeIsDue("new")).toBe(true);
  });

  it("clears the record once a call proves the key again", () => {
    latchWith("k");
    noteKeyWorked("k");
    expect(isKeyRejected("k")).toBe(false);
    expect(keyRejectionMessage("k")).toBeUndefined();
  });

  it("lets a successful probe lift a latch, so a provider-side fix needs no new key", () => {
    latchWith("k");
    noteKeyAccepted("k");
    expect(isKeyRejected("k")).toBe(false);
    expect(probeIsDue("k")).toBe(false);
  });

  it("owes a probe again once the day is out", () => {
    noteKeyAccepted("k", Date.now() - KEY_PROBE_INTERVAL_MS - 1);
    expect(probeIsDue("k")).toBe(true);
  });

  it("ends the refusal as one sentence, whatever punctuation the provider sent", () => {
    noteKeyRejected("k", "api.typesafe.ai refused the key (401)");
    expect(keyRejectionSentence("k")).toBe("api.typesafe.ai refused the key (401).");
    noteKeyRejected("k", "Cannot authenticate with the server. Please check your API key.");
    expect(keyRejectionSentence("k")).toBe(
      "Cannot authenticate with the server. Please check your API key.",
    );
  });

  it("warns a session once, and the next session again", () => {
    latchWith("k");
    expect(claimRejectedWarning("k", "s1")).toBe(true);
    expect(claimRejectedWarning("k", "s1")).toBe(false);
    expect(claimRejectedWarning("k", "s2")).toBe(true);
  });
});
