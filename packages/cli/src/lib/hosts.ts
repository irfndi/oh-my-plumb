import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { PlumbError, assertNever, HOSTS, hostSchema, type Host } from "oh-my-plumb-schema";
import { installPiExtension, uninstallPiExtension } from "./piPlugin.js";
import { installOpencodePlugin, uninstallOpencodePlugin } from "./opencodePlugin.js";
import { hookScriptPath } from "./packageRoot.js";
import { homeDir } from "./paths.js";
import { hookSpecs, installHooks, uninstallHooks } from "./settings.js";

export const hostLabel = (host: Host): string => {
  switch (host) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "opencode":
      return "OpenCode";
    case "pi":
      return "Pi";
    default:
      return assertNever(host);
  }
};

export const parseHost = (name: string): Host => {
  const parsed = hostSchema.safeParse(name.toLowerCase());
  if (!parsed.success)
    throw new PlumbError("HOST_UNKNOWN", `"${name}" is not one of ${HOSTS.join(", ")}`);
  return parsed.data;
};

const onPath = (bin: string): boolean =>
  spawnSync("which", [bin], { encoding: "utf8" }).status === 0;

export const hostPresent = (host: Host): boolean => {
  switch (host) {
    case "claude":
      return existsSync(path.join(homeDir(), ".claude")) || onPath("claude");
    case "codex":
      return existsSync(path.join(homeDir(), ".codex")) || onPath("codex");
    case "opencode":
      return existsSync(path.join(homeDir(), ".config", "opencode")) || onPath("opencode");
    case "pi":
      return existsSync(path.join(homeDir(), ".pi", "agent", "extensions")) || onPath("pi");
    default:
      return assertNever(host);
  }
};

export const detectHosts = (): Host[] => HOSTS.filter(hostPresent);

/**
 * Where oh-my-plumb's entries live for a host. Claude Code and Codex read the same
 * hooks JSON shape from different files; OpenCode loads a plugin file from a
 * directory it watches, so no config file is edited there.
 */
export const installTarget = (host: Host, root: string, project: boolean): string => {
  switch (host) {
    case "claude":
      return project
        ? path.join(root, ".claude", "settings.json")
        : path.join(homeDir(), ".claude", "settings.json");
    case "codex":
      return project
        ? path.join(root, ".codex", "hooks.json")
        : path.join(homeDir(), ".codex", "hooks.json");
    case "opencode":
      return project
        ? path.join(root, ".opencode", "plugins", "oh-my-plumb.js")
        : path.join(homeDir(), ".config", "opencode", "plugins", "oh-my-plumb.js");
    case "pi":
      return project
        ? path.join(root, ".pi", "extensions", "oh-my-plumb.ts")
        : path.join(homeDir(), ".pi", "agent", "extensions", "oh-my-plumb.ts");
    default:
      return assertNever(host);
  }
};

export type Installed = { host: Host; target: string; what: string; afterwards?: string };

export const installHost = (host: Host, root: string, project: boolean): Installed => {
  const target = installTarget(host, root, project);
  switch (host) {
    case "claude":
      installHooks(target, hookSpecs(hookScriptPath()));
      return {
        host,
        target,
        what: "hooks written: SessionStart, UserPromptSubmit, PostToolUse, Stop",
      };
    case "codex":
      installHooks(target, hookSpecs(hookScriptPath()));
      return {
        host,
        target,
        what: "hooks written: SessionStart, UserPromptSubmit, PostToolUse, Stop",
        afterwards:
          "Codex trusts new hooks once: start codex, type /hooks, accept the four oh-my-plumb entries.",
      };
    case "opencode":
      installOpencodePlugin(target);
      return { host, target, what: "plugin written; OpenCode loads it at the next start" };
    case "pi": {
      installPiExtension(target);
      const what = "extension written; Pi loads it at the next start";
      // Without project trust pi skips .pi/extensions silently, which reads as a broken install.
      if (!project) return { host, target, what };
      return {
        host,
        target,
        what,
        afterwards:
          "Pi only loads a project extension once the project is trusted: accept pi's trust prompt the next time you start pi here. `pi --approve` trusts it for one run without saving that.",
      };
    }
    default:
      return assertNever(host);
  }
};

export const uninstallHost = (host: Host, root: string, project: boolean): number => {
  const target = installTarget(host, root, project);
  switch (host) {
    case "claude":
    case "codex":
      return uninstallHooks(target);
    case "opencode":
      return uninstallOpencodePlugin(target) ? 1 : 0;
    case "pi":
      return uninstallPiExtension(target) ? 1 : 0;
    default:
      return assertNever(host);
  }
};
