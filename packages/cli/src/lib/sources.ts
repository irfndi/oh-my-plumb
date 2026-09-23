import { readdirSync, existsSync, type Dirent } from "node:fs";
import path from "node:path";
import { createSourceSha, type Rubric } from "oh-my-plumb-schema";
import { expandHome, homeDir, resolveSourcePath, toSourcePath } from "./paths.js";
import { readRegularFile, readRegularText } from "./regularFile.js";

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

const ROOT_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
  "CLAUDE.local.md",
  "AGENTS.override.md",
  ".github/copilot-instructions.md",
  ".windsurfrules",
];
const NESTED_NAMES = ["AGENTS.md", "CLAUDE.md"];
const GLOBAL_NAMES = [
  "~/.claude/CLAUDE.md",
  "~/.codex/AGENTS.md",
  "~/.config/opencode/AGENTS.md",
  "~/.pi/agent/AGENTS.md",
];
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

/** Cursor's `globs:` front matter. Absent or malformed falls back to the file's default scope. */
const cursorScope = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const lines = text.split("\n");
  if (lines[0]?.trim() !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") return undefined;
    const match = /^\s*globs:\s*(.*)$/.exec(line);
    if (match === null) continue;
    let value = (match[1] ?? "").trim();
    const quote = value[0];
    if (quote === '"' || quote === "'") {
      if (value.length < 2 || !value.endsWith(quote)) return undefined;
      value = value.slice(1, -1).trim();
    }
    return value.length > 0 ? value : undefined;
  }
  return undefined;
};

/** Every `.cursor/rules/*.mdc` directly under `dir`, inside the walk's depth and skip limits. */
const scanCursorRules = (root: string, dir: string, out: SourceCandidate[]): void => {
  const rulesDir = path.join(dir, ".cursor", "rules");
  let entries: Dirent[];
  try {
    entries = readdirSync(rulesDir, { withFileTypes: true });
  } catch {
    return;
  }
  const atRoot = dir === root;
  const rel = toSourcePath(root, dir);
  const origin: SourceCandidate["origin"] = atRoot ? "root" : "nested";
  const fallback = atRoot ? "**/*" : `${rel}/**/*`;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".mdc")) continue;
    const file = path.join(rulesDir, entry.name);
    out.push({
      path: toSourcePath(root, file),
      absolute: file,
      scope: cursorScope(readRegularText(file)) ?? fallback,
      required: true,
      origin,
    });
  }
};

const AT_IMPORT = /(?:^|[\s`(])@([^\s`)\]}"',;:!?]+)/gm;

/** `@path` import tokens, the spelling Claude Code follows inside CLAUDE.md. */
const importTokens = (text: string): string[] => {
  const tokens: string[] = [];
  for (const match of text.matchAll(AT_IMPORT)) {
    if (match[1] !== undefined) tokens.push(match[1]);
  }
  return tokens;
};

/** An import resolves against the file carrying it; `~` and absolute paths resolve as spelled. */
const resolveImport = (fromFile: string, spec: string): string =>
  spec === "~" || spec.startsWith("~/")
    ? expandHome(spec)
    : path.isAbsolute(spec)
      ? spec
      : path.resolve(path.dirname(fromFile), spec);

const scopeOf = (spelling: string): string => {
  const dir = spelling.split("/").slice(0, -1).join("/");
  return dir === "" || dir.startsWith("~") ? "**/*" : `${dir}/**/*`;
};

const originOf = (spelling: string): SourceCandidate["origin"] =>
  spelling.startsWith("~") ? "global" : spelling.includes("/") ? "nested" : "root";

/**
 * Follow `@path` imports in CLAUDE.md files the way the compile skill follows
 * pointers: the target is a source in its own right, with the scope of where it lives.
 */
const followImports = (root: string, found: SourceCandidate[]): void => {
  const seen = new Set(found.map((c) => path.resolve(c.absolute)));
  const queue = found
    .filter((c) => path.basename(c.path) === "CLAUDE.md")
    .map((c) => ({ file: c.absolute, depth: 0 }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (next.depth >= MAX_DEPTH) continue;
    const text = readRegularText(next.file);
    if (text === undefined) continue;
    for (const spec of importTokens(text)) {
      const target = path.resolve(resolveImport(next.file, spec));
      if (seen.has(target)) continue;
      const spelling = toSourcePath(root, target);
      if (path.isAbsolute(spelling) || readRegularFile(target) === undefined) continue;
      seen.add(target);
      found.push({
        path: spelling,
        absolute: target,
        scope: scopeOf(spelling),
        required: true,
        origin: originOf(spelling),
      });
      queue.push({ file: target, depth: next.depth + 1 });
    }
  }
};

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
    scanCursorRules(root, sub, out);
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
  scanCursorRules(root, root, found);
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
  followImports(root, found);
  return found;
};

export const discoverGlobalSources = (): SourceCandidate[] => {
  const found: SourceCandidate[] = GLOBAL_NAMES.flatMap((p) => {
    const absolute = path.join(homeDir(), p.slice(2));
    return existsSync(absolute)
      ? [{ path: p, absolute, scope: "**/*", required: true, origin: "global" as const }]
      : [];
  });
  followImports(homeDir(), found);
  return found;
};

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
