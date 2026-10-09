// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unmountReactRoot } from "../../../lib/testing/unmountReactRoot";

import { confirmDialog } from "../../../lib/confirmDialog";
import { withSnapshot } from "../../../lib/diagram/actions";
import type { GenerationHost } from "../../../lib/diagram/generation";
import { SEMANTIC_FIXTURES } from "../../../lib/diagram/__fixtures__/semantic";
import { archifySpecToDataset } from "../../../lib/diagram/archifyCodec";
import { isSemanticSpecDataset, type SemanticSpecDataset } from "../../../lib/diagram/reportTypes";
import { projectSemanticDocument } from "../../../lib/diagram/semantic";
import type { DiagramStore } from "../../../lib/diagram/state";
import {
  createEmptyDoc,
  createInitialEphemeral,
  type DiagramDoc,
  type DiagramNode,
} from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import "../../../lib/i18n/testing";
import {
  DiagramStoreProvider,
  _resetDiagramSharedStoreForTests,
  useDiagramStore,
} from "../DiagramStoreContext";
import { GenerateDiagramDialog } from "./GenerateDiagramDialog";

vi.mock("../../../lib/confirmDialog", () => ({ confirmDialog: vi.fn(async () => true) }));

vi.mock("../../../lib/diagram/actions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../lib/diagram/actions")>();
  return { ...actual, withSnapshot: vi.fn(actual.withSnapshot) };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const withSnapshotSpy = vi.mocked(withSnapshot);

let probe: DiagramStore | null = null;
function StoreProbe() {
  probe = useDiagramStore();
  return null;
}

function node(id: string, title: string, locked = false): DiagramNode {
  return { id, kind: "simple", x: 0, y: 0, w: 160, h: 64, title, ...(locked ? { locked: true } : {}) };
}

const ARCH_SPEC = {
  schema_version: 1,
  diagram_type: "architecture",
  meta: { title: "Generated", output: "generated.html" },
  components: [
    { id: "web", type: "frontend", label: "Web" },
    { id: "db", type: "database", label: "Database" },
  ],
  connections: [{ from: "web", to: "db" }],
};

type StubHost = GenerationHost & { cancel?: () => void };

function stubHost(overrides: Partial<GenerationHost> = {}): StubHost {
  return {
    runAgent: vi.fn(async () => JSON.stringify(ARCH_SPEC)),
    validateCandidate: vi.fn(async () => ({ ok: true, errors: [], warnings: [] })),
    ...overrides,
  };
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onImportDoc: ReturnType<typeof vi.fn>;
  onClose: ReturnType<typeof vi.fn>;
}

interface RenderOpts {
  doc?: DiagramDoc;
  dirty?: boolean;
  selection?: string[];
  host?: StubHost;
}

let keySeq = 0;

function renderDialog(opts: RenderOpts = {}): Harness {
  const onImportDoc = vi.fn();
  const onClose = vi.fn();
  const doc = opts.doc ?? createEmptyDoc(`doc-gen-${keySeq}`, 1);
  const ephemeral = {
    ...createInitialEphemeral(),
    selection: { nodes: new Set(opts.selection ?? []), edges: new Set<string>() },
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  keySeq += 1;
  act(() => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <DiagramStoreProvider initial={{ doc, ephemeral }} storeKey={`gen-dialog-test-${keySeq}`}>
          <StoreProbe />
          <GenerateDiagramDialog
            open
            dirty={opts.dirty ?? false}
            selectionNodeIds={opts.selection ?? []}
            workPath={null}
            hostOverride={opts.host ?? null}
            onImportDoc={onImportDoc}
            onClose={onClose}
          />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root, onImportDoc, onClose };
}

function query<T extends Element>(selector: string): T | null {
  return document.body.querySelector<T>(selector);
}

async function click(el: Element) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function setTextarea(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function runGeneration() {
  await setTextarea(query<HTMLTextAreaElement>('[data-testid="gen-requirements"]')!, "요구 사항");
  await click(query('[data-testid="gen-run"]')!);
  await vi.waitFor(() => {
    const status = query('[data-testid="gen-status"]');
    const preview = query('[data-testid="gen-preview"]');
    const failed = query('[data-testid="gen-failed"]');
    expect(status !== null || preview !== null || failed !== null).toBe(true);
  });
}

describe("GenerateDiagramDialog", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    probe = null;
    _resetDiagramSharedStoreForTests();
    withSnapshotSpy.mockClear();
  });

  afterEach(async () => {
    if (harness) {
      await unmountReactRoot(harness.root);
      harness.container.remove();
      harness = null;
    }
    document.body.innerHTML = "";
    vi.mocked(confirmDialog).mockReset();
    vi.mocked(confirmDialog).mockResolvedValue(true);
    _resetDiagramSharedStoreForTests();
  });

  it("renders the form and the new-diagram scope hint", () => {
    harness = renderDialog();
    expect(document.body.textContent).toContain(translate("ko", "diagram.generate.title"));
    expect(query('[data-testid="gen-scope"]')!.textContent).toBe(
      translate("ko", "diagram.generate.scopeNew"),
    );
    const typeSelect = query<HTMLSelectElement>('[data-testid="gen-type-select"]')!;
    expect([...typeSelect.options].map((o) => o.value)).toEqual([
      "architecture",
      "workflow",
      "sequence",
      "dataflow",
      "lifecycle",
    ]);
    expect(query('[data-testid="gen-requirements"]')).not.toBeNull();
    expect(query('[data-testid="gen-mermaid"]')).not.toBeNull();
    expect(query<HTMLSelectElement>('[data-testid="gen-locale-select"]')!.value).toBe("ko");
  });

  it("shows the scoped hint when opened with a selection", () => {
    const doc = { ...createEmptyDoc("doc-scoped", 1), nodes: [node("n1", "One"), node("n2", "Two")] };
    harness = renderDialog({ doc, selection: ["n1", "n2"] });
    expect(query('[data-testid="gen-scope"]')!.textContent).toBe(
      translate("ko", "diagram.generate.scopeSelection", { count: 2 }),
    );
  });

  it("switches the diagram type picker", async () => {
    harness = renderDialog();
    const select = query<HTMLSelectElement>('[data-testid="gen-type-select"]')!;
    await act(async () => {
      select.value = "workflow";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(select.value).toBe("workflow");
  });

  it("runs with a stubbed host and previews the categorized diff", async () => {
    harness = renderDialog({ host: stubHost() });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-preview"]')).not.toBeNull());
    expect(query('[data-testid="gen-summary"]')!.textContent).toBe(
      translate("ko", "diagram.generate.summary", {
        type: translate("ko", "diagram.generate.typeArchitecture"),
        elements: 2,
        relations: 1,
      }),
    );
    expect(query('[data-testid="gen-diff-added"]')!.textContent).toContain("Web");
    expect(query('[data-testid="gen-diff-added"]')!.textContent).toContain("Database");
    expect(query('[data-testid="gen-apply-new"]')).not.toBeNull();
    expect((query<HTMLButtonElement>('[data-testid="gen-apply-new"]')!).disabled).toBe(false);
  });

  it("surfaces engine validation failure as the failed state", async () => {
    harness = renderDialog({
      host: stubHost({
        validateCandidate: vi.fn(async () => ({ ok: false, errors: ["bad spec"], warnings: [] })),
      }),
    });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-failed"]')).not.toBeNull());
    expect(query('[data-testid="gen-failed"]')!.textContent).toContain("bad spec");
    expect(query('[data-testid="gen-apply-new"]')).toBeNull();
  });

  it("disables Apply when the proposal carries blocking diagnostics", async () => {
    const doc = { ...createEmptyDoc("doc-locked", 1), nodes: [node("n1", "Original", true)] };
    const lockedSpec = {
      ...ARCH_SPEC,
      components: [{ id: "n1", type: "backend", label: "Renamed" }],
      connections: [],
    };
    harness = renderDialog({
      doc,
      selection: ["n1"],
      host: stubHost({ runAgent: vi.fn(async () => JSON.stringify(lockedSpec)) }),
    });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-preview"]')).not.toBeNull());
    expect(query('[data-testid="gen-blocking"]')!.textContent).toContain(
      translate("ko", "diagram.proposal.lockedNode", { id: "n1" }),
    );
    expect((query<HTMLButtonElement>('[data-testid="gen-apply-scoped"]')!).disabled).toBe(true);
  });

  it("apply-new hands onImportDoc a doc containing the semanticSpec dataset", async () => {
    harness = renderDialog({ host: stubHost() });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-apply-new"]')).not.toBeNull());
    await click(query('[data-testid="gen-apply-new"]')!);
    expect(harness.onImportDoc).toHaveBeenCalledTimes(1);
    const doc = harness.onImportDoc.mock.calls[0]![0] as DiagramDoc;
    expect(doc.nodes.length).toBe(2);
    expect(doc.edges.length).toBe(1);
    expect(doc.docTitle).toBe("Generated");
    const dataset = (doc.datasets ?? []).find(isSemanticSpecDataset);
    expect(dataset).toBeDefined();
    expect((dataset as SemanticSpecDataset).diagramType).toBe("architecture");
    expect(harness.onClose).toHaveBeenCalled();
  });

  it("preserves the dirty document and preview when new-generation replacement is cancelled", async () => {
    const original = { ...createEmptyDoc("dirty-generation", 1), nodes: [node("existing", "Unsaved")] };
    harness = renderDialog({ doc: original, dirty: true, host: stubHost() });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-apply-new"]')).not.toBeNull());
    await click(query('[data-testid="gen-apply-new"]')!);
    expect(confirmDialog).toHaveBeenCalledTimes(1);
    expect(harness.onImportDoc).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
    expect(probe!.getState().doc).toBe(original);
    expect(query('[data-testid="gen-preview"]')).not.toBeNull();
  });

  it("preserves the dirty document when Mermaid replacement is cancelled", async () => {
    const original = { ...createEmptyDoc("dirty-mermaid", 1), nodes: [node("existing", "Unsaved")] };
    harness = renderDialog({ doc: original, dirty: true });
    vi.mocked(confirmDialog).mockResolvedValueOnce(false);
    await setTextarea(query<HTMLTextAreaElement>('[data-testid="gen-mermaid"]')!, "flowchart TD\n A[Start] --> B[End]");
    await click(query('[data-testid="gen-from-mermaid"]')!);
    await click(query('[data-testid="gen-mermaid-apply"]')!);
    expect(harness.onImportDoc).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
    expect(probe!.getState().doc).toBe(original);
  });

  it("apply-scoped commits the transformer via withSnapshot exactly once", async () => {
    const doc = { ...createEmptyDoc("doc-apply", 1), nodes: [node("web", "Old Web")] };
    harness = renderDialog({ doc, selection: ["web"], host: stubHost() });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-apply-scoped"]')).not.toBeNull());
    withSnapshotSpy.mockClear();
    await click(query('[data-testid="gen-apply-scoped"]')!);
    expect(withSnapshotSpy).toHaveBeenCalledTimes(1);
    const applied = probe!.getState().doc;
    expect(applied.nodes.find((n) => n.id === "web")?.title).toBe("Web");
    expect((applied.datasets ?? []).some(isSemanticSpecDataset)).toBe(true);
    expect(harness.onClose).toHaveBeenCalled();
  });

  it("shows the stale state when the document moved after generation", async () => {
    const doc = { ...createEmptyDoc("doc-stale", 1), nodes: [node("web", "Old Web")] };
    harness = renderDialog({ doc, selection: ["web"], host: stubHost() });
    await runGeneration();
    await vi.waitFor(() => expect(query('[data-testid="gen-apply-scoped"]')).not.toBeNull());
    // The user edits the document after the job finished.
    act(() => {
      probe!.setState((current) => ({
        ...current,
        doc: { ...current.doc, nodes: [...current.doc.nodes, node("extra", "Extra")] },
      }));
    });
    await click(query('[data-testid="gen-apply-scoped"]')!);
    await vi.waitFor(() => expect(query('[data-testid="gen-stale"]')).not.toBeNull());
    expect(query('[data-testid="gen-stale"]')!.textContent).toBe(
      translate("ko", "diagram.generate.stale"),
    );
    expect(withSnapshotSpy).not.toHaveBeenCalled();
    expect(harness.onClose).not.toHaveBeenCalled();
  });

  describe("P2 semantic types (issue #433)", () => {
    const lifecycleDoc = (id = "ds-run") =>
      projectSemanticDocument(archifySpecToDataset("lifecycle", SEMANTIC_FIXTURES.lifecycle, { id }).dataset).doc;

    async function setSelect(el: HTMLSelectElement, value: string) {
      await act(async () => {
        el.value = value;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      });
    }

    it("auto-selects the type from a pasted Mermaid header", async () => {
      harness = renderDialog();
      const mermaid = query<HTMLTextAreaElement>('[data-testid="gen-mermaid"]')!;
      await setTextarea(mermaid, "sequenceDiagram\n  Alice->>Bob: hi");
      expect(query<HTMLSelectElement>('[data-testid="gen-type-select"]')!.value).toBe("sequence");
      await setTextarea(mermaid, "stateDiagram-v2\n  [*] --> A");
      expect(query<HTMLSelectElement>('[data-testid="gen-type-select"]')!.value).toBe("lifecycle");
    });

    it("shows Mermaid diagnostics and disables apply for a refused diagram type", async () => {
      harness = renderDialog();
      await setTextarea(query<HTMLTextAreaElement>('[data-testid="gen-mermaid"]')!, "sequenceDiagram\n  A->>B: hi");
      await click(query('[data-testid="gen-from-mermaid"]')!);
      expect(query('[data-testid="gen-mermaid-diagnostics"]')!.textContent).toContain(
        translate("ko", "diagram.mermaid.useGeneration", { type: "sequence" }),
      );
      expect(query<HTMLButtonElement>('[data-testid="gen-mermaid-apply"]')!.disabled).toBe(true);
    });

    it("previews counts and applies a new lifecycle diagram with its lane container", async () => {
      harness = renderDialog({ host: stubHost({ runAgent: vi.fn(async () => JSON.stringify(SEMANTIC_FIXTURES.lifecycle)) }) });
      await setSelect(query<HTMLSelectElement>('[data-testid="gen-type-select"]')!, "lifecycle");
      await runGeneration();
      await vi.waitFor(() => expect(query('[data-testid="gen-preview"]')).not.toBeNull());
      expect(query('[data-testid="gen-summary"]')!.textContent).toBe(
        translate("ko", "diagram.generate.summary", {
          type: translate("ko", "diagram.generate.typeLifecycle"),
          elements: 3,
          relations: 2,
        }),
      );
      await click(query('[data-testid="gen-apply-new"]')!);
      const doc = harness.onImportDoc.mock.calls[0]![0] as DiagramDoc;
      expect(doc.nodes.map((n) => n.id)).toEqual([`${doc.datasets![0]!.id}:lane:main`, "queued", "running", "done"]);
      expect(doc.edges.map((e) => e.id)).toEqual(["tr1", "tr2"]);
    });

    it("expands a member selection to its dataset, locks the type and regenerates in place", async () => {
      const doc = lifecycleDoc();
      const updated = structuredClone(SEMANTIC_FIXTURES.lifecycle);
      (updated.states as Record<string, unknown>[])[1]!.label = "Busy";
      const host = stubHost({ runAgent: vi.fn(async () => JSON.stringify(updated)) });
      harness = renderDialog({ doc, selection: ["running"], host });
      expect(query('[data-testid="gen-scope"]')!.textContent).toBe(
        translate("ko", "diagram.generate.scopeDataset", {
          type: translate("ko", "diagram.generate.typeLifecycle"),
          name: "Run",
          count: 4,
        }),
      );
      const typeSelect = query<HTMLSelectElement>('[data-testid="gen-type-select"]')!;
      expect([typeSelect.value, typeSelect.disabled]).toEqual(["lifecycle", true]);

      await runGeneration();
      await vi.waitFor(() => expect(query('[data-testid="gen-apply-scoped"]')).not.toBeNull());
      const prompt = vi.mocked(host.runAgent).mock.calls[0]![0];
      expect(prompt).toContain("<untrusted_current_spec>");
      withSnapshotSpy.mockClear();
      await click(query('[data-testid="gen-apply-scoped"]')!);
      expect(withSnapshotSpy).toHaveBeenCalledTimes(1);
      const applied = probe!.getState().doc;
      expect((applied.datasets ?? []).filter(isSemanticSpecDataset).map((d) => d.id)).toEqual(["ds-run"]);
      expect(applied.nodes.find((n) => n.id === "running")?.title).toBe("Busy");
    });

    it("cannot run on members of more than one dataset", async () => {
      const a = lifecycleDoc("ds-a");
      const b = projectSemanticDocument(archifySpecToDataset("dataflow", SEMANTIC_FIXTURES.dataflow, { id: "ds-b" }).dataset).doc;
      const doc = { ...a, nodes: [...a.nodes, ...b.nodes], edges: [...a.edges, ...b.edges], datasets: [...a.datasets!, ...b.datasets!] };
      harness = renderDialog({ doc, selection: ["running", "app"] });
      expect(query('[data-testid="gen-scope"]')!.textContent).toBe(translate("ko", "diagram.generate.multipleDatasets"));
      await setTextarea(query<HTMLTextAreaElement>('[data-testid="gen-requirements"]')!, "x");
      expect(query<HTMLButtonElement>('[data-testid="gen-run"]')!.disabled).toBe(true);
    });
  });
});
