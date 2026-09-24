// Fake stdio MCP server for tests: no network, mode via argv.
// Logs every message it receives to $FAKE_MCP_LOG so tests can assert the
// exact call sequence (initialize -> notifications/initialized -> tools/call).
// Modes: success | error | timeout | malformed | framed | framed-odd | env | flood
import { appendFileSync } from "node:fs";

const mode = process.argv[2] ?? "success";
const log = process.env.FAKE_MCP_LOG;
const send = (msg) => {
  if (mode === "framed-odd") {
    // Lowercase name, an extra header, and the header split across writes.
    const body = Buffer.from(JSON.stringify(msg));
    process.stdout.write("content-len");
    setTimeout(() => {
      process.stdout.write(`gth: ${body.length}\r\nContent-Type: application/json\r\n\r\n`);
      process.stdout.write(body);
    }, 20);
    return;
  }
  if (mode === "framed") {
    const body = Buffer.from(JSON.stringify(msg));
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
    return;
  }
  process.stdout.write(`${JSON.stringify(msg)}\n`);
};

if (mode === "malformed") process.stdout.write("this is not json\n");
if (mode === "flood") process.stdout.write("x".repeat(2 * 1024 * 1024));

const initializeResult = {
  protocolVersion: "2025-06-18",
  capabilities: {},
  serverInfo: { name: "fake-mcp", version: "0" },
};
const toolsResult = { content: [{ type: "text", text: "ok" }], isError: false };
const toolsError = { content: [{ type: "text", text: "bad fk" }], isError: true };

const handle = (msg) => {
  if (log !== undefined && log !== "") appendFileSync(log, `${JSON.stringify(msg)}\n`);
  if (mode === "timeout" && msg.method === "tools/call") return;
  if (msg.id === 1 && msg.method === "initialize") {
    // A notification before the response proves the client filters by id.
    if (mode === "success") {
      send({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info" } });
    }
    send({ jsonrpc: "2.0", id: 1, result: initializeResult });
    return;
  }
  if (msg.method === "notifications/initialized") return;
  if (msg.id === 2 && msg.method === "tools/call") {
    // malformed answers with a hit too: a client that tolerates the garbage
    // line instead of failing closed would surface as a guard hit here.
    const result =
      mode === "env"
        ? { content: [{ type: "text", text: `env=${process.env.FAKE_MCP_SECRET}` }], isError: true }
        : mode === "error" || mode === "malformed"
          ? toolsError
          : toolsResult;
    send({ jsonrpc: "2.0", id: 2, result });
  }
};

let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  for (;;) {
    const nl = buffer.indexOf("\n");
    if (nl < 0) return;
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (line.trim() === "") continue;
    try {
      handle(JSON.parse(line));
    } catch {
      // The client should only ever send valid JSON-RPC lines.
    }
  }
});
