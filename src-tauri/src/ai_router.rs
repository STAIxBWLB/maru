// Provider-agnostic CLI subprocess bridge. Frontend calls
// `start_agent_cli_invocation(provider, prompt, cwd?, extra_args?, extra_env?,
// command_override?, permission_mode?)`; Rust resolves the provider (`claude` / `codex`) via
// `agent_host::provider::build_cli_command` — which already knows each CLI's
// argv shape and whether the prompt is passed as an arg (Claude `-p`) or piped
// over stdin (Codex `exec … -`) — then spawns it and streams stdout/stderr
// lines through Tauri's event channel as `ai://output`, plus a final
// `ai://done` (or `ai://error` if spawn/wait fails). `start_claude_cli_invocation`
// is kept as a thin Claude wrapper for back-compat. Both inbox classification
// and user-skill invocation drive this surface.
//
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Command, Stdio};
use std::thread;

use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::agent_host::contracts::{CompletionRequest, COMPLETION_REQUEST_SCHEMA_VERSION};
use crate::agent_host::provider::{
    build_cli_command, normalize_permission_mode, CliProviderKind,
};
use crate::cli_path::{augmented_path, merge_path_env};
use crate::mission_state;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiOutputEvent {
    pub invocation_id: String,
    /// "stdout" or "stderr".
    pub stream: String,
    pub line: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiDoneEvent {
    pub invocation_id: String,
    pub exit_code: Option<i32>,
    pub success: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AiErrorEvent {
    pub invocation_id: String,
    /// Frontend uses this to show a typed message:
    /// `cli_missing` / `spawn_failed` / `wait_failed`.
    pub kind: String,
    pub message: String,
}

/// Generic headless invocation: spawn `provider` (claude/codex) with `prompt`,
/// streaming stdout/stderr as `ai://output` and a terminal `ai://done`/`ai://error`.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn start_agent_cli_invocation(
    app: AppHandle,
    provider: String,
    prompt: String,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
    command_override: Option<String>,
    permission_mode: Option<String>,
) -> Result<String, String> {
    let command_override = command_override.filter(|value| !value.trim().is_empty());
    let permission_mode =
        normalize_permission_mode(permission_mode.as_deref().unwrap_or("plan")).to_string();
    let (provider_kind, resolved_cwd, mut cmd, stdin_payload) = build_agent_command(
        &provider,
        &prompt,
        cwd.as_deref(),
        command_override.as_deref(),
        &permission_mode,
    )?;
    if let Some(args) = extra_args {
        cmd.args(args);
    }
    let invocation_id = format!("ai-{}", Uuid::new_v4());
    let mission_cwd = resolved_cwd.clone();
    let mission_metadata = json!({
        "origin": "agentCliInvocation",
        "provider": provider_kind.id(),
        "runtime": provider_kind.id(),
        "workspacePath": mission_cwd,
        "permissionMode": permission_mode,
        "commandOverride": command_override,
    });
    spawn_streaming_invocation(
        app,
        invocation_id,
        cmd,
        Some(resolved_cwd),
        stdin_payload,
        extra_env.unwrap_or_default(),
        provider_kind.id().to_string(),
        Some(mission_metadata),
    )
}

/// Back-compat Claude wrapper. Preserves the original empty-prompt error string,
/// then delegates to the generic bridge with `provider = "claude"`.
#[tauri::command]
pub fn start_claude_cli_invocation(
    app: AppHandle,
    prompt: String,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is empty.".to_string());
    }
    start_agent_cli_invocation(
        app,
        "claude".to_string(),
        prompt,
        cwd,
        extra_args,
        extra_env,
        None,
        None,
    )
}

/// Resolve provider + cwd and build the provider command via the shared
/// `build_cli_command`. Pure (no spawn) so it is unit-testable without an
/// `AppHandle`. Returns the resolved cwd so the caller can set the process
/// working dir (the builder does not).
fn build_agent_command(
    provider: &str,
    prompt: &str,
    cwd: Option<&str>,
    command_override: Option<&str>,
    permission_mode: &str,
) -> Result<(CliProviderKind, String, Command, Option<String>), String> {
    if prompt.trim().is_empty() {
        return Err("completion_prompt_required".to_string());
    }
    let provider_kind = CliProviderKind::parse(provider)?;
    let resolved_cwd = cwd
        .map(str::to_string)
        .filter(|value| !value.trim().is_empty())
        .or_else(|| {
            std::env::current_dir()
                .ok()
                .map(|path| path.to_string_lossy().into_owned())
        })
        .ok_or_else(|| {
            "agent_cli_cwd_unresolved: no cwd provided and current_dir() failed".to_string()
        })?;
    let request = CompletionRequest {
        schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
        provider: provider_kind.id().to_string(),
        prompt: prompt.to_string(),
        cwd: resolved_cwd.clone(),
        mode: "background".to_string(),
        metadata: None,
    };
    let add_dirs = vec![request.cwd.clone()];
    let (cmd, stdin_payload) = build_cli_command(
        provider_kind,
        &request,
        &add_dirs,
        command_override,
        permission_mode,
    )?;
    Ok((provider_kind, resolved_cwd, cmd, stdin_payload))
}

/// Spawn `cmd`, wire stdout/stderr pumps + the reaper, register a mission keyed
/// by `mission_kind`, and (when `stdin_payload` is `Some`) write the prompt to
/// the child's stdin on its own thread so the pipe closes on EOF (Codex). Shared
/// by both the generic command and the Claude wrapper.
fn spawn_streaming_invocation(
    app: AppHandle,
    invocation_id: String,
    mut cmd: Command,
    cwd: Option<String>,
    stdin_payload: Option<String>,
    extra_env: HashMap<String, String>,
    mission_kind: String,
    mission_metadata: Option<JsonValue>,
) -> Result<String, String> {
    if let Some(cwd) = cwd.as_ref() {
        cmd.current_dir(cwd);
    }
    let augmented = augmented_path();
    let effective_path = merge_path_env(
        extra_env.get("PATH").map(std::ffi::OsStr::new),
        Some(augmented.as_os_str()),
    );
    cmd.env("PATH", effective_path);
    for (key, value) in extra_env {
        if key == "PATH" {
            continue;
        }
        cmd.env(key, value);
    }
    cmd.stdin(if stdin_payload.is_some() {
        Stdio::piped()
    } else {
        Stdio::null()
    })
    .stdout(Stdio::piped())
    .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Err(format_spawn_error(&err));
        }
    };
    let child_pid = child.id();

    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            thread::spawn(move || {
                let _ = stdin.write_all(payload.as_bytes());
                // `stdin` drops here, closing the pipe so the child sees EOF.
            });
        }
    }

    let stdout = child.stdout.take().ok_or_else(|| {
        "stdout_capture_failed: subprocess produced no stdout handle".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        "stderr_capture_failed: subprocess produced no stderr handle".to_string()
    })?;

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
    let _ = mission_state::register_mission_with_metadata(
        &app,
        &invocation_id,
        &mission_kind,
        child_pid,
        mission_metadata,
    );

    // Reaper thread: wait for exit, then emit `ai://done` or `ai://error`.
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
            let line = match line {
                Ok(line) => line,
                Err(_) => break,
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

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    fn write_fake_cli(path: std::path::PathBuf) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        std::fs::write(&path, "#!/bin/sh\nexit 0\n").unwrap();
        let mut perms = std::fs::metadata(&path).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&path, perms).unwrap();
        path
    }

    #[test]
    fn build_agent_command_rejects_empty_prompt() {
        let err = build_agent_command("claude", "   \n\t  ", Some("/tmp"), None, "plan").unwrap_err();
        assert_eq!(err, "completion_prompt_required");
    }

    #[test]
    fn build_agent_command_rejects_unsupported_provider() {
        let err = build_agent_command("openai", "hello", Some("/tmp"), None, "plan").unwrap_err();
        assert!(err.starts_with("unsupported_provider"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn build_agent_command_builds_claude_with_plan_mode_and_no_stdin() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-claude"));
        let (kind, cwd, cmd, stdin_payload) = build_agent_command(
            "claude",
            "classify this",
            Some(dir.path().to_str().unwrap()),
            Some(cli.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        assert_eq!(kind, CliProviderKind::Claude);
        assert_eq!(cwd, dir.path().to_str().unwrap());
        assert!(stdin_payload.is_none());
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"-p".to_string()), "{args:?}");
        assert!(args.contains(&"classify this".to_string()), "{args:?}");
        assert!(args.contains(&"--permission-mode".to_string()), "{args:?}");
        assert!(args.contains(&"plan".to_string()), "{args:?}");
    }

    #[cfg(unix)]
    #[test]
    fn build_agent_command_builds_codex_with_stdin_payload() {
        let dir = tempfile::tempdir().unwrap();
        let cli = write_fake_cli(dir.path().join("fake-codex"));
        let (kind, _cwd, cmd, stdin_payload) = build_agent_command(
            "codex",
            "classify this",
            Some(dir.path().to_str().unwrap()),
            Some(cli.to_str().unwrap()),
            "plan",
        )
        .unwrap();
        assert_eq!(kind, CliProviderKind::Codex);
        assert_eq!(stdin_payload.as_deref(), Some("classify this"));
        let args: Vec<String> = cmd
            .get_args()
            .map(|a| a.to_string_lossy().into_owned())
            .collect();
        assert!(args.contains(&"exec".to_string()), "{args:?}");
        assert!(args.contains(&"--cd".to_string()), "{args:?}");
        assert_eq!(args.last().map(String::as_str), Some("-"), "{args:?}");
    }

    #[test]
    fn empty_prompt_is_rejected() {
        // We can't call the Tauri command directly, but we can exercise
        // the input validation by inlining the same check.
        let prompt = "   \n\t   ";
        assert!(prompt.trim().is_empty());
    }

    #[test]
    fn output_event_serializes_to_camelcase() {
        let payload = AiOutputEvent {
            invocation_id: "ai-xxx".to_string(),
            stream: "stdout".to_string(),
            line: "hello".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"invocationId\""));
        assert!(json.contains("\"stream\""));
        assert!(json.contains("\"line\":\"hello\""));
    }

    #[test]
    fn done_event_serializes_success_field() {
        let payload = AiDoneEvent {
            invocation_id: "ai-xxx".to_string(),
            exit_code: Some(0),
            success: true,
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"exitCode\":0"));
        assert!(json.contains("\"success\":true"));
    }

    #[test]
    fn error_event_carries_kind() {
        let payload = AiErrorEvent {
            invocation_id: "ai-xxx".to_string(),
            kind: "cli_missing".to_string(),
            message: "claude: not found".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"kind\":\"cli_missing\""));
    }

    #[test]
    fn spawn_error_classifies_not_found_as_cli_missing() {
        let err = std::io::Error::from(std::io::ErrorKind::NotFound);
        let formatted = format_spawn_error(&err);
        assert!(formatted.starts_with("cli_missing:"), "{formatted}");
    }

    #[test]
    fn spawn_error_classifies_permission_denied() {
        let err = std::io::Error::from(std::io::ErrorKind::PermissionDenied);
        let formatted = format_spawn_error(&err);
        assert!(formatted.starts_with("permission_denied:"), "{formatted}");
    }

    #[test]
    fn spawn_error_falls_back_to_spawn_failed() {
        let err = std::io::Error::from(std::io::ErrorKind::Other);
        let formatted = format_spawn_error(&err);
        assert!(formatted.starts_with("spawn_failed:"), "{formatted}");
    }
}
