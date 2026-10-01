import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createBlobId } from "oh-my-plumb-schema";
import {
  blobIdsAt,
  snapshotTree,
  splitDiff,
  untrackIgnored,
  workingTreeDiff,
} from "../src/lib/git.js";

const commitAll = (root: string): void => {
  execSync("git add -A && git -c user.email=a@b -c user.name=a commit -q -m init", { cwd: root });
};

describe("the working tree diff", () => {
  it("includes files git does not track yet", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-git-"));
    execSync("git init -q .", { cwd: root });
    writeFileSync(path.join(root, "tracked.ts"), "export const a = 1;\n");
    execSync("git add . && git -c user.email=a@b -c user.name=a commit -q -m init", { cwd: root });
    writeFileSync(path.join(root, "tracked.ts"), "export const a = 2;\n");
    writeFileSync(path.join(root, "new.ts"), "export const b = 1;\n");
    const files = splitDiff(workingTreeDiff(root, []));
    expect(files.map((f) => f.file).sort()).toEqual(["new.ts", "tracked.ts"]);
    expect(files.find((f) => f.file === "new.ts")?.text).toContain("+export const b = 1;");
  });

  it("leaves secret files out of every patch it splits", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-git-"));
    execSync("git init -q .", { cwd: root });
    writeFileSync(path.join(root, ".env"), "KEY=1\n");
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    expect(splitDiff(workingTreeDiff(root, [])).map((f) => f.file)).toEqual(["a.ts"]);
  });

  it("untracks committed-then-ignored files, keeps the working copies, and reports only what it untracked", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-git-"));
    execSync("git init -q .", { cwd: root });
    writeFileSync(path.join(root, ".gitignore"), "events.jsonl\n");
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    mkdirSync(path.join(root, ".oh-my-plumb"));
    writeFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "{\n");
    execSync("git add -f .oh-my-plumb/events.jsonl", { cwd: root });
    commitAll(root);
    expect(untrackIgnored(root, [])).toEqual([]);
    expect(untrackIgnored(root, [".oh-my-plumb/events.jsonl", "a.ts"])).toEqual([
      ".oh-my-plumb/events.jsonl",
    ]);
    expect(execSync("git ls-files", { cwd: root, encoding: "utf8" }).trim().split("\n")).toEqual([
      ".gitignore",
      "a.ts",
    ]);
    expect(readFileSync(path.join(root, ".oh-my-plumb", "events.jsonl"), "utf8")).toBe("{\n");
    expect(untrackIgnored(root, [".oh-my-plumb/events.jsonl"])).toEqual([]);
  });
});

describe("the turn snapshot", () => {
  it("names each file's content as git does, and never stages a secret file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-git-"));
    execSync("git init -q .", { cwd: root });
    mkdirSync(path.join(root, "apps"));
    writeFileSync(path.join(root, "a.ts"), "export const a = 1;\n");
    writeFileSync(path.join(root, ".env"), "KEY=1\n");
    writeFileSync(path.join(root, "apps", ".env.local"), "KEY=2\n");
    writeFileSync(path.join(root, "apps", "server.key"), "k\n");
    const tree = snapshotTree(root, path.join(root, ".git", "oh-my-plumb-index"), 5_000);
    expect(tree).toMatch(/^[0-9a-f]{40,64}$/);
    if (tree === undefined) return;
    const ids = blobIdsAt(
      root,
      tree,
      ["a.ts", ".env", "apps/.env.local", "apps/server.key"],
      5_000,
    );
    expect(ids).toEqual(new Map([["a.ts", createBlobId("export const a = 1;\n")]]));
    const staged = execSync("git ls-tree -r --name-only " + tree, { cwd: root, encoding: "utf8" });
    expect(staged.trim().split("\n")).toEqual(["a.ts"]);
    expect(blobIdsAt(root, tree, [], 5_000)).toEqual(new Map());
    expect(blobIdsAt(root, "0".repeat(40), ["a.ts"], 5_000)).toBeUndefined();
  });
});
