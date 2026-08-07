// Phase 2 step 2: filesystem watcher layered on top of the polling
// `scan_inbox_drop` baseline. `notify` watches configured inbox drop/pending paths
// recursively; relevant create/modify/remove events are forwarded to the
// frontend via Tauri's event channel as batched `inbox://file_events` payloads.
//
// Lifecycle: the frontend calls `start_inbox_watcher(vault_path)` on
// vault activation and `stop_inbox_watcher()` on switch/quit. Replacing
// an active watcher transparently stops the previous one — the watcher
// handle is dropped, which `notify` interprets as unsubscribe, and the
// drain thread exits when the disconnected channel reports it.

use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use notify::{recommended_watcher, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::inbox_settings;

#[derive(Default)]
pub struct InboxWatcherState(pub Mutex<Option<RecommendedWatcher>>);

/// Coalesce window for filesystem event bursts. A bulk drop of N files
/// produces one `inbox://file_events` emit per window instead of N emits
/// (and therefore N frontend re-scans).
const DEBOUNCE_MS: u64 = 150;

/// One filesystem change inside an `inbox://file_events` batch. `kind` is
/// one of `added` / `modified` / `removed`. The current frontend re-runs
/// `scan_inbox_drop` (cheap, ~ms) on any batch and does not inspect the
/// payload; per-event fields are carried so a future consumer can apply
/// deltas without a re-scan.
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

/// Payload emitted to the webview as `inbox://file_events` — one batch per
/// coalesce window, never one emit per path.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxFileEventsBatch {
    pub vault_path: String,
    pub events: Vec<InboxFileEvent>,
}

/// Drop consecutive duplicates of the same path+kind — a single save
/// typically produces a burst of identical modify events.
fn dedup_events(events: Vec<InboxFileEvent>) -> Vec<InboxFileEvent> {
    let mut out: Vec<InboxFileEvent> = Vec::with_capacity(events.len());
    for event in events {
        let dup = out
            .last()
            .is_some_and(|prev| prev.abs_path == event.abs_path && prev.kind == event.kind);
        if !dup {
            out.push(event);
        }
    }
    out
}

fn emit_batch(app: &AppHandle, vault_path: &str, events: Vec<InboxFileEvent>) {
    let events = dedup_events(events);
    if events.is_empty() {
        return;
    }
    let _ = app.emit(
        "inbox://file_events",
        InboxFileEventsBatch {
            vault_path: vault_path.to_string(),
            events,
        },
    );
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
    let (tx, rx) = mpsc::channel::<InboxFileEvent>();

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
            let _ = tx.send(payload);
        }
    })
    .map_err(|err| format!("watcher creation failed: {err}"))?;

    for root in &watch_roots {
        watcher
            .watch(root, RecursiveMode::Recursive)
            .map_err(|err| format!("watch start failed: {err}"))?;
    }

    // Drain thread (same shape as the scratchpad watcher): wait for the
    // first event, keep draining until a DEBOUNCE_MS quiet window passes,
    // then emit one batch. Exits when the watcher — and with it the
    // channel — is dropped on stop/restart.
    let vault_for_thread = vault_path.clone();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let deadline = Instant::now() + Duration::from_millis(DEBOUNCE_MS);
            let mut events = vec![first];
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(event) => events.push(event),
                    Err(mpsc::RecvTimeoutError::Timeout) => break,
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        emit_batch(&app, &vault_for_thread, events);
                        return;
                    }
                }
            }
            emit_batch(&app, &vault_for_thread, events);
        }
    });

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
    // Dropping the RecommendedWatcher unsubscribes the OS handle and ends
    // the drain thread via the disconnected channel.
    *guard = None;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn event(abs_path: &str, kind: &str) -> InboxFileEvent {
        InboxFileEvent {
            vault_path: "/v".to_string(),
            abs_path: abs_path.to_string(),
            rel_path: format!("inbox/downloads/gmail/{abs_path}"),
            source: "gmail".to_string(),
            kind: kind.to_string(),
        }
    }

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

    #[test]
    fn batch_payload_serializes_events_under_vault_path() {
        let batch = InboxFileEventsBatch {
            vault_path: "/v".to_string(),
            events: vec![event("a.pdf", "added"), event("b.pdf", "modified")],
        };
        let json = serde_json::to_string(&batch).unwrap();
        assert!(json.contains("\"vaultPath\":\"/v\""));
        assert!(json.contains("\"events\":["));
        assert!(json.contains("\"absPath\":\"a.pdf\""));
    }

    #[test]
    fn dedup_events_drops_consecutive_path_kind_duplicates() {
        let events = vec![
            event("a.pdf", "modified"),
            event("a.pdf", "modified"),
            event("b.pdf", "modified"),
            event("b.pdf", "removed"),
            event("a.pdf", "modified"),
        ];
        let deduped = dedup_events(events);
        let summary: Vec<(&str, &str)> = deduped
            .iter()
            .map(|event| (event.abs_path.as_str(), event.kind.as_str()))
            .collect();
        assert_eq!(
            summary,
            vec![
                ("a.pdf", "modified"),
                ("b.pdf", "modified"),
                ("b.pdf", "removed"),
                ("a.pdf", "modified"),
            ]
        );
    }

    #[test]
    fn dedup_events_keeps_distinct_kinds_of_the_same_path() {
        let deduped = dedup_events(vec![event("a.pdf", "added"), event("a.pdf", "removed")]);
        assert_eq!(deduped.len(), 2);
    }
}
