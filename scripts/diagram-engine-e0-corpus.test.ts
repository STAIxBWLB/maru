import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { hasPrivateText, withoutRepositoryEvidence } from "./diagram-engine-e0-corpus.mjs";

describe("E0 public corpus intake", () => {
  it("recognizes local paths and contact data with optional private terms", () => {
    expect(hasPrivateText("/Users/fixture/work")).toBe(true);
    expect(hasPrivateText("reader@example.test")).toBe(true);
    expect(hasPrivateText("Fixture Person", ["fixture person"])).toBe(true);
    expect(hasPrivateText("https://github.com/example/home")).toBe(false);
  });
  it("keeps separate document-validity verdicts for all eight public blobs", () => {
    const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8"));
    const publicCases = corpus.cases.filter((item: { origin: { kind: string } }) => item.origin.kind === "public");
    expect(publicCases).toHaveLength(8);
    for (const item of publicCases) {
      expect(item.oracle.codes).toContain("repository-evidence/root-required");
      expect(item.validityOracle.ok).toBe(true);
      expect(item.validityOracle.codes).toEqual([]);
      expect(item.validityOracle.inputSha256).not.toBe(item.inputSha256);
    }
  });
  it("strips only evidence for the additional validity verdict without changing the original spec", () => {
    const input = { meta: { title: "Example", repository: { revision: "fixture" } }, components: [{ id: "a", sources: ["file.ts"], label: "A" }], connections: [] };
    const clean = withoutRepositoryEvidence(input, "architecture");
    expect(clean.meta).toEqual({ title: "Example" });
    expect(clean.components).toEqual([{ id: "a", label: "A" }]);
    expect(input.components[0].sources).toEqual(["file.ts"]);
    expect(input.meta.repository.revision).toBe("fixture");
  });
});
