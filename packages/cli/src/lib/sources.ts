import { readFileSync, readdirSync, existsSync, realpathSync, type Dirent } from "node:fs";
import path from "node:path";
import { createSourceSha, type Rubric } from "oh-my-plumb-schema";
import {
  canonicalSourcePath,
  expandHome,
  homeDir,
  isExcludedPath,
  resolveSourcePath,
  toSourcePath,
} from "./paths.js";
import { readRegularFile, readRegularText } from "./regularFile.js";
import { SKILL_DIRS } from "./guards.js";

export type SourceCandidate = {
  /** Rubric spelling: repo-relative or "~/...". */
  path: string;
  absolute: string;
  /** Glob the file's rules apply to. */
  scope: string;
  /** Required candidates must appear in the rubric for it to be fresh. */
  required: boolean;
  origin: "root" | "nested" | "global" | "contributing" | "mcp" | "skill";
  /** The server's `initialize` instructions, captured at compile time (origin "mcp"). */
  text?: string;
};

/** An MCP source always carries the instructions it was captured from. */
export type McpSourceCandidate = SourceCandidate & { origin: "mcp"; text: string };

/** The scope glob tying a rule source to one MCP server's tool calls. */
export const mcpSourceScope = (server: string): string => `mcp__${server}__*`;

/** A rubric source backed by MCP server instructions instead of a file. */
export const isMcpSource = (source: { kind?: "mcp" | undefined }): boolean => source.kind === "mcp";

/** The rubric's opted-in MCP servers, spelled the way source paths are compared, so one owner decides a match. */
export const optedInServers = (rubric: Rubric | undefined, root: string): Set<string> =>
  new Set((rubric?.mcpInstructions ?? []).map((server) => canonicalSourcePath(root, server)));

/** sha256 of each captured MCP source's instructions, keyed by canonical source path. */
export const capturedMcpShas = (
  root: string,
  candidates: readonly SourceCandidate[],
): Map<string, string> => {
  const captured = new Map<string, string>();
  for (const c of candidates) {
    if (c.origin === "mcp" && c.text !== undefined)
      captured.set(canonicalSourcePath(root, c.path), createSourceSha(c.text));
  }
  return captured;
};

const ROOT_NAMES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
  ".github/copilot-instructions.md",
  ".windsurfrules",
];
/** Per-developer overrides, usually gitignored: listed, but a teammate without one is not stale. */
const PERSONAL_NAMES = ["CLAUDE.local.md", "AGENTS.override.md"];
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

const unquote = (value: string): string | undefined => {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return value;
  return value.length >= 2 && value.endsWith(quote) ? value.slice(1, -1).trim() : undefined;
};

/**
 * Cursor's `globs:` front matter as one scope glob: a comma list, a `[...]` list
 * or a YAML block list becomes a brace list. Absent, unterminated or malformed
 * front matter falls back to the file's default scope.
 */
const cursorScope = (text: string | undefined): string | undefined => {
  if (text === undefined) return undefined;
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return undefined;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (end === -1) return undefined;
  const front = lines.slice(1, end);
  const at = front.findIndex((line) => /^\s*globs:/.test(line));
  if (at === -1) return undefined;
  const inline = (/^\s*globs:\s*(.*)$/.exec(front[at] ?? "")?.[1] ?? "")
    .replace(/\s+#.*$/, "")
    .trim();
  const raw: string[] = [];
  if (inline !== "") raw.push(...inline.replace(/^\[(.*)\]$/, "$1").split(","));
  else {
    for (const line of front.slice(at + 1)) {
      const item = /^\s*-\s+(.*)$/.exec(line)?.[1];
      if (item === undefined) break;
      raw.push(item.replace(/\s+#.*$/, ""));
    }
  }
  const globs = raw.map((g) => unquote(g.trim()));
  if (globs.some((g) => g === undefined)) return undefined;
  const kept = globs.filter((g): g is string => g !== undefined && g !== "");
  if (kept.length === 0) return undefined;
  return kept.length === 1 ? kept[0] : `{${kept.join(",")}}`;
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

/**
 * Follow `@path` imports in CLAUDE.md files the way Claude Code does: the
 * target is inlined into the importing file, so it is a source with the
 * importer's scope. Only files inside `root` are adopted, so a committed
 * project rubric never names a file another machine lacks, and the paths no
 * check may see (secrets, oh-my-plumb's own files) are never sources.
 */
const followImports = (root: string, found: SourceCandidate[]): void => {
  const seen = new Set(found.map((c) => path.resolve(c.absolute)));
  const queue = found
    .filter((c) => path.basename(c.path) === "CLAUDE.md")
    .map((c) => ({ file: c.absolute, scope: c.scope, origin: c.origin, depth: 0 }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (next === undefined) break;
    if (next.depth >= MAX_DEPTH) continue;
    const text = readRegularText(next.file);
    if (text === undefined) continue;
    for (const token of importTokens(text)) {
      // A sentence can end right after the path: "See @docs/rules.md."
      const target = [token, token.replace(/\.+$/, "")]
        .map((spec) => path.resolve(resolveImport(next.file, spec)))
        .find((candidate) => readRegularFile(candidate) !== undefined);
      if (target === undefined || seen.has(target)) continue;
      const rel = path.relative(root, target);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
      if (isExcludedPath(rel.split(path.sep).join("/"))) continue;
      seen.add(target);
      found.push({
        path: toSourcePath(root, target),
        absolute: target,
        scope: next.scope,
        required: true,
        origin: next.origin,
      });
      queue.push({ file: target, scope: next.scope, origin: next.origin, depth: next.depth + 1 });
    }
  }
};

// CLAUDE.md is often a symlink to AGENTS.md; listing both compiles and bills every rule twice.
const onePerFile = (candidates: SourceCandidate[]): SourceCandidate[] => {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    let real: string;
    try {
      real = realpathSync(c.absolute);
    } catch {
      real = path.resolve(c.absolute);
    }
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
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

/** Every `<dir>/<skill>/SKILL.md` below dir, bounded by the same skip list and depth as file discovery. */
const walkSkills = (
  dir: string,
  depth: number,
  spell: (absolute: string) => string,
  out: SourceCandidate[],
): void => {
  if (depth > MAX_DEPTH) return;
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Installed skills are often symlinked folders, which a Dirent does not call directories.
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
    if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
    const sub = path.join(dir, entry.name);
    const file = path.join(sub, "SKILL.md");
    if (existsSync(file)) {
      out.push({
        path: spell(file),
        absolute: file,
        scope: "**/*",
        required: false,
        origin: "skill",
      });
      // Everything under a skill's folder belongs to that skill, not to a skill of its own.
      continue;
    }
    walkSkills(sub, depth + 1, spell, out);
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
  for (const name of PERSONAL_NAMES) {
    const file = path.join(root, name);
    if (existsSync(file)) {
      found.push({ path: name, absolute: file, scope: "**/*", required: false, origin: "root" });
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
  for (const dir of SKILL_DIRS) {
    walkSkills(path.join(root, dir), 1, (f) => toSourcePath(root, f), found);
  }
  followImports(root, found);
  return onePerFile(found);
};

const GLOBAL_SKILL_DIRS = ["~/.claude/skills", "~/.pi/agent/skills"];

/** Installed plugin roots per Claude Code's own record; a missing or reshaped file yields none. */
const pluginSkillRoots = (): string[] => {
  let raw: unknown;
  try {
    raw = JSON.parse(
      readFileSync(path.join(homeDir(), ".claude", "plugins", "installed_plugins.json"), "utf8"),
    );
  } catch {
    return [];
  }
  if (typeof raw !== "object" || raw === null || !("plugins" in raw)) return [];
  const plugins: unknown = raw.plugins;
  if (typeof plugins !== "object" || plugins === null) return [];
  const roots: string[] = [];
  for (const group of Object.values(plugins)) {
    if (!Array.isArray(group)) continue;
    for (const entry of group) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "installPath" in entry &&
        typeof entry.installPath === "string" &&
        path.isAbsolute(entry.installPath)
      ) {
        roots.push(entry.installPath);
      }
    }
  }
  return [...new Set(roots)];
};

export const discoverGlobalSources = (): SourceCandidate[] => {
  const found: SourceCandidate[] = GLOBAL_NAMES.flatMap((p) => {
    const absolute = path.join(homeDir(), p.slice(2));
    return existsSync(absolute)
      ? [{ path: p, absolute, scope: "**/*", required: true, origin: "global" as const }]
      : [];
  });
  for (const dir of GLOBAL_SKILL_DIRS) {
    walkSkills(path.join(homeDir(), dir.slice(2)), 1, (f) => toSourcePath(homeDir(), f), found);
  }
  // An installed plugin is the user's opt-in to its skills, as an installed MCP server is to its instructions.
  for (const rootDir of pluginSkillRoots()) {
    walkSkills(path.join(rootDir, "skills"), 1, (f) => toSourcePath(homeDir(), f), found);
  }
  followImports(homeDir(), found);
  return onePerFile(found);
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
  const captured = capturedMcpShas(root, candidates);
  const optedIn = optedInServers(rubric, root);
  const changed: string[] = [];
  const removed: string[] = [];
  const unhashed: string[] = [];
  for (const source of rubric.sources) {
    if (isMcpSource(source)) {
      // A server taken off the opt-in list leaves a dead source behind.
      if (!optedIn.has(canonicalSourcePath(root, source.path))) {
        removed.push(source.path);
        continue;
      }
      // Instructions are captured only when a compile may be due; with nothing
      // captured there is no hash to compare against, and silence beats a false alarm.
      const now = captured.get(canonicalSourcePath(root, source.path));
      if (now === undefined) continue;
      if (source.sha === undefined) unhashed.push(source.path);
      else if (source.sha !== now) changed.push(source.path);
      continue;
    }
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
