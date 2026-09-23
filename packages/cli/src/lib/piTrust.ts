import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { homeDir } from "./paths.js";

/** Whether pi will load this project's extension: pi walks up from the project looking for a saved trust decision. */
export type PiTrustState = "trusted" | "untrusted" | "unknown";

/** What pi keeps in its store: a yes/no decision, or a cleared entry that inherits from a parent. */
const trustStore = z.record(z.string(), z.union([z.boolean(), z.null()]));

/**
 * Read-only look at pi's saved project-trust decisions, mirroring pi's own walk
 * up from the project directory (pi stores canonical paths, and skips cleared
 * entries in favour of the nearest real decision). A missing or malformed file
 * is "unknown", never a crash: trust.json is pi's file, and an odd one just
 * means pi has given no answer we can read.
 */
export const readPiTrust = (project: string, home: string = homeDir()): PiTrustState => {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path.join(home, ".pi", "agent", "trust.json"), "utf8"));
  } catch {
    return "unknown";
  }
  const store = trustStore.safeParse(raw);
  if (!store.success) return "unknown";
  let dir: string;
  try {
    dir = realpathSync(project);
  } catch {
    dir = path.resolve(project);
  }
  for (;;) {
    const decision = store.data[dir];
    if (typeof decision === "boolean") return decision ? "trusted" : "untrusted";
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // A readable store with no decision anywhere up the chain: pi asks, and in -p mode it skips.
  return "untrusted";
};
