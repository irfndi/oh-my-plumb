import { spawn, type ChildProcess } from "node:child_process";
import { z } from "zod";
import { debug } from "./output.js";

const PROTOCOL_VERSION = "2025-06-18";

/** Past this much unread output the server is not answering a guard call; skip it. */
const MAX_BUFFER_BYTES = 1024 * 1024;

/** Only these fields matter to the client; everything else on the wire is stripped. */
const wireMessage = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

const initializeResult = z.object({ protocolVersion: z.string() });

const toolsCallResult = z
  .object({ content: z.unknown().optional(), isError: z.boolean().optional() })
  .transform((r) => ({ isError: r.isError ?? false, content: r.content }));

const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]*:/;
const HEADER_PREFIX = /^[A-Za-z][A-Za-z0-9-]*:?[^\n]*$/;

export type McpCallResult = { isError: boolean; content: unknown };

/** How to start a stdio MCP server: its argv and the env its config sets. */
export type McpLaunch = { command: string[]; env: Record<string, string> };

/** Kill the server and anything it started: `npx` and shell wrappers leave the real server a grandchild. */
const killTree = (child: ChildProcess): void => {
  try {
    if (process.platform !== "win32" && child.pid !== undefined)
      process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {}
  }
};

/**
 * Minimal stdio MCP client for guard dispatch.
 *
 * Real MCP over the server's stdin/stdout: `initialize` handshake,
 * `notifications/initialized`, then `tools/call`, under one shared deadline.
 * Reads both NDJSON lines and header-framed messages (`Content-Length`, any
 * case, other headers allowed), decided from the buffer's start: a JSON line
 * begins with `{`, a framed message with a header name.
 *
 * Silent-pass contract: every failure (timeout, non-zero exit, malformed
 * frame, missing or unspawnable server, JSON-RPC error, invalid result,
 * oversized output) logs a skip and resolves `undefined`. This function
 * never throws or rejects, so an MCP guard can never break or hold the agent.
 */
export const callMcpGuard = (
  launch: McpLaunch,
  cwd: string,
  tool: string,
  args: Record<string, string>,
  timeoutMs: number,
): Promise<McpCallResult | undefined> =>
  new Promise((resolve) => {
    const [bin, ...spawnArgs] = launch.command;
    if (bin === undefined) {
      debug("mcp guard skipped: empty command");
      resolve(undefined);
      return;
    }
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let child: ChildProcess | undefined;
    const done = (value: McpCallResult | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child !== undefined) killTree(child);
      resolve(value);
    };
    const skip = (reason: string): undefined => {
      debug(`mcp guard skipped: ${reason}`);
      return undefined;
    };
    let spawned: ChildProcess | undefined;
    try {
      spawned = spawn(bin, spawnArgs, {
        cwd,
        env: { ...process.env, ...launch.env },
        stdio: ["pipe", "pipe", "ignore"],
        detached: process.platform !== "win32",
      });
    } catch {
      // falls through to the spawned === undefined skip below
    }
    if (spawned === undefined) {
      resolve(skip("command could not be spawned"));
      return;
    }
    child = spawned;
    const stdin = spawned.stdin;
    const stdout = spawned.stdout;
    if (stdin === null || stdout === null) {
      done(skip("stdio is not piped"));
      return;
    }
    const post = (message: Record<string, unknown>): void => {
      try {
        stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        done(skip("stdin write failed"));
      }
    };
    const onMessage = (line: string): void => {
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        done(skip("malformed frame"));
        return;
      }
      const parsed = wireMessage.safeParse(raw);
      if (!parsed.success) {
        done(skip("malformed frame"));
        return;
      }
      const msg = parsed.data;
      // Server-initiated requests/notifications and foreign ids: not ours to answer.
      if (msg.method !== undefined || msg.id === undefined) return;
      if (msg.id !== 1 && msg.id !== 2) return;
      if (msg.error !== undefined) {
        done(skip("server returned a JSON-RPC error"));
        return;
      }
      if (msg.id === 1) {
        if (!initializeResult.safeParse(msg.result).success) {
          done(skip("invalid initialize result"));
          return;
        }
        post({ jsonrpc: "2.0", method: "notifications/initialized" });
        post({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: tool, arguments: args },
        });
        return;
      }
      const result = toolsCallResult.safeParse(msg.result);
      if (!result.success) {
        done(skip("invalid tools/call result"));
        return;
      }
      done(result.data);
    };
    let buf = Buffer.alloc(0);
    /** One framed message off the front of the buffer: "wait" until its header and body are all here. */
    const takeFramed = (): string | "wait" | "bad" => {
      const blank = /\r?\n\r?\n/.exec(buf.toString("latin1", 0, Math.min(buf.length, 8192)));
      if (blank === null) return buf.length > 8192 ? "bad" : "wait";
      // Header bytes are ASCII, so latin1 offsets equal byte offsets.
      const headers = buf.toString("latin1", 0, blank.index).split(/\r?\n/);
      const length = headers
        .map((h) => /^content-length:[ \t]*(\d+)[ \t]*$/i.exec(h)?.[1])
        .find((v) => v !== undefined);
      if (length === undefined) return "bad";
      const start = blank.index + blank[0].length;
      const end = start + Number(length);
      if (buf.length < end) return "wait";
      const body = buf.subarray(start, end).toString("utf8");
      buf = buf.subarray(end);
      return body;
    };
    const pump = (chunk: Buffer): void => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > MAX_BUFFER_BYTES) {
        done(skip("server output over 1 MB"));
        return;
      }
      for (;;) {
        if (settled || buf.length === 0) return;
        const start = buf.toString("latin1", 0, Math.min(buf.length, 256)).trimStart();
        const nl = buf.indexOf(0x0a);
        const framed =
          HEADER_NAME.test(start) || (nl < 0 && start !== "" && HEADER_PREFIX.test(start));
        if (framed && !start.startsWith("{")) {
          const body = takeFramed();
          if (body === "wait") return;
          if (body === "bad") {
            done(skip("malformed frame"));
            return;
          }
          if (body.trim() !== "") onMessage(body);
          continue;
        }
        if (nl < 0) return;
        const line = buf.subarray(0, nl).toString("utf8");
        buf = buf.subarray(nl + 1);
        if (line.trim() !== "") onMessage(line);
      }
    };
    timer = setTimeout(() => done(skip("timed out")), timeoutMs);
    child.on("error", () => done(skip("command failed to start")));
    child.on("close", (code) => {
      if (!settled && buf.length > 0) {
        const tail = buf.toString("utf8");
        buf = Buffer.alloc(0);
        if (tail.trim() !== "") onMessage(tail);
      }
      done(
        skip(
          code === 0
            ? "server exited before answering"
            : `server exited with code ${code ?? "signal"}`,
        ),
      );
    });
    stdin.on("error", () => done(skip("stdin write failed")));
    stdout.on("data", (chunk: Buffer) => {
      if (!settled) pump(chunk);
    });
    post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        // version mirrors packages/cli/package.json; nothing parses it.
        clientInfo: { name: "oh-my-plumb", version: "0.1.2" },
      },
    });
  });
