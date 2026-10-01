import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlumbError } from "oh-my-plumb-schema";
import { globalOhMyPlumbDir } from "./paths.js";
import { readRegularText, writeRegularFile } from "./regularFile.js";

/** Directory of the installed oh-my-plumb package (the one holding package.json). */
export const runningVersion = (): string => {
  try {
    const version: unknown = JSON.parse(
      readFileSync(path.join(packageRoot(), "package.json"), "utf8"),
    ).version;
    return typeof version === "string" ? version : "unknown";
  } catch {
    return "unknown";
  }
};

export const packageRoot = (): string => {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const name: unknown = JSON.parse(readFileSync(candidate, "utf8")).name;
        if (name === "oh-my-plumb") return dir;
      } catch {
        // keep walking
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return dir;
    dir = parent;
  }
};

const packageVersion = (root: string): string => {
  const version: unknown = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ).version;
  return typeof version === "string" ? version : "unknown";
};

/** node_modules when npx ran this from ~/.npm/_npx/<hash>/node_modules; the hash segment rules out a project's own `_npx` folder. */
const npxNodeModules = (root: string): string | undefined => {
  const parent = path.dirname(root);
  return path.basename(parent) === "node_modules" &&
    path.basename(path.dirname(path.dirname(parent))) === "_npx"
    ? parent
    : undefined;
};

const runtimeComplete = (copied: string): boolean =>
  [
    "package.json",
    "dist/oh-my-plumb-hook.js",
    "dist/bin.js",
    "dist/mcp-server.js",
    "pi/oh-my-plumb.ts",
    "opencode/oh-my-plumb.mjs",
    "opencode/oh-my-plumb-v2.js",
  ].every((file) => existsSync(path.join(copied, file)));

const copyOutOfNpx = (root: string, nodeModules: string): string => {
  const dir = path.join(globalOhMyPlumbDir(), "runtime", packageVersion(root));
  const copied = path.join(dir, "node_modules", path.basename(root));
  if (runtimeComplete(copied)) return copied;
  const staging = `${dir}.${process.pid}.tmp`;
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(nodeModules, path.join(staging, "node_modules"), { recursive: true, dereference: true });
    mkdirSync(path.dirname(dir), { recursive: true });
    const previous = `${dir}.previous`;
    rmSync(previous, { recursive: true, force: true });
    if (existsSync(dir)) renameSync(dir, previous);
    try {
      renameSync(staging, dir);
    } catch (error) {
      // Losing the race to another init is fine; losing the working copy is not.
      if (!runtimeComplete(copied)) {
        if (existsSync(previous)) renameSync(previous, dir);
        throw error;
      }
    }
    rmSync(previous, { recursive: true, force: true });
  } catch (error) {
    throw new PlumbError("RUNTIME_COPY_FAILED", `could not copy ${nodeModules} to ${dir}`, {
      cause: error,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return copied;
};

export const installRoot = (): string => {
  const root = packageRoot();
  const nodeModules = npxNodeModules(root);
  return nodeModules === undefined ? root : copyOutOfNpx(root, nodeModules);
};

export const hookScriptPath = (): string => path.join(installRoot(), "dist", "oh-my-plumb-hook.js");
export const binScriptPath = (): string => path.join(packageRoot(), "dist", "bin.js");
export const compileSkillPath = (): string =>
  path.join(packageRoot(), "skills", "oh-my-plumb-compile", "SKILL.md");

/**
 * Copies the packaged skill into the repo so the agent can read it without
 * leaving the project. A FIFO there would hold the hook and a symlink would
 * redirect the copy, so either falls back to the packaged path.
 */
export const placeCompileSkill = (root: string): string => {
  const packaged = compileSkillPath();
  const target = path.join(root, ".oh-my-plumb", "compile-skill.md");
  const skill = readRegularText(packaged);
  if (skill === undefined) return packaged;
  try {
    mkdirSync(path.dirname(target), { recursive: true });
  } catch {
    return packaged;
  }
  return writeRegularFile(target, skill, { use: "replace", followSymlinks: false })
    ? target
    : packaged;
};
