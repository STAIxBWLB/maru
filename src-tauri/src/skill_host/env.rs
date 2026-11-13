use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::atomic_file::{PathTransactionLease, PathTransactionParent, PathTransactionRequest};
use crate::skill_host::fs as host_fs;
use crate::skill_host::store::default_public_env_setup;
use crate::win_process::NoWindow;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillsEnvStatus {
    pub root: String,
    pub venv_path: String,
    pub venv_exists: bool,
    pub node_modules_path: String,
    pub node_modules_exists: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub setup_script: Option<String>,
    pub status_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_bootstrap_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub healthy: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvOutputEvent {
    invocation_id: String,
    stream: String,
    line: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EnvDoneEvent {
    invocation_id: String,
    success: bool,
    exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// Resolve before admission. The setup directory owns uv/pnpm lockfiles and
/// installation metadata; it must not be collapsed to the skills registry root.
pub(crate) fn env_mutation_paths(root: &Path, setup: Option<&Path>) -> Vec<PathBuf> {
    let mut paths = vec![root.to_path_buf()];
    paths.extend(
        [
            ".venv",
            "node_modules",
            "node",
            "status.json",
            ".maru-env-complete",
            "input/hwp",
            "input/pdf",
            "output/text",
            "output/tables",
            "output/images",
            "temp",
            "logs",
            ".cache",
        ]
        .into_iter()
        .map(|name| root.join(name)),
    );
    if root
        .parent()
        .and_then(Path::file_name)
        .is_some_and(|name| name == "env")
    {
        paths.extend(host_fs::hash_env_repair_paths(root));
    }
    if let Some(project) = setup.and_then(Path::parent) {
        paths.extend([
            project.to_path_buf(),
            project.join("uv.lock"),
            project.join("pnpm-lock.yaml"),
            project.join("node_modules"),
        ]);
    }
    paths
}

/// Shared by the synchronous store repair and detached bootstrap. The caller
/// creates root/temp under its lease before launching the command.
pub(crate) fn configure_env_command(command: &mut Command, root: &Path) {
    #[cfg(test)]
    command.env_remove("BASH_ENV").env_remove("ENV");
    // A Finder-launched app inherits launchd's bare PATH, where setup.sh cannot
    // see uv, brew, or pnpm (#414).
    command
        .env("PATH", crate::cli_path::augmented_path())
        .env("TMPDIR", root.join("temp"))
        .env("UV_CACHE_DIR", root.join(".cache/uv"))
        .env("UV_PYTHON_INSTALL_DIR", root.join(".cache/python"))
        .env("XDG_CACHE_HOME", root.join(".cache"))
        .env("npm_config_cache", root.join(".cache/npm"))
        .env("npm_config_store_dir", root.join(".cache/pnpm"));
}

fn env_parent_snapshot(root: &Path) -> Result<PathTransactionParent, String> {
    let parent = root
        .ancestors()
        .find(|path| path.is_dir())
        .ok_or_else(|| "Environment has no existing parent".to_string())?;
    PathTransactionParent::capture(parent)
}

pub fn skills_env_status(work_path: Option<String>) -> Result<SkillsEnvStatus, String> {
    // Materializing defaults owns a separate, finite store transaction. Never
    // call it while the environment subprocess owns its network lease.
    let (root, warnings) = host_fs::env_root_with_warnings()?;
    let parent = env_parent_snapshot(&root)?;
    let setup = default_public_env_setup(work_path.as_deref())?;
    let lease = PathTransactionRequest::new(env_mutation_paths(&root, None))?
        .require_parent_snapshot(&parent)?
        .acquire()?;
    let mut status = env_status_in_transaction(&lease, &root, setup.as_deref(), None)?;
    if !warnings.is_empty() {
        let mut messages: Vec<String> = status.last_error.take().into_iter().collect();
        messages.extend(warnings);
        status.last_error = Some(messages.join("\n"));
    }
    Ok(status)
}

pub fn skills_env_bootstrap<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: Option<String>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    let root = host_fs::env_root()?;
    let parent = env_parent_snapshot(&root)?;
    let setup = default_public_env_setup(work_path.as_deref())?;
    let lease = PathTransactionRequest::new(env_mutation_paths(&root, setup.as_deref()))?
        .require_parent_snapshot(&parent)?
        .acquire()?;
    bootstrap_in_transaction(app, root, setup, dry_run.unwrap_or(false), lease)
}

/// Receives each setup output line with its stream name ("stdout"/"stderr").
pub type EnvOutputSink = Arc<dyn Fn(&str, String) + Send + Sync>;

/// Result of one environment bootstrap, shared by the app and the CLI.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EnvBootstrapOutcome {
    pub root: String,
    pub success: bool,
    pub exit_code: Option<i32>,
    /// Setup failure cause (exit status, spawn or stream failure).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setup_error: Option<String>,
    /// Failure to persist the completion marker or status after setup ran.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_error: Option<String>,
}

/// Runtime-free bootstrap: either settled without a setup run, or a setup
/// run that owns the lease and the repair lock until it finishes.
pub(crate) enum EnvBootstrapJob {
    Settled(EnvBootstrapOutcome),
    Setup(EnvSetupRun),
}

pub(crate) struct EnvSetupRun {
    root: PathBuf,
    setup: PathBuf,
    lease: PathTransactionLease,
    repair_lock: Option<fs::File>,
    completion_marker: Option<PathBuf>,
    /// CLI repair only: the prior hashed env, moved aside to `<root>.prev`.
    backup: Option<PathBuf>,
}

/// Synchronous preflight shared by `skills_env_bootstrap` and `maru skills env repair`.
/// `preserve` (CLI repair) moves an existing hashed env aside so setup builds
/// from empty and a failure restores it exactly; the app passes `false`.
pub(crate) fn prepare_env_bootstrap(
    root: PathBuf,
    setup: Option<PathBuf>,
    dry_run: bool,
    preserve: bool,
    lease: PathTransactionLease,
) -> Result<EnvBootstrapJob, String> {
    lease.ensure_covered(env_mutation_paths(&root, setup.as_deref()))?;
    lease.before_effect()?;
    host_fs::ensure_dir(&root)?;
    if dry_run || setup.is_none() {
        if !dry_run {
            host_fs::ensure_dir(&root.join(".venv"))?;
        }
        write_status_in_transaction(&lease, &root, None, None)?;
        return Ok(EnvBootstrapJob::Settled(EnvBootstrapOutcome {
            root: host_fs::display_path(&root),
            success: true,
            exit_code: Some(0),
            setup_error: None,
            completion_error: None,
        }));
    }
    let setup = setup.expect("setup checked above");
    let repair_lock = host_fs::lock_direct_hash_env_repair(&lease, &root)?;
    // The repair lock refused a pending `<root>.prev`, so the aside slot is free.
    let backup = if preserve && repair_lock.is_some() {
        let backup = root.with_extension("prev");
        lease.ensure_covered([backup.clone()])?;
        lease.before_effect()?;
        fs::rename(&root, &backup).map_err(|error| {
            host_fs::operation_error("move the prior environment aside", &backup, error)
        })?;
        if let Err(error) = host_fs::ensure_dir(&root) {
            let restore = fs::rename(&backup, &root).err();
            return Err(match restore {
                None => format!("{error}; the prior env was restored"),
                Some(restore) => format!(
                    "{error}; restoring the prior env failed ({restore}); its bytes remain at {}",
                    host_fs::display_path(&backup)
                ),
            });
        }
        Some(backup)
    } else {
        None
    };
    let prepared = prepare_hashed_completion_marker(&lease, &root)
        .and_then(|marker| host_fs::ensure_dir(&root.join("temp")).map(|_| marker));
    let completion_marker = match prepared {
        Ok(marker) => marker,
        Err(error) => {
            return Err(
                match backup.as_deref().map(|b| restore_env_backup(&root, b)) {
                    Some(Err(restore)) => format!("{error}; {restore}"),
                    Some(Ok(())) => format!("{error}; the prior env was restored"),
                    None => error,
                },
            )
        }
    };
    Ok(EnvBootstrapJob::Setup(EnvSetupRun {
        root,
        setup,
        lease,
        repair_lock,
        completion_marker,
        backup,
    }))
}

impl EnvSetupRun {
    /// Blocks until setup exits and its outcome is persisted; releases the lease.
    pub(crate) fn run(self, on_output: EnvOutputSink) -> EnvBootstrapOutcome {
        let EnvSetupRun {
            root,
            setup,
            lease,
            repair_lock,
            completion_marker,
            backup,
        } = self;
        #[cfg(all(test, unix))]
        let mut cmd = Command::new("/bin/bash");
        #[cfg(not(all(test, unix)))]
        let mut cmd = Command::new("bash");
        cmd.arg(setup)
            .arg("--target")
            .arg(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window();
        configure_env_command(&mut cmd, &root);
        let (success, exit_code, error) = match cmd.spawn() {
            Ok(mut child) => {
                let stdout = child
                    .stdout
                    .take()
                    .map(|source| pump(on_output.clone(), "stdout", source));
                let stderr = child
                    .stderr
                    .take()
                    .map(|source| pump(on_output.clone(), "stderr", source));
                let result = child.wait();
                // A failed wait must still settle the owned child before release.
                if result.is_err() {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                let streams_ok = [stdout, stderr]
                    .into_iter()
                    .flatten()
                    .map(|reader| reader.join().is_ok())
                    .fold(true, |ok, joined| ok & joined);
                match result {
                    Ok(status) => {
                        let success = status.success() && streams_ok;
                        let error = if !status.success() {
                            Some(format!("env_bootstrap_exit: {:?}", status.code()))
                        } else if !streams_ok {
                            Some("env_bootstrap_stream_failed".to_string())
                        } else {
                            None
                        };
                        (success, status.code(), error)
                    }
                    Err(err) => (false, None, Some(err.to_string())),
                }
            }
            Err(err) => (false, None, Some(err.to_string())),
        };
        #[cfg(test)]
        PathTransactionLease::test_stage(&[root.clone()], "env:before-status");
        let completion_error = match finish_bootstrap_in_transaction(
            &lease,
            &root,
            completion_marker.as_deref(),
            success,
            error.clone(),
        ) {
            Ok(()) => None,
            Err(error) => {
                on_output("stderr", error.clone());
                let _ =
                    write_status_in_transaction(&lease, &root, Some(false), Some(error.clone()));
                Some(error)
            }
        };
        let succeeded = success && completion_error.is_none();
        // Settle the aside copy while the lease and repair lock are still held.
        let completion_error = match backup.as_deref() {
            Some(backup) if succeeded => fs::remove_dir_all(backup).err().map(|error| {
                format!(
                    "{}; the repaired env is complete, and Maru removes this leftover copy on its next env check",
                    host_fs::operation_error(
                        "remove the prior environment after a successful repair",
                        backup,
                        error,
                    )
                )
            }),
            Some(backup) => {
                let restored = restore_env_backup(&root, backup);
                let note = match restored {
                    Ok(()) => "the prior env was restored".to_string(),
                    Err(error) => error,
                };
                Some(match completion_error {
                    Some(error) => format!("{error}; {note}"),
                    None => note,
                })
            }
            None => completion_error,
        };
        drop(repair_lock);
        drop(lease);
        EnvBootstrapOutcome {
            root: host_fs::display_path(&root),
            success: succeeded && completion_error.is_none(),
            exit_code,
            setup_error: error,
            completion_error,
        }
    }
}

/// The owned lease moves to the detached worker, never to a borrowed callback.
fn bootstrap_in_transaction<R: tauri::Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    setup: Option<PathBuf>,
    dry_run: bool,
    lease: PathTransactionLease,
) -> Result<String, String> {
    let invocation_id = format!("skills-env-{}", Uuid::new_v4());
    let run = match prepare_env_bootstrap(root, setup, dry_run, false, lease)? {
        EnvBootstrapJob::Settled(outcome) => {
            let _ = app.emit("skills-env://done", done_event(&invocation_id, &outcome));
            return Ok(invocation_id);
        }
        EnvBootstrapJob::Setup(run) => run,
    };
    let id = invocation_id.clone();
    thread::spawn(move || {
        let emitter = app.clone();
        let output_id = id.clone();
        let sink: EnvOutputSink = Arc::new(move |stream, line| {
            let _ = emitter.emit(
                "skills-env://output",
                EnvOutputEvent {
                    invocation_id: output_id.clone(),
                    stream: stream.to_string(),
                    line,
                },
            );
        });
        let outcome = run.run(sink);
        let _ = app.emit("skills-env://done", done_event(&id, &outcome));
    });
    Ok(invocation_id)
}

/// Put the env moved aside before a CLI repair back exactly as it was.
fn restore_env_backup(root: &Path, backup: &Path) -> Result<(), String> {
    let failed = |action: &str, path: &Path, error: std::io::Error| {
        format!(
            "{}; the prior env bytes remain at {}",
            host_fs::operation_error(action, path, error),
            host_fs::display_path(backup)
        )
    };
    match fs::remove_dir_all(root) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => return Err(failed("remove the failed repair attempt", root, error)),
    }
    fs::rename(backup, root).map_err(|error| failed("restore the prior environment", backup, error))
}

fn done_event(invocation_id: &str, outcome: &EnvBootstrapOutcome) -> EnvDoneEvent {
    EnvDoneEvent {
        invocation_id: invocation_id.to_string(),
        success: outcome.success,
        exit_code: outcome.exit_code,
        error: outcome.completion_error.clone(),
    }
}

/// Refusal prefix when the active env is already complete and `force` is off.
pub const ENV_REPAIR_NOT_NEEDED: &str = "skills_env_healthy";

/// `maru skills env repair`: rebuild the active env with the same core as the
/// app's Bootstrap button, on the calling thread. Setup clears the completion
/// marker before it runs, so a failed run on a complete env would leave it
/// worse (maru#608 AC4): without `force`, a complete env is refused.
pub fn skills_env_repair_headless(
    work_path: Option<String>,
    force: bool,
    on_output: EnvOutputSink,
) -> Result<EnvBootstrapOutcome, String> {
    let root = host_fs::env_root()?;
    // Only a hashed env can be moved aside to `<hash>.prev`; the legacy root
    // is the parent of every hashed env, so a failure could not be undone.
    if !host_fs::is_hashed_env_root(&root)? {
        return Err(format!(
            "skills_env_legacy_layout: the active env uses the legacy layout {}, which repair cannot back up, so nothing was changed. Run `maru skills update --apply` to move to a hashed env, or use Settings > Skills > Bootstrap",
            host_fs::display_path(&root)
        ));
    }
    if !force && env_is_complete(&root)? {
        return Err(format!(
            "{ENV_REPAIR_NOT_NEEDED}: the active skills env {} is complete; nothing to repair. Use `maru skills env repair --force` to rebuild it anyway (a failed rebuild restores the current env)",
            host_fs::display_path(&root)
        ));
    }
    let parent = env_parent_snapshot(&root)?;
    let setup = default_public_env_setup(work_path.as_deref())?;
    let lease = PathTransactionRequest::new(env_mutation_paths(&root, setup.as_deref()))?
        .require_parent_snapshot(&parent)?
        .acquire()?;
    if setup.is_none() {
        return Err(format!(
            "skills_env_setup_missing: no env setup script found for {}; run `maru skills update --apply` or `maru skills sync --apply` to restore the bundled skills, then retry `maru skills env repair`",
            host_fs::display_path(&root)
        ));
    }
    Ok(
        match prepare_env_bootstrap(root, setup, false, true, lease)? {
            EnvBootstrapJob::Settled(outcome) => outcome,
            EnvBootstrapJob::Setup(run) => run.run(on_output),
        },
    )
}

/// The same health rule as `skills_env_status`: a `.venv`, plus the
/// completion marker for a hashed env.
fn env_is_complete(root: &Path) -> Result<bool, String> {
    Ok(root.join(".venv").is_dir()
        && (!host_fs::is_hashed_env_root(root)? || root.join(".maru-env-complete").is_file()))
}

/// Read-only: the repair hint when the active hashed env is missing,
/// incomplete (no `.maru-env-complete`) or has no `.venv`. Never creates or
/// recovers anything, so doctor and `--check` stay diagnostic.
pub fn active_env_repair_hint() -> Option<String> {
    let state = crate::skill_host::bundle_update::read_state().ok()??;
    let active = state.active?;
    if active.env_hash.is_empty() {
        return None;
    }
    let root = host_fs::hashed_env_root(&active.env_hash).ok()?;
    let problem = if !root.is_dir() {
        if !crate::skill_host::store::bundle_uses_hashed_env(&active.bundle_id).unwrap_or(false) {
            return None;
        }
        "is missing"
    } else if !root.join(".venv").is_dir() {
        "has no .venv"
    } else if !root.join(".maru-env-complete").is_file() {
        "is incomplete (no .maru-env-complete)"
    } else {
        return None;
    };
    Some(format!(
        "active skills env {} {problem}; run `maru skills env repair`",
        host_fs::display_path(&root)
    ))
}

pub fn skills_env_repair<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: Option<String>,
) -> Result<String, String> {
    skills_env_bootstrap(app, work_path, Some(false))
}

fn prepare_hashed_completion_marker(
    lease: &PathTransactionLease,
    root: &Path,
) -> Result<Option<PathBuf>, String> {
    if !host_fs::is_hashed_env_root(root)? {
        return Ok(None);
    }
    let marker = root.join(".maru-env-complete");
    lease.ensure_covered([marker.clone()]).map_err(|error| {
        host_fs::operation_error("admit environment completion marker", &marker, error)
    })?;
    match fs::remove_file(&marker) {
        Ok(()) => (),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
        Err(error) => {
            return Err(host_fs::operation_error(
                "clear environment completion marker",
                &marker,
                error,
            ))
        }
    }
    Ok(Some(marker))
}

fn finish_bootstrap_in_transaction(
    lease: &PathTransactionLease,
    root: &Path,
    marker: Option<&Path>,
    success: bool,
    error: Option<String>,
) -> Result<(), String> {
    if let Some(marker) = marker.filter(|_| success) {
        lease
            .ensure_covered([marker.to_path_buf()])
            .and_then(|_| lease.before_effect())
            .map_err(|error| {
                host_fs::operation_error("admit environment completion marker", marker, error)
            })?;
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(marker)
            .map(|_| ())
            .map_err(|error| {
                host_fs::operation_error("mark hashed environment complete", marker, error)
            })?;
    }
    write_status_in_transaction(lease, root, Some(success), error).map_err(|error| {
        host_fs::operation_error(
            "record environment setup status",
            &root.join("status.json"),
            error,
        )
    })
}

pub(crate) fn env_status_in_transaction(
    lease: &PathTransactionLease,
    root: &Path,
    setup: Option<&Path>,
    last_error_override: Option<String>,
) -> Result<SkillsEnvStatus, String> {
    lease.ensure_covered(env_mutation_paths(root, None))?;
    lease.before_effect()?;
    host_fs::ensure_dir(root)?;
    let venv_path = root.join(".venv");
    let node_modules_path = root.join("node_modules");
    let status_path = root.join("status.json");
    let setup_script = setup.map(host_fs::display_path);
    let (last_bootstrap_at, last_error) = read_status(&status_path).unwrap_or((None, None));
    let last_error = last_error_override.or(last_error);
    let venv_exists = venv_path.is_dir();
    let node_modules_exists = node_modules_path.is_dir();
    Ok(SkillsEnvStatus {
        root: host_fs::display_path(root),
        venv_path: host_fs::display_path(&venv_path),
        venv_exists,
        node_modules_path: host_fs::display_path(&node_modules_path),
        node_modules_exists,
        setup_script,
        status_path: host_fs::display_path(&status_path),
        last_bootstrap_at,
        last_error,
        healthy: venv_exists
            && (!host_fs::is_hashed_env_root(root)? || root.join(".maru-env-complete").is_file()),
    })
}

fn pump<S>(on_output: EnvOutputSink, stream: &str, source: S) -> thread::JoinHandle<()>
where
    S: std::io::Read + Send + 'static,
{
    let stream = stream.to_string();
    thread::spawn(move || {
        use std::io::{BufRead, BufReader};
        let reader = BufReader::new(source);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            on_output(&stream, line);
        }
    })
}

fn write_status_in_transaction(
    lease: &PathTransactionLease,
    root: &Path,
    success: Option<bool>,
    error: Option<String>,
) -> Result<(), String> {
    lease.ensure_covered(env_mutation_paths(root, None))?;
    lease.before_effect()?;
    host_fs::ensure_dir(root)?;
    let status = serde_json::json!({
        "lastBootstrapAt": Utc::now().to_rfc3339(),
        "success": success.unwrap_or(true),
        "lastError": error,
    });
    host_fs::write_json_pretty(&root.join("status.json"), &status)
}

fn read_status(path: &std::path::Path) -> Result<(Option<String>, Option<String>), String> {
    if !path.is_file() {
        return Ok((None, None));
    }
    let content = fs::read_to_string(path)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(path)))?;
    let value: serde_json::Value = serde_json::from_str(&content)
        .map_err(|err| format!("Cannot parse {}: {err}", host_fs::display_path(path)))?;
    Ok((
        value
            .get("lastBootstrapAt")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
        value
            .get("lastError")
            .and_then(serde_json::Value::as_str)
            .map(ToString::to_string),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn status_shape_serializes_camel_case() {
        let status = SkillsEnvStatus {
            root: "/tmp/env".to_string(),
            venv_path: "/tmp/env/.venv".to_string(),
            venv_exists: true,
            node_modules_path: "/tmp/env/node_modules".to_string(),
            node_modules_exists: false,
            setup_script: None,
            status_path: "/tmp/env/status.json".to_string(),
            last_bootstrap_at: None,
            last_error: None,
            healthy: true,
        };
        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("venvExists"));
        assert!(json.contains("statusPath"));
    }

    #[test]
    fn env_command_path_reaches_user_tool_dirs() {
        let mut command = Command::new("bash");
        configure_env_command(&mut command, Path::new("/tmp/env"));
        let path = command
            .get_envs()
            .find(|(key, _)| *key == "PATH")
            .and_then(|(_, value)| value)
            .expect("env command sets PATH");
        let dirs: Vec<PathBuf> = std::env::split_paths(path).collect();
        for dir in crate::cli_path::extra_path_dirs() {
            assert!(dirs.contains(&dir), "{} missing from PATH", dir.display());
        }
    }
}

/// Only finite setup occupies the blocking pool; readers and child waits own dedicated threads.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn skills_env_status(work_path: Option<String>) -> Result<SkillsEnvStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            phase08_04::at_edge("skills_env_status");
            #[cfg(test)]
            PathTransactionLease::test_stage(&[host_fs::env_root()?], "worker:skills_env_status");
            crate::skill_host::skills_env_status(work_path)
        })
        .await
        .map_err(|err| format!("skills_env_status_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn skills_env_bootstrap<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: Option<String>,
        dry_run: Option<bool>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            phase08_04::at_edge("skills_env_bootstrap");
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[host_fs::env_root()?],
                "worker:skills_env_bootstrap",
            );
            crate::skill_host::skills_env_bootstrap(app, work_path, dry_run)
        })
        .await
        .map_err(|err| format!("skills_env_bootstrap_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn skills_env_repair<R: tauri::Runtime>(
        app: AppHandle<R>,
        work_path: Option<String>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            phase08_04::at_edge("skills_env_repair");
            #[cfg(test)]
            PathTransactionLease::test_stage(&[host_fs::env_root()?], "worker:skills_env_repair");
            crate::skill_host::skills_env_repair(app, work_path)
        })
        .await
        .map_err(|err| format!("skills_env_repair_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_04 {
    use super::*;
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    type Hook = Arc<dyn Fn(&str) + Send + Sync>;
    static HOOK: Mutex<Option<Hook>> = Mutex::new(None);
    pub(super) fn at_edge(name: &str) {
        let hook = HOOK.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook(name);
        }
    }
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            *HOOK.lock().unwrap() = None;
        }
    }
    fn worker<T: Send + 'static>(
        name: &'static str,
        future: impl std::future::Future<Output = Result<T, String>> + Send + 'static,
    ) {
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        *HOOK.lock().unwrap() = Some(Arc::new(move |edge| {
            if edge == name {
                entered_tx.send(std::thread::current().id()).unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                panic!("fixture boundary panic");
            }
        }));
        let _reset = Reset;
        let (caller_tx, caller_rx) = mpsc::channel();
        let task = tauri::async_runtime::spawn(async move {
            caller_tx.send(std::thread::current().id()).unwrap();
            future.await
        });
        let entered = entered_rx.recv_timeout(Duration::from_secs(5));
        let caller = caller_rx.recv_timeout(Duration::from_secs(5));
        let (probe_tx, probe_rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            probe_tx.send(()).unwrap();
        });
        let progress = probe_rx.recv_timeout(Duration::from_secs(2));
        let _ = release_tx.send(());
        let result = tauri::async_runtime::block_on(task).unwrap();
        assert!(progress.is_ok(), "{name}: async progress stalled");
        assert_ne!(
            entered.unwrap(),
            caller.unwrap(),
            "{name}: shared async thread"
        );
        assert!(matches!(result, Err(ref e) if e.starts_with(&format!("{name}_task_failed:"))));
    }

    #[test]
    fn every_environment_wrapper_uses_blocking_worker_and_preserves_join_error() {
        let _home = host_fs::test_home_for_bundle_tests();
        let app = tauri::test::mock_app();
        worker("skills_env_status", ipc::skills_env_status(None));
        worker(
            "skills_env_bootstrap",
            ipc::skills_env_bootstrap(app.handle().clone(), None, Some(true)),
        );
        worker(
            "skills_env_repair",
            ipc::skills_env_repair(app.handle().clone(), None),
        );
    }
    #[test]
    #[cfg(unix)]
    fn env_status_displays_backup_cleanup_warning_without_persisting_it() {
        use std::os::unix::fs::PermissionsExt;
        let _home = host_fs::test_home_for_bundle_tests();
        crate::skill_host::store::skills_list_sources(None).unwrap();
        let active = crate::skill_host::bundle_update::read_state()
            .unwrap()
            .unwrap()
            .active
            .unwrap();
        let root = host_fs::hashed_env_root(&active.env_hash).unwrap();
        fs::create_dir_all(root.join(".venv")).unwrap();
        fs::write(root.join(".maru-env-complete"), "").unwrap();
        let status_path = root.join("status.json");
        let saved = r#"{"lastError":"previous setup diagnostic"}"#;
        fs::write(&status_path, saved).unwrap();
        let backup = root.with_extension("prev");
        fs::create_dir_all(&backup).unwrap();
        fs::write(backup.join("keep"), "old runtime").unwrap();
        let permissions = fs::metadata(&backup).unwrap().permissions();
        fs::set_permissions(&backup, fs::Permissions::from_mode(0o500)).unwrap();
        let result = skills_env_status(None);
        fs::set_permissions(&backup, permissions).unwrap();
        let status = result.unwrap();
        assert!(status.healthy);
        let warning = status.last_error.unwrap();
        assert!(warning.contains("previous setup diagnostic"), "{warning}");
        assert!(
            warning.contains("remove completed environment backup"),
            "{warning}"
        );
        assert!(
            warning.contains(&host_fs::display_path(&backup)),
            "{warning}"
        );
        assert!(warning.contains("Refresh (새로고침)"), "{warning}");
        assert_eq!(fs::read_to_string(status_path).unwrap(), saved);
        assert_eq!(
            fs::read_to_string(backup.join("keep")).unwrap(),
            "old runtime"
        );
    }

    #[test]
    fn hashed_status_health_requires_completion_while_legacy_keeps_venv_health() {
        let _home = host_fs::test_home_for_bundle_tests();
        let legacy = host_fs::env_base().unwrap();
        let hashed = host_fs::hashed_env_root("health-env").unwrap();
        for root in [&legacy, &hashed] {
            fs::create_dir_all(root.join(".venv")).unwrap();
            let lease = PathTransactionRequest::new(env_mutation_paths(root, None))
                .unwrap()
                .acquire()
                .unwrap();
            let status = env_status_in_transaction(&lease, root, None, None).unwrap();
            assert!(status.venv_exists);
            assert_eq!(status.healthy, *root == legacy);
            if *root == hashed {
                lease.before_effect().unwrap();
                fs::write(root.join(".maru-env-complete"), "").unwrap();
                assert!(
                    env_status_in_transaction(&lease, root, None, None)
                        .unwrap()
                        .healthy
                );
            }
        }
    }

    #[test]
    fn successful_local_dry_run_preserves_status_and_done_payload() {
        use tauri::Listener;
        let _home = host_fs::test_home_for_bundle_tests();
        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen("skills-env://done", move |e| {
            tx.send(e.payload().to_string()).unwrap();
        });
        let id = tauri::async_runtime::block_on(ipc::skills_env_bootstrap(
            app.handle().clone(),
            None,
            Some(true),
        ))
        .unwrap();
        let done: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert_eq!(done["invocationId"], id);
        assert_eq!(done["success"], true);
        assert_eq!(done["exitCode"], 0);
        let status = tauri::async_runtime::block_on(ipc::skills_env_status(None)).unwrap();
        assert!(status.last_bootstrap_at.is_some());
        assert!(status.last_error.is_none());
        assert!(std::path::Path::new(&status.root).starts_with(host_fs::maru_home().unwrap()));
    }
    #[cfg(unix)]
    #[test]
    fn headless_repair_rebuilds_current_hashed_env_like_bootstrap() {
        use crate::skill_host::bundle_update;
        use tauri::Listener;
        let mut trees = Vec::new();
        for path in ["app", "cli", "cli-failure"] {
            let _home = host_fs::test_home_for_bundle_tests();
            let setup = default_public_env_setup(None).unwrap().unwrap();
            let mut state = bundle_update::read_state().unwrap().unwrap();
            let active = state.active.as_mut().unwrap();
            active.env_hash = "headless-repair-env".into();
            let record = host_fs::skills_root()
                .unwrap()
                .join("_cache/bundle-compatibility")
                .join(format!("{}.json", active.bundle_id));
            host_fs::write_json_pretty(
                &record,
                &serde_json::json!({"minAppVersion":"0.0.1", "envLayout":"hashed"}),
            )
            .unwrap();
            bundle_update::write_state(&state).unwrap();
            let root = host_fs::env_root().unwrap();
            // Half-built: venv present but no completion marker.
            fs::create_dir_all(root.join(".venv")).unwrap();
            let hint = active_env_repair_hint().unwrap();
            assert!(hint.contains("maru skills env repair"), "{hint}");
            assert!(crate::skill_host::skills_doctor(None)
                .unwrap()
                .issues
                .iter()
                .any(|issue| issue.code == "env_incomplete"
                    && issue.message.contains("maru skills env repair")));
            fs::remove_dir_all(root.join(".venv")).unwrap();
            fs::write(
                &setup,
                format!(
                    "#!/bin/sh\nmkdir -p \"$2/.venv/bin\"\necho built > \"$2/.venv/bin/marker\"\necho out\nexit {}\n",
                    if path == "cli-failure" { 9 } else { 0 }
                ),
            )
            .unwrap();
            if path == "app" {
                let app = tauri::test::mock_app();
                let (tx, rx) = mpsc::channel();
                app.listen("skills-env://done", move |event| {
                    tx.send(event.payload().to_string()).unwrap();
                });
                skills_env_bootstrap(app.handle().clone(), None, None).unwrap();
                rx.recv_timeout(Duration::from_secs(5)).unwrap();
            } else {
                let lines = Arc::new(std::sync::Mutex::new(Vec::new()));
                let seen = lines.clone();
                let outcome = skills_env_repair_headless(
                    None,
                    false,
                    Arc::new(move |_, line| seen.lock().unwrap().push(line)),
                )
                .unwrap();
                assert_eq!(outcome.success, path == "cli");
                assert_eq!(lines.lock().unwrap().as_slice(), ["out".to_string()]);
                if path == "cli-failure" {
                    assert_eq!(outcome.exit_code, Some(9));
                    assert!(outcome.setup_error.unwrap().contains("env_bootstrap_exit"));
                    assert!(!root.join(".maru-env-complete").exists());
                    assert!(active_env_repair_hint().is_some());
                    continue;
                }
            }
            assert!(root.join(".maru-env-complete").is_file(), "{path}");
            assert!(active_env_repair_hint().is_none(), "{path}");
            assert!(skills_env_status(None).unwrap().healthy, "{path}");
            let mut tree: Vec<String> = walk(&root);
            tree.retain(|entry| !entry.starts_with("status.json"));
            trees.push(tree);
        }
        assert_eq!(trees[0], trees[1]);
    }

    #[cfg(unix)]
    #[test]
    fn headless_repair_refuses_complete_env_and_keeps_it_on_failed_force() {
        use crate::skill_host::bundle_update;
        let _home = host_fs::test_home_for_bundle_tests();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        let mut state = bundle_update::read_state().unwrap().unwrap();
        let active = state.active.as_mut().unwrap();
        active.env_hash = "complete-env".into();
        let record = host_fs::skills_root()
            .unwrap()
            .join("_cache/bundle-compatibility")
            .join(format!("{}.json", active.bundle_id));
        host_fs::write_json_pretty(
            &record,
            &serde_json::json!({"minAppVersion":"0.0.1", "envLayout":"hashed"}),
        )
        .unwrap();
        bundle_update::write_state(&state).unwrap();
        let root = host_fs::env_root().unwrap();
        fs::create_dir_all(root.join(".venv/bin")).unwrap();
        fs::write(root.join(".venv/bin/python"), "prior").unwrap();
        fs::write(root.join(".maru-env-complete"), "").unwrap();
        fs::write(&setup, "#!/bin/sh\nrm -rf \"$2/.venv\"\nexit 3\n").unwrap();
        let before = walk(&root);
        let error = skills_env_repair_headless(None, false, Arc::new(|_, _| ())).unwrap_err();
        assert!(error.starts_with(ENV_REPAIR_NOT_NEEDED), "{error}");
        assert!(error.contains("--force"), "{error}");
        assert_eq!(walk(&root), before);
        assert!(root.join(".maru-env-complete").is_file());
        assert_eq!(
            fs::read_to_string(root.join(".venv/bin/python")).unwrap(),
            "prior"
        );
        assert!(active_env_repair_hint().is_none());
        // An explicit --force does run setup; its failure is reported and the
        // prior env, marker included, comes back exactly.
        let outcome = skills_env_repair_headless(None, true, Arc::new(|_, _| ())).unwrap();
        assert!(!outcome.success);
        assert_eq!(outcome.exit_code, Some(3));
        assert!(outcome
            .completion_error
            .as_deref()
            .unwrap()
            .contains("the prior env was restored"));
        assert_eq!(walk(&root), before);
        assert!(root.join(".maru-env-complete").is_file());
        assert_eq!(
            fs::read_to_string(root.join(".venv/bin/python")).unwrap(),
            "prior"
        );
        assert!(!root.with_extension("prev").exists());
        assert!(active_env_repair_hint().is_none());
    }

    #[cfg(unix)]
    #[test]
    fn failed_repair_of_incomplete_env_restores_it_byte_identical() {
        use crate::skill_host::bundle_update;
        let _home = host_fs::test_home_for_bundle_tests();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        let mut state = bundle_update::read_state().unwrap().unwrap();
        let active = state.active.as_mut().unwrap();
        active.env_hash = "incomplete-env".into();
        let record = host_fs::skills_root()
            .unwrap()
            .join("_cache/bundle-compatibility")
            .join(format!("{}.json", active.bundle_id));
        host_fs::write_json_pretty(
            &record,
            &serde_json::json!({"minAppVersion":"0.0.1", "envLayout":"hashed"}),
        )
        .unwrap();
        bundle_update::write_state(&state).unwrap();
        let root = host_fs::env_root().unwrap();
        fs::create_dir_all(root.join(".venv/lib")).unwrap();
        fs::write(root.join(".venv/lib/partial.py"), "usable").unwrap();
        fs::write(root.join("status.json"), "{\"success\":false}").unwrap();
        fs::write(
            &setup,
            "#!/bin/sh\nrm -rf \"$2\"/*\nmkdir -p \"$2/.venv/half\"\nexit 5\n",
        )
        .unwrap();
        let snapshot = |root: &Path| {
            walk(root)
                .into_iter()
                .map(|entry| {
                    let path = root.join(&entry);
                    let bytes = path.is_file().then(|| fs::read(&path).unwrap());
                    (entry, bytes)
                })
                .collect::<Vec<_>>()
        };
        let before = snapshot(&root);
        let outcome = skills_env_repair_headless(None, false, Arc::new(|_, _| ())).unwrap();
        assert!(!outcome.success);
        assert_eq!(outcome.exit_code, Some(5));
        assert_eq!(snapshot(&root), before);
        assert!(!root.with_extension("prev").exists());
        // A successful repair builds from empty and drops the aside copy.
        fs::write(&setup, "#!/bin/sh\nmkdir -p \"$2/.venv\"\n").unwrap();
        let outcome = skills_env_repair_headless(None, false, Arc::new(|_, _| ())).unwrap();
        assert!(outcome.success, "{outcome:?}");
        assert!(!root.join(".venv/lib/partial.py").exists());
        assert!(root.join(".maru-env-complete").is_file());
        assert!(!root.with_extension("prev").exists());
    }

    #[cfg(unix)]
    #[test]
    fn headless_repair_refuses_legacy_layout_without_changes() {
        let _home = host_fs::test_home_for_bundle_tests();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        let root = host_fs::env_root().unwrap();
        assert!(!host_fs::is_hashed_env_root(&root).unwrap());
        fs::create_dir_all(root.join(".venv/bin")).unwrap();
        fs::write(root.join(".venv/bin/python"), "legacy").unwrap();
        fs::write(&setup, "#!/bin/sh\nrm -rf \"$2/.venv\"\nexit 4\n").unwrap();
        let before = walk(&root);
        for force in [false, true] {
            let error = skills_env_repair_headless(None, force, Arc::new(|_, _| ())).unwrap_err();
            assert!(error.starts_with("skills_env_legacy_layout"), "{error}");
            assert!(error.contains("maru skills update --apply"), "{error}");
            assert_eq!(walk(&root), before, "force={force}");
        }
        assert_eq!(
            fs::read_to_string(root.join(".venv/bin/python")).unwrap(),
            "legacy"
        );
    }

    fn walk(root: &Path) -> Vec<String> {
        let mut out = Vec::new();
        let mut stack = vec![root.to_path_buf()];
        while let Some(dir) = stack.pop() {
            for entry in fs::read_dir(&dir).unwrap() {
                let path = entry.unwrap().path();
                out.push(path.strip_prefix(root).unwrap().display().to_string());
                if path.is_dir() {
                    stack.push(path);
                }
            }
        }
        out.sort();
        out
    }

    #[cfg(unix)]
    #[test]
    fn hashed_setup_marks_only_successful_real_setup_and_reports_marker_failure() {
        use crate::atomic_file::PathTransactionTestHook;
        use crate::skill_host::bundle_update;
        use tauri::Listener;
        for scenario in [
            "repair",
            "bootstrap",
            "failure",
            "dry-run",
            "no-setup",
            "marker-failure",
        ] {
            let _home = host_fs::test_home_for_bundle_tests();
            let setup = default_public_env_setup(None).unwrap().unwrap();
            let mut state = bundle_update::read_state().unwrap().unwrap();
            let active = state.active.as_mut().unwrap();
            active.env_hash = "direct-repair-env".into();
            let record = host_fs::skills_root()
                .unwrap()
                .join("_cache/bundle-compatibility")
                .join(format!("{}.json", active.bundle_id));
            host_fs::write_json_pretty(
                &record,
                &serde_json::json!({"minAppVersion":"0.0.1", "envLayout":"hashed"}),
            )
            .unwrap();
            bundle_update::write_state(&state).unwrap();
            let root = host_fs::env_root().unwrap();
            fs::create_dir_all(&root).unwrap();
            let marker = root.join(".maru-env-complete");
            if scenario == "failure" {
                fs::create_dir_all(root.join(".venv")).unwrap();
                fs::write(&marker, "").unwrap();
            }
            fs::write(
                &setup,
                format!(
                    r#"#!/bin/sh
mkdir -p "$2/.venv"
exit {}
"#,
                    if scenario == "failure" { 7 } else { 0 }
                ),
            )
            .unwrap();
            let marker_target = marker.clone();
            let _hook = (scenario == "marker-failure").then(|| {
                PathTransactionTestHook::new(root.clone(), "env:before-status", move || {
                    fs::create_dir_all(&marker_target).unwrap();
                })
            });
            let app = tauri::test::mock_app();
            let (tx, rx) = mpsc::channel();
            app.listen("skills-env://done", move |event| {
                tx.send(event.payload().to_string()).unwrap();
            });
            let id = if scenario == "no-setup" {
                let lease = PathTransactionRequest::new(env_mutation_paths(&root, None))
                    .unwrap()
                    .acquire()
                    .unwrap();
                bootstrap_in_transaction(app.handle().clone(), root.clone(), None, false, lease)
                    .unwrap()
            } else if scenario == "repair" {
                skills_env_repair(app.handle().clone(), None).unwrap()
            } else {
                skills_env_bootstrap(app.handle().clone(), None, Some(scenario == "dry-run"))
                    .unwrap()
            };
            let done: serde_json::Value =
                serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
            assert_eq!(done["invocationId"], id);
            assert_eq!(
                done["success"],
                !matches!(scenario, "failure" | "marker-failure")
            );
            assert_eq!(
                marker.is_file(),
                matches!(scenario, "repair" | "bootstrap"),
                "{scenario}"
            );
            assert!(!host_fs::env_base()
                .unwrap()
                .join(".maru-env-complete")
                .exists());
            assert_eq!(
                root.join(".venv").is_dir(),
                scenario != "dry-run",
                "{scenario}"
            );
            let status = skills_env_status(None).unwrap();
            if scenario == "marker-failure" {
                let error = status.last_error.unwrap();
                assert_eq!(
                    done["error"].as_str(),
                    Some(error.as_str()),
                    "done must explain marker failure even with exit code 0"
                );
                assert!(
                    error.contains("mark hashed environment complete"),
                    "{error}"
                );
                assert!(error.contains(&host_fs::display_path(&marker)), "{error}");
                assert!(error.contains("maru skills update --check"), "{error}");
            } else if scenario == "failure" {
                assert!(status.last_error.unwrap().contains("env_bootstrap_exit"));
            } else {
                assert!(status.last_error.is_none(), "{scenario}");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn repair_worker_survives_return_and_failure_persists_before_done() {
        use tauri::Listener;
        let _home = host_fs::test_home_for_bundle_tests();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        // Replace only the disposable materialized script. No package installer runs.
        fs::write(
            &setup,
            "#!/bin/sh\ni=0\nwhile [ ! -f \"$2/release\" ] && [ $i -lt 500 ]; do sleep 0.01; i=$((i+1)); done\nexit 7\n",
        )
        .unwrap();
        let app = tauri::test::mock_app();
        let (tx, rx) = mpsc::channel();
        app.listen("skills-env://done", move |e| {
            tx.send(e.payload().to_string()).unwrap();
        });
        let id = tauri::async_runtime::block_on(ipc::skills_env_repair(app.handle().clone(), None))
            .unwrap();
        assert!(rx.try_recv().is_err(), "launch is not completion");
        fs::write(host_fs::env_root().unwrap().join("release"), "release").unwrap();
        let done: serde_json::Value =
            serde_json::from_str(&rx.recv_timeout(Duration::from_secs(5)).unwrap()).unwrap();
        assert_eq!(done["invocationId"], id);
        assert_eq!(done["success"], false);
        assert_eq!(done["exitCode"], 7);
        let status = skills_env_status(None).unwrap();
        assert!(status.last_error.unwrap().contains("env_bootstrap_exit"));
    }
}

#[cfg(all(test, unix))]
mod phase08_29_env {
    use super::*;
    use crate::atomic_file::phase08_06::{run, Held, Home};
    use crate::workspace_files::{self, phase08_06::TrashFixture, WorkspaceMutationStatus};
    use std::sync::mpsc;
    use std::time::Duration;
    use tauri::Listener;

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

    fn parent(root: &Path, source: &Path, trash: bool) -> mpsc::Receiver<Result<(), String>> {
        let root = root.to_string_lossy().into_owned();
        let source = source.to_string_lossy().into_owned();
        start(async move {
            if trash {
                workspace_files::ipc::trash_workspace_entries(root, vec![source])
                    .await
                    .map(|rows| {
                        assert_eq!(rows[0].status, WorkspaceMutationStatus::Done);
                    })
            } else {
                workspace_files::ipc::rename_workspace_entry(root, source, "moved".into())
                    .await
                    .map(|_| ())
            }
        })
    }

    fn parent_race(trash: bool, env_first: bool, alias: bool) {
        let home = Home::new();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        let workspace = home.root.path().join("workspace");
        let source = workspace.join("ordinary");
        let moved = workspace.join("moved");
        fs::create_dir_all(&source).unwrap();
        let env_root = host_fs::env_root().unwrap();
        // Both lexical ownership and a physically aliased environment are exercised.
        let (parent_root, parent_source, destination) = if alias {
            fs::create_dir(source.join("env")).unwrap();
            std::os::unix::fs::symlink(source.join("env"), &env_root).unwrap();
            (workspace.clone(), source.clone(), moved.clone())
        } else {
            fs::create_dir_all(&env_root).unwrap();
            let maru = host_fs::maru_home().unwrap();
            (maru.clone(), env_root.clone(), maru.join("moved"))
        };
        let _trash = TrashFixture::new(parent_source.clone(), destination.clone());
        fs::write(&setup,
            "#!/bin/bash\ni=0\nwhile [ ! -f \"$2/release\" ] && [ $i -lt 400 ]; do sleep 0.01; i=$((i+1)); done\nprintf 'complete\\n'\nprintf 'preserved bytes' > \"$2/result.txt\"\nexit 7\n"
        ).unwrap();
        let app = tauri::test::mock_app();
        let (done_tx, done_rx) = mpsc::channel();
        app.listen("skills-env://done", move |event| {
            let _ = done_tx.send(event.payload().to_owned());
        });
        if env_first {
            // The dedicated worker has already returned its invocation ID. Hold
            // its final status edge after the actual child and streams complete.
            let status = Held::new(env_root.clone(), "env:before-status");
            let id = run(ipc::skills_env_bootstrap(
                app.handle().clone(),
                None,
                Some(false),
            ))
            .unwrap();
            let waiting = Held::new(parent_source.clone(), "before-admission");
            let parent_rx = parent(&parent_root, &parent_source, trash);
            waiting.wait();
            waiting.release();
            assert!(parent_rx.recv_timeout(Duration::from_millis(75)).is_err());
            fs::write(env_root.join("release"), "release").unwrap();
            status.wait();
            assert!(parent_rx.recv_timeout(Duration::from_millis(75)).is_err());
            assert!(!env_root.join("status.json").exists());
            status.release();
            let done: serde_json::Value =
                serde_json::from_str(&done_rx.recv_timeout(Duration::from_secs(5)).unwrap())
                    .unwrap();
            assert_eq!(done["invocationId"], id);
            assert_eq!(done["exitCode"], 7);
            assert_eq!(done["success"], false);
            parent_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            let result = if alias {
                destination.join("env")
            } else {
                destination.clone()
            };
            assert_eq!(
                fs::read_to_string(result.join("result.txt")).unwrap(),
                "preserved bytes"
            );
            let status: serde_json::Value =
                serde_json::from_slice(&fs::read(result.join("status.json")).unwrap()).unwrap();
            assert_eq!(status["success"], false);
            assert!(status["lastError"]
                .as_str()
                .unwrap()
                .contains("env_bootstrap_exit"));
        } else {
            let held = Held::new(parent_source.clone(), "pre-effect");
            let parent_rx = parent(&parent_root, &parent_source, trash);
            held.wait();
            let waiting = Held::new(env_root.clone(), "before-admission");
            let env_rx = start(ipc::skills_env_bootstrap(
                app.handle().clone(),
                None,
                Some(false),
            ));
            waiting.wait();
            waiting.release();
            assert!(env_rx.recv_timeout(Duration::from_millis(75)).is_err());
            held.release();
            parent_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap();
            assert!(env_rx
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .is_err());
            assert!(!env_root.is_dir(), "stale setup recreated its old parent");
            assert!(!destination.join("result.txt").exists());
        }
    }

    #[test]
    fn background_bootstrap_rename_both_orders_and_aliases() {
        for alias in [false, true] {
            for env_first in [false, true] {
                parent_race(false, env_first, alias);
            }
        }
    }

    #[test]
    fn background_bootstrap_trash_both_orders_and_aliases() {
        for alias in [false, true] {
            for env_first in [false, true] {
                parent_race(true, env_first, alias);
            }
        }
    }

    #[test]
    fn output_stream_is_joined_before_status_and_done() {
        let _home = Home::new();
        let setup = default_public_env_setup(None).unwrap().unwrap();
        fs::write(&setup, "#!/bin/bash\nprintf 'held-output\\n'\nexit 0\n").unwrap();
        let app = tauri::test::mock_app();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = std::sync::Mutex::new(release_rx);
        app.listen("skills-env://output", move |_| {
            entered_tx.send(()).unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
        });
        let (done_tx, done_rx) = mpsc::channel();
        app.listen("skills-env://done", move |_| {
            let _ = done_tx.send(());
        });
        run(ipc::skills_env_bootstrap(
            app.handle().clone(),
            None,
            Some(false),
        ))
        .unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(done_rx.recv_timeout(Duration::from_millis(75)).is_err());
        assert!(!host_fs::env_root().unwrap().join("status.json").exists());
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(host_fs::env_root().unwrap().join("status.json").is_file());
    }

    #[test]
    fn actual_wrappers_yield_on_the_same_polling_task_before_environment_work() {
        use crate::atomic_file::phase08_06::boundary;
        let _home = Home::new();
        let app = tauri::test::mock_app();
        let root = host_fs::env_root().unwrap();
        boundary(
            root.clone(),
            "skills_env_status",
            ipc::skills_env_status(None),
        );
        boundary(
            root.clone(),
            "skills_env_bootstrap",
            ipc::skills_env_bootstrap(app.handle().clone(), None, Some(true)),
        );
        boundary(
            root.clone(),
            "skills_env_repair",
            ipc::skills_env_repair(app.handle().clone(), None),
        );
        assert!(
            !root.exists(),
            "worker failure must precede environment effects"
        );
    }

    #[test]
    fn nested_status_rejects_incomplete_lease_and_no_setup_releases() {
        let _home = Home::new();
        let root = host_fs::env_root().unwrap();
        let other = host_fs::maru_home().unwrap().join("unrelated");
        let lease = PathTransactionRequest::new([other])
            .unwrap()
            .acquire()
            .unwrap();
        assert!(env_status_in_transaction(&lease, &root, None, None).is_err());
        assert!(!root.exists());
        drop(lease);
        let app = tauri::test::mock_app();
        let lease = PathTransactionRequest::new(env_mutation_paths(&root, None))
            .unwrap()
            .acquire()
            .unwrap();
        bootstrap_in_transaction(app.handle().clone(), root.clone(), None, false, lease).unwrap();
        let lease = PathTransactionRequest::new(env_mutation_paths(&root, None))
            .unwrap()
            .acquire()
            .unwrap();
        let status = env_status_in_transaction(&lease, &root, None, None).unwrap();
        assert!(status.venv_exists);
        assert!(status.last_bootstrap_at.is_some());
    }
}
