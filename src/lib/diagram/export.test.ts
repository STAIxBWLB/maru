import { describe, expect, it } from "vitest";

import { ARCHIFY_STATIC_TYPES, supportsArchifyStaticExport, canonicalSemanticExportInput, exportJson, suggestedFileName } from "./export";
import { DIAGRAM_SCHEMA_VERSION, createEmptyDoc } from "./types";
import { archifySpecToDataset } from "./archifyCodec";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";

describe("export helpers", () => {
  it("suggestedFileName slugifies the docTitle and appends ext", () => {
    const doc = createEmptyDoc("doc", 1);
    doc.docTitle = "  Project / Plan v2 !! ";
    expect(suggestedFileName(doc, "png")).toMatch(/^Project-Plan-v2\.png$/);
  });

  it("suggestedFileName falls back when title is empty", () => {
    const doc = createEmptyDoc("doc", 1);
    expect(suggestedFileName(doc, "svg")).toBe("diagram.svg");
  });

  it("exportJson returns a JSON blob with the doc body", async () => {
    const doc = createEmptyDoc("doc", 1);
    doc.docTitle = "Hi";
    const result = exportJson(doc);
    expect(result.mimeType).toBe("application/json");
    const text = await result.blob.text();
    const parsed = JSON.parse(text);
    expect(parsed.docTitle).toBe("Hi");
    expect(parsed.v).toBe(DIAGRAM_SCHEMA_VERSION);
  });
});

describe("canonical semantic export input", () => {
  it("limits static rendering to the pinned engine's five diagram types", () => {
    expect(ARCHIFY_STATIC_TYPES).toEqual(["architecture", "workflow", "sequence", "dataflow", "lifecycle"]);
    expect(supportsArchifyStaticExport("floorplan")).toBe(false);
  });
  it("serializes only the stored spec, preserving Korean text and excluding canvas/viewer provenance", () => {
    const doc = createEmptyDoc("doc", 1);
    const spec = { ...SEMANTIC_FIXTURES.architecture, meta: { title: "한글 구조", output: "diagram.html" } };
    const { dataset } = archifySpecToDataset("architecture", spec);
    doc.datasets = [dataset];
    const withPrivateState = { ...doc, docTitle: "Editor title", camera: { x: 800, zoom: 5 }, selection: ["selected"], privatePath: "/private/fixture-only", diagnostics: ["private note"] };
    const input = canonicalSemanticExportInput(withPrivateState, dataset.id);
    expect(JSON.parse(input.candidateJson)).toEqual(dataset.spec);
    expect(input.candidateJson).toContain("한글 구조");
    expect(input.candidateJson).not.toMatch(/Editor title|private note|fixture-only|selected|camera/);
    expect(canonicalSemanticExportInput(doc, dataset.id)).toEqual(input);
  });

  it("requires an explicit semantic choice when several datasets exist", () => {
    const doc = createEmptyDoc("doc", 1);
    const first = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture).dataset;
    const second = archifySpecToDataset("sequence", SEMANTIC_FIXTURES.sequence).dataset;
    doc.datasets = [first, second];
    expect(() => canonicalSemanticExportInput(doc)).toThrow(/select/i);
    expect(canonicalSemanticExportInput(doc, second.id).diagramType).toBe("sequence");
  });

  it("refuses missing, oversized and unsafe-path specs without changing the document", () => {
    const doc = createEmptyDoc("doc", 1);
    expect(() => canonicalSemanticExportInput(doc)).toThrow(/select/i);
    const dataset = archifySpecToDataset("architecture", SEMANTIC_FIXTURES.architecture).dataset;
    doc.datasets = [dataset];
    dataset.spec = { ...dataset.spec, meta: { title: "Unsafe", output: "../escape.html" } };
    const before = JSON.stringify(doc);
    expect(() => canonicalSemanticExportInput(doc, dataset.id)).toThrow(/repair or regenerate/);
    expect(JSON.stringify(doc)).toBe(before);
    dataset.spec = { ...dataset.spec, meta: { title: "x".repeat(512 * 1024), output: "safe.html" } };
    expect(() => canonicalSemanticExportInput(doc, dataset.id)).toThrow(/specBudget/);
  });
});
