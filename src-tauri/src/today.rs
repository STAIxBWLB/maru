// Maru Today — core domain types, logical-day math, and capacity math.
// Pure logic never reads the system clock: callers pass `now` as RFC3339
// (same convention as korean_date.rs). Types here mirror the TypeScript
// twin in src/lib/today.ts — keep field names stable.

use crate::vault::normalize_existing_dir;
use chrono::{DateTime, Duration, NaiveDate, NaiveTime, TimeZone, Timelike};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;

/// Hard cap on the "top" lane of a daily plan.
pub const TOP_LANE_MAX: usize = 3;
/// Estimate used for plan items the caller left without an estimate.
pub const PROVISIONAL_ESTIMATE_MINUTES: u32 = 30;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TodayRoute {
    Prepare,
    Execute,
    Review,
    Calendar,
    Capture,
    Upcoming,
    Log,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TodayStage {
    Prepare,
    Execute,
    Review,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DayState {
    Unstarted,
    Preparing,
    Planned,
    Skipped,
    Executing,
    Reviewed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PlanLane {
    Top,
    Flexible,
    Overflow,
}

/// Reference from a plan item (or carryover) to the thing it schedules.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum PlanItemRef {
    Task { task_id: String },
    Capture { capture_id: String },
}

impl PlanItemRef {
    pub fn id(&self) -> &str {
        match self {
            PlanItemRef::Task { task_id } => task_id,
            PlanItemRef::Capture { capture_id } => capture_id,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProposedBlock {
    pub start_iso: String,
    pub end_iso: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CalendarSyncStatus {
    None,
    Selected,
    Syncing,
    Synced,
    Error,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncState {
    #[serde(default)]
    pub status: CalendarSyncStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// Provider event id returned by a successful publish.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
    /// Destination calendar id captured at selection time (publish falls back
    /// to the command-level destination, then `primary`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub destination: Option<String>,
}

impl Default for CalendarSyncStatus {
    fn default() -> Self {
        CalendarSyncStatus::None
    }
}

impl CalendarSyncState {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn selected(destination: Option<String>) -> Self {
        Self {
            status: CalendarSyncStatus::Selected,
            message: None,
            event_id: None,
            destination,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyPlanItem {
    pub item_ref: PlanItemRef,
    #[serde(default)]
    pub lane: PlanLane,
    #[serde(default)]
    pub order: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_minutes: Option<u32>,
    #[serde(default)]
    pub estimate_provisional: bool,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proposed_block: Option<ProposedBlock>,
    #[serde(default)]
    pub calendar_sync: CalendarSyncState,
}

impl Default for PlanLane {
    fn default() -> Self {
        PlanLane::Flexible
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DailyPlanV1 {
    pub logical_day: String,
    /// Revision of the snapshot the plan was computed against. Enforced on
    /// `setPlan` so a stale AI draft cannot overwrite a newer day state.
    #[serde(default)]
    pub input_revision: String,
    #[serde(default)]
    pub top: Vec<DailyPlanItem>,
    #[serde(default)]
    pub flexible: Vec<DailyPlanItem>,
    #[serde(default)]
    pub overflow: Vec<DailyPlanItem>,
    #[serde(default)]
    pub reasons: Vec<String>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

impl DailyPlanV1 {
    pub fn items(&self) -> impl Iterator<Item = &DailyPlanItem> {
        self.top
            .iter()
            .chain(self.flexible.iter())
            .chain(self.overflow.iter())
    }

    pub fn items_mut(&mut self) -> impl Iterator<Item = &mut DailyPlanItem> {
        self.top
            .iter_mut()
            .chain(self.flexible.iter_mut())
            .chain(self.overflow.iter_mut())
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureConfidence {
    High,
    Medium,
    Low,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CaptureCandidate {
    pub capture_id: String,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_item_id: Option<String>,
    pub fingerprint: String,
    pub confidence: CaptureConfidence,
    #[serde(default)]
    pub category: String,
    pub title: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due_date: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub estimate_minutes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(default)]
    pub received_at: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CaptureDecision {
    AddToToday,
    Keep,
    Edit,
    Defer,
    Dismiss,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarCommitment {
    pub title: String,
    pub start_iso: String,
    pub end_iso: String,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapacitySummary {
    pub day_start: String,
    pub sleep_start: String,
    pub free_minutes: u32,
    pub busy_minutes: u32,
    /// Effective focus budget: `min(free_minutes, caller_cap)`.
    pub focus_cap_minutes: u32,
    pub proposed_minutes: u32,
    pub remaining_minutes: u32,
    pub over_capacity: bool,
    /// True when any planned item fell back to the provisional estimate.
    pub provisional: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceFreshness {
    pub source: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_loaded_at: Option<String>,
    #[serde(default)]
    pub stale: bool,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum YesterdayResolution {
    Today,
    Flexible,
    Defer,
    Cancel,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct YesterdayItem {
    pub task_id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolution: Option<YesterdayResolution>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CarryoverRef {
    pub item_ref: PlanItemRef,
    /// Logical day (YYYY-MM-DD) the item was carried over from.
    pub carried_from: String,
}

/// The per-day unit persisted at `<work>/.maru/today/YYYY-MM-DD.json`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TodaySnapshot {
    pub logical_day: String,
    pub generated_at: String,
    /// sha256 hex of the canonical JSON (this field blanked). Bumped on
    /// every mutation; checked by `today_mutate` for optimistic concurrency.
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub day_state: DayState,
    #[serde(default)]
    pub route: TodayRoute,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stage: Option<TodayStage>,
    #[serde(default)]
    pub timezone: String,
    #[serde(default)]
    pub day_start: String,
    #[serde(default)]
    pub sleep_start: String,
    #[serde(default)]
    pub brain_dump: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan: Option<DailyPlanV1>,
    #[serde(default)]
    pub yesterday: Vec<YesterdayItem>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capacity: Option<CapacitySummary>,
    #[serde(default)]
    pub carryovers: Vec<CarryoverRef>,
    #[serde(default)]
    pub sources: Vec<SourceFreshness>,
    /// True when rollover carried preparation content across a day boundary
    /// before the user confirmed or skipped it.
    #[serde(default)]
    pub unconfirmed_content: bool,
}

impl Default for DayState {
    fn default() -> Self {
        DayState::Unstarted
    }
}

impl Default for TodayRoute {
    fn default() -> Self {
        TodayRoute::Prepare
    }
}

impl TodaySnapshot {
    pub fn new(
        logical_day: String,
        generated_at: String,
        timezone: String,
        day_start: String,
        sleep_start: String,
    ) -> Self {
        Self {
            logical_day,
            generated_at,
            revision: String::new(),
            day_state: DayState::Unstarted,
            route: TodayRoute::Prepare,
            stage: Some(TodayStage::Prepare),
            timezone,
            day_start,
            sleep_start,
            brain_dump: String::new(),
            plan: None,
            yesterday: Vec::new(),
            capacity: None,
            carryovers: Vec::new(),
            sources: Vec::new(),
            unconfirmed_content: false,
        }
    }
}

/// Append-only event line in `<work>/.maru/today/events/YYYY-MM.jsonl`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskEvent {
    pub ts: String,
    /// Logical day the event belongs to. `ts` is UTC, so a timestamp-prefix
    /// filter misattributes early-morning events (03:30-09:00 KST land on the
    /// prior UTC date); day queries must use this field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    #[serde(default)]
    pub payload: JsonValue,
}

/// Serde-tagged mutation applied by `today_mutate`. The `type` tag is the
/// wire name the TypeScript twin sends.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum TodayMutation {
    SetRoute {
        route: TodayRoute,
    },
    SetBrainDump {
        brain_dump: String,
    },
    /// Unstarted/Preparing -> Planned (validates the stored plan).
    ConfirmSetup,
    /// Unstarted/Preparing -> Skipped.
    QuickSkip,
    ApplyYesterdayDecision {
        task_id: String,
        resolution: YesterdayResolution,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        defer_date: Option<String>,
    },
    SetPlan {
        plan: DailyPlanV1,
    },
    /// Explicit per-block calendar opt-in: toggles one plan item's
    /// `calendarSync` between `none` and `selected`. Never publishes.
    SetCalendarSync {
        item_ref: PlanItemRef,
        selected: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        destination: Option<String>,
    },
    /// Restore the previous revision snapshot (one step).
    Undo,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskSyncStatus {
    Local,
    Syncing,
    Synced,
    RetryNeeded,
    AuthBlocked,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum TaskTransitionKind {
    Complete,
    Reopen,
    Cancel,
    Defer,
}

/// Contract for the follow-up task-lifecycle commands. Types only — the
/// transition commands and the integration outbox are implemented later.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTransitionRequest {
    pub task_id: String,
    pub task_path: String,
    pub kind: TaskTransitionKind,
    /// sha256 of the task note content the caller based the transition on.
    pub expected_task_hash: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defer_date: Option<String>,
    /// Logical-day date (YYYY-MM-DD) written to `done` on complete and used
    /// for the event log month. Keeps the transition clock-free.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    /// RFC3339 timestamp written to `completedAt` and the event `ts`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub now_iso: Option<String>,
    #[serde(default)]
    pub payload: JsonValue,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTransitionOutcome {
    pub task_id: String,
    pub new_task_hash: String,
    pub bucket: String,
    pub sync_status: TaskSyncStatus,
}

// --- Day math (pure) -------------------------------------------------------

pub fn parse_timezone(iana: &str) -> Result<Tz, String> {
    iana.trim()
        .parse::<Tz>()
        .map_err(|_| format!("today_invalid_timezone: {iana}"))
}

fn parse_hhmm(value: &str) -> Option<NaiveTime> {
    let trimmed = value.trim();
    let (hour, minute) = trimmed.split_once(':')?;
    // Strict HH:MM — two digits each, nothing else.
    if hour.len() != 2 || minute.len() != 2 || trimmed.len() != 5 {
        return None;
    }
    let hour: u32 = hour.parse().ok()?;
    let minute: u32 = minute.parse().ok()?;
    NaiveTime::from_hms_opt(hour, minute, 0)
}

pub fn parse_day_start(value: &str) -> Result<NaiveTime, String> {
    parse_hhmm(value).ok_or_else(|| format!("today_invalid_day_start: {value}"))
}

pub fn parse_sleep_start(value: &str) -> Result<NaiveTime, String> {
    parse_hhmm(value).ok_or_else(|| format!("today_invalid_sleep_start: {value}"))
}

/// The logical day a moment belongs to: the civil date of `now - day_start`.
/// At exactly 03:30 with a 03:30 day start the new day begins; 03:29 is
/// still the previous logical day.
pub fn logical_day(now: DateTime<Tz>, day_start: NaiveTime) -> NaiveDate {
    (now.naive_local() - Duration::seconds(day_start.num_seconds_from_midnight() as i64)).date()
}

/// Resolve a local date+time in `tz`; fails on DST gap/overlap instead of
/// silently shifting the instant.
fn local_instant(tz: Tz, date: NaiveDate, time: NaiveTime) -> Result<DateTime<Tz>, String> {
    tz.from_local_datetime(&date.and_time(time))
        .single()
        .ok_or_else(|| format!("today_local_time_unresolvable: {date} {time} in {tz}"))
}

#[derive(Debug, Clone)]
pub struct BusyInterval {
    pub start: DateTime<Tz>,
    pub end: DateTime<Tz>,
}

/// Merge overlapping (and adjacent) busy intervals into a sorted, disjoint
/// set so double-booked time is never counted twice.
pub fn merge_busy_intervals(busy: &[BusyInterval]) -> Vec<BusyInterval> {
    let mut sorted: Vec<BusyInterval> = busy
        .iter()
        .filter(|interval| interval.end > interval.start)
        .cloned()
        .collect();
    sorted.sort_by_key(|interval| interval.start);
    let mut merged: Vec<BusyInterval> = Vec::with_capacity(sorted.len());
    for interval in sorted {
        match merged.last_mut() {
            Some(last) if interval.start <= last.end => {
                if interval.end > last.end {
                    last.end = interval.end;
                }
            }
            _ => merged.push(interval),
        }
    }
    merged
}

/// Sum plan-lane minutes (top + flexible; overflow is by definition beyond
/// the day). Missing estimates fall back to `provisional_default`, in which
/// case the returned flag is true.
pub fn planned_minutes(plan: &DailyPlanV1, provisional_default: u32) -> (u32, bool) {
    let mut total = 0u32;
    let mut provisional = false;
    for item in plan.top.iter().chain(plan.flexible.iter()) {
        match item.estimate_minutes {
            Some(minutes) => total = total.saturating_add(minutes),
            None => {
                total = total.saturating_add(provisional_default);
                provisional = true;
            }
        }
        if item.estimate_provisional {
            provisional = true;
        }
    }
    (total, provisional)
}

/// Free/busy/focus math for one logical day. The day window runs from
/// `day_start` on the logical day to `sleep_start` (next civil day when
/// `sleep_start <= day_start`).
#[allow(clippy::too_many_arguments)]
pub fn compute_capacity(
    tz: Tz,
    day: NaiveDate,
    day_start: NaiveTime,
    sleep_start: NaiveTime,
    busy: &[BusyInterval],
    focus_cap_minutes: u32,
    proposed_minutes: u32,
    provisional: bool,
) -> Result<CapacitySummary, String> {
    let start = local_instant(tz, day, day_start)?;
    let sleep_date = if sleep_start > day_start {
        day
    } else {
        day + Duration::days(1)
    };
    let end = local_instant(tz, sleep_date, sleep_start)?;
    if end <= start {
        return Err(format!("today_invalid_day_window: {day_start}-{sleep_start}"));
    }
    let window_minutes = (end - start).num_minutes().max(0) as u32;
    let busy_minutes = merge_busy_intervals(busy)
        .iter()
        .map(|interval| {
            let clipped_start = interval.start.max(start);
            let clipped_end = interval.end.min(end);
            (clipped_end - clipped_start).num_minutes().max(0) as u32
        })
        .sum::<u32>()
        .min(window_minutes);
    let free_minutes = window_minutes - busy_minutes;
    let focus = free_minutes.min(focus_cap_minutes);
    Ok(CapacitySummary {
        day_start: day_start.format("%H:%M").to_string(),
        sleep_start: sleep_start.format("%H:%M").to_string(),
        free_minutes,
        busy_minutes,
        focus_cap_minutes: focus,
        proposed_minutes,
        remaining_minutes: focus.saturating_sub(proposed_minutes),
        over_capacity: proposed_minutes > focus,
        provisional,
    })
}

/// True when the proposed block violates the sleep boundary of its start
/// date: any block ending past the boundary (straddling it or lying wholly
/// inside the sleep window). A block ending exactly at sleep is fine. The
/// boundary is resolved in the configured timezone, not the block's own
/// offset, so a DST transition or a wrong AI-supplied offset cannot shift
/// the cutoff.
/// ponytail: early-morning blocks on the next civil day (before dayStart)
/// still pass; reject via a full day-window check if that ever matters.
pub fn block_crosses_sleep(
    block: &ProposedBlock,
    sleep_start: NaiveTime,
    tz: Tz,
) -> Result<bool, String> {
    let start = DateTime::parse_from_rfc3339(&block.start_iso)
        .map_err(|err| format!("today_invalid_block: {err}"))?
        .with_timezone(&tz);
    let end = DateTime::parse_from_rfc3339(&block.end_iso)
        .map_err(|err| format!("today_invalid_block: {err}"))?
        .with_timezone(&tz);
    if end <= start {
        return Err("today_invalid_block: end must be after start".to_string());
    }
    let sleep_naive = start.date_naive().and_time(sleep_start);
    let sleep = tz
        .from_local_datetime(&sleep_naive)
        .earliest()
        .ok_or_else(|| "today_invalid_block: unresolvable sleep boundary".to_string())?;
    Ok(end > sleep)
}

/// Validate a plan before it is stored: top lane cap, no duplicate item
/// refs, and the sleep-boundary guard on every proposed block.
pub fn validate_plan(plan: &DailyPlanV1, sleep_start: NaiveTime, tz: Tz) -> Result<(), String> {
    if plan.top.len() > TOP_LANE_MAX {
        return Err(format!(
            "today_plan_top_exceeded: {} > {TOP_LANE_MAX}",
            plan.top.len()
        ));
    }
    let mut seen: Vec<&PlanItemRef> = Vec::new();
    for item in plan.items() {
        if seen.contains(&&item.item_ref) {
            return Err(format!(
                "today_plan_duplicate_ref: {}",
                item.item_ref.id()
            ));
        }
        seen.push(&item.item_ref);
        if let Some(block) = &item.proposed_block {
            if block_crosses_sleep(block, sleep_start, tz)? {
                return Err(format!(
                    "today_block_crosses_sleep: {} {}-{}",
                    item.item_ref.id(),
                    block.start_iso,
                    block.end_iso
                ));
            }
        }
    }
    Ok(())
}

// --- Commands --------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LogicalDayInfo {
    pub logical_day: String,
    pub previous_logical_day: String,
    /// True once local time has passed today's day start (the fresh logical
    /// day began this civil morning); false while still in yesterday's tail.
    pub is_new_day_boundary: bool,
}

#[tauri::command]
pub fn today_logical_day(
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
) -> Result<LogicalDayInfo, String> {
    let _work = normalize_existing_dir(&work_path)?;
    let tz = parse_timezone(&timezone)?;
    let day_start = parse_day_start(&day_start)?;
    let now = DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?
        .with_timezone(&tz);
    let day = logical_day(now, day_start);
    Ok(LogicalDayInfo {
        logical_day: day.format("%Y-%m-%d").to_string(),
        previous_logical_day: (day - Duration::days(1)).format("%Y-%m-%d").to_string(),
        is_new_day_boundary: now.time() >= day_start,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seoul_now(iso: &str) -> DateTime<Tz> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&parse_timezone("Asia/Seoul").unwrap())
    }

    fn ny_now(iso: &str) -> DateTime<Tz> {
        DateTime::parse_from_rfc3339(iso)
            .unwrap()
            .with_timezone(&parse_timezone("America/New_York").unwrap())
    }

    fn day_start() -> NaiveTime {
        parse_day_start("03:30").unwrap()
    }

    #[test]
    fn logical_day_flips_exactly_at_day_start_seoul() {
        let before = seoul_now("2026-07-21T03:29:59+09:00");
        let at = seoul_now("2026-07-21T03:30:00+09:00");
        assert_eq!(
            logical_day(before, day_start()),
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap()
        );
        assert_eq!(
            logical_day(at, day_start()),
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap()
        );
    }

    #[test]
    fn logical_day_uses_configured_tz_not_utc() {
        // 2026-07-20T18:29:59Z is 03:29:59 on 07-21 in Seoul — still 07-20.
        let before = seoul_now("2026-07-20T18:29:59Z");
        let at = seoul_now("2026-07-20T18:30:00Z");
        assert_eq!(
            logical_day(before, day_start()),
            NaiveDate::from_ymd_opt(2026, 7, 20).unwrap()
        );
        assert_eq!(
            logical_day(at, day_start()),
            NaiveDate::from_ymd_opt(2026, 7, 21).unwrap()
        );
    }

    #[test]
    fn logical_day_survives_spring_forward_new_york() {
        // 2026-03-08 spring forward: 02:00 EST -> 03:00 EDT.
        let before = ny_now("2026-03-08T03:29:59-04:00");
        let at = ny_now("2026-03-08T03:30:00-04:00");
        assert_eq!(
            logical_day(before, day_start()),
            NaiveDate::from_ymd_opt(2026, 3, 7).unwrap()
        );
        assert_eq!(
            logical_day(at, day_start()),
            NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()
        );
        // An hour before the gap (still EST) belongs to the previous day.
        let est = ny_now("2026-03-08T01:30:00-05:00");
        assert_eq!(
            logical_day(est, day_start()),
            NaiveDate::from_ymd_opt(2026, 3, 7).unwrap()
        );
    }

    #[test]
    fn rejects_bad_timezone_and_day_start() {
        assert!(parse_timezone("Mars/Olympus")
            .unwrap_err()
            .starts_with("today_invalid_timezone"));
        assert!(parse_day_start("25:00")
            .unwrap_err()
            .starts_with("today_invalid_day_start"));
        assert!(parse_day_start("3:30")
            .unwrap_err()
            .starts_with("today_invalid_day_start"));
        assert!(parse_sleep_start("21:60")
            .unwrap_err()
            .starts_with("today_invalid_sleep_start"));
    }

    #[test]
    fn merges_overlapping_busy_intervals() {
        let tz = parse_timezone("Asia/Seoul").unwrap();
        let at = |h: u32, m: u32| {
            tz.with_ymd_and_hms(2026, 7, 21, h, m, 0).single().unwrap()
        };
        let busy = vec![
            BusyInterval { start: at(10, 0), end: at(11, 0) },
            BusyInterval { start: at(10, 30), end: at(12, 0) },
            BusyInterval { start: at(14, 0), end: at(14, 30) },
        ];
        let merged = merge_busy_intervals(&busy);
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].start, at(10, 0));
        assert_eq!(merged[0].end, at(12, 0));
    }

    #[test]
    fn capacity_subtracts_merged_busy_and_enforces_focus_cap() {
        let tz = parse_timezone("Asia/Seoul").unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let at = |h: u32, m: u32| {
            tz.from_local_datetime(&day.and_time(NaiveTime::from_hms_opt(h, m, 0).unwrap()))
                .single()
                .unwrap()
        };
        let busy = vec![
            BusyInterval { start: at(10, 0), end: at(11, 0) },
            BusyInterval { start: at(10, 30), end: at(12, 0) },
        ];
        // 03:30 -> 21:30 = 1080 min window; busy merges to 120 min.
        let summary = compute_capacity(
            tz,
            day,
            day_start(),
            parse_sleep_start("21:30").unwrap(),
            &busy,
            480,
            300,
            false,
        )
        .unwrap();
        assert_eq!(summary.busy_minutes, 120);
        assert_eq!(summary.free_minutes, 960);
        assert_eq!(summary.focus_cap_minutes, 480);
        assert_eq!(summary.remaining_minutes, 180);
        assert!(!summary.over_capacity);
    }

    #[test]
    fn capacity_flags_over_capacity() {
        let tz = parse_timezone("Asia/Seoul").unwrap();
        let day = NaiveDate::from_ymd_opt(2026, 7, 21).unwrap();
        let summary = compute_capacity(
            tz,
            day,
            day_start(),
            parse_sleep_start("21:30").unwrap(),
            &[],
            480,
            500,
            false,
        )
        .unwrap();
        assert!(summary.over_capacity);
        assert_eq!(summary.remaining_minutes, 0);
    }

    #[test]
    fn missing_estimates_fall_back_to_provisional_default() {
        let plan = DailyPlanV1 {
            logical_day: "2026-07-21".to_string(),
            input_revision: String::new(),
            top: vec![DailyPlanItem {
                item_ref: PlanItemRef::Task { task_id: "a".to_string() },
                lane: PlanLane::Top,
                order: 0,
                outcome: None,
                estimate_minutes: None,
                estimate_provisional: false,
                pinned: false,
                proposed_block: None,
                calendar_sync: CalendarSyncState::none(),
            }],
            flexible: vec![DailyPlanItem {
                item_ref: PlanItemRef::Task { task_id: "b".to_string() },
                lane: PlanLane::Flexible,
                order: 0,
                outcome: None,
                estimate_minutes: Some(60),
                estimate_provisional: false,
                pinned: false,
                proposed_block: None,
                calendar_sync: CalendarSyncState::none(),
            }],
            overflow: vec![],
            reasons: vec![],
            warnings: vec![],
        };
        let (minutes, provisional) = planned_minutes(&plan, PROVISIONAL_ESTIMATE_MINUTES);
        assert_eq!(minutes, 90);
        assert!(provisional);
    }

    #[test]
    fn block_crossing_sleep_start_is_rejected() {
        let sleep = parse_sleep_start("21:30").unwrap();
        let tz = parse_timezone("Asia/Seoul").unwrap();
        let crossing = ProposedBlock {
            start_iso: "2026-07-21T21:00:00+09:00".to_string(),
            end_iso: "2026-07-21T22:00:00+09:00".to_string(),
        };
        assert!(block_crosses_sleep(&crossing, sleep, tz).unwrap());
        // Wholly inside the sleep window: also rejected, not just straddles.
        let inside = ProposedBlock {
            start_iso: "2026-07-21T22:00:00+09:00".to_string(),
            end_iso: "2026-07-21T23:00:00+09:00".to_string(),
        };
        assert!(block_crosses_sleep(&inside, sleep, tz).unwrap());
        let ok = ProposedBlock {
            start_iso: "2026-07-21T20:00:00+09:00".to_string(),
            end_iso: "2026-07-21T21:30:00+09:00".to_string(),
        };
        assert!(!block_crosses_sleep(&ok, sleep, tz).unwrap());
        // The boundary follows the configured timezone, not the block's own
        // offset: 12:00Z is 21:00 KST, so ending at 13:30Z (22:30 KST) is
        // past the KST boundary even though the UTC-naive reading is not.
        let utc_offset = ProposedBlock {
            start_iso: "2026-07-21T12:00:00+00:00".to_string(),
            end_iso: "2026-07-21T13:30:00+00:00".to_string(),
        };
        assert!(block_crosses_sleep(&utc_offset, sleep, tz).unwrap());
        let backwards = ProposedBlock {
            start_iso: "2026-07-21T22:00:00+09:00".to_string(),
            end_iso: "2026-07-21T21:00:00+09:00".to_string(),
        };
        assert!(block_crosses_sleep(&backwards, sleep, tz)
            .unwrap_err()
            .starts_with("today_invalid_block"));
    }

    #[test]
    fn validate_plan_enforces_top_cap_and_sleep_guard() {
        let item = |id: &str, block: Option<ProposedBlock>| DailyPlanItem {
            item_ref: PlanItemRef::Task { task_id: id.to_string() },
            lane: PlanLane::Top,
            order: 0,
            outcome: None,
            estimate_minutes: None,
            estimate_provisional: false,
            pinned: false,
            proposed_block: block,
            calendar_sync: CalendarSyncState::none(),
        };
        let sleep = parse_sleep_start("21:30").unwrap();
        let tz = parse_timezone("Asia/Seoul").unwrap();
        let mut plan = DailyPlanV1 {
            logical_day: "2026-07-21".to_string(),
            input_revision: String::new(),
            top: vec![item("a", None), item("b", None), item("c", None), item("d", None)],
            flexible: vec![],
            overflow: vec![],
            reasons: vec![],
            warnings: vec![],
        };
        assert!(validate_plan(&plan, sleep, tz)
            .unwrap_err()
            .starts_with("today_plan_top_exceeded"));
        plan.top.truncate(3);
        plan.top[0].proposed_block = Some(ProposedBlock {
            start_iso: "2026-07-21T21:00:00+09:00".to_string(),
            end_iso: "2026-07-21T22:00:00+09:00".to_string(),
        });
        assert!(validate_plan(&plan, sleep, tz)
            .unwrap_err()
            .starts_with("today_block_crosses_sleep"));
        plan.top[0].proposed_block = None;
        assert!(validate_plan(&plan, sleep, tz).is_ok());
        // Same ref in two lanes: rejected regardless of lane.
        plan.flexible = vec![item("a", None)];
        assert!(validate_plan(&plan, sleep, tz)
            .unwrap_err()
            .starts_with("today_plan_duplicate_ref"));
    }

    #[test]
    fn today_logical_day_command_reports_boundary_flag() {
        let tmp = tempfile::tempdir().unwrap();
        let info = today_logical_day(
            tmp.path().to_string_lossy().to_string(),
            "2026-07-21T03:29:59+09:00".to_string(),
            "Asia/Seoul".to_string(),
            "03:30".to_string(),
        )
        .unwrap();
        assert_eq!(info.logical_day, "2026-07-20");
        assert_eq!(info.previous_logical_day, "2026-07-19");
        assert!(!info.is_new_day_boundary);
        let info = today_logical_day(
            tmp.path().to_string_lossy().to_string(),
            "2026-07-21T10:00:00+09:00".to_string(),
            "Asia/Seoul".to_string(),
            "03:30".to_string(),
        )
        .unwrap();
        assert_eq!(info.logical_day, "2026-07-21");
        assert!(info.is_new_day_boundary);
    }
}
