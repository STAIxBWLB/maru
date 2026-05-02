import { Search } from "lucide-react";
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { VaultEntry } from "../lib/types";
import { filterEntries, formatRelativeDate, frontmatterScalar } from "../lib/document";
import { useTranslation } from "../lib/i18n";

const GROUP_ROW_HEIGHT = 28;
const ENTRY_ROW_HEIGHT = 132;
const VIRTUAL_OVERSCAN = 520;

type VirtualRow =
  | { kind: "group"; key: string; label: string; count: number; height: number }
  | { kind: "entry"; key: string; entry: VaultEntry; height: number };

interface DocumentListProps {
  entries: VaultEntry[];
  selectedPath: string | null;
  query: string;
  loading: boolean;
  typeFilter: string | null;
  onQueryChange: (query: string) => void;
  onSelect: (entry: VaultEntry) => void;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
}

export function DocumentList({
  entries,
  selectedPath,
  query,
  loading,
  typeFilter,
  onQueryChange,
  onSelect,
  searchInputRef,
}: DocumentListProps) {
  const { t, locale } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 720 });

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

  const virtualRows = useMemo<VirtualRow[]>(() => {
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
  }, [grouped]);

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
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTop = 0;
    setViewport({ scrollTop: 0, height: node.clientHeight || 720 });
  }, [query, typeFilter]);

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
      </div>

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
            <div className="empty-illus">
              <FileShape />
            </div>
            <strong>{t("list.empty.title")}</strong>
            <p>{t("list.empty.description")}</p>
          </div>
        ) : null}

        {!loading && filtered.length > 0 ? (
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
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
    </section>
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
