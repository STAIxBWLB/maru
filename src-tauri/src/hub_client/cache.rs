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

// ---------- Offline queue (Phase 3 stub, Phase 6에서 활성화) ----------

pub fn queue_root(workspace_root: &Path) -> PathBuf {
    workspace_root.join(".anchor").join("queue").join("hub")
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

    #[derive(Serialize)]
    struct QueueItem<'a> {
        request_id: String,
        method: &'a str,
        path: &'a str,
        body: &'a HubSubmitGateRequest,
        queued_at: String,
        retry_count: u32,
        last_error: Option<String>,
    }
    let item = QueueItem {
        request_id: format!("req_{}", id),
        method: "POST",
        path: "/submission-gates",
        body: req,
        queued_at: chrono::Utc::now().to_rfc3339(),
        retry_count: 0,
        last_error: None,
    };
    let text =
        serde_json::to_string_pretty(&item).map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(&path, text)?;
    Ok(path)
}

fn uuid_like() -> String {
    // 간단한 ULID-ish ID (rand 의존성 추가 없이). Phase 6에서 ulid crate로 교체 가능.
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:016x}", nanos)
}
