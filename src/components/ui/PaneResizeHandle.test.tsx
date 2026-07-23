// @vitest-environment jsdom

import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaneResizeHandle } from "./PaneResizeHandle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  document.body.innerHTML = "";
});

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
});
