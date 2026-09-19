import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { GATEWAY_KEY_ENV, TYPESAFE_KEY_ENV } from "./constants.js";
import { globalOhMyPlumbDir } from "./paths.js";
import { readRegularText } from "./regularFile.js";

/**
 * Which key oh-my-plumb has, and where it goes. A TypeSafe key talks to Jev
 * directly; a gateway key goes through the user's Vercel AI Gateway.
 */
export type Credentials =
  | { kind: "typesafe"; key: string; from: string }
  | { kind: "gateway"; key: string; from: string }
  | { kind: "none" };

export const KEY_NAMES: readonly string[] = [TYPESAFE_KEY_ENV, GATEWAY_KEY_ENV];

export const userEnvPath = (): string => path.join(globalOhMyPlumbDir(), ".env");

/** Only the two oh-my-plumb keys are read from a file; nothing else in it is touched or loaded. */
export const parseEnvFile = (text: string): Map<string, string> => {
  const found = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m === null) continue;
    const name = m[1];
    let value = (m[2] ?? "").trim();
    if (name === undefined || !KEY_NAMES.includes(name)) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value !== "") found.set(name, value);
  }
  return found;
};

const readEnvFile = (file: string): Map<string, string> => {
  const text = readRegularText(file);
  return text === undefined ? new Map() : parseEnvFile(text);
};

const pick = (vars: Map<string, string>, from: string): Credentials => {
  const typesafe = vars.get(TYPESAFE_KEY_ENV);
  if (typesafe !== undefined) return { kind: "typesafe", key: typesafe, from };
  const gateway = vars.get(GATEWAY_KEY_ENV);
  if (gateway !== undefined) return { kind: "gateway", key: gateway, from };
  return { kind: "none" };
};

const fromProcessEnv = (): Map<string, string> => {
  const vars = new Map<string, string>();
  for (const name of KEY_NAMES) {
    const value = (process.env[name] ?? "").trim();
    if (value !== "") vars.set(name, value);
  }
  return vars;
};

export const findCredentials = (root: string): Credentials => {
  const places: [string, () => Map<string, string>][] = [
    ["the environment", fromProcessEnv],
    [".env.local", () => readEnvFile(path.join(root, ".env.local"))],
    [".env", () => readEnvFile(path.join(root, ".env"))],
    [userEnvPath(), () => readEnvFile(userEnvPath())],
  ];
  for (const [from, read] of places) {
    const picked = pick(read(), from);
    if (picked.kind !== "none") return picked;
  }
  return { kind: "none" };
};

let current: Credentials | undefined;

export const resolveCredentials = (root: string): Credentials => {
  current ??= findCredentials(root);
  return current;
};

export const credentials = (): Credentials => {
  current ??= pick(fromProcessEnv(), "the environment");
  return current;
};

export const hasApiKey = (root: string): boolean => resolveCredentials(root).kind !== "none";

/** The one file oh-my-plumb may write a key to; see AGENTS.md. */
export const saveUserKey = (name: string, key: string): string => {
  const file = userEnvPath();
  mkdirSync(path.dirname(file), { recursive: true });
  const existing = readEnvFile(file);
  existing.set(name, key);
  const body = [...existing.entries()].map(([k, v]) => `${k}=${v}`).join("\n");
  writeFileSync(file, `${body}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return file;
};

export const NO_KEY_HINT = `No API key found. Run "oh-my-plumb login" with your TypeSafe key, or put ${TYPESAFE_KEY_ENV} in the environment or a .env file at the repo root.`;
