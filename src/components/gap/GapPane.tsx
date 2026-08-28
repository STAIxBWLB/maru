import { FileDiff, RefreshCcw, Save } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  draftsRelinkPromoted,
  gapAnalyze,
  gapAppendLog,
  gapLogList,
  gapReportsList,
  readDraft,
} from "../../lib/api";
import {
  resolveDraftGraphRelationEntries,
  type DraftGraphFocusRequest,
} from "../../lib/draftGraphRelations";
import { formatRelativeDate } from "../../lib/document";
import {
  filterGapHunks,
  GAP_HUNK_TYPES,
  gapTypeCountKey,
  translateGapError,
} from "../../lib/gapAnalysis";
import { setError } from "../../lib/errorStore";
import { useTranslation } from "../../lib/i18n";
import type {
  DraftDocument,
  GapHunkType,
  GapLogEntry,
  GapReport,
  GapReportSummary,
  VaultEntry,
} from "../../lib/types";
import { Button, IconButton } from "../ui/Button";
import { EmptyState, ModeHeader, StatusBanner } from "../ui/ModeChrome";
import { GapDiffViewer } from "./GapDiffViewer";
import { GapLogPanel } from "./GapLogPanel";

interface GapPaneProps {
  workPath: string | null;
  /** Primary-workspace entries used for the selected report's graph overlay. */
  entries?: VaultEntry[];
  /** Draft to preselect (set when arriving from the Drafts pane). */
  initialDraftId: string | null;
  /** Nonce makes repeated explicit selections of the same draft distinguishable. */
  initialDraftRequest?: number;
  /** Called once the initial selection has been consumed. */
  onConsumeInitialDraftId?: () => void;
  /** Opens the existing graph panel in reference-focus mode. */
  onOpenInGraph?: (request: DraftGraphFocusRequest) => void;
  /** Clears a gap-owned graph focus when the selected report changes. */
  onExitReferenceFocus?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type DraftLoadState = "idle" | "loading" | "loaded" | "error";

export function GapPane({
  workPath,
  entries = [],
  initialDraftId,
  initialDraftRequest = 0,
  onConsumeInitialDraftId,
  onOpenInGraph,
  onExitReferenceFocus,
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
  const [relinkTarget, setRelinkTarget] = useState("");
  const [relinking, setRelinking] = useState(false);
  const [relinkSaved, setRelinkSaved] = useState(false);
  const [selectedDraft, setSelectedDraft] = useState<DraftDocument | null>(null);
  const [selectedDraftLoadState, setSelectedDraftLoadState] =
    useState<DraftLoadState>("idle");
  const initialConsumedRequestRef = useRef<number | null>(null);
  const draftLoadRequestRef = useRef(0);
  const analysisRequestRef = useRef(0);
  const selectedIdRef = useRef<string | null>(initialDraftId);

  const selectedEntry = useMemo(
    () => reports.find((entry) => entry.draftId === selectedId) ?? null,
    [reports, selectedId],
  );
  const selectedReport = report?.draftId === selectedId ? report : null;

  const loadSelectedDraft = useCallback(
    (draftId: string) => {
      const request = ++draftLoadRequestRef.current;
      setSelectedDraft(null);
      if (!workPath) {
        setSelectedDraftLoadState("error");
        return;
      }
      setSelectedDraftLoadState("loading");
      void readDraft(workPath, draftId)
        .then((draft) => {
          if (request !== draftLoadRequestRef.current) return;
          setSelectedDraft(draft);
          setSelectedDraftLoadState("loaded");
        })
        .catch(() => {
          if (request === draftLoadRequestRef.current) {
            setSelectedDraftLoadState("error");
          }
        });
    },
    [workPath],
  );

  const refreshReports = useCallback(async () => {
    if (!workPath) {
      setReports([]);
      return;
    }
    setReportsLoading(true);
    try {
      setReports(await gapReportsList(workPath));
    } catch (error) {
      const message = translateGapError(errorMessage(error), t);
      setLocalError(message);
      setError(message);
    } finally {
      setReportsLoading(false);
    }
  }, [t, workPath]);

  const refreshLog = useCallback(async () => {
    if (!workPath) {
      setLogEntries([]);
      return;
    }
    setLogLoading(true);
    try {
      setLogEntries(await gapLogList(workPath, 200));
    } catch (error) {
      const message = translateGapError(errorMessage(error), t);
      setLocalError(message);
      setError(message);
    } finally {
      setLogLoading(false);
    }
  }, [t, workPath]);

  const analyze = useCallback(
    async (draftId: string) => {
      if (!workPath) return;
      const request = ++analysisRequestRef.current;
      setAnalyzing(true);
      setReport(null);
      setLogSaved(false);
      setLocalError(null);
      setExpandedEqual(new Set());
      try {
        const nextReport = await gapAnalyze(workPath, draftId);
        if (
          request !== analysisRequestRef.current ||
          selectedIdRef.current !== draftId ||
          nextReport.draftId !== draftId
        ) {
          return;
        }
        setReport(nextReport);
      } catch (error) {
        if (request !== analysisRequestRef.current || selectedIdRef.current !== draftId) {
          return;
        }
        const message = translateGapError(errorMessage(error), t);
        setLocalError(message);
        setError(message);
      } finally {
        if (request === analysisRequestRef.current && selectedIdRef.current === draftId) {
          setAnalyzing(false);
        }
      }
    },
    [t, workPath],
  );

  const selectReport = useCallback((draftId: string) => {
    const entry = reports.find((candidate) => candidate.draftId === draftId);
    ++analysisRequestRef.current;
    selectedIdRef.current = draftId;
    onExitReferenceFocus?.();
    setSelectedId(draftId);
    loadSelectedDraft(draftId);
    setRelinkTarget(entry?.promotedTo ?? "");
    setRelinkSaved(false);
    setReport(null);
    setAnalyzing(false);
    setLogSaved(false);
    setLocalError(null);
    setExpandedEqual(new Set());
    if (!entry || !entry.hasDocument) {
      setAnalyzing(false);
      return;
    }
    void analyze(draftId);
  }, [analyze, loadSelectedDraft, onExitReferenceFocus, reports]);

  useEffect(() => {
    onExitReferenceFocus?.();
    draftLoadRequestRef.current += 1;
    analysisRequestRef.current += 1;
    selectedIdRef.current = null;
    setSelectedDraft(null);
    setSelectedDraftLoadState("idle");
    setSelectedId(null);
    setReport(null);
    setAnalyzing(false);
    setLocalError(null);
    void refreshReports();
    void refreshLog();
  }, [onExitReferenceFocus, refreshReports, refreshLog]);

  // Consume the initial selection handed over from the Drafts pane after the
  // summary list is available. Missing promoted documents intentionally stop
  // at the relink panel and never invoke gap_analyze.
  useEffect(() => {
    if (!initialDraftId || initialConsumedRequestRef.current === initialDraftRequest || reports.length === 0) return;
    initialConsumedRequestRef.current = initialDraftRequest;
    onConsumeInitialDraftId?.();
    selectReport(initialDraftId);
  }, [initialDraftId, initialDraftRequest, onConsumeInitialDraftId, reports.length, selectReport]);

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
    if (!workPath || !selectedReport) return;
    setSavingLog(true);
    setLocalError(null);
    try {
      await gapAppendLog(workPath, selectedReport.draftId);
      setLogSaved(true);
      await refreshLog();
    } catch (error) {
      const message = translateGapError(errorMessage(error), t);
      setLocalError(message);
      setError(message);
    } finally {
      setSavingLog(false);
    }
  };

  const relinkSelected = async () => {
    if (!workPath || !selectedEntry || selectedEntry.hasDocument || !relinkTarget.trim()) return;
    setRelinking(true);
    setRelinkSaved(false);
    setLocalError(null);
    try {
      await draftsRelinkPromoted({
        workPath,
        id: selectedEntry.draftId,
        targetPath: relinkTarget,
      });
      setRelinkSaved(true);
      await refreshReports();
      await analyze(selectedEntry.draftId);
    } catch (error) {
      const message = translateGapError(errorMessage(error), t);
      setLocalError(message);
      setError(message);
    } finally {
      setRelinking(false);
    }
  };

  const visibleHunks = useMemo(
    () => (selectedReport ? filterGapHunks(selectedReport.hunks, activeTypes) : []),
    [activeTypes, selectedReport],
  );

  const graphRelations = useMemo(
    () =>
      selectedEntry && selectedDraftLoadState === "loaded" && selectedDraft
        ? resolveDraftGraphRelationEntries(
            entries,
            selectedDraft?.originRefs ?? [],
            selectedEntry.promotedTo,
            selectedDraft?.content ?? "",
          )
        : [],
    [entries, selectedDraft, selectedDraftLoadState, selectedEntry],
  );
  const canOpenSelectedInGraph = Boolean(
    selectedReport &&
      selectedDraftLoadState === "loaded" &&
      selectedDraft &&
      onOpenInGraph &&
      graphRelations.length > 0,
  );

  const openSelectedInGraph = () => {
    if (
      !selectedReport ||
      !selectedEntry ||
      selectedDraftLoadState !== "loaded" ||
      !selectedDraft ||
      !onOpenInGraph ||
      graphRelations.length === 0
    ) {
      return;
    }
    onOpenInGraph({
      docPath: selectedDraft.bodyPath,
      nodePaths: graphRelations.map((relation) => relation.entry.relPath),
    });
  };

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
      {relinkSaved ? (
        <StatusBanner tone="success">
          <span>{t("gap.relink.success")}</span>
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
                  {!entry.hasDocument ? (
                    <span className="gap-baseline-chip missing">
                      {t("gap.list.missingDoc")}
                    </span>
                  ) : null}
                  <span className="gap-list-updated">
                    {formatRelativeDate(entry.promotedAt, locale)}
                  </span>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div className="gap-diff-col">
          {selectedEntry && !selectedEntry.hasDocument ? (
            <div className="gap-relink-panel" data-testid="gap-relink-panel">
              <h3>{t("gap.relink.title")}</h3>
              <p>{t("gap.relink.hint")}</p>
              <label>
                <span>{t("gap.relink.target")}</span>
                <input
                  data-testid="gap-relink-target"
                  type="text"
                  value={relinkTarget}
                  placeholder={selectedEntry.promotedTo}
                  onChange={(event) => setRelinkTarget(event.target.value)}
                />
              </label>
              <Button
                type="button"
                size="sm"
                disabled={relinking || !relinkTarget.trim()}
                onClick={() => void relinkSelected()}
              >
                {relinking ? t("gap.relink.relinking") : t("gap.relink.confirm")}
              </Button>
              {canOpenSelectedInGraph ? (
                <Button type="button" size="sm" onClick={openSelectedInGraph}>
                  {t("gap.openInGraph")}
                </Button>
              ) : null}
            </div>
          ) : analyzing ? (
            <div className="gap-diff-empty" role="status">
              {t("gap.diff.loading")}
            </div>
          ) : selectedReport ? (
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
                      {t(`gap.type.${type}`)} {selectedReport.summary.byType[gapTypeCountKey(type)]}
                    </button>
                  ))}
                </div>
                <span className="gap-summary" role="status">
                  {t("gap.summary", {
                    total: selectedReport.summary.totalHunks,
                    added: selectedReport.summary.addedLines,
                    removed: selectedReport.summary.removedLines,
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
                {canOpenSelectedInGraph ? (
                  <Button type="button" size="sm" onClick={openSelectedInGraph}>
                    {t("gap.openInGraph")}
                  </Button>
                ) : null}
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
