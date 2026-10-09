use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::atomic_file::{
    with_path_transactions, PathTransactionLease, PathTransactionParent, PathTransactionRequest,
};
use crate::win_process::NoWindow;

#[path = "job_receipts.rs"]
mod receipts;

pub const JOBS_SCHEMA: u32 = 1;
pub const JOB_LABEL_PREFIX: &str = "com.maru.job.";
const LOG_TAIL_LINES: usize = 200;

// D-03: JOBS_LOCK serializes writers of `.maru/jobs.json`; the guarded data
// lives on disk and is re-read after acquisition (see `load_jobs`), so the
// in-memory unit carries no invariant and recovering the guard cannot serve
// tainted state.
static JOBS_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobsFile {
    pub schema: u32,
    #[serde(default)]
    pub jobs: Vec<JobRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRecord {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    pub program: JobProgram,
    pub schedule: JobSchedule,
    pub logs: JobLogs,
}

fn default_enabled() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobProgram {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: BTreeMap<String, String>,
}

/// How `recovery_interval_seconds` is applied.
///
/// `Repeat` (default): plain `StartInterval` on the job's own plist — the job
/// re-runs every N seconds regardless of whether the calendar fire happened.
/// `MissedFire`: the calendar cadence is preserved; a separate guard agent
/// (`com.maru.job.guard.<id>.*`, `StartInterval` + `RunAtLoad`) re-invokes the
/// job only when neither a success nor the first-install baseline covers the
/// most recent scheduled fire — i.e. a fire missed while the Mac was asleep or
/// powered off.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RecoveryMode {
    #[default]
    Repeat,
    MissedFire,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobSchedule {
    pub hour: u32,
    pub minute: u32,
    #[serde(default)]
    pub recovery_interval_seconds: u64,
    #[serde(default)]
    pub recovery_mode: RecoveryMode,
    #[serde(default)]
    pub run_at_load: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogs {
    pub dir: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobStatus {
    pub id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub installed: bool,
    pub loaded: bool,
    pub enabled: bool,
    pub plist_path: String,
    pub label: String,
    pub schedule: JobSchedule,
    pub last_exit_code: Option<i64>,
    pub last_run_at: Option<String>,
    pub receipts: Vec<receipts::JobRunReceipt>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogsTail {
    pub stdout: String,
    pub stderr: String,
}

fn jobs_guard() -> Result<MutexGuard<'static, ()>, String> {
    // D-03: the guarded jobs.json state is re-read from disk after
    // acquisition, so recovering a poisoned guard is safe (see the
    // JOBS_LOCK declaration).
    Ok(crate::lock_recovery::recover_guard(
        JOBS_LOCK.get_or_init(|| Mutex::new(())).lock(),
        "jobs",
        "JOBS_LOCK",
    ))
}

fn jobs_file_path(work_path: &Path) -> PathBuf {
    work_path.join(".maru").join("jobs.json")
}

pub fn load_jobs(work_path: &Path) -> Result<JobsFile, String> {
    let path = jobs_file_path(work_path);
    if !path.exists() {
        return Ok(JobsFile {
            schema: JOBS_SCHEMA,
            jobs: Vec::new(),
        });
    }
    let content = fs::read_to_string(&path)
        .map_err(|err| format!("jobs_read_failed: {}: {err}", path.to_string_lossy()))?;
    let file: JobsFile = serde_json::from_str(&content)
        .map_err(|err| format!("jobs_parse_failed: {}: {err}", path.to_string_lossy()))?;
    if file.schema > JOBS_SCHEMA {
        return Err(format!(
            "jobs_schema_unsupported: {} > {JOBS_SCHEMA}",
            file.schema
        ));
    }
    let mut seen = std::collections::HashSet::new();
    for job in &file.jobs {
        validate_job_id(&job.id)?;
        if !seen.insert(job.id.as_str()) {
            return Err(format!("job_id_duplicate: {}", job.id));
        }
        if job.schedule.hour > 23 || job.schedule.minute > 59 {
            return Err(format!(
                "job_schedule_invalid: {}: hour {} minute {} (expected 0-23 / 0-59)",
                job.id, job.schedule.hour, job.schedule.minute
            ));
        }
        if job.schedule.recovery_mode == RecoveryMode::MissedFire
            && job.schedule.recovery_interval_seconds == 0
        {
            return Err(format!(
                "job_schedule_invalid: {}: missedFire recovery needs recoveryIntervalSeconds > 0",
                job.id
            ));
        }
    }
    Ok(file)
}

fn validate_job_id(id: &str) -> Result<(), String> {
    let valid = !id.is_empty()
        && id
            .chars()
            .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-');
    if valid {
        Ok(())
    } else {
        Err(format!("job_id_invalid: {id} (expected [a-z0-9-]+)"))
    }
}

fn find_job<'a>(jobs: &'a JobsFile, job_id: &str) -> Result<&'a JobRecord, String> {
    jobs.jobs
        .iter()
        .find(|job| job.id == job_id)
        .ok_or_else(|| format!("job_not_found: {job_id}"))
}

/// Stable per-workspace label: two registered workspaces running the same job
/// id must not fight over one launchd label.
pub fn label_for(job_id: &str, work_path: &Path) -> Result<String, String> {
    validate_job_id(job_id)?;
    let canonical = canonical_work_path(work_path)?;
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hex: String = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!("{JOB_LABEL_PREFIX}{job_id}.{hex}"))
}

/// Label of the missed-fire guard agent paired with a job. Only rendered and
/// installed when the job opts into `RecoveryMode::MissedFire`.
fn guard_label_for(job_id: &str, work_path: &Path) -> Result<String, String> {
    validate_job_id(job_id)?;
    let canonical = canonical_work_path(work_path)?;
    let digest = Sha256::digest(canonical.to_string_lossy().as_bytes());
    let hex: String = digest[..4]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    Ok(format!("{JOB_LABEL_PREFIX}guard.{job_id}.{hex}"))
}

/// argv the plist invokes for a missed-fire job: the current binary drives the
/// run so the engine can record successes and gate recovery fires. The leading
/// `--maru-cli` selects CLI dispatch in the desktop binary and is skipped by
/// the standalone CLI's `run_cli`.
fn exec_wrapper_arguments(job: &JobRecord, if_missed: bool) -> Result<Vec<String>, String> {
    let exe = std::env::current_exe().map_err(|err| format!("current_exe_failed: {err}"))?;
    let exe = stable_invoked_executable(&exe, std::env::args_os().next().as_deref());
    let mut argv = vec![
        exe.to_string_lossy().to_string(),
        "--maru-cli".to_string(),
        "jobs".to_string(),
        "exec".to_string(),
    ];
    if if_missed {
        argv.push("--if-missed".to_string());
    }
    argv.push(job.id.clone());
    Ok(argv)
}

/// Preserve a stable caller-facing path (for example `/opt/homebrew/bin/maru`)
/// when it resolves to this process, while refusing ambient PATH lookup or an
/// unrelated executable that happens to be argv[0].
fn stable_invoked_executable(current_exe: &Path, argv0: Option<&OsStr>) -> PathBuf {
    let Some(candidate) = argv0.map(PathBuf::from).filter(|path| path.is_absolute()) else {
        return current_exe.to_path_buf();
    };
    match (fs::canonicalize(current_exe), fs::canonicalize(&candidate)) {
        (Ok(actual), Ok(invoked)) if actual == invoked => candidate,
        _ => current_exe.to_path_buf(),
    }
}

fn canonical_work_path(work_path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(work_path)
        .map_err(|err| format!("work_path_missing: {}: {err}", work_path.to_string_lossy()))
}

/// Expand a leading `~` / `~/` against the user's home directory.
fn expand_tilde(value: &str) -> String {
    if value == "~" || value.starts_with("~/") {
        if let Ok(home) = crate::skill_host::fs::install_root_base() {
            let rest = value.trim_start_matches('~').trim_start_matches('/');
            return if rest.is_empty() {
                home.to_string_lossy().to_string()
            } else {
                home.join(rest).to_string_lossy().to_string()
            };
        }
    }
    value.to_string()
}

/// Expand every `:`-separated segment of an env value with `expand_tilde`.
/// Env values such as PATH are colon-joined path lists; a leading-only
/// expansion leaves later tildes literal and they land in the plist as-is.
/// Segment-wise expansion is safe for non-path values: `expand_tilde` only
/// rewrites a segment that is exactly `~` or starts with `~/`, so URLs
/// (`https://host/x`) and times (`12:30`) pass through byte-identical.
fn expand_tilde_segments(value: &str) -> String {
    value
        .split(':')
        .map(expand_tilde)
        .collect::<Vec<_>>()
        .join(":")
}

/// Resolve a job-declared path: expand `~`, then anchor relative paths at the
/// workspace root.
fn resolve_job_path(work_path: &Path, value: &str) -> String {
    let expanded = expand_tilde(value);
    let path = PathBuf::from(&expanded);
    if path.is_absolute() {
        expanded
    } else {
        work_path.join(path).to_string_lossy().to_string()
    }
}

/// Resolve a program argument: `~` always expands, and values that look like
/// paths (contain `/` or start with `.`) anchor at the workspace root. Bare
/// tokens such as subcommand names (`run`) pass through unchanged, as do
/// flags (`--config=x/y`) and URLs — the job runs with WorkingDirectory set
/// to the workspace, so unresolved relative values still land correctly.
fn resolve_job_arg(work_path: &Path, value: &str) -> String {
    if value.starts_with('-') || value.contains("://") {
        return expand_tilde(value);
    }
    if value.contains('/') || value.starts_with('.') {
        resolve_job_path(work_path, value)
    } else {
        expand_tilde(value)
    }
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Render the launchd plist XML for a job. Written by hand because the dict
/// shape is small and fixed, and no plist crate is currently a dependency.
pub fn plist_for(job: &JobRecord, work_path: &Path) -> Result<String, String> {
    let label = label_for(&job.id, work_path)?;
    let argv = exec_wrapper_arguments(job, false)?;
    render_plist(
        job,
        work_path,
        &label,
        &argv,
        job.schedule.run_at_load,
        Some((job.schedule.hour, job.schedule.minute)),
        // A MissedFire job's interval lives on the guard agent only: rendering
        // it here too would re-run the job every interval regardless of the
        // calendar fire. For Repeat, launchd rejects StartInterval <= 0, so
        // the key is omitted when the job declares no recovery interval (the
        // serde default is 0).
        if job.schedule.recovery_mode == RecoveryMode::MissedFire {
            None
        } else if job.schedule.recovery_interval_seconds > 0 {
            Some(job.schedule.recovery_interval_seconds)
        } else {
            None
        },
    )
}

/// Plist of the missed-fire guard agent: interval-only (no calendar entry),
/// `RunAtLoad` so a boot or login through a missed fire recovers immediately.
/// The guard is cheap — it exits without invoking the job when the last
/// recorded success covers the most recent scheduled fire — so firing it at
/// every load is safe.
fn guard_plist_for(job: &JobRecord, work_path: &Path) -> Result<String, String> {
    let label = guard_label_for(&job.id, work_path)?;
    let argv = exec_wrapper_arguments(job, true)?;
    render_plist(
        job,
        work_path,
        &label,
        &argv,
        true,
        None,
        Some(job.schedule.recovery_interval_seconds),
    )
}

#[allow(clippy::too_many_arguments)]
fn render_plist(
    job: &JobRecord,
    work_path: &Path,
    label: &str,
    argv: &[String],
    run_at_load: bool,
    calendar: Option<(u32, u32)>,
    start_interval_seconds: Option<u64>,
) -> Result<String, String> {
    let logs_dir = resolve_job_path(work_path, &job.logs.dir);
    let stdout_path = format!("{logs_dir}/stdout.log");
    let stderr_path = format!("{logs_dir}/stderr.log");
    let work_dir = work_path.to_string_lossy().to_string();
    let workspace_config = work_path
        .join("workspace.config.yaml")
        .to_string_lossy()
        .to_string();
    let home = crate::skill_host::fs::install_root_base()?
        .to_string_lossy()
        .to_string();

    let mut program_arguments = String::new();
    for arg in argv {
        program_arguments.push_str(&format!("    <string>{}</string>\n", xml_escape(arg)));
    }

    let mut environment = String::new();
    environment.push_str(&format!(
        "      <key>HOME</key>\n      <string>{}</string>\n",
        xml_escape(&home)
    ));
    for (key, value) in &job.program.env {
        environment.push_str(&format!(
            "      <key>{}</key>\n      <string>{}</string>\n",
            xml_escape(key),
            xml_escape(&expand_tilde_segments(value))
        ));
    }
    environment.push_str(&format!(
        "      <key>WORKSPACE_CONFIG</key>\n      <string>{}</string>\n",
        xml_escape(&workspace_config)
    ));

    let calendar_interval = match calendar {
        Some((hour, minute)) => format!(
            "  <key>StartCalendarInterval</key>\n  <dict>\n    <key>Hour</key>\n    <integer>{hour}</integer>\n    <key>Minute</key>\n    <integer>{minute}</integer>\n  </dict>\n"
        ),
        None => String::new(),
    };
    let start_interval = match start_interval_seconds {
        Some(seconds) => format!("  <key>StartInterval</key>\n  <integer>{seconds}</integer>\n"),
        None => String::new(),
    };

    Ok(format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>{label}</string>
  <key>ProgramArguments</key>
  <array>
{program_arguments}  </array>
  <key>WorkingDirectory</key>
  <string>{work_dir}</string>
  <key>RunAtLoad</key>
  <{run_at_load}/>
{calendar_interval}{start_interval}  <key>ProcessType</key>
  <string>Background</string>
  <key>Nice</key>
  <integer>10</integer>
  <key>ThrottleInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>{stdout_path}</string>
  <key>StandardErrorPath</key>
  <string>{stderr_path}</string>
  <key>EnvironmentVariables</key>
  <dict>
{environment}  </dict>
</dict>
</plist>
"#,
        label = xml_escape(label),
        program_arguments = program_arguments,
        work_dir = xml_escape(&work_dir),
        run_at_load = if run_at_load { "true" } else { "false" },
        calendar_interval = calendar_interval,
        start_interval = start_interval,
        stdout_path = xml_escape(&stdout_path),
        stderr_path = xml_escape(&stderr_path),
        environment = environment,
    ))
}

// === Missed-fire recovery: exec wrapper, success signal, staleness ===

fn jobs_state_dir(work_path: &Path) -> PathBuf {
    work_path.join(".maru").join("jobs-state")
}

fn job_state_path(work_path: &Path, job_id: &str) -> PathBuf {
    jobs_state_dir(work_path).join(format!("{job_id}.json"))
}

fn job_run_lock_path(work_path: &Path, job_id: &str) -> PathBuf {
    jobs_state_dir(work_path).join(format!("{job_id}.run.lock"))
}

fn job_state_lock_path(work_path: &Path, job_id: &str) -> PathBuf {
    jobs_state_dir(work_path).join(format!("{job_id}.state.lock"))
}

fn lock_job_state(work_path: &Path, job_id: &str) -> Result<fs::File, String> {
    let state_dir = jobs_state_dir(work_path);
    fs::create_dir_all(&state_dir).map_err(|err| {
        format!(
            "job_state_dir_failed: {}: {err}",
            state_dir.to_string_lossy()
        )
    })?;
    let lock_path = job_state_lock_path(work_path, job_id);
    let file = fs::File::create(&lock_path)
        .map_err(|err| format!("job_state_lock_failed: {}: {err}", lock_path.display()))?;
    file.lock()
        .map_err(|err| format!("job_state_lock_failed: {err}"))?;
    Ok(file)
}

fn manual_requests_dir(work_path: &Path, job_id: &str) -> PathBuf {
    jobs_state_dir(work_path).join(format!("{job_id}.manual-requests"))
}

fn manual_requests_lock_path(work_path: &Path, job_id: &str) -> PathBuf {
    jobs_state_dir(work_path).join(format!("{job_id}.manual-requests.lock"))
}

fn lock_manual_requests(work_path: &Path, job_id: &str) -> Result<fs::File, String> {
    let state_dir = jobs_state_dir(work_path);
    fs::create_dir_all(&state_dir).map_err(|err| {
        format!(
            "job_state_dir_failed: {}: {err}",
            state_dir.to_string_lossy()
        )
    })?;
    let lock_path = manual_requests_lock_path(work_path, job_id);
    let file = fs::File::create(&lock_path)
        .map_err(|err| format!("manual_request_lock_failed: {}: {err}", lock_path.display()))?;
    file.lock()
        .map_err(|err| format!("manual_request_lock_failed: {err}"))?;
    Ok(file)
}

fn manual_request_ids_unlocked(work_path: &Path, job_id: &str) -> Result<Vec<String>, String> {
    let dir = manual_requests_dir(work_path, job_id);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(format!(
                "manual_requests_read_failed: {}: {err}",
                dir.display()
            ))
        }
    };
    let mut ids = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| format!("manual_requests_read_failed: {err}"))?;
        if !entry
            .file_type()
            .map_err(|err| format!("manual_request_metadata_failed: {err}"))?
            .is_file()
        {
            continue;
        }
        let path = entry.path();
        if path.extension().and_then(OsStr::to_str) != Some("json") {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(OsStr::to_str) else {
            continue;
        };
        if uuid::Uuid::parse_str(stem).is_ok() {
            ids.push(stem.to_string());
        }
    }
    ids.sort();
    Ok(ids)
}

/// Publish a unique one-shot manual request without taking the job-run lock.
/// Distinct files ensure concurrent Run now calls cannot overwrite each other.
fn enqueue_manual_run_request(
    work_path: &Path,
    job_id: &str,
    manifest_enabled: bool,
) -> Result<String, String> {
    let _lock = lock_manual_requests(work_path, job_id)?;
    let _state_lock = lock_job_state(work_path, job_id)?;
    let state = read_job_state(&job_state_path(work_path, job_id));
    if !state.agent_enabled.unwrap_or(manifest_enabled) {
        return Err(format!("job_not_enabled: {job_id}"));
    }
    let request_id = uuid::Uuid::new_v4().simple().to_string();
    let path = manual_requests_dir(work_path, job_id).join(format!("{request_id}.json"));
    let request = serde_json::json!({ "nonce": request_id });
    let payload = serde_json::to_vec(&request)
        .map_err(|err| format!("manual_request_serialize_failed: {err}"))?;
    crate::atomic_file::write_atomic_create(&path, &payload)?;
    Ok(request_id)
}

fn peek_manual_run_request(work_path: &Path, job_id: &str) -> Result<Option<String>, String> {
    let _lock = lock_manual_requests(work_path, job_id)?;
    Ok(manual_request_ids_unlocked(work_path, job_id)?
        .into_iter()
        .next())
}

fn remove_manual_run_request(
    work_path: &Path,
    job_id: &str,
    request_id: &str,
) -> Result<(), String> {
    if uuid::Uuid::parse_str(request_id).is_err() {
        return Err("manual_request_id_invalid".to_string());
    }
    let _lock = lock_manual_requests(work_path, job_id)?;
    let path = manual_requests_dir(work_path, job_id).join(format!("{request_id}.json"));
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!(
            "manual_request_remove_failed: {}: {err}",
            path.display()
        )),
    }
}

fn clear_manual_run_requests(work_path: &Path, job_id: &str) -> Result<(), String> {
    let _lock = lock_manual_requests(work_path, job_id)?;
    let dir = manual_requests_dir(work_path, job_id);
    for request_id in manual_request_ids_unlocked(work_path, job_id)? {
        let path = dir.join(format!("{request_id}.json"));
        fs::remove_file(&path)
            .map_err(|err| format!("manual_request_remove_failed: {}: {err}", path.display()))?;
    }
    Ok(())
}

/// Engine-recorded run history for a missed-fire job. The wrapper rewrites it
/// after every run; the guard agent reads it to decide whether the most recent
/// scheduled fire still needs recovering.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobRunState {
    /// First install boundary, separate from a successful execution.
    #[serde(default)]
    pub install_baseline_at: Option<u64>,
    /// Current Start/Stop state. Missing means use the manifest install value.
    #[serde(default)]
    pub agent_enabled: Option<bool>,
    /// Local install provenance for cross-launcher Run now; not a signed attestation.
    #[serde(default)]
    pub wrapper_executable: Option<String>,
    #[serde(default)]
    pub wrapper_sha256: Option<String>,
    #[serde(default)]
    pub last_run_at: Option<u64>,
    #[serde(default)]
    pub last_exit_code: Option<i64>,
    /// Completion time, for status and diagnostics.
    #[serde(default)]
    pub last_success_at: Option<u64>,
    /// Scheduled daily fire handled by that success; prevents a long run from
    /// accidentally covering the next day's fire.
    #[serde(default)]
    pub last_success_fire_at: Option<u64>,
}

fn read_job_state(path: &Path) -> JobRunState {
    fs::read_to_string(path)
        .ok()
        .and_then(|content| serde_json::from_str(&content).ok())
        .unwrap_or_default()
}

fn now_epoch_seconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

/// Fire for the latest local date whose daily `hour:minute` has occurred.
/// An ambiguous fall-back time uses its first occurrence so both folds share
/// one logical daily fire. A nonexistent wall time is skipped for that date.
fn latest_fire_on_date<Tz: chrono::TimeZone>(
    timezone: &Tz,
    now: &chrono::DateTime<Tz>,
    date: chrono::NaiveDate,
    time: chrono::NaiveTime,
) -> Option<chrono::DateTime<Tz>> {
    use chrono::LocalResult;
    match timezone.from_local_datetime(&date.and_time(time)) {
        LocalResult::Single(value) => (value.timestamp() <= now.timestamp()).then_some(value),
        LocalResult::Ambiguous(first, second) => {
            let first = first.min(second);
            (first.timestamp() <= now.timestamp()).then_some(first)
        }
        // A nonexistent wall time has no launchd fire on that date.
        LocalResult::None => None,
    }
}

fn last_scheduled_fire<Tz: chrono::TimeZone>(
    timezone: &Tz,
    now: chrono::DateTime<Tz>,
    hour: u32,
    minute: u32,
) -> Option<chrono::DateTime<Tz>> {
    use chrono::NaiveTime;
    let time = NaiveTime::from_hms_opt(hour, minute, 0)?;
    let mut date = now.date_naive();
    // DST gaps can remove a scheduled wall time for one date. Look back up to
    // three local dates; if none resolves, the caller fails closed and skips.
    for _ in 0..3 {
        if let Some(fire) = latest_fire_on_date(timezone, &now, date, time) {
            return Some(fire);
        }
        date = date.pred_opt()?;
    }
    None
}

fn last_scheduled_fire_epoch(
    now: chrono::DateTime<chrono::Local>,
    hour: u32,
    minute: u32,
) -> Option<i64> {
    last_scheduled_fire(&chrono::Local, now, hour, minute).map(|fire| fire.timestamp())
}

/// A fire needs no recovery when it is covered by a success or first-install
/// baseline. With neither timestamp, the fire counts as due.
fn last_success_covers_fire(
    state: &JobRunState,
    now: chrono::DateTime<chrono::Local>,
    hour: u32,
    minute: u32,
) -> bool {
    let Some(fire) = last_scheduled_fire_epoch(now, hour, minute) else {
        // If the local calendar cannot produce a scheduled fire, fail closed
        // rather than starting the job on every guard interval.
        return true;
    };
    let baseline_covers = state
        .install_baseline_at
        .map(|baseline| baseline as i64 >= fire)
        .unwrap_or(false);
    let success_covers = match (state.last_success_at, state.last_success_fire_at) {
        (Some(completed_at), Some(success_fire)) => {
            completed_at >= success_fire && success_fire as i64 >= fire
        }
        _ => false,
    };
    baseline_covers || success_covers
}

/// Entry point behind the plist wrapper for missed-fire jobs. The plist's
/// EnvironmentVariables land on this process and are inherited by the child,
/// so the run sees exactly what a direct launchd invocation would see; child
/// output appends to the same log files a direct plist would write. With
/// `if_missed` (the guard agent), exits 0 without running when the recorded
/// success already covers the most recent scheduled fire.
pub fn jobs_exec_in(work_path: &Path, job_id: &str, if_missed: bool) -> i32 {
    match jobs_exec_result(work_path, job_id, if_missed) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("jobs_exec_failed: {err}");
            1
        }
    }
}

fn jobs_exec_result(work_path: &Path, job_id: &str, if_missed: bool) -> Result<i32, String> {
    crate::vault_list::assert_maru_can_write(
        &work_path.to_string_lossy(),
        crate::vault_list::WorkspaceWriteAction::Modify,
    )?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    // From here on, derive state paths only from the manifest-validated id.
    let job_id = job.id.as_str();
    let state_path = job_state_path(work_path, job_id);
    let state_dir = jobs_state_dir(work_path);
    fs::create_dir_all(&state_dir).map_err(|err| {
        format!(
            "job_state_dir_failed: {}: {err}",
            state_dir.to_string_lossy()
        )
    })?;
    // This lock spans the child run. State writers use a separate short lock,
    // so Stop can disable a job without waiting for a long-running child.
    let lock_path = job_run_lock_path(work_path, job_id);
    let lock_file = fs::File::create(&lock_path)
        .map_err(|err| format!("job_lock_failed: {}: {err}", lock_path.to_string_lossy()))?;
    if if_missed {
        match lock_file.try_lock() {
            Ok(()) => {}
            // A run is already in progress; it records the success this fire
            // would have produced.
            Err(std::fs::TryLockError::WouldBlock) => {
                record_skipped(work_path, job, "recovery", "skipped_active", None)?;
                return Ok(0);
            }
            Err(err) => return Err(format!("job_lock_failed: {err}")),
        }
    } else {
        lock_file
            .lock()
            .map_err(|err| format!("job_lock_failed: {err}"))?;
    }
    let manual_requests_enabled = !if_missed;
    let mut manual_request = if manual_requests_enabled {
        peek_manual_run_request(work_path, job_id)?
    } else {
        None
    };
    let explicit_force = manual_request.is_some();
    // Reconcile the exit-before-ledger crash boundary without launching providers.
    for mut receipt in receipts::history(work_path, job_id)?.into_iter().rev() {
        if receipt.process_outcome == "exited" && !receipt.ledger_recorded {
            let _state_lock = lock_job_state(work_path, job_id)?;
            let mut state = read_job_state(&state_path);
            if state.last_run_at.unwrap_or(0) <= receipt.admitted_at {
                apply_receipt_to_state(&mut state, &receipt);
                crate::atomic_file::write_atomic(
                    &state_path,
                    &serde_json::to_vec(&state).map_err(|e| e.to_string())?,
                )?;
            }
            receipt.ledger_recorded = true;
            receipts::save(work_path, job_id, &receipt)?;
        }
    }
    let state = read_job_state(&state_path);
    if !state.agent_enabled.unwrap_or(job.enabled) {
        record_skipped(
            work_path,
            job,
            if if_missed { "recovery" } else { "calendar" },
            "disabled",
            manual_request.as_deref(),
        )?;
        return Ok(0);
    }
    if !explicit_force
        && (if_missed || job.schedule.recovery_mode == RecoveryMode::MissedFire)
        && last_success_covers_fire(
            &state,
            chrono::Local::now(),
            job.schedule.hour,
            job.schedule.minute,
        )
    {
        record_skipped(
            work_path,
            job,
            if if_missed { "recovery" } else { "calendar" },
            "deduplicated",
            None,
        )?;
        return Ok(0);
    }

    if !explicit_force {
        let fire =
            last_scheduled_fire_epoch(chrono::Local::now(), job.schedule.hour, job.schedule.minute)
                .map(|v| v.max(0) as u64);
        if receipts::history(work_path, job_id)?
            .iter()
            .any(|r| r.process_outcome == "interrupted" && r.scheduled_fire_at == fire)
        {
            record_skipped(
                work_path,
                job,
                if if_missed { "recovery" } else { "calendar" },
                "interrupted",
                None,
            )?;
            return Err("job_interrupted_requires_manual_request".into());
        }
    }
    let first_result = run_job_program(
        work_path,
        job,
        &state_path,
        if manual_request.is_some() {
            "manual"
        } else if if_missed {
            "recovery"
        } else {
            "calendar"
        },
        manual_request.as_deref(),
    );
    if let Some(request_id) = manual_request.take() {
        remove_manual_run_request(work_path, job_id, &request_id)?;
    }
    let mut exit_code = 1;
    let mut last_error = None;
    match first_result {
        Ok(code) => exit_code = code,
        Err(err) => last_error = Some(err),
    }

    // Multiple Run now requests arriving during one long run remain distinct.
    // Drain them in this launchd-supervised process instead of leaving a
    // request for an event launchd may have coalesced while the service ran.
    if manual_requests_enabled {
        while let Some(request_id) = peek_manual_run_request(work_path, job_id)? {
            if !read_job_state(&state_path)
                .agent_enabled
                .unwrap_or(job.enabled)
            {
                break;
            }
            let result = run_job_program(work_path, job, &state_path, "manual", Some(&request_id));
            remove_manual_run_request(work_path, job_id, &request_id)?;
            match result {
                Ok(code) => exit_code = code,
                Err(err) => last_error = Some(err),
            }
        }
    }
    match last_error {
        Some(err) => Err(err),
        None => Ok(exit_code),
    }
}

fn apply_receipt_to_state(state: &mut JobRunState, receipt: &receipts::JobRunReceipt) {
    state.last_run_at = Some(receipt.admitted_at);
    state.last_exit_code = Some(i64::from(receipt.exit_code.unwrap_or(-1)));
    if receipt.exit_code == Some(0) {
        state.last_success_at = receipt.finished_at;
        state.last_success_fire_at = receipt.scheduled_fire_at;
    }
}
fn new_receipt(job: &JobRecord, source: &str, request_id: Option<&str>) -> receipts::JobRunReceipt {
    new_receipt_at(job, source, request_id, chrono::Local::now())
}
fn new_receipt_at(
    job: &JobRecord,
    source: &str,
    request_id: Option<&str>,
    admitted: chrono::DateTime<chrono::Local>,
) -> receipts::JobRunReceipt {
    let run_id = uuid::Uuid::new_v4().to_string();
    receipts::JobRunReceipt {
        request_id: request_id.unwrap_or(&run_id).to_string(),
        run_id,
        source: source.into(),
        job_revision: format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(job).expect("job serialization"))
        ),
        // One timestamp freezes logical run-start and its daily fire before admission publication.
        scheduled_fire_at: last_scheduled_fire_epoch(
            admitted,
            job.schedule.hour,
            job.schedule.minute,
        )
        .map(|v| v.max(0) as u64),
        admitted_at: admitted.timestamp().max(0) as u64,
        started_at: None,
        finished_at: None,
        process_outcome: "admitted".into(),
        exit_code: None,
        verification_outcome: "notRequested".into(),
        ledger_recorded: false,
        coalesced_into: None,
        owner: receipts::identity(std::process::id()),
        child: None,
    }
}
fn record_skipped(
    work: &Path,
    job: &JobRecord,
    source: &str,
    outcome: &str,
    request_id: Option<&str>,
) -> Result<(), String> {
    let mut receipt = new_receipt(job, source, request_id);
    receipt.process_outcome = outcome.into();
    receipt.finished_at = Some(now_epoch_seconds());
    if outcome == "skipped_active" {
        receipt.coalesced_into = receipts::uncertain_active(work, &job.id)?;
    }
    receipts::save(work, &job.id, &receipt)
}
fn run_job_program(
    work_path: &Path,
    job: &JobRecord,
    state_path: &Path,
    source: &str,
    request_id: Option<&str>,
) -> Result<i32, String> {
    if let Some(active) = receipts::uncertain_active(work_path, &job.id)? {
        record_skipped(work_path, job, source, "skipped_active", request_id)?;
        return Err(format!("job_process_ownership_uncertain: {active}"));
    }
    let mut receipt = new_receipt(job, source, request_id);
    if receipt.owner.is_none() {
        return Err("job_native_owner_identity_unavailable".into());
    }
    receipts::save(work_path, &job.id, &receipt)?; // Must precede every spawn.

    let command = resolve_job_path(work_path, &job.program.command);
    let attempt = (|| {
        let logs_dir = resolve_job_path(work_path, &job.logs.dir);
        fs::create_dir_all(&logs_dir)
            .map_err(|err| format!("job_logs_dir_failed: {logs_dir}: {err}"))?;
        let stdout_path = format!("{logs_dir}/stdout.log");
        let stderr_path = format!("{logs_dir}/stderr.log");
        let stdout = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stdout_path)
            .map_err(|err| format!("job_log_open_failed: {stdout_path}: {err}"))?;
        let stderr = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&stderr_path)
            .map_err(|err| format!("job_log_open_failed: {stderr_path}: {err}"))?;
        let home = crate::skill_host::fs::install_root_base()?;
        let workspace_config = work_path.join("workspace.config.yaml");
        let mut child = Command::new(&command)
            .args(
                job.program
                    .args
                    .iter()
                    .map(|arg| resolve_job_arg(work_path, arg)),
            )
            .env("HOME", home)
            .envs(
                job.program
                    .env
                    .iter()
                    .map(|(key, value)| (key, expand_tilde_segments(value))),
            )
            .env("WORKSPACE_CONFIG", workspace_config)
            .current_dir(work_path)
            .stdout(Stdio::from(stdout))
            .stderr(Stdio::from(stderr))
            .no_window()
            .spawn()
            .map_err(|err| format!("job_spawn_failed: {command}: {err}"))?;
        receipt.started_at = Some(now_epoch_seconds());
        receipt.child = receipts::identity(child.id());
        receipt.process_outcome = "running".into();
        if let Err(err) = receipts::save(work_path, &job.id, &receipt) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(err);
        }
        let status = child
            .wait()
            .map_err(|err| format!("job_wait_failed: {command}: {err}"))?;
        Ok::<i32, String>(status.code().unwrap_or(-1))
    })();

    receipt.finished_at = Some(now_epoch_seconds());
    receipt.exit_code = attempt.as_ref().ok().copied();
    receipt.process_outcome = if attempt.is_ok() { "exited" } else { "failed" }.into();
    receipts::save(work_path, &job.id, &receipt)?; // Exit recorded before success-fire ledger.

    let _state_lock = lock_job_state(work_path, &job.id)?;
    let mut state = read_job_state(state_path);
    apply_receipt_to_state(&mut state, &receipt);
    let serialized = serde_json::to_string_pretty(&state).unwrap_or_default();
    crate::atomic_file::write_atomic(state_path, serialized.as_bytes())?;
    receipt.ledger_recorded = true;
    receipts::save(work_path, &job.id, &receipt)?;
    attempt
}

fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(crate::skill_host::fs::install_root_base()?
        .join("Library")
        .join("LaunchAgents"))
}

// The fixture selects one existing executable, never creates or runs a native
// service. Feature-off builds cannot select a test executable.
fn jobs_native_command(program: &str) -> Result<Command, String> {
    #[cfg(any(test, feature = "native-e2e"))]
    {
        #[cfg(test)]
        let fixture = true;
        #[cfg(not(test))]
        let fixture =
            crate::paths::native_e2e_dir_override(crate::paths::NATIVE_E2E_HOME_VAR)?.is_some();
        if fixture {
            let home = crate::skill_host::fs::install_root_base()?;
            #[cfg(test)]
            if std::env::var_os("MARU_TEST_HOME").is_none()
                || std::env::var_os("MARU_TEST_CONFIG_DIR").is_none()
            {
                return Err("jobs_test_home_required".into());
            }
            let path = home.join(".maru/test-jobs-command");
            let actual =
                fs::canonicalize(&path).map_err(|_| "jobs_test_command_missing".to_string())?;
            if !actual.starts_with(fs::canonicalize(&home).map_err(|err| err.to_string())?)
                || !actual.is_file()
            {
                return Err("jobs_test_command_refused".into());
            }
            let mut command = Command::new(actual);
            command.arg(program).env("MARU_JOBS_FIXTURE_HOME", home);
            return Ok(command);
        }
    }
    Ok(Command::new(program))
}

fn current_uid() -> Result<String, String> {
    let output = jobs_native_command("id")?
        .arg("-u")
        .no_window()
        .output()
        .map_err(|err| format!("uid_resolve_failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "uid_resolve_failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let uid = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if uid.is_empty() {
        return Err("uid_resolve_failed: empty uid".to_string());
    }
    Ok(uid)
}

/// Safety gate applied before any destructive launchd call or plist removal:
/// the label must carry the `com.maru.job.` prefix and the plist is always the
/// lexical `<canonical LaunchAgents>/<label>.plist`. An existing entry that is
/// a symlink is refused outright: canonicalizing it would pass a parent check
/// whenever the target also lives in LaunchAgents, redirecting the overwrite
/// or delete onto an unrelated agent's plist.
fn guarded_plist_path(label: &str) -> Result<PathBuf, String> {
    validate_label(label)?;
    let launch_agents = launch_agents_dir()?;
    let canonical_launch_agents = fs::canonicalize(&launch_agents).map_err(|err| {
        format!(
            "launch_agents_missing: {}: {err}",
            launch_agents.to_string_lossy()
        )
    })?;
    guarded_plist_path_in(&canonical_launch_agents, label)
}

fn validate_label(label: &str) -> Result<(), String> {
    if !label.starts_with(JOB_LABEL_PREFIX)
        || label.contains('/')
        || label.contains('\\')
        || label.contains("..")
    {
        return Err(format!("job_label_refused: {label}"));
    }
    Ok(())
}

fn guarded_plist_path_in(canonical_launch_agents: &Path, label: &str) -> Result<PathBuf, String> {
    validate_label(label)?;
    let plist = canonical_launch_agents.join(format!("{label}.plist"));
    match fs::symlink_metadata(&plist) {
        Ok(meta) if meta.file_type().is_symlink() => {
            Err(format!("plist_is_symlink: {}", plist.to_string_lossy()))
        }
        _ => Ok(plist),
    }
}

fn run_launchctl(args: &[&str]) -> Result<String, String> {
    let output = jobs_native_command("launchctl")?
        .args(args)
        .no_window()
        .output()
        .map_err(|err| format!("launchctl_spawn_failed: {err}"))?;
    let detail = [output.stdout.as_slice(), output.stderr.as_slice()]
        .into_iter()
        .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if output.status.success() {
        Ok(detail)
    } else {
        Err(format!("launchctl_failed: {}: {detail}", args.join(" ")))
    }
}

struct LaunchdPrint {
    loaded: bool,
    last_exit_code: Option<i64>,
}

fn print_launchd_state(uid: &str, label: &str) -> LaunchdPrint {
    let target = format!("gui/{uid}/{label}");
    let Ok(output) = jobs_native_command("launchctl").and_then(|mut command| {
        command
            .arg("print")
            .arg(&target)
            .no_window()
            .output()
            .map_err(|err| err.to_string())
    }) else {
        return LaunchdPrint {
            loaded: false,
            last_exit_code: None,
        };
    };
    if !output.status.success() {
        return LaunchdPrint {
            loaded: false,
            last_exit_code: None,
        };
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut last_exit_code = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("last exit code =") {
            last_exit_code = rest.trim().parse::<i64>().ok();
        }
    }
    LaunchdPrint {
        loaded: true,
        last_exit_code,
    }
}

/// Enabled state comes from `launchctl print-disabled gui/<uid>`: the service
/// is enabled unless its label appears in the disabled list.
fn launchd_disabled_labels(uid: &str) -> Vec<String> {
    let target = format!("gui/{uid}");
    let Ok(output) = jobs_native_command("launchctl").and_then(|mut command| {
        command
            .arg("print-disabled")
            .arg(&target)
            .no_window()
            .output()
            .map_err(|err| err.to_string())
    }) else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let line = line.trim();
            let (name, value) = line.split_once("=>")?;
            if value.trim() == "disabled" {
                Some(name.trim().trim_matches('"').to_string())
            } else {
                None
            }
        })
        .collect()
}

fn status_for(job: &JobRecord, work_path: &Path) -> Result<JobStatus, String> {
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let installed = plist.exists();
    let (loaded, enabled, last_exit_code) = if installed {
        let uid = current_uid()?;
        let print = print_launchd_state(&uid, &label);
        let enabled = if print.loaded {
            !launchd_disabled_labels(&uid)
                .iter()
                .any(|entry| entry == &label)
        } else {
            false
        };
        (print.loaded, enabled, print.last_exit_code)
    } else {
        (false, false, None)
    };
    let run_state = read_job_state(&job_state_path(work_path, &job.id));
    let last_run_at = run_state
        .last_run_at
        .and_then(|secs| chrono::DateTime::from_timestamp(secs as i64, 0))
        .map(|stamp| stamp.to_rfc3339());
    let reported_exit_code = if job.schedule.recovery_mode == RecoveryMode::MissedFire {
        run_state.last_exit_code
    } else {
        last_exit_code
    };
    Ok(JobStatus {
        id: job.id.clone(),
        title: job.title.clone(),
        description: job.description.clone(),
        installed,
        loaded,
        enabled,
        plist_path: plist.to_string_lossy().to_string(),
        label,
        schedule: job.schedule.clone(),
        last_exit_code: reported_exit_code,
        last_run_at,
        receipts: receipts::readback(work_path, &job.id)?,
    })
}

// Admission covers the workspace subprocess/config/script effects, plus every
// declared leaf (including symlinked descendants) and external logs/plist paths.
// Original lexical parents are captured before the manifest read. JOBS_LOCK is
// nested only for the fresh manifest snapshot and never spans a process join.
fn jobs_transaction_paths(work_path: &Path, job: &JobRecord) -> Result<Vec<PathBuf>, String> {
    let mut paths = vec![
        work_path.to_path_buf(),
        jobs_file_path(work_path),
        work_path.join("workspace.config.yaml"),
        // write_atomic allocates a random sibling before replacing the plist.
        launch_agents_dir()?,
        launch_agents_dir()?.join(format!("{}.plist", label_for(&job.id, work_path)?)),
        launch_agents_dir()?.join(format!("{}.plist", guard_label_for(&job.id, work_path)?)),
        PathBuf::from(resolve_job_path(work_path, &job.logs.dir)),
        PathBuf::from(resolve_job_path(work_path, &job.logs.dir)).join("stdout.log"),
        PathBuf::from(resolve_job_path(work_path, &job.logs.dir)).join("stderr.log"),
        PathBuf::from(resolve_job_path(work_path, &job.program.command)),
        jobs_state_dir(work_path),
        job_state_path(work_path, &job.id),
        jobs_state_dir(work_path).join(format!("{}.lock", job.id)),
        job_run_lock_path(work_path, &job.id),
        job_state_lock_path(work_path, &job.id),
        jobs_state_dir(work_path).join(format!("{}.receipts.json", job.id)),
        jobs_state_dir(work_path).join(format!("{}.receipts.lock", job.id)),
        manual_requests_dir(work_path, &job.id),
        manual_requests_lock_path(work_path, &job.id),
    ];
    for arg in &job.program.args {
        if !arg.starts_with('-')
            && !arg.contains("://")
            && (arg.contains('/') || arg.starts_with('.'))
        {
            paths.push(PathBuf::from(resolve_job_arg(work_path, arg)));
        }
    }
    Ok(paths)
}

fn jobs_transaction_request(
    work_path: &Path,
    job_id: &str,
) -> Result<PathTransactionRequest, String> {
    let parent = PathTransactionParent::capture(work_path)?;
    let agents = launch_agents_dir()?;
    let agents_parent = PathTransactionParent::capture(&agents)?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    PathTransactionRequest::new(jobs_transaction_paths(work_path, job)?)?
        .require_parent_snapshot(&parent)?
        .require_parent_snapshot(&agents_parent)
}

pub(crate) fn jobs_list_in(work_path: &Path) -> Result<Vec<JobStatus>, String> {
    let jobs = {
        let _guard = jobs_guard()?;
        load_jobs(work_path)?
    };
    jobs.jobs
        .iter()
        .map(|job| status_for(job, work_path))
        .collect()
}

pub(crate) fn jobs_install_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    with_path_transactions(jobs_transaction_request(work_path, job_id)?, |lease| {
        jobs_install_in_transaction(work_path, job_id, lease)
    })
}

/// Boot out and delete the missed-fire guard agent if it exists. Tolerates a
/// guard that was never loaded, but refuses to delete a plist whose service is
/// still loaded (same contract as the job's own uninstall).
fn remove_guard_agent(job: &JobRecord, work_path: &Path, uid: &str) -> Result<(), String> {
    let label = guard_label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let bootout = run_launchctl(&["bootout", &format!("gui/{uid}/{label}")]);
    if let Err(err) = bootout {
        if print_launchd_state(uid, &label).loaded {
            return Err(format!("job_bootout_failed: {label}: {err}"));
        }
    }
    if plist.exists() {
        fs::remove_file(&plist)
            .map_err(|err| format!("plist_remove_failed: {}: {err}", plist.to_string_lossy()))?;
    }
    Ok(())
}

/// Write and unload the missed-fire guard before the install baseline is
/// recorded. The caller loads either plist only after both old services are
/// unloaded and the baseline is durable.
fn prepare_guard_agent(
    job: &JobRecord,
    work_path: &Path,
    uid: &str,
) -> Result<Option<(String, PathBuf)>, String> {
    if job.schedule.recovery_mode != RecoveryMode::MissedFire {
        remove_guard_agent(job, work_path, uid)?;
        return Ok(None);
    }
    let label = guard_label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let target = format!("gui/{uid}/{label}");
    let xml = guard_plist_for(job, work_path)?;
    crate::atomic_file::write_atomic(&plist, xml.as_bytes())?;
    // Bootout first (ignore failure) so reinstall is idempotent.
    let _ = run_launchctl(&["bootout", &target]);
    Ok(Some((target, plist)))
}

/// Record the first-install boundary before either launchd plist can run. This
/// is distinct from a successful run: fires before installation are outside
/// this agent's recovery promise, and RunAtLoad must never race this baseline.
fn set_job_agent_enabled(work_path: &Path, job_id: &str, enabled: bool) -> Result<(), String> {
    let _state_lock = lock_job_state(work_path, job_id)?;
    let state_path = job_state_path(work_path, job_id);
    let mut state = read_job_state(&state_path);
    state.agent_enabled = Some(enabled);
    let serialized = serde_json::to_string_pretty(&state).unwrap_or_default();
    crate::atomic_file::write_atomic(&state_path, serialized.as_bytes())?;
    Ok(())
}

fn seed_install_baseline(work_path: &Path, job_id: &str, enabled: bool) -> Result<(), String> {
    let _state_lock = lock_job_state(work_path, job_id)?;
    let state_path = job_state_path(work_path, job_id);
    let mut state = read_job_state(&state_path);
    if state.install_baseline_at.is_none() {
        state.install_baseline_at = Some(now_epoch_seconds());
    }
    state.agent_enabled = Some(enabled);
    let serialized = serde_json::to_string_pretty(&state).unwrap_or_default();
    crate::atomic_file::write_atomic(&state_path, serialized.as_bytes())?;
    Ok(())
}

fn wrapper_executable_sha256(path: &Path) -> Result<String, String> {
    use std::io::Read;
    let mut file = fs::File::open(path).map_err(|e| format!("job_wrapper_hash_failed: {e}"))?;
    let mut hash = Sha256::new();
    let mut buffer = [0u8; 32768];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|e| format!("job_wrapper_hash_failed: {e}"))?;
        if count == 0 {
            break;
        }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}
fn record_wrapper_provenance(work: &Path, job: &JobRecord) -> Result<(), String> {
    let argv = exec_wrapper_arguments(job, false)?;
    let hash = wrapper_executable_sha256(Path::new(&argv[0]))?;
    let _state_lock = lock_job_state(work, &job.id)?;
    let path = job_state_path(work, &job.id);
    let mut state = read_job_state(&path);
    state.wrapper_executable = Some(argv[0].clone());
    state.wrapper_sha256 = Some(hash);
    crate::atomic_file::write_atomic(
        &path,
        &serde_json::to_vec(&state).map_err(|e| e.to_string())?,
    )
}

fn jobs_install_in_transaction(
    work_path: &Path,
    job_id: &str,
    lease: &PathTransactionLease,
) -> Result<JobStatus, String> {
    let jobs = {
        let _guard = jobs_guard()?;
        load_jobs(work_path)?
    };
    let job = find_job(&jobs, job_id)?;
    lease.ensure_covered(jobs_transaction_paths(work_path, job)?)?;
    lease.before_effect()?;
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;

    let xml = plist_for(job, work_path)?;
    let logs_dir = resolve_job_path(work_path, &job.logs.dir);
    fs::create_dir_all(&logs_dir)
        .map_err(|err| format!("job_logs_dir_failed: {logs_dir}: {err}"))?;
    crate::atomic_file::write_atomic(&plist, xml.as_bytes())?;

    // Bootout first (ignore failure) so reinstall is idempotent.
    let target = format!("gui/{uid}/{label}");
    let _ = run_launchctl(&["bootout", &target]);
    let guard = prepare_guard_agent(job, work_path, &uid)?;
    if job.schedule.recovery_mode == RecoveryMode::MissedFire {
        seed_install_baseline(work_path, &job.id, job.enabled)?;
    } else {
        set_job_agent_enabled(work_path, &job.id, job.enabled)?;
    }
    // Bind the generated launcher before any service can consume a queued request.
    record_wrapper_provenance(work_path, job)?;
    if job.enabled {
        // Enable before bootstrap: launchd refuses to bootstrap a service
        // whose label is in the disabled registry (e.g. after a prior Stop).
        run_launchctl(&["enable", &target])?;
        if let Some((guard_target, _)) = &guard {
            run_launchctl(&["enable", guard_target])?;
        }
        run_launchctl(&["bootstrap", &format!("gui/{uid}"), &plist.to_string_lossy()])?;
        if let Some((_, guard_plist)) = &guard {
            run_launchctl(&[
                "bootstrap",
                &format!("gui/{uid}"),
                &guard_plist.to_string_lossy(),
            ])?;
        }
    } else {
        // A disabled service cannot be loaded, and bootstrapping before
        // disabling would leave the schedule live (disable never unloads).
        run_launchctl(&["disable", &target])?;
        if let Some((guard_target, _)) = &guard {
            run_launchctl(&["disable", guard_target])?;
        }
    }
    status_for(job, work_path)
}

pub(crate) fn jobs_uninstall_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    with_path_transactions(jobs_transaction_request(work_path, job_id)?, |lease| {
        jobs_uninstall_in_transaction(work_path, job_id, lease)
    })
}

fn jobs_uninstall_in_transaction(
    work_path: &Path,
    job_id: &str,
    lease: &PathTransactionLease,
) -> Result<JobStatus, String> {
    let jobs = {
        let _guard = jobs_guard()?;
        load_jobs(work_path)?
    };
    let job = find_job(&jobs, job_id)?;
    lease.ensure_covered(jobs_transaction_paths(work_path, job)?)?;
    lease.before_effect()?;
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;

    let mut errors = Vec::new();
    if let Err(err) = set_job_agent_enabled(work_path, &job.id, false) {
        errors.push(err);
    }
    // Tolerate not-loaded on bootout, but never delete the plist while the
    // service is still loaded: launchd would keep running the cached job with
    // nothing on disk left to manage it.
    let bootout = run_launchctl(&["bootout", &format!("gui/{uid}/{label}")]);
    if let Err(err) = bootout {
        if print_launchd_state(&uid, &label).loaded {
            errors.push(format!("job_bootout_failed: {label}: {err}"));
        }
    }
    if plist.exists() && !print_launchd_state(&uid, &label).loaded {
        if let Err(err) = fs::remove_file(&plist) {
            errors.push(format!("plist_remove_failed: {}: {err}", plist.display()));
        }
    }
    if let Err(err) = remove_guard_agent(job, work_path, &uid) {
        errors.push(err);
    }
    if let Err(err) = clear_manual_run_requests(work_path, &job.id) {
        errors.push(err);
    }
    if !errors.is_empty() {
        return Err(format!("job_uninstall_failed: {}", errors.join("; ")));
    }
    status_for(job, work_path)
}

pub(crate) fn jobs_start_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    jobs_set_enabled_in(work_path, job_id, true)
}

pub(crate) fn jobs_stop_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    jobs_set_enabled_in(work_path, job_id, false)
}

fn jobs_set_enabled_in(work_path: &Path, job_id: &str, enabled: bool) -> Result<JobStatus, String> {
    with_path_transactions(jobs_transaction_request(work_path, job_id)?, |lease| {
        jobs_start_in_transaction(work_path, job_id, enabled, lease)
    })
}

fn jobs_start_in_transaction(
    work_path: &Path,
    job_id: &str,
    enabled: bool,
    lease: &PathTransactionLease,
) -> Result<JobStatus, String> {
    let jobs = {
        let _guard = jobs_guard()?;
        load_jobs(work_path)?
    };
    let job = find_job(&jobs, job_id)?;
    lease.ensure_covered(jobs_transaction_paths(work_path, job)?)?;
    lease.before_effect()?;
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;
    let target = format!("gui/{uid}/{label}");
    if enabled {
        if !plist.exists() {
            return Err(format!("job_not_installed: {job_id}"));
        }
        run_launchctl(&["enable", &target])?;
        // Unload both old services before enabling the runner state. Neither
        // service can start while stale work or manual requests are cleared.
        let _ = run_launchctl(&["bootout", &target]);
        let guard = if job.schedule.recovery_mode == RecoveryMode::MissedFire {
            let guard_label = guard_label_for(&job.id, work_path)?;
            let guard_plist = guarded_plist_path(&guard_label)?;
            let guard_target = format!("gui/{uid}/{guard_label}");
            if guard_plist.exists() {
                run_launchctl(&["enable", &guard_target])?;
                let _ = run_launchctl(&["bootout", &guard_target]);
                Some((guard_target, guard_plist))
            } else {
                None
            }
        } else {
            None
        };
        clear_manual_run_requests(work_path, &job.id)?;
        set_job_agent_enabled(work_path, &job.id, true)?;
        run_launchctl(&["bootstrap", &format!("gui/{uid}"), &plist.to_string_lossy()])?;
        if let Some((_, guard_plist)) = guard {
            run_launchctl(&[
                "bootstrap",
                &format!("gui/{uid}"),
                &guard_plist.to_string_lossy(),
            ])?;
        }
    } else {
        if job.schedule.recovery_mode == RecoveryMode::MissedFire {
            let mut errors = Vec::new();
            if let Err(err) = set_job_agent_enabled(work_path, &job.id, false) {
                errors.push(err);
            }
            // Persist disabled state first. Then attempt both agents even if
            // one launchctl operation fails, so the guard cannot survive Stop.
            stop_launch_agent(&uid, &label, &mut errors);
            let guard_label = guard_label_for(&job.id, work_path)?;
            stop_launch_agent(&uid, &guard_label, &mut errors);
            if let Err(err) = clear_manual_run_requests(work_path, &job.id) {
                errors.push(err);
            }
            if !errors.is_empty() {
                return Err(format!("job_stop_failed: {}", errors.join("; ")));
            }
        } else {
            set_job_agent_enabled(work_path, &job.id, false)?;
            clear_manual_run_requests(work_path, &job.id)?;
            run_launchctl(&["disable", &target])?;
            // disable leaves an already-loaded calendar timer live.
            let _ = run_launchctl(&["bootout", &target]);
        }
    }
    status_for(job, work_path)
}

fn stop_launch_agent(uid: &str, label: &str, errors: &mut Vec<String>) {
    let target = format!("gui/{uid}/{label}");
    if let Err(err) = run_launchctl(&["disable", &target]) {
        errors.push(err);
    }
    if let Err(err) = run_launchctl(&["bootout", &target]) {
        if print_launchd_state(uid, label).loaded {
            errors.push(format!("job_bootout_failed: {label}: {err}"));
        }
    }
}

pub(crate) fn jobs_run_now_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    with_path_transactions(jobs_transaction_request(work_path, job_id)?, |lease| {
        jobs_run_now_in_transaction(work_path, job_id, lease)
    })
}

/// Only the canonical generated main wrapper may consume durable Run now nonces.
/// Compare the entire generated plist shape, allowing an executable path alias
/// when it resolves to this Maru executable or matches the install-time path/hash.
/// This trusts local untampered install state, not a signed binary attestation.
fn installed_receipt_wrapper_matches(
    installed: &str,
    expected: &str,
    expected_args: &[String],
    state: &JobRunState,
) -> bool {
    let Some((prefix, body)) = installed.split_once("<array>") else {
        return false;
    };
    let Some((expected_prefix, expected_body)) = expected.split_once("<array>") else {
        return false;
    };
    let Some((arguments, suffix)) = body.split_once("</array>") else {
        return false;
    };
    let Some((_, expected_suffix)) = expected_body.split_once("</array>") else {
        return false;
    };
    if prefix != expected_prefix || suffix != expected_suffix {
        return false;
    }
    let mut remaining = arguments.trim();
    let mut argv = Vec::new();
    while !remaining.is_empty() {
        let Some(value) = remaining.strip_prefix("<string>") else {
            return false;
        };
        let Some((value, tail)) = value.split_once("</string>") else {
            return false;
        };
        let decoded = value
            .replace("&lt;", "<")
            .replace("&gt;", ">")
            .replace("&quot;", "\"")
            .replace("&amp;", "&");
        if xml_escape(&decoded) != value {
            return false;
        }
        argv.push(decoded);
        remaining = tail.trim();
    }
    if argv.len() != expected_args.len() || argv.get(1..) != expected_args.get(1..) {
        return false;
    }
    let Some(executable) = argv.first().filter(|value| Path::new(value).is_absolute()) else {
        return false;
    };
    let Ok(installed) = fs::canonicalize(executable) else {
        return false;
    };
    if expected_args
        .first()
        .and_then(|value| fs::canonicalize(value).ok())
        .is_some_and(|expected| installed == expected)
    {
        return true;
    }
    let Some(recorded) = state
        .wrapper_executable
        .as_deref()
        .filter(|value| Path::new(value).is_absolute())
    else {
        return false;
    };
    let Some(hash) = state.wrapper_sha256.as_deref() else {
        return false;
    };
    fs::canonicalize(recorded)
        .ok()
        .is_some_and(|recorded| recorded == installed)
        && wrapper_executable_sha256(Path::new(executable))
            .ok()
            .is_some_and(|actual| actual == hash)
}
fn ensure_installed_receipt_wrapper(
    plist: &Path,
    job: &JobRecord,
    work_path: &Path,
) -> Result<(), String> {
    use std::io::Read;
    let file = fs::File::open(plist).map_err(|e| format!("job_plist_read_failed: {e}"))?;
    let mut bytes = Vec::new();
    file.take(2 * 1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("job_plist_read_failed: {e}"))?;
    let installed = std::str::from_utf8(&bytes)
        .ok()
        .filter(|_| bytes.len() <= 2 * 1024 * 1024);
    let expected = plist_for(job, work_path)?;
    let argv = exec_wrapper_arguments(job, false)?;
    let state = read_job_state(&job_state_path(work_path, &job.id));
    if !installed
        .is_some_and(|xml| installed_receipt_wrapper_matches(xml, &expected, &argv, &state))
    {
        return Err(format!("job_receipt_wrapper_reinstall_required: {}: Reinstall this job through the current Maru launcher before Run now.", job.id));
    }
    Ok(())
}

fn jobs_run_now_in_transaction(
    work_path: &Path,
    job_id: &str,
    lease: &PathTransactionLease,
) -> Result<JobStatus, String> {
    let jobs = {
        let _guard = jobs_guard()?;
        load_jobs(work_path)?
    };
    let job = find_job(&jobs, job_id)?;
    lease.ensure_covered(jobs_transaction_paths(work_path, job)?)?;
    lease.before_effect()?;
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    if !plist.exists() {
        return Err(format!("job_not_installed: {job_id}"));
    }
    {
        let uid = current_uid()?;
        if !print_launchd_state(&uid, &label).loaded {
            return Err(format!("job_not_loaded: {job_id}"));
        }
        // Legacy Repeat plists run providers directly and cannot consume queued nonces.
        // Refuse before queue/kickstart so later reinstall cannot replay completed work.
        ensure_installed_receipt_wrapper(&plist, job, work_path)?;
        // Publish the force request first, then let launchd supervise the
        // child. The wrapper consumes this nonce only on the main agent path;
        // a guard fire can never consume it.
        let request_id = enqueue_manual_run_request(work_path, job_id, job.enabled)?;
        let target = format!("gui/{uid}/{label}");
        if let Err(err) = run_launchctl(&["kickstart", "-k", &target]) {
            remove_manual_run_request(work_path, job_id, &request_id)?;
            return Err(err);
        }
        status_for(job, work_path)
    }
}

pub(crate) fn jobs_read_log_in(work_path: &Path, job_id: &str) -> Result<JobLogsTail, String> {
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    let logs_dir = resolve_job_path(work_path, &job.logs.dir);
    Ok(JobLogsTail {
        stdout: tail_lines(&PathBuf::from(&logs_dir).join("stdout.log"), LOG_TAIL_LINES),
        stderr: tail_lines(&PathBuf::from(&logs_dir).join("stderr.log"), LOG_TAIL_LINES),
    })
}

/// Byte cap for the log tail: launchd appends forever with no rotation, so a
/// long-lived job's log can reach gigabytes; reading it whole would stall the
/// process for a 200-line preview.
const LOG_TAIL_BYTES: u64 = 256 * 1024;

fn tail_lines(path: &Path, max_lines: usize) -> String {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(mut file) = fs::File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let offset = len.saturating_sub(LOG_TAIL_BYTES);
    if file.seek(SeekFrom::Start(offset)).is_err() {
        return String::new();
    }
    let mut buf = Vec::new();
    if file.read_to_end(&mut buf).is_err() {
        return String::new();
    }
    let content = String::from_utf8_lossy(&buf);
    // Starting mid-file clips the first line; drop the fragment.
    let content: &str = if offset > 0 {
        content.split_once('\n').map(|(_, rest)| rest).unwrap_or("")
    } else {
        &content
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

pub fn jobs_list(work_path: String) -> Result<Vec<JobStatus>, String> {
    jobs_list_in(Path::new(&work_path))
}

pub fn jobs_install(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_install_in(Path::new(&work_path), &job_id)
}

pub fn jobs_uninstall(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_uninstall_in(Path::new(&work_path), &job_id)
}

pub fn jobs_start(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_start_in(Path::new(&work_path), &job_id)
}

pub fn jobs_stop(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_stop_in(Path::new(&work_path), &job_id)
}

pub fn jobs_run_now(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_run_now_in(Path::new(&work_path), &job_id)
}

pub fn jobs_read_log(work_path: String, job_id: String) -> Result<JobLogsTail, String> {
    jobs_read_log_in(Path::new(&work_path), &job_id)
}

pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn jobs_list(work_path: String) -> Result<Vec<JobStatus>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_list");
            super::jobs_list(work_path)
        })
        .await
        .map_err(|err| format!("jobs_list_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_install(work_path: String, job_id: String) -> Result<JobStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_install");
            super::jobs_install(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_install_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_uninstall(work_path: String, job_id: String) -> Result<JobStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_uninstall");
            super::jobs_uninstall(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_uninstall_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_start(work_path: String, job_id: String) -> Result<JobStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_start");
            super::jobs_start(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_start_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_stop(work_path: String, job_id: String) -> Result<JobStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_stop");
            super::jobs_stop(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_stop_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_run_now(work_path: String, job_id: String) -> Result<JobStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_run_now");
            super::jobs_run_now(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_run_now_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn jobs_read_log(work_path: String, job_id: String) -> Result<JobLogsTail, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:jobs_read_log");
            super::jobs_read_log(work_path, job_id)
        })
        .await
        .map_err(|err| format!("jobs_read_log_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};

    fn sample_job() -> JobRecord {
        JobRecord {
            id: "mail-digest".to_string(),
            title: "Daily Mail Digest".to_string(),
            description: "digest".to_string(),
            enabled: true,
            program: JobProgram {
                command: "~/.maru/env/.venv/bin/python3".to_string(),
                args: vec![
                    "_meta/scripts/daily_mail_digest.py".to_string(),
                    "run".to_string(),
                ],
                env: BTreeMap::from([
                    (
                        "PATH".to_string(),
                        "~/.local/share/fnm/aliases/default/bin:/usr/bin:/bin".to_string(),
                    ),
                    ("PYTHONUNBUFFERED".to_string(), "1".to_string()),
                ]),
            },
            schedule: JobSchedule {
                hour: 3,
                minute: 30,
                recovery_interval_seconds: 900,
                recovery_mode: RecoveryMode::Repeat,
                run_at_load: false,
            },
            logs: JobLogs {
                dir: "inbox/_state/mail-digest/.cache/logs".to_string(),
            },
        }
    }

    #[test]
    fn label_is_stable_and_work_path_sensitive() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work_a = dir.path().join("work-a");
        let work_b = dir.path().join("work-b");
        fs::create_dir_all(&work_a).unwrap();
        fs::create_dir_all(&work_b).unwrap();

        let first = label_for("mail-digest", &work_a).unwrap();
        let second = label_for("mail-digest", &work_a).unwrap();
        let other = label_for("mail-digest", &work_b).unwrap();

        assert_eq!(first, second);
        assert_ne!(first, other);
        assert!(first.starts_with("com.maru.job.mail-digest."));
        assert_eq!(first.len(), "com.maru.job.mail-digest.".len() + 8);

        let other_job = label_for("mail-digest-guard", &work_a).unwrap();
        let guard = guard_label_for("mail-digest", &work_a).unwrap();
        assert_ne!(other_job, guard, "guard labels use a separate namespace");
        assert!(guard.starts_with("com.maru.job.guard.mail-digest."));
    }

    #[test]
    fn label_rejects_invalid_job_id_charset() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        assert!(label_for("Mail_Digest", dir.path()).is_err());
        assert!(label_for("bad id", dir.path()).is_err());
        assert!(label_for("", dir.path()).is_err());
        assert!(label_for("mail-digest-2", dir.path()).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn wrapper_keeps_stable_invoked_symlink_only_when_it_targets_current_exe() {
        use std::os::unix::fs::symlink;

        let dir = tempfile::tempdir().unwrap();
        let versioned = dir.path().join("Cellar/maru/1.1.16/bin/maru");
        let stable = dir.path().join("bin/maru");
        let unrelated = dir.path().join("bin/other-maru");
        fs::create_dir_all(versioned.parent().unwrap()).unwrap();
        fs::create_dir_all(stable.parent().unwrap()).unwrap();
        fs::write(&versioned, b"binary").unwrap();
        fs::write(&unrelated, b"other").unwrap();
        symlink(&versioned, &stable).unwrap();

        assert_eq!(
            stable_invoked_executable(&versioned, Some(stable.as_os_str())),
            stable
        );
        assert_eq!(
            stable_invoked_executable(&versioned, Some(unrelated.as_os_str())),
            versioned
        );
        assert_eq!(stable_invoked_executable(&versioned, None), versioned);
    }

    #[test]
    fn guard_refuses_plist_outside_launch_agents() {
        let _home = Home::new();
        let err = guarded_plist_path("com.maru.job.test.deadbeef/../../etc/evil").unwrap_err();
        assert!(err.starts_with("job_label_refused") || err == "plist_outside_launch_agents");
    }

    #[test]
    fn guard_refuses_foreign_label() {
        let _home = Home::new();
        let err = guarded_plist_path("com.apple.Safari").unwrap_err();
        assert_eq!(err, "job_label_refused: com.apple.Safari");
    }

    #[test]
    fn plist_expands_tilde_and_resolves_paths() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = sample_job();

        let xml = plist_for(&job, &work).unwrap();
        let home = crate::skill_host::fs::install_root_base()
            .unwrap()
            .to_string_lossy()
            .to_string();

        assert!(!xml.contains("<string>~/"), "no literal ~ in values: {xml}");
        assert_eq!(
            resolve_job_path(&work, &job.program.command),
            under_home(&home, ".maru/env/.venv/bin/python3")
        );
        assert!(xml.contains("--maru-cli"));
        assert!(xml.contains(&format!(
            "<string>{}:/usr/bin:/bin</string>",
            under_home(&home, ".local/share/fnm/aliases/default/bin")
        )));
        assert_eq!(
            resolve_job_arg(&work, &job.program.args[0]),
            work.join("_meta/scripts/daily_mail_digest.py")
                .to_string_lossy()
        );
        // Bare subcommand tokens pass through; they are not workspace-relative paths.
        assert_eq!(resolve_job_arg(&work, "run"), "run");
        assert!(
            !xml.contains(&format!("<string>{}/run</string>", work.to_string_lossy())),
            "bare arg must not be path-resolved: {xml}"
        );
        assert!(xml.contains(&format!(
            "<key>WorkingDirectory</key>\n  <string>{}</string>",
            work.to_string_lossy()
        )));
        assert!(xml.contains(&format!(
            "<string>{}/stdout.log</string>",
            work.join("inbox/_state/mail-digest/.cache/logs")
                .to_string_lossy()
        )));
        assert!(xml.contains(&format!(
            "<string>{}</string>",
            work.join("workspace.config.yaml").to_string_lossy()
        )));
        assert!(xml.contains(&format!("<key>HOME</key>\n      <string>{home}</string>")));
        assert!(xml.contains("<key>Hour</key>\n    <integer>3</integer>"));
        assert!(xml.contains("<key>Minute</key>\n    <integer>30</integer>"));
        assert!(xml.contains("<key>StartInterval</key>\n  <integer>900</integer>"));
        assert!(xml.contains("<key>RunAtLoad</key>\n  <false/>"));
    }

    fn missed_fire_job() -> JobRecord {
        let mut job = sample_job();
        job.schedule.recovery_interval_seconds = 21600;
        job.schedule.recovery_mode = RecoveryMode::MissedFire;
        job
    }

    #[test]
    fn missed_fire_main_plist_wraps_program_and_keeps_cadence() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = missed_fire_job();

        let xml = plist_for(&job, &work).unwrap();

        // The engine wrapper drives the run so successes are recorded.
        assert!(xml.contains("<string>--maru-cli</string>"), "{xml}");
        assert!(xml.contains("<string>jobs</string>"), "{xml}");
        assert!(xml.contains("<string>exec</string>"), "{xml}");
        assert!(xml.contains("<string>mail-digest</string>"), "{xml}");
        assert!(
            !xml.contains("--if-missed"),
            "main plist runs unconditionally: {xml}"
        );
        assert!(
            !xml.contains("daily_mail_digest.py"),
            "wrapper replaces the direct program: {xml}"
        );
        // Cadence unchanged: calendar entry intact, RunAtLoad stays false,
        // and the recovery interval lives on the guard agent, not here.
        assert!(xml.contains("<key>StartCalendarInterval</key>"), "{xml}");
        assert!(xml.contains("<key>Hour</key>\n    <integer>3</integer>"));
        assert!(xml.contains("<key>Minute</key>\n    <integer>30</integer>"));
        assert!(xml.contains("<key>RunAtLoad</key>\n  <false/>"));
        assert!(
            !xml.contains("StartInterval"),
            "main missed-fire plist must not repeat on the interval: {xml}"
        );
    }

    #[test]
    fn missed_fire_guard_plist_is_interval_only_and_runs_at_load() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = missed_fire_job();

        let xml = guard_plist_for(&job, &work).unwrap();
        let label = guard_label_for(&job.id, &work).unwrap();

        assert!(label.starts_with("com.maru.job.guard.mail-digest."));
        assert!(xml.contains(&format!("<string>{label}</string>")));
        assert!(xml.contains("<string>--if-missed</string>"), "{xml}");
        // Interval + RunAtLoad recover a fire missed through sleep or reboot;
        // no calendar entry of its own.
        assert!(xml.contains("<key>RunAtLoad</key>\n  <true/>"));
        assert!(xml.contains("<key>StartInterval</key>\n  <integer>21600</integer>"));
        assert!(
            !xml.contains("StartCalendarInterval"),
            "guard is interval-only: {xml}"
        );
    }

    #[test]
    fn repeat_mode_plist_records_receipts_without_changing_cadence() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        // Repeat uses the admission wrapper, retaining its own interval cadence.
        let xml = plist_for(&sample_job(), &work).unwrap();
        assert!(xml.contains("--maru-cli"), "{xml}");
        assert!(xml.contains("<string>exec</string>"), "{xml}");
        assert!(!xml.contains("--if-missed"), "{xml}");
        assert!(xml.contains("<key>StartInterval</key>\n  <integer>900</integer>"));
    }

    #[test]
    fn load_jobs_defaults_recovery_mode_to_repeat_and_parses_missed_fire() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let maru_dir = dir.path().join(".maru");
        fs::create_dir_all(&maru_dir).unwrap();
        fs::write(
            maru_dir.join("jobs.json"),
            r#"{"schema":1,"jobs":[
              {"id":"plain","title":"t","program":{"command":"x"},"schedule":{"hour":1,"minute":0,"recoveryIntervalSeconds":900},"logs":{"dir":"logs"}},
              {"id":"guarded","title":"t","program":{"command":"x"},"schedule":{"hour":1,"minute":0,"recoveryIntervalSeconds":21600,"recoveryMode":"missedFire"},"logs":{"dir":"logs"}}
            ]}"#,
        )
        .unwrap();
        let jobs = load_jobs(dir.path()).unwrap();
        assert_eq!(jobs.jobs[0].schedule.recovery_mode, RecoveryMode::Repeat);
        assert_eq!(
            jobs.jobs[1].schedule.recovery_mode,
            RecoveryMode::MissedFire
        );
    }

    #[test]
    fn load_jobs_rejects_missed_fire_without_interval() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let maru_dir = dir.path().join(".maru");
        fs::create_dir_all(&maru_dir).unwrap();
        fs::write(
            maru_dir.join("jobs.json"),
            r#"{"schema":1,"jobs":[{"id":"guarded","title":"t","program":{"command":"x"},"schedule":{"hour":1,"minute":0,"recoveryMode":"missedFire"},"logs":{"dir":"logs"}}]}"#,
        )
        .unwrap();
        assert!(load_jobs(dir.path())
            .unwrap_err()
            .starts_with("job_schedule_invalid"));
    }

    #[test]
    fn last_scheduled_fire_rolls_back_before_the_fire_time() {
        use chrono::TimeZone;
        let after = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 10, 0, 0)
            .single()
            .unwrap();
        let fire = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 4, 30, 0)
            .single()
            .unwrap()
            .timestamp();
        assert_eq!(last_scheduled_fire_epoch(after, 4, 30), Some(fire));

        let before = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 3, 0, 0)
            .single()
            .unwrap();
        let yesterday_fire = chrono::Local
            .with_ymd_and_hms(2026, 10, 3, 4, 30, 0)
            .single()
            .unwrap()
            .timestamp();
        assert_eq!(
            last_scheduled_fire_epoch(before, 4, 30),
            Some(yesterday_fire)
        );
    }

    #[test]
    fn daily_fire_handles_dst_gap_and_uses_one_fall_back_fold() {
        use chrono::TimeZone;
        let timezone = chrono_tz::America::New_York;

        // The spring-forward date has no 02:30. The next morning, before
        // today's fire, the latest resolvable daily fire is March 7.
        let spring_morning = timezone
            .with_ymd_and_hms(2026, 3, 9, 1, 0, 0)
            .single()
            .unwrap();
        let prior_fire = timezone
            .with_ymd_and_hms(2026, 3, 7, 2, 30, 0)
            .single()
            .unwrap();
        assert_eq!(
            last_scheduled_fire(&timezone, spring_morning, 2, 30),
            Some(prior_fire)
        );

        // The fall-back date has two 01:30 wall times. Both folds map to the
        // first occurrence, so one logical daily fire cannot run twice.
        let first_fold = timezone
            .with_ymd_and_hms(2026, 11, 1, 1, 45, 0)
            .earliest()
            .unwrap();
        let second_fold = timezone
            .with_ymd_and_hms(2026, 11, 1, 1, 45, 0)
            .latest()
            .unwrap();
        let expected = timezone
            .with_ymd_and_hms(2026, 11, 1, 1, 30, 0)
            .earliest()
            .unwrap();
        assert_eq!(
            last_scheduled_fire(&timezone, first_fold, 1, 30),
            Some(expected)
        );
        assert_eq!(
            last_scheduled_fire(&timezone, second_fold, 1, 30),
            Some(expected)
        );
    }

    #[test]
    fn success_covers_fire_only_when_recorded_at_or_after_it() {
        use chrono::TimeZone;
        let now = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 10, 0, 0)
            .single()
            .unwrap();
        let fire = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 4, 30, 0)
            .single()
            .unwrap()
            .timestamp();

        let fresh = JobRunState {
            install_baseline_at: None,
            agent_enabled: None,
            wrapper_executable: None,
            wrapper_sha256: None,
            last_run_at: None,
            last_exit_code: None,
            last_success_at: Some((fire + 60) as u64),
            last_success_fire_at: Some(fire as u64),
        };
        assert!(last_success_covers_fire(&fresh, now, 4, 30));

        let stale = JobRunState {
            last_success_at: Some((fire - 60) as u64),
            ..fresh.clone()
        };
        assert!(!last_success_covers_fire(&stale, now, 4, 30));

        // Never ran through the wrapper -> due.
        assert!(!last_success_covers_fire(
            &JobRunState::default(),
            now,
            4,
            30
        ));
    }

    #[test]
    fn long_run_completion_does_not_cover_a_later_daily_fire() {
        use chrono::TimeZone;
        let prior_fire = chrono::Local
            .with_ymd_and_hms(2026, 10, 3, 4, 30, 0)
            .single()
            .unwrap()
            .timestamp();
        let next_fire = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 4, 30, 0)
            .single()
            .unwrap()
            .timestamp();
        let after_long_run = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 10, 0, 0)
            .single()
            .unwrap();
        let state = JobRunState {
            last_success_at: Some((next_fire + 3600) as u64),
            last_success_fire_at: Some(prior_fire as u64),
            ..JobRunState::default()
        };
        assert!(!last_success_covers_fire(&state, after_long_run, 4, 30));
    }

    fn exec_test_job(id: &str, shell_line: &str) -> JobRecord {
        JobRecord {
            id: id.to_string(),
            title: id.to_string(),
            description: String::new(),
            enabled: true,
            program: JobProgram {
                command: crate::test_support::posix_shell(),
                args: vec!["-c".to_string(), shell_line.to_string()],
                env: BTreeMap::new(),
            },
            schedule: JobSchedule {
                hour: 0,
                minute: 0,
                recovery_interval_seconds: 21600,
                recovery_mode: RecoveryMode::MissedFire,
                run_at_load: false,
            },
            logs: JobLogs {
                dir: ".maru/exec-test-logs".to_string(),
            },
        }
    }

    fn write_exec_test_workspace(work: &Path, job: &JobRecord) {
        let file = JobsFile {
            schema: JOBS_SCHEMA,
            jobs: vec![job.clone()],
        };
        let maru_dir = work.join(".maru");
        fs::create_dir_all(&maru_dir).unwrap();
        fs::write(
            maru_dir.join("jobs.json"),
            serde_json::to_string_pretty(&file).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn recovered_fire_prevents_later_coalesced_calendar_run_but_manual_run_forces() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = exec_test_job("ok-job", "echo ran >> exec-marker.txt");
        write_exec_test_workspace(&work, &job);

        // Recovery runs because there is no installed/success baseline.
        assert_eq!(jobs_exec_in(&work, "ok-job", true), 0);
        let marker = work.join("exec-marker.txt");
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);

        let state = read_job_state(&job_state_path(&work, "ok-job"));
        assert!(state.last_success_at.is_some());
        assert_eq!(state.last_exit_code, Some(0));

        // A later calendar invocation coalesced by launchd also skips the
        // already recovered fire.
        assert_eq!(jobs_exec_in(&work, "ok-job", false), 0);
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);

        // A guard cannot consume a pending explicit request. The main agent
        // consumes it once and bypasses same-fire dedup.
        let request = enqueue_manual_run_request(&work, "ok-job", true).unwrap();
        assert_eq!(jobs_exec_in(&work, "ok-job", true), 0);
        assert_eq!(
            peek_manual_run_request(&work, "ok-job").unwrap(),
            Some(request)
        );
        assert_eq!(jobs_exec_in(&work, "ok-job", false), 0);
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 2);
        assert_eq!(peek_manual_run_request(&work, "ok-job").unwrap(), None);

        // Child output lands in the job's log files, as a direct plist would.
        let stdout_log = work.join(".maru/exec-test-logs/stdout.log");
        assert!(stdout_log.exists());
    }

    #[test]
    fn exec_guard_runs_when_no_success_recorded() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = exec_test_job("stale-job", "echo ran >> exec-marker.txt");
        write_exec_test_workspace(&work, &job);

        // No state file: the fire counts as missed and the guard recovers it.
        assert_eq!(jobs_exec_in(&work, "stale-job", true), 0);
        let marker = work.join("exec-marker.txt");
        assert_eq!(fs::read_to_string(&marker).unwrap().lines().count(), 1);
        assert!(read_job_state(&job_state_path(&work, "stale-job"))
            .last_success_at
            .is_some());
    }

    #[test]
    fn install_baseline_is_not_a_fake_success_and_is_seeded_once() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();

        seed_install_baseline(&work, "baseline-job", true).unwrap();
        let initial = read_job_state(&job_state_path(&work, "baseline-job"));
        assert!(initial.install_baseline_at.is_some());
        assert_eq!(initial.agent_enabled, Some(true));
        assert_eq!(initial.last_success_at, None);

        seed_install_baseline(&work, "baseline-job", false).unwrap();
        let repeated = read_job_state(&job_state_path(&work, "baseline-job"));
        assert_eq!(repeated.install_baseline_at, initial.install_baseline_at);
        assert_eq!(repeated.agent_enabled, Some(false));
        assert_eq!(repeated.last_success_at, None);
    }

    #[test]
    fn stop_state_update_does_not_wait_for_a_running_job_lock() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let state_dir = jobs_state_dir(&work);
        fs::create_dir_all(&state_dir).unwrap();
        let run_lock = fs::File::create(job_run_lock_path(&work, "long-job")).unwrap();
        run_lock.lock().unwrap();

        let work_for_thread = work.clone();
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(set_job_agent_enabled(&work_for_thread, "long-job", false));
        });
        assert!(receiver
            .recv_timeout(std::time::Duration::from_secs(1))
            .expect("Stop state write is independent of the child-run lock")
            .is_ok());
        assert_eq!(
            read_job_state(&job_state_path(&work, "long-job")).agent_enabled,
            Some(false)
        );
    }

    #[test]
    fn concurrent_manual_requests_are_distinct_and_removable_individually() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = exec_test_job("queue-job", "exit 0");
        write_exec_test_workspace(&work, &job);

        let first = enqueue_manual_run_request(&work, "queue-job", true).unwrap();
        let second = enqueue_manual_run_request(&work, "queue-job", true).unwrap();
        assert_ne!(first, second);
        assert_eq!(
            manual_request_ids_unlocked(&work, "queue-job")
                .unwrap()
                .len(),
            2
        );

        remove_manual_run_request(&work, "queue-job", &first).unwrap();
        assert_eq!(
            peek_manual_run_request(&work, "queue-job").unwrap(),
            Some(second)
        );
        clear_manual_run_requests(&work, "queue-job").unwrap();
        assert_eq!(peek_manual_run_request(&work, "queue-job").unwrap(), None);
    }

    #[test]
    fn pre_spawn_failure_replaces_stale_success_status() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let mut job = exec_test_job("spawn-fail-job", "exit 0");
        job.program.command = work.join("missing-program").to_string_lossy().to_string();
        write_exec_test_workspace(&work, &job);

        assert_eq!(jobs_exec_in(&work, "spawn-fail-job", false), 1);
        let state = read_job_state(&job_state_path(&work, "spawn-fail-job"));
        assert!(state.last_run_at.is_some());
        assert_eq!(state.last_exit_code, Some(-1));
        assert_eq!(state.last_success_at, None);
    }

    #[test]
    fn exec_propagates_failure_without_marking_success() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = exec_test_job("fail-job", "exit 3");
        write_exec_test_workspace(&work, &job);

        assert_eq!(jobs_exec_in(&work, "fail-job", false), 3);
        let state = read_job_state(&job_state_path(&work, "fail-job"));
        assert_eq!(state.last_exit_code, Some(3));
        assert!(state.last_success_at.is_none());

        // A failed calendar run stays due: the guard retries it.
        assert_eq!(jobs_exec_in(&work, "fail-job", true), 3);
        let state = read_job_state(&job_state_path(&work, "fail-job"));
        assert!(state.last_success_at.is_none());
    }

    #[test]
    fn exec_disabled_job_is_a_noop() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let mut job = exec_test_job("off-job", "echo ran >> exec-marker.txt");
        job.enabled = false;
        write_exec_test_workspace(&work, &job);

        assert_eq!(jobs_exec_in(&work, "off-job", false), 0);
        assert!(!work.join("exec-marker.txt").exists());
    }

    /// Expected tilde expansion: the home directory joined with native separators.
    fn under_home(home: &str, rest: &str) -> String {
        Path::new(home).join(rest).to_string_lossy().into_owned()
    }

    #[test]
    fn env_value_expands_every_tilde_segment() {
        let _home = Home::new();
        let home = crate::skill_host::fs::install_root_base()
            .unwrap()
            .to_string_lossy()
            .to_string();

        // Regression: a two-tilde PATH must expand both segments.
        assert_eq!(
            expand_tilde_segments("~/a:~/b:/usr/bin"),
            format!(
                "{}:{}:/usr/bin",
                under_home(&home, "a"),
                under_home(&home, "b")
            )
        );
        // No tilde anywhere → byte-identical.
        assert_eq!(
            expand_tilde_segments("/usr/bin:/opt/homebrew/bin"),
            "/usr/bin:/opt/homebrew/bin"
        );
        // Single path without ':' behaves as before.
        assert_eq!(
            expand_tilde_segments("~/bin/tools"),
            under_home(&home, "bin/tools")
        );
        // URLs and times contain ':' but no tilde segments → byte-identical.
        assert_eq!(
            expand_tilde_segments("https://example.com/x"),
            "https://example.com/x"
        );
        assert_eq!(expand_tilde_segments("12:30"), "12:30");
        // A bare `~` segment expands to the home dir.
        assert_eq!(
            expand_tilde_segments("~:/usr/bin"),
            format!("{home}:/usr/bin")
        );
    }

    #[test]
    fn plist_env_expands_colon_separated_tildes() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let mut job = sample_job();
        job.program.env.insert(
            "PATH".to_string(),
            "~/.local/bin:~/.local/share/fnm/aliases/default/bin:/opt/homebrew/bin".to_string(),
        );

        let xml = plist_for(&job, &work).unwrap();
        let home = crate::skill_host::fs::install_root_base()
            .unwrap()
            .to_string_lossy()
            .to_string();
        assert!(xml.contains(&format!(
            "<string>{}:{}:/opt/homebrew/bin</string>",
            under_home(&home, ".local/bin"),
            under_home(&home, ".local/share/fnm/aliases/default/bin")
        )));
        assert!(!xml.contains("~/"), "no literal ~ in env values: {xml}");
    }

    #[test]
    fn args_that_are_flags_or_urls_pass_through() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path();
        // Flags and URLs contain '/' but are never workspace paths.
        assert_eq!(
            resolve_job_arg(work, "--config=conf/app.yaml"),
            "--config=conf/app.yaml"
        );
        assert_eq!(
            resolve_job_arg(work, "https://example.com/hook"),
            "https://example.com/hook"
        );
        // Plain relative paths still anchor at the workspace root.
        assert_eq!(
            resolve_job_arg(work, "scripts/run.py"),
            work.join("scripts/run.py").to_string_lossy()
        );
        assert_eq!(resolve_job_arg(work, "run"), "run");
    }

    #[test]
    fn plist_omits_start_interval_when_zero() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let mut job = sample_job();
        job.schedule.recovery_interval_seconds = 0;
        let xml = plist_for(&job, &work).unwrap();
        assert!(
            !xml.contains("StartInterval"),
            "StartInterval 0 is invalid to launchd and must be omitted: {xml}"
        );
    }

    #[test]
    fn load_jobs_rejects_duplicate_ids_and_bad_schedules() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let maru_dir = dir.path().join(".maru");
        fs::create_dir_all(&maru_dir).unwrap();
        let entry = |id: &str, hour: u32| {
            format!(
                r#"{{"id":"{id}","title":"t","program":{{"command":"x"}},"schedule":{{"hour":{hour},"minute":0}},"logs":{{"dir":"logs"}}}}"#
            )
        };
        fs::write(
            maru_dir.join("jobs.json"),
            format!(
                r#"{{"schema":1,"jobs":[{},{}]}}"#,
                entry("dup", 1),
                entry("dup", 2)
            ),
        )
        .unwrap();
        assert!(load_jobs(dir.path())
            .unwrap_err()
            .starts_with("job_id_duplicate"));

        fs::write(
            maru_dir.join("jobs.json"),
            format!(r#"{{"schema":1,"jobs":[{}]}}"#, entry("late", 24)),
        )
        .unwrap();
        assert!(load_jobs(dir.path())
            .unwrap_err()
            .starts_with("job_schedule_invalid"));
    }

    #[test]
    fn load_jobs_returns_empty_when_file_absent() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let jobs = load_jobs(dir.path()).unwrap();
        assert_eq!(jobs.schema, JOBS_SCHEMA);
        assert!(jobs.jobs.is_empty());
    }

    #[test]
    fn load_jobs_parses_mail_digest_entry() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let maru_dir = dir.path().join(".maru");
        fs::create_dir_all(&maru_dir).unwrap();
        fs::write(
            maru_dir.join("jobs.json"),
            r#"{
  "schema": 1,
  "jobs": [
    {
      "id": "mail-digest",
      "title": "Daily Mail Digest",
      "description": "digest",
      "enabled": true,
      "program": {
        "command": "~/.maru/env/.venv/bin/python3",
        "args": ["_meta/scripts/daily_mail_digest.py", "run"],
        "env": {"PYTHONUNBUFFERED": "1"}
      },
      "schedule": { "hour": 3, "minute": 30, "recoveryIntervalSeconds": 900, "runAtLoad": false },
      "logs": { "dir": "inbox/_state/mail-digest/.cache/logs" }
    }
  ]
}"#,
        )
        .unwrap();

        let jobs = load_jobs(dir.path()).unwrap();
        assert_eq!(jobs.jobs.len(), 1);
        assert_eq!(jobs.jobs[0].id, "mail-digest");
        assert_eq!(jobs.jobs[0].schedule.hour, 3);
        assert_eq!(jobs.jobs[0].schedule.recovery_interval_seconds, 900);
        assert!(!jobs.jobs[0].schedule.run_at_load);
    }

    #[cfg(unix)]
    #[test]
    fn guard_refuses_symlinked_plist() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let agents = fs::canonicalize(dir.path()).unwrap();
        let victim = agents.join("com.vendor.agent.plist");
        fs::write(&victim, "<plist/>").unwrap();
        let label = "com.maru.job.test.deadbeef";
        std::os::unix::fs::symlink(&victim, agents.join(format!("{label}.plist"))).unwrap();

        let err = guarded_plist_path_in(&agents, label).unwrap_err();
        assert!(err.starts_with("plist_is_symlink"), "{err}");
        // A regular file (or nothing) at the lexical path is accepted.
        fs::remove_file(agents.join(format!("{label}.plist"))).unwrap();
        assert!(guarded_plist_path_in(&agents, label).is_ok());
    }

    #[test]
    fn tail_lines_caps_read_at_byte_budget() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        // ~40 bytes per line * 10_000 lines ≈ 400 KiB > 256 KiB cap.
        let line = "x".repeat(39);
        let content: String = (0..10_000).map(|n| format!("{line}{n}\n")).collect();
        fs::write(&path, &content).unwrap();
        let tail = tail_lines(&path, 200);
        assert_eq!(tail.lines().count(), 200);
        assert!(tail.ends_with("9999"), "keeps the newest lines");
        assert!(!tail.contains('\u{FFFD}'), "no clipped-line fragment");
    }

    #[test]
    fn tail_lines_keeps_last_n_lines() {
        let _home = Home::new();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("stdout.log");
        let content: String = (1..=250).map(|n| format!("line {n}\n")).collect();
        fs::write(&path, content).unwrap();
        let tail = tail_lines(&path, 200);
        assert_eq!(tail.lines().count(), 200);
        assert!(tail.starts_with("line 51"));
        assert!(tail.ends_with("line 250"));
        assert_eq!(tail_lines(&dir.path().join("missing.log"), 200), "");
    }
    #[cfg(unix)]
    fn phase08_15_fixture(home: &Path, work: &Path) {
        fs::create_dir_all(home.join(".maru")).unwrap();
        fs::create_dir_all(home.join("Library/LaunchAgents")).unwrap();
        fs::create_dir_all(work.join(".maru")).unwrap();
        fs::create_dir_all(work.join("logs")).unwrap();
        fs::write(work.join("note.md"), "# original\nbody\n").unwrap();
        crate::test_support::write_executable_fixture(
            work.join("script.sh"),
            "#!/bin/sh\necho 'fixture child completed'\necho ran >> run-marker.txt\n",
            0o700,
        )
        .unwrap();
        let mut job = sample_job();
        job.schedule.recovery_interval_seconds = 21600;
        job.schedule.recovery_mode = RecoveryMode::MissedFire;
        job.program.command = "script.sh".into();
        job.program.args = vec![];
        job.program.env.clear();
        job.logs.dir = "logs".into();
        fs::write(
            jobs_file_path(work),
            serde_json::to_vec(&JobsFile {
                schema: 1,
                jobs: vec![job],
            })
            .unwrap(),
        )
        .unwrap();
        fs::write(work.join("logs/stdout.log"), "fixture stdout\n").unwrap();
        fs::write(work.join("logs/stderr.log"), "fixture stderr\n").unwrap();
        let executable = home.join(".maru/test-jobs-command");
        // Fixed local emulator. Every subprocess below is a local utility; the
        // job script is never submitted to launchd or another service manager.
        crate::test_support::write_executable_fixture(&executable, r#"#!/bin/sh
set -eu
state="$MARU_JOBS_FIXTURE_HOME/.maru"
if [ "$1" = id ]; then echo 501; exit 0; fi
[ "$1" = launchctl ] || exit 71
shift
op="$1"
shift
printf '%s\n' "$op" >> "$state/calls"
case "$op" in
  print-disabled)
    for entry in "$state"/*.disabled; do
      [ -e "$entry" ] || continue
      label="${entry##*/}"
      printf '"%s" => disabled\n' "${label%.disabled}"
    done
    ;;
  *)
    if [ "$op" = bootstrap ]; then
      label="${2##*/}"
      label="${label%.plist}"
    elif [ "$op" = kickstart ]; then label="${2##*/}"
    else label="${1##*/}"; fi
    case "$op" in
      enable) /bin/rm -f "$state/$label.disabled" ;;
      disable)
        [ ! -e "$state/fail-disable-$label" ] || exit 76
        : > "$state/$label.disabled"
        ;;
      bootstrap) [ ! -e "$state/$label.disabled" ]; : > "$state/$label.loaded" ;;
      bootout)
        [ ! -e "$state/fail-bootout" ] || exit 72
        /bin/rm -f "$state/$label.loaded"
        ;;
      print) [ -e "$state/$label.loaded" ]; echo 'last exit code = 0' ;;
      kickstart)
        [ ! -e "$state/fail-kickstart" ] || exit 77
        [ -e "$state/$label.loaded" ] || exit 73
        : > "$state/entered"
        n=0
        while [ -e "$state/hold" ]; do
          n=$((n + 1)); [ "$n" -lt 500 ] || exit 74
          /bin/sleep 0.01
        done
        plist="$MARU_JOBS_FIXTURE_HOME/Library/LaunchAgents/$label.plist"
        log=$(/usr/bin/sed -n '/<key>StandardOutPath<\/key>/{n;s/.*<string>\(.*\)<\/string>.*/\1/p;}' "$plist")
        printf 'fixture child completed\n' >> "$log"
        ;;
      *) exit 75 ;;
    esac
    ;;
esac
"#, 0o700).unwrap();
    }

    fn phase08_15_start<F>(future: F) -> std::sync::mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn phase08_15_done<T>(rx: std::sync::mpsc::Receiver<T>) -> T {
        rx.recv_timeout(std::time::Duration::from_secs(10))
            .expect("bounded jobs fixture completion")
    }
    async fn phase08_15_action(action: &'static str, work: String) -> Result<JobStatus, String> {
        match action {
            "install" => ipc::jobs_install(work, "mail-digest".into()).await,
            "uninstall" => ipc::jobs_uninstall(work, "mail-digest".into()).await,
            "start" => ipc::jobs_start(work, "mail-digest".into()).await,
            "stop" => ipc::jobs_stop(work, "mail-digest".into()).await,
            "run" => ipc::jobs_run_now(work, "mail-digest".into()).await,
            _ => unreachable!(),
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_15_jobs_all_wrappers_nonempty_legacy_errors_and_lifecycle() {
        let home = Home::new();
        let work = home.root.path().join("work");
        phase08_15_fixture(home.root.path(), &work);
        let main_label = label_for("mail-digest", &work).unwrap();
        let s = work.to_string_lossy().to_string();
        let list = run(ipc::jobs_list(s.clone())).unwrap();
        assert_eq!(list.len(), 1);
        assert!(!list[0].installed);
        assert_eq!(
            run(ipc::jobs_start(s.clone(), "mail-digest".into())).unwrap_err(),
            "job_not_installed: mail-digest"
        );
        let installed = run(phase08_15_action("install", s.clone())).unwrap();
        assert!(installed.installed && installed.loaded && installed.enabled);
        assert_eq!(installed.last_exit_code, None);
        assert!(!run(phase08_15_action("stop", s.clone())).unwrap().loaded);
        assert_eq!(
            read_job_state(&job_state_path(&work, "mail-digest")).agent_enabled,
            Some(false)
        );
        assert_eq!(jobs_exec_in(&work, "mail-digest", true), 0);
        assert!(!work.join("run-marker.txt").exists());
        assert_eq!(
            run(phase08_15_action("run", s.clone())).unwrap_err(),
            "job_not_loaded: mail-digest"
        );
        assert!(manual_request_ids_unlocked(&work, "mail-digest")
            .unwrap()
            .is_empty());
        assert!(run(phase08_15_action("start", s.clone())).unwrap().loaded);
        let state_path = job_state_path(&work, "mail-digest");
        let mut state = read_job_state(&state_path);
        assert_eq!(state.agent_enabled, Some(true));
        let fire = last_scheduled_fire_epoch(
            chrono::Local::now(),
            sample_job().schedule.hour,
            sample_job().schedule.minute,
        )
        .unwrap();
        state.install_baseline_at = Some((fire - 60) as u64);
        fs::write(&state_path, serde_json::to_vec(&state).unwrap()).unwrap();
        assert_eq!(jobs_exec_in(&work, "mail-digest", false), 0);
        assert_eq!(
            fs::read_to_string(work.join("run-marker.txt"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        fs::write(home.root.path().join(".maru/fail-kickstart"), "fail").unwrap();
        assert!(run(phase08_15_action("run", s.clone()))
            .unwrap_err()
            .starts_with("launchctl_failed: kickstart"));
        assert!(manual_request_ids_unlocked(&work, "mail-digest")
            .unwrap()
            .is_empty());
        fs::remove_file(home.root.path().join(".maru/fail-kickstart")).unwrap();
        assert_eq!(
            run(phase08_15_action("run", s.clone()))
                .unwrap()
                .last_exit_code,
            Some(0)
        );
        assert_eq!(
            manual_request_ids_unlocked(&work, "mail-digest")
                .unwrap()
                .len(),
            1
        );
        assert_eq!(jobs_exec_in(&work, "mail-digest", false), 0);
        assert!(manual_request_ids_unlocked(&work, "mail-digest")
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_to_string(work.join("run-marker.txt"))
                .unwrap()
                .lines()
                .count(),
            2
        );
        let tail = run(ipc::jobs_read_log(s.clone(), "mail-digest".into())).unwrap();
        assert!(tail.stdout.contains("fixture child completed"));
        assert_eq!(tail.stderr, "fixture stderr");
        let guard_label = guard_label_for("mail-digest", &work).unwrap();
        fs::write(
            home.root
                .path()
                .join(format!(".maru/fail-disable-{guard_label}")),
            "fail",
        )
        .unwrap();
        assert!(run(phase08_15_action("stop", s.clone()))
            .unwrap_err()
            .starts_with("job_stop_failed:"));
        assert_eq!(
            read_job_state(&job_state_path(&work, "mail-digest")).agent_enabled,
            Some(false)
        );
        assert!(!home
            .root
            .path()
            .join(format!(".maru/{main_label}.loaded"))
            .exists());
        assert!(!home
            .root
            .path()
            .join(format!(".maru/{guard_label}.loaded"))
            .exists());
        assert!(manual_request_ids_unlocked(&work, "mail-digest")
            .unwrap()
            .is_empty());
        fs::remove_file(
            home.root
                .path()
                .join(format!(".maru/fail-disable-{guard_label}")),
        )
        .unwrap();
        assert!(run(phase08_15_action("start", s.clone())).unwrap().loaded);
        fs::write(home.root.path().join(".maru/fail-bootout"), "fail").unwrap();
        let uninstall_error = run(phase08_15_action("uninstall", s.clone())).unwrap_err();
        assert!(uninstall_error.starts_with("job_uninstall_failed:"));
        assert!(uninstall_error.contains("job_bootout_failed:"));
        assert!(Path::new(&installed.plist_path).is_file());
        fs::remove_file(home.root.path().join(".maru/fail-bootout")).unwrap();
        assert!(
            !run(phase08_15_action("uninstall", s.clone()))
                .unwrap()
                .installed
        );
        for action in ["install", "uninstall", "start", "stop", "run"] {
            let missing = s.clone();
            let result = run(async move {
                match action {
                    "install" => ipc::jobs_install(missing, "missing".into()).await,
                    "uninstall" => ipc::jobs_uninstall(missing, "missing".into()).await,
                    "start" => ipc::jobs_start(missing, "missing".into()).await,
                    "stop" => ipc::jobs_stop(missing, "missing".into()).await,
                    _ => ipc::jobs_run_now(missing, "missing".into()).await,
                }
            });
            assert_eq!(result.unwrap_err(), "job_not_found: missing");
        }
        assert_eq!(
            run(ipc::jobs_read_log(s.clone(), "missing".into())).unwrap_err(),
            "job_not_found: missing"
        );
        fs::write(jobs_file_path(&work), "invalid").unwrap();
        assert!(run(ipc::jobs_list(s))
            .unwrap_err()
            .starts_with("jobs_parse_failed:"));
    }

    #[test]
    fn phase08_15_jobs_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let path = home.root.path();
        let s = path.to_string_lossy().to_string();
        boundary(path.into(), "jobs_list", ipc::jobs_list(s.clone()));
        boundary(
            path.into(),
            "jobs_install",
            ipc::jobs_install(s.clone(), "id".into()),
        );
        boundary(
            path.into(),
            "jobs_uninstall",
            ipc::jobs_uninstall(s.clone(), "id".into()),
        );
        boundary(
            path.into(),
            "jobs_start",
            ipc::jobs_start(s.clone(), "id".into()),
        );
        boundary(
            path.into(),
            "jobs_stop",
            ipc::jobs_stop(s.clone(), "id".into()),
        );
        boundary(
            path.into(),
            "jobs_run_now",
            ipc::jobs_run_now(s.clone(), "id".into()),
        );
        boundary(
            path.into(),
            "jobs_read_log",
            ipc::jobs_read_log(s, "id".into()),
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_15_jobs_files_parent_both_orders_and_aliases_no_recreation() {
        use crate::workspace_files::phase08_06::TrashFixture;
        let home = Home::new();
        for action in ["install", "uninstall", "start", "stop", "run"] {
            for parent in ["rename", "trash"] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
                        let root = fixture.path();
                        let a = root.join("a");
                        phase08_15_fixture(home.root.path(), &a);
                        let work = if alias {
                            std::os::unix::fs::symlink(&a, root.join("alias")).unwrap();
                            root.join("alias")
                        } else {
                            a.clone()
                        };
                        let s = work.to_string_lossy().to_string();
                        run(phase08_15_action("install", s.clone())).unwrap();
                        let target = root.join("b");
                        let _trash = TrashFixture::new(a.clone(), target.clone());
                        let parent_root = root.to_string_lossy().to_string();
                        let parent_future = async move {
                            if parent == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    parent_root,
                                    "a".into(),
                                    "b".into(),
                                )
                                .await
                                .map(|o| assert!(o.error.is_none()))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    parent_root,
                                    vec!["a".into()],
                                )
                                .await
                                .map(|o| assert!(o[0].error.is_none()))
                            }
                        };
                        let child_future = phase08_15_action(action, s);
                        if parent_first {
                            let held = Held::new(a.clone(), "pre-effect");
                            let p = phase08_15_start(parent_future);
                            held.wait();
                            let waiting = Held::new(work.clone(), "before-admission");
                            let c = phase08_15_start(child_future);
                            waiting.wait();
                            waiting.release();
                            assert!(c
                                .recv_timeout(std::time::Duration::from_millis(20))
                                .is_err());
                            held.release();
                            phase08_15_done(p).unwrap();
                            assert!(phase08_15_done(c).is_err(), "{action}/{parent}/{alias}");
                        } else {
                            let held = Held::new(work, "pre-effect");
                            let c = phase08_15_start(child_future);
                            held.wait();
                            let waiting = Held::new(a.clone(), "before-admission");
                            let p = phase08_15_start(parent_future);
                            waiting.wait();
                            waiting.release();
                            assert!(p
                                .recv_timeout(std::time::Duration::from_millis(20))
                                .is_err());
                            held.release();
                            phase08_15_done(c).unwrap();
                            phase08_15_done(p).unwrap();
                        }
                        assert!(!a.exists(), "original job parent recreated");
                        assert!(target.join(".maru/jobs.json").is_file());
                        if !parent_first && action == "run" {
                            assert!(fs::read_to_string(target.join("logs/stdout.log"))
                                .unwrap()
                                .contains("fixture child completed"));
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_15_jobs_document_writers_both_orders_alias_and_start_stop_order() {
        let home = Home::new();
        for action in ["install", "uninstall", "start", "stop", "run"] {
            for jobs_first in [false, true] {
                for alias in [false, true] {
                    let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
                    let root = fixture.path();
                    let work = root.join("work");
                    phase08_15_fixture(home.root.path(), &work);
                    let selected = if alias {
                        std::os::unix::fs::symlink(&work, root.join("alias")).unwrap();
                        root.join("alias")
                    } else {
                        work.clone()
                    };
                    let s = selected.to_string_lossy().to_string();
                    run(phase08_15_action("install", s.clone())).unwrap();
                    let document = crate::document::ipc::save_document(
                        work.to_string_lossy().to_string(),
                        "note.md".into(),
                        "# changed\ncomplete document\n".into(),
                        None,
                    );
                    let job = phase08_15_action(action, s);
                    if jobs_first {
                        let held = Held::new(selected.clone(), "pre-effect");
                        let j = phase08_15_start(job);
                        held.wait();
                        let waiting = Held::new(work.join("note.md"), "before-admission");
                        let d = phase08_15_start(document);
                        waiting.wait();
                        waiting.release();
                        assert!(d
                            .recv_timeout(std::time::Duration::from_millis(20))
                            .is_err());
                        held.release();
                        phase08_15_done(j).unwrap();
                        phase08_15_done(d).unwrap();
                    } else {
                        let held = Held::new(work.join("note.md"), "pre-effect");
                        let d = phase08_15_start(document);
                        held.wait();
                        let waiting = Held::new(selected, "before-admission");
                        let j = phase08_15_start(job);
                        waiting.wait();
                        waiting.release();
                        assert!(j
                            .recv_timeout(std::time::Duration::from_millis(20))
                            .is_err());
                        held.release();
                        phase08_15_done(d).unwrap();
                        phase08_15_done(j).unwrap();
                    }
                    assert_eq!(
                        fs::read_to_string(work.join("note.md")).unwrap(),
                        "# changed\ncomplete document\n"
                    );
                }
            }
        }
        let work = home.root.path().join("ordered");
        phase08_15_fixture(home.root.path(), &work);
        let s = work.to_string_lossy().to_string();
        run(phase08_15_action("install", s.clone())).unwrap();
        for first in ["start", "stop"] {
            let held = Held::new(work.clone(), "pre-effect");
            let one = phase08_15_start(phase08_15_action(first, s.clone()));
            held.wait();
            let waiting = Held::new(work.clone(), "before-admission");
            let second = if first == "start" { "stop" } else { "start" };
            let two = phase08_15_start(phase08_15_action(second, s.clone()));
            waiting.wait();
            waiting.release();
            assert!(two
                .recv_timeout(std::time::Duration::from_millis(20))
                .is_err());
            held.release();
            phase08_15_done(one).unwrap();
            assert_eq!(phase08_15_done(two).unwrap().loaded, second == "start");
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_15_jobs_unwind_releases_admission_and_local_child_holds_lease_not_jobs_lock() {
        let home = Home::new();
        let root = home.root.path();
        let work = root.join("work");
        phase08_15_fixture(root, &work);
        let s = work.to_string_lossy().to_string();
        {
            let _panic = crate::atomic_file::PathTransactionTestHook::new(
                work.clone(),
                "pre-effect",
                || panic!("fixture transaction unwind"),
            );
            assert!(run(phase08_15_action("install", s.clone()))
                .unwrap_err()
                .starts_with("jobs_install_task_failed:"));
        }
        run(phase08_15_action("install", s.clone())).unwrap();
        let state = root.join(".maru");
        fs::write(state.join("hold"), "held local child").unwrap();
        let child = phase08_15_start(phase08_15_action("run", s));
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !state.join("entered").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "child entered output wait"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let guard = JOBS_LOCK
            .get()
            .unwrap()
            .try_lock()
            .expect("domain lock released before local process output wait");
        drop(guard);
        let waiting = Held::new(work.clone(), "before-admission");
        let parent = phase08_15_start(crate::workspace_files::ipc::rename_workspace_entry(
            root.to_string_lossy().to_string(),
            "work".into(),
            "moved".into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(parent
            .recv_timeout(std::time::Duration::from_millis(20))
            .is_err());
        fs::remove_file(state.join("hold")).unwrap();
        phase08_15_done(child).unwrap();
        assert!(phase08_15_done(parent).unwrap().error.is_none());
        assert!(!work.exists());
        assert!(fs::read_to_string(root.join("moved/logs/stdout.log"))
            .unwrap()
            .contains("fixture child completed"));
    }
    #[cfg(unix)]
    #[test]
    fn phase08_15_jobs_descendant_alias_parents_revalidate_before_effects() {
        let home = Home::new();
        for selected in ["logs", "manifest", "script", "config", "agents"] {
            for parent_first in [false, true] {
                let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
                let root = fixture.path();
                let work = root.join("work");
                phase08_15_fixture(home.root.path(), &work);
                let external = root.join("external");
                fs::create_dir(&external).unwrap();
                let key = match selected {
                    "logs" => {
                        fs::remove_dir_all(work.join("logs")).unwrap();
                        std::os::unix::fs::symlink(&external, work.join("logs")).unwrap();
                        work.join("logs")
                    }
                    "manifest" => {
                        fs::rename(work.join(".maru/jobs.json"), external.join("jobs.json"))
                            .unwrap();
                        fs::remove_dir(work.join(".maru")).unwrap();
                        std::os::unix::fs::symlink(&external, work.join(".maru")).unwrap();
                        work.join(".maru/jobs.json")
                    }
                    "script" => {
                        fs::rename(work.join("script.sh"), external.join("script.sh")).unwrap();
                        std::os::unix::fs::symlink(
                            external.join("script.sh"),
                            work.join("script.sh"),
                        )
                        .unwrap();
                        work.join("script.sh")
                    }
                    "config" => {
                        fs::write(external.join("workspace.config.yaml"), "version: 1\n").unwrap();
                        std::os::unix::fs::symlink(
                            external.join("workspace.config.yaml"),
                            work.join("workspace.config.yaml"),
                        )
                        .unwrap();
                        work.join("workspace.config.yaml")
                    }
                    _ => {
                        fs::remove_dir_all(home.root.path().join("Library/LaunchAgents")).unwrap();
                        std::os::unix::fs::symlink(
                            &external,
                            home.root.path().join("Library/LaunchAgents"),
                        )
                        .unwrap();
                        home.root.path().join("Library/LaunchAgents").join(format!(
                            "{}.plist",
                            label_for("mail-digest", &work).unwrap()
                        ))
                    }
                };
                let job = phase08_15_action("install", work.to_string_lossy().to_string());
                let parent = crate::workspace_files::ipc::rename_workspace_entry(
                    root.to_string_lossy().to_string(),
                    "external".into(),
                    "moved".into(),
                );
                if parent_first {
                    let held = Held::new(external.clone(), "pre-effect");
                    let p = phase08_15_start(parent);
                    held.wait();
                    let waiting = Held::new(key, "before-admission");
                    let j = phase08_15_start(job);
                    waiting.wait();
                    waiting.release();
                    assert!(j
                        .recv_timeout(std::time::Duration::from_millis(20))
                        .is_err());
                    held.release();
                    assert!(phase08_15_done(p).unwrap().error.is_none());
                    assert!(
                        phase08_15_done(j).is_err(),
                        "{selected}: original alias parent must fail"
                    );
                } else {
                    let held = Held::new(key, "pre-effect");
                    let j = phase08_15_start(job);
                    held.wait();
                    let waiting = Held::new(external.clone(), "before-admission");
                    let p = phase08_15_start(parent);
                    waiting.wait();
                    waiting.release();
                    assert!(p
                        .recv_timeout(std::time::Duration::from_millis(20))
                        .is_err());
                    held.release();
                    assert!(phase08_15_done(j).unwrap().installed);
                    assert!(phase08_15_done(p).unwrap().error.is_none());
                }
                assert!(
                    !external.exists(),
                    "{selected}: external alias target recreated"
                );
                assert!(root.join("moved").is_dir());
                if selected == "agents" {
                    fs::remove_file(home.root.path().join("Library/LaunchAgents")).unwrap();
                    fs::create_dir(home.root.path().join("Library/LaunchAgents")).unwrap();
                }
            }
        }
    }
    #[test]
    fn receipt_admission_failure_never_spawns_a_child() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("admission", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        fs::create_dir_all(jobs_state_dir(work.path()).join("admission.receipts.json")).unwrap();
        assert!(jobs_exec_result(work.path(), "admission", false).is_err());
        assert!(!work.path().join("marker").exists());
    }
    #[test]
    fn receipts_distinguish_recovery_calendar_dedup_and_manual_force() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("receipt", "true");
        write_exec_test_workspace(work.path(), &job);
        assert_eq!(jobs_exec_result(work.path(), "receipt", true).unwrap(), 0);
        assert_eq!(jobs_exec_result(work.path(), "receipt", false).unwrap(), 0);
        let id = enqueue_manual_run_request(work.path(), "receipt", true).unwrap();
        assert_eq!(jobs_exec_result(work.path(), "receipt", false).unwrap(), 0);
        let rows = receipts::history(work.path(), "receipt").unwrap();
        assert_eq!(rows[0].source, "manual");
        assert_eq!(rows[0].request_id, id);
        assert_eq!(rows[0].verification_outcome, "notRequested");
        assert_eq!(rows[0].process_outcome, "exited");
        assert_eq!(rows[0].exit_code, Some(0));
        assert_eq!(rows[1].source, "calendar");
        assert_eq!(rows[1].process_outcome, "deduplicated");
        assert_eq!(rows[1].exit_code, None);
        assert_eq!(rows[2].source, "recovery");
    }
    #[test]
    fn recovery_lock_collision_has_a_skipped_receipt_without_executed_exit() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("collision", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        fs::create_dir_all(jobs_state_dir(work.path())).unwrap();
        let lock = fs::File::create(job_run_lock_path(work.path(), "collision")).unwrap();
        lock.lock().unwrap();
        assert_eq!(jobs_exec_result(work.path(), "collision", true).unwrap(), 0);
        let rows = receipts::history(work.path(), "collision").unwrap();
        assert_eq!(rows[0].process_outcome, "skipped_active");
        assert_eq!(rows[0].exit_code, None);
        assert!(!work.path().join("marker").exists());
    }
    #[test]
    fn repeat_manual_requests_remain_distinct_without_daily_dedup() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut job = exec_test_job("repeat", "echo ran >> marker");
        job.schedule.recovery_mode = RecoveryMode::Repeat;
        write_exec_test_workspace(work.path(), &job);
        let first = enqueue_manual_run_request(work.path(), "repeat", true).unwrap();
        let second = enqueue_manual_run_request(work.path(), "repeat", true).unwrap();
        assert_eq!(jobs_exec_result(work.path(), "repeat", false).unwrap(), 0);
        let rows = receipts::history(work.path(), "repeat").unwrap();
        assert_eq!(rows.len(), 2);
        let requests: std::collections::HashSet<_> =
            rows.iter().map(|row| row.request_id.clone()).collect();
        assert_eq!(requests, std::collections::HashSet::from([first, second]));
        assert!(rows
            .iter()
            .all(|row| row.source == "manual" && row.process_outcome == "exited"));
        assert_eq!(
            fs::read_to_string(work.path().join("marker"))
                .unwrap()
                .lines()
                .count(),
            2
        );
    }
    #[test]
    fn exit_before_ledger_crash_is_reconciled_without_provider_replay() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("ledger", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        let mut row = new_receipt(&job, "recovery", None);
        row.process_outcome = "exited".into();
        row.finished_at = Some(now_epoch_seconds());
        row.exit_code = Some(0);
        receipts::save(work.path(), &job.id, &row).unwrap();
        assert_eq!(jobs_exec_result(work.path(), "ledger", true).unwrap(), 0);
        assert!(!work.path().join("marker").exists());
        assert!(receipts::history(work.path(), &job.id)
            .unwrap()
            .iter()
            .any(|r| r.run_id == row.run_id && r.ledger_recorded));
        assert_eq!(
            read_job_state(&job_state_path(work.path(), &job.id)).last_success_fire_at,
            row.scheduled_fire_at
        );
    }
    #[test]
    fn terminal_receipt_failure_does_not_publish_success_fire() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        // Preserve the admitted/running evidence, then make the terminal destination unwritable.
        let job = exec_test_job(
            "terminal",
            r#"count=0; until grep -q '"processOutcome":"running"' .maru/jobs-state/terminal.receipts.json; do count=$((count + 1)); test "$count" -lt 100 || exit 3; sleep 0.01; done; mv .maru/jobs-state/terminal.receipts.json .maru/jobs-state/terminal.before-failure.json; mkdir .maru/jobs-state/terminal.receipts.json"#,
        );
        write_exec_test_workspace(work.path(), &job);
        assert!(jobs_exec_result(work.path(), &job.id, false).is_err());
        let state = read_job_state(&job_state_path(work.path(), &job.id));
        assert_eq!(state.last_success_fire_at, None);
        let preserved: Vec<receipts::JobRunReceipt> = serde_json::from_slice(
            &fs::read(jobs_state_dir(work.path()).join("terminal.before-failure.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(preserved[0].verification_outcome, "notRequested");
        assert_eq!(preserved[0].process_outcome, "running");
    }
    #[test]
    fn read_only_workspace_rejects_admission_before_provider_spawn() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("readonly", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        let registry = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::write(registry, serde_json::to_vec(&serde_json::json!({"workspaces": [{"label": "Read only", "path": work.path(), "visibility": "private", "provider": "local", "writePolicy": "readOnly"}]})).unwrap()).unwrap();
        assert!(jobs_exec_result(work.path(), &job.id, false).is_err());
        assert!(!work.path().join("marker").exists());
        assert!(!jobs_state_dir(work.path()).exists());
    }
    #[test]
    fn ownership_blocked_manual_receipt_keeps_exact_request_id() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("blocked", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        let mut orphan = new_receipt(&job, "calendar", None);
        orphan.owner = None;
        orphan.child = receipts::identity(std::process::id());
        receipts::save(work.path(), &job.id, &orphan).unwrap();
        let request = enqueue_manual_run_request(work.path(), &job.id, true).unwrap();
        assert!(jobs_exec_result(work.path(), &job.id, false).is_err());
        let row = receipts::history(work.path(), &job.id)
            .unwrap()
            .into_iter()
            .find(|r| r.request_id == request)
            .unwrap();
        assert_eq!(row.source, "manual");
        assert_eq!(row.process_outcome, "skipped_active");
        assert_eq!(row.coalesced_into, Some(orphan.run_id));
        assert_eq!(row.exit_code, None);
        assert!(!work.path().join("marker").exists());
    }
    #[test]
    fn repeat_start_stop_effective_state_controls_manual_admission() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let mut job = exec_test_job("repeat-state", "echo ran > marker");
        job.schedule.recovery_mode = RecoveryMode::Repeat;
        job.enabled = false;
        write_exec_test_workspace(work.path(), &job);
        set_job_agent_enabled(work.path(), &job.id, true).unwrap();
        let id = enqueue_manual_run_request(work.path(), &job.id, false).unwrap();
        assert_eq!(jobs_exec_result(work.path(), &job.id, false).unwrap(), 0);
        assert_eq!(
            receipts::history(work.path(), &job.id).unwrap()[0].request_id,
            id
        );
        set_job_agent_enabled(work.path(), &job.id, false).unwrap();
        assert!(enqueue_manual_run_request(work.path(), &job.id, false).is_err());
        assert_eq!(jobs_exec_result(work.path(), &job.id, false).unwrap(), 0);
        assert_eq!(
            receipts::history(work.path(), &job.id).unwrap()[0].process_outcome,
            "disabled"
        );
    }
    #[test]
    fn oversized_receipt_history_prevents_provider_spawn() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("large-history", "echo ran > marker");
        write_exec_test_workspace(work.path(), &job);
        fs::create_dir_all(jobs_state_dir(work.path())).unwrap();
        let path = jobs_state_dir(work.path()).join("large-history.receipts.json");
        fs::File::create(path)
            .unwrap()
            .set_len(2 * 1024 * 1024 + 1)
            .unwrap();
        assert_eq!(
            jobs_exec_result(work.path(), &job.id, false).unwrap_err(),
            "job_receipt_history_too_large"
        );
        assert!(!work.path().join("marker").exists());
    }
    #[test]
    #[cfg(unix)] // Exercises the launchctl shell emulator, like the other launchd fixtures.
    fn legacy_repeat_run_now_cannot_leave_a_nonce_for_later_replay() {
        let home = Home::new();
        let work = home.root.path().join("legacy-repeat");
        phase08_15_fixture(home.root.path(), &work);
        let mut manifest = load_jobs(&work).unwrap();
        manifest.jobs[0].schedule.recovery_mode = RecoveryMode::Repeat;
        fs::write(
            jobs_file_path(&work),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        let installed = jobs_install_in(&work, "mail-digest").unwrap();
        let job = manifest.jobs.remove(0);
        assert_eq!(job.schedule.recovery_mode, RecoveryMode::Repeat);
        let legacy = render_plist(
            &job,
            &work,
            &installed.label,
            &[resolve_job_path(&work, &job.program.command)],
            job.schedule.run_at_load,
            Some((job.schedule.hour, job.schedule.minute)),
            Some(job.schedule.recovery_interval_seconds),
        )
        .unwrap();
        fs::write(&installed.plist_path, legacy).unwrap();
        let before_calls = fs::read_to_string(home.root.path().join(".maru/calls")).unwrap();
        assert!(jobs_run_now_in(&work, &job.id)
            .unwrap_err()
            .starts_with("job_receipt_wrapper_reinstall_required:"));
        assert!(manual_request_ids_unlocked(&work, &job.id)
            .unwrap()
            .is_empty());
        let after_calls = fs::read_to_string(home.root.path().join(".maru/calls")).unwrap();
        assert_eq!(
            before_calls.lines().filter(|op| *op == "kickstart").count(),
            after_calls.lines().filter(|op| *op == "kickstart").count()
        );
        assert!(!work.join("run-marker.txt").exists());
        jobs_install_in(&work, &job.id).unwrap();
        jobs_run_now_in(&work, &job.id).unwrap();
        assert_eq!(
            manual_request_ids_unlocked(&work, &job.id).unwrap().len(),
            1
        );
        assert_eq!(jobs_exec_result(&work, &job.id, false).unwrap(), 0);
        assert!(manual_request_ids_unlocked(&work, &job.id)
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_to_string(work.join("run-marker.txt"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(receipts::history(&work, &job.id).unwrap().len(), 1);
    }
    #[test]
    fn receipt_wrapper_recognition_rejects_legacy_malformed_and_stray_markers() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = sample_job();
        let expected = plist_for(&job, work.path()).unwrap();
        let argv = exec_wrapper_arguments(&job, false).unwrap();
        assert!(installed_receipt_wrapper_matches(
            &expected,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let wrong_exe = expected.replace(
            &format!("<string>{}</string>", xml_escape(&argv[0])),
            "<string>/bin/sh</string>",
        );
        assert!(!installed_receipt_wrapper_matches(
            &wrong_exe,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let guard = guard_plist_for(&job, work.path()).unwrap();
        assert!(!installed_receipt_wrapper_matches(
            &guard,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let wrong_job = expected.replace(
            "<string>mail-digest</string>",
            "<string>another-job</string>",
        );
        assert!(!installed_receipt_wrapper_matches(
            &wrong_job,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let comment = expected.replace("<array>", "<!-- <array>");
        assert!(!installed_receipt_wrapper_matches(
            &comment,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let trailing = expected.replace("</array>", "<string>extra</string></array>");
        assert!(!installed_receipt_wrapper_matches(
            &trailing,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let env_marker = expected
            .replace(
                "<string>--maru-cli</string>",
                "<string>provider-flag</string>",
            )
            .replace(
                "</dict>",
                "<key>marker</key><string>--maru-cli jobs exec mail-digest</string></dict>",
            );
        assert!(!installed_receipt_wrapper_matches(
            &env_marker,
            &expected,
            &argv,
            &JobRunState::default()
        ));
    }
    #[cfg(unix)]
    #[test]
    fn receipt_wrapper_accepts_stable_alias_of_the_current_launcher() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = sample_job();
        let expected = plist_for(&job, work.path()).unwrap();
        let argv = exec_wrapper_arguments(&job, false).unwrap();
        let alias = work.path().join("maru-alias");
        std::os::unix::fs::symlink(&argv[0], &alias).unwrap();
        let installed = expected.replace(
            &format!("<string>{}</string>", xml_escape(&argv[0])),
            &format!("<string>{}</string>", xml_escape(&alias.to_string_lossy())),
        );
        assert!(installed_receipt_wrapper_matches(
            &installed,
            &expected,
            &argv,
            &JobRunState::default()
        ));
    }
    #[test]
    fn installed_launcher_provenance_preserves_cross_launcher_calls_without_probing() {
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = sample_job();
        let expected = plist_for(&job, work.path()).unwrap();
        let argv = exec_wrapper_arguments(&job, false).unwrap();
        let alternate = work.path().join("maru-cli-from-other-launcher");
        fs::write(
            &alternate,
            "distinct private fixture binary bytes, never executed",
        )
        .unwrap();
        let installed = expected.replace(
            &format!("<string>{}</string>", xml_escape(&argv[0])),
            &format!(
                "<string>{}</string>",
                xml_escape(&alternate.to_string_lossy())
            ),
        );
        assert!(!installed_receipt_wrapper_matches(
            &installed,
            &expected,
            &argv,
            &JobRunState::default()
        ));
        let state = JobRunState {
            wrapper_executable: Some(alternate.to_string_lossy().to_string()),
            wrapper_sha256: Some(wrapper_executable_sha256(&alternate).unwrap()),
            ..JobRunState::default()
        };
        assert!(installed_receipt_wrapper_matches(
            &installed, &expected, &argv, &state
        ));
        #[cfg(unix)]
        {
            let alias = work.path().join("stable-alternate");
            std::os::unix::fs::symlink(&alternate, &alias).unwrap();
            let aliased = installed.replace(
                &xml_escape(&alternate.to_string_lossy()),
                &xml_escape(&alias.to_string_lossy()),
            );
            assert!(installed_receipt_wrapper_matches(
                &aliased, &expected, &argv, &state
            ));
        }
        fs::write(&alternate, "changed private fixture bytes").unwrap();
        assert!(!installed_receipt_wrapper_matches(
            &installed, &expected, &argv, &state
        ));
        assert!(installed_receipt_wrapper_matches(
            &expected,
            &expected,
            &argv,
            &JobRunState::default()
        ));
    }
    #[test]
    fn admission_crossing_daily_fire_keeps_normal_and_crash_ledger_attribution_identical() {
        use chrono::TimeZone;
        let _home = Home::new();
        let work = tempfile::tempdir().unwrap();
        let job = exec_test_job("admission-fire", "true");
        let admitted = chrono::Local
            .with_ymd_and_hms(2026, 10, 4, 23, 59, 59)
            .single()
            .unwrap();
        let launched = chrono::Local
            .with_ymd_and_hms(2026, 10, 5, 0, 0, 1)
            .single()
            .unwrap();
        let completed = chrono::Local
            .with_ymd_and_hms(2026, 10, 5, 0, 0, 2)
            .single()
            .unwrap();
        let mut receipt = new_receipt_at(&job, "calendar", None, admitted);
        let frozen_fire = receipt.scheduled_fire_at;
        receipts::save(work.path(), &job.id, &receipt).unwrap();
        // Model slow durable admission crossing midnight without changing any host clock.
        receipt.started_at = Some(launched.timestamp() as u64);
        receipt.finished_at = Some(completed.timestamp() as u64);
        receipt.process_outcome = "exited".into();
        receipt.exit_code = Some(0);
        receipts::save(work.path(), &job.id, &receipt).unwrap();
        let mut normal = JobRunState::default();
        apply_receipt_to_state(&mut normal, &receipt);
        let terminal = receipts::history(work.path(), &job.id).unwrap().remove(0);
        let mut reconciled = JobRunState::default();
        apply_receipt_to_state(&mut reconciled, &terminal);
        assert_eq!(normal, reconciled);
        assert_eq!(normal.last_run_at, Some(admitted.timestamp() as u64));
        assert_eq!(normal.last_success_fire_at, frozen_fire);
        assert_eq!(normal.last_success_at, Some(completed.timestamp() as u64));
        assert!(last_success_covers_fire(&normal, admitted, 0, 0));
        assert!(!last_success_covers_fire(&normal, launched, 0, 0));
        assert_ne!(
            frozen_fire,
            last_scheduled_fire_epoch(launched, 0, 0).map(|v| v as u64)
        );
    }
}
