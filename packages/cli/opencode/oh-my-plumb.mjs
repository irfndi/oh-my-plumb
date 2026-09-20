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
// Nothing here may throw into OpenCode. Every path catches, and the script has
// its own deadline.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../dist/oh-my-plumb-hook.js", import.meta.url));

const runHook = (name, payload, timeoutMs) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    let child;
    try {
      child = spawn("node", [HOOK, name], { stdio: ["pipe", "pipe", "ignore"] });
    } catch {
      finish(undefined);
      return;
    }
    const chunks = [];
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {}
      finish(undefined);
    }, timeoutMs);
    // EPIPE from a child that exited early arrives async; unheard it kills OpenCode.
    child.stdin.on("error", () => {});
    child.stdout.on("error", () => {});
    child.stdout.on("data", (c) => chunks.push(c));
    child.on("error", () => {
      clearTimeout(timer);
      finish(undefined);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text === "") {
        finish(undefined);
        return;
      }
      try {
        finish(JSON.parse(text));
      } catch {
        finish(undefined);
      }
    });
    try {
      child.stdin.end(JSON.stringify(payload));
    } catch {
      clearTimeout(timer);
      finish(undefined);
    }
  });

/** Unified-diff hunks, as the Claude-style payload carries them, from OpenCode's own diff text. */
const hunksFrom = (diff) => {
  if (typeof diff !== "string") return undefined;
  const hunks = [];
  let current;
  for (const line of diff.split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      hunks.push(current);
      continue;
    }
    if (current && /^[ +-]/.test(line)) current.lines.push(line);
  }
  return hunks.length > 0 ? hunks : undefined;
};

const textOf = (parts) =>
  (Array.isArray(parts) ? parts : [])
    .filter((p) => p && p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n");

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
        if (input?.tool !== "edit" && input?.tool !== "write") return;
        const s = sessions.get(input.sessionID);
        if (!s) return;
        const args = input.args ?? {};
        const file_path = absolute(args.filePath);
        if (file_path === "") return;
        const hunks = hunksFrom(output?.metadata?.diff);
        const payload =
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
