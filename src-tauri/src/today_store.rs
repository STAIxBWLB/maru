// Maru Today — per-workspace persistence: day state files with sha256
// revisions, revision snapshots, an append-only JSONL event log, day
// rollover, and the tasks/daily journal projection.
//
// Layout under `<work>/.maru/today/`:
//   YYYY-MM-DD.json                current TodaySnapshot per logical day
//   revisions/YYYY-MM-DD/<rev>.json  pre-overwrite snapshots (latest 20 kept)
//   events/YYYY-MM.jsonl           append-only TaskEvent lines
//   outbox/                        reserved for the integration outbox

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::document::revision_for;
use crate::ipc_error::{IpcError, TODAY_CONFLICT};
use crate::tasks::{
    materialize_capture_task_in_transaction, prepare_capture_task_materialization,
    resolve_tasks_root, CreateTaskDraft, TaskBucket,
};
use crate::today::{
    logical_day, parse_day_start, parse_sleep_start, parse_timezone, validate_plan,
    CalendarSyncState, CaptureDecisionRecord, CarryoverRef, DayState, MaterializedCapture,
    PersistedCaptureDecision, PlanItemRef, TaskEvent, TodayFinalizeAction,
    TodayFinalizeSetupOutcome, TodayFinalizeSetupRequest, TodayMutation, TodaySnapshot, TodayStage,
    UnresolvedPolicy, YesterdayItem, YesterdayResolution,
};
use crate::vault::normalize_existing_dir;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};
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
    today_dir(work)
        .join("events")
        .join(format!("{month}.jsonl"))
}

fn finalize_dir(work: &Path) -> PathBuf {
    today_dir(work).join("finalize")
}

fn finalize_journal_path(work: &Path, idempotency_key: &str) -> PathBuf {
    finalize_dir(work).join(format!("{}.json", revision_for(idempotency_key)))
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
        validate_logical_day(&format!("{month}-01"))
            .map_err(|_| format!("today_invalid_month: {month}"))?;
        return Ok(());
    }
    Err(format!("today_invalid_month: {month}"))
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum FinalizeJournalPhase {
    Prepared,
    Materializing,
    Committing,
    Committed,
    RolledBack,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeCreatedFile {
    rel_path: String,
    content_hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FinalizeJournal {
    request_hash: String,
    request: TodayFinalizeSetupRequest,
    phase: FinalizeJournalPhase,
    #[serde(default)]
    created_files: Vec<FinalizeCreatedFile>,
    #[serde(default)]
    materialized: Vec<MaterializedCapture>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    outcome: Option<TodayFinalizeSetupOutcome>,
}

/// Terminal journals only matter for near-term replays; drop them once they
/// age out so the finalize directory does not grow forever.
const FINALIZE_JOURNAL_RETENTION_SECS: u64 = 30 * 24 * 60 * 60;

fn prune_stale_finalize_journal(path: &Path) {
    let stale = fs::metadata(path)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|modified| modified.elapsed().ok())
        .is_some_and(|age| age.as_secs() > FINALIZE_JOURNAL_RETENTION_SECS);
    if stale {
        let _ = fs::remove_file(path);
    }
}

fn write_finalize_journal(path: &Path, journal: &FinalizeJournal) -> Result<(), String> {
    let raw = serde_json::to_string_pretty(journal)
        .map_err(|err| format!("Cannot serialize today finalize journal: {err}"))?;
    write_atomic(path, raw.as_bytes())
}

fn safe_finalize_created_path(work: &Path, rel_path: &str) -> Option<PathBuf> {
    let rel = Path::new(rel_path);
    if rel.is_absolute()
        || rel
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return None;
    }
    let path = work.join(rel);
    let active_root = resolve_tasks_root(work, "tasks").ok()?.join("active");
    if path.extension().and_then(|value| value.to_str()) != Some("md")
        || !path.starts_with(active_root)
    {
        return None;
    }
    Some(path)
}

/// Remove only files this transaction created and only while their content
/// still matches the recorded hash. A user edit converts the file into
/// recoverable user data and is never deleted.
fn rollback_finalize_created_files(
    work: &Path,
    created_files: &[FinalizeCreatedFile],
) -> Vec<String> {
    let mut preserved = Vec::new();
    for created in created_files.iter().rev() {
        let Some(path) = safe_finalize_created_path(work, &created.rel_path) else {
            preserved.push(created.rel_path.clone());
            continue;
        };
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if revision_for(&raw) == created.content_hash {
            if fs::remove_file(&path).is_err() {
                preserved.push(created.rel_path.clone());
            }
        } else {
            preserved.push(created.rel_path.clone());
        }
    }
    preserved
}

/// Reconcile crash-interrupted Finish setup journals. `Committing` is
/// considered committed only when the persisted snapshot revision matches the
/// recorded outcome; all earlier phases roll back unchanged created files.
fn recover_finalize_journals(work: &Path) -> Result<(), String> {
    let dir = finalize_dir(work);
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(());
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        let Ok(mut journal) = serde_json::from_str::<FinalizeJournal>(&raw) else {
            continue;
        };
        match journal.phase {
            FinalizeJournalPhase::Committed | FinalizeJournalPhase::RolledBack => {
                prune_stale_finalize_journal(&path);
                continue;
            }
            FinalizeJournalPhase::Committing => {
                let committed = journal.outcome.as_ref().is_some_and(|outcome| {
                    fs::read_to_string(state_path(work, &journal.request.logical_day))
                        .ok()
                        .and_then(|raw| serde_json::from_str::<TodaySnapshot>(&raw).ok())
                        .is_some_and(|snapshot| snapshot.revision == outcome.snapshot.revision)
                });
                if committed {
                    journal.phase = FinalizeJournalPhase::Committed;
                    write_finalize_journal(&path, &journal)?;
                    continue;
                }
            }
            FinalizeJournalPhase::Prepared | FinalizeJournalPhase::Materializing => {}
        }
        let preserved = rollback_finalize_created_files(work, &journal.created_files);
        journal.phase = FinalizeJournalPhase::RolledBack;
        journal
            .created_files
            .retain(|entry| preserved.contains(&entry.rel_path));
        write_finalize_journal(&path, &journal)?;
    }
    Ok(())
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

// --- Locks -------------------------------------------------------------------

/// Process-wide per-workspace mutex serializing every read-check-write on
/// day state (mutations, rollover, lifecycle transitions, publish persist).
/// The revision check alone is TOCTOU-racy: two concurrent commands reading
/// the same revision would both pass and the first writer would be silently
/// lost. Single-user desktop, ms-scale writes — one lock per workspace is
/// plenty; never hold it across network calls.
pub(crate) fn work_lock_for(work: &Path) -> Result<Arc<Mutex<()>>, String> {
    static LOCKS: OnceLock<Mutex<HashMap<PathBuf, Arc<Mutex<()>>>>> = OnceLock::new();
    let key = work.to_path_buf();
    let mut locks = LOCKS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .map_err(|_| "today_work_lock_registry_poisoned".to_string())?;
    Ok(locks
        .entry(key)
        .or_insert_with(|| Arc::new(Mutex::new(())))
        .clone())
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
        day: Some(logical_day.to_string()),
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
        day: Some(logical_day.to_string()),
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
/// callers never fail a transition over this. Callers must hold the
/// workspace lock (`work_lock_for`) — task_transition does.
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
) -> Result<(), IpcError> {
    if snapshot.revision != expected_revision {
        return Err(IpcError {
            code: TODAY_CONFLICT.to_string(),
            message: format!(
                "expected revision {expected_revision}, found {}",
                snapshot.revision
            ),
        });
    }
    Ok(())
}

/// Load the snapshot for the logical day containing `now`, initializing and
/// persisting a fresh one when missing. Corrupt state JSON falls back to the
/// newest valid revision snapshot (logging `state_recovered`); with no valid
/// revision the day starts fresh. Creating a fresh day runs the rollover
/// (close + seed the newest prior day) first, so a failed or skipped
/// `today_rollover` call at boot can never permanently orphan the prior day.
pub fn today_open(
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodaySnapshot, String> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve Today cwd: {err}"))?
            .join(&work_path)
    };
    // Allocation, recovery, revision retention, events and journal rollback all
    // belong to this operation. Include nested symlink endpoints independently.
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry.map_err(|err| err.to_string())?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        today_open_in_transaction(lease, work_path, now_iso, timezone, day_start, sleep_start)
    })
}

pub(crate) fn today_open_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodaySnapshot, String> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    // A new nested alias introduced while waiting must not expand this lease.
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect Today transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
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
    if let Err(error) = assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify) {
        return load_snapshot(&work, &day).map_err(|_| error);
    }
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
    let lock = work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
    if let Err(err) = recover_finalize_journals(&work) {
        let _ = append_task_event(
            &work,
            &day,
            "finalize_recovery_failed",
            None,
            json!({ "error": err }),
        );
    }
    if let Ok(raw) = fs::read_to_string(state_path(&work, &day)) {
        let parsed = serde_json::from_str::<TodaySnapshot>(&raw)
            .ok()
            .filter(|snapshot: &TodaySnapshot| snapshot.logical_day == day);
        if let Some(snapshot) = parsed {
            // Repair a journal projection an earlier failure skipped.
            if matches!(snapshot.day_state, DayState::Planned | DayState::Skipped) {
                let _ = project_journal(&work, &work.join("tasks"), &snapshot);
            }
            return Ok(snapshot);
        }
        // Corrupt (or stale-day) state: recover from the newest valid revision.
        if let Some((_, mut snapshot)) = newest_valid_revision(&work, &day, None) {
            assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
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
    let (_, snapshot) = rollover_inner(&work, &day, now_iso, timezone, day_start, sleep_start)?;
    Ok(snapshot)
}

/// Apply a single mutation against the current day state. Optimistic
/// concurrency: `expected_revision` must match the stored revision, and the
/// whole read-check-write runs under the workspace lock so two concurrent
/// callers with the same revision cannot both win.
pub fn today_mutate(
    work_path: String,
    logical_day: String,
    expected_revision: String,
    mutation: TodayMutation,
) -> Result<TodaySnapshot, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve Today cwd: {err}"))?
            .join(&work_path)
    };
    // Allocation, recovery, revision retention, events and journal rollback all
    // belong to this operation. Include nested symlink endpoints independently.
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry.map_err(|err| err.to_string())?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        Ok(today_mutate_in_transaction(
            lease,
            work_path,
            logical_day,
            expected_revision,
            mutation,
        ))
    })?
}

pub(crate) fn today_mutate_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    logical_day: String,
    expected_revision: String,
    mutation: TodayMutation,
) -> Result<TodaySnapshot, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    // A new nested alias introduced while waiting must not expand this lease.
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect Today transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    validate_logical_day(&logical_day)?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let lock = work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
    let raw = fs::read_to_string(state_path(&work, &logical_day))
        .map_err(|_| "today_state_missing".to_string())?;
    let mut snapshot: TodaySnapshot =
        serde_json::from_str(&raw).map_err(|err| format!("today_state_corrupt: {err}"))?;
    if snapshot.revision != expected_revision {
        return Err(IpcError {
            code: TODAY_CONFLICT.to_string(),
            message: format!(
                "expected revision {expected_revision}, found {}",
                snapshot.revision
            ),
        });
    }
    let event_kind: &str;
    if matches!(mutation, TodayMutation::Undo) {
        // One step only: the previous head is restored, but undoing twice in
        // a row would just ping-pong, so a second undo is rejected until a
        // new mutation lands (tracked via the day's event log).
        if last_mutation_event_kind(&work, &logical_day)? == Some("undo".to_string()) {
            return Err("today_undo_unavailable".to_string().into());
        }
        let Some((_, restored)) =
            newest_valid_revision(&work, &logical_day, Some(&snapshot.revision))
        else {
            return Err("today_undo_unavailable".to_string().into());
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
    // The state is committed above; the event append and journal projection
    // are best-effort so a full events dir or unwritable journal cannot
    // report a committed mutation as failed (the caller would then retry
    // with a now-stale revision and hit a bogus conflict). Missed journal
    // projections are repaired on the next today_open.
    let (task_id, payload) = mutation_event_details(&logical_day, &mutation)?;
    let _ = append_task_event(&work, &logical_day, event_kind, task_id, payload);
    if matches!(snapshot.day_state, DayState::Planned | DayState::Skipped) {
        let _ = project_journal(&work, &work.join("tasks"), &snapshot);
    }
    Ok(snapshot)
}

/// Atomically finish (or skip) Prepare. Capture task notes and the rewritten
/// day snapshot are coordinated through a durable journal so retrying the same
/// request is safe and crash recovery never removes user-modified files.
pub fn today_finalize_setup(
    work_path: String,
    request: TodayFinalizeSetupRequest,
) -> Result<TodayFinalizeSetupOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve Today cwd: {err}"))?
            .join(&work_path)
    };
    // Allocation, recovery, revision retention, events and journal rollback all
    // belong to this operation. Include nested symlink endpoints independently.
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry.map_err(|err| err.to_string())?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        Ok(today_finalize_setup_in_transaction(
            lease, work_path, request,
        ))
    })?
}

pub(crate) fn today_finalize_setup_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    request: TodayFinalizeSetupRequest,
) -> Result<TodayFinalizeSetupOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    // A new nested alias introduced while waiting must not expand this lease.
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect Today transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    validate_logical_day(&request.logical_day)?;
    if request.idempotency_key.trim().is_empty() {
        return Err("today_finalize_idempotency_key_required".to_string().into());
    }
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let lock = work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
    recover_finalize_journals(&work)?;

    let request_raw = serde_json::to_string(&request)
        .map_err(|err| format!("Cannot serialize today finalize request: {err}"))?;
    let request_hash = revision_for(&request_raw);
    let journal_path = finalize_journal_path(&work, &request.idempotency_key);
    if let Ok(raw) = fs::read_to_string(&journal_path) {
        let existing: FinalizeJournal = serde_json::from_str(&raw)
            .map_err(|err| format!("today_finalize_journal_corrupt: {err}"))?;
        // A rolled-back journal is terminal: its key is free for a corrected
        // retry even when the request bytes changed. Only a committed receipt
        // (replay) or an in-flight journal pins the original request.
        if existing.phase != FinalizeJournalPhase::RolledBack
            && existing.request_hash != request_hash
        {
            return Err("today_finalize_idempotency_conflict".to_string().into());
        }
        if existing.phase == FinalizeJournalPhase::Committed {
            let mut outcome = existing
                .outcome
                .ok_or_else(|| "today_finalize_receipt_missing".to_string())?;
            outcome.replayed = true;
            return Ok(outcome);
        }
    }

    let raw = fs::read_to_string(state_path(&work, &request.logical_day))
        .map_err(|_| "today_state_missing".to_string())?;
    let mut snapshot: TodaySnapshot =
        serde_json::from_str(&raw).map_err(|err| format!("today_state_corrupt: {err}"))?;
    check_revision(&snapshot, &request.expected_revision)?;
    if !matches!(
        snapshot.day_state,
        DayState::Unstarted | DayState::Preparing
    ) {
        return Err(format!(
            "today_invalid_transition: finalizeSetup from {:?}",
            snapshot.day_state
        )
        .into());
    }

    let mut plan = match request.action {
        TodayFinalizeAction::Confirm => request.plan.clone().or_else(|| snapshot.plan.clone()),
        TodayFinalizeAction::Skip => None,
    };
    if let Some(candidate_plan) = plan.as_mut() {
        candidate_plan.input_revision = snapshot.revision.clone();
        if candidate_plan.logical_day != snapshot.logical_day {
            return Err(format!(
                "today_plan_day_mismatch: {} != {}",
                candidate_plan.logical_day, snapshot.logical_day
            )
            .into());
        }
        validate_plan(
            candidate_plan,
            parse_sleep_start(&snapshot.sleep_start)?,
            parse_timezone(&snapshot.timezone)?,
        )?;
    }

    let capture_inputs: HashMap<String, _> = request
        .captures
        .iter()
        .map(|capture| (capture.capture_id.clone(), capture))
        .collect();
    if let Some(capture) = request
        .captures
        .iter()
        .find(|capture| capture.capture_id.trim().is_empty())
    {
        return Err(format!(
            "today_finalize_capture_id_required: {}",
            capture.title.trim()
        )
        .into());
    }
    if let Some(capture) = request
        .captures
        .iter()
        .find(|capture| capture.title.trim().is_empty())
    {
        return Err(format!(
            "today_finalize_capture_title_required: {}",
            capture.capture_id
        )
        .into());
    }
    if capture_inputs.len() != request.captures.len() {
        return Err("today_finalize_duplicate_capture".to_string().into());
    }
    let capture_refs: BTreeSet<String> = plan
        .as_ref()
        .into_iter()
        .flat_map(|plan| plan.items())
        .filter_map(|item| match &item.item_ref {
            PlanItemRef::Capture { capture_id } => Some(capture_id.clone()),
            PlanItemRef::Task { .. } => None,
        })
        .collect();
    if let Some(missing) = capture_refs
        .iter()
        .find(|capture_id| !capture_inputs.contains_key(*capture_id))
    {
        return Err(format!("today_finalize_capture_missing: {missing}").into());
    }

    let mut journal = FinalizeJournal {
        request_hash,
        request: request.clone(),
        phase: FinalizeJournalPhase::Prepared,
        created_files: Vec::new(),
        materialized: Vec::new(),
        outcome: None,
    };
    write_finalize_journal(&journal_path, &journal)?;

    let commit_result = (|| -> Result<TodayFinalizeSetupOutcome, String> {
        let mut materialized_by_capture = HashMap::<String, MaterializedCapture>::new();
        if request.action == TodayFinalizeAction::Confirm {
            journal.phase = FinalizeJournalPhase::Materializing;
            write_finalize_journal(&journal_path, &journal)?;
            for capture_id in &capture_refs {
                let capture = capture_inputs
                    .get(capture_id)
                    .ok_or_else(|| format!("today_finalize_capture_missing: {capture_id}"))?;
                let mut frontmatter = BTreeMap::new();
                frontmatter.insert("title".to_string(), json!(capture.title.trim()));
                frontmatter.insert("status".to_string(), json!("active"));
                frontmatter.insert("priority".to_string(), json!("medium"));
                if let Some(project) = capture
                    .project
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    frontmatter.insert("project".to_string(), json!(project.trim()));
                }
                if let Some(due_date) = capture
                    .due_date
                    .as_deref()
                    .filter(|value| !value.trim().is_empty())
                {
                    frontmatter.insert("due".to_string(), json!(due_date.trim()));
                }
                if let Some(minutes) = capture.estimate_minutes {
                    frontmatter.insert("estimateMinutes".to_string(), json!(minutes));
                }
                let body = if capture.summary.trim().is_empty() {
                    format!("# {}\n", capture.title.trim())
                } else {
                    format!("# {}\n\n{}\n", capture.title.trim(), capture.summary.trim())
                };
                let prepared = prepare_capture_task_materialization(
                    &work,
                    &request.logical_day,
                    capture_id,
                    CreateTaskDraft {
                        slug: capture.title.clone(),
                        title: capture.title.clone(),
                        frontmatter,
                        body,
                        bucket: TaskBucket::Active,
                    },
                )?;
                if prepared.will_create {
                    journal.created_files.push(FinalizeCreatedFile {
                        rel_path: prepared.rel_path.clone(),
                        content_hash: prepared.content_hash.clone(),
                    });
                    write_finalize_journal(&journal_path, &journal)?;
                }
                let write = materialize_capture_task_in_transaction(lease, &work, &prepared)?;
                let task_id = write
                    .row
                    .frontmatter
                    .get("taskId")
                    .and_then(JsonValue::as_str)
                    .unwrap_or(&write.row.rel_path)
                    .to_string();
                let materialized = MaterializedCapture {
                    capture_id: capture_id.clone(),
                    task_id,
                    task_path: write.row.rel_path.clone(),
                };
                if prepared.will_create && !write.created {
                    journal
                        .created_files
                        .retain(|entry| entry.rel_path != prepared.rel_path);
                }
                journal.materialized.push(materialized.clone());
                materialized_by_capture.insert(capture_id.clone(), materialized);
                write_finalize_journal(&journal_path, &journal)?;
            }
        }

        if let Some(next_plan) = plan.as_mut() {
            for item in next_plan.items_mut() {
                if let PlanItemRef::Capture { capture_id } = &item.item_ref {
                    let materialized =
                        materialized_by_capture.get(capture_id).ok_or_else(|| {
                            format!("today_finalize_capture_not_materialized: {capture_id}")
                        })?;
                    item.item_ref = PlanItemRef::Task {
                        task_id: materialized.task_id.clone(),
                    };
                }
            }
        }
        for materialized in materialized_by_capture.values() {
            snapshot.capture_decisions.insert(
                materialized.capture_id.clone(),
                CaptureDecisionRecord {
                    decision: PersistedCaptureDecision::Materialized,
                    defer_date: None,
                    task_id: Some(materialized.task_id.clone()),
                    task_path: Some(materialized.task_path.clone()),
                },
            );
        }

        match request.unresolved_policy {
            UnresolvedPolicy::KeepLater => {
                for item in snapshot.yesterday.iter_mut() {
                    if item.resolution.is_none() {
                        item.resolution = Some(YesterdayResolution::KeepLater);
                        item.defer_date = None;
                    }
                }
            }
        }
        snapshot.plan = plan;
        snapshot.day_state = match request.action {
            TodayFinalizeAction::Confirm => DayState::Planned,
            TodayFinalizeAction::Skip => DayState::Skipped,
        };
        snapshot.stage = Some(TodayStage::Execute);
        snapshot.route = crate::today::TodayRoute::Execute;
        snapshot.unconfirmed_content = false;
        snapshot.generated_at = Utc::now().to_rfc3339();
        snapshot_revision(&work, &snapshot, &raw)?;
        snapshot.revision = revision_for(&canonical_json(&snapshot)?);

        let outcome = TodayFinalizeSetupOutcome {
            snapshot: snapshot.clone(),
            materialized: journal.materialized.clone(),
            replayed: false,
        };
        journal.phase = FinalizeJournalPhase::Committing;
        journal.outcome = Some(outcome.clone());
        write_finalize_journal(&journal_path, &journal)?;
        persist_snapshot(&work, &mut snapshot)?;

        let committed = TodayFinalizeSetupOutcome {
            snapshot: snapshot.clone(),
            ..outcome
        };
        journal.phase = FinalizeJournalPhase::Committed;
        journal.outcome = Some(committed.clone());
        // The state commit is authoritative. If this last receipt rewrite
        // fails, today_open promotes the matching `committing` journal.
        let _ = write_finalize_journal(&journal_path, &journal);
        Ok(committed)
    })();

    let outcome = match commit_result {
        Ok(outcome) => outcome,
        Err(err) => {
            let preserved = rollback_finalize_created_files(&work, &journal.created_files);
            journal.phase = FinalizeJournalPhase::RolledBack;
            journal
                .created_files
                .retain(|entry| preserved.contains(&entry.rel_path));
            let _ = write_finalize_journal(&journal_path, &journal);
            return Err(err.into());
        }
    };

    let _ = append_task_event(
        &work,
        &request.logical_day,
        match request.action {
            TodayFinalizeAction::Confirm => "setup_confirmed",
            TodayFinalizeAction::Skip => "day_skipped",
        },
        None,
        json!({
            "idempotencyKey": request.idempotency_key,
            "materialized": outcome.materialized,
            "unresolvedPolicy": request.unresolved_policy,
        }),
    );
    let _ = project_journal(&work, &work.join("tasks"), &outcome.snapshot);
    Ok(outcome)
}

fn apply_mutation(
    snapshot: &mut TodaySnapshot,
    mutation: &TodayMutation,
) -> Result<&'static str, IpcError> {
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
                )
                .into());
            }
            if let Some(plan) = &snapshot.plan {
                validate_plan(
                    plan,
                    parse_sleep_start(&snapshot.sleep_start)?,
                    parse_timezone(&snapshot.timezone)?,
                )?;
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
                )
                .into());
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
        TodayMutation::SetCaptureDecision {
            capture_id,
            decision,
            defer_date,
        } => {
            if capture_id.trim().is_empty() {
                return Err("today_capture_id_required".to_string().into());
            }
            snapshot.capture_decisions.insert(
                capture_id.clone(),
                CaptureDecisionRecord {
                    decision: *decision,
                    defer_date: defer_date.clone(),
                    task_id: None,
                    task_path: None,
                },
            );
            Ok("capture_decision")
        }
        TodayMutation::SetPlan { plan } => {
            if plan.input_revision != snapshot.revision {
                return Err(IpcError {
                    code: TODAY_CONFLICT.to_string(),
                    message: format!(
                        "expected revision {}, found {}",
                        plan.input_revision, snapshot.revision
                    ),
                });
            }
            if plan.logical_day != snapshot.logical_day {
                return Err(format!(
                    "today_plan_day_mismatch: {} != {}",
                    plan.logical_day, snapshot.logical_day
                )
                .into());
            }
            validate_plan(
                plan,
                parse_sleep_start(&snapshot.sleep_start)?,
                parse_timezone(&snapshot.timezone)?,
            )?;
            // Calendar sync state is owned by SetCalendarSync and the publish
            // command, never by the incoming plan (so an AI payload cannot
            // forge Selected/Synced to smuggle external writes past the
            // per-block opt-in). Reconcile from the stored plan by ref:
            // - post-publish states (synced/syncing/error) reflect external
            //   reality — the stored block AND sync survive any replan, or a
            //   real calendar event would be orphaned invisibly;
            // - a pre-publish Selected opt-in survives only while the block
            //   is unchanged — a moved block needs a fresh opt-in;
            // - everything else carries no sync state.
            let mut next = plan.clone();
            for item in next.items_mut() {
                let stored = snapshot.plan.as_ref().and_then(|current| {
                    current
                        .items()
                        .find(|existing| existing.item_ref == item.item_ref)
                });
                match stored {
                    Some(existing)
                        if !matches!(
                            existing.calendar_sync.status,
                            crate::today::CalendarSyncStatus::None
                                | crate::today::CalendarSyncStatus::Selected
                        ) =>
                    {
                        item.proposed_block = existing.proposed_block.clone();
                        item.calendar_sync = existing.calendar_sync.clone();
                    }
                    Some(existing) if existing.proposed_block == item.proposed_block => {
                        item.calendar_sync = existing.calendar_sync.clone();
                    }
                    _ => item.calendar_sync = CalendarSyncState::none(),
                }
            }
            snapshot.plan = Some(next);
            if matches!(
                snapshot.day_state,
                DayState::Unstarted | DayState::Preparing
            ) {
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
        .rfind(|event| {
            event.payload.get("logicalDay").and_then(JsonValue::as_str) == Some(logical_day)
        })
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
        && snapshot
            .yesterday
            .iter()
            .all(|item| item.resolution.is_none())
        && snapshot.capture_decisions.is_empty()
}

/// Newest persisted day state strictly before `new_day`. Rollover closes
/// this day rather than exactly `new_day - 1`, so a multi-day gap (weekend,
/// vacation) still closes the last touched day and seeds its carryovers.
fn newest_prior_day(work: &Path, new_day: &str) -> Option<String> {
    let entries = fs::read_dir(today_dir(work)).ok()?;
    entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().to_string();
            let stem = name.strip_suffix(".json")?.to_string();
            validate_logical_day(&stem).ok()?;
            (stem.as_str() < new_day).then_some(stem)
        })
        .max()
}

/// Close the previous logical day (if it was touched) and initialize the
/// new one. Idempotent: a second run for the same logical day is a no-op.
pub fn today_rollover(
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodayRolloverOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve Today cwd: {err}"))?
            .join(&work_path)
    };
    // Allocation, recovery, revision retention, events and journal rollback all
    // belong to this operation. Include nested symlink endpoints independently.
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry.map_err(|err| err.to_string())?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        today_rollover_in_transaction(lease, work_path, now_iso, timezone, day_start, sleep_start)
    })
}

pub(crate) fn today_rollover_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<TodayRolloverOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.join(".maru/today"),
        work.join(".maru/today/revisions"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/today/finalize"),
        work.join("tasks"),
        work.join("tasks/active"),
        work.join("tasks/daily"),
    ];
    // A new nested alias introduced while waiting must not expand this lease.
    for root in [today_dir(&work), work.join("tasks")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect Today transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
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
    let lock = work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
    let (outcome, _) = rollover_inner(&work, &new_day, now_iso, timezone, day_start, sleep_start)?;
    Ok(outcome)
}

/// Rollover body shared by `today_rollover` and `today_open`'s fresh-day
/// creation. Caller must hold the workspace lock.
fn rollover_inner(
    work: &Path,
    new_day: &str,
    now_iso: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
) -> Result<(TodayRolloverOutcome, TodaySnapshot), String> {
    if let Ok(raw) = fs::read_to_string(state_path(work, new_day)) {
        if let Ok(existing) = serde_json::from_str::<TodaySnapshot>(&raw) {
            if existing.logical_day == new_day {
                return Ok((
                    TodayRolloverOutcome {
                        closed_day: None,
                        new_day: new_day.to_string(),
                        seeded: 0,
                    },
                    existing,
                ));
            }
        }
        // Unparseable or wrong-day content falls through and is overwritten
        // (today_open's revision-based recovery already ran before this).
    }
    let mut snapshot = TodaySnapshot::new(
        new_day.to_string(),
        now_iso,
        timezone,
        day_start,
        sleep_start,
    );
    let mut closed_day = None;
    let mut seeded = 0;
    let prior_day = newest_prior_day(work, new_day);
    if let Some(raw) = prior_day
        .as_ref()
        .and_then(|day| fs::read_to_string(state_path(work, day)).ok())
    {
        let prior_day = prior_day.expect("read implies a prior day");
        if let Ok(prior) = serde_json::from_str::<TodaySnapshot>(&raw) {
            if !is_untouched(&prior) {
                snapshot.capture_decisions = prior.capture_decisions.clone();
                // Journal first: projection only happens for planned/skipped
                // days and must see the pre-close state.
                project_journal(work, &work.join("tasks"), &prior)?;
                let mut seeded_task_ids = HashSet::new();
                if let Some(plan) = &prior.plan {
                    for item in plan.items() {
                        snapshot.carryovers.push(CarryoverRef {
                            item_ref: item.item_ref.clone(),
                            carried_from: prior_day.clone(),
                        });
                        if let PlanItemRef::Task { task_id } = &item.item_ref {
                            seeded_task_ids.insert(task_id.clone());
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
                // Items explicitly left for later are not forced back into a
                // plan, but remain available for the next Prepare resolver.
                for item in &prior.yesterday {
                    if !matches!(item.resolution, Some(YesterdayResolution::KeepLater) | None)
                        || !seeded_task_ids.insert(item.task_id.clone())
                    {
                        continue;
                    }
                    snapshot.carryovers.push(CarryoverRef {
                        item_ref: PlanItemRef::Task {
                            task_id: item.task_id.clone(),
                        },
                        carried_from: prior_day.clone(),
                    });
                    snapshot.yesterday.push(YesterdayItem {
                        task_id: item.task_id.clone(),
                        title: item.title.clone(),
                        status: item.status.clone(),
                        progress: item.progress,
                        resolution: None,
                        defer_date: None,
                    });
                }
                seeded = snapshot.yesterday.len();
                let unconfirmed = (!prior.brain_dump.trim().is_empty() || prior.plan.is_some())
                    && !matches!(prior.day_state, DayState::Planned | DayState::Skipped);
                if unconfirmed {
                    snapshot.brain_dump = prior.brain_dump.clone();
                    // The carried plan is preserved for the new day's Prepare,
                    // but re-identified: yesterday's logicalDay/inputRevision
                    // would fail SetPlan's own checks, and past-dated blocks
                    // plus published sync markers do not belong to a day that
                    // was never confirmed.
                    snapshot.plan = prior.plan.clone().map(|mut plan| {
                        plan.logical_day = new_day.to_string();
                        plan.input_revision = String::new();
                        for item in plan.items_mut() {
                            item.proposed_block = None;
                            item.calendar_sync = CalendarSyncState::none();
                        }
                        plan
                    });
                    snapshot.unconfirmed_content = true;
                }
                let mut closing = prior.clone();
                if matches!(closing.day_state, DayState::Planned | DayState::Executing) {
                    closing.day_state = DayState::Reviewed;
                }
                closing.generated_at = Utc::now().to_rfc3339();
                persist_snapshot(work, &mut closing)?;
                append_task_event(
                    work,
                    &prior_day,
                    "day_closed",
                    None,
                    json!({ "dayState": closing.day_state }),
                )?;
                closed_day = Some(prior_day.clone());
                append_task_event(
                    work,
                    new_day,
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
                        work,
                        new_day,
                        "boundary-unconfirmed",
                        None,
                        json!({ "from": prior_day }),
                    )?;
                }
            }
        }
    }
    persist_snapshot(work, &mut snapshot)?;
    Ok((
        TodayRolloverOutcome {
            closed_day,
            new_day: new_day.to_string(),
            seeded,
        },
        snapshot,
    ))
}

/// Read appended task events for a month (`YYYY-MM`) or, when `day` is
/// given, only events belonging to that logical day (falling back to the
/// UTC timestamp prefix for legacy records without a `day` field).
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
            .filter(|event| match &event.day {
                Some(event_day) => event_day == &day,
                None => event.ts.starts_with(&day),
            })
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
        CalendarSyncState, CaptureMaterializationInput, DailyPlanItem, DailyPlanV1, PlanLane,
        ProposedBlock, TodayRoute, YesterdayResolution,
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

    fn plan_with_capture(snapshot: &TodaySnapshot, capture_id: &str) -> DailyPlanV1 {
        DailyPlanV1 {
            logical_day: snapshot.logical_day.clone(),
            input_revision: snapshot.revision.clone(),
            top: vec![],
            flexible: vec![DailyPlanItem {
                item_ref: PlanItemRef::Capture {
                    capture_id: capture_id.to_string(),
                },
                lane: PlanLane::Flexible,
                order: 0,
                outcome: Some("Review the captured request".to_string()),
                estimate_minutes: Some(30),
                estimate_provisional: false,
                pinned: false,
                proposed_block: None,
                calendar_sync: CalendarSyncState::none(),
            }],
            overflow: vec![],
            reasons: vec![],
            warnings: vec![],
        }
    }

    #[test]
    fn finalize_setup_materializes_capture_once_and_replays_receipt() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let request = TodayFinalizeSetupRequest {
            logical_day: snapshot.logical_day.clone(),
            expected_revision: snapshot.revision.clone(),
            idempotency_key: "finish-capture-once".to_string(),
            action: TodayFinalizeAction::Confirm,
            plan: Some(plan_with_capture(&snapshot, "capture-1")),
            captures: vec![CaptureMaterializationInput {
                capture_id: "capture-1".to_string(),
                title: "Review shared budget".to_string(),
                summary: "Reply with the approved numbers.".to_string(),
                project: Some("Shared University".to_string()),
                due_date: Some("2026-07-21".to_string()),
                estimate_minutes: Some(30),
            }],
            unresolved_policy: UnresolvedPolicy::KeepLater,
        };

        let first = today_finalize_setup(work.clone(), request.clone()).unwrap();
        assert!(!first.replayed);
        assert_eq!(first.snapshot.day_state, DayState::Planned);
        assert_eq!(first.snapshot.stage, Some(TodayStage::Execute));
        assert_eq!(first.materialized.len(), 1);
        assert!(matches!(
            first.snapshot.plan.as_ref().unwrap().flexible[0].item_ref,
            PlanItemRef::Task { .. }
        ));
        assert_eq!(
            first
                .snapshot
                .capture_decisions
                .get("capture-1")
                .map(|record| record.decision),
            Some(PersistedCaptureDecision::Materialized)
        );
        let task_path = tmp.path().join(&first.materialized[0].task_path);
        assert!(task_path.exists());

        let replay = today_finalize_setup(work, request).unwrap();
        assert!(replay.replayed);
        assert_eq!(replay.materialized, first.materialized);
        assert_eq!(replay.snapshot.revision, first.snapshot.revision);
        let task_count = fs::read_dir(tmp.path().join("tasks/active"))
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("md"))
            .count();
        assert_eq!(task_count, 1);
    }

    #[test]
    fn finalize_skip_keeps_unresolved_items_without_creating_tasks() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let mut seeded = snapshot.clone();
        seeded.yesterday.push(YesterdayItem {
            task_id: "carry-1".to_string(),
            title: "Carry this later".to_string(),
            status: "active".to_string(),
            progress: None,
            resolution: None,
            defer_date: None,
        });
        persist_snapshot(tmp.path(), &mut seeded).unwrap();

        let outcome = today_finalize_setup(
            work,
            TodayFinalizeSetupRequest {
                logical_day: seeded.logical_day.clone(),
                expected_revision: seeded.revision.clone(),
                idempotency_key: "skip-without-materializing".to_string(),
                action: TodayFinalizeAction::Skip,
                plan: Some(plan_with_capture(&seeded, "capture-unused")),
                captures: vec![CaptureMaterializationInput {
                    capture_id: "capture-unused".to_string(),
                    title: "Do not create me".to_string(),
                    summary: String::new(),
                    project: None,
                    due_date: None,
                    estimate_minutes: None,
                }],
                unresolved_policy: UnresolvedPolicy::KeepLater,
            },
        )
        .unwrap();

        assert_eq!(outcome.snapshot.day_state, DayState::Skipped);
        assert!(outcome.snapshot.plan.is_none());
        assert!(outcome.materialized.is_empty());
        assert_eq!(
            outcome.snapshot.yesterday[0].resolution,
            Some(YesterdayResolution::KeepLater)
        );
        assert!(!tmp.path().join("tasks/active").exists());
    }

    #[test]
    fn finalize_retries_with_a_modified_request_after_rollback() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let request = TodayFinalizeSetupRequest {
            logical_day: snapshot.logical_day.clone(),
            expected_revision: snapshot.revision.clone(),
            idempotency_key: "retry-after-rollback".to_string(),
            action: TodayFinalizeAction::Skip,
            plan: None,
            captures: vec![],
            unresolved_policy: UnresolvedPolicy::KeepLater,
        };
        write_finalize_journal(
            &finalize_journal_path(tmp.path(), &request.idempotency_key),
            &FinalizeJournal {
                request_hash: "different-earlier-request".to_string(),
                request: request.clone(),
                phase: FinalizeJournalPhase::RolledBack,
                created_files: vec![],
                materialized: vec![],
                outcome: None,
            },
        )
        .unwrap();

        let outcome = today_finalize_setup(work, request).unwrap();

        assert!(!outcome.replayed);
        assert_eq!(outcome.snapshot.day_state, DayState::Skipped);
    }

    #[test]
    fn finalize_recovery_preserves_user_modified_created_file() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let task_path = work.join("tasks/active/recovery.md");
        fs::create_dir_all(task_path.parent().unwrap()).unwrap();
        fs::write(&task_path, "initial").unwrap();
        let snapshot = open_day(&work.to_string_lossy(), "2026-07-21T09:00:00+09:00");
        let journal_path = finalize_journal_path(work, "recovery-preserves-user-edit");
        write_finalize_journal(
            &journal_path,
            &FinalizeJournal {
                request_hash: "request-hash".to_string(),
                request: TodayFinalizeSetupRequest {
                    logical_day: snapshot.logical_day,
                    expected_revision: snapshot.revision,
                    idempotency_key: "recovery-preserves-user-edit".to_string(),
                    action: TodayFinalizeAction::Skip,
                    plan: None,
                    captures: vec![],
                    unresolved_policy: UnresolvedPolicy::KeepLater,
                },
                phase: FinalizeJournalPhase::Materializing,
                created_files: vec![FinalizeCreatedFile {
                    rel_path: "tasks/active/recovery.md".to_string(),
                    content_hash: revision_for("initial"),
                }],
                materialized: vec![],
                outcome: None,
            },
        )
        .unwrap();

        fs::write(&task_path, "user edit").unwrap();
        recover_finalize_journals(work).unwrap();

        assert_eq!(fs::read_to_string(&task_path).unwrap(), "user edit");
        let recovered: FinalizeJournal =
            serde_json::from_str(&fs::read_to_string(journal_path).unwrap()).unwrap();
        assert_eq!(recovered.phase, FinalizeJournalPhase::RolledBack);
        assert_eq!(recovered.created_files.len(), 1);
    }

    #[test]
    fn finalize_recovery_removes_only_unchanged_active_task_notes() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let task_path = work.join("tasks/active/unchanged.md");
        fs::create_dir_all(task_path.parent().unwrap()).unwrap();
        fs::write(&task_path, "transaction bytes").unwrap();
        let snapshot = open_day(&work.to_string_lossy(), "2026-07-21T09:00:00+09:00");
        let journal_path = finalize_journal_path(work, "recovery-removes-unchanged");
        write_finalize_journal(
            &journal_path,
            &FinalizeJournal {
                request_hash: "request-hash".to_string(),
                request: TodayFinalizeSetupRequest {
                    logical_day: snapshot.logical_day,
                    expected_revision: snapshot.revision,
                    idempotency_key: "recovery-removes-unchanged".to_string(),
                    action: TodayFinalizeAction::Skip,
                    plan: None,
                    captures: vec![],
                    unresolved_policy: UnresolvedPolicy::KeepLater,
                },
                phase: FinalizeJournalPhase::Materializing,
                created_files: vec![
                    FinalizeCreatedFile {
                        rel_path: "tasks/active/unchanged.md".to_string(),
                        content_hash: revision_for("transaction bytes"),
                    },
                    FinalizeCreatedFile {
                        rel_path: "notes/must-not-delete.md".to_string(),
                        content_hash: revision_for("transaction bytes"),
                    },
                ],
                materialized: vec![],
                outcome: None,
            },
        )
        .unwrap();
        fs::create_dir_all(work.join("notes")).unwrap();
        fs::write(work.join("notes/must-not-delete.md"), "transaction bytes").unwrap();

        recover_finalize_journals(work).unwrap();

        assert!(!task_path.exists());
        assert!(work.join("notes/must-not-delete.md").exists());
        let recovered: FinalizeJournal =
            serde_json::from_str(&fs::read_to_string(journal_path).unwrap()).unwrap();
        assert_eq!(recovered.phase, FinalizeJournalPhase::RolledBack);
        assert_eq!(recovered.created_files.len(), 1);
        assert_eq!(
            recovered.created_files[0].rel_path,
            "notes/must-not-delete.md"
        );
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
        assert_eq!(err.code, TODAY_CONFLICT);
        assert!(err
            .to_string()
            .starts_with("today_conflict: expected revision bogus, found "));
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
        assert_eq!(err.to_string(), "today_undo_unavailable");
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
        assert_eq!(err.code, TODAY_CONFLICT);
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
        fs::write(
            &journal,
            original.replace("## Reflection\n", "## Reflection\nmy notes\n"),
        )
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
    fn rollover_after_multi_day_gap_closes_last_touched_day() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        // Friday: plan and confirm, then nothing all weekend.
        let snapshot = open_day(&work, "2026-07-17T09:00:00+09:00");
        let planned = mutate(
            &work,
            &snapshot,
            TodayMutation::SetPlan {
                plan: plan_for(&snapshot, &["a", "b"]),
            },
        );
        mutate(&work, &planned, TodayMutation::ConfirmSetup);
        // Monday boot: prior_day - 1 (Sunday) has no state, but Friday must
        // still be closed and seeded from.
        let outcome = today_rollover(
            work,
            "2026-07-20T08:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.closed_day.as_deref(), Some("2026-07-17"));
        assert_eq!(outcome.seeded, 2);
        let closed: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-17")).unwrap(),
        )
        .unwrap();
        assert_eq!(closed.day_state, DayState::Reviewed);
        let monday: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-20")).unwrap(),
        )
        .unwrap();
        assert_eq!(monday.yesterday.len(), 2);
        assert_eq!(monday.carryovers[0].carried_from, "2026-07-17");
    }

    #[test]
    fn open_alone_runs_rollover_for_a_fresh_day() {
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
        // No today_rollover call — a failed/skipped boot rollover must not
        // orphan the prior day, so today_open closes and seeds it itself.
        let next = open_day(&work, "2026-07-22T09:00:00+09:00");
        assert_eq!(next.logical_day, "2026-07-22");
        assert_eq!(next.yesterday.len(), 1);
        assert_eq!(next.carryovers.len(), 1);
        let closed: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-21")).unwrap(),
        )
        .unwrap();
        assert_eq!(closed.day_state, DayState::Reviewed);
    }

    #[test]
    fn rollover_sanitizes_carried_unconfirmed_plan() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let mut plan = plan_for(&snapshot, &["a"]);
        plan.top[0].proposed_block = Some(ProposedBlock {
            start_iso: "2026-07-21T10:00:00+09:00".to_string(),
            end_iso: "2026-07-21T11:00:00+09:00".to_string(),
        });
        let planned = mutate(&work, &snapshot, TodayMutation::SetPlan { plan });
        mutate(
            &work,
            &planned,
            TodayMutation::SetCalendarSync {
                item_ref: PlanItemRef::Task {
                    task_id: "a".to_string(),
                },
                selected: true,
                destination: None,
            },
        );
        // Never confirmed: the plan carries over, but re-identified for the
        // new day — yesterday's identity/revision would fail SetPlan, and
        // past blocks/sync markers do not belong to the new day.
        today_rollover(
            work,
            "2026-07-22T04:00:00+09:00".to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        let new_day: TodaySnapshot = serde_json::from_str(
            &fs::read_to_string(state_path(tmp.path(), "2026-07-22")).unwrap(),
        )
        .unwrap();
        assert!(new_day.unconfirmed_content);
        let carried = new_day.plan.as_ref().unwrap();
        assert_eq!(carried.logical_day, "2026-07-22");
        assert_eq!(carried.input_revision, "");
        assert!(carried.top[0].proposed_block.is_none());
        assert_eq!(
            carried.top[0].calendar_sync.status,
            crate::today::CalendarSyncStatus::None
        );
    }

    #[test]
    fn set_plan_preserves_stored_calendar_sync_and_ignores_forged_state() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let block = ProposedBlock {
            start_iso: "2026-07-21T10:00:00+09:00".to_string(),
            end_iso: "2026-07-21T11:00:00+09:00".to_string(),
        };
        let mut plan = plan_for(&snapshot, &["a"]);
        plan.top[0].proposed_block = Some(block.clone());
        let planned = mutate(&work, &snapshot, TodayMutation::SetPlan { plan });
        let selected = mutate(
            &work,
            &planned,
            TodayMutation::SetCalendarSync {
                item_ref: PlanItemRef::Task {
                    task_id: "a".to_string(),
                },
                selected: true,
                destination: Some("work-cal".to_string()),
            },
        );
        // Replan with the same item+block, but the incoming payload forges a
        // Synced state: the stored Selected state wins, the forgery is
        // discarded.
        let mut replan = plan_for(&selected, &["a"]);
        replan.top[0].proposed_block = Some(block);
        replan.top[0].calendar_sync = CalendarSyncState {
            status: crate::today::CalendarSyncStatus::Synced,
            message: None,
            event_id: Some("evt-forged".to_string()),
            destination: Some("attacker-cal".to_string()),
        };
        let after = mutate(&work, &selected, TodayMutation::SetPlan { plan: replan });
        let item = &after.plan.as_ref().unwrap().top[0];
        assert_eq!(
            item.calendar_sync.status,
            crate::today::CalendarSyncStatus::Selected
        );
        assert_eq!(item.calendar_sync.destination.as_deref(), Some("work-cal"));
        assert!(item.calendar_sync.event_id.is_none());
        // Replan that CHANGES the block: the selection no longer applies to
        // what the user opted into, so sync resets to none.
        let mut moved = plan_for(&after, &["a"]);
        moved.top[0].proposed_block = Some(ProposedBlock {
            start_iso: "2026-07-21T14:00:00+09:00".to_string(),
            end_iso: "2026-07-21T15:00:00+09:00".to_string(),
        });
        let after_move = mutate(&work, &after, TodayMutation::SetPlan { plan: moved });
        assert_eq!(
            after_move.plan.as_ref().unwrap().top[0]
                .calendar_sync
                .status,
            crate::today::CalendarSyncStatus::None
        );
    }

    #[test]
    fn set_plan_preserves_published_block_and_sync_across_replans() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let snapshot = open_day(&work, "2026-07-21T09:00:00+09:00");
        let block = ProposedBlock {
            start_iso: "2026-07-21T10:00:00+09:00".to_string(),
            end_iso: "2026-07-21T11:00:00+09:00".to_string(),
        };
        let mut plan = plan_for(&snapshot, &["a"]);
        plan.top[0].proposed_block = Some(block.clone());
        let planned = mutate(&work, &snapshot, TodayMutation::SetPlan { plan });
        // Simulate a completed publish by writing the synced state the way
        // the publish command does (directly into the stored snapshot).
        let (raw, mut stored) = load_snapshot_with_raw(tmp.path(), "2026-07-21").unwrap();
        stored.plan.as_mut().unwrap().top[0].calendar_sync = CalendarSyncState {
            status: crate::today::CalendarSyncStatus::Synced,
            message: None,
            event_id: Some("evt-42".to_string()),
            destination: Some("primary".to_string()),
        };
        snapshot_revision(tmp.path(), &stored, &raw).unwrap();
        persist_snapshot(tmp.path(), &mut stored).unwrap();
        let _ = planned;
        // A replan that drops the block entirely (the auto-planner emits
        // null blocks) must not orphan the published event: block + Synced
        // state both survive.
        let replan = plan_for(&stored, &["a"]);
        assert!(replan.top[0].proposed_block.is_none());
        let after = mutate(&work, &stored, TodayMutation::SetPlan { plan: replan });
        let item = &after.plan.as_ref().unwrap().top[0];
        assert_eq!(item.proposed_block.as_ref(), Some(&block));
        assert_eq!(
            item.calendar_sync.status,
            crate::today::CalendarSyncStatus::Synced
        );
        assert_eq!(item.calendar_sync.event_id.as_deref(), Some("evt-42"));
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
        assert_eq!(
            updated.yesterday[0].defer_date.as_deref(),
            Some("2026-07-25")
        );
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
        assert!(err.to_string().starts_with("today_yesterday_item_missing"));
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
        // Day filtering follows the event's logical day, not its UTC ts: an
        // early-morning completion (04:00 KST = 19:00Z on the PRIOR UTC
        // date) must still land in the logical day it was made on.
        append_task_event_for(
            tmp.path(),
            "2026-07-21",
            "task_completed",
            Some("t-early".to_string()),
            json!({}),
            "2026-07-20T19:00:00Z".to_string(),
        )
        .unwrap();
        let day_events =
            read_task_events(work.clone(), None, Some("2026-07-21".to_string())).unwrap();
        assert_eq!(day_events.len(), month_events.len() + 1);
        assert!(day_events
            .iter()
            .any(|event| event.task_id.as_deref() == Some("t-early")));
        assert!(read_task_events(work, None, Some("2026-07-20".to_string()))
            .unwrap()
            .is_empty());
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
        assert!(err.to_string().starts_with("today_block_crosses_sleep"));
    }
}

/// Owned IPC boundaries; all filesystem work and admission waits run in the worker.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn today_open(
        work_path: String,
        now_iso: String,
        timezone: String,
        day_start: String,
        sleep_start: String,
    ) -> Result<TodaySnapshot, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:today_open");
            super::today_open(work_path, now_iso, timezone, day_start, sleep_start)
        })
        .await
        .map_err(|err| format!("today_open_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn today_mutate(
        work_path: String,
        logical_day: String,
        expected_revision: String,
        mutation: TodayMutation,
    ) -> Result<TodaySnapshot, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:today_mutate");
            super::today_mutate(work_path, logical_day, expected_revision, mutation)
        })
        .await
        .map_err(|err| IpcError::from(format!("today_mutate_task_failed: {err}")))?
    }
    #[tauri::command]
    pub async fn today_finalize_setup(
        work_path: String,
        request: TodayFinalizeSetupRequest,
    ) -> Result<TodayFinalizeSetupOutcome, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:today_finalize_setup",
            );
            super::today_finalize_setup(work_path, request)
        })
        .await
        .map_err(|err| IpcError::from(format!("today_finalize_setup_task_failed: {err}")))?
    }
    #[tauri::command]
    pub async fn today_rollover(
        work_path: String,
        now_iso: String,
        timezone: String,
        day_start: String,
        sleep_start: String,
    ) -> Result<TodayRolloverOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:today_rollover");
            super::today_rollover(work_path, now_iso, timezone, day_start, sleep_start)
        })
        .await
        .map_err(|err| format!("today_rollover_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn read_task_events(
        work_path: String,
        month: Option<String>,
        day: Option<String>,
    ) -> Result<Vec<TaskEvent>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_task_events",
            );
            super::read_task_events(work_path, month, day)
        })
        .await
        .map_err(|err| format!("read_task_events_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_11 {
    use super::*;
    use crate::atomic_file::{
        phase08_06::{boundary, run, Held, Home},
        PathTransactionTestHook,
    };
    use crate::today::{CaptureMaterializationInput, DailyPlanItem, DailyPlanV1, PlanLane};
    use crate::workspace_files::phase08_06::TrashFixture;
    use std::{future::Future, sync::mpsc, time::Duration};
    const DAY: &str = "2026-07-21";
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn open(work: String) -> TodaySnapshot {
        run(ipc::today_open(
            work,
            "2026-07-21T09:00:00+09:00".into(),
            "Asia/Seoul".into(),
            "03:30".into(),
            "21:30".into(),
        ))
        .unwrap()
    }
    fn fixture(home: &Home) -> tempfile::TempDir {
        let tmp = tempfile::tempdir_in(home.root.path()).unwrap();
        fs::create_dir_all(tmp.path().join("tasks/active")).unwrap();
        open(text(tmp.path()));
        tmp
    }
    fn request(snapshot: &TodaySnapshot) -> TodayFinalizeSetupRequest {
        TodayFinalizeSetupRequest {
            logical_day: DAY.into(),
            expected_revision: snapshot.revision.clone(),
            idempotency_key: "capture-finish".into(),
            action: TodayFinalizeAction::Confirm,
            plan: Some(DailyPlanV1 {
                logical_day: DAY.into(),
                input_revision: snapshot.revision.clone(),
                top: vec![],
                flexible: vec![DailyPlanItem {
                    item_ref: PlanItemRef::Capture {
                        capture_id: "capture-1".into(),
                    },
                    lane: PlanLane::Flexible,
                    order: 0,
                    outcome: Some("Ship capture".into()),
                    estimate_minutes: Some(30),
                    estimate_provisional: false,
                    pinned: false,
                    proposed_block: None,
                    calendar_sync: CalendarSyncState::none(),
                }],
                overflow: vec![],
                reasons: vec![],
                warnings: vec![],
            }),
            captures: vec![CaptureMaterializationInput {
                capture_id: "capture-1".into(),
                title: "Synthetic capture".into(),
                summary: "Preserve receipt".into(),
                project: None,
                due_date: None,
                estimate_minutes: Some(30),
            }],
            unresolved_policy: UnresolvedPolicy::KeepLater,
        }
    }
    async fn write(
        op: &'static str,
        work: String,
        snapshot: TodaySnapshot,
    ) -> Result<TodaySnapshot, IpcError> {
        match op {
            "today_open" => ipc::today_open(
                work,
                "2026-07-22T09:00:00+09:00".into(),
                "Asia/Seoul".into(),
                "03:30".into(),
                "21:30".into(),
            )
            .await
            .map_err(IpcError::from),
            "today_rollover" => ipc::today_rollover(
                work,
                "2026-07-22T09:00:00+09:00".into(),
                "Asia/Seoul".into(),
                "03:30".into(),
                "21:30".into(),
            )
            .await
            .map(|_| snapshot)
            .map_err(IpcError::from),
            "today_mutate" => {
                ipc::today_mutate(
                    work,
                    DAY.into(),
                    snapshot.revision,
                    TodayMutation::SetBrainDump {
                        brain_dump: "persisted work".into(),
                    },
                )
                .await
            }
            "today_finalize_setup" => ipc::today_finalize_setup(work, request(&snapshot))
                .await
                .map(|v| v.snapshot),
            _ => unreachable!(),
        }
    }
    fn start<F: Future + Send + 'static>(future: F) -> mpsc::Receiver<F::Output>
    where
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("bounded completion")
    }
    #[test]
    fn phase08_11_store_all_wrappers_same_polling_task_yield_joinerror() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let w = text(root);
        let snapshot = load_snapshot(root, DAY).unwrap();
        for op in [
            "today_open",
            "today_mutate",
            "today_finalize_setup",
            "today_rollover",
        ] {
            let w = w.clone();
            let s = snapshot.clone();
            boundary(root.into(), op, async move {
                write(op, w, s).await.map_err(|err| {
                    assert!(err.code.is_empty());
                    err.message
                })
            });
        }
        boundary(
            root.into(),
            "read_task_events",
            ipc::read_task_events(w, None, Some(DAY.into())),
        );
    }
    #[test]
    fn phase08_11_store_finalize_capture_replay_events_and_incomplete_lease() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let w = text(root);
        let snapshot = load_snapshot(root, DAY).unwrap();
        let req = request(&snapshot);
        let incomplete = PathTransactionRequest::new([today_dir(root)])
            .unwrap()
            .with_workspace_registry()
            .unwrap();
        let denied = with_path_transactions(incomplete, |lease| {
            Ok(today_finalize_setup_in_transaction(
                lease,
                w.clone(),
                req.clone(),
            ))
        })
        .unwrap()
        .unwrap_err();
        assert!(denied.message.contains("exceeds the admitted"));
        assert_eq!(fs::read_dir(root.join("tasks/active")).unwrap().count(), 0);
        let outcome = run(ipc::today_finalize_setup(w.clone(), req.clone())).unwrap();
        assert_eq!(outcome.materialized.len(), 1);
        assert!(!outcome.replayed);
        assert!(root.join(&outcome.materialized[0].task_path).is_file());
        assert!(root.join("tasks/daily/2026-07-21.md").is_file());
        assert!(
            run(ipc::today_finalize_setup(w.clone(), req))
                .unwrap()
                .replayed
        );
        assert!(
            !run(ipc::read_task_events(w.clone(), None, Some(DAY.into())))
                .unwrap()
                .is_empty()
        );
        let err = run(ipc::today_mutate(
            w.clone(),
            DAY.into(),
            snapshot.revision,
            TodayMutation::QuickSkip,
        ))
        .unwrap_err();
        assert_eq!(err.code, TODAY_CONFLICT);
        assert_eq!(
            run(ipc::read_task_events(w, None, None)).unwrap_err(),
            "today_month_required"
        );
    }
    #[test]
    fn phase08_11_store_every_writer_same_target_contention_and_failure_release() {
        let home = Home::new();
        for op in [
            "today_open",
            "today_mutate",
            "today_finalize_setup",
            "today_rollover",
        ] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let w = text(root);
            let snapshot = load_snapshot(root, DAY).unwrap();
            let key = today_dir(root);
            let held = Held::new(key.clone(), "admitted");
            let first = start(write(op, w.clone(), snapshot.clone()));
            held.wait();
            let waiting = Held::new(key, "before-admission");
            let second = start(write(op, w.clone(), snapshot));
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(first).unwrap();
            let next = done(second);
            if op == "today_mutate" {
                assert_eq!(next.unwrap_err().code, TODAY_CONFLICT);
            } else {
                next.unwrap();
            }
            assert_eq!(open(w).logical_day, DAY);
        }
    }
    #[test]
    fn phase08_11_store_parent_rename_trash_both_orders_aliases() {
        let home = Home::new();
        for op in [
            "today_open",
            "today_mutate",
            "today_finalize_setup",
            "today_rollover",
        ] {
            for parent_op in ["rename", "trash"] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        let tmp = fixture(&home);
                        let root = tmp.path().to_path_buf();
                        let owner = root.parent().unwrap();
                        let snapshot = load_snapshot(&root, DAY).unwrap();
                        let alias_path = owner.join(format!(
                            "alias-{}",
                            root.file_name().unwrap().to_string_lossy()
                        ));
                        #[cfg(unix)]
                        if alias {
                            std::os::unix::fs::symlink(&root, &alias_path).unwrap();
                        }
                        let w = if alias {
                            text(&alias_path)
                        } else {
                            text(&root)
                        };
                        let moved = owner.join(format!(
                            "moved-{}",
                            root.file_name().unwrap().to_string_lossy()
                        ));
                        let trash = owner.join(format!(
                            "trash-{}",
                            root.file_name().unwrap().to_string_lossy()
                        ));
                        let _trash = TrashFixture::new(root.clone(), trash.clone());
                        let parent_w = text(owner);
                        let source = text(&root);
                        let new_name = moved.file_name().unwrap().to_string_lossy().into_owned();
                        let parent = async move {
                            if parent_op == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    parent_w, source, new_name,
                                )
                                .await
                                .map(|v| assert!(v.error.is_none()))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    parent_w,
                                    vec![source],
                                )
                                .await
                                .map(|v| assert!(v[0].error.is_none()))
                            }
                        };
                        let key = if alias {
                            alias_path.join(".maru/today")
                        } else {
                            today_dir(&root)
                        };
                        if parent_first {
                            let held = Held::new(root.clone(), "admitted");
                            let first = start(parent);
                            held.wait();
                            let wait = Held::new(key, "before-admission");
                            let second = start(write(op, w, snapshot));
                            wait.wait();
                            wait.release();
                            assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                            held.release();
                            done(first).unwrap();
                            assert!(done(second).is_err(), "{op}/{parent_op}");
                        } else {
                            let held = Held::new(key, "admitted");
                            let first = start(write(op, w, snapshot));
                            held.wait();
                            let wait = Held::new(root.clone(), "before-admission");
                            let second = start(parent);
                            wait.wait();
                            wait.release();
                            assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                            held.release();
                            done(first).unwrap();
                            done(second).unwrap();
                            let final_root = if parent_op == "rename" {
                                &moved
                            } else {
                                &trash
                            };
                            assert!(final_root.join(".maru/today/2026-07-21.json").is_file());
                            if op == "today_finalize_setup" {
                                assert_eq!(
                                    fs::read_dir(final_root.join("tasks/active"))
                                        .unwrap()
                                        .count(),
                                    1
                                );
                            }
                        }
                        assert!(!root.exists(), "old workspace not recreated");
                        #[cfg(unix)]
                        if alias {
                            fs::remove_file(alias_path).unwrap();
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn phase08_11_store_parent_replacement_and_unwind_release_before_domain_lock() {
        let home = Home::new();
        for op in [
            "today_open",
            "today_mutate",
            "today_finalize_setup",
            "today_rollover",
        ] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let snapshot = load_snapshot(root, DAY).unwrap();
            let moved = root.with_extension("old");
            let key = today_dir(root);
            let held = Held::new(key.clone(), "before-admission");
            let pending = start(write(op, text(root), snapshot.clone()));
            held.wait();
            fs::rename(root, &moved).unwrap();
            fs::create_dir(root).unwrap();
            held.release();
            assert!(done(pending).is_err());
            assert!(!root.join(".maru").exists());
            fs::remove_dir(root).unwrap();
            fs::rename(&moved, root).unwrap();
            drop(held);
            let hook = PathTransactionTestHook::new(key, "admitted", || {
                panic!("fixture transaction unwind")
            });
            let err = run(write(op, text(root), snapshot.clone())).unwrap_err();
            assert!(err.message.contains("task_failed"));
            assert!(err.code.is_empty());
            drop(hook);
            run(write(op, text(root), snapshot)).unwrap();
        }
    }
    #[test]
    fn phase08_11_store_finalize_rolls_back_capture_failure_then_manual_retry() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let w = text(root);
        let snapshot = load_snapshot(root, DAY).unwrap();
        let mut req = request(&snapshot);
        let mut second = req.captures[0].clone();
        second.capture_id = "capture-2".into();
        req.captures.push(second);
        let plan = req.plan.as_mut().unwrap();
        let mut item = plan.flexible[0].clone();
        item.item_ref = PlanItemRef::Capture {
            capture_id: "capture-2".into(),
        };
        item.order = 1;
        plan.flexible.push(item);
        let prepared = prepare_capture_task_materialization(
            root,
            DAY,
            "capture-2",
            CreateTaskDraft {
                slug: "Synthetic capture".into(),
                title: "Synthetic capture".into(),
                frontmatter: BTreeMap::new(),
                body: "fixture".into(),
                bucket: TaskBucket::Active,
            },
        )
        .unwrap();
        let blocker = root.join(&prepared.rel_path);
        fs::create_dir(&blocker).unwrap();
        assert!(run(ipc::today_finalize_setup(w.clone(), req.clone())).is_err());
        assert_eq!(fs::read_dir(root.join("tasks/active")).unwrap().count(), 1);
        assert_eq!(
            load_snapshot(root, DAY).unwrap().revision,
            snapshot.revision
        );
        let journal: FinalizeJournal = serde_json::from_slice(
            &fs::read(finalize_journal_path(root, &req.idempotency_key)).unwrap(),
        )
        .unwrap();
        assert_eq!(journal.phase, FinalizeJournalPhase::RolledBack);
        fs::remove_dir(blocker).unwrap();
        let outcome = run(ipc::today_finalize_setup(w, req)).unwrap();
        assert_eq!(outcome.materialized.len(), 2);
        assert_eq!(fs::read_dir(root.join("tasks/active")).unwrap().count(), 2);
    }
    #[test]
    fn phase08_11_store_current_alias_policy_blocks_every_writer_and_open_is_read_only() {
        use crate::scratchpad::phase08_08::registry;
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let snapshot = load_snapshot(root, DAY).unwrap();
        let original = fs::read(state_path(root, DAY)).unwrap();
        let alias = home.root.path().join("store-alias");
        #[cfg(unix)]
        std::os::unix::fs::symlink(root, alias.as_path()).unwrap();
        for reverse in [false, true] {
            for policy in ["readOnly", "delegated"] {
                let (registered, caller) = if reverse {
                    (alias.as_path(), root)
                } else {
                    (root, alias.as_path())
                };
                registry(registered, policy);
                for op in [
                    "today_open",
                    "today_mutate",
                    "today_finalize_setup",
                    "today_rollover",
                ] {
                    assert!(
                        run(write(op, text(caller), snapshot.clone())).is_err(),
                        "{op}/{policy}"
                    );
                }
                let read = open(text(caller));
                assert_eq!(read.revision, snapshot.revision);
                assert_eq!(fs::read(state_path(root, DAY)).unwrap(), original);
                assert_eq!(fs::read_dir(root.join("tasks/active")).unwrap().count(), 0);
            }
        }
        registry(root, "direct");
        let registry_path = crate::vault_list::workspace_registry_path().unwrap();
        let mut value: JsonValue =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        value["workspaces"].as_array_mut().unwrap().push(json!({"label":"denied alias","path":text(&alias),"visibility":"private","provider":"local","writePolicy":"readOnly"}));
        fs::write(registry_path, value.to_string()).unwrap();
        assert!(run(write("today_finalize_setup", text(root), snapshot.clone())).is_err());
        registry(root, "direct");
        let held = Held::new(today_dir(root), "admitted");
        let pending = start(write("today_finalize_setup", text(root), snapshot.clone()));
        held.wait();
        registry(root, "readOnly");
        held.release();
        assert!(done(pending).is_err());
        registry(root, "direct");
        run(write("today_finalize_setup", text(root), snapshot)).unwrap();
    }
    #[test]
    fn phase08_11_store_document_journal_races_both_orders_preserve_manual_content() {
        let home = Home::new();
        for op in [
            "today_open",
            "today_mutate",
            "today_finalize_setup",
            "today_rollover",
        ] {
            for document_first in [false, true] {
                let tmp = fixture(&home);
                let root = tmp.path();
                let w = text(root);
                let mut snapshot = load_snapshot(root, DAY).unwrap();
                if matches!(op, "today_open" | "today_rollover") {
                    snapshot = run(ipc::today_mutate(
                        w.clone(),
                        DAY.into(),
                        snapshot.revision,
                        TodayMutation::QuickSkip,
                    ))
                    .unwrap();
                }
                let path = root.join("tasks/daily/2026-07-21.md");
                fs::create_dir_all(path.parent().unwrap()).unwrap();
                fs::write(&path, "# Manual original\n").unwrap();
                let doc = crate::document::ipc::save_document(
                    w.clone(),
                    text(&path),
                    "# Manual edited\n".into(),
                    Some(revision_for("# Manual original\n")),
                );
                let writer = async move {
                    if op == "today_mutate" {
                        ipc::today_mutate(
                            w,
                            DAY.into(),
                            snapshot.revision,
                            TodayMutation::QuickSkip,
                        )
                        .await
                    } else {
                        write(op, w, snapshot).await
                    }
                };
                if document_first {
                    let held = Held::new(path.clone(), "admitted");
                    let first = start(doc);
                    held.wait();
                    let waiting = Held::new(today_dir(root), "before-admission");
                    let second = start(writer);
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                    assert!(fs::read_to_string(&path)
                        .unwrap()
                        .contains("# Manual edited"));
                } else {
                    let held = Held::new(today_dir(root), "admitted");
                    let first = start(writer);
                    held.wait();
                    let waiting = Held::new(path.clone(), "before-admission");
                    let second = start(doc);
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert_eq!(
                        done(second).unwrap_err().code,
                        crate::ipc_error::DOCUMENT_CONFLICT
                    );
                    assert!(fs::read_to_string(&path)
                        .unwrap()
                        .contains("# Manual original"));
                }
                assert!(fs::read_to_string(path)
                    .unwrap()
                    .contains(JOURNAL_START_MARKER));
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn phase08_11_store_nested_sidecar_aliases_contend_with_physical_parent() {
        let home = Home::new();
        for (rel, op) in [
            ("tasks/active", "today_finalize_setup"),
            ("tasks/daily", "today_finalize_setup"),
            (".maru/today/events", "today_mutate"),
            (".maru/today/revisions", "today_mutate"),
            (".maru/today/finalize", "today_finalize_setup"),
            (".maru/today/outbox", "today_open"),
        ] {
            for parent_first in [false, true] {
                let tmp = fixture(&home);
                let root = tmp.path();
                let snapshot = load_snapshot(root, DAY).unwrap();
                let target = root.join(rel);
                let physical = home
                    .root
                    .path()
                    .join(format!("physical-{}", uuid::Uuid::new_v4()));
                if target.exists() {
                    fs::rename(&target, &physical).unwrap();
                } else {
                    fs::create_dir(&physical).unwrap();
                }
                fs::create_dir_all(target.parent().unwrap()).unwrap();
                std::os::unix::fs::symlink(&physical, &target).unwrap();
                if rel.ends_with("outbox") {
                    crate::today_outbox::enqueue_record(
                        root,
                        crate::today_outbox::OutboxRecordDraft {
                            op: crate::today_outbox::OutboxOp::Complete,
                            task_path: "tasks/active/missing.md".into(),
                            google_task_id: "synthetic".into(),
                            google_task_list_id: None,
                            payload: None,
                            status: crate::today_outbox::OutboxStatus::Syncing,
                            web_action_id: None,
                        },
                        "2026-07-21T09:00:00+09:00",
                    )
                    .unwrap();
                }
                let moved_name =
                    format!("moved-{}", physical.file_name().unwrap().to_string_lossy());
                let moved = home.root.path().join(&moved_name);
                let parent = crate::workspace_files::ipc::rename_workspace_entry(
                    text(home.root.path()),
                    text(&physical),
                    moved_name,
                );
                if parent_first {
                    let held = Held::new(physical.clone(), "admitted");
                    let first = start(parent);
                    held.wait();
                    let waiting = Held::new(today_dir(root), "before-admission");
                    let second = start(write(op, text(root), snapshot));
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert!(done(second).is_err());
                } else {
                    let held = Held::new(today_dir(root), "admitted");
                    let first = start(write(op, text(root), snapshot));
                    held.wait();
                    let waiting = Held::new(physical.clone(), "before-admission");
                    let second = start(parent);
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(20)).is_err());
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                    assert!(
                        fs::read_dir(&moved).unwrap().next().is_some(),
                        "{rel} has actual effect"
                    );
                }
                assert!(!physical.exists());
                assert!(moved.is_dir());
                fs::remove_file(target).unwrap();
            }
        }
    }
    #[test]
    fn phase08_11_store_open_recovers_crash_journal_without_deleting_edited_siblings() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let snapshot = load_snapshot(root, DAY).unwrap();
        let req = request(&snapshot);
        fs::write(root.join("tasks/active/unchanged.md"), "original").unwrap();
        fs::write(root.join("tasks/active/edited.md"), "user edited").unwrap();
        let path = finalize_journal_path(root, &req.idempotency_key);
        write_finalize_journal(
            &path,
            &FinalizeJournal {
                request_hash: "crash".into(),
                request: req,
                phase: FinalizeJournalPhase::Materializing,
                created_files: vec![
                    FinalizeCreatedFile {
                        rel_path: "tasks/active/unchanged.md".into(),
                        content_hash: revision_for("original"),
                    },
                    FinalizeCreatedFile {
                        rel_path: "tasks/active/edited.md".into(),
                        content_hash: revision_for("original"),
                    },
                ],
                materialized: vec![],
                outcome: None,
            },
        )
        .unwrap();
        assert_eq!(open(text(root)).revision, snapshot.revision);
        assert!(!root.join("tasks/active/unchanged.md").exists());
        assert_eq!(
            fs::read_to_string(root.join("tasks/active/edited.md")).unwrap(),
            "user edited"
        );
        let journal: FinalizeJournal = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(journal.phase, FinalizeJournalPhase::RolledBack);
        assert_eq!(journal.created_files.len(), 1);
    }
}
