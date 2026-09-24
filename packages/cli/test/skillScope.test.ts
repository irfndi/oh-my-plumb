import { describe, expect, it } from "vite-plus/test";
import type { Rule } from "oh-my-plumb-schema";
import { filterToLoadedSkills } from "../src/lib/skillScope.js";

const skillRule: Rule = {
  id: "deploy-checksum",
  text: "Run the checksum before installing.",
  source: { path: "skills/deploy/SKILL.md", line: 3 },
  target: "diff",
  status: "active",
  check: { type: "lint", how: "shasum -c" },
};

const plainRule: Rule = {
  id: "plain-agents",
  text: "Use type, never interface.",
  source: { path: "AGENTS.md", line: 10 },
  target: "diff",
  status: "active",
  check: { type: "lint", how: "@typescript-eslint/consistent-type-definitions" },
};

const rules: Rule[] = [skillRule, plainRule];

describe("skill scoping", () => {
  it("excludes a skill's rules for a turn whose log never named it", () => {
    expect(filterToLoadedSkills(rules, []).map((r) => r.id)).toEqual(["plain-agents"]);
    expect(
      filterToLoadedSkills(rules, [
        { order: 1, name: "Read", summary: "{filePath=AGENTS.md}" },
      ]).map((r) => r.id),
    ).toEqual(["plain-agents"]);
  });

  it("includes a skill's rules once the log names the skill", () => {
    expect(
      filterToLoadedSkills(rules, [{ order: 1, name: "Skill", summary: "{name=deploy}" }]).map(
        (r) => r.id,
      ),
    ).toEqual(["deploy-checksum", "plain-agents"]);
    expect(
      filterToLoadedSkills(rules, [
        { order: 2, name: "Bash", summary: "{command=pnpm run deploy}" },
      ]).map((r) => r.id),
    ).toEqual(["deploy-checksum", "plain-agents"]);
  });
});
