import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MARU_SETTINGS } from "./settings";

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

async function loadPersistence() {
  const specifier = ["./editorSurface", "Persistence"].join("");
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

    expect(properties).toEqual(["scope", "commands", "paneRef", "slots"]);
    expect(properties).not.toEqual(
      expect.arrayContaining([
        "document",
        "draftContent",
        "onJumpToLine",
        "fileQueue",
        "onApplyFileQueue",
        "activeLine",
        "onClose",
        "sidebar",
        "explorer",
      ]),
    );
  });

  it("keeps explorer and active-tab/share/sidebar reads in independent facade slices", async () => {
    const surface = await loadOutlineSurface();
    const scope = { workspacePath: "/workspace-a" };
    const explorerSubscriber = vi.fn();
    const sidebarSubscriber = vi.fn();
    const unsubscribeExplorer = surface.subscribeOutlineExplorerSlice(scope, explorerSubscriber);
    const unsubscribeSidebar = surface.subscribeOutlineSidebarSlice(scope, sidebarSubscriber);

    const initial = surface.getOutlinePaneState(scope);
    surface.hydrateOutlinePaneState(scope, {
      explorer: { query: "report" },
      sidebar: { activeTab: "outline", activeLine: 2 },
    });
    const hydrated = surface.getOutlinePaneState(scope);

    expect(explorerSubscriber).toHaveBeenCalledTimes(1);
    expect(sidebarSubscriber).toHaveBeenCalledTimes(1);
    expect(hydrated.document).toBe(initial.document);
    expect(hydrated.fileQueue).toBe(initial.fileQueue);
    expect(hydrated.operation).toBe(initial.operation);

    unsubscribeExplorer();
    unsubscribeSidebar();
  });

  it("exposes shell effects only through the command port", async () => {
    const surface = await loadOutlineSurface();
    const closeOutline = vi.fn();
    const commands = surface.createOutlinePaneCommands({
      getState: () => surface.getOutlinePaneState({ workspacePath: "/workspace-a" }),
      jumpToLine: vi.fn(),
      closeOutline,
    });

    await commands.closeOutline();

    expect(closeOutline).toHaveBeenCalledOnce();
  });

  it("rejects a late workspace hydration before its one facade publish", async () => {
    const surface = await loadOutlineSurface();
    const persistence = await loadPersistence();
    const scopeA = { workspacePath: "/workspace-a" };
    const scopeB = { workspacePath: "/workspace-b" };
    let activeWorkspace = scopeA.workspacePath;
    let requestId = 1;
    let resolveTab: ((tab: "outline") => void) | undefined;
    const adapter = persistence.createEditorSurfacePersistence({
      currentWorkspacePath: () => activeWorkspace,
      currentRequestId: () => requestId,
      publish: surface.setOutlineRightPaneTab,
      cleanupWorkspace: surface.cleanupOutlinePaneWorkspace,
      scheduleSettings: vi.fn(),
    });
    const staleHydration = adapter.hydrate(
      { workspacePath: scopeA.workspacePath, requestId },
      new Promise<"outline">((resolve) => {
        resolveTab = resolve;
      }),
    );

    activeWorkspace = scopeB.workspacePath;
    requestId = 2;
    surface.hydrateOutlinePaneState(scopeB, { sidebar: { activeTab: "workspace" } });
    const before = surface.getOutlinePaneState(scopeB).sidebar;
    resolveTab?.("outline");

    await expect(staleHydration).resolves.toBe(false);
    expect(surface.getOutlinePaneState(scopeB).sidebar).toBe(before);
  });

  it("saves only rightPaneTab and removes facade-local workspace records", async () => {
    const surface = await loadOutlineSurface();
    const persistence = await loadPersistence();
    const tabs = await import("./editorTabsStore");
    const workspacePath = "/workspace-a";
    const scheduleSettings = vi.fn();
    const adapter = persistence.createEditorSurfacePersistence({
      currentWorkspacePath: () => workspacePath,
      currentRequestId: () => 1,
      publish: surface.setOutlineRightPaneTab,
      cleanupWorkspace: surface.cleanupOutlinePaneWorkspace,
      scheduleSettings,
    });

    surface.hydrateOutlinePaneState({ workspacePath }, {
      sidebar: { activeTab: "outline" },
      explorer: { explorerWorkspacePath: workspacePath },
    });
    tabs.restoreWorkspaceTabs(
      workspacePath,
      {
        id: "draft-tab",
        workspacePath,
        draftContent: "unsaved canonical draft",
      } as never,
      {
        leftActiveTabId: "draft-tab",
        rightActiveTabId: null,
        focusedEditorGroup: "left",
      },
    );
    adapter.setRightPaneTab("files");
    const next = scheduleSettings.mock.calls[0][0](DEFAULT_MARU_SETTINGS);
    expect(next.ui).toEqual({ ...DEFAULT_MARU_SETTINGS.ui, rightPaneTab: "files" });

    adapter.cleanupWorkspace(workspacePath);
    expect(surface.getOutlinePaneState({ workspacePath }).sidebar.activeTab).toBe("workspace");
    expect(tabs.getEditorTabsState().tabs[0]?.draftContent).toBe("unsaved canonical draft");
    expect(DEFAULT_MARU_SETTINGS.ui.rightPaneTab).toBe("workspace");
    tabs.resetWorkspaceTabs(workspacePath);
  });
});
