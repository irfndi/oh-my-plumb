import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";
import { handlePostToolUse } from "../src/hooks/postToolUse.js";
import { CODE_CHECK_TIMEOUT_MS, runCodeCheck } from "../src/lib/guards.js";
import type { CodeCheck } from "oh-my-plumb-schema";

const check = (script: string, scope = "**/*.ts"): CodeCheck => ({
  type: "code",
  scope,
  text: "Keep lines under 120 characters.",
  script,
});

const passScripts = [
  "return { isError: false };",
  "return undefined;",
  "",
  "return 'not an object';",
  "return 42;",
  "throw new Error('boom');",
  "return { isError: 'yes', content: 'sloppy' };",
];

describe("runCodeCheck", () => {
  it("blocks with the script's content", async () => {
    const hit = await runCodeCheck(
      "max-line-length",
      check(
        `const long = contents.split("\\n").filter((l) => l.length > 120);
return long.length === 0 ? { isError: false } : { isError: true, content: "line " + (long.length) + " too long" };`,
      ),
      "src/a.ts",
      `const line = '${"x".repeat(200)}';\n`,
    );
    expect(hit).toEqual({
      ruleId: "max-line-length",
      source: "max-line-length",
      reason: "max-line-length: src/a.ts: line 1 too long",
    });
  });

  it.each([
    ["no content at all", "return { isError: true };"],
    ["an empty content", "return { isError: true, content: '' };"],
  ])("falls back to the rule's text on a block with %s", async (_name, script) => {
    const hit = await runCodeCheck("r", check(script), "a.ts", "x\n");
    expect(hit?.reason).toContain("Keep lines under 120 characters.");
  });

  it.each(passScripts)("passes: %s", async (script) => {
    expect(await runCodeCheck("r", check(script), "a.ts", "x\n")).toBeUndefined();
  });

  it("passes a script that never returns, at the timeout", async () => {
    const started = performance.now();
    expect(await runCodeCheck("r", check("while (true) {}"), "a.ts", "x\n")).toBeUndefined();
    expect(performance.now() - started).toBeGreaterThanOrEqual(CODE_CHECK_TIMEOUT_MS - 100);
  }, 10_000);

  it("sees no process, require or imports from the host", async () => {
    const script = `let leak = '';
try { leak = String(typeof process) + ',' + String(typeof require); } catch { leak = 'threw'; }
return leak === 'undefined,undefined' ? { isError: false } : { isError: true, content: leak };`;
    expect(await runCodeCheck("r", check(script), "a.ts", "x\n")).toBeUndefined();
  });

  it("the sandbox escape through this.constructor.constructor finds nothing", async () => {
    const script = `const host = (function () { return this; })() || (function () { return globalThis; })();
const Outer = host.constructor.constructor;
const probe = Outer('return typeof process')();
return probe === 'undefined' ? { isError: false } : { isError: true, content: 'escaped: ' + probe };`;
    expect(await runCodeCheck("r", check(script), "a.ts", "x\n")).toBeUndefined();
  });

  it("a dynamic import cannot crash the hook: its rejection is drained", async () => {
    const script = `import('node:fs');
return { isError: false };`;
    expect(await runCodeCheck("r", check(script), "a.ts", "x\n")).toBeUndefined();
  });
});

/** A temp repo whose only rule is one code check. */
const repoWithCodeRule = (script: string, scope: string): string => {
  const root = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-code-repo-"));
  writeFileSync(path.join(root, "AGENTS.md"), "- Keep lines under 120 characters.\n");
  mkdirSync(path.join(root, ".oh-my-plumb"), { recursive: true });
  writeFileSync(
    path.join(root, ".oh-my-plumb", "rubric.json"),
    JSON.stringify({
      version: 1,
      compiledAt: "x",
      sources: [{ path: "AGENTS.md" }],
      rules: [
        {
          id: "max-line-length",
          text: "Keep lines under 120 characters.",
          source: { path: "AGENTS.md" },
          check: { type: "code", scope, text: "Keep lines under 120 characters.", script },
        },
      ],
    }),
  );
  return root;
};

const write = (sessionId: string, root: string, file: string, content: string) =>
  handlePostToolUse({
    session_id: sessionId,
    prompt_id: "p",
    cwd: root,
    hook_event_name: "PostToolUse",
    tool_name: "Write",
    tool_input: { file_path: path.join(root, file), content },
    tool_response: { originalFile: null, structuredPatch: [] },
  });

describe("a code check through postToolUse, end to end", () => {
  beforeEach(() => {
    process.env.OH_MY_PLUMB_HOME_DIR = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-code-home-"));
  });
  afterEach(() => {
    delete process.env.OH_MY_PLUMB_HOME_DIR;
  });

  const script = `const long = contents.split("\\n").map((line, i) => [line.length, i + 1]).filter(([n]) => n > 120);
return long.length === 0
  ? { isError: false }
  : { isError: true, content: "Lines over 120 chars: " + long.map(([, n]) => n).join(", ") + ". Break them up." };`;

  it("blocks the edit when the check fires", async () => {
    const root = repoWithCodeRule(script, "**/*.ts");
    const out = await write("code-block", root, "a.ts", `const x = '${"y".repeat(200)}';\n`);
    expect(out.kind).toBe("block");
    expect(out.kind === "block" ? out.reason : "").toContain("max-line-length");
    expect(out.kind === "block" ? out.reason : "").toContain("Break them up");
  });

  it("passes a clean edit", async () => {
    const root = repoWithCodeRule(script, "**/*.ts");
    const out = await write("code-pass", root, "a.ts", "const x = 1;\n");
    expect(out.kind).toBe("silent");
  });

  it("does not run on files outside the scope", async () => {
    const root = repoWithCodeRule(script, "**/*.ts");
    const out = await write("code-scope", root, "notes.md", "x".repeat(300) + "\n");
    expect(out.kind).toBe("silent");
  });
});
