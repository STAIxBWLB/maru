import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { GATE_ADJUST_AUDIT, generatedGateCases } from "./diagram-engine-e2-gates.mjs";
import { seedFor } from "./diagram-engine-e1-cases.mjs";

type RecordedCase = {
  id: string;
  inputJson: string;
  boundary: { expectedOracleAccepted?: boolean; gateOnNegativeRefs?: string[] };
  oracle: { ok: boolean };
  validityOracle?: { ok: boolean };
};
const corpus = JSON.parse(readFileSync("src-tauri/crates/maru-diagram-engine/testdata/parity.json", "utf8")) as {
  gateAdjustmentAudit: unknown[];
  cases: RecordedCase[];
  boundaryCases: RecordedCase[];
};
const recorded = new Map([...corpus.cases, ...corpus.boundaryCases].map((item) => [item.id, item]));

it("binds every recorded gate and adjustment row to the explicitly reviewed inventory", () => {
  expect(GATE_ADJUST_AUDIT).toHaveLength(132);
  expect(new Set(GATE_ADJUST_AUDIT.map((row) => row.key)).size).toBe(132);
  expect(corpus.gateAdjustmentAudit).toEqual(GATE_ADJUST_AUDIT);
  for (const row of GATE_ADJUST_AUDIT) {
    expect(row.gate.length).toBeGreaterThan(0);
    for (const id of row.controlIds) expect(recorded.has(id), row.key).toBe(true);
  }
});

it("retains the generated control inputs, hypotheses and actual oracle verdicts without false negative references", () => {
  const controls = generatedGateCases(seedFor);
  expect(new Set(controls.map((item) => item.id)).size).toBe(controls.length);
  for (const control of controls) {
    const actual = recorded.get(control.id);
    expect(actual, control.id).toBeDefined();
    expect(JSON.parse(actual!.inputJson), control.id).toEqual(control.spec);
    expect(actual!.boundary, control.id).toEqual(control.boundary);
    expect((actual!.validityOracle ?? actual!.oracle).ok, control.id).toBe(control.boundary.expectedOracleAccepted);
    for (const ref of control.boundary.gateOnNegativeRefs) {
      const active = recorded.get(ref);
      expect(active, ref).toBeDefined();
      expect((active!.validityOracle ?? active!.oracle).ok, ref).toBe(false);
    }
  }
});
