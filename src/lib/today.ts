// Maru Today — TypeScript twin of the Rust contracts in src-tauri/src/today.rs
// (plus today_store.rs / today_lifecycle.rs / today_outbox.rs / today_notify.rs).
// Field names mirror the serde camelCase wire format exactly — keep stable.

import { invoke } from "@tauri-apps/api/core";
import { invokeE2EOverride } from "./e2eInvoke";

/** Single invoke funnel for every Today command. In a plain browser (dev /
 *  Playwright) commands resolve through per-command e2e fixtures when
 *  registered; without a fixture the raw invoke rejects, preserving the
 *  previous degraded-mode behavior. In the Tauri shell this is a pass-through. */
async function todayInvoke<T>(command: string, args: Record<string, unknown>): Promise<T> {
  const override = await invokeE2EOverride<T>(command, args);
  if (override !== null) return override;
  return invoke<T>(command, args);
}

export type TodayRoute =
  | "prepare"
  | "execute"
  | "review"
  | "calendar"
  | "capture"
  | "upcoming"
  | "log"
  | "all";

export type TodayStage = "prepare" | "execute" | "review";

export type DayState =
  | "unstarted"
  | "preparing"
  | "planned"
  | "skipped"
  | "executing"
  | "reviewed";

export type PlanLane = "top" | "flexible" | "overflow";

export type PlanItemRef =
  | { kind: "task"; taskId: string }
  | { kind: "capture"; captureId: string };

export interface ProposedBlock {
  startIso: string;
  endIso: string;
}

export type CalendarSyncStatus = "none" | "selected" | "syncing" | "synced" | "error";

export interface CalendarSyncState {
  status: CalendarSyncStatus;
  message?: string | null;
  /** Provider event id returned by a successful publish. */
  eventId?: string | null;
  /** Destination calendar id captured at selection time. */
  destination?: string | null;
}

export interface DailyPlanItem {
  itemRef: PlanItemRef;
  lane: PlanLane;
  order: number;
  outcome?: string | null;
  estimateMinutes?: number | null;
  estimateProvisional: boolean;
  pinned: boolean;
  proposedBlock?: ProposedBlock | null;
  calendarSync: CalendarSyncState;
}

export interface DailyPlanV1 {
  logicalDay: string;
  /** Revision of the snapshot the plan was computed against. Enforced on
   *  `setPlan` so a stale AI draft cannot overwrite a newer day state. */
  inputRevision: string;
  top: DailyPlanItem[];
  flexible: DailyPlanItem[];
  overflow: DailyPlanItem[];
  reasons: string[];
  warnings: string[];
}

export type CaptureConfidence = "high" | "medium" | "low";

export interface CaptureCandidate {
  captureId: string;
  provider: string;
  providerItemId?: string | null;
  fingerprint: string;
  confidence: CaptureConfidence;
  category: string;
  title: string;
  summary: string;
  dueDate?: string | null;
  estimateMinutes?: number | null;
  project?: string | null;
  reason?: string | null;
  receivedAt: string;
}

export type CaptureDecision = "addToToday" | "keep" | "edit" | "defer" | "dismiss";

export interface CalendarCommitment {
  title: string;
  startIso: string;
  endIso: string;
  source: string;
}

export interface CapacitySummary {
  dayStart: string;
  sleepStart: string;
  freeMinutes: number;
  busyMinutes: number;
  /** Effective focus budget: `min(freeMinutes, callerCap)`. */
  focusCapMinutes: number;
  proposedMinutes: number;
  remainingMinutes: number;
  overCapacity: boolean;
  /** True when any planned item fell back to the provisional estimate. */
  provisional: boolean;
}

export interface SourceFreshness {
  source: string;
  lastLoadedAt?: string | null;
  stale: boolean;
}

export type YesterdayResolution = "today" | "flexible" | "defer" | "cancel";

export interface YesterdayItem {
  taskId: string;
  title: string;
  status: string;
  progress?: number | null;
  resolution?: YesterdayResolution | null;
  deferDate?: string | null;
}

export interface CarryoverRef {
  itemRef: PlanItemRef;
  /** Logical day (YYYY-MM-DD) the item was carried over from. */
  carriedFrom: string;
}

/** The per-day unit persisted at `<work>/.maru/today/YYYY-MM-DD.json`. */
export interface TodaySnapshot {
  logicalDay: string;
  generatedAt: string;
  /** sha256 hex of the canonical JSON (this field blanked). Bumped on every
   *  mutation; checked by `today_mutate` for optimistic concurrency. */
  revision: string;
  dayState: DayState;
  route: TodayRoute;
  stage?: TodayStage | null;
  timezone: string;
  dayStart: string;
  sleepStart: string;
  brainDump: string;
  plan?: DailyPlanV1 | null;
  yesterday: YesterdayItem[];
  capacity?: CapacitySummary | null;
  carryovers: CarryoverRef[];
  sources: SourceFreshness[];
  /** True when rollover carried preparation content across a day boundary
   *  before the user confirmed or skipped it. */
  unconfirmedContent: boolean;
}

/** Append-only event line in `<work>/.maru/today/events/YYYY-MM.jsonl`. */
export interface TaskEvent {
  ts: string;
  /** Logical day the event belongs to; `ts` is UTC and can differ. */
  day?: string | null;
  kind: string;
  taskId?: string | null;
  payload: unknown;
}

export type TaskSyncStatus = "local" | "syncing" | "synced" | "retryNeeded" | "authBlocked";

export type TaskTransitionKind = "complete" | "reopen" | "cancel" | "defer";

export interface TaskTransitionRequest {
  taskId: string;
  taskPath: string;
  kind: TaskTransitionKind;
  /** sha256 of the task note content the caller based the transition on. */
  expectedTaskHash: string;
  deferDate?: string | null;
  /** Logical-day date (YYYY-MM-DD) written to `done` on complete and used
   *  for the event log month. Keeps the transition clock-free. */
  date?: string | null;
  /** RFC3339 timestamp written to `completedAt` and the event `ts`. */
  nowIso?: string | null;
  payload?: unknown;
}

export interface TaskTransitionOutcome {
  taskId: string;
  newTaskHash: string;
  bucket: string;
  syncStatus: TaskSyncStatus;
}

/** Serde-tagged mutation applied by `today_mutate`. The `type` tag is the
 *  wire name the Rust side matches on. */
export type TodayMutation =
  | { type: "setRoute"; route: TodayRoute }
  | { type: "setBrainDump"; brainDump: string }
  | { type: "confirmSetup" }
  | { type: "quickSkip" }
  | {
      type: "applyYesterdayDecision";
      taskId: string;
      resolution: YesterdayResolution;
      deferDate?: string | null;
    }
  | { type: "setPlan"; plan: DailyPlanV1 }
  | {
      type: "setCalendarSync";
      itemRef: PlanItemRef;
      selected: boolean;
      destination?: string | null;
    }
  | { type: "undo" };

export interface LogicalDayInfo {
  logicalDay: string;
  previousLogicalDay: string;
  /** True once local time has passed today's day start (the fresh logical
   *  day began this civil morning); false while still in yesterday's tail. */
  isNewDayBoundary: boolean;
}

export interface TodayRolloverOutcome {
  closedDay: string | null;
  newDay: string;
  seeded: number;
}

export interface TaskTrashOutcome {
  trashedPath: string;
}

export type OutboxOp = "complete" | "reopen" | "delete";

export type OutboxStatus =
  | "prepared"
  | "ready"
  | "syncing"
  | "synced"
  | "retryNeeded"
  | "authBlocked";

export interface OutboxRecord {
  id: string;
  op: OutboxOp;
  taskPath: string;
  googleTaskId: string;
  googleTaskListId?: string | null;
  status: OutboxStatus;
  attempts: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DrainOutcome {
  drained: number;
  failed: number;
  blocked: number;
}

export interface RetryOutcome {
  requeued: number;
}

export interface TodayNotifyOutcome {
  sent: boolean;
  permission: string;
}

export interface CalendarPublishOutcome {
  published: number;
  failed: number;
  /** True when a gws auth failure stopped the run; remaining `selected`
   *  items are untouched so the user can re-authenticate and republish. */
  blocked: boolean;
  snapshot: TodaySnapshot;
}

// --- Commands --------------------------------------------------------------

export async function todayLogicalDay(
  workPath: string,
  nowIso: string,
  timezone: string,
  dayStart: string,
): Promise<LogicalDayInfo> {
  return todayInvoke<LogicalDayInfo>("today_logical_day", { workPath, nowIso, timezone, dayStart });
}

export async function todayOpen(
  workPath: string,
  nowIso: string,
  timezone: string,
  dayStart: string,
  sleepStart: string,
): Promise<TodaySnapshot> {
  return todayInvoke<TodaySnapshot>("today_open", { workPath, nowIso, timezone, dayStart, sleepStart });
}

export async function todayMutate(
  workPath: string,
  logicalDay: string,
  expectedRevision: string,
  mutation: TodayMutation,
): Promise<TodaySnapshot> {
  return todayInvoke<TodaySnapshot>("today_mutate", {
    workPath,
    logicalDay,
    expectedRevision,
    mutation,
  });
}

export async function todayRollover(
  workPath: string,
  nowIso: string,
  timezone: string,
  dayStart: string,
  sleepStart: string,
): Promise<TodayRolloverOutcome> {
  return todayInvoke<TodayRolloverOutcome>("today_rollover", {
    workPath,
    nowIso,
    timezone,
    dayStart,
    sleepStart,
  });
}

export async function readTaskEvents(
  workPath: string,
  month?: string | null,
  day?: string | null,
): Promise<TaskEvent[]> {
  return todayInvoke<TaskEvent[]>("read_task_events", {
    workPath,
    month: month ?? null,
    day: day ?? null,
  });
}

export async function taskTransition(
  workPath: string,
  request: TaskTransitionRequest,
): Promise<TaskTransitionOutcome> {
  return todayInvoke<TaskTransitionOutcome>("task_transition", { workPath, request });
}

export async function taskTrash(
  workPath: string,
  taskPath: string,
  expectedTaskHash: string,
  remoteDelete?: boolean | null,
): Promise<TaskTrashOutcome> {
  return todayInvoke<TaskTrashOutcome>("task_trash", {
    workPath,
    taskPath,
    expectedTaskHash,
    remoteDelete: remoteDelete ?? null,
  });
}

export async function taskIntegrationsDrain(
  workPath: string,
  nowIso: string,
  gwsPath?: string | null,
): Promise<DrainOutcome> {
  return todayInvoke<DrainOutcome>("task_integrations_drain", {
    workPath,
    nowIso,
    gwsPath: gwsPath ?? null,
  });
}

export async function taskIntegrationsRetry(
  workPath: string,
  ids: string[] | null,
  nowIso: string,
): Promise<RetryOutcome> {
  return todayInvoke<RetryOutcome>("task_integrations_retry", { workPath, ids: ids ?? null, nowIso });
}

export async function readTaskIntegrations(workPath: string): Promise<OutboxRecord[]> {
  return todayInvoke<OutboxRecord[]>("read_task_integrations", { workPath });
}

export async function todayNotifyNewDay(
  workPath: string,
  logicalDay: string,
  title?: string | null,
  body?: string | null,
): Promise<TodayNotifyOutcome> {
  return todayInvoke<TodayNotifyOutcome>("today_notify_new_day", {
    workPath,
    logicalDay,
    title: title ?? null,
    body: body ?? null,
  });
}

/** Busy intervals for one logical day from local calendar notes, clipped to
 *  the day window. `calendars` empty = all discovered notes; otherwise only
 *  notes whose `calendarId` (or `local`) is listed. */
export async function todayCalendarCommitments(
  workPath: string,
  logicalDay: string,
  timezone: string,
  dayStart: string,
  sleepStart: string,
  calendars: string[],
): Promise<CalendarCommitment[]> {
  return todayInvoke<CalendarCommitment[]>("today_calendar_commitments", {
    workPath,
    logicalDay,
    timezone,
    dayStart,
    sleepStart,
    calendars,
  });
}

/** Toggle ONE plan item's calendarSync between `none` and `selected`
 *  (explicit per-block opt-in). Never publishes. */
export async function taskCalendarSetSync(
  workPath: string,
  logicalDay: string,
  expectedRevision: string,
  itemRef: PlanItemRef,
  selected: boolean,
  destination?: string | null,
): Promise<TodaySnapshot> {
  return todayInvoke<TodaySnapshot>("task_calendar_set_sync", {
    workPath,
    logicalDay,
    expectedRevision,
    itemRef,
    selected,
    destination: destination ?? null,
  });
}

/** Publish every `selected` plan item with a proposedBlock to the destination
 *  calendar. Explicit policy: `none` items are never published. */
export async function todayCalendarPublish(
  workPath: string,
  logicalDay: string,
  expectedRevision: string,
  destination?: string | null,
  gwsPath?: string | null,
  nowIso?: string,
): Promise<CalendarPublishOutcome> {
  return todayInvoke<CalendarPublishOutcome>("today_calendar_publish", {
    workPath,
    logicalDay,
    expectedRevision,
    destination: destination ?? null,
    gwsPath: gwsPath ?? null,
    nowIso: nowIso ?? new Date().toISOString(),
  });
}

/** Request payload built by `today_build_plan_request` (Rust side owns the
 *  prompt/request assembly for the `maru_today_plan_v1` AI run). The shape is
 *  still stabilizing on the Rust side; keep this open-ended on purpose. */
export interface TodayPlanRequest {
  prompt?: string | null;
  [key: string]: unknown;
}

/** Ask Rust to assemble the plan-request payload (prompt + context) for one
 *  logical day. The result is handed to the AI runtime; the raw AI output then
 *  goes back through `todayApplyPlanResult`. */
export async function todayBuildPlanRequest(
  workPath: string,
  logicalDay: string,
): Promise<TodayPlanRequest> {
  return todayInvoke<TodayPlanRequest>("today_build_plan_request", { workPath, logicalDay });
}

/** Hand raw AI output for `maru_today_plan_v1` back to Rust for validation
 *  and application. `expectedRevision` is the snapshot revision the run
 *  started from (stale drafts are rejected), `validRefs` the item refs the
 *  plan may reference, `sleepStart` the day-window end used for sleep-boundary
 *  checks on proposed blocks. */
export async function todayApplyPlanResult(
  workPath: string,
  logicalDay: string,
  expectedRevision: string,
  outputJson: string,
  validRefs: PlanItemRef[],
  sleepStart: string,
): Promise<TodaySnapshot> {
  return todayInvoke<TodaySnapshot>("today_apply_plan_result", {
    workPath,
    logicalDay,
    expectedRevision,
    outputJson,
    validRefs,
    sleepStart,
  });
}

// --- Pure helpers ----------------------------------------------------------

/** sha256 hex of `text` — used for expected task hashes and content
 *  fingerprints (matches the Rust side's canonical-content hashing). */
export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Machine-readable error prefix Rust emits before `": "`
 *  (e.g. "today_conflict: expected revision ..." -> "today_conflict"). */
export function todayErrorCode(err: unknown): string | null {
  const message =
    typeof err === "string" ? err : err instanceof Error ? err.message : null;
  if (!message) return null;
  const index = message.indexOf(": ");
  if (index <= 0) return null;
  const code = message.slice(0, index);
  return /^[a-z][a-z0-9_]*$/.test(code) ? code : null;
}

/** Optimistic-concurrency conflict from `today_mutate` (stale revision). */
export function isTodayConflict(err: unknown): boolean {
  return todayErrorCode(err) === "today_conflict";
}

/** Optimistic-concurrency conflict from `task_transition` / `task_trash`
 *  (stale expected task hash). */
export function isTaskConflict(err: unknown): boolean {
  return todayErrorCode(err) === "task_conflict";
}
