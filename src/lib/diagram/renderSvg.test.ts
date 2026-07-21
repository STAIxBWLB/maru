import { describe, expect, it } from "vitest";

import { defaultEdge } from "./edgeRouting";
import { exportSvg } from "./export";
import { mkNode } from "./nodeKinds";
import { renderDocToSvg } from "./renderSvg";
import { createEmptyDoc, type DiagramDoc } from "./types";

function docWith(nodes: DiagramDoc["nodes"], edges: DiagramDoc["edges"] = []): DiagramDoc {
  const doc = createEmptyDoc("doc", 1);
  doc.nodes = nodes;
  doc.edges = edges;
  return doc;
}

describe("renderDocToSvg", () => {
  it("renders KPI-style body values inside the node label", () => {
    const kpi = mkNode("titled-box", 10, 10, {
      w: 170,
      h: 96,
      title: "Completion",
      body: "72%",
    });
    const { svg } = renderDocToSvg(docWith([kpi]));
    expect(svg).toContain("72%");
    // Headered kinds keep the title in the header band, not duplicated below.
    expect(svg).toContain("Completion");
  });

  it("renders SWOT-style bullets as a list", () => {
    const section = mkNode("section", 0, 0, {
      w: 200,
      h: 140,
      title: "Strengths",
      bullets: ["Skilled facilitators", "Strong local demand"],
    });
    const { svg } = renderDocToSvg(docWith([section]));
    expect(svg).toContain("<ul");
    expect(svg).toContain("<li");
    expect(svg).toContain("Skilled facilitators");
    expect(svg).toContain("Strong local demand");
  });

  it("renders Kanban items (bullets on section columns)", () => {
    const col = mkNode("section", 0, 0, {
      w: 180,
      h: 220,
      title: "Doing",
      bullets: ["Draft baseline report", "Recruit instructors"],
    });
    const { svg } = renderDocToSvg(docWith([col]));
    expect(svg).toContain("Draft baseline report");
    expect(svg).toContain("Recruit instructors");
  });

  it("preserves multiline body text with pre-wrap styling", () => {
    const node = mkNode("simple", 0, 0, { title: "T", body: "line one\nline two" });
    const { svg } = renderDocToSvg(docWith([node]));
    expect(svg).toContain("line one\nline two");
    expect(svg).toContain("white-space:pre-wrap");
  });

  it("includes nodes far outside any live viewport (no culling)", () => {
    const near = mkNode("simple", 0, 0, { title: "Near" });
    const far = mkNode("simple", 50_000, 50_000, { title: "Far away" });
    const { svg, viewBox } = renderDocToSvg(docWith([near, far]));
    expect(svg).toContain("Far away");
    // Bounds expand to cover the off-screen node.
    expect(viewBox.w).toBeGreaterThan(50_000);
  });

  it("excludes hidden nodes and nodes on invisible layers, by the model", () => {
    const visibleNode = mkNode("simple", 0, 0, { title: "Shown" });
    const hidden = mkNode("simple", 200, 0, { title: "Secret" });
    hidden.hidden = true;
    const layered = mkNode("simple", 400, 0, { title: "Layered", layerId: "draft" });
    const doc = docWith([visibleNode, hidden, layered]);
    doc.layers = [
      { id: "default", name: "default", visible: true, locked: false, order: 0 },
      { id: "draft", name: "draft", visible: false, locked: false, order: 1 },
    ];
    const { svg } = renderDocToSvg(doc);
    expect(svg).toContain("Shown");
    expect(svg).not.toContain("Secret");
    expect(svg).not.toContain("Layered");
  });

  it("drops edges whose endpoints are excluded", () => {
    const a = mkNode("simple", 0, 0, { id: "a", title: "A" });
    const b = mkNode("simple", 200, 0, { id: "b", title: "B" });
    b.hidden = true;
    const edge = defaultEdge("e1", "a", "e", "b", "w");
    const { svg } = renderDocToSvg(docWith([a, b], [edge]));
    expect(svg).not.toContain('data-edge-id="e1"');
  });

  it("renders edges with arrow markers and expands bounds for labels", () => {
    const a = mkNode("simple", 0, 0, { id: "a", title: "A" });
    const b = mkNode("simple", 0, 4_000, { id: "b", title: "B" });
    const edge = defaultEdge("e1", "a", "s", "b", "n", { label: "approves" });
    const { svg, viewBox } = renderDocToSvg(docWith([a, b], [edge]));
    expect(svg).toContain('data-edge-id="e1"');
    expect(svg).toContain("marker-end=");
    expect(svg).toContain("maru-diagram-arrow-filled");
    expect(svg).toContain("approves");
    // The edge path extends the viewBox beyond the node bbox's bottom.
    expect(viewBox.h).toBeGreaterThan(4_000);
  });

  it("contains no interactive chrome markers", () => {
    const node = mkNode("simple", 0, 0, { title: "Solo" });
    const { svg } = renderDocToSvg(docWith([node]));
    expect(svg).not.toContain("data-export-ignore");
    expect(svg).not.toContain("maru-diagram-port");
    expect(svg).not.toContain("is-selected");
  });

  it("escapes markup in user text", () => {
    const evil = mkNode("simple", 0, 0, { title: "<script>alert(1)</script>" });
    const { svg } = renderDocToSvg(docWith([evil]));
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;");
  });

  it("renders every node kind without throwing", () => {
    const kinds = [
      "simple",
      "section",
      "numbered",
      "text",
      "diamond",
      "oval",
      "hexagon",
      "cylinder",
      "callout",
      "split-box",
      "titled-box",
      "table",
      "image",
    ] as const;
    const nodes = kinds.map((kind, i) => mkNode(kind, i * 300, 0, { title: kind }));
    const { svg } = renderDocToSvg(docWith(nodes));
    for (const kind of kinds) {
      expect(svg).toContain(kind);
    }
  });

  it("produces a default viewBox for an empty doc", () => {
    const { svg, width, height } = renderDocToSvg(createEmptyDoc("doc", 1));
    expect(svg).toContain("<svg");
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});

describe("exportSvg (model-based)", () => {
  it("exports doc content without a live svg element", async () => {
    const kpi = mkNode("titled-box", 10, 10, { title: "KPI", body: "87%" });
    const swot = mkNode("section", 300, 10, {
      title: "Threats",
      bullets: ["Funding gap"],
    });
    const result = exportSvg(null as unknown as SVGSVGElement, docWith([kpi, swot]));
    const text = await result.blob.text();
    expect(result.mimeType).toBe("image/svg+xml");
    expect(text).toContain("87%");
    expect(text).toContain("Funding gap");
    expect(text).not.toContain("data-export-ignore");
    expect(result.width).toBeGreaterThan(0);
  });
});
