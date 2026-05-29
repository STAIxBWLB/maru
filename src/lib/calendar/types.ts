export type CalendarView = "day" | "week" | "month";

export type CalendarLocale = "ko" | "en";

export interface UnifiedCalendarEvent<T = unknown> {
  id: string;
  title: string;
  /** Source filename, used by the label mode to show filename / both. */
  fileName: string;
  start: Date;
  end: Date;
  allDay: boolean;
  category: string;
  source: "task" | "meeting";
  resource: T;
}

export interface MonthCell {
  date: Date;
  inCurrentMonth: boolean;
  isToday: boolean;
  isWeekend: boolean;
}

export interface LaneSegment<T = unknown> {
  event: UnifiedCalendarEvent<T>;
  startColumn: number;
  endColumn: number;
  openLeft: boolean;
  openRight: boolean;
}

export interface TimedChip<T = unknown> {
  event: UnifiedCalendarEvent<T>;
  column: number;
}

export interface WeekRowLayout<T = unknown> {
  weekStart: Date;
  cells: MonthCell[];
  lanes: Array<Array<LaneSegment<T>>>;
  timedByColumn: Array<Array<TimedChip<T>>>;
  overflowPerCell: number[];
}
