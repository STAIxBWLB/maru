import type { MeetingNoteRow, MissionRecord } from "./types";

export interface MeetingNoteEntry {
  absPath: string;
  relPath: string;
  fileName: string;
  /** Display title: frontmatter `title`/`name`, else `type · topic`. */
  title: string;
  date: string;
  year: number;
  month: number;
  day: number;
  type: string;
  topic: string;
  detail: string;
  size: number;
  modifiedAt: string | null;
}

export interface MeetingCalendarEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  resource: MeetingNoteEntry;
}

export type MeetingsMissionOrigin =
  | "meetingNotesFromTranscript"
  | "meetingNotesExternalRefine"
  | "meetingNotesVaultExtract"
  | "meetingNotesVaultConnect"
  | "meetingNotesTaskManagement";

export function parseMeetingFilename(
  relPath: string,
  row?: Partial<MeetingNoteRow>,
): MeetingNoteEntry | null {
  const normalized = relPath.replace(/\\/g, "/").replace(/^\/+/, "");
  const absPath = row?.path?.trim();
  if (!absPath) return null;
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments.at(-1);
  if (!fileName || !/\.md$/i.test(fileName)) return null;

  const stem = fileName.replace(/\.md$/i, "");
  const yearIndex = segments.findIndex((segment) => /^20\d{2}$/.test(segment));
  if (yearIndex < 0 || yearIndex + 1 >= segments.length) return null;
  const year = Number(segments[yearIndex]);
  const monthSegment = segments[yearIndex + 1];
  const monthMatch = monthSegment.match(/^20\d{2}-(0[1-9]|1[0-2])$/);
  if (!monthMatch) return null;
  const month = Number(monthMatch[1]);

  const nameMatch = stem.match(/^(\d{1,2})-(\d{1,2})\s+(.+)$/);
  if (!nameMatch) return null;
  const fileMonth = Number(nameMatch[1]);
  const day = Number(nameMatch[2]);
  if (fileMonth !== month || !isValidDateParts(year, month, day)) return null;

  const payload = nameMatch[3].trim();
  const parts = payload.split(/\s+-\s+/).map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const [type, topic, ...rest] = parts;
  if (!type || !topic) return null;
  const date = `${year}-${pad2(month)}-${pad2(day)}`;
  const fm = row?.frontmatter ?? {};
  const title =
    scalarString(fm.title) ?? scalarString(fm.name) ?? `${type} · ${topic}`;
  return {
    absPath,
    relPath: row?.relPath ?? normalized,
    fileName,
    title,
    date,
    year,
    month,
    day,
    type,
    topic,
    detail: rest.join(" - "),
    size: row?.sizeBytes ?? 0,
    modifiedAt: row?.updatedAt ?? null,
  };
}

export function rowsToMeetingEntries(rows: MeetingNoteRow[]): MeetingNoteEntry[] {
  return rows
    .map((row) => parseMeetingFilename(row.relPath, row))
    .filter((entry): entry is MeetingNoteEntry => entry !== null)
    .sort(compareMeetingEntries);
}

export function groupMeetingsByMonth(entries: MeetingNoteEntry[]): Map<string, MeetingNoteEntry[]> {
  const grouped = new Map<string, MeetingNoteEntry[]>();
  for (const entry of entries) {
    const key = `${entry.year}-${pad2(entry.month)}`;
    const group = grouped.get(key) ?? [];
    group.push(entry);
    grouped.set(key, group);
  }
  return new Map(
    Array.from(grouped.entries())
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([key, values]) => [key, values.sort(compareMeetingEntries)]),
  );
}

export function filterMeetingsByQuery(
  entries: MeetingNoteEntry[],
  query: string,
  types: readonly string[] = [],
): MeetingNoteEntry[] {
  const q = query.trim().toLowerCase();
  const typeSet = new Set(types.map((type) => type.trim()).filter(Boolean));
  return entries.filter((entry) => {
    if (typeSet.size > 0 && !typeSet.has(entry.type)) return false;
    if (!q) return true;
    return [
      entry.type,
      entry.topic,
      entry.detail,
      entry.fileName,
      entry.relPath,
      entry.date,
    ]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });
}

export function meetingsToCalendarEvents(
  entries: MeetingNoteEntry[],
): MeetingCalendarEvent[] {
  return entries.map((entry) => {
    const start = new Date(`${entry.date}T00:00:00`);
    const end = new Date(start);
    end.setDate(start.getDate() + 1);
    return {
      id: entry.relPath,
      title: entry.title,
      start,
      end,
      allDay: true,
      resource: entry,
    };
  });
}

export function activeMeetingsMissions(missions: MissionRecord[]): MissionRecord[] {
  return missions.filter((mission) => isMeetingsMission(mission)).sort(compareMissions);
}

export function isMeetingsMission(mission: MissionRecord): boolean {
  const metadata = mission.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const origin = (metadata as Record<string, unknown>).origin;
  if (typeof origin === "string") {
    if (origin.startsWith("meetingNotes")) return true;
    // Inbox-process review-flow runs set reviewFlow:true but are owned by the
    // inbox pane; keep them out of the meetings run list.
    if (origin === "inboxProcess") return false;
  }
  return (metadata as Record<string, unknown>).reviewFlow === true;
}

function compareMeetingEntries(a: MeetingNoteEntry, b: MeetingNoteEntry): number {
  return (
    b.date.localeCompare(a.date) ||
    a.type.localeCompare(b.type) ||
    a.topic.localeCompare(b.topic) ||
    a.relPath.localeCompare(b.relPath)
  );
}

function compareMissions(a: MissionRecord, b: MissionRecord): number {
  return b.lastOutputAt.localeCompare(a.lastOutputAt) || b.startedAt.localeCompare(a.startedAt);
}

function isValidDateParts(year: number, month: number, day: number): boolean {
  const date = new Date(year, month - 1, day);
  return (
    date.getFullYear() === year &&
    date.getMonth() === month - 1 &&
    date.getDate() === day
  );
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function scalarString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return null;
}
