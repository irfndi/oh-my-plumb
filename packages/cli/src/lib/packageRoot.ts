import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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

export const hookScriptPath = (): string => path.join(packageRoot(), "dist", "oh-my-plumb-hook.js");
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
