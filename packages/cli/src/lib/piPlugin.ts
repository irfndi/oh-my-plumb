import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { assertNever } from "oh-my-plumb-schema";
import { packageRoot } from "./packageRoot.js";
import { homeDir } from "./paths.js";

export const PI_PLUGIN_MARKER = "oh-my-plumb-pi-extension";

/**
 * The extension as shipped in the package. The installed file only points at
 * it, so an upgrade needs no reinstall. Mirrors opencodePlugin.ts.
 */
export const piExtensionSourcePath = (): string => path.join(packageRoot(), "pi", "oh-my-plumb.ts");

/** The file names its host, so the extension can stand down when that host also has the package. */
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

const piSettingsSchema = z.object({
  packages: z
    .array(z.union([z.string(), z.object({ source: z.string() }).passthrough()]))
    .optional(),
});
const pluginsManifestSchema = z.object({
  dependencies: z.record(z.string(), z.string()).optional(),
});
const versionSchema = z.object({ version: z.string() });

const readJson = <T>(file: string, schema: z.ZodType<T>): T | undefined => {
  try {
    return schema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return undefined;
  }
};

/** oh-my-plumb installed through a host's own package system, which loads it without our file. */
export type PackageInstall = {
  spec: string;
  from: string;
  version: string | undefined;
  pinned: boolean;
};

const PI_SPEC = /^npm:oh-my-plumb(@.+)?$/;

const piPackage = (settings: string, nodeModules: string): PackageInstall | undefined => {
  const spec = (readJson(settings, piSettingsSchema)?.packages ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.source))
    .find((source) => PI_SPEC.test(source));
  if (spec === undefined) return undefined;
  return {
    spec,
    from: settings,
    version: readJson(path.join(nodeModules, "oh-my-plumb", "package.json"), versionSchema)
      ?.version,
    pinned: PI_SPEC.exec(spec)?.[1] !== undefined,
  };
};

const ompPlugin = (pluginsDir: string): PackageInstall | undefined => {
  const range = readJson(path.join(pluginsDir, "package.json"), pluginsManifestSchema)
    ?.dependencies?.["oh-my-plumb"];
  if (range === undefined) return undefined;
  return {
    spec: `oh-my-plumb@${range}`,
    from: path.join(pluginsDir, "package.json"),
    version: readJson(
      path.join(pluginsDir, "node_modules", "oh-my-plumb", "package.json"),
      versionSchema,
    )?.version,
    pinned: false,
  };
};

/** Keep in step with `packageInstalled` in pi/oh-my-plumb.ts. */
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
