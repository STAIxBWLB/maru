import { useCallback, useEffect, useRef } from "react";

import { readDocument, scanWorkspaceEntries } from "./api";
import { insertDocTab, getEditorTabsState, mapDocTabs, type EditorTab } from "./editorTabsStore";
import { listenMaruIgnoreUpdated } from "./maruDir";
import type { ScanOptions, VaultEntry, WorkspaceEntryNode, WorkspaceFileEntry, WorkspaceVisibility } from "./types";
import { isCurrentWorkspaceFilesScanRequest, workspaceFilesScanStatusAfterFailure } from "./vaultStartup";
import { EMPTY_WORKSPACE_FILES_STATE, getWorkspaceStoreState, updateWorkspaceFileState } from "./workspaceStore";

interface WorkspaceFilesLifecycleOptions {
  scanOptions: ScanOptions;
  setError(message: string): void;
}

/** Canonical file-tree scan command with per-workspace stale-result rejection. */
export function useWorkspaceFilesLifecycle({
  scanOptions,
  setError,
}: WorkspaceFilesLifecycleOptions): (path: string, initial?: boolean) => Promise<void> {
  const requestSeq = useRef<Record<string, number>>({});
  return useCallback(async (path: string, initial = false) => {
    const request = (requestSeq.current[path] ?? 0) + 1;
    requestSeq.current[path] = request;
    updateWorkspaceFileState(path, initial ? { loading: true } : { refreshing: true });
    try {
      const snapshot = await scanWorkspaceEntries(path, scanOptions);
      if (!isCurrentWorkspaceFilesScanRequest(requestSeq.current, path, request)) return;
      const files = snapshot.entries
        .filter((entry) => entry.kind === "file" || (entry.kind === "symlink" && entry.targetKind === "file"))
        .map((entry) => ({
          path: entry.path,
          relPath: entry.relPath,
          name: entry.name,
          extension: entry.extension,
          fileKind: entry.fileKind,
          sizeBytes: entry.sizeBytes,
          updatedAt: entry.updatedAt,
          gitTracked: entry.gitTracked,
          binary: entry.binary,
        }));
      updateWorkspaceFileState(path, {
        entries: files,
        nodes: snapshot.entries,
        scanStatus: "ready",
        loading: false,
        refreshing: false,
      });
    } catch (error) {
      if (!isCurrentWorkspaceFilesScanRequest(requestSeq.current, path, request)) return;
      setError(error instanceof Error ? error.message : String(error));
      const previous = getWorkspaceStoreState().fileStates[path] ?? EMPTY_WORKSPACE_FILES_STATE;
      updateWorkspaceFileState(path, {
        scanStatus: workspaceFilesScanStatusAfterFailure(previous.scanStatus),
        loading: false,
        refreshing: false,
      });
    }
  }, [scanOptions, setError]);
}

export function useInitialWorkspaceFilesScan(
  workspacePath: string | null,
  shouldScan: boolean,
  refreshWorkspaceFiles: (path: string, initial?: boolean) => Promise<void>,
): void {
  useEffect(() => {
    if (!workspacePath || !shouldScan) return;
    void refreshWorkspaceFiles(workspacePath, true);
  }, [refreshWorkspaceFiles, shouldScan, workspacePath]);
}

export function useMaruIgnoreRescan(
  workspacePath: string | null,
  refreshAfterIgnoreChange: () => Promise<void>,
): void {
  useEffect(() => {
    let dispose: (() => void) | null = null;
    void listenMaruIgnoreUpdated((payload) => {
      if (payload.workPath === workspacePath) void refreshAfterIgnoreChange();
    }).then((off) => { dispose = off; });
    return () => dispose?.();
  }, [refreshAfterIgnoreChange, workspacePath]);
}

interface FilesDocumentLifecycleOptions {
  selectedPath: string | null;
  workspacePath: string | null;
  workspaceVisibility: WorkspaceVisibility;
  workspaceEntryVisibility: WorkspaceVisibility | undefined;
  previewTab: EditorTab | null;
  setEditorError(update: (current: Record<string, string | null>) => Record<string, string | null>): void;
  saveTab(tabId: string, contentOverride?: string, onFailure?: (message: string) => void): Promise<boolean>;
  refreshWorkspaceFiles(path: string): Promise<void>;
  confirmReload(): boolean;
}

function tabIdForEntry(entry: VaultEntry): string {
  return entry.path;
}

/**
 * Files preview owns its own selected-path request token and composes the
 * editor tab/write-gate primitives. It deliberately never mirrors drafts or
 * revisions: editorTabsStore remains the single canonical document owner.
 */
export function useFilesDocumentLifecycle({
  selectedPath,
  workspacePath,
  workspaceVisibility,
  workspaceEntryVisibility,
  previewTab,
  setEditorError,
  saveTab,
  refreshWorkspaceFiles,
  confirmReload,
}: FilesDocumentLifecycleOptions) {
  const request = useRef(0);
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  const prepareDocument = useCallback(async (entry: WorkspaceFileEntry | WorkspaceEntryNode) => {
    if (!workspacePath || !/\.(md|markdown|html|htm)$/i.test(entry.name)) return;
    const existing = getEditorTabsState().tabs.find(
      (tab) => tab.workspacePath === workspacePath && tab.entry.path === entry.path,
    );
    if (existing) return;
    const requestId = ++request.current;
    setEditorError((current) => ({ ...current, [entry.path]: null }));
    try {
      const loaded = await readDocument(workspacePath, entry.path);
      const payload = { ...loaded, path: entry.path, relPath: entry.relPath };
      if (requestId !== request.current || selectedPathRef.current !== entry.path) return;
      const knownEntry = getWorkspaceStoreState().states[workspacePath]?.entries.find(
        (candidate) => candidate.path === entry.path,
      ) ?? null;
      const tabEntry: VaultEntry = knownEntry ?? {
        path: payload.path,
        relPath: payload.relPath,
        ownerWorkspacePath: workspacePath,
        title: payload.title,
        frontmatter: payload.meta,
        updatedAt: entry.updatedAt,
        wordCount: payload.body.trim() ? payload.body.trim().split(/\s+/).length : 0,
        snippet: payload.body.slice(0, 240),
        fileKind: payload.fileKind,
        versionCount: 0,
        links: [],
      };
      insertDocTab({
        id: tabIdForEntry(tabEntry),
        workspacePath,
        visibility: workspaceEntryVisibility ?? workspaceVisibility,
        entry: tabEntry,
        document: payload,
        draftContent: payload.content,
      });
    } catch (error) {
      if (requestId !== request.current) return;
      setEditorError((current) => ({
        ...current,
        [entry.path]: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [setEditorError, workspaceEntryVisibility, workspacePath, workspaceVisibility]);

  const saveDocument = useCallback(async (contentOverride?: string) => {
    if (!previewTab) return;
    setEditorError((current) => ({ ...current, [previewTab.entry.path]: null }));
    const saved = await saveTab(previewTab.id, contentOverride, (message) => {
      setEditorError((current) => ({ ...current, [previewTab.entry.path]: message }));
    });
    if (saved) setEditorError((current) => ({ ...current, [previewTab.entry.path]: null }));
  }, [previewTab, saveTab, setEditorError]);

  const reloadDocument = useCallback(async () => {
    if (!previewTab) return;
    if (previewTab.draftContent !== previewTab.document.content && !confirmReload()) return;
    try {
      const loaded = await readDocument(previewTab.workspacePath, previewTab.entry.path);
      const payload = { ...loaded, path: previewTab.entry.path, relPath: previewTab.entry.relPath };
      mapDocTabs((candidate) => candidate.id === previewTab.id
        ? { ...candidate, document: payload, draftContent: payload.content }
        : candidate);
      setEditorError((current) => ({ ...current, [previewTab.entry.path]: null }));
      void refreshWorkspaceFiles(previewTab.workspacePath);
    } catch (error) {
      setEditorError((current) => ({
        ...current,
        [previewTab.entry.path]: error instanceof Error ? error.message : String(error),
      }));
    }
  }, [confirmReload, previewTab, refreshWorkspaceFiles, setEditorError]);

  return { prepareDocument, saveDocument, reloadDocument };
}
