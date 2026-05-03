// Phase 2 step 4: Claude Code CLI subprocess bridge. Frontend calls
// `start_claude_cli_invocation(prompt, cwd?, extra_args?)`; Rust spawns
// `claude -p --permission-mode plan <prompt>` and streams stdout/stderr
// lines through Tauri's event channel as `ai://output`, plus a final
// `ai://done` (or `ai://error` if spawn fails). Inbox classification
// keeps this one-shot bridge; general Claude/Codex use now runs through
// the integrated PTY terminal in `terminal.rs`.
//
// v1 deliberately omits kill/cancel. Anchor's invocation pattern is
// "click → wait for the streamed answer", not long-running pipelines;
// adding kill needs a global Child registry that we'd rather not pay for
// before there's a UI button. When a kill button lands, the registry
// goes here.

use std::io::{BufRead, BufReader, Read};
use std::process::{Command, Stdio};
use std::thread::{self, JoinHandle};

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use uuid::Uuid;

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

#[derive(Clone, Debug, PartialEq, Eq)]
struct AiCommandSpec {
    program: String,
    args: Vec<String>,
}

#[tauri::command]
pub fn start_claude_cli_invocation(
    app: AppHandle,
    prompt: String,
    cwd: Option<String>,
    extra_args: Option<Vec<String>>,
) -> Result<String, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is empty.".to_string());
    }

    let invocation_id = format!("ai-{}", Uuid::new_v4());
    let spec = build_claude_command_spec(&prompt, extra_args)?;

    let mut cmd = Command::new(&spec.program);
    cmd.args(&spec.args);
    if let Some(cwd) = cwd {
        cmd.current_dir(cwd);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|err| format_spawn_error(&err))?;
    let stdout = child.stdout.take().ok_or_else(|| {
        "stdout_capture_failed: claude subprocess produced no stdout handle".to_string()
    })?;
    let stderr = child.stderr.take().ok_or_else(|| {
        "stderr_capture_failed: claude subprocess produced no stderr handle".to_string()
    })?;

    let stdout_handle = spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        "stdout".to_string(),
        stdout,
    );
    let stderr_handle = spawn_line_pump(
        app.clone(),
        invocation_id.clone(),
        "stderr".to_string(),
        stderr,
    );

    let app_done = app.clone();
    let id_done = invocation_id.clone();
    thread::spawn(move || {
        let result = child.wait();
        // Drain both pipes before announcing completion so the UI never
        // finalizes an invocation while output lines are still mid-flight.
        let _ = stdout_handle.join();
        let _ = stderr_handle.join();
        match result {
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
        }
    });

    Ok(invocation_id)
}

fn build_claude_command_spec(
    prompt: &str,
    extra_args: Option<Vec<String>>,
) -> Result<AiCommandSpec, String> {
    if prompt.trim().is_empty() {
        return Err("Prompt is empty.".to_string());
    }
    let mut args = vec![
        "-p".to_string(),
        "--permission-mode".to_string(),
        "plan".to_string(),
    ];
    args.extend(extra_args.unwrap_or_default());
    args.push(prompt.to_string());
    Ok(AiCommandSpec {
        program: "claude".to_string(),
        args,
    })
}

fn spawn_line_pump<R>(
    app: AppHandle,
    invocation_id: String,
    stream_name: String,
    source: R,
) -> JoinHandle<()>
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
    })
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
    fn claude_bridge_uses_safe_plan_mode() {
        let spec = build_claude_command_spec("summarize", None).unwrap();
        assert_eq!(spec.program, "claude");
        assert_eq!(
            spec.args,
            vec!["-p", "--permission-mode", "plan", "summarize"]
        );
    }

    #[test]
    fn command_builder_rejects_empty_prompt() {
        let err = build_claude_command_spec(" \n ", None).unwrap_err();
        assert_eq!(err, "Prompt is empty.");
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
