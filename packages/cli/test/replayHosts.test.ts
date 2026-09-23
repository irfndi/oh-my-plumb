import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { piSessionsFor, parsePiSession } from "../src/lib/replayPi.js";
import { codexSessionsFor, parseCodexRollout } from "../src/lib/replayCodex.js";
import { opencodeSessionsFromRows } from "../src/lib/replayOpencode.js";

const line = (entry: unknown): string => JSON.stringify(entry);

describe("replay from Codex rollouts", () => {
  it("reads prompts and applied patches, skips injected context and failed patches", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-codex-"));
    const repo = "/r/app";
    const file = path.join(dir, "2026", "09", "18", "rollout-2026-09-18T10-00-00-abc.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    const item = (payload: unknown) => line({ type: "response_item", payload });
    writeFileSync(
      file,
      [
        line({ type: "session_meta", payload: { cwd: repo } }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions for /r/app\n..." }],
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "add a logout route" }],
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c1",
          input: "*** Begin Patch\n*** Add File: src/a.ts\n+export const a = 1;\n*** End Patch",
        }),
        item({
          type: "custom_tool_call_output",
          call_id: "c1",
          output: "Success. Updated the following files:\nA src/a.ts",
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c2",
          input: "*** Begin Patch\n*** Update File: src/b.ts\n@@\n-x\n+y\n*** End Patch",
        }),
        item({
          type: "custom_tool_call_output",
          call_id: "c2",
          output: "apply_patch verification failed: Failed to find expected lines",
        }),
        item({
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "now tests" }],
        }),
        item({
          type: "custom_tool_call",
          name: "apply_patch",
          call_id: "c3",
          input: "*** Begin Patch\n*** Add File: tests/a.test.ts\n+it()\n*** End Patch",
        }),
        item({ type: "custom_tool_call_output", call_id: "c3", output: "Success." }),
        "",
      ].join("\n"),
    );
    const session = parseCodexRollout(file);
    expect(session.cwd).toBe(repo);
    expect(session.turns.map((t) => [t.index, t.prompt, t.edits.length])).toEqual([
      [1, "add a logout route", 1],
      [2, "now tests", 1],
    ]);
    expect(session.turns[0]?.edits[0]?.input.tool_name).toBe("apply_patch");
    expect(codexSessionsFor(repo, dir)).toHaveLength(1);
    expect(codexSessionsFor("/elsewhere", dir)).toHaveLength(0);
  });
});

describe("replay from OpenCode rows", () => {
  it("groups parts into turns and maps edit and write tools onto hook payloads", () => {
    const row = (
      messageId: string,
      role: string,
      created: number,
      part: unknown,
      directory = "/r/app",
      sessionId = "ses_1",
    ) => ({ sessionId, directory, messageId, role, created, part: JSON.stringify(part) });
    const rows = [
      row("m1", "user", 1, { type: "text", text: "add a route" }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "write",
        callID: "w1",
        state: {
          status: "completed",
          input: { filePath: "src/a.ts", content: "export const a = 1;\n" },
        },
      }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "edit",
        callID: "e1",
        state: {
          status: "completed",
          input: { filePath: "/r/app/src/a.ts", oldString: "1", newString: "2" },
        },
      }),
      row("m2", "assistant", 2, {
        type: "tool",
        tool: "bash",
        callID: "b1",
        state: { status: "completed", input: { command: "ls" } },
      }),
      row("m3", "user", 3, {
        type: "text",
        text: "oh-my-plumb: This edit appears to break a rule",
      }),
      row("m4", "user", 1, { type: "text", text: "elsewhere" }, "/other", "ses_2"),
      row(
        "m5",
        "assistant",
        2,
        {
          type: "tool",
          tool: "write",
          callID: "w2",
          state: { status: "completed", input: { filePath: "x.ts", content: "" } },
        },
        "/other",
        "ses_2",
      ),
    ];
    const sessions = opencodeSessionsFromRows("/r/app", rows);
    expect(sessions).toHaveLength(1);
    const [s] = sessions;
    expect(s?.turns.map((t) => [t.index, t.prompt, t.edits.map((e) => e.input.tool_name)])).toEqual(
      [[1, "add a route", ["Write", "Edit"]]],
    );
    const write = s?.turns[0]?.edits[0]?.input;
    expect(write?.tool_name === "Write" && write.tool_input.file_path).toBe("/r/app/src/a.ts");
  });
});

describe("replay from pi sessions", () => {
  it("reads prompts and edit and write calls, skips other records and empty sessions", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-pi-"));
    const repo = "/r/app";
    const stamp = "2026-09-23T10:00:00.000Z";
    const session = (id: string, cwd: string): string =>
      line({ type: "session", version: 3, id, timestamp: stamp, cwd });
    const msg = (id: string, role: string, content: unknown): string =>
      line({ type: "message", id, timestamp: stamp, message: { role, content } });
    const file = path.join(dir, "--r-app--", "2026-09-23T10-00-00-000Z_01api.jsonl");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      [
        session("s1", repo),
        line({ type: "model_change", id: "mc1", provider: "p", modelId: "m" }),
        msg("u1", "user", [{ type: "text", text: "add a route" }]),
        msg("a1", "assistant", [
          { type: "text", text: "on it" },
          {
            type: "toolCall",
            id: "w1",
            name: "write",
            arguments: { path: "src/a.ts", content: "export const a = 1;\n" },
          },
        ]),
        line({ type: "custom", customType: "subagents:record", data: {} }),
        line({ type: "custom_message", customType: "oh-my-plumb", content: "repair it" }),
        "not json, a torn line",
        msg("u2", "user", [{ type: "text", text: "now fix b" }]),
        msg("a2", "assistant", [
          {
            type: "toolCall",
            id: "e1",
            name: "edit",
            arguments: { path: "/r/app/src/b.ts", edits: [{ oldText: "x", newText: "y" }] },
          },
          { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
        ]),
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(path.dirname(file), "2026-09-23T11-00-00-000Z_empty.jsonl"),
      [session("s2", repo), msg("u3", "user", [{ type: "text", text: "no edits here" }]), ""].join(
        "\n",
      ),
    );
    const elsewhere = path.join(dir, "--other--", "2026-09-23T12-00-00-000Z_elsewhere.jsonl");
    mkdirSync(path.dirname(elsewhere), { recursive: true });
    writeFileSync(
      elsewhere,
      [
        session("s3", "/other"),
        msg("u4", "user", [{ type: "text", text: "elsewhere" }]),
        msg("a4", "assistant", [
          { type: "toolCall", id: "w2", name: "write", arguments: { path: "x.ts", content: "" } },
        ]),
        "",
      ].join("\n"),
    );
    const parsed = parsePiSession(file);
    expect(parsed.cwd).toBe(repo);
    expect(
      parsed.turns.map((t) => [t.index, t.prompt, t.edits.map((e) => e.input.tool_name)]),
    ).toEqual([
      [1, "add a route", ["Write"]],
      [2, "now fix b", ["MultiEdit"]],
    ]);
    const write = parsed.turns[0]?.edits[0]?.input;
    expect(write?.tool_name === "Write" && write.tool_input.file_path).toBe("/r/app/src/a.ts");
    const edit = parsed.turns[1]?.edits[0]?.input;
    expect(edit?.tool_name === "MultiEdit" && edit.tool_input.edits[0]?.old_string).toBe("x");
    expect(piSessionsFor(repo, dir)).toHaveLength(1);
    expect(piSessionsFor("/elsewhere", dir)).toHaveLength(0);
  });
});
