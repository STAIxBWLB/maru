import type { EditorPaneScope, EditorPaneState } from "./editorPaneStore";
import type { OutlinePaneState } from "./outlinePaneStore";
import type { EditorViewMode } from "../components/DocumentModeSurface";
import type { DocumentFilter } from "./documentIndex";
import type { GraphLocalTarget, RightPaneTab, DocumentViewDefinition } from "./settings";
import type { FileQueueItem, FileQueueSourceInfo, VaultEntry, WorkspaceFileEntry } from "./types";
import type { WorkspaceFilesPaneFilters } from "./workspaceFileTree";

/** The Outline component receives only the actions it can invoke. Additional
 * pane commands are added by their owning migration task, never as a broad
 * shell capability object. */
export interface OutlinePaneCommands {
  closeOutline(): Promise<void>;
  jumpToLine(line: number): Promise<void>;
  setRightPaneTab(tab: RightPaneTab): Promise<void>;
  updateField(key: string, value: string | string[] | number | boolean | null): Promise<void>;
  selectEntry(entry: VaultEntry): Promise<void>;
  openMissingWikilink(target: string): Promise<void>;
  openGraph(target: GraphLocalTarget): Promise<void>;
  setDocumentFilter(filter: DocumentFilter): Promise<void>;
  updateDocumentViews(views: DocumentViewDefinition[]): Promise<void>;
  setDocumentSubmoduleScope(excluded: string[]): Promise<void>;
  openNewDocument(docType?: string): Promise<void>;
  openCommandPalette(): Promise<void>;
  setExplorerExpandedFolders(paths: string[]): Promise<void>;
  refreshExplorer(): Promise<void>;
  openWorkspaceFile(entry: WorkspaceFileEntry, line?: number): Promise<void>;
  ignoreWorkspaceEntry(relPath: string, kind: "file" | "directory"): Promise<void>;
  setFilesPaneFilters(filters: WorkspaceFilesPaneFilters): Promise<void>;
  revealFileInFinder(targetPath: string): Promise<void>;
  queueExternalFiles(paths: string[]): Promise<void>;
  queueFileSources(sources: FileQueueSourceInfo[], targetDir: string): Promise<void>;
  updateFileQueueItem(
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ): Promise<void>;
  applyFileQueue(): Promise<unknown>;
}

export interface CreateOutlinePaneCommandsOptions {
  getState: () => OutlinePaneState;
  jumpToLine: (line: number, documentPath: string | null) => void | Promise<void>;
  queueExternalFiles?: (paths: string[]) => void | Promise<void>;
  queueFileSources?: (sources: FileQueueSourceInfo[], targetDir: string) => void | Promise<void>;
  updateFileQueueItem?: (
    id: string,
    patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
  ) => void | Promise<void>;
  applyFileQueue?: () => unknown | Promise<unknown>;
  closeOutline?: () => void | Promise<void>;
  setRightPaneTab?: (tab: RightPaneTab) => void | Promise<void>;
  updateField?: (key: string, value: string | string[] | number | boolean | null) => void | Promise<void>;
  selectEntry?: (entry: VaultEntry) => void | Promise<void>;
  openMissingWikilink?: (target: string) => void | Promise<void>;
  openGraph?: (target: GraphLocalTarget) => void | Promise<void>;
  setDocumentFilter?: (filter: DocumentFilter) => void | Promise<void>;
  updateDocumentViews?: (views: DocumentViewDefinition[]) => void | Promise<void>;
  setDocumentSubmoduleScope?: (excluded: string[]) => void | Promise<void>;
  openNewDocument?: (docType?: string) => void | Promise<void>;
  openCommandPalette?: () => void | Promise<void>;
  setExplorerExpandedFolders?: (paths: string[]) => void | Promise<void>;
  refreshExplorer?: () => void | Promise<void>;
  openWorkspaceFile?: (entry: WorkspaceFileEntry, line?: number) => void | Promise<void>;
  ignoreWorkspaceEntry?: (relPath: string, kind: "file" | "directory") => void | Promise<void>;
  setFilesPaneFilters?: (filters: WorkspaceFilesPaneFilters) => void | Promise<void>;
  revealFileInFinder?: (targetPath: string) => void | Promise<void>;
}

export function createOutlinePaneCommands(
  options: CreateOutlinePaneCommandsOptions,
): OutlinePaneCommands {
  return {
    async closeOutline(): Promise<void> {
      await options.closeOutline?.();
    },
    async jumpToLine(line: number): Promise<void> {
      // Read inside the method so a stable port cannot retain a stale active
      // document when the user changes tabs before activating a heading.
      const slice = options.getState().document;
      const documentPath = "document" in slice
        ? slice.document?.path ?? null
        : (slice as unknown as { path?: string }).path ?? null;
      await options.jumpToLine(line, documentPath);
    },
    async setRightPaneTab(tab: RightPaneTab): Promise<void> {
      await options.setRightPaneTab?.(tab);
    },
    async updateField(key, value): Promise<void> {
      await options.updateField?.(key, value);
    },
    async selectEntry(entry): Promise<void> {
      await options.selectEntry?.(entry);
    },
    async openMissingWikilink(target): Promise<void> {
      await options.openMissingWikilink?.(target);
    },
    async openGraph(target): Promise<void> {
      await options.openGraph?.(target);
    },
    async setDocumentFilter(filter): Promise<void> {
      await options.setDocumentFilter?.(filter);
    },
    async updateDocumentViews(views): Promise<void> {
      await options.updateDocumentViews?.(views);
    },
    async setDocumentSubmoduleScope(excluded): Promise<void> {
      await options.setDocumentSubmoduleScope?.(excluded);
    },
    async openNewDocument(docType?: string): Promise<void> {
      await options.openNewDocument?.(docType);
    },
    async openCommandPalette(): Promise<void> {
      await options.openCommandPalette?.();
    },
    async setExplorerExpandedFolders(paths): Promise<void> {
      await options.setExplorerExpandedFolders?.(paths);
    },
    async refreshExplorer(): Promise<void> {
      await options.refreshExplorer?.();
    },
    async openWorkspaceFile(entry, line): Promise<void> {
      await options.openWorkspaceFile?.(entry, line);
    },
    async ignoreWorkspaceEntry(relPath, kind): Promise<void> {
      await options.ignoreWorkspaceEntry?.(relPath, kind);
    },
    async setFilesPaneFilters(filters): Promise<void> {
      await options.setFilesPaneFilters?.(filters);
    },
    async revealFileInFinder(targetPath): Promise<void> {
      await options.revealFileInFinder?.(targetPath);
    },
    async queueExternalFiles(paths: string[]): Promise<void> {
      void options.getState();
      await options.queueExternalFiles?.(paths);
    },
    async queueFileSources(sources: FileQueueSourceInfo[], targetDir: string): Promise<void> {
      void options.getState();
      await options.queueFileSources?.(sources, targetDir);
    },
    async updateFileQueueItem(
      id: string,
      patch: Partial<Pick<FileQueueItem, "targetDir" | "operation">>,
    ): Promise<void> {
      void options.getState();
      await options.updateFileQueueItem?.(id, patch);
    },
    async applyFileQueue(): Promise<unknown> {
      void options.getState();
      return await options.applyFileQueue?.();
    },
  };
}

/** Editor receives only the shell operations it invokes. Local state changes
 * stay in editorPaneStore; this port keeps filesystem and cross-surface work
 * behind the existing App orchestration. */
export interface EditorPaneCommands {
  selectTab(tabId: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  closeOtherTabs(tabId: string): Promise<void>;
  closeTabsToRight(tabId: string): Promise<void>;
  closeSavedTabs(): Promise<void>;
  closeAllTabs(): Promise<void>;
  copyTabName(tabId: string): Promise<void>;
  copyTabPath(tabId: string): Promise<void>;
  copyTabRelativePath(tabId: string): Promise<void>;
  renameTab(tabId: string): Promise<void>;
  moveTab(tabId: string): Promise<void>;
  duplicateTab(tabId: string): Promise<void>;
  deleteTab(tabId: string): Promise<void>;
  openTabPreview(tabId: string): Promise<void>;
  revealTabInFinder(tabId: string): Promise<void>;
  revealTabInExplorer(tabId: string): Promise<void>;
  save(): Promise<void>;
  snapshot(): Promise<void>;
  splitRight(): Promise<void>;
  openSourcePreview(): Promise<void>;
  openGraphRight(): Promise<void>;
  focusPane(): Promise<void>;
  toggleOutline(): Promise<void>;
  persistViewMode(mode: EditorViewMode): Promise<void>;
  flushHtmlDraft(): Promise<void>;
  visualizeRefs(): Promise<void>;
  toggleKgHighlight(): Promise<void>;
  openKgRefNode(nodePath: string): Promise<void>;
  openWikilink(target: string): Promise<void>;
}

type EditorScopeAction = (scope: EditorPaneScope, state: EditorPaneState) => void | Promise<void>;
type EditorTabAction = (tabId: string, scope: EditorPaneScope, state: EditorPaneState) => void | Promise<void>;

export interface CreateEditorPaneCommandsOptions {
  getState: () => EditorPaneState;
  invoke?: (
    operation: keyof EditorPaneCommands,
    args: readonly unknown[],
    scope: EditorPaneScope,
    state: EditorPaneState,
  ) => void | Promise<void>;
  selectTab?: EditorTabAction;
  closeTab?: EditorTabAction;
  closeOtherTabs?: EditorTabAction;
  closeTabsToRight?: EditorTabAction;
  closeSavedTabs?: EditorScopeAction;
  closeAllTabs?: EditorScopeAction;
  copyTabName?: EditorTabAction;
  copyTabPath?: EditorTabAction;
  copyTabRelativePath?: EditorTabAction;
  renameTab?: EditorTabAction;
  moveTab?: EditorTabAction;
  duplicateTab?: EditorTabAction;
  deleteTab?: EditorTabAction;
  openTabPreview?: EditorTabAction;
  revealTabInFinder?: EditorTabAction;
  revealTabInExplorer?: EditorTabAction;
  save?: EditorScopeAction;
  snapshot?: EditorScopeAction;
  splitRight?: EditorScopeAction;
  openSourcePreview?: EditorScopeAction;
  openGraphRight?: EditorScopeAction;
  focusPane?: EditorScopeAction;
  toggleOutline?: EditorScopeAction;
  persistViewMode?: (mode: EditorViewMode, scope: EditorPaneScope, state: EditorPaneState) => void | Promise<void>;
  flushHtmlDraft?: EditorScopeAction;
  visualizeRefs?: EditorScopeAction;
  toggleKgHighlight?: EditorScopeAction;
  openKgRefNode?: (nodePath: string, scope: EditorPaneScope, state: EditorPaneState) => void | Promise<void>;
  openWikilink?: (target: string, scope: EditorPaneScope, state: EditorPaneState) => void | Promise<void>;
}

export function createEditorPaneCommands(
  options: CreateEditorPaneCommandsOptions,
): EditorPaneCommands {
  const state = () => options.getState();
  if (options.invoke) {
    const invoke = async (
      operation: keyof EditorPaneCommands,
      args: readonly unknown[] = [],
    ): Promise<void> => {
      const current = state();
      await options.invoke?.(operation, args, current.scope, current);
    };
    return {
      selectTab: (tabId) => invoke("selectTab", [tabId]),
      closeTab: (tabId) => invoke("closeTab", [tabId]),
      closeOtherTabs: (tabId) => invoke("closeOtherTabs", [tabId]),
      closeTabsToRight: (tabId) => invoke("closeTabsToRight", [tabId]),
      closeSavedTabs: () => invoke("closeSavedTabs"),
      closeAllTabs: () => invoke("closeAllTabs"),
      copyTabName: (tabId) => invoke("copyTabName", [tabId]),
      copyTabPath: (tabId) => invoke("copyTabPath", [tabId]),
      copyTabRelativePath: (tabId) => invoke("copyTabRelativePath", [tabId]),
      renameTab: (tabId) => invoke("renameTab", [tabId]),
      moveTab: (tabId) => invoke("moveTab", [tabId]),
      duplicateTab: (tabId) => invoke("duplicateTab", [tabId]),
      deleteTab: (tabId) => invoke("deleteTab", [tabId]),
      openTabPreview: (tabId) => invoke("openTabPreview", [tabId]),
      revealTabInFinder: (tabId) => invoke("revealTabInFinder", [tabId]),
      revealTabInExplorer: (tabId) => invoke("revealTabInExplorer", [tabId]),
      save: () => invoke("save"),
      snapshot: () => invoke("snapshot"),
      splitRight: () => invoke("splitRight"),
      openSourcePreview: () => invoke("openSourcePreview"),
      openGraphRight: () => invoke("openGraphRight"),
      focusPane: () => invoke("focusPane"),
      toggleOutline: () => invoke("toggleOutline"),
      persistViewMode: (mode) => invoke("persistViewMode", [mode]),
      flushHtmlDraft: () => invoke("flushHtmlDraft"),
      visualizeRefs: () => invoke("visualizeRefs"),
      toggleKgHighlight: () => invoke("toggleKgHighlight"),
      openKgRefNode: (nodePath) => invoke("openKgRefNode", [nodePath]),
      openWikilink: (target) => invoke("openWikilink", [target]),
    };
  }
  const scopeAction = async (action?: EditorScopeAction): Promise<void> => {
    const current = state();
    await action?.(current.scope, current);
  };
  const tabAction = async (tabId: string, action?: EditorTabAction): Promise<void> => {
    const current = state();
    await action?.(tabId, current.scope, current);
  };
  return {
    selectTab: (tabId) => tabAction(tabId, options.selectTab),
    closeTab: (tabId) => tabAction(tabId, options.closeTab),
    closeOtherTabs: (tabId) => tabAction(tabId, options.closeOtherTabs),
    closeTabsToRight: (tabId) => tabAction(tabId, options.closeTabsToRight),
    closeSavedTabs: () => scopeAction(options.closeSavedTabs),
    closeAllTabs: () => scopeAction(options.closeAllTabs),
    copyTabName: (tabId) => tabAction(tabId, options.copyTabName),
    copyTabPath: (tabId) => tabAction(tabId, options.copyTabPath),
    copyTabRelativePath: (tabId) => tabAction(tabId, options.copyTabRelativePath),
    renameTab: (tabId) => tabAction(tabId, options.renameTab),
    moveTab: (tabId) => tabAction(tabId, options.moveTab),
    duplicateTab: (tabId) => tabAction(tabId, options.duplicateTab),
    deleteTab: (tabId) => tabAction(tabId, options.deleteTab),
    openTabPreview: (tabId) => tabAction(tabId, options.openTabPreview),
    revealTabInFinder: (tabId) => tabAction(tabId, options.revealTabInFinder),
    revealTabInExplorer: (tabId) => tabAction(tabId, options.revealTabInExplorer),
    save: () => scopeAction(options.save),
    snapshot: () => scopeAction(options.snapshot),
    splitRight: () => scopeAction(options.splitRight),
    openSourcePreview: () => scopeAction(options.openSourcePreview),
    openGraphRight: () => scopeAction(options.openGraphRight),
    focusPane: () => scopeAction(options.focusPane),
    toggleOutline: () => scopeAction(options.toggleOutline),
    async persistViewMode(mode): Promise<void> {
      const current = state();
      await options.persistViewMode?.(mode, current.scope, current);
    },
    flushHtmlDraft: () => scopeAction(options.flushHtmlDraft),
    visualizeRefs: () => scopeAction(options.visualizeRefs),
    toggleKgHighlight: () => scopeAction(options.toggleKgHighlight),
    async openKgRefNode(nodePath): Promise<void> {
      const current = state();
      await options.openKgRefNode?.(nodePath, current.scope, current);
    },
    async openWikilink(target): Promise<void> {
      const current = state();
      await options.openWikilink?.(target, current.scope, current);
    },
  };
}
