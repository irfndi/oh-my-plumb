import path from "node:path";
import type { Rubric } from "oh-my-plumb-schema";
import { findMcpServer } from "./detect.js";
import { GUARD_TIMEOUT_MS } from "./guards.js";
import { readMcpInstructions } from "./mcp.js";
import { debug } from "./output.js";
import { mcpSourceScope, type McpSourceCandidate } from "./sources.js";

/**
 * The instructions of every MCP server the rubric opts into (`mcpInstructions`),
 * captured read-only and turned into rule-source candidates. A server that is
 * missing, hangs, or sends none yields no candidate: no throw, no partial state.
 */
export const discoverMcpSources = async (
  root: string,
  rubric: Rubric | undefined,
  timeoutMs: number = GUARD_TIMEOUT_MS,
): Promise<McpSourceCandidate[]> => {
  const servers = [...new Set(rubric?.mcpInstructions ?? [])];
  const captured = await Promise.all(
    servers.map(async (server): Promise<McpSourceCandidate[]> => {
      const launch = findMcpServer(root, server);
      if (launch === undefined) {
        debug(`mcp instructions skipped: server "${server}" not found in host MCP config`);
        return [];
      }
      const text = await readMcpInstructions(launch, root, timeoutMs);
      if (text === undefined) return [];
      return [
        {
          path: server,
          absolute: path.resolve(root, server),
          scope: mcpSourceScope(server),
          required: false,
          origin: "mcp",
          text,
        },
      ];
    }),
  );
  return captured.flat();
};
