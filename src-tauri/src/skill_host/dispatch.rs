use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::ai_router::{AiDoneEvent, AiErrorEvent, AiOutputEvent};
use crate::cli_path::resolve_program;
use crate::mission_state;
use crate::skill_host::fs as host_fs;
use crate::skill_host::store::{env_vars_for_runs, get_skill};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillContextItem {
    pub path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DispatchComposition {
    pub skill_id: String,
    pub skill_name: String,
    pub cwd: String,
    pub prompt: String,
    #[serde(default)]
    pub context: Vec<SkillContextItem>,
    #[serde(default)]
    pub extra_env: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDispatchSpec {
    pub kind: String,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    pub extra_args: Vec<String>,
    pub extra_env: BTreeMap<String, String>,
    pub title: String,
}

#[tauri::command]
pub fn skills_dispatch_compose(
    skill_id: String,
    prompt: String,
    cwd: Option<String>,
    context: Option<Vec<SkillContextItem>>,
) -> Result<DispatchComposition, String> {
    compose(skill_id, prompt, cwd, context.unwrap_or_default())
}

#[tauri::command]
pub fn skills_dispatch_terminal(
    skill_id: String,
    runtime: String,
    prompt: String,
    cwd: Option<String>,
    context: Option<Vec<SkillContextItem>>,
) -> Result<TerminalDispatchSpec, String> {
    let composition = compose(skill_id, prompt, cwd, context.unwrap_or_default())?;
    let runtime = normalize_runtime(&runtime)?;
    let add_dirs = add_dirs(&composition);
    let title = format!("Skill: {}", composition.skill_name);
    match runtime.as_str() {
        "claude" => {
            let mut args = vec![
                "-p".to_string(),
                composition.prompt,
                "--permission-mode".to_string(),
                "plan".to_string(),
            ];
            for dir in add_dirs {
                args.push("--add-dir".to_string());
                args.push(dir);
            }
            Ok(TerminalDispatchSpec {
                kind: "claude".to_string(),
                cwd: composition.cwd,
                command: None,
                extra_args: args,
                extra_env: composition.extra_env,
                title,
            })
        }
        "codex" => {
            let mut command = format!(
                "printf '%s' \"$ANCHOR_SKILL_PROMPT\" | codex exec --cd {}",
                shell_quote(&composition.cwd)
            );
            for dir in add_dirs {
                command.push_str(" --add-dir ");
                command.push_str(&shell_quote(&dir));
            }
            command.push_str(" -");
            let mut extra_env = composition.extra_env;
            extra_env.insert("ANCHOR_SKILL_PROMPT".to_string(), composition.prompt);
            Ok(TerminalDispatchSpec {
                kind: "codex".to_string(),
                cwd: composition.cwd,
                command: Some("/bin/zsh".to_string()),
                extra_args: vec!["-lc".to_string(), command],
                extra_env,
                title,
            })
        }
        _ => Err(format!("unsupported_dispatch_runtime: {runtime}")),
    }
}

#[tauri::command]
pub fn skills_dispatch_background(
    app: AppHandle,
    skill_id: String,
    runtime: String,
    prompt: String,
    cwd: Option<String>,
    context: Option<Vec<SkillContextItem>>,
) -> Result<String, String> {
    let composition = compose(skill_id, prompt, cwd, context.unwrap_or_default())?;
    let runtime = normalize_runtime(&runtime)?;
    let invocation_id = format!("ai-{}", Uuid::new_v4());
    let add_dirs = add_dirs(&composition);
    let env = composition.extra_env.clone();
    match runtime.as_str() {
        "claude" => {
            let bin = resolve_program("claude").ok_or_else(|| {
                "cli_missing: claude CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            cmd.arg("-p")
                .arg(&composition.prompt)
                .arg("--permission-mode")
                .arg("plan");
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            spawn_background(app, invocation_id, cmd, composition.cwd, env, None)
        }
        "codex" => {
            let bin = resolve_program("codex").ok_or_else(|| {
                "cli_missing: codex CLI not found in PATH or common install locations".to_string()
            })?;
            let mut cmd = Command::new(bin);
            cmd.arg("exec").arg("--cd").arg(&composition.cwd);
            for dir in add_dirs {
                cmd.arg("--add-dir").arg(dir);
            }
            cmd.arg("-");
            spawn_background(
                app,
                invocation_id,
                cmd,
                composition.cwd,
                env,
                Some(composition.prompt),
            )
        }
        _ => Err(format!("unsupported_dispatch_runtime: {runtime}")),
    }
}

fn compose(
    skill_id: String,
    prompt: String,
    cwd: Option<String>,
    context: Vec<SkillContextItem>,
) -> Result<DispatchComposition, String> {
    if prompt.trim().is_empty() {
        return Err("skill_prompt_required".to_string());
    }
    let skill = get_skill(&skill_id)?;
    let skill_md = Path::new(&skill.abs_path).join("SKILL.md");
    let skill_content = std::fs::read_to_string(&skill_md)
        .map_err(|err| format!("Cannot read {}: {err}", host_fs::display_path(&skill_md)))?;
    let cwd = resolve_cwd(cwd.as_deref(), &context)?;
    let prompt = build_prompt(&skill.name, &skill_content, &context, &prompt);
    Ok(DispatchComposition {
        skill_id,
        skill_name: skill.name,
        cwd: host_fs::display_path(&cwd),
        prompt,
        context,
        extra_env: env_vars_for_runs()?,
    })
}

fn build_prompt(
    skill_name: &str,
    skill_content: &str,
    context: &[SkillContextItem],
    prompt: &str,
) -> String {
    let mut out = String::new();
    out.push_str("You are running an Anchor-managed skill.\n\n");
    out.push_str("<skill name=\"");
    out.push_str(skill_name);
    out.push_str("\">\n");
    out.push_str(skill_content.trim());
    out.push_str("\n</skill>\n\n");
    if !context.is_empty() {
        out.push_str("<selected_context>\n");
        for item in context {
            out.push_str("- ");
            out.push_str(item.kind.as_deref().unwrap_or("path"));
            out.push_str(": ");
            out.push_str(&item.path);
            out.push('\n');
        }
        out.push_str("</selected_context>\n\n");
    }
    out.push_str("<user_prompt>\n");
    out.push_str(prompt.trim());
    out.push_str("\n</user_prompt>\n");
    out
}

fn resolve_cwd(cwd: Option<&str>, context: &[SkillContextItem]) -> Result<PathBuf, String> {
    if let Some(cwd) = cwd.map(str::trim).filter(|value| !value.is_empty()) {
        let path = PathBuf::from(cwd);
        if path.is_dir() {
            return path
                .canonicalize()
                .map_err(|err| format!("dispatch_cwd_invalid: {err}"));
        }
    }
    for item in context {
        let path = PathBuf::from(&item.path);
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        };
        if dir.is_dir() {
            return dir
                .canonicalize()
                .map_err(|err| format!("dispatch_cwd_invalid: {err}"));
        }
    }
    std::env::current_dir().map_err(|err| format!("dispatch_cwd_invalid: {err}"))
}

fn add_dirs(composition: &DispatchComposition) -> Vec<String> {
    let mut dirs = Vec::new();
    for item in &composition.context {
        let path = PathBuf::from(&item.path);
        let dir = if path.is_dir() {
            path
        } else {
            path.parent().map(Path::to_path_buf).unwrap_or(path)
        };
        if dir.is_dir() {
            let value = host_fs::display_path(&dir);
            if !dirs.contains(&value) {
                dirs.push(value);
            }
        }
    }
    if !dirs.contains(&composition.cwd) {
        dirs.push(composition.cwd.clone());
    }
    dirs
}

fn normalize_runtime(runtime: &str) -> Result<String, String> {
    let value = runtime.trim().to_lowercase();
    match value.as_str() {
        "claude" | "codex" => Ok(value),
        _ => Err(format!("unsupported_dispatch_runtime: {value}")),
    }
}

fn spawn_background(
    app: AppHandle,
    invocation_id: String,
    mut cmd: Command,
    cwd: String,
    env: BTreeMap<String, String>,
    stdin_payload: Option<String>,
) -> Result<String, String> {
    cmd.current_dir(cwd)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in env {
        cmd.env(key, value);
    }
    let mut child = cmd.spawn().map_err(|err| format_spawn_error(&err))?;
    let child_pid = child.id();
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            thread::spawn(move || {
                let _ = stdin.write_all(payload.as_bytes());
            });
        }
    }
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "stdout_capture_failed".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "stderr_capture_failed".to_string())?;
    spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        "stdout".to_string(),
        stdout,
    );
    spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        "stderr".to_string(),
        stderr,
    );
    let _ = mission_state::register_mission(&app, &invocation_id, "skill", child_pid);
    let app_done = app.clone();
    let id_done = invocation_id.clone();
    thread::spawn(move || match child.wait() {
        Ok(status) => {
            mission_state::finish_mission(&app_done, &id_done, status.code(), status.success());
            let _ = app_done.emit(
                "ai://done",
                AiDoneEvent {
                    invocation_id: id_done,
                    exit_code: status.code(),
                    success: status.success(),
                },
            );
        }
        Err(err) => {
            mission_state::fail_mission(&app_done, &id_done, &err.to_string());
            let _ = app_done.emit(
                "ai://error",
                AiErrorEvent {
                    invocation_id: id_done,
                    kind: "wait_failed".to_string(),
                    message: err.to_string(),
                },
            );
        }
    });
    Ok(invocation_id)
}

fn spawn_line_pump<R>(app: AppHandle, invocation_id: String, stream_name: String, source: R)
where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(source);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            let _ = app.emit(
                "ai://output",
                AiOutputEvent {
                    invocation_id: invocation_id.clone(),
                    stream: stream_name.clone(),
                    line: line.clone(),
                },
            );
            mission_state::touch_output(&app, &invocation_id, &stream_name, &line);
        }
    });
}

fn format_spawn_error(err: &std::io::Error) -> String {
    let kind = if err.kind() == std::io::ErrorKind::NotFound {
        "cli_missing"
    } else if err.kind() == std::io::ErrorKind::PermissionDenied {
        "permission_denied"
    } else {
        "spawn_failed"
    };
    format!("{kind}: {err}")
}

fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_includes_skill_and_context() {
        let prompt = build_prompt(
            "demo",
            "# Demo",
            &[SkillContextItem {
                path: "/tmp/a.md".to_string(),
                kind: Some("file".to_string()),
            }],
            "Summarize",
        );
        assert!(prompt.contains("<skill name=\"demo\">"));
        assert!(prompt.contains("/tmp/a.md"));
        assert!(prompt.contains("Summarize"));
    }

    #[test]
    fn runtime_validation_rejects_unknown_targets() {
        assert!(normalize_runtime("claude").is_ok());
        assert!(normalize_runtime("codex").is_ok());
        assert!(normalize_runtime("openai").is_err());
    }
}
