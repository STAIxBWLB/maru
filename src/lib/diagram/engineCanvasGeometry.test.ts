import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Diagnostic,
  EngineReceipt,
  GeometryDocument,
  GeometryReport,
  LayoutRequest,
} from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { archifySpecToDataset } from "./archifyCodec";
import {
  canvasDisplayNode,
  canvasGeometryDatasetId,
  canvasGeometryOf,
  canvasLabelsFor,
  canvasNudgePins,
  canvasGeometryState,
  matchingCanvasGeometry,
  resetCanvasGeometry,
  routePathOf,
  syncCanvasGeometry,
  _resetCanvasGeometryForTests,
  type CanvasGeometry,
} from "./engineCanvasGeometry";
import { canonicalSemanticExportInput } from "./export";
import type { EngineDiagramType, SemanticSpecDataset } from "./reportTypes";
import { projectSemanticDocument } from "./semantic";
import { createEmptyDoc, type DiagramDoc, type DiagramNode } from "./types";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";

const TYPES: EngineDiagramType[] = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];
/** One mixed Korean/English label, and the two lines the engine wraps it into. */
const MIXED_LABEL = "주문 접수 Order intake";
const MIXED_LINES = "주문 접수\nOrder intake";
const ENTITY_FIELD: Record<EngineDiagramType, string> = {
  architecture: "components",
  workflow: "nodes",
  sequence: "participants",
  dataflow: "nodes",
  lifecycle: "states",
};

/** The engine-valid fixture with one Korean/English label pair per dataset. */
function mixedSpec(type: EngineDiagramType): Record<string, unknown> {
  const spec = structuredClone(SEMANTIC_FIXTURES[type]);
  const entries = spec[ENTITY_FIELD[type]] as Array<Record<string, unknown>>;
  entries[0]!.label = MIXED_LABEL;
  if (entries[1]) entries[1]!.sublabel = "검토 Review";
  return spec;
}

function datasetFor(type: EngineDiagramType): SemanticSpecDataset {
  const { dataset } = archifySpecToDataset(type, mixedSpec(type), { id: `ds-${type}` });
  return dataset;
}

function docFor(type: EngineDiagramType): { doc: DiagramDoc; dataset: SemanticSpecDataset } {
  const dataset = datasetFor(type);
  return { doc: projectSemanticDocument(dataset).doc, dataset };
}

function receipt(inputSpecSha256 = "0".repeat(64)): EngineReceipt {
  return {
    schemaVersion: 1,
    inputSpecSha256,
    engine: { id: "maru-diagram-engine", version: "0.1.0", revision: "canvas-geometry-test" },
    gates: {
      schema: { status: "passed", scope: "test-fixture" },
      artifact: { status: "not-run", scope: "layout-only" },
      browser: { status: "not-run", scope: "non-browser-rasterization" },
      visualReview: { status: "not-run", scope: "manual" },
    },
    readback: { status: "not-run", scope: "saved-file-byte-comparison" },
  };
}

function selectionDiagnostic(): Diagnostic {
  return {
    code: "test.labelTooWide",
    path: "/nodes/0/label",
    rule: "label-fit",
    message: "The label does not fit the node box",
    fix: "shorten the label or widen the node",
  };
}

/**
 * A stand-in scene in the engine's own fixed-point units, with the label breaks
 * the engine would wrap: the canvas must copy them, never re-measure the text.
 */
function sceneFor(request: LayoutRequest): GeometryDocument {
  const spec = JSON.parse(request.specJson) as Record<string, unknown>;
  const type = spec.diagram_type as EngineDiagramType;
  const entities = spec[ENTITY_FIELD[type]] as Array<{ id: string; label: string; sublabel?: string }>;
  const relations = (spec.edges ?? spec.connections ?? spec.messages ?? spec.flows ?? spec.transitions ?? []) as Array<{
    id?: string;
    from: string;
    to: string;
    label?: string;
  }>;
  const nodes = entities.map((entry, index) => ({
    id: entry.id,
    bounds: { x: 64 * (40 + index * 200), y: 64 * (40 + (index % 2) * 120), width: 64 * 180, height: 64 * 72 },
    positionSource: "automatic" as const,
  }));
  const labels = entities.flatMap((entry, index) => {
    const base = [
      {
        id: `node:${entry.id}:label`,
        targetId: entry.id,
        text: entry.label === MIXED_LABEL ? MIXED_LINES : entry.label,
        bounds: { x: 64 * 58, y: 64 * (48 + (index % 2) * 120), width: 64 * 140, height: 64 * 34 },
        font: { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 700, unitsPerEm: 1000, license: "OFL-1.1" },
        fontSize: 13 * 64,
        glyphs: [],
      },
    ];
    if (!entry.sublabel) return base;
    return [
      ...base,
      {
        id: `node:${entry.id}:sublabel`,
        targetId: entry.id,
        text: entry.sublabel,
        bounds: { x: 64 * 58, y: 64 * (80 + (index % 2) * 120), width: 64 * 120, height: 64 * 16 },
        font: { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 400, unitsPerEm: 1000, license: "OFL-1.1" },
        fontSize: 11 * 64,
        glyphs: [],
      },
    ];
  });
  const routes = relations.map((relation, index) => ({
    id: relation.id ?? `edge-${index}`,
    from: relation.from,
    to: relation.to,
    points: [
      { x: 64 * (220 + index), y: 64 * 60 },
      { x: 64 * (260 + index), y: 64 * 60 },
      { x: 64 * (260 + index), y: 64 * 120 },
    ],
    variant: null,
    role: null,
    width: null,
  }));
  const edgeLabels = relations
    .filter((relation) => typeof relation.label === "string")
    .map((relation, index) => ({
      id: `edge:${relation.id ?? `edge-${index}`}:label`,
      targetId: relation.id ?? `edge-${index}`,
      text: relation.label!,
      bounds: { x: 64 * 230, y: 64 * (70 + index), width: 64 * 40, height: 64 * 14 },
      font: { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 400, unitsPerEm: 1000, license: "OFL-1.1" },
      fontSize: 10 * 64,
      glyphs: [],
    }));
  return {
    nodes,
    containers: [],
    routes,
    labels: [...labels, ...edgeLabels],
    legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
    page: { bounds: { x: 0, y: 0, width: 64 * 1200, height: 64 * 800 }, contentOffset: { x: 0, y: 64 * 64 } },
  };
}

interface FakeEngine {
  requests: LayoutRequest[];
  load: () => Promise<{ layout: (input: LayoutRequest) => GeometryReport }>;
}

function fakeEngine(options: { ok?: boolean; fail?: boolean } = {}): FakeEngine {
  const requests: LayoutRequest[] = [];
  return {
    requests,
    load: async () => ({
      layout: (input) => {
        requests.push(input);
        if (options.fail) throw new Error("The layout module is unavailable; reload Maru and retry.");
        const geometry = options.ok === false ? null : sceneFor(input);
        return {
          apiVersion: 1,
          ok: options.ok !== false,
          ...(geometry ? { geometry } : {}),
          diagnostics: options.ok === false ? [selectionDiagnostic()] : [],
          receipt: receipt(input.pinSet?.sourceSpecSha256 ?? "0".repeat(64)),
        };
      },
    }),
  };
}

beforeEach(() => {
  vi.stubGlobal("crypto", webcrypto);
  _resetCanvasGeometryForTests();
});
afterEach(() => vi.unstubAllGlobals());

describe("canvas geometry source agreement with the export path", () => {
  it.each(TYPES)("lays out the exact bytes the %s export sends", async (type) => {
    const { doc, dataset } = docFor(type);
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    expect(engine.requests).toHaveLength(1);
    const request = engine.requests[0]!;
    expect(request.specJson).toBe(canonicalSemanticExportInput(doc, dataset.id).candidateJson);
    expect(request.specJson).toContain(MIXED_LABEL);
    expect(request.pinSet?.pins).toEqual([]);
    expect(canvasGeometryState(dataset.id).sourceSpecSha256).toBe(request.pinSet?.sourceSpecSha256);
  });

  it.each(TYPES)("draws the %s report's boxes, label lines and route points in pixels", async (type) => {
    const { doc, dataset } = docFor(type);
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    const geometry = canvasGeometryState(dataset.id).geometry!;
    const scene = sceneFor(engine.requests[0]!);
    expect(geometry.boxes.size).toBe(scene.nodes.length);
    for (const node of scene.nodes) {
      const box = geometry.boxes.get(dataset.idMap[node.id] ?? node.id)!;
      expect(box).toMatchObject({
        sourceId: node.id,
        role: "node",
        x: node.bounds.x / 64,
        y: node.bounds.y / 64,
        w: node.bounds.width / 64,
        h: node.bounds.height / 64,
      });
    }
    const firstId = (scene.nodes[0] as { id: string }).id;
    const canvasNodeId = dataset.idMap[firstId] ?? firstId;
    const label = geometry.labels.get(canvasNodeId)!.find((item) => item.role === "label")!;
    expect(label.lines).toEqual(["주문 접수", "Order intake"]);
    expect(label.fontSize).toBe(13);
    expect(label.weight).toBe(700);
    expect(geometry.routes.size).toBe(scene.routes.length);
    const route = [...geometry.routes.values()][0]!;
    expect(route.points).toEqual([
      { x: 220, y: 60 },
      { x: 260, y: 60 },
      { x: 260, y: 120 },
    ]);
    expect(routePathOf(route)).toBe("M 220 60 L 260 60 L 260 120");
    expect(geometry.page).toEqual({ x: 0, y: 0, w: 1200, h: 800 });
  });

  it("maps a lane container onto the projected canvas container id", () => {
    const { doc, dataset } = docFor("workflow");
    const report: GeometryReport = {
      apiVersion: 1,
      ok: true,
      geometry: {
        nodes: [],
        containers: [{ id: "lane:author", kind: "lane", bounds: { x: 0, y: 0, width: 64 * 100, height: 64 * 50 } }],
        routes: [],
        labels: [
          {
            id: "container:lane:author:label",
            targetId: "lane:author",
            text: "Author",
            bounds: { x: 0, y: 0, width: 64 * 40, height: 64 * 12 },
            font: { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 700, unitsPerEm: 1000, license: "OFL-1.1" },
            fontSize: 12 * 64,
            glyphs: [],
          },
        ],
        legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
        page: { bounds: { x: 0, y: 0, width: 64 * 100, height: 64 * 50 } },
      },
      diagnostics: [],
      receipt: receipt(),
    };
    const geometry = canvasGeometryOf(report, doc, dataset)!;
    const container = geometry.boxes.get(`${dataset.id}:lane:author`)!;
    expect(container.role).toBe("container");
    expect(geometry.labels.get(`${dataset.id}:lane:author`)![0]!.role).toBe("label");
  });

  it("maps an id-less relation onto the edge the projection mints for it", () => {
    // A legacy document keeps relations without ids: the projection names them
    // `<datasetId>-e<index>` while the engine reports `<role>:<index>`.
    const base = datasetFor("workflow");
    const spec = structuredClone(base.spec);
    delete (spec.edges as Array<Record<string, unknown>>)[0]!.id;
    const legacy: SemanticSpecDataset = { ...base, id: "ds-legacy", spec, idMap: {} };
    const doc = projectSemanticDocument(legacy).doc;
    expect(doc.edges[0]!.id).toBe("ds-legacy-e0");

    const font = { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 400, unitsPerEm: 1000, license: "OFL-1.1" };
    const report: GeometryReport = {
      apiVersion: 1,
      ok: true,
      geometry: {
        nodes: [],
        containers: [],
        routes: [
          { id: "edge:0", from: "draft", to: "review", points: [{ x: 64 * 10, y: 64 * 20 }], variant: null, role: null, width: null },
          // No projected edge answers this ordinal, so it keeps the reported id.
          { id: "edge:7", from: "draft", to: "review", points: [{ x: 64 * 30, y: 64 * 40 }], variant: null, role: null, width: null },
        ],
        labels: [
          {
            id: "edge:edge:0:label",
            targetId: "edge:0",
            text: "approve",
            bounds: { x: 64 * 10, y: 64 * 20, width: 64 * 40, height: 64 * 14 },
            font,
            fontSize: 10 * 64,
            glyphs: [],
          },
        ],
        legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
        page: { bounds: { x: 0, y: 0, width: 64 * 100, height: 64 * 100 } },
      },
      diagnostics: [],
      receipt: receipt(),
    };
    const geometry = canvasGeometryOf(report, doc, legacy)!;
    // The canvas draws this edge, so its route and label must reach it rather
    // than falling back to the legacy router.
    expect(geometry.routes.get("ds-legacy-e0")).toMatchObject({ sourceId: "edge:0" });
    expect(geometry.labels.get("ds-legacy-e0")?.[0]?.lines).toEqual(["approve"]);
    expect(geometry.routes.has("edge:0")).toBe(false);
    expect(geometry.routes.get("edge:7")).toMatchObject({ sourceId: "edge:7" });
  });

  it.each([1, 2])("maps generated route ids with %s collision suffixes", (depth) => {
    const generatedId = "edge:0" + ":generated".repeat(depth);
    // `<role>:<index>` is also a legal authored id. When one takes the name, the
    // engine renames the id-less relation's route `<role>:<index>:generated`,
    // and only that route belongs to the projection's edge.
    const base = archifySpecToDataset("workflow", {
      schema_version: 2,
      diagram_type: "workflow",
      meta: { title: "Collision", output: "collision.html", locale: "en" },
      lanes: [{ id: "main", label: "Main" }],
      nodes: [
        { id: "a", lane: "main", col: 0, type: "frontend", label: "A" },
        { id: "b", lane: "main", col: 1, type: "backend", label: "B" },
        { id: "c", lane: "main", col: 2, type: "backend", label: "C" },
      ],
      edges: [
        { id: "first", from: "a", to: "b" },
        { id: "edge:0", from: "b", to: "c" },
      ],
    }, { id: "ds-collide" }).dataset;
    const spec = structuredClone(base.spec);
    delete (spec.edges as Array<Record<string, unknown>>)[0]!.id;
    if (depth === 2) (spec.edges as Array<Record<string, unknown>>).push({ id: "edge:0:generated", from: "c", to: "a" });
    const legacy: SemanticSpecDataset = { ...base, spec, idMap: {} };
    const doc = projectSemanticDocument(legacy).doc;
    expect(doc.edges.map((edge) => edge.id)).toEqual(["ds-collide-e0", "edge:0", ...(depth === 2 ? ["edge:0:generated"] : [])]);

    const font = { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 400, unitsPerEm: 1000, license: "OFL-1.1" };
    const report: GeometryReport = {
      apiVersion: 1,
      ok: true,
      geometry: {
        nodes: [],
        containers: [],
        routes: [
          { id: generatedId, from: "a", to: "b", points: [{ x: 64 * 10, y: 64 * 20 }], variant: null, role: null, width: null },
          { id: "edge:0", from: "b", to: "c", points: [{ x: 64 * 30, y: 64 * 40 }], variant: null, role: null, width: null },
        ],
        labels: [
          {
            id: `edge:${generatedId}:label`,
            targetId: generatedId,
            text: "first",
            bounds: { x: 64 * 10, y: 64 * 20, width: 64 * 40, height: 64 * 14 },
            font,
            fontSize: 10 * 64,
            glyphs: [],
          },
          {
            id: "edge:edge:0:label",
            targetId: "edge:0",
            text: "second",
            bounds: { x: 64 * 30, y: 64 * 40, width: 64 * 40, height: 64 * 14 },
            font,
            fontSize: 10 * 64,
            glyphs: [],
          },
        ],
        legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
        page: { bounds: { x: 0, y: 0, width: 64 * 100, height: 64 * 100 } },
      },
      diagnostics: [],
      receipt: receipt(),
    };
    const geometry = canvasGeometryOf(report, doc, legacy)!;
    // Each route reaches the edge it was emitted for: the generated one the
    // projected edge, the authored one the edge that carries that name.
    expect(geometry.routes.get("ds-collide-e0")).toMatchObject({ sourceId: generatedId });
    expect(geometry.routes.get("edge:0")).toMatchObject({ sourceId: "edge:0" });
    expect(geometry.routes.has(generatedId)).toBe(false);
    expect(geometry.labels.get("ds-collide-e0")?.[0]?.lines).toEqual(["first"]);
    expect(geometry.labels.get("edge:0")?.[0]?.lines).toEqual(["second"]);
  });

  it("treats a refused report as no scene at all", () => {
    const { doc, dataset } = docFor("workflow");
    const report: GeometryReport = {
      apiVersion: 1,
      ok: false,
      geometry: sceneFor({ specJson: JSON.stringify(dataset.spec) }),
      diagnostics: [selectionDiagnostic()],
      receipt: receipt(),
    };
    expect(canvasGeometryOf(report, doc, dataset)).toBeNull();
  });
});

describe("canvas geometry store", () => {
  it("lays out once per distinct source and pin key, and never writes the doc", async () => {
    const { doc, dataset } = docFor("workflow");
    const engine = fakeEngine();
    const saved = JSON.stringify(doc);
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    const first = canvasGeometryState(dataset.id).geometry;
    await syncCanvasGeometry({ ...doc, docTitle: "Renamed" }, dataset.id, engine.load);
    expect(engine.requests).toHaveLength(1);
    expect(canvasGeometryState(dataset.id).geometry).toBe(first);
    expect(JSON.stringify(doc)).toBe(saved);

    const edited = structuredClone(doc);
    const editedDataset = edited.datasets![0] as SemanticSpecDataset;
    (editedDataset.spec.nodes as Array<Record<string, unknown>>)[0]!.label = "초안 Draft";
    await syncCanvasGeometry(edited, dataset.id, engine.load);
    expect(engine.requests).toHaveLength(2);
    expect(canvasGeometryState(dataset.id).geometry).not.toBe(first);
  });

  it("pins an authored canvas position and re-requests with it", async () => {
    const { doc, dataset } = docFor("workflow");
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    const target = doc.nodes.find((node) => node.meta?.memberId === `${dataset.id}:m0`)!;
    const pinned: DiagramDoc = {
      ...doc,
      nodes: doc.nodes.map((node) => (node.id === target.id ? { ...node, x: 777, y: 444, meta: { ...node.meta, pinned: true } } : node)),
    };
    await syncCanvasGeometry(pinned, dataset.id, engine.load);
    // The first layout measured the page offset, so the drop lays out once.
    expect(engine.requests).toHaveLength(2);
    const pinnedRequest = engine.requests[1]!;
    expect(pinnedRequest.pinSet?.pins).toEqual([
      { targetId: "draft", targetKind: "node", position: { x: 777 * 64, y: (444 - 64) * 64 } },
    ]);

    // A second drop reuses that measurement: one layout, no probe pass, and the
    // pin is still authored in source space.
    const second = pinned.nodes.find((node) => node.meta?.memberId === `${dataset.id}:m1`)!;
    const twice: DiagramDoc = {
      ...pinned,
      nodes: pinned.nodes.map((node) => (node.id === second.id ? { ...node, x: 900, y: 700, meta: { ...node.meta, pinned: true } } : node)),
    };
    await syncCanvasGeometry(twice, dataset.id, engine.load);
    expect(engine.requests).toHaveLength(3);
    expect(engine.requests[2]!.pinSet?.pins).toEqual([
      { targetId: "draft", targetKind: "node", position: { x: 777 * 64, y: (444 - 64) * 64 } },
      { targetId: "review", targetKind: "node", position: { x: 900 * 64, y: (700 - 64) * 64 } },
    ]);
  });

  it("keeps the last good scene when the engine refuses the next one", async () => {
    const { doc, dataset } = docFor("workflow");
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    const good = canvasGeometryState(dataset.id);
    expect(good.status).toBe("ready");

    const broken = structuredClone(doc);
    (broken.datasets![0] as SemanticSpecDataset).spec.meta = { title: "Broken", output: "x.html" };
    await syncCanvasGeometry(broken, dataset.id, fakeEngine({ ok: false }).load);
    const refused = canvasGeometryState(dataset.id);
    expect(refused.status).toBe("stale");
    expect(refused.geometry).toBe(good.geometry);
    expect(refused.diagnostics[0]!.code).toBe("test.labelTooWide");
    // The retained scene keeps the hash it was emitted for: the refused bytes
    // drew nothing on screen.
    expect(refused.sourceSpecSha256).toBe(good.sourceSpecSha256);
  });

  it("starts on source positions when the first layout is refused or unavailable", async () => {
    const { doc, dataset } = docFor("architecture");
    await syncCanvasGeometry(doc, dataset.id, fakeEngine({ ok: false }).load);
    expect(canvasGeometryState(dataset.id)).toMatchObject({ status: "refused", geometry: null });

    _resetCanvasGeometryForTests();
    await syncCanvasGeometry(doc, dataset.id, fakeEngine({ fail: true }).load);
    const failed = canvasGeometryState(dataset.id);
    expect(failed.status).toBe("refused");
    expect(failed.geometry).toBeNull();
    expect(failed.diagnostics[0]!.code).toBe("canvas.geometry.unavailable");
  });

  it("does not retry a deterministic refusal until the document changes", async () => {
    const { doc, dataset } = docFor("dataflow");
    const engine = fakeEngine({ ok: false });
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    expect(engine.requests).toHaveLength(1);
  });

  it("shares one layout between concurrent requests for the same key", async () => {
    const { doc, dataset } = docFor("sequence");
    const engine = fakeEngine();
    await Promise.all([
      syncCanvasGeometry(doc, dataset.id, engine.load),
      syncCanvasGeometry(doc, dataset.id, engine.load),
    ]);
    expect(engine.requests).toHaveLength(1);
  });

  it("returning to a ready key supersedes a different in-flight layout", async () => {
    const { doc, dataset } = docFor("workflow");
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    const ready = canvasGeometryState(dataset.id);
    const edited = structuredClone(doc);
    ((edited.datasets![0] as SemanticSpecDataset).spec.nodes as Array<Record<string, unknown>>)[0]!.label = "다른 초안 Different draft";
    let release!: (value: Awaited<ReturnType<FakeEngine["load"]>>) => void;
    const held = new Promise<Awaited<ReturnType<FakeEngine["load"]>>>((resolve) => { release = resolve; });
    const pending = syncCanvasGeometry(edited, dataset.id, () => held);
    expect(matchingCanvasGeometry(edited)).toBeNull();
    await syncCanvasGeometry(doc, dataset.id);
    release(await engine.load());
    await pending;
    expect(canvasGeometryState(dataset.id)).toBe(ready);
    expect(matchingCanvasGeometry(doc)).toBe(ready.geometry);
  });

  it("document replacement never inherits a copied dataset's scene or pending work", async () => {
    const { doc, dataset } = docFor("workflow");
    const engine = fakeEngine();
    await syncCanvasGeometry(doc, dataset.id, engine.load);
    expect(matchingCanvasGeometry(doc)).not.toBeNull();
    resetCanvasGeometry();
    const copy = structuredClone(doc);
    let release!: (value: Awaited<ReturnType<FakeEngine["load"]>>) => void;
    const held = new Promise<Awaited<ReturnType<FakeEngine["load"]>>>((resolve) => { release = resolve; });
    const pending = syncCanvasGeometry(doc, dataset.id, () => held);
    resetCanvasGeometry();
    await syncCanvasGeometry(copy, dataset.id, fakeEngine({ ok: false }).load);
    const refused = canvasGeometryState(dataset.id);
    expect(refused).toMatchObject({ status: "refused", geometry: null });
    expect(matchingCanvasGeometry(copy)).toBeNull();
    release(await engine.load());
    await pending;
    expect(canvasGeometryState(dataset.id)).toBe(refused);
  });

  it("ignores a layout the document has already superseded", async () => {
    const { doc, dataset } = docFor("workflow");
    const edited = structuredClone(doc);
    const editedSpec = (edited.datasets![0] as SemanticSpecDataset).spec;
    (editedSpec.nodes as Array<Record<string, unknown>>)[0]!.label = "초안 Draft";

    // Two distinct keys answering in the wrong order: the superseded layout
    // must neither replace the newer scene nor clear its pending slot.
    const requests: LayoutRequest[] = [];
    const held: Array<() => void> = [];
    const load = () => new Promise<{ layout: (input: LayoutRequest) => GeometryReport }>((resolve) => {
      const engine = {
        layout: (input: LayoutRequest): GeometryReport => {
          requests.push(input);
          return {
            apiVersion: 1,
            ok: true,
            geometry: sceneFor(input),
            diagnostics: [],
            receipt: receipt(input.pinSet?.sourceSpecSha256),
          };
        },
      };
      held.push(() => resolve(engine));
    });

    const superseded = syncCanvasGeometry(doc, dataset.id, load);
    const current = syncCanvasGeometry(edited, dataset.id, load);
    expect(held).toHaveLength(2);

    held[1]!();
    await current;
    const newest = canvasGeometryState(dataset.id);
    expect(newest.status).toBe("ready");
    expect(
      [...newest.geometry!.labels.values()].flat().some((label) => label.lines.join(" ") === "초안 Draft"),
    ).toBe(true);

    held[0]!();
    await superseded;
    // The older layout did reach the engine; its answer just never published.
    expect(requests).toHaveLength(2);
    expect(canvasGeometryState(dataset.id)).toBe(newest);
  });
});

describe("document header and entity label namespaces", () => {
  it("selects the right published labels when a node and relation share an id", async () => {
    const spec = mixedSpec("workflow");
    const nodes = spec.nodes as Array<Record<string, unknown>>;
    const edges = spec.edges as Array<Record<string, unknown>>;
    const shared = nodes[0]!.id as string;
    edges[0]!.id = shared;
    edges[0]!.label = "연결 Link";
    const dataset = archifySpecToDataset("workflow", spec, { id: "ds-shared" }).dataset;
    const doc = projectSemanticDocument(dataset).doc;
    const id = dataset.idMap[shared]!;
    expect(doc.edges[0]!.id).toBe(id);
    await syncCanvasGeometry(doc, dataset.id, fakeEngine().load);
    const geometry = canvasGeometryState(dataset.id).geometry!;
    expect(geometry.labels.get(id)!.some((label) => label.id.startsWith("node:"))).toBe(true);
    expect(geometry.labels.get(id)!.some((label) => label.id.startsWith("edge:"))).toBe(true);
    expect(canvasLabelsFor(geometry, id, "node").map((label) => label.lines.join(" "))).toContain(MIXED_LABEL);
    expect(canvasLabelsFor(geometry, id, "node").some((label) => label.id.startsWith("edge:"))).toBe(false);
    expect(canvasLabelsFor(geometry, id, "edge").map((label) => label.lines.join(" "))).toEqual(["연결 Link"]);
  });

  it("keeps a node named document out of the page header labels", async () => {
    const spec = mixedSpec("architecture");
    const nodes = spec.components as Array<Record<string, unknown>>;
    const previous = nodes[0]!.id;
    nodes[0]!.id = "document";
    for (const edge of spec.connections as Array<Record<string, unknown>>) {
      if (edge.from === previous) edge.from = "document";
      if (edge.to === previous) edge.to = "document";
    }
    const dataset = archifySpecToDataset("architecture", spec, { id: "ds-document" }).dataset;
    const doc = projectSemanticDocument(dataset).doc;
    await syncCanvasGeometry(doc, dataset.id, fakeEngine().load);
    const geometry = canvasGeometryState(dataset.id).geometry!;
    expect(geometry.labels.get(dataset.idMap.document!)?.some((label) => label.id === "node:document:label")).toBe(true);
    expect(geometry.pageLabels.some((label) => label.id === "node:document:label")).toBe(false);
  });
});

describe("which canvases draw engine geometry", () => {
  it("selects the single engine-family semantic dataset and nothing else", () => {
    const { doc, dataset } = docFor("lifecycle");
    expect(canvasGeometryDatasetId(doc)).toBe(dataset.id);

    const two = structuredClone(doc);
    two.datasets = [...two.datasets!, datasetFor("workflow")];
    expect(canvasGeometryDatasetId(two)).toBeNull();

    const floorplan = archifySpecToDataset("floorplan", SEMANTIC_FIXTURES.floorplan, { id: "ds-floor" }).dataset;
    expect(canvasGeometryDatasetId({ ...createEmptyDoc("free"), datasets: [floorplan] })).toBeNull();
    expect(canvasGeometryDatasetId(createEmptyDoc("free"))).toBeNull();
  });

  it("paints engine boxes for scene nodes and keeps free-form placement", () => {
    const { doc, dataset } = docFor("workflow");
    const scene = sceneFor({ specJson: JSON.stringify(dataset.spec) });
    const geometry: CanvasGeometry = canvasGeometryOf(
      { apiVersion: 1, ok: true, geometry: scene, diagnostics: [], receipt: receipt() },
      doc,
      dataset,
    )!;
    const member = doc.nodes.find((node) => node.meta?.memberId === `${dataset.id}:m0`)!;
    const painted = canvasDisplayNode(member, geometry);
    expect(painted).toMatchObject({ id: member.id, x: 40, y: 40, w: 180, h: 72 });

    const dragged = canvasDisplayNode(member, geometry, { ids: new Set([member.id]), dx: 24, dy: -8 });
    expect(dragged).toMatchObject({ x: 64, y: 32 });

    const free = { ...member, id: "free-note", x: 900, y: 900 };
    expect(canvasDisplayNode(free, geometry)).toBe(free);
    expect(canvasDisplayNode(free, null, { ids: new Set(["free-note"]), dx: 10, dy: 10 })).toMatchObject({ x: 910, y: 910 });
  });
});

describe("a keyboard nudge writes what the canvas shows", () => {
  function scene(member: DiagramNode): CanvasGeometry {
    return {
      boxes: new Map([[member.id, { id: member.id, sourceId: "draft", role: "node", x: 200, y: 300, w: 180, h: 72 }]]),
      labels: new Map(),
      routes: new Map(),
      pageLabels: [],
      page: null,
      diagnostics: [],
    };
  }

  it("pins an engine member at its box and leaves the rest to the doc", () => {
    const { doc, dataset } = docFor("workflow");
    const member = doc.nodes.find((node) => node.meta?.memberId === `${dataset.id}:m0`)!;
    const free: DiagramNode = { id: "free-note", kind: "simple", x: 10, y: 20, w: 40, h: 20 };
    const withFree = { ...doc, nodes: [...doc.nodes, free] };
    const geometry = scene(member);

    expect(canvasNudgePins(withFree, dataset.id, geometry, [member.id, free.id], 5, -4)).toEqual([
      { id: member.id, x: 205, y: 296 },
    ]);
    // Before the first scene arrives the doc position stands in for the box.
    expect(canvasNudgePins(withFree, dataset.id, null, [member.id], 5, -4)).toEqual([
      { id: member.id, x: member.x + 5, y: member.y - 4 },
    ]);
    // A pinned member moves on from its own position: the box on screen is the
    // previous one until the layout carrying the last nudge lands.
    const pinnedMember = { ...member, x: 205, y: 296, meta: { ...member.meta, pinned: true } };
    const pinnedDoc = { ...doc, nodes: [...withFree.nodes.filter((n) => n.id !== member.id), pinnedMember] };
    expect(canvasNudgePins(pinnedDoc, dataset.id, geometry, [member.id], 1, 0)).toEqual([
      { id: member.id, x: 206, y: 296 },
    ]);
    // Another dataset's canvas pins nothing here.
    expect(canvasNudgePins(withFree, "ds-elsewhere", geometry, [member.id], 5, -4)).toEqual([]);
  });
});
