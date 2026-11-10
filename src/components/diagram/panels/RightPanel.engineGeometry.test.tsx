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
  syncCanvasGeometry,
} from "../../../lib/diagram/engineCanvasGeometry";
import { projectSemanticDocument } from "../../../lib/diagram/semantic";
import type { SemanticSpecDataset } from "../../../lib/diagram/reportTypes";
import type { DiagramDoc } from "../../../lib/diagram/types";
import { createInitialEphemeral } from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import {
  DiagramStoreProvider,
  _resetDiagramSharedStoreForTests,
  useDiagramStore,
} from "../DiagramStoreContext";
import { RightPanel } from "./RightPanel";
import type { DiagramStore } from "../../../lib/diagram/state";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ko = (key: string) => translate("ko", key);

const spec = {
  schema_version: 2,
  diagram_type: "workflow",
  meta: { title: "주문 흐름", output: "flow.html", locale: "ko" },
  lanes: [{ id: "main", label: "Main" }],
  nodes: [
    { id: "draft", lane: "main", col: 0, type: "frontend", label: "주문 접수" },
    { id: "review", lane: "main", col: 1, type: "backend", label: "검토" },
  ],
  edges: [{ id: "approve", from: "draft", to: "review", label: "approve", role: "main" }],
};

function receipt(inputSpecSha256: string) {
  return {
    schemaVersion: 1,
    inputSpecSha256,
    engine: { id: "maru-diagram-engine", version: "0.1.0", revision: "panel-test" },
    gates: {
      schema: { status: "passed", scope: "test-fixture" },
      artifact: { status: "not-run", scope: "layout-only" },
      browser: { status: "not-run", scope: "non-browser-rasterization" },
      visualReview: { status: "not-run", scope: "manual" },
    },
    readback: { status: "not-run", scope: "saved-file-byte-comparison" },
  };
}

/** The engine places the drafted node at (200,300) with a box of 180×72. */
function scene(request: LayoutRequest): GeometryReport {
  return {
    apiVersion: 1,
    ok: true,
    geometry: {
      nodes: [
        { id: "draft", bounds: { x: 64 * 200, y: 64 * 300, width: 64 * 180, height: 64 * 72 }, positionSource: "automatic" },
        { id: "review", bounds: { x: 64 * 460, y: 64 * 300, width: 64 * 180, height: 64 * 72 }, positionSource: "automatic" },
      ],
      containers: [],
      routes: [],
      labels: [],
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let seq = 0;

function renderPanel(doc: DiagramDoc, selected: string): void {
  seq += 1;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const ephemeral = {
    ...createInitialEphemeral(),
    selection: { nodes: new Set([selected]), edges: new Set<string>() },
  };
  act(() => {
    root!.render(
      <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: ko }}>
        <DiagramStoreProvider initial={{ doc, ephemeral }} storeKey={`right-panel-geometry-${seq}`}>
          <StoreProbe />
          <RightPanel />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function section(titleKey: string): { text: string; inputs: HTMLInputElement[] } {
  const match = [...document.querySelectorAll(".maru-diagram-prop-sections section")].find(
    (candidate) => candidate.querySelector("h3")?.textContent === ko(titleKey),
  );
  if (!match) throw new Error(`the ${titleKey} section is not in the panel`);
  return {
    text: match.textContent ?? "",
    inputs: [...match.querySelectorAll("input")] as HTMLInputElement[],
  };
}

function semanticDoc(): { doc: DiagramDoc; dataset: SemanticSpecDataset } {
  const { dataset } = archifySpecToDataset("workflow", spec, { id: "ds-panel" });
  return { doc: projectSemanticDocument(dataset).doc, dataset };
}

describe("property fields follow what the canvas shows", () => {
  const engine = { layout: (input: LayoutRequest) => scene(input) };

  beforeEach(() => {
    document.body.innerHTML = "";
    probe = null;
    _resetCanvasGeometryForTests();
    _resetDiagramSharedStoreForTests();
    _setCanvasEngineLoaderForTests(async () => engine);
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    container?.remove();
    root = null;
    container = null;
    _setCanvasEngineLoaderForTests(null);
    _resetCanvasGeometryForTests();
    _resetDiagramSharedStoreForTests();
  });

  it("shows the engine box and refuses to place or size an unpinned member", async () => {
    const { doc, dataset } = semanticDoc();
    const draftId = dataset.idMap.draft!;
    const stored = doc.nodes.find((node) => node.id === draftId)!;
    // The doc still holds the coarse projected slot, so a field that read it
    // would show a position the canvas never paints.
    expect([stored.x, stored.y]).not.toEqual([200, 300]);

    // The scene is already there when the panel opens, so what it shows cannot
    // depend on the panel happening to ask for a layout.
    await syncCanvasGeometry(doc, dataset.id, async () => engine);
    expect(canvasGeometryState(dataset.id).status).toBe("ready");
    renderPanel(doc, draftId);
    await settle();

    const position = section("diagram.panel.properties.position");
    expect(position.inputs.map((input) => input.value)).toEqual(["200", "300"]);
    expect(position.inputs.every((input) => input.disabled)).toBe(true);
    expect(position.text).toContain(ko("diagram.properties.enginePosition"));

    const size = section("diagram.panel.properties.size");
    expect(size.inputs.map((input) => input.value)).toEqual(["180", "72"]);
    expect(size.inputs.every((input) => input.disabled)).toBe(true);
    expect(size.text).toContain(ko("diagram.properties.engineSize"));
  });

  it("lets a pinned member's position be typed, because that position is the pin", async () => {
    const { doc, dataset } = semanticDoc();
    const draftId = dataset.idMap.draft!;

    await syncCanvasGeometry(doc, dataset.id, async () => engine);
    renderPanel(doc, draftId);
    await settle();

    act(() => {
      probe!.setState((state) => ({
        ...state,
        doc: {
          ...state.doc,
          nodes: state.doc.nodes.map((node) =>
            node.id === draftId ? { ...node, x: 200, y: 300, meta: { ...node.meta, pinned: true } } : node,
          ),
        },
      }));
    });
    await settle();

    const position = section("diagram.panel.properties.position");
    expect(position.inputs.map((input) => input.value)).toEqual(["200", "300"]);
    expect(position.inputs.every((input) => input.disabled)).toBe(false);
    // The size stays the engine's: a pinned position does not size the box.
    expect(section("diagram.panel.properties.size").inputs.every((input) => input.disabled)).toBe(true);
  });

  it("leaves a free-form node's fields editable and reads its own position", async () => {
    const { doc } = semanticDoc();
    const free = { ...doc, datasets: [], nodes: [{ id: "free", kind: "simple" as const, x: 12, y: 34, w: 80, h: 40 }] };

    renderPanel(free, "free");
    await settle();

    const position = section("diagram.panel.properties.position");
    expect(position.inputs.map((input) => input.value)).toEqual(["12", "34"]);
    expect(position.inputs.every((input) => input.disabled)).toBe(false);
    const size = section("diagram.panel.properties.size");
    expect(size.inputs.map((input) => input.value)).toEqual(["80", "40"]);
    expect(size.inputs.every((input) => input.disabled)).toBe(false);
  });
});
