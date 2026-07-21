// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleContext, t as translate } from "../../../lib/i18n";
import { mkNode } from "../../../lib/diagram/nodeKinds";
import { InlineTextEditor, type InlineEditCommitReason } from "./InlineTextEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECT = { x: 10, y: 10, w: 100, h: 40 };

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onCommitReason: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  textarea: () => HTMLTextAreaElement;
}

function mountCellEditor(initialValue?: string): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCommitReason = vi.fn();
  const onCancel = vi.fn();
  const node = mkNode("table", 0, 0);
  act(() => {
    root.render(
      <LocaleContext.Provider
        value={{
          locale: "ko",
          setLocale: () => {},
          t: (key, vars) => translate("ko", key, vars),
        }}
      >
        <InlineTextEditor
          node={node}
          field="title"
          rect={RECT}
          zoom={1}
          initialValue={initialValue ?? "seed"}
          ariaLabel="cell"
          onCommitReason={onCommitReason}
          onCancel={onCancel}
        />
      </LocaleContext.Provider>,
    );
  });
  return {
    container,
    root,
    onCommitReason,
    onCancel,
    textarea: () => container.querySelector("textarea")!,
  };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function pressKey(textarea: HTMLTextAreaElement, keyName: string, init: KeyboardEventInit = {}) {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key: keyName, bubbles: true, ...init }));
}

describe("InlineTextEditor — cell mode (onCommitReason)", () => {
  let harness: Harness | null = null;

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  afterEach(() => {
    if (harness) {
      act(() => harness!.root.unmount());
      harness = null;
    }
    document.body.innerHTML = "";
  });

  const reasons: Array<[string, KeyboardEventInit, InlineEditCommitReason]> = [
    ["Enter", {}, "enter"],
    ["Tab", {}, "tab"],
    ["Tab", { shiftKey: true }, "shift-tab"],
  ];

  it.each(reasons)("%s commits with reason %s", (keyName, init, reason) => {
    harness = mountCellEditor();
    act(() => pressKey(harness!.textarea(), keyName, init));
    expect(harness.onCommitReason).toHaveBeenCalledTimes(1);
    expect(harness.onCommitReason).toHaveBeenCalledWith("seed", reason);
    expect(harness.onCancel).not.toHaveBeenCalled();
  });

  it("commits with reason blur when clicking away", () => {
    harness = mountCellEditor();
    act(() => setTextareaValue(harness!.textarea(), "edited"));
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(harness.onCommitReason).toHaveBeenCalledWith("edited", "blur");
  });

  it("Escape cancels without committing", () => {
    harness = mountCellEditor();
    act(() => pressKey(harness!.textarea(), "Escape"));
    expect(harness.onCancel).toHaveBeenCalledTimes(1);
    expect(harness.onCommitReason).not.toHaveBeenCalled();
  });

  it("Korean IME: Enter during composition never commits, Tab neither", () => {
    harness = mountCellEditor();
    const textarea = harness.textarea();
    act(() => {
      textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    });
    act(() => pressKey(textarea, "Enter"));
    act(() => pressKey(textarea, "Tab"));
    expect(harness.onCommitReason).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));
    });
    act(() => pressKey(textarea, "Enter"));
    expect(harness.onCommitReason).toHaveBeenCalledWith("seed", "enter");
  });

  it("seeds a quick-entry character as the draft", () => {
    harness = mountCellEditor("가");
    expect(harness.textarea().value).toBe("가");
  });

  it("settles exactly once across commit + cancel", () => {
    harness = mountCellEditor();
    act(() => pressKey(harness!.textarea(), "Tab"));
    act(() => pressKey(harness!.textarea(), "Escape"));
    expect(harness.onCommitReason).toHaveBeenCalledTimes(1);
    expect(harness.onCancel).not.toHaveBeenCalled();
  });
});
