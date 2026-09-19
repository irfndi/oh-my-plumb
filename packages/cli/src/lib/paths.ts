import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import picomatch from "picomatch";

export const homeDir = (): string => process.env.OH_MY_PLUMB_HOME_DIR ?? homedir();

export const globalOhMyPlumbDir = (): string => path.join(homeDir(), ".oh-my-plumb");
export const globalRubricPath = (): string => path.join(globalOhMyPlumbDir(), "global.json");
export const sessionsDir = (): string => path.join(globalOhMyPlumbDir(), "sessions");

export const ohMyPlumbDir = (root: string): string => path.join(root, ".oh-my-plumb");
export const rubricPath = (root: string): string => path.join(ohMyPlumbDir(root), "rubric.json");
export const eventsPath = (root: string): string => path.join(ohMyPlumbDir(root), "events.jsonl");

const isDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

const ROOT_MARKERS = [".git", ".oh-my-plumb", "AGENTS.md", "CLAUDE.md"];

/** The nearest ancestor that looks like a repository root, else the start directory. */
export const findRepoRoot = (start: string): string => {
  let dir = path.resolve(start);
  if (!isDir(dir)) dir = path.dirname(dir);
  let fallback: string | undefined;
  for (;;) {
    if (existsSync(path.join(dir, ".git"))) return dir;
    if (fallback === undefined && ROOT_MARKERS.some((m) => existsSync(path.join(dir, m)))) {
      fallback = dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return fallback ?? path.resolve(start);
};

export const expandHome = (p: string): string =>
  p === "~" ? homeDir() : p.startsWith("~/") ? path.join(homeDir(), p.slice(2)) : p;

/** Absolute location of a rubric source path ("~/x" or repo-relative). */
export const resolveSourcePath = (root: string, sourcePath: string): string =>
  sourcePath.startsWith("~") ? expandHome(sourcePath) : path.resolve(root, sourcePath);

const toPosix = (p: string): string => p.split(path.sep).join("/");

/** The rubric's spelling of an absolute path: repo-relative, "~/..." inside home, else absolute. */
export const toSourcePath = (root: string, absolute: string): string => {
  const rel = path.relative(root, absolute);
  if (
    path.resolve(root) !== homeDir() &&
    rel !== "" &&
    !rel.startsWith("..") &&
    !path.isAbsolute(rel)
  ) {
    return toPosix(rel);
  }
  const fromHome = path.relative(homeDir(), absolute);
  if (fromHome !== "" && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
    return `~/${toPosix(fromHome)}`;
  }
  return toPosix(absolute);
};

/** One spelling for a source path however the agent wrote it. */
export const canonicalSourcePath = (root: string, sourcePath: string): string =>
  toSourcePath(root, resolveSourcePath(root, sourcePath));

export const relativeToRoot = (root: string, absolute: string): string =>
  toPosix(path.relative(root, absolute));

/** Files oh-my-plumb owns are never checked; the agent writes the rubric under supervision of the compile skill. */
export const isPlumbOwned = (relativePath: string): boolean =>
  relativePath === ".oh-my-plumb" || relativePath.startsWith(".oh-my-plumb/");

/** Basename globs; also fed to git as pathspecs. */
export const SECRET_FILE_PATTERNS: readonly string[] = [
  ".env",
  ".env.*",
  ".envrc",
  "*.pem",
  "*.key",
];

const isSecretName = picomatch([...SECRET_FILE_PATTERNS], { dot: true });

export const isSecretFile = (relativePath: string): boolean =>
  isSecretName(path.posix.basename(relativePath));

export const isExcludedPath = (relativePath: string): boolean =>
  isPlumbOwned(relativePath) || isSecretFile(relativePath);
