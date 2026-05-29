import { useMemo } from "react";
import { differenceInCalendarDays, format, isSameDay, startOfDay } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import type {
  CalendarLocale,
  UnifiedCalendarEvent,
} from "../../lib/calendar/types";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";

interface DayAgendaProps<T> {
  viewDate: Date;
  events: Array<UnifiedCalendarEvent<T>>;
  locale: CalendarLocale;
  labelMode?: DocumentLabelMode;
  onSelectEvent?: (event: UnifiedCalendarEvent<T>) => void;
  emptyLabel?: string;
}

export function DayAgenda<T>({
  viewDate,
  events,
  locale,
  labelMode = "title",
  onSelectEvent,
  emptyLabel,
}: DayAgendaProps<T>) {
  const localeObj = locale === "ko" ? ko : enUS;
  const dayStart = startOfDay(viewDate);
  const visible = useMemo(() => {
    const list = events.filter((event) => coversDay(event, dayStart));
    return list.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return +a.start - +b.start;
    });
  }, [events, dayStart]);

  if (visible.length === 0) {
    return (
      <div className="cal-day cal-day-empty">
        <p>{emptyLabel ?? (locale === "ko" ? "이 날짜에 일정이 없습니다." : "No events")}</p>
      </div>
    );
  }

  return (
    <div className="cal-day">
      <header className="cal-day-header">
        <span className="cal-day-date">
          {format(viewDate, locale === "ko" ? "yyyy년 M월 d일 EEEE" : "EEEE, MMMM d, yyyy", {
            locale: localeObj,
          })}
        </span>
      </header>
      <ol className="cal-day-list">
        {visible.map((event) => {
          const label = resolveDisplayLabel(event.title, event.fileName, labelMode);
          return (
          <li key={event.id}>
            <button
              type="button"
              className={`cal-day-row cat-${event.category}`}
              onClick={() => onSelectEvent?.(event)}
            >
              <span className="cal-day-time">
                {event.allDay
                  ? locale === "ko"
                    ? "종일"
                    : "All-day"
                  : format(event.start, locale === "ko" ? "a h:mm" : "h:mm a", {
                      locale: localeObj,
                    })}
              </span>
              <span className="cal-day-titles">
                <span className="cal-day-title">{label.primary}</span>
                {label.secondary ? (
                  <span className="cal-day-subtitle">{label.secondary}</span>
                ) : null}
              </span>
            </button>
          </li>
          );
        })}
      </ol>
    </div>
  );
}

function coversDay(event: UnifiedCalendarEvent, day: Date): boolean {
  if (isSameDay(event.start, day)) return true;
  if (!event.allDay && differenceInCalendarDays(event.end, event.start) === 0) {
    return isSameDay(event.start, day);
  }
  return event.start <= day && event.end > day;
}
