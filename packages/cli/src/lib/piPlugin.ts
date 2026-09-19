import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { packageRoot } from "./packageRoot.js";

export const PI_PLUGIN_MARKER = "oh-my-plumb-pi-extension";

/**
 * The extension as shipped in the package. The installed file only points at
 * it, so an upgrade needs no reinstall. Mirrors opencodePlugin.ts.
 */
export const piExtensionSourcePath = (): string => path.join(packageRoot(), "pi", "oh-my-plumb.ts");

export const installPiExtension = (target: string): void => {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(
    target,
    [
      `// ${PI_PLUGIN_MARKER}: written by \`oh-my-plumb init pi\`; remove with \`oh-my-plumb uninstall pi\`.`,
      `export { default } from ${JSON.stringify(pathToFileURL(piExtensionSourcePath()).href)};`,
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
