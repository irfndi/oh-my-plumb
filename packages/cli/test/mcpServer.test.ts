import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createMcpServer } from "../src/mcp-server.js";

/** A stand-in for the CLI: echoes its argv as one JSON line. */
const echoBin = `#!/usr/bin/env node
console.log(JSON.stringify({ tool: process.argv[2], args: process.argv.slice(3) }));
`;

/** A stand-in that fails the way a real CLI error does: prose on stderr, non-zero exit, no JSON. */
const brokenBin = `#!/usr/bin/env node
process.stderr.write("rubric is unreadable");
process.exit(2);
`;

const setup = (binScript: string = echoBin): { handle: (message: unknown) => Promise<unknown> } => {
  const cwd = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-mcp-cwd-"));
  const binPath = path.join(cwd, "fake-bin.mjs");
  writeFileSync(binPath, binScript);
  return createMcpServer(binPath, cwd);
};

const id = (n: number) => ({ jsonrpc: "2.0", id: n, method: "x" });

describe("the MCP server", () => {
  it("answers initialize with its capabilities and the client's protocol version", async () => {
    const { handle } = setup();
    const out = (await handle({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2099-01-01" },
    })) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(out.result.protocolVersion).toBe("2099-01-01");
    expect(out.result.serverInfo.name).toBe("oh-my-plumb");
  });

  it("lists the four tools with input schemas", async () => {
    const { handle } = setup();
    const out = (await handle({ ...id(2), method: "tools/list" })) as {
      result: { tools: { name: string }[] };
    };
    expect(out.result.tools.map((t) => t.name)).toEqual(["check", "audit", "report", "bench"]);
  });

  it("dispatches check to the CLI with --json, the task and the paths", async () => {
    const { handle } = setup();
    const out = (await handle({
      ...id(3),
      method: "tools/call",
      params: { name: "check", arguments: { paths: ["src/a.ts"], task: "fix the bug" } },
    })) as { result: { content: { text: string }[]; isError?: boolean } };
    expect(out.result.isError).toBeUndefined();
    const parsed = JSON.parse(out.result.content[0]?.text ?? "{}") as {
      tool: string;
      args: string[];
    };
    expect(parsed.tool).toBe("check");
    expect(parsed.args).toEqual(["--json", "--task", "fix the bug", "src/a.ts"]);
  });

  it("treats a non-zero exit with valid JSON as an answer: check exits 1 on violations", async () => {
    const failWithJson = `#!/usr/bin/env node
console.log(JSON.stringify({ sections: [], violations: true }));
process.exit(1);
`;
    const { handle } = setup(failWithJson);
    const out = (await handle({
      ...id(4),
      method: "tools/call",
      params: { name: "check", arguments: {} },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBeUndefined();
    expect(
      (JSON.parse(out.result.content[0]?.text ?? "{}") as { violations: boolean }).violations,
    ).toBe(true);
  });

  it("returns an isError result when the CLI fails without JSON", async () => {
    const { handle } = setup(brokenBin);
    const out = (await handle({
      ...id(5),
      method: "tools/call",
      params: { name: "report", arguments: {} },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]?.text).toContain("exited with code 2");
    expect(out.result.content[0]?.text).toContain("rubric is unreadable");
  });

  it("names the unknown tool as an error result, not a crash", async () => {
    const { handle } = setup();
    const out = (await handle({
      ...id(7),
      method: "tools/call",
      params: { name: "no-such-tool", arguments: {} },
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(out.result.isError).toBe(true);
    expect(out.result.content[0]?.text).toContain("unknown tool");
  });

  it("rejects invalid params with a JSON-RPC error", async () => {
    const { handle } = setup();
    const out = (await handle({
      ...id(8),
      method: "tools/call",
      params: { arguments: {} },
    })) as { error: { code: number } };
    expect(out.error.code).toBe(-32602);
  });

  it("answers unknown methods with -32601 and skips notifications and garbage", async () => {
    const { handle } = setup();
    const unknown = (await handle({ ...id(9), method: "rubric/voodoo" })) as {
      error: { code: number };
    };
    expect(unknown.error.code).toBe(-32601);
    expect(await handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeUndefined();
    expect(await handle("not an object")).toBeUndefined();
    expect(await handle(null)).toBeUndefined();
  });
});
