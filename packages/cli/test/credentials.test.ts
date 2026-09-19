import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { findCredentials, parseEnvFile, saveUserKey, userEnvPath } from "../src/lib/credentials.js";

let home: string;
let root: string;
const saved: Record<string, string | undefined> = {};

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
});
