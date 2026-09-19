import { execSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { lastUserPrompt } from "../src/lib/transcript.js";

describe("the last prompt in a transcript", () => {
  it("reads the newest typed prompt from the tail", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-transcript-"));
    const file = path.join(dir, "t.jsonl");
    writeFileSync(
      file,
      [
        JSON.stringify({ type: "user", message: { content: "first" } }),
        JSON.stringify({ type: "assistant", message: { content: "ok" } }),
        JSON.stringify({ type: "user", message: { content: "  second  " } }),
        JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
      ].join("\n"),
    );
    expect(lastUserPrompt(file)).toBe("second");
    expect(lastUserPrompt(path.join(dir, "missing"))).toBeUndefined();
  });

  it("refuses a FIFO instead of waiting on its writer", { timeout: 3_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-transcript-"));
    const fifo = path.join(dir, "t.jsonl");
    execSync(`mkfifo "${fifo}"`);
    expect(lastUserPrompt(fifo)).toBeUndefined();
  });
});
