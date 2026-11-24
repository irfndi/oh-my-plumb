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

/** Drops oh-my-plumb from a host-owned JSON file's list, leaving every other key alone. */
const removeFromList = (
  file: string,
  pick: (raw: Record<string, unknown>) => unknown[],
  keep: (entry: unknown) => boolean,
): boolean => {
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    raw = { ...parsed };
  } catch {
    return false;
  }
  const list = pick(raw);
  const kept = list.filter(keep);
  if (kept.length === list.length) return false;
  try {
    writeFileSync(file, `${JSON.stringify({ ...raw, [listKey(raw, list)]: kept }, null, 2)}\n`);
  } catch {
    return false;
  }
  return true;
};

/** The key `removeFromList` writes back: the one whose value is the list it was given. */
const listKey = (raw: Record<string, unknown>, list: unknown[]): string =>
  Object.keys(raw).find((key) => raw[key] === list) ?? "packages";

const notOurs = (entry: unknown): boolean => {
  const spec = typeof entry === "string" ? entry : (entry as { source?: unknown }).source;
  return typeof spec !== "string" || !spec.startsWith("npm:oh-my-plumb");
};

/**
 * The pi `packages` entry, or the omp plugin dependency, that is actually loading
 * the extension: a package install writes no shim file, so leaving it is leaving
 * the extension loaded. Mirrors `packageInstall`.
 */
export const uninstallPackageInstall = (host: "pi" | "omp", root: string): boolean => {
  const found = packageInstall(host, root);
  if (found === undefined) return false;
  switch (host) {
    case "pi":
      return removeFromList(
        found.from,
        (raw) => (piSettingsSchema.parse(raw).packages ?? []) as unknown[],
        notOurs,
      );
    case "omp":
      return removeFromList(
        found.from,
        (raw) =>
          Object.entries(ompManifestSchema.parse(raw)).flatMap(([key, value]) =>
            key.endsWith("ependencies") && typeof value === "object" && value !== null
              ? [value as Record<string, unknown>]
              : [],
          ),
        (entry) =>
          typeof entry !== "object" || entry === null || !("oh-my-plumb" in (entry as object)),
      );
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

/** Keep the file pairs in step with `packageInstalled` in pi/oh-my-plumb.ts; the matcher itself is shared. */
export const packageInstall = (host: "pi" | "omp", root: string): PackageInstall | undefined => {
  switch (host) {
    case "pi": {
      const agent = path.join(homeDir(), ".pi", "agent");
      return (
        piPackage(path.join(agent, "settings.json"), path.join(agent, "npm", "node_modules")) ??
        piPackage(
          path.join(root, ".pi", "settings.json"),
          path.join(root, ".pi", "npm", "node_modules"),
        )
      );
    }
    case "omp":
      return (
        ompPlugin(path.join(homeDir(), ".omp", "plugins")) ??
        ompPlugin(path.join(root, ".omp", "plugins"))
      );
    default:
      return assertNever(host);
  }
};
