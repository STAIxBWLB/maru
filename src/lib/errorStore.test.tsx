// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { clearError, resolveErrorValue, setError, useError, type ErrorValue } from "./errorStore";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

function Probe({ onValue }: { onValue: (error: ErrorValue) => void }) {
  onValue(useError());
  return null;
}

async function mountProbe(seen: ErrorValue[]): Promise<Root> {
  const container = document.createElement("div");
  let root: Root | null = null;
  await act(async () => {
    root = createRoot(container);
    root.render(<Probe onValue={(error) => seen.push(error)} />);
  });
  return root as unknown as Root;
}

describe("resolveErrorValue", () => {
  it("passes plain values through", () => {
    expect(resolveErrorValue(null, "boom")).toBe("boom");
    expect(resolveErrorValue("boom", null)).toBeNull();
  });

  it("computes updater values from the current error", () => {
    expect(resolveErrorValue("a", (current) => (current === "a" ? null : current))).toBeNull();
    expect(resolveErrorValue("b", (current) => (current === "a" ? null : current))).toBe("b");
  });
});

describe("errorStore", () => {
  it("setError/clearError drive the useError hook", async () => {
    const seen: ErrorValue[] = [];
    const root = await mountProbe(seen);

    await act(async () => setError("first"));
    await act(async () => setError("second"));
    await act(async () => clearError());

    expect(seen).toEqual([null, "first", "second", null]);
    await act(async () => root.unmount());
  });

  it("supports the updater form", async () => {
    const seen: ErrorValue[] = [];
    const root = await mountProbe(seen);

    await act(async () => setError("kept"));
    await act(async () => setError((current) => (current === "other" ? null : current)));
    await act(async () => setError((current) => (current === "kept" ? null : current)));

    expect(seen).toEqual([null, "kept", null]);
    await act(async () => root.unmount());
  });
});
