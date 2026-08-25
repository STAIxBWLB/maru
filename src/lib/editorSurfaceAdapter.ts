import type { OutlinePaneState } from "./outlinePaneStore";
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

/** Reserved for the later Editor migration. Keeping the named export here
 * fixes the dedicated adapter seam before consumers arrive. */
export interface EditorPaneCommands {}

export function createEditorPaneCommands(): EditorPaneCommands {
  return {};
}
