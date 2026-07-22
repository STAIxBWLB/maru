mod input;
mod model;
mod snapshot;

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::env;
use std::io::{ErrorKind, Read};
use std::path::PathBuf;
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
        let mut reservations = state
            .reservations
            .lock()
            .map_err(|_| "terminal_registry_poisoned".to_string())?;
        let sessions = state
            .sessions
            .lock()
            .map_err(|_| "terminal_registry_poisoned".to_string())?;
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
        frame: snapshot::TerminalWireFrame,
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

    fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Release);
        self.wake_cv.notify_one();
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
            self.wake_cv.notify_one();
        }
    }

    fn acknowledge(&self, seq: u64) {
        self.acked_seq.fetch_max(seq, Ordering::AcqRel);
        self.wake_cv.notify_one();
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
            frame: frame.into(),
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
        self.wake_cv.notify_all();
    }
}

fn should_stop_frame_emitter(stream: &TerminalStream) -> bool {
    !stream.running.load(Ordering::Acquire)
        && (!stream.dirty.load(Ordering::Acquire)
            || !stream.visible.load(Ordering::Acquire)
            || !stream.has_credit())
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

#[tauri::command]
pub async fn terminal_spawn(
    state: State<'_, TerminalState>,
    session_id: String,
    kind: String,
    cwd: Option<String>,
    command: Option<String>,
    extra_args: Option<Vec<String>>,
    extra_env: Option<HashMap<String, String>>,
    cols: Option<u16>,
    rows: Option<u16>,
    on_event: Channel<TerminalStreamMessage>,
) -> Result<String, String> {
    if session_id.trim().is_empty() {
        return Err("terminal_session_id_required".to_string());
    }
    let reservation = SessionReservation::acquire(&state, &session_id)?;
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
    });
    state
        .sessions
        .lock()
        .map_err(|_| "terminal_registry_poisoned".to_string())?
        .insert(session_id.clone(), session.clone());
    reservation.commit();

    let pump_handle = spawn_output_pump(reader, model, input_modes, stream.clone());

    let sessions = state.sessions.clone();
    let exit_id = session_id.clone();
    let exit_session = session.clone();
    thread::spawn(move || {
        let exit_code = child.wait().ok().map(|status| status.exit_code() as i32);
        stream.stop();
        let _ = pump_handle.join();
        if let Ok(mut guard) = sessions.lock() {
            let is_current = guard
                .get(&exit_id)
                .is_some_and(|current| Arc::ptr_eq(current, &exit_session));
            if is_current {
                guard.remove(&exit_id);
            }
        }
        stream.send_exit(exit_code);
    });

    Ok(generation)
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, TerminalState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    write_shared(&session.writer, data.as_bytes())
}

#[tauri::command]
pub async fn terminal_input(
    state: State<'_, TerminalState>,
    session_id: String,
    command: TerminalInputCommand,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
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

#[tauri::command]
pub async fn terminal_input_batch(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
    _client_seq: u64,
    commands: Vec<TerminalInputCommand>,
) -> Result<(), String> {
    let session = get_session_generation(&state, &session_id, &generation)?;
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

#[tauri::command]
pub async fn terminal_ack(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
    seq: u64,
) -> Result<(), String> {
    let session = get_session_generation(&state, &session_id, &generation)?;
    session.stream.acknowledge(seq);
    Ok(())
}

#[tauri::command]
pub async fn terminal_request_full(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
) -> Result<(), String> {
    let session = get_session_generation(&state, &session_id, &generation)?;
    session.stream.request_full();
    Ok(())
}

#[tauri::command]
pub async fn terminal_set_visibility(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
    visible: bool,
) -> Result<(), String> {
    let session = get_session_generation(&state, &session_id, &generation)?;
    session.stream.set_visible(visible);
    Ok(())
}

#[tauri::command]
pub async fn terminal_selection(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
    command: TerminalSelectionCommand,
) -> Result<(), String> {
    use alacritty_terminal::index::Side;
    use alacritty_terminal::selection::SelectionType;

    let session = get_session_generation(&state, &session_id, &generation)?;
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

#[tauri::command]
pub async fn terminal_copy_selection(
    state: State<'_, TerminalState>,
    session_id: String,
    generation: String,
) -> Result<String, String> {
    let session = get_session_generation(&state, &session_id, &generation)?;
    let model = session
        .model
        .lock()
        .map_err(|_| "terminal_model_poisoned".to_string())?;
    Ok(model.selection_text())
}

/// Scroll the viewport through scrollback by `delta` lines (positive = toward
/// history). Emits a fresh full frame so the renderer shows the scrolled view.
#[tauri::command]
pub async fn terminal_scroll(
    state: State<'_, TerminalState>,
    session_id: String,
    delta: i32,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
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
#[tauri::command]
pub async fn terminal_clear(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
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

#[tauri::command]
pub async fn terminal_text(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<String, String> {
    let session = get_session(&state, &session_id)?;
    let model = session
        .model
        .lock()
        .map_err(|_| "terminal_model_poisoned".to_string())?;
    Ok(model.text())
}

#[tauri::command]
pub async fn terminal_search(
    state: State<'_, TerminalState>,
    session_id: String,
    query: String,
    direction: Option<String>,
    case_sensitive: Option<bool>,
) -> Result<TerminalSearchResult, String> {
    let session = get_session(&state, &session_id)?;
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
        session_id,
        query,
        found: hit.is_some(),
        row: hit.as_ref().map(|item| item.row),
        col: hit.as_ref().map(|item| item.col),
        length: hit.as_ref().map(|item| item.length).unwrap_or(0),
        display_offset,
    })
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, TerminalState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = get_session(&state, &session_id)?;
    let cols = cols.clamp(2, MAX_COLS);
    let rows = rows.clamp(1, MAX_ROWS);
    let _resize = session
        .resize_lock
        .lock()
        .map_err(|_| "terminal_resize_poisoned".to_string())?;
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
        session.input_modes.update(&model);
    }
    session.stream.request_full();
    Ok(())
}

#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, TerminalState>,
    session_id: String,
) -> Result<(), String> {
    let session = match get_session(&state, &session_id) {
        Ok(session) => session,
        Err(_) => return Ok(()),
    };
    if session.closing.swap(true, Ordering::AcqRel) {
        return Ok(());
    }
    let mut killer = match session.killer.lock() {
        Ok(killer) => killer,
        Err(_) => {
            session.closing.store(false, Ordering::Release);
            return Err("terminal_killer_poisoned".to_string());
        }
    };
    if let Err(err) = killer.kill() {
        session.closing.store(false, Ordering::Release);
        return Err(format!("terminal_kill_failed: {err}"));
    }
    Ok(())
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

fn get_session_generation(
    state: &State<'_, TerminalState>,
    session_id: &str,
    generation: &str,
) -> Result<Arc<TerminalSession>, String> {
    let session = get_session(state, session_id)?;
    if session.generation != generation {
        return Err(format!("Stale terminal session generation: {session_id}"));
    }
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

        if !stream.visible.load(Ordering::Acquire) || !stream.has_credit() {
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

    let (program, mut args) = match (kind, custom) {
        (_, Some(program)) => (program.to_string(), Vec::<String>::new()),
        ("claude", None) => ("claude".to_string(), Vec::new()),
        ("codex", None) => ("codex".to_string(), vec!["--cd".to_string(), cwd_str]),
        ("shell", None) => (default_shell_program(), Vec::new()),
        (other, None) => return Err(format!("Unsupported terminal launcher: {other}")),
    };
    args.extend(extras);
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
    if kind == "claude" || kind == "codex" {
        "ghostty"
    } else {
        "Maru"
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
                "version: 1\npaths:\n  primary: {}\n  scratchpad: {}\nscratchpad:\n  temp_subdir: temp\n",
                work.path().display(),
                scratchpad.display()
            ),
        )
        .unwrap();
        let mut caller_env = HashMap::new();
        caller_env.insert("MARU_SCRATCHPAD".to_string(), "/tmp/override".to_string());
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
    fn stream_credit_bounds_unacknowledged_frames() {
        let channel = Channel::new(|_| Ok(()));
        let stream = TerminalStream::new("term-1".to_string(), "generation-1".to_string(), channel);
        let model = TerminalModel::new(10, 2, model::NullTerminalWriter);
        assert!(stream.has_credit());
        stream.send_frame(model.snapshot("term-1")).unwrap();
        stream.send_frame(model.snapshot("term-1")).unwrap();
        assert!(!stream.has_credit());
        stream.stop();
        assert!(should_stop_frame_emitter(&stream));
        stream.acknowledge(1);
        assert!(stream.has_credit());
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
