// In-app scheduler for recurring skill missions. Schedules persist per
// workspace at <work>/.maru/schedules.json. A ticker started in the app
// setup scans every registered workspace every 60 seconds and dispatches
// due schedules through the existing skill-run machinery
// (skills_dispatch_background) — no new AI invocation path. On launch, a
// schedule whose nextRunAt lies in the past fires exactly once (catch-up)
// and is then re-aligned to its next future slot.

#[cfg(not(test))]
use crate::agents::global_ai_settings;
use crate::agents::{agent_can_run_standalone, get_agent, AgentRecord, GlobalAiSettings};
use crate::approval::{require_approval, ApprovalState};
use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionParent,
    PathTransactionRequest,
};
#[cfg(not(test))]
use crate::skill_host::store::resolve_skill_id;
#[cfg(not(test))]
use crate::skill_host::SkillDispatchBackgroundArgs;
use chrono::{DateTime, Datelike, Days, Local, NaiveDate, TimeZone};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::Duration as StdDuration;
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

const SCHEDULER_TICK_SECONDS: u64 = 60;
const SCHEDULER_ADD_KIND: &str = "scheduler.add";

static TICKER_STARTED: AtomicBool = AtomicBool::new(false);

/// (workspace, schedule id) -> civil date the ticker last dispatched it on.
/// A schedule owns one hour:minute slot per day, so a date-keyed claim taken
/// before dispatch caps the ticker at one run per day even when the
/// persisted nextRunAt guard cannot be written (ENOSPC, read-only mount).
/// ponytail: process-local only, entries are overwritten not evicted.
static LAST_FIRED: Mutex<BTreeMap<(PathBuf, String), NaiveDate>> = Mutex::new(BTreeMap::new());

// A short bookkeeping reservation, never a mutex held over dispatch or path waits.
// Timer and explicit run-now share it; independent schedules remain runnable.
static IN_FLIGHT: Mutex<BTreeSet<(PathBuf, String)>> = Mutex::new(BTreeSet::new());
struct SchedulerClaim((PathBuf, String));
impl SchedulerClaim {
    fn acquire(work: &Path, id: &str) -> Result<Self, String> {
        let key = (
            fs::canonicalize(work).map_err(|err| err.to_string())?,
            id.to_string(),
        );
        if !IN_FLIGHT
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .insert(key.clone())
        {
            return Err("scheduler_busy".to_string());
        }
        Ok(Self(key))
    }
}
impl Drop for SchedulerClaim {
    fn drop(&mut self) {
        IN_FLIGHT
            .lock()
            .unwrap_or_else(|err| err.into_inner())
            .remove(&self.0);
    }
}

// The admitted set keeps the command's lexical workspace root so a
// symlinked caller path stays observable to hooks, conflicts and
// alias-parent revalidation; canonical `work` remains the IO target.
fn scheduler_admission_root(work_path: &str, work: &Path) -> PathBuf {
    let lexical = crate::vault::lexical_normalize(std::path::Path::new(work_path));
    if lexical.is_absolute() {
        lexical
    } else {
        work.to_path_buf()
    }
}

fn scheduler_parent_snapshots(work: &Path) -> Result<Vec<PathTransactionParent>, String> {
    Ok(vec![
        PathTransactionParent::capture(work)?,
        PathTransactionParent::capture(&work.join(".maru"))?,
    ])
}

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
    /// Agent this schedule runs. `#[serde(default)]` so a pre-agent
    /// `schedules.json` parses unchanged. When it resolves to an enabled,
    /// standalone agent that agent's current configuration wins at dispatch.
    /// A *disabled* agent stops the schedule outright; a missing or
    /// feature-bound one falls back to the fields above as a stored snapshot,
    /// so deleting an agent never breaks a live schedule.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
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
    #[serde(default)]
    pub agent_id: Option<String>,
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

// The allocation parent covers atomic temporary siblings, including physical aliases
// of a symlinked schedules.json. No scheduler mutex is held during admission.
fn scheduler_transaction_request(work: &Path) -> Result<PathTransactionRequest, String> {
    PathTransactionRequest::new(vec![work.join(".maru"), schedules_path(work)])?
        .require_parent(work)
}

fn save_schedules_in_transaction(
    work: &Path,
    schedules: &[SchedulerSchedule],
    lease: &PathTransactionLease,
) -> Result<(), String> {
    lease.ensure_covered([work.join(".maru"), schedules_path(work)])?;
    lease.before_effect()?;
    let bytes = serde_json::to_vec_pretty(schedules)
        .map_err(|err| format!("Cannot serialize schedules: {err}"))?;
    write_atomic(&schedules_path(work), &bytes)
}

#[cfg(test)]
fn save_schedules(work: &Path, schedules: &[SchedulerSchedule]) -> Result<(), String> {
    with_path_transactions(scheduler_transaction_request(work)?, |lease| {
        save_schedules_in_transaction(work, schedules, lease)
    })
}

/// Next fire time strictly after `now`, honoring optional weekday filters.
/// Returns None for invalid hour/minute/weekday input.
///
/// Candidates walk civil dates, not 24-hour instants, so a DST transition
/// never skips a calendar day. An ambiguous local time (fall back) resolves
/// to the earlier instant and a nonexistent one (spring forward) skips only
/// that day — never the whole lookup, whose None means "no slot", which
/// callers persist as a missing nextRunAt.
///
/// Generic over the timezone so DST can be tested against a fixed zone; the
/// production call sites all pass `Local::now()`.
fn compute_next_run<Tz: TimeZone>(
    now: DateTime<Tz>,
    hour: u32,
    minute: u32,
    days_of_week: &[u32],
) -> Option<DateTime<Tz>> {
    if hour > 23 || minute > 59 || days_of_week.iter().any(|day| *day > 6) {
        return None;
    }
    let tz = now.timezone();
    let days: BTreeSet<u32> = days_of_week.iter().copied().collect();
    for offset in 0..=7_u64 {
        let date = now.date_naive() + Days::new(offset);
        if !days.is_empty() && !days.contains(&date.weekday().num_days_from_sunday()) {
            continue;
        }
        let naive = date.and_hms_opt(hour, minute, 0)?;
        let Some(candidate) = tz.from_local_datetime(&naive).earliest() else {
            continue;
        };
        if candidate > now {
            return Some(candidate);
        }
    }
    None
}

/// A schedule is due when it is enabled and either has never run and has no
/// recorded next run (fresh or migrated from an older schema) or its next run
/// is now or in the past (catch-up included — both cases fire exactly once
/// and then re-align). A schedule that has run but holds no nextRunAt failed
/// to re-align; treating that as due would re-fire it every tick.
fn is_due(schedule: &SchedulerSchedule, now: DateTime<Local>) -> bool {
    if !schedule.enabled {
        return false;
    }
    let Some(next) = schedule.next_run_at.as_deref() else {
        return schedule.last_run_at.is_none();
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

#[cfg(test)]
fn add_impl(work_path: &str, input: SchedulerScheduleInput) -> Result<SchedulerSchedule, String> {
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let admission = scheduler_admission_root(work_path, &work);
    with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
        scheduler_add_in_transaction(&work, input, lease)
    })
}

fn scheduler_add_in_transaction(
    work: &Path,
    input: SchedulerScheduleInput,
    lease: &PathTransactionLease,
) -> Result<SchedulerSchedule, String> {
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
        agent_id: input.agent_id.filter(|id| !id.trim().is_empty()),
        last_run_at: None,
        next_run_at: if input.enabled {
            Some(next_run.to_rfc3339())
        } else {
            None
        },
    };
    let mut schedules = load_schedules(work)?;
    schedules.push(schedule.clone());
    save_schedules_in_transaction(work, &schedules, lease)?;
    Ok(schedule)
}

fn find_schedule(schedules: &[SchedulerSchedule], id: &str) -> Option<usize> {
    schedules.iter().position(|schedule| schedule.id == id)
}

fn set_enabled_impl(work_path: &str, id: &str, enabled: bool) -> Result<SchedulerSchedule, String> {
    validate_schedule_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let admission = scheduler_admission_root(work_path, &work);
    with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
        let mut schedules = load_schedules(&work)?;
        let index =
            find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
        schedules[index].enabled = enabled;
        if enabled && schedules[index].next_run_at.is_none() {
            let schedule = &schedules[index];
            schedules[index].next_run_at = compute_next_run(
                Local::now(),
                schedule.hour,
                schedule.minute,
                &schedule.days_of_week,
            )
            .map(|next| next.to_rfc3339());
        }
        save_schedules_in_transaction(&work, &schedules, lease)?;
        Ok(schedules[index].clone())
    })
}

fn remove_impl(work_path: &str, id: &str) -> Result<(), String> {
    validate_schedule_id(id)?;
    let work = crate::vault::normalize_existing_dir(work_path)?;
    let admission = scheduler_admission_root(work_path, &work);
    with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
        let mut schedules = load_schedules(&work)?;
        let index =
            find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
        schedules.remove(index);
        save_schedules_in_transaction(&work, &schedules, lease)
    })
}

/// Record a fired run: stamp lastRunAt and re-align nextRunAt strictly after
/// `now` so a missed window never triggers a burst of catch-up runs.
#[cfg(test)]
fn mark_fired(work: &Path, id: &str, now: DateTime<Local>) -> Result<SchedulerSchedule, String> {
    with_path_transactions(scheduler_transaction_request(work)?, |lease| {
        scheduler_run_now_in_transaction(work, id, now, lease)
    })
}

fn scheduler_run_now_in_transaction(
    work: &Path,
    id: &str,
    now: DateTime<Local>,
    lease: &PathTransactionLease,
) -> Result<SchedulerSchedule, String> {
    let mut schedules = load_schedules(work)?;
    let index = find_schedule(&schedules, id).ok_or_else(|| "scheduler_not_found".to_string())?;
    schedules[index].last_run_at = Some(now.to_rfc3339());
    let schedule = &schedules[index];
    schedules[index].next_run_at =
        compute_next_run(now, schedule.hour, schedule.minute, &schedule.days_of_week)
            .map(|next| next.to_rfc3339());
    save_schedules_in_transaction(work, &schedules, lease)?;
    Ok(schedules[index].clone())
}

/// Prompt actually dispatched for a schedule. For the builtin inbox-process
/// skill a stale baked-in gap-feedback section (legacy add-time snapshot) is
/// stripped and the digest is rebuilt fresh from the current gap log;
/// anything else passes through untouched. Best-effort: a gap-log read
/// failure dispatches the bare stripped prompt, and an empty log yields no
/// section at all. If stripping would leave nothing (a legacy prompt that was
/// ONLY the baked-in section) and there is no fresh digest to add, the
/// original stored prompt is dispatched instead — a stale digest beats a
/// `skill_prompt_required` failure.
fn build_dispatch_prompt(work: &Path, skill_id: &str, prompt: &str) -> String {
    if !is_builtin_inbox_process(skill_id) {
        return prompt.to_string();
    }
    let stripped = crate::gap::strip_gap_feedback_section(prompt);
    let entries = crate::gap::read_gap_log_entries(work).unwrap_or_default();
    let digest = crate::gap::build_gap_feedback_digest(
        &entries,
        crate::gap::GAP_FEEDBACK_DEFAULT_MAX_ENTRIES,
    );
    if stripped.trim().is_empty() && digest.is_empty() {
        return prompt.to_string();
    }
    crate::gap::append_gap_feedback_digest(&stripped, &digest)
}

/// Canonical match for the builtin inbox skill only: an imported skill whose
/// composite id merely contains "inbox-process" must not have its prompt
/// rewritten at dispatch.
fn is_builtin_inbox_process(skill_id: &str) -> bool {
    skill_id == "inbox-process" || skill_id == "maru-builtin::inbox-process"
}

/// What a schedule actually dispatches, after the agent it points at (if any)
/// and the user-global AI settings have been folded in.
#[derive(Debug, Clone, PartialEq, Eq)]
struct DispatchPlan {
    /// Skill name or registry id; `resolve_skill_id` accepts either.
    skill_ref: String,
    runtime: String,
    prompt: String,
    permission_mode: Option<String>,
    command_override: Option<String>,
    agent_id: Option<String>,
}

/// Resolve a schedule against its agent. An enabled, standalone agent's current
/// skill / runtime / permission mode / prompt win, so editing the agent updates
/// every schedule that uses it. A missing, disabled or feature-bound agent
/// falls back to the schedule's own stored snapshot, so deleting or pausing an
/// agent never silently breaks — or silently empties — a live schedule.
fn resolve_dispatch(
    schedule: &SchedulerSchedule,
    agent: Option<&AgentRecord>,
    ai: &GlobalAiSettings,
) -> Result<DispatchPlan, String> {
    // Switching an agent off has to stop its schedule, not fall through to the
    // snapshot captured when it was attached — that snapshot is byte-identical
    // to what the agent used to run, so "off" would mean nothing on the one
    // path nobody is watching. Only a *missing* or feature-bound agent falls
    // back, which is what keeps a deleted agent from breaking a live schedule.
    if let Some(agent) = agent {
        if !agent.enabled {
            return Err(format!("agent_disabled: {}", agent.id));
        }
    }
    let agent = agent.filter(|agent| agent_can_run_standalone(agent));
    let runtime = match agent.map(|agent| agent.runtime.as_str()) {
        Some("inherit") => ai
            .default_runtime
            .clone()
            .unwrap_or_else(|| schedule.runtime.clone()),
        Some(explicit) => explicit.to_string(),
        None => schedule.runtime.clone(),
    };
    // An unattended run defaults to `plan` regardless of the global setting: the
    // user chose that setting for runs they are sitting in front of, and
    // silently promoting a 07:00 timer to `bypassPermissions` is exactly the
    // "agent-autonomous edits as default behavior" the README rules out. An
    // agent that needs more says so explicitly, per agent.
    let permission_mode = match agent.map(|agent| agent.permission_mode.as_str()) {
        Some("inherit") | None => None,
        Some(explicit) => Some(explicit.to_string()),
    };
    // An agent names its skill portably; the schedule stores the machine-local
    // registry id it was created with. Either is accepted by `resolve_skill_id`.
    let skill_ref = agent
        .map(|agent| agent.skill_name.clone())
        .unwrap_or_else(|| schedule.skill_id.clone());
    Ok(DispatchPlan {
        command_override: ai.command_override_for(&runtime),
        skill_ref,
        runtime,
        prompt: agent
            .map(|agent| agent.prompt.clone())
            .unwrap_or_else(|| schedule.prompt.clone()),
        permission_mode,
        agent_id: schedule.agent_id.clone(),
    })
}

/// True when a schedule must not fire because the agent it names is switched
/// off. Checked before the ticker claims the day, so a paused agent costs
/// nothing and emits nothing rather than erroring once a minute.
fn schedule_is_paused_by_agent(schedule: &SchedulerSchedule) -> bool {
    schedule
        .agent_id
        .as_deref()
        .and_then(get_agent)
        .is_some_and(|agent| !agent.enabled)
}

/// Metadata every scheduled run carries. `workspacePath` and `skillName` are
/// what `skillRunView` needs to render a run as anything other than a raw run
/// id; `agentId` is the join key the Agents pane groups by.
fn dispatch_metadata(
    schedule: &SchedulerSchedule,
    plan: &DispatchPlan,
    skill_id: &str,
    work: &Path,
) -> serde_json::Value {
    serde_json::json!({
        "scheduler": true,
        "scheduleId": schedule.id,
        "scheduleName": schedule.name,
        "agentId": plan.agent_id,
        "skillName": skill_name_of(skill_id),
        "runtime": plan.runtime,
        "permissionMode": plan.permission_mode,
        "workspacePath": work.to_string_lossy().to_string(),
    })
}

/// `<sourceId>::<name>` -> `<name>`; anything else passes through.
fn skill_name_of(skill_id: &str) -> String {
    skill_id.rsplit("::").next().unwrap_or(skill_id).to_string()
}

fn dispatch_schedule<R: tauri::Runtime>(
    app: &AppHandle<R>,
    work: &Path,
    schedule: &SchedulerSchedule,
    parents: Vec<PathTransactionParent>,
) -> Result<String, String> {
    #[cfg(test)]
    {
        let _ = app;
        PathTransactionLease::test_stage(&[work.to_path_buf()], "scheduler:dispatch");
        let executor = PHASE08_15_EXECUTOR.lock().unwrap().clone();
        if let Some(executor) = executor {
            // Same original-parent admission expected from the real dispatch producer.
            let mut request = scheduler_transaction_request(work)?;
            for parent in &parents {
                request = request.require_parent_snapshot(parent)?;
            }
            with_path_transactions(request, |lease| lease.before_effect())?;
            return executor(work, schedule);
        }
        return Err("scheduler_fixture_executor_required".to_string());
    }
    #[cfg(not(test))]
    {
        let agent = schedule.agent_id.as_deref().and_then(get_agent);
        let plan = resolve_dispatch(schedule, agent.as_ref(), &global_ai_settings())?;
        let skill_id = resolve_skill_id(&plan.skill_ref)?;
        let metadata = dispatch_metadata(schedule, &plan, &skill_id, work);
        crate::skill_host::dispatch::skills_dispatch_background_with_parents(
            app.clone(),
            SkillDispatchBackgroundArgs {
                skill_id: skill_id.clone(),
                runtime: plan.runtime.clone(),
                prompt: build_dispatch_prompt(work, &skill_id, &plan.prompt),
                cwd: Some(work.to_string_lossy().to_string()),
                context: None,
                metadata: Some(metadata),
                command_override: plan.command_override.clone(),
                permission_mode: plan.permission_mode.clone(),
            },
            parents,
        )
    }
}

fn run_due_for_workspace<R: tauri::Runtime>(
    app: &AppHandle<R>,
    work: &Path,
    now: DateTime<Local>,
) -> Result<(), String> {
    let parents = scheduler_parent_snapshots(work)?;
    let schedules = load_schedules(work)?;
    for selected in schedules {
        let mut request = scheduler_transaction_request(work)?;
        for parent in &parents {
            request = request.require_parent_snapshot(parent)?;
        }
        let ready = with_path_transactions(request, |lease| {
            let mut current = load_schedules(work)?;
            let Some(index) = find_schedule(&current, &selected.id) else {
                return Ok(None);
            };
            let schedule = &current[index];
            if !schedule.enabled || schedule_is_paused_by_agent(schedule) {
                return Ok(None);
            }
            if schedule
                .next_run_at
                .as_deref()
                .is_some_and(|next| DateTime::parse_from_rfc3339(next).is_err())
            {
                current[index].next_run_at =
                    compute_next_run(now, schedule.hour, schedule.minute, &schedule.days_of_week)
                        .map(|v| v.to_rfc3339());
                save_schedules_in_transaction(work, &current, lease)?;
                return Ok(None);
            }
            if !is_due(schedule, now) {
                return Ok(None);
            }
            let active = match SchedulerClaim::acquire(work, &schedule.id) {
                Ok(active) => active,
                Err(error) if error == "scheduler_busy" => return Ok(None),
                Err(error) => return Err(error),
            };
            let claim = (
                fs::canonicalize(work).map_err(|err| err.to_string())?,
                schedule.id.clone(),
            );
            {
                let mut claimed = LAST_FIRED.lock().unwrap_or_else(|err| err.into_inner());
                if claimed.get(&claim) == Some(&now.date_naive()) {
                    return Ok(None);
                }
                claimed.insert(claim, now.date_naive());
            }
            lease.before_effect()?;
            Ok(Some((schedule.clone(), active)))
        })?;
        let Some((schedule, _active)) = ready else {
            continue;
        };
        let work_path = work.to_string_lossy().to_string();
        match dispatch_schedule(app, work, &schedule, parents.clone()) {
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
        // An accepted run may complete after removal/disable. Settlement never
        // resurrects that schedule or overwrites a concurrently edited record.
        let settled = scheduler_settle(work, &parents, &schedule, now);
        match settled {
            Ok(()) => {
                LAST_FIRED
                    .lock()
                    .unwrap_or_else(|err| err.into_inner())
                    .remove(&(
                        fs::canonicalize(work).unwrap_or_else(|_| work.to_path_buf()),
                        schedule.id.clone(),
                    ));
            }
            Err(message) => {
                let _ = app.emit(
                    "scheduler://error",
                    SchedulerErrorEvent {
                        work_path,
                        schedule_id: schedule.id,
                        message: format!("scheduler_persist_failed: {message}"),
                    },
                );
            }
        }
    }
    Ok(())
}

fn scheduler_settle(
    work: &Path,
    parents: &[PathTransactionParent],
    selected: &SchedulerSchedule,
    now: DateTime<Local>,
) -> Result<(), String> {
    let mut request = scheduler_transaction_request(work)?;
    for parent in parents {
        request = request.require_parent_snapshot(parent)?;
    }
    with_path_transactions(request, |lease| {
        let current = load_schedules(work)?;
        let Some(index) = find_schedule(&current, &selected.id) else {
            return Ok(());
        };
        if &current[index] != selected {
            return Ok(());
        }
        scheduler_run_now_in_transaction(work, &selected.id, now, lease)?;
        Ok(())
    })
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

fn emit_scheduler_changed<R: tauri::Runtime>(app: &AppHandle<R>, work_path: &str) {
    let _ = app.emit(
        "scheduler://changed",
        SchedulerChangedEvent {
            work_path: work_path.to_string(),
        },
    );
}

pub fn scheduler_list(work_path: String) -> Result<Vec<SchedulerSchedule>, String> {
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    load_schedules(&work)
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn scheduler_add(
    approvals: tauri::State<'_, ApprovalState>,
    app: AppHandle,
    work_path: String,
    schedule: SchedulerScheduleInput,
    approval_id: Option<String>,
) -> Result<SchedulerSchedule, String> {
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    let admission = scheduler_admission_root(&work_path, &work);
    let result = with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
        require_approval(&approvals, approval_id, SCHEDULER_ADD_KIND)?;
        scheduler_add_in_transaction(&work, schedule, lease)
    })?;
    emit_scheduler_changed(&app, &work_path);
    Ok(result)
}

fn scheduler_add_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: String,
    schedule: SchedulerScheduleInput,
    approval_id: Option<String>,
) -> Result<SchedulerSchedule, String> {
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    let admission = scheduler_admission_root(&work_path, &work);
    let result = with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
        require_approval(
            &app.state::<ApprovalState>(),
            approval_id,
            SCHEDULER_ADD_KIND,
        )?;
        scheduler_add_in_transaction(&work, schedule, lease)
    })?;
    emit_scheduler_changed(&app, &work_path);
    Ok(result)
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn scheduler_remove(app: AppHandle, work_path: String, id: String) -> Result<(), String> {
    scheduler_remove_blocking(app, work_path, id)
}

fn scheduler_remove_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: String,
    id: String,
) -> Result<(), String> {
    remove_impl(&work_path, &id)?;
    emit_scheduler_changed(&app, &work_path);
    Ok(())
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn scheduler_set_enabled(
    app: AppHandle,
    work_path: String,
    id: String,
    enabled: bool,
) -> Result<SchedulerSchedule, String> {
    scheduler_set_enabled_blocking(app, work_path, id, enabled)
}

fn scheduler_set_enabled_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: String,
    id: String,
    enabled: bool,
) -> Result<SchedulerSchedule, String> {
    let schedule = set_enabled_impl(&work_path, &id, enabled)?;
    emit_scheduler_changed(&app, &work_path);
    Ok(schedule)
}

#[allow(dead_code)] // Stable synchronous Rust API; desktop registration uses ipc.
pub fn scheduler_run_now(app: AppHandle, work_path: String, id: String) -> Result<String, String> {
    scheduler_run_now_blocking(app, work_path, id)
}

fn scheduler_run_now_blocking<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: String,
    id: String,
) -> Result<String, String> {
    validate_schedule_id(&id)?;
    let work = crate::vault::normalize_existing_dir(&work_path)?;
    let admission = scheduler_admission_root(&work_path, &work);
    let parents = scheduler_parent_snapshots(&work)?;
    let (selected, _active) =
        with_path_transactions(scheduler_transaction_request(&admission)?, |lease| {
            let schedules = load_schedules(&work)?;
            let index =
                find_schedule(&schedules, &id).ok_or_else(|| "scheduler_not_found".to_string())?;
            lease.before_effect()?;
            Ok((
                schedules[index].clone(),
                SchedulerClaim::acquire(&work, &id)?,
            ))
        })?;
    let invocation_id = dispatch_schedule(&app, &work, &selected, parents.clone())?;
    // Same contract as the ticker: a failed persist leaves nextRunAt in the past,
    // so the next tick will fire this schedule again. The day claim bounds that to
    // one extra run, but the user still has to be told persistence failed.
    if let Err(message) = scheduler_settle(&work, &parents, &selected, Local::now()) {
        let _ = app.emit(
            "scheduler://error",
            SchedulerErrorEvent {
                work_path: work_path.clone(),
                schedule_id: id.clone(),
                message: format!("scheduler_persist_failed: {message}"),
            },
        );
    }
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

// D-04: Settings/Agents callers keep their existing scheduler events and notices.
// Plan25/26 owns navigation-safe completion; the existing mission runner owns work.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn scheduler_list(work_path: String) -> Result<Vec<SchedulerSchedule>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:scheduler_list");
            super::scheduler_list(work_path)
        })
        .await
        .map_err(|error| format!("scheduler_list_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn scheduler_add<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        schedule: SchedulerScheduleInput,
        approval_id: Option<String>,
    ) -> Result<SchedulerSchedule, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:scheduler_add");
            super::scheduler_add_blocking(app, work_path, schedule, approval_id)
        })
        .await
        .map_err(|error| format!("scheduler_add_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn scheduler_remove<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        id: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scheduler_remove",
            );
            super::scheduler_remove_blocking(app, work_path, id)
        })
        .await
        .map_err(|error| format!("scheduler_remove_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn scheduler_set_enabled<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        id: String,
        enabled: bool,
    ) -> Result<SchedulerSchedule, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scheduler_set_enabled",
            );
            super::scheduler_set_enabled_blocking(app, work_path, id, enabled)
        })
        .await
        .map_err(|error| format!("scheduler_set_enabled_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn scheduler_run_now<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: String,
        id: String,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scheduler_run_now",
            );
            super::scheduler_run_now_blocking(app, work_path, id)
        })
        .await
        .map_err(|error| format!("scheduler_run_now_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn local(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<Local> {
        Local
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(y, mo, d)
                    .unwrap()
                    .and_hms_opt(h, mi, 0)
                    .unwrap(),
            )
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
            agent_id: None,
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

    // DST assertions need a fixed zone: CI runs in UTC, where `Local` has no
    // transitions. compute_next_run is generic over the timezone for this.
    fn ny(y: i32, mo: u32, d: u32, h: u32, mi: u32) -> DateTime<chrono_tz::Tz> {
        chrono_tz::America::New_York
            .from_local_datetime(
                &chrono::NaiveDate::from_ymd_opt(y, mo, d)
                    .unwrap()
                    .and_hms_opt(h, mi, 0)
                    .unwrap(),
            )
            .earliest()
            .unwrap()
    }

    #[test]
    fn next_run_resolves_ambiguous_local_time_to_earliest() {
        // 2026-11-01 falls back 02:00 EDT -> 01:00 EST, so 01:30 happens twice.
        let now = ny(2026, 11, 1, 0, 30);
        let next = compute_next_run(now, 1, 30, &[]).expect("ambiguous slot must resolve");
        assert_eq!(
            next.date_naive(),
            chrono::NaiveDate::from_ymd_opt(2026, 11, 1).unwrap()
        );
        // 01:30 EDT (05:30 UTC), the earlier of the two instants.
        assert_eq!(next.naive_utc(), ny(2026, 11, 1, 1, 30).naive_utc());
        assert_eq!(
            next.naive_utc().time(),
            chrono::NaiveTime::from_hms_opt(5, 30, 0).unwrap()
        );
    }

    #[test]
    fn next_run_skips_nonexistent_local_time() {
        // 2026-03-08 springs forward 02:00 -> 03:00, so 02:30 does not exist.
        let now = ny(2026, 3, 8, 0, 30);
        let next = compute_next_run(now, 2, 30, &[]).expect("nonexistent slot must skip the day");
        assert_eq!(
            next.date_naive(),
            chrono::NaiveDate::from_ymd_opt(2026, 3, 9).unwrap()
        );
    }

    #[test]
    fn next_run_does_not_skip_a_weekday_across_spring_forward() {
        // Saturday 23:30 EST: instant arithmetic (+24h) would land on Monday
        // and push a Sunday-only schedule out a full week.
        let now = ny(2026, 3, 7, 23, 30);
        let next = compute_next_run(now, 9, 0, &[0]).expect("Sunday slot must be found");
        assert_eq!(
            next.date_naive(),
            chrono::NaiveDate::from_ymd_opt(2026, 3, 8).unwrap()
        );
        assert_eq!(next.date_naive().weekday().num_days_from_sunday(), 0);
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
        assert!(
            is_due(&past, now),
            "past nextRunAt must fire once (catch-up)"
        );
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
    fn fired_without_next_run_never_refires() {
        let now = Local::now();
        let unaligned = SchedulerSchedule {
            last_run_at: Some(now.to_rfc3339()),
            ..sample_schedule(None, true)
        };
        assert!(
            !is_due(&unaligned, now),
            "a fired schedule that could not re-align must not fire every tick"
        );
        let never_ran = sample_schedule(None, true);
        assert!(
            is_due(&never_ran, now),
            "fresh or migrated schedule fires once"
        );
    }

    #[test]
    fn persistence_round_trip() {
        let temp = TempDir::new().unwrap();
        assert!(load_schedules(temp.path()).unwrap().is_empty());
        let schedules = vec![sample_schedule(
            Some("2026-07-31T09:30:00+09:00".to_string()),
            true,
        )];
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
            agent_id: None,
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
            agent_id: None,
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
                agent_id: None,
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

    // === Dispatch-time gap-feedback digest ===

    use crate::gap::{GapLogEntry, GapTypeCounts, GAP_FEEDBACK_SECTION_HEADER};

    fn inbox_schedule(prompt: &str) -> SchedulerSchedule {
        SchedulerSchedule {
            skill_id: "inbox-process".to_string(),
            prompt: prompt.to_string(),
            ..sample_schedule(None, true)
        }
    }

    fn agent(id: &str, prompt: &str, runtime: &str, enabled: bool) -> AgentRecord {
        AgentRecord {
            id: id.to_string(),
            label_key: None,
            label: Some(id.to_string()),
            description: None,
            skill_name: "vault-lint".to_string(),
            runtime: runtime.to_string(),
            permission_mode: "inherit".to_string(),
            prompt: prompt.to_string(),
            kind: "background".to_string(),
            enabled,
            builtin: false,
            customized: false,
            recommended_schedule: None,
        }
    }

    fn ai_settings() -> GlobalAiSettings {
        GlobalAiSettings {
            default_runtime: Some("codex".to_string()),
            permission_mode: Some("bypassPermissions".to_string()),
            command_overrides: [("kimi".to_string(), "/opt/kimi".to_string())]
                .into_iter()
                .collect(),
        }
    }

    #[test]
    fn dispatch_without_an_agent_keeps_the_schedule_snapshot() {
        let schedule = sample_schedule(None, true);
        let plan = resolve_dispatch(&schedule, None, &ai_settings()).unwrap();
        assert_eq!(plan.skill_ref, "vault-sync");
        assert_eq!(plan.runtime, "claude");
        assert_eq!(plan.prompt, "Run it");
        // The bug this fixes: both of these used to be hardcoded None, so every
        // timed run ignored the user's CLI path override and ran at `plan`.
        // Unattended runs stay at `plan`; the command override is the half of
        // the old hardcoded `None, None` that genuinely was a bug.
        assert!(plan.permission_mode.is_none());
        assert!(plan.command_override.is_none());
    }

    #[test]
    fn dispatch_takes_the_agents_current_configuration() {
        let schedule = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        let agent = agent("vault-hygiene", "정합성 점검", "kimi", true);
        let plan = resolve_dispatch(&schedule, Some(&agent), &ai_settings()).unwrap();
        assert_eq!(plan.skill_ref, "vault-lint");
        assert_eq!(plan.runtime, "kimi");
        assert_eq!(plan.prompt, "정합성 점검");
        assert_eq!(plan.command_override.as_deref(), Some("/opt/kimi"));
        assert_eq!(plan.agent_id.as_deref(), Some("vault-hygiene"));
    }

    #[test]
    fn an_agent_on_inherit_resolves_through_global_settings() {
        let schedule = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        let agent = agent("vault-hygiene", "정합성 점검", "inherit", true);
        let plan = resolve_dispatch(&schedule, Some(&agent), &ai_settings()).unwrap();
        assert_eq!(plan.runtime, "codex");

        // With no global default the schedule's own runtime is the floor, so a
        // dispatch never resolves to nothing.
        let plan = resolve_dispatch(&schedule, Some(&agent), &GlobalAiSettings::default()).unwrap();
        assert_eq!(plan.runtime, "claude");
    }

    #[test]
    fn a_disabled_agent_stops_its_schedule_instead_of_running_the_snapshot() {
        let schedule = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        // The snapshot is byte-identical to what the agent used to run, so
        // falling back to it would make "off" mean nothing on the one path
        // nobody is watching.
        let disabled = agent("vault-hygiene", "정합성 점검", "kimi", false);
        assert_eq!(
            resolve_dispatch(&schedule, Some(&disabled), &ai_settings()).unwrap_err(),
            "agent_disabled: vault-hygiene"
        );
    }

    #[test]
    fn a_missing_or_feature_bound_agent_falls_back_to_the_snapshot() {
        let schedule = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        // A feature-bound agent carries no prompt of its own; taking it would
        // dispatch an empty prompt.
        let feature_bound = agent("inbox-triage", "", "kimi", true);
        let plan = resolve_dispatch(&schedule, Some(&feature_bound), &ai_settings()).unwrap();
        assert_eq!(plan.prompt, "Run it");
        assert_eq!(plan.skill_ref, "vault-sync");

        // A deleted agent must never break a live schedule.
        let plan = resolve_dispatch(&schedule, None, &ai_settings()).unwrap();
        assert_eq!(plan.skill_ref, "vault-sync");
        assert_eq!(plan.runtime, "claude");
    }

    #[test]
    fn an_unattended_run_does_not_inherit_a_permissive_global_mode() {
        // The user's global bypassPermissions is for runs they are sitting in
        // front of. A 07:00 timer silently promoted to it is the
        // agent-autonomous default the README rules out.
        let schedule = sample_schedule(None, true);
        let plan = resolve_dispatch(&schedule, None, &ai_settings()).unwrap();
        assert!(plan.permission_mode.is_none(), "{plan:?}");

        let inheriting = agent("vault-hygiene", "점검", "kimi", true);
        let with_agent = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        let plan = resolve_dispatch(&with_agent, Some(&inheriting), &ai_settings()).unwrap();
        assert!(plan.permission_mode.is_none());

        // An agent that needs more says so explicitly.
        let mut explicit = agent("git-sync", "커밋", "codex", true);
        explicit.permission_mode = "acceptEdits".to_string();
        let plan = resolve_dispatch(&with_agent, Some(&explicit), &ai_settings()).unwrap();
        assert_eq!(plan.permission_mode.as_deref(), Some("acceptEdits"));
    }

    #[test]
    fn dispatch_metadata_carries_what_the_run_panel_reads() {
        let temp = TempDir::new().unwrap();
        let schedule = SchedulerSchedule {
            agent_id: Some("vault-hygiene".to_string()),
            ..sample_schedule(None, true)
        };
        let plan = resolve_dispatch(&schedule, None, &ai_settings()).unwrap();
        let metadata = dispatch_metadata(&schedule, &plan, "maru-builtin::vault-sync", temp.path());

        // Without workspacePath and skillName, skillRunView renders a scheduled
        // run as its raw run id.
        assert_eq!(metadata["skillName"], "vault-sync");
        assert_eq!(
            metadata["workspacePath"],
            temp.path().to_string_lossy().to_string()
        );
        assert_eq!(metadata["agentId"], "vault-hygiene");
        assert_eq!(metadata["runtime"], "claude");
        assert!(metadata["permissionMode"].is_null());
        assert_eq!(metadata["scheduleId"], "sched-test");
    }

    #[test]
    fn a_pre_agent_schedules_json_still_parses() {
        let legacy = r#"[{"id":"sched-1","name":"Inbox extract-tasks",
            "skillId":"maru-builtin::inbox-process","runtime":"claude",
            "prompt":"extract-tasks","hour":7,"minute":0,"daysOfWeek":[],
            "enabled":true,"lastRunAt":"2026-08-02T07:00:20+09:00",
            "nextRunAt":"2026-08-03T07:00:00+09:00"}]"#;
        let parsed: Vec<SchedulerSchedule> = serde_json::from_str(legacy).unwrap();
        assert_eq!(parsed.len(), 1);
        assert!(parsed[0].agent_id.is_none());
        assert_eq!(parsed[0].prompt, "extract-tasks");
        // Round-trips without inventing an agentId key.
        let written = serde_json::to_string(&parsed).unwrap();
        assert!(!written.contains("agentId"), "{written}");
    }

    fn gap_entry(at: &str, added: usize, removed: usize, by_type: GapTypeCounts) -> GapLogEntry {
        GapLogEntry {
            at: at.to_string(),
            draft_id: "draft-fb".to_string(),
            promoted_to: "notes/fb.md".to_string(),
            added_lines: added,
            removed_lines: removed,
            by_type,
            hunk_count: 0,
            baseline_hash: None,
            baseline_lines: None,
            draft_kind: None,
            generated_by: None,
        }
    }

    fn write_gap_log(work: &Path, entries: &[GapLogEntry]) {
        fs::create_dir_all(work.join(".maru")).unwrap();
        let mut body = String::new();
        for entry in entries {
            body.push_str(&serde_json::to_string(entry).unwrap());
            body.push('\n');
        }
        fs::write(work.join(".maru").join("gap-log.jsonl"), body).unwrap();
    }

    #[test]
    fn dispatch_prompt_leaves_non_inbox_process_prompts_untouched() {
        let temp = TempDir::new().unwrap();
        let baked = format!("Run it\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        let schedule = SchedulerSchedule {
            prompt: baked.clone(),
            ..sample_schedule(None, true) // skill_id "vault-sync"
        };
        assert_eq!(
            build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt),
            baked
        );
    }

    #[test]
    fn dispatch_prompt_strips_stale_section_and_attaches_one_fresh_digest() {
        let temp = TempDir::new().unwrap();
        write_gap_log(
            temp.path(),
            &[gap_entry(
                "2026-07-30T09:00:00",
                3,
                1,
                GapTypeCounts {
                    external_info: 2,
                    direct_edit: 1,
                    ..GapTypeCounts::default()
                },
            )],
        );
        let legacy = format!("do stuff\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        let prompt = {
            let schedule = inbox_schedule(&legacy);
            build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt)
        };
        assert!(!prompt.contains("stale digest"), "{prompt}");
        assert_eq!(
            prompt.matches(GAP_FEEDBACK_SECTION_HEADER).count(),
            1,
            "exactly one fresh section: {prompt}"
        );
        assert!(prompt.contains("최근 초안 1건"), "{prompt}");
    }

    #[test]
    fn dispatch_prompt_appends_fresh_digest_to_a_clean_prompt() {
        let temp = TempDir::new().unwrap();
        write_gap_log(
            temp.path(),
            &[gap_entry(
                "2026-07-30T09:00:00",
                3,
                1,
                GapTypeCounts {
                    external_info: 2,
                    direct_edit: 1,
                    ..GapTypeCounts::default()
                },
            )],
        );
        let schedule = inbox_schedule("do stuff");
        let prompt = build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt);
        assert_eq!(
            prompt,
            format!(
                "do stuff\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\n\
                 최근 초안 1건의 수정 분석: 추가 3줄, 삭제 1줄 \
                 (외부 정보 2건, 직접 수정 1건, 교차 참조 0건, 서식 0건)\n\
                 가장 잦은 수정 유형은 외부 정보 추가: \
                 초안에 출처·수치·날짜 등 근거 정보를 더 포함할 것"
            ),
        );
    }

    #[test]
    fn dispatch_prompt_without_log_returns_stripped_bare_prompt() {
        let temp = TempDir::new().unwrap(); // no gap log at all
        let legacy = format!("do stuff\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        let prompt = {
            let schedule = inbox_schedule(&legacy);
            build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt)
        };
        assert_eq!(prompt, "do stuff");
    }

    #[test]
    fn dispatch_prompt_keeps_original_when_strip_would_leave_nothing() {
        let temp = TempDir::new().unwrap(); // no gap log -> no fresh digest
                                            // A legacy schedule whose stored prompt was ONLY the baked-in digest
                                            // section: stripping must not produce an empty dispatch prompt.
        let only_digest = format!("{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        let prompt = {
            let schedule = inbox_schedule(&only_digest);
            build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt)
        };
        assert_eq!(prompt, only_digest);
    }

    #[test]
    fn dispatch_prompt_ignores_imported_skills_with_inbox_process_in_the_id() {
        let temp = TempDir::new().unwrap();
        let baked = format!("Run it\n\n{GAP_FEEDBACK_SECTION_HEADER}\n\nstale digest");
        let schedule = SchedulerSchedule {
            skill_id: "my-import::inbox-process".to_string(),
            prompt: baked.clone(),
            ..sample_schedule(None, true)
        };
        assert_eq!(
            build_dispatch_prompt(temp.path(), &schedule.skill_id, &schedule.prompt),
            baked
        );
    }
}

#[cfg(test)]
type Phase08Executor =
    std::sync::Arc<dyn Fn(&Path, &SchedulerSchedule) -> Result<String, String> + Send + Sync>;
#[cfg(test)]
static PHASE08_15_EXECUTOR: Mutex<Option<Phase08Executor>> = Mutex::new(None);

#[cfg(test)]
mod phase08_15 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    type TestApp = AppHandle<tauri::test::MockRuntime>;

    struct Executor;
    impl Executor {
        fn new(
            callback: impl Fn(&Path, &SchedulerSchedule) -> Result<String, String>
                + Send
                + Sync
                + 'static,
        ) -> Self {
            *PHASE08_15_EXECUTOR.lock().unwrap() = Some(Arc::new(callback));
            Self
        }
        fn success() -> Self {
            Self::new(|_, schedule| {
                // An existing exact harmless program. No shell, agent/provider or daemon.
                let executable = std::env::current_exe().unwrap();
                assert!(executable.is_file());
                let output = std::process::Command::new(&executable)
                    .args([
                        "--exact",
                        "scheduler::phase08_15::phase08_15_scheduler_harmless_child",
                        "--nocapture",
                    ])
                    .env("MARU_PHASE08_15_SCHEDULER_CHILD", "1")
                    .output()
                    .unwrap();
                assert!(output.status.success());
                Ok(format!("fixture-run-{}", schedule.id))
            })
        }
    }
    impl Drop for Executor {
        fn drop(&mut self) {
            *PHASE08_15_EXECUTOR.lock().unwrap() = None;
        }
    }
    #[test]
    fn phase08_15_scheduler_harmless_child() {
        // Also safe when included in the ordinary suite; never takes the shared Home lock.
        if std::env::var_os("MARU_PHASE08_15_SCHEDULER_CHILD").is_some() {
            assert!(Path::new(&std::env::var_os("MARU_TEST_HOME").unwrap()).is_dir());
            println!("fixture scheduler child completed");
        }
    }
    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(ApprovalState::default());
        app
    }
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn input(name: &str) -> SchedulerScheduleInput {
        SchedulerScheduleInput {
            name: name.into(),
            skill_id: "fixture-skill".into(),
            runtime: "claude".into(),
            prompt: "Fixture only".into(),
            hour: 9,
            minute: 30,
            days_of_week: vec![],
            enabled: true,
            agent_id: None,
        }
    }
    fn approval(app: &TestApp) -> Option<String> {
        let request = crate::approval::prepare_approval(
            app.state(),
            SCHEDULER_ADD_KIND.into(),
            "Fixture schedule".into(),
            None,
            None,
        )
        .unwrap();
        crate::approval::record_approval(
            app.state(),
            request.id.clone(),
            crate::approval::ApprovalDecision::Approved,
            None,
        )
        .unwrap();
        Some(request.id)
    }
    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(8))
            .expect("scheduler command completed")
    }
    fn fixture(home: &Home) -> PathBuf {
        let work = home.root.path().join("workspace");
        fs::create_dir_all(work.join(".maru")).unwrap();
        work
    }
    fn due(work: &Path) -> SchedulerSchedule {
        let mut schedule = add_impl(&text(work), input("due")).unwrap();
        schedule.next_run_at = Some("2000-01-01T00:00:00+00:00".into());
        save_schedules(work, &[schedule.clone()]).unwrap();
        schedule
    }

    #[test]
    fn phase08_15_scheduler_every_wrapper_yields_and_preserves_join_error() {
        let home = Home::new();
        let work = fixture(&home);
        let app = app();
        boundary(
            work.clone(),
            "scheduler_list",
            ipc::scheduler_list(text(&work)),
        );
        boundary(
            work.clone(),
            "scheduler_add",
            ipc::scheduler_add(app.handle().clone(), text(&work), input("x"), None),
        );
        boundary(
            work.clone(),
            "scheduler_remove",
            ipc::scheduler_remove(app.handle().clone(), text(&work), "id".into()),
        );
        boundary(
            work.clone(),
            "scheduler_set_enabled",
            ipc::scheduler_set_enabled(app.handle().clone(), text(&work), "id".into(), false),
        );
        boundary(
            work.clone(),
            "scheduler_run_now",
            ipc::scheduler_run_now(app.handle().clone(), text(&work), "id".into()),
        );
    }

    #[test]
    fn phase08_15_scheduler_actual_wrappers_results_errors_and_fake_runner() {
        let home = Home::new();
        let work = fixture(&home);
        let app = app();
        let _executor = Executor::success();
        assert_eq!(
            run(ipc::scheduler_add(
                app.handle().clone(),
                text(&work),
                input("x"),
                None
            ))
            .unwrap_err(),
            "approval_required: scheduler.add"
        );
        let id = approval(app.handle());
        let schedule = run(ipc::scheduler_add(
            app.handle().clone(),
            text(&work),
            input("actual"),
            id,
        ))
        .unwrap();
        assert_eq!(
            run(ipc::scheduler_list(text(&work))).unwrap(),
            vec![schedule.clone()]
        );
        assert_eq!(
            run(ipc::scheduler_remove(
                app.handle().clone(),
                text(&work),
                "..".into()
            ))
            .unwrap_err(),
            "scheduler_invalid_id"
        );
        assert_eq!(
            run(ipc::scheduler_set_enabled(
                app.handle().clone(),
                text(&work),
                "missing".into(),
                true
            ))
            .unwrap_err(),
            "scheduler_not_found"
        );
        let disabled = run(ipc::scheduler_set_enabled(
            app.handle().clone(),
            text(&work),
            schedule.id.clone(),
            false,
        ))
        .unwrap();
        assert!(!disabled.enabled);
        assert!(run(ipc::scheduler_run_now(
            app.handle().clone(),
            text(&work),
            schedule.id.clone()
        ))
        .unwrap()
        .starts_with("fixture-run-"));
        assert!(!load_schedules(&work).unwrap()[0].enabled); // Explicit manual run on disabled retains old policy.
        run(ipc::scheduler_remove(
            app.handle().clone(),
            text(&work),
            schedule.id.clone(),
        ))
        .unwrap();
        assert_eq!(
            run(ipc::scheduler_run_now(
                app.handle().clone(),
                text(&work),
                schedule.id
            ))
            .unwrap_err(),
            "scheduler_not_found"
        );
        assert!(load_schedules(&work).unwrap().is_empty());
    }

    #[test]
    fn phase08_15_scheduler_mutations_same_target_and_error_unwind_release() {
        let home = Home::new();
        let work = fixture(&home);
        let app = app();
        let schedule = add_impl(&text(&work), input("a")).unwrap();
        let held = Held::new(work.join(".maru"), "admitted");
        let first = start(ipc::scheduler_set_enabled(
            app.handle().clone(),
            text(&work),
            schedule.id.clone(),
            false,
        ));
        held.wait();
        let wait = Held::new(work.join(".maru"), "before-admission");
        let approval = approval(app.handle());
        let second = start(ipc::scheduler_add(
            app.handle().clone(),
            text(&work),
            input("sibling"),
            approval,
        ));
        wait.wait();
        wait.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        done(second).unwrap();
        let current = load_schedules(&work).unwrap();
        assert_eq!(current.len(), 2);
        assert!(!current[0].enabled);
        assert_eq!(
            run(ipc::scheduler_remove(
                app.handle().clone(),
                text(&work),
                "missing".into()
            ))
            .unwrap_err(),
            "scheduler_not_found"
        );
        let panic = PathTransactionTestHook::new(work.join(".maru"), "pre-effect", || {
            panic!("fixture schedule unwind")
        });
        assert!(run(ipc::scheduler_remove(
            app.handle().clone(),
            text(&work),
            schedule.id.clone()
        ))
        .unwrap_err()
        .starts_with("scheduler_remove_task_failed:"));
        drop(panic);
        run(ipc::scheduler_remove(
            app.handle().clone(),
            text(&work),
            schedule.id,
        ))
        .unwrap();
        assert_eq!(load_schedules(&work).unwrap().len(), 1);
    }

    #[test]
    fn phase08_15_scheduler_accepted_run_remove_disable_siblings_and_duplicate_claim() {
        for remove in [false, true] {
            let home = Home::new();
            let work = fixture(&home);
            let app = app();
            let schedule = due(&work);
            let (entered_tx, entered_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel();
            let release_rx = Mutex::new(release_rx);
            let _executor = Executor::new(move |_, _| {
                entered_tx.send(()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                Ok("accepted-fixture".into())
            });
            let first = start(ipc::scheduler_run_now(
                app.handle().clone(),
                text(&work),
                schedule.id.clone(),
            ));
            entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(
                run(ipc::scheduler_run_now(
                    app.handle().clone(),
                    text(&work),
                    schedule.id.clone()
                ))
                .unwrap_err(),
                "scheduler_busy"
            );
            // Existing timer sees active reservation and cannot double dispatch.
            run_due_for_workspace(app.handle(), &work, Local::now()).unwrap();
            if remove {
                run(ipc::scheduler_remove(
                    app.handle().clone(),
                    text(&work),
                    schedule.id.clone(),
                ))
                .unwrap();
            } else {
                run(ipc::scheduler_set_enabled(
                    app.handle().clone(),
                    text(&work),
                    schedule.id.clone(),
                    false,
                ))
                .unwrap();
            }
            let sibling = add_impl(&text(&work), input("sibling")).unwrap();
            release_tx.send(()).unwrap();
            assert_eq!(done(first).unwrap(), "accepted-fixture");
            let current = load_schedules(&work).unwrap();
            assert!(current.contains(&sibling));
            if remove {
                assert_eq!(current, vec![sibling]);
            } else {
                let old = current.iter().find(|v| v.id == schedule.id).unwrap();
                assert!(!old.enabled);
                assert_eq!(old.last_run_at, None);
            }
            assert!(IN_FLIGHT.lock().unwrap().is_empty());
        }
    }

    #[test]
    fn phase08_15_scheduler_timer_disable_remove_claim_failure_and_day_semantics() {
        let home = Home::new();
        let work = fixture(&home);
        let app = app();
        let schedule = due(&work);
        let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let _executor = Executor::new(move |_, _| {
            count.fetch_add(1, Ordering::SeqCst);
            Err("fixture_launch_failed".into())
        });
        set_enabled_impl(&text(&work), &schedule.id, false).unwrap();
        run_due_for_workspace(app.handle(), &work, Local::now()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        set_enabled_impl(&text(&work), &schedule.id, true).unwrap();
        run_due_for_workspace(app.handle(), &work, Local::now()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        run_due_for_workspace(app.handle(), &work, Local::now()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        // Explicit manual failure releases only its active ownership, leaves scheduled next-run unchanged.
        let before = load_schedules(&work).unwrap();
        assert_eq!(
            run(ipc::scheduler_run_now(
                app.handle().clone(),
                text(&work),
                schedule.id.clone()
            ))
            .unwrap_err(),
            "fixture_launch_failed"
        );
        assert_eq!(load_schedules(&work).unwrap(), before);
        assert!(IN_FLIGHT.lock().unwrap().is_empty());
        assert!(LAST_FIRED
            .lock()
            .unwrap()
            .get(&(work.clone(), schedule.id.clone()))
            .is_none());
        remove_impl(&text(&work), &schedule.id).unwrap();
        run_due_for_workspace(app.handle(), &work, Local::now()).unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 2);
    }

    #[test]
    fn phase08_15_scheduler_dispatch_and_settlement_keep_original_workspace_and_maru() {
        for maru in [false, true] {
            for after_launch in [false, true] {
                let home = Home::new();
                let work = fixture(&home);
                let app = app();
                let schedule = due(&work);
                let parent = if maru {
                    work.join(".maru")
                } else {
                    work.clone()
                };
                let moved = home.root.path().join("moved");
                let work_copy = work.clone();
                let parent_copy = parent.clone();
                let moved_copy = moved.clone();
                let _executor = if after_launch {
                    Executor::new(move |_, _| {
                        fs::rename(&parent_copy, &moved_copy).unwrap();
                        fs::create_dir_all(work_copy.join(".maru")).unwrap();
                        fs::write(schedules_path(&work_copy), "[]").unwrap();
                        Ok("already-started".into())
                    })
                } else {
                    Executor::success()
                };
                let held = (!after_launch).then(|| Held::new(work.clone(), "scheduler:dispatch"));
                let result = start(ipc::scheduler_run_now(
                    app.handle().clone(),
                    text(&work),
                    schedule.id,
                ));
                if let Some(held) = &held {
                    held.wait();
                    fs::rename(&parent, &moved).unwrap();
                    fs::create_dir_all(work.join(".maru")).unwrap();
                    fs::write(schedules_path(&work), "[]").unwrap();
                    held.release();
                }
                let result = done(result);
                if after_launch {
                    assert_eq!(result.unwrap(), "already-started");
                } else {
                    assert!(result.is_err());
                }
                assert_eq!(fs::read_to_string(schedules_path(&work)).unwrap(), "[]");
                assert!(IN_FLIGHT.lock().unwrap().is_empty());
            }
        }
    }

    #[test]
    fn phase08_15_scheduler_files_parent_and_document_both_orders_aliases() {
        for alias in [false, true] {
            for scheduler_first in [false, true] {
                let home = Home::new();
                let root = home.root.path();
                let work = fixture(&home);
                let app = app();
                let selected = if alias {
                    #[cfg(unix)]
                    {
                        let link = root.join("alias");
                        std::os::unix::fs::symlink(&work, &link).unwrap();
                        link
                    }
                    #[cfg(not(unix))]
                    {
                        work.clone()
                    }
                } else {
                    work.clone()
                };
                let schedule = add_impl(&text(&selected), input("parent")).unwrap();
                let held = Held::new(
                    if scheduler_first {
                        selected.join(".maru")
                    } else {
                        work.clone()
                    },
                    "admitted",
                );
                if scheduler_first {
                    let first = start(ipc::scheduler_set_enabled(
                        app.handle().clone(),
                        text(&selected),
                        schedule.id.clone(),
                        false,
                    ));
                    held.wait();
                    let wait = Held::new(work.clone(), "before-admission");
                    let second = start(crate::workspace_files::ipc::rename_workspace_entry(
                        text(root),
                        "workspace".into(),
                        "renamed".into(),
                    ));
                    wait.wait();
                    wait.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                    assert!(!load_schedules(&root.join("renamed")).unwrap()[0].enabled);
                } else {
                    let first = start(crate::workspace_files::ipc::rename_workspace_entry(
                        text(root),
                        "workspace".into(),
                        "renamed".into(),
                    ));
                    held.wait();
                    let wait = Held::new(selected.join(".maru"), "before-admission");
                    let second = start(ipc::scheduler_set_enabled(
                        app.handle().clone(),
                        text(&selected),
                        schedule.id,
                        false,
                    ));
                    wait.wait();
                    wait.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert!(done(second).is_err());
                    assert!(!work.exists());
                }
            }
        }
        for scheduler_first in [false, true] {
            let home = Home::new();
            let work = fixture(&home);
            let app = app();
            let schedule = add_impl(&text(&work), input("document")).unwrap();
            let held = Held::new(
                if scheduler_first {
                    work.join(".maru")
                } else {
                    schedules_path(&work)
                },
                "admitted",
            );
            if scheduler_first {
                let first = start(ipc::scheduler_set_enabled(
                    app.handle().clone(),
                    text(&work),
                    schedule.id.clone(),
                    false,
                ));
                held.wait();
                let wait = Held::new(schedules_path(&work), "before-admission");
                let second = start(crate::document::ipc::save_document(
                    text(&work),
                    ".maru/schedules.json".into(),
                    "[]".into(),
                    None,
                ));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                assert!(load_schedules(&work).unwrap().is_empty());
            } else {
                let first = start(crate::document::ipc::save_document(
                    text(&work),
                    ".maru/schedules.json".into(),
                    "[]".into(),
                    None,
                ));
                held.wait();
                let wait = Held::new(work.join(".maru"), "before-admission");
                let second = start(ipc::scheduler_set_enabled(
                    app.handle().clone(),
                    text(&work),
                    schedule.id,
                    false,
                ));
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                assert_eq!(done(second).unwrap_err(), "scheduler_not_found");
            }
        }
    }
}
