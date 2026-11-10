import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface CorpusCase {
  id: string;
  inputJson: string;
  oracle: { ok: boolean };
  geometryComparison?: { inputJson: string };
}
interface LedgerRecord {
  corpusCaseRef: string;
  id: string;
  originalS3ModelDifference: boolean;
  currentMismatch: boolean;
  source: { inputJson: string; inputSha256: string; spec: unknown; origin?: unknown };
  oracle: { ok: boolean };
  boundary: unknown;
  geometryRule: string;
  pinnedSourceRefs: unknown[];
  engine: { accepted: boolean; geometry: unknown; diagnostics: unknown[] };
  disposition: { status: string; reason: string };
  pinnedSourceRefs: unknown[];
  numericGeometryEvidence: unknown;
  engineSourceCommit: string;
  sdkTreePath: string;
  sdkTree: string;
  engineCrateTreePath: string;
  engineCrateTree: string;
  engineEvidenceScope: string;
  historicalEvidence?: {
    engine: { accepted: boolean; geometry: unknown; diagnostics: unknown[] };
    disposition: { status: string; reason: string };
    numericGeometryEvidence: unknown;
  };
}
interface Ledger {
  schemaVersion: number;
  sourceCommit: string;
  sdkTreePath: string;
  sdkTree: string;
  engineCrateTreePath: string;
  engineCrateTree: string;
  sourceScope: {
    kind: string;
    refreshedCaseIds: string[];
    refreshedSourceCommit: string;
    refreshedSdkTree: string;
    preservedSourceCommit: string;
    preservedSdkTree: string;
  };
  counts: {
    unionCases: number;
    originalModelDifferenceCases: number;
    currentMismatches: number;
    currentAgreementsWithinUnion: number;
    fixedCases: number;
    fixedStatusCounts: Record<string, number>;
    statusCounts: Record<string, number>;
  };
  records: LedgerRecord[];
}
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8")) as unknown;
const corpus = readJson("src-tauri/crates/maru-diagram-engine/testdata/parity.json") as {
  cases: CorpusCase[];
  boundaryCases: CorpusCase[];
};
const receipt = readJson("docs/diagram-engine-e2-s3.json") as {
  boundaryEvidence: {
    originalModelDifferences: Array<{ case: string }>;
    modelDifferences: Array<{ case: string }>;
  };
};
const ledger = readJson("docs/performance/diagram-engine-e2-admission-ledger.json") as Ledger;
const original = new Set(receipt.boundaryEvidence.originalModelDifferences.map((row) => row.case));
const current = new Set(receipt.boundaryEvidence.modelDifferences.map((row) => row.case));
const cases = new Map([...corpus.cases, ...corpus.boundaryCases].map((row) => [row.id, row]));
const refreshedBrandRails = [
  "e2-boundary-architecture-brand-rail-71",
  "e2-boundary-dataflow-brand-rail-71",
  "e2-boundary-lifecycle-brand-rail-71",
  "e2-boundary-workflow-brand-rail-71",
  "e2-boundary-workflow-brand-rail-73",
];

function expectNodeTextInkFits(record: LedgerRecord) {
  const geometry = record.engine.geometry as {
    nodes: Array<{ id: string; bounds: { x: number; y: number; width: number; height: number } }>;
    labels: Array<{ id?: string; targetId: string; glyphs: Array<{ ink: { x: number; y: number; width: number; height: number } }> }>;
  };
  const nodes = new Map(geometry.nodes.map((node) => [node.id, node]));
  let paintedGlyphs = 0;
  for (const label of geometry.labels) {
    if (!label.id?.startsWith(`node:${label.targetId}:`)) continue;
    const node = nodes.get(label.targetId);
    expect(node, `${record.id}: ${label.id} target node`).toBeDefined();
    const right = node!.bounds.x + node!.bounds.width;
    const bottom = node!.bounds.y + node!.bounds.height;
    for (const glyph of label.glyphs) {
      if (glyph.ink.width <= 0 || glyph.ink.height <= 0) continue;
      paintedGlyphs += 1;
      expect(glyph.ink.x, `${record.id}: ${label.id} ink left`).toBeGreaterThanOrEqual(node!.bounds.x);
      expect(glyph.ink.y, `${record.id}: ${label.id} ink top`).toBeGreaterThanOrEqual(node!.bounds.y);
      expect(glyph.ink.x + glyph.ink.width, `${record.id}: ${label.id} ink right`).toBeLessThanOrEqual(right);
      expect(glyph.ink.y + glyph.ink.height, `${record.id}: ${label.id} ink bottom`).toBeLessThanOrEqual(bottom);
    }
  }
  expect(paintedGlyphs, `${record.id}: positioned glyph ink`).toBeGreaterThan(0);
}

describe("E2 admission disposition ledger", () => {
  it("covers the complete original/current union without duplicate or hidden cases", () => {
    expect(ledger.schemaVersion).toBe(1);
    expect(original.size).toBe(41);
    const ids = new Set(ledger.records.map((row) => row.id));
    expect(ids.size).toBe(ledger.records.length);
    expect(ledger.counts.unionCases).toBe(ledger.records.length);
    expect(ledger.counts.originalModelDifferenceCases).toBe(original.size);
    for (const id of new Set([...original, ...current])) expect(ids.has(id), id).toBe(true);
    expect(ledger.records.filter((row) => row.currentMismatch)).toHaveLength(ledger.counts.currentMismatches);
  });

  it("preserves pinned oracle verdicts and exact reproducible comparison input", () => {
    for (const row of ledger.records) {
      const source = cases.get(row.id);
      expect(source, row.id).toBeDefined();
      expect(row.oracle.ok, row.id).toBe(source!.oracle.ok);
      expect(row.source.inputJson, row.id).toBe(source!.geometryComparison?.inputJson ?? source!.inputJson);
      expect(createHash("sha256").update(row.source.inputJson).digest("hex"), row.id).toBe(row.source.inputSha256);
      expect(JSON.parse(row.source.inputJson), row.id).toEqual(row.source.spec);
      expect(row.originalS3ModelDifference, row.id).toBe(original.has(row.id));
      expect(row.currentMismatch, row.id).toBe(row.oracle.ok !== row.engine.accepted);
      expect(row.engine.geometry, row.id).not.toBeNull();
      expect(Array.isArray(row.engine.diagnostics), row.id).toBe(true);
    }
  });

  it("contains only resolved, evidenced dispositions rather than a blanket waiver", () => {
    for (const row of ledger.records) {
      expect(row.disposition.status, row.id).not.toMatch(/pending|unresolved|measured-geometry-disagreement|todo/i);
      expect(row.disposition.reason.length, row.id).toBeGreaterThan(40);
      expect(row.pinnedSourceRefs.length, row.id).toBeGreaterThan(0);
      expect(row.numericGeometryEvidence, row.id).toBeTruthy();
      if (row.disposition.status.startsWith("fixed-")) expect(row.engine.accepted, row.id).toBe(row.oracle.ok);
    }
  });

  it("refreshes exactly five brand-rail cases from current Noto ink while retaining the old snapshot", () => {
    expect(ledger.sourceScope.kind).toBe("mixed-per-record-engine-snapshots");
    expect([...ledger.sourceScope.refreshedCaseIds].sort()).toEqual([...refreshedBrandRails].sort());
    expect(ledger.sourceScope.refreshedSourceCommit).toBe(ledger.sourceCommit);
    expect(ledger.sourceScope.refreshedSdkTree).toBe(ledger.sdkTree);

    const refreshed = ledger.records.filter((row) => refreshedBrandRails.includes(row.id));
    expect(refreshed).toHaveLength(5);
    for (const row of refreshed) {
      expect(row.oracle.ok, row.id).toBe(false);
      expect(row.originalS3ModelDifference, row.id).toBe(true);
      expect(row.engine.accepted, row.id).toBe(true);
      expect(row.currentMismatch, row.id).toBe(true);
      expect(row.disposition.status, row.id).toBe("intentional-noto-ink-fit-model-difference");
      expect(row.disposition.reason, row.id).toMatch(/0px overflow/);
      expect(row.engineSourceCommit, row.id).toBe(ledger.sourceScope.refreshedSourceCommit);
      expect(row.sdkTree, row.id).toBe(ledger.sourceScope.refreshedSdkTree);
      expect(row.historicalEvidence?.engine.accepted, row.id).toBe(false);
      expect(row.historicalEvidence?.disposition.status, row.id).toBe("fixed-by-role-budget");
      expect(row.historicalEvidence?.numericGeometryEvidence, row.id).toBeTruthy();
      expect(row.corpusCaseRef, row.id).toContain(row.id);
      expect(row.source.origin, row.id).toBeDefined();
      expect(row.boundary, row.id).toBeDefined();
      expect(row.geometryRule, row.id).toBe(`${row.id.split("-brand-rail-")[0].replace(/^e2-boundary-/, "")}/geometry-label-fit`);
      expect(row.pinnedSourceRefs.length, row.id).toBeGreaterThan(0);
      expectNodeTextInkFits(row);
    }

    const preserved = ledger.records.filter((row) => !refreshedBrandRails.includes(row.id));
    expect(preserved).toHaveLength(39);
    for (const row of preserved) {
      expect(row.engineEvidenceScope, row.id).toBe("preserved-source-stamped-model-record");
      expect(row.engineSourceCommit, row.id).toBe(ledger.sourceScope.preservedSourceCommit);
      expect(row.sdkTree, row.id).toBe(ledger.sourceScope.preservedSdkTree);
    }

    const mismatchCount = ledger.records.filter((row) => row.currentMismatch).length;
    expect(ledger.counts.currentMismatches).toBe(mismatchCount);
    expect(ledger.counts.currentAgreementsWithinUnion).toBe(ledger.records.length - mismatchCount);
    expect(ledger.counts.unionCases).toBe(ledger.records.length);
    const statusCounts = Object.fromEntries([...new Set(ledger.records.map((row) => row.disposition.status))]
      .sort()
      .map((status) => [status, ledger.records.filter((row) => row.disposition.status === status).length]));
    expect(ledger.counts.statusCounts).toEqual(statusCounts);
    const fixedStatusCounts = Object.fromEntries(Object.entries(statusCounts).filter(([status]) => status.startsWith("fixed-")));
    expect(ledger.counts.fixedStatusCounts).toEqual(fixedStatusCounts);
    expect(ledger.counts.fixedCases).toBe(Object.values(fixedStatusCounts).reduce((total, count) => total + count, 0));
  });
});
