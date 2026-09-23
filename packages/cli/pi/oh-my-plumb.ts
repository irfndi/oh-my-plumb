// oh-my-plumb for Pi.
//
// Pi loads this module into its own process: it subscribes to tool events,
// runs the same hook script every other host runs, and returns Pi-shaped
// patches. Nothing here may throw into Pi. Every path catches, and the hook
// script has its own deadline.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../dist/oh-my-plumb-hook.js", import.meta.url));

const runHook = (name, payload, timeoutMs) => {
  const { promise, resolve } = Promise.withResolvers();
  let settled = false;
  let timer;
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(value);
  };
  let child;
  try {
    child = spawn("node", [HOOK, name], { stdio: ["pipe", "pipe", "ignore"] });
  } catch {
    finish(undefined);
    return promise;
  }
  const chunks = [];
  timer = setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {}
    finish(undefined);
  }, timeoutMs);
  child.stdin.on("error", () => {});
  child.stdout.on("error", () => {});
  child.stdout.on("data", (c) => chunks.push(c));
  child.on("error", () => finish(undefined));
  child.on("close", () => {
    try {
      const text = Buffer.concat(chunks).toString("utf8").trim().split("\n").pop() ?? "";
      finish(text === "" ? undefined : JSON.parse(text));
    } catch {
      finish(undefined);
    }
  });
  try {
    child.stdin.end(JSON.stringify(payload));
  } catch {
    finish(undefined);
  }
  return promise;
};

const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

const EDIT_TOOLS = { edit: true, write: true };

const readOrNull = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
};

export const postToolUsePayload = ({ filePath, original, after, sessionId, cwd, toolCallId }) => ({
  tool_name: "Write",
  tool_input: { file_path: filePath, content: after },
  tool_response: { filePath, originalFile: original },
  session_id: sessionId,
  cwd,
  hook_event_name: "PostToolUse",
  tool_use_id: toolCallId,
});

export default function ohMyPlumb(pi) {
  // Pi's tool_result carries no original file, so it is read before the tool runs.
  const originals = new Map();

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (!EDIT_TOOLS[event.toolName]) return;
      const filePath = event.input?.path;
      if (typeof filePath !== "string" || filePath === "") return;
      const absolute = path.resolve(ctx.cwd ?? process.cwd(), filePath);
      originals.set(event.toolCallId, { absolute, original: readOrNull(absolute) });
    } catch {}
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      const before = originals.get(event.toolCallId);
      originals.delete(event.toolCallId);
      if (!EDIT_TOOLS[event.toolName] || before === undefined || event.isError) return;
      const after = readOrNull(before.absolute);
      if (after === null) return;
      const out = await runHook(
        "post-tool-use",
        postToolUsePayload({
          filePath: before.absolute,
          original: before.original,
          after,
          sessionId: ctx.sessionManager?.getSessionId?.() ?? "pi",
          cwd: ctx.cwd ?? process.cwd(),
          toolCallId: event.toolCallId,
        }),
        20_000,
      );
      if (out?.decision === "block" && typeof out.reason === "string") {
        return { content: [{ type: "text", text: `${textOf(event.content)}\n\n${out.reason}` }] };
      }
    } catch {}
  });

  // turn_end fires after every model round in Pi; agent_before_settle fires
  // once, when the agent is about to stop, and allows one continuation.
  pi.on("agent_before_settle", async (event, ctx) => {
    try {
      if (event.outcome !== "completed") return;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "pi";
      const out = await runHook(
        "stop",
        {
          session_id: sessionId,
          cwd: ctx.cwd ?? process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: false,
        },
        30_000,
      );
      if (out?.decision === "block" && typeof out.reason === "string") {
        return {
          entries: [
            {
              type: "custom_message",
              customType: "oh-my-plumb",
              content: out.reason,
              display: true,
            },
          ],
          continue: true,
        };
      }
    } catch {}
  });
}
