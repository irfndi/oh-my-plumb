import type { CheckedEdit } from "./session.js";

/**
 * Judged edits must chain from the turn's start content to the disk now.
 * A change made by a shell, or while a judge was looking, breaks the chain.
 */
export const editsCoverFile = (
  start: string | null,
  edits: readonly CheckedEdit[],
  now: string,
): boolean => {
  const unused = [...edits];
  let at = start;
  while (at !== now) {
    const index = unused.findIndex((e) => e.before === at);
    const next = index === -1 ? undefined : unused.splice(index, 1)[0];
    if (next === undefined) return false;
    at = next.after;
  }
  return true;
};
