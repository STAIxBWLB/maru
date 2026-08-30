// Maru Today — Execute panel section: Google Tasks integration outbox, plus
// the web-action receipts the Maru web app commits for the desktop to apply.
// Lists outbox records with per-row op + status badges (icon + text, never
// color-only), attempts, and last-error tooltips. Recovery actions: per-row
// retry (requeue + drain) for retryNeeded/authBlocked rows, and a section-
// level "refresh all" (requeue failed + drain). Applying web actions is a
// deliberate, separate button: it never commits or pushes, so the resulting
// working-tree changes ride the user's normal Git Sync. Renders nothing when
// both the outbox and the pending receipts are empty; problem rows and
// pending receipts surface as count badges on the collapsed header.

import {
  Check,
  ChevronDown,
  ChevronUp,
  CloudDownload,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type {
  OutboxRecord,
  OutboxStatus,
  WebActionSummary,
  WebActionsOutcome,
} from "../../lib/today";
import {
  readTaskIntegrations,
  taskIntegrationsDrain,
  taskIntegrationsRetry,
  webActionRepairTaskListLinkage,
  webActionsApply,
  webActionsImportTop,
  webActionsScan,
} from "../../lib/today";
import { useToday } from "./todayContext";

const PROBLEM_STATUSES: ReadonlySet<OutboxStatus> = new Set(["retryNeeded", "authBlocked"]);

/** File stem of the task note path (no directory, no extension). */
function taskStem(taskPath: string): string {
  const fileName = taskPath.split("/").pop() ?? taskPath;
  return fileName.replace(/\.md$/i, "");
}

/** Badge vocabulary: in-flight states all read as "syncing". */
function badgeStatus(status: OutboxStatus): "syncing" | "synced" | "retryNeeded" | "authBlocked" {
  switch (status) {
    case "synced":
      return "synced";
    case "retryNeeded":
      return "retryNeeded";
    case "authBlocked":
      return "authBlocked";
    default:
      return "syncing";
  }
}

function StatusBadge({ status }: { status: OutboxStatus }) {
  const { t } = useTranslation();
  const badge = badgeStatus(status);
  const warn = badge === "retryNeeded" || badge === "authBlocked";
  return (
    <span className={warn ? "today-sync-badge warn" : "today-sync-badge"} role="status">
      {badge === "syncing" ? (
        <Loader2 size={12} strokeWidth={1.9} className="today-spin" aria-hidden="true" />
      ) : badge === "synced" ? (
        <Check size={12} strokeWidth={2.2} aria-hidden="true" />
      ) : (
        <TriangleAlert size={12} strokeWidth={1.9} aria-hidden="true" />
      )}
      {t(`today.sync.status.${badge}`)}
    </span>
  );
}

/** Keep the local affordance as narrow as the Rust guard. This is only a
 * discoverability check; the command always re-validates every condition. */
function canRepairTaskListLinkage(record: OutboxRecord, defaultTaskList: string | null | undefined) {
  const list = defaultTaskList?.trim();
  if (
    !list ||
    record.op !== "upsert" ||
    record.status !== "authBlocked" ||
    Boolean(record.googleTaskId.trim()) ||
    !record.webActionId?.trim() ||
    !record.recordRevision?.trim()
  ) {
    return false;
  }
  if (!record.googleTaskListId?.trim()) return true;
  const error = record.lastError?.toLowerCase() ?? "";
  return (
    error.includes("invalid task list") ||
    error.includes("invalid tasklist") ||
    error.includes("task list not found") ||
    error.includes("tasklist not found")
  );
}

export function TodaySyncStatus() {
  const { t } = useTranslation();
  const { workPath, gwsBinary, defaultTaskList, snapshot, reload, settings } = useToday();
  const topLaneSize = settings.topLaneSize;
  const logicalDay = snapshot?.logicalDay ?? null;

  const [records, setRecords] = useState<OutboxRecord[]>([]);
  const [webActions, setWebActions] = useState<WebActionSummary[]>([]);
  const [webOutcome, setWebOutcome] = useState<WebActionsOutcome | null>(null);
  /** True when the day plan's Top lane differs from the snapshot's, i.e. the
   *  web rewrote it. A Top-3 reorder carries no action receipt, so this is the
   *  only signal that there is web work to apply. */
  const [topPending, setTopPending] = useState(false);
  const [topTruncated, setTopTruncated] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [repairResult, setRepairResult] = useState<"success" | "error" | null>(null);
  const [retryResult, setRetryResult] = useState<"success" | "error" | null>(null);
  // State updates do not disable a button until React commits. Keep the
  // provider boundary single-flight across rapid clicks in that short window.
  const busyRef = useRef(false);

  const load = useCallback(async () => {
    if (!workPath) return;
    try {
      setRecords(await readTaskIntegrations(workPath));
    } catch {
      // Keep the last known list; the next action retries the load.
    }
    try {
      setWebActions(await webActionsScan(workPath));
    } catch {
      // Same: a failed scan keeps the last known receipts.
    }
    if (!logicalDay) {
      setTopPending(false);
      setTopTruncated(0);
      return;
    }
    try {
      const preview = await webActionsImportTop(workPath, logicalDay, true, topLaneSize);
      setTopPending(preview.changed);
      setTopTruncated(preview.truncated);
    } catch {
      setTopPending(false);
      setTopTruncated(0);
    }
  }, [workPath, logicalDay, topLaneSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const problemCount = useMemo(
    () => records.filter((record) => PROBLEM_STATUSES.has(record.status)).length,
    [records],
  );

  /** Per-row recovery: requeue this record, drain, then reload the truth. */
  const retryRecord = async (id: string) => {
    if (!workPath || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRetryResult(null);
    try {
      await taskIntegrationsRetry(workPath, [id], new Date().toISOString());
      await taskIntegrationsDrain(workPath, new Date().toISOString(), gwsBinary);
      setRetryResult("success");
    } catch {
      // Never imply that a rejected IPC call reached the provider. Reload the
      // authoritative row, then make the failed explicit retry visible.
      setRetryResult("error");
    } finally {
      await load();
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Local-only repair. A successful repair deliberately stops before Retry:
   * Retry is the single control that can requeue and drain the provider op. */
  const repairTaskListLinkage = async (record: OutboxRecord) => {
    const taskListId = defaultTaskList?.trim();
    if (!workPath || !taskListId || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setRepairResult(null);
    try {
      await webActionRepairTaskListLinkage(workPath, record, taskListId);
      setRepairResult("success");
    } catch {
      setRepairResult("error");
    } finally {
      await load();
      busyRef.current = false;
      setBusy(false);
    }
  };

  /** Section-level refresh: requeue everything failed, drain, reload. */
  const refreshAll = async () => {
    if (!workPath || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await taskIntegrationsRetry(workPath, null, new Date().toISOString());
      await taskIntegrationsDrain(workPath, new Date().toISOString(), gwsBinary);
    } catch {
      // This control remains a best-effort refresh; the authoritative reload
      // below is what updates its rows.
    } finally {
      await load();
      busyRef.current = false;
      setBusy(false);
    }
  };

  /**
   * One "apply what came from the web" action: the pending action receipts,
   * then a drain so any provider op they queued goes out in the same click,
   * then the web-selected Top 3 back into the day snapshot. Never commits or
   * pushes.
   */
  const applyWebActions = async () => {
    if (!workPath || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      try {
        setWebOutcome(
          await webActionsApply(workPath, new Date().toISOString(), defaultTaskList),
        );
        await taskIntegrationsDrain(workPath, new Date().toISOString(), gwsBinary);
      } catch {
        // The authoritative reload below surfaces the current state either way.
      }
      if (logicalDay) {
        try {
          const top = await webActionsImportTop(workPath, logicalDay, false, topLaneSize);
          setTopTruncated(top.truncated);
          if (top.changed) await reload();
        } catch {
          // A failed import leaves the snapshot untouched by construction.
        }
      }
    } finally {
      await load();
      busyRef.current = false;
      setBusy(false);
    }
  };

  const webPending = webActions.length > 0 || topPending;

  // Keep rendering while a result is on screen: applying the last receipt can
  // empty every list, and the outcome is the only confirmation the user gets
  // that the working tree changed and still needs Git Sync.
  if (records.length === 0 && !webPending && webOutcome === null && topTruncated === 0) {
    return null;
  }

  return (
    <section className="today-sync-status" aria-label={t("today.sync.title")}>
      <button
        type="button"
        className="today-sync-status-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="today-sync-status-title">{t("today.sync.title")}</span>
        {webPending ? (
          <span className="today-sync-status-count neutral">
            <CloudDownload size={11} strokeWidth={1.9} aria-hidden="true" />
            {webActions.length > 0
              ? t("today.sync.web.pendingCount", { count: webActions.length })
              : t("today.sync.web.topPendingCount")}
          </span>
        ) : null}
        {problemCount > 0 ? (
          <span className="today-sync-status-count">
            <TriangleAlert size={11} strokeWidth={1.9} aria-hidden="true" />
            {t("today.sync.problemCount", { count: problemCount })}
          </span>
        ) : null}
        {expanded ? (
          <ChevronUp size={13} strokeWidth={1.9} aria-hidden="true" />
        ) : (
          <ChevronDown size={13} strokeWidth={1.9} aria-hidden="true" />
        )}
      </button>
      {expanded ? (
        <div className="today-sync-status-body">
          {webPending ? (
            <div className="today-sync-web">
              <span className="today-sync-web-summary">
                {webActions.length > 0
                  ? t("today.sync.web.pending", { count: webActions.length })
                  : t("today.sync.web.topPending")}
              </span>
              <button
                type="button"
                className="today-panel-link"
                disabled={busy}
                onClick={() => void applyWebActions()}
              >
                <CloudDownload size={12} strokeWidth={1.9} aria-hidden="true" />
                {t("today.sync.web.apply")}
              </button>
            </div>
          ) : null}
          {topTruncated > 0 ? (
            <p className="today-sync-web-result" role="status">
              {t("today.sync.web.topTruncated", {
                count: topTruncated,
                lane: topLaneSize,
              })}
            </p>
          ) : null}
          {webOutcome ? (
            <p className="today-sync-web-result" role="status">
              {t("today.sync.web.result", {
                applied: webOutcome.applied,
                skipped: webOutcome.skipped,
                stale: webOutcome.stale,
                invalid: webOutcome.invalid,
              })}
            </p>
          ) : null}
          <div className="today-sync-status-toolbar">
            <button
              type="button"
              className="today-panel-link"
              disabled={busy}
              onClick={() => void refreshAll()}
            >
              <RefreshCw size={12} strokeWidth={1.9} aria-hidden="true" />
              {t("today.sync.refresh")}
            </button>
          </div>
          <ul className="today-sync-status-list" aria-live="polite">
            {records.map((record) => {
              const problem = PROBLEM_STATUSES.has(record.status);
              const repairable = canRepairTaskListLinkage(record, defaultTaskList);
              return (
                <li
                  key={record.id}
                  className="today-sync-status-row"
                  title={record.lastError ?? undefined}
                >
                  <span className="today-sync-status-task">{taskStem(record.taskPath)}</span>
                  <span className="today-sync-status-op">{t(`today.sync.op.${record.op}`)}</span>
                  <StatusBadge status={record.status} />
                  <span className="today-sync-status-attempts">
                    {t("today.sync.attempts", { count: record.attempts })}
                  </span>
                  {problem ? (
                    <button
                      type="button"
                      className="today-panel-link"
                      disabled={busy}
                      onClick={() => void retryRecord(record.id)}
                    >
                      {t("today.sync.retry")}
                    </button>
                  ) : null}
                  {repairable ? (
                    <button
                      type="button"
                      className="today-panel-link"
                      disabled={busy}
                      onClick={() => void repairTaskListLinkage(record)}
                    >
                      {t("today.sync.repairTaskList")}
                    </button>
                  ) : null}
                  {record.status === "authBlocked" ? (
                    <p className="today-sync-status-hint">{t("today.sync.authHint")}</p>
                  ) : null}
                  {repairable ? (
                    <p className="today-sync-status-hint">{t("today.sync.repairTaskListHint")}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {repairResult ? (
            <p className="today-sync-web-result" role="status">
              {t(
                repairResult === "success"
                  ? "today.sync.repairTaskListSuccess"
                  : "today.sync.repairTaskListError",
              )}
            </p>
          ) : null}
          {retryResult ? (
            <p className="today-sync-web-result" role="status">
              {t(
                retryResult === "success"
                  ? "today.sync.retrySuccess"
                  : "today.sync.retryError",
              )}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
