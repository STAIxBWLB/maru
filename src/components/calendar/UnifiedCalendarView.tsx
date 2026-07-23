import { Loader2, PanelLeft } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
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
import type { DocumentLabelMode } from "../../lib/settings";
import { t } from "../../lib/i18n";
import { TODAY_LAYOUT_LIMITS } from "../../lib/todayLayout";
import { PaneResizeHandle } from "../ui/PaneResizeHandle";

export interface UnifiedCalendarViewProps<T> {
  events: Array<UnifiedCalendarEvent<T>>;
  loading?: boolean;
  view: CalendarView;
  viewDate: Date;
  weekStartsOn: 0 | 1;
  locale: CalendarLocale;
  labelMode?: DocumentLabelMode;
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
  agendaWidth?: number;
  onAgendaWidthChange?: (value: number) => void;
  onAgendaWidthCommit?: (value: number) => void;
}

export function UnifiedCalendarView<T>({
  events,
  loading = false,
  view,
  viewDate,
  weekStartsOn,
  locale,
  labelMode = "title",
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
  agendaWidth = 220,
  onAgendaWidthChange,
  onAgendaWidthCommit,
}: UnifiedCalendarViewProps<T>) {
  const todayDate = today ?? new Date();
  const [agendaOpen, setAgendaOpen] = useState(false);
  const resizableAgenda = Boolean(onAgendaWidthChange && onAgendaWidthCommit);
  return (
    <section
      className={[
        "unified-calendar",
        agendaOpen ? "agenda-open" : "",
        resizableAgenda ? "resizable-agenda" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ "--calendar-agenda-width": `${agendaWidth}px` } as CSSProperties}
    >
      <button
        type="button"
        className="cal-agenda-backdrop"
        aria-label={t(locale, "calendar.agenda.close")}
        onClick={() => setAgendaOpen(false)}
      />
      <button
        type="button"
        className="cal-agenda-toggle"
        aria-label={t(locale, "calendar.agenda.open")}
        aria-expanded={agendaOpen}
        onClick={() => setAgendaOpen((open) => !open)}
      >
        <PanelLeft size={15} />
      </button>
      <div className="cal-agenda-pane">
        <UpcomingEventsSidebar
          events={events}
          view={view}
          viewDate={viewDate}
          weekStartsOn={weekStartsOn}
          today={todayDate}
          locale={locale}
          labelMode={labelMode}
          onSelectEvent={(event) => {
            setAgendaOpen(false);
            onSelectEvent?.(event);
          }}
          emptyLabel={emptyLabel}
        />
      </div>
      {resizableAgenda ? (
        <div className="cal-agenda-resizer">
          <PaneResizeHandle
            label={t(locale, "calendar.agenda.resize")}
            value={agendaWidth}
            min={TODAY_LAYOUT_LIMITS.calendarAgendaWidth.min}
            max={TODAY_LAYOUT_LIMITS.calendarAgendaWidth.max}
            defaultValue={TODAY_LAYOUT_LIMITS.calendarAgendaWidth.defaultValue}
            onChange={onAgendaWidthChange!}
            onCommit={onAgendaWidthCommit!}
          />
        </div>
      ) : null}
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
              <span>{loadingLabel ?? t(locale, "calendar.loading")}</span>
            </div>
          ) : view === "month" ? (
            <MonthGrid
              viewMonth={viewDate}
              events={events}
              weekStartsOn={weekStartsOn}
              locale={locale}
              labelMode={labelMode}
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
              labelMode={labelMode}
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
              labelMode={labelMode}
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
