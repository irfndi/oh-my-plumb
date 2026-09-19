import { describe, expect, it } from "vite-plus/test";
import { editsCoverFile } from "../src/lib/coverage.js";

const edit = (before: string | null, after: string) => ({ path: "a.ts", before, after });

describe("whether judged edits cover a file's whole turn", () => {
  it("accepts a chain from the start to the file as it stands, in any order", () => {
    expect(editsCoverFile("0", [edit("1", "2"), edit("0", "1")], "2")).toBe(true);
    expect(editsCoverFile(null, [edit(null, "1")], "1")).toBe(true);
    expect(editsCoverFile("0", [], "0")).toBe(true);
  });

  it("refuses a chain with a change nobody judged", () => {
    // A shell changed the file before the edit, or after it, or while a judge was looking.
    expect(editsCoverFile("0", [edit("1", "2")], "2")).toBe(false);
    expect(editsCoverFile("0", [edit("0", "1")], "2")).toBe(false);
    expect(editsCoverFile("0", [edit("0", "1")], "1x")).toBe(false);
    expect(editsCoverFile("0", [], "1")).toBe(false);
    expect(editsCoverFile(null, [edit("0", "1")], "1")).toBe(false);
  });

  it("does not loop on edits that undo each other", () => {
    expect(editsCoverFile("0", [edit("0", "1"), edit("1", "0")], "2")).toBe(false);
  });
});
