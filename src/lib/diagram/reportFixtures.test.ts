import { describe, expect, it } from "vitest";

import {
  reportFixtures,
  rowWidth,
  type ReportTableFixture,
  type ReportTableKind,
} from "./__fixtures__/reports";

const EXPECTED_KINDS: ReportTableKind[] = [
  "pdm",
  "kpi-scorecard",
  "budget",
  "schedule",
  "raci",
  "strategy-cascade",
];

/**
 * Simulate grid placement: cells flow left-to-right, skipping cells already
 * covered by a rowSpan from above. Asserts no overlap, no column overflow,
 * and full occupancy (every grid cell covered exactly once).
 */
function expectRectangularGrid(fixture: ReportTableFixture) {
  const cols = fixture.columns.length;
  const occupied = new Set<string>();
  fixture.rows.forEach((row, r) => {
    let c = 0;
    for (const cell of row) {
      const colSpan = cell.colSpan ?? 1;
      const rowSpan = cell.rowSpan ?? 1;
      expect(colSpan, `${fixture.kind} r${r} colSpan`).toBeGreaterThanOrEqual(1);
      expect(rowSpan, `${fixture.kind} r${r} rowSpan`).toBeGreaterThanOrEqual(1);
      while (occupied.has(`${r},${c}`)) c += 1;
      expect(
        c + colSpan,
        `${fixture.kind} r${r} overflows ${cols} columns`,
      ).toBeLessThanOrEqual(cols);
      for (let dr = 0; dr < rowSpan; dr += 1) {
        for (let dc = 0; dc < colSpan; dc += 1) {
          const key = `${r + dr},${c + dc}`;
          expect(occupied.has(key), `${fixture.kind} overlap at ${key}`).toBe(false);
          occupied.add(key);
        }
      }
      c += colSpan;
    }
  });
  // Full occupancy: rows x columns grid is completely covered.
  expect(occupied.size).toBe(fixture.rows.length * cols);
}

describe("report table fixtures", () => {
  it("ships all six report kinds", () => {
    expect(reportFixtures.map((f) => f.kind)).toEqual(EXPECTED_KINDS);
  });

  it("every fixture has a title, columns, and rows", () => {
    for (const fixture of reportFixtures) {
      expect(fixture.title.trim().length).toBeGreaterThan(0);
      expect(fixture.columns.length).toBeGreaterThan(0);
      expect(fixture.rows.length).toBeGreaterThan(0);
      for (const col of fixture.columns) {
        expect(col.trim().length).toBeGreaterThan(0);
      }
    }
  });

  it("rows are rectangular after span expansion (no overlap, full coverage)", () => {
    for (const fixture of reportFixtures) {
      expectRectangularGrid(fixture);
    }
  });

  it("spans are only set when they actually merge cells", () => {
    for (const fixture of reportFixtures) {
      for (const row of fixture.rows) {
        for (const cell of row) {
          if (cell.colSpan !== undefined) expect(cell.colSpan).toBeGreaterThan(1);
          if (cell.rowSpan !== undefined) expect(cell.rowSpan).toBeGreaterThan(1);
        }
      }
    }
  });

  it("rowWidth counts colSpan coverage", () => {
    const row = [{ text: "a" }, { text: "b", colSpan: 3 }, { text: "c" }];
    expect(rowWidth(row)).toBe(5);
  });

  it("schedule fixture spans 24 periods", () => {
    const schedule = reportFixtures.find((f) => f.kind === "schedule");
    expect(schedule).toBeDefined();
    expect(schedule!.columns).toHaveLength(2 + 24);
    expect(schedule!.columns[2]).toBe("M1");
    expect(schedule!.columns[25]).toBe("M24");
  });

  it("pdm fixture uses merged indicator cells", () => {
    const pdm = reportFixtures.find((f) => f.kind === "pdm");
    const merged = pdm!.rows.flat().filter((c) => (c.rowSpan ?? 1) > 1);
    expect(merged.length).toBeGreaterThan(0);
  });
});
