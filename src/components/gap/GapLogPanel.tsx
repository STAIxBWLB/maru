import { useMemo } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  aggregateGapTypeCounts,
  GAP_HUNK_TYPES,
  gapTrend,
  gapTypeCountKey,
  groupGapLogByDay,
} from "../../lib/gapAnalysis";
import type { GapLogEntry, GapReportSummary } from "../../lib/types";
import { EmptyState } from "../ui/ModeChrome";

interface GapLogPanelProps {
  entries: GapLogEntry[];
  loading: boolean;
  /** Reports list, used to resolve human titles for log entries. */
  reports: GapReportSummary[];
  /** Draft currently selected in the pane (trend is scoped to it). */
  selectedDraftId: string | null;
}

const TREND_ARROWS = { down: "↓", up: "↑", flat: "=" } as const;

function timeLabel(at: string, locale: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return at;
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(date);
}

function dayLabel(day: string, locale: string): string {
  const date = new Date(`${day}T00:00:00`);
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

/** Cumulative stats + log zone: per-type distribution, selected-document
 *  gap trend, and the log entries grouped by local day. */
export function GapLogPanel({ entries, loading, reports, selectedDraftId }: GapLogPanelProps) {
  const { t, locale } = useTranslation();

  const totals = useMemo(() => aggregateGapTypeCounts(entries), [entries]);
  const totalMax = Math.max(1, ...GAP_HUNK_TYPES.map((type) => totals[gapTypeCountKey(type)]));
  const dayGroups = useMemo(() => groupGapLogByDay(entries), [entries]);
  const titleByDraftId = useMemo(() => {
    const map = new Map<string, string>();
    for (const report of reports) map.set(report.draftId, report.title);
    return map;
  }, [reports]);
  const trend = useMemo(
    () =>
      selectedDraftId
        ? gapTrend(entries.filter((entry) => entry.draftId === selectedDraftId))
        : [],
    [entries, selectedDraftId],
  );

  const draftLabel = (draftId: string) => titleByDraftId.get(draftId) ?? draftId;

  return (
    <div className="gap-log-col">
      <h3 className="gap-log-title">{t("gap.log.title")}</h3>

      <section className="gap-log-section" aria-label={t("gap.log.distribution")}>
        <h4>{t("gap.log.distribution")}</h4>
        {GAP_HUNK_TYPES.map((type) => {
          const count = totals[gapTypeCountKey(type)];
          return (
            <div key={type} className="gap-dist-row">
              <span className={`gap-type-badge gap-type-${type}`}>{t(`gap.type.${type}`)}</span>
              <span className="gap-dist-bar">
                <span
                  className="gap-dist-bar-fill"
                  style={{ width: `${Math.round((count / totalMax) * 100)}%` }}
                />
              </span>
              <span className="gap-dist-count">{count}</span>
            </div>
          );
        })}
      </section>

      {selectedDraftId ? (
        <section className="gap-log-section" aria-label={t("gap.log.trend")}>
          <h4>{t("gap.log.trend")}</h4>
          {trend.length === 0 ? (
            <p className="gap-log-hint">{t("gap.log.trendEmpty")}</p>
          ) : (
            <p className="gap-trend" title={t("gap.log.trendHint")}>
              {trend.map((point, index) => (
                <span key={`${point.entry.at}-${index}`} className="gap-trend-point">
                  {index > 0 && point.direction ? (
                    <span
                      className={`gap-trend-arrow gap-trend-${point.direction}`}
                      aria-label={t(`gap.log.trend.${point.direction}`)}
                    >
                      {TREND_ARROWS[point.direction]}
                    </span>
                  ) : null}
                  <span className="gap-trend-size">{point.size}</span>
                </span>
              ))}
            </p>
          )}
        </section>
      ) : null}

      <section className="gap-log-section gap-log-entries" aria-label={t("gap.log.entries")}>
        <h4>{t("gap.log.entries")}</h4>
        {!loading && entries.length === 0 ? (
          <EmptyState title={t("gap.log.empty")} description={t("gap.log.emptyHint")} />
        ) : null}
        {dayGroups.map((group) => (
          <div key={group.day} className="gap-log-day">
            <h5 className="gap-log-day-label">{dayLabel(group.day, locale)}</h5>
            {group.entries.map((entry, index) => (
              <div key={`${entry.at}-${index}`} className="gap-log-entry">
                <div className="gap-log-entry-head">
                  <span className="gap-log-entry-time">{timeLabel(entry.at, locale)}</span>
                  <strong className="gap-log-entry-doc" title={entry.promotedTo}>
                    {draftLabel(entry.draftId)}
                  </strong>
                  <span className="gap-log-entry-lines">
                    +{entry.addedLines} / -{entry.removedLines}
                  </span>
                </div>
                <div className="gap-log-entry-types">
                  {GAP_HUNK_TYPES.map((type) => {
                    const count = entry.byType[gapTypeCountKey(type)];
                    if (count === 0) return null;
                    return (
                      <span key={type} className={`gap-type-badge gap-type-${type}`}>
                        {t(`gap.type.${type}`)} {count}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        ))}
      </section>
    </div>
  );
}
