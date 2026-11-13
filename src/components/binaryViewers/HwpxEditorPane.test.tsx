// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./HwpxViewer", () => ({
  HwpxViewer: () => <div data-testid="preview" />,
}));

vi.mock("./HwpEditorSurface", () => ({
  HwpEditorSurface: () => <div data-testid="editor-surface" />,
}));

import { HwpxEditorPane } from "./HwpxEditorPane";
import { LocaleContext } from "../../lib/i18n";
import type { WorkspaceFileEntry } from "../../lib/types";

const t = (key: string) => key;

const entry: WorkspaceFileEntry = {
  path: "/workspace/report.hwpx",
  relPath: "report.hwpx",
  name: "report.hwpx",
  extension: "hwpx",
  fileKind: "hwpx",
  sizeBytes: 10,
  updatedAt: null,
  gitTracked: false,
  binary: true,
};

describe("HwpxEditorPane", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
      true;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  async function renderPane(): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t }}>
          <HwpxEditorPane
            entry={entry}
            workspacePath="/workspace"
            onPreviewExternal={() => {}}
            onOpenExternal={() => {}}
          />
        </LocaleContext.Provider>,
      );
    });
  }

  function toggle(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>(
      "button.hwp-editor-pane-toggle",
    );
    if (button === null) throw new Error("toggle button is missing");
    return button;
  }

  it("opens on the preview and loads the editor only on request", async () => {
    await renderPane();

    expect(container.querySelector('[data-testid="preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-surface"]')).toBeNull();
    expect(container.textContent).not.toContain("binaryViewer.hwpEditorNotSaved");
    expect(toggle().textContent).toBe("binaryViewer.hwpEditorOpen");
  });

  it("mounts the editor with the unsaved notice and no save affordance", async () => {
    await renderPane();
    await act(async () => {
      toggle().click();
    });
    // The editor rides a lazy chunk, so let its module promise settle.
    await act(async () => {});

    expect(container.querySelector('[data-testid="preview"]')).toBeNull();
    expect(container.querySelector('[data-testid="editor-surface"]')).not.toBeNull();
    expect(container.textContent).toContain("binaryViewer.hwpEditorNotSaved");
    expect(toggle().textContent).toBe("binaryViewer.hwpEditorClose");
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(
      container
        .querySelector('[data-testid="editor-surface"]')
        ?.closest(".hwp-editor-host"),
    ).not.toBeNull();
  });

  it("returns to the preview and drops the notice", async () => {
    await renderPane();
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});
    await act(async () => {
      toggle().click();
    });

    expect(container.querySelector('[data-testid="preview"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-surface"]')).toBeNull();
    expect(container.textContent).not.toContain("binaryViewer.hwpEditorNotSaved");
  });
});
