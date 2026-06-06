mod input;
mod model;
mod snapshot;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::env;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

use crate::cli_path::{augmented_path, merge_path_env, resolve_program};
pub use input::{encode_mouse_input, encode_terminal_input, TerminalInputCommand};

use self::model::{write_shared, SharedTerminalWriter, TerminalModel};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;
const FRAME_COALESCE_MS: u64 = 16;

#[derive(Clone, Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
}

struct TerminalSession {
    kind: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SharedTerminalWriter,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    model: Arc<Mutex<TerminalModel>>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct TerminalCommandSpec {
    program: String,
    args: Vec<String>,
    cwd: PathBuf,
    extra_env: HashMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub session_id: String,
    pub exit_code: Option<i32>,
}

#[tauri::command]
pub fn terminal_spawn(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    kind: String,
    cwd: Option<String>,
    command: Option<String>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("terminal_session_id_required".to_string());
    }
    {
        let guard = state
            .sessions
            .lock()
            .map_err(|_| "terminal_registry_poisoned".to_string())?;
        if guard.contains_key(&session_id) {
            return Err(format!("terminal_session_id_in_use: {session_id}"));
        }
    }

    let spec = build_terminal_command_spec(
        &kind,
        cwd.as_deref(),
        command.as_deref(),
        extra_args,
        extra_env,
    )?;
    let initial_cols = cols.unwrap_or(DEFAULT_COLS).clamp(2, MAX_COLS);
    let initial_rows = rows.unwrap_or(DEFAULT_ROWS).clamp(1, MAX_ROWS);
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(PtySize {
            rows: initial_rows,
            cols: initial_cols,
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| format!("terminal_pty_failed: {err}"))?;

    let program = resolve_terminal_program(&spec.program)?;
    let mut cmd = CommandBuilder::new(program.as_os_str());
    cmd.args(&spec.args);
    cmd.cwd(spec.cwd.as_os_str());
    let augmented = augmented_path();
    let effective_path = merge_path_env(
        spec.extra_env.get("PATH").map(std::ffi::OsStr::new),
        Some(augmented.as_os_str()),
    );
    cmd.env("PATH", effective_path);
    #[cfg(not(windows))]
    {
        cmd.env("TERM", "xterm-256color");
        cmd.env("COLORTERM", "truecolor");
    }
    for (key, value) in &spec.extra_env {
        if key == "PATH" {
            continue;
        }
        cmd.env(key, value);
    }

    let reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| format!("terminal_reader_failed: {err}"))?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|err| format!("terminal_writer_failed: {err}"))?;
    let shared_writer: SharedTerminalWriter = Arc::new(Mutex::new(writer));
    let model = Arc::new(Mutex::new(TerminalModel::with_shared_writer_size(
        shared_writer.clone(),
        initial_cols,
        initial_rows,
    )));
    {
        let guard = model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        let _ = app.emit("terminal://frame", guard.snapshot(&session_id));
    }

    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("terminal_spawn_failed: {err}"))?;
    let killer = child.clone_killer();

    let session = Arc::new(TerminalSession {
        kind: kind.clone(),
        master: Mutex::new(pair.master),
        writer: shared_writer,
        killer: Mutex::new(killer),
        model: model.clone(),
    });
    state
        .sessions
        .lock()
        .map_err(|_| "terminal_registry_poisoned".to_string())?
        .insert(session_id.clone(), session);

    let pump_handle = spawn_output_pump(app.clone(), session_id.clone(), reader, model);

    let sessions = state.sessions.clone();
    let exit_app = app.clone();
    let exit_id = session_id.clone();
    thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        if let Ok(mut guard) = sessions.lock() {
            guard.remove(&exit_id);
        }
        let _ = pump_handle.join();
        let _ = exit_app.emit(
            "terminal://exit",
            TerminalExitEvent {
                session_id: exit_id,
                exit_code,
            },
        );
    });

    Ok(session_id)
}

#[tauri::command]
pub fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    write_shared(&session.writer, data.as_bytes())
}

#[tauri::command]
pub fn terminal_input(
    state: State<'_, TerminalState>,
    session_id: String,
    command: TerminalInputCommand,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    let is_mouse = matches!(
        command,
        TerminalInputCommand::Mouse { .. } | TerminalInputCommand::Wheel { .. }
    );
    let encoded = {
        let guard = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        if is_mouse {
            // Mouse reports are gated on the program's active mouse modes, read
            // under the same lock so a stale frame can't inject bytes.
            encode_mouse_input(&command, guard.mouse_modes())
        } else {
            encode_terminal_input(
                &session.kind,
                &command,
                guard.kitty_keyboard_active(),
                guard.bracketed_paste_active(),
            )
        }
    };
    if let Some(data) = encoded {
        write_shared(&session.writer, data.as_bytes())?;
    }
    Ok(())
}

/// Scroll the viewport through scrollback by `delta` lines (positive = toward
/// history). Emits a fresh full frame so the renderer shows the scrolled view.
#[tauri::command]
pub fn terminal_scroll(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    delta: i32,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    let frame = {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        model.scroll(delta);
        model.snapshot(&session_id)
    };
    let _ = app.emit("terminal://frame", frame);
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    app: AppHandle,
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    let cols = cols.clamp(2, MAX_COLS);
    let rows = rows.clamp(1, MAX_ROWS);
    {
        let master = session
            .master
            .lock()
            .map_err(|_| "terminal_master_poisoned".to_string())?;
        master
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| format!("terminal_resize_failed: {err}"))?;
    }
    {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        model.resize(cols, rows);
        let _ = app.emit("terminal://frame", model.snapshot(&session_id));
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_kill(state: State<'_, TerminalState>, session_id: String) -> Result<(), String> {
    let session = {
        let mut guard = state
            .sessions
            .lock()
            .map_err(|_| "terminal_registry_poisoned".to_string())?;
        guard.remove(&session_id)
    };
    let Some(session) = session else {
        return Ok(());
    };
    let mut killer = session
        .killer
        .lock()
        .map_err(|_| "terminal_killer_poisoned".to_string())?;
    killer
        .kill()
        .map_err(|err| format!("terminal_kill_failed: {err}"))
}

fn get_session(
    state: &State<'_, TerminalState>,
    session_id: &str,
) -> Result<Arc<TerminalSession>, String> {
    state
        .sessions
        .lock()
        .map_err(|_| "terminal_registry_poisoned".to_string())?
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown terminal session: {session_id}"))
}

fn spawn_output_pump(
    app: AppHandle,
    session_id: String,
    mut reader: Box<dyn Read + Send>,
    model: Arc<Mutex<TerminalModel>>,
) -> JoinHandle<()> {
    // The reader thread drains the PTY at full speed (no coalescing on this
    // path — the old in-reader `thread::sleep` was a source of input
    // backpressure) and only flags the model dirty. A separate emitter thread
    // coalesces dirty notifications into at most one `terminal://frame` per
    // FRAME_COALESCE_MS, sending only the rows alacritty reports as damaged.
    let dirty = Arc::new(AtomicBool::new(true));
    let running = Arc::new(AtomicBool::new(true));
    let emitter = spawn_frame_emitter(
        app,
        session_id,
        model.clone(),
        dirty.clone(),
        running.clone(),
    );

    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    {
                        let mut guard = match model.lock() {
                            Ok(guard) => guard,
                            Err(_) => break,
                        };
                        guard.advance(&buf[..n]);
                    }
                    dirty.store(true, Ordering::Release);
                }
                Err(_) => break,
            }
        }
        running.store(false, Ordering::Release);
        let _ = emitter.join();
    })
}

fn spawn_frame_emitter(
    app: AppHandle,
    session_id: String,
    model: Arc<Mutex<TerminalModel>>,
    dirty: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(FRAME_COALESCE_MS));
        let was_dirty = dirty.swap(false, Ordering::AcqRel);
        if !was_dirty {
            // Idle: keep looping while the session lives; exit once the reader
            // has stopped and the last frame has been flushed.
            if running.load(Ordering::Acquire) {
                continue;
            }
            break;
        }
        let frame = {
            let mut guard = match model.lock() {
                Ok(guard) => guard,
                Err(_) => break,
            };
            match guard.take_damage() {
                Some(rows) if rows.is_empty() => continue,
                Some(rows) => guard.snapshot_dirty(&session_id, &rows),
                None => guard.snapshot(&session_id),
            }
        };
        let _ = app.emit("terminal://frame", frame);
    })
}

fn build_terminal_command_spec(
    kind: &str,
    cwd: Option<&str>,
    command_override: Option<&str>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
) -> Result<TerminalCommandSpec, String> {
    let cwd = resolve_terminal_cwd(cwd)?;
    let cwd_str = cwd.to_string_lossy().to_string();
    let extras = extra_args.unwrap_or_default();
    let custom = command_override
        .map(str::trim)
        .filter(|value| !value.is_empty());

    let (program, mut args) = match (kind, custom) {
        (_, Some(program)) => (program.to_string(), Vec::<String>::new()),
        ("claude", None) => ("claude".to_string(), Vec::new()),
        ("codex", None) => ("codex".to_string(), vec!["--cd".to_string(), cwd_str]),
        ("shell", None) => (default_shell_program(), Vec::new()),
        (other, None) => return Err(format!("Unsupported terminal launcher: {other}")),
    };
    args.extend(extras);
    let mut extra_env = extra_env.unwrap_or_default();
    extra_env
        .entry("TERM_PROGRAM".to_string())
        .or_insert_with(|| default_term_program(kind).to_string());
    Ok(TerminalCommandSpec {
        program,
        args,
        cwd,
        extra_env,
    })
}

fn default_term_program(kind: &str) -> &'static str {
    if kind == "claude" || kind == "codex" {
        "ghostty"
    } else {
        "Anchor"
    }
}

fn resolve_terminal_cwd(cwd: Option<&str>) -> Result<PathBuf, String> {
    let raw = match cwd.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => PathBuf::from(value),
        None => env::current_dir().map_err(|err| format!("terminal_cwd_failed: {err}"))?,
    };
    let path = raw
        .canonicalize()
        .map_err(|err| format!("terminal_cwd_invalid: {err}"))?;
    if !path.is_dir() {
        return Err("terminal_cwd_invalid: cwd is not a directory".to_string());
    }
    Ok(strip_unc_prefix(path))
}

#[cfg(windows)]
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        if !stripped.starts_with("UNC\\") {
            return PathBuf::from(stripped);
        }
    }
    path
}

#[cfg(not(windows))]
fn strip_unc_prefix(path: PathBuf) -> PathBuf {
    path
}

#[cfg(not(windows))]
fn default_shell_program() -> String {
    if let Some(shell) = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        if std::path::Path::new(&shell).is_file() {
            return shell;
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "/bin/sh".to_string()
}

#[cfg(windows)]
fn default_shell_program() -> String {
    if let Some(shell) = env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
    {
        if std::path::Path::new(&shell).is_file() {
            return shell;
        }
    }
    for candidate in ["pwsh.exe", "powershell.exe"] {
        if let Some(path) = resolve_program(candidate) {
            return path.to_string_lossy().to_string();
        }
    }
    env::var("COMSPEC")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "cmd.exe".to_string())
}

fn resolve_terminal_program(program: &str) -> Result<PathBuf, String> {
    resolve_program(program).ok_or_else(|| {
        format!("terminal_cli_missing: {program} not found in PATH or common install locations")
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn launcher_specs_map_to_real_commands() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();

        let claude =
            build_terminal_command_spec("claude", Some(&cwd_str), None, None, None).unwrap();
        assert_eq!(claude.program, "claude");
        assert!(claude.args.is_empty());
        assert_eq!(claude.extra_env["TERM_PROGRAM"], "ghostty");

        let codex = build_terminal_command_spec("codex", Some(&cwd_str), None, None, None).unwrap();
        assert_eq!(codex.program, "codex");
        assert_eq!(codex.args, vec!["--cd", cwd_str.as_str()]);
        assert_eq!(codex.extra_env["TERM_PROGRAM"], "ghostty");

        let shell = build_terminal_command_spec("shell", Some(&cwd_str), None, None, None).unwrap();
        assert!(!shell.program.is_empty());
        assert!(shell.args.is_empty());
        assert_eq!(shell.extra_env["TERM_PROGRAM"], "Anchor");
    }

    #[test]
    fn explicit_term_program_overrides_launcher_default() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let mut env = HashMap::new();
        env.insert("TERM_PROGRAM".to_string(), "WezTerm".to_string());
        let spec =
            build_terminal_command_spec("claude", Some(&cwd_str), None, None, Some(env)).unwrap();
        assert_eq!(spec.extra_env["TERM_PROGRAM"], "WezTerm");
    }

    #[cfg(not(windows))]
    #[test]
    fn default_shell_program_returns_an_existing_program() {
        let shell = default_shell_program();
        assert!(
            std::path::Path::new(&shell).is_file(),
            "default shell {shell} should exist"
        );
    }

    #[test]
    fn unsupported_launcher_is_rejected() {
        let err = build_terminal_command_spec("python", None, None, None, None).unwrap_err();
        assert!(err.contains("Unsupported terminal launcher"));
    }

    #[test]
    fn cwd_must_exist_and_be_a_directory() {
        let missing = env::current_dir()
            .unwrap()
            .join("definitely-missing-anchor-cwd");
        let err = build_terminal_command_spec(
            "shell",
            Some(&missing.to_string_lossy()),
            None,
            None,
            None,
        )
        .unwrap_err();
        assert!(err.contains("terminal_cwd_invalid"));
    }

    #[test]
    fn launcher_command_override_takes_precedence_over_default_args() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let spec = build_terminal_command_spec(
            "codex",
            Some(&cwd_str),
            Some("/usr/local/bin/codex-1.5"),
            Some(vec!["--profile".to_string(), "dev".to_string()]),
            None,
        )
        .unwrap();
        assert_eq!(spec.program, "/usr/local/bin/codex-1.5");
        assert_eq!(spec.args, vec!["--profile", "dev"]);
    }

    #[test]
    fn launcher_extra_args_append_to_default_args() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let spec = build_terminal_command_spec(
            "codex",
            Some(&cwd_str),
            None,
            Some(vec!["--profile".to_string(), "dev".to_string()]),
            None,
        )
        .unwrap();
        assert_eq!(spec.program, "codex");
        assert_eq!(
            spec.args,
            vec!["--cd", cwd_str.as_str(), "--profile", "dev"]
        );
    }

    #[test]
    fn empty_command_override_falls_back_to_default() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let spec =
            build_terminal_command_spec("claude", Some(&cwd_str), Some("   "), None, None).unwrap();
        assert_eq!(spec.program, "claude");
    }

    #[test]
    fn terminal_exit_event_serializes_camelcase() {
        let exit = serde_json::to_value(TerminalExitEvent {
            session_id: "term-1".to_string(),
            exit_code: Some(0),
        })
        .unwrap();
        assert_eq!(exit, json!({ "sessionId": "term-1", "exitCode": 0 }));
    }
}
