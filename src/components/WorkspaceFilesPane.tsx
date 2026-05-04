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
  PanelLeftClose,
  Plus,
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
import { useTranslation } from "../lib/i18n";
import type { ExplorerPaneMode, WorkspaceFileFilter } from "../lib/settings";
import type {
  WorkspaceFileEntry,
  WorkspaceVisibility,
} from "../lib/types";
import {
  buildWorkspaceFileTreeRows,
  collectWorkspaceFileFolderPaths,
  filterWorkspaceFiles,
  isOpenableDocumentFile,
  nextCollapsedFileFolders,
  virtualizeWorkspaceFileTreeRows,
  type VirtualWorkspaceFileTreeRow,
  type WorkspaceFileTreeRow,
} from "../lib/workspaceFileTree";

const FILE_TREE_ROW_HEIGHT = 30;
const VIRTUAL_OVERSCAN = 520;

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
  binaryIncludePatterns: string[];
  collapsedFileFolders: string[];
  onWorkspaceVisibilityChange: (visibility: WorkspaceVisibility) => void;
  onAddPublicWorkspace: () => void;
  onPaneModeChange: (mode: ExplorerPaneMode) => void;
  onQueryChange: (query: string) => void;
  onFilterChange: (filter: WorkspaceFileFilter) => void;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onQueueFiles: (entries: WorkspaceFileEntry[]) => void;
  onRevealInFinder: (targetPath: string) => void;
  onRefresh: () => void;
  onClose?: () => void;
  paneRef?: React.RefObject<HTMLElement | null>;
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
  binaryIncludePatterns,
  collapsedFileFolders,
  onWorkspaceVisibilityChange,
  onAddPublicWorkspace,
  onPaneModeChange,
  onQueryChange,
  onFilterChange,
  onCollapsedFileFoldersChange,
  onSelectFile,
  onOpenFile,
  onQueueFiles,
  onRevealInFinder,
  onRefresh,
  onClose,
  paneRef,
}: WorkspaceFilesPaneProps) {
  const { t, locale } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastSentQueryRef = useRef(query);
  const [inputQuery, setInputQuery] = useState(query);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    entry: WorkspaceFileEntry;
  } | null>(null);
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
  const forceExpandTree = Boolean(deferredQuery.trim());
  const folderPaths = useMemo(() => collectWorkspaceFileFolderPaths(filtered), [filtered]);
  const rows = useMemo(
    () => buildWorkspaceFileTreeRows(filtered, collapsedFileFolders, forceExpandTree),
    [filtered, collapsedFileFolders, forceExpandTree],
  );
  const virtualTreeLayout = useMemo(
    () =>
      virtualizeWorkspaceFileTreeRows(
        rows,
        viewport.scrollTop,
        viewport.height,
        VIRTUAL_OVERSCAN,
        FILE_TREE_ROW_HEIGHT,
      ),
    [rows, viewport],
  );
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
  }, [deferredQuery, filter]);

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
        >
          <FileText size={13} />
          <span>{t("explorer.mode.documents")}</span>
        </button>
        <button
          type="button"
          className={paneMode === "files" ? "active" : ""}
          onClick={() => onPaneModeChange("files")}
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

      <div className="file-filter-toggle" role="group" aria-label={t("files.filter.label")}>
        <button
          type="button"
          className={filter === "all" ? "active" : ""}
          onClick={() => onFilterChange("all")}
        >
          <Files size={13} />
          <span>{t("files.filter.all")}</span>
        </button>
        <button
          type="button"
          className={filter === "tracked" ? "active" : ""}
          onClick={() => onFilterChange("tracked")}
        >
          <GitBranch size={13} />
          <span>{t("files.filter.tracked")}</span>
        </button>
        <button
          type="button"
          className={filter === "binary" ? "active" : ""}
          onClick={() => onFilterChange("binary")}
        >
          <Archive size={13} />
          <span>{t("files.filter.binary")}</span>
        </button>
      </div>

      <div className="tree-bulk-actions" role="group" aria-label={t("files.tree.actions")}>
        <button
          type="button"
          onClick={() => onCollapsedFileFoldersChange([])}
          disabled={folderPaths.length === 0}
          title={t("list.tree.collapseAll")}
        >
          <ChevronsDownUp size={13} />
          <span>{t("list.tree.collapseAll")}</span>
        </button>
        <button
          type="button"
          onClick={() => onCollapsedFileFoldersChange(folderPaths)}
          disabled={folderPaths.length === 0}
          title={t("list.tree.expandAll")}
        >
          <ChevronsUpDown size={13} />
          <span>{t("list.tree.expandAll")}</span>
        </button>
        <button
          type="button"
          onClick={() => onQueueFiles(selectedEntries)}
          disabled={selectedEntries.length === 0}
          title={t("files.queueSelected")}
        >
          <Plus size={13} />
          <span>{t("files.queueSelected")}</span>
        </button>
      </div>

      <label className="search-box">
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

        {!loading && filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illus">
              <Files size={22} />
            </div>
            <strong>{t("files.empty.title")}</strong>
            <p>{t("files.empty.description")}</p>
          </div>
        ) : null}

        {!loading && filtered.length > 0 ? (
          <WorkspaceFileTree
            rows={virtualTreeLayout.rows}
            totalHeight={virtualTreeLayout.totalHeight}
            rowHeight={FILE_TREE_ROW_HEIGHT}
            selectedSet={selectedSet}
            collapsedFileFolders={collapsedFileFolders}
            forceExpand={forceExpandTree}
            onCollapsedFileFoldersChange={onCollapsedFileFoldersChange}
            onSelectFile={onSelectFile}
            onOpenFile={onOpenFile}
            onContextMenu={(event, entry) => {
              event.preventDefault();
              event.stopPropagation();
              setContextMenu({ x: event.clientX, y: event.clientY, entry });
            }}
            t={t}
            locale={locale}
          />
        ) : null}
      </div>

      {contextMenu ? (
        <div
          className="context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="context-menu-title" title={contextMenu.entry.relPath}>
            {contextMenu.entry.name}
          </div>
          {isOpenableDocumentFile(contextMenu.entry) ? (
            <button
              type="button"
              onClick={() => {
                const entry = contextMenu.entry;
                setContextMenu(null);
                onOpenFile(entry);
              }}
            >
              {t("context.openFile")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              const entry = contextMenu.entry;
              setContextMenu(null);
              onQueueFiles([entry]);
            }}
          >
            {t("files.queue")}
          </button>
          <button
            type="button"
            onClick={() => {
              const target = contextMenu.entry.path;
              setContextMenu(null);
              onRevealInFinder(target);
            }}
          >
            {t("context.revealInFinder")}
          </button>
          <div className="context-menu-separator" />
          <button type="button" onClick={() => copyText(contextMenu.entry.path)}>
            {t("context.copyPath")}
          </button>
          <button type="button" onClick={() => copyText(contextMenu.entry.relPath)}>
            {t("context.copyRelativePath")}
          </button>
        </div>
      ) : null}
    </section>
  );
});

interface WorkspaceFileTreeProps {
  rows: VirtualWorkspaceFileTreeRow[];
  totalHeight: number;
  rowHeight: number;
  selectedSet: Set<string>;
  collapsedFileFolders: string[];
  forceExpand: boolean;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale: string;
}

const WorkspaceFileTree = memo(function WorkspaceFileTree({
  rows,
  totalHeight,
  rowHeight,
  selectedSet,
  collapsedFileFolders,
  forceExpand,
  onCollapsedFileFoldersChange,
  onSelectFile,
  onOpenFile,
  onContextMenu,
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
              />
            ) : (
              <FileRow
                row={row}
                paddingLeft={paddingLeft}
                selected={selectedSet.has(row.entry.path)}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
                onContextMenu={onContextMenu}
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
}: {
  row: FolderRow;
  paddingLeft: number;
  collapsedFileFolders: string[];
  forceExpand: boolean;
  onCollapsedFileFoldersChange: (paths: string[]) => void;
}) {
  return (
    <button
      type="button"
      className="tree-row folder"
      style={{ paddingLeft }}
      aria-expanded={!row.collapsed}
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
  locale,
}: {
  row: FileTreeFileRow;
  paddingLeft: number;
  selected: boolean;
  onSelectFile: (entry: WorkspaceFileEntry, additive: boolean) => void;
  onOpenFile: (entry: WorkspaceFileEntry) => void;
  onContextMenu: (event: React.MouseEvent, entry: WorkspaceFileEntry) => void;
  locale: string;
}) {
  return (
    <button
      type="button"
      className={selected ? "tree-row file selected" : "tree-row file"}
      style={{ paddingLeft }}
      onClick={(event) => onSelectFile(row.entry, event.metaKey || event.ctrlKey)}
      onDoubleClick={() => onOpenFile(row.entry)}
      onContextMenu={(event) => onContextMenu(event, row.entry)}
      title={row.entry.relPath}
      aria-selected={selected}
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
