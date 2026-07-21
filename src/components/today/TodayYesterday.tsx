// Maru Today — Prepare band: yesterday review. Groups yesterday's items into
// 완료 / 진척 / 이월 and exposes the four routing decisions (오늘 / 유연 /
// 날짜 미루기 / 취소) for items that still need one. Decisions persist via
// applyYesterdayDecision; rows update from the returned snapshot.

import { format, subDays } from "date-fns";
import { enUS } from "date-fns/locale/en-US";
import { ko } from "date-fns/locale/ko";
import {
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Info,
  Sun,
  Waves,
  X,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "../../lib/i18n";
import type {
  TodayRoute,
  YesterdayItem,
  YesterdayResolution,
} from "../../lib/today";
import { useToday } from "./todayContext";
import { addDaysIso } from "./todayPrepareUtils";

const COLLAPSED_ROW_COUNT = 2;

type YesterdayGroup = "done" | "progress" | "carryover";

interface TodayYesterdayProps {
  /** Auto-plan trigger after a decision lands. */
  onChanged: (kind: string) => void;
  onNavigate: (route: TodayRoute) => void;
}

function groupOf(item: YesterdayItem): YesterdayGroup | null {
  if (item.status === "done") return "done";
  if (item.resolution === "defer" || item.resolution === "cancel") return null;
  const progress = item.progress ?? 0;
  if (item.status === "in-progress" || progress > 0) return "progress";
  if (item.resolution) return null;
  return "carryover";
}

/** Small circular progress indicator (shape + % text, not color-only). */
function ProgressRing({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const radius = 7;
  const circumference = 2 * Math.PI * radius;
  const filled = (clamped / 100) * circumference;
  return (
    <span className="today-progress">
      <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
        <circle cx="9" cy="9" r={radius} className="today-progress-track" />
        <circle
          cx="9"
          cy="9"
          r={radius}
          className="today-progress-fill"
          strokeDasharray={`${filled} ${circumference}`}
          transform="rotate(-90 9 9)"
        />
      </svg>
      <span className="today-progress-text">{clamped}%</span>
    </span>
  );
}

export function TodayYesterday({ onChanged, onNavigate }: TodayYesterdayProps) {
  const { t, locale } = useTranslation();
  const { snapshot, mutate } = useToday();
  const [expanded, setExpanded] = useState<Record<YesterdayGroup, boolean>>({
    done: false,
    progress: false,
    carryover: false,
  });

  const groups = useMemo(() => {
    const result: Record<YesterdayGroup, YesterdayItem[]> = {
      done: [],
      progress: [],
      carryover: [],
    };
    for (const item of snapshot?.yesterday ?? []) {
      const group = groupOf(item);
      if (group) result[group].push(item);
    }
    return result;
  }, [snapshot]);

  const dateLabel = useMemo(() => {
    if (!snapshot) return "";
    const dateLocale = locale === "ko" ? ko : enUS;
    const day = subDays(new Date(`${snapshot.logicalDay}T00:00:00`), 1);
    return locale === "ko"
      ? format(day, "M월 d일 (EEE)", { locale: dateLocale })
      : format(day, "MMM d (EEE)", { locale: dateLocale });
  }, [snapshot, locale]);

  const decide = (item: YesterdayItem, resolution: YesterdayResolution) => {
    // Defer uses the simplest default: +1 day from the logical day.
    const deferDate =
      resolution === "defer" && snapshot ? addDaysIso(snapshot.logicalDay, 1) : null;
    const mutation =
      resolution === "defer"
        ? {
            type: "applyYesterdayDecision" as const,
            taskId: item.taskId,
            resolution,
            deferDate,
          }
        : { type: "applyYesterdayDecision" as const, taskId: item.taskId, resolution };
    void mutate(mutation).then((next) => {
      if (next) onChanged("carryover");
    });
  };

  const decisionButtons = (item: YesterdayItem) => (
    <div className="today-yesterday-decisions">
      <button type="button" onClick={() => decide(item, "today")}>
        <Sun size={12} strokeWidth={1.9} aria-hidden="true" />
        {t("today.yesterday.decision.today")}
      </button>
      <button type="button" onClick={() => decide(item, "flexible")}>
        <Waves size={12} strokeWidth={1.9} aria-hidden="true" />
        {t("today.yesterday.decision.flexible")}
      </button>
      <button type="button" onClick={() => decide(item, "defer")}>
        <Clock size={12} strokeWidth={1.9} aria-hidden="true" />
        {t("today.yesterday.decision.defer")}
      </button>
      <button type="button" onClick={() => decide(item, "cancel")}>
        <X size={12} strokeWidth={1.9} aria-hidden="true" />
        {t("today.yesterday.decision.cancel")}
      </button>
    </div>
  );

  const renderRow = (group: YesterdayGroup, item: YesterdayItem) => {
    const needsDecision = item.resolution == null;
    return (
      <li key={item.taskId} className="today-yesterday-row">
        <div className="today-yesterday-row-main">
          {group === "done" ? (
            <CheckCircle2 size={15} strokeWidth={1.9} className="today-yesterday-done-icon" aria-hidden="true" />
          ) : null}
          {group === "progress" ? <ProgressRing percent={item.progress ?? 0} /> : null}
          {group === "carryover" ? (
            <span className="today-yesterday-warn-dot" aria-hidden="true" />
          ) : null}
          <span className="today-yesterday-title">{item.title}</span>
          {group === "carryover" && needsDecision ? (
            <span className="today-yesterday-flag">{t("today.yesterday.needsDecision")}</span>
          ) : null}
          {group !== "done" && item.resolution ? (
            <span className="today-yesterday-flag">
              {t(`today.yesterday.decision.${item.resolution}`)}
            </span>
          ) : null}
        </div>
        {group !== "done" && needsDecision ? decisionButtons(item) : null}
      </li>
    );
  };

  const renderGroup = (
    group: YesterdayGroup,
    titleKey: string,
    subtitleKey: string,
  ) => {
    const items = groups[group];
    const shown = expanded[group] ? items : items.slice(0, COLLAPSED_ROW_COUNT);
    const hidden = items.length - shown.length;
    return (
      <div className="today-yesterday-group" key={group}>
        <header className="today-yesterday-group-header">
          <h4 className="today-yesterday-group-title">
            {t(titleKey)} {items.length}
          </h4>
          <button
            type="button"
            className="today-panel-link"
            onClick={() => onNavigate("review")}
          >
            {t("today.yesterday.viewAll")}
          </button>
        </header>
        <p className="today-yesterday-group-subtitle">{t(subtitleKey)}</p>
        {items.length > 0 ? (
          <ul className="today-yesterday-list">
            {shown.map((item) => renderRow(group, item))}
          </ul>
        ) : null}
        {hidden > 0 ? (
          <button
            type="button"
            className="today-panel-link today-yesterday-more"
            onClick={() => setExpanded((prev) => ({ ...prev, [group]: true }))}
          >
            {t("today.yesterday.more", { count: hidden })}
            <ChevronDown size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
        {expanded[group] && items.length > COLLAPSED_ROW_COUNT ? (
          <button
            type="button"
            className="today-panel-link today-yesterday-more"
            onClick={() => setExpanded((prev) => ({ ...prev, [group]: false }))}
          >
            <ChevronUp size={12} strokeWidth={1.9} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    );
  };

  const total = groups.done.length + groups.progress.length + groups.carryover.length;

  return (
    <section className="today-panel today-panel-yesterday" data-today-section="yesterday">
      <header className="today-panel-header">
        <h3 className="today-panel-title">
          {snapshot
            ? t("today.yesterday.heading", { date: dateLabel })
            : t("today.panel.yesterday.title")}
        </h3>
        <Info size={14} strokeWidth={1.9} className="today-panel-info" aria-hidden="true" />
      </header>
      <div className="today-panel-body">
        {total === 0 ? (
          <p className="today-panel-empty">{t("today.yesterday.empty")}</p>
        ) : (
          <div className="today-yesterday-groups">
            {renderGroup("done", "today.yesterday.done.title", "today.yesterday.done.subtitle")}
            {renderGroup(
              "progress",
              "today.yesterday.progress.title",
              "today.yesterday.progress.subtitle",
            )}
            {renderGroup(
              "carryover",
              "today.yesterday.carryover.title",
              "today.yesterday.carryover.subtitle",
            )}
          </div>
        )}
      </div>
    </section>
  );
}
