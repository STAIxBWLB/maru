import { FileDiff, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { gapAnalyze, gapAppendLog, gapLogList, gapReportsList } from "../../lib/api";
import { formatRelativeDate } from "../../lib/document";
import {
  filterGapHunks,
  GAP_HUNK_TYPES,
  gapTypeCountKey,
} from "../../lib/gapAnalysis";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";
import type { GapHunkType, GapLogEntry, GapReport, GapReportSummary } from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { EmptyState, ModeHeader, StatusBanner } from "../ui/ModeChrome";
import { GapDiffViewer } from "./GapDiffViewer";
import { GapLogPanel } from "./GapLogPanel";

interface GapPaneProps {
  workPath: string | null;
  /** Draft to preselect (set when arriving from the Drafts pane). */
  initialDraftId: string | null;
  /** Called once the initial selection has been consumed. */
  onConsumeInitialDraftId?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function GapPane({
  workPath,
  initialDraftId,
  onConsumeInitialDraftId,
}: GapPaneProps) {
  const { t, locale } = useTranslation();
  const [reports, setReports] = useState<GapReportSummary[]>([]);
  const [reportsLoading, setReportsLoading] = useState(false);
  const [logEntries, setLogEntries] = useState<GapLogEntry[]>([]);
  const [logLoading, setLogLoading] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(initialDraftId);
  const [report, setReport] = useState<GapReport | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const [activeTypes, setActiveTypes] = useState<Set<GapHunkType>>(
    () => new Set(GAP_HUNK_TYPES),
  );
  const [expandedEqual, setExpandedEqual] = useState<ReadonlySet<number>>(new Set());
  const [savingLog, setSavingLog] = useState(false);
  const [logSaved, setLogSaved] = useState(false);

  const refreshReports = useCallback(async () => {
    if (!workPath) {
      setReports([]);
      return;
    }
    setReportsLoading(true);
    try {
      setReports(await gapReportsList(workPath));
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setReportsLoading(false);
    }
  }, [workPath]);

  const refreshLog = useCallback(async () => {
    if (!workPath) {
      setLogEntries([]);
      return;
    }
    setLogLoading(true);
    try {
      setLogEntries(await gapLogList(workPath, 200));
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setLogLoading(false);
    }
  }, [workPath]);

  const analyze = useCallback(
    async (draftId: string) => {
      if (!workPath) return;
      setAnalyzing(true);
      setReport(null);
      setLogSaved(false);
      setLocalError(null);
      setExpandedEqual(new Set());
      try {
        setReport(await gapAnalyze(workPath, draftId));
      } catch (error) {
        const message = errorMessage(error);
        setLocalError(message);
        setError(message);
      } finally {
        setAnalyzing(false);
      }
    },
    [workPath],
  );

  useEffect(() => {
    setSelectedId(null);
    setReport(null);
    setLocalError(null);
    void refreshReports();
    void refreshLog();
  }, [refreshReports, refreshLog]);

  // Consume the initial selection handed over from the Drafts pane exactly
  // once per mount (the pane remounts whenever gap mode is re-entered). The
  // refresh effect above clears the selection first, so re-apply it here —
  // state updates flush in effect order, leaving the handoff id selected.
  useEffect(() => {
    if (!initialDraftId) return;
    onConsumeInitialDraftId?.();
    setSelectedId(initialDraftId);
    void analyze(initialDraftId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectReport = (draftId: string) => {
    setSelectedId(draftId);
    void analyze(draftId);
  };

  const toggleType = (type: GapHunkType) => {
    // Expansion indexes track the filtered list, so a filter change would
    // otherwise point them at the wrong hunks — reset them together.
    setExpandedEqual(new Set());
    setActiveTypes((current) => {
      const next = new Set(current);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  const toggleEqual = (index: number) => {
    setExpandedEqual((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const saveToLog = async () => {
    if (!workPath || !report) return;
    setSavingLog(true);
    setLocalError(null);
    try {
      await gapAppendLog(workPath, report.draftId);
      setLogSaved(true);
      await refreshLog();
    } catch (error) {
      const message = errorMessage(error);
      setLocalError(message);
      setError(message);
    } finally {
      setSavingLog(false);
    }
  };

  const visibleHunks = useMemo(
    () => (report ? filterGapHunks(report.hunks, activeTypes) : []),
    [report, activeTypes],
  );

  return (
    <section className="gap-pane" aria-label={t("mode.gap")}>
      <ModeHeader
        eyebrow={t("gap.header.eyebrow")}
        title={t("gap.header.title")}
        subtitle={t("gap.header.subtitle")}
        actions={
          <IconButton
            label={t("gap.refresh")}
            onClick={() => {
              void refreshReports();
              void refreshLog();
            }}
          >
            <RefreshCcw size={15} />
          </IconButton>
        }
      />

      {localError ? (
        <StatusBanner tone="danger">
          <span>{localError}</span>
        </StatusBanner>
      ) : null}
      {logSaved ? (
        <StatusBanner tone="success">
          <span>{t("gap.log.saved")}</span>
        </StatusBanner>
      ) : null}

      <div className="gap-body">
        <div className="gap-list-col">
          <h3 className="gap-list-title">{t("gap.list.title")}</h3>
          <div className="gap-list" aria-busy={reportsLoading}>
            {!reportsLoading && reports.length === 0 ? (
              <EmptyState
                icon={<FileDiff size={18} />}
                title={t("gap.list.empty")}
                description={t("gap.list.emptyHint")}
              />
            ) : null}
            {reports.map((entry) => (
              <button
                key={entry.draftId}
                type="button"
                className={
                  selectedId === entry.draftId ? "gap-list-item active" : "gap-list-item"
                }
                onClick={() => selectReport(entry.draftId)}
              >
                <span className="gap-list-item-title">
                  <strong>{entry.title}</strong>
                </span>
                <span className="gap-list-item-meta">
                  <code className="gap-list-path" title={entry.promotedTo}>
                    {entry.promotedTo}
                  </code>
                  <span
                    className={
                      entry.hasBaseline ? "gap-baseline-chip ok" : "gap-baseline-chip missing"
                    }
                  >
                    {entry.hasBaseline ? t("gap.list.baseline") : t("gap.list.noBaseline")}
                  </span>
                  <span className="gap-list-updated">
                    {formatRelativeDate(entry.promotedAt, locale)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="gap-diff-col">
          {analyzing ? (
            <div className="gap-diff-empty" role="status">
              {t("gap.diff.loading")}
            </div>
          ) : report ? (
            <>
              <div className="gap-diff-toolbar">
                <div
                  className="gap-filters"
                  role="group"
                  aria-label={t("gap.diff.filterLabel")}
                >
                  {GAP_HUNK_TYPES.map((type) => (
                    <button
                      key={type}
                      type="button"
                      className={
                        activeTypes.has(type) ? "gap-chip active" : "gap-chip"
                      }
                      aria-pressed={activeTypes.has(type)}
                      onClick={() => toggleType(type)}
                    >
                      {t(`gap.type.${type}`)} {report.summary.byType[gapTypeCountKey(type)]}
                    </button>
                  ))}
                </div>
                <span className="gap-summary" role="status">
                  {t("gap.summary", {
                    total: report.summary.totalHunks,
                    added: report.summary.addedLines,
                    removed: report.summary.removedLines,
                  })}
                </span>
                <Button
                  type="button"
                  size="sm"
                  icon={<Save size={13} />}
                  disabled={savingLog}
                  onClick={() => void saveToLog()}
                >
                  {savingLog ? t("gap.log.saving") : t("gap.log.save")}
                </Button>
              </div>
              {visibleHunks.length === 0 ? (
                <EmptyState
                  icon={<FileDiff size={18} />}
                  title={t("gap.diff.noHunks")}
                  description={t("gap.diff.noHunksHint")}
                />
              ) : (
                <div className="gap-diff-scroll">
                  <GapDiffViewer
                    hunks={visibleHunks}
                    expandedEqual={expandedEqual}
                    onToggleEqual={toggleEqual}
                  />
                </div>
              )}
            </>
          ) : (
            <div className="gap-diff-empty">
              <FileDiff size={18} />
              <span>{t("gap.diff.selectPrompt")}</span>
            </div>
          )}
        </div>

        <GapLogPanel
          entries={logEntries}
          loading={logLoading}
          reports={reports}
          selectedDraftId={selectedId}
          onSelectDraft={selectReport}
        />
      </div>
    </section>
  );
}
