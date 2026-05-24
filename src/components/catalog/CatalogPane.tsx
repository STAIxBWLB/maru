// M1 Operations Catalog UI pane.
// Spec: plan §M1 — 3-column layout (마감 임박 / 결재 진행 / 미연결 증빙).
//
// W1: render skeleton.
// W3: load entries via Tauri commands.
// W4: drilldown dialog + notify watcher auto-refresh.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  CatalogEntry,
  CatalogItemKind,
  CatalogScanReport,
  DocCategory,
} from "../../lib/catalog";
import { catalogQuery, catalogScan } from "../../lib/catalog";
import { DrilldownDialog } from "./DrilldownDialog";

interface CatalogPaneProps {
  workspaceRoot: string | null;
  onReveal?: (path: string) => void;
}

const ALL_CATEGORIES: { value: DocCategory | "all"; label: string }[] = [
  { value: "all", label: "전체" },
  { value: "formal-report", label: "정형보고" },
  { value: "admin-approval", label: "행정결재" },
  { value: "evidence-cert", label: "증빙·인증" },
  { value: "operations", label: "운영문서" },
];

export function CatalogPane({ workspaceRoot, onReveal }: CatalogPaneProps) {
  const [report, setReport] = useState<CatalogScanReport | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [selectedBu, setSelectedBu] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<DocCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilldownEntry, setDrilldownEntry] = useState<CatalogEntry | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(
    async (force = false): Promise<void> => {
      if (!workspaceRoot) return;
      setLoading(true);
      setError(null);
      try {
        const report = await catalogScan(workspaceRoot, force);
        setReport(report);
        const list = await catalogQuery({ workspaceRoot });
        setEntries(list);
      } catch (e) {
        setError(String(e));
      } finally {
        setLoading(false);
      }
    },
    [workspaceRoot],
  );

  useEffect(() => {
    if (!workspaceRoot) return;
    let cancelled = false;
    void refresh(false).catch(() => {
      /* refresh sets error */
    });
    // Start the notify watcher; debounce-coalesced refreshes hop through
    // catalog://refresh and we re-run the cheap query.
    void invoke<boolean>("catalog_watcher_start", { workspaceRoot }).catch((err) => {
      // Watcher failures are non-fatal; UI still works via manual refresh.
      console.warn("catalog_watcher_start failed", err);
    });

    const unlistenPromise = listen("catalog://refresh", () => {
      if (cancelled) return;
      // Debounce front-end so a burst of fs events results in one scan call.
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = setTimeout(() => {
        void refresh(false).catch(() => {
          /* swallowed; reporter already set */
        });
      }, 300);
    });

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      void invoke("catalog_watcher_stop").catch(() => undefined);
      void unlistenPromise.then((un) => un()).catch(() => undefined);
    };
  }, [workspaceRoot, refresh]);

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
        <CatalogColumn
          title="마감 임박"
          entries={deadlines}
          kind="deadline-due"
          onSelect={setDrilldownEntry}
        />
        <CatalogColumn
          title="결재 진행 중"
          entries={approvals}
          kind="approval-in-flight"
          onSelect={setDrilldownEntry}
        />
        <CatalogColumn
          title="미연결 증빙"
          entries={evidence}
          kind="evidence-unlinked"
          onSelect={setDrilldownEntry}
        />
      </div>

      {report && (
        <footer className="catalog-pane__footer">
          마지막 스캔: {report.scanned_at} · 총 {report.entries_count}건 · 사업단 {report.bus_seen.length}개
          {report.warnings.length > 0 && (
            <span className="catalog-pane__warnings"> · 경고 {report.warnings.length}건</span>
          )}
        </footer>
      )}

      <DrilldownDialog
        workspaceRoot={workspaceRoot}
        entry={drilldownEntry}
        onClose={() => setDrilldownEntry(null)}
        onReveal={onReveal}
      />
    </div>
  );
}

interface CatalogColumnProps {
  title: string;
  entries: CatalogEntry[];
  kind: CatalogItemKind;
  onSelect: (entry: CatalogEntry) => void;
}

function CatalogColumn({ title, entries, kind: _kind, onSelect }: CatalogColumnProps) {
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
              <button
                type="button"
                className="catalog-entry__button"
                onClick={() => onSelect(e)}
                aria-label={`${e.title || e.path} 상세 보기`}
              >
                <div className="catalog-entry__title" title={e.title || e.path}>
                  {e.title || e.path}
                </div>
                <div className="catalog-entry__meta">
                  {e.business_unit && (
                    <span className="catalog-entry__bu">{e.business_unit}</span>
                  )}
                  {e.deadline && <span className="catalog-entry__deadline">~{e.deadline}</span>}
                  {e.approval_status && (
                    <span className="catalog-entry__status">{e.approval_status}</span>
                  )}
                  {e.evidence_kind && (
                    <span className="catalog-entry__evidence">{e.evidence_kind}</span>
                  )}
                </div>
                <div className="catalog-entry__path" title={e.path}>
                  {e.path}
                </div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
