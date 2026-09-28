import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { installRoot } from "./packageRoot.js";
import { homeDir } from "./paths.js";

export const OPENCODE_PLUGIN_MARKER = "oh-my-plumb-opencode-plugin";

/**
 * Whether the OpenCode on this machine is v2. Both versions install a binary
 * named `opencode`, so the version is what tells them apart: the v2 installer
 * adds an `opencode2` alias and reports a 2.x `--version`, v1 reports 0.x.
 */
export const opencodeIsV2 = (): boolean => {
  if (spawnSync("which", ["opencode2"], { encoding: "utf8" }).status === 0) return true;
  // v2 unpacks here before a shell has it on PATH; only v2 uses this directory.
  if (existsSync(path.join(homeDir(), ".opencode", "bin", "opencode"))) return true;
  const probe = spawnSync("opencode", ["--version"], { encoding: "utf8", timeout: 5_000 });
  if (probe.status !== 0) return false;
  const match = /(\d+)\.\d+\.\d+/.exec(probe.stdout ?? "");
  return match !== null && Number(match[1]) >= 2;
};

/**
 * The plugin as shipped in the package. The installed file only points at it,
 * so an upgrade needs no reinstall. OpenCode discovers `plugins/*.js` and
 * `*.ts` only, so the installed file is `.js` whatever the package uses, and
 * it points at whichever version's module that version's loader accepts:
 * v1 wants the function in `oh-my-plumb.mjs`, v2 the `{ id, setup }` object in
 * `oh-my-plumb-v2.js`, and neither reads the other's.
 */
export const pluginSourcePath = (): string =>
  path.join(installRoot(), "opencode", opencodeIsV2() ? "oh-my-plumb-v2.js" : "oh-my-plumb.mjs");

const shim = (source: string): string =>
  [
    `// ${OPENCODE_PLUGIN_MARKER}: written by \`oh-my-plumb init opencode\`; remove with \`oh-my-plumb uninstall opencode\`.`,
    `export { default } from ${JSON.stringify(pathToFileURL(source).href)};`,
    "",
  ].join("\n");

/** Config roots OpenCode reads, first hit wins. */
const configFiles = (): string[] => {
  const base = path.join(homeDir(), ".config", "opencode");
  return [path.join(base, "opencode.json"), path.join(base, "opencode.jsonc")];
};

const readConfig = (file: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON5.parse(readFileSync(file, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
};

/** Records `oh-my-plumb` in the npm `plugin` list OpenCode itself installs and updates; true when the list changed. Existing entries are left alone. Returns false on any write failure, so `init` keeps going. */
export const addOpencodePackagePlugin = (): boolean => {
  for (const file of configFiles()) {
    const config = readConfig(file);
    if (config === undefined) continue;
    const plugins = config["plugin"];
    if (!Array.isArray(plugins)) continue;
    if (
      plugins.some(
        (entry) =>
          entry === "oh-my-plumb" ||
          (typeof entry === "string" && entry.startsWith("oh-my-plumb@")),
      )
    )
      return false;
    try {
      writeFileSync(
        file,
        JSON.stringify({ ...config, plugin: [...plugins, "oh-my-plumb"] }, null, 2) + "\n",
      );
    } catch {
      return false;
    }
    return true;
  }
  return false;
};

export const installOpencodePlugin = (target: string): void => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, shim(pluginSourcePath()));
};

export const uninstallOpencodePlugin = (target: string): boolean => {
  if (!existsSync(target)) return false;
  let text: string;
  try {
    text = readFileSync(target, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(OPENCODE_PLUGIN_MARKER)) return false;
  rmSync(target);
  return true;
};
