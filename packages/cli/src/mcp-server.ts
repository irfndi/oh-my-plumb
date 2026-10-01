#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { runningVersion } from "./lib/packageRoot.js";

/**
 * oh-my-plumb as an MCP server.
 *
 * The hooks judge edits while the agent works; this server exposes the same
 * checks as tools an agent can call on demand, in any host that speaks MCP —
 * including codemode, where one script can call check, filter the verdicts
 * and drive the repair. It is a thin adapter: every tool runs the CLI's own
 * `--json` path, so there is one implementation of each check and no drift.
 *
 * Protocol: newline-delimited JSON-RPC over stdio, with Content-Length frames
 * accepted the way hosts have been known to send them. stdout carries only
 * protocol records; logs go to stderr. An unsupported message is skipped, a
 * failed tool call is an isError result, and the server never exits non-zero
 * on a bad message: it serves the next one or ends quietly when stdin closes.
 */

const PROTOCOL_VERSION = "2025-06-18";

/** Longest wait on one tool call. audit judges every file in the paths given, so it can run long. */
const TOOL_TIMEOUT_MS = 180_000;

const DEBUG = process.env.OH_MY_PLUMB_DEBUG !== "";
const debug = (message: string): void => {
  if (DEBUG) process.stderr.write(`oh-my-plumb mcp: ${message}\n`);
};

const initializeParamsSchema = z.object({
  protocolVersion: z.string().optional(),
});

const toolsCallParamsSchema = z.object({
  name: z.string().min(1),
  arguments: z.unknown().optional(),
});

const requestSchema = z.object({
  id: z.union([z.string(), z.number()]),
  method: z.string().min(1),
  params: z.unknown().optional(),
});

type ToolArgs = { readonly paths?: readonly string[]; readonly task?: string };

type ToolSpec = {
  description: string;
  inputSchema: Record<string, unknown>;
  args: (input: ToolArgs) => string[];
};

const pathArgs = (input: ToolArgs): string[] => (input.paths === undefined ? [] : [...input.paths]);

const TOOLS: Record<string, ToolSpec> = {
  check: {
    description:
      "Judge the repository's uncommitted changes the way the hooks would: one question per rule, a banded verdict per rule. Returns JSON with per-file verdicts.",
    inputSchema: {
      type: "object",
      properties: {
        paths: {
          type: "array",
          items: { type: "string" },
          description: "Limit the check to these repo-relative paths. Absent means all changes.",
        },
        task: { type: "string", description: "What the change was asked to do, for scope rules." },
      },
      additionalProperties: false,
    },
    args: (input) => [
      "check",
      "--json",
      ...(input.task === undefined ? [] : ["--task", input.task]),
      ...pathArgs(input),
    ],
  },
  audit: {
    description:
      "Judge existing files as if they had just been written. Returns JSON by rule and by file.",
    inputSchema: {
      type: "object",
      properties: {
        paths: { type: "array", items: { type: "string" }, description: "Files or directories." },
      },
      additionalProperties: false,
    },
    args: (input) => ["audit", "--json", ...pathArgs(input)],
  },
  report: {
    description:
      "The rules in force, what fires, what never does, and where a guard cannot run. JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["report", "--json"],
  },
  bench: {
    description: "Latency and spend of one check, measured on this machine. JSON.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    args: () => ["bench", "--json"],
  },
};

const toolArgsSchema = z
  .object({
    paths: z.array(z.string().min(1)).optional(),
    task: z.string().max(600).optional(),
  })
  .strict();

/** Run one CLI command; a JSON answer is success whatever the exit code, since check exits 1 on violations. */
const runTool = (binPath: string, cwd: string, argv: readonly string[]) =>
  new Promise<{ isError: boolean; text: string }>((resolve) => {
    const child = spawn("node", [binPath, ...argv], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const done = (result: { isError: boolean; text: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    let settled = false;
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done({ isError: true, text: `oh-my-plumb ${argv[0]} timed out` });
    }, TOOL_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", () => done({ isError: true, text: "could not start the oh-my-plumb CLI" }));
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf8").trim();
      try {
        const parsed: unknown = JSON.parse(stdout);
        done({ isError: false, text: JSON.stringify(parsed) });
        return;
      } catch {
        // fall through to the failure text below
      }
      const stderr = Buffer.concat(err).toString("utf8").trim();
      done({
        isError: true,
        text: `oh-my-plumb ${argv[0]} exited with code ${code ?? "signal"}${
          stderr === "" ? "" : `: ${stderr.slice(-500)}`
        }`,
      });
    });
  });

export type McpServer = {
  /** One protocol message in, one response out; undefined for notifications and anything unparsable. */
  handle: (message: unknown) => Promise<Record<string, unknown> | undefined>;
};

export const createMcpServer = (binPath: string, cwd: string): McpServer => {
  const result = (
    id: string | number,
    value: Record<string, unknown>,
  ): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    result: value,
  });
  const error = (id: string | number, code: number, message: string): Record<string, unknown> => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  const handle = async (message: unknown): Promise<Record<string, unknown> | undefined> => {
    const parsed = requestSchema.safeParse(message);
    if (!parsed.success) {
      debug("skipped a message that is not a request");
      return undefined;
    }
    const { id, method, params } = parsed.data;
    switch (method) {
      case "initialize": {
        const init = initializeParamsSchema.safeParse(params ?? {});
        return result(id, {
          // The client's version when we know it, else the one this server speaks.
          protocolVersion: init.success
            ? (init.data.protocolVersion ?? PROTOCOL_VERSION)
            : PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "oh-my-plumb", version: runningVersion() },
          instructions:
            "oh-my-plumb enforces this repository's own instruction-file rules on edits. Use check to judge uncommitted changes on demand, audit for existing files, report for the rules in force.",
        });
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return undefined;
      case "ping":
        return result(id, {});
      case "tools/list":
        return result(id, {
          tools: Object.entries(TOOLS).map(([name, spec]) => ({
            name,
            description: spec.description,
            inputSchema: spec.inputSchema,
          })),
        });
      case "tools/call": {
        const call = toolsCallParamsSchema.safeParse(params ?? {});
        if (!call.success) return error(id, -32602, "invalid params for tools/call");
        const spec = TOOLS[call.data.name];
        if (spec === undefined)
          return result(id, {
            content: [{ type: "text", text: `unknown tool "${call.data.name}"` }],
            isError: true,
          });
        const args = toolArgsSchema.safeParse(call.data.arguments ?? {});
        if (!args.success) return error(id, -32602, `invalid arguments for ${call.data.name}`);
        const answer = await runTool(binPath, cwd, spec.args(args.data));
        return result(id, {
          content: [{ type: "text", text: answer.text }],
          ...(answer.isError ? { isError: true } : {}),
        });
      }
      default:
        return error(id, -32601, `unknown method "${method}"`);
    }
  };
  return { handle };
};

/**
 * Reads requests from stdin in both shapes hosts have been seen to use: one
 * JSON object per line, or Content-Length-framed bodies. Anything unparsable
 * is skipped, and stdin's end ends the server with code 0.
 */
const main = async (): Promise<void> => {
  const binPath = new URL("bin.js", import.meta.url).pathname;
  const server = createMcpServer(binPath, process.cwd());
  const write = (message: Record<string, unknown>): boolean =>
    process.stdout.write(`${JSON.stringify(message)}\n`);

  const rl = createInterface({ input: process.stdin, terminal: false });
  process.stdout.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EPIPE") process.exit(0);
  });
  rl.on("line", (line) => {
    void (async () => {
      for (const message of frames(line)) {
        const response = await server.handle(message);
        if (response !== undefined && !write(response)) return;
      }
    })().catch((error: unknown) =>
      debug(`handler failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  });
  rl.on("close", () => process.exit(0));
};

/** Every complete JSON value in one delivered chunk: a line, or a framed body that arrived with it. */
const frames = function* (chunk: string): Generator<unknown> {
  if (/^\s*content-length:/i.test(chunk)) {
    const blank = chunk.search(/\r?\n\r?\n/);
    if (blank >= 0) {
      const body = chunk.slice(blank).replace(/^\r?\n\r?\n/, "");
      yield* frames(body);
      return;
    }
  }
  for (const line of chunk.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    try {
      yield JSON.parse(trimmed);
    } catch {
      debug("skipped an unparsable line");
    }
  }
};

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) await main();
