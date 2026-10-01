import path from "node:path";
import { installRoot } from "../lib/packageRoot.js";
import { say } from "../lib/ui.js";

/**
 * Prints how to attach oh-my-plumb's MCP server to each host, so an agent can
 * call check, audit, report and bench as tools. Nothing is written: the config
 * is the host's own, and one pasted block beats four parsers.
 */
export const runMcp = async (argv: string[]): Promise<number> => {
  const json = argv.includes("--json");
  const script = path.join(installRoot(), "dist", "mcp-server.js");
  if (json) {
    say(JSON.stringify({ script, command: "node", args: [script] }));
    return 0;
  }
  say("oh-my-plumb also runs as an MCP server, so an agent can call check, audit,");
  say("report and bench as tools - in codemode, one script can call check, filter");
  say("the verdicts and drive the repair.");
  say("");
  say(`  server: node ${script}`);
  say("");
  say("Claude Code : claude mcp add oh-my-plumb -- node " + script);
  say("              (add --scope user to have it in every project)");
  say("Codex       : in ~/.codex/config.toml");
  say("              [mcp_servers.oh-my-plumb]");
  say('              command = "node"');
  say(`              args = ["${script}"]`);
  say("OpenCode    : in opencode.json");
  say('              "mcp": { "oh-my-plumb": { "type": "local",');
  say(`                "command": ["node", "${script}"] } }`);
  say("Pi          : in .pi/mcp.json or ~/.pi/agent/mcp.json");
  say('              { "mcpServers": { "oh-my-plumb": {');
  say(`                "command": "node", "args": ["${script}"] } } }`);
  return 0;
};
