use crate::scratchpad::{
    assert_scratchpad_workspace_access, resolve_scratchpad_root, validate_scratchpad_layout,
};
use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

struct ActiveWatcher {
    generation: u64,
    work_path: PathBuf,
    _watcher: RecommendedWatcher,
}

#[derive(Default)]
struct WatcherControl {
    active: Option<ActiveWatcher>,
}

pub struct ScratchpadWatcherState {
    control: Mutex<WatcherControl>,
    epoch: Arc<AtomicU64>,
}

impl Default for ScratchpadWatcherState {
    fn default() -> Self {
        Self {
            control: Mutex::new(WatcherControl::default()),
            epoch: Arc::new(AtomicU64::new(0)),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadChangedEvent {
    pub work_path: String,
    pub paths: Vec<String>,
    pub generation: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScratchpadWatcherErrorEvent {
    pub work_path: String,
    pub message: String,
    pub generation: u64,
}

enum WatchMessage {
    Event(Event),
    Error(String),
}

fn relevant_path(path: &Path, root: &Path) -> bool {
    let Ok(relative) = path.strip_prefix(root) else {
        return false;
    };
    if relative.as_os_str().is_empty() {
        return false;
    }
    if relative.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .map(|part| part.starts_with('.') && part.contains(".maru-tmp-"))
            .unwrap_or(false)
    }) {
        return false;
    }
    true
}

fn generation_is_current(epoch: &AtomicU64, generation: u64) -> bool {
    epoch.load(Ordering::SeqCst) == generation
}

#[tauri::command]
pub fn start_scratchpad_watcher(
    app: AppHandle,
    state: State<'_, ScratchpadWatcherState>,
    work_path: String,
) -> Result<u64, String> {
    let work = PathBuf::from(&work_path);
    assert_scratchpad_workspace_access(&work)?;
    validate_scratchpad_layout(&work)?;
    let work_owner = work
        .canonicalize()
        .map_err(|err| format!("Cannot resolve Scratchpad watcher workPath: {err}"))?;
    let root = resolve_scratchpad_root(&work)?;

    {
        let guard = state
            .control
            .lock()
            .map_err(|err| format!("Scratchpad watcher state lock poisoned: {err}"))?;
        if let Some(active) = guard.active.as_ref().filter(|active| {
            active.work_path == work_owner && generation_is_current(&state.epoch, active.generation)
        }) {
            return Ok(active.generation);
        }
    }

    // Claim a generation before setup. Any newer start/stop invalidates this
    // token, so a slow start can never replace the current owner afterward.
    let generation = state.epoch.fetch_add(1, Ordering::SeqCst) + 1;
    {
        let mut guard = state
            .control
            .lock()
            .map_err(|err| format!("Scratchpad watcher state lock poisoned: {err}"))?;
        guard.active = None;
    }

    fs::create_dir_all(&root)
        .map_err(|err| format!("Cannot create Scratchpad root for watcher: {err}"))?;
    let root = root
        .canonicalize()
        .map_err(|err| format!("Cannot resolve Scratchpad watcher root: {err}"))?;

    let (tx, rx) = mpsc::channel::<WatchMessage>();
    let mut watcher = recommended_watcher(move |result: Result<Event, notify::Error>| {
        let message = match result {
            Ok(event)
                if matches!(
                    event.kind,
                    EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
                ) =>
            {
                Some(WatchMessage::Event(event))
            }
            Ok(_) => None,
            Err(err) => Some(WatchMessage::Error(err.to_string())),
        };
        if let Some(message) = message {
            let _ = tx.send(message);
        }
    })
    .map_err(|err| format!("Scratchpad watcher creation failed: {err}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| format!("Scratchpad watcher start failed: {err}"))?;

    let root_for_thread = root.clone();
    let work_for_thread = work_path.clone();
    let epoch_for_thread = Arc::clone(&state.epoch);
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            if !generation_is_current(&epoch_for_thread, generation) {
                return;
            }
            let first = match first {
                WatchMessage::Event(event) => event,
                WatchMessage::Error(message) => {
                    if !generation_is_current(&epoch_for_thread, generation) {
                        return;
                    }
                    let _ = app.emit(
                        "scratchpad://error",
                        ScratchpadWatcherErrorEvent {
                            work_path: work_for_thread.clone(),
                            message,
                            generation,
                        },
                    );
                    let _ = epoch_for_thread.compare_exchange(
                        generation,
                        generation.saturating_add(1),
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                    return;
                }
            };
            let deadline = Instant::now() + Duration::from_millis(150);
            let mut paths = first.paths;
            while Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(WatchMessage::Event(event)) => paths.extend(event.paths),
                    Ok(WatchMessage::Error(message)) => {
                        if !generation_is_current(&epoch_for_thread, generation) {
                            return;
                        }
                        let _ = app.emit(
                            "scratchpad://error",
                            ScratchpadWatcherErrorEvent {
                                work_path: work_for_thread.clone(),
                                message,
                                generation,
                            },
                        );
                        let _ = epoch_for_thread.compare_exchange(
                            generation,
                            generation.saturating_add(1),
                            Ordering::SeqCst,
                            Ordering::SeqCst,
                        );
                        return;
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let mut relative_paths: Vec<String> = paths
                .into_iter()
                .filter(|path| relevant_path(path, &root_for_thread))
                .filter_map(|path| {
                    path.strip_prefix(&root_for_thread)
                        .ok()
                        .map(|relative| relative.to_string_lossy().replace('\\', "/"))
                })
                .collect();
            relative_paths.sort();
            relative_paths.dedup();
            if relative_paths.is_empty() {
                continue;
            }
            if !generation_is_current(&epoch_for_thread, generation) {
                return;
            }
            if app
                .emit(
                    "scratchpad://changed",
                    ScratchpadChangedEvent {
                        work_path: work_for_thread.clone(),
                        paths: relative_paths,
                        generation,
                    },
                )
                .is_err()
            {
                let _ = epoch_for_thread.compare_exchange(
                    generation,
                    generation.saturating_add(1),
                    Ordering::SeqCst,
                    Ordering::SeqCst,
                );
                return;
            }
        }
    });

    let mut guard = state
        .control
        .lock()
        .map_err(|err| format!("Scratchpad watcher state lock poisoned: {err}"))?;
    if !generation_is_current(&state.epoch, generation) {
        return Err("scratchpad_watcher_superseded: a newer start or stop won".to_string());
    }
    guard.active = Some(ActiveWatcher {
        generation,
        work_path: work_owner,
        _watcher: watcher,
    });
    Ok(generation)
}

#[tauri::command]
pub fn stop_scratchpad_watcher(state: State<'_, ScratchpadWatcherState>) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    let mut guard = state
        .control
        .lock()
        .map_err(|err| format!("Scratchpad watcher state lock poisoned: {err}"))?;
    guard.active = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn watcher_accepts_collection_paths_and_ignores_atomic_temps() {
        let root = Path::new("/work/scratchpad");
        assert!(relevant_path(
            Path::new("/work/scratchpad/ideation/seeds/a.md"),
            root
        ));
        assert!(relevant_path(
            Path::new("/work/scratchpad/temp/codex/a.bin"),
            root
        ));
        assert!(!relevant_path(
            Path::new("/work/scratchpad/memos/.a.md.maru-tmp-123"),
            root
        ));
        assert!(!relevant_path(root, root));
    }

    #[test]
    fn newer_generation_invalidates_late_start_and_old_events() {
        let epoch = AtomicU64::new(1);
        assert!(generation_is_current(&epoch, 1));
        let newer = epoch.fetch_add(1, Ordering::SeqCst) + 1;
        assert_eq!(newer, 2);
        assert!(!generation_is_current(&epoch, 1));
        assert!(generation_is_current(&epoch, 2));
    }
}
