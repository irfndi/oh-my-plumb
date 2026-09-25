import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PlumbError } from "oh-my-plumb-schema";
import { globalOhMyPlumbDir } from "./paths.js";
import { readRegularText, writeRegularFile } from "./regularFile.js";

/** Directory of the installed oh-my-plumb package (the one holding package.json). */
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

/** The node_modules folder holding this package when npx ran it from its cache. */
const npxNodeModules = (root: string): string | undefined => {
  const parent = path.dirname(root);
  return path.basename(parent) === "node_modules" && root.split(path.sep).includes("_npx")
    ? parent
    : undefined;
};

/**
 * Copies this package and its dependencies out of the npx cache, once per
 * version. The copy is staged and renamed into place, so a half-finished copy
 * is never mistaken for a complete one.
 */
const copyOutOfNpx = (root: string, nodeModules: string): string => {
  const dir = path.join(globalOhMyPlumbDir(), "runtime", packageVersion(root));
  const copied = path.join(dir, "node_modules", path.basename(root));
  if (existsSync(path.join(copied, "package.json"))) return copied;
  const staging = `${dir}.${process.pid}.tmp`;
  try {
    rmSync(staging, { recursive: true, force: true });
    cpSync(nodeModules, path.join(staging, "node_modules"), {
      recursive: true,
      verbatimSymlinks: true,
    });
    mkdirSync(path.dirname(dir), { recursive: true });
    try {
      renameSync(staging, dir);
    } catch (error) {
      // Another init finished the same copy first.
      if (!existsSync(path.join(copied, "package.json"))) throw error;
    }
  } catch (error) {
    throw new PlumbError("RUNTIME_COPY_FAILED", `could not copy ${nodeModules} to ${dir}`, {
      cause: error,
    });
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return copied;
};

/**
 * The package hosts are pointed at. npm may clear its npx cache at any time,
 * and a hook left pointing there fails on every event, so a copy run by npx
 * points hosts at a copy of itself under ~/.oh-my-plumb/runtime instead.
 */
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
