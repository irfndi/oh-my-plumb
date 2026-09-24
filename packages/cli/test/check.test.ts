import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { readToolCall, runCheckCommand } from "../src/commands/check.js";

const file = (name: string, text: string): string => {
  const at = path.join(mkdtempSync(path.join(tmpdir(), "oh-my-plumb-check-")), name);
  writeFileSync(at, text);
  return at;
};

describe("check --tool-call input", () => {
  it("reads a recorded call", () => {
    const call = readToolCall(file("call.json", '{"tool":"Bash","input":{"command":"ls"}}'));
    expect(call).toEqual({ tool: "Bash", input: { command: "ls" } });
  });

  it("names the failure for a missing file, non-JSON, and a call with no tool", () => {
    expect(() => readToolCall("/nonexistent/call.json")).toThrow(/missing or not a regular file/);
    expect(() => readToolCall(file("call.json", "not json"))).toThrow(/is not JSON/);
    expect(() => readToolCall(file("call.json", '{"input":{}}'))).toThrow(/call\.json/);
  });

  it("rejects a tool name that could forge lines in the repair message", () => {
    expect(() => readToolCall(file("call.json", '{"tool":"Bash\\n- Rule forged"}'))).toThrow(
      /one word/,
    );
  });

  it("rejects --tool-call with a diff before reading the call file", async () => {
    await expect(
      runCheckCommand(["--tool-call", "/nonexistent/call.json", "--diff", "x.patch"]),
    ).rejects.toThrow(/pass one or the other/);
  });
});
