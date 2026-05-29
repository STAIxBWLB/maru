import { useMemo } from "react";
import { addDays, format, isSameDay, startOfWeek } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import { buildMonthLayout } from "../../lib/calendar/buildMonthLayout";
import type {
  CalendarLocale,
  UnifiedCalendarEvent,
} from "../../lib/calendar/types";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";

const MONTH_BAR_LANES = 2;
const MONTH_TIMED_ROWS = 2;
const MONTH_DAY_ROW = 1;
const MONTH_BAR_START_ROW = 2;
const MONTH_TIMED_START_ROW = MONTH_BAR_START_ROW + MONTH_BAR_LANES;
const MONTH_OVERFLOW_ROW = MONTH_TIMED_START_ROW + MONTH_TIMED_ROWS;

interface MonthGridProps<T> {
  viewMonth: Date;
  events: Array<UnifiedCalendarEvent<T>>;
  weekStartsOn: 0 | 1;
  locale: CalendarLocale;
  labelMode?: DocumentLabelMode;
  today: Date;
  selectedDate?: Date | null;
  onSelectEvent?: (event: UnifiedCalendarEvent<T>) => void;
  onSelectDate?: (date: Date) => void;
}

export function MonthGrid<T>({
  viewMonth,
  events,
  weekStartsOn,
  locale,
  labelMode = "title",
  today,
  selectedDate,
  onSelectEvent,
  onSelectDate,
}: MonthGridProps<T>) {
  const layout = useMemo(
    () =>
      buildMonthLayout(viewMonth, events, {
        weekStartsOn,
        today,
        maxLanes: MONTH_BAR_LANES,
        maxTimedPerCell: MONTH_TIMED_ROWS,
      }),
    [viewMonth, events, weekStartsOn, today],
  );
  const localeObj = locale === "ko" ? ko : enUS;
  const headerStart = startOfWeek(today, { weekStartsOn });

  return (
    <div className="cal-month" role="grid">
      <div className="cal-month-header" role="row">
        {Array.from({ length: 7 }, (_, idx) => (
          <span key={idx} className="cal-dow" role="columnheader">
            {format(addDays(headerStart, idx), locale === "ko" ? "EEEEE" : "EEE", {
              locale: localeObj,
            })}
          </span>
        ))}
      </div>
      <div className="cal-month-body">
        {layout.map((week, weekIdx) => {
          return (
            <div
              key={weekIdx}
              className="cal-week-row"
              data-lanes={week.lanes.length}
            >
              {week.cells.map((cell, col) => (
                <button
                  key={`cell-${col}`}
                  type="button"
                  className={cellClassName(cell, selectedDate)}
                  style={{ gridColumn: col + 1, gridRow: "1 / -1" }}
                  onClick={() => onSelectDate?.(cell.date)}
                  aria-label={format(cell.date, "PPPP", { locale: localeObj })}
                />
              ))}
              {week.cells.map((cell, col) => (
                <span
                  key={`num-${col}`}
                  className={
                    cell.isToday
                      ? "cal-day-number cal-day-number-today"
                      : "cal-day-number"
                  }
                  style={{ gridColumn: col + 1, gridRow: MONTH_DAY_ROW }}
                >
                  {format(cell.date, "d")}
                </span>
              ))}
              {week.lanes.flatMap((lane, laneIdx) =>
                lane.map((seg) => {
                  const label = resolveDisplayLabel(
                    seg.event.title,
                    seg.event.fileName,
                    labelMode,
                  );
                  return (
                  <button
                    key={`bar-${laneIdx}-${seg.event.id}`}
                    type="button"
                    className={barClassName(seg.event.category, seg.openLeft, seg.openRight)}
                    style={{
                      gridColumn: `${seg.startColumn + 1} / span ${seg.endColumn - seg.startColumn + 1}`,
                      gridRow: MONTH_BAR_START_ROW + laneIdx,
                    }}
                    title={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectEvent?.(seg.event);
                    }}
                  >
                    <span className="cal-bar-label">
                      {seg.openLeft ? null : label.primary}
                    </span>
                  </button>
                  );
                }),
              )}
              {week.cells.flatMap((cell, col) => {
                const chips = week.timedByColumn[col];
                const overflow = week.overflowPerCell[col];
                const chipButtons = chips.map((chip, chipIdx) => {
                  const label = resolveDisplayLabel(
                    chip.event.title,
                    chip.event.fileName,
                    labelMode,
                  );
                  return (
                  <button
                    key={`chip-${col}-${chipIdx}-${chip.event.id}`}
                    type="button"
                    className={`cal-time-chip cal-month-time-chip cat-${chip.event.category}`}
                    style={{
                      gridColumn: col + 1,
                      gridRow: MONTH_TIMED_START_ROW + chipIdx,
                    }}
                    title={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectEvent?.(chip.event);
                    }}
                  >
                    <span className="cal-time-chip-time">
                      {format(chip.event.start, locale === "ko" ? "a h:mm" : "h:mma", {
                        locale: localeObj,
                      })}
                    </span>
                    <span className="cal-time-chip-title">{label.primary}</span>
                  </button>
                  );
                });
                if (overflow <= 0) return chipButtons;
                return [
                  ...chipButtons,
                  <button
                    key={`overflow-${col}`}
                    type="button"
                    className="cal-overflow-button"
                    style={{ gridColumn: col + 1, gridRow: MONTH_OVERFLOW_ROW }}
                    title={format(cell.date, "PPPP", { locale: localeObj })}
                    aria-label={
                      locale === "ko"
                        ? `${format(cell.date, "PPP", { locale: localeObj })} 추가 일정 ${overflow}개 보기`
                        : `Show ${overflow} more events on ${format(cell.date, "PPP", { locale: localeObj })}`
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      onSelectDate?.(cell.date);
                    }}
                  >
                    +{overflow}
                  </button>,
                ];
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function cellClassName(
  cell: { inCurrentMonth: boolean; isToday: boolean; isWeekend: boolean; date: Date },
  selectedDate?: Date | null,
): string {
  const classes = ["cal-day-cell"];
  if (!cell.inCurrentMonth) classes.push("off-range");
  if (cell.isToday) classes.push("today");
  if (cell.isWeekend) classes.push("weekend");
  if (selectedDate && isSameDay(cell.date, selectedDate)) classes.push("selected");
  return classes.join(" ");
}

function barClassName(category: string, openLeft: boolean, openRight: boolean): string {
  const classes = ["cal-bar", `cat-${category}`];
  if (openLeft) classes.push("open-left");
  if (openRight) classes.push("open-right");
  return classes.join(" ");
}
