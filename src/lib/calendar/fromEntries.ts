import type { TaskEntry, TaskPriority } from "../tasks";
import type { MeetingNoteEntry } from "../meetings";
import type { UnifiedCalendarEvent } from "./types";

const PRIORITY_KEY: Record<TaskPriority, string> = {
  highest: "priority-highest",
  high: "priority-high",
  medium: "priority-medium",
  low: "priority-low",
  none: "priority-none",
};

export function toUnifiedTaskEvents(
  entries: TaskEntry[],
): Array<UnifiedCalendarEvent<TaskEntry>> {
  const out: Array<UnifiedCalendarEvent<TaskEntry>> = [];
  for (const entry of entries) {
    if (!entry.due && !entry.calendarStart) continue;
    const category = PRIORITY_KEY[entry.priority];
    if (entry.calendarStart) {
      const start = new Date(entry.calendarStart);
      if (Number.isNaN(start.getTime())) continue;
      const end = entry.calendarEnd ? new Date(entry.calendarEnd) : addHours(start, 1);
      const safeEnd =
        Number.isNaN(end.getTime()) || end <= start ? addHours(start, 1) : end;
      out.push({
        id: entry.relPath,
        title: entry.title,
        fileName: entry.fileName,
        start,
        end: safeEnd,
        allDay: false,
        category,
        source: "task",
        resource: entry,
      });
      continue;
    }
    const due = entry.due ?? "1970-01-01";
    const start = new Date(`${due}T00:00:00`);
    if (Number.isNaN(start.getTime())) continue;
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    out.push({
      id: entry.relPath,
      title: entry.title,
      fileName: entry.fileName,
      start,
      end,
      allDay: true,
      category,
      source: "task",
      resource: entry,
    });
  }
  return out;
}

export function toUnifiedMeetingEvents(
  entries: MeetingNoteEntry[],
): Array<UnifiedCalendarEvent<MeetingNoteEntry>> {
  return entries.map((entry) => {
    const start = new Date(`${entry.date}T00:00:00`);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return {
      id: entry.relPath,
      title: entry.title,
      fileName: entry.fileName,
      start,
      end,
      allDay: true,
      category: `meeting-type-${hashMeetingType(entry.type)}`,
      source: "meeting" as const,
      resource: entry,
    };
  });
}

export function hashMeetingType(type: string): number {
  let hash = 0;
  for (const char of type) hash = (hash + char.charCodeAt(0)) % 5;
  return hash + 1;
}

function addHours(date: Date, hours: number): Date {
  const next = new Date(date);
  next.setHours(next.getHours() + hours);
  return next;
}
