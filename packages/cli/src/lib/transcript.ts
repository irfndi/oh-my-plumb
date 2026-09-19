import { closeSync, readSync } from "node:fs";
import { MAX_TASK_CHARS } from "./constants.js";
import { openRegular } from "./regularFile.js";

const TAIL_BYTES = 512 * 1024;

const readTail = (file: string): string | undefined => {
  const opened = openRegular(file);
  if (opened === undefined) return undefined;
  const { fd, size } = opened;
  try {
    const start = Math.max(0, size - TAIL_BYTES);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString("utf8");
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
};

/** The user's most recent typed prompt, so the check knows what the change was for. */
export const lastUserPrompt = (transcriptPath: string | undefined): string | undefined => {
  if (transcriptPath === undefined) return undefined;
  const tail = readTail(transcriptPath);
  if (tail === undefined) return undefined;
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (line === undefined || !line.includes('"type":"user"')) continue;
    try {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== "object" || entry === null) continue;
      const record: Record<string, unknown> = { ...entry };
      if (record.type !== "user" || record.isMeta === true) continue;
      const message = record.message;
      if (typeof message !== "object" || message === null) continue;
      const body: Record<string, unknown> = { ...message };
      const content = body.content;
      if (typeof content === "string" && content.trim() !== "") {
        return content.trim().slice(0, MAX_TASK_CHARS);
      }
    } catch {
      // torn line while the transcript is being written
    }
  }
  return undefined;
};
