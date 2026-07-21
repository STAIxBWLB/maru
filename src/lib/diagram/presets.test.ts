import { describe, expect, it } from "vitest";

import { serializePreset, validatePreset, type PatternPresetV1 } from "./presets";
import { matrixFromRowsCols } from "./reportTypes";

function validPreset(): PatternPresetV1 {
  return {
    v: 1,
    id: "preset-1",
    name: "My preset",
    patternId: "table",
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
  };
}

describe("validatePreset", () => {
  it("accepts a minimal valid preset", () => {
    const result = validatePreset(validPreset());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.preset.patternId).toBe("table");
  });

  it("accepts theme, flat style, and a matrix dataset seed", () => {
    const result = validatePreset({
      ...validPreset(),
      theme: "mineral",
      style: { bg: "#fff", bw: 1.5, striped: true },
      datasetSeed: matrixFromRowsCols(2, 2, { name: "seed" }),
    });
    expect(result.ok).toBe(true);
  });

  it("accepts non-matrix dataset seeds with the right shape", () => {
    const result = validatePreset({
      ...validPreset(),
      patternId: "report.problem-tree",
      datasetSeed: {
        id: "ds-1",
        kind: "hierarchy",
        name: "tree",
        nodes: [
          { id: "n1", parentId: null, label: "Root" },
          { id: "n2", parentId: "n1", label: "Child", fields: { note: "x" } },
        ],
      },
    });
    expect(result.ok).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const bad of [null, 42, "preset", [1, 2], undefined]) {
      const result = validatePreset(bad);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects wrong versions", () => {
    for (const v of [0, 2, "1", undefined]) {
      const result = validatePreset({ ...validPreset(), v });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain("preset.v");
    }
  });

  it("rejects unknown pattern ids", () => {
    const result = validatePreset({ ...validPreset(), patternId: "no.such.pattern" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("unknown pattern");
  });

  it("accepts template (freeform) pattern ids — presets can store them", () => {
    const result = validatePreset({ ...validPreset(), patternId: "swot" });
    expect(result.ok).toBe(true);
  });

  it("rejects non-primitive style values (no nested objects/arrays/null)", () => {
    for (const style of [
      { nested: { bg: "#fff" } },
      { list: [1, 2] },
      { nothing: null },
    ]) {
      const result = validatePreset({ ...validPreset(), style });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.errors.join()).toContain("preset.style");
    }
  });

  it("rejects invalid matrix seeds (span-invariant violations)", () => {
    const broken = matrixFromRowsCols(2, 2);
    // delete one cell → uncovered position
    const firstCellId = Object.keys(broken.cells)[0]!;
    delete broken.cells[firstCellId];
    const result = validatePreset({ ...validPreset(), datasetSeed: broken });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("datasetSeed");
  });

  it("rejects malformed non-matrix seeds", () => {
    const result = validatePreset({
      ...validPreset(),
      patternId: "report.problem-tree",
      datasetSeed: { id: "ds", kind: "hierarchy", name: "t", nodes: [{ label: "no id" }] },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects unknown dataset kinds", () => {
    const result = validatePreset({
      ...validPreset(),
      datasetSeed: { id: "ds", kind: "spreadsheet", name: "t" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join()).toContain("kind");
  });

  it("rejects missing timestamps and empty names", () => {
    const result = validatePreset({ ...validPreset(), createdAt: "now", name: "  " });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join()).toContain("createdAt");
      expect(result.errors.join()).toContain("name");
    }
  });
});

describe("serializePreset", () => {
  it("round-trips through JSON", () => {
    const preset = validPreset();
    const parsed = JSON.parse(serializePreset(preset)) as unknown;
    expect(parsed).toEqual(preset);
    const result = validatePreset(parsed);
    expect(result.ok).toBe(true);
  });
});
