// oh-my-plumb for Pi and Oh My Pi, which share this extension API.
//
// Pi loads this module into its own process: it subscribes to tool events,
// runs the same hook script every other host runs, and returns Pi-shaped
// patches. Nothing here may throw into Pi. Every path catches, and the hook
// script has its own deadline.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** Whether any rubric this session can load has a tool-call rule; without one a tool call is not worth a hook spawn. */
const hasToolCallRule = (file) => {
  try {
    const rubric = JSON.parse(readFileSync(file, "utf8"));
    return (
      Array.isArray(rubric?.rules) &&
      rubric.rules.some((rule) => rule?.target === "toolCall" && rule?.status !== "disabled")
    );
  } catch {
    return false;
  }
};

const toolCallRulesFor = (cwd) => {
  const home = process.env.OH_MY_PLUMB_HOME_DIR ?? homedir();
  if (hasToolCallRule(path.join(home, ".oh-my-plumb", "global.json"))) return true;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (hasToolCallRule(path.join(dir, ".oh-my-plumb", "rubric.json"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
};

const EDIT_TOOLS = { edit: true, write: true };
// Pi's own read-only tools are never judged, so they must not spawn a hook. Every
// other tool — bash, MCP, an extension's own — is forwarded; rule scopes decide.
const READ_TOOLS: Record<string, true> = { read: true, grep: true, glob: true };

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

export const toolCallPayload = ({ tool, input, sessionId, cwd, toolCallId }) => ({
  tool_name: tool,
  tool_input: input ?? {},
  session_id: sessionId,
  cwd,
  hook_event_name: "PostToolUse",
  tool_use_id: toolCallId,
});

export const preToolCallPayload = ({ tool, input, sessionId, cwd, toolCallId }) => ({
  tool_name: tool,
  tool_input: input ?? {},
  session_id: sessionId,
  cwd,
  hook_event_name: "PreToolUse",
  tool_use_id: toolCallId,
});

/** What the hook's answer means before a call runs: a deny blocks it, a note is shown to the user. */
export const preToolCallResult = (out) => {
  const decision = out?.hookSpecificOutput;
  if (
    decision?.permissionDecision === "deny" &&
    typeof decision.permissionDecisionReason === "string" &&
    decision.permissionDecisionReason !== ""
  ) {
    return { block: true, reason: decision.permissionDecisionReason };
  }
  if (typeof out?.systemMessage === "string" && out.systemMessage !== "") {
    return { note: out.systemMessage };
  }
  return undefined;
};

export default function ohMyPlumb(pi) {
  const originals = new Map();

  pi.on("tool_call", async (event, ctx) => {
    try {
      if (EDIT_TOOLS[event.toolName]) {
        // Pi's tool_result carries no original file, so it is read before the tool runs.
        const filePath = event.input?.path;
        if (typeof filePath !== "string" || filePath === "") return;
        const absolute = path.resolve(ctx.cwd ?? process.cwd(), filePath);
        originals.set(event.toolCallId, { absolute, original: readOrNull(absolute) });
        return;
      }
      if (typeof event.toolName !== "string" || READ_TOOLS[event.toolName]) return;
      if (!toolCallRulesFor(ctx.cwd ?? process.cwd())) return;
      const out = await runHook(
        "pre-tool-use",
        preToolCallPayload({
          tool: event.toolName,
          input: event.input,
          sessionId: ctx.sessionManager?.getSessionId?.() ?? "pi",
          cwd: ctx.cwd ?? process.cwd(),
          toolCallId: event.toolCallId,
        }),
        20_000,
      );
      const result = preToolCallResult(out);
      if (result?.block) return { block: true, reason: result.reason };
      if (result?.note !== undefined) ctx.ui?.notify?.(result.note, "warning");
    } catch {}
  });

  pi.on("tool_result", async (event, ctx) => {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "pi";
      const cwd = ctx.cwd ?? process.cwd();
      const before = originals.get(event.toolCallId);
      originals.delete(event.toolCallId);
      if (EDIT_TOOLS[event.toolName]) {
        if (before === undefined || event.isError) return;
        const after = readOrNull(before.absolute);
        if (after === null) return;
        const out = await runHook(
          "post-tool-use",
          postToolUsePayload({
            filePath: before.absolute,
            original: before.original,
            after,
            sessionId,
            cwd,
            toolCallId: event.toolCallId,
          }),
          20_000,
        );
        if (out?.decision === "block" && typeof out.reason === "string") {
          return { content: [{ type: "text", text: `${textOf(event.content)}\n\n${out.reason}` }] };
        }
        return;
      }
      if (typeof event.toolName !== "string" || READ_TOOLS[event.toolName]) return;
      if (!toolCallRulesFor(cwd)) return;
      // A failed attempt still counts: the call was made, and a rule may forbid it.
      const out = await runHook(
        "post-tool-use",
        toolCallPayload({
          tool: event.toolName,
          input: event.input,
          sessionId,
          cwd,
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
  // Oh My Pi has no agent_before_settle; its equivalent is session_stop below.
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
  pi.on("session_stop", async (event, ctx) => {
    try {
      const out = await runHook(
        "stop",
        {
          session_id: event.session_id ?? ctx.sessionManager?.getSessionId?.() ?? "omp",
          cwd: ctx.cwd ?? process.cwd(),
          hook_event_name: "Stop",
          stop_hook_active: event.stop_hook_active === true,
        },
        30_000,
      );
      if (out?.decision === "block" && typeof out.reason === "string") {
        return { decision: "block", reason: out.reason };
      }
    } catch {}
  });
}
