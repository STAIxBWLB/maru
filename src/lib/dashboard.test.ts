import { describe, expect, it } from "vitest";

import type { AgentBoard } from "./agents";
import type { CatalogScanReport } from "./catalog";
import {
  agentBoardSummary,
  catalogKindChips,
  dashboardLogicalDay,
  draftStatusCounts,
  filterTasksForDashboard,
  gitSummary,
  inboxSummary,
  planLaneCounts,
  planTopTitles,
  topRecentEntries,
} from "./dashboard";
import type { DailyPlanV1 } from "./today";
import type { TaskEntry } from "./tasks";
import type { DraftEntry, InboxDropItem, InboxEntry, VaultEntry } from "./types";

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
