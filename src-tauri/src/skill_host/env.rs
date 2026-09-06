use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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
    command
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
    let root = host_fs::env_root()?;
    let parent = env_parent_snapshot(&root)?;
    let setup = default_public_env_setup(work_path.as_deref())?;
    let lease = PathTransactionRequest::new(env_mutation_paths(&root, None))?
        .require_parent_snapshot(&parent)?
        .acquire()?;
    env_status_in_transaction(&lease, &root, setup.as_deref(), None)
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

/// The owned lease moves to the detached worker, never to a borrowed callback.
fn bootstrap_in_transaction<R: tauri::Runtime>(
    app: AppHandle<R>,
    root: PathBuf,
    setup: Option<PathBuf>,
    dry_run: bool,
    lease: PathTransactionLease,
) -> Result<String, String> {
    lease.ensure_covered(env_mutation_paths(&root, setup.as_deref()))?;
    lease.before_effect()?;
    let invocation_id = format!("skills-env-{}", Uuid::new_v4());
    host_fs::ensure_dir(&root)?;
    if dry_run || setup.is_none() {
        if !dry_run {
            host_fs::ensure_dir(&root.join(".venv"))?;
        }
        write_status_in_transaction(&lease, &root, None, None)?;
        let _ = app.emit(
            "skills-env://done",
            EnvDoneEvent {
                invocation_id: invocation_id.clone(),
                success: true,
                exit_code: Some(0),
            },
        );
        return Ok(invocation_id);
    }
    let setup = setup.expect("setup checked above");
    host_fs::ensure_dir(&root.join("temp"))?;
    let id = invocation_id.clone();
    thread::spawn(move || {
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
                    .map(|source| pump(app.clone(), id.clone(), "stdout", source));
                let stderr = child
                    .stderr
                    .take()
                    .map(|source| pump(app.clone(), id.clone(), "stderr", source));
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
        let persisted = write_status_in_transaction(&lease, &root, Some(success), error).is_ok();
        let _ = app.emit(
            "skills-env://done",
            EnvDoneEvent {
                invocation_id: id,
                success: success && persisted,
                exit_code,
            },
        );
        drop(lease);
    });
    Ok(invocation_id)
}

pub fn skills_env_repair<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: Option<String>,
) -> Result<String, String> {
    skills_env_bootstrap(app, work_path, Some(false))
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
        healthy: venv_exists,
    })
}

fn pump<R: tauri::Runtime, S>(
    app: AppHandle<R>,
    invocation_id: String,
    stream: &str,
    source: S,
) -> thread::JoinHandle<()>
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
            let _ = app.emit(
                "skills-env://output",
                EnvOutputEvent {
                    invocation_id: invocation_id.clone(),
                    stream: stream.clone(),
                    line,
                },
            );
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
