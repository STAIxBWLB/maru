import { describe, expect, it } from "vitest";
import type { MeetingNoteRow, MissionRecord } from "./types";
import {
  activeMeetingsMissions,
  filterMeetingsByQuery,
  groupMeetingsByMonth,
  meetingsToCalendarEvents,
  parseMeetingFilename,
  rowsToMeetingEntries,
} from "./meetings";

const rows: MeetingNoteRow[] = [
  {
    path: "/work/meetings/2026/2026-04/04-20 회의 - Anchor 사업 주간 점검 - KPI.md",
    relPath: "meetings/2026/2026-04/04-20 회의 - Anchor 사업 주간 점검 - KPI.md",
    fileName: "04-20 회의 - Anchor 사업 주간 점검 - KPI.md",
    sizeBytes: 100,
    updatedAt: "2026-04-20T10:00:00+09:00",
    frontmatter: {},
  },
  {
    path: "/work/meetings/2026/2026-05/05-04 상담 - Skills 관리 - Codex.md",
    relPath: "meetings/2026/2026-05/05-04 상담 - Skills 관리 - Codex.md",
    fileName: "05-04 상담 - Skills 관리 - Codex.md",
    sizeBytes: 80,
    updatedAt: "2026-05-04T10:00:00+09:00",
    frontmatter: {},
  },
  {
    path: "/work/meetings/2026/2026-05/not-a-meeting.md",
    relPath: "meetings/2026/2026-05/not-a-meeting.md",
    fileName: "not-a-meeting.md",
    sizeBytes: 10,
    updatedAt: null,
    frontmatter: {},
  },
];

describe("parseMeetingFilename", () => {
  it("parses year, month, day, type, topic, and detail from the target convention", () => {
    const entry = parseMeetingFilename(rows[0].relPath, rows[0]);

    expect(entry).toMatchObject({
      absPath: rows[0].path,
      date: "2026-04-20",
      year: 2026,
      month: 4,
      day: 20,
      type: "회의",
      topic: "Anchor 사업 주간 점검",
      detail: "KPI",
      size: 100,
    });
  });

  it("derives title from type · topic when frontmatter has none", () => {
    const entry = parseMeetingFilename(rows[0].relPath, rows[0]);
    expect(entry?.title).toBe("회의 · Anchor 사업 주간 점검");
  });

  it("prefers frontmatter title (then name) over type · topic", () => {
    const withTitle = parseMeetingFilename(rows[0].relPath, {
      ...rows[0],
      frontmatter: { title: "Anchor 주간 KPI 회의" },
    });
    expect(withTitle?.title).toBe("Anchor 주간 KPI 회의");

    const withName = parseMeetingFilename(rows[0].relPath, {
      ...rows[0],
      frontmatter: { name: "KPI 점검" },
    });
    expect(withName?.title).toBe("KPI 점검");
  });

  it("excludes invalid names and mismatched folder months", () => {
    expect(parseMeetingFilename("meetings/2026/2026-05/not-a-meeting.md")).toBeNull();
    expect(parseMeetingFilename("meetings/2026/2026-05/05-20 회의 - Anchor - KPI.md")).toBeNull();
    expect(
      parseMeetingFilename("meetings/2026/2026-05/04-20 회의 - Anchor - KPI.md"),
    ).toBeNull();
    expect(
      parseMeetingFilename("meetings/2026/2026-05/05-99 회의 - Anchor - KPI.md"),
    ).toBeNull();
  });

  it("parses the new YYMMDD-meeting-<slug> convention from frontmatter", () => {
    const relPath = "meetings/2026/2026-06/260601-meeting-academic-council-esg.md";
    const entry = parseMeetingFilename(relPath, {
      path: `/work/${relPath}`,
      relPath,
      fileName: "260601-meeting-academic-council-esg.md",
      sizeBytes: 120,
      updatedAt: "2026-06-01T10:00:00+09:00",
      frontmatter: {
        title: "교무위원회 - 글로벌 ESG 학위 심의",
        type: "회의",
        topic: "교무위원회",
        date: "2026-06-01",
      },
    });

    expect(entry).toMatchObject({
      date: "2026-06-01",
      year: 2026,
      month: 6,
      day: 1,
      type: "회의",
      // List rows render `topic` as the bold label — it carries the human title.
      topic: "교무위원회 - 글로벌 ESG 학위 심의",
      title: "교무위원회 - 글로벌 ESG 학위 심의",
      detail: "",
    });
  });

  it("derives a humanized-slug label and reads variant date keys when frontmatter is sparse", () => {
    const relPath = "meetings/2026/2026-05/260504-meeting-jeju-space-mobility-schedule.md";
    const entry = parseMeetingFilename(relPath, {
      path: `/work/${relPath}`,
      relPath,
      fileName: "260504-meeting-jeju-space-mobility-schedule.md",
      sizeBytes: 80,
      updatedAt: null,
      // Legacy variant schema: no `title`, uses `meeting_date` instead of `date`.
      frontmatter: { meeting_date: "2026-05-04", venue: "전화통화" },
    });

    expect(entry).toMatchObject({
      date: "2026-05-04",
      type: "",
      topic: "jeju space mobility schedule",
      title: "jeju space mobility schedule",
    });
  });

  it("falls back to the YYMMDD prefix when no frontmatter date is present", () => {
    const relPath = "meetings/2026/2026-04/260420-meeting-anchor-weekly.md";
    const entry = parseMeetingFilename(relPath, {
      path: `/work/${relPath}`,
      relPath,
      fileName: "260420-meeting-anchor-weekly.md",
      sizeBytes: 50,
      updatedAt: null,
      frontmatter: {},
    });

    expect(entry?.date).toBe("2026-04-20");
    expect(entry?.topic).toBe("anchor weekly");
  });
});

describe("meeting entry helpers", () => {
  it("filters rows to valid meeting entries and sorts newest first", () => {
    const entries = rowsToMeetingEntries(rows);

    expect(entries.map((entry) => entry.date)).toEqual(["2026-05-04", "2026-04-20"]);
  });

  it("surfaces new-format files alongside legacy ones, newest first", () => {
    const mixed: MeetingNoteRow[] = [
      ...rows,
      {
        path: "/work/meetings/2026/2026-06/260601-meeting-academic-council-esg.md",
        relPath: "meetings/2026/2026-06/260601-meeting-academic-council-esg.md",
        fileName: "260601-meeting-academic-council-esg.md",
        sizeBytes: 120,
        updatedAt: "2026-06-01T10:00:00+09:00",
        frontmatter: { title: "교무위원회 ESG", type: "회의" },
      },
    ];
    const entries = rowsToMeetingEntries(mixed);

    expect(entries.map((entry) => entry.date)).toEqual([
      "2026-06-01",
      "2026-05-04",
      "2026-04-20",
    ]);
    expect(entries[0]).toMatchObject({ type: "회의", topic: "교무위원회 ESG" });
  });

  it("groups meetings by month with entries sorted in each group", () => {
    const grouped = groupMeetingsByMonth(rowsToMeetingEntries(rows));

    expect([...grouped.keys()]).toEqual(["2026-05", "2026-04"]);
    expect(grouped.get("2026-05")?.[0].topic).toBe("Skills 관리");
  });

  it("filters by query and type", () => {
    const entries = rowsToMeetingEntries(rows);

    expect(filterMeetingsByQuery(entries, "codex").map((entry) => entry.type)).toEqual(["상담"]);
    expect(filterMeetingsByQuery(entries, "", ["회의"]).map((entry) => entry.topic)).toEqual([
      "Anchor 사업 주간 점검",
    ]);
  });

  it("converts meetings to all-day calendar events", () => {
    const events = meetingsToCalendarEvents(rowsToMeetingEntries(rows));

    expect(events[0]).toMatchObject({
      id: rows[1].relPath,
      title: "상담 · Skills 관리",
      allDay: true,
    });
    expect(events[0].start.getFullYear()).toBe(2026);
    expect(events[0].start.getMonth()).toBe(4);
    expect(events[0].start.getDate()).toBe(4);
  });
});

describe("activeMeetingsMissions", () => {
  it("keeps only meeting-note background missions", () => {
    const missions: MissionRecord[] = [
      mission("a", "meetingNotesFromTranscript"),
      mission("b", "inboxProcess"),
      mission("c", "meetingNotesExternalRefine"),
      mission("d", "meetingNotesVaultExtract"),
      {
        ...mission("e", "other"),
        metadata: { reviewFlow: true, skillName: "task-management" },
      },
      {
        ...mission("f", "other"),
        metadata: { origin: "inboxProcess", reviewFlow: true },
      },
    ];

    // "f" is an inbox-process review-flow run — it must not leak into meetings.
    expect(activeMeetingsMissions(missions).map((item) => item.id)).toEqual(["e", "d", "c", "a"]);
  });
});

function mission(id: string, origin: string): MissionRecord {
  const minute = id === "e" ? 4 : id === "d" ? 3 : id === "c" ? 2 : 1;
  return {
    id,
    kind: "skill",
    startedAt: `2026-05-04T10:0${minute}:00+09:00`,
    lastOutputAt: `2026-05-04T10:0${minute}:00+09:00`,
    status: "running",
    exitCode: null,
    outputLogPath: null,
    metadata: { origin },
  };
}
