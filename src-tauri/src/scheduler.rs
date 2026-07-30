// In-app scheduler for recurring skill missions. Schedules persist per
// workspace at <work>/.maru/schedules.json. A ticker started in the app
// setup scans every registered workspace every 60 seconds and dispatches
// due schedules through the existing skill-run machinery
// (skills_dispatch_background) — no new AI invocation path. On launch, a
// schedule whose nextRunAt lies in the past fires exactly once (catch-up)
// and is then re-aligned to its next future slot.

use crate::approval::{require_approval, ApprovalState};
use crate::atomic_file::write_atomic;
use crate::skill_host::skills_dispatch_background;
use chrono::{DateTime, Datelike, Duration, Local, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

const SCHEDULER_TICK_SECONDS: u64 = 60;
const SCHEDULER_ADD_KIND: &str = "scheduler.add";

static TICKER_STARTED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerSchedule {
    pub id: String,
    pub name: String,
    pub skill_id: String,
    pub runtime: String,
    pub prompt: String,
    pub hour: u32,
    pub minute: u32,
    /// 0 = Sunday .. 6 = Saturday; empty means daily.
    #[serde(default)]
    pub days_of_week: Vec<u32>,
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_run_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerScheduleInput {
    pub name: String,
    pub skill_id: String,
    pub runtime: String,
    pub prompt: String,
    pub hour: u32,
    pub minute: u32,
    #[serde(default)]
    pub days_of_week: Vec<u32>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerChangedEvent {
    pub work_path: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerFiredEvent {
    pub work_path: String,
    pub schedule_id: String,
    pub invocation_id: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SchedulerErrorEvent {
    pub work_path: String,
    pub schedule_id: String,
    pub message: String,
}

fn schedules_path(work: &Path) -> PathBuf {
    work.join(".maru").join("schedules.json")
}

fn load_schedules(work: &Path) -> Result<Vec<SchedulerSchedule>, String> {
    let path = schedules_path(work);
    if !path.is_file() {
        return Ok(Vec::new());
    }
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read {}: {err}", path.display()))?;
    // A corrupt file must surface an error rather than be silently replaced
    // with an empty list — schedules are user data.
    serde_json::from_str(&raw).map_err(|err| format!("Cannot parse {}: {err}", path.display()))
}

fn save_schedules(work: &Path, schedules: &[SchedulerSchedule]) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(schedules)
        .map_err(|err| format!("Cannot serialize schedules: {err}"))?;
    write_atomic(&schedules_path(work), &bytes)
}

/// Next fire time strictly after `now`, honoring optional weekday filters.
/// Returns None for invalid hour/minute/weekday input.
fn compute_next_run(
    now: DateTime<Local>,
    hour: u32,
    minute: u32,
    days_of_week: &[u32],
) -> Option<DateTime<Local>> {
    if hour > 23 || minute > 59 || days_of_week.iter().any(|day| *day > 6) {
        return None;
    }
    let days: BTreeSet<u32> = days_of_week.iter().copied().collect();
    for offset in 0..=7_i64 {
        let date = (now + Duration::days(offset)).date_naive();
        if !days.is_empty() && !days.contains(&date.weekday().num_days_from_sunday()) {
            continue;
        }
        let candidate = date.and_hms_opt(hour, minute, 0)?;
        let candidate = Local.from_local_datetime(&candidate).single()?;
        if candidate > now {
            return Some(candidate);
        }
    }
    None
}

/// A schedule is due when it is enabled and has no recorded next run (fresh
/// or migrated) or its next run is now or in the past (catch-up included —
/// both cases fire exactly once and then re-align).
fn is_due(schedule: &SchedulerSchedule, now: DateTime<Local>) -> bool {
    if !schedule.enabled {
        return false;
    }
    let Some(next) = schedule.next_run_at.as_deref() else {
        return true;
    };
    match DateTime::parse_from_rfc3339(next) {
        Ok(next) => next <= now,
        Err(_) => false,
    }
}

fn normalize_runtime(runtime: &str) -> Result<String, String> {
    let value = runtime.trim().to_lowercase();
    match value.as_str() {
        "claude" | "codex" | "kimi" | "kiro" => Ok(value),
        _ => Err(format!("unsupported_dispatch_runtime: {value}")),
    }
}

fn validate_schedule_id(id: &str) -> Result<(), String> {
    let trimmed = id.trim();
    if trimmed.is_empty()
        || trimmed.len() > 128
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-')
    {
        return Err("scheduler_invalid_id".to_string());
    }
    Ok(())
}

fn add_impl(work_path: &str, input: SchedulerScheduleInput) -> Result<SchedulerSchedule, String> {
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let name = input.name.trim();
    if name.is_empty() {
        return Err("scheduler_name_required".to_string());
    }
    if input.prompt.trim().is_empty() {
        return Err("scheduler_prompt_required".to_string());
    }
    let runtime = normalize_runtime(&input.runtime)?;
    let now = Local::now();
    let next_run = compute_next_run(now, input.hour, input.minute, &input.days_of_week)
        .ok_or_else(|| "scheduler_time_invalid".to_string())?;
    let mut days_of_week = input.days_of_week;
    days_of_week.sort_unstable();
    days_of_week.dedup();
    let schedule = SchedulerSchedule {
        id: format!("sched-{}", Uuid::new_v4()),
        name: name.to_string(),
        skill_id: input.skill_id,
        runtime,
        prompt: input.prompt,
        hour: input.hour,
        minute: input.minute,
        days_of_week,
        enabled: input.enabled,
        last_run_at: None,
        next_run_at: if input.enabled {
            Some(next_run.to_rfc3339())
        } else {
            None
        },
    };
    let mut schedules = load_schedules(&work)?;
    schedules.push(schedule.clone());
    save_schedules(&work, &schedules)?;
    Ok(schedule)
}

fn find_schedule(schedules: &[SchedulerSchedule], id: &str) -> Option<usize> {
    schedules.iter().position(|schedule| schedule.id == id)
}

fn set_enabled_impl(work_path: &str, id: &str, enabled: bool) -> Result<SchedulerSchedule, String> {
    validate_schedule_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut schedules = load_schedules(&work)?;
    let index = find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
    schedules[index].enabled = enabled;
    if enabled && schedules[index].next_run_at.is_none() {
        let schedule = &schedules[index];
        schedules[index].next_run_at =
            compute_next_run(Local::now(), schedule.hour, schedule.minute, &schedule.days_of_week)
                .map(|next| next.to_rfc3339());
    }
    save_schedules(&work, &schedules)?;
    Ok(schedules[index].clone())
}

fn remove_impl(work_path: &str, id: &str) -> Result<(), String> {
    validate_schedule_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let mut schedules = load_schedules(&work)?;
    let index = find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
    schedules.remove(index);
    save_schedules(&work, &schedules)
}

/// Record a fired run: stamp lastRunAt and re-align nextRunAt strictly after
/// `now` so a missed window never triggers a burst of catch-up runs.
fn mark_fired(work: &Path, id: &str, now: DateTime<Local>) -> Result<SchedulerSchedule, String> {
    let mut schedules = load_schedules(work)?;
    let index = find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
    schedules[index].last_run_at = Some(now.to_rfc3339());
    let schedule = &schedules[index];
    schedules[index].next_run_at =
        compute_next_run(now, schedule.hour, schedule.minute, &schedule.days_of_week)
            .map(|next| next.to_rfc3339());
    save_schedules(work, &schedules)?;
    Ok(schedules[index].clone())
}

fn dispatch_schedule(
    app: &AppHandle,
    work: &Path,
    schedule: &SchedulerSchedule,
) -> Result<String, String> {
    skills_dispatch_background(
        app.clone(),
        schedule.skill_id.clone(),
        schedule.runtime.clone(),
        schedule.prompt.clone(),
        Some(work.to_string_lossy().to_string()),
        None,
        Some(serde_json::json!({
            "scheduler": true,
            "scheduleId": schedule.id,
            "scheduleName": schedule.name,
        })),
        None,
        None,
    )
}

fn run_due_for_workspace(app: &AppHandle, work: &Path, now: DateTime<Local>) -> Result<(), String> {
    let schedules = load_schedules(work)?;
    for schedule in &schedules {
        if !schedule.enabled {
            continue;
        }
        // A nextRunAt that no longer parses is re-aligned without firing:
        // corrupt state must never launch an AI mission.
        if let Some(next) = schedule.next_run_at.as_deref() {
            if DateTime::parse_from_rfc3339(next).is_err() {
                let realigned = compute_next_run(
                    now,
                    schedule.hour,
                    schedule.minute,
                    &schedule.days_of_week,
                )
                .map(|value| value.to_rfc3339());
                let mut updated = schedules.clone();
                if let Some(index) = find_schedule(&updated, &schedule.id) {
                    updated[index].next_run_at = realigned;
                    save_schedules(work, &updated)?;
                }
                continue;
            }
        }
        if !is_due(schedule, now) {
            continue;
        }
        let work_path = work.to_string_lossy().to_string();
        match dispatch_schedule(app, work, schedule) {
            Ok(invocation_id) => {
                let _ = app.emit(
                    "scheduler://fired",
                    SchedulerFiredEvent {
                        work_path: work_path.clone(),
                        schedule_id: schedule.id.clone(),
                        invocation_id,
                    },
                );
            }
            Err(message) => {
                let _ = app.emit(
                    "scheduler://error",
                    SchedulerErrorEvent {
                        work_path: work_path.clone(),
                        schedule_id: schedule.id.clone(),
                        message,
                    },
                );
            }
        }
        // Record the attempt either way so a broken schedule does not retry
        // every tick.
        let _ = mark_fired(work, &schedule.id, now);
    }
    Ok(())
}

#[cfg(not(test))]
fn run_tick(app: &AppHandle) {
    let now = Local::now();
    let Ok(Some(registry)) = crate::vault_list::load_registry_if_present() else {
        return;
    };
    let mut seen = BTreeSet::new();
    for entry in registry.workspaces {
        if !seen.insert(entry.path.clone()) {
            continue;
        }
        let work = PathBuf::from(&entry.path);
        if !schedules_path(&work).is_file() {
            continue;
        }
        let _ = run_due_for_workspace(app, &work, now);
    }
}

// The workspace registry helper is cfg(not(test))-gated; unit tests exercise
// the per-workspace logic directly instead of the registry scan.
#[cfg(test)]
fn run_tick(_app: &AppHandle) {}

/// Start the 60-second scheduler ticker. Idempotent; called once from the
/// app setup. The first tick runs immediately, which is also the launch
/// catch-up path for schedules whose nextRunAt is in the past.
pub fn start_scheduler_ticker(app: AppHandle) {
    if TICKER_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    thread::spawn(move || loop {
        run_tick(&app);
        thread::sleep(StdDuration::from_secs(SCHEDULER_TICK_SECONDS));
    });
}

fn emit_scheduler_changed(app: &AppHandle, work_path: &str) {
    let _ = app.emit(
        "scheduler://changed",
        SchedulerChangedEvent {
            work_path: work_path.to_string(),
        },
    );
}

#[tauri::command]
pub fn scheduler_list(work_path: String) -> Result<Vec<SchedulerSchedule>, String> {
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    load_schedules(&work)
}

#[tauri::command]
pub fn scheduler_add(
    approvals: tauri::State<'_, ApprovalState>,
    app: AppHandle,
    work_path: String,
    schedule: SchedulerScheduleInput,
    approval_id: Option<String>,
) -> Result<SchedulerSchedule, String> {
    require_approval(&approvals, approval_id, SCHEDULER_ADD_KIND)?;
    let schedule = add_impl(&work_path, schedule)?;
    emit_scheduler_changed(&app, &work_path);
    Ok(schedule)
}

#[tauri::command]
pub fn scheduler_remove(
    app: AppHandle,
    work_path: String,
    id: String,
) -> Result<(), String> {
    remove_impl(&work_path, &id)?;
    emit_scheduler_changed(&app, &work_path);
    Ok(())
}

#[tauri::command]
pub fn scheduler_set_enabled(
    app: AppHandle,
    work_path: String,
    id: String,
    enabled: bool,
) -> Result<SchedulerSchedule, String> {
    let schedule = set_enabled_impl(&work_path, &id, enabled)?;
    emit_scheduler_changed(&app, &work_path);
    Ok(schedule)
}

#[tauri::command]
pub fn scheduler_run_now(
    app: AppHandle,
    work_path: String,
    id: String,
) -> Result<String, String> {
    validate_schedule_id(&id)?;
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    let schedules = load_schedules(&work)?;
    let index = find_schedule(&schedules, &id).ok_or_else(|| "scheduler_not_found".to_string())?;
    let invocation_id = dispatch_schedule(&app, &work, &schedules[index])?;
    let _ = mark_fired(&work, &id, Local::now());
    let _ = app.emit(
        "scheduler://fired",
        SchedulerFiredEvent {
            work_path: work_path.clone(),
            schedule_id: id,
            invocation_id: invocation_id.clone(),
        },
    );
    Ok(invocation_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .from_local_datetime(&chrono::NaiveDate::from_ymd_opt(y, mo, d).unwrap().and_hms_opt(h, mi, 0).unwrap())
            .single()
            .unwrap()
    }

    fn sample_schedule(next_run_at: Option<String>, enabled: bool) -> SchedulerSchedule {
        SchedulerSchedule {
            id: "sched-test".to_string(),
            name: "Test".to_string(),
            skill_id: "vault-sync".to_string(),
            runtime: "claude".to_string(),
            prompt: "Run it".to_string(),
            hour: 9,
            minute: 30,
            days_of_week: Vec::new(),
            enabled,
            last_run_at: None,
            next_run_at,
        }
    }

    #[test]
    fn next_run_same_day_when_time_is_ahead() {
        let now = local(2026, 7, 30, 8, 0);
        let next = compute_next_run(now, 9, 30, &[]).unwrap();
        assert_eq!(next, local(2026, 7, 30, 9, 30));
    }

    #[test]
    fn next_run_rolls_to_tomorrow_when_time_passed() {
        let now = local(2026, 7, 30, 10, 0);
        let next = compute_next_run(now, 9, 30, &[]).unwrap();
        assert_eq!(next, local(2026, 7, 31, 9, 30));
    }

    #[test]
    fn next_run_honors_weekday_filter() {
        // 2026-07-30 is a Thursday (weekday 4, Sunday = 0).
        let now = local(2026, 7, 30, 8, 0);
        assert_eq!(now.date_naive().weekday().num_days_from_sunday(), 4);
        let next = compute_next_run(now, 9, 30, &[1]).unwrap(); // Mondays only
        assert_eq!(next.date_naive().weekday().num_days_from_sunday(), 1);
        assert_eq!(next, local(2026, 8, 3, 9, 30));
    }

    #[test]
    fn next_run_rejects_invalid_time() {
        let now = local(2026, 7, 30, 8, 0);
        assert!(compute_next_run(now, 24, 0, &[]).is_none());
        assert!(compute_next_run(now, 9, 60, &[]).is_none());
        assert!(compute_next_run(now, 9, 30, &[7]).is_none());
    }

    #[test]
    fn due_detection_covers_catch_up() {
        let now = Local::now();
        let past = sample_schedule(Some("2000-01-01T00:00:00+00:00".to_string()), true);
        assert!(is_due(&past, now), "past nextRunAt must fire once (catch-up)");
        let future = sample_schedule(Some("2999-01-01T00:00:00+00:00".to_string()), true);
        assert!(!is_due(&future, now));
        let fresh = sample_schedule(None, true);
        assert!(is_due(&fresh, now), "missing nextRunAt is due once");
        let disabled = sample_schedule(Some("2000-01-01T00:00:00+00:00".to_string()), false);
        assert!(!is_due(&disabled, now));
        let corrupt = sample_schedule(Some("not-a-date".to_string()), true);
        assert!(!is_due(&corrupt, now), "corrupt nextRunAt never fires");
    }

    #[test]
    fn persistence_round_trip() {
        let temp = TempDir::new().unwrap();
        assert!(load_schedules(temp.path()).unwrap().is_empty());
        let schedules = vec![sample_schedule(Some("2026-07-31T09:30:00+09:00".to_string()), true)];
        save_schedules(temp.path(), &schedules).unwrap();
        let loaded = load_schedules(temp.path()).unwrap();
        assert_eq!(loaded, schedules);
    }

    #[test]
    fn corrupt_schedules_file_errors_instead_of_wiping() {
        let temp = TempDir::new().unwrap();
        let path = schedules_path(temp.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        assert!(load_schedules(temp.path()).is_err());
    }

    #[test]
    fn add_set_enabled_remove_flow() {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        let input = SchedulerScheduleInput {
            name: "Daily sync".to_string(),
            skill_id: "vault-sync".to_string(),
            runtime: "Claude".to_string(),
            prompt: "Sync the vault".to_string(),
            hour: 9,
            minute: 30,
            days_of_week: vec![1, 1, 3],
            enabled: true,
        };
        let added = add_impl(&work, input).unwrap();
        assert_eq!(added.runtime, "claude");
        assert_eq!(added.days_of_week, vec![1, 3]);
        assert!(added.next_run_at.is_some());
        assert_eq!(load_schedules(temp.path()).unwrap().len(), 1);

        let disabled = set_enabled_impl(&work, &added.id, false).unwrap();
        assert!(!disabled.enabled);
        let reenabled = set_enabled_impl(&work, &added.id, true).unwrap();
        assert!(reenabled.enabled);
        assert!(reenabled.next_run_at.is_some());

        remove_impl(&work, &added.id).unwrap();
        assert!(load_schedules(temp.path()).unwrap().is_empty());
        assert!(remove_impl(&work, &added.id).is_err());
    }

    #[test]
    fn add_rejects_invalid_input() {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        let base = SchedulerScheduleInput {
            name: "x".to_string(),
            skill_id: "s".to_string(),
            runtime: "claude".to_string(),
            prompt: "p".to_string(),
            hour: 9,
            minute: 0,
            days_of_week: Vec::new(),
            enabled: true,
        };
        let bad_runtime = SchedulerScheduleInput {
            runtime: "openai".to_string(),
            ..base.clone()
        };
        assert!(add_impl(&work, bad_runtime).is_err());
        let bad_hour = SchedulerScheduleInput {
            hour: 25,
            ..base.clone()
        };
        assert!(add_impl(&work, bad_hour).is_err());
        let empty_name = SchedulerScheduleInput {
            name: "  ".to_string(),
            ..base.clone()
        };
        assert!(add_impl(&work, empty_name).is_err());
        let empty_prompt = SchedulerScheduleInput {
            prompt: " ".to_string(),
            ..base
        };
        assert!(add_impl(&work, empty_prompt).is_err());
    }

    #[test]
    fn mark_fired_records_run_and_realigns_next() {
        let temp = TempDir::new().unwrap();
        let work = temp.path().to_string_lossy().to_string();
        let added = add_impl(
            &work,
            SchedulerScheduleInput {
                name: "Daily".to_string(),
                skill_id: "s".to_string(),
                runtime: "kimi".to_string(),
                prompt: "p".to_string(),
                hour: 9,
                minute: 30,
                days_of_week: Vec::new(),
                enabled: true,
            },
        )
        .unwrap();
        let now = Local::now();
        let fired = mark_fired(temp.path(), &added.id, now).unwrap();
        assert!(fired.last_run_at.is_some());
        let next = fired.next_run_at.clone().unwrap();
        let next = DateTime::parse_from_rfc3339(&next).unwrap();
        assert!(next > now, "next run must move past the fired slot");
        // After re-alignment the schedule is no longer due.
        assert!(!is_due(&fired, now));
    }
}
