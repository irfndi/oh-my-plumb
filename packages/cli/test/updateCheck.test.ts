import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import {
  CHECK_INTERVAL_MS,
  UPDATE_CHECK_LATEST_ENV,
  UPDATE_COMMANDS,
  updateNotice,
} from "../src/lib/updateCheck.js";

const savedHome = process.env.OH_MY_PLUMB_HOME_DIR;
const savedPin = process.env[UPDATE_CHECK_LATEST_ENV];
beforeEach(() => {
  process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  delete process.env[UPDATE_CHECK_LATEST_ENV];
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.OH_MY_PLUMB_HOME_DIR;
  else process.env.OH_MY_PLUMB_HOME_DIR = savedHome;
  if (savedPin === undefined) delete process.env[UPDATE_CHECK_LATEST_ENV];
  else process.env[UPDATE_CHECK_LATEST_ENV] = savedPin;
});

const stateFile = (): string => {
  const dir = path.join(process.env.OH_MY_PLUMB_HOME_DIR ?? "", ".oh-my-plumb");
  mkdirSync(dir, { recursive: true });
  return path.join(dir, "update-check.json");
};

describe("updateCheck", () => {
  it("names every host's own update command", () => {
    expect(UPDATE_COMMANDS).toEqual({
      pi: "pi update --extensions",
      omp: "omp update --plugins",
      opencode: "opencode plugin update",
      claude: "npm i -g oh-my-plumb@latest",
      codex: "npm i -g oh-my-plumb@latest",
    });
  });

  it("says nothing when the cache is fresh and no newer release is known", () => {
    writeFileSync(stateFile(), JSON.stringify({ checkedAt: Date.now(), latest: "0.2.0" }));
    expect(updateNotice("0.2.0")).toBeUndefined();
  });

  it("says nothing about a running copy it cannot version", () => {
    writeFileSync(stateFile(), JSON.stringify({ checkedAt: Date.now(), latest: "9.9.9" }));
    expect(updateNotice("unknown")).toBeUndefined();
  });

  it("mentions the newer release with the host commands when one is pinned", () => {
    writeFileSync(
      stateFile(),
      JSON.stringify({ checkedAt: Date.now() - CHECK_INTERVAL_MS - 1, latest: "0.2.0" }),
    );
    process.env[UPDATE_CHECK_LATEST_ENV] = "0.3.0";
    const notice = updateNotice("0.2.0");
    expect(notice).toContain("oh-my-plumb 0.3.0 is available (running 0.2.0)");
    expect(notice).toContain("pi: pi update --extensions");
    expect(notice).toContain("opencode: opencode plugin update");
  });

  it("compares prerelease segments by their numeric prefix", () => {
    writeFileSync(
      stateFile(),
      JSON.stringify({ checkedAt: Date.now() - CHECK_INTERVAL_MS - 1, latest: "0.2.0" }),
    );
    process.env[UPDATE_CHECK_LATEST_ENV] = "0.3.0-beta.10";
    expect(updateNotice("0.3.0-beta.2")).toContain("oh-my-plumb 0.3.0-beta.10 is available");
  });

  it("writes the checked release to the state file", () => {
    writeFileSync(
      stateFile(),
      JSON.stringify({ checkedAt: Date.now() - CHECK_INTERVAL_MS - 1, latest: "0.2.0" }),
    );
    process.env[UPDATE_CHECK_LATEST_ENV] = "0.2.0";
    updateNotice("0.2.0", Date.now());
    const state = JSON.parse(readFileSync(stateFile(), "utf8"));
    expect(typeof state.checkedAt).toBe("number");
    expect(state.latest).toBe("0.2.0");
  });
});
