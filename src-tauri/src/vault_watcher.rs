use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::vault::is_document_extension;

#[derive(Default, Clone)]
pub struct VaultWatcherState(pub Arc<Mutex<Option<RecommendedWatcher>>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultIndexDeltaEvent {
    pub workspace_path: String,
    pub paths: Vec<String>,
}

fn relevant_path(path: &Path, root: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(root) else {
        return false;
    };
    // PERF-04 prune runs on the root-relative path (WR-01): a vault
    // directory itself named like a generated dir (dist, build, ...) must
    // not prune 100% of its own events.
    if crate::paths::is_under_generated_dir(rel) {
        return false;
    }
    if rel.starts_with(".maru/cache") || rel.starts_with(".maru/versions") {
        return false;
    }
    if rel == Path::new(".maruignore") {
        return true;
    }
    path.extension()
        .and_then(|extension| extension.to_str())
        .map(is_document_extension)
        .unwrap_or(false)
}

pub fn start_vault_watcher<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: &VaultWatcherState,
    workspace_path: String,
) -> Result<(), String> {
    let root = PathBuf::from(&workspace_path)
        .canonicalize()
        .map_err(|err| format!("Cannot watch workspace: {err}"))?;
    if !root.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {workspace_path}"
        ));
    }
    let (tx, rx) = mpsc::channel::<Event>();
    let mut watcher = recommended_watcher(move |result: Result<Event, notify::Error>| {
        if let Ok(event) = result {
            if matches!(
                event.kind,
                EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_)
            ) {
                let _ = tx.send(event);
            }
        }
    })
    .map_err(|err| format!("vault watcher creation failed: {err}"))?;
    watcher
        .watch(&root, RecursiveMode::Recursive)
        .map_err(|err| format!("vault watcher start failed: {err}"))?;

    let root_for_thread = root.clone();
    let workspace_for_thread = workspace_path.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let deadline = Instant::now() + Duration::from_millis(120);
            let mut paths = first.paths;
            while Instant::now() < deadline {
                let remaining = deadline.saturating_duration_since(Instant::now());
                match rx.recv_timeout(remaining) {
                    Ok(event) => paths.extend(event.paths),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
            }
            let mut rel_paths: Vec<String> = paths
                .into_iter()
                .filter(|path| relevant_path(path, &root_for_thread))
                .filter_map(|path| {
                    path.strip_prefix(&root_for_thread)
                        .ok()
                        .map(|rel| rel.to_string_lossy().replace('\\', "/"))
                })
                .collect();
            rel_paths.sort();
            rel_paths.dedup();
            if rel_paths.is_empty() {
                continue;
            }
            let _ = app.emit(
                "vault://index-delta",
                VaultIndexDeltaEvent {
                    workspace_path: workspace_for_thread.clone(),
                    paths: rel_paths,
                },
            );
        }
    });

    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("vault watcher state lock poisoned: {err}"))?;
    *guard = Some(watcher);
    Ok(())
}

pub fn stop_vault_watcher(state: &VaultWatcherState) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("vault watcher state lock poisoned: {err}"))?;
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod phase08_19_stage {
    use super::VaultWatcherState;
    use std::sync::{Arc, Mutex};

    pub(super) static STAGES: Mutex<Vec<(u64, usize, String, Arc<dyn Fn() + Send + Sync>)>> =
        Mutex::new(Vec::new());

    fn state_key(state: &VaultWatcherState) -> usize {
        Arc::as_ptr(&state.0) as usize
    }

    pub(super) fn register(
        id: u64,
        command: &str,
        state: &VaultWatcherState,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) {
        STAGES
            .lock()
            .unwrap()
            .push((id, state_key(state), command.to_string(), callback));
    }

    pub(super) fn hit(command: &str, state: &VaultWatcherState) {
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
    pub async fn start_vault_watcher<R: tauri::Runtime>(
        app: AppHandle<R>,
        state: State<'_, VaultWatcherState>,
        workspace_path: String,
    ) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("start_vault_watcher", &state);
            super::start_vault_watcher(app, &state, workspace_path)
        })
        .await
        .map_err(|err| format!("start_vault_watcher_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn stop_vault_watcher(state: State<'_, VaultWatcherState>) -> Result<(), String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("stop_vault_watcher", &state);
            super::stop_vault_watcher(&state)
        })
        .await
        .map_err(|err| format!("stop_vault_watcher_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_19 {
    use super::phase08_19_stage::STAGES;
    use super::*;
    use crate::atomic_file::phase08_06::run;
    use std::future::Future;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{mpsc, Arc, Mutex};
    use std::time::Duration;
    use tauri::Manager;

    type TestApp = tauri::AppHandle<tauri::test::MockRuntime>;

    fn mock_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(VaultWatcherState::default());
        app
    }

    fn workspace_with_document() -> (tempfile::TempDir, String) {
        let work = tempfile::tempdir().unwrap();
        std::fs::write(work.path().join("note.md"), "# fixture\n").unwrap();
        let path = work.path().to_path_buf().to_string_lossy().into_owned();
        (work, path)
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
            app.state::<VaultWatcherState>().inner(),
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

    async fn start_watcher(app: TestApp, workspace_path: String) -> Result<(), String> {
        ipc::start_vault_watcher(app.clone(), app.state(), workspace_path).await
    }

    async fn stop_watcher(app: TestApp) -> Result<(), String> {
        ipc::stop_vault_watcher(app.state()).await
    }

    #[test]
    fn phase08_19_vault_each_wrapper_yields_same_poll_and_maps_join_failure() {
        for command in ["start_vault_watcher", "stop_vault_watcher"] {
            let app = mock_app();
            let app = app.handle().clone();
            let app_for_call = app.clone();
            let future = async move {
                if command == "start_vault_watcher" {
                    start_watcher(app_for_call, "/phase08-19-missing-workspace".to_string())
                        .await
                        .map(|_| String::new())
                } else {
                    stop_watcher(app_for_call).await.map(|_| String::new())
                }
            };
            boundary(command, &app, future);
        }
    }

    #[test]
    fn phase08_19_vault_real_fixture_results_and_legacy_rejections() {
        let app = mock_app();
        let app = app.handle().clone();
        let (_work, workspace_path) = workspace_with_document();

        run(start_watcher(app.clone(), workspace_path.clone())).unwrap();
        run(start_watcher(app.clone(), workspace_path.clone())).unwrap();
        run(stop_watcher(app.clone())).unwrap();

        let file = tempfile::NamedTempFile::new().unwrap();
        let err = run(start_watcher(
            app.clone(),
            file.path().to_path_buf().to_string_lossy().into_owned(),
        ))
        .unwrap_err();
        assert!(
            err.contains("Workspace path is not a directory"),
            "typed rejection unchanged, got: {err}"
        );
        let err = run(start_watcher(
            app,
            "/phase08-19-missing-workspace".to_string(),
        ))
        .unwrap_err();
        assert!(
            err.contains("Cannot watch workspace"),
            "missing workspace keeps the legacy rejection, got: {err}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ignores_cache_and_accepts_markdown() {
        let root = Path::new("/work");
        assert!(relevant_path(Path::new("/work/notes/a.md"), root));
        assert!(relevant_path(Path::new("/work/.maruignore"), root));
        assert!(!relevant_path(
            Path::new("/work/.maru/cache/workspace-index-v4.json"),
            root
        ));
        assert!(!relevant_path(
            Path::new("/work/node_modules/readme.md"),
            root
        ));
    }

    #[test]
    fn accepts_uppercase_document_extensions() {
        let root = Path::new("/work");
        assert!(relevant_path(Path::new("/work/notes/a.HTML"), root));
        assert!(relevant_path(Path::new("/work/notes/a.MD"), root));
        assert!(!relevant_path(Path::new("/work/notes/a.txt"), root));
    }

    #[test]
    fn rejects_generated_dir_paths_via_shared_predicate() {
        let root = Path::new("/work");
        assert!(!relevant_path(
            Path::new("/work/node_modules/pkg/index.js"),
            root
        ));
        assert!(!relevant_path(
            Path::new("/work/api/.venv/lib/site.py"),
            root
        ));
    }

    #[test]
    fn accepts_prefix_sibling_of_generated_dir_name() {
        let root = Path::new("/work");
        assert!(relevant_path(
            Path::new("/work/node_modules_backup/notes.md"),
            root
        ));
    }

    #[test]
    fn root_named_generated_dir_still_dispatches() {
        // WR-01: the prune runs on the root-relative path, so a vault
        // directory literally named `dist` keeps dispatching its events
        // while a nested generated dir is still pruned.
        let root = Path::new("/work/dist");
        assert!(relevant_path(Path::new("/work/dist/notes/a.md"), root));
        assert!(relevant_path(Path::new("/work/dist/.maruignore"), root));
        assert!(!relevant_path(Path::new("/work/dist/dist/a.md"), root));
        assert!(!relevant_path(
            Path::new("/work/dist/node_modules/pkg/index.js"),
            root
        ));
    }

    #[test]
    fn mixed_batch_keeps_only_legitimate_paths() {
        // Mirrors the drain-thread filter chain: per-path filter, then
        // strip_prefix — a generated-dir path in the batch must not drop its
        // legitimate siblings (D-04 per-path semantics, Pitfall 7).
        let root = Path::new("/work");
        let batch = vec![
            PathBuf::from("/work/node_modules/pkg/index.js"),
            PathBuf::from("/work/notes/a.md"),
            PathBuf::from("/work/notes/b.md"),
        ];
        let kept: Vec<String> = batch
            .iter()
            .filter(|path| relevant_path(path, root))
            .filter_map(|path| {
                path.strip_prefix(root)
                    .ok()
                    .map(|rel| rel.to_string_lossy().replace('\\', "/"))
            })
            .collect();
        assert_eq!(kept, vec!["notes/a.md", "notes/b.md"]);
    }
}
