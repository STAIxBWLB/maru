import { describe, expect, it } from "vitest";
import { proposalFromReport, type RepoScanReport } from "./repoScan";

/** The shape `scan_repository` returns, built by hand (no repository content). */
function report(document: Record<string, unknown>): RepoScanReport {
  return {
    document,
    relativePath: "web",
    stats: { inventory: "filesystem", files: 3, sourceFiles: 3, fileImports: 2, skippedLarge: 0, nodes: 2, edges: 1 },
  };
}

const proposed = {
  $schema: "floorplan/architecture@1",
  audience: "developers",
  project: { name: "web", summary: "Proposed by the Maru repository scan from 3 files." },
  nodes: [
    { id: "src", label: "src", kind: "library", paths: ["src/**"] },
    { id: "src.ui", parent: "src", label: "ui", kind: "ui", paths: ["src/ui/**"], packages: ["react"] },
  ],
  edges: [{ from: "src", to: "src.ui", kind: "import" }],
};

describe("repository scan proposal", () => {
  it("opens a valid proposal as an unsaved floorplan document with generated provenance", () => {
    const outcome = proposalFromReport(report(proposed), 42);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const dataset = outcome.doc.datasets?.find((entry) => entry.kind === "semanticSpec");
    expect(dataset).toMatchObject({
      kind: "semanticSpec",
      diagramType: "floorplan",
      provenance: { origin: "generated", sourcePath: "web", capturedAt: 42 },
    });
    // The spec is carried verbatim, so saving writes exactly what was proposed.
    expect(dataset && "spec" in dataset ? dataset.spec : null).toEqual(proposed);
    expect(outcome.doc.nodes.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a proposal the floorplan checks reject instead of opening it", () => {
    const broken = { ...proposed, edges: [{ from: "src", to: "missing", kind: "import" }] };
    const outcome = proposalFromReport(report(broken));
    expect(outcome.ok).toBe(false);
    expect(outcome.diagnostics.length).toBeGreaterThan(0);
  });
});
