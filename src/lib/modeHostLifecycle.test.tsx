// @vitest-environment jsdom

import { act, useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ModeHostPublisher } from "./modeHostLifecycle";

describe("ModeHostPublisher", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("publishes only after commit, without a render-phase warning or duplicate stable-host publication", async () => {
    let snapshot = 0;
    const listeners = new Set<() => void>();
    const controller = {
      bind: vi.fn(() => {
        snapshot += 1;
        listeners.forEach((listener) => listener());
      }),
    };
    const host = { id: "stable-host" };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    function Subscriber() {
      useSyncExternalStore(
        (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        () => snapshot,
        () => snapshot,
      );
      return null;
    }

    await act(async () => {
      root.render(<><ModeHostPublisher controller={controller} host={host} /><Subscriber /></>);
    });
    await act(async () => {
      root.render(<><ModeHostPublisher controller={controller} host={host} /><Subscriber /></>);
    });

    expect(controller.bind).toHaveBeenCalledTimes(1);
    expect(consoleError).not.toHaveBeenCalledWith(expect.stringContaining("Cannot update a component"));
    consoleError.mockRestore();
  });
});
