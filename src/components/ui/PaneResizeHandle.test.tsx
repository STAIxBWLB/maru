// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "./PaneResizeHandle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

function pointerEvent(
  type: string,
  init: { pointerId: number; clientX?: number; clientY?: number },
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  for (const [name, value] of Object.entries(init)) {
    Object.defineProperty(event, name, { configurable: true, value });
  }
  return event;
}

function mockPointerCapture(handle: HTMLElement) {
  const captured = new Set<number>();
  const setPointerCapture = vi.fn((pointerId: number) => captured.add(pointerId));
  const hasPointerCapture = vi.fn((pointerId: number) => captured.has(pointerId));
  const releasePointerCapture = vi.fn((pointerId: number) => captured.delete(pointerId));
  Object.defineProperties(handle, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: hasPointerCapture },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { setPointerCapture, hasPointerCapture, releasePointerCapture };
}

async function dispatchPointer(target: EventTarget, event: Event) {
  await act(async () => {
    target.dispatchEvent(event);
  });
}

describe("PaneResizeHandle", () => {
  it("supports keyboard steps, bounds, and reset", async () => {
    const onCommit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={setValue}
          onCommit={onCommit}
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("252");
    expect(onCommit).toHaveBeenLastCalledWith(252);

    await act(async () => {
      handle.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
      );
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("360");

    await act(async () => {
      handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    expect(onCommit).toHaveBeenLastCalledWith(240);

    await act(async () => root.unmount());
  });

  it("uses vertical movement and arrow keys for a horizontal separator", async () => {
    const onCommit = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(260);
      return (
        <PaneResizeHandle
          label="Resize height"
          orientation="horizontal"
          value={value}
          min={160}
          max={520}
          defaultValue={260}
          onChange={setValue}
          onCommit={onCommit}
        />
      );
    }

    await act(async () => {
      root.render(<Harness />);
    });
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");

    await act(async () => {
      handle.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(handle.getAttribute("aria-valuenow")).toBe("272");
    expect(onCommit).toHaveBeenLastCalledWith(272);

    await act(async () => root.unmount());
  });

  it("commits the current value on pointerup and ignores duplicate endings", async () => {
    const changes: number[] = [];
    const commits: number[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onCommit={(next) => commits.push(next)}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    const capture = mockPointerCapture(handle);
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 1, clientX: 100 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 1, clientX: 160 }));
    expect(handle.getAttribute("aria-valuenow")).toBe("300");
    expect(commits).toEqual([]);

    await dispatchPointer(window, pointerEvent("pointerup", { pointerId: 1, clientX: 160 }));
    await dispatchPointer(window, pointerEvent("pointerup", { pointerId: 1, clientX: 160 }));
    expect(commits).toEqual([300]);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(1);

    await act(async () => root.unmount());
  });

  it("restores and commits the start value on lost capture", async () => {
    const changes: number[] = [];
    const commits: number[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onCommit={(next) => commits.push(next)}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 2, clientX: 100 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 2, clientX: 150 }));
    await dispatchPointer(handle, pointerEvent("lostpointercapture", { pointerId: 2 }));
    await dispatchPointer(window, pointerEvent("pointerup", { pointerId: 2, clientX: 150 }));

    expect(changes).toEqual([290, 240]);
    expect(commits).toEqual([240]);
    expect(handle.getAttribute("aria-valuenow")).toBe("240");
    await act(async () => root.unmount());
  });

  it.each([
    ["blur", () => window.dispatchEvent(new Event("blur"))],
    ["pagehide", () => window.dispatchEvent(new Event("pagehide"))],
  ])("cancels an active drag on %s", async (_name, interrupt) => {
    const commits: number[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={setValue}
          onCommit={(next) => commits.push(next)}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 3, clientX: 100 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 3, clientX: 140 }));
    await act(async () => interrupt());
    expect(commits).toEqual([240]);
    await act(async () => root.unmount());
  });

  it("cancels on hidden visibility and starts a replacement drag from the restored value", async () => {
    const commits: number[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={setValue}
          onCommit={(next) => commits.push(next)}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    mockPointerCapture(handle);
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 4, clientX: 100 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 4, clientX: 150 }));
    const previousVisibility = document.visibilityState;
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    });
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(commits).toEqual([240]);

    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: previousVisibility,
    });
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 5, clientX: 200 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 5, clientX: 220 }));
    await dispatchPointer(window, pointerEvent("pointerup", { pointerId: 5, clientX: 220 }));
    expect(commits).toEqual([240, 260]);
    await act(async () => root.unmount());
  });

  it("cleans up an active drag on unmount without updating React state", async () => {
    const changes: number[] = [];
    const commits: number[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    function Harness() {
      const [value, setValue] = useState(240);
      return (
        <PaneResizeHandle
          label="Resize"
          value={value}
          min={180}
          max={360}
          defaultValue={240}
          onChange={(next) => {
            changes.push(next);
            setValue(next);
          }}
          onCommit={(next) => commits.push(next)}
        />
      );
    }

    await act(async () => root.render(<Harness />));
    const handle = container.querySelector<HTMLElement>('[role="separator"]')!;
    const capture = mockPointerCapture(handle);
    await dispatchPointer(handle, pointerEvent("pointerdown", { pointerId: 6, clientX: 100 }));
    await dispatchPointer(window, pointerEvent("pointermove", { pointerId: 6, clientX: 140 }));
    const changesBeforeUnmount = changes.length;
    const commitsBeforeUnmount = commits.length;
    await act(async () => root.unmount());
    await dispatchPointer(window, pointerEvent("pointerup", { pointerId: 6, clientX: 140 }));
    window.dispatchEvent(new Event("blur"));

    expect(changes).toHaveLength(changesBeforeUnmount);
    expect(commits).toHaveLength(commitsBeforeUnmount);
    expect(capture.releasePointerCapture).toHaveBeenCalledWith(6);
  });
});
