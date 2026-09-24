import { parseArgs } from "node:util";
import { PlumbError } from "oh-my-plumb-schema";
import {
  canonicalSourcePath,
  findRepoRoot,
  globalRubricPath,
  homeDir,
  rubricPath,
} from "../lib/paths.js";
import { optedInServers } from "../lib/sources.js";
import { fillSourceShas, readRubric, writeRubric } from "../lib/rubricFile.js";
import { syncToolCallMatchers } from "../lib/hosts.js";
import { discoverMcpSources } from "../lib/mcpSources.js";
import { showStatic } from "../ui/render.js";
import { RubricView } from "../ui/views/RubricView.js";

/** Parses the rubric the agent just wrote, fills in real source hashes, writes it back. */
export const runRubric = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { global: { type: "boolean", default: false } },
  });
  const sub = positionals[0] ?? "validate";
  if (sub !== "validate")
    throw new PlumbError(
      "RUBRIC_INVALID",
      `unknown rubric command "${sub}"; try: oh-my-plumb rubric validate`,
    );
  const root = values.global ? homeDir() : findRepoRoot(process.cwd());
  const file = values.global ? globalRubricPath() : rubricPath(root);
  const read = readRubric(file);
  switch (read.kind) {
    case "missing":
      throw new PlumbError("RUBRIC_MISSING", `${file} does not exist yet`);
    case "invalid":
      await showStatic(RubricView({ data: { kind: "invalid", root, file, issues: read.issues } }));
      return 1;
    case "ok": {
      const mcp = await discoverMcpSources(root, read.rubric);
      const { rubric, missing } = fillSourceShas(read.rubric, root, mcp);
      const listed = new Set(rubric.sources.map((s) => s.path));
      const heard = new Set(mcp.map((c) => canonicalSourcePath(root, c.path)));
      const quiet = [...optedInServers(read.rubric, root)].filter((server) => !heard.has(server));
      const orphaned = rubric.rules
        .filter((r) => !listed.has(r.source.path))
        .map((r) => `${r.id} (${r.source.path})`);
      writeRubric(file, rubric);
      // A rubric that gained or lost its tool-call rules needs the project's hook matchers to follow.
      if (!values.global) syncToolCallMatchers(root);
      await showStatic(
        RubricView({
          data: { kind: "ok", root, file, rules: rubric.rules, missing, orphaned, quiet },
        }),
      );
      return missing.length + orphaned.length > 0 ? 1 : 0;
    }
    default:
      return 1;
  }
};
