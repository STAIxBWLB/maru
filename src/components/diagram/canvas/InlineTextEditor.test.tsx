// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LocaleContext, t as translate } from "../../../lib/i18n";
import { mkNode } from "../../../lib/diagram/nodeKinds";
import { InlineTextEditor } from "./InlineTextEditor";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const RECT = { x: 10, y: 10, w: 140, h: 60 };

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

interface Harness {
  container: HTMLDivElement;
  root: Root;
  onCommit: ReturnType<typeof vi.fn>;
  onCancel: ReturnType<typeof vi.fn>;
  textarea: () => HTMLTextAreaElement;
}

function mountEditor(initialTitle = "Original"): Harness {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const onCommit = vi.fn();
  const onCancel = vi.fn();
  const node = mkNode("simple", 0, 0, { title: initialTitle });
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
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </LocaleContext.Provider>,
    );
  });
  return {
    container,
    root,
    onCommit,
    onCancel,
    textarea: () => container.querySelector("textarea")!,
  };
}

function pressKey(textarea: HTMLTextAreaElement, key: string, init: KeyboardEventInit = {}) {
  textarea.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("InlineTextEditor", () => {
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

  it("commits the edited value on Enter", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => setTextareaValue(textarea, "Renamed"));
    act(() => pressKey(textarea, "Enter"));
    expect(harness.onCommit).toHaveBeenCalledTimes(1);
    expect(harness.onCommit).toHaveBeenCalledWith("Renamed");
    expect(harness.onCancel).not.toHaveBeenCalled();
  });

  it("cancels on Escape without committing", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => setTextareaValue(textarea, "Discarded"));
    act(() => pressKey(textarea, "Escape"));
    expect(harness.onCancel).toHaveBeenCalledTimes(1);
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("does not commit on Enter during IME composition", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => setTextareaValue(textarea, "한글"));
    act(() => {
      textarea.dispatchEvent(new Event("compositionstart", { bubbles: true }));
    });
    // Enter that confirms a hangul syllable must not commit the edit.
    act(() => pressKey(textarea, "Enter"));
    expect(harness.onCommit).not.toHaveBeenCalled();
    expect(harness.onCancel).not.toHaveBeenCalled();
    act(() => {
      textarea.dispatchEvent(new Event("compositionend", { bubbles: true }));
    });
    act(() => pressKey(textarea, "Enter"));
    expect(harness.onCommit).toHaveBeenCalledWith("한글");
  });

  it("ignores keydowns flagged isComposing even without composition events", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => pressKey(textarea, "Enter", { isComposing: true }));
    expect(harness.onCommit).not.toHaveBeenCalled();
  });

  it("commits when the pointer lands outside the editor", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => setTextareaValue(textarea, "Clicked away"));
    act(() => {
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    expect(harness.onCommit).toHaveBeenCalledWith("Clicked away");
  });

  it("settles exactly once (Enter then Escape is still one commit)", () => {
    harness = mountEditor();
    const textarea = harness.textarea();
    act(() => pressKey(textarea, "Enter"));
    act(() => pressKey(textarea, "Escape"));
    expect(harness.onCommit).toHaveBeenCalledTimes(1);
    expect(harness.onCancel).not.toHaveBeenCalled();
  });
});
