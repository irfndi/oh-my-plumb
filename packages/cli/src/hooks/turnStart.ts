import path from "node:path";
import { turnIdOf, turnStartInputSchema, type HookOutput } from "oh-my-plumb-schema";
import { TURN_START_TIMEOUT_MS } from "../lib/constants.js";
import { isGitRepo, snapshotTree } from "../lib/git.js";
import { findRepoRoot } from "../lib/paths.js";
import { clearTurn, markBaseline, turnDir, writeBaseline, writePrompt } from "../lib/session.js";

/**
 * The turn is about to begin: remember what the working tree looks like now,
 * so the Stop check can diff the whole turn, whichever tool made the changes.
 * Prints nothing: on this event plain stdout would become context.
 */
export const handleTurnStart = async (raw: unknown): Promise<HookOutput> => {
  const parsed = turnStartInputSchema.safeParse(raw);
  if (!parsed.success) return { kind: "silent" };
  const input = parsed.data;
  const root = findRepoRoot(input.cwd);
  const turnId = turnIdOf(input);
  const dir = turnDir(input.session_id, turnId);
  // Without a turn id every turn shares one directory, so the last turn's
  // records go before this one's start.
  if (turnId === undefined) clearTurn(dir);
  if (input.prompt !== undefined) writePrompt(dir, input.prompt);
  if (!isGitRepo(root)) return { kind: "silent" };
  // Written before the attempt: a hook that dies mid-snapshot leaves "pending"
  // behind, and the Stop check reads that as a turn it cannot see whole.
  markBaseline(dir, "pending");
  const tree = snapshotTree(root, path.join(dir, "index"), TURN_START_TIMEOUT_MS);
  if (tree === undefined) {
    markBaseline(dir, "failed");
    return { kind: "silent" };
  }
  writeBaseline(dir, tree);
  markBaseline(dir, "ok");
  return { kind: "silent" };
};
