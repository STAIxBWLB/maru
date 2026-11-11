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

// jsdom lacks pointer capture; each test decides whether it succeeds.
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
        <DiagramStoreProvider initial={{ doc }} storeKey={`canvas-capture-${keySeq}`}>
          <StoreProbe />
          <CanvasSurface />
        </DiagramStoreProvider>
      </LocaleContext.Provider>,
    );
  });
  return { container, root };
}

// jsdom has no PointerEvent constructor; the handlers read only the fields a
// MouseEvent carries.
async function pointerDownOn(target: Element): Promise<void> {
  await act(async () => {
    target.dispatchEvent(
      new MouseEvent("pointerdown", { bubbles: true, button: 0 } as MouseEventInit),
    );
  });
}

function memberIds(): string[] {
  return probe!.getState().doc.views![0]!.nodeIds;
}

describe("CanvasSurface pointer capture", () => {
  let harness: { container: HTMLDivElement; root: Root } | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
    window.confirm = vi.fn(() => false) as unknown as typeof window.confirm;
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness.container.remove();
      harness = null;
    }
  });

  // WebKit raises `NotFoundError` from setPointerCapture when the id no longer
  // names an active pointer (a gesture the platform cancelled or re-routed
  // mid-press). That refusal must cost only out-of-surface events, never the
  // press itself: the gesture below it still has to select and to clear.
  it("a refused capture still selects the pressed member", async () => {
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("The object can not be found here.", "NotFoundError");
      },
    });
    harness = renderCanvas();
    const target = memberIds()[0]!;
    expect(probe!.getState().ephemeral.selection.nodes.size).toBe(0);

    await pointerDownOn(document.body.querySelector(`[data-node-id="${target}"]`)!);

    expect([...probe!.getState().ephemeral.selection.nodes]).toEqual([target]);
  });

  it("a refused capture still lets the surface press clear the selection", async () => {
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: () => {
        throw new DOMException("The object can not be found here.", "NotFoundError");
      },
    });
    harness = renderCanvas();
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

    await pointerDownOn(document.body.querySelector(".maru-diagram-canvas")!);

    expect(probe!.getState().ephemeral.selection.nodes.size).toBe(0);
  });

  it("a successful capture changes nothing about the same press", async () => {
    Object.defineProperty(Element.prototype, "setPointerCapture", {
      configurable: true,
      value: () => {},
    });
    harness = renderCanvas();
    const target = memberIds()[0]!;

    await pointerDownOn(document.body.querySelector(`[data-node-id="${target}"]`)!);

    expect([...probe!.getState().ephemeral.selection.nodes]).toEqual([target]);
  });
});
