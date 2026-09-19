import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { compileSkillPath, placeCompileSkill } from "../src/lib/packageRoot.js";

describe("placing the compile skill in a repo (needs `pnpm build` first)", () => {
  it("copies it into .oh-my-plumb", () => {
    const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-skill-"));
    const placed = placeCompileSkill(root);
    expect(placed).toBe(path.join(root, ".oh-my-plumb", "compile-skill.md"));
    expect(readFileSync(placed, "utf8")).toBe(readFileSync(compileSkillPath(), "utf8"));
    expect(placeCompileSkill(root)).toBe(placed);
  });

  it(
    "refuses a FIFO or a symlink in the copy's place and falls back to the packaged copy",
    { timeout: 3_000 },
    () => {
      const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-skill-"));
      mkdirSync(path.join(root, ".oh-my-plumb"));
      execSync(`mkfifo "${path.join(root, ".oh-my-plumb", "compile-skill.md")}"`);
      expect(placeCompileSkill(root)).toBe(compileSkillPath());

      const other = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-skill-"));
      const precious = path.join(other, "precious.txt");
      writeFileSync(precious, "keep me\n");
      mkdirSync(path.join(other, ".oh-my-plumb"));
      symlinkSync(precious, path.join(other, ".oh-my-plumb", "compile-skill.md"));
      expect(placeCompileSkill(other)).toBe(compileSkillPath());
      expect(readFileSync(precious, "utf8")).toBe("keep me\n");
      expect(existsSync(path.join(other, ".oh-my-plumb", "compile-skill.md"))).toBe(true);
    },
  );
});
