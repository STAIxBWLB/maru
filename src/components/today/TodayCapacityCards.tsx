// Maru Today — Prepare panel: capacity, constraints, and sleep-boundary
// cards. Capacity math comes from computeCapacitySummary (mirrors the Rust
// side); calendar commitments are not wired yet (TODO(calendar), Group 3),
// so busy time is empty and the constraints card says so honestly.

import { CalendarDays, Moon, TriangleAlert } from "lucide-react";
import { useTranslation } from "../../lib/i18n";
import type { CalendarCommitment, TodayRoute } from "../../lib/today";
import { computeCapacitySummary } from "../../lib/todayPlan";
import { useToday } from "./todayContext";

interface TodayCapacityCardsProps {
  onNavigate: (route: TodayRoute) => void;
}

export function TodayCapacityCards({ onNavigate }: TodayCapacityCardsProps) {
  const { t } = useTranslation();
  const { settings, snapshot } = useToday();

  // TODO(calendar): real busy commitments land with the calendar lane
  // (Group 3); computeCapacitySummary already merges/clips them.
  const busy: CalendarCommitment[] = [];

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
