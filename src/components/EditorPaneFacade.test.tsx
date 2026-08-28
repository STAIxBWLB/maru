// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/markdown", () => ({
  renderMarkdown: () => "<p>editor facade</p>",
}));

import { EditorPaneFacade } from "./EditorPaneFacade";
import { createEditorPaneCommands } from "../lib/editorSurfaceAdapter";
import {
  getEditorPaneState,
  resetEditorPaneStoreForTests,
  type EditorPaneScope,
} from "../lib/editorPaneStore";
import { replaceAllDocTabs, type EditorTab } from "../lib/editorTabsStore";
import { LocaleContext } from "../lib/i18n";

const scope: EditorPaneScope = { workspacePath: "/workspace", group: "left", tabId: "note.md" };
const commands = createEditorPaneCommands({ getState: () => getEditorPaneState(scope) });
const t = (key: string) => key;

function FacadeHarness({ saving }: { saving: boolean }) {
  return (
    <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
      <EditorPaneFacade
        scope={scope}
        commands={commands}
        presentation={{
          tabs: [],
          activeTabId: scope.tabId,
          outlineOpen: false,
          activeWorkspaceLabel: null,
          documentLabel: "note",
          readOnly: false,
          canSnapshot: false,
          readOnlyReason: null,
          entries: [],
          bodyOverride: null,
          vaultPath: scope.workspacePath,
          isManagedVaultNote: false,
          kgHighlightRefs: null,
        }}
        operation={{ openingEntry: null, saving }}
        viewMode="source"
      />
    </LocaleContext.Provider>
  );
}

describe("EditorPaneFacade", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    resetEditorPaneStoreForTests();
    const editorDocument = {
      path: "/workspace/note.md",
      relPath: "note.md",
      title: "note",
      content: "editor facade",
      body: "editor facade",
      meta: {},
      fileKind: "markdown",
    };
    replaceAllDocTabs(
      [{ id: scope.tabId, workspacePath: scope.workspacePath, document: editorDocument, draftContent: editorDocument.content } as EditorTab],
      { activeTabId: scope.tabId, leftActiveTabId: scope.tabId, rightActiveTabId: null, focusedEditorGroup: "left" },
    );
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("publishes facade changes after commit without render-phase subscriber updates", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    root = createRoot(container);

    await act(async () => {
      root?.render(<FacadeHarness saving={false} />);
    });
    error.mockClear();

    await act(async () => {
      root?.render(<FacadeHarness saving />);
    });

    expect(getEditorPaneState(scope).operation.saving).toBe(true);
    expect(error.mock.calls.flat().join(" ")).not.toContain("Cannot update a component while rendering");
    error.mockRestore();
  });
});
