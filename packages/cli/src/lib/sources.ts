import { readdirSync, existsSync, type Dirent } from "node:fs";
import path from "node:path";
import { createSourceSha, type Rubric } from "oh-my-plumb-schema";
import { homeDir, resolveSourcePath, toSourcePath } from "./paths.js";
import { readRegularFile } from "./regularFile.js";

export type SourceCandidate = {
  /** Rubric spelling: repo-relative or "~/...". */
  path: string;
  absolute: string;
  /** Glob the file's rules apply to. */
  scope: string;
  /** Required candidates must appear in the rubric for it to be fresh. */
  required: boolean;
  origin: "root" | "nested" | "global" | "contributing";
};

const ROOT_NAMES = ["AGENTS.md", "CLAUDE.md", ".cursorrules"];
const NESTED_NAMES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_NAMES = ["~/.claude/CLAUDE.md", "~/.codex/AGENTS.md", "~/.config/opencode/AGENTS.md"];
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  "vendor",
  "coverage",
  ".turbo",
  ".cache",
  "target",
  ".oh-my-plumb",
  ".claude",
  ".codex",
  ".opencode",
]);
const MAX_DEPTH = 6;

const walkNested = (root: string, dir: string, depth: number, out: SourceCandidate[]): void => {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const sub = path.join(dir, entry.name);
    for (const name of NESTED_NAMES) {
      const file = path.join(sub, name);
      if (existsSync(file)) {
        const rel = toSourcePath(root, sub);
        out.push({
          path: toSourcePath(root, file),
          absolute: file,
          scope: `${rel}/**/*`,
          required: true,
          origin: "nested",
        });
      }
    }
    walkNested(root, sub, depth + 1, out);
  }
};

export const discoverProjectSources = (root: string): SourceCandidate[] => {
  const found: SourceCandidate[] = [];
  for (const name of ROOT_NAMES) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      found.push({ path: name, absolute: file, scope: "**/*", required: true, origin: "root" });
    }
  }
  walkNested(root, root, 1, found);
  const contributing = path.join(root, "CONTRIBUTING.md");
  if (existsSync(contributing)) {
    found.push({
      path: "CONTRIBUTING.md",
      absolute: contributing,
      scope: "**/*",
      required: false,
      origin: "contributing",
    });
  }
  return found;
};

export const discoverGlobalSources = (): SourceCandidate[] =>
  GLOBAL_NAMES.flatMap((p) => {
    const absolute = path.join(homeDir(), p.slice(2));
    return existsSync(absolute)
      ? [{ path: p, absolute, scope: "**/*", required: true, origin: "global" as const }]
      : [];
  });

export const hashFile = (absolute: string): string | undefined => {
  const bytes = readRegularFile(absolute);
  return bytes === undefined ? undefined : createSourceSha(bytes);
};

export type Staleness =
  | { status: "missing" }
  | { status: "fresh" }
  | { status: "stale"; changed: string[]; added: string[]; removed: string[]; unhashed: string[] };

export const checkStaleness = (
  rubric: Rubric | undefined,
  candidates: SourceCandidate[],
  root: string,
): Staleness => {
  if (rubric === undefined) return { status: "missing" };
  const changed: string[] = [];
  const removed: string[] = [];
  const unhashed: string[] = [];
  for (const source of rubric.sources) {
    const now = hashFile(resolveSourcePath(root, source.path));
    if (now === undefined) removed.push(source.path);
    else if (source.sha === undefined) unhashed.push(source.path);
    else if (source.sha !== now) changed.push(source.path);
  }
  const listed = new Set(rubric.sources.map((s) => path.resolve(resolveSourcePath(root, s.path))));
  const added = candidates
    .filter((c) => c.required && !listed.has(path.resolve(c.absolute)))
    .map((c) => c.path);
  if (changed.length + removed.length + unhashed.length + added.length === 0) {
    return { status: "fresh" };
  }
  return { status: "stale", changed, added, removed, unhashed };
};

export const describeStaleness = (s: Staleness): string => {
  switch (s.status) {
    case "missing":
      return "no rubric yet";
    case "fresh":
      return "up to date";
    case "stale": {
      const parts: string[] = [];
      if (s.changed.length) parts.push(`changed: ${s.changed.join(", ")}`);
      if (s.added.length) parts.push(`new: ${s.added.join(", ")}`);
      if (s.removed.length) parts.push(`gone: ${s.removed.join(", ")}`);
      if (s.unhashed.length) parts.push(`never hashed: ${s.unhashed.join(", ")}`);
      return parts.join("; ");
    }
    default:
      return assertNeverStaleness(s);
  }
};

const assertNeverStaleness = (value: never): never => {
  throw new Error(`Unhandled staleness: ${JSON.stringify(value)}`);
};
