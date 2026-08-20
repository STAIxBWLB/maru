import { describe, expect, it } from "vitest";

import type { AgentBoard } from "./agents";
import type { CatalogScanReport } from "./catalog";
import {
  agentBoardSummary,
  agentStatusTiers,
  catalogKindChips,
  dashboardLogicalDay,
  draftStatusCounts,
  filterTasksForDashboard,
  gitSummary,
  inboxIntakeCounts,
  inboxSummary,
  planLaneCounts,
  planTopTitles,
  projectCategory,
  projectPortfolio,
  todayPressure,
  topRecentEntries,
} from "./dashboard";
import type { DailyPlanV1, TodaySnapshot } from "./today";
import { resolveTaskEntryProjects, type TaskEntry } from "./tasks";
import type {
  DraftEntry,
  InboxDropItem,
  InboxEntry,
  ProjectActivityRow,
  ProjectPickerEntry,
  VaultEntry,
} from "./types";

const TODAY = "2026-08-16";

function taskEntry(partial: Partial<TaskEntry>): TaskEntry {
  return {
    absPath: "/work/task.md",
    relPath: "tasks/task.md",
    fileName: "task.md",
    bucket: "active",
    title: "Task",
    status: "active",
    priority: "medium",
    project: null,
    projects: [],
    projectKeys: [],
    projectLabels: [],
    topics: [],
    due: null,
    calendarStart: null,
    calendarEnd: null,
    size: 0,
    modifiedAt: null,
    frontmatter: {},
    ...partial,
  };
}

describe("filterTasksForDashboard", () => {
  const entries = [
    taskEntry({ relPath: "a.md", title: "Due today", due: TODAY }),
    taskEntry({ relPath: "b.md", title: "Overdue", due: "2026-08-10" }),
    taskEntry({ relPath: "c.md", title: "Scheduled", due: "2026-08-20" }),
    taskEntry({ relPath: "d.md", title: "Backlog", bucket: "backlog", status: "backlog" }),
    taskEntry({ relPath: "e.md", title: "Done", bucket: "archive", status: "done" }),
    taskEntry({ relPath: "f.md", title: "Unscheduled" }),
  ];

  it("filters per chip using the shared task query pipeline", () => {
    expect(filterTasksForDashboard(entries, "today", TODAY).map((e) => e.title)).toEqual(["Due today"]);
    expect(filterTasksForDashboard(entries, "overdue", TODAY).map((e) => e.title)).toEqual(["Overdue"]);
    expect(filterTasksForDashboard(entries, "scheduled", TODAY).map((e) => e.title)).toEqual([
      "Due today",
      "Overdue",
      "Scheduled",
    ]);
    expect(filterTasksForDashboard(entries, "backlog", TODAY).map((e) => e.title)).toEqual(["Backlog"]);
    expect(filterTasksForDashboard(entries, "done", TODAY).map((e) => e.title)).toEqual(["Done"]);
  });
});

describe("planLaneCounts / planTopTitles", () => {
  const plan: DailyPlanV1 = {
    logicalDay: TODAY,
    inputRevision: "rev",
    top: [
      {
        itemRef: { kind: "task", taskId: "t-1" },
        lane: "top",
        order: 1,
        estimateProvisional: false,
        pinned: false,
        calendarSync: { status: "none" },
      },
      {
        itemRef: { kind: "task", taskId: "t-2" },
        lane: "top",
        order: 0,
        outcome: "Draft the report",
        estimateProvisional: false,
        pinned: false,
        calendarSync: { status: "none" },
      },
      {
        itemRef: { kind: "capture", captureId: "c-1" },
        lane: "top",
        order: 2,
        estimateProvisional: false,
        pinned: false,
        calendarSync: { status: "none" },
      },
    ],
    flexible: [
      {
        itemRef: { kind: "task", taskId: "t-3" },
        lane: "flexible",
        order: 0,
        estimateProvisional: false,
        pinned: false,
        calendarSync: { status: "none" },
      },
    ],
    overflow: [],
    reasons: [],
    warnings: [],
  };

  it("counts plan lanes with a null-safe default", () => {
    expect(planLaneCounts(plan)).toEqual({ top: 3, flexible: 1, overflow: 0 });
    expect(planLaneCounts(null)).toEqual({ top: 0, flexible: 0, overflow: 0 });
  });

  it("resolves top titles by taskId, falling back to outcome then ref id", () => {
    const entries = [taskEntry({ relPath: "tasks/one.md", title: "Write proposal", taskId: "t-1" })];
    expect(planTopTitles(plan, entries)).toEqual([
      "Draft the report",
      "Write proposal",
      "c-1",
    ]);
    expect(planTopTitles(plan, entries, 2)).toHaveLength(2);
    expect(planTopTitles(null, entries)).toEqual([]);
  });
});

describe("dashboardLogicalDay", () => {
  it("rolls back before the day-start boundary", () => {
    expect(dashboardLogicalDay(new Date(2026, 7, 16, 10, 30), "04:00")).toBe("2026-08-16");
    expect(dashboardLogicalDay(new Date(2026, 7, 16, 2, 30), "04:00")).toBe("2026-08-15");
    expect(dashboardLogicalDay(new Date(2026, 7, 16, 4, 0), "04:00")).toBe("2026-08-16");
  });
});

describe("catalogKindChips", () => {
  it("keeps a stable order and zero-fills missing kinds", () => {
    const report: CatalogScanReport = {
      scanned_at: "2026-08-16T00:00:00Z",
      entries_count: 5,
      by_kind: { "deadline-due": 2, "task-due": 3 },
      bus_seen: [],
      warnings: [],
      elapsed_ms: 1,
    };
    // `task-due` is present in the report and deliberately not surfaced: the
    // task chips beside these already count it, from the source that owns it.
    expect(catalogKindChips(report)).toEqual([
      { key: "deadline-due", count: 2 },
      { key: "approval-in-flight", count: 0 },
      { key: "evidence-unlinked", count: 0 },
    ]);
    expect(catalogKindChips(null).every((chip) => chip.count === 0)).toBe(true);
  });
});

describe("draftStatusCounts", () => {
  it("counts per status in the fixed order", () => {
    const drafts = [
      { status: "new" },
      { status: "new" },
      { status: "accepted" },
    ] as DraftEntry[];
    expect(draftStatusCounts(drafts)).toEqual([
      { key: "new", count: 2 },
      { key: "in-review", count: 0 },
      { key: "accepted", count: 1 },
      { key: "discarded", count: 0 },
    ]);
    expect(draftStatusCounts(null).every((chip) => chip.count === 0)).toBe(true);
  });
});

describe("inboxSummary", () => {
  const dropItems: InboxDropItem[] = [
    {
      id: "drop-1",
      path: "/work/inbox/drop/a.pdf",
      relPath: "inbox/drop/a.pdf",
      title: "a.pdf",
      source: "kakao",
      sizeBytes: 10,
      receivedAt: "2026-08-15T01:00:00Z",
    },
  ];
  const entries: InboxEntry[] = [
    {
      id: "entry-1",
      kind: "pendingItem",
      path: "/work/inbox/items/x",
      relPath: "inbox/items/x",
      title: "메일 첨부",
      channel: "gmail",
      sourceKind: null,
      dropPath: null,
      configuredRoot: "inbox",
      itemId: null,
      status: "pending",
      manifestPath: null,
      summaryPath: null,
      routePath: null,
      sizeBytes: 0,
      intakeMode: "manual",
      receivedAt: "2026-08-16T01:00:00Z",
    },
    {
      id: "entry-2",
      kind: "dropFile",
      path: "/work/inbox/items/y",
      relPath: "inbox/items/y",
      title: "처리 완료",
      channel: "kakao",
      sourceKind: null,
      dropPath: null,
      configuredRoot: "inbox",
      itemId: null,
      status: "done",
      manifestPath: null,
      summaryPath: null,
      routePath: null,
      sizeBytes: 0,
      intakeMode: "manual",
      receivedAt: "2026-08-14T01:00:00Z",
    },
  ];

  it("counts drop files and pending entries, newest first", () => {
    const summary = inboxSummary(dropItems, entries);
    expect(summary.pendingCount).toBe(2);
    expect(summary.latest.map((item) => item.id)).toEqual(["entry-1", "drop-1"]);
  });

  it("handles empty inputs", () => {
    expect(inboxSummary(null, null)).toEqual({ pendingCount: 0, latest: [] });
  });
});

describe("agentBoardSummary", () => {
  it("aggregates rows, schedules, and the earliest next run", () => {
    const board: AgentBoard = {
      rows: [
        {
          agent: { id: "a1" } as never,
          schedules: [
            { id: "s1", enabled: true, nextRunAt: "2026-08-17T09:00:00Z" } as never,
            { id: "s2", enabled: false, nextRunAt: null } as never,
          ],
          missions: [],
          status: "running",
          activeMissionId: "m1",
        },
        {
          agent: { id: "a2" } as never,
          schedules: [{ id: "s3", enabled: true, nextRunAt: "2026-08-16T09:00:00Z" } as never],
          missions: [],
          status: "idle",
          activeMissionId: null,
        },
      ],
      orphans: [{ id: "s4", enabled: true, nextRunAt: null } as never],
    };
    expect(agentBoardSummary(board)).toEqual({
      agents: 2,
      running: 1,
      scheduled: 3,
      nextRunAt: "2026-08-16T09:00:00Z",
    });
  });

  it("returns null next run when nothing is scheduled", () => {
    expect(agentBoardSummary({ rows: [], orphans: [] }).nextRunAt).toBeNull();
  });
});

describe("gitSummary", () => {
  it("sums working tree counts", () => {
    expect(
      gitSummary({
        isRepo: true,
        branch: "main",
        modified: 2,
        staged: 1,
        untracked: 3,
        untrackedKnown: true,
        clean: false,
      }),
    ).toEqual({
      isRepo: true,
      branch: "main",
      modified: 2,
      staged: 1,
      untracked: 3,
      clean: false,
      total: 6,
    });
  });

  it("treats a missing status as a clean non-repo", () => {
    expect(gitSummary(null)).toMatchObject({ isRepo: false, clean: true, total: 0 });
  });
});

describe("topRecentEntries", () => {
  it("slices the leading entries", () => {
    const entries = Array.from({ length: 8 }, (_, index) => ({
      path: `/work/${index}.md`,
      title: `Doc ${index}`,
    })) as VaultEntry[];
    expect(topRecentEntries(entries)).toHaveLength(5);
    expect(topRecentEntries(entries, 2).map((entry) => entry.title)).toEqual(["Doc 0", "Doc 1"]);
  });
});

// === Project portfolio ===

const PROJECTS: ProjectPickerEntry[] = [
  { id: "rise", name: "RISE", path: "projects/rise", status: "active" },
  {
    id: "rise-a2cl",
    name: "A2CL Growth Engine",
    path: "projects/rise/a2cl-growth-engine",
    status: "active",
  },
  { id: "oda-koica-tiu", name: "KOICA TIU", path: "projects/oda/koica-tiu", status: "active" },
  { id: "teaching", name: "Teaching", path: "teaching", status: "active" },
];

function activityRow(partial: Partial<ProjectActivityRow> & { id: string }): ProjectActivityRow {
  return { path: "", lastMeetingDay: null, lastActivityAt: null, ...partial };
}

/** The dashboard hands `projectPortfolio` the raw scanner rows, so that is
 *  what these tests pass too. `resolved` exists only to prove the pre-resolved
 *  shape (what the Tasks pane holds) lands on the same numbers. */
function resolved(entries: TaskEntry[]): TaskEntry[] {
  return resolveTaskEntryProjects(entries, PROJECTS);
}

const FRESH = "2026-08-15T09:00:00Z"; // day before TODAY
const OLD = "2026-06-01T09:00:00Z"; // well past the 14-day stale line

describe("projectCategory", () => {
  it("reads the category out of the path, which is where the registry keeps it", () => {
    expect(projectCategory("projects/oda/koica-tiu")).toBe("oda");
    expect(projectCategory("projects/rise/a2cl-growth-engine")).toBe("rise");
    expect(projectCategory("admin/depts/ai")).toBe("admin");
    expect(projectCategory("teaching")).toBe("teaching");
    expect(projectCategory("projects")).toBe("projects");
    expect(projectCategory("")).toBe("");
  });
});

describe("projectPortfolio", () => {
  it("counts open and overdue tasks per project via the shared resolver", () => {
    const entries = resolved([
      taskEntry({ relPath: "a.md", projects: ["oda-koica-tiu"], due: "2026-08-10" }),
      taskEntry({ relPath: "b.md", projects: ["oda-koica-tiu"], due: "2026-08-30" }),
      taskEntry({ relPath: "c.md", projects: ["[[teaching|수업]]"], due: "2026-08-01" }),
    ]);
    const portfolio = projectPortfolio(PROJECTS, [], entries, TODAY);
    const byId = new Map(portfolio.allRows.map((row) => [row.id, row]));

    expect(byId.get("oda-koica-tiu")).toMatchObject({ openTasks: 2, overdueTasks: 1 });
    // An aliased wikilink still resolves to the registry project behind it.
    expect(byId.get("teaching")).toMatchObject({ openTasks: 1, overdueTasks: 1 });
  });

  it("ignores tasks that are done, cancelled, or archived", () => {
    const entries = ([
      taskEntry({ relPath: "a.md", projects: ["teaching"], status: "done", bucket: "archive" }),
      taskEntry({ relPath: "b.md", projects: ["teaching"], status: "cancelled" }),
      taskEntry({ relPath: "c.md", projects: ["teaching"], bucket: "backlog" }),
      taskEntry({ relPath: "d.md", projects: ["teaching"], bucket: "calendar" }),
    ]);
    const portfolio = projectPortfolio(PROJECTS, [], entries, TODAY);
    const teaching = portfolio.allRows.find((row) => row.id === "teaching");
    expect(teaching?.openTasks).toBe(1);
  });

  it("falls back to contexts when projects is empty, but only for registry hits", () => {
    const entries = ([
      taskEntry({ relPath: "a.md", projects: [], frontmatter: { contexts: ["teaching"] } }),
      taskEntry({ relPath: "b.md", projects: [], frontmatter: { contexts: ["misc-freetext"] } }),
      taskEntry({ relPath: "c.md", projects: [] }),
    ]);
    const portfolio = projectPortfolio(PROJECTS, [], entries, TODAY);

    expect(portfolio.allRows.find((row) => row.id === "teaching")?.openTasks).toBe(1);
    // Free-text contexts must not invent a project; they stay in the honest total.
    expect(portfolio.unassignedOpenTasks).toBe(2);
  });

  it("folds sub-project work into the parent for the card but keeps both rows", () => {
    const entries = ([
      taskEntry({ relPath: "a.md", projects: ["rise-a2cl"], due: "2026-08-01" }),
      taskEntry({ relPath: "b.md", projects: ["rise"], due: "2026-08-30" }),
    ]);
    const activity = [
      activityRow({ id: "rise-a2cl", lastMeetingDay: "2026-08-14" }),
      activityRow({ id: "rise", lastMeetingDay: "2026-08-02" }),
    ];
    const portfolio = projectPortfolio(PROJECTS, activity, entries, TODAY);

    const foldedRise = portfolio.rows.find((row) => row.id === "rise");
    expect(foldedRise).toMatchObject({ openTasks: 2, overdueTasks: 1, lastMeetingDay: "2026-08-14" });
    // Sub-projects never appear as their own card rows.
    expect(portfolio.rows.map((row) => row.id)).not.toContain("rise-a2cl");
    // ...but the drilldown keeps them, unfolded.
    const child = portfolio.allRows.find((row) => row.id === "rise-a2cl");
    expect(child).toMatchObject({ openTasks: 1, parentId: "rise", category: "rise" });
    expect(portfolio.allRows.find((row) => row.id === "rise")?.openTasks).toBe(1);
  });

  it("marks a project stale once nothing has been touched for two weeks", () => {
    const activity = [
      activityRow({ id: "oda-koica-tiu", lastActivityAt: FRESH }),
      activityRow({ id: "teaching", lastActivityAt: OLD }),
    ];
    const portfolio = projectPortfolio(PROJECTS, activity, [], TODAY);
    const byId = new Map(portfolio.allRows.map((row) => [row.id, row]));

    expect(byId.get("oda-koica-tiu")?.stale).toBe(false);
    expect(byId.get("teaching")?.stale).toBe(true);
    // Never-touched counts as stale: there is nothing to show it is alive.
    expect(byId.get("rise")?.stale).toBe(true);
  });

  it("flags attention for overdue work, or open work on a project gone quiet", () => {
    const entries = ([
      taskEntry({ relPath: "a.md", projects: ["oda-koica-tiu"], due: "2026-08-01" }),
      taskEntry({ relPath: "b.md", projects: ["teaching"], due: "2026-08-30" }),
      taskEntry({ relPath: "c.md", projects: ["rise"], due: "2026-08-30" }),
    ]);
    const activity = [
      activityRow({ id: "oda-koica-tiu", lastActivityAt: FRESH }),
      activityRow({ id: "teaching", lastActivityAt: OLD }),
      activityRow({ id: "rise", lastActivityAt: FRESH }),
    ];
    const portfolio = projectPortfolio(PROJECTS, activity, entries, TODAY);
    const flagged = portfolio.attention.map((row) => row.id);

    expect(flagged).toContain("oda-koica-tiu"); // overdue
    expect(flagged).toContain("teaching"); // open + stale
    expect(flagged).not.toContain("rise"); // open but active
    expect(portfolio.attentionCount).toBe(flagged.length);
  });

  it("sorts by overdue, then open, then deadest first", () => {
    const entries = ([
      taskEntry({ relPath: "a.md", projects: ["teaching"], due: "2026-08-01" }),
      taskEntry({ relPath: "b.md", projects: ["oda-koica-tiu"], due: "2026-08-30" }),
      taskEntry({ relPath: "c.md", projects: ["oda-koica-tiu"], due: "2026-08-30" }),
      taskEntry({ relPath: "d.md", projects: ["rise"], due: "2026-08-30" }),
    ]);
    const activity = [
      activityRow({ id: "oda-koica-tiu", lastActivityAt: FRESH }),
      activityRow({ id: "rise", lastActivityAt: OLD }),
    ];
    const portfolio = projectPortfolio(PROJECTS, activity, entries, TODAY);

    expect(portfolio.rows.map((row) => row.id)).toEqual([
      "teaching", // 1 overdue
      "oda-koica-tiu", // 0 overdue, 2 open
      "rise", // 0 overdue, 1 open
    ]);
  });

  it("summarizes categories across every project, sub-projects included", () => {
    const portfolio = projectPortfolio(PROJECTS, [], [], TODAY);
    expect(portfolio.categories).toEqual([
      { key: "rise", count: 2 },
      { key: "oda", count: 1 },
      { key: "teaching", count: 1 },
    ]);
  });

  it("survives an empty registry and a missing activity report", () => {
    const portfolio = projectPortfolio(null, null, null, TODAY);
    expect(portfolio).toMatchObject({
      rows: [],
      allRows: [],
      attentionCount: 0,
      unassignedOpenTasks: 0,
      categories: [],
    });
  });
});

// === Today pressure ===

function snapshot(partial: Partial<TodaySnapshot>): TodaySnapshot {
  return {
    logicalDay: TODAY,
    generatedAt: `${TODAY}T03:30:00Z`,
    revision: "abc",
    dayState: "preparing",
    route: "full",
    timezone: "Asia/Seoul",
    dayStart: "03:30",
    sleepStart: "23:30",
    brainDump: "",
    yesterday: [],
    carryovers: [],
    sources: [],
    unconfirmedContent: false,
    ...partial,
  } as TodaySnapshot;
}

describe("todayPressure", () => {
  it("reduces the carryover pile to a count instead of a list", () => {
    const carryovers = Array.from({ length: 121 }, (_, index) => ({
      itemRef: { kind: "task" as const, taskId: `tasks/active/${index}.md` },
      carriedFrom: "2026-08-15",
    }));
    const pressure = todayPressure(snapshot({ carryovers } as Partial<TodaySnapshot>));
    expect(pressure.carryovers).toBe(121);
  });

  it("surfaces capacity, unconfirmed content, and stale sources", () => {
    const pressure = todayPressure(
      snapshot({
        unconfirmedContent: true,
        sources: [
          { source: "calendar", stale: true },
          { source: "tasks", stale: false },
          { source: "inbox", stale: true },
        ],
        capacity: {
          dayStart: "03:30",
          sleepStart: "23:30",
          freeMinutes: 240,
          busyMinutes: 180,
          focusCapMinutes: 240,
          proposedMinutes: 300,
          remainingMinutes: -60,
          overCapacity: true,
          provisional: false,
        },
      }),
    );
    expect(pressure).toMatchObject({
      freeMinutes: 240,
      busyMinutes: 180,
      overCapacity: true,
      unconfirmed: true,
      staleSources: 2,
    });
  });

  it("reports nothing rather than zero when there is no snapshot", () => {
    expect(todayPressure(null)).toMatchObject({
      carryovers: 0,
      freeMinutes: null,
      busyMinutes: null,
      overCapacity: false,
      staleSources: 0,
    });
  });
});

// === Inbox intake ===

describe("inboxIntakeCounts", () => {
  it("splits pending entries into automated and hand-staged", () => {
    const entries = [
      { intakeMode: "auto" },
      { intakeMode: "auto" },
      { intakeMode: "manual" },
    ] as InboxEntry[];
    expect(inboxIntakeCounts(entries)).toEqual({ auto: 2, manual: 1 });
  });

  it("returns zeros for an empty queue", () => {
    expect(inboxIntakeCounts([])).toEqual({ auto: 0, manual: 0 });
    expect(inboxIntakeCounts(null)).toEqual({ auto: 0, manual: 0 });
  });
});

// === Agent status tiers ===

describe("agentStatusTiers", () => {
  it("orders by attention and drops statuses with no agents", () => {
    const board = {
      rows: [
        { status: "idle" },
        { status: "failed" },
        { status: "running" },
        { status: "idle" },
      ],
      orphans: [],
    } as unknown as AgentBoard;
    expect(agentStatusTiers(board)).toEqual([
      { key: "running", count: 1 },
      { key: "failed", count: 1 },
      { key: "idle", count: 2 },
    ]);
  });

  it("returns nothing when there are no agents", () => {
    expect(agentStatusTiers(null)).toEqual([]);
  });
});
