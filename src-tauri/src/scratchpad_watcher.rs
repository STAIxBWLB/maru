use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
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

#[derive(Clone)]
pub struct ScratchpadWatcherState {
    control: Arc<Mutex<WatcherControl>>,
    epoch: Arc<AtomicU64>,
}

impl Default for ScratchpadWatcherState {
    fn default() -> Self {
        Self {
            control: Arc::new(Mutex::new(WatcherControl::default())),
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

pub fn start_scratchpad_watcher<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: &ScratchpadWatcherState,
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

    let request = PathTransactionRequest::new(vec![root])?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        start_scratchpad_watcher_in_transaction(
            lease, app, state, work_path, work_owner, generation,
        )
    })
}

pub(crate) fn start_scratchpad_watcher_in_transaction<R: tauri::Runtime>(
    lease: &PathTransactionLease,
    app: AppHandle<R>,
    state: &ScratchpadWatcherState,
    work_path: String,
    work_owner: PathBuf,
    generation: u64,
) -> Result<u64, String> {
    let work = PathBuf::from(&work_path);
    let root = resolve_scratchpad_root(&work)?;
    lease.ensure_covered([root.clone()])?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_scratchpad_workspace_access(&work)?;
    validate_scratchpad_layout(&work)?;
    let root = resolve_scratchpad_root(&work)?;
    lease.ensure_covered([root.clone()])?;

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
                // PERF-04 prune runs on the root-relative path (WR-01): a
                // scratchpad root itself named like a generated dir must not
                // prune 100% of its own events.
                .filter(|path| {
                    path.strip_prefix(&root_for_thread)
                        .map(|rel| !crate::paths::is_under_generated_dir(rel))
                        .unwrap_or(false)
                })
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

pub fn stop_scratchpad_watcher(state: &ScratchpadWatcherState) -> Result<(), String> {
    state.epoch.fetch_add(1, Ordering::SeqCst);
    let mut guard = state
        .control
        .lock()
        .map_err(|err| format!("Scratchpad watcher state lock poisoned: {err}"))?;
    guard.active = None;
    Ok(())
}

#[cfg(test)]
mod phase08_19_stage {
    use super::ScratchpadWatcherState;
    use std::sync::{Arc, Mutex};

    pub(super) static STAGES: Mutex<Vec<(u64, usize, String, Arc<dyn Fn() + Send + Sync>)>> =
        Mutex::new(Vec::new());

    fn state_key(state: &ScratchpadWatcherState) -> usize {
        Arc::as_ptr(&state.control) as usize
    }

    pub(super) fn register(
        id: u64,
        command: &str,
        state: &ScratchpadWatcherState,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) {
        STAGES
            .lock()
            .unwrap()
            .push((id, state_key(state), command.to_string(), callback));
    }

    pub(super) fn hit(command: &str, state: &ScratchpadWatcherState) {
        let key = state_key(state);
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
    pub async fn start_scratchpad_watcher<R: tauri::Runtime>(
        app: AppHandle<R>,
        state: State<'_, ScratchpadWatcherState>,
        work_path: String,
    ) -> Result<u64, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("start_scratchpad_watcher", &state);
            super::start_scratchpad_watcher(app, &state, work_path)
        })
        .await
        .map_err(|err| format!("start_scratchpad_watcher_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn stop_scratchpad_watcher(
        state: State<'_, ScratchpadWatcherState>,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("stop_scratchpad_watcher", &state);
            super::stop_scratchpad_watcher(&state)
        })
        .await
        .map_err(|err| format!("stop_scratchpad_watcher_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_19 {
    use super::phase08_19_stage::STAGES;
    use super::*;
    use crate::atomic_file::phase08_06::{run, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::{ScratchpadCollection, ScratchpadFormat};
    use std::future::Future;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tauri::Manager;

    type TestApp = tauri::AppHandle<tauri::test::MockRuntime>;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(ScratchpadWatcherState::default());
        app
    }

    fn work_path_of(dir: &tempfile::TempDir) -> String {
        dir.path().to_path_buf().to_string_lossy().into_owned()
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
        super::phase08_19_stage::register(
            id,
            command,
            app.state::<ScratchpadWatcherState>().inner(),
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

    async fn start_watcher(app: TestApp, work_path: String) -> Result<u64, String> {
        ipc::start_scratchpad_watcher(app.clone(), app.state(), work_path).await
    }

    async fn stop_watcher(app: TestApp) -> Result<(), String> {
        ipc::stop_scratchpad_watcher(app.state()).await
    }

    #[test]
    fn phase08_19_scratchpad_each_wrapper_yields_same_poll_and_maps_join_failure() {
        for command in ["start_scratchpad_watcher", "stop_scratchpad_watcher"] {
            let app = mock_app();
            let app = app.handle().clone();
            match command {
                "start_scratchpad_watcher" => {
                    let app_for_call = app.clone();
                    boundary(command, &app, async move {
                        start_watcher(app_for_call, "/phase08-19-missing-work-path".to_string())
                            .await
                    });
                }
                _ => {
                    let app_for_call = app.clone();
                    boundary(
                        command,
                        &app,
                        async move { stop_watcher(app_for_call).await },
                    );
                }
            }
        }
    }

    #[test]
    fn phase08_19_scratchpad_real_fixture_results_and_legacy_rejections() {
        let _home = Home::new();
        let app = mock_app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let work_path = work_path_of(&work);

        let first = run(start_watcher(app.clone(), work_path.clone())).unwrap();
        assert!(first > 0, "watcher start must return a real generation");
        assert!(
            crate::scratchpad::resolve_scratchpad_root(work.path())
                .unwrap()
                .is_dir(),
            "start must create the configured Scratchpad root"
        );
        let again = run(start_watcher(app.clone(), work_path.clone())).unwrap();
        assert_eq!(
            again, first,
            "a second start for the same work path is idempotent"
        );
        run(stop_watcher(app.clone())).unwrap();
        let after_stop = run(start_watcher(app.clone(), work_path.clone())).unwrap();
        assert!(
            after_stop > first,
            "stop invalidates the old generation; the next start claims a new one"
        );
        run(stop_watcher(app.clone())).unwrap();

        let err = run(start_watcher(
            app.clone(),
            "/phase08-19-scratchpad-missing-work".to_string(),
        ))
        .unwrap_err();
        assert!(
            err.contains("Cannot resolve Scratchpad watcher workPath"),
            "legacy rejection string unchanged, got: {err}"
        );
        let relative = run(start_watcher(app, "relative/work".to_string())).unwrap_err();
        assert!(
            relative.contains("workPath must be absolute"),
            "relative workPath keeps the typed rejection, got: {relative}"
        );
    }

    fn save_memo(work_path: String, name: &str, content: &str, revision: Option<String>) {
        crate::scratchpad::scratchpad_save(
            work_path,
            ScratchpadCollection::Memos,
            name.to_string(),
            ScratchpadFormat::Markdown,
            content.to_string(),
            revision,
            false,
        )
        .unwrap();
    }

    #[test]
    fn phase08_19_scratchpad_start_serializes_with_scratchpad_save_both_orders() {
        let _home = Home::new();
        let root_for = |work: &tempfile::TempDir| {
            crate::scratchpad::resolve_scratchpad_root(work.path()).unwrap()
        };

        // Watcher first: the held lease must block the domain save on admission.
        let app = mock_app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let work_path = work_path_of(&work);
        let root = root_for(&work);
        let (hit_tx, hit_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let fired = Arc::new(AtomicBool::new(false));
        let hook = PathTransactionTestHook::new(root.clone(), "pre-effect", move || {
            if fired.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = hit_tx.send(());
            release_rx.lock().unwrap().recv().unwrap();
        });
        let watcher_app = app.clone();
        let watcher_work = work_path.clone();
        let (watcher_tx, watcher_rx) = mpsc::channel();
        let watcher = std::thread::spawn(move || {
            let _ = watcher_tx.send(run(start_watcher(watcher_app, watcher_work)));
        });
        hit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (save_tx, save_rx) = mpsc::channel();
        let save_work = work_path.clone();
        let saver = std::thread::spawn(move || {
            let _ = save_tx.send(crate::scratchpad::scratchpad_save(
                save_work,
                ScratchpadCollection::Memos,
                "note.md".to_string(),
                ScratchpadFormat::Markdown,
                "watcher-first".to_string(),
                None,
                false,
            ));
        });
        assert!(
            save_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "save must wait for the watcher lease while setup holds admission"
        );
        release_tx.send(()).unwrap();
        let generation = watcher_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(generation > 0);
        let saved = save_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(saved.content, "watcher-first");
        saver.join().unwrap();
        watcher.join().unwrap();
        run(stop_watcher(app)).unwrap();
        drop(hook);
        drop(work);

        // Save first: the held save lease must block watcher admission.
        let app = mock_app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let work_path = work_path_of(&work);
        let root = root_for(&work);
        let entry = root.join("memos").join("note.md");
        let (hit_tx, hit_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let fired = Arc::new(AtomicBool::new(false));
        let hook = PathTransactionTestHook::new(root.clone(), "pre-effect", move || {
            if fired.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = hit_tx.send(());
            release_rx.lock().unwrap().recv().unwrap();
        });
        let (save_tx, save_rx) = mpsc::channel();
        let save_work = work_path.clone();
        let saver = std::thread::spawn(move || {
            let _ = save_tx.send(crate::scratchpad::scratchpad_save(
                save_work,
                ScratchpadCollection::Memos,
                "note.md".to_string(),
                ScratchpadFormat::Markdown,
                "save-first".to_string(),
                None,
                false,
            ));
        });
        hit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let watcher_app = app.clone();
        let watcher_work = work_path.clone();
        let (watcher_tx, watcher_rx) = mpsc::channel();
        let watcher = std::thread::spawn(move || {
            let _ = watcher_tx.send(run(start_watcher(watcher_app, watcher_work)));
        });
        assert!(
            watcher_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "watcher start must wait for the save lease"
        );
        release_tx.send(()).unwrap();
        let saved = save_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert_eq!(saved.content, "save-first");
        assert!(entry.is_file());
        let generation = watcher_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(generation > 0);
        saver.join().unwrap();
        watcher.join().unwrap();
        run(stop_watcher(app)).unwrap();
        drop(hook);
    }

    #[test]
    fn phase08_19_scratchpad_save_conflict_releases_admission_for_watcher_start() {
        let _home = Home::new();
        let app = mock_app();
        let app = app.handle().clone();
        let work = tempfile::tempdir().unwrap();
        let work_path = work_path_of(&work);
        let root = crate::scratchpad::resolve_scratchpad_root(work.path()).unwrap();
        save_memo(work_path.clone(), "note.md", "original", None);

        let (hit_tx, hit_rx) = mpsc::channel::<()>();
        let (release_tx, release_rx) = mpsc::channel::<()>();
        let release_rx = Arc::new(Mutex::new(release_rx));
        let fired = Arc::new(AtomicBool::new(false));
        let hook = PathTransactionTestHook::new(root, "pre-effect", move || {
            if fired.swap(true, Ordering::SeqCst) {
                return;
            }
            let _ = hit_tx.send(());
            release_rx.lock().unwrap().recv().unwrap();
        });
        let (save_tx, save_rx) = mpsc::channel();
        let save_work = work_path.clone();
        let saver = std::thread::spawn(move || {
            let _ = save_tx.send(crate::scratchpad::scratchpad_save(
                save_work,
                ScratchpadCollection::Memos,
                "note.md".to_string(),
                ScratchpadFormat::Markdown,
                "overwritten".to_string(),
                Some("stale-revision".to_string()),
                false,
            ));
        });
        hit_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let watcher_app = app.clone();
        let (watcher_tx, watcher_rx) = mpsc::channel();
        let watcher = std::thread::spawn(move || {
            let _ = watcher_tx.send(run(start_watcher(watcher_app, work_path)));
        });
        assert!(
            watcher_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "watcher start must wait while the conflicting save holds admission"
        );
        release_tx.send(()).unwrap();
        let err = save_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap_err();
        assert!(
            err.contains("scratchpad_conflict"),
            "legacy conflict string unchanged, got: {err}"
        );
        let generation = watcher_rx
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .unwrap();
        assert!(
            generation > 0,
            "the released conflict lease must let the watcher start proceed"
        );
        saver.join().unwrap();
        watcher.join().unwrap();
        run(stop_watcher(app)).unwrap();
        drop(hook);
        assert_eq!(
            std::fs::read_to_string(work.path().join("scratchpad/memos/note.md")).unwrap(),
            "original",
            "the conflicting save must not land a partial write"
        );
    }

    #[test]
    fn phase08_19_scratchpad_stop_before_start_is_accepted() {
        let _home = Home::new();
        let app = mock_app();
        let app = app.handle().clone();
        run(stop_watcher(app)).unwrap();
    }
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
    fn drain_filter_drops_generated_dir_paths_but_keeps_siblings() {
        // Mirrors the drain-thread chain: generated-dir prune (on the
        // root-relative path, WR-01) ahead of relevant_path — a generated
        // path in the batch must not drop its legitimate siblings (per-path
        // D-04 semantics, Pitfall 7).
        let root = Path::new("/work/scratchpad");
        let batch = vec![
            PathBuf::from("/work/scratchpad/node_modules/pkg/index.js"),
            PathBuf::from("/work/scratchpad/ideation/seeds/a.md"),
        ];
        let kept: Vec<String> = batch
            .iter()
            .filter(|path| {
                path.strip_prefix(root)
                    .map(|rel| !crate::paths::is_under_generated_dir(rel))
                    .unwrap_or(false)
            })
            .filter(|path| relevant_path(path, root))
            .filter_map(|path| {
                path.strip_prefix(root)
                    .ok()
                    .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        assert_eq!(kept, vec!["ideation/seeds/a.md"]);
    }

    #[test]
    fn drain_filter_still_dispatches_when_root_name_is_generated_dir() {
        // WR-01: a scratchpad root literally named `dist` must keep
        // dispatching while a nested generated dir stays pruned.
        let root = Path::new("/work/dist");
        let batch = vec![
            PathBuf::from("/work/dist/dist/out.js"),
            PathBuf::from("/work/dist/node_modules/pkg/index.js"),
            PathBuf::from("/work/dist/ideation/seeds/a.md"),
        ];
        let kept: Vec<String> = batch
            .iter()
            .filter(|path| {
                path.strip_prefix(root)
                    .map(|rel| !crate::paths::is_under_generated_dir(rel))
                    .unwrap_or(false)
            })
            .filter(|path| relevant_path(path, root))
            .filter_map(|path| {
                path.strip_prefix(root)
                    .ok()
                    .map(|relative| relative.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        assert_eq!(kept, vec!["ideation/seeds/a.md"]);
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
