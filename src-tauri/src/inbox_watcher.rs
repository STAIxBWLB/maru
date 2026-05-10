// Phase 2 step 2: filesystem watcher layered on top of the polling
// `scan_inbox_drop` baseline. `notify` watches configured inbox drop/pending paths
// recursively; relevant create/modify/remove events are forwarded to the
// frontend via Tauri's event channel as `inbox://file_event` payloads.
//
// Lifecycle: the frontend calls `start_inbox_watcher(vault_path)` on
// vault activation and `stop_inbox_watcher()` on switch/quit. Replacing
// an active watcher transparently stops the previous one — the watcher
// handle is dropped, which `notify` interprets as unsubscribe.

use std::path::PathBuf;
use std::sync::Mutex;

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::inbox_settings;

#[derive(Default)]
pub struct InboxWatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Payload emitted to the webview as `inbox://file_event`. `kind` is one of
/// `added` / `modified` / `removed`. Frontend treats any `added`/`modified`
/// event as a hint to re-run `scan_inbox_drop` (cheap, ~ms). `removed` is
/// surfaced so the inbox view can drop the row without a re-scan.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFileEvent {
    pub vault_path: String,
    pub abs_path: String,
    /// Path relative to the vault root (matches `InboxDropItem.relPath`).
    pub rel_path: String,
    /// First component under `inbox/downloads/` — kakao / telegram / gmail / sharepoint / etc.
    pub source: String,
    pub kind: String,
}

#[tauri::command]
pub fn start_inbox_watcher(
    app: AppHandle,
    state: State<'_, InboxWatcherState>,
    vault_path: String,
) -> Result<(), String> {
    let vault = PathBuf::from(&vault_path);
    if !vault.is_dir() {
        return Err(format!("Vault path is not a directory: {vault_path}"));
    }
    let config = inbox_settings::load_runtime_config_or_legacy(&vault)?;
    let inbox_root = inbox_settings::resolve_runtime_root(&vault, &config)?;
    let mut watch_roots = Vec::new();
    for channel in config.channels.values() {
        for drop_path in &channel.drop_paths {
            let path = inbox_settings::lexical_normalize_path(&inbox_root.join(drop_path));
            if path.is_dir() && !watch_roots.contains(&path) {
                watch_roots.push(path);
            }
        }
    }
    let pending = inbox_settings::lexical_normalize_path(&inbox_root.join(&config.paths.pending));
    if pending.is_dir() && !watch_roots.contains(&pending) {
        watch_roots.push(pending);
    }
    if watch_roots.is_empty() {
        return Err("No configured inbox drop or pending directories exist yet.".to_string());
    }

    let roots_for_handler = watch_roots.clone();
    let vault_for_handler = vault.clone();
    let vault_string = vault_path.clone();

    let mut watcher = recommended_watcher(move |res: Result<Event, notify::Error>| {
        let Ok(event) = res else { return };
        let kind_label = match event.kind {
            EventKind::Create(_) => "added",
            EventKind::Modify(_) => "modified",
            EventKind::Remove(_) => "removed",
            _ => return,
        };
        for path in event.paths {
            if kind_label != "removed" && !path.is_file() {
                continue;
            }
            let matched_root = roots_for_handler
                .iter()
                .find(|root| path.starts_with(root.as_path()));
            let Some(matched_root) = matched_root else {
                continue;
            };
            let rel_to_downloads = match path.strip_prefix(matched_root) {
                Ok(rel) => rel,
                Err(_) => continue,
            };
            let source = rel_to_downloads
                .components()
                .next()
                .and_then(|c| c.as_os_str().to_str())
                .filter(|value| !value.is_empty())
                .unwrap_or("downloads")
                .to_string();
            let rel_path = path
                .strip_prefix(&vault_for_handler)
                .unwrap_or(path.as_path())
                .to_string_lossy()
                .to_string();
            let payload = InboxFileEvent {
                vault_path: vault_string.clone(),
                abs_path: path.to_string_lossy().to_string(),
                rel_path,
                source,
                kind: kind_label.to_string(),
            };
            let _ = app.emit("inbox://file_event", payload);
        }
    })
    .map_err(|err| format!("watcher creation failed: {err}"))?;

    for root in &watch_roots {
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|err| format!("watch start failed: {err}"))?;
    }

    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("watcher state lock poisoned: {err}"))?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_inbox_watcher(state: State<'_, InboxWatcherState>) -> Result<(), String> {
    let mut guard = state
        .0
        .lock()
        .map_err(|err| format!("watcher state lock poisoned: {err}"))?;
    // Dropping the RecommendedWatcher unsubscribes the OS handle.
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn payload_shape_serializes_to_camelcase() {
        let payload = InboxFileEvent {
            vault_path: "/v".to_string(),
            abs_path: "/v/inbox/downloads/gmail/x.pdf".to_string(),
            rel_path: "inbox/downloads/gmail/x.pdf".to_string(),
            source: "gmail".to_string(),
            kind: "added".to_string(),
        };
        let json = serde_json::to_string(&payload).unwrap();
        assert!(json.contains("\"vaultPath\""));
        assert!(json.contains("\"absPath\""));
        assert!(json.contains("\"relPath\""));
        assert!(json.contains("\"source\":\"gmail\""));
        assert!(json.contains("\"kind\":\"added\""));
    }
}
