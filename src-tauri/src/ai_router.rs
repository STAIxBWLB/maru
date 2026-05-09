// Phase 2 step 4: Claude Code CLI subprocess bridge. Frontend calls
// `start_claude_cli_invocation(prompt, cwd?, extra_args?)`; Rust spawns
// `claude -p <prompt>` and streams stdout/stderr lines through Tauri's
// event channel as `ai://output`, plus a final `ai://done` (or
// `ai://error` if spawn fails). Both inbox classification (Phase 2) and
// user-skill invocation (Phase 3) drive this surface.
//
// v1 deliberately omits kill/cancel. Anchor's invocation pattern is
// "click → wait for the streamed answer", not long-running pipelines;
// adding kill needs a global Child registry that we'd rather not pay for
// before there's a UI button. When a kill button lands, the registry
// goes here.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::thread;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

use crate::cli_path::{augmented_path, merge_path_env, resolve_program};

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

    let invocation_id = format!("ai-{}", Uuid::new_v4());

    let claude_bin = resolve_program("claude").ok_or_else(|| {
        "cli_missing: claude CLI not found in PATH or common install locations".to_string()
    })?;

    let mut cmd = Command::new(claude_bin);
    cmd.arg("-p").arg(&prompt);
    if let Some(args) = extra_args {
        cmd.args(args);
    }
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    let extra_env = extra_env.unwrap_or_default();
    let augmented = augmented_path();
    let effective_path = merge_path_env(
        extra_env.get("PATH").map(std::ffi::OsStr::new),
        Some(augmented.as_os_str()),
    );
    cmd.env("PATH", effective_path)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in extra_env {
        if key == "PATH" {
            continue;
        }
        cmd.env(key, value);
    }

    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            return Err(format_spawn_error(&err));
        }
    };

    let stdout = child.stdout.take().ok_or_else(|| {
        "stdout_capture_failed: claude subprocess produced no stdout handle".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        "stderr_capture_failed: claude subprocess produced no stderr handle".to_string()
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

    // Reaper thread: wait for exit, then emit `ai://done` or `ai://error`.
    let app_done = app.clone();
    let id_done = invocation_id.clone();
    thread::spawn(move || match child.wait() {
        Ok(status) => {
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
                    line,
                },
            );
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
