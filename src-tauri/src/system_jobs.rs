use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde::Serialize;

use crate::win_process::NoWindow;

// System agents are user LaunchAgents Maru does not own. `com.maru.job.*`
// labels stay in the jobs.rs section; this module only observes and toggles
// the rest, so its label guard is the inverse of jobs.rs `validate_label`.
const MANAGED_JOB_PREFIX: &str = "com.maru.job.";
const MAX_AGENTS: usize = 512;
const MAX_CRONTAB_ENTRIES: usize = 512;
const MAX_CRONTAB_LINE: usize = 1024;
// launchctl/PlistBuddy output for a single label is small; the cap guards
// against a pathological plist or a stuck tool streaming forever.
const COMMAND_OUTPUT_CAP: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemAgent {
    pub label: String,
    pub program: String,
    pub plist_path: String,
    pub loaded: bool,
    pub enabled: bool,
    pub pid: Option<i64>,
    pub last_exit_code: Option<i64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SystemJobsOverview {
    pub agents: Vec<SystemAgent>,
    pub crontab: Vec<String>,
}

fn launch_agents_dir() -> Result<PathBuf, String> {
    Ok(crate::skill_host::fs::install_root_base()?
        .join("Library")
        .join("LaunchAgents"))
}

fn system_command(program: &str) -> Command {
    Command::new(program)
}

fn capped_output(output: std::process::Output) -> Result<String, String> {
    if output.stdout.len() > COMMAND_OUTPUT_CAP || output.stderr.len() > COMMAND_OUTPUT_CAP {
        return Err("system_command_output_too_large".to_string());
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn run_tool(program: &str, args: &[&str]) -> Result<String, String> {
    let output = system_command(program)
        .args(args)
        .no_window()
        .output()
        .map_err(|err| format!("system_command_spawn_failed: {program}: {err}"))?;
    if !output.status.success() {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
        return Err(format!(
            "system_command_failed: {} {}: {detail}",
            program,
            args.join(" ")
        ));
    }
    capped_output(output)
}

fn current_uid() -> Result<String, String> {
    let stdout = run_tool("id", &["-u"])?;
    let uid = stdout.trim().to_string();
    if uid.is_empty() {
        return Err("uid_resolve_failed: empty uid".to_string());
    }
    Ok(uid)
}

/// Read a single string key from a plist via PlistBuddy. Returns None when the
/// key is absent or the plist is unreadable; listing degrades to a fallback
/// label/program rather than failing the whole overview.
fn plist_string(plist: &Path, key: &str) -> Option<String> {
    let output = system_command("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(plist)
        .no_window()
        .output()
        .ok()?;
    if !output.status.success() || output.stdout.len() > COMMAND_OUTPUT_CAP {
        return None;
    }
    let value = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

fn program_summary(plist: &Path) -> String {
    plist_string(plist, "ProgramArguments:0")
        .or_else(|| plist_string(plist, "Program"))
        .unwrap_or_default()
}

/// Parse `launchctl print gui/<uid>/<label>` stdout: the service is loaded
/// when the command succeeded, `pid =` appears only while it runs, and
/// `last exit code =` records the most recent exit.
fn parse_launchd_print(stdout: &str) -> (Option<i64>, Option<i64>) {
    let mut pid = None;
    let mut last_exit_code = None;
    for line in stdout.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("pid =") {
            pid = rest.trim().parse::<i64>().ok();
        } else if let Some(rest) = line.strip_prefix("last exit code =") {
            last_exit_code = rest.trim().parse::<i64>().ok();
        }
    }
    (pid, last_exit_code)
}

struct LaunchdPrint {
    loaded: bool,
    pid: Option<i64>,
    last_exit_code: Option<i64>,
}

fn print_launchd_state(uid: &str, label: &str) -> LaunchdPrint {
    let target = format!("gui/{uid}/{label}");
    let Ok(output) = system_command("launchctl")
        .arg("print")
        .arg(&target)
        .no_window()
        .output()
    else {
        return LaunchdPrint {
            loaded: false,
            pid: None,
            last_exit_code: None,
        };
    };
    if !output.status.success() {
        return LaunchdPrint {
            loaded: false,
            pid: None,
            last_exit_code: None,
        };
    }
    let (pid, last_exit_code) = parse_launchd_print(&String::from_utf8_lossy(&output.stdout));
    LaunchdPrint {
        loaded: true,
        pid,
        last_exit_code,
    }
}

/// Labels listed as `=> disabled` in `launchctl print-disabled gui/<uid>`.
fn parse_disabled_labels(stdout: &str) -> Vec<String> {
    stdout
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

fn launchd_disabled_labels(uid: &str) -> Vec<String> {
    let Ok(output) = system_command("launchctl")
        .arg("print-disabled")
        .arg(format!("gui/{uid}"))
        .no_window()
        .output()
    else {
        return Vec::new();
    };
    if !output.status.success() {
        return Vec::new();
    }
    parse_disabled_labels(&String::from_utf8_lossy(&output.stdout))
}

/// Crontab entries are the non-empty, non-comment lines of `crontab -l`; the
/// same indexing drives both the list response and `system_crontab_remove`.
fn parse_crontab_entries(stdout: &str) -> Vec<String> {
    stdout
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .take(MAX_CRONTAB_ENTRIES)
        .map(|line| line.chars().take(MAX_CRONTAB_LINE).collect())
        .collect()
}

fn read_crontab_raw() -> Result<Option<String>, String> {
    let output = system_command("crontab")
        .arg("-l")
        .no_window()
        .output()
        .map_err(|err| format!("crontab_spawn_failed: {err}"))?;
    if output.status.success() {
        if output.stdout.len() > COMMAND_OUTPUT_CAP {
            return Err("crontab_read_failed: output too large".to_string());
        }
        return Ok(Some(String::from_utf8_lossy(&output.stdout).to_string()));
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    if stderr.contains("no crontab") {
        return Ok(None);
    }
    Err(format!("crontab_read_failed: {}", stderr.trim()))
}

fn crontab_entries() -> Result<Vec<String>, String> {
    Ok(read_crontab_raw()?
        .map(|raw| parse_crontab_entries(&raw))
        .unwrap_or_default())
}

fn list_agents() -> Result<Vec<SystemAgent>, String> {
    let dir = launch_agents_dir()?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(err) => {
            return Err(format!(
                "launch_agents_read_failed: {}: {err}",
                dir.to_string_lossy()
            ));
        }
    };
    let mut plists: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().is_some_and(|ext| ext == "plist"))
        .take(MAX_AGENTS)
        .collect();
    plists.sort();

    let uid = current_uid()?;
    let disabled = launchd_disabled_labels(&uid);
    let mut agents = Vec::new();
    for plist in plists {
        let fallback = plist
            .file_stem()
            .map(|stem| stem.to_string_lossy().to_string())
            .unwrap_or_default();
        let label = plist_string(&plist, "Label").unwrap_or(fallback);
        if label.starts_with(MANAGED_JOB_PREFIX) {
            continue;
        }
        let print = print_launchd_state(&uid, &label);
        agents.push(SystemAgent {
            enabled: !disabled.iter().any(|entry| entry == &label),
            loaded: print.loaded,
            pid: print.pid,
            last_exit_code: print.last_exit_code,
            program: program_summary(&plist),
            plist_path: plist.to_string_lossy().to_string(),
            label,
        });
    }
    agents.sort_by(|a, b| a.label.cmp(&b.label));
    Ok(agents)
}

/// Label guard for the toggle/run commands, deliberately separate from the
/// jobs.rs guard: safe charset, never a Maru-managed `com.maru.job.*` label,
/// and a plist for it must exist in ~/Library/LaunchAgents.
fn validate_system_label(label: &str) -> Result<(), String> {
    let valid = !label.is_empty()
        && label
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_');
    if !valid || label.starts_with(MANAGED_JOB_PREFIX) {
        return Err(format!("system_job_label_refused: {label}"));
    }
    Ok(())
}

fn guarded_system_plist(label: &str) -> Result<PathBuf, String> {
    validate_system_label(label)?;
    let plist = launch_agents_dir()?.join(format!("{label}.plist"));
    if !plist.is_file() {
        return Err(format!("system_job_plist_missing: {label}"));
    }
    Ok(plist)
}

fn system_job_set_enabled_in(label: &str, enabled: bool) -> Result<SystemAgent, String> {
    let plist = guarded_system_plist(label)?;
    let uid = current_uid()?;
    let target = format!("gui/{uid}/{label}");
    run_tool(
        "launchctl",
        &[if enabled { "enable" } else { "disable" }, &target],
    )?;
    agent_status(label, &plist, &uid)
}

fn system_job_run_now_in(label: &str) -> Result<SystemAgent, String> {
    let plist = guarded_system_plist(label)?;
    let uid = current_uid()?;
    run_tool(
        "launchctl",
        &["kickstart", "-k", &format!("gui/{uid}/{label}")],
    )?;
    agent_status(label, &plist, &uid)
}

fn agent_status(label: &str, plist: &Path, uid: &str) -> Result<SystemAgent, String> {
    let print = print_launchd_state(uid, label);
    let enabled = !launchd_disabled_labels(uid)
        .iter()
        .any(|entry| entry == label);
    Ok(SystemAgent {
        label: label.to_string(),
        program: program_summary(plist),
        plist_path: plist.to_string_lossy().to_string(),
        loaded: print.loaded,
        enabled,
        pid: print.pid,
        last_exit_code: print.last_exit_code,
    })
}

/// Rewrite the crontab without the entry at `index`, where indexes count the
/// same non-empty/non-comment lines `parse_crontab_entries` returns. Comments
/// and blank lines are preserved verbatim. `expected` must match the listed
/// entry text so a crontab changed since the last list cannot shift a
/// different entry into the confirmed slot.
fn remove_crontab_entry(raw: &str, index: u32, expected: &str) -> Result<String, String> {
    let mut seen = 0u32;
    let mut kept = Vec::new();
    let mut removed = false;
    for line in raw.lines() {
        let trimmed = line.trim();
        let is_entry = !trimmed.is_empty() && !trimmed.starts_with('#');
        if is_entry {
            if seen == index {
                let listed: String = trimmed.chars().take(MAX_CRONTAB_LINE).collect();
                if listed != expected {
                    return Err("crontab_entry_mismatch: refresh and retry".to_string());
                }
                removed = true;
                seen += 1;
                continue;
            }
            seen += 1;
        }
        kept.push(line);
    }
    if !removed {
        return Err(format!("crontab_index_out_of_range: {index}"));
    }
    let mut rewritten = kept.join("\n");
    if raw.ends_with('\n') {
        rewritten.push('\n');
    }
    Ok(rewritten)
}

fn system_crontab_remove_in(index: u32, expected: &str) -> Result<Vec<String>, String> {
    let raw = read_crontab_raw()?.ok_or("crontab_missing: no crontab for user")?;
    let rewritten = remove_crontab_entry(&raw, index, expected)?;
    let mut child = system_command("crontab")
        .arg("-")
        .no_window()
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|err| format!("crontab_spawn_failed: {err}"))?;
    child
        .stdin
        .as_mut()
        .ok_or("crontab_write_failed: stdin unavailable")?
        .write_all(rewritten.as_bytes())
        .map_err(|err| format!("crontab_write_failed: {err}"))?;
    let output = child
        .wait_with_output()
        .map_err(|err| format!("crontab_write_failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "crontab_write_failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(parse_crontab_entries(&rewritten))
}

pub fn system_jobs_list() -> Result<SystemJobsOverview, String> {
    Ok(SystemJobsOverview {
        agents: list_agents()?,
        crontab: crontab_entries()?,
    })
}

pub fn system_job_set_enabled(label: String, enabled: bool) -> Result<SystemAgent, String> {
    system_job_set_enabled_in(&label, enabled)
}

pub fn system_job_run_now(label: String) -> Result<SystemAgent, String> {
    system_job_run_now_in(&label)
}

pub fn system_crontab_remove(index: u32, expected: String) -> Result<Vec<String>, String> {
    system_crontab_remove_in(index, &expected)
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn system_jobs_list() -> Result<SystemJobsOverview, String> {
        tauri::async_runtime::spawn_blocking(super::system_jobs_list)
            .await
            .map_err(|err| format!("system_jobs_list_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn system_job_set_enabled(
        label: String,
        enabled: bool,
    ) -> Result<SystemAgent, String> {
        tauri::async_runtime::spawn_blocking(move || super::system_job_set_enabled(label, enabled))
            .await
            .map_err(|err| format!("system_job_set_enabled_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn system_job_run_now(label: String) -> Result<SystemAgent, String> {
        tauri::async_runtime::spawn_blocking(move || super::system_job_run_now(label))
            .await
            .map_err(|err| format!("system_job_run_now_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn system_crontab_remove(
        index: u32,
        expected: String,
    ) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || super::system_crontab_remove(index, expected))
            .await
            .map_err(|err| format!("system_crontab_remove_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_launchd_print_extracts_pid_and_exit_code() {
        let sample = "com.vendor.agent = {\n\tpid = 4812\n\tlast exit code = 0\n}\n";
        assert_eq!(parse_launchd_print(sample), (Some(4812), Some(0)));
        let not_running = "com.vendor.agent = {\n\tlast exit code = 78\n\tstate = not running\n}\n";
        assert_eq!(parse_launchd_print(not_running), (None, Some(78)));
        let never_ran = "com.vendor.agent = {\n\tstate = waiting\n}\n";
        assert_eq!(parse_launchd_print(never_ran), (None, None));
        let never_exited =
            "com.vendor.agent = {\n\tlast exit code = (never exited)\n\tpid = 7\n}\n";
        assert_eq!(parse_launchd_print(never_exited), (Some(7), None));
    }

    #[test]
    fn parse_disabled_labels_collects_only_disabled_entries() {
        let sample = "\"com.vendor.off\" => disabled\n\"com.vendor.on\" => enabled\ncom.plain.off => disabled\n";
        assert_eq!(
            parse_disabled_labels(sample),
            vec!["com.vendor.off".to_string(), "com.plain.off".to_string()]
        );
        assert!(parse_disabled_labels("").is_empty());
    }

    #[test]
    fn parse_crontab_entries_skips_comments_and_blank_lines() {
        let sample = "# comment\n\n0 3 * * * /usr/bin/true\n   \n  */15 * * * * echo hi  \n#0 0 * * * disabled-job\n";
        assert_eq!(
            parse_crontab_entries(sample),
            vec![
                "0 3 * * * /usr/bin/true".to_string(),
                "*/15 * * * * echo hi".to_string()
            ]
        );
        assert!(parse_crontab_entries("# only comments\n\n").is_empty());
    }

    #[test]
    fn validate_system_label_accepts_plain_labels_and_refuses_unsafe_ones() {
        assert!(validate_system_label("com.dotfiles.sync").is_ok());
        assert!(validate_system_label("ai.jeju.relay-worker_2").is_ok());
        for bad in [
            "",
            "com.maru.job.mail-digest.deadbeef",
            "com.vendor/agent",
            "com.vendor\\agent",
            "../etc",
            "com.vendor agent",
            "com.vendor;rm",
        ] {
            assert!(
                validate_system_label(bad).is_err(),
                "label must be refused: {bad}"
            );
        }
        assert_eq!(
            validate_system_label("com.maru.job.x.y").unwrap_err(),
            "system_job_label_refused: com.maru.job.x.y"
        );
    }

    #[test]
    fn guarded_system_plist_requires_existing_plist() {
        let err = guarded_system_plist("com.vendor.definitely-absent").unwrap_err();
        assert!(
            err == "system_job_plist_missing: com.vendor.definitely-absent"
                || err.starts_with("launch_agents"),
            "{err}"
        );
        assert!(guarded_system_plist("com.maru.job.test.deadbeef").is_err());
    }

    #[test]
    fn remove_crontab_entry_drops_only_the_indexed_entry() {
        let raw = "# header\n0 3 * * * /usr/bin/true\n\n*/15 * * * * echo hi\n# tail\n";
        let rewritten = remove_crontab_entry(raw, 1, "*/15 * * * * echo hi").unwrap();
        assert_eq!(rewritten, "# header\n0 3 * * * /usr/bin/true\n\n# tail\n");
        assert_eq!(
            parse_crontab_entries(&rewritten),
            vec!["0 3 * * * /usr/bin/true".to_string()]
        );
        let first = remove_crontab_entry(raw, 0, "0 3 * * * /usr/bin/true").unwrap();
        assert!(!first.contains("/usr/bin/true"));
        assert!(
            first.ends_with('\n'),
            "trailing newline preserved: {first:?}"
        );
    }

    #[test]
    fn remove_crontab_entry_rejects_stale_expected_text() {
        let raw = "0 3 * * * /usr/bin/true\n*/15 * * * * echo hi\n";
        assert_eq!(
            remove_crontab_entry(raw, 1, "0 4 * * * /usr/bin/false").unwrap_err(),
            "crontab_entry_mismatch: refresh and retry"
        );
    }

    #[test]
    fn remove_crontab_entry_rejects_out_of_range_index() {
        let raw = "0 3 * * * /usr/bin/true\n";
        assert_eq!(
            remove_crontab_entry(raw, 1, "0 3 * * * /usr/bin/true").unwrap_err(),
            "crontab_index_out_of_range: 1"
        );
        assert!(remove_crontab_entry("", 0, "").is_err());
    }
}
