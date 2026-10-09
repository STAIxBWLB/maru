// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmDialog } from "../../../lib/confirmDialog";
import { SEMANTIC_FIXTURES } from "../../../lib/diagram/__fixtures__/semantic";
import { undo } from "../../../lib/diagram/actions";
import { archifySpecToDataset } from "../../../lib/diagram/archifyCodec";
import type { SemanticDiagramType, SemanticSpecDataset } from "../../../lib/diagram/reportTypes";
import { projectSemanticDocument } from "../../../lib/diagram/semantic";
import type { DiagramStore } from "../../../lib/diagram/state";
import { createInitialEphemeral, type DiagramDoc } from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";
import { DiagramStoreProvider, _resetDiagramSharedStoreForTests, useDiagramStore } from "../DiagramStoreContext";
import { RightPanel } from "./RightPanel";

vi.mock("../../../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let probe: DiagramStore | null = null;
function StoreProbe() {
  probe = useDiagramStore();
  return null;
}

const ko = (key: string, vars?: Record<string, string | number>) => translate("ko", key, vars);

let seq = 0;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

function docOf(type: SemanticDiagramType): DiagramDoc {
  return projectSemanticDocument(archifySpecToDataset(type, SEMANTIC_FIXTURES[type], { id: "ds" }).dataset).doc;
}

function render(doc: DiagramDoc, selection: { nodes?: string[]; edges?: string[] }) {
  seq += 1;
  const ephemeral = {
    ...createInitialEphemeral(),
    selection: { nodes: new Set(selection.nodes ?? []), edges: new Set(selection.edges ?? []) },
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t: ko }}>
        <DiagramStoreProvider initial={{ doc, ephemeral }} storeKey={`semantic-props-${seq}`}>
          <StoreProbe />
          <RightPanel />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
}

const q = <T extends Element>(testId: string) => document.body.querySelector<T>(`[data-testid="${testId}"]`);

async function click(testId: string) {
  await act(async () => {
    q(testId)!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function changeSelect(testId: string, value: string) {
  const el = q<HTMLSelectElement>(testId)!;
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function typeInto(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const specOf = () =>
  (probe!.getState().doc.datasets!.find((d) => d.id === "ds") as SemanticSpecDataset).spec as Record<
    string,
    Record<string, unknown>[]
  >;

describe("SemanticProps", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    probe = null;
    _resetDiagramSharedStoreForTests();
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(true);
  });

  afterEach(async () => {
    if (root) await unmountReactRoot(root);
    container?.remove();
    root = null;
    document.body.innerHTML = "";
    _resetDiagramSharedStoreForTests();
  });

  it("stays hidden for freeform objects", () => {
    const doc = docOf("lifecycle");
    render({ ...doc, nodes: [...doc.nodes, { id: "note", kind: "text", x: 0, y: 0, w: 20, h: 20 }] }, { nodes: ["note"] });
    expect(q("semantic-props")).toBeNull();
  });

  it("reorders a sequence message and follows undo", async () => {
    render(docOf("sequence"), { edges: ["msg3"] });
    expect(q("semantic-order")!.textContent).toBe("3/4");
    await click("semantic-move-earlier");
    expect(q("semantic-order")!.textContent).toBe("2/4");
    act(() => probe!.setState(undo()));
    expect(q("semantic-order")!.textContent).toBe("3/4");
  });

  it("changes a lifecycle state type, and a property-panel rename shows in the inspector", async () => {
    render(docOf("lifecycle"), { nodes: ["running"] });
    await changeSelect("semantic-state-type", "decision");
    expect(probe!.getState().doc.nodes.find((n) => n.id === "running")?.kind).toBe("diamond");

    const titleInput = [...document.body.querySelectorAll<HTMLLabelElement>("label.maru-diagram-prop")]
      .find((label) => label.textContent?.startsWith(ko("diagram.properties.title")))!
      .querySelector("input")!;
    await typeInto(titleInput, "Busy");
    expect(q("semantic-label")!.textContent).toBe("Busy");
    expect(specOf().states![1]!.label).toBe("Busy");
  });

  it("shows why a structural edit was refused", async () => {
    const doc = docOf("lifecycle");
    render(
      { ...doc, nodes: doc.nodes.map((n) => (n.id === "running" ? { ...n, locked: true } : n)) },
      { nodes: ["running"] },
    );
    await changeSelect("semantic-state-type", "decision");
    expect(q("semantic-status")!.textContent).toBe(ko("diagram.proposal.lockedNode", { id: "running" }));
    expect(specOf().states![1]!.type).toBe("active");
  });

  it("edits a classification and detaches with a loss list", async () => {
    render(docOf("dataflow"), { edges: ["flow1"] });
    const input = q<HTMLInputElement>("semantic-classification")!;
    expect(input.value).toBe("PII");
    await typeInto(input, "internal");
    await act(async () => {
      input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(specOf().flows![0]!.classification).toBe("internal");

    await click("semantic-detach");
    const message = vi.mocked(confirmDialog).mock.calls[0]![0];
    expect(message).toContain(ko("diagram.semantic.loss.stages", { count: 2 }));
    expect(message).toContain(ko("diagram.semantic.loss.classifications", { count: 1 }));
    expect(probe!.getState().doc.datasets).toEqual([]);
    expect(q("semantic-props")).toBeNull();

    act(() => probe!.setState(undo()));
    expect(q("semantic-props")).not.toBeNull();
  });
});
