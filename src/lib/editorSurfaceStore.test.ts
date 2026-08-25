import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getEditorTabsState,
  replaceAllDocTabs,
  type EditorTab,
  updateTabDraft,
} from "./editorTabsStore";

const editorPanePath = fileURLToPath(new URL("../components/EditorPane.tsx", import.meta.url));

function interfacePropertyNames(filePath: string, interfaceName: string): string[] {
  const source = ts.createSourceFile(filePath, readFileSync(filePath, "utf8"), ts.ScriptTarget.Latest, true);
  let properties: string[] = [];
  source.forEachChild((node) => {
    if (!ts.isInterfaceDeclaration(node) || node.name.text !== interfaceName) return;
    properties = node.members.flatMap((member) => {
      if (!ts.isPropertySignature(member) || !member.name) return [];
      return [member.name.getText(source)];
    });
  });
  return properties;
}

async function loadEditorSurface() {
  const specifier = ["./editor", "PaneStore"].join("");
  return import(/* @vite-ignore */ specifier);
}

describe("Editor facade contract", () => {
  beforeEach(async () => {
    const surface = await loadEditorSurface();
    surface.resetEditorPaneStoreForTests();
    replaceAllDocTabs([], {
      activeTabId: null,
      leftActiveTabId: null,
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });
  });
  it("isolates the same tab id by workspace and editor group while preserving no-op identity", async () => {
    const surface = await loadEditorSurface();
    const left = { workspacePath: "/workspace-a", group: "left", tabId: "note.md" };
    const right = { workspacePath: "/workspace-a", group: "right", tabId: "note.md" };
    const otherWorkspace = { workspacePath: "/workspace-b", group: "left", tabId: "note.md" };
    const rightBefore = surface.getEditorPaneState(right);
    const otherBefore = surface.getEditorPaneState(otherWorkspace);

    const leftAfter = surface.patchEditorPaneViewPreview(left, { viewMode: "preview" });

    expect(surface.patchEditorPaneViewPreview(left, { viewMode: "preview" })).toBe(leftAfter);
    expect(surface.getEditorPaneState(right)).toBe(rightBefore);
    expect(surface.getEditorPaneState(otherWorkspace)).toBe(otherBefore);
  });

  it("composes canonical draft data while keeping view and operation slices referentially stable", async () => {
    const surface = await loadEditorSurface();
    const scope = { workspacePath: "/workspace-a", group: "left", tabId: "note.md" };
    const before = surface.getEditorPaneState(scope);
    const after = surface.patchEditorPaneOperation(scope, { saving: true });

    expect(after.document).toBe(before.document);
    expect(after.tabs).toBe(before.tabs);
    expect(after.viewPreview).toBe(before.viewPreview);
    expect(after.operation).not.toBe(before.operation);
  });

  it("observes canonical draft updates without storing a facade draft", async () => {
    const surface = await loadEditorSurface();
    const scope = { workspacePath: "/workspace-a", group: "left", tabId: "note.md" } as const;
    const tab = {
      id: scope.tabId,
      workspacePath: scope.workspacePath,
      document: { content: "before" },
      draftContent: "before",
    } as EditorTab;
    replaceAllDocTabs([tab], {
      activeTabId: tab.id,
      leftActiveTabId: tab.id,
      rightActiveTabId: null,
      focusedEditorGroup: "left",
    });

    const before = surface.getEditorPaneState(scope);
    updateTabDraft(tab.id, "after");
    const after = surface.getEditorPaneState(scope);

    expect(after.document.draftContent).toBe("after");
    expect(after.document).not.toBe(before.document);
    surface.cleanupEditorPaneTab(scope);
    expect(getEditorTabsState().tabs[0]?.draftContent).toBe("after");
  });

  it("accepts only current workspace hydration and removes the exact closed scope", async () => {
    const surface = await loadEditorSurface();
    const active = { workspacePath: "/workspace-a", group: "left", tabId: "note.md" };
    const stale = { workspacePath: "/workspace-b", group: "left", tabId: "note.md" };

    expect(surface.hydrateEditorPaneState(stale, 1, { viewMode: "source" }, 2)).toBe(false);
    expect(surface.hydrateEditorPaneState(active, 2, { viewMode: "preview" }, 2)).toBe(true);
    surface.cleanupEditorPaneTab(active);

    expect(surface.hasEditorPaneState(active)).toBe(false);
    expect(surface.getEditorPaneState(stale)).toBeDefined();
  });

});

describe.skip("Editor facade component migration contract", () => {
  it("uses a stable command port that delegates against the current scope snapshot", async () => {
    const surface = await loadEditorSurface();
    const scope = { workspacePath: "/workspace-a", group: "left", tabId: "first.md" };
    const save = vi.fn();
    const commands = surface.createEditorPaneCommands({
      getState: () => surface.getEditorPaneState(scope),
      save,
    });

    surface.replaceEditorPaneScope(scope, { ...scope, tabId: "later.md" });
    await commands.save();

    expect(save).toHaveBeenCalledWith(expect.objectContaining({ tabId: "later.md" }));
  });

  it("keeps EditorPane within the structural prop budget", async () => {
    await loadEditorSurface();
    const properties = interfacePropertyNames(editorPanePath, "EditorPaneProps");

    expect(properties).toHaveLength(8);
    expect(properties).toEqual(expect.arrayContaining(["scope", "commands"]));
    expect(properties).not.toEqual(
      expect.arrayContaining(["document", "draftContent", "onChange", "onSave", "viewMode"]),
    );
  });
});
