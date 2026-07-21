// Maru Today — per-workspace persistence: day state files with sha256
// revisions, revision snapshots, an append-only JSONL event log, day
// rollover, and the tasks/daily journal projection.
//
// Layout under `<work>/.maru/today/`:
//   YYYY-MM-DD.json                current TodaySnapshot per logical day
//   revisions/YYYY-MM-DD/<rev>.json  pre-overwrite snapshots (latest 20 kept)
//   events/YYYY-MM.jsonl           append-only TaskEvent lines
//   outbox/                        reserved for the integration outbox

use crate::atomic_file::write_atomic;
use crate::document::revision_for;
use crate::today::{
    logical_day, parse_day_start, parse_sleep_start, parse_timezone, validate_plan, CalendarSyncState,
    CarryoverRef, DayState, PlanItemRef, TaskEvent, TodayMutation, TodaySnapshot, TodayStage,
    YesterdayItem,
};
use crate::vault::normalize_existing_dir;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashMap;
use std::fs::{self, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::SystemTime;

const REVISION_RETENTION: usize = 20;
pub const JOURNAL_START_MARKER: &str = "<!-- maru:today:start -->";
pub const JOURNAL_END_MARKER: &str = "<!-- maru:today:end -->";

// --- Paths -----------------------------------------------------------------

pub fn today_dir(work: &Path) -> PathBuf {
    work.join(".maru").join("today")
}

/// Directory the integration outbox drains from. Helper only — the outbox
/// itself is implemented by the task-lifecycle follow-up.
pub fn outbox_dir(work_path: &str) -> Result<PathBuf, String> {
    let work = normalize_existing_dir(work_path)?;
    Ok(today_dir(&work).join("outbox"))
}

fn state_path(work: &Path, day: &str) -> PathBuf {
    today_dir(work).join(format!("{day}.json"))
}

fn revisions_dir(work: &Path, day: &str) -> PathBuf {
    today_dir(work).join("revisions").join(day)
}

fn events_path(work: &Path, month: &str) -> PathBuf {
    today_dir(work).join("events").join(format!("{month}.jsonl"))
}

fn validate_logical_day(day: &str) -> Result<(), String> {
    let parsed = NaiveDate::parse_from_str(day, "%Y-%m-%d")
        .map_err(|_| format!("today_invalid_logical_day: {day}"))?;
    if parsed.format("%Y-%m-%d").to_string() != day {
        return Err(format!("today_invalid_logical_day: {day}"));
    }
    Ok(())
}

fn validate_month(month: &str) -> Result<(), String> {
    if month.len() == 7 && month.chars().nth(4) == Some('-') {
        validate_logical_day(&format!("{month}-01")).map_err(|_| {
            format!("today_invalid_month: {month}")
        })?;
        return Ok(());
    }
    Err(format!("today_invalid_month: {month}"))
}

// --- Canonical serialization + revision ------------------------------------

/// Canonical JSON has the revision field blanked, so the hash of a snapshot
/// is stable regardless of the embedded revision value.
fn canonical_json(snapshot: &TodaySnapshot) -> Result<String, String> {
    let mut clone = snapshot.clone();
    clone.revision = String::new();
    serde_json::to_string_pretty(&clone)
        .map_err(|err| format!("Cannot serialize today snapshot: {err}"))
}

/// Recompute the revision from canonical content and atomically persist.
pub(crate) fn persist_snapshot(work: &Path, snapshot: &mut TodaySnapshot) -> Result<(), String> {
    snapshot.revision = revision_for(&canonical_json(snapshot)?);
    let json = serde_json::to_string_pretty(snapshot)
        .map_err(|err| format!("Cannot serialize today snapshot: {err}"))?;
    write_atomic(&state_path(work, &snapshot.logical_day), json.as_bytes())
}

// --- Revision snapshots ----------------------------------------------------

/// Snapshot the current on-disk content before it is overwritten, then
/// prune to the latest `REVISION_RETENTION` revisions.
pub(crate) fn snapshot_revision(
    work: &Path,
    snapshot: &TodaySnapshot,
    raw: &str,
) -> Result<(), String> {
    let dir = revisions_dir(work, &snapshot.logical_day);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Cannot create today revisions directory: {err}"))?;
    let revision = if snapshot.revision.is_empty() {
        revision_for(raw)
    } else {
        snapshot.revision.clone()
    };
    fs::write(dir.join(format!("{revision}.json")), raw)
        .map_err(|err| format!("Cannot write today revision snapshot: {err}"))?;
    prune_revisions(&dir)
}

fn list_revisions(dir: &Path) -> Vec<(PathBuf, SystemTime, String)> {
    let mut entries: Vec<(PathBuf, SystemTime, String)> = Vec::new();
    let Ok(read_dir) = fs::read_dir(dir) else {
        return entries;
    };
    for entry in read_dir.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|meta| meta.modified())
            .unwrap_or(SystemTime::UNIX_EPOCH);
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push((path, mtime, name));
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| b.2.cmp(&a.2)));
    entries
}

fn prune_revisions(dir: &Path) -> Result<(), String> {
    for (path, _, _) in list_revisions(dir).into_iter().skip(REVISION_RETENTION) {
        fs::remove_file(&path)
            .map_err(|err| format!("Cannot prune today revision {}: {err}", path.display()))?;
    }
    Ok(())
}

/// Newest revision file that still parses as a snapshot, newest first.
fn newest_valid_revision(
    work: &Path,
    day: &str,
    excluding: Option<&str>,
) -> Option<(String, TodaySnapshot)> {
    for (path, _, name) in list_revisions(&revisions_dir(work, day)) {
        if let Some(excluded) = excluding {
            if name.trim_end_matches(".json") == excluded {
                continue;
            }
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(snapshot) = serde_json::from_str::<TodaySnapshot>(&raw) {
            return Some((raw, snapshot));
        }
    }
    None
}

// --- Event log --------------------------------------------------------------

fn append_lock_for(path: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = path.to_path_buf();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "today_event_lock_registry_poisoned".to_string())?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
}

pub fn append_task_event_at(path: &Path, event: &TaskEvent) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create today event directory: {err}"))?;
    }
    let json = serde_json::to_string(event)
        .map_err(|err| format!("Cannot serialize task event: {err}"))?;
    let line = format!("{json}\n");
    let append_lock = append_lock_for(path)?;
    let _guard = append_lock
        .lock()
        .map_err(|_| "today_event_append_lock_poisoned".to_string())?;
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|err| format!("Cannot open task event log: {err}"))?;
    file.write_all(line.as_bytes())
        .map_err(|err| format!("Cannot append task event: {err}"))
}

fn append_task_event(
    work: &Path,
    logical_day: &str,
    kind: &str,
    task_id: Option<String>,
    payload: JsonValue,
) -> Result<(), String> {
    let event = TaskEvent {
        ts: Utc::now().to_rfc3339(),
        kind: kind.to_string(),
        task_id,
        payload,
    };
    append_task_event_at(&events_path(work, &logical_day[..7]), &event)
}

/// Append an event with a caller-supplied timestamp/logical day — the
/// clock-free variant used by the task lifecycle commands.
pub(crate) fn append_task_event_for(
    work: &Path,
    logical_day: &str,
    kind: &str,
    task_id: Option<String>,
    payload: JsonValue,
    ts: String,
) -> Result<(), String> {
    let event = TaskEvent {
        ts,
        kind: kind.to_string(),
        task_id,
        payload,
    };
    append_task_event_at(&events_path(work, &logical_day[..7]), &event)
}

/// Best-effort reflection of a task lifecycle transition in the day's
/// snapshot. Only the yesterday list carries a per-task status, so plan
/// membership is detected but only yesterday entries are patched. Returns
/// `Ok(false)` when the day state is absent or the task appears nowhere;
/// callers never fail a transition over this.
pub(crate) fn note_task_transition(
    work: &Path,
    logical_day: &str,
    task_id: &str,
    status: &str,
) -> Result<bool, String> {
    let Ok(raw) = fs::read_to_string(state_path(work, logical_day)) else {
        return Ok(false);
    };
    let Ok(mut snapshot) = serde_json::from_str::<TodaySnapshot>(&raw) else {
        return Ok(false);
    };
    let mut touched = false;
    for item in snapshot.yesterday.iter_mut() {
        if item.task_id == task_id {
            item.status = status.to_string();
            touched = true;
        }
    }
    let in_plan = snapshot.plan.as_ref().is_some_and(|plan| {
        plan.items().any(|item| match &item.item_ref {
            PlanItemRef::Task { task_id: id } => id == task_id,
            _ => false,
        })
    });
    if touched {
        snapshot.generated_at = Utc::now().to_rfc3339();
        persist_snapshot(work, &mut snapshot)?;
    }
    Ok(touched || in_plan)
}

fn read_events_at(path: &Path) -> Result<Vec<TaskEvent>, String> {
    let file = fs::File::open(path).map_err(|err| format!("Cannot read task event log: {err}"))?;
    let reader = BufReader::new(file);
    let mut events = Vec::new();
    for (line_no, line) in reader.lines().enumerate() {
        let line = line.map_err(|err| format!("Cannot read task event line: {err}"))?;
        if line.trim().is_empty() {
            continue;
        }
        let event: TaskEvent = serde_json::from_str(&line).map_err(|err| {
            format!(
                "Cannot parse task event {} in {}: {err}",
                line_no + 1,
                path.display()
            )
        })?;
        events.push(event);
    }
    Ok(events)
}

// --- Commands ---------------------------------------------------------------

/// Read the persisted snapshot for a logical day without mutating anything.
pub(crate) fn load_snapshot(work: &Path, logical_day: &str) -> Result<TodaySnapshot, String> {
    Ok(load_snapshot_with_raw(work, logical_day)?.1)
}

/// Read the persisted snapshot together with its raw on-disk JSON (needed by
/// commands that snapshot the pre-overwrite revision themselves).
pub(crate) fn load_snapshot_with_raw(
    work: &Path,
    logical_day: &str,
) -> Result<(String, TodaySnapshot), String> {
    validate_logical_day(logical_day)?;
    let raw = fs::read_to_string(state_path(work, logical_day))
        .map_err(|_| "today_state_missing".to_string())?;
    let snapshot: TodaySnapshot =
        serde_json::from_str(&raw).map_err(|err| format!("today_state_corrupt: {err}"))?;
    Ok((raw, snapshot))
}

/// Optimistic-concurrency guard shared by every revision-checked command.
pub(crate) fn check_revision(
    snapshot: &TodaySnapshot,
    expected_revision: &str,
) -> Result<(), String> {
    if snapshot.revision != expected_revision {
        return Err(format!(
            "today_conflict: expected revision {expected_revision}, found {}",
            snapshot.revision
        ));
    }
    Ok(())
}

/// Load the snapshot for the logical day containing `now`, initializing and
/// persisting a fresh one when missing. Corrupt state JSON falls back to the
/// newest valid revision snapshot (logging `state_recovered`); with no valid
/// revision the day starts fresh.
#[tauri::command]
pub fn today_open(
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodaySnapshot, String> {
    let work = normalize_existing_dir(&work_path)?;
    let tz = parse_timezone(&timezone)?;
    let day_start_time = parse_day_start(&day_start)?;
    parse_sleep_start(&sleep_start)?;
    let now = DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?
        .with_timezone(&tz);
    let day = logical_day(now, day_start_time)
        .format("%Y-%m-%d")
        .to_string();
    // Best-effort integration-outbox recovery: reconcile crash-interrupted
    // `prepared`/`syncing` records. Never fails open — a recovery error is
    // logged to the day's event log and opening continues.
    if let Err(err) = crate::today_outbox::recover_outbox(&work) {
        let _ = append_task_event(
            &work,
            &day,
            "outbox_recovery_failed",
            None,
            json!({ "error": err }),
        );
    }
    if let Ok(raw) = fs::read_to_string(state_path(&work, &day)) {
        let parsed = serde_json::from_str::<TodaySnapshot>(&raw)
            .ok()
            .filter(|snapshot: &TodaySnapshot| snapshot.logical_day == day);
        if let Some(snapshot) = parsed {
            return Ok(snapshot);
        }
        // Corrupt (or stale-day) state: recover from the newest valid revision.
        if let Some((_, mut snapshot)) = newest_valid_revision(&work, &day, None) {
            persist_snapshot(&work, &mut snapshot)?;
            append_task_event(
                &work,
                &day,
                "state_recovered",
                None,
                json!({ "revision": snapshot.revision }),
            )?;
            return Ok(snapshot);
        }
    }
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Create)?;
    let mut snapshot = TodaySnapshot::new(day, now_iso, timezone, day_start, sleep_start);
    persist_snapshot(&work, &mut snapshot)?;
    Ok(snapshot)
}

/// Apply a single mutation against the current day state. Optimistic
/// concurrency: `expected_revision` must match the stored revision.
#[tauri::command]
pub fn today_mutate(
    work_path: String,
    logical_day: String,
    expected_revision: String,
    mutation: TodayMutation,
) -> Result<TodaySnapshot, String> {
    validate_logical_day(&logical_day)?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let raw = fs::read_to_string(state_path(&work, &logical_day))
        .map_err(|_| "today_state_missing".to_string())?;
    let mut snapshot: TodaySnapshot = serde_json::from_str(&raw)
        .map_err(|err| format!("today_state_corrupt: {err}"))?;
    if snapshot.revision != expected_revision {
        return Err(format!(
            "today_conflict: expected revision {expected_revision}, found {}",
            snapshot.revision
        ));
    }
    let event_kind: &str;
    if matches!(mutation, TodayMutation::Undo) {
        // One step only: the previous head is restored, but undoing twice in
        // a row would just ping-pong, so a second undo is rejected until a
        // new mutation lands (tracked via the day's event log).
        if last_mutation_event_kind(&work, &logical_day)? == Some("undo".to_string()) {
            return Err("today_undo_unavailable".to_string());
        }
        let Some((_, restored)) =
            newest_valid_revision(&work, &logical_day, Some(&snapshot.revision))
        else {
            return Err("today_undo_unavailable".to_string());
        };
        snapshot_revision(&work, &snapshot, &raw)?;
        snapshot = restored;
        event_kind = "undo";
    } else {
        snapshot_revision(&work, &snapshot, &raw)?;
        event_kind = apply_mutation(&mut snapshot, &mutation)?;
    }
    snapshot.generated_at = Utc::now().to_rfc3339();
    persist_snapshot(&work, &mut snapshot)?;
    let (task_id, payload) = mutation_event_details(&logical_day, &mutation)?;
    append_task_event(&work, &logical_day, event_kind, task_id, payload)?;
    if matches!(snapshot.day_state, DayState::Planned | DayState::Skipped) {
        project_journal(&work, &work.join("tasks"), &snapshot)?;
    }
    Ok(snapshot)
}

fn apply_mutation(
    snapshot: &mut TodaySnapshot,
    mutation: &TodayMutation,
) -> Result<&'static str, String> {
    match mutation {
        TodayMutation::SetRoute { route } => {
            snapshot.route = *route;
            Ok("route_set")
        }
        TodayMutation::SetBrainDump { brain_dump } => {
            snapshot.brain_dump = brain_dump.clone();
            if snapshot.day_state == DayState::Unstarted {
                snapshot.day_state = DayState::Preparing;
                snapshot.stage = Some(TodayStage::Prepare);
            }
            Ok("brain_dump_set")
        }
        TodayMutation::ConfirmSetup => {
            if !matches!(
                snapshot.day_state,
                DayState::Unstarted | DayState::Preparing
            ) {
                return Err(format!(
                    "today_invalid_transition: confirmSetup from {:?}",
                    snapshot.day_state
                ));
            }
            if let Some(plan) = &snapshot.plan {
                validate_plan(plan, parse_sleep_start(&snapshot.sleep_start)?)?;
            }
            snapshot.day_state = DayState::Planned;
            snapshot.stage = Some(TodayStage::Execute);
            Ok("setup_confirmed")
        }
        TodayMutation::QuickSkip => {
            if !matches!(
                snapshot.day_state,
                DayState::Unstarted | DayState::Preparing
            ) {
                return Err(format!(
                    "today_invalid_transition: quickSkip from {:?}",
                    snapshot.day_state
                ));
            }
            snapshot.day_state = DayState::Skipped;
            snapshot.stage = Some(TodayStage::Execute);
            Ok("day_skipped")
        }
        TodayMutation::ApplyYesterdayDecision {
            task_id,
            resolution,
            defer_date,
        } => {
            let item = snapshot
                .yesterday
                .iter_mut()
                .find(|item| item.task_id == *task_id)
                .ok_or_else(|| format!("today_yesterday_item_missing: {task_id}"))?;
            item.resolution = Some(*resolution);
            item.defer_date = defer_date.clone();
            Ok("yesterday_decision")
        }
        TodayMutation::SetPlan { plan } => {
            if plan.input_revision != snapshot.revision {
                return Err(format!(
                    "today_conflict: expected revision {}, found {}",
                    plan.input_revision, snapshot.revision
                ));
            }
            if plan.logical_day != snapshot.logical_day {
                return Err(format!(
                    "today_plan_day_mismatch: {} != {}",
                    plan.logical_day, snapshot.logical_day
                ));
            }
            validate_plan(plan, parse_sleep_start(&snapshot.sleep_start)?)?;
            snapshot.plan = Some(plan.clone());
            if matches!(snapshot.day_state, DayState::Unstarted | DayState::Preparing) {
                snapshot.day_state = DayState::Preparing;
            }
            Ok("plan_set")
        }
        TodayMutation::SetCalendarSync {
            item_ref,
            selected,
            destination,
        } => {
            let plan = snapshot
                .plan
                .as_mut()
                .ok_or_else(|| "today_plan_missing".to_string())?;
            let item = plan
                .items_mut()
                .find(|item| item.item_ref == *item_ref)
                .ok_or_else(|| format!("today_plan_item_missing: {}", item_ref.id()))?;
            item.calendar_sync = if *selected {
                CalendarSyncState::selected(destination.clone())
            } else {
                CalendarSyncState::none()
            };
            Ok("calendar_sync_set")
        }
        TodayMutation::Undo => unreachable!("undo is handled before apply_mutation"),
    }
}

fn mutation_event_details(
    logical_day: &str,
    mutation: &TodayMutation,
) -> Result<(Option<String>, JsonValue), String> {
    let task_id = match mutation {
        TodayMutation::ApplyYesterdayDecision { task_id, .. } => Some(task_id.clone()),
        _ => None,
    };
    let payload = json!({
        "logicalDay": logical_day,
        "mutation": serde_json::to_value(mutation)
            .map_err(|err| format!("Cannot serialize today mutation: {err}"))?,
    });
    Ok((task_id, payload))
}

/// Kind of the most recent `today_mutate` event for this logical day, used
/// to enforce one-step undo. Events written by other commands (rollover,
/// recovery) carry no `logicalDay` payload marker and are ignored here.
fn last_mutation_event_kind(work: &Path, logical_day: &str) -> Result<Option<String>, String> {
    let path = events_path(work, &logical_day[..7]);
    if !path.exists() {
        return Ok(None);
    }
    Ok(read_events_at(&path)?
        .into_iter()
        .filter(|event| {
            event
                .payload
                .get("logicalDay")
                .and_then(JsonValue::as_str)
                == Some(logical_day)
        })
        .last()
        .map(|event| event.kind))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TodayRolloverOutcome {
    pub closed_day: Option<String>,
    pub new_day: String,
    pub seeded: usize,
}

fn is_untouched(snapshot: &TodaySnapshot) -> bool {
    snapshot.day_state == DayState::Unstarted
        && snapshot.brain_dump.trim().is_empty()
        && snapshot.plan.is_none()
        && snapshot.yesterday.iter().all(|item| item.resolution.is_none())
}

/// Close the previous logical day (if it was touched) and initialize the
/// new one. Idempotent: a second run for the same logical day is a no-op.
#[tauri::command]
pub fn today_rollover(
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodayRolloverOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let tz = parse_timezone(&timezone)?;
    let day_start_time = parse_day_start(&day_start)?;
    parse_sleep_start(&sleep_start)?;
    let now = DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?
        .with_timezone(&tz);
    let new_day = logical_day(now, day_start_time)
        .format("%Y-%m-%d")
        .to_string();
    if state_path(&work, &new_day).exists() {
        return Ok(TodayRolloverOutcome {
            closed_day: None,
            new_day,
            seeded: 0,
        });
    }
    let prior_day = (logical_day(now, day_start_time) - Duration::days(1))
        .format("%Y-%m-%d")
        .to_string();
    let mut snapshot = TodaySnapshot::new(
        new_day.clone(),
        now_iso,
        timezone,
        day_start,
        sleep_start,
    );
    let mut closed_day = None;
    let mut seeded = 0;
    if let Ok(raw) = fs::read_to_string(state_path(&work, &prior_day)) {
        if let Ok(prior) = serde_json::from_str::<TodaySnapshot>(&raw) {
            if !is_untouched(&prior) {
                // Journal first: projection only happens for planned/skipped
                // days and must see the pre-close state.
                project_journal(&work, &work.join("tasks"), &prior)?;
                if let Some(plan) = &prior.plan {
                    for item in plan.items() {
                        snapshot.carryovers.push(CarryoverRef {
                            item_ref: item.item_ref.clone(),
                            carried_from: prior_day.clone(),
                        });
                        if let PlanItemRef::Task { task_id } = &item.item_ref {
                            snapshot.yesterday.push(YesterdayItem {
                                task_id: task_id.clone(),
                                title: item.outcome.clone().unwrap_or_default(),
                                status: "planned".to_string(),
                                progress: None,
                                resolution: None,
                                defer_date: None,
                            });
                        }
                    }
                }
                seeded = snapshot.yesterday.len();
                let unconfirmed = (!prior.brain_dump.trim().is_empty() || prior.plan.is_some())
                    && !matches!(prior.day_state, DayState::Planned | DayState::Skipped);
                if unconfirmed {
                    snapshot.brain_dump = prior.brain_dump.clone();
                    snapshot.plan = prior.plan.clone();
                    snapshot.unconfirmed_content = true;
                }
                let mut closing = prior.clone();
                if matches!(closing.day_state, DayState::Planned | DayState::Executing) {
                    closing.day_state = DayState::Reviewed;
                }
                closing.generated_at = Utc::now().to_rfc3339();
                persist_snapshot(&work, &mut closing)?;
                append_task_event(
                    &work,
                    &prior_day,
                    "day_closed",
                    None,
                    json!({ "dayState": closing.day_state }),
                )?;
                closed_day = Some(prior_day.clone());
                append_task_event(
                    &work,
                    &new_day,
                    "rollover",
                    None,
                    json!({
                        "from": prior_day,
                        "carryovers": snapshot.carryovers.len(),
                        "seeded": seeded,
                    }),
                )?;
                if unconfirmed {
                    append_task_event(
                        &work,
                        &new_day,
                        "boundary-unconfirmed",
                        None,
                        json!({ "from": prior_day }),
                    )?;
                }
            }
        }
    }
    persist_snapshot(&work, &mut snapshot)?;
    Ok(TodayRolloverOutcome {
        closed_day,
        new_day,
        seeded,
    })
}

/// Read appended task events for a month (`YYYY-MM`) or, when `day` is
/// given, only events whose UTC timestamp falls on that day.
#[tauri::command]
pub fn read_task_events(
    work_path: String,
    month: Option<String>,
    day: Option<String>,
) -> Result<Vec<TaskEvent>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let (month, day_filter) = match (month, day) {
        (_, Some(day)) => {
            validate_logical_day(&day)?;
            (day[..7].to_string(), Some(day))
        }
        (Some(month), None) => {
            validate_month(&month)?;
            (month, None)
        }
        (None, None) => return Err("today_month_required".to_string()),
    };
    let path = events_path(&work, &month);
    if !path.exists() {
        return Ok(Vec::new());
    }
    let events = read_events_at(&path)?;
    Ok(match day_filter {
        Some(day) => events
            .into_iter()
            .filter(|event| event.ts.starts_with(&day))
            .collect(),
        None => events,
    })
}

// --- Journal projection ------------------------------------------------------

fn journal_item_line(item: &crate::today::DailyPlanItem) -> String {
    let mut line = format!("- {}", item.item_ref.id());
    if let Some(minutes) = item.estimate_minutes {
        line.push_str(&format!(" ({minutes}m)"));
    } else if item.estimate_provisional {
        line.push_str(" (estimate pending)");
    }
    if let Some(outcome) = &item.outcome {
        if !outcome.trim().is_empty() {
            line.push_str(&format!(": {}", outcome.trim()));
        }
    }
    line
}

fn render_journal_block(snapshot: &TodaySnapshot) -> String {
    let mut out = String::new();
    out.push_str(JOURNAL_START_MARKER);
    out.push('\n');
    out.push_str(&format!("# Today: {}\n\n", snapshot.logical_day));
    let state = serde_json::to_value(snapshot.day_state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| format!("{:?}", snapshot.day_state));
    out.push_str(&format!(
        "- State: {state}\n- Day window: {} -> {}\n",
        snapshot.day_start, snapshot.sleep_start
    ));
    if let Some(plan) = &snapshot.plan {
        let lanes = [
            ("Top", &plan.top),
            ("Flexible", &plan.flexible),
            ("Overflow", &plan.overflow),
        ];
        for (label, items) in lanes {
            if items.is_empty() {
                continue;
            }
            out.push_str(&format!("\n## {label}\n"));
            for item in items {
                out.push_str(&journal_item_line(item));
                out.push('\n');
            }
        }
    }
    out.push_str(JOURNAL_END_MARKER);
    out
}

fn splice_journal(existing: &str, block: &str) -> String {
    let start = existing.find(JOURNAL_START_MARKER);
    let end = existing.find(JOURNAL_END_MARKER);
    match (start, end) {
        (Some(start), Some(end)) if end >= start => {
            format!(
                "{}{}{}",
                &existing[..start],
                block,
                &existing[end + JOURNAL_END_MARKER.len()..]
            )
        }
        // No (complete) marker pair yet: prepend the managed block and keep
        // the entire existing file below it.
        _ => format!("{block}\n\n{existing}"),
    }
}

/// Write `tasks/daily/YYYY-MM-DD.md` for planned or skipped days only.
/// Content between the maru markers is managed; everything outside (e.g. a
/// hand-written Reflection section) is preserved verbatim across rewrites.
pub fn project_journal(
    _work: &Path,
    tasks_root: &Path,
    snapshot: &TodaySnapshot,
) -> Result<(), String> {
    if !matches!(snapshot.day_state, DayState::Planned | DayState::Skipped) {
        return Ok(());
    }
    let path = tasks_root
        .join("daily")
        .join(format!("{}.md", snapshot.logical_day));
    let block = render_journal_block(snapshot);
    let content = match fs::read_to_string(&path) {
        Ok(existing) => splice_journal(&existing, &block),
        Err(_) => format!("{block}\n\n## Reflection\n"),
    };
    write_atomic(&path, content.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today::{
        CalendarSyncState, DailyPlanItem, DailyPlanV1, PlanLane, ProposedBlock, TodayRoute,
        YesterdayResolution,
    };

    const SEOUL: &str = "Asia/Seoul";
    const DAY_START: &str = "03:30";
    const SLEEP_START: &str = "21:30";

    fn open_day(work: &str, now_iso: &str) -> TodaySnapshot {
        today_open(
            work.to_string(),
            now_iso.to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap()
    }

    fn mutate(work: &str, snapshot: &TodaySnapshot, mutation: TodayMutation) -> TodaySnapshot {
        today_mutate(
            work.to_string(),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            mutation,
        )
        .unwrap()
    }

    fn plan_for(snapshot: &TodaySnapshot, task_ids: &[&str]) -> DailyPlanV1 {
        DailyPlanV1 {
            logical_day: snapshot.logical_day.clone(),
            input_revision: snapshot.revision.clone(),
            top: task_ids
                .iter()
                .enumerate()
                .map(|(index, id)| DailyPlanItem {
                    item_ref: PlanItemRef::Task {
                        task_id: id.to_string(),
                    },
                    lane: PlanLane::Top,
                    order: index as u32,
                    outcome: Some(format!("Ship {id}")),
                    estimate_minutes: Some(45),
                    estimate_provisional: false,
                    pinned: false,
                    proposed_block: None,
                    calendar_sync: CalendarSyncState::none(),
                })
                .collect(),
            flexible: vec![],
            overflow: vec![],
            reasons: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn open_initializes_state_named_by_configured_tz_not_utc() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        // 2026-07-20T18:30:00Z is 2026-07-21 03:30 in Seoul.
        let snapshot = open_day(&work, "2026-07-20T18:30:00Z");
        assert_eq!(snapshot.logical_day, "2026-07-21");
        assert_eq!(snapshot.day_state, DayState::Unstarted);
        assert!(!snapshot.revision.is_empty());
        assert!(state_path(tmp.path(), "2026-07-21").exists());
        // Reopen loads the persisted snapshot.
        let reopened = open_day(&work, "2026-07-20T19:00:00Z");
        assert_eq!(reopened.revision, snapshot.revision);
    }

    #[test]
    fn mutate_rejects_stale_expected_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let err = today_mutate(
            work,
            snapshot.logical_day.clone(),
            "bogus".to_string(),
            TodayMutation::SetBrainDump {
                brain_dump: "x".to_string(),
            },
        )
        .unwrap_err();
        assert!(err.starts_with("today_conflict: expected revision bogus, found "));
    }

    #[test]
    fn mutate_snapshots_each_revision_and_prunes_to_twenty() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let mut snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        for index in 0..25 {
            let next = mutate(
                &work,
                &snapshot,
                TodayMutation::SetBrainDump {
                    brain_dump: format!("dump {index}"),
                },
            );
            assert_ne!(next.revision, snapshot.revision);
            snapshot = next;
        }
        assert_eq!(snapshot.brain_dump, "dump 24");
        let files = list_revisions(&revisions_dir(tmp.path(), "2026-07-21"));
        assert_eq!(files.len(), REVISION_RETENTION);
    }

    #[test]
    fn undo_restores_previous_revision_once() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let filled = mutate(
            &work,
            &snapshot,
            TodayMutation::SetBrainDump {
                brain_dump: "draft".to_string(),
            },
        );
        let undone = mutate(&work, &filled, TodayMutation::Undo);
        assert_eq!(undone.brain_dump, "");
        assert_eq!(undone.day_state, DayState::Unstarted);
        // One step only: undoing again fails because nothing newer exists.
        let err = today_mutate(
            work,
            undone.logical_day.clone(),
            undone.revision.clone(),
            TodayMutation::Undo,
        )
        .unwrap_err();
        assert_eq!(err, "today_undo_unavailable");
    }

    #[test]
    fn set_plan_validates_and_confirm_setup_journals() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let mut stale_plan = plan_for(&snapshot, &["a"]);
        stale_plan.input_revision = "stale".to_string();
        let err = today_mutate(
            work.clone(),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            TodayMutation::SetPlan { plan: stale_plan },
        )
        .unwrap_err();
        assert!(err.starts_with("today_conflict"));
        let planned = mutate(
            &work,
            &snapshot,
            TodayMutation::SetPlan {
                plan: plan_for(&snapshot, &["a", "b"]),
            },
        );
        assert_eq!(planned.day_state, DayState::Preparing);
        let confirmed = mutate(&work, &planned, TodayMutation::ConfirmSetup);
        assert_eq!(confirmed.day_state, DayState::Planned);
        assert_eq!(confirmed.stage, Some(TodayStage::Execute));
        let journal = tmp.path().join("tasks/daily/2026-07-21.md");
        let content = fs::read_to_string(journal).unwrap();
        assert!(content.contains(JOURNAL_START_MARKER));
        assert!(content.contains(JOURNAL_END_MARKER));
        assert!(content.contains("- a (45m): Ship a"));
        assert!(content.contains("## Reflection"));
    }

    #[test]
    fn open_recovers_from_corrupt_state_via_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let mutated = mutate(
            &work,
            &snapshot,
            TodayMutation::SetBrainDump {
                brain_dump: "draft".to_string(),
            },
        );
        fs::write(state_path(tmp.path(), "2026-07-21"), "{ not json").unwrap();
        let recovered = open_day(&work, "2026-07-21T10:00:00+09:00");
        // The only revision snapshot predates the mutation.
        assert_eq!(recovered.brain_dump, "");
        assert_eq!(recovered.revision, snapshot.revision);
        assert_ne!(recovered.revision, mutated.revision);
        let events = read_task_events(work, Some("2026-07".to_string()), None).unwrap();
        assert!(events.iter().any(|event| event.kind == "state_recovered"));
    }

    #[test]
    fn journal_rewrite_preserves_text_outside_markers() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let planned = mutate(
            &work,
            &snapshot,
            TodayMutation::SetPlan {
                plan: plan_for(&snapshot, &["a"]),
            },
        );
        let confirmed = mutate(&work, &planned, TodayMutation::ConfirmSetup);
        let journal = tmp.path().join("tasks/daily/2026-07-21.md");
        let original = fs::read_to_string(&journal).unwrap();
        fs::write(&journal, original.replace("## Reflection\n", "## Reflection\nmy notes\n"))
            .unwrap();
        // Any later mutation on a planned day re-projects the journal.
        mutate(
            &work,
            &confirmed,
            TodayMutation::SetRoute {
                route: TodayRoute::Execute,
            },
        );
        let rewritten = fs::read_to_string(&journal).unwrap();
        assert!(rewritten.contains("my notes"));
        assert_eq!(rewritten.matches(JOURNAL_START_MARKER).count(), 1);
    }

    #[test]
    fn rollover_closes_prior_day_and_is_idempotent() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let planned = mutate(
            &work,
            &snapshot,
            TodayMutation::SetPlan {
                plan: plan_for(&snapshot, &["a", "b"]),
            },
        );
        mutate(&work, &planned, TodayMutation::ConfirmSetup);

        let outcome = today_rollover(
            work.clone(),
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.closed_day.as_deref(), Some("2026-07-21"));
        assert_eq!(outcome.new_day, "2026-07-22");
        assert_eq!(outcome.seeded, 2);

        let closed: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-21")).unwrap(),
        )
        .unwrap();
        assert_eq!(closed.day_state, DayState::Reviewed);
        let new_day: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-22")).unwrap(),
        )
        .unwrap();
        assert_eq!(new_day.yesterday.len(), 2);
        assert_eq!(new_day.yesterday[0].task_id, "a");
        assert_eq!(new_day.carryovers.len(), 2);
        assert!(!new_day.unconfirmed_content);
        assert!(tmp.path().join("tasks/daily/2026-07-21.md").exists());

        // Second run: no-op, snapshot untouched.
        let second = today_rollover(
            work.clone(),
            "2026-07-22T05:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(second.closed_day, None);
        assert_eq!(second.seeded, 0);
        let new_day_after: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-22")).unwrap(),
        )
        .unwrap();
        assert_eq!(new_day_after.revision, new_day.revision);
        let events = read_task_events(work, Some("2026-07".to_string()), None).unwrap();
        assert_eq!(
            events
                .iter()
                .filter(|event| event.kind == "rollover")
                .count(),
            1
        );
    }

    #[test]
    fn rollover_skipped_day_writes_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        mutate(&work, &snapshot, TodayMutation::QuickSkip);
        let outcome = today_rollover(
            work,
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.closed_day.as_deref(), Some("2026-07-21"));
        let journal = fs::read_to_string(tmp.path().join("tasks/daily/2026-07-21.md")).unwrap();
        assert!(journal.contains("- State: skipped"));
        let closed: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-21")).unwrap(),
        )
        .unwrap();
        assert_eq!(closed.day_state, DayState::Skipped);
    }

    #[test]
    fn rollover_carries_unconfirmed_preparation_across_boundary() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        mutate(
            &work,
            &snapshot,
            TodayMutation::SetBrainDump {
                brain_dump: "loose thoughts".to_string(),
            },
        );
        let outcome = today_rollover(
            work.clone(),
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.closed_day.as_deref(), Some("2026-07-21"));
        let new_day: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-22")).unwrap(),
        )
        .unwrap();
        assert!(new_day.unconfirmed_content);
        assert_eq!(new_day.brain_dump, "loose thoughts");
        // Never planned nor skipped -> no journal for the prior day.
        assert!(!tmp.path().join("tasks/daily/2026-07-21.md").exists());
        let events = read_task_events(work, Some("2026-07".to_string()), None).unwrap();
        assert!(events
            .iter()
            .any(|event| event.kind == "boundary-unconfirmed"));
    }

    #[test]
    fn rollover_ignores_untouched_prior_day_and_writes_no_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        open_day(&work, "2026-07-21T09:00:00+09:00");
        let outcome = today_rollover(
            work.clone(),
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.closed_day, None);
        assert_eq!(outcome.seeded, 0);
        assert!(!tmp.path().join("tasks/daily/2026-07-21.md").exists());
        // Prior day state stays exactly as it was (still unstarted).
        let prior: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-21")).unwrap(),
        )
        .unwrap();
        assert_eq!(prior.day_state, DayState::Unstarted);
        let events = read_task_events(work, Some("2026-07".to_string()), None).unwrap();
        assert!(!events.iter().any(|event| event.kind == "day_closed"));
    }

    #[test]
    fn apply_yesterday_decision_updates_item() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let planned = mutate(
            &work,
            &snapshot,
            TodayMutation::SetPlan {
                plan: plan_for(&snapshot, &["a"]),
            },
        );
        mutate(&work, &planned, TodayMutation::ConfirmSetup);
        today_rollover(
            work.clone(),
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        let new_day = open_day(&work, "2026-07-22T08:00:00+09:00");
        let updated = mutate(
            &work,
            &new_day,
            TodayMutation::ApplyYesterdayDecision {
                task_id: "a".to_string(),
                resolution: YesterdayResolution::Defer,
                defer_date: Some("2026-07-25".to_string()),
            },
        );
        assert_eq!(
            updated.yesterday[0].resolution,
            Some(YesterdayResolution::Defer)
        );
        assert_eq!(updated.yesterday[0].defer_date.as_deref(), Some("2026-07-25"));
        let err = today_mutate(
            work,
            updated.logical_day.clone(),
            updated.revision.clone(),
            TodayMutation::ApplyYesterdayDecision {
                task_id: "missing".to_string(),
                resolution: YesterdayResolution::Cancel,
                defer_date: None,
            },
        )
        .unwrap_err();
        assert!(err.starts_with("today_yesterday_item_missing"));
    }

    #[test]
    fn read_task_events_filters_by_day() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        mutate(
            &work,
            &snapshot,
            TodayMutation::SetBrainDump {
                brain_dump: "x".to_string(),
            },
        );
        let month_events =
            read_task_events(work.clone(), Some("2026-07".to_string()), None).unwrap();
        assert!(month_events
            .iter()
            .any(|event| event.kind == "brain_dump_set"));
        let today = Utc::now().format("%Y-%m-%d").to_string();
        let day_events = read_task_events(work, None, Some(today)).unwrap();
        assert_eq!(day_events.len(), month_events.len());
        assert!(read_task_events(
            tmp.path().to_string_lossy().to_string(),
            None,
            Some("2020-01-01".to_string())
        )
        .unwrap()
        .is_empty());
    }

    #[test]
    fn proposed_block_crossing_sleep_is_rejected_on_set_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let mut plan = plan_for(&snapshot, &["a"]);
        plan.top[0].proposed_block = Some(ProposedBlock {
            start_iso: "2026-07-21T21:00:00+09:00".to_string(),
            end_iso: "2026-07-21T22:00:00+09:00".to_string(),
        });
        let err = today_mutate(
            work,
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            TodayMutation::SetPlan { plan },
        )
        .unwrap_err();
        assert!(err.starts_with("today_block_crosses_sleep"));
    }
}
