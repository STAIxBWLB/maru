import { describe, expect, it, vi } from "vitest";

import { createDiagramStore } from "./state";
import { createEmptyDoc } from "./types";

describe("createDiagramStore", () => {
  it("returns the initial state via getState()", () => {
    const store = createDiagramStore({ doc: createEmptyDoc("seed", 1) });
    expect(store.getState().doc.id).toBe("seed");
  });

  it("notifies subscribers on setState", () => {
    const store = createDiagramStore({ doc: createEmptyDoc("seed", 1) });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.setState((s) => ({ ...s, doc: { ...s.doc, docTitle: "Hello" } }));
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
    store.setState((s) => ({ ...s, doc: { ...s.doc, docTitle: "Hello 2" } }));
    expect(listener).toHaveBeenCalledOnce(); // not called after unsubscribe
  });

  it("subscribeSelector only fires when the selected slice changes", () => {
    const store = createDiagramStore({ doc: createEmptyDoc("seed", 1) });
    const listener = vi.fn();
    store.subscribeSelector((s) => s.doc.docTitle, listener);
    store.setState((s) => ({
      ...s,
      ephemeral: { ...s.ephemeral, viewport: { ...s.ephemeral.viewport, zoom: 2 } },
    }));
    expect(listener).not.toHaveBeenCalled();
    store.setState((s) => ({ ...s, doc: { ...s.doc, docTitle: "Updated" } }));
    expect(listener).toHaveBeenCalledWith("Updated");
  });
});
