use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::fs;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::skill_host::fs as host_fs;
use crate::skill_host::store::default_public_env_setup;

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

#[tauri::command]
pub fn skills_env_status(work_path: Option<String>) -> Result<SkillsEnvStatus, String> {
    env_status(work_path.as_deref(), None)
}

#[tauri::command]
pub fn skills_env_bootstrap(
    app: AppHandle,
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
        return Ok(invocation_id);
    }
    let Some(setup) = setup else {
        host_fs::ensure_dir(&root.join(".venv"))?;
        write_status(None, None)?;
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
            .stderr(Stdio::piped());
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

#[tauri::command]
pub fn skills_env_repair(app: AppHandle, work_path: Option<String>) -> Result<String, String> {
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

fn pump<R>(app: AppHandle, invocation_id: String, stream: &str, source: R)
where
    R: std::io::Read + Send + 'static,
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
