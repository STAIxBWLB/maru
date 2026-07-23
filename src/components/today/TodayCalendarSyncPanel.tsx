import { format } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { ko } from "date-fns/locale/ko";
import {
  CalendarCheck,
  CalendarClock,
  CalendarPlus,
  Check,
  Loader2,
  TriangleAlert,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type { CalendarSyncStatus, DailyPlanItem } from "../../lib/today";
import { planItemRefKey } from "../../lib/todayPlan";
import { TaskSheet } from "./TaskSheet";
import { useCalendarCommitments } from "./useCalendarCommitments";
import { useToday } from "./todayContext";
import { resolveRefTitle, taskKeyOf } from "./todayPrepareUtils";
import { useTodayCalendarSync } from "./useTodayCalendarSync";
import { useTodayTasks } from "./useTodayTasks";

const STATUS_ORDER: CalendarSyncStatus[] = ["selected", "error", "syncing", "synced", "none"];

export function TodayCalendarSyncPanel() {
  const { t, locale } = useTranslation();
  const { snapshot } = useToday();
  const { commitments, loading: commitmentsLoading } = useCalendarCommitments();
  const { tasks, refresh } = useTodayTasks();
  const {
    destination,
    notice,
    publishing,
    publishSelected,
    retryItem,
    setSelected,
  } = useTodayCalendarSync();
  const [sheetTaskId, setSheetTaskId] = useState<string | null>(null);

  const items = useMemo(
    () =>
      [
        ...(snapshot?.plan?.top ?? []),
        ...(snapshot?.plan?.flexible ?? []),
        ...(snapshot?.plan?.overflow ?? []),
      ]
        .filter((item) => item.proposedBlock)
        .sort((left, right) => {
          const status =
            STATUS_ORDER.indexOf(left.calendarSync.status)
            - STATUS_ORDER.indexOf(right.calendarSync.status);
          if (status !== 0) return status;
          return (left.proposedBlock?.startIso ?? "").localeCompare(
            right.proposedBlock?.startIso ?? "",
          );
        }),
    [snapshot?.plan],
  );
  const selectedCount = items.filter(
    (item) => item.calendarSync.status === "selected",
  ).length;
  const sheetEntry = sheetTaskId
    ? (tasks.find((task) => taskKeyOf(task) === sheetTaskId) ?? null)
    : null;
  const dateLocale = locale === "ko" ? ko : enUS;

  const timeRange = (startIso: string, endIso: string) => {
    const start = new Date(startIso);
    const end = new Date(endIso);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "";
    return `${format(start, "M/d EEE HH:mm", { locale: dateLocale })} - ${format(end, "HH:mm", {
      locale: dateLocale,
    })}`;
  };

  const itemAction = (item: DailyPlanItem) => {
    switch (item.calendarSync.status) {
      case "selected":
        return (
          <button
            type="button"
            className="today-panel-link"
            disabled={publishing}
            onClick={() => void setSelected(item, false)}
          >
            <X size={12} aria-hidden="true" />
            {t("today.calendar.remove")}
          </button>
        );
      case "syncing":
        return (
          <span className="today-sync-badge">
            <Loader2 size={12} className="today-spin" aria-hidden="true" />
            {t("today.execute.sync.syncing")}
          </span>
        );
      case "synced":
        return (
          <span className="today-sync-badge">
            <Check size={12} aria-hidden="true" />
            {t("today.calendar.synced")}
          </span>
        );
      case "error":
        return (
          <button
            type="button"
            className="today-panel-link"
            disabled={publishing}
            title={item.calendarSync.message ?? undefined}
            onClick={() => void retryItem(item)}
          >
            <TriangleAlert size={12} aria-hidden="true" />
            {t("today.calendar.retry")}
          </button>
        );
      default:
        return (
          <button
            type="button"
            className="today-panel-link"
            disabled={publishing}
            onClick={() => void setSelected(item, true)}
          >
            <CalendarPlus size={12} aria-hidden="true" />
            {t("today.calendar.add")}
          </button>
        );
    }
  };

  return (
    <section className="today-calendar-sync">
      <header className="today-calendar-sync-header">
        <div>
          <h2>{t("today.calendar.panel.title")}</h2>
          <p>{t("today.calendar.panel.subtitle")}</p>
        </div>
        <div className="today-calendar-sync-destination">
          <span>{t("today.calendar.destination")}</span>
          <strong>{destination || t("today.calendar.destinationFallback")}</strong>
        </div>
        <button
          type="button"
          className="today-button-primary"
          disabled={publishing || selectedCount === 0}
          onClick={() => void publishSelected()}
        >
          {publishing ? (
            <Loader2 size={14} className="today-spin" aria-hidden="true" />
          ) : (
            <CalendarCheck size={14} aria-hidden="true" />
          )}
          {t("today.calendar.publishSelected", { count: selectedCount })}
        </button>
      </header>

      {notice ? (
        <p className="today-notice" role="alert">
          <TriangleAlert size={13} aria-hidden="true" />
          {notice === "calendarBlocked"
            ? t("today.calendar.blocked")
            : notice === "conflict"
              ? t("today.execute.conflict")
              : t("today.execute.error")}
        </p>
      ) : null}

      <div className="today-calendar-sync-grid">
        <section className="today-panel today-calendar-commitments">
          <header className="today-panel-header">
            <h3 className="today-panel-title">{t("today.calendar.commitments")}</h3>
            <span className="today-panel-meta">{commitments.length}</span>
          </header>
          <div className="today-panel-body">
            {commitmentsLoading ? (
              <p className="today-panel-empty">{t("tasks.loading")}</p>
            ) : commitments.length === 0 ? (
              <p className="today-panel-empty">{t("today.calendar.noCommitments")}</p>
            ) : (
              <ul className="today-calendar-commitment-list">
                {commitments.map((commitment) => (
                  <li key={`${commitment.source}:${commitment.startIso}:${commitment.title}`}>
                    <CalendarClock size={14} aria-hidden="true" />
                    <div>
                      <strong>{commitment.title}</strong>
                      <span>{timeRange(commitment.startIso, commitment.endIso)}</span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <section className="today-panel today-calendar-queue">
          <header className="today-panel-header">
            <h3 className="today-panel-title">{t("today.calendar.queue")}</h3>
            <span className="today-panel-meta">{items.length}</span>
          </header>
          <div className="today-panel-body">
            {items.length === 0 ? (
              <p className="today-panel-empty">{t("today.calendar.noBlocks")}</p>
            ) : (
              <ul className="today-calendar-queue-list">
                {items.map((item) => {
                  const title =
                    item.outcome?.trim()
                    || resolveRefTitle(item.itemRef, tasks, []);
                  const block = item.proposedBlock!;
                  return (
                    <li key={planItemRefKey(item.itemRef)}>
                      <button
                        type="button"
                        className="today-calendar-item-main"
                        disabled={item.itemRef.kind !== "task"}
                        onClick={() => {
                          if (item.itemRef.kind === "task") {
                            setSheetTaskId(item.itemRef.taskId);
                          }
                        }}
                      >
                        <strong>{title}</strong>
                        <span>{timeRange(block.startIso, block.endIso)}</span>
                      </button>
                      <span className={`today-calendar-status status-${item.calendarSync.status}`}>
                        {t(`today.calendar.status.${item.calendarSync.status}`)}
                      </span>
                      {itemAction(item)}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </section>
      </div>

      <TaskSheet
        entry={sheetEntry}
        open={sheetTaskId !== null}
        onClose={() => setSheetTaskId(null)}
        onSaved={() => void refresh()}
      />
    </section>
  );
}
