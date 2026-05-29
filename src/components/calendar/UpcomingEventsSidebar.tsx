import { addDays, format, startOfWeek } from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import { groupCalendarRangeEvents } from "../../lib/calendar/groupUpcoming";
import type {
  CalendarLocale,
  CalendarView,
  UnifiedCalendarEvent,
} from "../../lib/calendar/types";
import type { DocumentLabelMode } from "../../lib/settings";
import { resolveDisplayLabel } from "../../lib/document";

interface UpcomingEventsSidebarProps<T> {
  events: Array<UnifiedCalendarEvent<T>>;
  view: CalendarView;
  viewDate: Date;
  weekStartsOn: 0 | 1;
  today: Date;
  locale: CalendarLocale;
  labelMode?: DocumentLabelMode;
  onSelectEvent?: (event: UnifiedCalendarEvent<T>) => void;
  emptyLabel?: string;
}

export function UpcomingEventsSidebar<T>({
  events,
  view,
  viewDate,
  weekStartsOn,
  today,
  locale,
  labelMode = "title",
  onSelectEvent,
  emptyLabel,
}: UpcomingEventsSidebarProps<T>) {
  const groups = groupCalendarRangeEvents(events, {
    view,
    viewDate,
    weekStartsOn,
    today,
    locale,
  });
  const localeObj = locale === "ko" ? ko : enUS;
  const heading = sidebarHeading(view, locale);
  const rangeLabel = sidebarRangeLabel(view, viewDate, weekStartsOn, locale);
  if (groups.length === 0) {
    return (
      <aside className="cal-sidebar" aria-label={heading}>
        <header className="cal-sidebar-header">
          <strong>{heading}</strong>
          <span>{rangeLabel}</span>
        </header>
        <p className="cal-sidebar-empty">
          {emptyLabel ?? (locale === "ko" ? "다가오는 일정 없음" : "Nothing upcoming")}
        </p>
      </aside>
    );
  }
  return (
    <aside className="cal-sidebar" aria-label={heading}>
      <header className="cal-sidebar-header">
        <strong>{heading}</strong>
        <span>{rangeLabel}</span>
      </header>
      <ul className="cal-sidebar-list">
        {groups.map((group) => (
          <li key={group.dateISO} className="cal-sidebar-group">
            <header className="cal-sidebar-group-header">
              <span className="cal-sidebar-bucket">{group.label}</span>
              <span className="cal-sidebar-date">{group.dateLabel}</span>
            </header>
            <ul className="cal-sidebar-events">
              {group.events.map((event) => {
                const label = resolveDisplayLabel(event.title, event.fileName, labelMode);
                return (
                <li key={event.id}>
                  <button
                    type="button"
                    className={`cal-sidebar-row cat-${event.category}`}
                    onClick={() => onSelectEvent?.(event)}
                  >
                    <span className="cal-sidebar-swatch" aria-hidden />
                    <span className="cal-sidebar-body">
                      {!event.allDay ? (
                        <span className="cal-sidebar-time">
                          {format(event.start, locale === "ko" ? "a h:mm" : "h:mm a", {
                            locale: localeObj,
                          })}
                        </span>
                      ) : null}
                      <span
                        className="cal-sidebar-title"
                        title={label.secondary ? `${label.primary} · ${label.secondary}` : label.primary}
                      >
                        {label.primary}
                      </span>
                      {label.secondary ? (
                        <span className="cal-sidebar-subtitle">{label.secondary}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ul>
    </aside>
  );
}

function sidebarHeading(view: CalendarView, locale: CalendarLocale): string {
  if (locale === "ko") {
    if (view === "day") return "일별 목록";
    if (view === "week") return "주간 목록";
    return "월간 목록";
  }
  if (view === "day") return "Day agenda";
  if (view === "week") return "Week agenda";
  return "Month agenda";
}

function sidebarRangeLabel(
  view: CalendarView,
  viewDate: Date,
  weekStartsOn: 0 | 1,
  locale: CalendarLocale,
): string {
  const localeObj = locale === "ko" ? ko : enUS;
  if (view === "day") {
    return format(viewDate, locale === "ko" ? "yyyy년 M월 d일" : "MMM d, yyyy", {
      locale: localeObj,
    });
  }
  if (view === "week") {
    const start = startOfWeek(viewDate, { weekStartsOn });
    const end = addDays(start, 6);
    if (locale === "ko") {
      return `${format(start, "yyyy년 M월 d일", { locale: localeObj })} - ${format(end, "M월 d일", { locale: localeObj })}`;
    }
    if (start.getFullYear() === end.getFullYear() && start.getMonth() === end.getMonth()) {
      return `${format(start, "MMM d", { locale: localeObj })}-${format(end, "d, yyyy", { locale: localeObj })}`;
    }
    return `${format(start, "MMM d, yyyy", { locale: localeObj })} - ${format(end, "MMM d, yyyy", { locale: localeObj })}`;
  }
  return format(viewDate, locale === "ko" ? "yyyy년 M월" : "MMMM yyyy", {
    locale: localeObj,
  });
}
