// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatElapsed, latestActivityLine, useElapsed } from "./missionProgress";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

describe("latestActivityLine", () => {
  it("returns the last non-empty line with the stream prefix stripped", () => {
    expect(
      latestActivityLine([
        "[stdout] Extracting files",
        "[stderr] warn: slow",
        "[stdout] Classifying item 3",
      ]),
    ).toBe("Classifying item 3");
  });

  it("skips blank and whitespace-only trailing lines", () => {
    expect(latestActivityLine(["[stdout] working", "[stdout]   ", "[stdout] "])).toBe("working");
  });

  it("returns null for empty or undefined input", () => {
    expect(latestActivityLine([])).toBeNull();
    expect(latestActivityLine(undefined)).toBeNull();
  });
});

describe("formatElapsed", () => {
  it("formats sub-minute durations as seconds", () => {
    expect(formatElapsed(0)).toBe("0s");
    expect(formatElapsed(5_000)).toBe("5s");
    expect(formatElapsed(-100)).toBe("0s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatElapsed(65_000)).toBe("1m 05s");
  });

  it("formats hours with zero-padded minutes", () => {
    expect(formatElapsed(3_725_000)).toBe("1h 02m");
  });
});

describe("useElapsed", () => {
  function ElapsedLabel({ startIso, active }: { startIso: string | null; active: boolean }) {
    return <span>{useElapsed(startIso, active) ?? "none"}</span>;
  }

  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-08T12:00:00Z"));
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) act(() => root?.unmount());
    root = null;
    container.remove();
    vi.useRealTimers();
  });

  it("shares one 1 Hz timer across consumers and ticks them together", () => {
    const startIso = new Date("2026-08-08T11:59:50Z").toISOString();
    root = createRoot(container);
    act(() => {
      root?.render(
        <>
          <ElapsedLabel startIso={startIso} active />
          <ElapsedLabel startIso={startIso} active />
        </>,
      );
    });
    expect(vi.getTimerCount()).toBe(1);
    expect(container.textContent).toBe("10s10s");

    act(() => {
      vi.advanceTimersByTime(1_000);
    });
    expect(container.textContent).toBe("11s11s");
  });

  it("stops the shared timer when the last active consumer unmounts", () => {
    const startIso = new Date("2026-08-08T11:59:50Z").toISOString();
    root = createRoot(container);
    act(() => {
      root?.render(<ElapsedLabel startIso={startIso} active />);
    });
    expect(vi.getTimerCount()).toBe(1);

    act(() => root?.unmount());
    root = null;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns null and never starts the timer while inactive or unparseable", () => {
    root = createRoot(container);
    act(() => {
      root?.render(
        <>
          <ElapsedLabel startIso={null} active />
          <ElapsedLabel startIso="not-a-date" active />
          <ElapsedLabel startIso={new Date().toISOString()} active={false} />
        </>,
      );
    });
    expect(container.textContent).toBe("nonenonenone");
    expect(vi.getTimerCount()).toBe(0);
  });
});
