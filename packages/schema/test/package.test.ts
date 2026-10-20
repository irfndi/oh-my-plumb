import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";

// omp loads the Pi extension inside a standalone Bun executable, whose loader
// resolves a bare specifier to <pkg>/index.js and never reads "exports". The
// Pi extension imports this package by name, so without a root entry the
// extension fails to load and every rule goes unchecked. Resolve the way that
// runtime does: by root index, not by the exports map.
const packageRoot = path.resolve(import.meta.dirname, "..");
const rootEntry = path.join(packageRoot, "index.js");

describe("package entry points", () => {
  it("resolves by root index.js, which a runtime that ignores exports can find", async () => {
    expect(existsSync(rootEntry)).toBe(true);
    const viaRoot = await import(pathToFileURL(rootEntry).href);
    const viaExports = await import("oh-my-plumb-schema");
    // Both entries must stay the same contract, or hosts disagree about it.
    expect(Object.keys(viaRoot).sort()).toEqual(Object.keys(viaExports).sort());
    expect(viaRoot.rubricSchema).toBeDefined();
  });

  it("ships the root entry, so resolving it survives publish", () => {
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      files: string[];
    };
    expect(manifest.files).toContain("index.js");
  });
});
