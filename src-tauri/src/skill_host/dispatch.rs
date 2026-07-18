use serde::{Deserialize, Serialize};
use serde_json::Value as JsonValue;
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agent_host::contracts::{
    AgentRunContextItem, AgentRunRequest, CompletionRequest, AGENT_RUN_REQUEST_SCHEMA_VERSION,
    COMPLETION_REQUEST_SCHEMA_VERSION,
};
use crate::agent_host::event_store::append_run_event_payload;
use crate::agent_host::proposal::parse_skill_proposal;
use crate::agent_host::provider::{
    build_cli_command, normalize_permission_mode, resolve_provider_binary, CliProviderKind,
};
use crate::ai_router::{AiDoneEvent, AiErrorEvent, AiOutputEvent};
use crate::mission_state;
use crate::skill_host::fs as host_fs;
use crate::skill_host::store::{env_vars_for_runs, get_skill};
use crate::win_process::NoWindow;

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillRuntimeStatus {
    pub runtime: String,
    pub available: bool,
    pub binary_path: Option<String>,
    pub version: Option<String>,
    pub auth_status: String,
    pub error_kind: Option<String>,
    pub message: String,
    pub suggested_action: Option<String>,
}

#[tauri::command]
pub fn skills_runtime_status(
    runtime: String,
    command_override: Option<String>,
) -> Result<SkillRuntimeStatus, String> {
    runtime_status(runtime, command_override.as_deref())
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
    command_override: Option<String>,
) -> Result<TerminalDispatchSpec, String> {
    let composition = compose(skill_id, prompt, cwd, context.unwrap_or_default())?;
    let runtime = normalize_runtime(&runtime)?;
    let command_override = command_override.filter(|value| !value.trim().is_empty());
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
                command: command_override,
                extra_args: args,
                extra_env: composition.extra_env,
                title,
            })
        }
        "codex" => {
            let mut command = format!(
                "printf '%s' \"$MARU_SKILL_PROMPT\" | {} exec --cd {}",
                shell_quote(command_override.as_deref().unwrap_or("codex")),
                shell_quote(&composition.cwd)
            );
            for dir in add_dirs {
                command.push_str(" --add-dir ");
                command.push_str(&shell_quote(&dir));
            }
            command.push_str(" -");
            let mut extra_env = composition.extra_env;
            extra_env.insert("MARU_SKILL_PROMPT".to_string(), composition.prompt);
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
    metadata: Option<JsonValue>,
    command_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<String, String> {
    let command_override = command_override.filter(|value| !value.trim().is_empty());
    let permission_mode =
        normalize_permission_mode(permission_mode.as_deref().unwrap_or("plan")).to_string();
    let original_skill_id = skill_id.clone();
    let original_prompt = prompt.clone();
    let composition = compose(skill_id, prompt, cwd, context.unwrap_or_default())?;
    let runtime = normalize_runtime(&runtime)?;
    let invocation_id = format!("ai-{}", Uuid::new_v4());
    let add_dirs = add_dirs(&composition);
    let env = composition.extra_env.clone();
    let approved_execution = metadata_bool(&metadata, "approvedExecution");
    let composition = DispatchComposition {
        prompt: append_background_contract(&composition.prompt, approved_execution),
        ..composition
    };
    let run_request =
        build_agent_run_request(&composition, &runtime, "background", metadata.clone())?;
    let completion_request = CompletionRequest {
        schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
        provider: runtime.clone(),
        prompt: composition.prompt.clone(),
        cwd: composition.cwd.clone(),
        mode: "background".to_string(),
        metadata: metadata.clone(),
    };
    let provider = CliProviderKind::parse(&runtime)?;
    let (cmd, stdin_payload) = build_cli_command(
        provider,
        &completion_request,
        &add_dirs,
        command_override.as_deref(),
        &permission_mode,
    )?;
    let retry_payload = serde_json::json!({
        "skillId": original_skill_id,
        "runtime": runtime,
        "prompt": original_prompt,
        "cwd": composition.cwd,
        "context": composition.context,
        "commandOverride": command_override,
        "permissionMode": permission_mode,
    });
    spawn_background(
        app,
        invocation_id,
        cmd,
        composition.cwd,
        env,
        stdin_payload,
        metadata,
        run_request,
        retry_payload,
    )
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
    if !skill.valid {
        return Err(format!(
            "skill_frontmatter_invalid: {}",
            skill.validation_errors.join(", ")
        ));
    }
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
    out.push_str("You are running an Maru-managed skill.\n\n");
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

fn build_agent_run_request(
    composition: &DispatchComposition,
    runtime: &str,
    mode: &str,
    metadata: Option<JsonValue>,
) -> Result<AgentRunRequest, String> {
    let request = AgentRunRequest {
        intent: composition.prompt.clone(),
        runtime_provider: runtime.to_string(),
        skill_id: Some(composition.skill_id.clone()),
        cwd: composition.cwd.clone(),
        context: composition
            .context
            .iter()
            .map(|item| AgentRunContextItem {
                path: item.path.clone(),
                kind: item.kind.clone(),
            })
            .collect(),
        mode: mode.to_string(),
        approval_policy: "proposal-only".to_string(),
        schema_version: AGENT_RUN_REQUEST_SCHEMA_VERSION.to_string(),
        metadata,
    };
    request.validate()?;
    Ok(request)
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
    metadata: Option<JsonValue>,
    run_request: AgentRunRequest,
    retry_payload: JsonValue,
) -> Result<String, String> {
    let _ = append_run_event_payload(
        &cwd,
        &invocation_id,
        "run.started",
        "maru.skill_host",
        serde_json::json!({
            "request": run_request,
            "dispatch": retry_payload,
        }),
    );
    cmd.current_dir(&cwd)
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
    cmd.no_window();
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let message = format_spawn_error(&err);
            let _ = append_run_event_payload(
                &cwd,
                &invocation_id,
                "run.failed",
                "maru.skill_host",
                serde_json::json!({ "error": message }),
            );
            return Err(message);
        }
    };
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
    let stdout_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        cwd.clone(),
        "stdout".to_string(),
        stdout,
        Some(stdout_buffer.clone()),
    );
    spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        cwd.clone(),
        "stderr".to_string(),
        stderr,
        Some(stderr_buffer.clone()),
    );
    let _ = mission_state::register_mission_with_metadata(
        &app,
        &invocation_id,
        "skill",
        child_pid,
        metadata,
    );
    let app_done = app.clone();
    let id_done = invocation_id.clone();
    let cwd_done = cwd.clone();
    thread::spawn(move || match child.wait() {
        Ok(status) => {
            if !status.success() {
                let raw_error = stderr_buffer
                    .lock()
                    .map(|buffer| buffer.clone())
                    .unwrap_or_default();
                let error_kind = classify_runtime_error(&raw_error, "runtime_failed");
                let message = raw_error
                    .lines()
                    .next()
                    .filter(|line| !line.trim().is_empty())
                    .unwrap_or("runtime_failed")
                    .to_string();
                let _ = append_run_event_payload(
                    &cwd_done,
                    &id_done,
                    "run.failed",
                    "maru.skill_host",
                    serde_json::json!({
                        "errorKind": error_kind,
                        "message": message,
                        "exitCode": status.code(),
                    }),
                );
                let _ = app_done.emit(
                    "ai://error",
                    AiErrorEvent {
                        invocation_id: id_done.clone(),
                        kind: error_kind.to_string(),
                        message,
                    },
                );
            }
            if status.success() {
                if let Ok(raw) = stdout_buffer.lock().map(|buffer| buffer.clone()) {
                    if let Ok(proposal) = parse_skill_proposal(&raw) {
                        let _ = append_run_event_payload(
                            &cwd_done,
                            &id_done,
                            "proposal.created",
                            "maru.skill_host",
                            serde_json::json!({ "proposal": proposal }),
                        );
                    }
                }
            }
            let _ = append_run_event_payload(
                &cwd_done,
                &id_done,
                "run.completed",
                "maru.skill_host",
                serde_json::json!({
                    "exitCode": status.code(),
                    "success": status.success(),
                }),
            );
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
            let _ = append_run_event_payload(
                &cwd_done,
                &id_done,
                "run.failed",
                "maru.skill_host",
                serde_json::json!({ "error": err.to_string() }),
            );
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

fn runtime_status(
    runtime: String,
    command_override: Option<&str>,
) -> Result<SkillRuntimeStatus, String> {
    let runtime = normalize_runtime(&runtime)?;
    let provider = CliProviderKind::parse(&runtime)?;
    let Some(binary) = resolve_provider_binary(provider, command_override) else {
        return Ok(SkillRuntimeStatus {
            runtime,
            available: false,
            binary_path: None,
            version: None,
            auth_status: "unknown".to_string(),
            error_kind: Some("cli_missing".to_string()),
            message: format!("{} CLI not found", provider.id()),
            suggested_action: Some(format!(
                "Install {} CLI or configure its command path.",
                provider.id()
            )),
        });
    };
    let version = run_status_command(&binary, &["--version"]);
    let auth = match provider {
        CliProviderKind::Claude => run_status_command(&binary, &["auth", "status"]),
        CliProviderKind::Codex => run_status_command(&binary, &["login", "status"]),
    };
    let version_text = version.ok_text();
    let auth_text = auth.output_text();
    let auth_ok = auth.success;
    let error_kind = if !version.success {
        Some(classify_runtime_error(&version.output_text(), "runtime_failed").to_string())
    } else if !auth_ok {
        Some(classify_runtime_error(&auth_text, "auth_required").to_string())
    } else {
        None
    };
    let available = version.success && auth_ok;
    let suggested_action = error_kind.as_deref().map(|kind| match kind {
        "auth_required" => format!(
            "Run `{}` login/auth in a terminal and try again.",
            provider.id()
        ),
        "permission_denied" => {
            "Check executable permissions for the configured CLI path.".to_string()
        }
        _ => format!("Check `{}` installation and configuration.", provider.id()),
    });
    Ok(SkillRuntimeStatus {
        runtime,
        available,
        binary_path: Some(host_fs::display_path(&binary)),
        version: version_text,
        auth_status: if auth_ok {
            "authenticated"
        } else {
            "unavailable"
        }
        .to_string(),
        error_kind,
        message: if available {
            format!("{} runtime ready", provider.id())
        } else {
            auth_text
                .lines()
                .next()
                .filter(|line| !line.trim().is_empty())
                .unwrap_or("Runtime is not ready")
                .to_string()
        },
        suggested_action,
    })
}

struct StatusCommandResult {
    success: bool,
    stdout: String,
    stderr: String,
}

impl StatusCommandResult {
    fn output_text(&self) -> String {
        [self.stdout.trim(), self.stderr.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn ok_text(&self) -> Option<String> {
        self.success
            .then(|| {
                self.output_text()
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim()
                    .to_string()
            })
            .filter(|value| !value.is_empty())
    }
}

fn run_status_command(binary: &Path, args: &[&str]) -> StatusCommandResult {
    let mut cmd = Command::new(binary);
    cmd.args(args).no_window();
    // ETXTBSY retry: status probes may exec a just-written binary (tests,
    // freshly installed CLIs) while another thread's fork holds its fd.
    match crate::agent_host::provider::retry_etxtbsy(|| cmd.output()) {
        Ok(output) => StatusCommandResult {
            success: output.status.success(),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        },
        Err(err) => StatusCommandResult {
            success: false,
            stdout: String::new(),
            stderr: format_spawn_error(&err),
        },
    }
}

fn classify_runtime_error(text: &str, fallback: &str) -> &'static str {
    let lower = text.to_lowercase();
    if lower.contains("auth")
        || lower.contains("login")
        || lower.contains("not logged in")
        || lower.contains("api key")
        || lower.contains("unauthorized")
    {
        "auth_required"
    } else if lower.contains("permission") || lower.contains("denied") {
        "permission_denied"
    } else if lower.contains("not found") || lower.contains("cli_missing") {
        "cli_missing"
    } else if fallback == "auth_required" {
        "auth_required"
    } else {
        "runtime_failed"
    }
}

fn append_background_contract(prompt: &str, approved_execution: bool) -> String {
    let rules = if approved_execution {
        vec![
            "- This run starts after explicit Maru approval; follow only the approved execution contract above.",
            "- Emit concise progress logs and a final human-readable completion summary.",
        ]
    } else {
        vec![
            "- Do not directly write, delete, rename, or move files.",
            "- If changes are needed, emit exactly one maru_skill_proposal_v1 JSON block.",
            "- Keep progress logs concise and human-readable.",
            "- Actual file writes must happen only through Maru approval and Apply.",
        ]
    };
    let mut lines = vec![prompt.trim(), "", "<maru_background_run_contract>"];
    lines.extend(rules);
    lines.push("</maru_background_run_contract>");
    lines.join("\n")
}

fn metadata_bool(metadata: &Option<JsonValue>, key: &str) -> bool {
    metadata
        .as_ref()
        .and_then(|value| value.get(key))
        .and_then(|value| value.as_bool())
        .unwrap_or(false)
}

fn spawn_line_pump<R>(
    app: AppHandle,
    invocation_id: String,
    cwd: String,
    stream_name: String,
    source: R,
    buffer: Option<Arc<Mutex<String>>>,
) where
    R: Read + Send + 'static,
{
    thread::spawn(move || {
        let reader = BufReader::new(source);
        for line in reader.lines() {
            let Ok(line) = line else {
                break;
            };
            if let Some(buffer) = buffer.as_ref() {
                if let Ok(mut buffer) = buffer.lock() {
                    buffer.push_str(&line);
                    buffer.push('\n');
                }
            }
            let _ = app.emit(
                "ai://output",
                AiOutputEvent {
                    invocation_id: invocation_id.clone(),
                    stream: stream_name.clone(),
                    line: line.clone(),
                },
            );
            let _ = append_run_event_payload(
                &cwd,
                &invocation_id,
                "provider.output",
                "provider",
                serde_json::json!({
                    "stream": stream_name.clone(),
                    "line": line.clone(),
                }),
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
    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::path::PathBuf;

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

    #[test]
    fn runtime_error_classification_handles_common_failures() {
        assert_eq!(
            classify_runtime_error("not logged in; run login first", "runtime_failed"),
            "auth_required"
        );
        assert_eq!(
            classify_runtime_error("Permission denied", "runtime_failed"),
            "permission_denied"
        );
        assert_eq!(
            classify_runtime_error("command not found", "runtime_failed"),
            "cli_missing"
        );
    }

    #[test]
    fn background_contract_is_proposal_only_by_default() {
        let prompt = append_background_contract("Do the work", false);
        assert!(prompt.contains("maru_skill_proposal_v1"));
        assert!(prompt.contains("Do not directly write"));
    }

    #[test]
    fn approved_background_contract_preserves_execution_flow() {
        let prompt = append_background_contract("Approved MCP Obsidian work", true);
        assert!(prompt.contains("explicit Maru approval"));
        assert!(!prompt.contains("Do not directly write"));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_status_uses_command_override_and_reports_ready() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-claude"),
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake claude 1.2.3"; exit 0; fi
if [ "$1" = "auth" ] && [ "$2" = "status" ]; then echo "authenticated"; exit 0; fi
echo "unexpected args: $*" >&2
exit 2
"#,
        );
        let status = runtime_status("claude".to_string(), Some(cli.to_str().unwrap())).unwrap();
        assert!(status.available);
        assert_eq!(status.version.as_deref(), Some("fake claude 1.2.3"));
        assert_eq!(status.auth_status, "authenticated");
        assert_eq!(status.binary_path.as_deref(), Some(cli.to_str().unwrap()));
    }

    #[cfg(unix)]
    #[test]
    fn runtime_status_classifies_auth_required() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(
            dir.path().join("fake-codex"),
            r#"#!/bin/sh
if [ "$1" = "--version" ]; then echo "fake codex 0.1.0"; exit 0; fi
echo "not logged in" >&2
exit 1
"#,
        );
        let status = runtime_status("codex".to_string(), Some(cli.to_str().unwrap())).unwrap();
        assert!(!status.available);
        assert_eq!(status.error_kind.as_deref(), Some("auth_required"));
    }

    #[cfg(unix)]
    fn write_fake_cli(path: PathBuf, script: &str) -> PathBuf {
        fs::write(&path, script).unwrap();
        let mut perms = fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        fs::set_permissions(&path, perms).unwrap();
        path
    }
}
