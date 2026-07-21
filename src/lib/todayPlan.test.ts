import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { TaskEntry } from "./tasks";
import type {
  CalendarCommitment,
  CaptureCandidate,
  DailyPlanItem,
  DailyPlanV1,
  TodaySnapshot,
  YesterdayItem,
} from "./today";
import {
  buildDeterministicPlan,
  computeCapacitySummary,
  createAutoPlanner,
  diffPlans,
  extractTodayPlanArtifact,
  isAutoPlanTrigger,
  mergeBusyIntervals,
  plannedMinutes,
  planItemRefKey,
  preserveProtected,
  type AutoPlanRunContext,
} from "./todayPlan";

const DAY = "2026-07-21";

function task(overrides: Partial<TaskEntry>): TaskEntry {
  return {
    absPath: "/work/tasks/active/x.md",
    relPath: "tasks/active/x.md",
    fileName: "x.md",
    bucket: "active",
    title: "Task",
    status: "active",
    priority: "none",
    project: null,
    topics: [],
    due: null,
    calendarStart: null,
    calendarEnd: null,
    size: 0,
    modifiedAt: null,
    frontmatter: {},
    ...overrides,
  };
}

function capture(overrides: Partial<CaptureCandidate>): CaptureCandidate {
  return {
    captureId: "gmail:msg-1",
    provider: "gmail",
    providerItemId: "msg-1",
    fingerprint: "fp",
    confidence: "high",
    category: "action",
    title: "Capture",
    summary: "",
    receivedAt: `${DAY}T08:00:00`,
    ...overrides,
  };
}

function item(overrides: Partial<DailyPlanItem> & { key: string }): DailyPlanItem {
  const { key, ...rest } = overrides;
  const [kind, id] = key.split(":");
  return {
    itemRef: kind === "capture" ? { kind: "capture", captureId: id } : { kind: "task", taskId: id },
    lane: "flexible",
    order: 0,
    outcome: null,
    estimateMinutes: 30,
    estimateProvisional: false,
    pinned: false,
    proposedBlock: null,
    calendarSync: { status: "none" },
    ...rest,
  };
}

function plan(overrides: Partial<DailyPlanV1> = {}): DailyPlanV1 {
  return {
    logicalDay: DAY,
    inputRevision: "rev-1",
    top: [],
    flexible: [],
    overflow: [],
    reasons: [],
    warnings: [],
    ...overrides,
  };
}

function keys(plan: DailyPlanV1): string[] {
  return [...plan.top, ...plan.flexible, ...plan.overflow].map((entry) =>
    planItemRefKey(entry.itemRef),
  );
}

describe("buildDeterministicPlan", () => {
  it("orders pinned, in-progress, overdue, due-today, captures, priority, oldest", () => {
    const existing = plan({
      flexible: [item({ key: "task:pinned", lane: "flexible", order: 0, pinned: true })],
    });
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      pinned: existing,
      yesterday: [],
      acceptedCaptures: [capture({ captureId: "cap-1" })],
      tasks: [
        task({ taskId: "priority-high", title: "P", priority: "high" }),
        task({ taskId: "due-today", title: "D", due: DAY }),
        task({ taskId: "overdue", title: "O", due: "2026-07-19" }),
        task({ taskId: "in-prog", title: "I", status: "in-progress" }),
        task({ taskId: "pinned", title: "Pin" }),
        task({ taskId: "plain-new", title: "New", modifiedAt: "2026-07-20T10:00:00" }),
        task({ taskId: "plain-old", title: "Old", modifiedAt: "2026-07-18T10:00:00" }),
      ],
    });
    expect(keys(result)).toEqual([
      "task:pinned",
      "task:in-prog",
      "task:overdue",
      "task:due-today",
      "capture:cap-1",
      "task:priority-high",
      "task:plain-old",
      "task:plain-new",
    ]);
    expect(result.reasons).toEqual([
      "pinned",
      "in_progress",
      "overdue",
      "due_today",
      "capture",
      "priority",
      "unscheduled",
    ]);
  });

  it("splits top 3 / flexible / overflow by capacity", () => {
    const tasks = Array.from({ length: 6 }, (_, index) =>
      task({ taskId: `t-${index}`, title: `T${index}`, due: DAY, estimateMinutes: 30 }),
    );
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      tasks,
      acceptedCaptures: [],
      yesterday: [],
      capacityMinutes: 120,
    });
    expect(result.top).toHaveLength(3);
    expect(result.flexible).toHaveLength(1);
    expect(result.overflow).toHaveLength(2);
    expect(result.warnings).toContain("overflow");
    expect(result.overflow.map((entry) => entry.lane)).toEqual(["overflow", "overflow"]);
  });

  it("keeps everything flexible when no capacity is given", () => {
    const tasks = Array.from({ length: 5 }, (_, index) =>
      task({ taskId: `t-${index}`, title: `T${index}`, due: DAY }),
    );
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      tasks,
      acceptedCaptures: [],
      yesterday: [],
    });
    expect(result.top).toHaveLength(3);
    expect(result.flexible).toHaveLength(2);
    expect(result.overflow).toHaveLength(0);
  });

  it("falls back to provisional estimates and flags them", () => {
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      tasks: [task({ taskId: "no-est", due: DAY })],
      acceptedCaptures: [],
      yesterday: [],
    });
    const entry = result.top[0];
    expect(entry.estimateMinutes).toBe(30);
    expect(entry.estimateProvisional).toBe(true);
    expect(result.warnings).toContain("provisional_estimates");
  });

  it("excludes done/cancelled/backlog/archive, future deferrals, and routed-away yesterday items", () => {
    const yesterday: YesterdayItem[] = [
      { taskId: "yd", title: "Y", status: "active", resolution: "defer" },
      { taskId: "yc", title: "Y", status: "active", resolution: "cancel" },
    ];
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      yesterday,
      acceptedCaptures: [],
      tasks: [
        task({ taskId: "done", status: "done" }),
        task({ taskId: "cancelled", status: "cancelled" }),
        task({ taskId: "backlog", status: "backlog" }),
        task({ taskId: "archived", bucket: "archive" }),
        task({ taskId: "deferred", deferDate: "2026-07-25" }),
        task({ taskId: "yd" }),
        task({ taskId: "yc" }),
        task({ taskId: "kept", title: "K" }),
      ],
    });
    expect(keys(result)).toEqual(["task:kept"]);
  });

  it("marks carried-over yesterday items with the carryover reason", () => {
    const result = buildDeterministicPlan({
      logicalDay: DAY,
      inputRevision: "rev-1",
      yesterday: [{ taskId: "co", title: "C", status: "active", resolution: "today" }],
      acceptedCaptures: [],
      tasks: [task({ taskId: "co" })],
    });
    expect(result.reasons).toContain("carryover");
  });
});

describe("capacity math", () => {
  const busy = (entries: Array<[string, string]>): CalendarCommitment[] =>
    entries.map(([startIso, endIso]) => ({ title: "busy", startIso, endIso, source: "test" }));

  it("computes the day window and applies the focus cap", () => {
    const summary = computeCapacitySummary({
      dayStart: "03:30",
      sleepStart: "21:30",
      busy: [],
      focusCapMinutes: 480,
      plan: null,
    });
    expect(summary.freeMinutes).toBe(1080);
    expect(summary.busyMinutes).toBe(0);
    expect(summary.focusCapMinutes).toBe(480);
    expect(summary.overCapacity).toBe(false);
    expect(summary.provisional).toBe(false);
  });

  it("wraps the window past midnight when sleepStart <= dayStart", () => {
    const summary = computeCapacitySummary({
      dayStart: "03:30",
      sleepStart: "01:00",
      busy: [],
      focusCapMinutes: 480,
      plan: null,
    });
    expect(summary.freeMinutes).toBe(1290);
  });

  it("merges overlapping and adjacent busy intervals", () => {
    const merged = mergeBusyIntervals(
      busy([
        [`${DAY}T09:30:00`, `${DAY}T10:30:00`],
        [`${DAY}T09:00:00`, `${DAY}T10:00:00`],
        [`${DAY}T10:30:00`, `${DAY}T11:00:00`],
      ]),
    );
    expect(merged).toHaveLength(1);
    const summary = computeCapacitySummary({
      dayStart: "03:30",
      sleepStart: "21:30",
      logicalDay: DAY,
      busy: busy([
        [`${DAY}T09:30:00`, `${DAY}T10:30:00`],
        [`${DAY}T09:00:00`, `${DAY}T10:00:00`],
        [`${DAY}T10:30:00`, `${DAY}T11:00:00`],
      ]),
      focusCapMinutes: 480,
      plan: null,
    });
    expect(summary.busyMinutes).toBe(120);
    expect(summary.freeMinutes).toBe(960);
    expect(summary.focusCapMinutes).toBe(480);
  });

  it("clips busy intervals to the day window", () => {
    const summary = computeCapacitySummary({
      dayStart: "09:00",
      sleepStart: "17:00",
      logicalDay: DAY,
      busy: busy([[`${DAY}T07:00:00`, `${DAY}T10:00:00`]]),
      focusCapMinutes: 480,
      plan: null,
    });
    expect(summary.busyMinutes).toBe(60);
    expect(summary.freeMinutes).toBe(420);
  });

  it("flags over-capacity when proposed minutes exceed the focus budget", () => {
    const full = plan({
      top: [item({ key: "task:a", lane: "top", estimateMinutes: 300 })],
      flexible: [item({ key: "task:b", lane: "flexible", estimateMinutes: 240 })],
    });
    const summary = computeCapacitySummary({
      dayStart: "03:30",
      sleepStart: "21:30",
      busy: [],
      focusCapMinutes: 480,
      plan: full,
    });
    expect(summary.proposedMinutes).toBe(540);
    expect(summary.remainingMinutes).toBe(0);
    expect(summary.overCapacity).toBe(true);
  });

  it("plannedMinutes ignores overflow and flags provisional estimates", () => {
    const withOverflow = plan({
      top: [item({ key: "task:a", lane: "top", estimateMinutes: 60 })],
      flexible: [item({ key: "task:b", lane: "flexible", estimateMinutes: null, estimateProvisional: true })],
      overflow: [item({ key: "task:c", lane: "overflow", estimateMinutes: 999 })],
    });
    const { minutes, provisional } = plannedMinutes(withOverflow, 30);
    expect(minutes).toBe(90);
    expect(provisional).toBe(true);
  });
});

describe("preserveProtected", () => {
  it("keeps pinned, manually ordered, and active items in their lane/order", () => {
    const existing = plan({
      top: [
        item({ key: "task:active", lane: "top", order: 0 }),
        item({ key: "task:pinned", lane: "top", order: 1, pinned: true }),
      ],
      flexible: [item({ key: "task:manual", lane: "flexible", order: 0 })],
    });
    const proposed = plan({
      top: [item({ key: "task:pinned", lane: "top", order: 0, pinned: true })],
      flexible: [
        item({ key: "task:manual", lane: "flexible", order: 0 }),
        item({ key: "task:active", lane: "flexible", order: 1 }),
      ],
      overflow: [item({ key: "task:new", lane: "overflow", order: 0 })],
    });
    const merged = preserveProtected(existing, proposed, {
      manualOrder: new Set(["task:manual"]),
      activeTaskId: "active",
    });
    const byKey = new Map(
      [...merged.top, ...merged.flexible, ...merged.overflow].map((entry) => [
        planItemRefKey(entry.itemRef),
        entry,
      ]),
    );
    expect(byKey.get("task:active")?.lane).toBe("top");
    expect(byKey.get("task:pinned")?.lane).toBe("top");
    expect(byKey.get("task:manual")?.lane).toBe("flexible");
    // Existing top order (active=0, pinned=1) is retained and re-indexed.
    expect(merged.top.map((entry) => planItemRefKey(entry.itemRef))).toEqual([
      "task:active",
      "task:pinned",
    ]);
    expect(merged.top.map((entry) => entry.order)).toEqual([0, 1]);
  });

  it("re-inserts protected items the proposal dropped", () => {
    const existing = plan({
      top: [item({ key: "task:pinned", lane: "top", order: 0, pinned: true })],
    });
    const proposed = plan({
      flexible: [item({ key: "task:other", lane: "flexible", order: 0 })],
    });
    const merged = preserveProtected(existing, proposed);
    expect(merged.top.map((entry) => planItemRefKey(entry.itemRef))).toEqual(["task:pinned"]);
    expect(merged.flexible.map((entry) => planItemRefKey(entry.itemRef))).toEqual(["task:other"]);
  });

  it("returns the proposal unchanged without an existing plan", () => {
    const proposed = plan();
    expect(preserveProtected(null, proposed)).toBe(proposed);
  });
});

describe("diffPlans", () => {
  it("reports added, removed, moved, and changed items by ref key", () => {
    const prev = plan({
      top: [item({ key: "task:stay", lane: "top", order: 0 })],
      flexible: [
        item({ key: "task:move", lane: "flexible", order: 0 }),
        item({ key: "task:change", lane: "flexible", order: 1 }),
        item({ key: "task:remove", lane: "flexible", order: 2 }),
      ],
    });
    const next = plan({
      top: [
        item({ key: "task:move", lane: "top", order: 0 }),
        item({ key: "task:stay", lane: "top", order: 1 }),
      ],
      flexible: [
        item({ key: "task:change", lane: "flexible", order: 1, estimateMinutes: 60 }),
        item({ key: "task:add", lane: "flexible", order: 0 }),
      ],
    });
    const diff = diffPlans(prev, next);
    expect(diff.added.map((entry) => planItemRefKey(entry.itemRef))).toEqual(["task:add"]);
    expect(diff.removed.map((entry) => planItemRefKey(entry.itemRef))).toEqual(["task:remove"]);
    expect(diff.moved).toEqual([
      {
        itemRef: { kind: "task", taskId: "move" },
        from: { lane: "flexible", order: 0 },
        to: { lane: "top", order: 0 },
      },
      {
        itemRef: { kind: "task", taskId: "stay" },
        from: { lane: "top", order: 0 },
        to: { lane: "top", order: 1 },
      },
    ]);
    expect(diff.changed.map((entry) => planItemRefKey(entry.after.itemRef))).toEqual([
      "task:change",
    ]);
  });

  it("handles null plans", () => {
    const diff = diffPlans(null, plan({ top: [item({ key: "task:a", lane: "top" })] }));
    expect(diff.added).toHaveLength(1);
    expect(diffPlans(plan(), null).removed).toHaveLength(0);
  });
});

describe("extractTodayPlanArtifact", () => {
  const artifact = {
    schema: "maru_today_plan_v1",
    plan: {
      logicalDay: DAY,
      inputRevision: "rev-9",
      top: [
        {
          itemRef: { kind: "task", taskId: "t-1" },
          lane: "top",
          order: 0,
          estimateMinutes: 45,
          estimateProvisional: false,
          pinned: false,
        },
      ],
      flexible: [
        {
          itemRef: { kind: "capture", captureId: "c-1" },
          estimateMinutes: null,
        },
      ],
      overflow: [],
      reasons: ["overdue"],
      warnings: ["overflow"],
    },
  };

  it("extracts a fenced JSON artifact", () => {
    const raw = `Here is the plan.\n\n\`\`\`json\n${JSON.stringify(artifact, null, 2)}\n\`\`\`\nDone.`;
    const result = extractTodayPlanArtifact(raw);
    expect(result?.schema).toBe("maru_today_plan_v1");
    expect(result?.plan.logicalDay).toBe(DAY);
    expect(result?.plan.inputRevision).toBe("rev-9");
    expect(result?.plan.top[0].itemRef).toEqual({ kind: "task", taskId: "t-1" });
    expect(result?.plan.flexible[0].estimateProvisional).toBe(true);
    expect(result?.plan.flexible[0].calendarSync).toEqual({ status: "none" });
    expect(result?.plan.reasons).toEqual(["overdue"]);
  });

  it("extracts an inline JSON artifact and accepts schemaVersion", () => {
    const inline = { ...artifact, schema: undefined, schemaVersion: "maru_today_plan_v1" };
    const raw = `prefix ${JSON.stringify(inline)} suffix`;
    const result = extractTodayPlanArtifact(raw);
    expect(result?.plan.logicalDay).toBe(DAY);
  });

  it("returns null for garbage and foreign schemas", () => {
    expect(extractTodayPlanArtifact("no json here")).toBeNull();
    expect(extractTodayPlanArtifact(JSON.stringify({ schema: "maru_other_v1" }))).toBeNull();
    expect(extractTodayPlanArtifact("{ not json")).toBeNull();
  });

  it("drops items without a valid itemRef", () => {
    const broken = {
      ...artifact,
      plan: {
        ...artifact.plan,
        top: [{ lane: "top", order: 0 }, ...artifact.plan.top],
      },
    };
    const result = extractTodayPlanArtifact(JSON.stringify(broken));
    expect(result?.plan.top).toHaveLength(1);
    expect(result?.plan.top[0].itemRef).toEqual({ kind: "task", taskId: "t-1" });
  });
});

describe("auto planner triggers", () => {
  it("enumerates material change kinds and filters no-ops", () => {
    for (const kind of ["tasks", "brainDump", "capture", "carryover", "estimate", "calendar"]) {
      expect(isAutoPlanTrigger(kind)).toBe(true);
    }
    expect(isAutoPlanTrigger("route")).toBe(false);
    expect(isAutoPlanTrigger("")).toBe(false);
  });
});

describe("createAutoPlanner", () => {
  let snapshot: TodaySnapshot;

  beforeEach(() => {
    vi.useFakeTimers();
    snapshot = {
      logicalDay: DAY,
      generatedAt: `${DAY}T09:00:00`,
      revision: "rev-1",
      dayState: "planned",
      route: "prepare",
      timezone: "Asia/Seoul",
      dayStart: "03:30",
      sleepStart: "21:30",
      brainDump: "",
      plan: null,
      yesterday: [],
      carryovers: [],
      sources: [],
      unconfirmedContent: false,
    };
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function planner(overrides: Partial<Parameters<typeof createAutoPlanner>[0]> = {}) {
    const mutate = vi.fn(async () => snapshot);
    const invokePlan = vi.fn(async (_ctx: AutoPlanRunContext) => null as DailyPlanV1 | null);
    const autoPlanner = createAutoPlanner({
      workPath: "/work",
      logicalDay: DAY,
      getSnapshot: () => snapshot,
      mutate,
      invokePlan,
      debounceMs: 1000,
      ...overrides,
    });
    return { autoPlanner, mutate, invokePlan };
  }

  it("debounces schedules into a single run with the latest reason", async () => {
    const { autoPlanner, invokePlan } = planner();
    autoPlanner.schedule("tasks");
    autoPlanner.schedule("capture");
    expect(autoPlanner.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(invokePlan).toHaveBeenCalledTimes(1);
    expect(invokePlan.mock.calls[0][0]).toMatchObject({
      workPath: "/work",
      logicalDay: DAY,
      inputRevision: "rev-1",
      reason: "capture",
    });
    expect(autoPlanner.running).toBe(false);
  });

  it("notifyChange filters no-op kinds", async () => {
    const { autoPlanner, invokePlan } = planner();
    autoPlanner.notifyChange("route");
    await vi.advanceTimersByTimeAsync(5000);
    expect(invokePlan).not.toHaveBeenCalled();
    autoPlanner.notifyChange("estimate");
    await vi.advanceTimersByTimeAsync(1000);
    expect(invokePlan).toHaveBeenCalledTimes(1);
  });

  it("applies a returned plan via setPlan when the revision is unchanged", async () => {
    const draft = plan({ inputRevision: "rev-1" });
    const { autoPlanner, mutate } = planner({ invokePlan: async () => draft });
    autoPlanner.schedule("tasks");
    await vi.advanceTimersByTimeAsync(1000);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({ type: "setPlan", plan: draft }, "rev-1");
  });

  it("discards stale results when the snapshot revision moved mid-run", async () => {
    let release!: (value: DailyPlanV1) => void;
    const blocked = new Promise<DailyPlanV1>((resolve) => {
      release = resolve;
    });
    const { autoPlanner, mutate } = planner({ invokePlan: () => blocked });
    autoPlanner.schedule("tasks");
    await vi.advanceTimersByTimeAsync(1000);
    expect(autoPlanner.running).toBe(true);
    snapshot = { ...snapshot, revision: "rev-2" };
    release(plan());
    await vi.advanceTimersByTimeAsync(0);
    expect(mutate).not.toHaveBeenCalled();
    expect(autoPlanner.running).toBe(false);
  });

  it("keeps a single active run and re-runs with the latest reason", async () => {
    const reasons: string[] = [];
    let release!: () => void;
    const blocked = new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
    const invokePlan = vi.fn((ctx: { reason: string }) => {
      reasons.push(ctx.reason);
      return reasons.length === 1 ? blocked : Promise.resolve(null);
    });
    const { autoPlanner } = planner({ invokePlan });
    autoPlanner.schedule("tasks");
    await vi.advanceTimersByTimeAsync(1000);
    expect(autoPlanner.running).toBe(true);
    autoPlanner.schedule("calendar");
    await vi.advanceTimersByTimeAsync(1000);
    expect(invokePlan).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(invokePlan).toHaveBeenCalledTimes(2);
    expect(reasons).toEqual(["tasks", "calendar"]);
  });

  it("cancel drops a pending run and an in-flight result", async () => {
    let release!: (value: DailyPlanV1) => void;
    const blocked = new Promise<DailyPlanV1>((resolve) => {
      release = resolve;
    });
    const { autoPlanner, invokePlan, mutate } = planner({ invokePlan: () => blocked });
    autoPlanner.schedule("tasks");
    autoPlanner.cancel();
    await vi.advanceTimersByTimeAsync(5000);
    expect(invokePlan).not.toHaveBeenCalled();

    autoPlanner.schedule("tasks");
    await vi.advanceTimersByTimeAsync(1000);
    expect(autoPlanner.running).toBe(true);
    autoPlanner.cancel();
    release(plan());
    await vi.advanceTimersByTimeAsync(0);
    expect(mutate).not.toHaveBeenCalled();
  });
});
