import {
  ChevronsDownUp,
  ChevronsUpDown,
  ChevronRight,
  FileText,
  Files,
  Folder,
  List,
  PanelLeftClose,
  RefreshCcw,
  Search,
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
import type { FileStoreOperation, VaultEntry, WorkspaceVisibility } from "../lib/types";
import { documentDisplayName, formatRelativeDate, frontmatterScalar } from "../lib/document";
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
import {
  buildDocumentTreeRows,
  collectDocumentTreeFolderPaths,
  nextCollapsedFolders,
  virtualizeDocumentTreeRows,
  type DocumentTreeRow,
  type VirtualTreeRow,
} from "../lib/documentTree";
import {
  documentFilterKey,
  filterDocumentIndex,
  isAllDocumentFilter,
  type DocumentFilter,
  type DocumentIndex,
} from "../lib/documentIndex";
import { useTranslation } from "../lib/i18n";
import type { DocumentBrowserMode, DocumentLabelMode, DocumentViewDefinition } from "../lib/settings";
import type { ExplorerPaneMode } from "../lib/settings";

const GROUP_ROW_HEIGHT = 28;
const ENTRY_ROW_HEIGHT = 132;
const TREE_ROW_HEIGHT = 30;
const VIRTUAL_OVERSCAN = 520;

type VirtualRow =
  | { kind: "group"; key: string; label: string; count: number; height: number }
  | { kind: "entry"; key: string; entry: VaultEntry; height: number };

type ApplyFileQueueToDestination = (
  targetPath: string,
  targetKind: "file" | "directory",
  operation: FileStoreOperation,
  itemIds?: string[],
) => void;

interface DocumentListProps {
  documentIndex: DocumentIndex;
  selectedPath: string | null;
  query: string;
  loading: boolean;
  documentFilter: DocumentFilter;
  documentViews: DocumentViewDefinition[];
  workspaceVisibility: WorkspaceVisibility;
  publicWorkspaceAvailable: boolean;
  activeWorkspaceLabel: string | null;
  onWorkspaceVisibilityChange: (visibility: WorkspaceVisibility) => void;
  onAddPublicWorkspace: () => void;
  browserMode: DocumentBrowserMode;
  documentLabelMode: DocumentLabelMode;
  collapsedTreeFolders: string[];
  onQueryChange: (query: string) => void;
  onBrowserModeChange: (mode: DocumentBrowserMode) => void;
  onCollapsedTreeFoldersChange: (paths: string[]) => void;
  onSelect: (entry: VaultEntry) => void;
  onRevealInFinder: (targetPath: string) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  onClose?: () => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  paneRef?: React.RefObject<HTMLElement | null>;
  vaultPath?: string | null;
  paneMode: ExplorerPaneMode;
  onPaneModeChange: (mode: ExplorerPaneMode) => void;
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
}

export const DocumentList = memo(function DocumentList({
  documentIndex,
  selectedPath,
  query,
  loading,
  documentFilter,
  documentViews,
  workspaceVisibility,
  publicWorkspaceAvailable,
  activeWorkspaceLabel,
  onWorkspaceVisibilityChange,
  onAddPublicWorkspace,
  browserMode,
  documentLabelMode,
  collapsedTreeFolders,
  onQueryChange,
  onBrowserModeChange,
  onCollapsedTreeFoldersChange,
  onSelect,
  onRevealInFinder,
  onRefresh,
  refreshing = false,
  onClose,
  searchInputRef,
  paneRef,
  vaultPath,
  paneMode,
  onPaneModeChange,
  pendingRevealTargetPath = null,
  onRevealHandled,
  selectedFileQueueCount = 0,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
}: DocumentListProps) {
  const { t, locale } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSentQueryRef = useRef(query);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });
  const [inputQuery, setInputQuery] = useState(query);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    targetPath: string;
    relPath: string;
    title: string;
    entry: VaultEntry | null;
    targetKind: "file" | "directory";
  } | null>(null);
  const [dragOverTargetPath, setDragOverTargetPath] = useState<string | null>(null);
  const [, startSearchTransition] = useTransition();
  const deferredQuery = useDeferredValue(query);
  const deferredDocumentFilter = useDeferredValue(documentFilter);
  const deferredFilterKey = documentFilterKey(deferredDocumentFilter);

  useEffect(() => {
    if (query === lastSentQueryRef.current) return;
    lastSentQueryRef.current = query;
    setInputQuery(query);
  }, [query]);

  const filtered = useMemo(
    () =>
      filterDocumentIndex(documentIndex, deferredQuery, deferredDocumentFilter, {
        customViews: documentViews,
      }),
    [documentIndex, deferredQuery, deferredDocumentFilter, documentViews],
  );

  // Group by mtime bucket: Today / This week / Earlier
  const grouped = useMemo(() => {
    if (browserMode !== "list") return [];
    if (deferredQuery.trim() || !isAllDocumentFilter(deferredDocumentFilter)) {
      return [{ label: null, items: filtered }];
    }
    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;
    const buckets: { label: string | null; items: VaultEntry[] }[] = [
      { label: t("list.group.today"), items: [] },
      { label: t("list.group.thisWeek"), items: [] },
      { label: t("list.group.earlier"), items: [] },
    ];
    for (const entry of filtered) {
      const ts = entry.updatedAt ? new Date(entry.updatedAt).getTime() : 0;
      const age = now - ts;
      if (age < day) buckets[0].items.push(entry);
      else if (age < 7 * day) buckets[1].items.push(entry);
      else buckets[2].items.push(entry);
    }
    return buckets.filter((b) => b.items.length > 0);
  }, [browserMode, filtered, deferredQuery, deferredDocumentFilter, t]);

  const virtualRows = useMemo<VirtualRow[]>(() => {
    if (browserMode !== "list") return [];
    const rows: VirtualRow[] = [];
    for (const [groupIdx, group] of grouped.entries()) {
      if (group.label) {
        rows.push({
          kind: "group",
          key: `g-${group.label}-${groupIdx}`,
          label: group.label,
          count: group.items.length,
          height: GROUP_ROW_HEIGHT,
        });
      }
      for (const entry of group.items) {
        rows.push({ kind: "entry", key: entry.path, entry, height: ENTRY_ROW_HEIGHT });
      }
    }
    return rows;
  }, [browserMode, grouped]);

  const virtualLayout = useMemo(() => {
    let offset = 0;
    const rows = virtualRows.map((row) => {
      const top = offset;
      offset += row.height;
      return { row, top };
    });
    return { rows, totalHeight: offset };
  }, [virtualRows]);

  const visibleRows = useMemo(() => {
    const min = Math.max(0, viewport.scrollTop - VIRTUAL_OVERSCAN);
    const max = viewport.scrollTop + viewport.height + VIRTUAL_OVERSCAN;
    return virtualLayout.rows.filter(
      ({ row, top }) => top + row.height >= min && top <= max,
    );
  }, [virtualLayout.rows, viewport]);

  const forceExpandTree = Boolean(deferredQuery.trim() || !isAllDocumentFilter(deferredDocumentFilter));
  const folderPaths = useMemo(
    () => collectDocumentTreeFolderPaths(documentIndex.entries),
    [documentIndex.entries],
  );
  const treeRows = useMemo(
    () =>
      browserMode === "tree"
        ? buildDocumentTreeRows(filtered, collapsedTreeFolders, forceExpandTree)
        : [],
    [browserMode, filtered, collapsedTreeFolders, forceExpandTree],
  );
  const virtualTreeLayout = useMemo(
    () =>
      virtualizeDocumentTreeRows(
        treeRows,
        viewport.scrollTop,
        viewport.height,
        VIRTUAL_OVERSCAN,
        TREE_ROW_HEIGHT,
      ),
    [treeRows, viewport],
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
  }, [deferredQuery, deferredFilterKey]);

  useEffect(() => {
    if (!pendingRevealTargetPath || browserMode !== "tree") return;
    const index = treeRows.findIndex(
      (row) => row.kind === "entry" && row.entry.path === pendingRevealTargetPath,
    );
    if (index < 0) {
      if (!loading) onRevealHandled?.();
      return;
    }
    const node = scrollRef.current;
    if (!node) return;
    const top = index * TREE_ROW_HEIGHT;
    node.scrollTop = Math.max(0, top - TREE_ROW_HEIGHT);
    setViewport({ scrollTop: node.scrollTop, height: node.clientHeight || 720 });
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        const selector = `[data-tree-target-path="${CSS.escape(pendingRevealTargetPath)}"]`;
        const target = scrollRef.current?.querySelector<HTMLButtonElement>(selector);
        target?.focus({ preventScroll: true });
        onRevealHandled?.();
      });
    });
  }, [browserMode, loading, onRevealHandled, pendingRevealTargetPath, treeRows]);

  const headerCaption = documentFilterTitle(documentFilter, documentViews, t);
  const copyContextText = (value: string) => {
    if (!value) return;
    const write = navigator.clipboard?.writeText(value);
    void write?.catch(() => {});
    setContextMenu(null);
  };
  const canDropOnTarget = (event: React.DragEvent): boolean =>
    Boolean(
      (onApplyExplorerDragToDestination && hasExplorerDragPayload(event.dataTransfer)) ||
        (onApplyFileQueueToDestination &&
          (hasFileQueueDragPayload(event.dataTransfer) || (selectedFileQueueCount ?? 0) > 0)),
    );
  const handleTargetDragOver = (
    event: React.DragEvent,
    targetPath: string,
  ) => {
    if (!canDropOnTarget(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dropOperationFromEvent(event);
    setDragOverTargetPath(targetPath);
  };
  const handleTargetDrop = (
    event: React.DragEvent,
    targetPath: string,
    targetKind: "file" | "directory",
  ) => {
    const payload = readExplorerDragPayload(event.dataTransfer);
    const queuePayload = readFileQueueDragPayload(event.dataTransfer);
    setDragOverTargetPath(null);
    if (payload && onApplyExplorerDragToDestination) {
      event.preventDefault();
      clearExplorerDragPayload();
      onApplyExplorerDragToDestination(
        payload,
        targetPath,
        targetKind,
        dropOperationFromEvent(event),
      );
      return;
    }
    if (queuePayload && onApplyFileQueueToDestination) {
      event.preventDefault();
      clearFileQueueDragPayload();
      onApplyFileQueueToDestination(
        targetPath,
        targetKind,
        dropOperationFromEvent(event),
        queuePayload.itemIds,
      );
      return;
    }
    if (!selectedFileQueueCount || !onApplyFileQueueToDestination) return;
    event.preventDefault();
    onApplyFileQueueToDestination(targetPath, targetKind, dropOperationFromEvent(event));
  };
  const writeDocumentDragPayload = (event: React.DragEvent, entry: VaultEntry) => {
    if (!vaultPath) return;
    writeExplorerDragPayload(event, {
      origin: "documents",
      workspacePath: vaultPath,
      items: [
        {
          path: entry.path,
          relPath: entry.relPath,
          fileName: entry.relPath.split("/").pop() ?? entry.relPath,
          sourceKind: "file",
        },
      ],
    });
  };

  return (
    <section className="document-list" ref={paneRef}>
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
          <h2>{headerCaption}</h2>
          {activeWorkspaceLabel ? (
            <span className="workspace-caption">{activeWorkspaceLabel}</span>
          ) : null}
        </div>
        <span className="meta">{t("list.meta.count", { count: filtered.length })}</span>
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

      <div className="list-mode-toggle" role="group" aria-label={t("list.viewMode")}>
        <button
          type="button"
          className={browserMode === "list" ? "active" : ""}
          onClick={() => onBrowserModeChange("list")}
          title={t("list.view.list")}
          aria-label={t("list.view.list")}
        >
          <List size={13} />
          <span>{t("list.view.list")}</span>
        </button>
        <button
          type="button"
          className={browserMode === "tree" ? "active" : ""}
          onClick={() => onBrowserModeChange("tree")}
          title={t("list.view.tree")}
          aria-label={t("list.view.tree")}
        >
          <Folder size={13} />
          <span>{t("list.view.tree")}</span>
        </button>
      </div>

      {browserMode === "tree" ? (
        <div className="tree-bulk-actions" role="group" aria-label={t("list.tree.actions")}>
          <button
            type="button"
            onClick={() => onCollapsedTreeFoldersChange([])}
            disabled={folderPaths.length === 0}
            title={t("list.tree.collapseAll")}
            aria-label={t("list.tree.collapseAll")}
          >
            <ChevronsDownUp size={13} />
            <span>{t("list.tree.collapseAll")}</span>
          </button>
          <button
            type="button"
            onClick={() => onCollapsedTreeFoldersChange(folderPaths)}
            disabled={folderPaths.length === 0}
            title={t("list.tree.expandAll")}
            aria-label={t("list.tree.expandAll")}
          >
            <ChevronsUpDown size={13} />
            <span>{t("list.tree.expandAll")}</span>
          </button>
        </div>
      ) : null}

      <label className="search-box" title={t("list.searchPlaceholder")}>
        <Search size={14} />
        <input
          ref={searchInputRef}
          value={inputQuery}
          onChange={(event) => {
            const next = event.target.value;
            lastSentQueryRef.current = next;
            setInputQuery(next);
            startSearchTransition(() => onQueryChange(next));
          }}
          placeholder={t("list.searchPlaceholder")}
        />
        <span className="kbd">⌘F</span>
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
          <div className="skeleton-stack" aria-label={t("list.loading")}>
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!loading && filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illus" title={t("list.empty.title")}>
              <FileShape />
            </div>
            <strong>{t("list.empty.title")}</strong>
            <p>{t("list.empty.description")}</p>
          </div>
        ) : null}

        {!loading && filtered.length > 0 && browserMode === "tree" ? (
          <DocumentTree
            rows={virtualTreeLayout.rows}
            totalHeight={virtualTreeLayout.totalHeight}
            rowHeight={TREE_ROW_HEIGHT}
            selectedPath={selectedPath}
            collapsedTreeFolders={collapsedTreeFolders}
            forceExpand={forceExpandTree}
            onCollapsedTreeFoldersChange={onCollapsedTreeFoldersChange}
            onSelect={onSelect}
            onContextMenu={(event, target) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({
                x: event.clientX,
                y: event.clientY,
                ...target,
              });
            }}
            vaultPath={vaultPath}
            t={t}
            documentLabelMode={documentLabelMode}
            selectedFileQueueCount={selectedFileQueueCount}
            onApplyFileQueueToDestination={onApplyFileQueueToDestination}
            onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
            dragOverTargetPath={dragOverTargetPath}
            onDragOverTargetChange={setDragOverTargetPath}
          />
        ) : null}

        {!loading && filtered.length > 0 && browserMode === "list" ? (
          <div
            className="virtual-list-spacer"
            style={{ height: virtualLayout.totalHeight }}
          >
            {visibleRows.map(({ row, top }) => {
              if (row.kind === "group") {
                return (
                  <div
                    className="virtual-list-row group"
                    key={row.key}
                    style={{ height: row.height, transform: `translateY(${top}px)` }}
                  >
                    <div className="list-group-label">
                      {row.label}
                      <span className="count">{row.count}</span>
                    </div>
                  </div>
                );
              }
              const { entry } = row;
              const fmType = frontmatterScalar(entry.frontmatter, "type");
              const fmStatus = frontmatterScalar(entry.frontmatter, "status");
              return (
                <div
                  className="virtual-list-row entry"
                  key={row.key}
                  style={{ height: row.height, transform: `translateY(${top}px)` }}
                >
                  <button
                    type="button"
                    className={[
                      "doc-row",
                      selectedPath === entry.path ? "selected" : "",
                      dragOverTargetPath === entry.path ? "drag-over" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    draggable={Boolean(vaultPath)}
                    onClick={() => onSelect(entry)}
                    onDragStart={(event) => writeDocumentDragPayload(event, entry)}
                    onDragEnd={clearExplorerDragPayload}
                    onDragOver={(event) => handleTargetDragOver(event, entry.path)}
                    onDragLeave={() => setDragOverTargetPath(null)}
                    onDrop={(event) => handleTargetDrop(event, entry.path, "file")}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setContextMenu({
                        x: event.clientX,
                        y: event.clientY,
                        targetPath: entry.path,
                        relPath: entry.relPath,
                        title: entry.title,
                        entry,
                        targetKind: "file",
                      });
                    }}
                  >
                    <div className="doc-row-top">
                      {fmType ? (
                        <span className="type-badge" data-type={fmType.toLowerCase()}>
                          {fmType}
                        </span>
                      ) : (
                        <span className="type-badge">{entry.fileKind.toUpperCase()}</span>
                      )}
                      {fmStatus ? (
                        <span className="status-pill" data-status={fmStatus.toLowerCase()}>
                          {fmStatus}
                        </span>
                      ) : null}
                      <time dateTime={entry.updatedAt ?? undefined}>
                        {formatRelativeDate(entry.updatedAt, locale)}
                      </time>
                    </div>
                    <strong>{documentDisplayName(entry, documentLabelMode)}</strong>
                    {entry.snippet ? <p>{entry.snippet}</p> : null}
                    <div className="doc-row-meta">
                      <span>
                        {t("list.meta.words", {
                          count: entry.wordCount.toLocaleString(locale),
                        })}
                      </span>
                      {entry.versionCount > 0 ? (
                        <>
                          <span className="dot" />
                          <span>
                            {t("list.meta.versions", {
                              count: entry.versionCount.toLocaleString(locale),
                            })}
                          </span>
                        </>
                      ) : null}
                      <span className="dot" />
                      <span title={entry.relPath}>{entry.relPath}</span>
                    </div>
                  </button>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu-title" title={contextMenu.title}>
            {contextMenu.title}
          </div>
          {contextMenu.entry ? (
            <button
              type="button"
              onClick={() => {
                const entry = contextMenu.entry;
                setContextMenu(null);
                if (entry) void onSelect(entry);
              }}
            >
              {t("context.openFile")}
            </button>
          ) : null}
          <button
            type="button"
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
              <div className="context-menu-separator" />
              <button
                type="button"
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
          <div className="context-menu-separator" />
          <button type="button" onClick={() => copyContextText(contextMenu.targetPath)}>
            {t("context.copyPath")}
          </button>
          <button type="button" onClick={() => copyContextText(contextMenu.relPath)}>
            {t("context.copyRelativePath")}
          </button>
        </div>
      ) : null}
    </section>
  );
});

interface DocumentTreeProps {
  rows: VirtualTreeRow[];
  totalHeight: number;
  rowHeight: number;
  selectedPath: string | null;
  collapsedTreeFolders: string[];
  forceExpand: boolean;
  onCollapsedTreeFoldersChange: (paths: string[]) => void;
  onSelect: (entry: VaultEntry) => void;
  onContextMenu: (
    event: React.MouseEvent,
    target: DocumentContextTarget,
  ) => void;
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
  vaultPath?: string | null;
  t: (key: string, vars?: Record<string, string | number>) => string;
  documentLabelMode: DocumentLabelMode;
}

const DocumentTree = memo(function DocumentTree({
  rows,
  totalHeight,
  rowHeight,
  selectedPath,
  collapsedTreeFolders,
  forceExpand,
  onCollapsedTreeFoldersChange,
  onSelect,
  onContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  vaultPath,
  t,
  documentLabelMode,
}: DocumentTreeProps) {
  return (
    <div
      className="tree-virtual-spacer"
      role="tree"
      aria-label={t("list.view.tree")}
      style={{ height: totalHeight }}
    >
      {rows.map(({ row, top }) => {
        const paddingLeft = 8 + row.depth * 16;
        if (row.kind === "folder") {
          return (
            <div
              key={row.id}
              className="virtual-list-row tree"
              style={{ height: rowHeight, transform: `translateY(${top}px)` }}
            >
              <TreeFolderRow
                row={row}
                paddingLeft={paddingLeft}
                collapsedTreeFolders={collapsedTreeFolders}
                forceExpand={forceExpand}
                onCollapsedTreeFoldersChange={onCollapsedTreeFoldersChange}
                onContextMenu={onContextMenu}
                selectedFileQueueCount={selectedFileQueueCount}
                onApplyFileQueueToDestination={onApplyFileQueueToDestination}
                onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
                dragOverTargetPath={dragOverTargetPath}
                onDragOverTargetChange={onDragOverTargetChange}
                vaultPath={vaultPath}
              />
            </div>
          );
        }
        return (
          <div
            key={row.id}
            className="virtual-list-row tree"
            style={{ height: rowHeight, transform: `translateY(${top}px)` }}
          >
            <TreeEntryRow
              row={row}
              paddingLeft={paddingLeft}
              selected={selectedPath === row.entry.path}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              selectedFileQueueCount={selectedFileQueueCount}
              onApplyFileQueueToDestination={onApplyFileQueueToDestination}
              onApplyExplorerDragToDestination={onApplyExplorerDragToDestination}
              dragOverTargetPath={dragOverTargetPath}
              onDragOverTargetChange={onDragOverTargetChange}
              vaultPath={vaultPath}
              documentLabelMode={documentLabelMode}
            />
          </div>
        );
      })}
    </div>
  );
});

type FolderRow = Extract<DocumentTreeRow, { kind: "folder" }>;
type EntryRow = Extract<DocumentTreeRow, { kind: "entry" }>;
type DocumentContextTarget = {
  targetPath: string;
  relPath: string;
  title: string;
  entry: VaultEntry | null;
  targetKind: "file" | "directory";
};

const TreeFolderRow = memo(function TreeFolderRow({
  row,
  paddingLeft,
  collapsedTreeFolders,
  forceExpand,
  onCollapsedTreeFoldersChange,
  onContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  vaultPath,
}: {
  row: FolderRow;
  paddingLeft: number;
  collapsedTreeFolders: string[];
  forceExpand: boolean;
  onCollapsedTreeFoldersChange: (paths: string[]) => void;
  onContextMenu: (
    event: React.MouseEvent,
    target: DocumentContextTarget,
  ) => void;
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
  vaultPath?: string | null;
}) {
  const folderTarget = vaultPath ? joinVaultPath(vaultPath, row.path) : row.path;
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
      draggable={Boolean(vaultPath)}
      onClick={() =>
        onCollapsedTreeFoldersChange(
          nextCollapsedFolders(
            collapsedTreeFolders,
            row.path,
            forceExpand ? true : !row.collapsed,
          ),
        )
      }
      onDragStart={(event) => {
        if (!vaultPath) return;
        writeExplorerDragPayload(event, {
          origin: "documents",
          workspacePath: vaultPath,
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
      title={row.path}
      onContextMenu={(event) =>
        onContextMenu(event, {
          targetPath: folderTarget,
          relPath: row.path,
          title: row.path,
          entry: null,
          targetKind: "directory",
        })
      }
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
        if (!selectedFileQueueCount || !onApplyFileQueueToDestination) return;
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

const TreeEntryRow = memo(function TreeEntryRow({
  row,
  paddingLeft,
  selected,
  onSelect,
  onContextMenu,
  selectedFileQueueCount,
  onApplyFileQueueToDestination,
  onApplyExplorerDragToDestination,
  dragOverTargetPath,
  onDragOverTargetChange,
  vaultPath,
  documentLabelMode,
}: {
  row: EntryRow;
  paddingLeft: number;
  selected: boolean;
  onSelect: (entry: VaultEntry) => void;
  onContextMenu: (
    event: React.MouseEvent,
    target: DocumentContextTarget,
  ) => void;
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
  vaultPath?: string | null;
  documentLabelMode: DocumentLabelMode;
}) {
  const fmType = frontmatterScalar(row.entry.frontmatter, "type");
  const canDrop = (event: React.DragEvent): boolean =>
    Boolean(
      (onApplyExplorerDragToDestination && hasExplorerDragPayload(event.dataTransfer)) ||
        (onApplyFileQueueToDestination &&
          (hasFileQueueDragPayload(event.dataTransfer) || (selectedFileQueueCount ?? 0) > 0)),
    );
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
      draggable={Boolean(vaultPath)}
      onClick={() => onSelect(row.entry)}
      onDragStart={(event) => {
        if (!vaultPath) return;
        writeExplorerDragPayload(event, {
          origin: "documents",
          workspacePath: vaultPath,
          items: [
            {
              path: row.entry.path,
              relPath: row.entry.relPath,
              fileName: row.entry.relPath.split("/").pop() ?? row.entry.relPath,
              sourceKind: "file",
            },
          ],
        });
      }}
      onDragEnd={clearExplorerDragPayload}
      onContextMenu={(event) =>
        onContextMenu(event, {
          targetPath: row.entry.path,
          relPath: row.entry.relPath,
          title: row.entry.title,
          entry: row.entry,
          targetKind: "file",
        })
      }
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
      data-tree-target-path={row.entry.path}
    >
      <span className="tree-indent-slot" />
      <FileText size={13} />
      <span className="tree-row-title">{documentDisplayName(row.entry, documentLabelMode)}</span>
      {fmType ? (
        <span className="tree-type" data-type={fmType.toLowerCase()}>
          {fmType}
        </span>
      ) : (
        <span className="tree-type">{row.entry.fileKind.toUpperCase()}</span>
      )}
    </button>
  );
});

function FileShape() {
  return (
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M7 4h7l4 4v12H7V4Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M14 4v4h4" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

function documentFilterTitle(
  filter: DocumentFilter,
  views: readonly DocumentViewDefinition[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): string {
  switch (filter.kind) {
    case "all":
      return t("list.title");
    case "type":
      return filter.type;
    case "untyped":
      return t("sidebar.types.untyped");
    case "view":
      return t(`sidebar.view.${filter.view}`);
    case "custom":
      return views.find((view) => view.id === filter.viewId)?.label ?? t("list.title");
  }
}

function joinVaultPath(vaultPath: string, relPath: string): string {
  return `${vaultPath.replace(/\/+$/, "")}/${relPath.replace(/^\/+/, "")}`;
}
