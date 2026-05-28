import {
  addDays,
  differenceInCalendarDays,
  endOfMonth,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
  subDays,
  type Locale,
} from "date-fns";
import { ko } from "date-fns/locale/ko";
import { enUS } from "date-fns/locale/en-US";
import type { CalendarLocale, CalendarView, UnifiedCalendarEvent } from "./types";

export interface CalendarRangeGroup<T = unknown> {
  dateISO: string;
  date: Date;
  label: string;
  dateLabel: string;
  events: Array<UnifiedCalendarEvent<T>>;
}

export type UpcomingGroup<T = unknown> = CalendarRangeGroup<T>;

export interface GroupCalendarRangeOptions {
  view: CalendarView;
  viewDate: Date;
  weekStartsOn: 0 | 1;
  today: Date;
  locale: CalendarLocale;
}

export interface GroupUpcomingOptions {
  today: Date;
  locale: CalendarLocale;
  horizonDays?: number;
}

const LOCALES = { ko, en: enUS };

export function groupCalendarRangeEvents<T>(
  events: Array<UnifiedCalendarEvent<T>>,
  options: GroupCalendarRangeOptions,
): Array<CalendarRangeGroup<T>> {
  const range = calendarRange(options.view, options.viewDate, options.weekStartsOn);
  return groupEventsInRange(events, {
    rangeStart: range.start,
    rangeEnd: range.end,
    today: options.today,
    locale: options.locale,
  });
}

export function groupUpcomingEvents<T>(
  events: Array<UnifiedCalendarEvent<T>>,
  options: GroupUpcomingOptions,
): Array<CalendarRangeGroup<T>> {
  const todayMidnight = startOfDay(options.today);
  const horizon = options.horizonDays ?? 30;
  return groupEventsInRange(events, {
    rangeStart: todayMidnight,
    rangeEnd: addDays(todayMidnight, horizon),
    today: options.today,
    locale: options.locale,
  });
}

function groupEventsInRange<T>(
  events: Array<UnifiedCalendarEvent<T>>,
  options: {
    rangeStart: Date;
    rangeEnd: Date;
    today: Date;
    locale: CalendarLocale;
  },
): Array<CalendarRangeGroup<T>> {
  const rangeStart = startOfDay(options.rangeStart);
  const rangeEnd = startOfDay(options.rangeEnd);
  const todayMidnight = startOfDay(options.today);
  const localeObj = LOCALES[options.locale] ?? enUS;

  const buckets = new Map<string, CalendarRangeGroup<T>>();
  for (const event of events) {
    const prepared = prepareEvent(event);
    if (!prepared) continue;
    if (prepared.lastDay < rangeStart || prepared.firstDay > rangeEnd) continue;
    const bucketDate = prepared.firstDay < rangeStart ? rangeStart : prepared.firstDay;
    const key = isoDate(bucketDate);
    const existing = buckets.get(key);
    if (existing) {
      existing.events.push(event);
      continue;
    }
    buckets.set(key, {
      dateISO: key,
      date: bucketDate,
      label: bucketLabel(bucketDate, todayMidnight, options.locale, localeObj),
      dateLabel: dateLabel(bucketDate, options.locale, localeObj),
      events: [event],
    });
  }

  const groups = Array.from(buckets.values()).sort((a, b) => +a.date - +b.date);
  for (const group of groups) {
    group.events.sort((a, b) => +a.start - +b.start || a.title.localeCompare(b.title));
  }
  return groups;
}

function calendarRange(
  view: CalendarView,
  viewDate: Date,
  weekStartsOn: 0 | 1,
): { start: Date; end: Date } {
  if (view === "day") {
    const day = startOfDay(viewDate);
    return { start: day, end: day };
  }
  if (view === "week") {
    const start = startOfWeek(viewDate, { weekStartsOn });
    return { start, end: addDays(start, 6) };
  }
  return {
    start: startOfMonth(viewDate),
    end: startOfDay(endOfMonth(viewDate)),
  };
}

function prepareEvent<T>(
  event: UnifiedCalendarEvent<T>,
): { firstDay: Date; lastDay: Date } | null {
  const start = event.start;
  const end = event.end;
  if (!(start instanceof Date) || Number.isNaN(start.getTime())) return null;
  if (!(end instanceof Date) || Number.isNaN(end.getTime())) return null;
  const firstDay = startOfDay(start);
  const inclusiveLast = end > start && isMidnight(end) ? subDays(end, 1) : end;
  const lastDay = startOfDay(inclusiveLast < firstDay ? firstDay : inclusiveLast);
  return { firstDay, lastDay };
}

function bucketLabel(
  date: Date,
  today: Date,
  locale: CalendarLocale,
  localeObj: Locale,
): string {
  const diff = differenceInCalendarDays(date, today);
  if (locale === "ko") {
    if (diff === 0) return "오늘";
    if (diff === 1) return "내일";
    return format(date, "EEEE", { locale: localeObj });
  }
  if (isSameDay(date, today)) return "TODAY";
  if (diff === 1) return "TOMORROW";
  return format(date, "EEE", { locale: localeObj }).toUpperCase();
}

function dateLabel(date: Date, locale: CalendarLocale, localeObj: Locale): string {
  if (locale === "ko") {
    return format(date, "yyyy년 M월 d일", { locale: localeObj });
  }
  return format(date, "MMM d, yyyy", { locale: localeObj });
}

function isMidnight(date: Date): boolean {
  return (
    date.getHours() === 0 &&
    date.getMinutes() === 0 &&
    date.getSeconds() === 0 &&
    date.getMilliseconds() === 0
  );
}

function isoDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
