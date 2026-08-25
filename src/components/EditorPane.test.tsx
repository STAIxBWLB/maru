// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/markdown", () => ({
  renderMarkdown: () => '<p>reference <mark class="find-mark find-mark-current">match</mark></p>',
}));

import { EditorPane } from "./EditorPane";
import { createEditorPaneCommands } from "../lib/editorSurfaceAdapter";
import {
  getEditorPaneState,
  patchEditorPaneOperation,
  patchEditorPaneViewPreview,
  resetEditorPaneStoreForTests,
  setEditorPanePresentation,
  type EditorPaneScope,
} from "../lib/editorPaneStore";
import { replaceAllDocTabs, type EditorTab } from "../lib/editorTabsStore";
import { LocaleContext } from "../lib/i18n";

const editorPaneSource = resolve(process.cwd(), "src/components/EditorPane.tsx");
const scope: EditorPaneScope = { workspacePath: "/workspace", group: "left", tabId: "note.md" };
const commands = createEditorPaneCommands({ getState: () => getEditorPaneState(scope) });
const t = (key: string) => key;

function renderPane(root: Root): void {
  const document = {
    path: "/workspace/note.md",
    relPath: "note.md",
    title: "note",
    content: "reference match",
    body: "reference match",
    meta: {},
    fileKind: "markdown",
  };
  replaceAllDocTabs(
    [{ id: scope.tabId, workspacePath: scope.workspacePath, document, draftContent: document.content } as EditorTab],
    { activeTabId: scope.tabId, leftActiveTabId: scope.tabId, rightActiveTabId: null, focusedEditorGroup: "left" },
  );
  setEditorPanePresentation(
    scope,
    {
      tabs: [], activeTabId: scope.tabId, outlineOpen: false, activeWorkspaceLabel: null,
      documentLabel: null, readOnly: false, canSnapshot: false, readOnlyReason: null,
      entries: [], bodyOverride: null, vaultPath: scope.workspacePath, isManagedVaultNote: false,
      kgHighlightRefs: [{ nodePath: "target.md", nodeTitle: "target", matchKind: "entity", spans: [{ start: 0, end: 9, paragraph: 0 }] }],
    },
    { openingEntry: null, saving: false },
  );
  patchEditorPaneViewPreview(scope, { viewMode: "preview" });
  root.render(
    <LocaleContext.Provider value={{ locale: "en", setLocale: () => {}, t }}>
      <EditorPane scope={scope} commands={commands} />
    </LocaleContext.Provider>,
  );
}

describe("EditorPane preview identity contract", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement("div");
    document.body.appendChild(container);
    resetEditorPaneStoreForTests();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = null;
    container.remove();
  });

  it("retains preview marks and the same marked DOM node through an unrelated operation update", async () => {
    root = createRoot(container);
    await act(async () => {
      renderPane(root!);
    });
    const retainedMark = container.querySelector("mark.kg-ref-mark");
    expect(retainedMark).toBeInstanceOf(HTMLElement);
    expect(container.querySelector("mark.find-mark.find-mark-current")).toBeInstanceOf(HTMLElement);

    await act(async () => {
      patchEditorPaneOperation(scope, { saving: true });
    });

    expect(container.querySelector("mark.kg-ref-mark")).toBe(retainedMark);
    expect(container.querySelector("mark.find-mark.find-mark-current")).toBeInstanceOf(HTMLElement);
  });

  it("keeps preview markup React-owned and memoized only on previewHtml", async () => {
    const source = readFileSync(editorPaneSource, "utf8");

    expect(source).toContain("const previewMarkup = useMemo(() => ({ __html: previewHtml }), [previewHtml]);");
    expect(source).toContain("dangerouslySetInnerHTML={previewMarkup}");
    expect(source).toContain("export function decoratePreviewHtml");
    expect(source).not.toMatch(/previewRef\.current\?\.(?:innerHTML|append|replaceChildren)/);
  });
});
