import { Search, SlidersHorizontal } from "lucide-react";
import type { VaultEntry } from "../lib/types";
import { docTypeLabel, filterEntries, formatRelativeDate, statusLabel } from "../lib/document";

interface DocumentListProps {
  entries: VaultEntry[];
  selectedPath: string | null;
  query: string;
  activeType: string;
  loading: boolean;
  onQueryChange: (query: string) => void;
  onSelect: (entry: VaultEntry) => void;
}

export function DocumentList({
  entries,
  selectedPath,
  query,
  activeType,
  loading,
  onQueryChange,
  onSelect,
}: DocumentListProps) {
  const filtered = filterEntries(entries, query, activeType);

  return (
    <section className="document-list">
      <div className="list-header">
        <div>
          <span className="eyebrow">문서 인덱스</span>
          <h2>{activeType === "All" ? "전체 문서" : docTypeLabel(activeType)}</h2>
        </div>
        <button className="icon-button" title="정렬과 필터">
          <SlidersHorizontal size={16} />
        </button>
      </div>

      <label className="search-box">
        <Search size={16} />
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="제목, 본문, 인물, 태그 검색"
        />
      </label>

      <div className="list-scroll">
        {loading ? (
          <div className="skeleton-stack" aria-label="문서 목록 로딩">
            <span />
            <span />
            <span />
          </div>
        ) : null}

        {!loading && filtered.length === 0 ? (
          <div className="empty-state">
            <FileShape />
            <strong>표시할 문서가 없습니다</strong>
            <p>샘플 볼트를 열거나 새 문서를 만들어 Anchor 문서 흐름을 시작하세요.</p>
          </div>
        ) : null}

        {filtered.map((entry) => (
          <button
            key={entry.path}
            className={selectedPath === entry.path ? "doc-row selected" : "doc-row"}
            onClick={() => onSelect(entry)}
          >
            <div className="doc-row-top">
              <span>{docTypeLabel(entry.docType)}</span>
              <time>{formatRelativeDate(entry.updatedAt)}</time>
            </div>
            <strong>{entry.title}</strong>
            <p>{entry.snippet || "본문 미리보기가 없습니다."}</p>
            <div className="doc-row-meta">
              <span className={`status-pill status-${entry.status}`}>{statusLabel(entry.status)}</span>
              <span>{entry.wordCount.toLocaleString("ko-KR")} 단어</span>
              {entry.versionCount > 0 ? <span>{entry.versionCount} 버전</span> : null}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function FileShape() {
  return (
    <svg width="54" height="54" viewBox="0 0 54 54" fill="none" aria-hidden="true">
      <path d="M15 8h17l7 7v31H15V8Z" fill="#E9E3D7" stroke="#6D7665" strokeWidth="1.3" />
      <path d="M32 8v8h7" stroke="#6D7665" strokeWidth="1.3" />
      <path d="M21 25h12M21 31h9M21 37h13" stroke="#52604E" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}
