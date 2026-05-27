import {
  Archive,
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  Copy,
  File,
  FileText,
  Files,
  Folder,
  GitBranch,
  List,
  PanelLeftClose,
  Plus,
  RefreshCcw,
  Search,
  SlidersHorizontal,
} from "lucide-react";
import type React from "react";
import {
  memo,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useTranslation } from "../lib/i18n";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import {
  clearExplorerDragPayload,
  clearFileQueueDragPayload,
  dropOperationFromEvent,
  hasExplorerDragPayload,
  hasFileQueueDragPayload,
  readFileQueueDragPayload,
  readExplorerDragPayload,
  writeExplorerDragPayload,
  type ExplorerDragPayload,
} from "../lib/fileDrag";
import type {
  ExplorerPaneMode,
  FilesBrowserMode,
  FilesListAttribute,
  FilesSortKey,
  WorkspaceFileFilter,
} from "../lib/settings";
import { ALL_FILES_LIST_ATTRIBUTES } from "../lib/settings";
import type {
  FileStoreOperation,
  WorkspaceFileEntry,
  WorkspaceVisibility,
} from "../lib/types";
import {
  applyWorkspaceFilesPaneFilters,
  buildWorkspaceFileListRows,
  buildWorkspaceFileTreeRows,
  collectWorkspaceFileFolderPaths,
  filterWorkspaceFiles,
  hasActiveWorkspaceFilesPaneFilters,
  isOpenableDocumentFile,
  nextCollapsedFileFolders,
  virtualizeWorkspaceFileListRows,
  virtualizeWorkspaceFileTreeRows,
  type VirtualWorkspaceFileListRow,
  type VirtualWorkspaceFileTreeRow,
  type WorkspaceFilesPaneFilters,
  type WorkspaceFileTreeRow,
} from "../lib/workspaceFileTree";

const FILE_TREE_ROW_HEIGHT = 30;
const FILE_LIST_ROW_HEIGHT = 58;
const FILE_LIST_GROUP_HEIGHT = 24;
const VIRTUAL_OVERSCAN = 520;

type ApplyFileQueueToDestination = (
  targetPath: string,
  targetKind: "file" | "directory",
  operation: FileStoreOperation,
  itemIds?: string[],
) => void;

interface WorkspaceFilesPaneProps {
  entries: WorkspaceFileEntry[];
  selectedPaths: string[];
  query: string;
  loading: boolean;
  refreshing?: boolean;
  workspaceVisibility: WorkspaceVisibility;
  publicWorkspaceAvailable: boolean;
  activeWorkspaceLabel: string | null;
  paneMode: ExplorerPaneMode;
  filter: WorkspaceFileFilter;
  browserMode: FilesBrowserMode;
  sortKey: FilesSortKey;
  filesListAttributes: FilesListAttribute[];
  paneFilters: WorkspaceFilesPaneFilters;
  queuedSourcePaths: string[];
  binaryIncludePatterns: string[];
  collapsedFileFolders: string[];
  workspacePath?: string | null;
  onWorkspaceVisibilityChange: (visibility: WorkspaceVisibility) => void;
  onAddPublicWorkspace: () => void;
  onPaneModeChange: (mode: ExplorerPaneMode) => void;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: WorkspaceFileFilter) => void;
  onBrowserModeChange: (mode: FilesBrowserMode) => void;
  onSortKeyChange: (key: FilesSortKey) => void;
  onFilesListAttributesChange: (attributes: FilesListAttribute[]) => void;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onQueueFiles: (entries: WorkspaceFileEntry[]) => void;
  onRevealInFinder: (targetPath: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  paneRef?: React.RefObject<HTMLElement | null>;
  pendingRevealTargetPath?: string | null;
  onRevealHandled?: () => void;
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  onApplySkillToTarget?: (targetPath: string, targetKind: "file" | "directory") => void;
}

export const WorkspaceFilesPane = memo(function WorkspaceFilesPane({
  entries,
  selectedPaths,
  query,
  loading,
  refreshing = false,
  workspaceVisibility,
  publicWorkspaceAvailable,
  activeWorkspaceLabel,
  paneMode,
  filter,
  browserMode,
  sortKey,
  filesListAttributes,
  paneFilters,
  queuedSourcePaths,
  binaryIncludePatterns,
  collapsedFileFolders,
  workspacePath,
  onWorkspaceVisibilityChange,
  onAddPublicWorkspace,
  onPaneModeChange,
  onQueryChange,
  onFilterChange,
  onBrowserModeChange,
  onSortKeyChange,
  onFilesListAttributesChange,
  onCollapsedFileFoldersChange,
  onSelectFile,
  onOpenFile,
  onQueueFiles,
  onRevealInFinder,
  onRefresh,
  onClose,
  paneRef,
  pendingRevealTargetPath = null,
  onRevealHandled,
  selectedFileQueueCount = 0,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  onApplySkillToTarget,
}: WorkspaceFilesPaneProps) {
  const { t, locale } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSentQueryRef = useRef(query);
  const [inputQuery, setInputQuery] = useState(query);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string;
    relPath: string;
    title: string;
    entry: WorkspaceFileEntry | null;
    targetKind: "file" | "directory";
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );
  const [dragOverTargetPath, setDragOverTargetPath] = useState<string | null>(null);
  const [, startSearchTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);
  const selectedSet = useMemo(() => new Set(selectedPaths), [selectedPaths]);

  useEffect(() => {
    if (query === lastSentQueryRef.current) return;
    lastSentQueryRef.current = query;
    setInputQuery(query);
  }, [query]);

  const filtered = useMemo(
    () => filterWorkspaceFiles(entries, deferredQuery, filter, binaryIncludePatterns),
    [entries, deferredQuery, filter, binaryIncludePatterns],
  );
  const queuedPaths = useMemo(() => queuedSourcePaths ?? [], [queuedSourcePaths]);
  const effectivePaneFilters = useMemo<WorkspaceFilesPaneFilters>(
    () => ({ ...paneFilters, queuedPaths }),
    [paneFilters, queuedPaths],
  );
  const paneFiltered = useMemo(
    () => applyWorkspaceFilesPaneFilters(filtered, effectivePaneFilters),
    [filtered, effectivePaneFilters],
  );
  const hasActivePaneFilters = hasActiveWorkspaceFilesPaneFilters(effectivePaneFilters);
  const forceExpandTree = Boolean(deferredQuery.trim()) || hasActivePaneFilters;
  const folderPaths = useMemo(
    () => collectWorkspaceFileFolderPaths(paneFiltered),
    [paneFiltered],
  );
  const treeRows = useMemo(
    () =>
      browserMode === "tree"
        ? buildWorkspaceFileTreeRows(paneFiltered, collapsedFileFolders, forceExpandTree)
        : [],
    [browserMode, paneFiltered, collapsedFileFolders, forceExpandTree],
  );
  const virtualTreeLayout = useMemo(
    () =>
      virtualizeWorkspaceFileTreeRows(
        treeRows,
        viewport.scrollTop,
        viewport.height,
        VIRTUAL_OVERSCAN,
        FILE_TREE_ROW_HEIGHT,
      ),
    [treeRows, viewport],
  );
  const bucketLabels = useMemo(
    () => ({
      today: t("list.group.today"),
      thisWeek: t("list.group.thisWeek"),
      earlier: t("list.group.earlier"),
    }),
    [t],
  );
  const showListGroups =
    browserMode === "list" &&
    !deferredQuery.trim() &&
    !hasActivePaneFilters &&
    filter === "all" &&
    (sortKey === "modifiedDesc" || sortKey === "modifiedAsc");
  const listRows = useMemo(
    () =>
      browserMode === "list"
        ? buildWorkspaceFileListRows(paneFiltered, {
            sortKey,
            grouped: showListGroups,
            bucketLabels,
          })
        : [],
    [browserMode, paneFiltered, sortKey, showListGroups, bucketLabels],
  );
  const virtualListLayout = useMemo(
    () =>
      virtualizeWorkspaceFileListRows(
        listRows,
        viewport.scrollTop,
        viewport.height,
        VIRTUAL_OVERSCAN,
        FILE_LIST_ROW_HEIGHT,
        FILE_LIST_GROUP_HEIGHT,
      ),
    [listRows, viewport],
  );
  const queuedPathSet = useMemo(() => new Set(queuedPaths), [queuedPaths]);
  const selectedEntries = useMemo(
    () => entries.filter((entry) => selectedSet.has(entry.path)),
    [entries, selectedSet],
  );

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    const update = () => {
      setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || 720 });
    };
    update();
    const observer =
      typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(node);
    return () => observer?.disconnect();
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [contextMenu]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = 0;
    setViewport({ scrollTop: 0, height: node.clientHeight || 720 });
  }, [deferredQuery, filter, browserMode, sortKey, effectivePaneFilters]);

  useEffect(() => {
    if (!pendingRevealTargetPath) return;
    if (browserMode === "list") {
      const index = listRows.findIndex(
        (row) => row.kind === "file" && row.entry.path === pendingRevealTargetPath,
      );
      if (index < 0) {
        if (!loading) onRevealHandled?.();
        return;
      }
      const node = scrollRef.current;
      if (!node) return;
      let top = 0;
      for (let i = 0; i < index; i += 1) {
        top += listRows[i].kind === "group" ? FILE_LIST_GROUP_HEIGHT : FILE_LIST_ROW_HEIGHT;
      }
      node.scrollTop = Math.max(0, top - FILE_LIST_ROW_HEIGHT);
      setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || 720 });
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const selector = `[data-tree-target-path="${CSS.escape(pendingRevealTargetPath)}"]`;
          const target = scrollRef.current?.querySelector<HTMLButtonElement>(selector);
          target?.focus({ preventScroll: true });
          onRevealHandled?.();
        });
      });
      return;
    }
    const index = treeRows.findIndex(
      (row) => row.kind === "file" && row.entry.path === pendingRevealTargetPath,
    );
    if (index < 0) {
      if (!loading) onRevealHandled?.();
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    const top = index * FILE_TREE_ROW_HEIGHT;
    node.scrollTop = Math.max(0, top - FILE_TREE_ROW_HEIGHT);
    setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || 720 });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const selector = `[data-tree-target-path="${CSS.escape(pendingRevealTargetPath)}"]`;
        const target = scrollRef.current?.querySelector<HTMLButtonElement>(selector);
        target?.focus({ preventScroll: true });
        onRevealHandled?.();
      });
    });
  }, [browserMode, listRows, loading, onRevealHandled, pendingRevealTargetPath, treeRows]);

  const copyText = (value: string) => {
    if (!value) return;
    const write = navigator.clipboard?.writeText(value);
    void write?.catch(() => {});
    setContextMenu(null);
  };

  return (
    <section className="document-list files-pane" ref={paneRef}>
      <div className="workspace-tabs" role="tablist" aria-label={t("workspace.tabs.label")}>
        <button
          type="button"
          role="tab"
          aria-selected={workspaceVisibility === "private"}
          className={workspaceVisibility === "private" ? "active" : ""}
          onClick={() => onWorkspaceVisibilityChange("private")}
        >
          {t("workspace.visibility.private")}
        </button>
        {publicWorkspaceAvailable ? (
          <button
            type="button"
            role="tab"
            aria-selected={workspaceVisibility === "public"}
            className={workspaceVisibility === "public" ? "active" : ""}
            onClick={() => onWorkspaceVisibilityChange("public")}
          >
            {t("workspace.visibility.public")}
          </button>
        ) : (
          <button type="button" className="add-public" onClick={onAddPublicWorkspace}>
            {t("workspace.addPublic.short")}
          </button>
        )}
      </div>
      <div className="explorer-mode-toggle" role="group" aria-label={t("explorer.mode.label")}>
        <button
          type="button"
          className={paneMode === "documents" ? "active" : ""}
          onClick={() => onPaneModeChange("documents")}
          title={t("explorer.mode.documents")}
          aria-label={t("explorer.mode.documents")}
        >
          <FileText size={13} />
          <span>{t("explorer.mode.documents")}</span>
        </button>
        <button
          type="button"
          className={paneMode === "files" ? "active" : ""}
          onClick={() => onPaneModeChange("files")}
          title={t("explorer.mode.files")}
          aria-label={t("explorer.mode.files")}
        >
          <Files size={13} />
          <span>{t("explorer.mode.files")}</span>
        </button>
      </div>
      <div className="list-header">
        <div>
          <h2>{t("files.title")}</h2>
          {activeWorkspaceLabel ? (
            <span className="workspace-caption">{activeWorkspaceLabel}</span>
          ) : null}
        </div>
        <span className="meta">{t("list.meta.count", { count: paneFiltered.length })}</span>
        <button
          type="button"
          className="icon-button"
          onClick={onRefresh}
          disabled={refreshing}
          title={t("app.refresh")}
          aria-label={t("app.refresh")}
        >
          <RefreshCcw size={14} className={refreshing ? "spin" : ""} />
        </button>
        {onClose ? (
          <button
            type="button"
            className="icon-button"
            onClick={onClose}
            title={t("layout.hideDocuments")}
            aria-label={t("layout.hideDocuments")}
          >
            <PanelLeftClose size={14} />
          </button>
        ) : null}
      </div>

      <div className="list-mode-toggle" role="group" aria-label={t("files.viewMode")}>
        <button
          type="button"
          className={browserMode === "list" ? "active" : ""}
          onClick={() => onBrowserModeChange("list")}
          title={t("files.view.list")}
          aria-label={t("files.view.list")}
        >
          <List size={13} />
          <span>{t("files.view.list")}</span>
        </button>
        <button
          type="button"
          className={browserMode === "tree" ? "active" : ""}
          onClick={() => onBrowserModeChange("tree")}
          title={t("files.view.tree")}
          aria-label={t("files.view.tree")}
        >
          <Folder size={13} />
          <span>{t("files.view.tree")}</span>
        </button>
      </div>

      <div className="file-filter-toggle" role="group" aria-label={t("files.filter.label")}>
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onClick={() => onFilterChange("all")}
          title={t("files.filter.all")}
          aria-label={t("files.filter.all")}
        >
          <Files size={13} />
          <span>{t("files.filter.all")}</span>
        </button>
        <button
          type="button"
          className={filter === "tracked" ? "active" : ""}
          onClick={() => onFilterChange("tracked")}
          title={t("files.filter.tracked")}
          aria-label={t("files.filter.tracked")}
        >
          <GitBranch size={13} />
          <span>{t("files.filter.tracked")}</span>
        </button>
        <button
          type="button"
          className={filter === "binary" ? "active" : ""}
          onClick={() => onFilterChange("binary")}
          title={t("files.filter.binary")}
          aria-label={t("files.filter.binary")}
        >
          <Archive size={13} />
          <span>{t("files.filter.binary")}</span>
        </button>
      </div>

      {browserMode === "list" ? (
        <div className="files-list-controls" role="group" aria-label={t("files.toolbar.label")}>
          <label className="file-sort-control" aria-label={t("files.sort.label")}>
            <span className="file-sort-label">{t("files.sort.label")}</span>
            <select
              value={sortKey}
              onChange={(event) => onSortKeyChange(event.target.value as FilesSortKey)}
            >
              <option value="name">{t("files.sort.nameShort")}</option>
              <option value="modifiedDesc">{t("files.sort.modifiedDescShort")}</option>
              <option value="modifiedAsc">{t("files.sort.modifiedAscShort")}</option>
            </select>
          </label>
          <FilesListAttributeMenu
            attributes={filesListAttributes}
            onChange={onFilesListAttributesChange}
            t={t}
          />
          <button
            type="button"
            className="files-list-action-button files-add-selected"
            onClick={() => onQueueFiles(selectedEntries)}
            disabled={selectedEntries.length === 0}
            title={t("files.queueSelected")}
            aria-label={t("files.queueSelected")}
          >
            <Plus size={13} />
            {selectedEntries.length > 0 ? (
              <span className="files-add-count">{selectedEntries.length}</span>
            ) : null}
          </button>
        </div>
      ) : (
        <div
          className="tree-bulk-actions files-tree-actions"
          role="group"
          aria-label={t("files.tree.actions")}
        >
          <button
            type="button"
            className="files-list-action-button"
            onClick={() => onCollapsedFileFoldersChange([])}
            disabled={folderPaths.length === 0}
            title={t("list.tree.collapseAll")}
            aria-label={t("list.tree.collapseAll")}
          >
            <ChevronsDownUp size={13} />
            <span>{t("list.tree.collapseAll")}</span>
          </button>
          <button
            type="button"
            className="files-list-action-button"
            onClick={() => onCollapsedFileFoldersChange(folderPaths)}
            disabled={folderPaths.length === 0}
            title={t("list.tree.expandAll")}
            aria-label={t("list.tree.expandAll")}
          >
            <ChevronsUpDown size={13} />
            <span>{t("list.tree.expandAll")}</span>
          </button>
          <button
            type="button"
            className="files-list-action-button files-add-selected"
            onClick={() => onQueueFiles(selectedEntries)}
            disabled={selectedEntries.length === 0}
            title={t("files.queueSelected")}
            aria-label={t("files.queueSelected")}
          >
            <Plus size={13} />
            {selectedEntries.length > 0 ? (
              <span className="files-add-count">{selectedEntries.length}</span>
            ) : null}
          </button>
        </div>
      )}

      <label className="search-box" title={t("files.searchPlaceholder")}>
        <Search size={14} />
        <input
          value={inputQuery}
          onChange={(event) => {
            const next = event.target.value;
            lastSentQueryRef.current = next;
            setInputQuery(next);
            startSearchTransition(() => onQueryChange(next));
          }}
          placeholder={t("files.searchPlaceholder")}
        />
      </label>

      <div
        className="list-scroll"
        ref={scrollRef}
        onScroll={(event) =>
          setViewport({
            scrollTop: event.currentTarget.scrollTop,
            height: event.currentTarget.clientHeight || 720,
          })
        }
      >
        {loading ? (
          <div className="skeleton-stack" aria-label={t("files.loading")}>
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!loading && paneFiltered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illus" title={t("files.empty.title")}>
              <Files size={22} />
            </div>
            <strong>{t("files.empty.title")}</strong>
            <p>{t("files.empty.description")}</p>
          </div>
        ) : null}

        {!loading && paneFiltered.length > 0 && browserMode === "tree" ? (
          <WorkspaceFileTree
            rows={virtualTreeLayout.rows}
            totalHeight={virtualTreeLayout.totalHeight}
            rowHeight={FILE_TREE_ROW_HEIGHT}
            selectedSet={selectedSet}
            selectedEntries={selectedEntries}
            collapsedFileFolders={collapsedFileFolders}
            forceExpand={forceExpandTree}
            onCollapsedFileFoldersChange={onCollapsedFileFoldersChange}
            onSelectFile={onSelectFile}
            onOpenFile={onOpenFile}
            onContextMenu={(event, entry) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                targetPath: entry.path,
                relPath: entry.relPath,
                title: entry.name,
                entry,
                targetKind: "file",
              });
            }}
            onFolderContextMenu={(event, row) => {
              if (!workspacePath) return;
              event.preventDefault();
              event.stopPropagation();
              const targetPath = joinWorkspacePath(workspacePath, row.path);
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                targetPath,
                relPath: row.path,
                title: row.path,
                entry: null,
                targetKind: "directory",
              });
            }}
            selectedFileQueueCount={selectedFileQueueCount}
            onApplyFileQueueToDestination={onApplyFileQueueToDestination}
            onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
            dragOverTargetPath={dragOverTargetPath}
            onDragOverTargetChange={setDragOverTargetPath}
            workspacePath={workspacePath}
            t={t}
            locale={locale}
          />
        ) : null}

        {!loading && paneFiltered.length > 0 && browserMode === "list" ? (
          <WorkspaceFileList
            rows={virtualListLayout.rows}
            totalHeight={virtualListLayout.totalHeight}
            selectedSet={selectedSet}
            selectedEntries={selectedEntries}
            queuedPathSet={queuedPathSet}
            attributes={filesListAttributes}
            onSelectFile={onSelectFile}
            onOpenFile={onOpenFile}
            onContextMenu={(event, entry) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                targetPath: entry.path,
                relPath: entry.relPath,
                title: entry.name,
                entry,
                targetKind: "file",
              });
            }}
            selectedFileQueueCount={selectedFileQueueCount}
            onApplyFileQueueToDestination={onApplyFileQueueToDestination}
            onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
            dragOverTargetPath={dragOverTargetPath}
            onDragOverTargetChange={setDragOverTargetPath}
            workspacePath={workspacePath}
            t={t}
            locale={locale}
          />
        ) : null}
      </div>

      {contextMenu ? (
        <div
          ref={contextMenuRef}
          className="context-menu"
          role="menu"
          tabIndex={-1}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={handleContextMenuKeyDown}
        >
          <div className="context-menu-title" title={contextMenu.relPath}>
            {contextMenu.title}
          </div>
          {contextMenu.entry && isOpenableDocumentFile(contextMenu.entry) ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const entry = contextMenu.entry;
                if (!entry) return;
                setContextMenu(null);
                onOpenFile(entry);
              }}
            >
              {t("context.openFile")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const entry = contextMenu.entry;
              setContextMenu(null);
              if (entry) onQueueFiles([entry]);
            }}
            disabled={!contextMenu.entry}
          >
            {t("files.queue")}
          </button>
          {onApplySkillToTarget ? (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const target = contextMenu.targetPath;
                const kind = contextMenu.targetKind;
                setContextMenu(null);
                onApplySkillToTarget(target, kind);
              }}
            >
              {t("context.applySkill")}
            </button>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              const target = contextMenu.targetPath;
              setContextMenu(null);
              onRevealInFinder(target);
            }}
          >
            {t("context.revealInFinder")}
          </button>
          {selectedFileQueueCount > 0 && onApplyFileQueueToDestination ? (
            <>
              <div className="context-menu-separator" role="separator" />
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contextMenu.targetPath;
                  const kind = contextMenu.targetKind;
                  setContextMenu(null);
                  onApplyFileQueueToDestination(target, kind, "copy");
                }}
              >
                {t("rightPane.files.copySelectedHere", { count: selectedFileQueueCount })}
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const target = contextMenu.targetPath;
                  const kind = contextMenu.targetKind;
                  setContextMenu(null);
                  onApplyFileQueueToDestination(target, kind, "move");
                }}
              >
                {t("rightPane.files.moveSelectedHere", { count: selectedFileQueueCount })}
              </button>
            </>
          ) : null}
          <div className="context-menu-separator" role="separator" />
          <button type="button" role="menuitem" onClick={() => copyText(contextMenu.targetPath)}>
            {t("context.copyPath")}
          </button>
          <button type="button" role="menuitem" onClick={() => copyText(contextMenu.relPath)}>
            {t("context.copyRelativePath")}
          </button>
        </div>
      ) : null}
    </section>
  );
});

function FilesListAttributeMenu({
  attributes,
  onChange,
  t,
}: {
  attributes: FilesListAttribute[];
  onChange: (attributes: FilesListAttribute[]) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
}) {
  const selected = new Set(attributes);
  const toggleAttribute = (attribute: FilesListAttribute, checked: boolean) => {
    const next = new Set(attributes);
    if (checked) next.add(attribute);
    else next.delete(attribute);
    onChange(ALL_FILES_LIST_ATTRIBUTES.filter((value) => next.has(value)));
  };
  return (
    <details className="files-attribute-menu">
      <summary title={t("files.attributes.label")} aria-label={t("files.attributes.label")}>
        <SlidersHorizontal size={13} />
        <span>{t("files.attributes.short")}</span>
        <span className="files-attribute-count">{attributes.length}</span>
      </summary>
      <div className="files-attribute-popover">
        <div className="files-attribute-title">{t("files.attributes.label")}</div>
        {ALL_FILES_LIST_ATTRIBUTES.map((attribute) => (
          <label key={attribute} className="files-attribute-option">
            <input
              type="checkbox"
              checked={selected.has(attribute)}
              onChange={(event) => toggleAttribute(attribute, event.target.checked)}
            />
            <span>{t(`files.attributes.${attribute}`)}</span>
          </label>
        ))}
      </div>
    </details>
  );
}

interface WorkspaceFileTreeProps {
  rows: VirtualWorkspaceFileTreeRow[];
  totalHeight: number;
  rowHeight: number;
  selectedSet: Set<string>;
  selectedEntries: WorkspaceFileEntry[];
  collapsedFileFolders: string[];
  forceExpand: boolean;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  onFolderContextMenu: (event: React.MouseEvent, row: FolderRow) => void;
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  dragOverTargetPath: string | null;
  onDragOverTargetChange: (targetPath: string | null) => void;
  workspacePath?: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

const WorkspaceFileTree = memo(function WorkspaceFileTree({
  rows,
  totalHeight,
  rowHeight,
  selectedSet,
  selectedEntries,
  collapsedFileFolders,
  forceExpand,
  onCollapsedFileFoldersChange,
  onSelectFile,
  onOpenFile,
  onContextMenu,
  onFolderContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  workspacePath,
  t,
  locale,
}: WorkspaceFileTreeProps) {
  return (
    <div
      className="tree-virtual-spacer"
      role="tree"
      aria-label={t("explorer.mode.files")}
      style={{ height: totalHeight }}
    >
      {rows.map(({ row, top }) => {
        const paddingLeft = 8 + row.depth * 16;
        return (
          <div
            key={row.id}
            className="virtual-list-row tree"
            style={{ height: rowHeight, transform: `translateY(${top}px)` }}
          >
            {row.kind === "folder" ? (
              <FileFolderRow
                row={row}
                paddingLeft={paddingLeft}
                collapsedFileFolders={collapsedFileFolders}
                forceExpand={forceExpand}
                onCollapsedFileFoldersChange={onCollapsedFileFoldersChange}
                onContextMenu={onFolderContextMenu}
                selectedFileQueueCount={selectedFileQueueCount}
                onApplyFileQueueToDestination={onApplyFileQueueToDestination}
                onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
                dragOverTargetPath={dragOverTargetPath}
                onDragOverTargetChange={onDragOverTargetChange}
                workspacePath={workspacePath}
              />
            ) : (
              <FileRow
                row={row}
                paddingLeft={paddingLeft}
                selected={selectedSet.has(row.entry.path)}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
                selectedEntries={selectedEntries}
                selectedFileQueueCount={selectedFileQueueCount}
                onApplyFileQueueToDestination={onApplyFileQueueToDestination}
                onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
                dragOverTargetPath={dragOverTargetPath}
                onDragOverTargetChange={onDragOverTargetChange}
                workspacePath={workspacePath}
                locale={locale}
              />
            )}
          </div>
        );
      })}
    </div>
  );
});

type FolderRow = Extract<WorkspaceFileTreeRow, { kind: "folder" }>;
type FileTreeFileRow = Extract<WorkspaceFileTreeRow, { kind: "file" }>;

const FileFolderRow = memo(function FileFolderRow({
  row,
  paddingLeft,
  collapsedFileFolders,
  forceExpand,
  onCollapsedFileFoldersChange,
  onContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  workspacePath,
}: {
  row: FolderRow;
  paddingLeft: number;
  collapsedFileFolders: string[];
  forceExpand: boolean;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
  onContextMenu: (event: React.MouseEvent, row: FolderRow) => void;
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  dragOverTargetPath: string | null;
  onDragOverTargetChange: (targetPath: string | null) => void;
  workspacePath?: string | null;
}) {
  const folderTarget = workspacePath ? joinWorkspacePath(workspacePath, row.path) : row.path;
  const canDrop = (event: React.DragEvent): boolean =>
    Boolean(
      (onApplyExplorerDragToDestination && hasExplorerDragPayload(event.dataTransfer)) ||
        (onApplyFileQueueToDestination &&
          (hasFileQueueDragPayload(event.dataTransfer) || (selectedFileQueueCount ?? 0) > 0)),
    );
  return (
    <button
      type="button"
      className={
        dragOverTargetPath === folderTarget ? "tree-row folder drag-over" : "tree-row folder"
      }
      style={{ paddingLeft }}
      aria-expanded={!row.collapsed}
      draggable={Boolean(workspacePath)}
      onClick={() =>
        onCollapsedFileFoldersChange(
          nextCollapsedFileFolders(
            collapsedFileFolders,
            row.path,
            forceExpand ? true : !row.collapsed,
          ),
        )
      }
      title={row.path}
      onContextMenu={(event) => onContextMenu(event, row)}
      onDragStart={(event) => {
        if (!workspacePath) return;
        writeExplorerDragPayload(event, {
          origin: "files",
          workspacePath,
          items: [
            {
              path: folderTarget,
              relPath: row.path,
              fileName: row.name,
              sourceKind: "directory",
            },
          ],
        });
      }}
      onDragEnd={clearExplorerDragPayload}
      onDragOver={(event) => {
        if (!canDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dropOperationFromEvent(event);
        onDragOverTargetChange(folderTarget);
      }}
      onDragLeave={() => onDragOverTargetChange(null)}
      onDrop={(event) => {
        const payload = readExplorerDragPayload(event.dataTransfer);
        const queuePayload = readFileQueueDragPayload(event.dataTransfer);
        onDragOverTargetChange(null);
        if (payload && onApplyExplorerDragToDestination) {
          event.preventDefault();
          clearExplorerDragPayload();
          onApplyExplorerDragToDestination(
            payload,
            folderTarget,
            "directory",
            dropOperationFromEvent(event),
          );
          return;
        }
        if (queuePayload && onApplyFileQueueToDestination) {
          event.preventDefault();
          clearFileQueueDragPayload();
          void onApplyFileQueueToDestination(
            folderTarget,
            "directory",
            dropOperationFromEvent(event),
            queuePayload.itemIds,
          );
          return;
        }
        if (!selectedFileQueueCount || !onApplyFileQueueToDestination || !workspacePath) return;
        event.preventDefault();
        void onApplyFileQueueToDestination(
          folderTarget,
          "directory",
          dropOperationFromEvent(event),
        );
      }}
    >
      <ChevronRight
        size={13}
        className={row.collapsed ? "tree-chevron" : "tree-chevron open"}
      />
      <Folder size={14} />
      <span className="tree-row-title">{row.name}</span>
      <span className="tree-count">{row.count}</span>
    </button>
  );
});

const FileRow = memo(function FileRow({
  row,
  paddingLeft,
  selected,
  onSelectFile,
  onOpenFile,
  onContextMenu,
  selectedEntries,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  workspacePath,
  locale,
}: {
  row: FileTreeFileRow;
  paddingLeft: number;
  selected: boolean;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  selectedEntries: WorkspaceFileEntry[];
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  dragOverTargetPath: string | null;
  onDragOverTargetChange: (targetPath: string | null) => void;
  workspacePath?: string | null;
  locale: string;
}) {
  const canDrop = (event: React.DragEvent): boolean =>
    Boolean(
      (onApplyExplorerDragToDestination && hasExplorerDragPayload(event.dataTransfer)) ||
        (onApplyFileQueueToDestination &&
          (hasFileQueueDragPayload(event.dataTransfer) || (selectedFileQueueCount ?? 0) > 0)),
    );
  const dragEntries = selected && selectedEntries.length > 0 ? selectedEntries : [row.entry];
  return (
    <button
      type="button"
      className={[
        "tree-row file",
        selected ? "selected" : "",
        dragOverTargetPath === row.entry.path ? "drag-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ paddingLeft }}
      draggable={Boolean(workspacePath)}
      onClick={(event) => onSelectFile(row.entry, event.metaKey || event.ctrlKey)}
      onDoubleClick={() => onOpenFile(row.entry)}
      onContextMenu={(event) => onContextMenu(event, row.entry)}
      onDragStart={(event) => {
        if (!workspacePath) return;
        writeExplorerDragPayload(event, {
          origin: "files",
          workspacePath,
          items: dragEntries.map((entry) => ({
            path: entry.path,
            relPath: entry.relPath,
            fileName: entry.name,
            sourceKind: "file",
          })),
        });
      }}
      onDragEnd={clearExplorerDragPayload}
      onDragOver={(event) => {
        if (!canDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dropOperationFromEvent(event);
        onDragOverTargetChange(row.entry.path);
      }}
      onDragLeave={() => onDragOverTargetChange(null)}
      onDrop={(event) => {
        const payload = readExplorerDragPayload(event.dataTransfer);
        const queuePayload = readFileQueueDragPayload(event.dataTransfer);
        onDragOverTargetChange(null);
        if (payload && onApplyExplorerDragToDestination) {
          event.preventDefault();
          clearExplorerDragPayload();
          onApplyExplorerDragToDestination(
            payload,
            row.entry.path,
            "file",
            dropOperationFromEvent(event),
          );
          return;
        }
        if (queuePayload && onApplyFileQueueToDestination) {
          event.preventDefault();
          clearFileQueueDragPayload();
          void onApplyFileQueueToDestination(
            row.entry.path,
            "file",
            dropOperationFromEvent(event),
            queuePayload.itemIds,
          );
          return;
        }
        if (!selectedFileQueueCount || !onApplyFileQueueToDestination) return;
        event.preventDefault();
        void onApplyFileQueueToDestination(
          row.entry.path,
          "file",
          dropOperationFromEvent(event),
        );
      }}
      title={row.entry.relPath}
      aria-selected={selected}
      data-tree-target-path={row.entry.path}
    >
      <span className="tree-indent-slot" />
      {isOpenableDocumentFile(row.entry) ? <FileText size={13} /> : <File size={13} />}
      <span className="tree-row-title">{row.entry.name}</span>
      {row.entry.gitTracked ? (
        <span className="tree-type" data-type="git">
          git
        </span>
      ) : null}
      {row.entry.binary ? (
        <span className="tree-type" data-type="binary">
          bin
        </span>
      ) : (
        <span className="tree-type">{row.entry.fileKind.toUpperCase()}</span>
      )}
      <span className="tree-size">{formatBytes(row.entry.sizeBytes, locale)}</span>
    </button>
  );
});

function formatBytes(value: number, locale: string): string {
  if (value < 1024) return `${value.toLocaleString(locale)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function joinWorkspacePath(workspacePath: string, relPath: string): string {
  return `${workspacePath.replace(/\/+$/, "")}/${relPath.replace(/^\/+/, "")}`;
}

function formatRelativeTime(
  isoString: string | null | undefined,
  t: (key: string, vars?: Record<string, string | number>) => string,
  now: number = Date.now(),
): string {
  if (!isoString) return "";
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return "";
  const diff = Math.max(0, now - ts);
  const minute = 60 * 1000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const week = 7 * day;
  const month = 30 * day;
  const year = 365 * day;
  if (diff < minute) return t("files.row.relTime.now");
  if (diff < hour) return t("files.row.relTime.minutes", { count: Math.floor(diff / minute) });
  if (diff < day) return t("files.row.relTime.hours", { count: Math.floor(diff / hour) });
  if (diff < week) return t("files.row.relTime.days", { count: Math.floor(diff / day) });
  if (diff < month) return t("files.row.relTime.weeks", { count: Math.floor(diff / week) });
  if (diff < year) return t("files.row.relTime.months", { count: Math.floor(diff / month) });
  return t("files.row.relTime.years", { count: Math.floor(diff / year) });
}

function formatAbsoluteTime(isoString: string | null | undefined, locale: string): string {
  if (!isoString) return "";
  const ts = Date.parse(isoString);
  if (!Number.isFinite(ts)) return "";
  return new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(ts));
}

// ---------------------------------------------------------------------------
// List-view rendering
// ---------------------------------------------------------------------------

interface WorkspaceFileListProps {
  rows: VirtualWorkspaceFileListRow[];
  totalHeight: number;
  selectedSet: Set<string>;
  selectedEntries: WorkspaceFileEntry[];
  queuedPathSet: Set<string>;
  attributes: FilesListAttribute[];
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  dragOverTargetPath: string | null;
  onDragOverTargetChange: (targetPath: string | null) => void;
  workspacePath?: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

const WorkspaceFileList = memo(function WorkspaceFileList({
  rows,
  totalHeight,
  selectedSet,
  selectedEntries,
  queuedPathSet,
  attributes,
  onSelectFile,
  onOpenFile,
  onContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  workspacePath,
  t,
  locale,
}: WorkspaceFileListProps) {
  return (
    <div
      className="tree-virtual-spacer files-list"
      role="list"
      aria-label={t("files.view.list")}
      style={{ height: totalHeight }}
    >
      {rows.map(({ row, top, height }) => {
        if (row.kind === "group") {
          return (
            <div
              key={row.id}
              className="virtual-list-row files-list-group"
              style={{ height, transform: `translateY(${top}px)` }}
            >
              <span className="files-list-group-label">{row.label}</span>
              <span className="files-list-group-count">{row.count}</span>
            </div>
          );
        }
        return (
          <div
            key={row.id}
            className="virtual-list-row"
            style={{ height, transform: `translateY(${top}px)` }}
          >
            <FileListRow
              entry={row.entry}
              selected={selectedSet.has(row.entry.path)}
              queued={queuedPathSet.has(row.entry.path)}
              attributes={attributes}
              onSelectFile={onSelectFile}
              onOpenFile={onOpenFile}
              onContextMenu={onContextMenu}
              selectedEntries={selectedEntries}
              selectedFileQueueCount={selectedFileQueueCount}
              onApplyFileQueueToDestination={onApplyFileQueueToDestination}
              onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
              dragOverTargetPath={dragOverTargetPath}
              onDragOverTargetChange={onDragOverTargetChange}
              workspacePath={workspacePath}
              t={t}
              locale={locale}
            />
          </div>
        );
      })}
    </div>
  );
});

interface FileListRowProps {
  entry: WorkspaceFileEntry;
  selected: boolean;
  queued: boolean;
  attributes: FilesListAttribute[];
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  selectedEntries: WorkspaceFileEntry[];
  selectedFileQueueCount?: number;
  onApplyFileQueueToDestination?: ApplyFileQueueToDestination;
  onApplyExplorerDragToDestination?: (
    payload: ExplorerDragPayload,
    targetPath: string,
    targetKind: "file" | "directory",
    operation: FileStoreOperation,
  ) => void;
  dragOverTargetPath: string | null;
  onDragOverTargetChange: (targetPath: string | null) => void;
  workspacePath?: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

const FileListRow = memo(function FileListRow({
  entry,
  selected,
  queued,
  attributes,
  onSelectFile,
  onOpenFile,
  onContextMenu,
  selectedEntries,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  workspacePath,
  t,
  locale,
}: FileListRowProps) {
  const canDrop = (event: React.DragEvent): boolean =>
    Boolean(
      (onApplyExplorerDragToDestination && hasExplorerDragPayload(event.dataTransfer)) ||
        (onApplyFileQueueToDestination &&
          (hasFileQueueDragPayload(event.dataTransfer) || (selectedFileQueueCount ?? 0) > 0)),
    );
  const dragEntries = selected && selectedEntries.length > 0 ? selectedEntries : [entry];
  const parentDir = entry.relPath.includes("/")
    ? entry.relPath.slice(0, entry.relPath.lastIndexOf("/"))
    : "";
  const visibleAttributes = new Set(attributes);
  const modifiedRelative = formatRelativeTime(entry.updatedAt, t);
  const modifiedAbsolute = formatAbsoluteTime(entry.updatedAt, locale);
  const kindLabel = (entry.extension ?? entry.fileKind).toUpperCase();
  const hasMeta =
    queued ||
    (visibleAttributes.has("parent") && parentDir) ||
    visibleAttributes.has("kind") ||
    (visibleAttributes.has("modified") && modifiedRelative) ||
    visibleAttributes.has("size") ||
    (visibleAttributes.has("git") && entry.gitTracked) ||
    (visibleAttributes.has("binary") && entry.binary);
  return (
    <button
      type="button"
      className={[
        "files-list-row",
        selected ? "selected" : "",
        queued ? "queued" : "",
        dragOverTargetPath === entry.path ? "drag-over" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      draggable={Boolean(workspacePath)}
      onClick={(event) => onSelectFile(entry, event.metaKey || event.ctrlKey)}
      onDoubleClick={() => onOpenFile(entry)}
      onContextMenu={(event) => onContextMenu(event, entry)}
      onDragStart={(event) => {
        if (!workspacePath) return;
        writeExplorerDragPayload(event, {
          origin: "files",
          workspacePath,
          items: dragEntries.map((selectedEntry) => ({
            path: selectedEntry.path,
            relPath: selectedEntry.relPath,
            fileName: selectedEntry.name,
            sourceKind: "file",
          })),
        });
      }}
      onDragEnd={clearExplorerDragPayload}
      onDragOver={(event) => {
        if (!canDrop(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = dropOperationFromEvent(event);
        onDragOverTargetChange(entry.path);
      }}
      onDragLeave={() => onDragOverTargetChange(null)}
      onDrop={(event) => {
        const payload = readExplorerDragPayload(event.dataTransfer);
        const queuePayload = readFileQueueDragPayload(event.dataTransfer);
        onDragOverTargetChange(null);
        if (payload && onApplyExplorerDragToDestination) {
          event.preventDefault();
          clearExplorerDragPayload();
          onApplyExplorerDragToDestination(payload, entry.path, "file", dropOperationFromEvent(event));
          return;
        }
        if (queuePayload && onApplyFileQueueToDestination) {
          event.preventDefault();
          clearFileQueueDragPayload();
          void onApplyFileQueueToDestination(
            entry.path,
            "file",
            dropOperationFromEvent(event),
            queuePayload.itemIds,
          );
          return;
        }
        if (!selectedFileQueueCount || !onApplyFileQueueToDestination) return;
        event.preventDefault();
        void onApplyFileQueueToDestination(entry.path, "file", dropOperationFromEvent(event));
      }}
      title={entry.relPath}
      aria-selected={selected}
      data-tree-target-path={entry.path}
    >
      {isOpenableDocumentFile(entry) ? <FileText size={13} /> : <File size={13} />}
      <span className="files-list-main">
        <span className="files-list-name">{entry.name}</span>
        {hasMeta ? (
          <span className="files-list-meta-line">
            {queued ? (
              <span className="files-list-badge" data-kind="queued">
                {t("files.row.queued")}
              </span>
            ) : null}
            {visibleAttributes.has("parent") && parentDir ? (
              <span className="files-list-parent" title={parentDir}>
                {parentDir}
              </span>
            ) : null}
            {visibleAttributes.has("kind") ? (
              <span className="files-list-chip">{kindLabel}</span>
            ) : null}
            {visibleAttributes.has("modified") && modifiedRelative ? (
              <span className="files-list-mtime" title={modifiedAbsolute}>
                {modifiedRelative}
              </span>
            ) : null}
            {visibleAttributes.has("size") ? (
              <span className="tree-size">{formatBytes(entry.sizeBytes, locale)}</span>
            ) : null}
            {visibleAttributes.has("git") && entry.gitTracked ? (
              <span className="files-list-chip" data-type="git">
                git
              </span>
            ) : null}
            {visibleAttributes.has("binary") && entry.binary ? (
              <span className="files-list-chip" data-type="binary">
                bin
              </span>
            ) : null}
          </span>
        ) : null}
      </span>
    </button>
  );
});
