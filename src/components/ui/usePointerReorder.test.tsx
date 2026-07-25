// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { usePointerReorder } from "./usePointerReorder";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pointer(
  type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel",
  clientY: number,
) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
    clientX: 10,
    clientY,
  });
  Object.defineProperty(event, "pointerId", { value: 7 });
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("usePointerReorder", () => {
  it("commits once against the stationary row below the lifted row", async () => {
    const onCommit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const reorder = usePointerReorder({
        items: ["a", "b", "c"],
        getId: (item) => item,
        onCommit,
      });
      return (
        <div>
          {["a", "b", "c"].map((id) => {
            const state = reorder.rowState(id);
            return (
              <div key={id} data-reorder-id={id} style={state.style}>
                <button
                  type="button"
                  data-handle={id}
                  onPointerDown={(event) => reorder.begin(event, id)}
                >
                  {id}
                </button>
              </div>
            );
          })}
        </div>
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[data-handle="a"]')!;
    const draggedRow = container.querySelector<HTMLElement>('[data-reorder-id="a"]')!;
    const targetRow = container.querySelector<HTMLElement>('[data-reorder-id="b"]')!;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({
      top: 20,
      bottom: 40,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [draggedRow, targetRow]),
    });

    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10));
      handle.dispatchEvent(pointer("pointermove", 35));
      handle.dispatchEvent(pointer("pointerup", 35));
    });

    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0][0]).toMatchObject({
      items: ["b", "a", "c"],
      draggedId: "a",
      targetId: "b",
      fromIndex: 0,
      toIndex: 1,
    });

    await act(async () => root.unmount());
  });

  it("stays visually at rest until the drag passes the hysteresis threshold", async () => {
    const seen: boolean[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const reorder = usePointerReorder({
        items: ["a", "b"],
        getId: (item) => item,
        onCommit: () => {},
      });
      seen.push(reorder.rowState("a").dragging);
      return (
        <button
          type="button"
          data-reorder-id="a"
          onPointerDown={(event) => reorder.begin(event, "a")}
        >
          a
        </button>
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>("button")!;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });

    // A plain click: press and release without crossing the 8px threshold.
    // Each event is flushed separately — batching them would hide the very
    // intermediate render this asserts against.
    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10));
    });
    await act(async () => {
      handle.dispatchEvent(pointer("pointermove", 13));
    });
    await act(async () => {
      handle.dispatchEvent(pointer("pointerup", 13));
    });

    expect(seen).not.toContain(true);
    await act(async () => root.unmount());
  });

  it("abandons an in-flight drag on Escape without committing", async () => {
    const onCommit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const reorder = usePointerReorder({
        items: ["a", "b"],
        getId: (item) => item,
        onCommit,
      });
      return (
        <div>
          {["a", "b"].map((id) => (
            <div key={id} data-reorder-id={id}>
              <button
                type="button"
                data-handle={id}
                onPointerDown={(event) => reorder.begin(event, id)}
              >
                {id}
              </button>
            </div>
          ))}
        </div>
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[data-handle="a"]')!;
    const draggedRow = container.querySelector<HTMLElement>('[data-reorder-id="a"]')!;
    const targetRow = container.querySelector<HTMLElement>('[data-reorder-id="b"]')!;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });
    vi.spyOn(targetRow, "getBoundingClientRect").mockReturnValue({
      top: 20,
      bottom: 40,
      left: 0,
      right: 100,
      width: 100,
      height: 20,
      x: 0,
      y: 20,
      toJSON: () => ({}),
    });
    Object.defineProperty(document, "elementsFromPoint", {
      configurable: true,
      value: vi.fn(() => [draggedRow, targetRow]),
    });

    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10));
      handle.dispatchEvent(pointer("pointermove", 35));
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
      );
      // The pointer is still down; releasing it must not resurrect the commit.
      handle.dispatchEvent(pointer("pointerup", 35));
    });

    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it("does not strand the Escape listener when unmounted mid-drag", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const reorder = usePointerReorder({
        items: ["a", "b"],
        getId: (item) => item,
        onCommit: () => {},
      });
      return (
        <button
          type="button"
          data-reorder-id="a"
          onPointerDown={(event) => reorder.begin(event, "a")}
        >
          a
        </button>
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>("button")!;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });

    const added = vi.spyOn(window, "addEventListener");
    const removed = vi.spyOn(window, "removeEventListener");

    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10));
    });
    expect(added.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);

    // The list is replaced out from under an in-flight drag.
    await act(async () => root.unmount());
    expect(removed.mock.calls.filter(([type]) => type === "keydown")).toHaveLength(1);
  });

  it("rolls back without committing on pointer cancellation", async () => {
    const onCommit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const reorder = usePointerReorder({
        items: ["a", "b"],
        getId: (item) => item,
        onCommit,
      });
      return (
        <button
          type="button"
          data-reorder-id="a"
          onPointerDown={(event) => reorder.begin(event, "a")}
        >
          a
        </button>
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>("button")!;
    Object.assign(handle, {
      setPointerCapture: vi.fn(),
      hasPointerCapture: vi.fn(() => false),
      releasePointerCapture: vi.fn(),
    });

    await act(async () => {
      handle.dispatchEvent(pointer("pointerdown", 10));
      handle.dispatchEvent(pointer("pointercancel", 30));
    });

    expect(onCommit).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
