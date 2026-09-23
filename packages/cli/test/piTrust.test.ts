import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { readPiTrust } from "../src/lib/piTrust.js";

let home: string;
let project: string;

beforeEach(() => {
  home = mkdtempSync(path.join(tmpdir(), "oh-my-plumb-home-"));
  // pi stores canonical paths, so the fixture spells them the way pi writes them.
  project = realpathSync(mkdtempSync(path.join(tmpdir(), "oh-my-plumb-repo-")));
});

const writeTrust = (text: string): void => {
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "trust.json"), text);
};

describe("readPiTrust", () => {
  it("takes the nearest saved decision for the project or a folder above it", () => {
    writeTrust(JSON.stringify({ [project]: true }));
    expect(readPiTrust(project, home)).toBe("trusted");
    writeTrust(JSON.stringify({ [path.dirname(project)]: true, [project]: false }));
    expect(readPiTrust(project, home)).toBe("untrusted");
    writeTrust(JSON.stringify({ [path.dirname(project)]: true, [project]: null }));
    expect(readPiTrust(project, home)).toBe("trusted");
  });

  it("calls a readable store with no decision for this project untrusted", () => {
    writeTrust("{}");
    expect(readPiTrust(project, home)).toBe("untrusted");
  });

  it("says unknown when pi's store is missing or malformed, and never throws", () => {
    expect(readPiTrust(project, home)).toBe("unknown");
    writeTrust("not json");
    expect(readPiTrust(project, home)).toBe("unknown");
    writeTrust(JSON.stringify({ [project]: "yes" }));
    expect(readPiTrust(project, home)).toBe("unknown");
    writeTrust("[]");
    expect(readPiTrust(project, home)).toBe("unknown");
  });
});
