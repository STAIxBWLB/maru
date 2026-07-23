// Maru Today — selective calendar sync.
//
// "Read capacity from selected calendars, but publish only individually
// selected proposed blocks to the configured destination calendar."
//
// Busy-interval source decision: LOCAL CALENDAR NOTES ONLY. Timed events in
// Maru are markdown notes — task notes under `tasks/` and calendar-only
// receipts under `calendar/` (task-management skill convention,
// `taskSourceType: calendarEvent`) carrying `calendarStart`/`calendarEnd`
// frontmatter (plus optional `timezone`, `calendarId`, `calendarEventId`).
// Remote Google events synced through the task-management skill already land
// as these local notes (with `calendarId`/`calendarEventId` backrefs), so
// local notes are the always-available source of truth. A `gws calendar
// events list` READ path is deliberately NOT mirrored here: it would add
// auth fragility to the capacity path, which must work offline. (The gws
// shell-out below is publish-only — an explicit user action.)
//
// "Enabled calendars" for the `calendars` filter: a note's calendar is its
// `calendarId` frontmatter, or `local` when absent. An empty `calendars`
// list means every discovered note counts; a non-empty list keeps only
// notes whose calendar is in the list.
//
// Publication is ALWAYS explicit: `task_calendar_set_sync` only toggles an
// opt-in flag per plan item, and `today_calendar_publish` inserts events for
// items flagged `selected` (policy `calendarBlockSyncPolicy: "explicit"`).
// Items at `none` are never published.

use crate::cli_path::augmented_path;
use crate::today::{
    parse_day_start, parse_sleep_start, parse_timezone, CalendarCommitment, CalendarSyncState,
    CalendarSyncStatus, PlanItemRef, ProposedBlock, TodayMutation, TodaySnapshot,
};
use crate::today_outbox::{is_auth_error, resolve_gws};
use crate::today_store::{
    append_task_event_for, check_revision, load_snapshot_with_raw, persist_snapshot,
    snapshot_revision, work_lock_for,
};
use crate::vault::{load_maruignore, matches_maruignore, normalize_existing_dir, parse_frontmatter};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use std::process::Command;
use walkdir::WalkDir;

/// Conventional roots scanned for timed calendar notes.
const COMMITMENT_ROOTS: [&str; 2] = ["tasks", "calendar"];
/// Calendar name for notes without a `calendarId` frontmatter.
const LOCAL_CALENDAR: &str = "local";
/// Fallback Google calendar when no destination is configured.
const FALLBACK_DESTINATION: &str = "primary";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CalendarPublishOutcome {
    pub published: usize,
    pub failed: usize,
    /// True when a gws auth failure stopped the run; remaining `selected`
    /// items are untouched so the user can re-authenticate and republish.
    pub blocked: bool,
    pub snapshot: TodaySnapshot,
}

// --- Commitments (busy intervals) --------------------------------------------

/// One parsed timed note, pre-clipping.
struct NoteEvent {
    title: String,
    calendar: String,
    start: DateTime<Tz>,
    end: DateTime<Tz>,
    rel_path: String,
    cancelled: bool,
}

fn string_field<'a>(frontmatter: &'a JsonValue, keys: &[&str]) -> Option<&'a str> {
    keys.iter().find_map(|key| {
        frontmatter
            .get(*key)
            .and_then(JsonValue::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
    })
}

/// Parse a frontmatter datetime: RFC3339 with offset, or a naive local
/// `YYYY-MM-DDTHH:MM[:SS]` interpreted in `tz`.
fn parse_event_time(raw: &str, tz: Tz) -> Option<DateTime<Tz>> {
    let trimmed = raw.trim();
    if let Ok(parsed) = DateTime::parse_from_rfc3339(trimmed) {
        return Some(parsed.with_timezone(&tz));
    }
    let naive = NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M:%S")
        .or_else(|_| NaiveDateTime::parse_from_str(trimmed, "%Y-%m-%dT%H:%M"))
        .ok()?;
    tz.from_local_datetime(&naive).single()
}

fn note_event_for(work: &Path, path: &Path, default_tz: Tz) -> Option<NoteEvent> {
    let raw = fs::read_to_string(path).ok()?;
    let parts = parse_frontmatter(&raw);
    let frontmatter = crate::tasks::normalize_task_frontmatter_aliases(crate::tasks::yaml_to_json(
        &parts.meta,
    ));
    let start_raw = string_field(&frontmatter, &["calendarStart", "calendar_start"])?;
    let note_tz = string_field(&frontmatter, &["timezone"])
        .and_then(|iana| parse_timezone(iana).ok())
        .unwrap_or(default_tz);
    let start = parse_event_time(start_raw, note_tz)?;
    let end = string_field(&frontmatter, &["calendarEnd", "calendar_end"])
        .and_then(|value| parse_event_time(value, note_tz))
        // Mirror the frontend (fromEntries.ts): a missing/unparseable end
        // means a one-hour block.
        .filter(|end| *end > start)
        .unwrap_or(start + Duration::hours(1));
    let title = string_field(&frontmatter, &["title"]).map(ToString::to_string).unwrap_or_else(|| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("event")
            .to_string()
    });
    let cancelled = string_field(&frontmatter, &["status"])
        .map(|status| status.eq_ignore_ascii_case("cancelled"))
        .unwrap_or(false);
    let rel_path = path
        .strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    Some(NoteEvent {
        title,
        calendar: string_field(&frontmatter, &["calendarId", "calendar_id"])
            .unwrap_or(LOCAL_CALENDAR)
            .to_string(),
        start,
        end,
        rel_path,
        cancelled,
    })
}

/// Day window [start, end): `day_start` on the logical day to `sleep_start`
/// (next civil day when `sleep_start <= day_start`). Mirrors compute_capacity.
fn day_window(
    tz: Tz,
    day: NaiveDate,
    day_start: &str,
    sleep_start: &str,
) -> Result<(DateTime<Tz>, DateTime<Tz>), String> {
    let day_start = parse_day_start(day_start)?;
    let sleep_start = parse_sleep_start(sleep_start)?;
    let start = tz
        .from_local_datetime(&day.and_time(day_start))
        .single()
        .ok_or_else(|| format!("today_local_time_unresolvable: {day} {day_start} in {tz}"))?;
    let sleep_date = if sleep_start > day_start {
        day
    } else {
        day + Duration::days(1)
    };
    let end = tz
        .from_local_datetime(&sleep_date.and_time(sleep_start))
        .single()
        .ok_or_else(|| format!("today_local_time_unresolvable: {sleep_date} {sleep_start} in {tz}"))?;
    if end <= start {
        return Err(format!("today_invalid_day_window: {day_start}-{sleep_start}"));
    }
    Ok((start, end))
}

/// Busy intervals for the logical day from local calendar notes, clipped to
/// the day window. `calendars` empty = all discovered notes; otherwise only
/// notes whose `calendarId` (or `local`) is listed. Overlapping duplicates
/// (same title + same start, e.g. a task note and its receipt) are deduped.
#[tauri::command]
pub fn today_calendar_commitments(
    work_path: String,
    logical_day: String,
    timezone: String,
    day_start: String,
    sleep_start: String,
    calendars: Vec<String>,
) -> Result<Vec<CalendarCommitment>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let tz = parse_timezone(&timezone)?;
    let day = NaiveDate::parse_from_str(&logical_day, "%Y-%m-%d")
        .map_err(|_| format!("today_invalid_logical_day: {logical_day}"))?;
    let (window_start, window_end) = day_window(tz, day, &day_start, &sleep_start)?;
    let selected: HashSet<String> = calendars
        .iter()
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect();
    let ignore_patterns = load_maruignore(&work);

    let mut events: Vec<NoteEvent> = Vec::new();
    for root in COMMITMENT_ROOTS {
        let root_path = work.join(root);
        if !root_path.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&root_path)
            .follow_links(false)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if path
                .extension()
                .and_then(|ext| ext.to_str())
                .map(|ext| !ext.eq_ignore_ascii_case("md"))
                .unwrap_or(true)
            {
                continue;
            }
            let rel = path
                .strip_prefix(&work)
                .unwrap_or(path)
                .to_string_lossy()
                .replace('\\', "/");
            if matches_maruignore(Path::new(&rel), &ignore_patterns) {
                continue;
            }
            let Some(event) = note_event_for(&work, path, tz) else {
                continue;
            };
            if event.cancelled {
                continue;
            }
            if !selected.is_empty() && !selected.contains(&event.calendar) {
                continue;
            }
            events.push(event);
        }
    }

    // Dedupe: same title + same start instant is the same event seen from
    // two roots (task note + calendar receipt).
    events.sort_by(|a, b| {
        a.start
            .cmp(&b.start)
            .then_with(|| a.title.cmp(&b.title))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    let mut commitments: Vec<CalendarCommitment> = Vec::new();
    for event in events {
        let clipped_start = event.start.max(window_start);
        let clipped_end = event.end.min(window_end);
        if clipped_end <= clipped_start {
            continue;
        }
        if commitments
            .last()
            .is_some_and(|last| last.title == event.title && last.start_iso == clipped_start.to_rfc3339())
        {
            continue;
        }
        commitments.push(CalendarCommitment {
            title: event.title,
            start_iso: clipped_start.to_rfc3339(),
            end_iso: clipped_end.to_rfc3339(),
            source: event.rel_path,
        });
    }
    Ok(commitments)
}

// --- Per-item opt-in ----------------------------------------------------------

/// Toggle ONE plan item's `calendarSync` between `none` and `selected`
/// (explicit user opt-in per block). Goes through `today_mutate`, so a stale
/// `expected_revision` propagates as `today_conflict`. Never publishes.
#[tauri::command]
pub fn task_calendar_set_sync(
    work_path: String,
    logical_day: String,
    expected_revision: String,
    item_ref: PlanItemRef,
    selected: bool,
    destination: Option<String>,
) -> Result<TodaySnapshot, String> {
    crate::today_store::today_mutate(
        work_path,
        logical_day,
        expected_revision,
        TodayMutation::SetCalendarSync {
            item_ref,
            selected,
            destination,
        },
    )
}

// --- Publish ------------------------------------------------------------------

fn publish_args(
    destination: &str,
    summary: &str,
    block: &crate::today::ProposedBlock,
    timezone: &str,
) -> Vec<String> {
    vec![
        "calendar".to_string(),
        "events".to_string(),
        "insert".to_string(),
        "--params".to_string(),
        json!({ "calendarId": destination }).to_string(),
        "--json".to_string(),
        json!({
            "summary": summary,
            "start": { "dateTime": block.start_iso, "timeZone": timezone },
            "end": { "dateTime": block.end_iso, "timeZone": timezone },
        })
        .to_string(),
        "--format".to_string(),
        "json".to_string(),
    ]
}

/// Provider event id from a successful insert response (`{"id": ...}`).
fn event_id_from_stdout(stdout: &[u8]) -> Option<String> {
    let parsed: JsonValue = serde_json::from_slice(stdout).ok()?;
    parsed
        .get("id")
        .and_then(JsonValue::as_str)
        .map(ToString::to_string)
}

/// A queue item re-read from the stored snapshot just before its insert.
fn selected_item_detail(
    work: &Path,
    logical_day: &str,
    item_ref: &PlanItemRef,
) -> Result<Option<(String, ProposedBlock, Option<String>)>, String> {
    let (_, snapshot) = load_snapshot_with_raw(work, logical_day)?;
    Ok(snapshot.plan.as_ref().and_then(|plan| {
        plan.items()
            .find(|item| item.item_ref == *item_ref)
            .filter(|item| item.calendar_sync.status == CalendarSyncStatus::Selected)
            .and_then(|item| {
                item.proposed_block.clone().map(|block| {
                    (
                        item.outcome
                            .clone()
                            .unwrap_or_else(|| item_ref.id().to_string()),
                        block,
                        item.calendar_sync.destination.clone(),
                    )
                })
            })
    }))
}

/// Persist one item's sync-state change against the FRESH stored snapshot,
/// under the workspace lock. Returns false when the item vanished from the
/// plan (concurrent edit) — the caller decides what that means.
fn persist_item_sync(
    work: &Path,
    logical_day: &str,
    item_ref: &PlanItemRef,
    state: CalendarSyncState,
    now_iso: &str,
) -> Result<bool, String> {
    let lock = work_lock_for(work)?;
    let _guard = lock.lock().map_err(|_| "today_work_lock_poisoned".to_string())?;
    let (raw, mut snapshot) = load_snapshot_with_raw(work, logical_day)?;
    let mut found = false;
    if let Some(plan) = snapshot.plan.as_mut() {
        if let Some(item) = plan.items_mut().find(|item| item.item_ref == *item_ref) {
            item.calendar_sync = state;
            found = true;
        }
    }
    if !found {
        return Ok(false);
    }
    snapshot_revision(work, &snapshot, &raw)?;
    snapshot.generated_at = now_iso.to_string();
    persist_snapshot(work, &mut snapshot)?;
    Ok(true)
}

/// Publish every plan item flagged `selected` (with a `proposedBlock`) to the
/// destination calendar via `gws calendar events insert`. Explicit policy:
/// items at `none` are never touched. Auth failure stops the run with
/// `blocked: true` and leaves remaining items `selected`; a non-auth failure
/// marks only that item `error` and the run continues.
///
/// Concurrency/durability: each item is re-read from the stored snapshot
/// right before its insert (a concurrent edit that unselects or removes it
/// skips the insert) and its resulting state persists immediately after,
/// against the then-current snapshot under the workspace lock — a long
/// publish run can no longer clobber mutations that landed mid-run, and a
/// crash loses at most the one in-flight item.
/// ponytail: that one-item crash window can still duplicate a calendar
/// event on republish; closing it needs a durable per-event intent record.
#[tauri::command]
pub fn today_calendar_publish(
    work_path: String,
    logical_day: String,
    expected_revision: String,
    destination: Option<String>,
    gws_path: Option<String>,
    now_iso: String,
) -> Result<CalendarPublishOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    DateTime::parse_from_rfc3339(&now_iso).map_err(|err| format!("now_iso must be RFC3339: {err}"))?;
    let (_, entry_snapshot) = load_snapshot_with_raw(&work, &logical_day)?;
    check_revision(&entry_snapshot, &expected_revision)?;

    // Collect the publish queue up front: only `selected` items with a block.
    let queue: Vec<PlanItemRef> = entry_snapshot
        .plan
        .as_ref()
        .map(|plan| {
            plan.items()
                .filter(|item| {
                    item.calendar_sync.status == CalendarSyncStatus::Selected
                        && item.proposed_block.is_some()
                })
                .map(|item| item.item_ref.clone())
                .collect()
        })
        .unwrap_or_default();
    let mut outcome = CalendarPublishOutcome {
        published: 0,
        failed: 0,
        blocked: false,
        snapshot: entry_snapshot.clone(),
    };
    if queue.is_empty() {
        return Ok(outcome);
    }
    let gws_bin = resolve_gws(gws_path.as_deref())?;
    let timezone = entry_snapshot.timezone.clone();

    for item_ref in &queue {
        let Some((summary, block, item_destination)) =
            selected_item_detail(&work, &logical_day, item_ref)?
        else {
            // Concurrent edit unselected or removed the item — skip.
            continue;
        };
        let destination_id = item_destination
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .or(destination.as_deref().map(str::trim).filter(|value| !value.is_empty()))
            .unwrap_or(FALLBACK_DESTINATION);
        let output = Command::new(&gws_bin)
            .env("PATH", augmented_path())
            .args(publish_args(destination_id, &summary, &block, &timezone))
            .no_window()
            .output();
        let state = match output {
            Ok(output) if output.status.success() => {
                outcome.published += 1;
                CalendarSyncState {
                    status: CalendarSyncStatus::Synced,
                    message: None,
                    event_id: event_id_from_stdout(&output.stdout),
                    destination: Some(destination_id.to_string()),
                }
            }
            Ok(output) => {
                let detail = [output.stderr.as_slice(), output.stdout.as_slice()]
                    .into_iter()
                    .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
                    .filter(|value| !value.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                if is_auth_error(&detail) {
                    // Leave this item (and the rest of the queue) `selected`:
                    // after re-auth the user republishes the same selection.
                    outcome.blocked = true;
                    break;
                }
                outcome.failed += 1;
                CalendarSyncState {
                    status: CalendarSyncStatus::Error,
                    message: Some(detail),
                    event_id: None,
                    destination: Some(destination_id.to_string()),
                }
            }
            Err(err) => {
                outcome.failed += 1;
                CalendarSyncState {
                    status: CalendarSyncStatus::Error,
                    message: Some(format!("gws_spawn_failed: {err}")),
                    event_id: None,
                    destination: Some(destination_id.to_string()),
                }
            }
        };
        let inserted_event_id = state.event_id.clone();
        if !persist_item_sync(&work, &logical_day, item_ref, state, &now_iso)? {
            // The item vanished mid-publish; the inserted event (if any) is
            // orphaned — record that instead of resurrecting the item.
            let _ = append_task_event_for(
                &work,
                &logical_day,
                "calendar_publish_orphan",
                None,
                json!({ "itemRef": item_ref, "eventId": inserted_event_id }),
                now_iso.clone(),
            );
        }
    }

    if outcome.published > 0 || outcome.failed > 0 {
        let _ = append_task_event_for(
            &work,
            &logical_day,
            "calendar_blocks_published",
            None,
            json!({
                "published": outcome.published,
                "failed": outcome.failed,
                "blocked": outcome.blocked,
            }),
            now_iso.clone(),
        );
    }
    let (_, final_snapshot) = load_snapshot_with_raw(&work, &logical_day)?;
    outcome.snapshot = final_snapshot;
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today::{
        CalendarSyncStatus, DailyPlanItem, DailyPlanV1, PlanLane, ProposedBlock, TodayMutation,
    };
    use crate::today_store::{today_mutate, today_open};
    use std::path::PathBuf;

    const SEOUL: &str = "Asia/Seoul";
    const DAY: &str = "2026-07-21";
    const DAY_START: &str = "03:30";
    const SLEEP_START: &str = "21:30";
    const NOW: &str = "2026-07-21T09:00:00+09:00";

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    fn work(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    fn commitments(
        tmp: &tempfile::TempDir,
        calendars: Vec<String>,
    ) -> Vec<CalendarCommitment> {
        today_calendar_commitments(
            work(tmp),
            DAY.to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
            calendars,
        )
        .unwrap()
    }

    fn write_fake_gws(dir: &Path, name: &str, body: &str) -> PathBuf {
        let bin = dir.join(name);
        fs::write(&bin, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        bin
    }

    fn plan_item(id: &str, block: Option<ProposedBlock>) -> DailyPlanItem {
        DailyPlanItem {
            item_ref: PlanItemRef::Task {
                task_id: id.to_string(),
            },
            lane: PlanLane::Top,
            order: 0,
            outcome: Some(format!("Ship {id}")),
            estimate_minutes: Some(45),
            estimate_provisional: false,
            pinned: false,
            proposed_block: block,
            calendar_sync: CalendarSyncState::none(),
        }
    }

    fn open_with_plan(tmp: &tempfile::TempDir, items: Vec<DailyPlanItem>) -> TodaySnapshot {
        let snapshot = today_open(
            work(tmp),
            NOW.to_string(),
            SEOUL.to_string(),
            DAY_START.to_string(),
            SLEEP_START.to_string(),
        )
        .unwrap();
        today_mutate(
            work(tmp),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            TodayMutation::SetPlan {
                plan: DailyPlanV1 {
                    logical_day: snapshot.logical_day.clone(),
                    input_revision: snapshot.revision.clone(),
                    top: items,
                    flexible: vec![],
                    overflow: vec![],
                    reasons: vec![],
                    warnings: vec![],
                },
            },
        )
        .unwrap()
    }

    fn select(
        tmp: &tempfile::TempDir,
        snapshot: &TodaySnapshot,
        task_id: &str,
        selected: bool,
    ) -> Result<TodaySnapshot, String> {
        task_calendar_set_sync(
            work(tmp),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            PlanItemRef::Task {
                task_id: task_id.to_string(),
            },
            selected,
            Some("cal-1".to_string()),
        )
    }

    fn block(start: &str, end: &str) -> ProposedBlock {
        ProposedBlock {
            start_iso: start.to_string(),
            end_iso: end.to_string(),
        }
    }

    // --- Commitments -----------------------------------------------------------

    #[test]
    fn commitments_gather_clip_and_dedupe_local_notes() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("tasks/active/focus.md"),
            "---\ntitle: 집중 작업\ncalendarStart: 2026-07-21T09:00\ncalendarEnd: 2026-07-21T10:30\n---\n# Body\n",
        );
        // Receipt duplicating the same event (same title + start) is deduped.
        write(
            &tmp.path().join("calendar/focus-receipt.md"),
            "---\ntitle: 집중 작업\ntaskSourceType: calendarEvent\ncalendarStart: 2026-07-21T09:00\ncalendarEnd: 2026-07-21T10:30\n---\n# Receipt\n",
        );
        // Starts before the day window: clipped to day start.
        write(
            &tmp.path().join("calendar/overnight.md"),
            "---\ntitle: 야간 근무\ncalendarStart: 2026-07-21T01:00\ncalendarEnd: 2026-07-21T05:00\n---\n",
        );
        // Fully outside the window: dropped.
        write(
            &tmp.path().join("calendar/late.md"),
            "---\ntitle: 심야\ncalendarStart: 2026-07-21T22:00\ncalendarEnd: 2026-07-21T23:00\n---\n",
        );
        // Cancelled: dropped. No calendarEnd: defaults to one hour.
        write(
            &tmp.path().join("calendar/cancelled.md"),
            "---\ntitle: 취소됨\nstatus: cancelled\ncalendarStart: 2026-07-21T11:00\ncalendarEnd: 2026-07-21T12:00\n---\n",
        );
        write(
            &tmp.path().join("calendar/noend.md"),
            "---\ntitle: 한 시간 기본\ncalendarStart: 2026-07-21T14:00\n---\n",
        );

        let commitments = commitments(&tmp, vec![]);
        let titles: Vec<&str> = commitments.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["야간 근무", "집중 작업", "한 시간 기본"]);
        // Clipped to the 03:30 day start.
        assert_eq!(commitments[0].start_iso, "2026-07-21T03:30:00+09:00");
        assert_eq!(commitments[0].end_iso, "2026-07-21T05:00:00+09:00");
        assert_eq!(commitments[1].start_iso, "2026-07-21T09:00:00+09:00");
        assert_eq!(commitments[1].end_iso, "2026-07-21T10:30:00+09:00");
        assert!(commitments[1].source.starts_with("tasks/") || commitments[1].source.starts_with("calendar/"));
        // Missing end defaults to one hour.
        assert_eq!(commitments[2].end_iso, "2026-07-21T15:00:00+09:00");
    }

    #[test]
    fn commitments_filter_by_calendar_id_and_respect_offsets() {
        let tmp = tempfile::tempdir().unwrap();
        write(
            &tmp.path().join("calendar/work.md"),
            "---\ntitle: 업무\ncalendarId: work-cal\ncalendarStart: 2026-07-21T09:00\ncalendarEnd: 2026-07-21T10:00\n---\n",
        );
        write(
            &tmp.path().join("calendar/personal.md"),
            "---\ntitle: 개인\ncalendarStart: 2026-07-21T11:00\ncalendarEnd: 2026-07-21T12:00\n---\n",
        );
        // RFC3339 with offset parses in its own offset.
        write(
            &tmp.path().join("calendar/offset.md"),
            "---\ntitle: 오프셋\ncalendarId: work-cal\ncalendarStart: \"2026-07-21T13:00:00+09:00\"\ncalendarEnd: \"2026-07-21T14:00:00+09:00\"\n---\n",
        );

        let all = commitments(&tmp, vec![]);
        assert_eq!(all.len(), 3);
        let work_only = commitments(&tmp, vec!["work-cal".to_string()]);
        let titles: Vec<&str> = work_only.iter().map(|c| c.title.as_str()).collect();
        assert_eq!(titles, vec!["업무", "오프셋"]);
        assert_eq!(work_only[1].start_iso, "2026-07-21T13:00:00+09:00");
        // `local` selects notes without a calendarId.
        let local_only = commitments(&tmp, vec![LOCAL_CALENDAR.to_string()]);
        assert_eq!(local_only.len(), 1);
        assert_eq!(local_only[0].title, "개인");
    }

    // --- Set sync ---------------------------------------------------------------

    #[test]
    fn set_sync_toggles_one_item_and_enforces_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let snapshot = open_with_plan(
            &tmp,
            vec![
                plan_item("a", Some(block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00"))),
                plan_item("b", None),
            ],
        );
        let updated = select(&tmp, &snapshot, "a", true).unwrap();
        let plan = updated.plan.as_ref().unwrap();
        assert_eq!(plan.top[0].calendar_sync.status, CalendarSyncStatus::Selected);
        assert_eq!(plan.top[0].calendar_sync.destination.as_deref(), Some("cal-1"));
        assert_eq!(plan.top[1].calendar_sync.status, CalendarSyncStatus::None);
        assert_ne!(updated.revision, snapshot.revision);

        // Deselect resets to none.
        let cleared = select(&tmp, &updated, "a", false).unwrap();
        assert_eq!(
            cleared.plan.as_ref().unwrap().top[0].calendar_sync.status,
            CalendarSyncStatus::None
        );

        // Stale revision conflicts; unknown item errors.
        let err = select(&tmp, &snapshot, "a", true).unwrap_err();
        assert!(err.starts_with("today_conflict"));
        let err = select(&tmp, &cleared, "nope", true).unwrap_err();
        assert!(err.starts_with("today_plan_item_missing"));
    }

    // --- Publish -----------------------------------------------------------------

    fn publish(tmp: &tempfile::TempDir, snapshot: &TodaySnapshot, gws: &Path) -> CalendarPublishOutcome {
        today_calendar_publish(
            work(tmp),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            None,
            Some(gws.to_string_lossy().to_string()),
            NOW.to_string(),
        )
        .unwrap()
    }

    #[test]
    fn publish_inserts_selected_blocks_and_marks_synced() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join("gws-args.log");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-ok",
            &format!(
                "#!/bin/sh\necho \"$@\" >> {}\necho '{{\"id\":\"evt-42\"}}'\nexit 0\n",
                log.display()
            ),
        );
        let snapshot = open_with_plan(
            &tmp,
            vec![
                plan_item("a", Some(block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00"))),
                plan_item("b", Some(block("2026-07-21T13:00:00+09:00", "2026-07-21T14:00:00+09:00"))),
            ],
        );
        // Only `a` is selected; `b` stays at none and must never publish.
        let snapshot = select(&tmp, &snapshot, "a", true).unwrap();

        let outcome = publish(&tmp, &snapshot, &fake);
        assert_eq!(outcome.published, 1);
        assert_eq!(outcome.failed, 0);
        assert!(!outcome.blocked);
        let plan = outcome.snapshot.plan.as_ref().unwrap();
        assert_eq!(plan.top[0].calendar_sync.status, CalendarSyncStatus::Synced);
        assert_eq!(plan.top[0].calendar_sync.event_id.as_deref(), Some("evt-42"));
        assert_eq!(plan.top[1].calendar_sync.status, CalendarSyncStatus::None);
        assert_ne!(outcome.snapshot.revision, snapshot.revision);

        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("calendar events insert"));
        assert!(logged.contains(r#"{"calendarId":"cal-1"}"#));
        assert!(logged.contains(r#""summary":"Ship a""#));
        assert!(logged.contains(r#""dateTime":"2026-07-21T10:00:00+09:00""#));
        assert!(logged.contains(r#""timeZone":"Asia/Seoul""#));
        assert!(!logged.contains("Ship b"));

        let events = fs::read_to_string(tmp.path().join(".maru/today/events/2026-07.jsonl")).unwrap();
        assert!(events.contains("\"kind\":\"calendar_blocks_published\""));
    }

    #[test]
    fn publish_keeps_the_destination_captured_when_the_item_was_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let log = tmp.path().join("gws-destination.log");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-destination",
            &format!(
                "#!/bin/sh\necho \"$@\" >> {}\necho '{{\"id\":\"evt-42\"}}'\nexit 0\n",
                log.display()
            ),
        );
        let snapshot = open_with_plan(
            &tmp,
            vec![plan_item(
                "a",
                Some(block(
                    "2026-07-21T10:00:00+09:00",
                    "2026-07-21T11:00:00+09:00",
                )),
            )],
        );
        // `select` captures cal-1. A later command-level default must not
        // redirect the already-approved write to cal-2.
        let snapshot = select(&tmp, &snapshot, "a", true).unwrap();
        let outcome = today_calendar_publish(
            work(&tmp),
            snapshot.logical_day.clone(),
            snapshot.revision.clone(),
            Some("cal-2".to_string()),
            Some(fake.to_string_lossy().to_string()),
            NOW.to_string(),
        )
        .unwrap();

        assert_eq!(outcome.published, 1);
        let logged = fs::read_to_string(log).unwrap();
        assert!(logged.contains(r#"{"calendarId":"cal-1"}"#));
        assert!(!logged.contains(r#"{"calendarId":"cal-2"}"#));
    }

    #[test]
    fn publish_auth_failure_blocks_and_keeps_remaining_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-auth",
            "#!/bin/sh\necho 'token expired: re-login required' >&2\nexit 1\n",
        );
        let snapshot = open_with_plan(
            &tmp,
            vec![
                plan_item("a", Some(block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00"))),
                plan_item("b", Some(block("2026-07-21T13:00:00+09:00", "2026-07-21T14:00:00+09:00"))),
            ],
        );
        let snapshot = select(&tmp, &snapshot, "a", true).unwrap();
        let snapshot = select(&tmp, &snapshot, "b", true).unwrap();

        let outcome = publish(&tmp, &snapshot, &fake);
        assert!(outcome.blocked);
        assert_eq!(outcome.published, 0);
        assert_eq!(outcome.failed, 0);
        let plan = outcome.snapshot.plan.as_ref().unwrap();
        // Both stay selected so a re-auth + republish retries the same set.
        assert_eq!(plan.top[0].calendar_sync.status, CalendarSyncStatus::Selected);
        assert_eq!(plan.top[1].calendar_sync.status, CalendarSyncStatus::Selected);
    }

    #[test]
    fn publish_non_auth_failure_marks_item_error_and_continues() {
        let tmp = tempfile::tempdir().unwrap();
        // Fails only for the first insert (Ship a), succeeds for the second.
        let marker = tmp.path().join("called");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-flaky",
            &format!(
                "#!/bin/sh\nif [ ! -f {} ]; then touch {}; echo 'network unreachable' >&2; exit 1; fi\necho '{{\"id\":\"evt-9\"}}'\nexit 0\n",
                marker.display(),
                marker.display()
            ),
        );
        let snapshot = open_with_plan(
            &tmp,
            vec![
                plan_item("a", Some(block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00"))),
                plan_item("b", Some(block("2026-07-21T13:00:00+09:00", "2026-07-21T14:00:00+09:00"))),
            ],
        );
        let snapshot = select(&tmp, &snapshot, "a", true).unwrap();
        let snapshot = select(&tmp, &snapshot, "b", true).unwrap();

        let outcome = publish(&tmp, &snapshot, &fake);
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.published, 1);
        assert!(!outcome.blocked);
        let plan = outcome.snapshot.plan.as_ref().unwrap();
        assert_eq!(plan.top[0].calendar_sync.status, CalendarSyncStatus::Error);
        assert!(plan.top[0]
            .calendar_sync
            .message
            .as_deref()
            .unwrap()
            .contains("network unreachable"));
        assert_eq!(plan.top[1].calendar_sync.status, CalendarSyncStatus::Synced);
        assert_eq!(plan.top[1].calendar_sync.event_id.as_deref(), Some("evt-9"));
    }

    #[test]
    fn publish_without_selection_is_a_noop_and_conflicts_on_stale_revision() {
        let tmp = tempfile::tempdir().unwrap();
        let fake = write_fake_gws(tmp.path(), "gws-ok", "#!/bin/sh\nexit 0\n");
        let snapshot = open_with_plan(
            &tmp,
            vec![plan_item("a", Some(block("2026-07-21T10:00:00+09:00", "2026-07-21T11:00:00+09:00")))],
        );
        // Nothing selected: no gws call, no revision bump.
        let outcome = publish(&tmp, &snapshot, &fake);
        assert_eq!(outcome.published, 0);
        assert_eq!(outcome.snapshot.revision, snapshot.revision);

        let err = today_calendar_publish(
            work(&tmp),
            snapshot.logical_day.clone(),
            "bogus".to_string(),
            None,
            Some(fake.to_string_lossy().to_string()),
            NOW.to_string(),
        )
        .unwrap_err();
        assert!(err.starts_with("today_conflict: expected revision bogus, found "));
    }
}
