// oh-my-plumb for OpenCode v2 (the anomalyco/opencode `v2` branch).
//
// v1 loads a default-exported function. v2 loads a definition instead: an
// object with an id and a setup function, which its own Plugin.define returns
// unchanged, so a plain object is the whole contract and the plugin package is
// not a dependency. The three hooks below turn each v2 event into the payload
// the oh-my-plumb hook script already understands, run that same script, and
// put the answer where v2 will carry it to the model: an edit's repair request
// is appended to its tool result, a turn's repair request is spliced in ahead
// of the prompt as one follow-up message, and a denied call throws before it
// runs. The checks, the rubric and the messages are the same as on every
// other host.
//
// Nothing here may throw into OpenCode — a deny is the one exception: throwing
// is how tool.execute.before keeps the call from running. Every other path
// catches, and the script has its own deadline.
//
// Field names were read from v2 at commit
// 0bc8b8dbeb9540842ae5a69bb5c9af3182999522: tool hooks in
// packages/plugin/src/promise/tool.ts (event.tool, event.input, event.id,
// event.status, event.result, event.error), session hooks in
// packages/plugin/src/promise/session.ts (event.sessionID, event.messages with
// role and content), the setup context in packages/plugin/src/promise/plugin.ts
// (ctx.location.directory), and the edit/write/patch inputs and results in
// packages/core/src/tool/plugin/edit.ts, write.ts and patch.ts.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
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

/** Unified-diff hunks, as the Claude-style payload carries them, from v2's per-file patch text. */
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

// v2's own read-only tools are never judged, so they never spawn a hook.
// v1's list and todoread do not exist on v2.
const READ_ONLY = { read: true, grep: true, glob: true };
// edit, write and patch change files, so they are judged after they run, like v1's edit and write.
const EDITS = { edit: true, write: true, patch: true };

/** What the hook's answer means before a call runs: a deny stops it, a note only annotates it. */
const preToolCallResult = (out) => {
  const decision = out?.hookSpecificOutput;
  if (
    decision?.permissionDecision === "deny" &&
    typeof decision.permissionDecisionReason === "string" &&
    decision.permissionDecisionReason !== ""
  ) {
    return { block: true, reason: decision.permissionDecisionReason };
  }
  return undefined;
};

/** A repair request goes where the model reads next: the tool result, or the error when the call failed. */
const appendReason = (event, reason) => {
  const note = `\n\n${reason}`;
  if (event.status === "completed" && event.result !== undefined) {
    const content = event.result.content;
    if (typeof content === "string") event.result.content = content + note;
    else if (Array.isArray(content))
      event.result.content = [...content, { type: "text", text: reason }];
    else event.result.content = [{ type: "text", text: reason }];
    return;
  }
  if (event.status === "error" && typeof event.error?.message === "string") {
    event.error.message += note;
  }
};

export default {
  id: "oh-my-plumb",
  setup: async (ctx) => {
    const directory = typeof ctx?.location?.directory === "string" ? ctx.location.directory : "";
    const sessions = new Map();
    const state = (sessionID) => {
      let s = sessions.get(sessionID);
      if (s === undefined) {
        s = { started: false, boundary: undefined, followups: 0 };
        sessions.set(sessionID, s);
      }
      return s;
    };
    const absolute = (file) =>
      typeof file !== "string" || file === ""
        ? ""
        : path.isAbsolute(file)
          ? file
          : path.join(directory, file);
    // v2 exposes no log API on these hooks, so the flag band's note has nowhere
    // to go; it never blocks, which is the whole of its contract here.
    const note = (text) => ({ role: "user", content: [{ type: "text", text }] });

    await ctx.tool.hook("execute.before", async (event) => {
      let deny;
      try {
        const tool = event?.tool;
        if (
          typeof tool !== "string" ||
          Object.hasOwn(EDITS, tool) ||
          Object.hasOwn(READ_ONLY, tool)
        )
          return;
        if (typeof event.sessionID !== "string" || !toolCallRulesFor(directory)) return;
        const out = await runHook(
          "pre-tool-use",
          {
            tool_name: tool,
            tool_input: event.input ?? {},
            session_id: event.sessionID,
            cwd: directory,
            hook_event_name: "PreToolUse",
            tool_use_id: event.id,
          },
          20_000,
        );
        const result = preToolCallResult(out);
        if (result?.block) deny = result.reason;
      } catch {}
      // A throw is v2's documented way to keep tool.execute.before from running the call.
      if (typeof deny === "string") throw new Error(deny);
    });

    await ctx.tool.hook("execute.after", async (event) => {
      try {
        const tool = event?.tool;
        if (typeof tool !== "string") return;
        const edits = Object.hasOwn(EDITS, tool);
        if (!edits && Object.hasOwn(READ_ONLY, tool)) return;
        // An edit that failed changed nothing; a call that failed still ran.
        if (edits && event.status !== "completed") return;
        const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
        const input = event.input ?? {};
        let payload;
        if (tool === "edit") {
          const file_path = absolute(input.path);
          if (file_path === "") return;
          const files = event.result?.metadata?.files ?? event.result?.output?.files;
          const chosen =
            Array.isArray(files) && files.length > 0
              ? (files.find((f) => typeof f?.file === "string" && absolute(f.file) === file_path) ??
                files[0])
              : undefined;
          const hunks = hunksFrom(chosen?.patch);
          payload = {
            tool_name: "Edit",
            tool_input: {
              file_path,
              old_string: String(input.oldString ?? ""),
              new_string: String(input.newString ?? ""),
              replace_all: Boolean(input.replaceAll),
            },
            tool_response: hunks ? { filePath: file_path, structuredPatch: hunks } : {},
          };
        } else if (tool === "write") {
          const file_path = absolute(input.path);
          if (file_path === "") return;
          // v2's write result carries no diff, so the hook treats the file as new.
          payload = {
            tool_name: "Write",
            tool_input: { file_path, content: String(input.content ?? "") },
            tool_response: { filePath: file_path, originalFile: null },
          };
        } else if (tool === "patch") {
          // v2's patch speaks the same *** Begin Patch dialect as apply_patch.
          payload = {
            tool_name: "apply_patch",
            tool_input: { command: String(input.patchText ?? "") },
          };
        } else {
          if (!toolCallRulesFor(directory)) return;
          payload = { tool_name: tool, tool_input: input };
        }
        const out = await runHook(
          "post-tool-use",
          {
            ...payload,
            session_id: sessionID,
            cwd: directory,
            hook_event_name: "PostToolUse",
            tool_use_id: event.id,
          },
          20_000,
        );
        if (out?.decision === "block" && typeof out.reason === "string")
          appendReason(event, out.reason);
      } catch {}
    });

    await ctx.session.hook("context", async (event) => {
      try {
        const sessionID = typeof event.sessionID === "string" ? event.sessionID : "";
        if (sessionID === "") return;
        const messages = Array.isArray(event.messages) ? event.messages : [];
        if (messages.at(-1)?.role !== "user") return; // mid-turn: not a turn boundary
        const s = state(sessionID);
        const prompt = textOf(messages.at(-1)?.content);
        const boundary = `${messages.length}:${prompt}`;
        if (s.boundary === boundary) return; // the same request prepared twice
        // Session start rides the first request of the session, as v1 runs it from the first message.
        if (!s.started) {
          s.started = true;
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
            messages.splice(messages.length - 1, 0, note(context));
          }
        }
        // The turn that settled is judged here, before the model reads this request.
        if (messages.some((m) => m?.role === "assistant")) {
          const out = await runHook(
            "stop",
            {
              session_id: sessionID,
              cwd: directory,
              hook_event_name: "Stop",
              stop_hook_active: s.followups > 0,
            },
            30_000,
          );
          if (out?.decision === "block" && typeof out.reason === "string" && s.followups < 1) {
            s.followups = 1;
            messages.splice(messages.length - 1, 0, note(out.reason));
          } else {
            s.followups = 0;
          }
        }
        s.boundary = boundary;
        await runHook(
          "turn-start",
          { session_id: sessionID, cwd: directory, hook_event_name: "UserPromptSubmit", prompt },
          10_000,
        );
      } catch {}
    });
  },
};
