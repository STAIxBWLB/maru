import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const outlinePanePath = fileURLToPath(new URL("../components/OutlinePane.tsx", import.meta.url));

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

async function loadOutlineSurface() {
  const specifier = ["./outline", "PaneStore"].join("");
  return import(/* @vite-ignore */ specifier);
}

describe("Outline facade contract", () => {
  it("keeps no-op and changed render-domain snapshot identities scoped to one workspace", async () => {
    const surface = await loadOutlineSurface();
    const scope = { workspacePath: "/workspace-a" };
    const initial = surface.getOutlinePaneState(scope);
    const hydrated = surface.hydrateOutlinePaneState(scope, {
      document: { path: "/workspace-a/note.md", draftContent: "first" },
      fileQueue: [],
    });

    expect(surface.hydrateOutlinePaneState(scope, hydrated)).toBe(hydrated);
    expect(surface.getOutlinePaneState(scope)).toBe(hydrated);
    expect(hydrated.document).not.toBe(initial.document);
    expect(hydrated.fileQueue).toBe(initial.fileQueue);
  });

  it("hydrates and cleans up workspace-local state without taking ownership of canonical drafts", async () => {
    const surface = await loadOutlineSurface();
    const scope = { workspacePath: "/workspace-a" };
    const canonicalDraft = { tabId: "/workspace-a/note.md", draftContent: "canonical" };

    surface.hydrateOutlinePaneState(scope, { document: canonicalDraft, fileQueue: [] });
    surface.cleanupOutlinePaneWorkspace(scope.workspacePath);

    expect(surface.getOutlinePaneState(scope).document).not.toBe(canonicalDraft);
    expect(canonicalDraft.draftContent).toBe("canonical");
  });

  it("routes commands through a stable port that reads the latest snapshot when invoked", async () => {
    const surface = await loadOutlineSurface();
    const scope = { workspacePath: "/workspace-a" };
    const jumpToLine = vi.fn();
    const commands = surface.createOutlinePaneCommands({
      getState: () => surface.getOutlinePaneState(scope),
      jumpToLine,
    });

    surface.hydrateOutlinePaneState(scope, {
      document: { path: "/workspace-a/later.md", draftContent: "latest" },
      fileQueue: [],
    });
    await commands.jumpToLine(42);

    expect(jumpToLine).toHaveBeenCalledWith(42, "/workspace-a/later.md");
  });

  it("publishes file-queue changes only to the file-queue render domain", async () => {
    const surface = await loadOutlineSurface();
    const scope = { workspacePath: "/workspace-a" };
    const documentSubscriber = vi.fn();
    const fileQueueSubscriber = vi.fn();
    const unsubscribeDocument = surface.subscribeOutlineDocumentSlice(scope, documentSubscriber);
    const unsubscribeFileQueue = surface.subscribeOutlineFileQueueSlice(scope, fileQueueSubscriber);

    const before = surface.getOutlinePaneState(scope);
    surface.replaceOutlineFileQueue(scope, [{
      id: "queue-1",
      status: "queued",
      sourcePath: "/outside/source.md",
      sourceRelPath: "source.md",
      sourceKind: "file",
      fileName: "source.md",
      targetDir: "/workspace-a",
      operation: "copy",
      message: null,
      targetPath: null,
    }]);
    const queued = surface.getOutlinePaneState(scope);

    expect(fileQueueSubscriber).toHaveBeenCalledTimes(1);
    expect(documentSubscriber).not.toHaveBeenCalled();
    expect(queued.document).toBe(before.document);
    expect(queued.fileQueue).not.toBe(before.fileQueue);

    const selected = surface.selectOutlineFileQueueItemInState(queued, "queue-1", false);
    expect(surface.selectOutlineFileQueueItemInState(selected, "queue-1", false)).toBe(selected);
    const updated = surface.updateOutlineFileQueueItemInState(selected, "queue-1", { operation: "move" });
    expect(updated.document).toBe(selected.document);
    expect(updated.fileQueue).not.toBe(selected.fileQueue);

    unsubscribeDocument();
    unsubscribeFileQueue();
  });

  it("keeps OutlinePane within the structural prop budget", async () => {
    await loadOutlineSurface();
    const properties = interfacePropertyNames(outlinePanePath, "OutlinePaneProps");

    expect(properties).toHaveLength(8);
    expect(properties).toEqual(
      expect.arrayContaining(["scope", "commands"]),
    );
    expect(properties).not.toEqual(
      expect.arrayContaining(["document", "draftContent", "onJumpToLine", "fileQueue", "onApplyFileQueue"]),
    );
  });
});
