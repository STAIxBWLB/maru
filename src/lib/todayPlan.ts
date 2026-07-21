// Maru Today — planning lane. Deterministic fallback planner, capacity math
// (mirrors src-tauri/src/today.rs semantics), auto-plan orchestration with
// debounce + stale-result discard, protected-item preservation, plan diffing
// for the Undo UI, and tolerant `maru_today_plan_v1` artifact extraction.
//
// The lib speaks in structured reason/warning CODES (e.g. "overdue",
// "over_capacity") — never display strings. The UI translates codes via i18n.

import type { TaskEntry } from "./tasks";
import { isOverdue } from "./tasks";
import {
  asRecord,
  extractJsonCandidates,
  safeParseRecord,
  stringValue,
} from "./skillProposal";
import {
  type CalendarCommitment,
  type CalendarSyncStatus,
  type CapacitySummary,
  type CaptureCandidate,
  type DailyPlanItem,
  type DailyPlanV1,
  type PlanItemRef,
  type PlanLane,
  type ProposedBlock,
  type TodayMutation,
  type TodaySnapshot,
  type YesterdayItem,
} from "./today";

export const TODAY_PLAN_SCHEMA_VERSION = "maru_today_plan_v1";
export const DEFAULT_PROVISIONAL_ESTIMATE_MINUTES = 30;
export const TOP_LANE_SIZE = 3;

/** Stable identity key for a plan item (diff/protection/dedupe key). */
export function planItemRefKey(ref: PlanItemRef): string {
  return ref.kind === "task" ? `task:${ref.taskId}` : `capture:${ref.captureId}`;
}

// --- Deterministic fallback planner ----------------------------------------

/** Plan-level reason codes. The UI maps these to i18n keys. */
export type PlanReasonCode =
  | "pinned"
  | "carryover"
  | "in_progress"
  | "overdue"
  | "due_today"
  | "capture"
  | "priority"
  | "unscheduled";

export type PlanWarningCode = "overflow" | "over_capacity" | "provisional_estimates";

const REASON_ORDER: PlanReasonCode[] = [
  "pinned",
  "carryover",
  "in_progress",
  "overdue",
  "due_today",
  "capture",
  "priority",
  "unscheduled",
];

const PRIORITY_RANK: Record<string, number> = {
  highest: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

// Sort tiers, applied in order: pinned, in-progress, overdue, due today,
// accepted morning captures, then everything else. Priority and age break
// ties inside a tier.
const TIER_PINNED = 0;
const TIER_IN_PROGRESS = 1;
const TIER_OVERDUE = 2;
const TIER_DUE_TODAY = 3;
const TIER_CAPTURE = 4;
const TIER_REST = 5;

interface PlanSeed {
  ref: PlanItemRef;
  tier: number;
  priorityRank: number;
  /** Epoch ms for oldest-first tie-break; captures use receivedAt. */
  ageMs: number;
  title: string;
  estimateMinutes: number | null;
  reason: PlanReasonCode;
  pinned: boolean;
  outcome: string | null;
}

export interface BuildDeterministicPlanArgs {
  logicalDay: string;
  inputRevision: string;
  tasks: TaskEntry[];
  acceptedCaptures: CaptureCandidate[];
  yesterday: YesterdayItem[];
  /** Existing plan, when re-planning: pinned flags/outcomes are carried over
   *  and pinned items sort first. */
  pinned?: DailyPlanV1 | null;
  /** Effective focus budget in minutes (e.g. from computeCapacitySummary).
   *  When provided, items beyond the budget land in `overflow`; when omitted,
   *  everything past the top lane stays flexible. */
  capacityMinutes?: number | null;
  provisionalEstimateMinutes?: number;
}

/** Deterministic fallback plan used when no AI draft is available (and as the
 *  baseline the auto-planner protects user edits against). Ordering: pinned
 *  first, in-progress, overdue, due today, accepted morning captures,
 *  priority, then oldest. Top = first 3 of the merged order; flexible = rest
 *  up to capacity; overflow = remainder. */
export function buildDeterministicPlan(args: BuildDeterministicPlanArgs): DailyPlanV1 {
  const provisional = args.provisionalEstimateMinutes ?? DEFAULT_PROVISIONAL_ESTIMATE_MINUTES;
  const existing = new Map<string, DailyPlanItem>();
  for (const item of allPlanItems(args.pinned ?? null)) {
    existing.set(planItemRefKey(item.itemRef), item);
  }
  const yesterdayByTaskId = new Map(args.yesterday.map((item) => [item.taskId, item]));

  const seeds: PlanSeed[] = [];
  for (const task of args.tasks) {
    const seed = taskSeed(task, args.logicalDay, yesterdayByTaskId.get(taskKey(task)) ?? null, existing);
    if (seed) seeds.push(seed);
  }
  for (const capture of args.acceptedCaptures) {
    const ref: PlanItemRef = { kind: "capture", captureId: capture.captureId };
    const prior = existing.get(planItemRefKey(ref));
    seeds.push({
      ref,
      tier: prior?.pinned ? TIER_PINNED : TIER_CAPTURE,
      priorityRank: PRIORITY_RANK.none,
      ageMs: parseTime(capture.receivedAt),
      title: capture.title,
      estimateMinutes: capture.estimateMinutes ?? null,
      reason: prior?.pinned ? "pinned" : "capture",
      pinned: prior?.pinned ?? false,
      outcome: prior?.outcome ?? null,
    });
  }

  seeds.sort((a, b) =>
    a.tier - b.tier
    || a.priorityRank - b.priorityRank
    || a.ageMs - b.ageMs
    || a.title.localeCompare(b.title)
    || planItemRefKey(a.ref).localeCompare(planItemRefKey(b.ref)),
  );

  const toItem = (seed: PlanSeed, lane: PlanLane, order: number): DailyPlanItem => ({
    itemRef: seed.ref,
    lane,
    order,
    outcome: seed.outcome,
    estimateMinutes: seed.estimateMinutes ?? provisional,
    estimateProvisional: seed.estimateMinutes === null,
    pinned: seed.pinned,
    proposedBlock: null,
    calendarSync: { status: "none" },
  });

  const top: DailyPlanItem[] = [];
  const flexible: DailyPlanItem[] = [];
  const overflow: DailyPlanItem[] = [];
  const capacity = args.capacityMinutes ?? null;
  let usedMinutes = 0;

  seeds.forEach((seed, index) => {
    const estimate = seed.estimateMinutes ?? provisional;
    if (index < TOP_LANE_SIZE) {
      top.push(toItem(seed, "top", top.length));
      usedMinutes += estimate;
      return;
    }
    if (capacity === null || usedMinutes + estimate <= capacity) {
      flexible.push(toItem(seed, "flexible", flexible.length));
      usedMinutes += estimate;
      return;
    }
    overflow.push(toItem(seed, "overflow", overflow.length));
  });

  const reasons = REASON_ORDER.filter((code) => seeds.some((seed) => seed.reason === code));
  const warnings: PlanWarningCode[] = [];
  if (overflow.length > 0) warnings.push("overflow");
  if (capacity !== null && usedMinutes > capacity) warnings.push("over_capacity");
  if ([...top, ...flexible].some((item) => item.estimateProvisional)) {
    warnings.push("provisional_estimates");
  }

  return {
    logicalDay: args.logicalDay,
    inputRevision: args.inputRevision,
    top,
    flexible,
    overflow,
    reasons,
    warnings,
  };
}

function taskKey(task: TaskEntry): string {
  return task.taskId ?? task.relPath;
}

function taskSeed(
  task: TaskEntry,
  logicalDay: string,
  yesterday: YesterdayItem | null,
  existing: Map<string, DailyPlanItem>,
): PlanSeed | null {
  if (task.bucket === "archive" || task.bucket === "backlog") return null;
  if (task.status === "done" || task.status === "cancelled" || task.status === "backlog") {
    return null;
  }
  // Deferred into the future — not part of this day.
  if (task.deferDate && task.deferDate > logicalDay) return null;
  // Yesterday review already routed this task away from today.
  if (yesterday?.resolution === "defer" || yesterday?.resolution === "cancel") return null;

  const ref: PlanItemRef = { kind: "task", taskId: taskKey(task) };
  const prior = existing.get(planItemRefKey(ref));
  const scheduled = task.due ?? task.calendarStart?.slice(0, 10) ?? null;
  const carryover = yesterday?.resolution === "today" || yesterday?.resolution === "flexible";

  let tier = TIER_REST;
  let reason: PlanReasonCode = scheduled ? "due_today" : "unscheduled";
  if (prior?.pinned) {
    tier = TIER_PINNED;
    reason = "pinned";
  } else if (task.status === "in-progress") {
    tier = TIER_IN_PROGRESS;
    reason = "in_progress";
  } else if (isOverdue(task, logicalDay)) {
    tier = TIER_OVERDUE;
    reason = "overdue";
  } else if (scheduled === logicalDay) {
    tier = TIER_DUE_TODAY;
    reason = "due_today";
  } else if (carryover) {
    reason = "carryover";
  } else if (task.priority !== "none") {
    reason = "priority";
  }

  return {
    ref,
    tier,
    priorityRank: PRIORITY_RANK[task.priority] ?? PRIORITY_RANK.none,
    ageMs: parseTime(task.modifiedAt),
    title: task.title,
    estimateMinutes: task.estimateMinutes ?? null,
    reason,
    pinned: prior?.pinned ?? false,
    outcome: prior?.outcome ?? null,
  };
}

function parseTime(value: string | null | undefined): number {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function allPlanItems(plan: DailyPlanV1 | null): DailyPlanItem[] {
  if (!plan) return [];
  return [...plan.top, ...plan.flexible, ...plan.overflow];
}

// --- Capacity math (mirrors src-tauri/src/today.rs) -------------------------

interface Interval {
  startMs: number;
  endMs: number;
}

/** Merge overlapping (and adjacent) intervals into sorted disjoint ranges so
 *  double-booked time is never counted twice. Mirrors `merge_busy_intervals`. */
export function mergeBusyIntervals(busy: CalendarCommitment[]): Interval[] {
  const sorted = busy
    .map((entry) => ({ startMs: Date.parse(entry.startIso), endMs: Date.parse(entry.endIso) }))
    .filter((interval) => Number.isFinite(interval.startMs) && Number.isFinite(interval.endMs))
    .filter((interval) => interval.endMs > interval.startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const merged: Interval[] = [];
  for (const interval of sorted) {
    const last = merged[merged.length - 1];
    if (last && interval.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, interval.endMs);
    } else {
      merged.push({ ...interval });
    }
  }
  return merged;
}

/** Sum plan-lane minutes (top + flexible; overflow is by definition beyond
 *  the day). Missing estimates fall back to the provisional default, flagging
 *  the result. Mirrors `planned_minutes`. */
export function plannedMinutes(
  plan: DailyPlanV1 | null,
  provisionalDefault: number = DEFAULT_PROVISIONAL_ESTIMATE_MINUTES,
): { minutes: number; provisional: boolean } {
  if (!plan) return { minutes: 0, provisional: false };
  let minutes = 0;
  let provisional = false;
  for (const item of [...plan.top, ...plan.flexible]) {
    if (item.estimateMinutes === null || item.estimateMinutes === undefined) {
      minutes += provisionalDefault;
      provisional = true;
    } else {
      minutes += item.estimateMinutes;
    }
    if (item.estimateProvisional) provisional = true;
  }
  return { minutes, provisional };
}

function parseHHMM(value: string): number | null {
  const match = value.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

export interface ComputeCapacityArgs {
  /** HH:MM local time the logical day begins. */
  dayStart: string;
  /** HH:MM local time the day window ends (next civil day when <= dayStart). */
  sleepStart: string;
  busy: CalendarCommitment[];
  /** Caller-side focus cap; effective budget is min(freeMinutes, cap). */
  focusCapMinutes: number;
  plan: DailyPlanV1 | null;
  provisionalEstimateMinutes?: number;
  /** Logical day (YYYY-MM-DD). When provided, busy intervals are clipped to
   *  the day window (window bounds are parsed in the local JS timezone — see
   *  the Rust side for the authoritative tz-aware computation). */
  logicalDay?: string | null;
}

/** Free/busy/focus math for one logical day. Mirrors `compute_capacity`:
 *  merge busy, free between bounds, min(free, cap), proposed from estimates,
 *  remaining, overCapacity, provisional flag. */
export function computeCapacitySummary(args: ComputeCapacityArgs): CapacitySummary {
  const startMinutes = parseHHMM(args.dayStart) ?? 0;
  const endMinutes = parseHHMM(args.sleepStart) ?? 0;
  const windowMinutes =
    endMinutes > startMinutes ? endMinutes - startMinutes : endMinutes + 24 * 60 - startMinutes;

  let windowStartMs: number | null = null;
  if (args.logicalDay) {
    const parsed = Date.parse(`${args.logicalDay}T${args.dayStart}:00`);
    windowStartMs = Number.isFinite(parsed) ? parsed : null;
  }
  const windowEndMs = windowStartMs === null ? null : windowStartMs + windowMinutes * 60_000;

  const busyMinutes = Math.min(
    mergeBusyIntervals(args.busy).reduce((total, interval) => {
      const clippedStart = windowStartMs === null ? interval.startMs : Math.max(interval.startMs, windowStartMs);
      const clippedEnd = windowEndMs === null ? interval.endMs : Math.min(interval.endMs, windowEndMs);
      return total + Math.max(0, clippedEnd - clippedStart);
    }, 0) / 60_000,
    windowMinutes,
  );
  const freeMinutes = windowMinutes - Math.floor(busyMinutes);
  const focusCapMinutes = Math.min(freeMinutes, args.focusCapMinutes);
  const { minutes: proposedMinutes, provisional } = plannedMinutes(
    args.plan,
    args.provisionalEstimateMinutes ?? DEFAULT_PROVISIONAL_ESTIMATE_MINUTES,
  );

  return {
    dayStart: args.dayStart,
    sleepStart: args.sleepStart,
    freeMinutes,
    busyMinutes: Math.floor(busyMinutes),
    focusCapMinutes,
    proposedMinutes,
    remainingMinutes: Math.max(0, focusCapMinutes - proposedMinutes),
    overCapacity: proposedMinutes > focusCapMinutes,
    provisional,
  };
}

// --- Protected items ---------------------------------------------------------

export interface ProtectedPlanItems {
  /** planItemRefKey set of items the user manually reordered. */
  manualOrder?: ReadonlySet<string>;
  /** Currently executing task — its lane/order never moves under replanning. */
  activeTaskId?: string | null;
}

/** Re-apply user intent to a freshly proposed plan: items that are pinned,
 *  manually reordered, or the active task keep their existing lane and order
 *  (and are re-inserted when the proposal dropped them). Lane contents are
 *  then re-indexed deterministically by (order, key). */
export function preserveProtected(
  existing: DailyPlanV1 | null,
  proposed: DailyPlanV1,
  protectedItems: ProtectedPlanItems = {},
): DailyPlanV1 {
  if (!existing) return proposed;
  const manualOrder = protectedItems.manualOrder ?? new Set<string>();
  const activeKey = protectedItems.activeTaskId ? `task:${protectedItems.activeTaskId}` : null;

  const isProtected = (item: DailyPlanItem): boolean => {
    const key = planItemRefKey(item.itemRef);
    return item.pinned || manualOrder.has(key) || key === activeKey;
  };

  const byKey = new Map<string, DailyPlanItem>();
  for (const item of allPlanItems(proposed)) byKey.set(planItemRefKey(item.itemRef), item);

  for (const existingItem of allPlanItems(existing)) {
    if (!isProtected(existingItem)) continue;
    const key = planItemRefKey(existingItem.itemRef);
    const proposedItem = byKey.get(key);
    if (proposedItem) {
      byKey.set(key, {
        ...proposedItem,
        lane: existingItem.lane,
        order: existingItem.order,
        pinned: existingItem.pinned,
      });
    } else {
      byKey.set(key, { ...existingItem });
    }
  }

  const lanes: Record<PlanLane, DailyPlanItem[]> = { top: [], flexible: [], overflow: [] };
  for (const item of byKey.values()) lanes[item.lane].push(item);
  for (const lane of Object.keys(lanes) as PlanLane[]) {
    lanes[lane].sort(
      (a, b) => a.order - b.order || planItemRefKey(a.itemRef).localeCompare(planItemRefKey(b.itemRef)),
    );
    lanes[lane].forEach((item, index) => {
      item.order = index;
    });
  }
  return { ...proposed, top: lanes.top, flexible: lanes.flexible, overflow: lanes.overflow };
}

// --- Diff (Undo UI) ----------------------------------------------------------

export interface PlanItemMove {
  itemRef: PlanItemRef;
  from: { lane: PlanLane; order: number };
  to: { lane: PlanLane; order: number };
}

export interface PlanItemChange {
  before: DailyPlanItem;
  after: DailyPlanItem;
}

export interface PlanDiff {
  added: DailyPlanItem[];
  removed: DailyPlanItem[];
  moved: PlanItemMove[];
  changed: PlanItemChange[];
}

/** Diff two plans by itemRef key. `moved` = lane/order changed; `changed` =
 *  same position but other fields differ (estimate, pinned, block, …). */
export function diffPlans(prev: DailyPlanV1 | null, next: DailyPlanV1 | null): PlanDiff {
  const prevItems = new Map(allPlanItems(prev).map((item) => [planItemRefKey(item.itemRef), item]));
  const nextItems = new Map(allPlanItems(next).map((item) => [planItemRefKey(item.itemRef), item]));

  const diff: PlanDiff = { added: [], removed: [], moved: [], changed: [] };
  for (const [key, item] of nextItems) {
    const before = prevItems.get(key);
    if (!before) {
      diff.added.push(item);
      continue;
    }
    if (before.lane !== item.lane || before.order !== item.order) {
      diff.moved.push({
        itemRef: item.itemRef,
        from: { lane: before.lane, order: before.order },
        to: { lane: item.lane, order: item.order },
      });
    } else if (planItemFieldsChanged(before, item)) {
      diff.changed.push({ before, after: item });
    }
  }
  for (const [key, item] of prevItems) {
    if (!nextItems.has(key)) diff.removed.push(item);
  }
  return diff;
}

function planItemFieldsChanged(a: DailyPlanItem, b: DailyPlanItem): boolean {
  return (
    a.outcome !== b.outcome
    || a.estimateMinutes !== b.estimateMinutes
    || a.estimateProvisional !== b.estimateProvisional
    || a.pinned !== b.pinned
    || (a.proposedBlock?.startIso ?? null) !== (b.proposedBlock?.startIso ?? null)
    || (a.proposedBlock?.endIso ?? null) !== (b.proposedBlock?.endIso ?? null)
    || a.calendarSync.status !== b.calendarSync.status
  );
}

// --- Auto-plan orchestrator ----------------------------------------------------

/** Change kinds that legitimately trigger an auto-plan run. */
export const AUTO_PLAN_TRIGGERS = [
  "tasks",
  "brainDump",
  "capture",
  "carryover",
  "estimate",
  "calendar",
] as const;

export type AutoPlanTriggerKind = (typeof AUTO_PLAN_TRIGGERS)[number];

export function isAutoPlanTrigger(kind: string): kind is AutoPlanTriggerKind {
  return (AUTO_PLAN_TRIGGERS as readonly string[]).includes(kind);
}

export interface AutoPlanRunContext {
  workPath: string;
  logicalDay: string;
  /** Snapshot revision the run started from; stale results are dropped. */
  inputRevision: string | null;
  reason: AutoPlanTriggerKind;
}

export interface AutoPlannerDeps {
  workPath: string;
  logicalDay: string;
  getSnapshot: () => TodaySnapshot | null;
  /** Applies a mutation (production: `todayMutate`); used only when
   *  `invokePlan` returns a plan for the orchestrator to apply. */
  mutate: (mutation: TodayMutation, expectedRevision: string) => Promise<TodaySnapshot>;
  /** One plan run. Production wiring builds the request
   *  (`todayBuildPlanRequest`), calls the AI runtime, and applies via
   *  `todayApplyPlanResult` — returning void. When it instead returns a
   *  `DailyPlanV1`, the orchestrator applies it via `mutate` after the
   *  staleness check. */
  invokePlan: (ctx: AutoPlanRunContext) => Promise<DailyPlanV1 | null | void>;
  debounceMs?: number;
}

export interface AutoPlanner {
  /** Debounced scheduling; a new schedule supersedes a pending one. */
  schedule(reason: AutoPlanTriggerKind): void;
  /** Change notification entry point — filters no-op kinds. */
  notifyChange(kind: string): void;
  /** Cancel a pending run and drop any in-flight result. */
  cancel(): void;
  readonly running: boolean;
  readonly pending: boolean;
}

export function createAutoPlanner(deps: AutoPlannerDeps): AutoPlanner {
  const debounceMs = deps.debounceMs ?? 2000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingReason: AutoPlanTriggerKind | null = null;
  let running = false;
  let rerunReason: AutoPlanTriggerKind | null = null;
  let generation = 0;

  const clearTimer = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const finish = async (
    result: DailyPlanV1 | null | void,
    runGeneration: number,
    startRevision: string | null,
  ) => {
    running = false;
    // Stale discard: a newer schedule/cancel superseded this run, or the
    // snapshot moved on while the run was in flight — drop the result.
    const stale =
      runGeneration !== generation || (deps.getSnapshot()?.revision ?? null) !== startRevision;
    if (!stale && result && startRevision !== null) {
      try {
        await deps.mutate({ type: "setPlan", plan: result }, startRevision);
      } catch {
        // Apply failures (e.g. revision conflict) are non-fatal; the next
        // scheduled run replans from the newer snapshot.
      }
    }
    if (rerunReason !== null && runGeneration === generation) {
      const reason = rerunReason;
      rerunReason = null;
      startRun(reason);
    }
  };

  const startRun = (reason: AutoPlanTriggerKind) => {
    running = true;
    generation += 1;
    const runGeneration = generation;
    const startRevision = deps.getSnapshot()?.revision ?? null;
    Promise.resolve()
      .then(() =>
        deps.invokePlan({
          workPath: deps.workPath,
          logicalDay: deps.logicalDay,
          inputRevision: startRevision,
          reason,
        }),
      )
      .then((result) => finish(result, runGeneration, startRevision))
      .catch(() => finish(null, runGeneration, startRevision));
  };

  return {
    schedule(reason) {
      pendingReason = reason;
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        const runReason = pendingReason;
        pendingReason = null;
        if (runReason === null) return;
        if (running) {
          rerunReason = runReason;
          return;
        }
        startRun(runReason);
      }, debounceMs);
    },
    notifyChange(kind) {
      if (isAutoPlanTrigger(kind)) this.schedule(kind);
    },
    cancel() {
      clearTimer();
      pendingReason = null;
      rerunReason = null;
      generation += 1;
    },
    get running() {
      return running;
    },
    get pending() {
      return timer !== null;
    },
  };
}

// --- AI artifact extraction ----------------------------------------------------

export interface TodayPlanArtifact {
  schema: string;
  plan: DailyPlanV1;
}

/** Tolerantly extract a `maru_today_plan_v1` artifact from raw AI output:
 *  fenced or inline JSON, matching on `schema`/`schemaVersion`. The final
 *  matching candidate wins (skill bodies may embed the schema example). */
export function extractTodayPlanArtifact(raw: string): TodayPlanArtifact | null {
  for (const candidate of extractJsonCandidates(raw).reverse()) {
    const parsed = safeParseRecord(candidate);
    if (!parsed) continue;
    const schema = stringValue(parsed.schema ?? parsed.schemaVersion);
    if (schema !== TODAY_PLAN_SCHEMA_VERSION) continue;
    const plan = normalizePlanArtifact(asRecord(parsed.plan) ?? parsed);
    if (plan) return { schema, plan };
  }
  return null;
}

const LANES: PlanLane[] = ["top", "flexible", "overflow"];
const CALENDAR_SYNC_STATUSES: CalendarSyncStatus[] = ["none", "selected", "syncing", "synced", "error"];

function normalizePlanArtifact(value: Record<string, unknown>): DailyPlanV1 | null {
  const logicalDay = stringValue(value.logicalDay ?? value.logical_day);
  if (!logicalDay) return null;
  const lanes = {} as Record<PlanLane, DailyPlanItem[]>;
  for (const lane of LANES) {
    const rawItems = Array.isArray(value[lane]) ? value[lane] : [];
    lanes[lane] = rawItems
      .map((item, index) => normalizePlanItem(item, lane, index))
      .filter((item): item is DailyPlanItem => item !== null);
  }
  return {
    logicalDay,
    inputRevision: stringValue(value.inputRevision ?? value.input_revision),
    top: lanes.top,
    flexible: lanes.flexible,
    overflow: lanes.overflow,
    reasons: stringArray(value.reasons),
    warnings: stringArray(value.warnings),
  };
}

function normalizePlanItem(value: unknown, lane: PlanLane, index: number): DailyPlanItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const itemRef = normalizeItemRef(record.itemRef ?? record.item_ref);
  if (!itemRef) return null;
  const rawLane = stringValue(record.lane);
  const estimateMinutes = numberOrNull(record.estimateMinutes ?? record.estimate_minutes);
  const estimateProvisional =
    typeof record.estimateProvisional === "boolean"
      ? record.estimateProvisional
      : typeof record.estimate_provisional === "boolean"
        ? record.estimate_provisional
        : estimateMinutes === null;
  const syncRecord = asRecord(record.calendarSync ?? record.calendar_sync);
  const syncStatus = stringValue(syncRecord?.status);
  const syncMessage = stringValue(syncRecord?.message);
  const syncEventId = stringValue(syncRecord?.eventId ?? syncRecord?.event_id);
  const syncDestination = stringValue(syncRecord?.destination);
  return {
    itemRef,
    lane: (LANES as string[]).includes(rawLane) ? (rawLane as PlanLane) : lane,
    order: numberOrNull(record.order) ?? index,
    outcome: stringValue(record.outcome) || null,
    estimateMinutes,
    estimateProvisional,
    pinned: record.pinned === true,
    proposedBlock: normalizeProposedBlock(record.proposedBlock ?? record.proposed_block),
    calendarSync: {
      status: (CALENDAR_SYNC_STATUSES as string[]).includes(syncStatus)
        ? (syncStatus as CalendarSyncStatus)
        : "none",
      ...(syncMessage ? { message: syncMessage } : {}),
      ...(syncEventId ? { eventId: syncEventId } : {}),
      ...(syncDestination ? { destination: syncDestination } : {}),
    },
  };
}

function normalizeItemRef(value: unknown): PlanItemRef | null {
  const record = asRecord(value);
  if (!record) return null;
  const kind = stringValue(record.kind);
  if (kind === "task") {
    const taskId = stringValue(record.taskId ?? record.task_id ?? record.id);
    return taskId ? { kind: "task", taskId } : null;
  }
  if (kind === "capture") {
    const captureId = stringValue(record.captureId ?? record.capture_id ?? record.id);
    return captureId ? { kind: "capture", captureId } : null;
  }
  return null;
}

function normalizeProposedBlock(value: unknown): ProposedBlock | null {
  const record = asRecord(value);
  if (!record) return null;
  const startIso = stringValue(record.startIso ?? record.start_iso);
  const endIso = stringValue(record.endIso ?? record.end_iso);
  return startIso && endIso ? { startIso, endIso } : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? Math.floor(number) : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
