import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { createSourceSha, RUBRIC_VERSION, type Rubric } from "oh-my-plumb-schema";
import { planCompile } from "../src/hooks/sessionStart.js";
import { compilePrompt } from "../src/lib/compilePrompt.js";
import { readRubric, fillSourceShas } from "../src/lib/rubricFile.js";
import { rubricPath } from "../src/lib/paths.js";

const fakeMcp = path.resolve(import.meta.dirname, "fixtures", "fake-mcp.mjs");
const INSTRUCTIONS = "Use fake-mcp only for demo rules; never for production.";

type Fixture = { root: string; home: string };

const fixture = (mode: string, optIn: boolean, command = "node"): Fixture => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-mcp-rules-"));
  const home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-mcp-rules-home-"));
  process.env.OH_MY_PLUMB_HOME_DIR = home;
  process.env.FAKE_MCP_LOG = path.join(root, "fake-mcp.log");
  writeFileSync(path.join(root, "AGENTS.md"), "# rules\n- Use type\n");
  // A repo-root MCP config the hosts actually use: the server command
  // resolves from here, so opting in never needs a second config file.
  writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { fakeGuard: { command, args: [fakeMcp, mode] } } }),
  );
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  // The opt-in lives in the rubric: `mcpInstructions` lists the servers whose
  // `initialize` instructions compile as rule sources. Absent = no MCP sources.
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: RUBRIC_VERSION,
      compiledAt: new Date().toISOString(),
      sources: [],
      rules: [],
      ...(optIn ? { mcpInstructions: ["fakeGuard"] } : {}),
    }),
  );
  return { root, home };
};

const cleanup = (f: Fixture): void => {
  delete process.env.OH_MY_PLUMB_HOME_DIR;
  delete process.env.FAKE_MCP_LOG;
  rmSync(f.root, { recursive: true, force: true });
  rmSync(f.home, { recursive: true, force: true });
};

describe("MCP instructions as rule sources", () => {
  it("opted-in instructions become a source scoped to that server's tools", async () => {
    const f = fixture("instructions", true);
    try {
      const plan = await planCompile(f.root);
      expect(plan.mcp).toHaveLength(1);
      expect(plan.mcp[0]).toMatchObject({
        path: "fakeGuard",
        scope: "mcp__fakeGuard__*",
        origin: "mcp",
        required: true,
        text: INSTRUCTIONS,
      });
      const project = plan.targets.find((t) => t.which === "project");
      expect(project?.candidates.map((c) => c.path)).toContain("fakeGuard");
    } finally {
      cleanup(f);
    }
  });

  it("opt-in is off by default: an old rubric without the section still validates", async () => {
    const f = fixture("instructions", false);
    try {
      const read = readRubric(rubricPath(f.root));
      expect(read.kind).toBe("ok");
      const plan = await planCompile(f.root);
      expect(plan.mcp).toHaveLength(0);
      const project = plan.targets.find((t) => t.which === "project");
      expect(project?.candidates.map((c) => c.path)).not.toContain("fakeGuard");
    } finally {
      cleanup(f);
    }
  });

  it("a server with no instructions or no binary is silence, not an error", async () => {
    const quiet = fixture("success", true);
    try {
      expect((await planCompile(quiet.root)).mcp).toHaveLength(0);
    } finally {
      cleanup(quiet);
    }
    const dead = fixture("instructions", true, "/nonexistent-mcp-bin");
    try {
      expect((await planCompile(dead.root)).mcp).toHaveLength(0);
    } finally {
      cleanup(dead);
    }
  });

  it("keeps the instructions text only in the source entry, hashed in the rubric", async () => {
    const f = fixture("instructions", true);
    try {
      const plan = await planCompile(f.root);
      const prompt = compilePrompt("compile-skill.md", plan.targets);
      expect(prompt).toContain("source: fakeGuard (rules apply to mcp__fakeGuard__*");
      expect(prompt.split(INSTRUCTIONS)).toHaveLength(2);

      const rubric: Rubric = {
        version: 1,
        compiledAt: "x",
        sources: [{ path: "fakeGuard", scope: "mcp__fakeGuard__*" }],
        mcpInstructions: ["fakeGuard"],
        rules: [],
      };
      const { rubric: filled, missing } = fillSourceShas(rubric, f.root, plan.mcp);
      expect(missing).toEqual([]);
      expect(filled.sources[0]?.sha).toBe(createSourceSha(INSTRUCTIONS));
      // validate marks a source named for an opted-in server as MCP.
      expect(filled.sources[0]?.kind).toBe("mcp");
      expect(JSON.stringify(filled)).not.toContain(INSTRUCTIONS);
    } finally {
      cleanup(f);
    }
  });

  it("starts no server on a fresh rubric, and one when a listed server has no source yet", async () => {
    const f = fixture("instructions", true);
    try {
      const listedRubric = (sources: Rubric["sources"]): void =>
        writeFileSync(
          rubricPath(f.root),
          JSON.stringify({
            version: RUBRIC_VERSION,
            compiledAt: "x",
            sources,
            mcpInstructions: ["fakeGuard"],
            rules: [],
          }),
        );
      const agents = { path: "AGENTS.md", sha: createSourceSha("# rules\n- Use type\n") };
      // Opted in but never compiled: the plan starts the server and asks for a compile.
      listedRubric([agents]);
      const due = await planCompile(f.root);
      expect(due.mcp).toHaveLength(1);
      expect(due.targets.find((t) => t.which === "project")?.staleness).toMatchObject({
        status: "stale",
        added: ["fakeGuard"],
      });
      // Fresh and covered: no server is started, so no log is written.
      rmSync(path.join(f.root, "fake-mcp.log"), { force: true });
      listedRubric([
        agents,
        {
          path: "fakeGuard",
          kind: "mcp",
          scope: "mcp__fakeGuard__*",
          sha: createSourceSha(INSTRUCTIONS),
        },
      ]);
      const fresh = await planCompile(f.root);
      expect(fresh.mcp).toHaveLength(0);
      expect(fresh.targets.find((t) => t.which === "project")).toBeUndefined();
      expect(existsSync(path.join(f.root, "fake-mcp.log"))).toBe(false);
    } finally {
      cleanup(f);
    }
  });
});
