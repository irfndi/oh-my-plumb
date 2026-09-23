import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { handlePostToolUse } from "../src/hooks/postToolUse.js";
import { GUARD_TIMEOUT_MS } from "../src/lib/guards.js";

const decidingGuard = `#!/usr/bin/env node
let text = "";
for await (const chunk of process.stdin) text += chunk;
const hits = text.split("\\n").filter((line) => /^\\s*(export\\s+)?interface\\s/.test(line));
console.log(
  hits.length === 0
    ? JSON.stringify({ isError: false })
    : JSON.stringify({ isError: true, content: "use type, not interface" }),
);
`;

const hangingGuard = `#!/usr/bin/env node
setTimeout(() => {}, 60_000);
`;
// ts-no-test-timers exception: the hang must happen in the spawned child, which fake
// timers cannot reach; the child is SIGKILLed at GUARD_TIMEOUT_MS, so the test waits ~2 s.

const garbageGuard = `#!/usr/bin/env node
console.log("this is not json");
`;

/** A temp repo whose rubric points one guard skill at `script`. */
const repoWithGuard = (script: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-guard-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- Use type, not interface.\n");
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "type-not-interface",
          text: "Use type, not interface.",
          source: { path: "AGENTS.md" },
          check: {
            type: "guard",
            skill: "interface-guard",
            scope: "{*.ts,*.tsx}",
            text: "Use type, not interface.",
          },
        },
      ],
    }),
  );
  mkdirSync(path.join(root, "skills", "interface-guard"), { recursive: true });
  const guard = path.join(root, "skills", "interface-guard", "guard.mjs");
  writeFileSync(guard, script);
  chmodSync(guard, 0o755);
  return root;
};

const write = (sessionId: string, root: string, content: string) =>
  handlePostToolUse({
    session_id: sessionId,
    prompt_id: "p",
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, "a.ts"), content },
    tool_response: { originalFile: null, structuredPatch: [] },
  });

describe("a skill guard through postToolUse, end to end", () => {
  beforeEach(() => {
    process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-guard-home-"));
  });
  afterEach(() => {
    delete process.env.OH_MY_PLUMB_HOME_DIR;
  });

  it("blocks when the spawned guard reports isError", async () => {
    const out = await write("guard-block", repoWithGuard(decidingGuard), "export interface X {}\n");
    expect(out.kind).toBe("block");
    expect(out.kind === "block" ? out.reason : "").toContain("use type, not interface");
    expect(out.kind === "block" ? out.reason : "").toContain("type-not-interface");
  });

  it("passes when the spawned guard reports a clean file", async () => {
    const out = await write("guard-pass", repoWithGuard(decidingGuard), "export type X = 1;\n");
    expect(out.kind).toBe("silent");
  });

  it("skips a guard that hangs, at the deadline, without a throw", async () => {
    const root = repoWithGuard(hangingGuard);
    const started = performance.now();
    const out = await write("guard-hang", root, "export const x = 1;\n");
    const elapsed = performance.now() - started;
    expect(out.kind).toBe("silent");
    // The guard really ran and the deadline, not an early death, ended it.
    expect(elapsed).toBeGreaterThanOrEqual(GUARD_TIMEOUT_MS - 500);
    expect(elapsed).toBeLessThan(GUARD_TIMEOUT_MS + 5_000);
  }, 15_000);

  it("skips a guard that prints garbage, without a throw", async () => {
    const out = await write("guard-garbage", repoWithGuard(garbageGuard), "export const x = 1;\n");
    expect(out.kind).toBe("silent");
  });
});
