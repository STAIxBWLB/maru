import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";
import { MonthGrid } from "./MonthGrid";
import { WeekGrid } from "./WeekGrid";
import { DayAgenda } from "./DayAgenda";
import { UpcomingEventsSidebar } from "./UpcomingEventsSidebar";
import { UnifiedCalendarToolbar } from "./UnifiedCalendarToolbar";
import type {
  CalendarLocale,
  CalendarView,
  UnifiedCalendarEvent,
} from "../../lib/calendar/types";

export interface UnifiedCalendarViewProps<T> {
  events: Array<UnifiedCalendarEvent<T>>;
  loading?: boolean;
  view: CalendarView;
  viewDate: Date;
  weekStartsOn: 0 | 1;
  locale: CalendarLocale;
  today?: Date;
  query: string;
  onQueryChange: (next: string) => void;
  onViewChange: (next: CalendarView) => void;
  onViewDateChange: (next: Date) => void;
  onSelectEvent?: (event: UnifiedCalendarEvent<T>) => void;
  onSelectDate?: (date: Date) => void;
  searchPlaceholder?: string;
  emptyLabel?: string;
  startHour?: number;
  loadingLabel?: string;
  footer?: ReactNode;
}

export function UnifiedCalendarView<T>({
  events,
  loading = false,
  view,
  viewDate,
  weekStartsOn,
  locale,
  today,
  query,
  onQueryChange,
  onViewChange,
  onViewDateChange,
  onSelectEvent,
  onSelectDate,
  searchPlaceholder,
  emptyLabel,
  startHour = 0,
  loadingLabel,
  footer,
}: UnifiedCalendarViewProps<T>) {
  const todayDate = today ?? new Date();
  return (
    <section className="unified-calendar">
      <UpcomingEventsSidebar
        events={events}
        view={view}
        viewDate={viewDate}
        weekStartsOn={weekStartsOn}
        today={todayDate}
        locale={locale}
        onSelectEvent={onSelectEvent}
        emptyLabel={emptyLabel}
      />
      <section className="cal-main">
        <UnifiedCalendarToolbar
          view={view}
          viewDate={viewDate}
          locale={locale}
          query={query}
          onQueryChange={onQueryChange}
          onViewChange={onViewChange}
          onViewDateChange={onViewDateChange}
          searchPlaceholder={searchPlaceholder}
        />
        <div className="cal-body">
          {loading ? (
            <div className="cal-loading">
              <Loader2 size={16} className="cal-spin" />
              <span>{loadingLabel ?? (locale === "ko" ? "로딩 중..." : "Loading...")}</span>
            </div>
          ) : view === "month" ? (
            <MonthGrid
              viewMonth={viewDate}
              events={events}
              weekStartsOn={weekStartsOn}
              locale={locale}
              today={todayDate}
              onSelectEvent={onSelectEvent}
              onSelectDate={onSelectDate}
            />
          ) : view === "week" ? (
            <WeekGrid
              viewDate={viewDate}
              events={events}
              weekStartsOn={weekStartsOn}
              locale={locale}
              today={todayDate}
              onSelectEvent={onSelectEvent}
              onSelectDate={onSelectDate}
              startHour={startHour}
            />
          ) : (
            <DayAgenda
              viewDate={viewDate}
              events={events}
              locale={locale}
              onSelectEvent={onSelectEvent}
              emptyLabel={emptyLabel}
            />
          )}
        </div>
        {footer}
      </section>
    </section>
  );
}
