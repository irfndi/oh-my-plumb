import { describe, expect, it } from "vite-plus/test";
import { postToolUseInputSchema } from "oh-my-plumb-schema";
import { editsFromPostToolUse } from "../src/lib/diff.js";

// A computed specifier keeps tsc out of the extension, which Pi loads as untyped JS.
const extension = "../pi/oh-my-plumb.ts";
const { postToolUsePayload } = await import(extension);

describe("pi extension payload", () => {
  it("passes the hook schema and diffs an edit against the original", () => {
    const payload = postToolUsePayload({
      filePath: "/repo/src/a.ts",
      original: "const a = 1;\n",
      after: "const a = 2;\n",
      sessionId: "s1",
      cwd: "/repo",
      toolCallId: "t1",
    });
    const parsed = postToolUseInputSchema.parse(payload);
    const [edit] = editsFromPostToolUse(parsed);
    expect(edit?.isNewFile).toBe(false);
    expect(edit?.text).toContain("+const a = 2;");
    expect(edit?.text).toContain("-const a = 1;");
  });

  it("treats a missing original as a new file", () => {
    const payload = postToolUsePayload({
      filePath: "/repo/src/b.ts",
      original: null,
      after: "export type B = 1;\n",
      sessionId: "s1",
      cwd: "/repo",
      toolCallId: "t2",
    });
    const [edit] = editsFromPostToolUse(postToolUseInputSchema.parse(payload));
    expect(edit?.isNewFile).toBe(true);
    expect(edit?.text).toContain("+export type B = 1;");
  });
});

describe("pi extension events", () => {
  it("checks the whole turn once, when pi settles, not after every model round", async () => {
    const { default: ohMyPlumb } = await import(extension);
    const events: string[] = [];
    ohMyPlumb({ on: (name: string) => events.push(name), sendUserMessage: () => {} });
    expect(events).toContain("agent_before_settle");
    expect(events).not.toContain("turn_end");
  });
});
