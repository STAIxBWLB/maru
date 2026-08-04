import {
  ChevronDown,
  ChevronRight,
  ChevronsDownUp,
  EyeOff,
  File,
  FileText,
  Folder,
  FolderOpen,
  RefreshCw,
  Search,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import type React from "react";
import { gitChanges, searchWorkspaceContents } from "../lib/api";
import {
  contentSearchFileEntry,
  parseGlobList,
  shouldRunContentSearch,
  splitMatchSegments,
} from "../lib/contentSearch";
import {
  buildGitDecorations,
  type GitDecoration,
} from "../lib/gitStatusDisplay";
import { useTranslation } from "../lib/i18n";
import { clampMenuPosition } from "../lib/menu";
import { useContextMenuKeyboard } from "../lib/useContextMenuKeyboard";
import type {
  ContentSearchFile,
  ContentSearchResult,
  WorkspaceFileEntry,
} from "../lib/types";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import {
  buildWorkspaceFileTreeRows,
  filterWorkspaceFiles,
  nextCollapsedFileFolders,
  virtualizeWorkspaceFileTreeRows,
  workspaceFileTreeTabStopId,
  type WorkspaceFileTreeRow,
} from "../lib/workspaceFileTree";

export interface ExplorerPaneProps {
  workspacePath: string | null;
  entries: WorkspaceFileEntry[];
  /** Despite the legacy setting name, this stores the expanded folder set. */
  expandedFolders: string[];
  onExpandedFoldersChange: (paths: string[]) => void;
  selectedPath: string | null;
  loading: boolean;
  ready: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  onOpenFile: (entry: WorkspaceFileEntry, line?: number) => void;
  includeDotFolders: string[];
  /** Hide this entry from the workspace listings by adding it to `.maruignore`. */
  onIgnore?: (relPath: string, kind: "file" | "directory") => void;
}

type ExplorerMode = "names" | "contents";

const EMPTY_RESULT: ContentSearchResult = {
  files: [],
  fileCount: 0,
  totalMatches: 0,
  truncated: false,
};
const TREE_ROW_HEIGHT = 27;
const TREE_OVERSCAN = TREE_ROW_HEIGHT * 8;
const TEXT_FILE_KINDS = new Set([
  "md",
  "markdown",
  "mdx",
  "txt",
  "text",
  "css",
  "html",
  "js",
  "jsx",
  "json",
  "py",
  "rs",
  "sh",
  "toml",
  "ts",
  "tsx",
  "xml",
  "yaml",
  "yml",
]);

function workspaceName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function fileDirectory(relPath: string): string {
  const normalized = relPath.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash > 0 ? normalized.slice(0, slash) : ".";
}

function FileKindIcon({ entry }: { entry: WorkspaceFileEntry }) {
  return TEXT_FILE_KINDS.has(entry.fileKind.toLowerCase()) ? (
    <FileText size={14} aria-hidden="true" />
  ) : (
    <File size={14} aria-hidden="true" />
  );
}

export function ExplorerPane({
  workspacePath,
  entries,
  expandedFolders,
  onExpandedFoldersChange,
  selectedPath,
  loading: workspaceLoading,
  ready,
  refreshing,
  onRefresh,
  onOpenFile,
  includeDotFolders,
  onIgnore,
}: ExplorerPaneProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ExplorerMode>("names");
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [regex, setRegex] = useState(false);
  const [includeValue, setIncludeValue] = useState("");
  const [excludeValue, setExcludeValue] = useState("");
  const [result, setResult] = useState<ContentSearchResult>(EMPTY_RESULT);
  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [collapsedResults, setCollapsedResults] = useState<Set<string>>(
    () => new Set(),
  );
  const [treeScrollTop, setTreeScrollTop] = useState(0);
  const [treeViewportHeight, setTreeViewportHeight] = useState(0);
  const [focusedTreeRowId, setFocusedTreeRowId] = useState<string | null>(null);
  const [gitDecorations, setGitDecorations] = useState<
    Map<string, GitDecoration>
  >(() => new Map());
  const [gitRefreshTick, setGitRefreshTick] = useState(0);
  const treeScrollRef = useRef<HTMLDivElement | null>(null);
  const searchSeqRef = useRef(0);
  const gitSeqRef = useRef(0);
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    relPath: string;
    title: string;
    kind: "file" | "directory";
  } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const handleContextMenuKeyDown = useContextMenuKeyboard(
    contextMenuRef,
    !!contextMenu,
    () => setContextMenu(null),
  );

  useLayoutEffect(() => {
    if (!contextMenu) return;
    const menu = contextMenuRef.current;
    if (!menu) return;
    const next = clampMenuPosition(
      { x: contextMenu.x, y: contextMenu.y },
      { width: menu.offsetWidth, height: menu.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    if (next.x === contextMenu.x && next.y === contextMenu.y) return;
    setContextMenu({ ...contextMenu, ...next });
  }, [contextMenu]);

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

  const openContextMenu = useCallback(
    (
      event: React.MouseEvent,
      target: { relPath: string; title: string; kind: "file" | "directory" },
    ) => {
      if (!onIgnore) return;
      event.preventDefault();
      setContextMenu({ x: event.clientX, y: event.clientY, ...target });
    },
    [onIgnore],
  );

  const debouncedQuery = useDebouncedValue(query, 250);
  const debouncedInclude = useDebouncedValue(includeValue, 250);
  const debouncedExclude = useDebouncedValue(excludeValue, 250);

  const filteredEntries = useMemo(
    () => filterWorkspaceFiles(entries, query, "all"),
    [entries, query],
  );
  const treeRows = useMemo(
    () =>
      buildWorkspaceFileTreeRows(
        filteredEntries,
        expandedFolders,
        query.trim().length > 0,
      ),
    [expandedFolders, filteredEntries, query],
  );
  const virtualTree = useMemo(
    () =>
      virtualizeWorkspaceFileTreeRows(
        treeRows,
        treeScrollTop,
        treeViewportHeight,
        TREE_OVERSCAN,
        TREE_ROW_HEIGHT,
      ),
    [treeRows, treeScrollTop, treeViewportHeight],
  );
  const mountedTreeTabStopId = useMemo(
    () => workspaceFileTreeTabStopId(virtualTree.rows, focusedTreeRowId),
    [focusedTreeRowId, virtualTree.rows],
  );

  useEffect(() => {
    if (treeRows.length === 0) {
      setFocusedTreeRowId(null);
      return;
    }
    if (
      focusedTreeRowId &&
      treeRows.some((row) => row.id === focusedTreeRowId)
    ) {
      return;
    }
    const selectedRow = treeRows.find(
      (row) => row.kind === "file" && row.entry.path === selectedPath,
    );
    setFocusedTreeRowId(selectedRow?.id ?? treeRows[0].id);
  }, [focusedTreeRowId, selectedPath, treeRows]);

  useEffect(() => {
    const element = treeScrollRef.current;
    if (!element || mode !== "names") return;
    const updateHeight = () => setTreeViewportHeight(element.clientHeight);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, [mode]);

  // Invalidate an in-flight request as soon as the user types. The debounced
  // effect below starts the replacement request after input settles.
  useEffect(() => {
    searchSeqRef.current += 1;
  }, [query, includeValue, excludeValue, mode, workspacePath]);

  useEffect(() => {
    const requestSeq = ++searchSeqRef.current;
    if (
      !shouldRunContentSearch({
        mode,
        query: debouncedQuery,
        workspacePath,
      })
    ) {
      setLoading(false);
      setSearchError(null);
      setResult(EMPTY_RESULT);
      return () => {
        searchSeqRef.current += 1;
      };
    }

    setLoading(true);
    setSearchError(null);
    void searchWorkspaceContents(workspacePath!, debouncedQuery, {
      caseSensitive,
      wholeWord,
      regex,
      include: parseGlobList(debouncedInclude),
      exclude: parseGlobList(debouncedExclude),
      includeDotFolders,
    })
      .then((next) => {
        if (searchSeqRef.current !== requestSeq) return;
        setResult(next);
        setCollapsedResults(new Set());
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (searchSeqRef.current !== requestSeq) return;
        setResult(EMPTY_RESULT);
        setCollapsedResults(new Set());
        setSearchError(error instanceof Error ? error.message : String(error));
        setLoading(false);
      });

    return () => {
      searchSeqRef.current += 1;
    };
  }, [
    caseSensitive,
    debouncedExclude,
    debouncedInclude,
    debouncedQuery,
    includeDotFolders,
    mode,
    regex,
    wholeWord,
    workspacePath,
  ]);

  useEffect(() => {
    if (!workspacePath) {
      setGitDecorations(new Map());
      return;
    }
    let disposed = false;

    const poll = () => {
      const requestSeq = ++gitSeqRef.current;
      void gitChanges(workspacePath)
        .then((changes) => {
          if (!disposed && requestSeq === gitSeqRef.current) {
            // `git_changes` is capped at 200 entries and reports paths from the
            // repo root. A workspace nested in that repo may therefore have no
            // matching decoration; decoration is intentionally best-effort.
            setGitDecorations(buildGitDecorations(changes));
          }
        })
        .catch(() => {
          if (!disposed && requestSeq === gitSeqRef.current) {
            setGitDecorations(new Map());
          }
        });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") poll();
    };

    poll();
    window.addEventListener("focus", poll);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      disposed = true;
      gitSeqRef.current += 1;
      window.removeEventListener("focus", poll);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [gitRefreshTick, workspacePath]);

  const handleRefresh = useCallback(() => {
    setGitRefreshTick((value) => value + 1);
    onRefresh();
  }, [onRefresh]);

  const toggleTreeFolder = useCallback(
    (row: Extract<WorkspaceFileTreeRow, { kind: "folder" }>) => {
      onExpandedFoldersChange(
        nextCollapsedFileFolders(
          expandedFolders,
          row.path,
          !row.collapsed,
        ),
      );
    },
    [expandedFolders, onExpandedFoldersChange],
  );

  const activateTreeRow = useCallback(
    (row: WorkspaceFileTreeRow) => {
      if (row.kind === "folder") toggleTreeFolder(row);
      else onOpenFile(row.entry);
    },
    [onOpenFile, toggleTreeFolder],
  );

  const focusTreeRow = useCallback(
    (index: number) => {
      const row = treeRows[index];
      const container = treeScrollRef.current;
      if (!row || !container) return;
      const top = index * TREE_ROW_HEIGHT;
      const bottom = top + TREE_ROW_HEIGHT;
      if (top < container.scrollTop) container.scrollTop = top;
      else if (bottom > container.scrollTop + container.clientHeight) {
        container.scrollTop = bottom - container.clientHeight;
      }
      setTreeScrollTop(container.scrollTop);
      setFocusedTreeRowId(row.id);
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const target = Array.from(
            container.querySelectorAll<HTMLElement>("[data-tree-row-id]"),
          ).find((element) => element.dataset.treeRowId === row.id);
          target?.focus();
        });
      });
    },
    [treeRows],
  );

  const handleTreeKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLButtonElement>,
      row: WorkspaceFileTreeRow,
      index: number,
    ) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        focusTreeRow(Math.min(treeRows.length - 1, index + 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        focusTreeRow(Math.max(0, index - 1));
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        focusTreeRow(0);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        focusTreeRow(treeRows.length - 1);
        return;
      }
      if (event.key === "ArrowRight" && row.kind === "folder") {
        event.preventDefault();
        if (row.collapsed) toggleTreeFolder(row);
        else if (treeRows[index + 1]?.depth > row.depth) focusTreeRow(index + 1);
        return;
      }
      if (event.key === "ArrowLeft") {
        if (row.kind === "folder" && !row.collapsed) {
          event.preventDefault();
          toggleTreeFolder(row);
          return;
        }
        const parentDepth = row.depth - 1;
        for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
          const parent = treeRows[candidate];
          if (parent.kind === "folder" && parent.depth === parentDepth) {
            event.preventDefault();
            focusTreeRow(candidate);
            return;
          }
        }
      }
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        activateTreeRow(row);
      }
    },
    [activateTreeRow, focusTreeRow, toggleTreeFolder, treeRows],
  );

  const toggleResult = useCallback((path: string) => {
    setCollapsedResults((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const rootLabel = workspaceName(workspacePath) ?? t("explorer.noWorkspace");
  const hasRunnableQuery = shouldRunContentSearch({ mode, query, workspacePath });

  return (
    <section className="explorer-pane" aria-label={t("rightPane.tab.explorer")}>
      <header className="explorer-pane-head">
        <strong className="explorer-pane-root" title={workspacePath ?? undefined}>
          {rootLabel}
        </strong>
        <button
          type="button"
          className="icon-button"
          onClick={() => onExpandedFoldersChange([])}
          title={t("explorer.collapseAll")}
          aria-label={t("explorer.collapseAll")}
          disabled={expandedFolders.length === 0}
        >
          <ChevronsDownUp size={14} />
        </button>
        <button
          type="button"
          className="icon-button"
          onClick={handleRefresh}
          title={t("explorer.refresh")}
          aria-label={t("explorer.refresh")}
          disabled={!workspacePath || workspaceLoading || refreshing}
        >
          <RefreshCw
            size={14}
            className={workspaceLoading || refreshing ? "spin" : undefined}
          />
        </button>
      </header>

      <div className="explorer-pane-search">
        <Search size={13} aria-hidden="true" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={
            mode === "names"
              ? t("explorer.searchNames")
              : t("explorer.searchContents")
          }
          aria-label={
            mode === "names"
              ? t("explorer.searchNames")
              : t("explorer.searchContents")
          }
          spellCheck={false}
        />
        {mode === "contents" ? (
          <div className="explorer-pane-toggles">
            <button
              type="button"
              className={caseSensitive ? "active" : ""}
              onClick={() => setCaseSensitive((value) => !value)}
              title={t("explorer.caseSensitive")}
              aria-label={t("explorer.caseSensitive")}
              aria-pressed={caseSensitive}
            >
              Aa
            </button>
            <button
              type="button"
              className={wholeWord ? "active" : ""}
              onClick={() => setWholeWord((value) => !value)}
              title={t("explorer.wholeWord")}
              aria-label={t("explorer.wholeWord")}
              aria-pressed={wholeWord}
            >
              ab
            </button>
            <button
              type="button"
              className={regex ? "active" : ""}
              onClick={() => setRegex((value) => !value)}
              title={t("explorer.regex")}
              aria-label={t("explorer.regex")}
              aria-pressed={regex}
            >
              .*
            </button>
          </div>
        ) : null}
      </div>

      <div
        className="workspace-tabs explorer-pane-modes"
        role="tablist"
        aria-label={t("explorer.modeLabel")}
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === "names"}
          className={mode === "names" ? "active" : ""}
          onClick={() => setMode("names")}
        >
          {t("explorer.names")}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "contents"}
          className={mode === "contents" ? "active" : ""}
          onClick={() => setMode("contents")}
        >
          {t("explorer.contents")}
        </button>
      </div>

      {mode === "contents" ? (
        <div className="explorer-pane-filter">
          <input
            value={includeValue}
            onChange={(event) => setIncludeValue(event.target.value)}
            placeholder={t("explorer.include")}
            aria-label={t("explorer.include")}
            spellCheck={false}
          />
          <input
            value={excludeValue}
            onChange={(event) => setExcludeValue(event.target.value)}
            placeholder={t("explorer.exclude")}
            aria-label={t("explorer.exclude")}
            spellCheck={false}
          />
          <div className="explorer-pane-count" aria-live="polite">
            {t("explorer.resultCount", {
              files: result.fileCount,
              matches: result.totalMatches,
            })}
            {result.truncated ? ` ${t("explorer.truncated")}` : ""}
          </div>
        </div>
      ) : null}

      {mode === "names" ? (
        <div
          ref={treeScrollRef}
          className="files-tree-scroll explorer-pane-tree"
          onScroll={(event) => setTreeScrollTop(event.currentTarget.scrollTop)}
          role="tree"
          aria-label={t("explorer.treeLabel")}
          aria-busy={workspaceLoading || refreshing}
        >
          {treeRows.length > 0 ? (
            <div
              className="explorer-pane-sizer"
              role="none"
              style={{ height: virtualTree.totalHeight }}
            >
              {virtualTree.rows.map(({ row, top }) => {
                const indent = Math.min(row.depth, 8) * 12;
                const index = Math.round(top / TREE_ROW_HEIGHT);
                const tabIndex = row.id === mountedTreeTabStopId ? 0 : -1;
                if (row.kind === "folder") {
                  return (
                    <button
                      key={row.id}
                      type="button"
                      role="treeitem"
                      className="files-tree-row explorer-pane-treeitem"
                      style={{ top, paddingLeft: indent }}
                      data-tree-row-id={row.id}
                      aria-label={row.name}
                      aria-level={row.depth + 1}
                      aria-expanded={!row.collapsed}
                      aria-selected={false}
                      tabIndex={tabIndex}
                      onFocus={() => setFocusedTreeRowId(row.id)}
                      onClick={() => toggleTreeFolder(row)}
                      onContextMenu={(event) =>
                        openContextMenu(event, {
                          relPath: row.path,
                          title: row.name,
                          kind: "directory",
                        })
                      }
                      onKeyDown={(event) =>
                        handleTreeKeyDown(event, row, index)
                      }
                    >
                      <span className="files-tree-chevron" aria-hidden="true">
                        {row.collapsed ? (
                          <ChevronRight size={13} />
                        ) : (
                          <ChevronDown size={13} />
                        )}
                      </span>
                      <span className="files-tree-target" title={row.path}>
                        {row.collapsed ? (
                          <Folder size={14} aria-hidden="true" />
                        ) : (
                          <FolderOpen size={14} aria-hidden="true" />
                        )}
                        <span>{row.name}</span>
                        <span className="explorer-pane-count">{row.count}</span>
                      </span>
                    </button>
                  );
                }
                const decoration = gitDecorations.get(
                  row.entry.relPath.replace(/\\/g, "/"),
                );
                return (
                  <button
                    key={row.id}
                    type="button"
                    role="treeitem"
                    className={`files-tree-row${
                      row.entry.path === selectedPath ? " selected" : ""
                    } explorer-pane-treeitem`}
                    style={{ top, paddingLeft: indent }}
                    data-tree-row-id={row.id}
                    aria-label={row.entry.name}
                    aria-level={row.depth + 1}
                    aria-selected={row.entry.path === selectedPath}
                    tabIndex={tabIndex}
                    onFocus={() => setFocusedTreeRowId(row.id)}
                    onClick={() => onOpenFile(row.entry)}
                    onContextMenu={(event) =>
                      openContextMenu(event, {
                        relPath: row.entry.relPath,
                        title: row.entry.name,
                        kind: "file",
                      })
                    }
                    onKeyDown={(event) =>
                      handleTreeKeyDown(event, row, index)
                    }
                  >
                    <span className="files-tree-chevron" aria-hidden="true" />
                    <span className="files-tree-target" title={row.entry.relPath}>
                      <FileKindIcon entry={row.entry} />
                      <span>{row.entry.name}</span>
                      {decoration ? (
                        <span
                          className="explorer-pane-git"
                          data-decoration={decoration}
                          aria-label={t("explorer.gitDecoration", {
                            status: decoration,
                          })}
                        >
                          {decoration}
                        </span>
                      ) : null}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="explorer-pane-state">
              {!workspacePath
                ? t("explorer.noWorkspace")
                : !ready
                  ? workspaceLoading || refreshing
                    ? t("explorer.loading")
                    : t("explorer.notScanned")
                  : query.trim()
                    ? t("explorer.noNameMatches")
                    : t("explorer.emptyWorkspace")}
            </div>
          )}
        </div>
      ) : (
        <div
          className={`explorer-pane-results${loading ? " loading" : ""}`}
          aria-busy={loading}
        >
          {searchError ? (
            <div className="explorer-pane-state error" role="alert">
              {t("explorer.searchFailed", { error: searchError })}
            </div>
          ) : null}
          {result.files.map((file) => (
            <SearchResultFile
              key={file.path}
              file={file}
              collapsed={collapsedResults.has(file.path)}
              onToggle={() => toggleResult(file.path)}
              onOpen={(line) => {
                const entry =
                  entries.find(
                    (candidate) =>
                      candidate.path === file.path ||
                      candidate.relPath === file.relPath,
                  ) ?? contentSearchFileEntry(file);
                onOpenFile(entry, line);
              }}
            />
          ))}
          {!searchError && result.files.length === 0 ? (
            <div className="explorer-pane-state">
              {loading
                ? t("explorer.searching")
                : !hasRunnableQuery
                  ? query.trim().length > 0
                    ? t("explorer.queryTooShort")
                    : t("explorer.contentsHint")
                  : t("explorer.noContentMatches")}
            </div>
          ) : null}
        </div>
      )}
      {contextMenu && onIgnore
        ? createPortal(
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
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  const { relPath, kind } = contextMenu;
                  setContextMenu(null);
                  onIgnore(relPath, kind);
                }}
              >
                <EyeOff size={13} />
                {t("context.addToIgnore")}
              </button>
            </div>,
            document.body,
          )
        : null}
    </section>
  );
}

function SearchResultFile({
  file,
  collapsed,
  onToggle,
  onOpen,
}: {
  file: ContentSearchFile;
  collapsed: boolean;
  onToggle: () => void;
  onOpen: (line: number) => void;
}) {
  const { t } = useTranslation();
  const fileName = file.relPath.replace(/\\/g, "/").split("/").pop() ?? file.relPath;
  return (
    <section className="explorer-pane-result-file">
      <button
        type="button"
        className="explorer-pane-result-head"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={file.relPath}
      >
        {collapsed ? <ChevronRight size={13} /> : <ChevronDown size={13} />}
        <FileText size={14} aria-hidden="true" />
        <span className="explorer-pane-result-name">{fileName}</span>
        <span className="explorer-pane-result-badge">{file.matches.length}</span>
        <span className="explorer-pane-result-dir">{fileDirectory(file.relPath)}</span>
      </button>
      {!collapsed ? (
        <div className="explorer-pane-matches">
          {file.matches.map((match, index) => (
            <button
              key={`${match.line}:${index}`}
              type="button"
              className="explorer-pane-match"
              onClick={() => onOpen(match.line)}
              aria-label={t("explorer.openMatch", { line: match.line })}
              title={`${file.relPath}:${match.line}`}
            >
              <span className="explorer-pane-match-line">{match.line}</span>
              <span className="explorer-pane-match-text">
                {splitMatchSegments(match.text, match.ranges).map((segment, segmentIndex) =>
                  segment.hit ? (
                    <mark key={segmentIndex}>{segment.text}</mark>
                  ) : (
                    <span key={segmentIndex}>{segment.text}</span>
                  ),
                )}
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
