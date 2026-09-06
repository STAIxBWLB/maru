// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it } from "vitest";

import { clearError, resolveErrorValue, setError, useError, dismissOperationNotice, getOperationNotice, publishOperationNotice, useOperationNotice, type ErrorValue } from "./errorStore";

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


describe("operation notice channel", () => {
  it("deduplicates terminal notices even after dismissal", () => {
    const notice = { operationId: "dedup", kind: "success" as const, message: "Workspace / source complete" };
    expect(publishOperationNotice(notice)).toBe(true);
    expect(publishOperationNotice(notice)).toBe(false);
    dismissOperationNotice(notice.operationId);
    expect(publishOperationNotice(notice)).toBe(false);
    expect(getOperationNotice()).toBeNull();
  });
  it("concurrent notices remain available in order without replacing errors", () => {
    setError("existing error");
    publishOperationNotice({ operationId: "first", kind: "info", message: "Skipped; retry manually" });
    publishOperationNotice({ operationId: "second", kind: "error", message: "Failed; retry manually" });
    expect(getOperationNotice()?.operationId).toBe("first");
    dismissOperationNotice("first"); expect(getOperationNotice()?.operationId).toBe("second");
    dismissOperationNotice("second"); expect(getOperationNotice()).toBeNull();
    let previous: ErrorValue = null;
    setError((current) => { previous = current; return null; });
    expect(previous).toBe("existing error");
  });
  it("useOperationNotice reattaches after unmount", async () => {
    const container = document.createElement("div"); const root = createRoot(container);
    function Notice() { return <span>{useOperationNotice()?.message ?? "empty"}</span>; }
    publishOperationNotice({ operationId: "hook", kind: "success", message: "Done" });
    await act(async () => root.render(<Notice />)); expect(container.textContent).toBe("Done");
    await act(async () => dismissOperationNotice("hook")); expect(container.textContent).toBe("empty");
    await act(async () => root.unmount());
  });
});
