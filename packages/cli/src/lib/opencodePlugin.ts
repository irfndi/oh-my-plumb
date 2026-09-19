import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./packageRoot.js";

export const OPENCODE_PLUGIN_MARKER = "oh-my-plumb-opencode-plugin";

/**
 * The plugin as shipped in the package. The installed file only points at it,
 * so an upgrade needs no reinstall. OpenCode discovers `plugins/*.js` and
 * `*.ts` only, so the installed file is `.js` whatever the package uses.
 */
export const pluginSourcePath = (): string =>
  path.join(packageRoot(), "opencode", "oh-my-plumb.mjs");

const shim = (source: string): string =>
  [
    `// ${OPENCODE_PLUGIN_MARKER}: written by \`oh-my-plumb init opencode\`; remove with \`oh-my-plumb uninstall opencode\`.`,
    `export { default } from ${JSON.stringify(pathToFileURL(source).href)};`,
    "",
  ].join("\n");

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
