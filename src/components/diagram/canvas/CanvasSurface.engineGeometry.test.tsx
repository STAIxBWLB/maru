// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeometryReport, LayoutRequest } from "../../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { archifySpecToDataset } from "../../../lib/diagram/archifyCodec";
import { replaceDoc, undo } from "../../../lib/diagram/actions";
import {
  _resetCanvasGeometryForTests,
  _setCanvasEngineLoaderForTests,
  canvasGeometryState,
  syncCanvasGeometry,
  resetCanvasGeometry,
} from "../../../lib/diagram/engineCanvasGeometry";
import { projectSemanticDocument } from "../../../lib/diagram/semantic";
import type { SemanticSpecDataset } from "../../../lib/diagram/reportTypes";
import type { DiagramDoc } from "../../../lib/diagram/types";
import "../../../lib/i18n/testing";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import {
  DiagramStoreProvider,
  _resetDiagramSharedStoreForTests,
  useDiagramStore,
  useDiagram,
} from "../DiagramStoreContext";
import { useCanvasDisplay } from "./useCanvasGeometry";
import { CanvasSurface } from "./CanvasSurface";
import { renderDocToSvg } from "../../../lib/diagram/renderSvg";
import type { DiagramStore } from "../../../lib/diagram/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks pointer capture and layout.
(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture = () => {};
(Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture = () => {};
(Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture = () => false;
Element.prototype.getBoundingClientRect = function rect() {
  return { x: 0, y: 0, top: 0, left: 0, right: 900, bottom: 700, width: 900, height: 700, toJSON: () => ({}) } as DOMRect;
};

const spec = {
  schema_version: 2,
  diagram_type: "workflow",
  meta: { title: "주문 흐름", output: "flow.html", locale: "ko" },
  lanes: [{ id: "main", label: "Main" }],
  nodes: [
    { id: "draft", lane: "main", col: 0, type: "frontend", label: "주문 접수 Order intake" },
    { id: "review", lane: "main", col: 1, type: "backend", label: "검토 Review" },
  ],
  edges: [{ id: "approve", from: "draft", to: "review", label: "approve", role: "main" }],
};

function receipt(inputSpecSha256: string) {
  return {
    schemaVersion: 1,
    inputSpecSha256,
    engine: { id: "maru-diagram-engine", version: "0.1.0", revision: "canvas-component-test" },
    gates: {
      schema: { status: "passed", scope: "test-fixture" },
      artifact: { status: "not-run", scope: "layout-only" },
      browser: { status: "not-run", scope: "non-browser-rasterization" },
      visualReview: { status: "not-run", scope: "manual" },
    },
    readback: { status: "not-run", scope: "saved-file-byte-comparison" },
  };
}

/** The engine scene the fake WASM returns: two boxes, engine-wrapped labels, one route. */
function scene(request: LayoutRequest): GeometryReport {
  const font = { id: "maru-ui", revision: "1", fontSha256: "f".repeat(64), weight: 700, unitsPerEm: 1000, license: "OFL-1.1" };
  // A pin is a requested source position, and this page keeps no offset, so a
  // pinned member lands exactly where the drop put it, label included.
  const pins = new Map((request.pinSet?.pins ?? []).map((pin) => [pin.targetId, pin.position]));
  const shift = (id: string, x: number, y: number) => {
    const pin = pins.get(id);
    return { x: pin ? pin.x / 64 - x : 0, y: pin ? pin.y / 64 - y : 0 };
  };
  const nodeBounds = (id: string, x: number, y: number) => {
    const pin = pins.get(id);
    return {
      x: pin ? pin.x : 64 * x,
      y: pin ? pin.y : 64 * y,
      width: 64 * 180,
      height: 64 * 72,
    };
  };
  const labelBounds = (id: string, originX: number, originY: number, x: number, y: number, width: number, height: number) => {
    const offset = shift(id, originX, originY);
    return { x: 64 * (x + offset.x), y: 64 * (y + offset.y), width: 64 * width, height: 64 * height };
  };
  return {
    apiVersion: 1,
    ok: true,
    geometry: {
      nodes: [
        { id: "draft", bounds: nodeBounds("draft", 200, 300), positionSource: "automatic" },
        { id: "review", bounds: nodeBounds("review", 460, 300), positionSource: "automatic" },
      ],
      containers: [{ id: "lane:main", kind: "lane", bounds: { x: 64 * 160, y: 64 * 250, width: 64 * 560, height: 64 * 200 } }],
      routes: [
        {
          id: "approve", from: "draft", to: "review", variant: null, role: null, width: null,
          points: [{ x: 64 * 380, y: 64 * 336 }, { x: 64 * 420, y: 64 * 336 }, { x: 64 * 420, y: 64 * 336 }, { x: 64 * 460, y: 64 * 336 }],
        },
      ],
      labels: [
        {
          id: "title", targetId: "document", text: "주문 흐름",
          bounds: { x: 64 * 32, y: 64 * 16, width: 64 * 120, height: 64 * 30 }, font, fontSize: 24 * 64, glyphs: [],
        },
        {
          id: "node:draft:label", targetId: "draft", text: "주문 접수\nOrder intake",
          bounds: labelBounds("draft", 200, 300, 218, 316, 140, 34), font, fontSize: 13 * 64, glyphs: [],
        },
        {
          id: "node:review:label", targetId: "review", text: "검토 Review",
          bounds: labelBounds("review", 460, 300, 478, 316, 100, 17), font, fontSize: 13 * 64, glyphs: [],
        },
        {
          id: "edge:approve:label", targetId: "approve", text: "approve",
          bounds: { x: 64 * 400, y: 64 * 320, width: 64 * 40, height: 64 * 14 }, font, fontSize: 10 * 64, glyphs: [],
        },
        {
          id: "container:lane:main:label", targetId: "lane:main", text: "Main",
          bounds: { x: 64 * 170, y: 64 * 260, width: 64 * 40, height: 64 * 16 }, font, fontSize: 12 * 64, glyphs: [],
        },
      ],
      legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
      page: { bounds: { x: 0, y: 0, width: 64 * 900, height: 64 * 700 } },
    },
    diagnostics: [],
    receipt: receipt(request.pinSet?.sourceSpecSha256 ?? "0".repeat(64)),
  };
}

let probe: DiagramStore | null = null;
function StoreProbe() {
  probe = useDiagramStore();
  const doc = useDiagram((state) => state.doc);
  const { nodes } = useCanvasDisplay(doc);
  return <output data-display-probe>{JSON.stringify(nodes.map(({ id, x, y, w, h }) => ({ id, x, y, w, h })))}</output>;
}

let keySeq = 0;
const requests: LayoutRequest[] = [];

function semanticDoc(): { doc: DiagramDoc; dataset: SemanticSpecDataset } {
  const { dataset } = archifySpecToDataset("workflow", spec, { id: "ds-flow" });
  return { doc: projectSemanticDocument(dataset).doc, dataset };
}

function renderCanvas(doc: DiagramDoc): { container: HTMLDivElement; root: Root } {
  _resetDiagramSharedStoreForTests();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  keySeq += 1;
  act(() => {
    root.render(
      <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: (key, vars) => translate("ko", key, vars) }}>
        <DiagramStoreProvider initial={{ doc }} storeKey={`canvas-geometry-${keySeq}`}>
          <StoreProbe />
          <CanvasSurface />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function nodeGroup(nodeId: string): SVGGElement {
  const group = document.body.querySelector<SVGGElement>(`[data-node-id="${nodeId}"]`);
  if (!group) throw new Error(`node ${nodeId} was not rendered`);
  return group;
}

function displayed(id: string): { id: string; x: number; y: number; w: number; h: number } {
  const nodes = JSON.parse(document.querySelector("[data-display-probe]")!.textContent!) as Array<{ id: string; x: number; y: number; w: number; h: number }>;
  return nodes.find((node) => node.id === id)!;
}

describe("semantic canvas draws engine geometry", () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null;
  let doc: DiagramDoc;

  beforeEach(() => {
    document.body.innerHTML = "";
    requests.length = 0;
    _resetCanvasGeometryForTests();
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        return scene(input);
      },
    }));
    doc = semanticDoc().doc;
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
    _setCanvasEngineLoaderForTests(null);
    _resetCanvasGeometryForTests();
  });

  it("paints engine boxes, wrapped label lines and engine routes", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();

    const canvas = document.body.querySelector(".maru-diagram-canvas")!;
    expect(canvas.getAttribute("data-engine-dataset-id")).toBe("ds-flow");
    expect(canvas.getAttribute("data-engine-geometry-status")).toBe("ready");
    expect(canvas.getAttribute("data-engine-spec-sha256")).toMatch(/^[0-9a-f]{64}$/);

    const draft = doc.datasets![0] as SemanticSpecDataset;
    const draftId = draft.idMap.draft!;
    // The box is the engine's, converted only at the render boundary.
    expect(nodeGroup(draftId).getAttribute("transform")).toBe("translate(200,300)");

    const label = nodeGroup(draftId).querySelector("[data-engine-label='node:draft:label']")!;
    expect([...label.querySelectorAll("tspan")].map((line) => line.textContent)).toEqual(["주문 접수", "Order intake"]);
    expect(label.getAttribute("font-size")).toBe("13");

    const edge = document.body.querySelector("[data-edge-id='approve']")!;
    expect(edge.getAttribute("data-engine-route")).toBe("approve");
    expect(edge.querySelector("path")!.getAttribute("d")).toBe("M 380 336 L 420 336 L 420 336 L 460 336");

    // The lane is a container box, and its engine label replaced the title band.
    expect(nodeGroup("ds-flow:lane:main").getAttribute("transform")).toBe("translate(160,250)");
    expect(nodeGroup("ds-flow:lane:main").querySelector("[data-engine-label='container:lane:main:label']")).not.toBeNull();
    expect(nodeGroup("ds-flow:lane:main").querySelector(".maru-diagram-node-header")).toBeNull();

    // The document header is the engine's too: the page offset it reserves is
    // not a blank band.
    const title = canvas.querySelector("[data-engine-label='title']");
    expect(title?.textContent).toBe("주문 흐름");
    expect(title?.getAttribute("x")).toBe("32");
    expect(title?.getAttribute("y")).toBe("16");

    // A container's opaque fill would hide a route run inside it, so containers
    // paint below the edges and members above them. renderSvg keeps the order.
    const order = [...canvas.querySelectorAll("[data-node-id], [data-edge-id]")]
      .map((element) => element.getAttribute("data-node-id") ?? element.getAttribute("data-edge-id"));
    expect(order.indexOf("ds-flow:lane:main")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("ds-flow:lane:main")).toBeLessThan(order.indexOf("approve"));
    expect(order.indexOf("approve")).toBeLessThan(order.indexOf(draftId));
    expect(order.indexOf("approve")).toBeLessThan(order.indexOf(draft.idMap.review!));

    // WebKit does not inherit dominant-baseline into tspans, so every line
    // carries its own or the first one lifts by an ascent.
    const lines = [...canvas.querySelectorAll("[data-engine-label] tspan")];
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line.getAttribute("dominant-baseline")).toBe("text-before-edge");
    }
  });

  it("lays out once and leaves the doc untouched", async () => {
    const saved = JSON.stringify(doc);
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(probe!.getState().doc)).toBe(saved);
  });

  it("paints the engine's own shapes under the routes and over the members, taking no pointer", async () => {
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        const report = scene(input);
        report.geometry!.primitives = [
          {
            kind: "sequence-lifeline", owner: "draft", layer: "underlay", paint: "line",
            stroke: "0.8", dash: "3 7", arrow: false,
            shape: { kind: "line", from: { x: 64 * 290, y: 64 * 372 }, to: { x: 64 * 290, y: 64 * 600 } },
          },
          {
            kind: "lifecycle-final-border", owner: "review", layer: "overlay", paint: "outlineNode",
            stroke: "1", arrow: false,
            shape: { kind: "rect", bounds: { x: 64 * 463, y: 64 * 303, width: 64 * 174, height: 64 * 66 }, radius: 64 * 4 },
          },
        ];
        return report;
      },
    }));
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();

    const canvas = document.body.querySelector(".maru-diagram-canvas")!;
    const lifeline = canvas.querySelector('[data-engine-primitive="sequence-lifeline"]')!;
    expect(lifeline.tagName.toLowerCase()).toBe("line");
    expect(lifeline.getAttribute("x1")).toBe("290");
    expect(lifeline.getAttribute("y2")).toBe("600");
    expect(lifeline.getAttribute("stroke-width")).toBe("0.8");
    expect(lifeline.getAttribute("stroke-dasharray")).toBe("3 7");
    expect(lifeline.getAttribute("data-engine-primitive-owner")).toBe("draft");
    const border = canvas.querySelector('[data-engine-primitive="lifecycle-final-border"]')!;
    expect(border.getAttribute("x")).toBe("463");
    expect(border.getAttribute("data-engine-primitive-owner")).toBe("review");

    // Scenery, not a target: a lifeline that swallowed the pointer would make
    // every message on it unselectable.
    for (const layer of canvas.querySelectorAll("[data-engine-primitive-layer]")) {
      expect(layer.getAttribute("pointer-events")).toBe("none");
    }

    // The order the SVG writer uses: frames, underlays, routes, members,
    // overlays, page chrome.
    const order = [...canvas.querySelectorAll("[data-node-id], [data-edge-id], [data-engine-primitive], [data-engine-label]")]
      .map((element) => element.getAttribute("data-engine-primitive")
        ?? element.getAttribute("data-engine-label")
        ?? element.getAttribute("data-node-id")
        ?? element.getAttribute("data-edge-id"));
    const draft = doc.datasets![0] as SemanticSpecDataset;
    expect(order.indexOf("sequence-lifeline")).toBeGreaterThan(order.indexOf("ds-flow:lane:main"));
    expect(order.indexOf("sequence-lifeline")).toBeLessThan(order.indexOf("approve"));
    expect(order.indexOf("lifecycle-final-border")).toBeGreaterThan(order.indexOf(draft.idMap.review!));
    expect(order.indexOf("lifecycle-final-border")).toBeLessThan(order.indexOf("title"));
  });

  it("drops an engine shape with the member the canvas stops drawing", async () => {
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        const report = scene(input);
        report.geometry!.primitives = [
          {
            kind: "sequence-lifeline", owner: "draft", layer: "underlay", paint: "line",
            stroke: "0.8", dash: "3 7", arrow: false,
            shape: { kind: "line", from: { x: 64 * 290, y: 64 * 372 }, to: { x: 64 * 290, y: 64 * 600 } },
          },
          {
            kind: "sequence-lifeline", owner: "review", layer: "underlay", paint: "line",
            stroke: "0.8", dash: "3 7", arrow: false,
            shape: { kind: "line", from: { x: 64 * 560, y: 64 * 372 }, to: { x: 64 * 560, y: 64 * 600 } },
          },
          {
            kind: "lifecycle-final-border", owner: "review", layer: "overlay", paint: "outlineNode",
            stroke: "1", arrow: false,
            shape: { kind: "rect", bounds: { x: 64 * 463, y: 64 * 303, width: 64 * 174, height: 64 * 66 }, radius: 64 * 4 },
          },
          {
            // Page chrome: a band names a band, not a member, so hiding a
            // participant must not take the lifecycle's own rail with it.
            kind: "lifecycle-band", owner: "outcome", layer: "underlay", paint: "line",
            stroke: "1.1", arrow: false,
            shape: { kind: "line", from: { x: 64 * 72, y: 64 * 436 }, to: { x: 64 * 800, y: 64 * 436 } },
          },
        ];
        return report;
      },
    }));
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const reviewId = dataset.idMap.review!;
    harness = renderCanvas({
      ...doc,
      nodes: doc.nodes.map((node) => node.id === reviewId ? { ...node, hidden: true } : node),
    });
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();

    const canvas = document.body.querySelector(".maru-diagram-canvas")!;
    // The member is gone, so its lifeline and its final border are gone with it:
    // a dashed line under no participant, and a ring around no state, only
    // describe a scene the reader is not looking at.
    expect(document.body.querySelector(`[data-node-id="${reviewId}"]`)).toBeNull();
    const lifelines = [...canvas.querySelectorAll('[data-engine-primitive="sequence-lifeline"]')];
    expect(lifelines.map((line) => line.getAttribute("data-engine-primitive-owner"))).toEqual(["draft"]);
    expect(canvas.querySelector('[data-engine-primitive="lifecycle-final-border"]')).toBeNull();
    // The band belongs to the page, not to the hidden member.
    expect(canvas.querySelector('[data-engine-primitive="lifecycle-band"]')).not.toBeNull();
  });

  it("keeps the last scene and says so when the engine refuses", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));

    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => ({
        apiVersion: 1,
        ok: false,
        diagnostics: [{ code: "workflow.labelOverflow", path: "/nodes/0", rule: "fit", message: "The label does not fit", fix: "shorten it" }],
        receipt: receipt(input.pinSet?.sourceSpecSha256 ?? "0".repeat(64)),
      }),
    }));
    await act(async () => {
      probe!.setState((state) => ({
        ...state,
        doc: { ...state.doc, datasets: [{ ...(state.doc.datasets![0] as SemanticSpecDataset), spec: { ...spec, meta: { title: "다른 제목", output: "flow.html" } } }] },
      }));
    });
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("stale"));
    await settle();

    await vi.waitFor(() => expect(document.querySelector('[data-canvas-diagnostic="workflow.labelOverflow"]')).not.toBeNull());
    const notice = document.querySelector('[data-canvas-diagnostic="workflow.labelOverflow"]')!;
    expect(notice.getAttribute("data-target-id")).toBe((doc.datasets![0] as SemanticSpecDataset).idMap.draft);
    expect(notice.getAttribute("aria-label")).toContain("The label does not fit");
    expect(notice.getAttribute("aria-label")).toContain("shorten it");
    // Beside the member is taken by the neighbour's box and above it by the
    // lane caption, so the badge steps below the member instead of covering
    // either of them.
    expect(notice.getAttribute("transform")).toBe("translate(200,380)");
    expect(notice.getAttribute("tabindex")).toBe("0");
    expect(document.querySelector("[data-canvas-diagnostic-notice]")).toBeNull();
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
    let release!: () => void;
    const engine = { layout: scene };
    const held = new Promise<typeof engine>((resolve) => { release = () => resolve(engine); });
    _setCanvasEngineLoaderForTests(() => held);
    try {
      act(() => { probe!.setState((state) => ({ ...state, doc: { ...state.doc, datasets: [{ ...(state.doc.datasets![0] as SemanticSpecDataset), spec: { ...spec, meta: { ...spec.meta, title: "새 요청" } } }] } })); });
      // Old-result diagnostics vanish while the next request is still held.
      expect(document.querySelector("[data-canvas-diagnostic]")).toBeNull();
    } finally {
      release();
      await settle();
      await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    }
    // The refusal leaves the previous scene on screen.
    const draft = doc.datasets![0] as SemanticSpecDataset;
    expect(nodeGroup(draft.idMap.draft!).getAttribute("transform")).toBe("translate(200,300)");
  });
});

describe("semantic canvas pins a dropped member", () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null;
  let doc: DiagramDoc;

  beforeEach(() => {
    document.body.innerHTML = "";
    requests.length = 0;
    _resetCanvasGeometryForTests();
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        return scene(input);
      },
    }));
    doc = semanticDoc().doc;
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
    _setCanvasEngineLoaderForTests(null);
    _resetCanvasGeometryForTests();
  });

  function holdFollowingLayouts(): () => void {
    const engine = {
      layout: (input: LayoutRequest) => {
        requests.push(input);
        return scene(input);
      },
    };
    let release!: () => void;
    const held = new Promise<typeof engine>((resolve) => { release = () => resolve(engine); });
    _setCanvasEngineLoaderForTests(() => held);
    return release;
  }

  async function startReadyCanvas(): Promise<void> {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: false } },
      }));
    });
  }

  async function dragMember(id: string, dx: number, dy: number, drop = true): Promise<void> {
    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    const position = nodeGroup(id).getAttribute("transform")!.match(/translate\(([^,]+),([^)]*)\)/)!;
    const x = Number(position[1]) + 8;
    const y = Number(position[2]) + 8;
    await act(async () => {
      nodeGroup(id).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x + dx, clientY: y + dy }));
    });
    if (drop) {
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: x + dx, clientY: y + dy }));
      });
    }
    await settle();
  }

  it("marquee and additive multi-select hit engine boxes, and pan/zoom keep their canvas position", async () => {
    await startReadyCanvas();
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draft = dataset.idMap.draft!;
    const review = dataset.idMap.review!;
    const surface = document.querySelector(".maru-diagram-canvas")!;
    async function pointer(type: string, x: number, y: number, modifiers = {}) {
      await act(async () => { surface.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y, ...modifiers })); });
    }
    await pointer("pointerdown", 198, 298);
    await pointer("pointermove", 382, 374);
    await pointer("pointerup", 382, 374);
    expect(new Set(probe!.getState().ephemeral.selection.nodes)).toEqual(new Set(["ds-flow:lane:main", draft]));
    await pointer("pointerdown", 458, 298, { ctrlKey: true });
    await pointer("pointermove", 642, 374);
    await pointer("pointerup", 642, 374);
    expect(new Set(probe!.getState().ephemeral.selection.nodes)).toEqual(new Set(["ds-flow:lane:main", draft, review]));
    const saved = JSON.stringify(probe!.getState().doc);
    await pointer("pointerdown", 10, 10, { shiftKey: true });
    await pointer("pointermove", 50, 40);
    await pointer("pointerup", 50, 40);
    expect(probe!.getState().ephemeral.viewport).toMatchObject({ px: 40, py: 30, zoom: 1 });
    await act(async () => { surface.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true, clientX: 240, clientY: 330, deltaY: -100 })); });
    const viewport = probe!.getState().ephemeral.viewport;
    expect(viewport.zoom).toBeGreaterThan(1);
    // Zoom keeps the engine point under the pointer, not the stored coarse slot.
    expect((240 - viewport.px) / viewport.zoom).toBeCloseTo(200);
    expect((330 - viewport.py) / viewport.zoom).toBeCloseTo(300);
    expect(displayed(draft)).toMatchObject({ x: 200, y: 300 });
    expect(JSON.stringify(probe!.getState().doc)).toBe(saved);
  });

  it("snaps and smart guides operate on the painted engine origins", async () => {
    await startReadyCanvas();
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draft = dataset.idMap.draft!;
    act(() => { probe!.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: true, snapSize: 20 } } })); });
    await dragMember(draft, 29, 11, false);
    expect(displayed(draft)).toMatchObject({ x: 220, y: 320 });
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    act(() => { probe!.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: true } } })); });
    await dragMember(draft, 258, 0, false);
    expect(displayed(draft)).toMatchObject({ x: 460, y: 300 });
    expect(document.querySelectorAll('line[stroke="#ec4899"]').length).toBeGreaterThan(0);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("moves a state's own engine shapes with it while the drag is live", async () => {
    // A lifecycle final border is the engine's shape, but it belongs to the
    // state it rings. The member group is painted at its live position, so a
    // border left at the settled box would be a ring the state has stepped out
    // of until the next layout lands.
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        const report = scene(input);
        report.geometry!.primitives = [
          {
            kind: "lifecycle-final-border", owner: "review", layer: "overlay", paint: "outlineNode",
            stroke: "1", arrow: false,
            shape: { kind: "rect", bounds: { x: 64 * 463, y: 64 * 303, width: 64 * 174, height: 64 * 66 }, radius: 64 * 4 },
          },
        ];
        return report;
      },
    }));
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: false } },
      }));
    });
    const review = (doc.datasets![0] as SemanticSpecDataset).idMap.review!;
    const border = () => document.body.querySelector('[data-engine-primitive="lifecycle-final-border"]')!;
    expect([border().getAttribute("x"), border().getAttribute("y")]).toEqual(["463", "303"]);

    await dragMember(review, 60, 45, false);
    expect(nodeGroup(review).getAttribute("transform")).toBe("translate(520,345)");
    // The same delta the member group took, applied to the engine's shape.
    expect([border().getAttribute("x"), border().getAttribute("y")]).toEqual(["523", "348"]);
    expect(border().getAttribute("width")).toBe("174");

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect([border().getAttribute("x"), border().getAttribute("y")]).toEqual(["463", "303"]);
    expect(nodeGroup(review).getAttribute("transform")).toBe("translate(460,300)");
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("starts the connect ghost at the painted engine port", async () => {
    await startReadyCanvas();
    const draft = (doc.datasets![0] as SemanticSpecDataset).idMap.draft!;
    // Selected members expose their ports without relying on jsdom hover layout.
    act(() => { probe!.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, selection: { nodes: new Set([draft]), edges: new Set() } } })); });
    const port = nodeGroup(draft).querySelector('[data-port="e"]')!;
    expect(port).not.toBeNull();
    await act(async () => { port.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 380, clientY: 336 })); });
    const surface = document.querySelector(".maru-diagram-canvas")!;
    await act(async () => { surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 430, clientY: 350 })); });
    const ghost = surface.querySelector('line[stroke="#2563eb"]')!;
    expect([ghost.getAttribute("x1"), ghost.getAttribute("y1"), ghost.getAttribute("x2"), ghost.getAttribute("y2")]).toEqual(["380", "336", "430", "350"]);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(surface.querySelector('line[stroke="#2563eb"]')).toBeNull();
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
  });

  it.each([false, true])("document replacement cancels a live drag before pointer-up (copied id=%s)", async (sameId) => {
    await startReadyCanvas();
    const release = holdFollowingLayouts();
    const draft = (doc.datasets![0] as SemanticSpecDataset).idMap.draft!;
    try {
      await dragMember(draft, 60, 45, false);
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      const replacement = structuredClone(doc);
      if (!sameId) replacement.id = "other-document";
      replacement.docTitle = "Opened replacement";
      replacement.nodes = replacement.nodes.map((node) => ({ ...node, x: node.x + 900 }));
      await act(async () => {
        resetCanvasGeometry();
        probe!.setState(replaceDoc(replacement));
      });
      const before = JSON.stringify(probe!.getState().doc);
      const source = replacement.nodes.find((node) => node.id === draft)!;
      expect(displayed(draft)).toMatchObject({ x: source.x, y: source.y });
      const surface = document.querySelector(".maru-diagram-canvas")!;
      await act(async () => { surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 268, clientY: 353 })); });
      expect(JSON.stringify(probe!.getState().doc)).toBe(before);
      expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
      expect(document.querySelector('line[stroke="#ec4899"]')).toBeNull();
    } finally {
      release();
      await settle();
      await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    }
  });

  it("keeps each member's painted start through a second drag before the first layout lands", async () => {
    await startReadyCanvas();
    const release = holdFollowingLayouts();
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draft = dataset.idMap.draft!;
    const review = dataset.idMap.review!;
    try {
      await dragMember(draft, 60, 45);
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(260,345)");
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      // The second selection mixes a member with a pending prior drop and one
      // still at its original box. They must not share the first member's delta.
      act(() => {
        probe!.setState((state) => ({
          ...state,
          ephemeral: { ...state.ephemeral, selection: { nodes: new Set([draft, review]), edges: new Set<string>() } },
        }));
      });
      await dragMember(draft, 20, 15, false);
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(280,360)");
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
      expect(canvasGeometryState("ds-flow").geometry?.boxes.get(draft)?.x).toBe(200);
      const surface = document.body.querySelector(".maru-diagram-canvas")!;
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 288, clientY: 368 }));
      });
      await settle();
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(280,360)");
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
      const pinned = probe!.getState().doc.nodes;
      expect(pinned.find((node) => node.id === draft)).toMatchObject({ x: 280, y: 360, meta: { pinned: true } });
      expect(pinned.find((node) => node.id === review)).toMatchObject({ x: 480, y: 315, meta: { pinned: true } });
      release();
      await settle();
      await vi.waitFor(() => {
        expect(canvasGeometryState("ds-flow").geometry?.boxes.get(draft)?.x).toBe(280);
        expect(canvasGeometryState("ds-flow").geometry?.boxes.get(review)?.x).toBe(480);
      });
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(280,360)");
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
    } finally {
      release();
      await settle();
    }
  });

  it("preserves unselected pending drops and cancels only the next live drag on Escape", async () => {
    await startReadyCanvas();
    const release = holdFollowingLayouts();
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draft = dataset.idMap.draft!;
    const review = dataset.idMap.review!;
    try {
      await dragMember(draft, 60, 45);
      await dragMember(review, 20, 15);
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(260,345)");
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
      const before = JSON.stringify(probe!.getState().doc);
      const historyCount = probe!.getState().ephemeral.history.past.length;
      await dragMember(draft, 10, 5, false);
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(270,350)");
      expect(displayed(draft)).toMatchObject({ x: 270, y: 350 });
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(260,345)");
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
      expect(JSON.stringify(probe!.getState().doc)).toBe(before);
      expect(probe!.getState().ephemeral.history.past).toHaveLength(historyCount);
      release();
      await settle();
      await vi.waitFor(() => expect(canvasGeometryState("ds-flow").geometry?.boxes.get(draft)?.x).toBe(260));
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(260,345)");
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      expect(nodeGroup(review).getAttribute("transform")).toBe("translate(480,315)");
    } finally {
      release();
      await settle();
    }
  });

  it("drops an undone pin overlay when the cached scene needs no new publish", async () => {
    await startReadyCanvas();
    const release = holdFollowingLayouts();
    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draft = dataset.idMap.draft!;
    const before = JSON.stringify(probe!.getState().doc);
    const published = canvasGeometryState("ds-flow");
    let pending: Promise<void> | null = null;
    try {
      await dragMember(draft, 60, 45);
      pending = syncCanvasGeometry(probe!.getState().doc, dataset.id);
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(260,345)");
      expect(displayed(draft)).toMatchObject({ x: 260, y: 345 });
      expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
      act(() => { probe!.setState(undo()); });
      await settle();
      expect(JSON.stringify(probe!.getState().doc)).toBe(before);
      expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
      expect(probe!.getState().ephemeral.history.future).toHaveLength(1);
      // K0 is already ready, so neither a new layout nor a geometry publish is
      // needed to replace the obsolete optimistic position from K1's drop.
      expect(canvasGeometryState("ds-flow")).toBe(published);
      expect(displayed(draft)).toMatchObject({ x: 200, y: 300 });
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(200,300)");
      await act(async () => {
        release();
        await pending;
      });
      expect(canvasGeometryState("ds-flow")).toBe(published);
      expect(displayed(draft)).toMatchObject({ x: 200, y: 300 });
      expect(nodeGroup(draft).getAttribute("transform")).toBe("translate(200,300)");
      expect(JSON.stringify(probe!.getState().doc)).toBe(before);
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
  });

  it("Escape cancels a live engine drag without leaving a visual offset", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();
    act(() => {
      probe!.setState((state) => ({ ...state, ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: false } } }));
    });
    const id = (doc.datasets![0] as SemanticSpecDataset).idMap.draft!;
    const before = JSON.stringify(probe!.getState().doc);
    const original = nodeGroup(id).getAttribute("transform");
    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    await act(async () => { nodeGroup(id).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit)); });
    await act(async () => { surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit)); });
    expect(nodeGroup(id).getAttribute("transform")).not.toBe(original);
    await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    expect(nodeGroup(id).getAttribute("transform")).toBe(original);
    expect(JSON.stringify(probe!.getState().doc)).toBe(before);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("Maru SVG uses the same published scene the component paints", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();
    const before = JSON.stringify(probe!.getState().doc);
    const exported = new DOMParser().parseFromString(renderDocToSvg(probe!.getState().doc).svg, "image/svg+xml");
    const id = (doc.datasets![0] as SemanticSpecDataset).idMap.draft!;
    expect(exported.querySelector(`[data-node-id="${id}"]`)?.getAttribute("transform"))
      .toBe(nodeGroup(id).getAttribute("transform"));
    for (const edge of doc.edges) {
      expect(exported.querySelector(`[data-edge-id="${edge.id}"] path`)?.getAttribute("d"))
        .toBe(document.body.querySelector(`[data-edge-id="${edge.id}"] path`)?.getAttribute("d"));
    }
    const label = document.body.querySelector("[data-engine-label]")!;
    expect(exported.querySelector(`[data-engine-label="${label.getAttribute("data-engine-label")}"]`)?.textContent)
      .toBe(label.textContent);

    // The Maru SVG is opened in Safari and Preview, where a tspan that inherits
    // nothing lifts its line by an ascent, so the export declares it per line.
    const exportedLines = [...exported.querySelectorAll("[data-engine-label] tspan")];
    expect(exportedLines.length).toBeGreaterThan(0);
    for (const line of exportedLines) {
      expect(line.getAttribute("dominant-baseline")).toBe("text-before-edge");
    }

    // Same paint order as the canvas: container, then route, then members.
    const exportedOrder = [...exported.documentElement.children]
      .filter((element) => element.tagName.toLowerCase() !== "defs")
      .map((element) => element.getAttribute("data-node-id") ?? element.getAttribute("data-edge-id"));
    expect(exportedOrder.indexOf("ds-flow:lane:main")).toBeGreaterThanOrEqual(0);
    expect(exportedOrder.indexOf("ds-flow:lane:main")).toBeLessThan(exportedOrder.indexOf("approve"));
    expect(exportedOrder.indexOf("approve")).toBeLessThan(exportedOrder.indexOf(id));
    expect(JSON.stringify(probe!.getState().doc)).toBe(before);
  });

  it("writes one pin at the dropped canvas position", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();

    // Exact deltas: snapping and smart guides would round the drop, and a
    // tolerant assertion cannot tell one gesture offset from two.
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: false } },
      }));
    });

    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draftId = dataset.idMap.draft!;
    const before = probe!.getState();
    expect(before.ephemeral.history.past).toHaveLength(0);

    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    await act(async () => {
      nodeGroup(draftId).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await settle();

    const after = probe!.getState();
    const pinned = after.doc.nodes.find((node) => node.id === draftId)!;
    // Engine box (200,300) plus the drag delta exactly, in emitted canvas space.
    expect(pinned.meta?.pinned).toBe(true);
    expect([pinned.x, pinned.y]).toEqual([200 + 60, 300 + 45]);
    expect(after.ephemeral.history.past).toHaveLength(1);
    // The pin is what the engine is asked to place next.
    await vi.waitFor(() => {
      const last = requests.at(-1)!;
      expect(last.pinSet?.pins?.some((pin) => pin.targetId === "draft")).toBe(true);
    });
  });

  it("keeps a drop made before the first scene arrives", async () => {
    // Hold the first layout so the drag happens while the canvas still shows
    // its projected source positions, which is what a first paint looks like.
    let release: (() => void) | null = null;
    let first = true;
    _setCanvasEngineLoaderForTests(() => {
      const engine = {
        layout: (input: LayoutRequest) => {
          requests.push(input);
          return scene(input);
        },
      };
      if (!first) return Promise.resolve(engine);
      first = false;
      return new Promise((resolve) => {
        release = () => resolve(engine);
      });
    });

    harness = renderCanvas(doc);
    await settle();
    expect(canvasGeometryState("ds-flow").geometry).toBeNull();

    const dataset = doc.datasets![0] as SemanticSpecDataset;
    const draftId = dataset.idMap.draft!;
    const before = probe!.getState().doc.nodes.find((node) => node.id === draftId)!;
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: false } },
      }));
    });

    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    await act(async () => {
      nodeGroup(draftId).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await settle();

    const pinned = probe!.getState().doc.nodes.find((node) => node.id === draftId)!;
    // Without a scene there is no engine box to read, but the drop still
    // authors a pin instead of an unpinned doc move the layout would erase.
    // The base is the doc position, and the painted node already carries the
    // gesture offset, so adding it again would store twice the drag.
    expect(pinned.meta?.pinned).toBe(true);
    expect([pinned.x, pinned.y]).toEqual([before.x + 60, before.y + 45]);
    // The pinned doc position is what the canvas paints while no box hides it,
    // so a gesture offset on top of it would double the move.
    expect(nodeGroup(draftId).getAttribute("transform")).toBe(`translate(${pinned.x},${pinned.y})`);

    release!();
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    // The scene the engine answers the pin with puts the member back under the
    // cursor: the drag was not lost to the first layout.
    await vi.waitFor(() => {
      expect(nodeGroup(draftId).getAttribute("transform")).toBe(`translate(${pinned.x},${pinned.y})`);
    });
  });
});

describe("semantic canvas leaves derived frames where the engine puts them", () => {
  const dataflowSpec = {
    schema_version: 1,
    diagram_type: "dataflow",
    meta: { title: "Events", output: "events.html", locale: "en" },
    stages: [{ label: "Collect" }, { label: "Store" }],
    nodes: [
      { id: "app", type: "frontend", label: "App", stage: 0, row: 0 },
      { id: "wh", type: "database", label: "Warehouse", stage: 1, row: 0 },
    ],
    flows: [{ from: "app", to: "wh", label: "events", classification: "PII" }],
  };

  let harness: { container: HTMLDivElement; root: Root } | null = null;
  let doc: DiagramDoc;
  let engine: { layout: (input: LayoutRequest) => GeometryReport };

  beforeEach(() => {
    document.body.innerHTML = "";
    requests.length = 0;
    _resetCanvasGeometryForTests();
    engine = {
      layout: (input: LayoutRequest) => {
        requests.push(input);
        return {
          apiVersion: 1,
          ok: true,
          geometry: {
            nodes: [],
            // A stage frame is computed from its members; nothing pins it.
            containers: [{ id: "stage:0", kind: "stage", bounds: { x: 64 * 160, y: 64 * 250, width: 64 * 320, height: 64 * 180 } }],
            routes: [],
            labels: [],
            legend: { bounds: { x: 0, y: 0, width: 0, height: 0 }, entries: [] },
            page: { bounds: { x: 0, y: 0, width: 64 * 900, height: 64 * 700 } },
          },
          diagnostics: [],
          receipt: receipt(input.pinSet?.sourceSpecSha256 ?? "0".repeat(64)),
        };
      },
    };
    _setCanvasEngineLoaderForTests(async () => engine);
    const { dataset } = archifySpecToDataset("dataflow", dataflowSpec, { id: "ds-dataflow" });
    doc = projectSemanticDocument(dataset).doc;
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
    _setCanvasEngineLoaderForTests(null);
    _resetCanvasGeometryForTests();
  });

  it("does not write a derived frame's coarse position before the first scene arrives", async () => {
    let release!: () => void;
    const held = new Promise<typeof engine>((resolve) => { release = () => resolve(engine); });
    _setCanvasEngineLoaderForTests(() => held);
    harness = renderCanvas(doc);
    await settle();
    const pending = syncCanvasGeometry(doc, "ds-dataflow");
    const stageId = "ds-dataflow:stage:0";
    const saved = JSON.stringify(probe!.getState().doc);
    const origin = nodeGroup(stageId).getAttribute("transform");
    expect(canvasGeometryState("ds-dataflow").geometry).toBeNull();
    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    try {
      await act(async () => {
        nodeGroup(stageId).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      });
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 45 }));
      });
      expect(nodeGroup(stageId).getAttribute("transform")).not.toBe(origin);
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 45 }));
      });
      expect(JSON.stringify(probe!.getState().doc)).toBe(saved);
      expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
      expect(nodeGroup(stageId).getAttribute("transform")).toBe(origin);
      await act(async () => {
        release();
        await pending;
      });
      expect(nodeGroup(stageId).getAttribute("transform")).toBe("translate(160,250)");
      expect(JSON.stringify(probe!.getState().doc)).toBe(saved);
    } finally {
      await act(async () => {
        release();
        await pending;
      });
    }
  });

  it("stores no committed offset for a drop that pins nothing", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-dataflow").status).toBe("ready"));
    await settle();

    const stageId = "ds-dataflow:stage:0";
    expect(nodeGroup(stageId).getAttribute("transform")).toBe("translate(160,250)");
    const saved = JSON.stringify(probe!.getState().doc);

    const surface = document.body.querySelector(".maru-diagram-canvas")!;
    await act(async () => {
      nodeGroup(stageId).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await act(async () => {
      surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: 60, clientY: 45 } as MouseEventInit));
    });
    await settle();

    const after = probe!.getState();
    expect(JSON.stringify(after.doc)).toBe(saved);
    expect(after.ephemeral.history.past).toHaveLength(0);
    // No layout is coming to clear a committed offset, so the drop must not
    // leave one: the frame returns to the box the engine computed.
    expect(nodeGroup(stageId).getAttribute("transform")).toBe("translate(160,250)");
  });
});

describe("semantic canvas leaves an undrawn member out of interaction", () => {
  const GHOST_LAYER = "veiled";
  let harness: { container: HTMLDivElement; root: Root } | null = null;
  let doc: DiagramDoc;

  beforeEach(() => {
    document.body.innerHTML = "";
    requests.length = 0;
    _resetCanvasGeometryForTests();
    _setCanvasEngineLoaderForTests(async () => ({
      layout: (input: LayoutRequest) => {
        requests.push(input);
        return scene(input);
      },
    }));
    doc = semanticDoc().doc;
  });

  afterEach(() => {
    unmount();
    _setCanvasEngineLoaderForTests(null);
    _resetCanvasGeometryForTests();
  });

  /** The document plus a layer the reader may have made invisible. */
  function withLayer(visible: boolean): DiagramDoc {
    return {
      ...doc,
      layers: [...doc.layers, { id: GHOST_LAYER, name: "Veiled", visible, locked: false, order: 1 }],
    };
  }

  async function mount(next: DiagramDoc): Promise<void> {
    harness = renderCanvas(next);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: { ...state.ephemeral, ui: { ...state.ephemeral.ui, snapOn: false, smartGuideOn: true } },
      }));
    });
  }

  function unmount(): void {
    if (!harness) return;
    act(() => harness!.root.unmount());
    harness.container.remove();
    harness = null;
  }

  function ghostDoc(opts: { hiddenGhostHidden: boolean; layerVisible: boolean }): DiagramDoc {
    return {
      ...withLayer(opts.layerVisible),
      nodes: [
        ...doc.nodes,
        { id: "ghost-hidden", kind: "simple", x: 100, y: 500, w: 60, h: 40, hidden: opts.hiddenGhostHidden },
        { id: "ghost-layer", kind: "simple", x: 100, y: 560, w: 60, h: 40, layerId: GHOST_LAYER },
      ],
    };
  }

  async function sweepAndSelect(): Promise<Set<string>> {
    const surface = document.querySelector(".maru-diagram-canvas")!;
    const at = async (type: string, x: number, y: number) => act(async () => {
      surface.dispatchEvent(new MouseEvent(type, { bubbles: true, button: 0, clientX: x, clientY: y }));
    });
    await at("pointerdown", 90, 290);
    await at("pointermove", 400, 620);
    await at("pointerup", 400, 620);
    await settle();
    return new Set(probe!.getState().ephemeral.selection.nodes);
  }

  it("marquee selects only the members the canvas draws", async () => {
    // Control: with both ghosts drawn, the same sweep hits both. Without this
    // the empty result below would prove nothing about the sweep.
    await mount(ghostDoc({ hiddenGhostHidden: false, layerVisible: true }));
    const drawn = await sweepAndSelect();
    expect(drawn.has("ghost-hidden")).toBe(true);
    expect(drawn.has("ghost-layer")).toBe(true);
    unmount();

    await mount(ghostDoc({ hiddenGhostHidden: true, layerVisible: false }));
    const undrawn = await sweepAndSelect();
    expect(undrawn.has("ghost-hidden")).toBe(false);
    expect(undrawn.has("ghost-layer")).toBe(false);
    // The sweep still takes what is on screen.
    expect(undrawn.has((doc.datasets![0] as SemanticSpecDataset).idMap.draft!)).toBe(true);
  });

  it("a hidden member is no smart-guide target", async () => {
    const draft = (doc.datasets![0] as SemanticSpecDataset).idMap.draft!;
    const dx = 10;
    await mount(doc);
    const start = displayed(draft);
    unmount();

    /** A plain member whose left edge sits three pixels past where the drag lands. */
    const neighbour = (extra: { hidden?: boolean; layerId?: string } = {}) => ({
      id: "ghost-guided",
      kind: "simple" as const,
      x: start.x + start.w + dx + 3,
      y: start.y + 10,
      w: 40,
      h: 20,
      ...extra,
    });

    async function dropWith(ghost: ReturnType<typeof neighbour>, layerVisible = true): Promise<number> {
      await mount({ ...withLayer(layerVisible), nodes: [...doc.nodes, ghost] });
      const surface = document.querySelector(".maru-diagram-canvas")!;
      const position = nodeGroup(draft).getAttribute("transform")!.match(/translate\(([^,]+),([^)]*)\)/)!;
      const x = Number(position[1]) + 8;
      const y = Number(position[2]) + 8;
      await act(async () => {
        nodeGroup(draft).dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: x, clientY: y }));
      });
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientX: x + dx, clientY: y }));
      });
      await act(async () => {
        surface.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientX: x + dx, clientY: y }));
      });
      await settle();
      const landed = displayed(draft).x;
      unmount();
      return landed;
    }

    const guided = await dropWith(neighbour());
    const hidden = await dropWith(neighbour({ hidden: true }));
    const layered = await dropWith(neighbour({ layerId: GHOST_LAYER }), false);

    // The control proves the fixture reaches the guide at all: a drawn
    // neighbour pulls the member the three pixels onto its edge. The two
    // invisible neighbours must leave the drag exactly where the pointer put it.
    expect(guided).toBe(start.x + dx + 3);
    expect(hidden).toBe(start.x + dx);
    expect(layered).toBe(start.x + dx);
  });
});
