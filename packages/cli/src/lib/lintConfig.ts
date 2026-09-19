import { existsSync, readdirSync, type Dirent } from "node:fs";
import path from "node:path";
import { relativeToRoot } from "./paths.js";

const NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yml",
  ".eslintrc.yaml",
  "biome.json",
  "biome.jsonc",
  ".stylelintrc",
  ".stylelintrc.json",
  ".stylelintrc.js",
  ".stylelintrc.cjs",
  ".stylelintrc.yml",
  "stylelint.config.js",
  "stylelint.config.mjs",
  "stylelint.config.cjs",
  ".oxlintrc.json",
];
const SKIP = new Set(["node_modules", ".git", "dist", "build", ".next", "coverage", "vendor"]);

/** Lint config files at the root and up to two directory levels down (workspaces). */
export const findLintConfigs = (root: string): string[] => {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    for (const name of NAMES) {
      const file = path.join(dir, name);
      if (existsSync(file)) found.push(relativeToRoot(root, file));
    }
    if (depth >= 2) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !SKIP.has(entry.name) && !entry.name.startsWith(".")) {
        visit(path.join(dir, entry.name), depth + 1);
      }
    }
  };
  visit(root, 0);
  return found;
};
