// Maru Today — Execute panel section: Google Tasks integration outbox.
// Lists outbox records with per-row op + status badges (icon + text, never
// color-only), attempts, and last-error tooltips. Recovery actions: per-row
// retry (requeue + drain) for retryNeeded/authBlocked rows, and a section-
// level "refresh all" (requeue failed + drain). Renders nothing when the
// outbox is empty; problem rows surface as a count badge on the collapsed
// header.

import {
  Check,
  ChevronDown,
  ChevronUp,
  Loader2,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { OutboxRecord, OutboxStatus } from "../../lib/today";
import {
  readTaskIntegrations,
  taskIntegrationsDrain,
  taskIntegrationsRetry,
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

export function TodaySyncStatus() {
  const { t } = useTranslation();
  const { workPath } = useToday();

  const [records, setRecords] = useState<OutboxRecord[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!workPath) return;
    try {
      setRecords(await readTaskIntegrations(workPath));
    } catch {
      // Keep the last known list; the next action retries the load.
    }
  }, [workPath]);

  useEffect(() => {
    void load();
  }, [load]);

  const problemCount = useMemo(
    () => records.filter((record) => PROBLEM_STATUSES.has(record.status)).length,
    [records],
  );

  /** Per-row recovery: requeue this record, drain, then reload the truth. */
  const retryRecord = async (id: string) => {
    if (!workPath || busy) return;
    setBusy(true);
    try {
      await taskIntegrationsRetry(workPath, [id], new Date().toISOString());
      await taskIntegrationsDrain(workPath, new Date().toISOString());
    } catch {
      // The reload below surfaces the real state either way.
    }
    await load();
    setBusy(false);
  };

  /** Section-level refresh: requeue everything failed, drain, reload. */
  const refreshAll = async () => {
    if (!workPath || busy) return;
    setBusy(true);
    try {
      await taskIntegrationsRetry(workPath, null, new Date().toISOString());
      await taskIntegrationsDrain(workPath, new Date().toISOString());
    } catch {
      // The reload below surfaces the real state either way.
    }
    await load();
    setBusy(false);
  };

  if (records.length === 0) return null;

  return (
    <section className="today-sync-status" aria-label={t("today.sync.title")}>
      <button
        type="button"
        className="today-sync-status-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="today-sync-status-title">{t("today.sync.title")}</span>
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
                  {record.status === "authBlocked" ? (
                    <p className="today-sync-status-hint">{t("today.sync.authHint")}</p>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
