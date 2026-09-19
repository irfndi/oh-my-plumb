import { STDIN_TIMEOUT_MS } from "./constants.js";

/** Reads all of stdin, giving up after a short wait so a host that sends nothing cannot hang us, and lets go of the handle. */
export const readStdin = (timeoutMs = STDIN_TIMEOUT_MS): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        process.stdin.destroy();
      } catch {
        // nothing to release
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.on("data", (c: Buffer) => chunks.push(c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
