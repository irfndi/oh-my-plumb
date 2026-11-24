import { parseArgs } from "node:util";
import { HOSTS } from "oh-my-plumb-schema";
import { parseHost, uninstallHost } from "../lib/hosts.js";
import { resolveRepoRoot } from "../lib/paths.js";
import { showStatic } from "../ui/render.js";
import { UninstallView } from "../ui/views/UninstallView.js";

export const runUninstall = async (argv: string[]): Promise<number> => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { project: { type: "boolean", default: false } },
  });
  const root = resolveRepoRoot(process.cwd()).root;
  const hosts = positionals.length > 0 ? [...new Set(positionals.map(parseHost))] : [...HOSTS];
  const rows = hosts.map((host) => ({ host, ...uninstallHost(host, root, values.project) }));
  await showStatic(UninstallView({ rows }));
  return 0;
};
