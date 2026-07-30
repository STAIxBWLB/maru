// KakaoTalk relay bus consumer. A separate daemon on a dedicated Mac syncs a
// Dropbox folder ("relay bus") with room/message/media status; this module
// reads that bus and queues outbound send requests into its outbox.
//
// Layout (root from `io.providers.kakao.relay_root` in workspace.config.yaml):
//   status/relay.json, rooms/rooms.json,
//   messages/<room-slug>/YYYY-MM-DD/<hhmmss>-<hash8>.json,
//   media/_incoming/, outbox/{pending,attachments,done}/
//
// All reads tolerate partial Dropbox sync: unparseable JSON files are
// skipped, and media files younger than 10s are considered still in flight.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as JsonValue};

use crate::atomic_file::write_atomic;
use crate::inbox_drop::sanitize_filename;
use crate::inbox_settings;
use crate::telegram_io::workspace_provider_string;
use crate::vault::resolve_inside_vault;

const RELAY_PROVIDER: &str = "kakao";
const DROP_CHANNEL: &str = "kakao";
const MEDIA_STABLE_AGE: Duration = Duration::from_secs(10);
const DEFAULT_HEARTBEAT_INTERVAL_SECONDS: i64 = 300;
const HEARTBEAT_STALE_MAX_SECONDS: i64 = 900;
const DEFAULT_MESSAGE_LIMIT: u32 = 50;
const MAX_MESSAGE_LIMIT: u32 = 500;
const REQUESTED_BY: &str = "work-mac";

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KakaoRelayRoomStatus {
    pub name: String,
    pub slug: String,
    pub managed: bool,
    pub send_allowed: bool,
    pub priority: i64,
    pub message_days: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KakaoRelayStatus {
    pub configured: bool,
    pub root: Option<String>,
    pub state: String,
    pub heartbeat: Option<String>,
    pub heartbeat_age_seconds: Option<i64>,
    pub stale: bool,
    pub last_error: Option<String>,
    pub rooms: Vec<KakaoRelayRoomStatus>,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KakaoRelayRoomStageCount {
    pub staged: usize,
    pub skipped: usize,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct KakaoRelayStageOutcome {
    pub staged_messages: usize,
    pub staged_media: usize,
    pub skipped: usize,
    pub errors: Vec<String>,
    pub per_room: BTreeMap<String, KakaoRelayRoomStageCount>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KakaoSendEnqueueResult {
    pub id: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KakaoSendResult {
    pub id: String,
    pub status: String,
    pub ok: Option<bool>,
    pub error: Option<String>,
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct RelayCursor {
    #[serde(default)]
    rooms: BTreeMap<String, RelayRoomCursor>,
    #[serde(default)]
    media: Vec<String>,
}

#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct RelayRoomCursor {
    #[serde(default)]
    last_file: Option<String>,
}

#[derive(Debug, Clone)]
struct RelayRoomEntry {
    name: String,
    slug: String,
    managed: bool,
    send_allowed: bool,
    priority: i64,
}

fn resolve_relay_root(work: &Path) -> Result<PathBuf, String> {
    let raw = workspace_provider_string(work, RELAY_PROVIDER, &["relay_root"])
        .ok_or_else(|| "relay_root_not_configured".to_string())?;
    let candidate = inbox_settings::expand_tilde(&raw);
    let path = if candidate.is_absolute() {
        candidate
    } else {
        work.join(candidate)
    };
    Ok(inbox_settings::lexical_normalize_path(&path))
}

/// Mirror of `inbox_drop::stage_message_json` drop-dir resolution: runtime
/// config root + channel's first drop path, lexically normalized and
/// contained inside the inbox root.
fn resolve_kakao_drop_dir(work: &Path) -> Result<PathBuf, String> {
    let config = inbox_settings::load_runtime_config_or_legacy(work)?;
    let root = inbox_settings::resolve_runtime_root(work, &config)?;
    let drop_path = config
        .channels
        .get(DROP_CHANNEL)
        .and_then(|channel| channel.drop_paths.first())
        .cloned()
        .unwrap_or_else(|| format!("drop/{DROP_CHANNEL}"));
    let target = inbox_settings::lexical_normalize_path(&root.join(&drop_path));
    if !target.starts_with(&root) {
        return Err(format!("drop_path_outside_inbox: {drop_path}"));
    }
    Ok(target)
}

fn cursor_path(work: &Path) -> PathBuf {
    work.join(".maru")
        .join("cache")
        .join("kakao-relay-cursor.json")
}

fn load_cursor(work: &Path) -> RelayCursor {
    let Ok(raw) = fs::read_to_string(cursor_path(work)) else {
        return RelayCursor::default();
    };
    serde_json::from_str(&raw).unwrap_or_default()
}

fn read_json_file(path: &Path) -> Option<JsonValue> {
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str(&raw).ok()
}

fn read_rooms(root: &Path) -> Vec<RelayRoomEntry> {
    let Some(value) = read_json_file(&root.join("rooms").join("rooms.json")) else {
        return Vec::new();
    };
    let Some(rooms) = value.get("rooms").and_then(JsonValue::as_array) else {
        return Vec::new();
    };
    rooms
        .iter()
        .filter_map(|room| {
            let slug = room.get("slug")?.as_str()?.trim().to_string();
            if slug.is_empty() {
                return None;
            }
            let name = room
                .get("name")
                .and_then(JsonValue::as_str)
                .map(str::trim)
                .filter(|name| !name.is_empty())
                .unwrap_or(&slug)
                .to_string();
            Some(RelayRoomEntry {
                name,
                slug,
                managed: room
                    .get("managed")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(true),
                send_allowed: room
                    .get("send_allowed")
                    .and_then(JsonValue::as_bool)
                    .unwrap_or(false),
                priority: room
                    .get("priority")
                    .and_then(JsonValue::as_i64)
                    .unwrap_or(0),
            })
        })
        .collect()
}

fn validate_room_slug(slug: &str) -> Result<String, String> {
    let trimmed = slug.trim();
    if trimmed.is_empty()
        || trimmed == "."
        || trimmed == ".."
        || trimmed.contains('/')
        || trimmed.contains('\\')
    {
        return Err(format!("invalid_room_slug: {slug}"));
    }
    Ok(trimmed.to_string())
}

/// All message envelope files for a room as (`YYYY-MM-DD/<file>`, path),
/// sorted ascending by the relative key (date dir then filename).
fn list_room_message_files(root: &Path, slug: &str) -> Vec<(String, PathBuf)> {
    let room_dir = root.join("messages").join(slug);
    let Ok(days) = fs::read_dir(&room_dir) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for day in days.flatten() {
        let day_path = day.path();
        if !day_path.is_dir() {
            continue;
        }
        let Some(day_name) = day.file_name().to_str().map(ToString::to_string) else {
            continue;
        };
        let Ok(files) = fs::read_dir(&day_path) else {
            continue;
        };
        for file in files.flatten() {
            let file_path = file.path();
            if !file_path.is_file() {
                continue;
            }
            let Some(file_name) = file.file_name().to_str().map(ToString::to_string) else {
                continue;
            };
            if !file_name.ends_with(".json") {
                continue;
            }
            out.push((format!("{day_name}/{file_name}"), file_path));
        }
    }
    out.sort_by(|left, right| left.0.cmp(&right.0));
    out
}

fn count_message_days(root: &Path, slug: &str) -> usize {
    let room_dir = root.join("messages").join(slug);
    let Ok(days) = fs::read_dir(&room_dir) else {
        return 0;
    };
    days.flatten().filter(|day| day.path().is_dir()).count()
}

fn parse_iso_seconds(iso: &str) -> Option<i64> {
    let parsed = DateTime::parse_from_rfc3339(iso.trim()).ok()?;
    Some(parsed.timestamp())
}

fn read_status_inner(work: &Path) -> KakaoRelayStatus {
    let root = match resolve_relay_root(work) {
        Ok(root) => root,
        Err(_) => {
            return KakaoRelayStatus {
                configured: false,
                root: None,
                state: "unconfigured".to_string(),
                heartbeat: None,
                heartbeat_age_seconds: None,
                stale: true,
                last_error: None,
                rooms: Vec::new(),
            };
        }
    };
    let relay = read_json_file(&root.join("status").join("relay.json"));
    // The relay daemon writes `heartbeat_at`; accept the legacy `heartbeat` key too.
    let heartbeat = relay
        .as_ref()
        .and_then(|value| {
            value
                .get("heartbeat")
                .or_else(|| value.get("heartbeat_at"))
        })
        .and_then(JsonValue::as_str)
        .map(ToString::to_string);
    let heartbeat_age_seconds = heartbeat
        .as_deref()
        .and_then(parse_iso_seconds)
        .map(|stamp| (Utc::now().timestamp() - stamp).max(0));
    let expected_interval = relay
        .as_ref()
        .and_then(|value| {
            value
                .get("interval_seconds")
                .or_else(|| value.get("cycle_seconds"))
        })
        .and_then(JsonValue::as_i64)
        .filter(|value| *value > 0)
        .unwrap_or(DEFAULT_HEARTBEAT_INTERVAL_SECONDS);
    let stale = match heartbeat_age_seconds {
        Some(age) => age > 3 * expected_interval || age > HEARTBEAT_STALE_MAX_SECONDS,
        None => true,
    };
    let state = relay
        .as_ref()
        .and_then(|value| value.get("state"))
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|state| !state.is_empty())
        .map(ToString::to_string)
        .unwrap_or_else(|| "unreachable".to_string());
    let last_error = relay
        .as_ref()
        .and_then(|value| value.get("last_error"))
        .and_then(JsonValue::as_str)
        .map(ToString::to_string);
    let rooms = read_rooms(&root)
        .into_iter()
        .map(|room| KakaoRelayRoomStatus {
            message_days: count_message_days(&root, &room.slug),
            name: room.name,
            slug: room.slug,
            managed: room.managed,
            send_allowed: room.send_allowed,
            priority: room.priority,
        })
        .collect();
    KakaoRelayStatus {
        configured: true,
        root: Some(root.to_string_lossy().to_string()),
        state,
        heartbeat,
        heartbeat_age_seconds,
        stale,
        last_error,
        rooms,
    }
}

fn read_messages_inner(
    work: &Path,
    room_slug: &str,
    limit: Option<u32>,
) -> Result<Vec<JsonValue>, String> {
    let slug = validate_room_slug(room_slug)?;
    let root = resolve_relay_root(work)?;
    let limit = limit
        .unwrap_or(DEFAULT_MESSAGE_LIMIT)
        .clamp(1, MAX_MESSAGE_LIMIT) as usize;
    let files = list_room_message_files(&root, &slug);
    let mut messages = Vec::new();
    for (_, path) in files.iter().rev() {
        if messages.len() >= limit {
            break;
        }
        // Partial sync: skip envelopes that fail to parse.
        if let Some(value) = read_json_file(path) {
            messages.push(value);
        }
    }
    Ok(messages)
}

fn stage_inner(work: &Path, media_stable_age: Duration) -> Result<KakaoRelayStageOutcome, String> {
    let root = resolve_relay_root(work)?;
    let mut outcome = KakaoRelayStageOutcome::default();
    let drop_dir = match resolve_kakao_drop_dir(work) {
        Ok(dir) => Some(dir),
        Err(err) => {
            outcome.errors.push(err);
            None
        }
    };
    let mut cursor = load_cursor(work);
    let mut cursor_dirty = false;

    if let Some(drop_dir) = drop_dir.as_ref() {
        fs::create_dir_all(drop_dir)
            .map_err(|err| format!("Cannot create {}: {err}", drop_dir.to_string_lossy()))?;
        for room in read_rooms(&root).into_iter().filter(|room| room.managed) {
            let last_seen = cursor
                .rooms
                .get(&room.slug)
                .and_then(|entry| entry.last_file.clone());
            let count = outcome.per_room.entry(room.slug.clone()).or_default();
            let mut newest_staged: Option<String> = None;
            for (key, path) in list_room_message_files(&root, &room.slug) {
                if last_seen.as_deref().is_some_and(|last| key.as_str() <= last) {
                    continue;
                }
                // Partial sync: leave unparseable envelopes (and everything
                // after them) for the next run instead of staging partials.
                let Ok(bytes) = fs::read(&path) else {
                    count.skipped += 1;
                    outcome.skipped += 1;
                    outcome
                        .errors
                        .push(format!("{}: cannot read {}", room.slug, key));
                    break;
                };
                if serde_json::from_slice::<JsonValue>(&bytes).is_err() {
                    count.skipped += 1;
                    outcome.skipped += 1;
                    outcome
                        .errors
                        .push(format!("{}: unparseable envelope {}", room.slug, key));
                    break;
                }
                let Some(file_name) = path.file_name() else {
                    continue;
                };
                let target = drop_dir.join(file_name);
                if let Err(err) = fs::copy(&path, &target) {
                    count.skipped += 1;
                    outcome.skipped += 1;
                    outcome.errors.push(format!(
                        "{}: cannot stage {}: {err}",
                        room.slug, key
                    ));
                    break;
                }
                count.staged += 1;
                outcome.staged_messages += 1;
                newest_staged = Some(key);
            }
            if let Some(newest) = newest_staged {
                cursor
                    .rooms
                    .entry(room.slug.clone())
                    .or_default()
                    .last_file = Some(newest);
                cursor_dirty = true;
            }
        }

        // Media: copy stable (fully synced) new files into `<drop>/files/`.
        let incoming = root.join("media").join("_incoming");
        if incoming.is_dir() {
            let known: std::collections::BTreeSet<String> =
                cursor.media.iter().cloned().collect();
            let mut staged_names = Vec::new();
            let mut entries: Vec<PathBuf> = fs::read_dir(&incoming)
                .map(|read| {
                    read.flatten()
                        .map(|entry| entry.path())
                        .filter(|path| path.is_file())
                        .collect()
                })
                .unwrap_or_default();
            entries.sort();
            for path in entries {
                let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
                    continue;
                };
                if name.starts_with('.') || known.contains(name) {
                    continue;
                }
                let stable = fs::metadata(&path)
                    .and_then(|meta| meta.modified())
                    .ok()
                    .and_then(|mtime| SystemTime::now().duration_since(mtime).ok())
                    .is_some_and(|age| age >= media_stable_age);
                if !stable {
                    outcome.skipped += 1;
                    continue;
                }
                let files_dir = drop_dir.join("files");
                if let Err(err) = fs::create_dir_all(&files_dir)
                    .map_err(|err| err.to_string())
                    .and_then(|_| {
                        fs::copy(&path, files_dir.join(name)).map_err(|err| err.to_string())
                    })
                {
                    outcome.skipped += 1;
                    outcome
                        .errors
                        .push(format!("media: cannot stage {name}: {err}"));
                    continue;
                }
                outcome.staged_media += 1;
                staged_names.push(name.to_string());
            }
            if !staged_names.is_empty() {
                let mut merged = cursor.media.clone();
                merged.extend(staged_names);
                merged.sort();
                merged.dedup();
                cursor.media = merged;
                cursor_dirty = true;
            }
        }
    }

    if cursor_dirty {
        let payload = serde_json::to_vec_pretty(&cursor)
            .map_err(|err| format!("kakao_relay_cursor_serialize_failed: {err}"))?;
        write_atomic(&cursor_path(work), &payload)?;
    }
    Ok(outcome)
}

fn enqueue_send_inner(
    work: &Path,
    chat: &str,
    text: &str,
    attachment_path: Option<&str>,
) -> Result<KakaoSendEnqueueResult, String> {
    let chat = chat.trim();
    if chat.is_empty() {
        return Err("chat_required".to_string());
    }
    let text = text.trim();
    let attachment_path = attachment_path.map(str::trim).filter(|path| !path.is_empty());
    if text.is_empty() && attachment_path.is_none() {
        return Err("text_or_attachment_required".to_string());
    }
    let root = resolve_relay_root(work)?;
    let id = uuid::Uuid::new_v4().to_string();

    let mut attachment_field = JsonValue::Null;
    if let Some(source) = attachment_path {
        let source_path = PathBuf::from(source);
        if !source_path.is_file() {
            return Err(format!("attachment_not_found: {source}"));
        }
        let name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .map(sanitize_filename)
            .filter(|name| !name.is_empty())
            .ok_or_else(|| format!("attachment_name_invalid: {source}"))?;
        let relative = format!("outbox/attachments/{id}-{name}");
        let target = root.join(&relative);
        let parent = target
            .parent()
            .ok_or_else(|| "attachment_target_invalid".to_string())?;
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create {}: {err}", parent.to_string_lossy()))?;
        fs::copy(&source_path, &target)
            .map_err(|err| format!("Cannot copy attachment to {}: {err}", target.to_string_lossy()))?;
        attachment_field = JsonValue::String(relative);
    }

    let payload = json!({
        "schema": "kakao-send/v1",
        "id": id,
        "chat": chat,
        "text": text,
        "attachment": attachment_field,
        "requested_by": REQUESTED_BY,
        "requested_at": Utc::now().to_rfc3339(),
    });
    let target = root.join("outbox").join("pending").join(format!("{id}.json"));
    let bytes = serde_json::to_vec_pretty(&payload)
        .map_err(|err| format!("kakao_send_payload_failed: {err}"))?;
    write_atomic(&target, &bytes)?;
    Ok(KakaoSendEnqueueResult {
        id,
        path: target.to_string_lossy().to_string(),
    })
}

fn read_send_results_inner(work: &Path, ids: &[String]) -> Result<Vec<KakaoSendResult>, String> {
    let root = resolve_relay_root(work)?;
    let mut results = Vec::with_capacity(ids.len());
    for id in ids {
        let id = id.trim();
        if id.is_empty()
            || !id
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
        {
            results.push(KakaoSendResult {
                id: id.to_string(),
                status: "unknown".to_string(),
                ok: None,
                error: None,
            });
            continue;
        }
        let done_path = root.join("outbox").join("done").join(format!("{id}.json"));
        if done_path.is_file() {
            let parsed = read_json_file(&done_path);
            let result = parsed.as_ref().and_then(|value| value.get("result"));
            results.push(KakaoSendResult {
                id: id.to_string(),
                status: "done".to_string(),
                ok: result
                    .and_then(|value| value.get("ok"))
                    .and_then(JsonValue::as_bool),
                error: result
                    .and_then(|value| value.get("error"))
                    .and_then(JsonValue::as_str)
                    .map(ToString::to_string),
            });
            continue;
        }
        let pending_path = root.join("outbox").join("pending").join(format!("{id}.json"));
        let status = if pending_path.is_file() {
            "queued"
        } else {
            "unknown"
        };
        results.push(KakaoSendResult {
            id: id.to_string(),
            status: status.to_string(),
            ok: None,
            error: None,
        });
    }
    Ok(results)
}

#[tauri::command]
pub fn read_kakao_relay_status(work_path: String) -> Result<KakaoRelayStatus, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    Ok(read_status_inner(&work))
}

#[tauri::command]
pub fn read_kakao_relay_messages(
    work_path: String,
    room_slug: String,
    limit: Option<u32>,
) -> Result<Vec<JsonValue>, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    read_messages_inner(&work, &room_slug, limit)
}

#[tauri::command]
pub fn stage_kakao_relay_new(work_path: String) -> Result<KakaoRelayStageOutcome, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    stage_inner(&work, MEDIA_STABLE_AGE)
}

#[tauri::command]
pub fn enqueue_kakao_send(
    work_path: String,
    chat: String,
    text: String,
    attachment_path: Option<String>,
) -> Result<KakaoSendEnqueueResult, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    enqueue_send_inner(&work, &chat, &text, attachment_path.as_deref())
}

#[tauri::command]
pub fn read_kakao_send_results(
    work_path: String,
    ids: Vec<String>,
) -> Result<Vec<KakaoSendResult>, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    read_send_results_inner(&work, &ids)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    struct Fixture {
        work: TempDir,
        relay: TempDir,
    }

    fn write_envelope(dir: &Path, id: &str, text: &str) {
        fs::create_dir_all(dir).unwrap();
        let payload = json!({
            "schema": "kakao-msg/v1",
            "provider": "kakao",
            "kind": "message",
            "message": {
                "id": id,
                "chat": "room",
                "room_slug": "room",
                "sender": "someone",
                "is_me": false,
                "text": text,
                "sent_at": "2026-07-29T01:00:00Z",
                "captured_at": "2026-07-29T01:00:01Z",
                "engine": "kmsg",
                "attachments": [],
            }
        });
        fs::write(
            dir.join(format!("{id}.json")),
            serde_json::to_vec_pretty(&payload).unwrap(),
        )
        .unwrap();
    }

    fn fixture(drop_path: &str) -> Fixture {
        let work = TempDir::new().unwrap();
        let relay = TempDir::new().unwrap();
        let config = format!(
            r#"profile: local
inbox:
  root: inbox
  channels:
    kakao:
      provider: kakao
      skill: io-kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - {drop_path}
io:
  providers:
    kakao:
      relay_root: {}
"#,
            relay.path().to_string_lossy()
        );
        fs::write(work.path().join("workspace.config.yaml"), config).unwrap();
        Fixture { work, relay }
    }

    fn write_rooms(relay: &Path, rooms: &str) {
        let dir = relay.join("rooms");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("rooms.json"), rooms).unwrap();
    }

    #[test]
    fn status_unconfigured_when_relay_root_missing() {
        let tmp = TempDir::new().unwrap();
        let status = read_status_inner(tmp.path());
        assert!(!status.configured);
        assert_eq!(status.state, "unconfigured");
        assert!(status.stale);
    }

    #[test]
    fn status_unreachable_when_files_missing() {
        let fixture = fixture("drop/kakao");
        let status = read_status_inner(fixture.work.path());
        assert!(status.configured);
        assert_eq!(status.state, "unreachable");
        assert!(status.stale);
        assert!(status.heartbeat.is_none());
        assert!(status.rooms.is_empty());
    }

    #[test]
    fn status_tolerates_partial_relay_json() {
        let fixture = fixture("drop/kakao");
        let status_dir = fixture.relay.path().join("status");
        fs::create_dir_all(&status_dir).unwrap();
        fs::write(status_dir.join("relay.json"), "{\"state\":\"running\",\"heartbeat\":").unwrap();
        let status = read_status_inner(fixture.work.path());
        assert_eq!(status.state, "unreachable");
        assert!(status.stale);

        let heartbeat = Utc::now().to_rfc3339();
        fs::write(
            status_dir.join("relay.json"),
            format!(r#"{{"state":"running","heartbeat":"{heartbeat}"}}"#),
        )
        .unwrap();
        let status = read_status_inner(fixture.work.path());
        assert_eq!(status.state, "running");
        assert!(!status.stale);
        assert!(status.heartbeat_age_seconds.unwrap() < 60);
    }

    #[test]
    fn status_detects_stale_heartbeat() {
        let fixture = fixture("drop/kakao");
        let status_dir = fixture.relay.path().join("status");
        fs::create_dir_all(&status_dir).unwrap();
        let old = (Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        fs::write(
            status_dir.join("relay.json"),
            format!(r#"{{"state":"running","heartbeat":"{old}","last_error":null}}"#),
        )
        .unwrap();
        write_rooms(
            fixture.relay.path(),
            r#"{"rooms":[{"name":"Team","slug":"team","managed":true,"send_allowed":false,"priority":1}]}"#,
        );
        fs::create_dir_all(fixture.relay.path().join("messages/team/2026-07-28")).unwrap();
        fs::create_dir_all(fixture.relay.path().join("messages/team/2026-07-29")).unwrap();

        let status = read_status_inner(fixture.work.path());
        assert_eq!(status.state, "running");
        assert!(status.stale);
        assert!(status.heartbeat_age_seconds.unwrap() >= 7200);
        assert_eq!(status.rooms.len(), 1);
        assert_eq!(status.rooms[0].slug, "team");
        assert_eq!(status.rooms[0].message_days, 2);
    }

    #[test]
    fn messages_skip_invalid_newest_first_limit_honored() {
        let fixture = fixture("drop/kakao");
        let day1 = fixture.relay.path().join("messages/room/2026-07-28");
        let day2 = fixture.relay.path().join("messages/room/2026-07-29");
        write_envelope(&day1, "080000-aaaa1111", "old");
        write_envelope(&day2, "090000-bbbb2222", "mid");
        write_envelope(&day2, "100000-cccc3333", "new");
        fs::write(day2.join("110000-dddd4444.json"), "{\"schema\":\"kakao-msg").unwrap();
        fs::write(day2.join("notes.txt"), "not json").unwrap();

        let messages = read_messages_inner(fixture.work.path(), "room", None).unwrap();
        assert_eq!(messages.len(), 3);
        assert_eq!(messages[0]["message"]["text"], "new");
        assert_eq!(messages[2]["message"]["text"], "old");

        let limited = read_messages_inner(fixture.work.path(), "room", Some(2)).unwrap();
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0]["message"]["text"], "new");
        assert_eq!(limited[1]["message"]["text"], "mid");

        assert!(read_messages_inner(fixture.work.path(), "../escape", None).is_err());
        assert!(
            read_messages_inner(fixture.work.path(), "missing", None)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn staging_copies_envelopes_and_media_and_is_idempotent() {
        let fixture = fixture("drop/kakao");
        write_rooms(
            fixture.relay.path(),
            r#"{"rooms":[
                {"name":"Team","slug":"team","managed":true},
                {"name":"Idle","slug":"idle","managed":false}
            ]}"#,
        );
        let day = fixture.relay.path().join("messages/team/2026-07-29");
        write_envelope(&day, "090000-aaaa1111", "first");
        write_envelope(&day, "100000-bbbb2222", "second");
        let idle_day = fixture.relay.path().join("messages/idle/2026-07-29");
        write_envelope(&idle_day, "090000-eeee5555", "unmanaged");
        let incoming = fixture.relay.path().join("media/_incoming");
        fs::create_dir_all(&incoming).unwrap();
        fs::write(incoming.join("photo.jpg"), b"jpeg-bytes").unwrap();

        let outcome = stage_inner(fixture.work.path(), Duration::ZERO).unwrap();
        assert_eq!(outcome.staged_messages, 2);
        assert_eq!(outcome.staged_media, 1);
        assert_eq!(outcome.per_room.get("team").unwrap().staged, 2);
        assert!(!outcome.per_room.contains_key("idle"));

        let drop = fixture.work.path().join("inbox/drop/kakao");
        assert!(drop.join("090000-aaaa1111.json").exists());
        assert!(drop.join("100000-bbbb2222.json").exists());
        assert_eq!(
            fs::read(drop.join("090000-aaaa1111.json")).unwrap(),
            fs::read(day.join("090000-aaaa1111.json")).unwrap()
        );
        assert_eq!(
            fs::read(drop.join("files/photo.jpg")).unwrap(),
            b"jpeg-bytes"
        );

        let cursor = load_cursor(fixture.work.path());
        assert_eq!(
            cursor.rooms.get("team").unwrap().last_file.as_deref(),
            Some("2026-07-29/100000-bbbb2222.json")
        );
        assert_eq!(cursor.media, vec!["photo.jpg".to_string()]);

        let second = stage_inner(fixture.work.path(), Duration::ZERO).unwrap();
        assert_eq!(second.staged_messages, 0);
        assert_eq!(second.staged_media, 0);
    }

    #[test]
    fn staging_resumes_after_unparseable_envelope() {
        let fixture = fixture("drop/kakao");
        write_rooms(
            fixture.relay.path(),
            r#"{"rooms":[{"name":"Team","slug":"team","managed":true}]}"#,
        );
        let day = fixture.relay.path().join("messages/team/2026-07-29");
        write_envelope(&day, "090000-aaaa1111", "first");
        fs::write(day.join("100000-bbbb2222.json"), "{\"partial\":").unwrap();
        write_envelope(&day, "110000-cccc3333", "third");

        let outcome = stage_inner(fixture.work.path(), Duration::ZERO).unwrap();
        assert_eq!(outcome.staged_messages, 1);
        assert_eq!(outcome.skipped, 1);
        assert!(!outcome.errors.is_empty());
        let cursor = load_cursor(fixture.work.path());
        assert_eq!(
            cursor.rooms.get("team").unwrap().last_file.as_deref(),
            Some("2026-07-29/090000-aaaa1111.json")
        );

        // Sync completes the partial file; next run picks it up.
        write_envelope(&day, "100000-bbbb2222", "second");
        let outcome = stage_inner(fixture.work.path(), Duration::ZERO).unwrap();
        assert_eq!(outcome.staged_messages, 2);
        let cursor = load_cursor(fixture.work.path());
        assert_eq!(
            cursor.rooms.get("team").unwrap().last_file.as_deref(),
            Some("2026-07-29/110000-cccc3333.json")
        );
    }

    #[test]
    fn staging_does_not_advance_cursor_when_drop_resolution_fails() {
        let fixture = fixture("../escape");
        write_rooms(
            fixture.relay.path(),
            r#"{"rooms":[{"name":"Team","slug":"team","managed":true}]}"#,
        );
        let day = fixture.relay.path().join("messages/team/2026-07-29");
        write_envelope(&day, "090000-aaaa1111", "first");

        let outcome = stage_inner(fixture.work.path(), Duration::ZERO).unwrap();
        assert_eq!(outcome.staged_messages, 0);
        assert!(!outcome.errors.is_empty());
        assert!(!cursor_path(fixture.work.path()).exists());
    }

    #[test]
    fn enqueue_requires_chat_and_text_or_attachment() {
        let fixture = fixture("drop/kakao");
        assert_eq!(
            enqueue_send_inner(fixture.work.path(), "  ", "hi", None).unwrap_err(),
            "chat_required"
        );
        assert_eq!(
            enqueue_send_inner(fixture.work.path(), "room", "  ", None).unwrap_err(),
            "text_or_attachment_required"
        );
        assert!(enqueue_send_inner(
            fixture.work.path(),
            "room",
            "",
            Some("/nonexistent/file.png")
        )
        .unwrap_err()
        .contains("attachment_not_found"));
    }

    #[test]
    fn enqueue_writes_request_and_copies_attachment() {
        let fixture = fixture("drop/kakao");
        let attachment = fixture.work.path().join("my photo.png");
        fs::write(&attachment, b"png-bytes").unwrap();

        let result = enqueue_send_inner(
            fixture.work.path(),
            "team room",
            "hello",
            Some(attachment.to_string_lossy().as_ref()),
        )
        .unwrap();

        let pending = fixture
            .relay
            .path()
            .join(format!("outbox/pending/{}.json", result.id));
        assert!(pending.is_file());
        assert_eq!(result.path, pending.to_string_lossy().to_string());
        let payload = read_json_file(&pending).unwrap();
        assert_eq!(payload["schema"], "kakao-send/v1");
        assert_eq!(payload["id"], result.id);
        assert_eq!(payload["chat"], "team room");
        assert_eq!(payload["text"], "hello");
        assert_eq!(payload["requested_by"], "work-mac");
        let attachment_rel = payload["attachment"].as_str().unwrap();
        assert_eq!(
            attachment_rel,
            format!("outbox/attachments/{}-my-photo.png", result.id)
        );
        assert_eq!(
            fs::read(fixture.relay.path().join(attachment_rel)).unwrap(),
            b"png-bytes"
        );

        let no_attachment =
            enqueue_send_inner(fixture.work.path(), "team room", "plain", None).unwrap();
        let payload = read_json_file(
            &fixture
                .relay
                .path()
                .join(format!("outbox/pending/{}.json", no_attachment.id)),
        )
        .unwrap();
        assert!(payload["attachment"].is_null());
    }

    #[test]
    fn send_results_cover_done_queued_and_unknown() {
        let fixture = fixture("drop/kakao");
        let queued = enqueue_send_inner(fixture.work.path(), "room", "hi", None).unwrap();

        let done_dir = fixture.relay.path().join("outbox/done");
        fs::create_dir_all(&done_dir).unwrap();
        fs::write(
            done_dir.join("11111111-1111-1111-1111-111111111111.json"),
            r#"{"schema":"kakao-send/v1","id":"11111111-1111-1111-1111-111111111111","result":{"ok":true,"error":null,"sent_at":"2026-07-29T01:00:00Z"}}"#,
        )
        .unwrap();
        fs::write(
            done_dir.join("22222222-2222-2222-2222-222222222222.json"),
            r#"{"schema":"kakao-send/v1","id":"22222222-2222-2222-2222-222222222222","result":{"ok":false,"error":"kmsg_timeout","sent_at":null}}"#,
        )
        .unwrap();

        let results = read_send_results_inner(
            fixture.work.path(),
            &[
                queued.id.clone(),
                "11111111-1111-1111-1111-111111111111".to_string(),
                "22222222-2222-2222-2222-222222222222".to_string(),
                "33333333-3333-3333-3333-333333333333".to_string(),
            ],
        )
        .unwrap();

        assert_eq!(results[0].status, "queued");
        assert_eq!(results[1].status, "done");
        assert_eq!(results[1].ok, Some(true));
        assert_eq!(results[1].error, None);
        assert_eq!(results[2].status, "done");
        assert_eq!(results[2].ok, Some(false));
        assert_eq!(results[2].error.as_deref(), Some("kmsg_timeout"));
        assert_eq!(results[3].status, "unknown");
    }
}
