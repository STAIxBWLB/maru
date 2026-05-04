import {
  ChevronRight,
  ChevronsDownUp,
  ChevronsUpDown,
  FileText,
  Folder,
  List,
  RefreshCcw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { VaultEntry } from "../lib/types";
import { filterEntries, formatRelativeDate, frontmatterScalar } from "../lib/document";
import {
  buildDocumentTreeRows,
  collectDocumentTreeFolderPaths,
  nextCollapsedFolders,
  type DocumentTreeRow,
} from "../lib/documentTree";
import { useTranslation } from "../lib/i18n";

interface DocumentListProps {
  entries: VaultEntry[];
  selectedPath: string | null;
  query: string;
  loading: boolean;
  typeFilter: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (entry: VaultEntry) => void;
  onRefresh: () => void;
  refreshing?: boolean;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

type BrowserMode = "list" | "tree";

const BROWSER_MODE_KEY = "anchor:documentBrowserMode:v1";

export function DocumentList({
  entries,
  selectedPath,
  query,
  loading,
  typeFilter,
  onQueryChange,
  onSelect,
  onRefresh,
  refreshing = false,
  searchInputRef,
}: DocumentListProps) {
  const { t, locale } = useTranslation();
  const [browserMode, setBrowserMode] = useState<BrowserMode>(() => {
    if (typeof window === "undefined") return "tree";
    const stored = window.localStorage.getItem(BROWSER_MODE_KEY);
    return stored === "list" || stored === "tree" ? stored : "tree";
  });
  const [collapsedFolders, setCollapsedFolders] = useState<string[]>([]);

  const filtered = useMemo(() => {
    let next = filterEntries(entries, query);
    if (typeFilter != null) {
      next = next.filter((entry) => {
        const type = frontmatterScalar(entry.frontmatter, "type");
        return typeFilter === "_" ? type == null : type === typeFilter;
      });
    }
    return next;
  }, [entries, query, typeFilter]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(BROWSER_MODE_KEY, browserMode);
  }, [browserMode]);

  // Group by mtime bucket: Today / This week / Earlier
  const grouped = useMemo(() => {
    if (query.trim() || typeFilter != null) {
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
  }, [filtered, query, typeFilter, t]);

  const forceExpandTree = Boolean(query.trim() || typeFilter != null);
  const folderPaths = useMemo(() => collectDocumentTreeFolderPaths(entries), [entries]);
  const treeRows = useMemo(
    () => buildDocumentTreeRows(filtered, collapsedFolders, forceExpandTree),
    [filtered, collapsedFolders, forceExpandTree],
  );

  const headerCaption = typeFilter
    ? typeFilter === "_"
      ? t("sidebar.types.untyped")
      : typeFilter
    : t("list.title");

  return (
    <section className="document-list">
      <div className="list-header">
        <div>
          <h2>{headerCaption}</h2>
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
          <RefreshCcw size={14} className={refreshing ? "spin" : undefined} />
        </button>
      </div>

      <div className="list-mode-toggle" role="group" aria-label={t("list.viewMode")}>
        <button
          type="button"
          className={browserMode === "list" ? "active" : ""}
          onClick={() => setBrowserMode("list")}
        >
          <List size={13} />
          <span>{t("list.view.list")}</span>
        </button>
        <button
          type="button"
          className={browserMode === "tree" ? "active" : ""}
          onClick={() => setBrowserMode("tree")}
        >
          <Folder size={13} />
          <span>{t("list.view.tree")}</span>
        </button>
      </div>

      {browserMode === "tree" ? (
        <div className="tree-bulk-actions" role="group" aria-label={t("list.tree.actions")}>
          <button
            type="button"
            onClick={() => setCollapsedFolders(folderPaths)}
            disabled={folderPaths.length === 0}
            title={t("list.tree.collapseAll")}
          >
            <ChevronsDownUp size={13} />
            <span>{t("list.tree.collapseAll")}</span>
          </button>
          <button
            type="button"
            onClick={() => setCollapsedFolders([])}
            disabled={folderPaths.length === 0}
            title={t("list.tree.expandAll")}
          >
            <ChevronsUpDown size={13} />
            <span>{t("list.tree.expandAll")}</span>
          </button>
        </div>
      ) : null}

      <label className="search-box">
        <Search size={14} />
        <input
          ref={searchInputRef}
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("list.searchPlaceholder")}
        />
        <span className="kbd">⌘F</span>
      </label>

      <div className="list-scroll">
        {loading ? (
          <div className="skeleton-stack" aria-label={t("list.loading")}>
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!loading && filtered.length === 0 ? (
          <div className="empty-state">
            <div className="empty-illus">
              <FileShape />
            </div>
            <strong>{t("list.empty.title")}</strong>
            <p>{t("list.empty.description")}</p>
          </div>
        ) : null}

        {!loading && filtered.length > 0 && browserMode === "tree" ? (
          <DocumentTree
            rows={treeRows}
            selectedPath={selectedPath}
            collapsedFolders={collapsedFolders}
            forceExpand={forceExpandTree}
            onCollapsedFoldersChange={setCollapsedFolders}
            onSelect={onSelect}
          />
        ) : null}

        {browserMode === "list" ? grouped.map((group, groupIdx) => (
          <div className="list-group" key={group.label ?? `g-${groupIdx}`}>
            {group.label ? (
              <div className="list-group-label">
                {group.label}
                <span className="count">{group.items.length}</span>
              </div>
            ) : null}
            {group.items.map((entry) => {
              const fmType = frontmatterScalar(entry.frontmatter, "type");
              const fmStatus = frontmatterScalar(entry.frontmatter, "status");
              return (
                <button
                  key={entry.path}
                  className={selectedPath === entry.path ? "doc-row selected" : "doc-row"}
                  onClick={() => onSelect(entry)}
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
                  <strong>{entry.title}</strong>
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
              );
            })}
          </div>
        )) : null}
      </div>
    </section>
  );
}

function DocumentTree({
  rows,
  selectedPath,
  collapsedFolders,
  forceExpand,
  onCollapsedFoldersChange,
  onSelect,
}: {
  rows: DocumentTreeRow[];
  selectedPath: string | null;
  collapsedFolders: string[];
  forceExpand: boolean;
  onCollapsedFoldersChange: (paths: string[]) => void;
  onSelect: (entry: VaultEntry) => void;
}) {
  return (
    <div className="tree-list" role="tree">
      {rows.map((row) =>
        row.kind === "folder" ? (
          <FolderRow
            key={row.id}
            row={row}
            collapsedFolders={collapsedFolders}
            forceExpand={forceExpand}
            onCollapsedFoldersChange={onCollapsedFoldersChange}
          />
        ) : (
          <EntryRow
            key={row.id}
            row={row}
            selected={selectedPath === row.entry.path}
            onSelect={onSelect}
          />
        ),
      )}
    </div>
  );
}

function FolderRow({
  row,
  collapsedFolders,
  forceExpand,
  onCollapsedFoldersChange,
}: {
  row: Extract<DocumentTreeRow, { kind: "folder" }>;
  collapsedFolders: string[];
  forceExpand: boolean;
  onCollapsedFoldersChange: (paths: string[]) => void;
}) {
  const paddingLeft = 8 + row.depth * 14;
  const collapsed = !forceExpand && row.collapsed;
  return (
    <button
      type="button"
      className="tree-row folder"
      style={{ paddingLeft }}
      aria-expanded={!collapsed}
      onClick={() =>
        onCollapsedFoldersChange(
          nextCollapsedFolders(collapsedFolders, row.path, !collapsed),
        )
      }
      title={row.path}
    >
      <ChevronRight
        size={13}
        className={collapsed ? "tree-chevron" : "tree-chevron open"}
      />
      <Folder size={14} />
      <span className="tree-row-title">{row.name}</span>
      <span className="tree-count">{row.count}</span>
    </button>
  );
}

function EntryRow({
  row,
  selected,
  onSelect,
}: {
  row: Extract<DocumentTreeRow, { kind: "entry" }>;
  selected: boolean;
  onSelect: (entry: VaultEntry) => void;
}) {
  const paddingLeft = 8 + row.depth * 14;
  const fmType = frontmatterScalar(row.entry.frontmatter, "type");
  return (
    <button
      type="button"
      className={selected ? "tree-row file selected" : "tree-row file"}
      style={{ paddingLeft }}
      onClick={() => onSelect(row.entry)}
      title={row.entry.relPath}
    >
      <span className="tree-indent-slot" />
      <FileText size={13} />
      <span className="tree-row-title">{row.entry.title}</span>
      {fmType ? (
        <span className="tree-type" data-type={fmType.toLowerCase()}>
          {fmType}
        </span>
      ) : (
        <span className="tree-type">{row.entry.fileKind.toUpperCase()}</span>
      )}
    </button>
  );
}

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
