import { execSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { appendEvent, appendUnknownPayload, readEvents, trimEvents } from "../src/lib/events.js";
import { EVENTS_LOG_MAX_BYTES } from "../src/lib/constants.js";
import { eventsPath, findRepoRoot } from "../src/lib/paths.js";

const event = { kind: "skip", at: "now", phase: "edit", reason: "test" } as const;

describe("the event log", () => {
  it("appends and reads back", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    appendEvent(root, event);
    appendEvent(root, event);
    expect(readEvents(root)).toEqual([event, event]);
    expect(
      readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8").split("\n"),
    ).toHaveLength(3);
  });

  it("reads an unknown payload; a missing log or a torn line hides nothing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    expect(readEvents(root)).toEqual([]);
    const unknown = { kind: "unknown_payload", at: "now", tool: "MysteryTool" } as const;
    appendEvent(root, unknown);
    appendFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "{ torn line\n");
    expect(readEvents(root)).toEqual([unknown]);
  });

  it("a rejected payload with no cwd logs nothing, so drift never lands in the wrong repo", () => {
    const ambient = findRepoRoot(process.cwd());
    const file = eventsPath(ambient);
    const before = existsSync(file) ? readFileSync(file, "utf8") : "";
    appendUnknownPayload({ tool_name: "Bash", session_id: "s", hook_event_name: "PostToolUse" });
    expect(existsSync(file) ? readFileSync(file, "utf8") : "").toBe(before);
  });

  it(
    "refuses a FIFO in the log's place instead of waiting on its reader",
    { timeout: 3_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
      mkdirSync(path.join(root, ".oh-my-plumb"));
      execSync(`mkfifo "${path.join(root, ".oh-my-plumb", "events.jsonl")}"`);
      appendEvent(root, event);
    },
  );

  it("a log under the cap is left alone, and a missing one trims to nothing", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    appendEvent(root, event);
    const before = readFileSync(eventsPath(root), "utf8");
    trimEvents(root);
    expect(readFileSync(eventsPath(root), "utf8")).toBe(before);
    trimEvents(mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-")));
    expect(readEvents(root)).toHaveLength(1);
  });

  it("past the cap keeps the newest events and drops the rest", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    mkdirSync(path.join(root, ".oh-my-plumb"));
    const lines = Array.from({ length: 1_200 }, (_, i) =>
      JSON.stringify({ ...event, reason: `${i < 600 ? "old" : `new-${i}`}-${"x".repeat(900)}` }),
    );
    writeFileSync(eventsPath(root), `${lines.join("\n")}\n`);
    expect(statSync(eventsPath(root)).size).toBeGreaterThan(EVENTS_LOG_MAX_BYTES);
    trimEvents(root);
    const kept = readEvents(root);
    // One pass lands under the cap: the window read is the cap itself, so a
    // 35 MB legacy log does not need ten sessions to shrink.
    expect(statSync(eventsPath(root)).size).toBeLessThanOrEqual(EVENTS_LOG_MAX_BYTES);
    expect(kept.length).toBeLessThan(lines.length);
    expect(kept.some((e) => e.kind === "skip" && e.reason.startsWith("new-1199"))).toBe(true);
  });

  it("a torn line and a legacy unknown-kind line are dropped by the trim, the valid kept", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    mkdirSync(path.join(root, ".oh-my-plumb"));
    const pad = `${"x".repeat(600)}\n`;
    writeFileSync(
      eventsPath(root),
      `${pad.repeat(3000)}{ torn line\n${JSON.stringify({
        kind: "unknown_payload",
        at: "now",
        tool: "MysteryTool",
      })}\n${JSON.stringify(event)}\n`,
    );
    trimEvents(root);
    const kept = readEvents(root);
    expect(kept).toHaveLength(2);
    expect(kept.some((e) => e.kind === "unknown_payload")).toBe(true);
    expect(kept.some((e) => e.kind === "skip")).toBe(true);
    expect(existsSync(`${eventsPath(root)}.tmp`)).toBe(false);
  });

  it("refuses to trim a FIFO instead of waiting on its reader", { timeout: 3_000 }, () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-events-"));
    mkdirSync(path.join(root, ".oh-my-plumb"));
    execSync(`mkfifo "${path.join(root, ".oh-my-plumb", "events.jsonl")}"`);
    trimEvents(root);
  });
});
