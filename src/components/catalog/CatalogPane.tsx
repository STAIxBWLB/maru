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
import { hubQueueDrain, hubStatus } from "../../lib/hubClient";
import { useTranslation } from "../../lib/i18n";
import { DrilldownDialog } from "./DrilldownDialog";

interface CatalogPaneProps {
  workspaceRoot: string | null;
  onReveal?: (path: string) => void;
}

const ALL_CATEGORIES: { value: DocCategory | "all"; labelKey: string }[] = [
  { value: "all", labelKey: "catalog.category.all" },
  { value: "formal-report", labelKey: "catalog.category.formalReport" },
  { value: "admin-approval", labelKey: "catalog.category.adminApproval" },
  { value: "evidence-cert", labelKey: "catalog.category.evidenceCert" },
  { value: "operations", labelKey: "catalog.category.operations" },
];

export function CatalogPane({ workspaceRoot, onReveal }: CatalogPaneProps) {
  const { t } = useTranslation();
  const [report, setReport] = useState<CatalogScanReport | null>(null);
  const [entries, setEntries] = useState<CatalogEntry[]>([]);
  const [selectedBu, setSelectedBu] = useState<string>("all");
  const [selectedCategory, setSelectedCategory] = useState<DocCategory | "all">("all");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drilldownEntry, setDrilldownEntry] = useState<CatalogEntry | null>(null);
  const [hubQueueDepth, setHubQueueDepth] = useState<number | null>(null);
  const [hubDrainBusy, setHubDrainBusy] = useState(false);
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
      // Hub queue depth is best-effort: workspaces without hub config simply
      // never show the indicator.
      try {
        const status = await hubStatus(workspaceRoot);
        setHubQueueDepth(status.queue_depth);
      } catch {
        setHubQueueDepth(null);
      }
    },
    [workspaceRoot],
  );

  const drainHubQueue = useCallback(async () => {
    if (!workspaceRoot) return;
    setHubDrainBusy(true);
    try {
      const result = await hubQueueDrain(workspaceRoot);
      setHubQueueDepth(result.remaining);
    } catch {
      // Drain errors are non-fatal; the depth re-reads on the next refresh.
    } finally {
      setHubDrainBusy(false);
    }
  }, [workspaceRoot]);

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
    return <div className="catalog-pane catalog-pane--empty">{t("catalog.noWorkspace")}</div>;
  }

  return (
    <div className="catalog-pane">
      <header className="catalog-pane__topbar">
        <h2>{t("catalog.title")}</h2>
        <div className="catalog-pane__filters">
          <select
            value={selectedBu}
            onChange={(e) => setSelectedBu(e.target.value)}
            aria-label={t("catalog.bu.selectAria")}
          >
            <option value="all">{t("catalog.bu.all")}</option>
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
                {t(c.labelKey)}
              </button>
            ))}
          </div>
        </div>
      </header>

      {loading && <div className="catalog-pane__status">{t("catalog.loading")}</div>}
      {error && <div className="catalog-pane__error">{t("catalog.error", { message: error })}</div>}

      <div className="catalog-pane__columns">
        <CatalogColumn
          title={t("catalog.column.deadlines")}
          entries={deadlines}
          kind="deadline-due"
          onSelect={setDrilldownEntry}
        />
        <CatalogColumn
          title={t("catalog.column.approvals")}
          entries={approvals}
          kind="approval-in-flight"
          onSelect={setDrilldownEntry}
        />
        <CatalogColumn
          title={t("catalog.column.evidence")}
          entries={evidence}
          kind="evidence-unlinked"
          onSelect={setDrilldownEntry}
        />
      </div>

      {report && (
        <footer className="catalog-pane__footer">
          {t("catalog.footer.summary", {
            time: report.scanned_at,
            count: report.entries_count,
            buCount: report.bus_seen.length,
          })}
          {report.warnings.length > 0 && (
            <span className="catalog-pane__warnings">
              {" "}
              {t("catalog.footer.warnings", { count: report.warnings.length })}
            </span>
          )}
          {hubQueueDepth != null && hubQueueDepth > 0 && (
            <span className="catalog-pane__hub-queue">
              {" · "}
              {t("catalog.hubQueue", { count: hubQueueDepth })}{" "}
              <button
                type="button"
                className="button button-ghost button-sm"
                disabled={hubDrainBusy}
                onClick={() => void drainHubQueue()}
              >
                {t("catalog.hubQueueRetry")}
              </button>
            </span>
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
  const { t } = useTranslation();
  return (
    <section className="catalog-column">
      <h3>
        {title} <span className="catalog-column__count">({entries.length})</span>
      </h3>
      {entries.length === 0 ? (
        <p className="catalog-column__empty">{t("catalog.column.empty")}</p>
      ) : (
        <ul className="catalog-column__list">
          {entries.map((e) => (
            <li key={e.path} className="catalog-entry">
              <button
                type="button"
                className="catalog-entry__button"
                onClick={() => onSelect(e)}
                aria-label={t("catalog.entry.detailAria", { title: e.title || e.path })}
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
