import { describe, expect, it } from "vitest";

import { t } from "../i18n";
import {
  PATTERN_LIST,
  REPORT_PATTERN_LIST,
  getPattern,
  patternsForFamily,
  type PatternDefinition,
} from "./patterns";
import { viewProjectionHash } from "./convert";
import { TABLE_PATTERN_ID, type PatternViewBounds } from "./reportTypes";
import { TEMPLATE_LIST } from "./templates";

const BOUNDS: PatternViewBounds = { x: 100, y: 80, w: 480, h: 320 };
const enT = (key: string) => t("en", key);

const REPORT_PATTERN_IDS = [
  TABLE_PATTERN_ID,
  "report.irregular-table",
  "report.pdm",
  "report.raci",
  "report.checklist",
  "report.curriculum-matrix",
  "report.before-after",
  "report.comparison",
  "report.strategy-cascade",
  "report.problem-tree",
  "report.objective-tree",
  "report.budget",
  "report.timeline",
  "report.process",
  "report.stakeholder",
  "report.kpi-scorecard",
];

describe("pattern registry", () => {
  it("registers all report patterns plus the 11 legacy templates", () => {
    for (const id of REPORT_PATTERN_IDS) {
      expect(getPattern(id), id).toBeDefined();
    }
    expect(REPORT_PATTERN_LIST.map((p) => p.id)).toEqual(REPORT_PATTERN_IDS);
    for (const tpl of TEMPLATE_LIST) {
      const pattern = getPattern(tpl.id);
      expect(pattern, tpl.id).toBeDefined();
      expect(pattern?.freeform).toBe(true);
    }
    expect(PATTERN_LIST).toHaveLength(REPORT_PATTERN_IDS.length + TEMPLATE_LIST.length);
  });

  it("has unique ids across the whole registry", () => {
    const ids = PATTERN_LIST.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every pattern has ko+en label and description", () => {
    for (const pattern of PATTERN_LIST) {
      for (const key of [pattern.labelKey, pattern.descriptionKey]) {
        expect(t("ko", key), `ko ${key}`).not.toBe(key);
        expect(t("en", key), `en ${key}`).not.toBe(key);
      }
    }
  });

  it("compatibleFamilies always includes the pattern's own family", () => {
    for (const pattern of REPORT_PATTERN_LIST) {
      expect(pattern.compatibleFamilies).toContain(pattern.family);
    }
    // problem tree and objective tree share the hierarchy family (same-family switch)
    expect(getPattern("report.problem-tree")?.family).toBe("hierarchy");
    expect(getPattern("report.objective-tree")?.family).toBe("hierarchy");
  });

  it("patternsForFamily groups sensibly", () => {
    expect(patternsForFamily("matrix").map((p) => p.id)).toContain("report.pdm");
    expect(patternsForFamily("hierarchy").map((p) => p.id)).toEqual([
      "report.strategy-cascade",
      "report.problem-tree",
      "report.objective-tree",
      "report.budget",
    ]);
    expect(patternsForFamily("timeline").map((p) => p.id)).toEqual(["report.timeline"]);
    expect(patternsForFamily("flow").map((p) => p.id)).toEqual(["report.process"]);
    expect(patternsForFamily("network").map((p) => p.id)).toEqual(["report.stakeholder"]);
    expect(patternsForFamily("scorecard").map((p) => p.id)).toEqual(["report.kpi-scorecard"]);
  });

  function datasetFor(pattern: PatternDefinition) {
    if (!pattern.createDataset) throw new Error(`${pattern.id} has no createDataset`);
    return pattern.createDataset({ t: enT });
  }

  it("report-pattern buildView is deterministic (same input → same output)", () => {
    for (const pattern of REPORT_PATTERN_LIST) {
      const dataset = datasetFor(pattern);
      expect(dataset.kind, pattern.id).toBe(pattern.family);
      const first = pattern.buildView({ dataset, bounds: BOUNDS, t: enT });
      const second = pattern.buildView({ dataset, bounds: BOUNDS, t: enT });
      expect(second, pattern.id).toEqual(first);
      expect(first.nodes.length, pattern.id).toBeGreaterThan(0);
    }
  });

  it("buildView lays members out inside the view bounds", () => {
    for (const pattern of REPORT_PATTERN_LIST) {
      if (pattern.family === "matrix") continue; // table node fills bounds exactly
      const dataset = datasetFor(pattern);
      const { nodes } = pattern.buildView({ dataset, bounds: BOUNDS, t: enT });
      for (const node of nodes) {
        expect(node.x, `${pattern.id} x`).toBeGreaterThanOrEqual(BOUNDS.x - 1);
        expect(node.y, `${pattern.id} y`).toBeGreaterThanOrEqual(BOUNDS.y - 1);
        expect(node.x + node.w, `${pattern.id} right`).toBeLessThanOrEqual(
          BOUNDS.x + BOUNDS.w + 1,
        );
        expect(node.y + node.h, `${pattern.id} bottom`).toBeLessThanOrEqual(
          BOUNDS.y + BOUNDS.h + 1,
        );
      }
    }
  });

  it("projectionHash changes when the dataset changes", () => {
    const pattern = getPattern("report.timeline")!;
    const dataset = datasetFor(pattern);
    const before = viewProjectionHash(pattern.id, dataset, BOUNDS);
    if (dataset.kind !== "timeline") throw new Error("unexpected kind");
    const changed = {
      ...dataset,
      items: dataset.items.map((item, i) =>
        i === 0 ? { ...item, label: `${item.label} (revised)` } : item,
      ),
    };
    const after = viewProjectionHash(pattern.id, changed, BOUNDS);
    expect(after).not.toBe(before);
  });

  it("matrix-family patterns project a single linked table node", () => {
    for (const pattern of patternsForFamily("matrix")) {
      const dataset = datasetFor(pattern);
      const { nodes, edges } = pattern.buildView({ dataset, bounds: BOUNDS, t: enT });
      expect(nodes, pattern.id).toHaveLength(1);
      expect(nodes[0]?.kind).toBe("table");
      expect(nodes[0]?.meta?.memberId).toBe(dataset.id);
      expect(edges).toHaveLength(0);
    }
  });

  it("freeform template entries wrap the legacy builders", () => {
    const swot = getPattern("swot")!;
    const dataset = datasetFor(getPattern(TABLE_PATTERN_ID)!);
    const out = swot.buildView({ dataset, bounds: BOUNDS, t: enT });
    expect(out.nodes.length).toBeGreaterThan(0);
    expect(swot.compatibleFamilies).toEqual([]);
  });
});
