// Maru Today — Prepare panel: capacity, constraints, and sleep-boundary
// cards. Capacity math comes from computeCapacitySummary (mirrors the Rust
// side); busy time comes from the day's calendar commitments (local calendar
// notes) loaded by useCalendarCommitments.

import { format } from "date-fns";
import { CalendarDays, Moon, TriangleAlert } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import type { CalendarCommitment, TodayRoute } from "../../lib/today";
import { computeCapacitySummary, mergeBusyIntervals } from "../../lib/todayPlan";
import { useToday } from "./todayContext";

interface TodayCapacityCardsProps {
  onNavigate: (route: TodayRoute) => void;
  /** The logical day's busy intervals (local calendar notes). */
  commitments?: CalendarCommitment[];
}

/** How many merged busy ranges the constraints card spells out before
 *  collapsing the rest into a "+N more" suffix. */
const MAX_SHOWN_RANGES = 2;

export function TodayCapacityCards({ onNavigate, commitments = [] }: TodayCapacityCardsProps) {
  const { t } = useTranslation();
  const { settings, snapshot } = useToday();

  const busy = commitments;

  const summary = computeCapacitySummary({
    dayStart: snapshot?.dayStart ?? settings.dayStart,
    sleepStart: snapshot?.sleepStart ?? settings.sleepStart,
    busy,
    focusCapMinutes: settings.dailyFocusCapMinutes,
    plan: snapshot?.plan ?? null,
    provisionalEstimateMinutes: settings.provisionalEstimateMinutes,
    logicalDay: snapshot?.logicalDay ?? null,
  });

  const formatMinutes = (minutes: number): string => {
    const hours = Math.floor(minutes / 60);
    const rest = minutes % 60;
    if (hours > 0 && rest > 0) return t("today.capacity.hoursMinutes", { hours, minutes: rest });
    if (hours > 0) return t("today.capacity.hoursOnly", { hours });
    return t("today.capacity.minutesOnly", { minutes: rest });
  };

  const mergedRanges = mergeBusyIntervals(busy).map(
    (interval) =>
      `${format(interval.startMs, "HH:mm")}-${format(interval.endMs, "HH:mm")}`,
  );
  const shownRanges = mergedRanges.slice(0, MAX_SHOWN_RANGES);
  const hiddenRangeCount = mergedRanges.length - shownRanges.length;
  const rangesSummary =
    hiddenRangeCount > 0
      ? `${shownRanges.join(", ")}${t("today.calendar.rangesMore", { count: hiddenRangeCount })}`
      : shownRanges.join(", ");

  const rows: Array<{ key: string; label: string; value: string }> = [
    {
      key: "available",
      label: t("today.capacity.available"),
      value: formatMinutes(summary.focusCapMinutes),
    },
    {
      key: "proposed",
      label: t("today.capacity.proposed"),
      value: formatMinutes(summary.proposedMinutes),
    },
    {
      key: "remaining",
      label: t("today.capacity.remaining"),
      value: formatMinutes(summary.remainingMinutes),
    },
  ];

  return (
    <section className="today-panel today-panel-capacity" data-today-section="confirm">
      <div className="today-capacity-layout">
        <div className="today-capacity-card">
          <h4 className="today-capacity-card-title">{t("today.capacity.focusTitle")}</h4>
          <dl className="today-capacity-rows">
            {rows.map((row) => (
              <div key={row.key} className="today-capacity-row">
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </div>
            ))}
          </dl>
          {summary.overCapacity ? (
            <p className="today-capacity-warning" role="alert">
              <TriangleAlert size={13} strokeWidth={1.9} aria-hidden="true" />
              {t("today.capacity.overWarning")}
            </p>
          ) : null}
        </div>
        <div className="today-capacity-side">
          <div className="today-capacity-card">
            <div className="today-capacity-side-row">
              <CalendarDays size={16} strokeWidth={1.7} aria-hidden="true" />
              <div className="today-capacity-side-main">
                <p className="today-capacity-side-text">
                  {busy.length > 0
                    ? t("today.capacity.constraints.reflected", { count: busy.length })
                    : t("today.capacity.constraints.none")}
                </p>
                {rangesSummary ? (
                  <p className="today-capacity-side-text today-capacity-ranges">{rangesSummary}</p>
                ) : null}
              </div>
              <button
                type="button"
                className="today-panel-link"
                onClick={() => onNavigate("calendar")}
              >
                {t("today.capacity.constraints.viewCalendar")}
              </button>
            </div>
          </div>
          <div className="today-capacity-card">
            <div className="today-capacity-side-row">
              <Moon size={16} strokeWidth={1.7} aria-hidden="true" />
              <div className="today-capacity-side-main">
                <p className="today-capacity-side-title">{t("today.capacity.sleep.title")}</p>
                <p className="today-capacity-side-text">
                  {t("today.capacity.sleep.body", { time: summary.sleepStart })}
                </p>
              </div>
              <button
                type="button"
                className="today-panel-link"
                disabled
                title={t("today.capacity.sleep.settingsUnavailable")}
              >
                {t("today.capacity.sleep.changeSettings")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
