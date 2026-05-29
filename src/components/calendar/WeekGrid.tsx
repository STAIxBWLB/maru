import { useMemo } from "react";
import {
  addDays,
  differenceInCalendarDays,
  differenceInMinutes,
  format,
  isSameDay,
  startOfDay,
  startOfWeek,
  subDays,
} from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import type {
  CalendarLocale,
  LaneSegment,
  UnifiedCalendarEvent,
} from "../../lib/calendar/types";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";

interface WeekGridProps<T> {
  viewDate: Date;
  events: Array<UnifiedCalendarEvent<T>>;
  weekStartsOn: 0 | 1;
  locale: CalendarLocale;
  labelMode?: DocumentLabelMode;
  today: Date;
  onSelectEvent?: (event: UnifiedCalendarEvent<T>) => void;
  onSelectDate?: (date: Date) => void;
  startHour?: number;
}

const HOUR_HEIGHT = 44;

export function WeekGrid<T>({
  viewDate,
  events,
  weekStartsOn,
  locale,
  labelMode = "title",
  today,
  onSelectEvent,
  onSelectDate,
  startHour = 0,
}: WeekGridProps<T>) {
  const weekStart = startOfWeek(viewDate, { weekStartsOn });
  const weekEnd = addDays(weekStart, 6);
  const localeObj = locale === "ko" ? ko : enUS;
  const days = useMemo(
    () => Array.from({ length: 7 }, (_, idx) => addDays(weekStart, idx)),
    [weekStart],
  );

  const allDaySegments = useMemo(
    () => buildWeekAllDayLanes(weekStart, weekEnd, events),
    [weekStart, weekEnd, events],
  );

  const timedByDay = useMemo(() => {
    const buckets: Array<Array<UnifiedCalendarEvent<T>>> = days.map(() => []);
    for (const event of events) {
      if (event.allDay) continue;
      for (let idx = 0; idx < days.length; idx += 1) {
        if (isSameDay(event.start, days[idx])) {
          buckets[idx].push(event);
          break;
        }
      }
    }
    return buckets.map((list) => list.sort((a, b) => +a.start - +b.start));
  }, [events, days]);

  const hours = Array.from({ length: 24 - startHour }, (_, idx) => startHour + idx);

  return (
    <div className="cal-week">
      <header className="cal-week-header">
        <div className="cal-week-gutter" />
        {days.map((day) => (
          <button
            key={day.toISOString()}
            type="button"
            className={
              isSameDay(day, today) ? "cal-week-daycol today" : "cal-week-daycol"
            }
            onClick={() => onSelectDate?.(day)}
          >
            <span className="cal-week-dow">
              {format(day, locale === "ko" ? "EEEE" : "EEE", { locale: localeObj })}
            </span>
            <span className="cal-week-daynum">{format(day, "d")}</span>
          </button>
        ))}
      </header>
      {allDaySegments.length > 0 ? (
        <div
          className="cal-week-allday"
          style={{
            gridTemplateRows: `repeat(${allDaySegments.length}, 22px)`,
          }}
        >
          <div className="cal-week-allday-gutter">
            {locale === "ko" ? "종일" : "All-day"}
          </div>
          <div
            className="cal-week-allday-grid"
            style={{
              gridTemplateRows: `repeat(${allDaySegments.length}, 22px)`,
            }}
          >
            {allDaySegments.flatMap((lane, laneIdx) =>
              lane.map((seg) => {
                const label = resolveDisplayLabel(
                  seg.event.title,
                  seg.event.fileName,
                  labelMode,
                );
                return (
                <button
                  key={`wbar-${laneIdx}-${seg.event.id}`}
                  type="button"
                  className={`cal-bar cat-${seg.event.category}${seg.openLeft ? " open-left" : ""}${
                    seg.openRight ? " open-right" : ""
                  }`}
                  style={{
                    gridColumn: `${seg.startColumn + 1} / span ${seg.endColumn - seg.startColumn + 1}`,
                    gridRow: laneIdx + 1,
                  }}
                  title={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
                  onClick={() => onSelectEvent?.(seg.event)}
                >
                  <span className="cal-bar-label">
                    {seg.openLeft ? null : label.primary}
                  </span>
                </button>
                );
              }),
            )}
          </div>
        </div>
      ) : null}
      <div className="cal-week-body">
        <div className="cal-week-hours">
          {hours.map((hour) => (
            <div key={hour} className="cal-week-hour">
              <span>
                {format(new Date(2020, 0, 1, hour, 0), locale === "ko" ? "a h시" : "ha", {
                  locale: localeObj,
                })}
              </span>
            </div>
          ))}
        </div>
        <div
          className="cal-week-columns"
          style={{ height: `${(24 - startHour) * HOUR_HEIGHT}px` }}
        >
          {days.map((day, dayIdx) => (
            <div
              key={day.toISOString()}
              className="cal-week-column"
              onClick={() => onSelectDate?.(day)}
            >
              {hours.map((hour) => (
                <div
                  key={`line-${hour}`}
                  className="cal-week-line"
                  style={{ top: `${(hour - startHour) * HOUR_HEIGHT}px` }}
                />
              ))}
              {timedByDay[dayIdx].map((event) => {
                const startMinutes = Math.max(
                  0,
                  differenceInMinutes(event.start, startOfDay(event.start)),
                );
                const endMinutes = Math.min(
                  24 * 60,
                  differenceInMinutes(event.end, startOfDay(event.start)),
                );
                const adjustedStart = Math.max(0, startMinutes - startHour * 60);
                const top = (adjustedStart / 60) * HOUR_HEIGHT;
                const height = Math.max(
                  18,
                  ((endMinutes - Math.max(startMinutes, startHour * 60)) / 60) * HOUR_HEIGHT,
                );
                const label = resolveDisplayLabel(event.title, event.fileName, labelMode);
                return (
                  <button
                    key={event.id}
                    type="button"
                    className={`cal-event-block cat-${event.category}`}
                    style={{ top: `${top}px`, height: `${height}px` }}
                    title={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onSelectEvent?.(event);
                    }}
                  >
                    <span className="cal-event-time">
                      {format(event.start, locale === "ko" ? "a h:mm" : "h:mma", {
                        locale: localeObj,
                      })}
                    </span>
                    <span className="cal-event-title">{label.primary}</span>
                    {label.secondary ? (
                      <span className="cal-event-subtitle">{label.secondary}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function buildWeekAllDayLanes<T>(
  weekStart: Date,
  weekEnd: Date,
  events: Array<UnifiedCalendarEvent<T>>,
): Array<Array<LaneSegment<T>>> {
  const segments: Array<LaneSegment<T>> = [];
  for (const event of events) {
    if (!event.allDay && !isMultiDay(event)) continue;
    const firstDay = startOfDay(event.start);
    const inclusiveLast = event.end > event.start && isMidnight(event.end)
      ? subDays(event.end, 1)
      : event.end;
    const lastDay = startOfDay(inclusiveLast < firstDay ? firstDay : inclusiveLast);
    if (lastDay < weekStart || firstDay > weekEnd) continue;
    const segmentStart = firstDay < weekStart ? weekStart : firstDay;
    const segmentEnd = lastDay > weekEnd ? weekEnd : lastDay;
    const startColumn = clamp(differenceInCalendarDays(segmentStart, weekStart), 0, 6);
    const endColumn = clamp(differenceInCalendarDays(segmentEnd, weekStart), 0, 6);
    segments.push({
      event,
      startColumn,
      endColumn,
      openLeft: firstDay < weekStart,
      openRight: lastDay > weekEnd,
    });
  }
  segments.sort((a, b) => {
    if (a.startColumn !== b.startColumn) return a.startColumn - b.startColumn;
    return b.endColumn - b.startColumn - (a.endColumn - a.startColumn);
  });
  const lanes: Array<Array<LaneSegment<T>>> = [];
  for (const seg of segments) {
    let placed = false;
    for (let lane = 0; lane < lanes.length; lane += 1) {
      const conflict = lanes[lane].some(
        (existing) =>
          !(seg.endColumn < existing.startColumn || seg.startColumn > existing.endColumn),
      );
      if (!conflict) {
        lanes[lane].push(seg);
        placed = true;
        break;
      }
    }
    if (!placed) lanes.push([seg]);
  }
  return lanes;
}

function isMultiDay(event: UnifiedCalendarEvent): boolean {
  return differenceInCalendarDays(event.end, event.start) > 0;
}

function isMidnight(date: Date): boolean {
  return (
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
