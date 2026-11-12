import { describe, expect, it } from "vitest";
import type { Diagnostic } from "../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { nativeE4RefusedSpec } from "./__fixtures__/nativeEngineE4";
import { SEMANTIC_FIXTURES } from "./__fixtures__/semantic";
import { archifySpecToDataset } from "./archifyCodec";
import { CANVAS_CONTAINER_HEADER_BAND, CANVAS_DIAGNOSTIC_BADGE, canvasDiagnosticCategory, mapCanvasDiagnostics } from "./canvasDiagnostics";
import { canvasLabelsFor, type CanvasGeometry, type CanvasGeometryLabel } from "./engineCanvasGeometry";
import type { Rect } from "./geometry";
import type { EngineDiagramType } from "./reportTypes";
import { descriptorFor, projectSemanticDocument, projectedRelationEdgeIds, resolveSemanticMember, specEntries } from "./semantic";

function fixture(type: EngineDiagramType = "workflow") {
  const { dataset } = archifySpecToDataset(type, structuredClone(SEMANTIC_FIXTURES[type]), { id: "diagnostic-ds" });
  const doc = projectSemanticDocument(dataset).doc;
  const labels = new Map<string, CanvasGeometryLabel[]>();
  const geometry: CanvasGeometry = {
    boxes: new Map(doc.nodes.map((node, index) => {
      const kind = resolveSemanticMember(doc, { nodeId: node.id })?.kind === "container" ? "container" as const : "node" as const;
      const box = { id: node.id, sourceId: node.id, role: kind, x: 100 + index * 200, y: 150, w: 180, h: 70, ellipse: null };
      labels.set(node.id, [{ id: `${kind}:${node.id}:label`, targetId: node.id, role: "label", lines: ["한글 English"], x: box.x + 8, y: box.y + 9, w: 150, h: 20, fontSize: 13, weight: 400 }]);
      return [node.id, box];
    })),
    labels,
    routes: new Map(doc.edges.map((edge) => [edge.id, { id: edge.id, sourceId: edge.id, points: [{ x: 300, y: 250 }, { x: 400, y: 250 }, { x: 400, y: 350 }] }])),
    primitives: [],
    pageLabels: [{ id: "title", targetId: "document", role: "label", lines: ["Document"], x: 20, y: 10, w: 200, h: 30, fontSize: 24, weight: 700 }],
    // An engine page always contains its members, with room for a badge.
    page: { x: 0, y: 0, w: 100 + doc.nodes.length * 200 + 400, h: 700 },
    diagnostics: [],
  };
  return { dataset, doc, geometry };
}

function diagnostic(path: string, code = "workflow/geometry-label-fit"): Diagnostic {
  return { code, path, rule: "geometry-v1/geometry-label-fit", message: "Measured text needs 12px more width", fix: "Shorten nodes[0].label or enlarge its source box" };
}

/** The drawn badge for one placement, at the size the mapper places at. */
function badgeOf(target: { x: number; y: number }): Rect {
  return { x: target.x, y: target.y, w: CANVAS_DIAGNOSTIC_BADGE.width, h: CANVAS_DIAGNOSTIC_BADGE.height };
}

/** Everything already painted that a badge may not sit on top of. The member
 *  the badge explains is left out: the badge belongs to it and may sit over it. */
function drawnBoxes(geometry: CanvasGeometry, except: string | null = null): Rect[] {
  const boxes: Rect[] = [];
  for (const [id, box] of geometry.boxes) {
    if (box.role === "container" || id === except) continue;
    boxes.push({ x: box.x, y: box.y, w: box.w, h: box.h });
    for (const label of canvasLabelsFor(geometry, id, "node")) {
      boxes.push({ x: label.x, y: label.y, w: label.w, h: label.h });
    }
  }
  for (const label of geometry.pageLabels) boxes.push({ x: label.x, y: label.y, w: label.w, h: label.h });
  return boxes;
}

function sharedArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

describe("canvas diagnostic anchors", () => {
  it.each<EngineDiagramType>(["architecture", "workflow", "sequence", "dataflow", "lifecycle"])("maps %s source JSON-pointer indexes to its measured node label", (type) => {
    const { doc, dataset, geometry } = fixture(type);
    const descriptor = descriptorFor(dataset)!;
    const sourceId = specEntries(dataset.spec, descriptor.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const label = geometry.labels.get(id)![0]!;
    const cause = diagnostic(`/${descriptor.entities}/0/label`);
    const [item] = mapCanvasDiagnostics(doc, dataset.id, geometry, [cause]);
    expect(item!.diagnostic).toBe(cause);
    expect(item!.target).toMatchObject({ kind: "label", id: label.id });
    // Every fixture packs its members a row apart, so the badge has to leave the
    // side it prefers. What must hold is that it covers nothing already drawn:
    // a badge over the neighbouring label hides that member's text and swallows
    // its pointer input.
    const badge = badgeOf(item!.target!);
    for (const drawn of drawnBoxes(geometry, label.targetId)) {
      expect(sharedArea(badge, drawn)).toBe(0);
    }
    expect(badge.x).toBeGreaterThanOrEqual(0);
    expect(badge.y).toBeGreaterThanOrEqual(0);
  });

  it("keeps the badge to the right of its label at the label's top when nothing is in the way", () => {
    const { doc, dataset, geometry } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const label = geometry.labels.get(id)![0]!;
    const alone: CanvasGeometry = {
      ...geometry,
      boxes: new Map([...geometry.boxes].filter(([key]) => key === id)),
      labels: new Map([[id, [label]]]),
      pageLabels: [],
    };
    const [item] = mapCanvasDiagnostics(doc, dataset.id, alone, [diagnostic("/nodes/0/label")]);
    expect(item!.target).toEqual({ kind: "label", id: label.id, x: label.x + label.w + 8, y: label.y });
  });

  it("uses displayed drag positions and source fallback for a first-run refusal", () => {
    const { doc, dataset, geometry } = fixture();
    const id = dataset.idMap.draft!;
    const box = geometry.boxes.get(id)!;
    const displayed = doc.nodes.map((node) => node.id === id ? { ...node, x: box.x + 60, y: box.y + 45, w: box.w, h: box.h } : node);
    const [item] = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic("/nodes/0/label")], displayed);
    const label = geometry.labels.get(id)![0]!;
    // The anchor and the boxes it dodges both come from the displayed
    // positions, so the badge travels with the drag and stays beside it.
    expect(item!.target).toEqual({ kind: "label", id: label.id, x: label.x + label.w + 8 + 60, y: label.y + 45 });
    const [fallback] = mapCanvasDiagnostics(doc, dataset.id, null, [diagnostic("/nodes/0/label")], displayed);
    expect(fallback!.target).toEqual({ kind: "node", id, x: box.x + 60 + box.w + 8, y: box.y + 45 });
  });

  it("anchors named and index-keyed containers by their projected membership", () => {
    for (const type of ["workflow", "dataflow"] as const) {
      const { doc, dataset, geometry } = fixture(type);
      const field = descriptorFor(dataset)!.container!.field;
      const [item] = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic(`/${field}/0`)]);
      expect(item!.target?.kind).toBe("container");
      const member = resolveSemanticMember(doc, { nodeId: item!.target!.id });
      expect(member).toMatchObject({ kind: "container", field, index: 0 });
    }
  });

  it("keeps node and relation labels separate when their canvas ids collide", () => {
    const { dataset } = fixture();
    const relations = specEntries(dataset.spec, "edges");
    relations[0]!.id = "draft";
    const doc = projectSemanticDocument(dataset).doc;
    const shared = dataset.idMap.draft!;
    expect(doc.edges[0]!.id).toBe(shared);
    const label = (id: string, y: number): CanvasGeometryLabel => ({ id, targetId: shared, role: "label", lines: [id], x: 10, y, w: 30, h: 20, fontSize: 13, weight: 400 });
    const geometry: CanvasGeometry = { boxes: new Map(), labels: new Map([[shared, [label("node:draft:label", 20), label("edge:draft:label", 80)]]]), routes: new Map(), primitives: [], pageLabels: [], page: null, diagnostics: [] };
    const items = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic("/nodes/0/label"), diagnostic("/edges/0/label")]);
    expect(items.map((item) => item.target?.id)).toEqual(["node:draft:label", "edge:draft:label"]);
    expect(items.map((item) => item.target?.y)).toEqual([20, 80]);
  });

  it("uses projection relation indexes instead of guessing generated or colliding route ids", () => {
    const { dataset } = fixture();
    const relations = specEntries(dataset.spec, "edges");
    delete relations[0]!.id;
    relations[1]!.id = "edge:0";
    const doc = projectSemanticDocument(dataset).doc;
    const ids = projectedRelationEdgeIds(dataset);
    const geometry: CanvasGeometry = { boxes: new Map(), labels: new Map(), routes: new Map([
      [ids[0]!, { id: ids[0]!, sourceId: "edge:0:generated:generated", points: [{ x: 10, y: 20 }, { x: 50, y: 60 }] }],
      [ids[1]!, { id: ids[1]!, sourceId: "edge:0", points: [{ x: 90, y: 100 }, { x: 130, y: 140 }] }],
    ]), primitives: [], pageLabels: [], page: null, diagnostics: [] };
    const items = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic("/edges/0/via/0"), diagnostic("/edges/1")]);
    expect(items.map((item) => item.target?.id)).toEqual(ids);
    expect(items.map((item) => item.target?.x)).toEqual([58, 138]);
  });

  it.each(["geometry-label-overlap", "geometry-label-viewbox", "route-label-space", "geometry-label-fit"])("anchors %s at an offset edge label for the engine's relation-only pointer", (suffix) => {
    const { doc, dataset, geometry } = fixture();
    const edge = doc.edges[0]!;
    const label: CanvasGeometryLabel = { id: `edge:${edge.id}:label`, targetId: edge.id, role: "label", lines: ["Offset label"], x: 900, y: 650, w: 80, h: 20, fontSize: 13, weight: 400 };
    const labelled = { ...geometry, labels: new Map([...geometry.labels, [edge.id, [label]]]) };
    const [item] = mapCanvasDiagnostics(doc, dataset.id, labelled, [diagnostic("/edges/0", `workflow/${suffix}`)]);
    expect(item!.target).toEqual({ kind: "label", id: label.id, x: 988, y: 650 });
    // A route-clearance failure with the same pointer still belongs to the route.
    const [route] = mapCanvasDiagnostics(doc, dataset.id, labelled, [diagnostic("/edges/0", "workflow/geometry-route-clearance")]);
    expect(route!.target).toEqual({ kind: "edge", id: edge.id, x: 408, y: 250 });
  });

  it("anchors page title but leaves unresolvable or malformed pointers as canvas notices", () => {
    const { doc, dataset, geometry } = fixture();
    const paths = ["/meta/title", "/meta/viewBox", "/nodes/-1/label", "/nodes/00/label", "/nodes/99/label", "/nodes/0/~2", "", "/unknown/0"];
    const items = mapCanvasDiagnostics(doc, dataset.id, geometry, paths.map((path) => diagnostic(path)));
    expect(items[0]!.target).toEqual({ kind: "label", id: "title", x: 228, y: 10 });
    expect(items.slice(1).every((item) => item.target === null)).toBe(true);
  });

  it("ignores inherited idMap keys and maps raw source indexes before filtering", () => {
    const { dataset } = fixture();
    const nodes = specEntries(dataset.spec, "nodes");
    nodes[0]!.id = "constructor";
    dataset.spec.nodes = [null, ...nodes];
    const doc = projectSemanticDocument(dataset).doc;
    const mapped = mapCanvasDiagnostics(doc, dataset.id, null, [diagnostic("/nodes/1/label"), diagnostic("/nodes/0/label")]);
    expect(mapped[0]!.target).toMatchObject({ kind: "node", id: "constructor" });
    expect(mapped[1]!.target).toBeNull();
  });

  it("stacks two diagnostics on one element instead of drawing them on top of each other", () => {
    const { doc, dataset, geometry } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const label = geometry.labels.get(id)![0]!;
    const alone: CanvasGeometry = {
      ...geometry,
      boxes: new Map([...geometry.boxes].filter(([key]) => key === id)),
      labels: new Map([[id, [label]]]),
      pageLabels: [],
    };
    const cause = diagnostic("/nodes/0/label");
    const items = mapCanvasDiagnostics(doc, dataset.id, alone, [cause, cause]);
    expect(items.map((item) => item.target?.id)).toEqual([label.id, label.id]);
    const [first, second] = items.map((item) => badgeOf(item.target!));
    // The first badge keeps the side it prefers; the second knows the first is
    // there and takes another one, so the two never cover each other.
    expect(first).toMatchObject({ x: label.x + label.w + 8, y: label.y });
    expect(sharedArea(first, second)).toBe(0);
    expect(second.x === first.x && second.y === first.y).toBe(false);
    // Both stay beside the element they explain: a badge that jumps across the
    // scene reads as belonging to whatever it landed on.
    for (const badge of [first, second]) {
      expect(Math.abs(badge.x - label.x)).toBeLessThanOrEqual(CANVAS_DIAGNOSTIC_BADGE.width);
      expect(Math.abs(badge.y - label.y)).toBeLessThanOrEqual(
        CANVAS_DIAGNOSTIC_BADGE.height + CANVAS_DIAGNOSTIC_BADGE.gap,
      );
    }
    for (const drawn of drawnBoxes(alone, id)) {
      expect(sharedArea(first, drawn)).toBe(0);
      expect(sharedArea(second, drawn)).toBe(0);
    }
  });

  it("keeps the badge off a container's title band in the fallback view", () => {
    const { doc, dataset } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const lane = doc.nodes.find((node) => resolveSemanticMember(doc, { nodeId: node.id })?.kind === "container");
    expect(lane).toBeDefined();
    // The refused view has no engine geometry, so the canvas draws the
    // container's own dark title band above its body and the member sits just
    // under it.
    const shown = doc.nodes.map((node) => node.id === id
      ? { ...node, x: lane!.x + 40, y: lane!.y + CANVAS_CONTAINER_HEADER_BAND + 2 }
      : node);
    const [item] = mapCanvasDiagnostics(doc, dataset.id, null, [diagnostic("/nodes/0/label")], shown);
    const badge = badgeOf(item!.target!);
    const band = { x: lane!.x, y: lane!.y, w: lane!.w, h: CANVAS_CONTAINER_HEADER_BAND };
    expect(sharedArea(badge, band)).toBe(0);
    // The lane body is still no obstacle: a badge inside the frame covers
    // nothing, so only the opaque band pushes it away.
    expect(badge.y).toBeGreaterThanOrEqual(lane!.y + CANVAS_CONTAINER_HEADER_BAND);
  });

  it("slides clear of the members and title bands on every side it prefers", () => {
    // The native refusal fixture: a lane whose member sits just under its own
    // title band, a second member to the right of it and a third in the lane
    // below. No side of the anchor is free at the first step, so the badge has
    // to keep sliding — and still cover nothing. A 300 px badge is wider than
    // the gap between these members, which is why adjacency cannot be promised
    // here and the first clear slot is what the mapper owns.
    const { dataset } = archifySpecToDataset("workflow", nativeE4RefusedSpec(), { id: "native-e4-refused" });
    const doc = projectSemanticDocument(dataset).doc;
    const [item] = mapCanvasDiagnostics(doc, dataset.id, null, [diagnostic("/nodes/0/label")], doc.nodes);
    expect(item!.target).toMatchObject({ kind: "node", id: "draft" });
    const badge = badgeOf(item!.target!);
    const anchor = doc.nodes.find((node) => node.id === "draft")!;
    const { gap, step } = CANVAS_DIAGNOSTIC_BADGE;
    // Below the anchor, three steps down: the first slot in the mapper's order
    // that covers no member and no title band.
    expect(badge).toMatchObject({ x: anchor.x, y: anchor.y + anchor.h + gap + 3 * step });
    for (const node of doc.nodes) {
      const rect = { x: node.x, y: node.y, w: node.w, h: node.h };
      const isFrame = resolveSemanticMember(doc, { nodeId: node.id })?.kind === "container";
      expect(sharedArea(badge, isFrame ? { ...rect, h: CANVAS_CONTAINER_HEADER_BAND } : rect)).toBe(0);
    }
  });

  it("leaves the badge to the canvas notice rather than cover a member", () => {
    const { doc, dataset } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    // A second member wide enough to stand under every candidate slot. The least
    // covered spot would still land on it, hide it and take its clicks, so the
    // diagnostic belongs in the canvas notice instead of on another member.
    const wall = {
      ...doc.nodes.find((node) => node.id === id)!,
      id: "wall",
      x: -10_000,
      y: -10_000,
      w: 30_000,
      h: 30_000,
    };
    const [item] = mapCanvasDiagnostics(
      doc,
      dataset.id,
      null,
      [diagnostic("/nodes/0/label")],
      [...doc.nodes, wall],
    );
    expect(item!.target).toBeNull();
    expect(item!.category).toBe("text");
  });

  /** One member alone on a page, so only the page edges constrain its badge. */
  function aloneAt(box: { x: number; y: number; h?: number }) {
    const { doc, dataset, geometry } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const engineBox = { ...geometry.boxes.get(id)!, ...box };
    const alone: CanvasGeometry = {
      ...geometry,
      boxes: new Map([[id, engineBox]]),
      labels: new Map(),
      pageLabels: [],
      page: { x: 0, y: 0, w: 900, h: 700 },
    };
    const [item] = mapCanvasDiagnostics(doc, dataset.id, alone, [diagnostic("/nodes/0")]);
    return { badge: item!.target ? badgeOf(item!.target) : null, page: alone.page! };
  }

  function insidePage(badge: Rect, page: Rect) {
    expect(badge.x).toBeGreaterThanOrEqual(page.x);
    expect(badge.y).toBeGreaterThanOrEqual(page.y);
    expect(badge.x + badge.w).toBeLessThanOrEqual(page.x + page.w);
    expect(badge.y + badge.h).toBeLessThanOrEqual(page.y + page.h);
  }

  it("keeps the badge inside the page for a member at the right edge", () => {
    const { badge, page } = aloneAt({ x: 900 - 180, y: 300 });
    expect(badge).not.toBeNull();
    insidePage(badge!, page);
  });

  it("keeps the badge inside the page for a member at the bottom edge", () => {
    // Short enough that the right-hand badge would run past the bottom.
    const { badge, page } = aloneAt({ x: 300, y: 700 - 30, h: 30 });
    expect(badge).not.toBeNull();
    insidePage(badge!, page);
  });

  it("does not treat a member the canvas does not draw as an obstacle", () => {
    const { doc, dataset, geometry } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    const own = geometry.boxes.get(id)!;
    const other = [...geometry.boxes.values()].find((box) => box.id !== id && box.role === "node")!;
    // The other member sits exactly where the badge prefers to go.
    const blocker = { ...geometry.boxes.get(other.id)!, x: own.x + own.w + 8, y: own.y, w: 300, h: 44 };
    const scene: CanvasGeometry = {
      ...geometry,
      boxes: new Map([[id, own], [other.id, blocker]]),
      labels: new Map(),
      pageLabels: [],
    };
    const preferred = { x: own.x + own.w + 8, y: own.y };
    const drawnBoth = doc.nodes.filter((node) => node.id === id || node.id === other.id)
      .map((node) => ({ ...node, ...(node.id === id ? own : blocker) }));
    const [blocked] = mapCanvasDiagnostics(doc, dataset.id, scene, [diagnostic("/nodes/0")], drawnBoth);
    expect(blocked!.target).not.toMatchObject(preferred);
    const [hidden] = mapCanvasDiagnostics(doc, dataset.id, scene, [diagnostic("/nodes/0")], drawnBoth.filter((node) => node.id === id));
    expect(hidden!.target).toMatchObject(preferred);
  });

  it("sends a diagnostic on an undrawn member to the canvas notice", () => {
    const { doc, dataset, geometry } = fixture();
    const sourceId = specEntries(dataset.spec, descriptorFor(dataset)!.entities)[0]!.id as string;
    const id = dataset.idMap[sourceId] ?? sourceId;
    // The member the diagnostic names is the one the canvas does not draw, so
    // there is no box on screen to point at: a badge beside an invisible member
    // explains nothing a reader can see.
    const drawn = doc.nodes.filter((node) => node.id !== id);
    for (const path of ["/nodes/0", "/nodes/0/label"]) {
      const [item] = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic(path)], drawn);
      expect(item!.target).toBeNull();
    }
    // Without the drawn set the mapper does not know the member is absent, so
    // it keeps anchoring: only the caller who says what it paints can drop it.
    const [anchored] = mapCanvasDiagnostics(doc, dataset.id, geometry, [diagnostic("/nodes/0")]);
    expect(anchored!.target).not.toBeNull();
  });

  it("categorizes only recognized codes and retains unknown engine prose verbatim", () => {
    expect(canvasDiagnosticCategory(diagnostic("/nodes/0/label"))).toBe("text");
    expect(canvasDiagnosticCategory(diagnostic("/nodes/0", "workflow/geometry-node-overlap"))).toBe("overlap");
    expect(canvasDiagnosticCategory(diagnostic("/edges/0", "workflow/route-blocked"))).toBe("routing");
    const unknown = diagnostic("/meta/viewBox", "future/label-new-rule");
    const { doc, dataset } = fixture();
    const [item] = mapCanvasDiagnostics(doc, dataset.id, null, [unknown]);
    expect(item!.category).toBe("unknown");
    expect(item!.diagnostic).toBe(unknown);
  });
});
