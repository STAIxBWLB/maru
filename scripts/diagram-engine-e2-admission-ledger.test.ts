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
  id: string;
  originalS3ModelDifference: boolean;
  currentMismatch: boolean;
  source: { inputJson: string; inputSha256: string; spec: unknown };
  oracle: { ok: boolean };
  engine: { accepted: boolean; geometry: unknown; diagnostics: unknown[] };
  disposition: { status: string; reason: string };
  pinnedSourceRefs: unknown[];
  numericGeometryEvidence: unknown;
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
const ledger = readJson("docs/performance/diagram-engine-e2-admission-ledger.json") as {
  schemaVersion: number;
  counts: { unionCases: number; originalModelDifferenceCases: number; currentMismatches: number };
  records: LedgerRecord[];
};
const original = new Set(receipt.boundaryEvidence.originalModelDifferences.map((row) => row.case));
const current = new Set(receipt.boundaryEvidence.modelDifferences.map((row) => row.case));
const cases = new Map([...corpus.cases, ...corpus.boundaryCases].map((row) => [row.id, row]));

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
});
