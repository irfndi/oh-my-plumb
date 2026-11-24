import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  assertNever,
  ompListsPlugin,
  ompManifestSchema,
  packageVersionSchema,
  piListsPackage,
  piSettingsSchema,
} from "oh-my-plumb-schema";
import { installRoot } from "./packageRoot.js";
import { homeDir } from "./paths.js";

export const PI_PLUGIN_MARKER = "oh-my-plumb-pi-extension";

/** The manifest sections an omp plugin entry can live in. */
const DEPENDENCY_KEYS = ["dependencies", "devDependencies", "optionalDependencies"] as const;

/**
 * The extension as shipped in the package. The installed file only points at
 * it, so an upgrade needs no reinstall. Mirrors opencodePlugin.ts.
 *
 * The extension imports no bare specifier but `zod`, because a host loads it
 * into a module graph of its own: the same file resolves `oh-my-plumb-schema`
 * from the host's plugin tree and not from a global install (issue #78).
 */
export const piExtensionSourcePath = (): string => path.join(installRoot(), "pi", "oh-my-plumb.ts");

const readJson = <T>(file: string, schema: z.ZodType<T>): T | undefined => {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
};

/** The file as a JSON object, or nothing: a host file that is not an object is left alone. */
const readObject = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? { ...parsed }
      : undefined;
  } catch {
    return undefined;
  }
};

const writeObject = (file: string, raw: Record<string, unknown>): boolean => {
  try {
    writeFileSync(file, `${JSON.stringify(raw, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
};

/**
 * The pi `packages` entry, or the omp plugin dependency, that is actually loading
 * the extension: a package install writes no shim file, so leaving it is leaving
 * the extension loaded. Only the requested scope is read, so `--project` cannot
 * uninstall the machine-wide install.
 */
export const uninstallPackageInstall = (
  host: "pi" | "omp",
  root: string,
  project: boolean,
): boolean => {
  const found = packageInstall(host, root, project ? "project" : "global");
  if (found === undefined) return false;
  switch (host) {
    case "pi": {
      const raw = readObject(found.from);
      if (raw === undefined) return false;
      const packages = piSettingsSchema.parse(raw).packages ?? [];
      // Every entry that is oh-my-plumb, and nothing that merely starts like it.
      const kept = packages.filter((entry) => piListsPackage({ packages: [entry] }) === undefined);
      if (kept.length === packages.length) return false;
      return writeObject(found.from, { ...raw, packages: kept });
    }
    case "omp": {
      const raw = readObject(found.from);
      if (raw === undefined) return false;
      let removed = false;
      for (const key of DEPENDENCY_KEYS) {
        const section = raw[key];
        if (typeof section !== "object" || section === null) continue;
        const entries = { ...(section as Record<string, unknown>) };
        if (!("oh-my-plumb" in entries)) continue;
        delete entries["oh-my-plumb"];
        removed = true;
        // An emptied section goes with its last entry; the rest of the manifest is untouched.
        if (Object.keys(entries).length === 0) delete raw[key];
        else raw[key] = entries;
      }
      return removed && writeObject(found.from, raw);
    }
    default:
      return assertNever(host);
  }
};

export const installPiExtension = (target: string, host: "pi" | "omp"): void => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    [
      `// ${PI_PLUGIN_MARKER}: written by \`oh-my-plumb init ${host}\`; remove with \`oh-my-plumb uninstall ${host}\`.`,
      `import ohMyPlumb from ${JSON.stringify(pathToFileURL(piExtensionSourcePath()).href)};`,
      `export default (pi) => ohMyPlumb(pi, { shimFor: ${JSON.stringify(host)} });`,
      "",
    ].join("\n"),
  );
};

export const uninstallPiExtension = (target: string): boolean => {
  if (!existsSync(target)) return false;
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(PI_PLUGIN_MARKER)) return false;
  rmSync(target);
  return true;
};

export type PackageInstall = {
  spec: string;
  from: string;
  version: string;
  pinned: boolean;
};

const piPackage = (settings: string, nodeModules: string): PackageInstall | undefined => {
  const listed = piListsPackage(readJson(settings, piSettingsSchema));
  const version = readJson(
    path.join(nodeModules, "oh-my-plumb", "package.json"),
    packageVersionSchema,
  )?.version;
  if (listed === undefined || version === undefined) return undefined;
  return { spec: listed.spec, from: settings, version, pinned: listed.pinned };
};

const ompPlugin = (pluginsDir: string): PackageInstall | undefined => {
  const range = ompListsPlugin(readJson(path.join(pluginsDir, "package.json"), ompManifestSchema));
  const version = readJson(
    path.join(pluginsDir, "node_modules", "oh-my-plumb", "package.json"),
    packageVersionSchema,
  )?.version;
  if (range === undefined || version === undefined) return undefined;
  return {
    spec: `oh-my-plumb@${range}`,
    from: path.join(pluginsDir, "package.json"),
    version,
    pinned: false,
  };
};

/** Which install a lookup may see: the machine-wide one, this project's, or whichever is there. */
export type InstallScope = "global" | "project" | "any";

/** Keep the file pairs in step with `packageInstalled` in pi/oh-my-plumb.ts; the matcher itself is shared. */
export const packageInstall = (
  host: "pi" | "omp",
  root: string,
  scope: InstallScope = "any",
): PackageInstall | undefined => {
  const pi = (dir: string): PackageInstall | undefined =>
    piPackage(path.join(dir, "settings.json"), path.join(dir, "npm", "node_modules"));
  const omp = (dir: string): PackageInstall | undefined => ompPlugin(dir);
  switch (host) {
    case "pi":
      return scope === "project"
        ? pi(path.join(root, ".pi"))
        : scope === "global"
          ? pi(path.join(homeDir(), ".pi", "agent"))
          : (pi(path.join(homeDir(), ".pi", "agent")) ?? pi(path.join(root, ".pi")));
    case "omp": {
      const plugins = (dir: string) => path.join(dir, ".omp", "plugins");
      return scope === "project"
        ? omp(plugins(root))
        : scope === "global"
          ? omp(plugins(homeDir()))
          : (omp(plugins(homeDir())) ?? omp(plugins(root)));
    }
    default:
      return assertNever(host);
  }
};
