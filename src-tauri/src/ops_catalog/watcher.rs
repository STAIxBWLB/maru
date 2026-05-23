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

#[derive(Default)]
pub struct CatalogWatcherState(pub Mutex<Option<RecommendedWatcher>>);

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRefreshEvent {
    pub workspace_root: String,
    pub trigger_path: String,
    pub kind: String,
}

#[tauri::command]
pub fn catalog_watcher_start(
    app: AppHandle,
    state: State<'_, CatalogWatcherState>,
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
        if !is_catalog_relevant(&path, &root_clone) {
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

#[tauri::command]
pub fn catalog_watcher_stop(state: State<'_, CatalogWatcherState>) -> Result<bool, String> {
    let mut guard = state.0.lock().map_err(|_| "state poisoned".to_string())?;
    let had_watcher = guard.is_some();
    *guard = None;
    Ok(had_watcher)
}

fn emit_refresh(app: &AppHandle, root: &Path, path: &Path, kind: &str) {
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

fn is_catalog_relevant(path: &Path, root: &Path) -> bool {
    let rel = match path.strip_prefix(root) {
        Ok(r) => r.to_string_lossy().to_string(),
        Err(_) => return false,
    };

    // OS 잡파일 무시
    if path
        .file_name()
        .map_or(false, |n| n.to_string_lossy().starts_with('.'))
    {
        // `.evidence.yaml` 사이드카는 catalog 상태 변경 신호 — 허용
        if !path
            .file_name()
            .map_or(false, |n| n.to_string_lossy().contains(".evidence.yaml"))
        {
            return false;
        }
    }

    // 캐시/런타임 surface 제외
    if rel.starts_with(".anchor/cache/")
        || rel.starts_with(".anchor/runs/")
        || rel.starts_with(".anchor/queue/")
        || rel.starts_with(".anchor/studio/")
    {
        return false;
    }

    // catalog-relevant 디렉토리만
    rel.starts_with("inbox/items/")
        || rel.starts_with("tasks/")
        || rel.contains("/02-admin-approvals/")
        || rel.contains("/03-evidence-cert/")
        || rel.contains("/.anchor/bu-config.yaml")
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
        let p = root.join(".anchor/cache/catalog.json");
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
    fn watch_paths_lists_core_surfaces() {
        let root = PathBuf::from("/ws");
        let paths = catalog_watch_paths(&root);
        assert!(paths.iter().any(|p| p.ends_with("inbox/items/pending")));
        assert!(paths.iter().any(|p| p.ends_with("tasks/active")));
        assert!(paths.iter().any(|p| p.ends_with("tasks/calendar")));
    }
}
