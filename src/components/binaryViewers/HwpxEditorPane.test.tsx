// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({
  onDirtyChange: undefined as undefined | ((dirty: boolean) => void),
}));

vi.mock("./HwpxViewer", () => ({
  HwpxViewer: () => <div data-testid="preview" />,
}));

vi.mock("./HwpEditorSurface", () => ({
  HwpEditorSurface: (props: { onDirtyChange?: (dirty: boolean) => void }) => {
    surface.onDirtyChange = props.onDirtyChange;
    return <div data-testid="editor-surface" />;
  },
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

  async function renderPane(target: WorkspaceFileEntry = entry): Promise<void> {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <LocaleContext.Provider value={{ locale: "ko", setLocale: () => {}, t }}>
          <HwpxEditorPane
            entry={target}
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

  it("keeps the editor mounted and hidden when the preview is shown again", async () => {
    await renderPane();
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});
    await act(async () => {
      toggle().click();
    });

    expect(container.querySelector('[data-testid="preview"]')).not.toBeNull();
    // Still mounted, and hidden: unmounting would drop in-memory edits.
    const host = container.querySelector(".hwp-editor-host");
    expect(host?.querySelector('[data-testid="editor-surface"]')).not.toBeNull();
    expect(host?.hasAttribute("hidden")).toBe(true);
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    // Nothing was edited, so there is nothing to say about unsaved edits.
    expect(container.textContent).not.toContain("binaryViewer.hwpEditorNotSaved");
  });

  it("keeps the unsaved notice after a dirty editor goes back behind the preview", async () => {
    await renderPane();
    await act(async () => {
      toggle().click();
    });
    await act(async () => {});
    await act(async () => {
      surface.onDirtyChange?.(true);
    });
    await act(async () => {
      toggle().click();
    });

    expect(container.querySelector('[data-testid="preview"]')).not.toBeNull();
    expect(container.querySelector(".hwp-editor-host")?.hasAttribute("hidden")).toBe(true);
    expect(container.textContent).toContain("binaryViewer.hwpEditorNotSaved");
  });

  it("does not offer the editor above the preview's inline bound", async () => {
    await renderPane({ ...entry, sizeBytes: 20 * 1024 * 1024 + 1 });

    expect(container.querySelector("button.hwp-editor-pane-toggle")).toBeNull();
    expect(container.querySelector('[data-testid="preview"]')).not.toBeNull();
  });
});
