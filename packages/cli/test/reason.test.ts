import { describe, expect, it } from "vite-plus/test";
import type { Rule } from "oh-my-plumb-schema";
import { toolCallReason } from "../src/lib/reason.js";

describe("toolCallReason", () => {
  it("names the rule, its source, and the call to redo", () => {
    const rule: Rule = {
      id: "use-rtk",
      text: "Always prefix shell commands with rtk",
      source: { path: "RTK.md", line: 2 },
      target: "toolCall",
      status: "active",
      check: { type: "model", question: { type: "boolean", instructions: "?" } },
    };
    const reason = toolCallReason(
      [{ rule, verdict: { ruleId: "use-rtk", probability: 0.95, band: "act" } }],
      "Bash",
    );
    expect(reason).toContain('Rule "use-rtk" from RTK.md line 2');
    expect(reason).toContain('"Always prefix shell commands with rtk"');
    expect(reason).toContain("The call to Bash");
    expect(reason).toContain("Redo the call the way the rule asks");
  });
});
