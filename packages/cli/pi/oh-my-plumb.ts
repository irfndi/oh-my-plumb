// oh-my-plumb for Pi.
//
// Pi loads this module into its own process: it subscribes to tool events,
// runs the same hook script every other host runs, and returns Pi-shaped
// patches. Nothing here may throw into Pi. Every path catches, and the hook
// script has its own deadline.
import { spawn } from "node:child_process";
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

export default function ohMyPlumb(pi) {
  pi.on("tool_result", async (event, ctx) => {
    try {
      if (!EDIT_TOOLS[event.toolName]) return;
      const input = event.input ?? {};
      const filePath = input.path ?? input.filePath ?? input.file_path ?? "";
      if (typeof filePath !== "string" || filePath === "") return;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "pi";
      const out = await runHook(
        "post-tool-use",
        {
          tool_name: event.toolName === "write" ? "Write" : "Edit",
          tool_input: { file_path: filePath },
          tool_response: { filePath: filePath },
          session_id: sessionId,
          cwd: ctx.cwd ?? process.cwd(),
          hook_event_name: "PostToolUse",
          tool_use_id: event.toolCallId,
        },
        20_000,
      );
      if (out?.decision === "block" && typeof out.reason === "string") {
        return { content: [{ type: "text", text: `${textOf(event.content)}\n\n${out.reason}` }] };
      }
    } catch {}
  });

  pi.on("turn_end", async (event, ctx) => {
    try {
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
        pi.sendUserMessage(out.reason, { deliverAs: "followUp" });
      }
    } catch {}
  });
}
