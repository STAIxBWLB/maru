// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { confirmDialog, messageDialog } from "../../../lib/confirmDialog";
import { SEMANTIC_FIXTURES } from "../../../lib/diagram/__fixtures__/semantic";
import { pinnedEngineHost } from "../../../../e2e/helpers/diagramEngineHost";
import type { GenerationHost } from "../../../lib/diagram/generation";
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

vi.mock("../../../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true), messageDialog: vi.fn(async () => {}) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const validateCandidate = vi.fn<GenerationHost["validateCandidate"]>();
const hostOverride: GenerationHost = { runAgent: async () => "", validateCandidate };

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
        <DiagramStoreProvider initial={{ doc, ephemeral }} hostOverride={hostOverride} storeKey={`semantic-props-${seq}`}>
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
    validateCandidate.mockReset();
    validateCandidate.mockResolvedValue({ ok: true, errors: [], warnings: [] });
    _resetDiagramSharedStoreForTests();
    vi.mocked(messageDialog).mockClear();
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

  it.each([
    { type: "workflow", field: "phases", entry: { id: "build", label: "Build", fromCol: 0, toCol: 2 }, role: "phase", key: "build", count: 3 },
    { type: "workflow", field: "groups", entry: { id: "publish", label: "Publish", lane: "author", fromCol: 2, toCol: 2 }, role: "group", key: "publish", count: 1 },
    { type: "sequence", field: "segments", entry: { label: "Lookup", from: 170, to: 290 }, role: "segment", key: "0", count: 3 },
    { type: "sequence", field: "activations", entry: { participant: "api", from: 180, to: 280 }, role: "activation", key: "0", count: 3 },
  ] as const)("shows $role semantics and membership counts", ({ type, field, entry, role, key, count }) => {
    const spec = { ...structuredClone(SEMANTIC_FIXTURES[type]), [field]: [entry] };
    const doc = projectSemanticDocument(archifySpecToDataset(type, spec, { id: "ds" }).dataset).doc;
    render(doc, { nodes: [`ds:${role}:${key}`] });
    const text = q("semantic-props")!.textContent!;
    expect(text).toContain(ko(`diagram.semantic.role.${role}`));
    expect(text).toContain(`${ko("diagram.semantic.members")}${count}`);
    expect(q("semantic-label")!.textContent).toBe("label" in entry ? entry.label : "API");
  });

  it.each(["architecture", "workflow", "sequence", "dataflow", "lifecycle"] as const)("adds a %s member from typed controls with one undo", async (type) => {
    const doc = docOf(type);
    const member = doc.nodes.find((node) => node.kind !== "section")!;
    render(doc, { nodes: [member.id] });
    await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Extra");
    if (q("semantic-add-col")) await typeInto(q<HTMLInputElement>("semantic-add-col")!, "3");
    await click("semantic-add-confirm");
    expect(probe!.getState().doc.nodes).toHaveLength(doc.nodes.length + 1);
    expect(probe!.getState().doc.nodes.some((node) => node.title === "Extra")).toBe(true);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it("adds a sequence message and restores its exact edges in one undo", async () => {
    const doc = docOf("sequence");
    render(doc, { nodes: ["web"] });
    await changeSelect("semantic-add-collection", "messages");
    await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Another request");
    await click("semantic-add-confirm");
    expect(probe!.getState().doc.edges).toHaveLength(doc.edges.length + 1);
    expect(probe!.getState().doc.edges.some((edge) => edge.label === "Another request")).toBe(true);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it.each([
    { type: "workflow", field: "phases" }, { type: "workflow", field: "groups" },
    { type: "sequence", field: "segments" }, { type: "sequence", field: "activations" },
    { type: "dataflow", field: "stages" }, { type: "lifecycle", field: "lanes" },
    { type: "architecture", field: "boundaries" },
  ] as const)("adds a $field container through typed controls", async ({ type, field }) => {
    const doc = docOf(type);
    render(doc, { nodes: [doc.nodes.find((node) => node.kind !== "section")!.id] });
    await changeSelect("semantic-add-collection", field);
    if (q("semantic-add-label")) await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Extra frame");
    if (field === "boundaries") {
      const checkbox = q("semantic-structure")!.querySelector<HTMLInputElement>('input[type="checkbox"][value="web"]')!;
      await act(async () => { checkbox.click(); });
    }
    await click("semantic-add-confirm");
    expect(probe!.getState().doc.nodes).toHaveLength(doc.nodes.length + 1);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it("refuses the engine's rejection without writing a doc or undo entry", async () => {
    const doc = docOf("lifecycle");
    render(doc, { nodes: ["running"] });
    validateCandidate.mockResolvedValueOnce({ ok: false, errors: ["renderer rule rejected this candidate"], warnings: [] });
    await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Rejected state");
    await click("semantic-add-confirm");
    expect(validateCandidate).toHaveBeenCalled();
    expect(probe!.getState().doc).toBe(doc);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
    expect(q("semantic-status")!.textContent).toContain("renderer rule rejected this candidate");
  });

  it("shows the main-lane removal reason without allowing confirmation", () => {
    render(docOf("lifecycle"), { nodes: ["ds:lane:main"] });
    expect(q<HTMLButtonElement>("semantic-remove")!.disabled).toBe(true);
    expect(q("semantic-structure")!.textContent).toContain(ko("diagram.semantic.reservedMainLane"));
  });

  it("bounds architecture columns by layout.cols before apply", async () => {
    const spec = { ...structuredClone(SEMANTIC_FIXTURES.architecture), layout: { mode: "grid", cols: 4 } };
    const doc = projectSemanticDocument(archifySpecToDataset("architecture", spec, { id: "ds" }).dataset).doc;
    render(doc, { nodes: ["api"] });
    await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Outside grid");
    await typeInto(q<HTMLInputElement>("semantic-add-col")!, "4");
    expect(q<HTMLInputElement>("semantic-add-col")!.max).toBe("3");
    expect(q<HTMLButtonElement>("semantic-add-confirm")!.disabled).toBe(true);
    expect(validateCandidate).not.toHaveBeenCalled();
    expect(probe!.getState().doc).toBe(doc);
  });

  it("uses the same annotation preview for inspector removal as Delete", async () => {
    const base = docOf("lifecycle");
    const doc = { ...base, edges: [...base.edges, { id: "annotation", fromNode: "running", fromPort: "e" as const, toNode: "done", toPort: "w" as const, label: "Shared note" }] };
    render(doc, { nodes: ["running"] });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await click("semantic-remove");
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toContain("Shared note (annotation)");
    expect(probe!.getState().doc).toBe(doc);
  });

  it("adds a free-placement architecture component at a free position through the engine gate", async () => {
    const spec = structuredClone(SEMANTIC_FIXTURES.architecture);
    delete spec.layout;
    spec.components = (spec.components as Record<string, unknown>[]).map((entry, index) => ({ id: entry.id, type: entry.type, label: entry.label, pos: [40 + index * 200, 200], size: [160, 64] }));
    expect((await pinnedEngineHost.validateCandidate("architecture", spec)).ok).toBe(true);
    validateCandidate.mockImplementation(pinnedEngineHost.validateCandidate);
    const doc = projectSemanticDocument(archifySpecToDataset("architecture", spec, { id: "ds" }).dataset).doc;
    render(doc, { nodes: ["api"] });
    expect(q("semantic-add-col")).toBeNull();
    expect(q<HTMLInputElement>("semantic-add-x")!.value).toBe("630");
    expect(q<HTMLInputElement>("semantic-add-y")!.value).toBe("200");
    await typeInto(q<HTMLInputElement>("semantic-add-label")!, "Cache");
    await click("semantic-add-confirm");
    expect(specOf().components!.at(-1)).toMatchObject({ pos: [630, 200], size: [160, 64] });
    expect(probe!.getState().doc.nodes.find((node) => node.title === "Cache")).toMatchObject({ x: 630, y: 200 });
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it("previews a remove cascade and keeps the dataset through apply and undo", async () => {
    const doc = docOf("lifecycle");
    render(doc, { nodes: ["running"] });
    await click("semantic-remove");
    expect(vi.mocked(confirmDialog).mock.calls[0]![0]).toContain(ko("diagram.semantic.collection.transitions"));
    expect(probe!.getState().doc.nodes.some((node) => node.id === "running")).toBe(false);
    expect(probe!.getState().doc.edges).toHaveLength(0);
    expect(probe!.getState().doc.datasets).toHaveLength(1);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it("cancels a remove without touching the doc or history", async () => {
    const doc = docOf("lifecycle");
    render(doc, { nodes: ["running"] });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await click("semantic-remove");
    expect(probe!.getState().doc).toBe(doc);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(0);
  });

  it("does not apply an index-based removal after confirmation becomes stale", async () => {
    const doc = docOf("lifecycle");
    render(doc, { nodes: ["running"] });
    let settle!: (answer: boolean) => void;
    vi.mocked(confirmDialog).mockImplementationOnce(() => new Promise((resolve) => { settle = resolve; }));
    await click("semantic-remove");
    act(() => probe!.setState((state) => ({ ...state, doc: { ...state.doc, docTitle: "Changed" } })));
    const changed = probe!.getState().doc;
    await act(async () => { settle(true); });
    expect(probe!.getState().doc).toBe(changed);
    expect(messageDialog).toHaveBeenCalledWith(ko("diagram.semantic.editStale"), "warning");
  });

  it("edits wraps membership as one spec edit and updates the boundary", async () => {
    const doc = docOf("architecture");
    render(doc, { nodes: ["ds:boundary:0"] });
    const before = doc.nodes.find((node) => node.id === "ds:boundary:0")!;
    const checkbox = q("semantic-structure")!.querySelector<HTMLInputElement>('input[type="checkbox"][value="web"]')!;
    await act(async () => { checkbox.click(); });
    await click("semantic-apply-membership");
    expect(specOf().boundaries![0]!.wraps).toEqual(["api", "db", "web"]);
    const after = probe!.getState().doc.nodes.find((node) => node.id === "ds:boundary:0")!;
    expect(after.w).toBeGreaterThanOrEqual(before.w);
    expect(probe!.getState().ephemeral.history.past).toHaveLength(1);
    act(() => probe!.setState(undo()));
    expect(probe!.getState().doc).toEqual(doc);
  });

  it("edits a workflow phase range and refuses a reversed range", async () => {
    const spec = { ...structuredClone(SEMANTIC_FIXTURES.workflow), phases: [{ id: "build", label: "Build", fromCol: 0, toCol: 1 }] };
    const doc = projectSemanticDocument(archifySpecToDataset("workflow", spec, { id: "ds" }).dataset).doc;
    render(doc, { nodes: ["ds:phase:build"] });
    await typeInto(q<HTMLInputElement>("semantic-range-to")!, "2");
    await click("semantic-apply-range");
    expect(specOf().phases![0]!.toCol).toBe(2);
    const applied = probe!.getState().doc;
    await typeInto(q<HTMLInputElement>("semantic-range-from")!, "3");
    await click("semantic-apply-range");
    expect(probe!.getState().doc).toBe(applied);
    expect(q("semantic-status")!.textContent).toContain(ko("diagram.semantic.invalidRange", { field: "phases[0]" }));
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
    expect(q("semantic-status")!.textContent).toBe(ko("diagram.semantic.editRefused") + ko("diagram.proposal.lockedNode", { id: "running" }));
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
