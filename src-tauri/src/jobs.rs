use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, MutexGuard, OnceLock};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::win_process::NoWindow;

pub const JOBS_SCHEMA: u32 = 1;
pub const JOB_LABEL_PREFIX: &str = "com.maru.job.";
const LOG_TAIL_LINES: usize = 200;

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

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobSchedule {
    pub hour: u32,
    pub minute: u32,
    #[serde(default)]
    pub recovery_interval_seconds: u64,
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
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct JobLogsTail {
    pub stdout: String,
    pub stderr: String,
}

fn jobs_guard() -> Result<MutexGuard<'static, ()>, String> {
    JOBS_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "jobs_lock_poisoned".to_string())
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
    for job in &file.jobs {
        validate_job_id(&job.id)?;
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
    let hex: String = digest[..4].iter().map(|byte| format!("{byte:02x}")).collect();
    Ok(format!("{JOB_LABEL_PREFIX}{job_id}.{hex}"))
}

fn canonical_work_path(work_path: &Path) -> Result<PathBuf, String> {
    fs::canonicalize(work_path)
        .map_err(|err| format!("work_path_missing: {}: {err}", work_path.to_string_lossy()))
}

/// Expand a leading `~` / `~/` against the user's home directory.
fn expand_tilde(value: &str) -> String {
    if value == "~" || value.starts_with("~/") {
        if let Some(home) = dirs::home_dir() {
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
    let command = resolve_job_path(work_path, &job.program.command);
    let args: Vec<String> = job
        .program
        .args
        .iter()
        .map(|arg| resolve_job_path(work_path, arg))
        .collect();
    let logs_dir = resolve_job_path(work_path, &job.logs.dir);
    let stdout_path = format!("{logs_dir}/stdout.log");
    let stderr_path = format!("{logs_dir}/stderr.log");
    let work_dir = work_path.to_string_lossy().to_string();
    let workspace_config = work_path
        .join("workspace.config.yaml")
        .to_string_lossy()
        .to_string();
    let home = dirs::home_dir()
        .ok_or_else(|| "Cannot resolve home directory".to_string())?
        .to_string_lossy()
        .to_string();

    let mut program_arguments = String::new();
    program_arguments.push_str(&format!(
        "    <string>{}</string>\n",
        xml_escape(&command)
    ));
    for arg in &args {
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
            xml_escape(&expand_tilde(value))
        ));
    }
    environment.push_str(&format!(
        "      <key>WORKSPACE_CONFIG</key>\n      <string>{}</string>\n",
        xml_escape(&workspace_config)
    ));

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
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>{hour}</integer>
    <key>Minute</key>
    <integer>{minute}</integer>
  </dict>
  <key>StartInterval</key>
  <integer>{recovery}</integer>
  <key>ProcessType</key>
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
        label = xml_escape(&label),
        program_arguments = program_arguments,
        work_dir = xml_escape(&work_dir),
        run_at_load = if job.schedule.run_at_load {
            "true"
        } else {
            "false"
        },
        hour = job.schedule.hour,
        minute = job.schedule.minute,
        recovery = job.schedule.recovery_interval_seconds,
        stdout_path = xml_escape(&stdout_path),
        stderr_path = xml_escape(&stderr_path),
        environment = environment,
    ))
}

fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(dirs::home_dir()
        .ok_or_else(|| "Cannot resolve home directory".to_string())?
        .join("Library")
        .join("LaunchAgents"))
}

fn current_uid() -> Result<String, String> {
    let output = Command::new("id")
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
/// the label must carry the `com.maru.job.` prefix and the canonicalized plist
/// must be a direct child of canonicalized `~/Library/LaunchAgents`.
fn guarded_plist_path(label: &str) -> Result<PathBuf, String> {
    if !label.starts_with(JOB_LABEL_PREFIX)
        || label.contains('/')
        || label.contains('\\')
        || label.contains("..")
    {
        return Err(format!("job_label_refused: {label}"));
    }
    let launch_agents = launch_agents_dir()?;
    let canonical_launch_agents = fs::canonicalize(&launch_agents).map_err(|err| {
        format!(
            "launch_agents_missing: {}: {err}",
            launch_agents.to_string_lossy()
        )
    })?;
    let plist = canonical_launch_agents.join(format!("{label}.plist"));
    if plist.exists() {
        let canonical_plist = fs::canonicalize(&plist)
            .map_err(|err| format!("plist_missing: {}: {err}", plist.to_string_lossy()))?;
        if canonical_plist.parent() != Some(canonical_launch_agents.as_path()) {
            return Err("plist_outside_launch_agents".to_string());
        }
        Ok(canonical_plist)
    } else {
        Ok(plist)
    }
}

fn run_launchctl(args: &[&str]) -> Result<String, String> {
    let output = Command::new("launchctl")
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
    let Ok(output) = Command::new("launchctl")
        .arg("print")
        .arg(&target)
        .no_window()
        .output()
    else {
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
    let Ok(output) = Command::new("launchctl")
        .arg("print-disabled")
        .arg(&target)
        .no_window()
        .output()
    else {
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
            !launchd_disabled_labels(&uid).iter().any(|entry| entry == &label)
        } else {
            false
        };
        (print.loaded, enabled, print.last_exit_code)
    } else {
        (false, false, None)
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
        last_exit_code,
        last_run_at: None,
    })
}

pub(crate) fn jobs_list_in(work_path: &Path) -> Result<Vec<JobStatus>, String> {
    let _guard = jobs_guard()?;
    let jobs = load_jobs(work_path)?;
    jobs.jobs
        .iter()
        .map(|job| status_for(job, work_path))
        .collect()
}

pub(crate) fn jobs_install_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    let _guard = jobs_guard()?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
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
    run_launchctl(&["bootstrap", &format!("gui/{uid}"), &plist.to_string_lossy()])?;
    if job.enabled {
        run_launchctl(&["enable", &target])?;
    } else {
        run_launchctl(&["disable", &target])?;
    }
    status_for(job, work_path)
}

pub(crate) fn jobs_uninstall_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    let _guard = jobs_guard()?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    let label = label_for(&job.id, work_path)?;
    let plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;

    // Tolerate not-loaded on bootout.
    let _ = run_launchctl(&["bootout", &format!("gui/{uid}/{label}")]);
    if plist.exists() {
        fs::remove_file(&plist)
            .map_err(|err| format!("plist_remove_failed: {}: {err}", plist.to_string_lossy()))?;
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
    let _guard = jobs_guard()?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    let label = label_for(&job.id, work_path)?;
    let _plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;
    let verb = if enabled { "enable" } else { "disable" };
    run_launchctl(&[verb, &format!("gui/{uid}/{label}")])?;
    status_for(job, work_path)
}

pub(crate) fn jobs_run_now_in(work_path: &Path, job_id: &str) -> Result<JobStatus, String> {
    let _guard = jobs_guard()?;
    let jobs = load_jobs(work_path)?;
    let job = find_job(&jobs, job_id)?;
    let label = label_for(&job.id, work_path)?;
    let _plist = guarded_plist_path(&label)?;
    let uid = current_uid()?;
    run_launchctl(&["kickstart", "-k", &format!("gui/{uid}/{label}")])?;
    status_for(job, work_path)
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

fn tail_lines(path: &Path, max_lines: usize) -> String {
    let Ok(content) = fs::read_to_string(path) else {
        return String::new();
    };
    let lines: Vec<&str> = content.lines().collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

#[tauri::command]
pub fn jobs_list(work_path: String) -> Result<Vec<JobStatus>, String> {
    jobs_list_in(Path::new(&work_path))
}

#[tauri::command]
pub fn jobs_install(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_install_in(Path::new(&work_path), &job_id)
}

#[tauri::command]
pub fn jobs_uninstall(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_uninstall_in(Path::new(&work_path), &job_id)
}

#[tauri::command]
pub fn jobs_start(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_start_in(Path::new(&work_path), &job_id)
}

#[tauri::command]
pub fn jobs_stop(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_stop_in(Path::new(&work_path), &job_id)
}

#[tauri::command]
pub fn jobs_run_now(work_path: String, job_id: String) -> Result<JobStatus, String> {
    jobs_run_now_in(Path::new(&work_path), &job_id)
}

#[tauri::command]
pub fn jobs_read_log(work_path: String, job_id: String) -> Result<JobLogsTail, String> {
    jobs_read_log_in(Path::new(&work_path), &job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

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
                run_at_load: false,
            },
            logs: JobLogs {
                dir: "inbox/_state/mail-digest/.cache/logs".to_string(),
            },
        }
    }

    #[test]
    fn label_is_stable_and_work_path_sensitive() {
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
    }

    #[test]
    fn label_rejects_invalid_job_id_charset() {
        let dir = tempfile::tempdir().unwrap();
        assert!(label_for("Mail_Digest", dir.path()).is_err());
        assert!(label_for("bad id", dir.path()).is_err());
        assert!(label_for("", dir.path()).is_err());
        assert!(label_for("mail-digest-2", dir.path()).is_ok());
    }

    #[test]
    fn guard_refuses_plist_outside_launch_agents() {
        let err = guarded_plist_path("com.maru.job.test.deadbeef/../../etc/evil")
            .unwrap_err();
        assert!(err.starts_with("job_label_refused") || err == "plist_outside_launch_agents");
    }

    #[test]
    fn guard_refuses_foreign_label() {
        let err = guarded_plist_path("com.apple.Safari").unwrap_err();
        assert_eq!(err, "job_label_refused: com.apple.Safari");
    }

    #[test]
    fn plist_expands_tilde_and_resolves_paths() {
        let dir = tempfile::tempdir().unwrap();
        let work = dir.path().join("work");
        fs::create_dir_all(&work).unwrap();
        let job = sample_job();

        let xml = plist_for(&job, &work).unwrap();
        let home = dirs::home_dir().unwrap().to_string_lossy().to_string();

        assert!(!xml.contains("<string>~/"), "no literal ~ in values: {xml}");
        assert!(xml.contains(&format!(
            "<string>{home}/.maru/env/.venv/bin/python3</string>"
        )));
        assert!(xml.contains(&format!(
            "<string>{home}/.local/share/fnm/aliases/default/bin:/usr/bin:/bin</string>"
        )));
        assert!(xml.contains(&format!(
            "<string>{}/_meta/scripts/daily_mail_digest.py</string>",
            work.to_string_lossy()
        )));
        assert!(xml.contains(&format!(
            "<key>WorkingDirectory</key>\n  <string>{}</string>",
            work.to_string_lossy()
        )));
        assert!(xml.contains(&format!(
            "<string>{}/inbox/_state/mail-digest/.cache/logs/stdout.log</string>",
            work.to_string_lossy()
        )));
        assert!(xml.contains(&format!(
            "<string>{}/workspace.config.yaml</string>",
            work.to_string_lossy()
        )));
        assert!(xml.contains(&format!("<key>HOME</key>\n      <string>{home}</string>")));
        assert!(xml.contains("<key>Hour</key>\n    <integer>3</integer>"));
        assert!(xml.contains("<key>Minute</key>\n    <integer>30</integer>"));
        assert!(xml.contains("<key>StartInterval</key>\n  <integer>900</integer>"));
        assert!(xml.contains("<key>RunAtLoad</key>\n  <false/>"));
    }

    #[test]
    fn load_jobs_returns_empty_when_file_absent() {
        let dir = tempfile::tempdir().unwrap();
        let jobs = load_jobs(dir.path()).unwrap();
        assert_eq!(jobs.schema, JOBS_SCHEMA);
        assert!(jobs.jobs.is_empty());
    }

    #[test]
    fn load_jobs_parses_mail_digest_entry() {
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

    #[test]
    fn tail_lines_keeps_last_n_lines() {
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
}
