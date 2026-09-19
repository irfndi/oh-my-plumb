import { execSync } from "node:child_process";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readRegularFile, readRegularText } from "../src/lib/regularFile.js";

describe("reading files the agent points at", () => {
  it("reads a regular file, and refuses one past the size it will take", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-read-"));
    const file = path.join(dir, "a.txt");
    writeFileSync(file, "hello");
    expect(readRegularText(file)).toBe("hello");
    expect(readRegularFile(file, { maxBytes: 4 })).toBeUndefined();
    expect(readRegularText(path.join(dir, "missing"))).toBeUndefined();
  });

  it("refuses a FIFO instead of waiting on its writer", { timeout: 3_000 }, () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-read-"));
    const fifo = path.join(dir, "pipe");
    execSync(`mkfifo "${fifo}"`);
    expect(readRegularFile(fifo)).toBeUndefined();
    expect(readRegularFile("/dev/zero")).toBeUndefined();
  });

  it("follows a symlink only when asked to", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-read-"));
    writeFileSync(path.join(dir, "target"), "t");
    symlinkSync(path.join(dir, "target"), path.join(dir, "link"));
    expect(readRegularText(path.join(dir, "link"))).toBe("t");
    expect(readRegularText(path.join(dir, "link"), { followSymlinks: false })).toBeUndefined();
  });
});
