mod input;
mod model;
mod snapshot;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{ErrorKind, Read};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri::{ipc::Channel, State};
use uuid::Uuid;

use crate::cli_path::{augmented_path, merge_path_env, resolve_program};
pub use input::{encode_mouse_input, encode_terminal_input, TerminalInputCommand};

use self::model::{write_shared, SearchDirection, SharedTerminalWriter, TerminalModel};

const DEFAULT_COLS: u16 = 120;
const DEFAULT_ROWS: u16 = 30;
const MAX_COLS: u16 = 500;
const MAX_ROWS: u16 = 200;
const FRAME_COALESCE_MS: u64 = 16;

#[derive(Clone, Default)]
pub struct TerminalState {
    sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>,
    reservations: Arc<Mutex<HashSet<String>>>,
    // REL-01/D-09: kill targets whose tab-close escalation ladder
    // (SIGHUP -> SIGTERM -> SIGKILL) is still running in a detached thread.
    #[cfg(unix)]
    escalations: Arc<Mutex<HashSet<KillTarget>>>,
}

struct TerminalSession {
    kind: String,
    generation: String,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: SharedTerminalWriter,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    model: Arc<Mutex<TerminalModel>>,
    input_modes: Arc<TerminalInputModes>,
    resize_lock: Mutex<()>,
    stream: Arc<TerminalStream>,
    closing: AtomicBool,
    // REL-01: the terminal child's spawn-time pid, which is also its pgid
    // and sid because portable-pty calls `setsid()` before exec. `None` on
    // non-unix, where the group-targeted kill ladder does not apply.
    process_group: Option<u32>,
}

#[derive(Default)]
struct TerminalInputModes {
    kitty: AtomicBool,
    bracketed_paste: AtomicBool,
    mouse_click: AtomicBool,
    mouse_motion: AtomicBool,
    mouse_drag: AtomicBool,
    mouse_sgr: AtomicBool,
    display_offset: AtomicUsize,
}

impl TerminalInputModes {
    fn update(&self, model: &TerminalModel) {
        let mouse = model.mouse_modes();
        self.kitty
            .store(model.kitty_keyboard_active(), Ordering::Release);
        self.bracketed_paste
            .store(model.bracketed_paste_active(), Ordering::Release);
        self.mouse_click.store(mouse.click, Ordering::Release);
        self.mouse_motion.store(mouse.motion, Ordering::Release);
        self.mouse_drag.store(mouse.drag, Ordering::Release);
        self.mouse_sgr.store(mouse.sgr, Ordering::Release);
        self.display_offset
            .store(model.display_offset(), Ordering::Release);
    }

    fn mouse_modes(&self) -> input::MouseModes {
        input::MouseModes {
            click: self.mouse_click.load(Ordering::Acquire),
            motion: self.mouse_motion.load(Ordering::Acquire),
            drag: self.mouse_drag.load(Ordering::Acquire),
            sgr: self.mouse_sgr.load(Ordering::Acquire),
        }
    }
}

struct SessionReservation {
    reservations: Arc<Mutex<HashSet<String>>>,
    session_id: String,
    active: bool,
}

impl SessionReservation {
    fn acquire(state: &TerminalState, session_id: &str) -> Result<Self, String> {
        // D-03: these per-session unit mutexes guard ID-registry collections
        // (session handles and reserved IDs) whose entries are re-validated
        // against live session state on every use; the authoritative per-
        // session state lives in the session struct itself, so a poisoned
        // guard carries no tainted invariant.
        let mut reservations = crate::lock_recovery::recover_guard(
            state.reservations.lock(),
            "terminal",
            "TERMINAL_RESERVATIONS",
        );
        let sessions = crate::lock_recovery::recover_guard(
            state.sessions.lock(),
            "terminal",
            "TERMINAL_SESSIONS",
        );
        if sessions.contains_key(session_id) || !reservations.insert(session_id.to_string()) {
            return Err(format!("terminal_session_id_in_use: {session_id}"));
        }
        drop(sessions);
        drop(reservations);
        Ok(Self {
            reservations: state.reservations.clone(),
            session_id: session_id.to_string(),
            active: true,
        })
    }

    fn commit(mut self) {
        self.release();
        self.active = false;
    }

    fn release(&self) {
        if let Ok(mut reservations) = self.reservations.lock() {
            reservations.remove(&self.session_id);
        }
    }
}

impl Drop for SessionReservation {
    fn drop(&mut self) {
        if self.active {
            self.release();
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum TerminalStreamMessage {
    Frame {
        session_id: String,
        generation: String,
        seq: u64,
        prev_seq: u64,
        frame: Box<snapshot::TerminalWireFrame>,
    },
    Exit {
        session_id: String,
        generation: String,
        seq: u64,
        exit_code: Option<i32>,
    },
    Fault {
        session_id: String,
        generation: String,
        seq: u64,
        message: String,
    },
}

struct TerminalStream {
    session_id: String,
    generation: String,
    channel: Channel<TerminalStreamMessage>,
    sent_seq: AtomicU64,
    acked_seq: AtomicU64,
    dirty: AtomicBool,
    force_full: AtomicBool,
    visible: AtomicBool,
    running: AtomicBool,
    wake: Mutex<()>,
    wake_cv: Condvar,
}

impl TerminalStream {
    fn new(
        session_id: String,
        generation: String,
        channel: Channel<TerminalStreamMessage>,
    ) -> Self {
        Self {
            session_id,
            generation,
            channel,
            sent_seq: AtomicU64::new(0),
            acked_seq: AtomicU64::new(0),
            dirty: AtomicBool::new(true),
            force_full: AtomicBool::new(true),
            visible: AtomicBool::new(true),
            running: AtomicBool::new(true),
            wake: Mutex::new(()),
            wake_cv: Condvar::new(),
        }
    }

    /// Wake the frame emitter. The `wake` mutex must be held across the
    /// notification: an unlocked notify can land between the emitter's
    /// predicate check and its `wait()` and be lost, parking the session until
    /// the next byte of PTY output — or forever, once the PTY goes quiet.
    fn signal(&self) {
        let _guard = self
            .wake
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        self.wake_cv.notify_all();
    }

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.signal();
    }

    fn request_full(&self) {
        self.force_full.store(true, Ordering::Release);
        self.mark_dirty();
    }

    fn set_visible(&self, visible: bool) {
        self.visible.store(visible, Ordering::Release);
        if visible {
            self.request_full();
        } else {
            self.signal();
        }
    }

    fn acknowledge(&self, seq: u64) {
        self.acked_seq.fetch_max(seq, Ordering::AcqRel);
        self.signal();
    }

    fn has_credit(&self) -> bool {
        self.sent_seq
            .load(Ordering::Acquire)
            .saturating_sub(self.acked_seq.load(Ordering::Acquire))
            < 2
    }

    fn next_seq(&self) -> u64 {
        self.sent_seq.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn send_frame(&self, frame: snapshot::TerminalFrame) -> tauri::Result<()> {
        let seq = self.next_seq();
        self.channel.send(TerminalStreamMessage::Frame {
            session_id: self.session_id.clone(),
            generation: self.generation.clone(),
            seq,
            prev_seq: seq.saturating_sub(1),
            frame: Box::new(frame.into()),
        })
    }

    fn send_exit(&self, exit_code: Option<i32>) {
        let seq = self.next_seq();
        let _ = self.channel.send(TerminalStreamMessage::Exit {
            session_id: self.session_id.clone(),
            generation: self.generation.clone(),
            seq,
            exit_code,
        });
    }

    fn send_fault(&self, message: String) {
        let seq = self.next_seq();
        let _ = self.channel.send(TerminalStreamMessage::Fault {
            session_id: self.session_id.clone(),
            generation: self.generation.clone(),
            seq,
            message,
        });
    }

    fn stop(&self) {
        self.running.store(false, Ordering::Release);
        self.signal();
    }
}

/// Once the session is stopping, pending damage is drained regardless of the
/// credit window: the acks for the last frames are still in flight, and the
/// session is gone before they land, so honouring credit here would silently
/// drop the tail of a command's output.
fn should_stop_frame_emitter(stream: &TerminalStream) -> bool {
    !stream.running.load(Ordering::Acquire)
        && (!stream.dirty.load(Ordering::Acquire) || !stream.visible.load(Ordering::Acquire))
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
pub struct TerminalSearchResult {
    pub session_id: String,
    pub query: String,
    pub found: bool,
    pub row: Option<usize>,
    pub col: Option<usize>,
    pub length: usize,
    pub display_offset: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TerminalSelectionCommand {
    Start {
        row: u16,
        col: u16,
        side: String,
        kind: String,
    },
    Update {
        row: u16,
        col: u16,
        side: String,
        #[serde(default)]
        scroll_delta: i32,
    },
    Finish {
        #[serde(default)]
        include_all: bool,
    },
    Clear,
    SelectAll,
}

/// `terminal_spawn`'s plain-data invoke fields, bundled into one
/// deserializable struct to keep the command's own argument count under
/// clippy's threshold. `on_event`'s `Channel` stays a top-level parameter,
/// since it carries Tauri's own channel-registration wiring. Frontend caller
/// (`terminalSpawn` in `src/lib/api.ts`) nests these under this `args` key;
/// field names are unchanged, so no other caller is affected.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnArgs {
    session_id: String,
    kind: String,
    cwd: Option<String>,
    command: Option<String>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionHandle {
    session_id: String,
    generation: String,
}

pub fn terminal_spawn(
    state: &TerminalState,
    args: TerminalSpawnArgs,
    on_event: Channel<TerminalStreamMessage>,
) -> Result<String, String> {
    let TerminalSpawnArgs {
        session_id,
        kind,
        cwd,
        command,
        extra_args,
        extra_env,
        cols,
        rows,
    } = args;
    if session_id.trim().is_empty() {
        return Err("terminal_session_id_required".to_string());
    }
    let reservation = SessionReservation::acquire(state, &session_id)?;
    let generation = Uuid::new_v4().to_string();
    let stream = Arc::new(TerminalStream::new(
        session_id.clone(),
        generation.clone(),
        on_event,
    ));

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
    let input_modes = Arc::new(TerminalInputModes::default());
    if let Ok(model) = model.lock() {
        input_modes.update(&model);
    }
    let mut child = pair
        .slave
        .spawn_command(cmd)
        .map_err(|err| format!("terminal_spawn_failed: {err}"))?;
    let killer = child.clone_killer();
    // REL-01: portable-pty's unix spawn path calls `setsid()` in `pre_exec`
    // before exec, so this child is already its own session and process-
    // group leader -- its pid equals its pgid for its whole lifetime.
    #[cfg(unix)]
    let process_group = child.process_id();
    #[cfg(not(unix))]
    let process_group: Option<u32> = None;

    let session = Arc::new(TerminalSession {
        kind: kind.clone(),
        generation: generation.clone(),
        master: Mutex::new(pair.master),
        writer: shared_writer,
        killer: Mutex::new(killer),
        model: model.clone(),
        input_modes: input_modes.clone(),
        resize_lock: Mutex::new(()),
        stream: stream.clone(),
        closing: AtomicBool::new(false),
        process_group,
    });
    // D-03: the sessions registry holds Arc<TerminalSession> handles whose
    // authoritative state lives in the session struct; every reader
    // re-validates generation and identity after acquisition, so recovering
    // a poisoned guard cannot serve a tainted invariant.
    crate::lock_recovery::recover_guard(state.sessions.lock(), "terminal", "TERMINAL_SESSIONS")
        .insert(session_id.clone(), session.clone());
    reservation.commit();

    let pump_handle = spawn_output_pump(reader, model, input_modes, stream.clone());

    let sessions = state.sessions.clone();
    let exit_id = session_id.clone();
    let exit_session = session.clone();
    thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        stream.stop();
        // Unregister and notify before joining the pump. A grandchild that
        // inherited the PTY slave (`sleep 60 &` then `exit`) keeps the reader
        // blocked past the child's death, and gating cleanup on that join
        // strands the session in the registry with the tab stuck "running".
        if let Ok(mut guard) = sessions.lock() {
            let is_current = guard
                .get(&exit_id)
                .is_some_and(|current| Arc::ptr_eq(current, &exit_session));
            if is_current {
                guard.remove(&exit_id);
            }
        }
        stream.send_exit(exit_code);
        let _ = pump_handle.join();
    });

    Ok(generation)
}

pub fn terminal_write(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    data: String,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    write_shared(&session.writer, data.as_bytes())
}

pub fn terminal_input(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    command: TerminalInputCommand,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    let is_mouse = matches!(
        command,
        TerminalInputCommand::Mouse { .. } | TerminalInputCommand::Wheel { .. }
    );
    if !is_mouse && session.input_modes.display_offset.load(Ordering::Acquire) != 0 {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        model.scroll_bottom();
        session.input_modes.update(&model);
        session.stream.request_full();
    }
    let encoded = if is_mouse {
        encode_mouse_input(&command, session.input_modes.mouse_modes())
    } else {
        encode_terminal_input(
            &session.kind,
            &command,
            session.input_modes.kitty.load(Ordering::Acquire),
            session.input_modes.bracketed_paste.load(Ordering::Acquire),
        )
        .map(String::into_bytes)
    };
    if let Some(data) = encoded {
        write_shared(&session.writer, &data)?;
    }
    Ok(())
}

pub fn terminal_input_batch(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    _client_seq: u64,
    commands: Vec<TerminalInputCommand>,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    if commands.is_empty() {
        return Ok(());
    }
    let mut bytes = Vec::new();
    let has_keyboard_input = commands.iter().any(|command| {
        !matches!(
            command,
            TerminalInputCommand::Mouse { .. } | TerminalInputCommand::Wheel { .. }
        )
    });
    if has_keyboard_input && session.input_modes.display_offset.load(Ordering::Acquire) != 0 {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        model.scroll_bottom();
        session.input_modes.update(&model);
        session.stream.request_full();
    }
    let mouse_modes = session.input_modes.mouse_modes();
    let kitty = session.input_modes.kitty.load(Ordering::Acquire);
    let bracketed_paste = session.input_modes.bracketed_paste.load(Ordering::Acquire);
    for command in &commands {
        let encoded = if matches!(
            command,
            TerminalInputCommand::Mouse { .. } | TerminalInputCommand::Wheel { .. }
        ) {
            encode_mouse_input(command, mouse_modes)
        } else {
            encode_terminal_input(&session.kind, command, kitty, bracketed_paste)
                .map(String::into_bytes)
        };
        if let Some(encoded) = encoded {
            bytes.extend_from_slice(&encoded);
        }
    }
    if !bytes.is_empty() {
        write_shared(&session.writer, &bytes)?;
    }
    Ok(())
}

pub fn terminal_ack(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    seq: u64,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    session.stream.acknowledge(seq);
    Ok(())
}

pub fn terminal_request_full(
    state: &TerminalState,
    handle: TerminalSessionHandle,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    session.stream.request_full();
    Ok(())
}

pub fn terminal_set_visibility(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    visible: bool,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    session.stream.set_visible(visible);
    Ok(())
}

pub fn terminal_selection(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    command: TerminalSelectionCommand,
) -> Result<(), String> {
    use alacritty_terminal::index::Side;
    use alacritty_terminal::selection::SelectionType;

    let session = get_session_generation(state, &handle)?;
    let repaint = {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        match command {
            TerminalSelectionCommand::Start {
                row,
                col,
                side,
                kind,
            } => {
                let side = if side == "right" {
                    Side::Right
                } else {
                    Side::Left
                };
                let kind = match kind.as_str() {
                    "semantic" => SelectionType::Semantic,
                    "lines" => SelectionType::Lines,
                    _ => SelectionType::Simple,
                };
                model.selection_start(row, col, side, kind);
                false
            }
            TerminalSelectionCommand::Update {
                row,
                col,
                side,
                scroll_delta,
            } => {
                if scroll_delta != 0 {
                    model.scroll(scroll_delta);
                    session.input_modes.update(&model);
                }
                let side = if side == "right" {
                    Side::Right
                } else {
                    Side::Left
                };
                model.selection_update(row, col, side);
                scroll_delta != 0
            }
            TerminalSelectionCommand::Finish { include_all } => {
                if include_all {
                    model.selection_finish();
                }
                true
            }
            TerminalSelectionCommand::Clear => {
                model.selection_clear();
                true
            }
            TerminalSelectionCommand::SelectAll => {
                model.selection_select_all();
                true
            }
        }
    };
    if repaint {
        session.stream.request_full();
    }
    Ok(())
}

pub fn terminal_copy_selection(
    state: &TerminalState,
    handle: TerminalSessionHandle,
) -> Result<String, String> {
    let session = get_session_generation(state, &handle)?;
    let model = session
        .model
        .lock()
        .map_err(|_| "terminal_model_poisoned".to_string())?;
    Ok(model.selection_text())
}

/// Scroll the viewport through scrollback by `delta` lines (positive = toward
/// history). Emits a fresh full frame so the renderer shows the scrolled view.
pub fn terminal_scroll(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    delta: i32,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        model.scroll(delta);
        session.input_modes.update(&model);
    }
    session.stream.request_full();
    Ok(())
}

/// Clear the visible screen and scrollback (Cmd+K). On the primary screen
/// also sends a form feed so a shell at a prompt redraws it at the top;
/// no-op while the alternate screen is active (vim, TUIs).
pub fn terminal_clear(state: &TerminalState, handle: TerminalSessionHandle) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        if !model.clear() {
            return Ok(());
        }
        session.input_modes.update(&model);
    }
    // Best-effort: the model is already cleared, so the frame must reach the
    // renderer even if the PTY write fails (dead shell).
    let _ = write_shared(&session.writer, b"\x0c");
    session.stream.request_full();
    Ok(())
}

pub fn terminal_text(
    state: &TerminalState,
    handle: TerminalSessionHandle,
) -> Result<String, String> {
    let session = get_session_generation(state, &handle)?;
    let model = session
        .model
        .lock()
        .map_err(|_| "terminal_model_poisoned".to_string())?;
    Ok(model.text())
}

pub fn terminal_search(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    query: String,
    direction: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<TerminalSearchResult, String> {
    let session = get_session_generation(state, &handle)?;
    let direction = match direction.as_deref() {
        Some("previous") => SearchDirection::Previous,
        _ => SearchDirection::Next,
    };
    let (hit, display_offset) = {
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
        let hit = model.search(&query, direction, case_sensitive.unwrap_or(false));
        session.input_modes.update(&model);
        let display_offset = model.display_offset();
        (hit, display_offset)
    };
    let display_offset = hit
        .as_ref()
        .map(|item| item.display_offset)
        .unwrap_or(display_offset);
    session.stream.request_full();
    Ok(TerminalSearchResult {
        session_id: handle.session_id,
        query,
        found: hit.is_some(),
        row: hit.as_ref().map(|item| item.row),
        col: hit.as_ref().map(|item| item.col),
        length: hit.as_ref().map(|item| item.length).unwrap_or(0),
        display_offset,
    })
}

pub fn terminal_resize(
    state: &TerminalState,
    handle: TerminalSessionHandle,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_session_generation(state, &handle)?;
    let cols = cols.clamp(2, MAX_COLS);
    let rows = rows.clamp(1, MAX_ROWS);
    let _resize = session
        .resize_lock
        .lock()
        .map_err(|_| "terminal_resize_poisoned".to_string())?;
    {
        // Hold the model lock across the ioctl. A TUI redraws on SIGWINCH
        // immediately, so releasing it between the PTY resize and the model
        // resize lets the reader parse the new-size redraw into the old grid.
        let mut model = session
            .model
            .lock()
            .map_err(|_| "terminal_model_poisoned".to_string())?;
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
        drop(master);
        model.resize(cols, rows);
        session.input_modes.update(&model);
    }
    session.stream.request_full();
    Ok(())
}

// REL-01/D-09: timeout-gated escalation ladder, targeted at the terminal
// child's own process group (never a bare pid, never the session id). The
// grace period between stages and the poll interval used while waiting for
// a stage to take effect.
#[cfg(unix)]
const KILL_ESCALATION_GRACE: Duration = Duration::from_secs(2);
#[cfg(unix)]
const ESCALATION_POLL: Duration = Duration::from_millis(50);
#[cfg(unix)]
const SIGHUP: i32 = 1;
#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

/// How far an escalation ladder got before the process group disappeared.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum KillStage {
    Hangup,
    Terminate,
    Kill,
}

/// One target of a kill ladder (D-09). Both kinds take the opening SIGHUP
/// as a whole process group; they differ in how SIGTERM/SIGKILL escalate.
#[cfg(unix)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
enum KillTarget {
    /// The terminal child itself (its pid is its pgid). Without job control
    /// (agent CLIs exec'd as the leader, `sh -c` wrappers) every child it
    /// starts stays in this group, `nohup`'d ones included, so SIGTERM and
    /// SIGKILL go to the leader pid only and the stage is judged by the
    /// leader pid alone. The session waiter only watches the leader, so this
    /// still ends a leader that traps SIGHUP (REL-01).
    Leader(u32),
    /// The pty's foreground job group under job control: the whole group
    /// escalates.
    Group(u32),
}

#[cfg(unix)]
impl KillTarget {
    /// The group the opening SIGHUP goes to.
    fn pgid(self) -> u32 {
        match self {
            KillTarget::Leader(id) | KillTarget::Group(id) => id,
        }
    }

    /// SIGTERM/SIGKILL: the leader pid only, or the whole foreground group.
    fn signal(self, signal: i32) -> std::io::Result<bool> {
        match self {
            KillTarget::Leader(pid) => signal_pid(pid, signal),
            KillTarget::Group(pgid) => signal_process_group(pgid, signal),
        }
    }

    /// Same EPERM-means-alive rule as `process_group_alive`.
    fn alive(self) -> bool {
        match self {
            KillTarget::Leader(pid) => signal_pid(pid, 0).unwrap_or(true),
            KillTarget::Group(pgid) => process_group_alive(pgid),
        }
    }
}

#[cfg(unix)]
impl std::fmt::Display for KillTarget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            KillTarget::Leader(pid) => write!(f, "pid {pid}"),
            KillTarget::Group(pgid) => write!(f, "pgid {pgid}"),
        }
    }
}

/// Sends `signal` to the process group led by `pgid` (i.e. `kill(-pgid,
/// signal)`), reusing the raw FFI idiom already in
/// `command_output.rs::terminate_unix_process_group`. Returns `Ok(true)`
/// when the signal was delivered, `Ok(false)` when the group is already
/// gone (ESRCH), and `Err` for any other failure.
#[cfg(unix)]
fn signal_process_group(pgid: u32, signal: i32) -> std::io::Result<bool> {
    let group =
        i32::try_from(pgid).map_err(|_| std::io::Error::other("process group id exceeds i32"))?;
    send_signal(-group, signal)
}

/// `signal_process_group` for a single pid (`kill(pid, signal)`).
#[cfg(unix)]
fn signal_pid(pid: u32, signal: i32) -> std::io::Result<bool> {
    let pid = i32::try_from(pid).map_err(|_| std::io::Error::other("pid exceeds i32"))?;
    send_signal(pid, signal)
}

#[cfg(unix)]
fn send_signal(target: i32, signal: i32) -> std::io::Result<bool> {
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let result = unsafe { kill(target, signal) };
    if result == 0 {
        return Ok(true);
    }
    let err = std::io::Error::last_os_error();
    if err.raw_os_error() == Some(3) {
        // ESRCH: the target is already gone.
        return Ok(false);
    }
    Err(err)
}

/// Probes liveness with signal 0. Any error other than ESRCH (e.g. EPERM)
/// is treated as "still alive" -- the group exists but this process cannot
/// signal it, not that it is gone.
#[cfg(unix)]
fn process_group_alive(pgid: u32) -> bool {
    signal_process_group(pgid, 0).unwrap_or(true)
}

/// Runs one shared SIGHUP -> SIGTERM -> SIGKILL ladder against every target
/// together, assuming SIGHUP was already sent to each target's group. A
/// kill is never just the terminal child's own leader (REL-01): an
/// interactive, job-control shell puts every foreground external command
/// into its OWN process group, so a tab-close or quit-time kill must
/// escalate the leader and the pty's current foreground group on the same
/// clock, or the foreground job survives untouched (see kill_target_pgids).
/// Returns the stage the whole batch was finally observed gone at (or
/// `Kill` if any target needed SIGKILL) and the targets that outlived
/// SIGHUP, the only ones escalation touched.
#[cfg(unix)]
fn escalate_process_groups(
    targets: &[KillTarget],
    grace: Duration,
) -> (KillStage, Vec<KillTarget>) {
    let survivors = wait_for_all_groups_gone(targets, grace);
    if survivors.is_empty() {
        return (KillStage::Hangup, survivors);
    }
    for &target in &survivors {
        let _ = target.signal(SIGTERM);
    }
    let still_alive = wait_for_all_groups_gone(&survivors, grace);
    if still_alive.is_empty() {
        return (KillStage::Terminate, survivors);
    }
    for &target in &still_alive {
        let _ = target.signal(SIGKILL);
    }
    (KillStage::Kill, survivors)
}

/// D-11: one warn-level line naming the targets that outlived SIGHUP, `None`
/// when SIGHUP alone was enough (the common case, not worth logging).
#[cfg(unix)]
fn escalation_warn_line(escalated: &[KillTarget], stage: KillStage) -> Option<String> {
    let signal_name = match stage {
        KillStage::Hangup => return None,
        KillStage::Terminate => "SIGTERM",
        KillStage::Kill => "SIGKILL",
    };
    if escalated.is_empty() {
        return None;
    }
    let names = escalated
        .iter()
        .map(KillTarget::to_string)
        .collect::<Vec<_>>()
        .join(", ");
    Some(format!(
        "[terminal] {names} survived SIGHUP; escalated to {signal_name}"
    ))
}

/// Every target a kill (tab close or quit sweep) should hit for this
/// session: its own leader (REL-01) plus, if its group differs, the pty's
/// CURRENT foreground process group (`tcgetpgrp` on the master).
/// Job control assigns a fresh group to every foreground job; the leader's
/// own group is the tty's foreground group only while the shell sits idle
/// at its prompt or when there is no job control at all. Captured up front,
/// before any signal is sent to the leader — tcgetpgrp becomes meaningless
/// once the leader dies. A background or disowned job is never the pty's
/// foreground group, so it is never added here (REL-01/D-09: it must
/// survive).
#[cfg(unix)]
fn kill_target_pgids(session: &TerminalSession, leader_pgid: u32) -> Vec<KillTarget> {
    let mut targets = vec![KillTarget::Leader(leader_pgid)];
    let foreground = session
        .master
        .lock()
        .ok()
        .and_then(|master| master.process_group_leader())
        .and_then(|pid| u32::try_from(pid).ok());
    if let Some(pgid) = foreground {
        if pgid != leader_pgid {
            targets.push(KillTarget::Group(pgid));
        }
    }
    targets
}

/// Sends SIGHUP to every target's group and, unless every target is already
/// gone, spawns a detached thread to run the rest of the escalation ladder
/// against whichever ones a signal actually reached. Holds no
/// session/registry/killer lock while that thread sleeps.
#[cfg(unix)]
fn begin_group_kill(state: &TerminalState, targets: Vec<KillTarget>) -> Result<(), String> {
    let mut delivered = Vec::with_capacity(targets.len());
    let mut first_hard_error: Option<std::io::Error> = None;
    for &target in &targets {
        match signal_process_group(target.pgid(), SIGHUP) {
            Ok(true) => delivered.push(target),
            Ok(false) => {}
            Err(err) => {
                if first_hard_error.is_none() {
                    first_hard_error = Some(err);
                }
            }
        }
    }
    if delivered.is_empty() {
        return match first_hard_error {
            Some(err) => Err(format!("terminal_kill_failed: {err}")),
            None => Ok(()),
        };
    }
    // D-03: `escalations` is a registry of process-group ids that
    // `escalate_process_groups` re-validates via `process_group_alive`
    // before every signal it sends, so a poisoned guard cannot serve a
    // tainted invariant -- worst case a dead pgid gets probed once more
    // before this thread drops it from the set.
    {
        let mut guard = crate::lock_recovery::recover_guard(
            state.escalations.lock(),
            "terminal",
            "TERMINAL_ESCALATIONS",
        );
        for &target in &delivered {
            guard.insert(target);
        }
    }
    let escalations = state.escalations.clone();
    thread::spawn(move || {
        let (stage, escalated) = escalate_process_groups(&delivered, KILL_ESCALATION_GRACE);
        if let Some(line) = escalation_warn_line(&escalated, stage) {
            eprintln!("{line}");
        }
        let mut guard = crate::lock_recovery::recover_guard(
            escalations.lock(),
            "terminal",
            "TERMINAL_ESCALATIONS",
        );
        for target in &delivered {
            guard.remove(target);
        }
    });
    Ok(())
}

/// Falls back to the session's stored `ChildKiller` (a bare, non-escalating
/// signal on unix) for sessions with no captured process group, and for
/// every session on non-unix platforms.
fn kill_via_signaller(session: &TerminalSession) -> Result<(), String> {
    // D-03: the killer value is an Arc<Mutex<ChildKiller>> wrapping a live
    // process handle that survives poisoning; only the guard flag is
    // tainted, so recovering keeps the success-path semantics (D-02):
    // `closing` stays latched and the kill proceeds against existing PTY
    // sessions.
    let mut killer =
        crate::lock_recovery::recover_guard(session.killer.lock(), "terminal", "TERMINAL_KILLER");
    killer
        .kill()
        .map_err(|err| format!("terminal_kill_failed: {err}"))
}

pub fn terminal_kill(state: &TerminalState, handle: TerminalSessionHandle) -> Result<(), String> {
    let session = match get_session_generation(state, &handle) {
        Ok(session) => session,
        Err(error) if error == format!("Unknown terminal session: {}", handle.session_id) => {
            return Ok(())
        }
        Err(error) => return Err(error),
    };
    if session.closing.swap(true, Ordering::AcqRel) {
        return Ok(());
    }

    #[cfg(unix)]
    let kill_result = match session.process_group {
        Some(pgid) => begin_group_kill(state, kill_target_pgids(&session, pgid)),
        None => kill_via_signaller(&session),
    };
    #[cfg(not(unix))]
    let kill_result = kill_via_signaller(&session);

    if let Err(err) = kill_result {
        session.closing.store(false, Ordering::Release);
        return Err(err);
    }
    // Unregister on kill. The group escalation ladder (unix) or the stored
    // `ChildKiller` (non-unix / no captured group) now guarantees the child
    // eventually terminates, so the waiter thread always removes this entry
    // later if it has not already. The `Arc::ptr_eq` guard still protects a
    // late exit here against a session id that was recycled in the meantime.
    if let Ok(mut guard) = state.sessions.lock() {
        if guard
            .get(&handle.session_id)
            .is_some_and(|current| Arc::ptr_eq(current, &session))
        {
            guard.remove(&handle.session_id);
        }
    }
    Ok(())
}

// D-12: each stage of the quit-time sweep gets this long before escalating.
// Shorter than the tab-close ladder's KILL_ESCALATION_GRACE (2s) on
// purpose: two KILL_ESCALATION_GRACE-length stages measured ~4s end to end,
// overrunning the 3s quit budget once signal-send and thread/reap overhead
// are added on top of the raw poll windows. 1s + 1s leaves headroom for
// that overhead while still giving a group two full chances to die before
// SIGKILL. Tab close keeps its own 2s + 2s (D-09) — only the quit sweep is
// time-boxed against a fixed external deadline.
const QUIT_SWEEP_STEP: Duration = Duration::from_millis(1000);

/// Polls every target together (not one at a time) for up to `step`,
/// returning whichever ones are still alive when the deadline passes (empty
/// once all are gone). Used to run one shared ladder step across a whole
/// batch of targets instead of a per-target grace period, since the quit
/// sweep must stay inside a fixed total budget regardless of how many
/// sessions are live.
#[cfg(unix)]
fn wait_for_all_groups_gone(targets: &[KillTarget], step: Duration) -> Vec<KillTarget> {
    let deadline = std::time::Instant::now() + step;
    loop {
        let alive: Vec<KillTarget> = targets
            .iter()
            .copied()
            .filter(|target| target.alive())
            .collect();
        if alive.is_empty() {
            return Vec::new();
        }
        if std::time::Instant::now() >= deadline {
            return alive;
        }
        thread::sleep(ESCALATION_POLL);
    }
}

/// D-12: drains every live session and every kill target whose tab-close
/// escalation ladder (from a prior `terminal_kill`) is still in flight, then
/// runs one shared SIGHUP -> SIGTERM -> SIGKILL ladder against the whole
/// batch, bounded by two `step` windows total. No lock is held while
/// polling. Sessions with no captured process group (or on non-unix) fall
/// back to their stored `ChildKiller` instead of joining the batch ladder.
pub(crate) fn sweep_sessions(state: &TerminalState, step: Duration) {
    let drained: Vec<Arc<TerminalSession>> = {
        let mut guard = crate::lock_recovery::recover_guard(
            state.sessions.lock(),
            "terminal",
            "TERMINAL_SESSIONS",
        );
        guard.drain().map(|(_, session)| session).collect()
    };

    #[cfg(unix)]
    let mut targets: HashSet<KillTarget> = HashSet::new();
    for session in &drained {
        // A racing `terminal_kill` on this same session now finds it
        // already latched and, once it also fails to find the entry in
        // `state.sessions`, returns `Ok(())` via the unknown-session path.
        session.closing.store(true, Ordering::Release);
        #[cfg(unix)]
        match session.process_group {
            Some(pgid) => {
                // kill_target_pgids also adds the pty's current foreground
                // group when a job-control shell has one running that
                // differs from its own leader group (see its doc comment);
                // a background/disowned job is never that foreground
                // group, so it is never added.
                targets.extend(kill_target_pgids(session, pgid));
            }
            None => {
                let _ = kill_via_signaller(session);
            }
        }
        #[cfg(not(unix))]
        {
            let _ = kill_via_signaller(session);
        }
    }

    #[cfg(unix)]
    {
        let escalating: Vec<KillTarget> = {
            let mut guard = crate::lock_recovery::recover_guard(
                state.escalations.lock(),
                "terminal",
                "TERMINAL_ESCALATIONS",
            );
            guard.drain().collect()
        };
        targets.extend(escalating);

        if targets.is_empty() {
            return;
        }

        for &target in &targets {
            let _ = signal_process_group(target.pgid(), SIGHUP);
        }
        let target_vec: Vec<KillTarget> = targets.into_iter().collect();
        // Same ladder and leader-pid-only rule as tab close, on `step`.
        let (stage, escalated) = escalate_process_groups(&target_vec, step);
        // D-11: name the final signal, consistent with the per-tab-close
        // line (escalation_warn_line) — "escalated past SIGHUP" alone
        // doesn't say whether TERM was enough or KILL was needed.
        let final_signal = match stage {
            KillStage::Hangup => return,
            KillStage::Terminate => "SIGTERM",
            KillStage::Kill => "SIGKILL",
        };
        eprintln!(
            "[terminal] quit sweep escalated {} process group(s) past SIGHUP; final signal {final_signal}",
            escalated.len()
        );
    }
}

/// D-12: called from the app's `RunEvent::ExitRequested`/`Exit` arm, only
/// after the webview's own close guards already let the quit proceed
/// (D-06). Two `QUIT_SWEEP_STEP` stages keep the whole sweep inside the 3s
/// quit budget.
pub fn shutdown_all_sessions(state: &TerminalState) {
    sweep_sessions(state, QUIT_SWEEP_STEP);
}

#[cfg(test)]
mod phase08_18_stage {
    use super::TerminalState;
    use std::sync::{Arc, Mutex};

    pub(super) static STAGES: Mutex<Vec<(u64, usize, String, Arc<dyn Fn() + Send + Sync>)>> =
        Mutex::new(Vec::new());

    fn registry_key(state: &TerminalState) -> usize {
        Arc::as_ptr(&state.sessions) as usize
    }

    pub(super) fn register(
        id: u64,
        command: &str,
        state: &TerminalState,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) {
        STAGES
            .lock()
            .unwrap()
            .push((id, registry_key(state), command.to_string(), callback));
    }

    pub(super) fn hit(command: &str, state: &TerminalState) {
        let key = registry_key(state);
        let callbacks: Vec<_> = STAGES
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, hook_key, name, _)| *hook_key == key && name == command)
            .map(|(_, _, _, callback)| callback.clone())
            .collect();
        for callback in callbacks {
            callback();
        }
    }
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn terminal_spawn(
        state: State<'_, TerminalState>,
        args: TerminalSpawnArgs,
        on_event: Channel<TerminalStreamMessage>,
    ) -> Result<String, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_spawn", &state);
            super::terminal_spawn(&state, args, on_event)
        })
        .await
        .map_err(|err| format!("terminal_spawn_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_write(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        data: String,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_write", &state);
            super::terminal_write(&state, handle, data)
        })
        .await
        .map_err(|err| format!("terminal_write_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_input(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        command: TerminalInputCommand,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_input", &state);
            super::terminal_input(&state, handle, command)
        })
        .await
        .map_err(|err| format!("terminal_input_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_input_batch(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        client_seq: u64,
        commands: Vec<TerminalInputCommand>,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_input_batch", &state);
            super::terminal_input_batch(&state, handle, client_seq, commands)
        })
        .await
        .map_err(|err| format!("terminal_input_batch_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_ack(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        seq: u64,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_ack", &state);
            super::terminal_ack(&state, handle, seq)
        })
        .await
        .map_err(|err| format!("terminal_ack_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_request_full(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_request_full", &state);
            super::terminal_request_full(&state, handle)
        })
        .await
        .map_err(|err| format!("terminal_request_full_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_set_visibility(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        visible: bool,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_set_visibility", &state);
            super::terminal_set_visibility(&state, handle, visible)
        })
        .await
        .map_err(|err| format!("terminal_set_visibility_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_selection(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        command: TerminalSelectionCommand,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_selection", &state);
            super::terminal_selection(&state, handle, command)
        })
        .await
        .map_err(|err| format!("terminal_selection_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_copy_selection(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
    ) -> Result<String, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_copy_selection", &state);
            super::terminal_copy_selection(&state, handle)
        })
        .await
        .map_err(|err| format!("terminal_copy_selection_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_scroll(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        delta: i32,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_scroll", &state);
            super::terminal_scroll(&state, handle, delta)
        })
        .await
        .map_err(|err| format!("terminal_scroll_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_clear(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_clear", &state);
            super::terminal_clear(&state, handle)
        })
        .await
        .map_err(|err| format!("terminal_clear_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_text(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
    ) -> Result<String, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_text", &state);
            super::terminal_text(&state, handle)
        })
        .await
        .map_err(|err| format!("terminal_text_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_search(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        query: String,
        direction: Option<String>,
        case_sensitive: Option<bool>,
    ) -> Result<TerminalSearchResult, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_search", &state);
            super::terminal_search(&state, handle, query, direction, case_sensitive)
        })
        .await
        .map_err(|err| format!("terminal_search_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_resize(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_resize", &state);
            super::terminal_resize(&state, handle, cols, rows)
        })
        .await
        .map_err(|err| format!("terminal_resize_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn terminal_kill(
        state: State<'_, TerminalState>,
        handle: TerminalSessionHandle,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_18_stage::hit("terminal_kill", &state);
            super::terminal_kill(&state, handle)
        })
        .await
        .map_err(|err| format!("terminal_kill_task_failed: {err}"))?
    }
}

fn get_session(state: &TerminalState, session_id: &str) -> Result<Arc<TerminalSession>, String> {
    // D-03: registry entries are Arc handles re-validated by the caller via
    // generation checks; recovering a poisoned guard cannot serve a tainted
    // invariant (same justification as the spawn-time insert above).
    crate::lock_recovery::recover_guard(state.sessions.lock(), "terminal", "TERMINAL_SESSIONS")
        .get(session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown terminal session: {session_id}"))
}

fn handle_matches_generation(
    session_id: &str,
    generation: &str,
    handle: &TerminalSessionHandle,
) -> Result<(), String> {
    if generation != handle.generation {
        return Err(format!("Stale terminal session generation: {session_id}"));
    }
    Ok(())
}

fn get_session_generation(
    state: &TerminalState,
    handle: &TerminalSessionHandle,
) -> Result<Arc<TerminalSession>, String> {
    let session = get_session(state, &handle.session_id)?;
    handle_matches_generation(&handle.session_id, &session.generation, handle)?;
    Ok(session)
}

fn spawn_output_pump(
    mut reader: Box<dyn Read + Send>,
    model: Arc<Mutex<TerminalModel>>,
    input_modes: Arc<TerminalInputModes>,
    stream: Arc<TerminalStream>,
) -> JoinHandle<()> {
    let emitter = spawn_frame_emitter(model.clone(), stream.clone());
    stream.mark_dirty();

    thread::spawn(move || {
        let mut buf = [0_u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    {
                        let mut guard = match model.lock() {
                            Ok(guard) => guard,
                            Err(_) => {
                                stream.send_fault("terminal_model_poisoned".to_string());
                                break;
                            }
                        };
                        guard.advance(&buf[..n]);
                        input_modes.update(&guard);
                    }
                    stream.mark_dirty();
                }
                Err(err) if err.kind() == ErrorKind::Interrupted => continue,
                Err(err) => {
                    stream.send_fault(format!("terminal_reader_failed: {err}"));
                    break;
                }
            }
        }
        stream.stop();
        let _ = emitter.join();
    })
}

fn spawn_frame_emitter(
    model: Arc<Mutex<TerminalModel>>,
    stream: Arc<TerminalStream>,
) -> JoinHandle<()> {
    thread::spawn(move || loop {
        let mut wake = match stream.wake.lock() {
            Ok(wake) => wake,
            Err(_) => break,
        };
        while stream.running.load(Ordering::Acquire)
            && (!stream.dirty.load(Ordering::Acquire)
                || !stream.visible.load(Ordering::Acquire)
                || !stream.has_credit())
        {
            wake = match stream.wake_cv.wait(wake) {
                Ok(wake) => wake,
                Err(_) => return,
            };
        }
        if should_stop_frame_emitter(&stream) {
            break;
        }
        let (next_wake, _) = match stream
            .wake_cv
            .wait_timeout(wake, Duration::from_millis(FRAME_COALESCE_MS))
        {
            Ok(result) => result,
            Err(_) => break,
        };
        drop(next_wake);

        let draining = !stream.running.load(Ordering::Acquire);
        if !stream.visible.load(Ordering::Acquire) || (!draining && !stream.has_credit()) {
            continue;
        }
        if !stream.dirty.swap(false, Ordering::AcqRel) {
            continue;
        }
        let force_full = stream.force_full.swap(false, Ordering::AcqRel);
        let frame = {
            let mut guard = match model.lock() {
                Ok(guard) => guard,
                Err(_) => {
                    stream.send_fault("terminal_model_poisoned".to_string());
                    break;
                }
            };
            if force_full {
                guard.reset_damage();
                guard.snapshot(&stream.session_id)
            } else {
                match guard.take_damage() {
                    Some(rows) if rows.is_empty() => continue,
                    Some(rows) => guard.snapshot_dirty(&stream.session_id, &rows),
                    None => guard.snapshot(&stream.session_id),
                }
            }
        };
        if stream.send_frame(frame).is_err() {
            break;
        }
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
    let shell_wrapper = custom
        .map(|program| is_shell_wrapper(program, &extras))
        .unwrap_or(false);

    // A normal command override replaces only the provider binary, so its
    // launcher argv still applies. A shell plus -c/-lc is different: it is a
    // complete wrapper command whose argv must stay byte-for-byte in order.
    let (program, mut args) = match kind {
        "claude" => (custom.unwrap_or("claude").to_string(), Vec::new()),
        "codex" => (
            custom.unwrap_or("codex").to_string(),
            if shell_wrapper {
                Vec::new()
            } else {
                vec!["--cd".to_string(), cwd_str]
            },
        ),
        "kimi" => (custom.unwrap_or("kimi").to_string(), Vec::new()),
        // kiro-cli has no --cd flag; the PTY cwd below already runs `chat`
        // in the right directory.
        "kiro" => (
            custom.unwrap_or("kiro-cli").to_string(),
            if shell_wrapper {
                Vec::new()
            } else {
                vec!["chat".to_string()]
            },
        ),
        "shell" => (
            custom
                .map(str::to_string)
                .unwrap_or_else(default_shell_program),
            Vec::new(),
        ),
        other => return Err(format!("Unsupported terminal launcher: {other}")),
    };
    if kind == "kiro" && !shell_wrapper {
        // kiro-cli parses some flags (e.g. `--v3`) only at the top level,
        // before the `chat` subcommand; everything else stays after it.
        let (top_level, rest): (Vec<String>, Vec<String>) = extras
            .into_iter()
            .partition(|arg| is_kiro_top_level_flag(arg));
        args.splice(..0, top_level);
        args.extend(rest);
    } else {
        args.extend(extras);
    }
    let mut extra_env = extra_env.unwrap_or_default();
    crate::agent_runtime_env::reserve_hash_env(&mut extra_env, &cwd)?;
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
    if matches!(kind, "claude" | "codex" | "kimi" | "kiro") {
        "ghostty"
    } else {
        "Maru"
    }
}

/// kiro-cli flags that are parsed at the top level and must precede the
/// `chat` subcommand.
fn is_kiro_top_level_flag(arg: &str) -> bool {
    arg == "--v3"
}

fn is_shell_wrapper(program: &str, args: &[String]) -> bool {
    let shell = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str());
    matches!(shell, Some("sh" | "bash" | "dash" | "ksh" | "zsh" | "fish"))
        && matches!(args.first().map(String::as_str), Some("-c" | "-lc"))
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

        let kimi = build_terminal_command_spec("kimi", Some(&cwd_str), None, None, None).unwrap();
        assert_eq!(kimi.program, "kimi");
        assert!(kimi.args.is_empty());
        assert_eq!(kimi.extra_env["TERM_PROGRAM"], "ghostty");

        let kiro = build_terminal_command_spec("kiro", Some(&cwd_str), None, None, None).unwrap();
        assert_eq!(kiro.program, "kiro-cli");
        assert_eq!(kiro.args, vec!["chat"]);
        assert_eq!(kiro.extra_env["TERM_PROGRAM"], "ghostty");

        let shell = build_terminal_command_spec("shell", Some(&cwd_str), None, None, None).unwrap();
        assert!(!shell.program.is_empty());
        assert!(shell.args.is_empty());
        assert_eq!(shell.extra_env["TERM_PROGRAM"], "Maru");
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

    #[test]
    fn scratchpad_contract_overrides_launcher_env() {
        let work = tempfile::tempdir().unwrap();
        let scratchpad = crate::scratchpad::resolve_scratchpad_root(work.path()).unwrap();
        std::fs::write(
            work.path().join("workspace.config.yaml"),
            format!(
                "version: 1\npaths:\n  primary: {}\n  scratchpad: {}\nscratchpad:\n  temp_subdir: temp\n  drafts_subdir: generated-drafts\n",
                work.path().display(),
                scratchpad.display()
            ),
        )
        .unwrap();
        let drafts = crate::scratchpad::resolve_scratchpad_drafts_root(work.path()).unwrap();
        let mut caller_env = HashMap::new();
        caller_env.insert("MARU_SCRATCHPAD".to_string(), "/tmp/override".to_string());
        caller_env.insert(
            "MARU_DRAFTS".to_string(),
            "/tmp/override/drafts".to_string(),
        );
        caller_env.insert("MARU_TEMP".to_string(), "/tmp/override/temp".to_string());
        caller_env.insert(
            "CLAUDE_CODE_TMPDIR".to_string(),
            "/tmp/override/claude".to_string(),
        );

        let spec = build_terminal_command_spec(
            "claude",
            Some(work.path().to_string_lossy().as_ref()),
            None,
            None,
            Some(caller_env),
        )
        .unwrap();

        assert_eq!(
            spec.extra_env.get("MARU_SCRATCHPAD"),
            Some(&scratchpad.to_string_lossy().into_owned())
        );
        assert_eq!(
            spec.extra_env.get("MARU_DRAFTS"),
            Some(&drafts.to_string_lossy().into_owned())
        );
        assert_eq!(
            spec.extra_env.get("MARU_TEMP"),
            Some(&scratchpad.join("temp").to_string_lossy().into_owned())
        );
        assert_eq!(
            spec.extra_env.get("CLAUDE_CODE_TMPDIR"),
            Some(
                &scratchpad
                    .join("temp/runtime/claude")
                    .to_string_lossy()
                    .into_owned()
            )
        );
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
            .join("definitely-missing-maru-cwd");
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
    fn launcher_command_override_replaces_program_but_keeps_launcher_args() {
        // The override names a different *binary*, not a different CLI. Dropping
        // the launcher's own args left an overridden codex with no `--cd`, so it
        // ran against the process cwd instead of the workspace.
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
        assert_eq!(
            spec.args,
            vec!["--cd", cwd_str.as_str(), "--profile", "dev"]
        );

        let shell =
            build_terminal_command_spec("shell", Some(&cwd_str), Some("/bin/dash"), None, None)
                .unwrap();
        assert_eq!(shell.program, "/bin/dash");
        assert!(shell.args.is_empty());
    }

    #[test]
    fn provider_shell_wrapper_keeps_its_argv_verbatim() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let wrapper = "printf '%s' \"$MARU_SKILL_PROMPT\" | codex exec -";
        let spec = build_terminal_command_spec(
            "codex",
            Some(&cwd_str),
            Some("/bin/zsh"),
            Some(vec!["-lc".to_string(), wrapper.to_string()]),
            None,
        )
        .unwrap();

        assert_eq!(spec.program, "/bin/zsh");
        assert_eq!(spec.args, vec!["-lc", wrapper]);
    }

    #[test]
    fn kiro_extra_args_hoist_top_level_flags_before_chat() {
        let cwd = env::current_dir().unwrap();
        let cwd_str = cwd.to_string_lossy().to_string();
        let spec = build_terminal_command_spec(
            "kiro",
            Some(&cwd_str),
            None,
            Some(vec![
                "--v3".to_string(),
                "--agent".to_string(),
                "x".to_string(),
            ]),
            None,
        )
        .unwrap();
        assert_eq!(spec.program, "kiro-cli");
        assert_eq!(spec.args, vec!["--v3", "chat", "--agent", "x"]);

        // An override names a different kiro-cli binary, so `chat` and the
        // top-level flag ordering still apply — without them it starts no
        // session at all.
        let spec = build_terminal_command_spec(
            "kiro",
            Some(&cwd_str),
            Some("/opt/bin/kiro-cli"),
            Some(vec!["--v3".to_string(), "--agent".to_string()]),
            None,
        )
        .unwrap();
        assert_eq!(spec.program, "/opt/bin/kiro-cli");
        assert_eq!(spec.args, vec!["--v3", "chat", "--agent"]);
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
    fn terminal_exit_stream_message_serializes_camelcase() {
        let exit = serde_json::to_value(TerminalStreamMessage::Exit {
            session_id: "term-1".to_string(),
            generation: "generation-1".to_string(),
            seq: 7,
            exit_code: Some(0),
        })
        .unwrap();
        assert_eq!(
            exit,
            json!({
                "kind": "exit",
                "sessionId": "term-1",
                "generation": "generation-1",
                "seq": 7,
                "exitCode": 0
            })
        );
    }

    #[test]
    fn selection_update_deserializes_atomic_scroll_delta() {
        let command: TerminalSelectionCommand = serde_json::from_value(json!({
            "type": "update",
            "row": 2,
            "col": 4,
            "side": "right",
            "scrollDelta": 3
        }))
        .unwrap();
        assert!(matches!(
            command,
            TerminalSelectionCommand::Update {
                row: 2,
                col: 4,
                scroll_delta: 3,
                ..
            }
        ));
        let finish: TerminalSelectionCommand = serde_json::from_value(json!({
            "type": "finish",
            "includeAll": true
        }))
        .unwrap();
        assert!(matches!(
            finish,
            TerminalSelectionCommand::Finish { include_all: true }
        ));
    }

    #[test]
    fn terminal_session_handle_deserializes_the_frontend_camel_case_shape() {
        let handle: TerminalSessionHandle = serde_json::from_value(json!({
            "sessionId": "term-recycled",
            "generation": "current-generation"
        }))
        .unwrap();
        assert_eq!(handle.session_id, "term-recycled");
        assert_eq!(handle.generation, "current-generation");
    }

    #[test]
    fn every_session_command_uses_the_generation_checked_handle_gateway() {
        let source = include_str!("mod.rs");
        for command in [
            "terminal_write",
            "terminal_input",
            "terminal_input_batch",
            "terminal_ack",
            "terminal_request_full",
            "terminal_set_visibility",
            "terminal_selection",
            "terminal_copy_selection",
            "terminal_scroll",
            "terminal_clear",
            "terminal_text",
            "terminal_search",
            "terminal_resize",
            "terminal_kill",
        ] {
            let command_start = source.find(&format!("pub fn {command}(")).unwrap();
            let command_source = &source[command_start..];
            let command_end = command_source
                .find("#[tauri::command]")
                .unwrap_or(command_source.len());
            let command_source = &command_source[..command_end];
            assert!(
                command_source.contains("handle: TerminalSessionHandle"),
                "{command} must accept a generation-bearing handle"
            );
            let body_start = command_source.find('{').unwrap();
            let first_lookup = command_source[body_start..]
                .find("get_session_generation")
                .unwrap();
            assert!(
                first_lookup < 600,
                "{command} must validate its handle before mutation"
            );
        }
    }

    #[test]
    fn recycled_session_matrix_rejects_stale_handles_and_accepts_current_handles() {
        let stale = TerminalSessionHandle {
            session_id: "term-recycled".to_string(),
            generation: "old-generation".to_string(),
        };
        let current = TerminalSessionHandle {
            session_id: "term-recycled".to_string(),
            generation: "current-generation".to_string(),
        };
        for command in [
            "write",
            "input",
            "input_batch",
            "ack",
            "request_full",
            "set_visibility",
            "selection",
            "copy_selection",
            "scroll",
            "clear",
            "text",
            "search",
            "resize",
            "kill",
        ] {
            assert!(
                handle_matches_generation("term-recycled", "current-generation", &stale).is_err(),
                "{command} must reject a stale handle before its operation"
            );
            assert!(
                handle_matches_generation("term-recycled", "current-generation", &current).is_ok(),
                "{command} must accept the current handle"
            );
        }
    }

    #[test]
    fn stream_credit_bounds_unacknowledged_frames() {
        let channel = Channel::new(|_| Ok(()));
        let stream = TerminalStream::new("term-1".to_string(), "generation-1".to_string(), channel);
        let model = TerminalModel::new(10, 2, model::NullTerminalWriter);
        assert!(stream.has_credit());
        stream.send_frame(model.snapshot("term-1")).unwrap();
        stream.send_frame(model.snapshot("term-1")).unwrap();
        assert!(!stream.has_credit());
        stream.stop();
        // Stopping with damage still pending must drain, not bail: the acks for
        // the in-flight frames land after the session is already gone.
        assert!(!should_stop_frame_emitter(&stream));
        stream.dirty.store(false, Ordering::Release);
        assert!(should_stop_frame_emitter(&stream));
        stream.acknowledge(1);
        assert!(stream.has_credit());
    }

    /// A notification that lands between the emitter's predicate check and its
    /// `wait()` must not be lost: an idle session would otherwise never repaint
    /// until the next byte of PTY output arrives.
    #[test]
    fn frame_emitter_never_misses_a_wakeup() {
        for attempt in 0..400 {
            let frames = Arc::new(AtomicUsize::new(0));
            let channel = Channel::new({
                let frames = frames.clone();
                move |_| {
                    frames.fetch_add(1, Ordering::Release);
                    Ok(())
                }
            });
            let stream = Arc::new(TerminalStream::new(
                "term-1".to_string(),
                "generation-1".to_string(),
                channel,
            ));
            stream.dirty.store(false, Ordering::Release);
            let model = Arc::new(Mutex::new(TerminalModel::new(
                10,
                2,
                model::NullTerminalWriter,
            )));
            let emitter = spawn_frame_emitter(model, stream.clone());
            // Vary the delay so the notify lands across the whole window
            // between the emitter's predicate check and its wait().
            for _ in 0..(attempt % 40) {
                std::hint::spin_loop();
            }
            stream.mark_dirty();

            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            while frames.load(Ordering::Acquire) == 0 && std::time::Instant::now() < deadline {
                thread::yield_now();
            }
            let delivered = frames.load(Ordering::Acquire);
            stream.stop();
            // Deliberately not joined: on a lost wakeup the emitter is parked
            // forever and join() would hang the suite instead of failing it.
            drop(emitter);
            assert!(
                delivered > 0,
                "attempt {attempt}: mark_dirty() was lost, emitter parked forever"
            );
        }
    }

    #[test]
    fn session_ids_are_reserved_atomically_during_spawn() {
        let state = TerminalState::default();
        let first = SessionReservation::acquire(&state, "term-1").unwrap();
        assert!(SessionReservation::acquire(&state, "term-1").is_err());
        drop(first);
        assert!(SessionReservation::acquire(&state, "term-1").is_ok());
    }
}

#[cfg(test)]
mod phase08_18 {
    use super::phase08_18_stage::STAGES;
    use super::*;
    use crate::atomic_file::phase08_06::run;
    use std::future::Future;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::{Duration, Instant};
    use tauri::Manager;

    type TestApp = tauri::AppHandle<tauri::test::MockRuntime>;

    /// Runs an ipc wrapper future that borrows its `State` from an owned
    /// `AppHandle` clone; the borrow stays inside the self-contained future.
    macro_rules! run_with {
        ($app:ident, $body:expr) => {{
            let $app = $app.clone();
            run(async move { $body.await })
        }};
    }

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(TerminalState::default());
        app
    }

    fn cat_args(session_id: String, cwd: PathBuf) -> TerminalSpawnArgs {
        TerminalSpawnArgs {
            session_id,
            kind: "shell".to_string(),
            cwd: Some(cwd.to_string_lossy().into_owned()),
            command: Some("/bin/cat".to_string()),
            extra_args: None,
            extra_env: None,
            cols: Some(120),
            rows: Some(10),
        }
    }

    async fn spawn_session(app: TestApp, args: TerminalSpawnArgs) -> Result<String, String> {
        ipc::terminal_spawn(app.state(), args, Channel::new(|_| Ok(()))).await
    }

    async fn text_of(app: TestApp, handle: TerminalSessionHandle) -> Result<String, String> {
        ipc::terminal_text(app.state(), handle).await
    }

    async fn write_cmd(
        app: TestApp,
        handle: TerminalSessionHandle,
        data: String,
    ) -> Result<(), String> {
        ipc::terminal_write(app.state(), handle, data).await
    }

    fn current(session_id: String, generation: String) -> TerminalSessionHandle {
        TerminalSessionHandle {
            session_id,
            generation,
        }
    }

    fn wait_for_text(app: &TestApp, handle: &TerminalSessionHandle, needle: &str) -> String {
        wait_for_all(app, handle, &[needle])
    }

    fn wait_for_all(app: &TestApp, handle: &TerminalSessionHandle, needles: &[&str]) -> String {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = run(text_of(app.clone(), handle.clone())).unwrap();
            if needles.iter().all(|needle| text.contains(needle)) {
                return text;
            }
            assert!(
                Instant::now() < deadline,
                "fixture terminal never echoed all of {needles:?}: {text:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    static NEXT_HOOK: AtomicU64 = AtomicU64::new(0);

    struct StageGuard(u64);
    impl Drop for StageGuard {
        fn drop(&mut self) {
            STAGES.lock().unwrap().retain(|(id, _, _, _)| *id != self.0);
        }
    }

    fn boundary<F, T>(command: &'static str, app: &TestApp, future: F)
    where
        F: Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let (entered_tx, mut entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Mutex::new(release_rx);
        let id = NEXT_HOOK.fetch_add(1, Ordering::SeqCst);
        let callback: Arc<dyn Fn() + Send + Sync> = Arc::new(move || {
            entered_tx
                .blocking_send(std::thread::current().id())
                .unwrap();
            release_rx
                .lock()
                .unwrap()
                .recv_timeout(Duration::from_secs(5))
                .unwrap();
            panic!("fixture worker failure");
        });
        super::phase08_18_stage::register(
            id,
            command,
            app.state::<TerminalState>().inner(),
            callback,
        );
        let _guard = StageGuard(id);
        run(async move {
            let caller = std::thread::current().id();
            let mut future = Box::pin(future);
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending(),
                "{command} must yield until its blocking worker completes"
            );
            let worker = entered_rx.recv().await.expect("worker entry");
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
            assert_ne!(
                worker, caller,
                "{command} must run on a distinct blocking worker"
            );
            release_tx.send(()).unwrap();
            assert!(
                matches!(future.await, Err(error) if error.starts_with(&format!("{command}_task_failed:"))),
                "{command} must map a panicked worker to the display-only task-failed error"
            );
        });
    }

    async fn boundary_invoke(command: &'static str, app: TestApp) -> Result<String, String> {
        let missing = TerminalSessionHandle {
            session_id: format!("phase08-18-boundary-{command}"),
            generation: "generation".to_string(),
        };
        match command {
            "terminal_spawn" => {
                ipc::terminal_spawn(
                    app.state(),
                    TerminalSpawnArgs {
                        cwd: None,
                        command: Some("/bin/cat".to_string()),
                        ..cat_args(missing.session_id.clone(), PathBuf::from("/"))
                    },
                    Channel::new(|_| Ok(())),
                )
                .await
            }
            "terminal_write" => ipc::terminal_write(app.state(), missing, "x".to_string())
                .await
                .map(|_| String::new()),
            "terminal_input" => {
                ipc::terminal_input(app.state(), missing, TerminalInputCommand::LineBreak)
                    .await
                    .map(|_| String::new())
            }
            "terminal_input_batch" => ipc::terminal_input_batch(
                app.state(),
                missing,
                1,
                vec![TerminalInputCommand::LineBreak],
            )
            .await
            .map(|_| String::new()),
            "terminal_ack" => ipc::terminal_ack(app.state(), missing, 1)
                .await
                .map(|_| String::new()),
            "terminal_request_full" => ipc::terminal_request_full(app.state(), missing)
                .await
                .map(|_| String::new()),
            "terminal_set_visibility" => ipc::terminal_set_visibility(app.state(), missing, false)
                .await
                .map(|_| String::new()),
            "terminal_selection" => {
                ipc::terminal_selection(app.state(), missing, TerminalSelectionCommand::SelectAll)
                    .await
                    .map(|_| String::new())
            }
            "terminal_copy_selection" => ipc::terminal_copy_selection(app.state(), missing).await,
            "terminal_scroll" => ipc::terminal_scroll(app.state(), missing, 1)
                .await
                .map(|_| String::new()),
            "terminal_clear" => ipc::terminal_clear(app.state(), missing)
                .await
                .map(|_| String::new()),
            "terminal_text" => ipc::terminal_text(app.state(), missing).await,
            "terminal_search" => ipc::terminal_search(
                app.state(),
                missing,
                "needle".to_string(),
                None,
                Some(false),
            )
            .await
            .map(|hit| hit.query),
            "terminal_resize" => ipc::terminal_resize(app.state(), missing, 80, 10)
                .await
                .map(|_| String::new()),
            "terminal_kill" => ipc::terminal_kill(app.state(), missing)
                .await
                .map(|_| String::new()),
            other => panic!("unknown boundary command {other}"),
        }
    }

    #[test]
    fn phase08_18_each_wrapper_yields_same_poll_and_maps_join_failure() {
        for command in [
            "terminal_spawn",
            "terminal_write",
            "terminal_input",
            "terminal_input_batch",
            "terminal_ack",
            "terminal_request_full",
            "terminal_set_visibility",
            "terminal_selection",
            "terminal_copy_selection",
            "terminal_scroll",
            "terminal_clear",
            "terminal_text",
            "terminal_search",
            "terminal_resize",
            "terminal_kill",
        ] {
            let app = app();
            let app = app.handle().clone();
            let app_for_boundary = app.clone();
            boundary(command, &app_for_boundary, async move {
                boundary_invoke(command, app).await
            });
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_18_real_pty_fixture_results_and_legacy_rejections() {
        let app = app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let session_id = "phase08-18-cat".to_string();
        let generation = run(spawn_session(
            app.clone(),
            cat_args(session_id.clone(), work.path().to_path_buf()),
        ))
        .unwrap();
        assert!(!generation.is_empty());

        let write_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_write(app.state(), write_handle, "hello-marufixture\n".into())
        )
        .unwrap();
        let text_handle = current(session_id.clone(), generation.clone());
        let text = wait_for_text(&app, &text_handle, "hello-marufixture");
        assert!(!text.trim().is_empty());

        let search_handle = current(session_id.clone(), generation.clone());
        let hit = run_with!(
            app,
            ipc::terminal_search(
                app.state(),
                search_handle,
                "marufixture".into(),
                None,
                Some(false)
            )
        )
        .unwrap();
        assert!(hit.found);
        assert_eq!(hit.length, "marufixture".len());

        let select_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_selection(
                app.state(),
                select_handle,
                TerminalSelectionCommand::SelectAll
            )
        )
        .unwrap();
        let copy_handle = current(session_id.clone(), generation.clone());
        let copied =
            run_with!(app, ipc::terminal_copy_selection(app.state(), copy_handle)).unwrap();
        assert!(
            copied.contains("hello-marufixture"),
            "selection copy must include the fixture line: {copied:?}"
        );

        let input_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_input(
                app.state(),
                input_handle,
                TerminalInputCommand::Text { text: "x".into() }
            )
        )
        .unwrap();
        let batch_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_input_batch(
                app.state(),
                batch_handle,
                1,
                vec![TerminalInputCommand::LineBreak]
            )
        )
        .unwrap();
        let ack_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_ack(app.state(), ack_handle, 1)).unwrap();
        let full_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_request_full(app.state(), full_handle)).unwrap();
        let hide_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_set_visibility(app.state(), hide_handle, false)
        )
        .unwrap();
        let show_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_set_visibility(app.state(), show_handle, true)
        )
        .unwrap();
        let resize_handle = current(session_id.clone(), generation.clone());
        run_with!(
            app,
            ipc::terminal_resize(app.state(), resize_handle, 100, 12)
        )
        .unwrap();
        let up_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_scroll(app.state(), up_handle, 1)).unwrap();
        let down_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_scroll(app.state(), down_handle, -1)).unwrap();
        let clear_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_clear(app.state(), clear_handle)).unwrap();

        let unknown = TerminalSessionHandle {
            session_id: "phase08-18-nope".to_string(),
            generation: "g".to_string(),
        };
        assert_eq!(
            run(text_of(app.clone(), unknown.clone())).unwrap_err(),
            "Unknown terminal session: phase08-18-nope"
        );
        let stale = TerminalSessionHandle {
            session_id: session_id.clone(),
            generation: "old".to_string(),
        };
        assert_eq!(
            run_with!(app, ipc::terminal_write(app.state(), stale, "y".into())).unwrap_err(),
            "Stale terminal session generation: phase08-18-cat"
        );
        let kill_unknown = unknown.clone();
        run_with!(app, ipc::terminal_kill(app.state(), kill_unknown)).unwrap();
        let kill_handle = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_kill(app.state(), kill_handle)).unwrap();
        let kill_again = current(session_id.clone(), generation.clone());
        run_with!(app, ipc::terminal_kill(app.state(), kill_again)).unwrap();
        let gone_handle = current(session_id.clone(), generation.clone());
        assert_eq!(
            run(text_of(app.clone(), gone_handle)).unwrap_err(),
            "Unknown terminal session: phase08-18-cat"
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_18_concurrent_writes_serialize_per_session_in_both_launch_orders() {
        for (first, second) in [("a", "b"), ("b", "a")] {
            let app = app();
            let app = app.handle().clone();
            let work = tempfile::tempdir().unwrap();
            let session_id = format!("phase08-18-contention-{first}{second}");
            let generation = run(spawn_session(
                app.clone(),
                cat_args(session_id.clone(), work.path().to_path_buf()),
            ))
            .unwrap();
            let handle = TerminalSessionHandle {
                session_id,
                generation,
            };
            let payload_a = format!("{}phase08-18-a\n", "a".repeat(40));
            let payload_b = format!("{}phase08-18-b\n", "b".repeat(40));
            let (first_payload, second_payload) = if first == "a" {
                (payload_a.clone(), payload_b.clone())
            } else {
                (payload_b.clone(), payload_a.clone())
            };
            let first_rx = start(write_cmd(app.clone(), handle.clone(), first_payload));
            let second_rx = start(write_cmd(app.clone(), handle.clone(), second_payload));
            done(first_rx).unwrap();
            done(second_rx).unwrap();
            // Which write reaches the PTY first is up to the scheduler, so wait for
            // both echoes: returning on payload_b alone raced payload_a's echo when
            // b landed first. A dropped payload fails the bounded wait; the
            // per-session writer lock is what keeps payloads from interleaving.
            wait_for_all(&app, &handle, &[payload_a.trim_end(), payload_b.trim_end()]);
            run_with!(app, ipc::terminal_kill(app.state(), handle)).unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_18_spawn_rollback_releases_reservation_and_recycles_identity() {
        let app = app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let session_id = "phase08-18-lifecycle".to_string();
        let spawn = |kind: &str| {
            let args = TerminalSpawnArgs {
                kind: kind.to_string(),
                ..cat_args(session_id.clone(), work.path().to_path_buf())
            };
            run(spawn_session(app.clone(), args))
        };

        let error = spawn("bogus").unwrap_err();
        assert!(error.contains("Unsupported terminal launcher"), "{error}");
        let empty_id = TerminalSpawnArgs {
            session_id: String::new(),
            ..cat_args(session_id.clone(), work.path().to_path_buf())
        };
        assert_eq!(
            run(spawn_session(app.clone(), empty_id)).unwrap_err(),
            "terminal_session_id_required"
        );
        let generation = spawn("shell").unwrap();
        assert!(!generation.is_empty());
        assert_eq!(
            spawn("shell").unwrap_err(),
            format!("terminal_session_id_in_use: {session_id}")
        );

        let old = TerminalSessionHandle {
            session_id: session_id.clone(),
            generation,
        };
        let old_kill = old.clone();
        run_with!(app, ipc::terminal_kill(app.state(), old_kill)).unwrap();
        let recycled = spawn("shell").unwrap();
        assert_ne!(old.generation, recycled);
        let stale_write = old.clone();
        assert_eq!(
            run_with!(
                app,
                ipc::terminal_write(app.state(), stale_write, "z".into())
            )
            .unwrap_err(),
            format!("Stale terminal session generation: {session_id}")
        );
        let fresh = TerminalSessionHandle {
            session_id,
            generation: recycled,
        };
        let fresh_write = fresh.clone();
        run_with!(
            app,
            ipc::terminal_write(app.state(), fresh_write, "ok\n".into())
        )
        .unwrap();
        wait_for_text(&app, &fresh, "ok");
        run_with!(app, ipc::terminal_kill(app.state(), fresh)).unwrap();
    }

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("fixture completion")
    }
}

/// REL-01: real-PTY tests for the process-group escalation ladder (D-09,
/// D-10) and the generation-token invariant that protects a recycled
/// session id from a dying child's late output.
#[cfg(all(test, unix))]
mod phase09_02 {
    use super::*;
    use crate::atomic_file::phase08_06::run;
    use std::time::Instant;
    use tauri::Manager;

    type TestApp = tauri::AppHandle<tauri::test::MockRuntime>;

    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(TerminalState::default());
        app
    }

    fn sh_args(session_id: String, script: &str) -> TerminalSpawnArgs {
        TerminalSpawnArgs {
            session_id,
            kind: "shell".to_string(),
            cwd: None,
            command: Some("/bin/sh".to_string()),
            extra_args: Some(vec!["-c".to_string(), script.to_string()]),
            extra_env: None,
            cols: Some(120),
            rows: Some(10),
        }
    }

    fn cat_args(session_id: String) -> TerminalSpawnArgs {
        TerminalSpawnArgs {
            session_id,
            kind: "shell".to_string(),
            cwd: None,
            command: Some("/bin/cat".to_string()),
            extra_args: None,
            extra_env: None,
            cols: Some(120),
            rows: Some(10),
        }
    }

    /// A genuinely interactive, job-control-enabled shell — the same shape
    /// `kind: "shell"` with no command override spawns in production
    /// (default_shell_program(), no args, tty-attached). `-i` makes job
    /// control explicit rather than relying on isatty() auto-detection
    /// inside the test harness; `--norc`/`--noprofile` keep the CI runner's
    /// own dotfiles from adding output or side effects. Unlike `sh_args`'s
    /// `/bin/sh -c script` (non-interactive: the whole script is one
    /// process, so `while` loops never get a separate process group), a
    /// foreground external command here (e.g. bare `sleep 600`, no `&`)
    /// gets its OWN process group under job control, distinct from the
    /// shell's own leader group — reproducing the real bug.
    fn interactive_shell_args(session_id: String) -> TerminalSpawnArgs {
        TerminalSpawnArgs {
            session_id,
            kind: "shell".to_string(),
            cwd: None,
            command: Some("/bin/bash".to_string()),
            extra_args: Some(vec![
                "--noprofile".to_string(),
                "--norc".to_string(),
                "-i".to_string(),
            ]),
            extra_env: None,
            cols: Some(120),
            rows: Some(10),
        }
    }

    fn current(session_id: String, generation: String) -> TerminalSessionHandle {
        TerminalSessionHandle {
            session_id,
            generation,
        }
    }

    async fn spawn_session(app: TestApp, args: TerminalSpawnArgs) -> Result<String, String> {
        ipc::terminal_spawn(app.state(), args, Channel::new(|_| Ok(()))).await
    }

    async fn kill_session(app: TestApp, handle: TerminalSessionHandle) -> Result<(), String> {
        ipc::terminal_kill(app.state(), handle).await
    }

    async fn text_of(app: TestApp, handle: TerminalSessionHandle) -> Result<String, String> {
        ipc::terminal_text(app.state(), handle).await
    }

    async fn write_cmd(
        app: TestApp,
        handle: TerminalSessionHandle,
        data: String,
    ) -> Result<(), String> {
        ipc::terminal_write(app.state(), handle, data).await
    }

    /// Reads a live session's spawn-time process group straight from the
    /// registry — must be called before the session is killed and removed.
    fn process_group_of(app: &TestApp, session_id: &str) -> Option<u32> {
        let state = app.state::<TerminalState>();
        let sessions = state.sessions.lock().unwrap();
        sessions
            .get(session_id)
            .and_then(|session| session.process_group)
    }

    /// Reads the pty's CURRENT foreground process group (tcgetpgrp) straight
    /// from the live session — the same value the production kill paths
    /// must capture before signaling. Must be called before the session is
    /// killed and removed (same caveat as process_group_of).
    fn foreground_pgid_of(app: &TestApp, session_id: &str) -> Option<u32> {
        let state = app.state::<TerminalState>();
        let sessions = state.sessions.lock().unwrap();
        let session = sessions.get(session_id)?;
        let master = session.master.lock().ok()?;
        master
            .process_group_leader()
            .and_then(|pid| u32::try_from(pid).ok())
    }

    /// Polls until the pty's foreground process group differs from
    /// `leader_pgid` (a foreground external command has taken over the
    /// group from the idle shell) or the timeout passes.
    fn wait_for_foreground_job(
        app: &TestApp,
        session_id: &str,
        leader_pgid: u32,
        timeout: Duration,
    ) -> Option<u32> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(pgid) = foreground_pgid_of(app, session_id) {
                if pgid != leader_pgid {
                    return Some(pgid);
                }
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn wait_until_group_gone(pgid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if !process_group_alive(pgid) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
    }

    fn read_pgid(pid: u32) -> Option<u32> {
        let output = std::process::Command::new("ps")
            .args(["-o", "pgid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
            .ok()
    }

    /// Blocks until the session's PTY output contains `marker`. Scripts
    /// below echo a marker right after `trap` installs, so the fixture
    /// never races the shell's own startup (sending SIGHUP before the trap
    /// is installed would kill the shell via the default disposition,
    /// producing a false pass rather than proving escalation ran).
    fn wait_for_marker(app: &TestApp, handle: &TerminalSessionHandle, marker: &str) {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let text = run(text_of(app.clone(), handle.clone())).unwrap();
            if text.contains(marker) {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "marker {marker:?} never appeared in terminal output: {text:?}"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    #[test]
    fn phase09_02_sighup_trapping_child_dies_via_escalation_ladder() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-sighup-trap".to_string();
        let generation = run(spawn_session(
            app.clone(),
            sh_args(
                session_id.clone(),
                "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);
        wait_for_marker(&app, &handle, "TRAP-READY");

        let pgid = process_group_of(&app, &session_id).expect("process group captured at spawn");

        let start = Instant::now();
        run(kill_session(app.clone(), handle)).unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "terminal_kill must return immediately; escalation runs in the background"
        );

        thread::sleep(Duration::from_secs(1));
        assert!(
            process_group_alive(pgid),
            "a SIGHUP-trapping group must still be alive ~1s later (the trap made escalation necessary)"
        );

        assert!(
            wait_until_group_gone(pgid, Duration::from_secs(8)),
            "process group {pgid} survived the full escalation ladder past the 8s deadline"
        );
    }

    #[test]
    fn phase09_02_backgrounded_grandchild_survives_tab_close() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-grandchild".to_string();
        let tempdir = tempfile::tempdir().unwrap();
        let pid_file = tempdir.path().join("gc.pid");
        let script = format!(
            "set -m; sleep 60 & echo $! > {pid}; trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            pid = pid_file.display()
        );
        let generation = run(spawn_session(
            app.clone(),
            sh_args(session_id.clone(), &script),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);
        wait_for_marker(&app, &handle, "TRAP-READY");

        let session_pgid =
            process_group_of(&app, &session_id).expect("process group captured at spawn");

        let deadline = Instant::now() + Duration::from_secs(5);
        let grandchild_pid: u32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "grandchild pid file never appeared"
            );
            thread::sleep(Duration::from_millis(50));
        };

        let grandchild_pgid = read_pgid(grandchild_pid)
            .expect("grandchild process group must be discoverable via ps");
        assert_ne!(
            grandchild_pgid, session_pgid,
            "precondition: the backgrounded grandchild must be in its own process group \
             (set -m job control) — if this fails the test fixture, not the fix, is wrong"
        );

        run(kill_session(app.clone(), handle)).unwrap();
        assert!(
            wait_until_group_gone(session_pgid, Duration::from_secs(8)),
            "session process group {session_pgid} never died"
        );
        assert!(
            process_group_alive(grandchild_pgid),
            "the backgrounded grandchild's group must survive the tab's kill ladder"
        );

        // Cleanup: the grandchild is a real detached `sleep 60` outside any
        // Maru session; make sure it does not outlive this test.
        let _ = signal_process_group(grandchild_pgid, SIGKILL);
    }

    #[test]
    fn phase09_02_generation_invariant_blocks_late_output_and_stale_handle() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-generation".to_string();
        let old_generation = run(spawn_session(
            app.clone(),
            sh_args(
                session_id.clone(),
                "trap 'echo LATE-OLD-GEN' HUP; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let old_handle = current(session_id.clone(), old_generation);
        wait_for_marker(&app, &old_handle, "TRAP-READY");

        run(kill_session(app.clone(), old_handle.clone())).unwrap();

        let new_generation = run(spawn_session(app.clone(), cat_args(session_id.clone()))).unwrap();
        let new_handle = current(session_id.clone(), new_generation);

        thread::sleep(Duration::from_millis(2500));

        let text = run(text_of(app.clone(), new_handle)).unwrap();
        assert!(
            !text.contains("LATE-OLD-GEN"),
            "late output from the killed old-generation child must never reach the new session: {text:?}"
        );

        let write_result = run(write_cmd(app.clone(), old_handle, "irrelevant\n".into()));
        assert!(
            write_result.is_err(),
            "the old generation's handle must be rejected after respawn"
        );
    }

    /// Spawns `/bin/sh -c script` directly (no PTY) with its own process
    /// group (`process_group(0)`), reaping it on a waiter thread so a
    /// zombie leader never keeps the group observable. Returns the pgid.
    fn spawn_direct_trapping(script: &str) -> u32 {
        use std::os::unix::process::CommandExt;
        let mut child = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(script)
            .process_group(0)
            .spawn()
            .expect("spawn direct process");
        let pgid = child.id();
        thread::spawn(move || {
            let _ = child.wait();
        });
        pgid
    }

    #[test]
    fn phase09_02_direct_spawn_escalates_to_sigkill_when_hup_and_term_trapped() {
        let tempdir = tempfile::tempdir().unwrap();
        let marker = tempdir.path().join("ready");
        let script = format!(
            "trap '' HUP TERM; : > {marker}; while :; do sleep 1; done",
            marker = marker.display()
        );
        let pgid = spawn_direct_trapping(&script);

        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                Instant::now() < deadline,
                "direct-spawn child never signaled readiness"
            );
            thread::sleep(Duration::from_millis(20));
        }

        signal_process_group(pgid, SIGHUP).unwrap();
        let (stage, _) =
            escalate_process_groups(&[KillTarget::Group(pgid)], Duration::from_millis(200));
        assert_eq!(
            stage,
            KillStage::Kill,
            "a child trapping both HUP and TERM must only die at the SIGKILL stage"
        );
        // escalate_process_groups returns as soon as SIGKILL is sent, without
        // polling for the kernel to finish tearing the process down (and the
        // waiter thread to reap it) -- give that a brief window here.
        assert!(
            wait_until_group_gone(pgid, Duration::from_secs(2)),
            "SIGKILL must eventually remove the process group"
        );
    }

    #[test]
    fn phase09_02_escalation_warn_line_matches_d11_format() {
        let group = [KillTarget::Group(4242)];
        assert_eq!(escalation_warn_line(&group, KillStage::Hangup), None);
        assert_eq!(escalation_warn_line(&[], KillStage::Kill), None);
        assert_eq!(
            escalation_warn_line(&group, KillStage::Terminate),
            Some("[terminal] pgid 4242 survived SIGHUP; escalated to SIGTERM".to_string())
        );
        assert_eq!(
            escalation_warn_line(&group, KillStage::Kill),
            Some("[terminal] pgid 4242 survived SIGHUP; escalated to SIGKILL".to_string())
        );
        assert_eq!(
            escalation_warn_line(
                &[KillTarget::Leader(4241), KillTarget::Group(4242)],
                KillStage::Kill
            ),
            Some(
                "[terminal] pid 4241, pgid 4242 survived SIGHUP; escalated to SIGKILL".to_string()
            )
        );
    }

    #[test]
    fn phase09_02_ladder_reports_only_targets_that_outlived_sighup() {
        let tempdir = tempfile::tempdir().unwrap();
        let marker = tempdir.path().join("ready");
        let trapping = spawn_direct_trapping(&format!(
            "trap '' HUP; : > {marker}; while :; do sleep 1; done",
            marker = marker.display()
        ));
        let plain = spawn_direct_trapping("while :; do sleep 1; done");
        let deadline = Instant::now() + Duration::from_secs(5);
        while !marker.exists() {
            assert!(
                Instant::now() < deadline,
                "direct-spawn child never signaled readiness"
            );
            thread::sleep(Duration::from_millis(20));
        }

        let targets = [KillTarget::Group(plain), KillTarget::Leader(trapping)];
        for target in targets {
            signal_process_group(target.pgid(), SIGHUP).unwrap();
        }
        let (stage, escalated) = escalate_process_groups(&targets, Duration::from_millis(500));
        assert_eq!(stage, KillStage::Terminate);
        assert_eq!(
            escalated,
            vec![KillTarget::Leader(trapping)],
            "only the SIGHUP-trapping target needed escalation; the plain one died at SIGHUP"
        );
        assert!(wait_until_group_gone(trapping, Duration::from_secs(3)));
    }

    #[test]
    fn phase09_02_repeated_kill_is_idempotent_and_does_not_block_other_sessions() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-repeat-kill".to_string();
        let generation = run(spawn_session(
            app.clone(),
            sh_args(
                session_id.clone(),
                "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);
        wait_for_marker(&app, &handle, "TRAP-READY");

        run(kill_session(app.clone(), handle.clone())).unwrap();
        // Second kill of the same handle: idempotent, sends nothing new.
        run(kill_session(app.clone(), handle)).unwrap();

        // While the first session's ladder sleeps in the background (up to
        // KILL_ESCALATION_GRACE per stage), an unrelated session must still
        // spawn and be killed quickly -- no lock is held across the sleeps.
        let other_id = "phase09-02-repeat-kill-other".to_string();
        let start = Instant::now();
        let other_generation = run(spawn_session(app.clone(), cat_args(other_id.clone()))).unwrap();
        let other_handle = current(other_id, other_generation);
        run(kill_session(app.clone(), other_handle)).unwrap();
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "spawn+kill of an unrelated session must not block on another session's escalation ladder"
        );
    }

    #[test]
    fn phase09_02_sweep_sessions_clears_live_and_mid_ladder_groups() {
        let app = app();
        let app = app.handle().clone();
        let state = app.state::<TerminalState>().inner().clone();

        let id_a = "phase09-02-sweep-a".to_string();
        let gen_a = run(spawn_session(
            app.clone(),
            sh_args(
                id_a.clone(),
                "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let handle_a = current(id_a.clone(), gen_a);
        wait_for_marker(&app, &handle_a, "TRAP-READY");
        let pgid_a = process_group_of(&app, &id_a).expect("pgid a captured");

        let id_b = "phase09-02-sweep-b".to_string();
        let gen_b = run(spawn_session(
            app.clone(),
            sh_args(
                id_b.clone(),
                "trap '' HUP TERM; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let handle_b = current(id_b.clone(), gen_b);
        wait_for_marker(&app, &handle_b, "TRAP-READY");
        let pgid_b = process_group_of(&app, &id_b).expect("pgid b captured");

        let id_c = "phase09-02-sweep-c".to_string();
        let gen_c = run(spawn_session(
            app.clone(),
            sh_args(
                id_c.clone(),
                "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            ),
        ))
        .unwrap();
        let handle_c = current(id_c.clone(), gen_c);
        wait_for_marker(&app, &handle_c, "TRAP-READY");
        let pgid_c = process_group_of(&app, &id_c).expect("pgid c captured");

        // Put C mid-ladder: its own tab-close escalation thread is now
        // sleeping in the background against KILL_ESCALATION_GRACE (2s),
        // independent of the sweep below.
        run(kill_session(app.clone(), handle_c)).unwrap();

        sweep_sessions(&state, Duration::from_millis(300));

        // sweep_sessions returns as soon as its last SIGKILL is sent for any
        // survivor, without polling for the kernel to finish tearing the
        // process down -- give that a brief window per group here.
        assert!(
            wait_until_group_gone(pgid_a, Duration::from_secs(2)),
            "session A's live group must be gone after the sweep"
        );
        assert!(
            wait_until_group_gone(pgid_b, Duration::from_secs(2)),
            "session B's live group (traps HUP and TERM) must be gone after the sweep"
        );
        assert!(
            wait_until_group_gone(pgid_c, Duration::from_secs(2)),
            "session C's mid-ladder group must be gone after the sweep"
        );
        assert!(state.sessions.lock().unwrap().is_empty());
        assert!(state.escalations.lock().unwrap().is_empty());

        // A second sweep right after a full sweep is a fast no-op.
        let start = Instant::now();
        sweep_sessions(&state, Duration::from_millis(300));
        assert!(
            start.elapsed() < Duration::from_millis(50),
            "a sweep of an already-empty state must return almost immediately"
        );
    }

    #[test]
    fn phase09_02_sweep_sessions_on_empty_state_returns_immediately() {
        let state = TerminalState::default();
        let start = Instant::now();
        sweep_sessions(&state, Duration::from_millis(300));
        assert!(start.elapsed() < Duration::from_millis(50));

        let start = Instant::now();
        sweep_sessions(&state, Duration::from_millis(300));
        assert!(start.elapsed() < Duration::from_millis(50));
    }

    // Owner checkpoint regression (plan 09-08): a real terminal is an
    // INTERACTIVE, job-control-enabled shell (kind: "shell", no command
    // override — interactive_shell_args mirrors that exactly). Under job
    // control, a foreground external command (typed at the prompt, no `-c`
    // wrapper) gets its OWN process group, distinct from the shell's own
    // leader group that REL-01 captures at spawn. `trap '' HUP; sleep 600`
    // as a genuine foreground job reproduces this: the shell's leader group
    // dies, but the sleep's own group — never targeted before this fix —
    // survives untouched. The existing phase09_02 traps above all run via
    // `/bin/sh -c script` (non-interactive, no job control), which is why
    // they never caught this: the whole script is one process, so nothing
    // ever forks a second process group to miss.
    #[test]
    fn phase09_02_tab_close_kills_the_interactive_foreground_job_group() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-fg-tab-close".to_string();
        let generation = run(spawn_session(
            app.clone(),
            interactive_shell_args(session_id.clone()),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);

        let leader_pgid =
            process_group_of(&app, &session_id).expect("process group captured at spawn");
        // The marker names the shell's own pid so it can only match the
        // ACTUAL command output (substituted by bash), never the tty's local
        // echo of the literal keystrokes we write below (which would show
        // the unexpanded "$$" and never match a marker with real digits).
        let marker = format!("READY-{leader_pgid}");
        run(write_cmd(
            app.clone(),
            handle.clone(),
            format!("trap '' HUP; echo {marker}; sleep 600\n"),
        ))
        .unwrap();
        wait_for_marker(&app, &handle, &marker);

        let foreground_pgid =
            wait_for_foreground_job(&app, &session_id, leader_pgid, Duration::from_secs(3)).expect(
                "precondition: an interactive shell running a foreground `sleep` must get \
                     its own process group (job control) — if this fails the test fixture, not \
                     the fix, is wrong",
            );
        assert_ne!(
            foreground_pgid, leader_pgid,
            "precondition: the foreground job's group must differ from the shell's own leader"
        );

        let start = Instant::now();
        run(kill_session(app.clone(), handle)).unwrap();
        assert!(
            start.elapsed() < Duration::from_millis(500),
            "terminal_kill must return immediately; escalation runs in the background"
        );

        assert!(
            wait_until_group_gone(leader_pgid, Duration::from_secs(8)),
            "the shell's own leader group must be gone after the tab-close ladder"
        );
        assert!(
            wait_until_group_gone(foreground_pgid, Duration::from_secs(8)),
            "the foreground `sleep 600` job's own process group {foreground_pgid} must be gone \
             after the tab-close ladder, not just the shell's leader group {leader_pgid}"
        );
    }

    #[test]
    fn phase09_02_quit_sweep_kills_the_interactive_foreground_job_group_within_budget() {
        let app = app();
        let app = app.handle().clone();
        let state = app.state::<TerminalState>().inner().clone();
        let session_id = "phase09-02-fg-quit-sweep".to_string();
        let generation = run(spawn_session(
            app.clone(),
            interactive_shell_args(session_id.clone()),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);

        let leader_pgid =
            process_group_of(&app, &session_id).expect("process group captured at spawn");
        let marker = format!("READY-{leader_pgid}");
        run(write_cmd(
            app.clone(),
            handle.clone(),
            format!("trap '' HUP; echo {marker}; sleep 600\n"),
        ))
        .unwrap();
        wait_for_marker(&app, &handle, &marker);

        let foreground_pgid =
            wait_for_foreground_job(&app, &session_id, leader_pgid, Duration::from_secs(3)).expect(
                "precondition: an interactive shell running a foreground `sleep` must get \
                     its own process group (job control) — if this fails the test fixture, not \
                     the fix, is wrong",
            );

        // D-12: the whole quit sweep (every live session, whatever its
        // shape) must finish inside the 3s quit budget.
        let start = Instant::now();
        shutdown_all_sessions(&state);
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(3),
            "the quit sweep must finish inside the 3s quit budget (D-12); took {elapsed:?}"
        );

        assert!(
            wait_until_group_gone(leader_pgid, Duration::from_secs(2)),
            "the shell's own leader group must be gone after the quit sweep"
        );
        assert!(
            wait_until_group_gone(foreground_pgid, Duration::from_secs(2)),
            "the foreground `sleep 600` job's own process group {foreground_pgid} must be gone \
             after the quit sweep, not just the shell's leader group {leader_pgid}"
        );
    }

    #[test]
    fn phase09_02_disowned_job_survives_tab_close_even_with_foreground_targeting() {
        let app = app();
        let app = app.handle().clone();
        let session_id = "phase09-02-disown-tab-close".to_string();
        let tempdir = tempfile::tempdir().unwrap();
        let pid_file = tempdir.path().join("bg.pid");
        let generation = run(spawn_session(
            app.clone(),
            interactive_shell_args(session_id.clone()),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);

        let leader_pgid =
            process_group_of(&app, &session_id).expect("process group captured at spawn");
        let marker = format!("READY-{leader_pgid}");
        let script = format!(
            "sleep 600 & echo $! > {pid}; disown; echo {marker}\n",
            pid = pid_file.display(),
        );
        run(write_cmd(app.clone(), handle.clone(), script)).unwrap();
        wait_for_marker(&app, &handle, &marker);

        let deadline = Instant::now() + Duration::from_secs(5);
        let bg_pid: u32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "background job pid file never appeared"
            );
            thread::sleep(Duration::from_millis(50));
        };
        let bg_pgid =
            read_pgid(bg_pid).expect("disowned job's process group must be discoverable via ps");
        assert_ne!(
            bg_pgid, leader_pgid,
            "precondition: the disowned background job must be in its own process group \
             (job control) — if this fails the test fixture, not the fix, is wrong"
        );

        run(kill_session(app.clone(), handle)).unwrap();
        assert!(
            wait_until_group_gone(leader_pgid, Duration::from_secs(8)),
            "the shell's own leader group must still die on tab close"
        );
        assert!(
            process_group_alive(bg_pgid),
            "a disowned background job must survive the tab's kill ladder even with foreground \
             targeting added — it is never the pty's foreground group (REL-01/D-09)"
        );

        // Cleanup: a real detached `sleep 600` outside any Maru session.
        let _ = signal_process_group(bg_pgid, SIGKILL);
    }

    #[test]
    fn phase09_02_disowned_job_survives_quit_sweep() {
        let app = app();
        let app = app.handle().clone();
        let state = app.state::<TerminalState>().inner().clone();
        let session_id = "phase09-02-disown-quit-sweep".to_string();
        let tempdir = tempfile::tempdir().unwrap();
        let pid_file = tempdir.path().join("bg.pid");
        let generation = run(spawn_session(
            app.clone(),
            interactive_shell_args(session_id.clone()),
        ))
        .unwrap();
        let handle = current(session_id.clone(), generation);

        let leader_pgid =
            process_group_of(&app, &session_id).expect("process group captured at spawn");
        let marker = format!("READY-{leader_pgid}");
        let script = format!(
            "sleep 600 & echo $! > {pid}; disown; echo {marker}\n",
            pid = pid_file.display(),
        );
        run(write_cmd(app.clone(), handle.clone(), script)).unwrap();
        wait_for_marker(&app, &handle, &marker);

        let deadline = Instant::now() + Duration::from_secs(5);
        let bg_pid: u32 = loop {
            if let Ok(contents) = std::fs::read_to_string(&pid_file) {
                if let Ok(pid) = contents.trim().parse::<u32>() {
                    break pid;
                }
            }
            assert!(
                Instant::now() < deadline,
                "background job pid file never appeared"
            );
            thread::sleep(Duration::from_millis(50));
        };
        let bg_pgid =
            read_pgid(bg_pid).expect("disowned job's process group must be discoverable via ps");
        assert_ne!(
            bg_pgid, leader_pgid,
            "precondition: the disowned background job must be in its own process group"
        );

        shutdown_all_sessions(&state);

        assert!(
            wait_until_group_gone(leader_pgid, Duration::from_secs(2)),
            "the shell's own leader group must still die on the quit sweep"
        );
        assert!(
            process_group_alive(bg_pgid),
            "a disowned background job must survive the quit sweep too (D-09/REL-01)"
        );

        let _ = signal_process_group(bg_pgid, SIGKILL);
    }

    // PR #361 review: agent tabs exec the CLI directly as the leader and
    // wrapper tabs run `sh -c`, so there is no job control and a `nohup cmd &`
    // the leader starts stays in the leader's own process group. The ladder
    // must escalate the leader pid only, never that whole group, or the
    // nohup'd job dies at SIGTERM (D-09: nohup/disown jobs survive).

    /// Live, non-zombie check for one pid, independent of the ladder's own
    /// probes: `ps` prints nothing for a reaped pid and `Z...` for a zombie.
    fn pid_alive(pid: u32) -> bool {
        std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .map(|output| {
                let stat = String::from_utf8_lossy(&output.stdout);
                let stat = stat.trim();
                !stat.is_empty() && !stat.starts_with('Z')
            })
            .unwrap_or(false)
    }

    fn wait_until_pid_gone(pid: u32, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while pid_alive(pid) {
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(50));
        }
        true
    }

    /// Blocks until no tab-close ladder thread is still running.
    fn wait_for_ladders_done(app: &TestApp) {
        let state = app.state::<TerminalState>();
        let deadline = Instant::now() + Duration::from_secs(8);
        while !state.escalations.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "tab-close ladder never finished");
            thread::sleep(Duration::from_millis(50));
        }
    }

    /// Spawns a `/bin/sh -c` leader (no job control) that starts
    /// `nohup sleep 600 &` and then runs `tail`, which must print `marker`.
    /// Returns (handle, leader pid, nohup'd child pid).
    fn spawn_nohup_leader(
        app: &TestApp,
        session_id: &str,
        tail: &str,
        marker: &str,
        pid_file: &Path,
    ) -> (TerminalSessionHandle, u32, u32) {
        let script = format!(
            "nohup sleep 600 </dev/null >/dev/null 2>&1 & echo $! > {pid}; {tail}",
            pid = pid_file.display()
        );
        let generation = run(spawn_session(
            app.clone(),
            sh_args(session_id.to_string(), &script),
        ))
        .unwrap();
        let handle = current(session_id.to_string(), generation);
        wait_for_marker(app, &handle, marker);
        let leader = process_group_of(app, session_id).expect("process group captured at spawn");
        let child = std::fs::read_to_string(pid_file)
            .ok()
            .and_then(|contents| contents.trim().parse::<u32>().ok())
            .expect("the pid file is written before the marker is echoed");
        assert_eq!(
            read_pgid(child),
            Some(leader),
            "precondition: without job control the nohup'd child must share the leader's \
             process group -- if this fails the test fixture, not the fix, is wrong"
        );
        (handle, leader, child)
    }

    fn kill_pid(pid: u32) {
        let _ = std::process::Command::new("kill")
            .args(["-9", &pid.to_string()])
            .stderr(std::process::Stdio::null())
            .status();
    }

    #[test]
    fn phase09_02_nohup_child_of_non_job_control_leader_survives_tab_close() {
        let app = app();
        let app = app.handle().clone();
        let tempdir = tempfile::tempdir().unwrap();
        let (handle, leader, child) = spawn_nohup_leader(
            &app,
            "phase09-02-nohup-tab-close",
            "echo NOHUP-READY; wait",
            "NOHUP-READY",
            &tempdir.path().join("nohup.pid"),
        );

        run(kill_session(app.clone(), handle)).unwrap();
        assert!(
            wait_until_pid_gone(leader, Duration::from_secs(8)),
            "the leader {leader} must die on tab close"
        );
        wait_for_ladders_done(&app);

        let survived = pid_alive(child);
        kill_pid(child);
        assert!(
            survived,
            "a nohup'd child {child} in the non-job-control leader's group must survive the \
             whole tab-close ladder (D-09)"
        );
    }

    #[test]
    fn phase09_02_hup_trapping_non_job_control_leader_is_escalated_but_nohup_child_survives() {
        let app = app();
        let app = app.handle().clone();
        let tempdir = tempfile::tempdir().unwrap();
        let (handle, leader, child) = spawn_nohup_leader(
            &app,
            "phase09-02-nohup-trap-tab-close",
            "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            "TRAP-READY",
            &tempdir.path().join("nohup.pid"),
        );

        run(kill_session(app.clone(), handle)).unwrap();
        thread::sleep(Duration::from_secs(1));
        assert!(
            pid_alive(leader),
            "a SIGHUP-trapping leader must still be alive ~1s later (the trap made escalation necessary)"
        );
        assert!(
            wait_until_pid_gone(leader, Duration::from_secs(8)),
            "the SIGHUP-trapping leader {leader} must be escalated and gone (REL-01)"
        );
        wait_for_ladders_done(&app);

        let survived = pid_alive(child);
        kill_pid(child);
        assert!(
            survived,
            "escalating a SIGHUP-trapping leader must hit the leader pid only, not the nohup'd \
             child {child} in its group (D-09)"
        );
    }

    #[test]
    fn phase09_02_nohup_child_of_non_job_control_leader_survives_quit_sweep() {
        let app = app();
        let app = app.handle().clone();
        let state = app.state::<TerminalState>().inner().clone();
        let tempdir = tempfile::tempdir().unwrap();
        let (_handle, leader, child) = spawn_nohup_leader(
            &app,
            "phase09-02-nohup-quit-sweep",
            "trap '' HUP; echo TRAP-READY; while :; do sleep 1; done",
            "TRAP-READY",
            &tempdir.path().join("nohup.pid"),
        );

        let start = Instant::now();
        shutdown_all_sessions(&state);
        let elapsed = start.elapsed();
        assert!(
            elapsed < Duration::from_secs(3),
            "the quit sweep must finish inside the 3s quit budget (D-12); took {elapsed:?}"
        );
        assert!(
            wait_until_pid_gone(leader, Duration::from_secs(2)),
            "the SIGHUP-trapping leader {leader} must be gone after the quit sweep"
        );

        let survived = pid_alive(child);
        kill_pid(child);
        assert!(
            survived,
            "the quit sweep must escalate the leader pid only, not the nohup'd child {child} \
             in its group (D-09)"
        );
    }
}
