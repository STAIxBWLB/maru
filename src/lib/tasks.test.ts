import { describe, expect, it } from "vitest";
import type { MissionRecord, TaskNoteRow } from "./types";
import {
  activeTasksMissions,
  buildTaskManagementSchedulePrompt,
  buildTaskManagementSyncPrompt,
  filterTasksByQuery,
  isOverdue,
  normalizeTaskPriority,
  normalizeTaskStatus,
  rowsToTaskEntries,
  selectVisibleTask,
  taskFilterCounts,
  tasksToCalendarEvents,
} from "./tasks";

const rows: TaskNoteRow[] = [
  {
    path: "/work/tasks/active/260514-maru-tasks.md",
    relPath: "tasks/active/260514-maru-tasks.md",
    fileName: "260514-maru-tasks.md",
    bucket: "active",
    sizeBytes: 100,
    updatedAt: "2026-05-14T10:00:00+09:00",
    frontmatter: {
      title: "Maru tasks mode",
      status: "in_progress",
      priority: "P1",
      due: "2026-05-14",
      project: "Maru",
      topics: ["tasks"],
    },
  },
  {
    path: "/work/tasks/backlog/sync.md",
    relPath: "tasks/backlog/sync.md",
    fileName: "sync.md",
    bucket: "backlog",
    sizeBytes: 20,
    updatedAt: null,
    frontmatter: {
      title: "Sync tasks",
      priority: "normal",
      project: "Ops",
    },
  },
  {
    path: "/work/tasks/archive/done.md",
    relPath: "tasks/archive/done.md",
    fileName: "done.md",
    bucket: "archive",
    sizeBytes: 20,
    updatedAt: null,
    frontmatter: {
      title: "Done task",
      due: "2026-05-01",
    },
  },
];

describe("task entry helpers", () => {
  it("normalizes status, priority, and frontmatter-derived fields", () => {
    const entries = rowsToTaskEntries(rows);
    const first = entries.find((entry) => entry.relPath.includes("260514"))!;
    const backlog = entries.find((entry) => entry.bucket === "backlog")!;
    const archive = entries.find((entry) => entry.bucket === "archive")!;

    expect(first.status).toBe("in-progress");
    expect(first.priority).toBe("high");
    expect(first.due).toBe("2026-05-14");
    expect(first.project).toBe("Maru");
    expect(first.topics).toEqual(["tasks"]);
    expect(backlog.status).toBe("backlog");
    expect(backlog.priority).toBe("medium");
    expect(archive.status).toBe("done");
  });

  it("filters by query, status, project, priority, and due scope", () => {
    const entries = rowsToTaskEntries(rows);

    expect(filterTasksByQuery(entries, "maru").map((entry) => entry.title)).toEqual([
      "Maru tasks mode",
    ]);
    expect(
      filterTasksByQuery(entries, "", {
        statuses: ["backlog"],
        projects: ["Ops"],
        priorities: ["medium"],
      }).map((entry) => entry.title),
    ).toEqual(["Sync tasks"]);
    expect(
      filterTasksByQuery(entries, "", { due: "overdue", today: "2026-05-14" }).map(
        (entry) => entry.title,
      ),
    ).toEqual([]);
    expect(
      filterTasksByQuery(entries, "", { due: "today", today: "2026-05-14" }).map((entry) => entry.title),
    ).toEqual(["Maru tasks mode"]);
  });

  it("detects overdue tasks with done and cancelled excluded", () => {
    const active = rowsToTaskEntries(rows).find((entry) => entry.title === "Maru tasks mode")!;
    const done = rowsToTaskEntries(rows).find((entry) => entry.title === "Done task")!;

    expect(isOverdue({ ...active, due: "2026-05-13" }, "2026-05-14")).toBe(true);
    expect(isOverdue({ ...active, due: "2026-05-14" }, "2026-05-14")).toBe(false);
    expect(isOverdue(done, "2026-05-14")).toBe(false);
  });

  it("converts due and timed tasks to calendar events", () => {
    const timed: TaskNoteRow = {
      path: "/work/tasks/calendar/call.md",
      relPath: "tasks/calendar/call.md",
      fileName: "call.md",
      bucket: "calendar",
      sizeBytes: 10,
      updatedAt: null,
      frontmatter: {
        title: "Timed call",
        calendarStart: "2026-05-14T09:00:00+09:00",
        calendarEnd: "2026-05-14T10:00:00+09:00",
      },
    };
    const events = tasksToCalendarEvents(rowsToTaskEntries([rows[0], rows[1], timed]));

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({ title: "Maru tasks mode", allDay: true });
    expect(events[0].start.getFullYear()).toBe(2026);
    expect(events[0].start.getMonth()).toBe(4);
    expect(events[0].start.getDate()).toBe(14);
    expect(events[1]).toMatchObject({ title: "Timed call", allDay: false });
    expect(events[1].end.getTime()).toBeGreaterThan(events[1].start.getTime());
  });

  it("counts schedule filters with done and backlog excluded from active counts", () => {
    const timed: TaskNoteRow = {
      path: "/work/tasks/active/timed.md",
      relPath: "tasks/active/timed.md",
      fileName: "timed.md",
      bucket: "active",
      sizeBytes: 10,
      updatedAt: null,
      frontmatter: {
        title: "Timed task",
        status: "active",
        calendarStart: "2026-05-14T14:00:00+09:00",
      },
    };
    const unscheduled: TaskNoteRow = {
      path: "/work/tasks/active/unscheduled.md",
      relPath: "tasks/active/unscheduled.md",
      fileName: "unscheduled.md",
      bucket: "active",
      sizeBytes: 10,
      updatedAt: null,
      frontmatter: {
        title: "Unscheduled task",
        status: "active",
      },
    };

    const counts = taskFilterCounts(rowsToTaskEntries([...rows, timed, unscheduled]), "2026-05-14");

    expect(counts).toEqual({
      scheduled: 2,
      today: 2,
      overdue: 0,
      unscheduled: 1,
      backlog: 1,
      done: 1,
    });
  });

  it("falls back to a visible task when selected path is filtered out", () => {
    const visible = rowsToTaskEntries(rows).filter((entry) => entry.bucket === "active");

    expect(selectVisibleTask(visible, "tasks/archive/done.md")?.relPath).toBe(
      "tasks/active/260514-maru-tasks.md",
    );
    expect(selectVisibleTask([], "tasks/archive/done.md")).toBeNull();
  });
});

describe("task normalizers", () => {
  it("normalizes unknown status from bucket and priority aliases", () => {
    expect(normalizeTaskStatus("weird", "active")).toBe("active");
    expect(normalizeTaskStatus(undefined, "backlog")).toBe("backlog");
    expect(normalizeTaskStatus(undefined, "archive")).toBe("done");
    expect(normalizeTaskPriority("urgent")).toBe("highest");
    expect(normalizeTaskPriority("low")).toBe("low");
    expect(normalizeTaskPriority("unknown")).toBe("none");
  });

  it("maps the legacy 'open' status alias to active", () => {
    expect(normalizeTaskStatus("open", "active")).toBe("active");
    expect(normalizeTaskStatus("Open", "backlog")).toBe("active");
  });
});

describe("today task fields", () => {
  const todayRow = (frontmatter: Record<string, unknown>): TaskNoteRow => ({
    path: "/work/tasks/active/today.md",
    relPath: "tasks/active/today.md",
    fileName: "today.md",
    bucket: "active",
    sizeBytes: 10,
    updatedAt: null,
    frontmatter,
  });

  it("populates today-integration fields from frontmatter", () => {
    const [entry] = rowsToTaskEntries([
      todayRow({
        title: "Integrated task",
        taskId: "task-123",
        done: "2026-07-20",
        completedAt: "2026-07-20T18:00:00+09:00",
        estimateMinutes: 45,
        progress: 50,
        deferDate: "2026-07-25",
        googleTaskId: "gt-1",
        googleTaskListId: "list-1",
        calendarEventId: "evt-1",
        syncStatus: "retryNeeded",
      }),
    ]);
    expect(entry.taskId).toBe("task-123");
    expect(entry.done).toBe("2026-07-20");
    expect(entry.completedAt).toBe("2026-07-20T18:00:00+09:00");
    expect(entry.estimateMinutes).toBe(45);
    expect(entry.progress).toBe(50);
    expect(entry.deferDate).toBe("2026-07-25");
    expect(entry.googleTaskId).toBe("gt-1");
    expect(entry.googleTaskListId).toBe("list-1");
    expect(entry.calendarEventId).toBe("evt-1");
    expect(entry.syncStatus).toBe("retryNeeded");
  });

  it("omits today fields when absent or malformed and invents no dates", () => {
    const [entry] = rowsToTaskEntries([
      todayRow({
        title: "Plain task",
        estimateMinutes: -3,
        progress: 140,
        syncStatus: "bogus",
        done: "not-a-date",
        completed: true,
      }),
    ]);
    expect(entry.taskId).toBeUndefined();
    expect(entry.done).toBeUndefined();
    expect(entry.completedAt).toBeUndefined();
    expect(entry.estimateMinutes).toBeUndefined();
    expect(entry.progress).toBeUndefined();
    expect(entry.deferDate).toBeUndefined();
    expect(entry.syncStatus).toBeUndefined();
  });

  it("derives project from the legacy projects list alias when project is missing", () => {
    const [entry] = rowsToTaskEntries([
      todayRow({ title: "Aliased", projects: ["alpha", "beta"] }),
    ]);
    expect(entry.project).toBe("alpha");
    expect(entry.projects).toEqual(["alpha", "beta"]);
    expect(entry.projectKeys).toEqual(["raw:alpha", "raw:beta"]);

    const [canonical] = rowsToTaskEntries([
      todayRow({ title: "Canonical", project: "gamma", projects: ["alpha"] }),
    ]);
    expect(canonical.project).toBe("gamma");
    expect(canonical.projects).toEqual(["gamma"]);
  });

  it("accepts scalar projects and uses the scanner-provided H1 title", () => {
    const [entry] = rowsToTaskEntries([
      {
        ...todayRow({ projects: "admin-ai-innovation" }),
        displayTitle: "AI혁신처 운영 정리",
      },
    ]);
    expect(entry.title).toBe("AI혁신처 운영 정리");
    expect(entry.projects).toEqual(["admin-ai-innovation"]);
    expect(entry.projectLabels).toEqual(["Admin AI innovation"]);
  });
});

describe("activeTasksMissions", () => {
  it("keeps task-management background and compose missions", () => {
    const missions: MissionRecord[] = [
      mission("a", "taskManagementSync"),
      mission("b", "meetingNotesVaultExtract"),
      mission("c", "taskManagementVaultExtract"),
      mission("d", "skillCompose", { skillName: "task-management" }),
      mission("e", "skillCompose", { skillName: "vault-extract" }),
    ];

    expect(activeTasksMissions(missions).map((item) => item.id)).toEqual(["d", "c", "a"]);
  });
});

describe("buildTaskManagementSchedulePrompt", () => {
  it("builds a task-management prompt for unstructured schedule text", () => {
    const prompt = buildTaskManagementSchedulePrompt("내일 오후 3시 대구 회의 준비", {
      root: "tasks",
      timezone: "Asia/Seoul",
      defaultTaskList: "reclaim",
      defaultCalendar: "chu_aio",
    });

    expect(prompt).toContain("내일 오후 3시 대구 회의 준비");
    expect(prompt).toContain("workspace.config.yaml");
    expect(prompt).toContain("source of truth under tasks");
    expect(prompt).toContain("calendarStart");
    expect(prompt).toContain("Asia/Seoul");
    expect(prompt).toContain("approved execution path");
    expect(prompt).toContain("read-only availability/conflict lookup");
    expect(prompt).toContain("Maru itself must not call Google APIs");
    expect(prompt).toContain("Do not write files or mutate Google Tasks/Calendar");
    expect(prompt).toContain("Read-only Google Tasks/Calendar lookup is allowed");
    expect(prompt).toContain("All Google create/update/delete operations happen only after user approval");
    expect(prompt).toContain("Do not write directly to any vault");
  });
});

describe("buildTaskManagementSyncPrompt", () => {
  it("allows read-only Google reconciliation but keeps mutations approval-only", () => {
    const prompt = buildTaskManagementSyncPrompt("tasks/active/a.md", {
      root: "tasks",
      timezone: "Asia/Seoul",
      defaultTaskList: "reclaim",
      defaultCalendar: "chu_aio",
    });

    expect(prompt).toContain("read-only lookup during review");
    expect(prompt).toContain("Maru itself must not call Google APIs");
    expect(prompt).toContain("mutations will run only after approval");
    expect(prompt).toContain("Do not write files or mutate Google Tasks/Calendar");
    expect(prompt).toContain("Read-only Google Tasks/Calendar lookup is allowed");
  });
});

function mission(
  id: string,
  origin: string,
  metadata: Record<string, unknown> = {},
): MissionRecord {
  const minute = id === "d" ? 4 : id === "c" ? 3 : id === "b" ? 2 : 1;
  return {
    id,
    kind: "skill",
    startedAt: `2026-05-14T10:0${minute}:00+09:00`,
    lastOutputAt: `2026-05-14T10:0${minute}:00+09:00`,
    status: "running",
    exitCode: null,
    outputLogPath: null,
    metadata: { origin, ...metadata },
  };
}
