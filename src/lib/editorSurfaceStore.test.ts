import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const wave0ContractsEnabled = process.env.PHASE4_WAVE0_CONTRACT === "1";
const describeWave0 = wave0ContractsEnabled ? describe : describe.skip;
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

describeWave0("Editor facade contract", () => {
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
