use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

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

pub fn skills_env_status(work_path: Option<String>) -> Result<SkillsEnvStatus, String> {
    env_status(work_path.as_deref(), None)
}

pub fn skills_env_bootstrap<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: Option<String>,
    dry_run: Option<bool>,
) -> Result<String, String> {
    let invocation_id = format!("skills-env-{}", Uuid::new_v4());
    let setup = default_public_env_setup(work_path.as_deref())?;
    let root = host_fs::env_root()?;
    host_fs::ensure_dir(&root)?;
    let dry_run = dry_run.unwrap_or(false);
    if dry_run {
        write_status(None, None)?;
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
    let Some(setup) = setup else {
        host_fs::ensure_dir(&root.join(".venv"))?;
        write_status(None, None)?;
        let _ = app.emit(
            "skills-env://done",
            EnvDoneEvent {
                invocation_id: invocation_id.clone(),
                success: true,
                exit_code: Some(0),
            },
        );
        return Ok(invocation_id);
    };
    let app_clone = app.clone();
    let id_clone = invocation_id.clone();
    thread::spawn(move || {
        let mut cmd = Command::new("bash");
        cmd.arg(setup)
            .arg("--target")
            .arg(&root)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .no_window();
        match cmd.spawn() {
            Ok(mut child) => {
                if let Some(stdout) = child.stdout.take() {
                    pump(app_clone.clone(), id_clone.clone(), "stdout", stdout);
                }
                if let Some(stderr) = child.stderr.take() {
                    pump(app_clone.clone(), id_clone.clone(), "stderr", stderr);
                }
                match child.wait() {
                    Ok(status) => {
                        let success = status.success();
                        let err = if success {
                            None
                        } else {
                            Some(format!("env_bootstrap_exit: {:?}", status.code()))
                        };
                        let _ = write_status(Some(success), err.clone());
                        let _ = app_clone.emit(
                            "skills-env://done",
                            EnvDoneEvent {
                                invocation_id: id_clone,
                                success,
                                exit_code: status.code(),
                            },
                        );
                    }
                    Err(err) => {
                        let _ = write_status(Some(false), Some(err.to_string()));
                    }
                }
            }
            Err(err) => {
                let _ = write_status(Some(false), Some(err.to_string()));
                let _ = app_clone.emit(
                    "skills-env://done",
                    EnvDoneEvent {
                        invocation_id: id_clone,
                        success: false,
                        exit_code: None,
                    },
                );
            }
        }
    });
    Ok(invocation_id)
}

pub fn skills_env_repair<R: tauri::Runtime>(
    app: AppHandle<R>,
    work_path: Option<String>,
) -> Result<String, String> {
    skills_env_bootstrap(app, work_path, Some(false))
}

fn env_status(
    work_path: Option<&str>,
    last_error_override: Option<String>,
) -> Result<SkillsEnvStatus, String> {
    let root = host_fs::env_root()?;
    host_fs::ensure_dir(&root)?;
    let venv_path = root.join(".venv");
    let node_modules_path = root.join("node_modules");
    let status_path = root.join("status.json");
    let setup_script =
        default_public_env_setup(work_path)?.map(|path| host_fs::display_path(&path));
    let (last_bootstrap_at, last_error) = read_status(&status_path).unwrap_or((None, None));
    let last_error = last_error_override.or(last_error);
    let venv_exists = venv_path.is_dir();
    let node_modules_exists = node_modules_path.is_dir();
    Ok(SkillsEnvStatus {
        root: host_fs::display_path(&root),
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

fn pump<R: tauri::Runtime, S>(app: AppHandle<R>, invocation_id: String, stream: &str, source: S)
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
    });
}

fn write_status(success: Option<bool>, error: Option<String>) -> Result<(), String> {
    let root = host_fs::env_root()?;
    host_fs::ensure_dir(&root)?;
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
