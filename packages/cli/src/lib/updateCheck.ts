import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { globalOhMyPlumbDir } from "./paths.js";

/** How often session-start may mention an update; the check itself is one cached registry read. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const stateFile = (): string => path.join(globalOhMyPlumbDir(), "update-check.json");

const readState = (): { checkedAt: number; latest: string } | undefined => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(stateFile(), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { checkedAt, latest } = parsed as { checkedAt: unknown; latest: unknown };
    if (typeof checkedAt !== "number" || typeof latest !== "string") return undefined;
    return { checkedAt, latest };
  } catch {
    return undefined;
  }
};

const writeState = (checkedAt: number, latest: string): void => {
  try {
    mkdirSync(globalOhMyPlumbDir(), { recursive: true });
    writeFileSync(stateFile(), JSON.stringify({ checkedAt, latest }));
  } catch {
    // A read-only home must not break session start.
  }
};

const latestFromRegistry = (timeoutMs: number): string | undefined => {
  try {
    const out = execFileSync("npm", ["view", "oh-my-plumb", "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
    }).trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
};

const newerThan = (latest: string, running: string): boolean => {
  const parts = (v: string): number[] => v.split(".").map((n) => Number(n));
  const a = parts(latest);
  const b = parts(running);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

import type { Host } from "oh-my-plumb-schema";

/** One line per host: whatever copy runs, its own updater moves it. */
export const UPDATE_COMMANDS: Record<Host, string> = {
  pi: "pi update --extensions",
  omp: "omp update --plugins",
  opencode: "opencode plugin update",
  claude: "npm i -g oh-my-plumb@latest",
  codex: "npm i -g oh-my-plumb@latest",
};

/** A once-a-day nudge naming each host's own update command. Never throws. */
export const updateNotice = (running: string, now = Date.now()): string | undefined => {
  let state = readState();
  if (state === undefined || now - state.checkedAt >= CHECK_INTERVAL_MS) {
    state = { checkedAt: now, latest: running };
    const latest = latestFromRegistry(8_000);
    if (latest !== undefined) state = { checkedAt: now, latest };
    writeState(state.checkedAt, state.latest);
  }
  if (running === "unknown" || !newerThan(state.latest, running)) return undefined;
  return `oh-my-plumb ${state.latest} is available (running ${running}). Update with your host's own command: ${Object.entries(
    UPDATE_COMMANDS,
  )
    .map(([host, command]) => `${host}: ${command}`)
    .join("; ")}.`;
};
