import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEngineCanvasLayoutRequest } from "./engineGeometryCanvas";
import type { SemanticSpecDataset } from "./reportTypes";
import { createEmptyDoc, type DiagramDoc, type DiagramNode } from "./types";

function dataset(id = "ds"): SemanticSpecDataset {
  return {
    id, kind: "semanticSpec", name: "Fixture", diagramType: "workflow",
    engine: { name: "archify", version: "3.0.0" },
    idMap: { source: "canvas-a", sink: "canvas-b" },
    spec: {
      schema_version: 1, diagram_type: "workflow", meta: { title: "Fixture", output: "fixture.html" },
      nodes: [{ id: "source", label: "Source" }, { id: "sink", label: "Sink" }],
      lanes: [{ id: "main", label: "Main" }],
      phases: [{ id: "review", label: "Review" }],
      groups: [{ id: "batch", label: "Batch" }],
    },
  };
}
function node(id: string, memberId: string, extra: Partial<DiagramNode> = {}): DiagramNode {
  return { id, kind: "simple", x: 20, y: 30, w: 180, h: 72, meta: { memberId, pinned: true }, ...extra };
}
function doc(nodes: DiagramNode[], datasets = [dataset()]): DiagramDoc {
  return { ...createEmptyDoc("fixture", 0), nodes, datasets };
}

beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => vi.unstubAllGlobals());

describe("test-only engine canvas pin adapter", () => {
  it("maps explicit canvas members through source identity and hashes the exact source", async () => {
    const source = doc([node("canvas-a", "ds:m0", { x: -1 / 128, y: 1 / 128 })]);
    const snapshot = JSON.stringify(source);
    const request = await buildEngineCanvasLayoutRequest(source, "ds");
    expect(request.specJson).toBe(JSON.stringify(source.datasets![0].kind === "semanticSpec" ? source.datasets![0].spec : {}));
    expect(request.pinSet).toEqual({
      sourceSpecSha256: createHash("sha256").update(request.specJson).digest("hex"),
      pins: [{ targetId: "source", targetKind: "node", position: { x: -1, y: 1 } }],
    });
    expect(JSON.stringify(source)).toBe(snapshot);
  });

  it("never infers a pin from moved or merely truthy canvas coordinates/flags", async () => {
    const request = await buildEngineCanvasLayoutRequest(doc([
      node("canvas-a", "ds:m0", { x: 900, y: 500, meta: { memberId: "ds:m0" } }),
      node("canvas-b", "ds:m1", { meta: { memberId: "ds:m1", pinned: "true" } }),
      node("freeform", "", { x: NaN, meta: { pinned: true } }),
    ]), "ds");
    expect(request.pinSet?.pins).toEqual([]);
  });

  it("treats an explicit lock as a pin and scopes metadata to the exact dataset", async () => {
    const request = await buildEngineCanvasLayoutRequest(doc([
      node("canvas-a", "ds:m0", { locked: true, meta: { memberId: "ds:m0" } }),
      node("foreign", "ds-other:m0", { x: Infinity }),
      node("nested-foreign", "ds:other:m0", { x: Infinity }),
    ], [dataset(), dataset("ds-other"), dataset("ds:other")]), "ds");
    expect(request.pinSet?.pins?.map((pin) => pin.targetId)).toEqual(["source"]);
  });

  it("keeps explicit-ID lanes, phases and groups but drops derived containers", async () => {
    const authored = ["lane:main", "phase:review", "group:batch"].map((key) => node(`ds:${key}`, `ds:${key}`, { meta: { pinned: true, memberId: `ds:${key}`, semanticContainer: key.split(":")[0] } }));
    const derived = ["boundary", "stage", "segment", "activation", "card"].map((role) => node(`ds:${role}:0`, `ds:${role}:0`, { x: Infinity, meta: { pinned: true, memberId: `ds:${role}:0`, semanticContainer: role } }));
    const request = await buildEngineCanvasLayoutRequest(doc([...authored, ...derived]), "ds");
    expect(request.pinSet?.pins?.map((pin) => [pin.targetId, pin.targetKind, pin.role])).toEqual([
      ["group:batch", "container", "group"], ["lane:main", "container", "lane"], ["phase:review", "container", "phase"],
    ]);
  });

  it.each([NaN, Infinity, -Infinity, 33554432, -33554433])("refuses invalid fixed-point coordinates %s", async (x) => {
    await expect(buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0", { x })]), "ds")).rejects.toThrow(/Cannot adapt canvas pins:.*;.*retry/);
  });

  it("retains exact signed-32-bit coordinate endpoints", async () => {
    const request = await buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0", { x: -2147483648 / 64, y: 2147483647 / 64 })]), "ds");
    expect(request.pinSet?.pins?.[0].position).toEqual({ x: -2147483648, y: 2147483647 });
  });

  it("refuses stale identities, duplicate targets and ambiguous datasets", async () => {
    await expect(buildEngineCanvasLayoutRequest(doc([node("wrong-id", "ds:m0")]), "ds")).rejects.toThrow("id mapping");
    await expect(buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m9")]), "ds")).rejects.toThrow("no source entity");
    await expect(buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0"), node("canvas-a", "ds:m0")]), "ds")).rejects.toThrow("multiple explicitly pinned");
    await expect(buildEngineCanvasLayoutRequest(doc([], [dataset(), dataset()]), "ds")).rejects.toThrow("duplicated");
  });

  it("changes only the source hash after an unrelated source edit and restores on undo", async () => {
    const source = doc([node("canvas-a", "ds:m0")]);
    const before = await buildEngineCanvasLayoutRequest(source, "ds");
    const selected = source.datasets![0];
    if (selected.kind !== "semanticSpec") throw new Error("fixture dataset must be semantic");
    selected.spec.meta = { title: "Changed", output: "fixture.html" };
    const edited = await buildEngineCanvasLayoutRequest(source, "ds");
    expect(edited.pinSet?.pins).toEqual(before.pinSet?.pins);
    expect(edited.pinSet?.sourceSpecSha256).not.toBe(before.pinSet?.sourceSpecSha256);
    selected.spec = JSON.parse(before.specJson) as Record<string, unknown>;
    expect(await buildEngineCanvasLayoutRequest(source, "ds")).toEqual(before);
  });

  it("subtracts the page content offset so a canvas position becomes an authored pin", async () => {
    const source = doc([node("canvas-a", "ds:m0", { x: 20, y: 94 })]);
    // Canvas y=94 under a 64px header band is source y=30, and adding the offset
    // back reproduces the canvas position the author dragged.
    const request = await buildEngineCanvasLayoutRequest(source, "ds", { contentOffset: { x: 0, y: 64 * 64 } });
    expect(request.pinSet?.pins).toEqual([
      { targetId: "source", targetKind: "node", position: { x: 20 * 64, y: 30 * 64 } },
    ]);
    expect(request.pinSet!.pins![0].position.y + 64 * 64).toBe(94 * 64);
  });

  it("refuses a non fixed-point content offset and can skip pins for the offset probe", async () => {
    await expect(buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0")]), "ds", { contentOffset: { x: 0, y: 1.5 } })).rejects.toThrow(/content offset/);
    const probe = await buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0")]), "ds", { pins: false });
    expect(probe.pinSet?.pins).toEqual([]);
  });

  it.each(["architecture", "sequence", "dataflow", "lifecycle"] as const)("resolves %s entity collections without canvas ID inference", async (diagramType) => {
    const selected = dataset();
    selected.diagramType = diagramType;
    const field = { architecture: "components", sequence: "participants", dataflow: "nodes", lifecycle: "states" }[diagramType];
    selected.spec = { [field]: [{ id: "source" }] };
    const request = await buildEngineCanvasLayoutRequest(doc([node("canvas-a", "ds:m0")], [selected]), "ds");
    expect(request.pinSet?.pins?.[0].targetId).toBe("source");
  });
});
