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
  return {
    apiVersion: 1,
    ok: true,
    geometry: {
      nodes: [
        { id: "draft", bounds: { x: 64 * 200, y: 64 * 300, width: 64 * 180, height: 64 * 72 }, positionSource: "automatic" },
        { id: "review", bounds: { x: 64 * 460, y: 64 * 300, width: 64 * 180, height: 64 * 72 }, positionSource: "automatic" },
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
          id: "node:draft:label", targetId: "draft", text: "주문 접수\nOrder intake",
          bounds: { x: 64 * 218, y: 64 * 316, width: 64 * 140, height: 64 * 34 }, font, fontSize: 13 * 64, glyphs: [],
        },
        {
          id: "node:review:label", targetId: "review", text: "검토 Review",
          bounds: { x: 64 * 478, y: 64 * 316, width: 64 * 100, height: 64 * 17 }, font, fontSize: 13 * 64, glyphs: [],
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

  it("writes one pin at the dropped canvas position", async () => {
    harness = renderCanvas(doc);
    await settle();
    await vi.waitFor(() => expect(canvasGeometryState("ds-flow").status).toBe("ready"));
    await settle();

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
    // Engine box (200,300) plus the snapped drag delta, in emitted canvas space.
    expect(pinned.meta?.pinned).toBe(true);
    expect(pinned.x).toBeGreaterThan(200);
    expect(pinned.y).toBeGreaterThan(300);
    expect(after.ephemeral.history.past).toHaveLength(1);
    // The pin is what the engine is asked to place next.
    await vi.waitFor(() => {
      const last = requests.at(-1)!;
      expect(last.pinSet?.pins?.some((pin) => pin.targetId === "draft")).toBe(true);
    });
  });
});
