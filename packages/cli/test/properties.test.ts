import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vite-plus/test";
import { eventSchema, ruleSchema, type Rule } from "oh-my-plumb-schema";
import { EVENTS_LOG_MAX_BYTES, MAX_TOOL_CALLS_PER_TURN } from "../src/lib/constants.js";
import { appendEvent, readEvents, trimEvents } from "../src/lib/events.js";
import { eventsPath, sessionsDir } from "../src/lib/paths.js";
import { settlePrecondition } from "../src/lib/precondition.js";
import { bandFor } from "../src/lib/band.js";
import { DEFAULT_THRESHOLDS } from "oh-my-plumb-schema";
import {
  clearTurn,
  incrementStopChecks,
  readToolCalls,
  recordToolCall,
  stopCheckCount,
  turnDir,
} from "../src/lib/session.js";

/**
 * Properties rather than examples, for the three stores every hook writes
 * through. Each one holds for every input, which is what an example cannot
 * say: a hand-picked pair of prompts misses the one host that sends no id.
 */

const freshHome = (): string => {
  const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-prop-"));
  process.env.OH_MY_PLUMB_HOME_DIR = home;
  return home;
};

const within = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
};

const relativeDepth = (parent: string, child: string): number =>
  path.relative(parent, child).split(path.sep).filter(Boolean).length;

/** Ids are spelled into directory names, so two ids that spell the same are one directory. */
const sanitized = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_") || "_";

describe("turn directories", () => {
  it("never let a session id or prompt id escape the sessions directory", () => {
    freshHome();
    const base = sessionsDir();
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.option(fc.string({ maxLength: 40 }), { nil: undefined }),
        (sessionId, promptId) => {
          // Two levels below sessions/, whatever the ids contained. `..` would
          // land a turn's clear on the sessions root itself.
          const dir = turnDir(sessionId, promptId);
          expect(within(base, dir)).toBe(true);
          expect(relativeDepth(base, dir)).toEqual(2);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("gives prompts that spell differently two directories, and the same prompt one", () => {
    freshHome();
    fc.assert(
      fc.property(
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        fc.string({ maxLength: 20 }),
        (sessionId, promptA, promptB) => {
          fc.pre(sanitized(promptA) !== sanitized(promptB));
          expect(turnDir(sessionId, promptA)).not.toBe(turnDir(sessionId, promptB));
          expect(turnDir(sessionId, promptA)).toBe(turnDir(sessionId, promptA));
        },
      ),
      { numRuns: 300 },
    );
  });

  it("keeps every recorded call under the turn's cap, with unique order numbers", () => {
    freshHome();
    const dir = turnDir("session", "prompt");
    for (let i = 0; i < MAX_TOOL_CALLS_PER_TURN + 12; i += 1)
      recordToolCall(dir, "Bash", { command: `echo ${i}` });
    const calls = readToolCalls(dir);
    expect(calls.length).toBeLessThanOrEqual(MAX_TOOL_CALLS_PER_TURN);
    expect(new Set(calls.map((c) => c.order)).size).toBe(calls.length);
  });

  it("clears a turn's state and nothing above it", () => {
    freshHome();
    const dir = turnDir("session", "prompt");
    incrementStopChecks(dir);
    incrementStopChecks(dir);
    expect(stopCheckCount(dir)).toBe(2);
    clearTurn(dir);
    expect(stopCheckCount(dir)).toBe(0);
  });
});

describe("the event log's trim", () => {
  const write = (root: string, lines: readonly unknown[]): void => {
    mkdirSync(path.dirname(eventsPath(root)), { recursive: true });
    writeFileSync(eventsPath(root), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  };

  const size = (root: string): number => statSync(eventsPath(root)).size;

  const validEvent = (n: number) => ({
    kind: "skip" as const,
    at: `2026-01-01T00:00:${String(n % 60).padStart(2, "0")}`,
    phase: "edit" as const,
    reason: `case ${n}`,
  });

  it("lands at or under the cap however large the log grew", () => {
    freshHome();
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), (count) => {
        const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-trim-"));
        write(
          root,
          Array.from({ length: count }, (_, i) => validEvent(i)),
        );
        const before = size(root);
        trimEvents(root, Math.max(64, Math.floor(before / 2)));
        expect(size(root)).toBeLessThanOrEqual(Math.max(64, Math.floor(before / 2)));
      }),
      { numRuns: 40 },
    );
  });

  it("leaves a log under the cap exactly as it was", () => {
    freshHome();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-trim-"));
    write(root, [validEvent(1), validEvent(2)]);
    const before = readFileSync(eventsPath(root), "utf8");
    trimEvents(root, EVENTS_LOG_MAX_BYTES);
    expect(readFileSync(eventsPath(root), "utf8")).toBe(before);
  });

  it("keeps only lines the schema still accepts, and only a suffix of the old log", () => {
    freshHome();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-trim-"));
    const lines = [
      JSON.stringify(validEvent(1)),
      "{not json",
      JSON.stringify({ kind: "no-such-kind", at: "x" }),
      JSON.stringify(validEvent(2)),
      JSON.stringify(validEvent(3)),
    ];
    mkdirSync(path.dirname(eventsPath(root)), { recursive: true });
    writeFileSync(eventsPath(root), `${lines.join("\n")}\n${"x".repeat(80)}\n`);
    // A cap below the fixture, so the trim path actually runs: at or above it,
    // `trimEvents` returns at its size guard and this test proves nothing.
    const before = statSync(eventsPath(root)).size;
    trimEvents(root, Math.floor(before / 2));
    expect(statSync(eventsPath(root)).size).toBeLessThan(before);
    const kept = readEvents(root);
    expect(kept.length).toBeGreaterThan(0);
    // The torn tail and the invalid line are gone from the file, not just from a reader's view.
    expect(readFileSync(eventsPath(root), "utf8")).not.toContain("no-such-kind");
    expect(readFileSync(eventsPath(root), "utf8")).not.toContain("x".repeat(80));
    for (const event of kept) expect(eventSchema.safeParse(event).success).toBe(true);
    // A suffix, not a reordering: the newest valid events survive and the torn ones do not.
    expect(kept.at(-1)).toMatchObject({ reason: "case 3" });
    expect(kept.map((e) => (e.kind === "skip" ? e.reason : e.kind))).not.toContain("no-such-kind");
  });

  it("drops everything rather than keep a torn line, when the cap lands inside one", () => {
    freshHome();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-trim-"));
    write(root, [validEvent(1)]);
    trimEvents(root, 16);
    expect(readEvents(root)).toEqual([]);
  });

  it("is idempotent: a second trim on a trimmed log changes nothing", () => {
    freshHome();
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-trim-"));
    write(
      root,
      Array.from({ length: 60 }, (_, i) => validEvent(i)),
    );
    trimEvents(root, 200);
    const once = readFileSync(eventsPath(root), "utf8");
    trimEvents(root, 200);
    expect(readFileSync(eventsPath(root), "utf8")).toBe(once);
  });

  it("never lets an appended event land unparsed, whatever the payload's own text", () => {
    freshHome();
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.string({ maxLength: 200 }), (reason, at) => {
        const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-append-"));
        appendEvent(root, { kind: "skip", at, phase: "edit", reason });
        const events = readEvents(root);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ kind: "skip", at, reason });
      }),
      { numRuns: 60 },
    );
  });
});

describe("the hook's own boundary", () => {
  const script = path.resolve(import.meta.dirname, "..", "dist", "oh-my-plumb-hook.js");
  const HOME = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-hookprop-"));

  it("exits 0 with nothing on stdout for every payload it was never promised", () => {
    fc.assert(
      fc.property(fc.option(fc.string({ maxLength: 400 }), { nil: undefined }), (input) => {
        const r = spawnSync("node", [script, "post-tool-use"], {
          input: input ?? "",
          encoding: "utf8",
          env: {
            ...process.env,
            TYPESAFE_AI_API_KEY: "",
            AI_GATEWAY_API_KEY: "",
            OH_MY_PLUMB_HOME_DIR: HOME,
          },
          timeout: 20_000,
        });
        expect(r.status).toBe(0);
        // One record or none: a host reads the last line and nothing else.
        const printed = r.stdout.split("\n").filter((line) => line.trim() !== "");
        expect(printed.length).toBeLessThanOrEqual(1);
        for (const line of printed) expect(() => JSON.parse(line)).not.toThrow();
      }),
      { numRuns: 12 },
    );
  }, 60_000);
});

describe("a precondition's verdict", () => {
  const state = (files: string[], names: string[]) => ({
    files,
    log: names.map((name, i) => ({ order: i + 1, name, summary: `{command=${name}}` })),
  });

  it("answers a band or nothing, never throws, and never lands in the middle", () => {
    const ruleWith = (precondition: unknown): Rule =>
      ruleSchema.parse({
        id: "gated",
        text: "Run the gate.",
        source: { path: "AGENTS.md", line: 1 },
        target: "toolCall",
        scope: ["Bash"],
        when: "turn",
        check: {
          type: "model",
          question: { type: "boolean", instructions: "Did it?" },
          precondition,
        },
      });
    const globs = ["apps/**", "**/*.ts", "docs/**/*.md", "src/**"];
    fc.assert(
      fc.property(
        fc.constantFrom(...globs),
        fc.constantFrom("\\bgate\\b", "gate.*", "(a+)*", "a{1,3}", ".*"),
        fc.array(fc.constantFrom("apps/a.ts", "src/deep/b.rs", "docs/x.md", "README.md")),
        fc.array(fc.constantFrom("Bash", "Read"), { maxLength: 4 }),
        (glob, pattern, files, tools) => {
          const rule = ruleWith({ changes: [glob], ran: { arg: ["command"], pattern } });
          const verdict = settlePrecondition(rule, state(files, tools));
          if (verdict === undefined) return;
          expect(["act", "flag", "clear"]).toContain(verdict.band);
          expect(verdict.band).not.toBe("flag");
          expect(verdict.band).toBe(bandFor(verdict.probability, DEFAULT_THRESHOLDS));
        },
      ),
      { numRuns: 200 },
    );
  });
});
