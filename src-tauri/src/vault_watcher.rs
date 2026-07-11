use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

#[derive(Default)]
pub struct VaultWatcherState(pub Mutex<Option<RecommendedWatcher>>);

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
    if rel.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules" | "target" | "dist" | "build")
        )
    }) {
        return false;
    }
    if rel.starts_with(".maru/cache") || rel.starts_with(".maru/versions") {
        return false;
    }
    if rel == Path::new(".maruignore") {
        return true;
    }
    matches!(
        path.extension().and_then(|extension| extension.to_str()),
        Some("md" | "markdown" | "html" | "htm")
    )
}

#[tauri::command]
pub fn start_vault_watcher(
    app: AppHandle,
    state: State<'_, VaultWatcherState>,
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

#[tauri::command]
pub fn stop_vault_watcher(state: State<'_, VaultWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("vault watcher state lock poisoned: {err}"))?;
    *guard = None;
    Ok(())
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
            Path::new("/work/.maru/cache/workspace-index-v3.json"),
            root
        ));
        assert!(!relevant_path(
            Path::new("/work/node_modules/readme.md"),
            root
        ));
    }
}
