// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeometryReport, LayoutRequest } from "../../../../src-tauri/crates/maru-diagram-engine/bindings/engine";
import { archifySpecToDataset } from "../../../lib/diagram/archifyCodec";
import {
  _resetCanvasGeometryForTests,
  _setCanvasEngineLoaderForTests,
  canvasGeometryState,
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
} from "../DiagramStoreContext";
import { CanvasSurface } from "./CanvasSurface";
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
  return null;
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
  });

  it("lays out once and leaves the doc untouched", async () => {
    const saved = JSON.stringify(doc);
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    expect(requests).toHaveLength(1);
    expect(JSON.stringify(probe!.getState().doc)).toBe(saved);
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

    const notice = document.body.querySelector("[data-engine-geometry-notice]")!;
    expect(notice.textContent).toContain("The label does not fit");
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

  beforeEach(() => {
    document.body.innerHTML = "";
    requests.length = 0;
    _resetCanvasGeometryForTests();
    _setCanvasEngineLoaderForTests(async () => ({
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
    }));
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
