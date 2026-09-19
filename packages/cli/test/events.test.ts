import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { appendEvent, readEvents } from "../src/lib/events.js";

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
});
