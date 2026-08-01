import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import {
  aggregateGapTypeCounts,
  GAP_HUNK_TYPES,
  gapLogDayKey,
  gapTrend,
  gapTypeCountKey,
  groupGapLogByDay,
} from "../../lib/gapAnalysis";
import type { GapHunkType, GapLogEntry, GapReportSummary } from "../../lib/types";
import { EmptyState } from "../ui/ModeChrome";

interface GapLogPanelProps {
  entries: GapLogEntry[];
  loading: boolean;
  /** Reports list, used to resolve human titles for log entries. */
  reports: GapReportSummary[];
  /** Draft currently selected in the pane (trend is scoped to it). */
  selectedDraftId: string | null;
  /** Select the draft a log entry names. Omitted when selection is unavailable. */
  onSelectDraft?: (draftId: string) => void;
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
export function GapLogPanel({
  entries,
  loading,
  reports,
  selectedDraftId,
  onSelectDraft,
}: GapLogPanelProps) {
  const { t, locale } = useTranslation();

  const [typeFilter, setTypeFilter] = useState<GapHunkType | null>(null);
  const [fromDay, setFromDay] = useState("");
  const [toDay, setToDay] = useState("");

  // The distribution is always over everything: it is what you click to filter,
  // so narrowing it by its own filter would leave no way back.
  const totals = useMemo(() => aggregateGapTypeCounts(entries), [entries]);
  const totalMax = Math.max(1, ...GAP_HUNK_TYPES.map((type) => totals[gapTypeCountKey(type)]));

  const filtered = useMemo(
    () =>
      entries.filter((entry) => {
        if (typeFilter && entry.byType[gapTypeCountKey(typeFilter)] === 0) return false;
        const day = gapLogDayKey(entry.at);
        if (fromDay && day < fromDay) return false;
        if (toDay && day > toDay) return false;
        return true;
      }),
    [entries, typeFilter, fromDay, toDay],
  );
  const filterActive = typeFilter !== null || fromDay !== "" || toDay !== "";

  const dayGroups = useMemo(() => groupGapLogByDay(filtered), [filtered]);
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
          const active = typeFilter === type;
          return (
            <button
              key={type}
              type="button"
              className={`gap-dist-row${active ? " is-active" : ""}`}
              aria-pressed={active}
              title={t("gap.log.filterByType")}
              onClick={() => setTypeFilter(active ? null : type)}
            >
              <span className={`gap-type-badge gap-type-${type}`}>{t(`gap.type.${type}`)}</span>
              <span className="gap-dist-bar">
                <span
                  className="gap-dist-bar-fill"
                  style={{ width: `${Math.round((count / totalMax) * 100)}%` }}
                />
              </span>
              <span className="gap-dist-count">{count}</span>
            </button>
          );
        })}
      </section>

      <section className="gap-log-section gap-log-filters" aria-label={t("gap.log.filterRange")}>
        <label className="gap-log-filter">
          <span>{t("gap.log.filterFrom")}</span>
          <input type="date" value={fromDay} max={toDay || undefined} onChange={(event) => setFromDay(event.target.value)} />
        </label>
        <label className="gap-log-filter">
          <span>{t("gap.log.filterTo")}</span>
          <input type="date" value={toDay} min={fromDay || undefined} onChange={(event) => setToDay(event.target.value)} />
        </label>
        {filterActive ? (
          <button
            type="button"
            className="gap-log-filter-clear"
            onClick={() => {
              setTypeFilter(null);
              setFromDay("");
              setToDay("");
            }}
          >
            {t("gap.log.filterClear", { shown: filtered.length, total: entries.length })}
          </button>
        ) : null}
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
        {!loading && entries.length > 0 && filtered.length === 0 ? (
          <p className="gap-log-hint">{t("gap.log.filterEmpty")}</p>
        ) : null}
        {dayGroups.map((group) => (
          <div key={group.day} className="gap-log-day">
            <h5 className="gap-log-day-label">{dayLabel(group.day, locale)}</h5>
            {group.entries.map((entry, index) => (
              <div
                key={`${entry.at}-${index}`}
                className={`gap-log-entry${onSelectDraft ? " is-clickable" : ""}${
                  entry.draftId === selectedDraftId ? " is-selected" : ""
                }`}
                role={onSelectDraft ? "button" : undefined}
                tabIndex={onSelectDraft ? 0 : undefined}
                onClick={onSelectDraft ? () => onSelectDraft(entry.draftId) : undefined}
                onKeyDown={
                  onSelectDraft
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onSelectDraft(entry.draftId);
                        }
                      }
                    : undefined
                }
              >
                <div className="gap-log-entry-head">
                  <span className="gap-log-entry-time">{timeLabel(entry.at, locale)}</span>
                  <strong className="gap-log-entry-doc" title={entry.promotedTo}>
                    {draftLabel(entry.draftId)}
                  </strong>
                  <span
                    className="gap-log-entry-lines"
                    title={
                      entry.baselineLines
                        ? t("gap.log.churnOfBaseline", { lines: entry.baselineLines })
                        : undefined
                    }
                  >
                    +{entry.addedLines} / -{entry.removedLines}
                    {entry.baselineLines ? (
                      <span className="gap-log-entry-baseline"> / {entry.baselineLines}</span>
                    ) : null}
                  </span>
                  {entry.generatedBy ? (
                    <span className="gap-log-entry-runtime">{entry.generatedBy}</span>
                  ) : null}
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
