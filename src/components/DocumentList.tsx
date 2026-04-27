import { Search } from "lucide-react";
import { useMemo } from "react";
import type { VaultEntry } from "../lib/types";
import { filterEntries, formatRelativeDate, frontmatterScalar } from "../lib/document";
import { useTranslation } from "../lib/i18n";

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

        {grouped.map((group, groupIdx) => (
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
        ))}
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
