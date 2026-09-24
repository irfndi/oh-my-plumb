// Helpers both OpenCode plugins (v1 and v2) share: spawning the hook script,
// reading the hook's answer, and deciding whether a tool call is worth a hook.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK = fileURLToPath(new URL("../dist/oh-my-plumb-hook.js", import.meta.url));

export const runHook = (name, payload, timeoutMs) =>
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
export const hunksFrom = (diff) => {
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

export const textOf = (parts) =>
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
      rubric.rules.some(
        (rule) =>
          rule?.status !== "disabled" &&
          (rule?.target === "toolCall" || String(rule?.source?.path ?? "").endsWith("/SKILL.md")),
      )
    );
  } catch {
    return false;
  }
};

export const toolCallRulesFor = (cwd) => {
  const home = process.env.OH_MY_PLUMB_HOME_DIR ?? homedir();
  if (hasToolCallRule(path.join(home, ".oh-my-plumb", "global.json"))) return true;
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (hasToolCallRule(path.join(dir, ".oh-my-plumb", "rubric.json"))) return true;
    if (path.dirname(dir) === dir) return false;
  }
};

/** What the hook's answer means before a call runs: a deny stops it, a note is shown to the user. */
export const preToolCallResult = (out) => {
  const decision = out?.hookSpecificOutput;
  if (
    decision?.permissionDecision === "deny" &&
    typeof decision.permissionDecisionReason === "string" &&
    decision.permissionDecisionReason !== ""
  ) {
    const note =
      typeof out?.systemMessage === "string" && out.systemMessage !== ""
        ? out.systemMessage
        : undefined;
    return { block: true, reason: decision.permissionDecisionReason, note };
  }
  if (typeof out?.systemMessage === "string" && out.systemMessage !== "") {
    return { note: out.systemMessage };
  }
  return undefined;
};
