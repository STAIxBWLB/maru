// Operations Catalog filesystem watcher (Phase 3 W4).
//
// Watches surfaces that mutate Catalog entries:
//   - inbox/items/{pending,done,failed,duplicate}/
//   - tasks/{active,calendar}/
//   - projects/**/02-admin-approvals/
//   - admin/**/02-admin-approvals/
//   - projects/**/03-evidence-cert/
//
// Debounces bursts (default 500ms) and emits `catalog://refresh` with the
// triggering path. The React side treats it as a hint to call
// `catalog_scan` again. Replacing an active watcher transparently stops
// the previous one — the handle is dropped.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use walkdir::WalkDir;

const DEBOUNCE_MS: u64 = 500;

#[derive(Default, Clone)]
pub struct CatalogWatcherState(pub Arc<Mutex<Option<RecommendedWatcher>>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRefreshEvent {
    pub workspace_root: String,
    pub trigger_path: String,
    pub kind: String,
}

pub fn catalog_watcher_start<R: tauri::Runtime>(
    app: AppHandle<R>,
    state: &CatalogWatcherState,
    workspace_root: String,
) -> Result<bool, String> {
    let root = PathBuf::from(&workspace_root);
    if !root.exists() {
        return Err(format!("workspace_root not found: {}", root.display()));
    }

    // 디바운스 상태 (마지막 트리거 시각 + pending event).
    let last_emit = Arc::new(Mutex::new(Instant::now() - Duration::from_secs(60)));
    let pending_path = Arc::new(Mutex::new(None::<(PathBuf, String)>));

    let app_clone = app.clone();
    let root_clone = root.clone();
    let last_emit_handler = last_emit.clone();
    let pending_handler = pending_path.clone();

    let mut watcher: RecommendedWatcher = recommended_watcher(move |res: notify::Result<Event>| {
        let Ok(event) = res else { return };
        let kind = match event.kind {
            EventKind::Create(_) => "added",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "removed",
            _ => return,
        };
        let Some(path) = event.paths.into_iter().next() else {
            return;
        };
        if !should_dispatch_catalog_event(&path, &root_clone) {
            return;
        }
        // Debounce: 마지막 emit으로부터 500ms 이내면 펜딩에 적재만 하고 스킵
        let now = Instant::now();
        {
            let mut last = last_emit_handler.lock().expect("last_emit poisoned");
            if now.duration_since(*last) < Duration::from_millis(DEBOUNCE_MS) {
                let mut pending = pending_handler.lock().expect("pending poisoned");
                *pending = Some((path, kind.to_string()));
                return;
            }
            *last = now;
        }
        emit_refresh(&app_clone, &root_clone, &path, kind);
    })
    .map_err(|e| format!("notify create error: {}", e))?;

    // 핵심 surface 등록 — 존재하는 것만
    for sub in catalog_watch_paths(&root) {
        if sub.exists() {
            if let Err(e) = watcher.watch(&sub, RecursiveMode::Recursive) {
                eprintln!("[catalog-watcher] watch failed {}: {}", sub.display(), e);
            }
        }
    }

    // BU별 03-evidence-cert / 02-admin-approvals도 한번 더 등록
    register_bu_watch_paths(&mut watcher, &root);

    // 펜딩 플러시 스레드 — 디바운스 윈도우 만료 후 마지막 이벤트 송출
    let app_flush = app;
    let root_flush = root.clone();
    let pending_flush = pending_path;
    let last_flush = last_emit;
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(DEBOUNCE_MS));
        let item = {
            let mut p = pending_flush.lock().expect("pending poisoned");
            p.take()
        };
        if let Some((path, kind)) = item {
            *last_flush.lock().expect("last poisoned") = Instant::now();
            emit_refresh(&app_flush, &root_flush, &path, &kind);
        }
    });

    *state.0.lock().expect("state poisoned") = Some(watcher);
    Ok(true)
}

pub fn catalog_watcher_stop(state: &CatalogWatcherState) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|_| "state poisoned".to_string())?;
    let had_watcher = guard.is_some();
    *guard = None;
    Ok(had_watcher)
}

#[cfg(test)]
mod phase08_19_stage {
    use super::CatalogWatcherState;
    use std::sync::{Arc, Mutex};

    pub(super) static STAGES: Mutex<Vec<(u64, usize, String, Arc<dyn Fn() + Send + Sync>)>> =
        Mutex::new(Vec::new());

    fn state_key(state: &CatalogWatcherState) -> usize {
        Arc::as_ptr(&state.0) as usize
    }

    pub(super) fn register(
        id: u64,
        command: &str,
        state: &CatalogWatcherState,
        callback: Arc<dyn Fn() + Send + Sync>,
    ) {
        STAGES
            .lock()
            .unwrap()
            .push((id, state_key(state), command.to_string(), callback));
    }

    pub(super) fn hit(command: &str, state: &CatalogWatcherState) {
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
    pub async fn catalog_watcher_start<R: tauri::Runtime>(
        app: AppHandle<R>,
        state: State<'_, CatalogWatcherState>,
        workspace_root: String,
    ) -> Result<bool, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("catalog_watcher_start", &state);
            super::catalog_watcher_start(app, &state, workspace_root)
        })
        .await
        .map_err(|err| format!("catalog_watcher_start_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn catalog_watcher_stop(
        state: State<'_, CatalogWatcherState>,
    ) -> Result<bool, String> {
        let state = state.inner().clone();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            super::phase08_19_stage::hit("catalog_watcher_stop", &state);
            super::catalog_watcher_stop(&state)
        })
        .await
        .map_err(|err| format!("catalog_watcher_stop_task_failed: {err}"))?
    }
}

fn emit_refresh<R: tauri::Runtime>(app: &AppHandle<R>, root: &Path, path: &Path, kind: &str) {
    let payload = CatalogRefreshEvent {
        workspace_root: root.to_string_lossy().to_string(),
        trigger_path: path.to_string_lossy().to_string(),
        kind: kind.to_string(),
    };
    let _ = app.emit("catalog://refresh", payload);
}

fn catalog_watch_paths(root: &Path) -> Vec<PathBuf> {
    vec![
        root.join("inbox").join("items").join("pending"),
        root.join("inbox").join("items").join("done"),
        root.join("tasks").join("active"),
        root.join("tasks").join("calendar"),
    ]
}

/// projects/<bu>/02-admin-approvals/ 및 admin/<bu>/02-admin-approvals/ 등 BU별 핵심 경로
/// notify 6의 recommended_watcher는 부모 경로 변경에도 트리거되므로 surplus가 있지만
/// 명시 등록은 폴더 재생성·이름 변경 안전성을 높인다.
fn register_bu_watch_paths(watcher: &mut RecommendedWatcher, root: &Path) {
    for parent in ["projects", "admin"] {
        let base = root.join(parent);
        if !base.exists() {
            continue;
        }
        for entry in WalkDir::new(&base)
            .min_depth(2)
            .max_depth(3)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_dir() {
                continue;
            }
            let name = entry.file_name().to_string_lossy();
            if matches!(name.as_ref(), "02-admin-approvals" | "03-evidence-cert") {
                let _ = watcher.watch(entry.path(), RecursiveMode::Recursive);
            }
        }
    }
}

/// Dispatch gate: the shared generated-dir prune (PERF-04, D-06) composed with
/// the catalog relevance check — factored into a pure fn so the combination
/// is unit-testable. A heavy generated subtree under a watched BU surface
/// (e.g. a business unit that grows node_modules) must not flood the
/// debounce/emit pipeline.
fn should_dispatch_catalog_event(path: &Path, root: &Path) -> bool {
    !crate::paths::is_under_generated_dir(path) && is_catalog_relevant(path, root)
}

fn is_catalog_relevant(path: &Path, root: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    // OS 잡파일 무시
    if path
        .file_name()
        .is_some_and(|n| n.to_string_lossy().starts_with('.'))
    {
        // `.evidence.yaml` 사이드카는 catalog 상태 변경 신호 — 허용
        if !path
            .file_name()
            .is_some_and(|n| n.to_string_lossy().contains(".evidence.yaml"))
        {
            return false;
        }
    }

    // 캐시/런타임 surface 제외
    if rel.starts_with(".maru/cache/")
        || rel.starts_with(".maru/runs/")
        || rel.starts_with(".maru/queue/")
        || rel.starts_with(".maru/studio/")
    {
        return false;
    }

    // catalog-relevant 디렉토리만
    rel.starts_with("inbox/items/")
        || rel.starts_with("tasks/")
        || rel.contains("/02-admin-approvals/")
        || rel.contains("/03-evidence-cert/")
        || rel.contains("/.maru/bu-config.yaml")
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
        app.manage(CatalogWatcherState::default());
        app
    }

    fn workspace_with_surface() -> (tempfile::TempDir, String) {
        let work = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(work.path().join("inbox/items/pending")).unwrap();
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
            app.state::<CatalogWatcherState>().inner(),
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

    async fn start_watcher(app: TestApp, workspace_root: String) -> Result<bool, String> {
        ipc::catalog_watcher_start(app.clone(), app.state(), workspace_root).await
    }

    async fn stop_watcher(app: TestApp) -> Result<bool, String> {
        ipc::catalog_watcher_stop(app.state()).await
    }

    #[test]
    fn phase08_19_catalog_each_wrapper_yields_same_poll_and_maps_join_failure() {
        for command in ["catalog_watcher_start", "catalog_watcher_stop"] {
            let app = mock_app();
            let app = app.handle().clone();
            let app_for_call = app.clone();
            let future = async move {
                if command == "catalog_watcher_start" {
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
    fn phase08_19_catalog_real_fixture_results_and_legacy_rejections() {
        let app = mock_app();
        let app = app.handle().clone();
        let (_work, workspace_root) = workspace_with_surface();

        assert!(!run(stop_watcher(app.clone())).unwrap());
        assert!(run(start_watcher(app.clone(), workspace_root.clone())).unwrap());
        assert!(run(start_watcher(app.clone(), workspace_root.clone())).unwrap());
        assert!(run(stop_watcher(app.clone())).unwrap());
        assert!(!run(stop_watcher(app.clone())).unwrap());

        let err = run(start_watcher(
            app,
            "/phase08-19-missing-workspace".to_string(),
        ))
        .unwrap_err();
        assert!(
            err.contains("workspace_root not found"),
            "legacy rejection string unchanged, got: {err}"
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relevant_includes_inbox_pending() {
        let root = PathBuf::from("/ws");
        let p = root.join("inbox/items/pending/foo/manifest.yaml");
        assert!(is_catalog_relevant(&p, &root));
    }

    #[test]
    fn relevant_includes_admin_approvals() {
        let root = PathBuf::from("/ws");
        let p = root.join("projects/a/02-admin-approvals/2026/doc.md");
        assert!(is_catalog_relevant(&p, &root));
    }

    #[test]
    fn relevant_includes_evidence_cert() {
        let root = PathBuf::from("/ws");
        let p = root.join("projects/a/03-evidence-cert/2026/receipts/foo.pdf");
        assert!(is_catalog_relevant(&p, &root));
    }

    #[test]
    fn relevant_skips_cache() {
        let root = PathBuf::from("/ws");
        let p = root.join(".maru/cache/catalog.json");
        assert!(!is_catalog_relevant(&p, &root));
    }

    #[test]
    fn relevant_skips_dotfiles_but_allows_evidence_sidecar() {
        let root = PathBuf::from("/ws");
        let p = root.join("projects/a/03-evidence-cert/receipts/.DS_Store");
        assert!(!is_catalog_relevant(&p, &root));
        let sidecar = root.join("projects/a/03-evidence-cert/receipts/foo.pdf.evidence.yaml");
        assert!(is_catalog_relevant(&sidecar, &root));
    }

    #[test]
    fn generated_dir_path_under_catalog_surface_is_not_dispatch_relevant() {
        let root = PathBuf::from("/ws");
        // A generated subtree under a watched BU surface would pass
        // is_catalog_relevant on its own — the dispatch gate must prune it.
        let path = root.join("projects/a/03-evidence-cert/node_modules/pkg/receipt.pdf");
        assert!(is_catalog_relevant(&path, &root));
        assert!(!should_dispatch_catalog_event(&path, &root));
    }

    #[test]
    fn watch_paths_lists_core_surfaces() {
        let root = PathBuf::from("/ws");
        let paths = catalog_watch_paths(&root);
        assert!(paths.iter().any(|p| p.ends_with("inbox/items/pending")));
        assert!(paths.iter().any(|p| p.ends_with("tasks/active")));
        assert!(paths.iter().any(|p| p.ends_with("tasks/calendar")));
    }
}
