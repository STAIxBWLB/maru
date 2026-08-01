// @vitest-environment jsdom

// Regression guard for the preview debounce (EditorPane): the markdown
// preview rebuilds its entire DOM per renderMarkdown call, so a keystroke
// burst must coalesce into one render inside the 200ms debounce window
// instead of re-rendering per keystroke.

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  renderMarkdown: vi.fn((markdown: string) => `<p>${markdown}</p>`),
  vaultValidateNote: vi.fn(),
}));

vi.mock("../lib/api", () => ({
  vaultValidateNote: mocks.vaultValidateNote,
}));

vi.mock("../lib/markdown", () => ({
  renderMarkdown: mocks.renderMarkdown,
}));

import { EditorPane } from "../components/EditorPane";
import { LocaleContext } from "../lib/i18n";
import type { DocumentPayload } from "../lib/types";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

const t = (key: string, vars?: Record<string, string | number>) => {
  let result = key;
  for (const [name, value] of Object.entries(vars ?? {})) {
    result = result.replace(`{${name}}`, String(value));
  }
  return result;
};

const doc: DocumentPayload = {
  path: "/workspace/note.md",
  relPath: "note.md",
  title: "note",
  content: "",
  body: "",
  meta: {},
  fileKind: "markdown",
};

const noop = () => {};

function renderPane(root: Root, draftContent: string) {
  root.render(
    <LocaleContext.Provider value={{ locale: "en", setLocale: noop, t }}>
      <EditorPane
        document={doc}
        openingEntry={null}
        draftContent={draftContent}
        saving={false}
        dirty={false}
        outlineOpen={false}
        activeWorkspaceLabel={null}
        documentLabel={null}
        readOnly={false}
        canSnapshot={false}
        readOnlyReason={null}
        viewMode="preview"
        tabs={[]}
        activeTabId={null}
        entries={[]}
        onChange={noop}
        onSelectTab={noop}
        onCloseTab={noop}
        onCloseOtherTabs={noop}
        onCloseTabsToRight={noop}
        onCloseSavedTabs={noop}
        onCloseAllTabs={noop}
        onCopyTabName={noop}
        onCopyTabPath={noop}
        onCopyTabRelativePath={noop}
        onRenameTab={noop}
        onMoveTab={noop}
        onDuplicateTab={noop}
        onDeleteTab={noop}
        onOpenTabPreview={noop}
        onRevealTabInFinder={noop}
        onRevealTabInExplorer={noop}
        onSave={noop}
        onSnapshot={noop}
        onSplitRight={noop}
        onOpenGraphRight={noop}
        onToggleOutline={noop}
        onViewModeChange={noop}
        onWikilinkClick={noop}
      />
    </LocaleContext.Provider>,
  );
}

describe("EditorPane preview debounce", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("coalesces a keystroke burst into one renderMarkdown call", async () => {
    root = createRoot(container);
    await act(async () => {
      renderPane(root!, "첫 번째");
    });
    // Initial render paints once, no debounce involved.
    expect(mocks.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(mocks.renderMarkdown).toHaveBeenLastCalledWith("첫 번째");
    expect(container.querySelector(".preview-surface")?.innerHTML).toBe("<p>첫 번째</p>");

    // A burst of draft changes inside the 200ms window schedules nothing yet.
    for (const draft of ["두 번째", "세 번째", "네 번째"]) {
      await act(async () => {
        renderPane(root!, draft);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(199);
    });
    expect(mocks.renderMarkdown).toHaveBeenCalledTimes(1);
    expect(container.querySelector(".preview-surface")?.innerHTML).toBe("<p>첫 번째</p>");

    // The window elapses: exactly one re-render, with the latest draft only.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(mocks.renderMarkdown).toHaveBeenCalledTimes(2);
    expect(mocks.renderMarkdown).toHaveBeenLastCalledWith("네 번째");
    expect(container.querySelector(".preview-surface")?.innerHTML).toBe("<p>네 번째</p>");
  });
});
