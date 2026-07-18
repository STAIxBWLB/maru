// Hub client local cache (ETag-aware) + offline queue.
// Spec: hub-sync.md §5-§7

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use super::{HubFetchResponse, HubSubmitGateRequest};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EtagIndex {
    /// Key: "<resource>?<params>" canonical string. Value: ETag.
    pub etags: HashMap<String, EtagEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EtagEntry {
    pub etag: String,
    pub cached_at: String, // ISO8601
    pub ttl_seconds: u64,
}

pub fn etag_index_path(cache_root: &Path) -> PathBuf {
    cache_root.join("etags.json")
}

pub fn load_etag_index(cache_root: &Path) -> io::Result<EtagIndex> {
    let path = etag_index_path(cache_root);
    if !path.exists() {
        return Ok(EtagIndex::default());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn save_etag_index(cache_root: &Path, index: &EtagIndex) -> io::Result<()> {
    std::fs::create_dir_all(cache_root)?;
    let path = etag_index_path(cache_root);
    let text =
        serde_json::to_string_pretty(index).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(&path, text)
}

pub fn list_cached_etags(cache_root: &Path) -> io::Result<Vec<String>> {
    let index = load_etag_index(cache_root)?;
    Ok(index.etags.keys().cloned().collect())
}

pub fn last_fetch_at(cache_root: &Path) -> io::Result<String> {
    let index = load_etag_index(cache_root)?;
    Ok(index
        .etags
        .values()
        .map(|e| e.cached_at.clone())
        .max()
        .unwrap_or_default())
}

/// 캐시에서 자원 로드 (오프라인 fallback).
pub fn load_cached_resource(
    cache_root: &Path,
    resource: &str,
    params: &HashMap<String, String>,
) -> io::Result<HubFetchResponse> {
    let key = canonical_key(resource, params);
    let body_path = resource_body_path(cache_root, resource, &key);

    if !body_path.exists() {
        return Ok(HubFetchResponse {
            from_cache: false,
            etag: None,
            body_json: String::new(),
            fetched_at: String::new(),
        });
    }
    let body = std::fs::read_to_string(&body_path)?;
    let index = load_etag_index(cache_root).unwrap_or_default();
    let entry = index.etags.get(&key);
    Ok(HubFetchResponse {
        from_cache: true,
        etag: entry.map(|e| e.etag.clone()),
        body_json: body,
        fetched_at: entry.map(|e| e.cached_at.clone()).unwrap_or_default(),
    })
}

/// 캐시 저장 (실 호출 후 호출). Phase 4+에서 사용.
#[allow(dead_code)]
pub fn save_resource(
    cache_root: &Path,
    resource: &str,
    params: &HashMap<String, String>,
    body: &str,
    etag: Option<String>,
    ttl_seconds: u64,
) -> io::Result<()> {
    let key = canonical_key(resource, params);
    let body_path = resource_body_path(cache_root, resource, &key);
    if let Some(parent) = body_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(&body_path, body)?;

    if let Some(tag) = etag {
        let mut index = load_etag_index(cache_root).unwrap_or_default();
        index.etags.insert(
            key,
            EtagEntry {
                etag: tag,
                cached_at: chrono::Utc::now().to_rfc3339(),
                ttl_seconds,
            },
        );
        save_etag_index(cache_root, &index)?;
    }
    Ok(())
}

fn canonical_key(resource: &str, params: &HashMap<String, String>) -> String {
    let mut pairs: Vec<(&String, &String)> = params.iter().collect();
    pairs.sort_by(|a, b| a.0.cmp(b.0));
    let query: String = pairs
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");
    if query.is_empty() {
        resource.to_string()
    } else {
        format!("{}?{}", resource, query)
    }
}

fn resource_body_path(cache_root: &Path, resource: &str, key: &str) -> PathBuf {
    // 안전한 파일명으로 변환
    let safe = key.replace(['/', '?', '&', '='], "_");
    cache_root.join(resource).join(format!("{}.json", safe))
}

// ---------- Offline queue ----------

/// Durable record for one queued Hub write. Lives as one JSON file per item
/// under `<workspace>/.maru/queue/hub/`, drained FIFO by `hub_queue_drain`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QueuedSubmitGate {
    pub request_id: String,
    pub method: String,
    pub path: String,
    pub body: HubSubmitGateRequest,
    pub queued_at: String,
    pub retry_count: u32,
    pub last_error: Option<String>,
}

pub fn queue_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".maru").join("queue").join("hub")
}

pub fn queue_depth(workspace_root: &Path) -> io::Result<usize> {
    let dir = queue_root(workspace_root);
    if !dir.exists() {
        return Ok(0);
    }
    let mut count = 0;
    for entry in std::fs::read_dir(&dir)? {
        if entry?.path().extension().and_then(|s| s.to_str()) == Some("json") {
            count += 1;
        }
    }
    Ok(count)
}

pub fn enqueue_submit_gate(
    workspace_root: &Path,
    req: &HubSubmitGateRequest,
) -> io::Result<PathBuf> {
    let dir = queue_root(workspace_root);
    std::fs::create_dir_all(&dir)?;
    let ts = chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string();
    let id = uuid_like();
    let filename = format!("{}-submit-gate-{}.json", ts, id);
    let path = dir.join(filename);

    let item = QueuedSubmitGate {
        request_id: format!("req_{}", id),
        method: "POST".to_string(),
        path: "/submission-gates".to_string(),
        body: req.clone(),
        queued_at: chrono::Utc::now().to_rfc3339(),
        retry_count: 0,
        last_error: None,
    };
    let text =
        serde_json::to_string_pretty(&item).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(&path, text)?;
    Ok(path)
}

/// List queued items oldest-first (filenames start with a UTC timestamp, so
/// lexical order is FIFO). Unreadable files are skipped with a log line — a
/// corrupt item must not block draining the rest of the queue.
pub fn list_queue(workspace_root: &Path) -> io::Result<Vec<(PathBuf, QueuedSubmitGate)>> {
    let dir = queue_root(workspace_root);
    let mut items: Vec<(PathBuf, QueuedSubmitGate)> = Vec::new();
    if !dir.exists() {
        return Ok(items);
    }
    let mut paths: Vec<PathBuf> = std::fs::read_dir(&dir)?
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|s| s.to_str()) == Some("json"))
        .collect();
    paths.sort();
    for path in paths {
        let parsed = std::fs::read_to_string(&path)
            .ok()
            .and_then(|text| serde_json::from_str::<QueuedSubmitGate>(&text).ok());
        match parsed {
            Some(item) => items.push((path, item)),
            None => eprintln!(
                "[hub_client] skipping unreadable queue item: {}",
                path.display()
            ),
        }
    }
    Ok(items)
}

/// Record a failed drain attempt: bump retry_count and keep the last error.
pub fn mark_retry(path: &Path, error: &str) -> io::Result<()> {
    let text = std::fs::read_to_string(path)?;
    let mut item: QueuedSubmitGate = serde_json::from_str(&text)
        .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))?;
    item.retry_count += 1;
    item.last_error = Some(error.chars().take(500).collect());
    let text =
        serde_json::to_string_pretty(&item).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(path, text)
}

/// Drop a successfully drained item from the queue.
pub fn remove_queued(path: &Path) -> io::Result<()> {
    std::fs::remove_file(path)
}

fn uuid_like() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos)
}


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn req() -> HubSubmitGateRequest {
        HubSubmitGateRequest {
            workspace_root: "/tmp".to_string(),
            program_id: "prg_1".to_string(),
            business_unit_id: "bu_1".to_string(),
            document_uri: "projects/x/doc.md".to_string(),
            document_type: "change-request".to_string(),
            document_sha256: "a".repeat(64),
            submission_kind: "external-dispatch".to_string(),
            target_org: "Demo Org".to_string(),
            deadline: None,
            evidence_sha256_list: vec![],
            frontmatter_snapshot: serde_json::json!({"title": "X"}),
            notes: None,
        }
    }

    #[test]
    fn queue_roundtrip_enqueue_list_retry_remove() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        assert_eq!(queue_depth(root).unwrap(), 0);

        let path = enqueue_submit_gate(root, &req()).unwrap();
        assert_eq!(queue_depth(root).unwrap(), 1);

        let items = list_queue(root).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].1.retry_count, 0);
        assert_eq!(items[0].1.method, "POST");
        assert_eq!(items[0].1.path, "/submission-gates");

        mark_retry(&path, "network: down").unwrap();
        let items = list_queue(root).unwrap();
        assert_eq!(items[0].1.retry_count, 1);
        assert_eq!(items[0].1.last_error.as_deref(), Some("network: down"));

        remove_queued(&path).unwrap();
        assert_eq!(queue_depth(root).unwrap(), 0);
        assert!(list_queue(root).unwrap().is_empty());
    }

    #[test]
    fn list_queue_skips_unreadable_items() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        enqueue_submit_gate(root, &req()).unwrap();
        let junk = queue_root(root).join("broken.json");
        std::fs::write(&junk, "{not json").unwrap();

        // queue_depth counts every .json file (cheap); list_queue skips the
        // unreadable one so a corrupt item never blocks draining.
        assert_eq!(queue_depth(root).unwrap(), 2);
        let items = list_queue(root).unwrap();
        assert_eq!(items.len(), 1);
        assert!(items[0].1.request_id.starts_with("req_"));
    }

    #[test]
    fn list_queue_returns_oldest_first() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let dir = queue_root(root);
        std::fs::create_dir_all(&dir).unwrap();
        for (name, id) in [
            ("20260102T000000Z-0000000000000002-submit-gate-b.json", "req_b"),
            ("20260101T000000Z-0000000000000001-submit-gate-a.json", "req_a"),
        ] {
            let item = QueuedSubmitGate {
                request_id: id.to_string(),
                method: "POST".to_string(),
                path: "/submission-gates".to_string(),
                body: req(),
                queued_at: "2026-01-01T00:00:00Z".to_string(),
                retry_count: 0,
                last_error: None,
            };
            std::fs::write(
                dir.join(name),
                serde_json::to_string_pretty(&item).unwrap(),
            )
            .unwrap();
        }
        let items = list_queue(root).unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].1.request_id, "req_a");
        assert_eq!(items[1].1.request_id, "req_b");
    }
}
