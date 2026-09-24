import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { appendEvent, appendUnknownPayload, readEvents } from "../src/lib/events.js";
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
});
