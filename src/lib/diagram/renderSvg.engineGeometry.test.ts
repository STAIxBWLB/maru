// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { archifySpecToDataset } from "./archifyCodec";
import { getCodec, type CodecSerializeOutcome } from "./codecs";
import {
  matchingCanvasGeometry,
  routePathOf,
  type CanvasGeometry,
  type CanvasGeometryLabel,
} from "./engineCanvasGeometry";
import { deserializeDoc, serializeDoc } from "./persistence";
import type { EngineDiagramType } from "./reportTypes";
import { renderDocToSvg } from "./renderSvg";
import { projectSemanticDocument } from "./semantic";
import type { DiagramDoc } from "./types";

vi.mock("./engineCanvasGeometry", async (importOriginal) => ({
  ...await importOriginal<typeof import("./engineCanvasGeometry")>(),
  matchingCanvasGeometry: vi.fn(),
}));

const TYPES: EngineDiagramType[] = ["architecture", "workflow", "sequence", "dataflow", "lifecycle"];

function sceneFor(type: EngineDiagramType): { doc: DiagramDoc; geometry: CanvasGeometry } {
  const { dataset } = archifySpecToDataset(type, structuredClone(SEMANTIC_FIXTURES[type]), { id: `export-${type}` });
  const doc = projectSemanticDocument(dataset).doc;
  const boxes: CanvasGeometry["boxes"] = new Map(doc.nodes.map((node, index) => [node.id, {
    id: node.id,
    sourceId: `source-${index}`,
    role: index === 0 ? "node" as const : "container" as const,
    x: 110.125 + index * 200,
    y: 170.015625,
    w: 180.015625,
    h: 90.125,
  }]));
  const first = doc.nodes[0]!;
  const box = boxes.get(first.id)!;
  const label: CanvasGeometryLabel = {
    id: "node:source-0:label",
    targetId: first.id,
    role: "label",
    lines: ["한글 주문", "Order <intake>"],
    x: box.x + 6.25,
    y: box.y + 9.5,
    w: box.w - 12.5,
    h: 39,
    fontSize: 13,
    weight: 700,
  };
  const labels = new Map<string, CanvasGeometryLabel[]>([[first.id, [label]]]);
  const routes: CanvasGeometry["routes"] = new Map(doc.edges.map((edge, index) => [edge.id, {
    id: edge.id,
    sourceId: `relation-${index}`,
    points: [{ x: 350.125, y: 290.015625 }, { x: 400.125, y: 290.015625 }, { x: 400.125, y: 330.015625 }],
  }]));
  const edge = doc.edges[0]!;
  labels.set(edge.id, [{
    ...label,
    id: "edge:relation-0:label",
    targetId: edge.id,
    lines: ["처리", "Process"],
    x: 360.125,
    y: 280.015625,
    w: 70.25,
    h: 30,
    fontSize: 10,
    weight: 400,
  }]);
  return { doc, geometry: {
    boxes, labels, routes,
    pageLabels: [{ ...label, id: "document:title", targetId: "document", x: 40, y: 20, lines: ["한글 Header"] }],
    page: { x: 0, y: 0, w: 5000, h: 3000 },
    diagnostics: [],
  } };
}

function parsed(svg: string): Document {
  return new DOMParser().parseFromString(svg, "image/svg+xml");
}

beforeEach(() => vi.mocked(matchingCanvasGeometry).mockReturnValue(null));

describe("published engine geometry in Maru visual exports", () => {
  it.each(TYPES)("renders exact %s boxes, measured mixed-script lines and routes without changing the doc", (type) => {
    const { doc, geometry } = sceneFor(type);
    const before = JSON.stringify(doc);
    vi.mocked(matchingCanvasGeometry).mockReturnValue(geometry);
    const rendered = renderDocToSvg(doc);
    const svg = parsed(rendered.svg);
    const node = doc.nodes[0]!;
    const box = geometry.boxes.get(node.id)!;
    const group = svg.querySelector(`[data-node-id="${node.id}"]`)!;
    expect(group.getAttribute("transform")).toBe(`translate(${box.x},${box.y})`);
    const label = group.querySelector('[data-engine-label="node:source-0:label"]')!;
    expect(label.getAttribute("x")).toBe("6.25");
    expect(label.getAttribute("y")).toBe("9.5");
    expect(label.getAttribute("font-size")).toBe("13");
    expect([...label.querySelectorAll("tspan")].map((line) => line.textContent)).toEqual(["한글 주문", "Order <intake>"]);
    expect(label.querySelectorAll("intake")).toHaveLength(0);
    expect(group.querySelectorAll("foreignObject")).toHaveLength(0);
    for (const edge of doc.edges) {
      expect(svg.querySelector(`[data-edge-id="${edge.id}"] path`)?.getAttribute("d"))
        .toBe(routePathOf(geometry.routes.get(edge.id)!));
    }
    expect(svg.querySelector('[data-engine-label="edge:relation-0:label"]')?.textContent).toBe("처리Process");
    expect(svg.querySelector('[data-engine-label="document:title"]')?.textContent).toBe("한글 Header");
    for (const text of svg.querySelectorAll("text[data-engine-label]")) {
      expect(text.getAttribute("font-kerning")).toBe("none");
      expect(text.getAttribute("font-variant-ligatures")).toBe("none");
      expect(text.getAttribute("text-rendering")).toBe("geometricPrecision");
    }
    expect(rendered.viewBox).toEqual({ x: -40, y: -40, w: 5080, h: 3080 });
    expect(JSON.stringify(doc)).toBe(before);
  });

  it("keeps node and edge labels separate when their canvas ids are identical", () => {
    const { doc, geometry } = sceneFor("workflow");
    const shared = doc.nodes[0]!.id;
    const oldEdgeId = doc.edges[0]!.id;
    const nodeLabels = geometry.labels.get(shared)!;
    const edgeLabel = { ...geometry.labels.get(oldEdgeId)![0]!, targetId: shared };
    doc.edges[0]!.id = shared;
    const mixed: CanvasGeometry = {
      ...geometry,
      labels: new Map([[shared, [...nodeLabels, edgeLabel]]]),
      routes: new Map([...geometry.routes].map(([id, route]) => id === oldEdgeId ? [shared, { ...route, id: shared }] : [id, route])),
    };
    vi.mocked(matchingCanvasGeometry).mockReturnValue(mixed);
    const exported = parsed(renderDocToSvg(doc).svg);
    const node = exported.querySelector(`[data-node-id="${shared}"]`)!;
    const edge = exported.querySelector(`[data-edge-id="${shared}"]`)!;
    expect(node.querySelector('[data-engine-label="edge:relation-0:label"]')).toBeNull();
    expect(edge.querySelector('[data-engine-label="node:source-0:label"]')).toBeNull();
    expect(edge.querySelector('[data-engine-label="edge:relation-0:label"]')?.textContent).toBe("처리Process");
  });

  it("keeps source placement when no matching ready scene is available", () => {
    const { doc } = sceneFor("architecture");
    const rendered = parsed(renderDocToSvg(doc).svg);
    const first = doc.nodes[0]!;
    expect(rendered.querySelector(`[data-node-id="${first.id}"]`)?.getAttribute("transform"))
      .toBe(`translate(${first.x},${first.y})`);
    expect(rendered.querySelectorAll("[data-engine-label]")).toHaveLength(0);
  });

  it("Maru SVG paints the engine scene but reopens the unchanged editable source doc", () => {
    const { doc, geometry } = sceneFor("workflow");
    const before = serializeDoc(doc);
    vi.mocked(matchingCanvasGeometry).mockReturnValue(geometry);
    const codec = getCodec("maru-svg")!;
    const outcome = codec.serialize!({ doc });
    if (outcome instanceof Promise) throw new Error("Maru SVG serialization must remain synchronous");
    const text = (outcome as CodecSerializeOutcome).bytes as string;
    expect(text).toContain('data-engine-label="node:source-0:label"');
    const reopened = codec.parse!(text, "diagram.svg");
    if (reopened.result.kind !== "doc") throw new Error("Maru SVG must reopen an editable doc");
    expect(serializeDoc(reopened.result.doc)).toBe(serializeDoc(deserializeDoc(before)));
    expect(serializeDoc(doc)).toBe(before);
    expect(reopened.result.doc.nodes[0]!.x).toBe(doc.nodes[0]!.x);
    expect(reopened.result.doc.nodes[0]!.x).not.toBe(geometry.boxes.get(doc.nodes[0]!.id)!.x);
    const image = getCodec("svg-image")!.serialize!({ doc });
    if (image instanceof Promise) throw new Error("Plain SVG serialization must remain synchronous");
    expect(image.bytes).toContain('data-engine-label="node:source-0:label"');
    expect(image.bytes).not.toContain('<metadata id="maru-diagram">');
  });
});
