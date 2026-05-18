// M1 Operations Catalog UI pane (Phase 3 scaffold).
// Spec: plan §M1 — 3-column layout (마감 임박 / 결재 진행 / 미연결 증빙).
//
// Phase 3 W1: render skeleton + load entries via Tauri commands.
// Phase 3 W3-W4: real data pipeline + drilldown dialog.

import { useEffect, useMemo, useState } from "react";
import type {
  CatalogEntry,
  CatalogItemKind,
  CatalogScanReport,
  DocCategory,
} from "../../lib/catalog";
import { catalogQuery, catalogScan } from "../../lib/catalog";

interface CatalogPaneProps {
  workspaceRoot: string | null;
}

const ALL_CATEGORIES: { value: DocCategory | "all"; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "formal-report", label: "정형보고" },
  { value: "admin-approval", label: "행정결재" },
  { value: "evidence-cert", label: "증빙·인증" },
  { value: "operations", label: "운영문서" },
];

export function CatalogPane({ workspaceRoot }: CatalogPaneProps) {
  const [report, setReport] = useState<CatalogScanReport | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [selectedBu, setSelectedBu] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<DocCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    catalogScan(workspaceRoot, false)
      .then((r) => {
        if (cancelled) return;
        setReport(r);
        return catalogQuery({ workspaceRoot });
      })
      .then((list) => {
        if (cancelled || !list) return;
        setEntries(list);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceRoot]);

  const filtered = useMemo(() => {
    return entries.filter((e) => {
      if (selectedBu !== "all" && e.business_unit !== selectedBu) return false;
      if (selectedCategory !== "all" && e.category !== selectedCategory) return false;
      return true;
    });
  }, [entries, selectedBu, selectedCategory]);

  const deadlines = filtered.filter((e) => e.kind === "deadline-due" || e.kind === "task-due");
  const approvals = filtered.filter((e) => e.kind === "approval-in-flight");
  const evidence = filtered.filter(
    (e) => e.kind === "evidence-unlinked" || e.kind === "inbox-pending",
  );

  if (!workspaceRoot) {
    return <div className="catalog-pane catalog-pane--empty">워크스페이스가 선택되지 않았습니다.</div>;
  }

  return (
    <div className="catalog-pane">
      <header className="catalog-pane__topbar">
        <h2>Operations Catalog</h2>
        <div className="catalog-pane__filters">
          <select
            value={selectedBu}
            onChange={(e) => setSelectedBu(e.target.value)}
            aria-label="사업단/조직 선택"
          >
            <option value="all">전체 사업단</option>
            {(report?.bus_seen ?? []).map((bu) => (
              <option key={bu} value={bu}>
                {bu}
              </option>
            ))}
          </select>
          <div className="catalog-pane__category-chips">
            {ALL_CATEGORIES.map((c) => (
              <button
                key={c.value}
                type="button"
                className={selectedCategory === c.value ? "active" : ""}
                onClick={() => setSelectedCategory(c.value)}
              >
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading && <div className="catalog-pane__status">불러오는 중…</div>}
      {error && <div className="catalog-pane__error">오류: {error}</div>}

      <div className="catalog-pane__columns">
        <CatalogColumn title="마감 임박" entries={deadlines} kind="deadline-due" />
        <CatalogColumn title="결재 진행 중" entries={approvals} kind="approval-in-flight" />
        <CatalogColumn title="미연결 증빙" entries={evidence} kind="evidence-unlinked" />
      </div>

      {report && (
        <footer className="catalog-pane__footer">
          마지막 스캔: {report.scanned_at} · 총 {report.entries_count}건 · 사업단 {report.bus_seen.length}개
          {report.warnings.length > 0 && (
            <span className="catalog-pane__warnings"> · 경고 {report.warnings.length}건</span>
          )}
        </footer>
      )}
    </div>
  );
}

interface CatalogColumnProps {
  title: string;
  entries: CatalogEntry[];
  kind: CatalogItemKind;
}

function CatalogColumn({ title, entries, kind: _kind }: CatalogColumnProps) {
  return (
    <section className="catalog-column">
      <h3>
        {title} <span className="catalog-column__count">({entries.length})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="catalog-column__empty">표시할 항목이 없습니다.</p>
      ) : (
        <ul className="catalog-column__list">
          {entries.map((e) => (
            <li key={e.path} className="catalog-entry">
              <div className="catalog-entry__title">{e.title || e.path}</div>
              <div className="catalog-entry__meta">
                {e.business_unit && <span className="catalog-entry__bu">{e.business_unit}</span>}
                {e.deadline && <span className="catalog-entry__deadline">~{e.deadline}</span>}
                {e.approval_status && (
                  <span className="catalog-entry__status">{e.approval_status}</span>
                )}
                {e.evidence_kind && (
                  <span className="catalog-entry__evidence">{e.evidence_kind}</span>
                )}
              </div>
              <div className="catalog-entry__path">{e.path}</div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
