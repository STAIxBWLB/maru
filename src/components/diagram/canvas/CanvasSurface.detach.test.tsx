// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertPatternAt } from "../../../lib/diagram/patternStudio";
import type { DiagramStore } from "../../../lib/diagram/state";
import { createEmptyDoc } from "../../../lib/diagram/types";
import { LocaleContext, t as translate } from "../../../lib/i18n";
import {
  DiagramStoreProvider,
  _resetDiagramSharedStoreForTests,
  useDiagramStore,
} from "../DiagramStoreContext";
import { CanvasSurface } from "./CanvasSurface";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// jsdom lacks pointer capture.
(Element.prototype as { setPointerCapture?: unknown }).setPointerCapture = () => {};
(Element.prototype as { releasePointerCapture?: unknown }).releasePointerCapture = () => {};
(Element.prototype as { hasPointerCapture?: unknown }).hasPointerCapture = () => false;

let probe: DiagramStore | null = null;
function StoreProbe() {
  probe = useDiagramStore();
  return null;
}

let keySeq = 0;

function renderCanvas(): { container: HTMLDivElement; root: Root } {
  _resetDiagramSharedStoreForTests();
  const base = createEmptyDoc("doc-1", 1);
  // A hierarchy view: several members, so a single-node drag is a SUBSET.
  const { doc } = insertPatternAt(base, "report.problem-tree", { x: 400, y: 300 });
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
        <DiagramStoreProvider initial={{ doc }} storeKey={`canvas-detach-${keySeq}`}>
          <StoreProbe />
          <CanvasSurface />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

// Async act: the detach prompt is answered through confirmDialog.
async function pointerDownOn(nodeId: string): Promise<void> {
  const el = document.body.querySelector(`[data-node-id="${nodeId}"]`)!;
  await act(async () => {
    el.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit),
    );
  });
}

function memberIds(): string[] {
  return probe!.getState().doc.views![0]!.nodeIds;
}

describe("CanvasSurface detach prompt", () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null;
  let confirmSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.body.innerHTML = "";
    confirmSpy = vi.fn(() => false);
    window.confirm = confirmSpy as unknown as typeof window.confirm;
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
  });

  it("cancel aborts the drag and keeps the view link", async () => {
    confirmSpy.mockReturnValue(false);
    harness = renderCanvas();
    const target = memberIds()[0]!;
    await pointerDownOn(target);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const state = probe!.getState();
    const node = state.doc.nodes.find((n) => n.id === target)!;
    expect(node.meta?.viewId).toBe(state.doc.views![0]!.id);
    expect(node.meta?.snippet).toBeUndefined();
    expect(state.doc.views![0]!.nodeIds).toContain(target);
  });

  it("confirm detaches the subset; the next press drags it", async () => {
    confirmSpy.mockReturnValue(true);
    harness = renderCanvas();
    const target = memberIds()[0]!;
    const viewId = probe!.getState().doc.views![0]!.id;
    await pointerDownOn(target);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
    const state = probe!.getState();
    const node = state.doc.nodes.find((n) => n.id === target)!;
    expect(node.meta?.viewId).toBeUndefined();
    expect(node.meta?.snippet).toBe(true);
    expect(state.doc.views![0]!.nodeIds).not.toContain(target);
    expect(state.doc.views![0]!.id).toBe(viewId);
    // Detached, the node is no longer a view subset: pressing it again asks nothing.
    await pointerDownOn(target);
    expect(confirmSpy).toHaveBeenCalledTimes(1);
  });

  it("a whole-membership drag stays linked (no prompt)", async () => {
    harness = renderCanvas();
    // Select every member first: a marquee-free way is dispatching setSelection
    // through the store, then dragging one of them drags the whole selection.
    const ids = memberIds();
    act(() => {
      probe!.setState((state) => ({
        ...state,
        ephemeral: {
          ...state.ephemeral,
          selection: { nodes: new Set(ids), edges: new Set() },
        },
      }));
    });
    await pointerDownOn(ids[0]!);
    expect(confirmSpy).not.toHaveBeenCalled();
  });
});
