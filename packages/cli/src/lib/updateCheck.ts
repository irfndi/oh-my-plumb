import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Host } from "oh-my-plumb-schema";
import { globalOhMyPlumbDir } from "./paths.js";

/** How often session-start may mention an update; the check itself is one cached registry read. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
/** Registry reads must never be what a host waits on; the notice is informational. */
export const REGISTRY_TIMEOUT_MS = 2_500;
/** Tests pin the registry answer through the environment instead of the network. */
export const UPDATE_CHECK_LATEST_ENV = "OH_MY_PLUMB_UPDATE_CHECK_LATEST";

const stateFile = (): string => path.join(globalOhMyPlumbDir(), "update-check.json");

const stateSchema = z.object({ checkedAt: z.number(), latest: z.string() });

const readState = (): { checkedAt: number; latest: string } | undefined => {
  try {
    const parsed = stateSchema.safeParse(JSON.parse(readFileSync(stateFile(), "utf8")));
    return parsed.success ? parsed.data : undefined;
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

const npmOn = (platform = process.platform): string => (platform === "win32" ? "npm.cmd" : "npm");

const latestFromRegistry = (timeoutMs: number): string | undefined => {
  const pinned = process.env[UPDATE_CHECK_LATEST_ENV];
  if (pinned !== undefined && pinned !== "") return pinned;
  try {
    const out = execFileSync(npmOn(), ["view", "oh-my-plumb", "version"], {
      encoding: "utf8",
      timeout: timeoutMs,
    }).trim();
    return /^[0-9]+\.[0-9]+\.[0-9]+/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
};

const numericPrefix = (segment: string): number => {
  const match = /^[0-9]+/.exec(segment);
  return match === null ? 0 : Number(match[0]);
};

const newerThan = (latest: string, running: string): boolean => {
  const a = latest.split(".").map(numericPrefix);
  const b = running.split(".").map(numericPrefix);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
};

/** One line per host: whatever copy runs, its own updater moves it. */
export const UPDATE_COMMANDS: Record<Host, string> = {
  pi: "pi update --extensions",
  omp: "omp plugin install oh-my-plumb --force",
  opencode: "opencode plugin update",
  claude: "npm i -g oh-my-plumb@latest && oh-my-plumb init",
  codex: "npm i -g oh-my-plumb@latest && oh-my-plumb init",
};

/** A once-a-day nudge naming each host's own update command. Never throws. */
export const updateNotice = (running: string, now = Date.now()): string | undefined => {
  let state = readState();
  if (state === undefined || now - state.checkedAt >= CHECK_INTERVAL_MS) {
    state = { checkedAt: now, latest: running };
    const latest = latestFromRegistry(REGISTRY_TIMEOUT_MS);
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
