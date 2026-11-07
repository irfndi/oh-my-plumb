import { describe, expect, it } from "vite-plus/test";
import { boundedPattern, MAX_REGEX_INPUT_CHARS } from "../src/lib/pattern.js";

describe("a rubric's regex is bounded before it runs", () => {
  const timely = (run: () => void): number => {
    const started = Date.now();
    run();
    return Date.now() - started;
  };

  it("refuses a nested quantifier instead of running it", () => {
    const pattern = boundedPattern("(a+)+$");
    expect(pattern.kind).toBe("refuse");
    // The same pattern compiled by hand is what this refuses to do.
    expect(
      timely(() => pattern.kind === "match" && pattern.test("a".repeat(30) + "b")),
    ).toBeLessThan(50);
  });

  it("refuses the brace and mixed spellings too", () => {
    for (const pattern of ["(a{1,10})+$", "(a*)*b", "(\\w+\\s?)+$"])
      expect(boundedPattern(pattern).kind).toBe("refuse");
  });

  it("still runs the patterns people actually write", () => {
    const ran = boundedPattern("\\b(bun run check|oxlint|oxfmt)(?:\\s|$)");
    expect(ran.kind).toBe("match");
    expect(ran.kind === "match" && ran.test("cd apps && bun run check --all")).toBe(true);
    expect(ran.kind === "match" && ran.test("bun run check:types")).toBe(false);
  });

  it("refuses text past the bound rather than reading a document", () => {
    const ran = boundedPattern("SELECT");
    expect(ran.kind === "match" && ran.test("SELECT ".repeat(MAX_REGEX_INPUT_CHARS))).toBe(false);
  });

  it("refuses a pattern that does not compile", () => {
    expect(boundedPattern("([unclosed").kind).toBe("refuse");
  });
});
