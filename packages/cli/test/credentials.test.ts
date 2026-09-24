import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isPlumbError } from "oh-my-plumb-schema";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  findCredentials,
  NO_KEY_HINT,
  parseEnvFile,
  requireApiKey,
  saveUserKey,
  userEnvPath,
} from "../src/lib/credentials.js";

let home: string;
let root: string;
const saved: Record<string, string | undefined> = {};

/** The message the no-key guard throws; anything else fails the test here, not later. */
const noKeyMessage = (): string => {
  try {
    requireApiKey(root);
  } catch (error) {
    if (isPlumbError(error) && error.code === "NO_API_KEY") return error.message;
    throw error;
  }
  throw new Error("expected NO_API_KEY but a key was found");
};

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-"));
  process.env.OH_MY_PLUMB_HOME_DIR = home;
  for (const name of ["TYPESAFE_AI_API_KEY", "AI_GATEWAY_API_KEY"]) {
    saved[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  delete process.env.OH_MY_PLUMB_HOME_DIR;
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("credentials", () => {
  it("reads only the two oh-my-plumb keys out of an env file", () => {
    const vars = parseEnvFile(
      "# comment\nexport TYPESAFE_AI_API_KEY=\"abc\"\nOTHER=1\nAI_GATEWAY_API_KEY='g'\nBROKEN\n",
    );
    expect([...vars.entries()]).toEqual([
      ["TYPESAFE_AI_API_KEY", "abc"],
      ["AI_GATEWAY_API_KEY", "g"],
    ]);
  });

  it("looks in the environment, then the repo, then the user file, and prefers TypeSafe", () => {
    expect(findCredentials(root)).toEqual({ kind: "none" });
    saveUserKey("AI_GATEWAY_API_KEY", "user-gateway");
    expect(findCredentials(root)).toMatchObject({ kind: "gateway", key: "user-gateway" });
    writeFileSync(path.join(root, ".env"), "TYPESAFE_AI_API_KEY=repo\n");
    expect(findCredentials(root)).toMatchObject({ kind: "typesafe", key: "repo", from: ".env" });
    writeFileSync(path.join(root, ".env.local"), "AI_GATEWAY_API_KEY=local\n");
    expect(findCredentials(root)).toMatchObject({
      kind: "gateway",
      key: "local",
      from: ".env.local",
    });
    process.env.TYPESAFE_AI_API_KEY = "env";
    expect(findCredentials(root)).toMatchObject({ kind: "typesafe", key: "env" });
  });

  it("writes the user file owner-only and keeps the other key", () => {
    saveUserKey("TYPESAFE_AI_API_KEY", "t");
    saveUserKey("AI_GATEWAY_API_KEY", "g");
    const file = userEnvPath();
    expect(readFileSync(file, "utf8")).toBe("TYPESAFE_AI_API_KEY=t\nAI_GATEWAY_API_KEY=g\n");
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("points at the repo .env when a near-miss key name sits there", () => {
    writeFileSync(path.join(root, ".env"), "TYPESAFE_API_KEY=repo-near-miss-secret\n");
    const message = noKeyMessage();
    expect(message).toContain("Found TYPESAFE_API_KEY in .env — rename it to TYPESAFE_AI_API_KEY");
    expect(message.startsWith(NO_KEY_HINT)).toBe(true);
    expect(message).not.toContain("repo-near-miss-secret");
  });

  it("points at the user file when the near-miss key name sits there", () => {
    const file = saveUserKey("JEV_API_KEY", "user-near-miss-secret");
    const message = noKeyMessage();
    expect(message).toContain(`Found JEV_API_KEY in ${file} — rename it to TYPESAFE_AI_API_KEY`);
    expect(message).not.toContain("user-near-miss-secret");
  });

  it("points at the environment when a near-miss name is exported there", () => {
    process.env.TYPESAFE_API_KEY = "env-near-miss-secret";
    try {
      const message = noKeyMessage();
      expect(message).toContain(
        "Found TYPESAFE_API_KEY in the environment — rename it to TYPESAFE_AI_API_KEY",
      );
      expect(message).not.toContain("env-near-miss-secret");
    } finally {
      delete process.env.TYPESAFE_API_KEY;
    }
  });

  it("keeps the error unchanged when no near-miss name is present", () => {
    writeFileSync(path.join(root, ".env"), "SOMETHING_ELSE=x\n");
    expect(noKeyMessage()).toBe(NO_KEY_HINT);
  });

  it("never puts a discovered value in the message", () => {
    writeFileSync(path.join(root, ".env.local"), "TYPESAFE_KEY=repo-secret-value\n");
    saveUserKey("JEV_API_KEY", "user-secret-value");
    const message = noKeyMessage();
    expect(message).toContain(
      "Found TYPESAFE_KEY in .env.local — rename it to TYPESAFE_AI_API_KEY",
    );
    expect(message).not.toContain("repo-secret-value");
    expect(message).not.toContain("user-secret-value");
  });
});
