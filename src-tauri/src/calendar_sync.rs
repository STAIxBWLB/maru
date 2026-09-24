// Maru Calendar sync — one-way reconcile of timed notes to the configured
// Google calendar (issue #316).
//
// The markdown note is the source of truth: every note under `tasks/` and
// `calendar/` carrying `calendarStart` (optionally `calendarEnd`, `timezone`)
// owns one remote event, keyed by the note's `calendarEventId`. A run diffs
// the notes against a small ledger (`.maru/today/calendar-sync.json`, keyed
// by event id, holding the last synced payload) and enqueues `calendarUpsert`
// / `calendarDelete` records into the Google outbox, then drains them. Retry
// backoff, auth blocking, crash recovery and the id-before-write-back order
// are therefore the same mechanism Google Tasks already uses (today_outbox).
//
// Two triggers, one entry point: `calendar_sync_run` is what the
// `maru calendar-sync` CLI (daily `.maru/jobs.json` job) and the IPC command
// behind the Today "sync notes" button both call.
//
// Destination: `task_management.google.calendar.default_calendar` in
// `workspace.config.yaml`, resolved to the calendar id. There is no fallback;
// an unresolved destination is an error and calendars under `read_only` are
// refused, so the retired personal calendar can never be written by accident.
//
// Existence check: none is needed. A patch against an event that was deleted
// remotely answers 404/410, which the outbox classifies as terminal and turns
// into a fresh insert (the upsert-recreate path). The sync stays inside the
// declared `calendar.write` capability.
//
// Adoption: a note that already carries `calendarEventId` (imported by the
// task-management skill) but is unknown to the ledger is adopted without a
// provider call, trusting the backref. Notes whose `calendarId` names another
// calendar are never touched.
//
// ponytail: outbox claims are process-local (today_outbox ACTIVE_OUTBOX). The
// daily CLI run and an app-side drain in the same second could both claim one
// record and double-insert; add a file-lock claim in task_integrations_drain
// if that ever shows up in the ledger (two events, one note).

use crate::atomic_file::write_atomic;
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::inbox_settings::workspace_config_path;
use crate::today::parse_timezone;
use crate::today_calendar::{
    parse_event_time, string_field, CalendarPublishReservation, COMMITMENT_ROOTS,
};
use crate::today_outbox::{
    enqueue_record, list_records, task_integrations_drain, CalendarPayload, OutboxOp, OutboxRecord,
    OutboxRecordDraft, OutboxStatus,
};
use crate::today_store::today_dir;
use crate::vault::{
    load_maruignore, matches_maruignore, normalize_existing_dir, parse_frontmatter,
};
use chrono::{DateTime, Duration};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

// --- Destination -------------------------------------------------------------

/// Calendar section of `workspace.config.yaml` (`task_management.google.calendar`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CalendarDestinations {
    pub default_key: Option<String>,
    /// Write destinations: config key → calendar id.
    pub calendars: BTreeMap<String, String>,
    /// Calendars that must never be written: config key → calendar id.
    pub read_only: BTreeMap<String, String>,
    /// `task_management.timezone`, the default for notes without `timezone`.
    pub timezone: Option<String>,
}

fn yaml_str(value: Option<&serde_yaml::Value>) -> Option<String> {
    value
        .and_then(serde_yaml::Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(ToString::to_string)
}

impl CalendarDestinations {
    pub fn load(work: &Path) -> Result<Self, String> {
        let path = workspace_config_path(work);
        if !path.is_file() {
            return Ok(Self::default());
        }
        let raw = fs::read_to_string(&path)
            .map_err(|err| format!("Cannot read workspace.config.yaml: {err}"))?;
        let yaml: serde_yaml::Value = serde_yaml::from_str(&raw)
            .map_err(|err| format!("Cannot parse workspace.config.yaml: {err}"))?;
        let task_management = yaml.get("task_management");
        let calendar = task_management
            .and_then(|value| value.get("google"))
            .and_then(|value| value.get("calendar"));
        let ids = |section: &str| -> BTreeMap<String, String> {
            calendar
                .and_then(|value| value.get(section))
                .and_then(serde_yaml::Value::as_mapping)
                .map(|mapping| {
                    mapping
                        .iter()
                        .filter_map(|(key, value)| {
                            Some((key.as_str()?.to_string(), yaml_str(value.get("id"))?))
                        })
                        .collect()
                })
                .unwrap_or_default()
        };
        Ok(Self {
            default_key: yaml_str(calendar.and_then(|value| value.get("default_calendar"))),
            calendars: ids("calendars"),
            read_only: ids("read_only"),
            timezone: yaml_str(task_management.and_then(|value| value.get("timezone"))),
        })
    }

    /// Destination calendar id for an optional override (a config key or a
    /// literal id). Never guesses: no configured default is an error, and a
    /// read-only calendar is refused whether named by key or by id.
    pub fn resolve(&self, requested: Option<&str>) -> Result<String, String> {
        let requested = requested.map(str::trim).filter(|text| !text.is_empty());
        let key_or_id = match requested {
            Some(value) => value.to_string(),
            None => self.default_key.clone().ok_or_else(|| {
                "calendar_destination_unresolved: set task_management.google.calendar.default_calendar in workspace.config.yaml".to_string()
            })?,
        };
        if let Some(id) = self.calendars.get(&key_or_id) {
            return Ok(id.clone());
        }
        if let Some((key, id)) = self
            .read_only
            .iter()
            .find(|(key, id)| **key == key_or_id || **id == key_or_id)
        {
            return Err(format!(
                "calendar_destination_read_only: {key} ({id}) is not a write destination"
            ));
        }
        if requested.is_none() {
            return Err(format!(
                "calendar_destination_unresolved: default_calendar '{key_or_id}' has no task_management.google.calendar.calendars entry"
            ));
        }
        Ok(key_or_id)
    }

    /// A note's `calendarId` (key or id) names the destination calendar.
    fn is_destination(&self, calendar: &str, destination: &str) -> bool {
        let calendar = calendar.trim();
        calendar == destination
            || self
                .calendars
                .get(calendar)
                .is_some_and(|id| id == destination)
    }
}

// --- Ledger --------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LedgerEntry {
    pub rel_path: String,
    pub calendar_id: String,
    pub payload: CalendarPayload,
    pub synced_at: String,
}

/// Last synced payload per event id. Tiny, rewritten whole; keyed by event id
/// so a note that moves buckets (active → archive) keeps its event.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Ledger {
    pub schema: u32,
    #[serde(default)]
    pub events: BTreeMap<String, LedgerEntry>,
}

impl Default for Ledger {
    fn default() -> Self {
        Self {
            schema: 1,
            events: BTreeMap::new(),
        }
    }
}

pub(crate) fn ledger_path(work: &Path) -> PathBuf {
    today_dir(work).join("calendar-sync.json")
}

pub(crate) fn load_ledger(work: &Path) -> Result<Ledger, String> {
    let path = ledger_path(work);
    if !path.is_file() {
        return Ok(Ledger::default());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read calendar sync ledger: {err}"))?;
    serde_json::from_str(&raw).map_err(|err| format!("Cannot parse calendar sync ledger: {err}"))
}

fn save_ledger(work: &Path, ledger: &Ledger) -> Result<(), String> {
    let path = ledger_path(work);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create calendar sync ledger dir: {err}"))?;
    }
    let raw = serde_json::to_string_pretty(ledger)
        .map_err(|err| format!("Cannot encode calendar sync ledger: {err}"))?;
    write_atomic(&path, raw.as_bytes())
}

// --- Drain settlement (called by today_outbox) ---------------------------------

fn note_frontmatter(raw: &str) -> JsonValue {
    crate::tasks::normalize_task_frontmatter_aliases(crate::tasks::yaml_to_json(
        &parse_frontmatter(raw).meta,
    ))
}

/// After a successful insert/patch: put `calendarEventId`/`calendarId` on the
/// note (fill only what is missing; a note pointing at a different event is a
/// conflict, not a winner to pick) and record the payload in the ledger.
pub(crate) fn write_back_event_id(work: &Path, record: &OutboxRecord) -> Result<(), String> {
    let path = work.join(&record.task_path);
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read note: {err}"))?;
    let frontmatter = note_frontmatter(&raw);
    let existing = crate::tasks::string_field(&frontmatter, "calendarEventId");
    if let Some(existing) = &existing {
        if existing != &record.google_task_id {
            return Err(format!(
                "note_relinked: note points at {existing}, record at {}",
                record.google_task_id
            ));
        }
    }
    let mut updated = raw.clone();
    if existing.is_none() {
        updated = update_frontmatter_content(
            &updated,
            "calendarEventId",
            Some(FrontmatterValue::String(record.google_task_id.clone())),
        )?;
    }
    if let Some(calendar) = &record.calendar_id {
        if crate::tasks::string_field(&frontmatter, "calendarId").is_none() {
            updated = update_frontmatter_content(
                &updated,
                "calendarId",
                Some(FrontmatterValue::String(calendar.clone())),
            )?;
        }
    }
    if updated != raw {
        write_atomic(&path, updated.as_bytes())?;
    }
    if let Some(payload) = &record.calendar {
        let mut ledger = load_ledger(work)?;
        ledger.events.insert(
            record.google_task_id.clone(),
            LedgerEntry {
                rel_path: record.task_path.clone(),
                calendar_id: record.calendar_id.clone().unwrap_or_default(),
                payload: payload.clone(),
                synced_at: record.updated_at.clone(),
            },
        );
        save_ledger(work, &ledger)?;
    }
    Ok(())
}

/// After a successful (or already-gone) delete: clear the note's backref when
/// the note still exists and still points at this event, and forget the event.
pub(crate) fn settle_deleted_event(work: &Path, record: &OutboxRecord) -> Result<(), String> {
    let path = work.join(&record.task_path);
    if path.is_file() {
        let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read note: {err}"))?;
        let frontmatter = note_frontmatter(&raw);
        if crate::tasks::string_field(&frontmatter, "calendarEventId").as_deref()
            == Some(record.google_task_id.as_str())
        {
            let mut updated = update_frontmatter_content(&raw, "calendarEventId", None)?;
            updated = update_frontmatter_content(&updated, "calendarId", None)?;
            if updated != raw {
                write_atomic(&path, updated.as_bytes())?;
            }
        }
    }
    let mut ledger = load_ledger(work)?;
    if ledger.events.remove(&record.google_task_id).is_some() {
        save_ledger(work, &ledger)?;
    }
    Ok(())
}

// --- Scan ------------------------------------------------------------------------

#[derive(Debug, Clone)]
struct TimedNote {
    rel_path: String,
    calendar_id: Option<String>,
    event_id: Option<String>,
    cancelled: bool,
    payload: CalendarPayload,
}

#[derive(Debug, Default)]
struct Scan {
    /// Notes with a parseable `calendarStart`, `tasks/` before `calendar/`.
    timed: Vec<TimedNote>,
    /// Every note carrying a `calendarEventId`, timed or not: event id → paths.
    backrefs: HashMap<String, Vec<String>>,
}

fn scan_notes(work: &Path, default_tz: Tz) -> Result<Scan, String> {
    let ignore_patterns = load_maruignore(work);
    let mut scan = Scan::default();
    for root in COMMITMENT_ROOTS {
        let root_path = work.join(root);
        if !root_path.is_dir() {
            continue;
        }
        let mut entries: Vec<PathBuf> = WalkDir::new(&root_path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
            .map(|entry| entry.into_path())
            .filter(|path| {
                path.extension()
                    .and_then(|ext| ext.to_str())
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("md"))
            })
            .collect();
        entries.sort();
        for path in entries {
            let rel_path = path
                .strip_prefix(work)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if matches_maruignore(Path::new(&rel_path), &ignore_patterns) {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let frontmatter = note_frontmatter(&raw);
            let event_id = string_field(&frontmatter, &["calendarEventId", "calendar_event_id"])
                .map(ToString::to_string);
            if let Some(id) = &event_id {
                scan.backrefs
                    .entry(id.clone())
                    .or_default()
                    .push(rel_path.clone());
            }
            let Some(start_raw) = string_field(&frontmatter, &["calendarStart", "calendar_start"])
            else {
                continue;
            };
            let note_tz = string_field(&frontmatter, &["timezone"])
                .and_then(|iana| parse_timezone(iana).ok())
                .unwrap_or(default_tz);
            let Some(start) = parse_event_time(start_raw, note_tz) else {
                continue;
            };
            let end = string_field(&frontmatter, &["calendarEnd", "calendar_end"])
                .and_then(|value| parse_event_time(value, note_tz))
                .filter(|end| *end > start)
                .unwrap_or(start + Duration::hours(1));
            let summary = string_field(&frontmatter, &["title"])
                .map(ToString::to_string)
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|stem| stem.to_str())
                        .unwrap_or("event")
                        .to_string()
                });
            let cancelled = string_field(&frontmatter, &["status"])
                .is_some_and(|status| status.eq_ignore_ascii_case("cancelled"));
            scan.timed.push(TimedNote {
                rel_path,
                calendar_id: string_field(&frontmatter, &["calendarId", "calendar_id"])
                    .map(ToString::to_string),
                event_id,
                cancelled,
                payload: CalendarPayload {
                    summary,
                    start_iso: start.to_rfc3339(),
                    end_iso: end.to_rfc3339(),
                    time_zone: note_tz.name().to_string(),
                },
            });
        }
    }
    Ok(scan)
}

// --- Reconcile ---------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncChange {
    pub rel_path: String,
    /// `insert` | `patch` | `delete` | `adopt` | `skipForeign` | `pending`
    pub action: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSyncOutcome {
    pub destination: String,
    pub dry_run: bool,
    /// Timed notes considered.
    pub scanned: usize,
    /// Ops planned this run (enqueued unless `dry_run`).
    pub inserts: usize,
    pub patches: usize,
    pub deletes: usize,
    /// Backrefs adopted into the ledger without a provider call.
    pub adopted: usize,
    pub unchanged: usize,
    /// Notes whose `calendarId` names another calendar; never touched.
    pub skipped_foreign: usize,
    /// Notes with an outbox record still in flight; not re-planned.
    pub pending: usize,
    /// Outbox drain totals for this run (all due records, calendar or tasks).
    pub drained: usize,
    pub failed: usize,
    pub blocked: usize,
    pub changes: Vec<CalendarSyncChange>,
}

fn upsert_draft(note: &TimedNote, destination: &str, event_id: Option<&str>) -> OutboxRecordDraft {
    OutboxRecordDraft {
        op: OutboxOp::CalendarUpsert,
        task_path: note.rel_path.clone(),
        google_task_id: event_id.unwrap_or_default().to_string(),
        google_task_list_id: None,
        payload: None,
        status: OutboxStatus::Ready,
        web_action_id: None,
        calendar_id: Some(destination.to_string()),
        calendar: Some(note.payload.clone()),
    }
}

/// Reconcile every timed note with the destination calendar, then drain the
/// outbox. Idempotent: a second run over an unchanged note set plans nothing.
/// `dry_run` reports the plan and writes nothing (no ledger, no records, no
/// provider calls).
pub fn calendar_sync_run(
    work_path: String,
    destination: Option<String>,
    gws_path: Option<String>,
    now_iso: String,
    dry_run: bool,
) -> Result<CalendarSyncOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?;
    let _reservation = CalendarPublishReservation::acquire(&work)?;
    let destinations = CalendarDestinations::load(&work)?;
    let destination = destinations.resolve(destination.as_deref())?;
    let tz = destinations
        .timezone
        .as_deref()
        .map(parse_timezone)
        .transpose()?
        .unwrap_or(chrono_tz::UTC);
    let scan = scan_notes(&work, tz)?;
    let mut ledger = load_ledger(&work)?;
    let records = list_records(&work)?;
    let in_flight: Vec<&OutboxRecord> = records
        .iter()
        .filter(|record| record.op.is_calendar() && record.status != OutboxStatus::Synced)
        .collect();
    let pending_paths: HashSet<&str> = in_flight
        .iter()
        .map(|record| record.task_path.as_str())
        .collect();
    let pending_events: HashSet<&str> = in_flight
        .iter()
        .map(|record| record.google_task_id.as_str())
        .filter(|id| !id.is_empty())
        .collect();

    let mut outcome = CalendarSyncOutcome {
        destination: destination.clone(),
        dry_run,
        ..CalendarSyncOutcome::default()
    };
    let mut drafts: Vec<OutboxRecordDraft> = Vec::new();
    let mut ledger_dirty = false;
    let mut live_events: HashSet<String> = HashSet::new();
    let mut change = |rel_path: &str, action: &str, event_id: Option<&str>| {
        outcome.changes.push(CalendarSyncChange {
            rel_path: rel_path.to_string(),
            action: action.to_string(),
            event_id: event_id.map(ToString::to_string),
        });
    };

    for note in &scan.timed {
        outcome.scanned += 1;
        if let Some(calendar) = &note.calendar_id {
            if !destinations.is_destination(calendar, &destination) {
                outcome.skipped_foreign += 1;
                change(&note.rel_path, "skipForeign", note.event_id.as_deref());
                continue;
            }
        }
        if note.cancelled {
            // Not live: the sweep below deletes its event if the ledger knows it.
            continue;
        }
        if pending_paths.contains(note.rel_path.as_str()) {
            outcome.pending += 1;
            change(&note.rel_path, "pending", note.event_id.as_deref());
            continue;
        }
        match &note.event_id {
            Some(id) => {
                // ponytail: a task note and its calendar/ receipt can share one
                // event id; tasks/ sorts first and wins, the receipt is a no-op.
                if !live_events.insert(id.clone()) {
                    outcome.unchanged += 1;
                    continue;
                }
                match ledger.events.get(id) {
                    Some(entry) if entry.payload == note.payload => {
                        outcome.unchanged += 1;
                        let ledger_path_alive = scan
                            .backrefs
                            .values()
                            .flatten()
                            .any(|path| *path == entry.rel_path);
                        if entry.rel_path != note.rel_path && !ledger_path_alive {
                            // The note moved (e.g. active → archive); follow it.
                            if let Some(entry) = ledger.events.get_mut(id) {
                                entry.rel_path = note.rel_path.clone();
                                ledger_dirty = true;
                            }
                        }
                    }
                    Some(_) => {
                        outcome.patches += 1;
                        change(&note.rel_path, "patch", Some(id));
                        drafts.push(upsert_draft(note, &destination, Some(id)));
                    }
                    None => {
                        outcome.adopted += 1;
                        change(&note.rel_path, "adopt", Some(id));
                        ledger.events.insert(
                            id.clone(),
                            LedgerEntry {
                                rel_path: note.rel_path.clone(),
                                calendar_id: destination.clone(),
                                payload: note.payload.clone(),
                                synced_at: now_iso.clone(),
                            },
                        );
                        ledger_dirty = true;
                    }
                }
            }
            None => {
                outcome.inserts += 1;
                change(&note.rel_path, "insert", None);
                drafts.push(upsert_draft(note, &destination, None));
            }
        }
    }

    // Sweep: a ledger event no live timed note claims any more (times removed,
    // note cancelled or deleted) is deleted remotely and its backref cleared.
    for (event_id, entry) in &ledger.events {
        if live_events.contains(event_id) || pending_events.contains(event_id.as_str()) {
            continue;
        }
        let rel_path = scan
            .backrefs
            .get(event_id)
            .and_then(|paths| paths.first())
            .cloned()
            .unwrap_or_else(|| entry.rel_path.clone());
        outcome.deletes += 1;
        change(&rel_path, "delete", Some(event_id));
        drafts.push(OutboxRecordDraft {
            op: OutboxOp::CalendarDelete,
            task_path: rel_path,
            google_task_id: event_id.clone(),
            google_task_list_id: None,
            payload: None,
            status: OutboxStatus::Ready,
            web_action_id: None,
            calendar_id: Some(entry.calendar_id.clone()),
            calendar: None,
        });
    }

    if dry_run {
        return Ok(outcome);
    }
    if ledger_dirty {
        save_ledger(&work, &ledger)?;
    }
    for draft in drafts {
        enqueue_record(&work, draft, &now_iso)?;
    }
    let drain = task_integrations_drain(work_path, now_iso, gws_path)?;
    outcome.drained = drain.drained;
    outcome.failed = drain.failed;
    outcome.blocked = drain.blocked;
    Ok(outcome)
}

// --- CLI -----------------------------------------------------------------------------

pub(crate) fn calendar_sync_usage() -> &'static str {
    "usage: maru calendar-sync [--work <path>] [--destination <key-or-id>] [--gws <path>] [--dry-run] [--json]"
}

/// `maru calendar-sync`: the daily job's entry point. Exit 0 when nothing
/// failed or blocked, 1 otherwise, 2 on usage errors.
pub(crate) fn run_calendar_sync(args: &[String]) -> i32 {
    let mut work: Option<String> = None;
    let mut destination: Option<String> = None;
    let mut gws: Option<String> = None;
    let mut dry_run = false;
    let mut json = false;
    let mut iter = args.iter();
    while let Some(arg) = iter.next() {
        match arg.as_str() {
            "--dry-run" => dry_run = true,
            "--json" => json = true,
            "--work" | "--destination" | "--gws" => {
                let Some(value) = iter.next() else {
                    eprintln!("{arg} requires a value");
                    eprintln!("{}", calendar_sync_usage());
                    return 2;
                };
                match arg.as_str() {
                    "--work" => work = Some(value.clone()),
                    "--destination" => destination = Some(value.clone()),
                    _ => gws = Some(value.clone()),
                }
            }
            other => {
                eprintln!("unknown option: {other}");
                eprintln!("{}", calendar_sync_usage());
                return 2;
            }
        }
    }
    let work = work.or_else(|| {
        std::env::current_dir()
            .ok()
            .map(|path| path.to_string_lossy().to_string())
    });
    let Some(work) = work else {
        eprintln!("cannot resolve current directory");
        return 1;
    };
    let now_iso = chrono::Local::now().to_rfc3339();
    match calendar_sync_run(work, destination, gws, now_iso, dry_run) {
        Ok(outcome) => {
            if json {
                println!(
                    "{}",
                    serde_json::to_string_pretty(&outcome).unwrap_or_default()
                );
            } else {
                println!(
                    "calendar-sync{}: {} → scanned {}, insert {}, patch {}, delete {}, adopt {}, unchanged {}, foreign {}, pending {}; drained {}, failed {}, blocked {}",
                    if outcome.dry_run { " (dry run)" } else { "" },
                    outcome.destination,
                    outcome.scanned,
                    outcome.inserts,
                    outcome.patches,
                    outcome.deletes,
                    outcome.adopted,
                    outcome.unchanged,
                    outcome.skipped_foreign,
                    outcome.pending,
                    outcome.drained,
                    outcome.failed,
                    outcome.blocked,
                );
                for change in &outcome.changes {
                    println!(
                        "  {:<12} {}{}",
                        change.action,
                        change.rel_path,
                        change
                            .event_id
                            .as_deref()
                            .map(|id| format!(" [{id}]"))
                            .unwrap_or_default()
                    );
                }
            }
            if outcome.failed == 0 && outcome.blocked == 0 {
                0
            } else {
                1
            }
        }
        Err(err) => {
            eprintln!("{err}");
            1
        }
    }
}

pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn calendar_sync_run(
        work_path: String,
        destination: Option<String>,
        gws_path: Option<String>,
        now_iso: String,
        dry_run: bool,
    ) -> Result<CalendarSyncOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:calendar_sync_run",
            );
            super::calendar_sync_run(work_path, destination, gws_path, now_iso, dry_run)
        })
        .await
        .map_err(|err| format!("calendar_sync_run_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today_outbox::{read_task_integrations, task_integrations_retry};

    const NOW: &str = "2026-07-21T09:00:00+09:00";
    const CHU_AIO: &str = "c_chuaio@group.calendar.google.com";
    const CONFIG: &str = "task_management:\n  timezone: Asia/Seoul\n  google:\n    calendar:\n      default_calendar: chu_aio\n      calendars:\n        chu_aio: { id: c_chuaio@group.calendar.google.com, label: CHU-AIO }\n      read_only:\n        chu_rise: { id: c_rise@group.calendar.google.com, label: CHU-RISE }\n        primary: { id: hello@example.com, label: Primary }\n";

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn fixture() -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        write(&tmp.path().join("workspace.config.yaml"), CONFIG);
        tmp
    }

    /// Fake gws that logs argv and answers a fixed event id.
    fn fake_gws(dir: &Path, name: &str, event_id: &str) -> (PathBuf, PathBuf) {
        let log = dir.join(format!("{name}.log"));
        let bin = dir.join(name);
        fs::write(
            &bin,
            format!(
                "#!/bin/sh\necho \"$@\" >> {}\necho '{{\"id\":\"{event_id}\"}}'\nexit 0\n",
                log.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        (bin, log)
    }

    fn run(tmp: &tempfile::TempDir, gws: &Path, now: &str) -> CalendarSyncOutcome {
        calendar_sync_run(
            tmp.path().to_string_lossy().to_string(),
            None,
            Some(gws.to_string_lossy().to_string()),
            now.to_string(),
            false,
        )
        .unwrap()
    }

    fn count(log: &Path, needle: &str) -> usize {
        fs::read_to_string(log)
            .unwrap_or_default()
            .lines()
            .filter(|line| line.contains(needle))
            .count()
    }

    fn note(tmp: &tempfile::TempDir, rel: &str) -> String {
        fs::read_to_string(tmp.path().join(rel)).unwrap()
    }

    const FOCUS: &str =
        "---\ntitle: 집중 작업\ncalendarStart: 2026-07-21T10:00\ncalendarEnd: 2026-07-21T11:00\n---\n# Body\n";

    #[test]
    fn calendar_sync_destination_comes_from_config_and_never_guesses() {
        let tmp = fixture();
        let destinations = CalendarDestinations::load(tmp.path()).unwrap();
        assert_eq!(destinations.resolve(None).unwrap(), CHU_AIO);
        assert_eq!(destinations.resolve(Some("chu_aio")).unwrap(), CHU_AIO);
        assert_eq!(destinations.resolve(Some(" chu_aio ")).unwrap(), CHU_AIO);
        // A literal id that is not read-only passes through.
        assert_eq!(
            destinations
                .resolve(Some("other@group.calendar.google.com"))
                .unwrap(),
            "other@group.calendar.google.com"
        );
        // Read-only calendars are refused by key and by id; "primary" included.
        for refused in ["primary", "hello@example.com", "chu_rise"] {
            let err = destinations.resolve(Some(refused)).unwrap_err();
            assert!(
                err.starts_with("calendar_destination_read_only"),
                "{refused}: {err}"
            );
        }
        // No config at all: no default, no guess.
        let bare = tempfile::tempdir().unwrap();
        let err = CalendarDestinations::load(bare.path())
            .unwrap()
            .resolve(None)
            .unwrap_err();
        assert!(err.starts_with("calendar_destination_unresolved"), "{err}");
        // A default key without a calendars entry is an error too.
        write(
            &bare.path().join("workspace.config.yaml"),
            "task_management:\n  google:\n    calendar:\n      default_calendar: ghost\n",
        );
        let err = CalendarDestinations::load(bare.path())
            .unwrap()
            .resolve(None)
            .unwrap_err();
        assert!(err.contains("ghost"), "{err}");
        // And a run against an unresolved destination fails before any provider call.
        let (gws, log) = fake_gws(bare.path(), "gws-never", "evt-x");
        write(&bare.path().join("tasks/active/focus.md"), FOCUS);
        let err = calendar_sync_run(
            bare.path().to_string_lossy().to_string(),
            None,
            Some(gws.to_string_lossy().to_string()),
            NOW.to_string(),
            false,
        )
        .unwrap_err();
        assert!(err.starts_with("calendar_destination_unresolved"), "{err}");
        assert!(!log.exists());
    }

    #[test]
    fn calendar_sync_inserts_once_and_is_idempotent() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);

        let first = run(&tmp, &gws, NOW);
        assert_eq!((first.inserts, first.drained, first.failed), (1, 1, 0));
        assert_eq!(first.destination, CHU_AIO);
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("calendar events insert"));
        assert!(logged.contains(&format!(r#"{{"calendarId":"{CHU_AIO}"}}"#)));
        assert!(logged.contains(r#""summary":"집중 작업""#));
        assert!(logged.contains(r#""dateTime":"2026-07-21T10:00:00+09:00""#));
        assert!(logged.contains(r#""timeZone":"Asia/Seoul""#));
        let body = note(&tmp, "tasks/active/focus.md");
        assert!(body.contains("calendarEventId: evt-1"), "{body}");
        assert!(body.contains(&format!("calendarId: {CHU_AIO}")), "{body}");
        assert!(body.contains("# Body"));
        let ledger = load_ledger(tmp.path()).unwrap();
        assert_eq!(ledger.events["evt-1"].rel_path, "tasks/active/focus.md");

        let second = run(&tmp, &gws, "2026-07-21T09:05:00+09:00");
        assert_eq!(second.inserts, 0);
        assert_eq!(second.patches, 0);
        assert_eq!(second.deletes, 0);
        assert_eq!(second.unchanged, 1);
        assert_eq!(count(&log, "events insert"), 1);
        assert_eq!(
            read_task_integrations(tmp.path().to_string_lossy().to_string())
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn calendar_sync_patches_when_times_change_and_keeps_event_id() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        run(&tmp, &gws, NOW);

        let moved = note(&tmp, "tasks/active/focus.md").replace("T10:00", "T14:00");
        write(&tmp.path().join("tasks/active/focus.md"), &moved);
        let outcome = run(&tmp, &gws, "2026-07-21T09:05:00+09:00");
        assert_eq!(
            (outcome.patches, outcome.inserts, outcome.drained),
            (1, 0, 1)
        );
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("calendar events patch"));
        assert!(logged.contains(r#""eventId":"evt-1""#));
        assert!(logged.contains(r#""dateTime":"2026-07-21T14:00:00+09:00""#));
        assert_eq!(count(&log, "events insert"), 1);
        assert!(note(&tmp, "tasks/active/focus.md").contains("calendarEventId: evt-1"));
        let ledger = load_ledger(tmp.path()).unwrap();
        assert_eq!(
            ledger.events["evt-1"].payload.start_iso,
            "2026-07-21T14:00:00+09:00"
        );

        // Moving the note between buckets keeps the event and follows the path.
        fs::create_dir_all(tmp.path().join("tasks/archive")).unwrap();
        fs::rename(
            tmp.path().join("tasks/active/focus.md"),
            tmp.path().join("tasks/archive/focus.md"),
        )
        .unwrap();
        let outcome = run(&tmp, &gws, "2026-07-21T09:10:00+09:00");
        assert_eq!(
            (outcome.patches, outcome.deletes, outcome.unchanged),
            (0, 0, 1)
        );
        assert_eq!(
            load_ledger(tmp.path()).unwrap().events["evt-1"].rel_path,
            "tasks/archive/focus.md"
        );
    }

    #[test]
    fn calendar_sync_deletes_when_times_removed_or_note_deleted() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        run(&tmp, &gws, NOW);

        // Times removed: remote delete, backref cleared, ledger forgets it.
        let stripped = note(&tmp, "tasks/active/focus.md")
            .lines()
            .filter(|line| !line.starts_with("calendarStart") && !line.starts_with("calendarEnd"))
            .collect::<Vec<_>>()
            .join("\n");
        write(&tmp.path().join("tasks/active/focus.md"), &stripped);
        let outcome = run(&tmp, &gws, "2026-07-21T09:05:00+09:00");
        assert_eq!((outcome.deletes, outcome.drained), (1, 1));
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("calendar events delete"));
        assert!(logged.contains(r#""eventId":"evt-1""#));
        let body = note(&tmp, "tasks/active/focus.md");
        assert!(!body.contains("calendarEventId"), "{body}");
        assert!(!body.contains("calendarId"), "{body}");
        assert!(body.contains("title: 집중 작업"));
        assert!(load_ledger(tmp.path()).unwrap().events.is_empty());

        // Note deleted outright: the ledger alone drives the delete.
        let (gws2, log2) = fake_gws(tmp.path(), "gws-two", "evt-2");
        write(
            &tmp.path().join("calendar/standup.md"),
            FOCUS.replace("집중 작업", "스탠드업").as_str(),
        );
        run(&tmp, &gws2, "2026-07-21T09:10:00+09:00");
        assert!(load_ledger(tmp.path())
            .unwrap()
            .events
            .contains_key("evt-2"));
        fs::remove_file(tmp.path().join("calendar/standup.md")).unwrap();
        let outcome = run(&tmp, &gws2, "2026-07-21T09:15:00+09:00");
        assert_eq!(outcome.deletes, 1);
        assert_eq!(count(&log2, "events delete"), 1);
        assert!(load_ledger(tmp.path()).unwrap().events.is_empty());

        // Cancelled notes count as removed too.
        write(&tmp.path().join("tasks/active/cancel.md"), FOCUS);
        run(&tmp, &gws2, "2026-07-21T09:20:00+09:00");
        let cancelled = note(&tmp, "tasks/active/cancel.md")
            .replace("---\ntitle", "---\nstatus: cancelled\ntitle");
        write(&tmp.path().join("tasks/active/cancel.md"), &cancelled);
        let outcome = run(&tmp, &gws2, "2026-07-21T09:25:00+09:00");
        assert_eq!(outcome.deletes, 1);
        assert!(!note(&tmp, "tasks/active/cancel.md").contains("calendarEventId"));
    }

    #[test]
    fn calendar_sync_adopts_imported_backrefs_and_skips_foreign_calendars() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-new");
        write(
            &tmp.path().join("calendar/imported.md"),
            &format!("---\ntitle: 수업\ncalendarId: {CHU_AIO}\ncalendarEventId: evt-imp\ncalendarStart: \"2026-07-21T13:00:00+09:00\"\ncalendarEnd: \"2026-07-21T14:00:00+09:00\"\n---\n"),
        );
        write(
            &tmp.path().join("calendar/by-key.md"),
            "---\ntitle: 키로 표기\ncalendarId: chu_aio\ncalendarEventId: evt-key\ncalendarStart: 2026-07-21T15:00\n---\n",
        );
        write(
            &tmp.path().join("calendar/rise.md"),
            "---\ntitle: RISE\ncalendarId: c_rise@group.calendar.google.com\ncalendarEventId: evt-rise\ncalendarStart: 2026-07-21T16:00\n---\n",
        );
        write(
            &tmp.path().join("calendar/personal.md"),
            "---\ntitle: 개인\ncalendarId: primary\ncalendarStart: 2026-07-21T17:00\n---\n",
        );
        let outcome = run(&tmp, &gws, NOW);
        assert_eq!(outcome.adopted, 2);
        assert_eq!(outcome.skipped_foreign, 2);
        assert_eq!(outcome.inserts, 0);
        assert!(!log.exists(), "adoption must not call the provider");
        let ledger = load_ledger(tmp.path()).unwrap();
        assert_eq!(ledger.events.len(), 2);
        assert!(ledger.events.contains_key("evt-imp"));
        assert!(ledger.events.contains_key("evt-key"));

        // Editing an adopted note patches the adopted event id.
        let edited =
            note(&tmp, "calendar/imported.md").replace("T13:00:00+09:00", "T13:30:00+09:00");
        write(&tmp.path().join("calendar/imported.md"), &edited);
        let outcome = run(&tmp, &gws, "2026-07-21T09:05:00+09:00");
        assert_eq!(outcome.patches, 1);
        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains(r#""eventId":"evt-imp""#));
        // A task note and its receipt sharing one event id stay one event.
        write(&tmp.path().join("tasks/active/imported-task.md"), &edited);
        let outcome = run(&tmp, &gws, "2026-07-21T09:10:00+09:00");
        // imported.md, by-key.md and the receipt-sharing task note: all unchanged.
        assert_eq!(
            (outcome.patches, outcome.deletes, outcome.unchanged),
            (0, 0, 3)
        );
    }

    #[test]
    fn calendar_sync_auth_failure_blocks_and_retries_through_outbox() {
        let tmp = fixture();
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        let denied = tmp.path().join("gws-denied");
        fs::write(
            &denied,
            "#!/bin/sh\necho 'Error: token expired, please login again' >&2\nexit 1\n",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&denied, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let outcome = run(&tmp, &denied, NOW);
        assert_eq!(
            (outcome.inserts, outcome.blocked, outcome.drained),
            (1, 1, 0)
        );
        let work_path = tmp.path().to_string_lossy().to_string();
        let records = read_task_integrations(work_path.clone()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, OutboxStatus::AuthBlocked);
        assert_eq!(records[0].op, OutboxOp::CalendarUpsert);
        assert!(!note(&tmp, "tasks/active/focus.md").contains("calendarEventId"));

        // A second run does not queue a duplicate while the record is blocked.
        let again = run(&tmp, &denied, "2026-07-21T09:05:00+09:00");
        assert_eq!((again.inserts, again.pending), (0, 1));
        assert_eq!(read_task_integrations(work_path.clone()).unwrap().len(), 1);

        // Re-auth: the existing outbox retry requeues and the next run drains it.
        task_integrations_retry(
            work_path.clone(),
            None,
            "2026-07-21T09:06:00+09:00".to_string(),
        )
        .unwrap();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        let drained = run(&tmp, &gws, "2026-07-21T09:07:00+09:00");
        assert_eq!(
            (drained.inserts, drained.pending, drained.drained),
            (0, 1, 1)
        );
        assert_eq!(count(&log, "events insert"), 1);
        assert!(note(&tmp, "tasks/active/focus.md").contains("calendarEventId: evt-1"));
        assert_eq!(
            read_task_integrations(work_path).unwrap()[0].status,
            OutboxStatus::Synced
        );
    }

    #[test]
    fn calendar_sync_crash_between_insert_and_write_back_repairs_without_duplicate() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        run(&tmp, &gws, NOW);

        // Reproduce the crash window: the insert landed and the id is on the
        // record, but neither the note nor the ledger heard about it.
        let work_path = tmp.path().to_string_lossy().to_string();
        let mut record = read_task_integrations(work_path.clone()).unwrap().remove(0);
        assert_eq!(record.google_task_id, "evt-1");
        record.status = OutboxStatus::RetryNeeded;
        record.next_retry_at = None;
        crate::today_outbox::write_record(tmp.path(), &record).unwrap();
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        fs::remove_file(ledger_path(tmp.path())).unwrap();

        let outcome = run(&tmp, &gws, "2026-07-21T09:05:00+09:00");
        // The note looks new, but its in-flight record wins: no second insert.
        assert_eq!(
            (outcome.inserts, outcome.pending, outcome.drained),
            (0, 1, 1)
        );
        assert_eq!(count(&log, "events insert"), 1);
        assert_eq!(count(&log, "events patch"), 1);
        assert!(note(&tmp, "tasks/active/focus.md").contains("calendarEventId: evt-1"));
        assert!(load_ledger(tmp.path())
            .unwrap()
            .events
            .contains_key("evt-1"));
        let after = run(&tmp, &gws, "2026-07-21T09:10:00+09:00");
        assert_eq!((after.inserts, after.patches, after.unchanged), (0, 0, 1));
    }

    #[test]
    fn calendar_sync_dry_run_plans_without_writing() {
        let tmp = fixture();
        let (gws, log) = fake_gws(tmp.path(), "gws-ok", "evt-1");
        write(&tmp.path().join("tasks/active/focus.md"), FOCUS);
        let outcome = calendar_sync_run(
            tmp.path().to_string_lossy().to_string(),
            None,
            Some(gws.to_string_lossy().to_string()),
            NOW.to_string(),
            true,
        )
        .unwrap();
        assert!(outcome.dry_run);
        assert_eq!(outcome.inserts, 1);
        assert_eq!(outcome.changes[0].action, "insert");
        assert!(!log.exists());
        assert!(!ledger_path(tmp.path()).exists());
        assert!(
            read_task_integrations(tmp.path().to_string_lossy().to_string())
                .unwrap()
                .is_empty()
        );
        assert_eq!(note(&tmp, "tasks/active/focus.md"), FOCUS);
    }

    #[test]
    fn calendar_sync_cli_and_ipc_share_the_entry_point() {
        // Same fixture twice: once through the CLI the daily job runs, once
        // through the function the IPC command wraps. Identical effects.
        let cli = fixture();
        let (gws_cli, log_cli) = fake_gws(cli.path(), "gws-ok", "evt-1");
        write(&cli.path().join("tasks/active/focus.md"), FOCUS);
        let code = crate::run_cli(vec![
            "calendar-sync".to_string(),
            "--work".to_string(),
            cli.path().to_string_lossy().to_string(),
            "--gws".to_string(),
            gws_cli.to_string_lossy().to_string(),
            "--json".to_string(),
        ]);
        assert_eq!(code, 0);

        let ipc = fixture();
        let (gws_ipc, log_ipc) = fake_gws(ipc.path(), "gws-ok", "evt-1");
        write(&ipc.path().join("tasks/active/focus.md"), FOCUS);
        let outcome = tauri::async_runtime::block_on(super::ipc::calendar_sync_run(
            ipc.path().to_string_lossy().to_string(),
            None,
            Some(gws_ipc.to_string_lossy().to_string()),
            NOW.to_string(),
            false,
        ))
        .unwrap();
        assert_eq!((outcome.inserts, outcome.drained), (1, 1));

        assert_eq!(count(&log_cli, "events insert"), 1);
        assert_eq!(count(&log_ipc, "events insert"), 1);
        assert_eq!(
            note(&cli, "tasks/active/focus.md"),
            note(&ipc, "tasks/active/focus.md")
        );
        let strip = |ledger: Ledger| {
            ledger
                .events
                .into_iter()
                .map(|(id, entry)| (id, entry.rel_path, entry.calendar_id, entry.payload))
                .collect::<Vec<_>>()
        };
        assert_eq!(
            strip(load_ledger(cli.path()).unwrap()),
            strip(load_ledger(ipc.path()).unwrap())
        );
        // Usage errors and an unresolved workspace are CLI errors, not panics.
        assert_eq!(run_calendar_sync(&["--bogus".to_string()]), 2);
        assert_eq!(run_calendar_sync(&["--work".to_string()]), 2);
    }
}
