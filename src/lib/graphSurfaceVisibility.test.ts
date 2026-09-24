// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  GRAPH_SUSPEND_GRACE_MS,
  graphPanelMounted,
  graphSuspendGraceMs,
  useSuspendedAfter,
} from "./graphSurfaceVisibility";

describe("graphPanelMounted", () => {
  it("unmounts when the panel closes even while Graph is the selected surface (#327)", () => {
    expect(graphPanelMounted(true, false, "graph")).toBe(false);
    expect(graphPanelMounted(true, false, "terminal")).toBe(false);
  });

  it("mounts on the graph surface and keeps alive across surface toggles while open", () => {
    expect(graphPanelMounted(false, true, "graph")).toBe(true);
    expect(graphPanelMounted(true, true, "terminal")).toBe(true);
    expect(graphPanelMounted(false, true, "terminal")).toBe(false);
  });
});

describe("graphSuspendGraceMs", () => {
  afterEach(() => window.localStorage.clear());

  it("falls back to the constant without a valid override", () => {
    expect(graphSuspendGraceMs()).toBe(GRAPH_SUSPEND_GRACE_MS);
    window.localStorage.setItem("maru:graph-suspend-grace-ms", "nope");
    expect(graphSuspendGraceMs()).toBe(GRAPH_SUSPEND_GRACE_MS);
    window.localStorage.setItem("maru:graph-suspend-grace-ms", "-5");
    expect(graphSuspendGraceMs()).toBe(GRAPH_SUSPEND_GRACE_MS);
  });

  it("honours a non-negative integer override", () => {
    window.localStorage.setItem("maru:graph-suspend-grace-ms", "250");
    expect(graphSuspendGraceMs()).toBe(250);
  });
});

/** Minimal renderHook: mounts a probe component and exposes the latest value. */
function renderHook<P, R>(hook: (props: P) => R, initialProps: P) {
  const result = { current: undefined as unknown as R };
  const host = document.createElement("div");
  const root = createRoot(host);
  function Probe(props: { value: P }) {
    result.current = hook(props.value);
    return null;
  }
  const rerender = (props: P) => void act(() => root.render(createElement(Probe, { value: props })));
  rerender(initialProps);
  return { result, rerender, unmount: () => void act(() => root.unmount()) };
}

describe("useSuspendedAfter", () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  it("suspends only after the grace elapses and clears immediately on reveal", () => {
    const { result, rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) => useSuspendedAfter(hidden, 1000),
      { hidden: false },
    );
    expect(result.current).toBe(false);
    rerender({ hidden: true });
    void act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(false);
    void act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(true);
    rerender({ hidden: false });
    expect(result.current).toBe(false);
  });

  it("does not suspend when revealed before the grace elapses", () => {
    const { result, rerender } = renderHook(
      ({ hidden }: { hidden: boolean }) => useSuspendedAfter(hidden, 1000),
      { hidden: true },
    );
    void act(() => vi.advanceTimersByTime(500));
    rerender({ hidden: false });
    void act(() => vi.advanceTimersByTime(1000));
    expect(result.current).toBe(false);
  });
});
