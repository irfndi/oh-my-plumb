/**
 * Codex edits files through `apply_patch`, whose input is its own patch
 * dialect: one `*** Begin Patch` block holding `*** Add File:`,
 * `*** Update File:` (optionally followed by `*** Move to:`) and
 * `*** Delete File:` sections. Update sections carry hunks that are already
 * diff-shaped, so the text the judge sees is the section itself.
 */
export type PatchedFile =
  | { kind: "add"; path: string; text: string }
  | { kind: "update"; path: string; text: string; movedTo?: string }
  | { kind: "delete"; path: string };

const ADD = "*** Add File: ";
const UPDATE = "*** Update File: ";
const DELETE = "*** Delete File: ";
const MOVE = "*** Move to: ";

const hunkHeader = (line: string): string => {
  const context = line.slice(2).trim();
  return context === "" ? "@@" : `@@ ${context}`;
};

export const parseApplyPatch = (command: string): PatchedFile[] => {
  const files: PatchedFile[] = [];
  let open: { kind: "add" | "update"; path: string; lines: string[]; movedTo?: string } | undefined;
  const close = (): void => {
    if (open === undefined) return;
    const text = open.lines.join("\n");
    files.push(
      open.kind === "add"
        ? { kind: "add", path: open.path, text }
        : {
            kind: "update",
            path: open.path,
            text,
            ...(open.movedTo === undefined ? {} : { movedTo: open.movedTo }),
          },
    );
    open = undefined;
  };
  for (const line of command.split("\n")) {
    if (line === "*** Begin Patch" || line === "*** End Patch") {
      close();
      continue;
    }
    if (line.startsWith(ADD)) {
      close();
      open = { kind: "add", path: line.slice(ADD.length).trim(), lines: [] };
      continue;
    }
    if (line.startsWith(UPDATE)) {
      close();
      open = { kind: "update", path: line.slice(UPDATE.length).trim(), lines: [] };
      continue;
    }
    if (line.startsWith(DELETE)) {
      close();
      files.push({ kind: "delete", path: line.slice(DELETE.length).trim() });
      continue;
    }
    if (open === undefined) continue;
    if (line.startsWith(MOVE)) {
      open.movedTo = line.slice(MOVE.length).trim();
      continue;
    }
    if (line.startsWith("@@")) {
      open.lines.push(hunkHeader(line));
      continue;
    }
    if (line === "*** End of File") continue;
    open.lines.push(open.kind === "add" && !line.startsWith("+") ? `+${line}` : line);
  }
  close();
  return files;
};
