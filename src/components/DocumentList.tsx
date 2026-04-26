import { Search } from "lucide-react";
import type { VaultEntry } from "../lib/types";
import { filterEntries, formatRelativeDate, frontmatterScalar } from "../lib/document";
import { useTranslation } from "../lib/i18n";

interface DocumentListProps {
  entries: VaultEntry[];
  selectedPath: string | null;
  query: string;
  loading: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (entry: VaultEntry) => void;
}

export function DocumentList({
  entries,
  selectedPath,
  query,
  loading,
  onQueryChange,
  onSelect,
}: DocumentListProps) {
  const { t, locale } = useTranslation();
  const filtered = filterEntries(entries, query);

  return (
    <section className="document-list">
      <div className="list-header">
        <div>
          <span className="eyebrow">{t("list.title")}</span>
          <h2>{filtered.length}</h2>
        </div>
      </div>

      <label className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t("list.searchPlaceholder")}
        />
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
            <FileShape />
            <strong>{t("list.empty.title")}</strong>
            <p>{t("list.empty.description")}</p>
          </div>
        ) : null}

        {filtered.map((entry) => {
          const fmType = frontmatterScalar(entry.frontmatter, "type");
          const fmStatus = frontmatterScalar(entry.frontmatter, "status");
          return (
            <button
              key={entry.path}
              className={selectedPath === entry.path ? "doc-row selected" : "doc-row"}
              onClick={() => onSelect(entry)}
            >
              <div className="doc-row-top">
                {fmType ? <span>{fmType}</span> : <span>{entry.fileKind.toUpperCase()}</span>}
                <time>{formatRelativeDate(entry.updatedAt, locale)}</time>
              </div>
              <strong>{entry.title}</strong>
              <p>{entry.snippet || entry.relPath}</p>
              <div className="doc-row-meta">
                {fmStatus ? (
                  <span className={`status-pill status-${fmStatus}`}>{fmStatus}</span>
                ) : null}
                <span>{t("list.meta.words", { count: entry.wordCount.toLocaleString(locale) })}</span>
                {entry.versionCount > 0 ? (
                  <span>
                    {t("list.meta.versions", {
                      count: entry.versionCount.toLocaleString(locale),
                    })}
                  </span>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function FileShape() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden="true">
      <path d="M15 8h17l7 7v31H15V8Z" fill="#E9E3D7" stroke="#6D7665" strokeWidth="1.3" />
      <path d="M32 8v8h7" stroke="#6D7665" strokeWidth="1.3" />
      <path
        d="M21 25h12M21 31h9M21 37h13"
        stroke="#52604E"
        strokeWidth="1.3"
        strokeLinecap="round"
      />
    </svg>
  );
}
