// oh-my-plumb for OpenCode.
//
// OpenCode has no hook processes: it loads this module into its own server and
// calls the functions below. Each one turns the OpenCode event into the payload
// the oh-my-plumb hook script already understands, runs that script, and puts the
// answer where OpenCode will carry it to the model: an edit's repair request is
// appended to the tool result, a turn's repair request is sent as one follow-up
// message. The checks, the rubric and the messages are the same as on every
// other host.
//
// Nothing here may throw into OpenCode — a deny is the one exception: throwing
// is how tool.execute.before keeps the call from running. Every other path
// catches, and the script has its own deadline.

import path from "node:path";
import { hunksFrom, preToolCallResult, runHook, textOf, toolCallRulesFor } from "./shared.mjs";

export { preToolCallResult, toolCallRulesFor };

// OpenCode's own read-only tools are never judged, so they never spawn a hook.
const READ_TOOLS = new Set(["read", "grep", "glob", "list", "todoread"]);

/** A shell or MCP call as the hook's schema reads it; rule scopes match on the name. */
export const toolCallPayload = ({ tool, args, sessionID, turnId, directory, callID }) => ({
  tool_name: tool,
  tool_input: args ?? {},
  session_id: sessionID,
  prompt_id: turnId,
  cwd: directory,
  hook_event_name: "PostToolUse",
  tool_use_id: callID,
});

export const preToolCallPayload = ({ tool, args, sessionID, turnId, directory, callID }) => ({
  tool_name: tool,
  tool_input: args ?? {},
  session_id: sessionID,
  prompt_id: turnId,
  cwd: directory,
  hook_event_name: "PreToolUse",
  tool_use_id: callID,
});

export default async ({ client, directory }) => {
  const log = (message) => {
    try {
      // An unhandled rejection is as fatal to the host as a throw.
      Promise.resolve(
        client?.app?.log?.({ body: { service: "oh-my-plumb", level: "info", message } }),
      ).catch(() => {});
    } catch {}
  };
  /** Per session: the turn being checked, and whether oh-my-plumb's own follow-up is in flight. */
  const sessions = new Map();
  const absolute = (file) =>
    typeof file !== "string" ? "" : path.isAbsolute(file) ? file : path.join(directory, file);

  return {
    "tool.execute.before": async (input, output) => {
      let deny;
      try {
        const tool = input?.tool;
        if (typeof tool !== "string" || tool === "edit" || tool === "write" || READ_TOOLS.has(tool))
          return;
        // A session this plugin has not seen (a reload wipes the map) is still checked, without a turn id.
        if (typeof input.sessionID !== "string" || !toolCallRulesFor(directory)) return;
        const out = await runHook(
          "pre-tool-use",
          preToolCallPayload({
            tool,
            args: output.args,
            sessionID: input.sessionID,
            turnId: sessions.get(input.sessionID)?.turnId,
            directory,
            callID: input.callID,
          }),
          20_000,
        );
        const result = preToolCallResult(out);
        if (result?.note !== undefined) log(result.note);
        if (result?.block) deny = result.reason;
      } catch {}
      // A throw is OpenCode's documented way to keep tool.execute.before from running the call.
      if (typeof deny === "string") throw new Error(deny);
    },

    "chat.message": async (input, output) => {
      try {
        const sessionID = input?.sessionID;
        const message = output?.message;
        if (!sessionID || !message?.id) return;
        const text = textOf(output.parts);
        let s = sessions.get(sessionID);
        if (!s) {
          s = { turnId: undefined, followups: 0, repairing: false };
          sessions.set(sessionID, s);
          const out = await runHook(
            "session-start",
            {
              session_id: sessionID,
              cwd: directory,
              hook_event_name: "SessionStart",
              source: "startup",
            },
            10_000,
          );
          const context = out?.hookSpecificOutput?.additionalContext;
          if (typeof context === "string" && context !== "") {
            output.parts.push({
              id: `prt_oh-my-plumb_${Date.now().toString(36)}`,
              sessionID,
              messageID: message.id,
              type: "text",
              text: context,
              synthetic: true,
            });
          }
          if (out?.systemMessage) log(out.systemMessage);
        }
        // oh-my-plumb's own repair request continues the turn it was raised in.
        if (s.repairing && text.startsWith("oh-my-plumb:")) {
          s.repairing = false;
          return;
        }
        s.turnId = message.id;
        s.followups = 0;
        await runHook(
          "turn-start",
          {
            session_id: sessionID,
            prompt_id: message.id,
            cwd: directory,
            hook_event_name: "UserPromptSubmit",
            prompt: text,
          },
          10_000,
        );
      } catch {}
    },

    "tool.execute.after": async (input, output) => {
      try {
        const s = sessions.get(input.sessionID);
        if (!s) return;
        let payload;
        if (
          typeof input?.tool === "string" &&
          input.tool !== "edit" &&
          input.tool !== "write" &&
          !READ_TOOLS.has(input.tool)
        ) {
          // bash, MCP tools and any other tool: forwarded only while a rubric has a tool-call rule.
          if (!toolCallRulesFor(directory)) return;
          payload = toolCallPayload({
            tool: input.tool,
            args: input.args,
            sessionID: input.sessionID,
            turnId: s.turnId,
            directory,
            callID: input.callID,
          });
        } else if (input?.tool === "edit" || input?.tool === "write") {
          const args = input.args ?? {};
          const file_path = absolute(args.filePath);
          if (file_path === "") return;
          const hunks = hunksFrom(output?.metadata?.diff);
          payload =
            input.tool === "edit"
              ? {
                  tool_name: "Edit",
                  tool_input: {
                    file_path,
                    old_string: String(args.oldString ?? ""),
                    new_string: String(args.newString ?? ""),
                    replace_all: Boolean(args.replaceAll),
                  },
                  tool_response: hunks ? { filePath: file_path, structuredPatch: hunks } : {},
                }
              : {
                  tool_name: "Write",
                  tool_input: { file_path, content: String(args.content ?? "") },
                  // A diff from the host means the file existed; without one it is treated as new.
                  tool_response: hunks
                    ? { filePath: file_path, originalFile: "", structuredPatch: hunks }
                    : { filePath: file_path, originalFile: null },
                };
        } else {
          return;
        }
        const out = await runHook(
          "post-tool-use",
          {
            ...payload,
            session_id: input.sessionID,
            prompt_id: s.turnId,
            cwd: directory,
            hook_event_name: "PostToolUse",
            tool_use_id: input.callID,
          },
          20_000,
        );
        if (out?.decision === "block" && typeof out.reason === "string") {
          output.output = `${output.output ?? ""}\n\n${out.reason}`;
        }
        if (out?.systemMessage) log(out.systemMessage);
      } catch {}
    },

    event: async ({ event }) => {
      try {
        if (event?.type !== "session.idle") return;
        const sessionID = event.properties?.sessionID;
        const s = sessions.get(sessionID);
        if (!s || !s.turnId) return;
        const out = await runHook(
          "stop",
          {
            session_id: sessionID,
            prompt_id: s.turnId,
            cwd: directory,
            hook_event_name: "Stop",
            stop_hook_active: s.followups > 0,
          },
          30_000,
        );
        if (out?.systemMessage) log(out.systemMessage);
        if (out?.decision === "block" && typeof out.reason === "string" && s.followups < 1) {
          s.followups += 1;
          s.repairing = true;
          await client.session.promptAsync({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: out.reason }] },
          });
        }
      } catch {}
    },
  };
};
