// M7 Hub Connector (Phase 3 read, Phase 6 write)
//
// Maru → Maru Hub (read-mirror) 통신.
// 본문/원본 binary/개인정보 업로드 금지.
//
// Spec: ~/workspace/work/_sys/rules/hub-sync.md + plan §M7

pub mod cache;
#[allow(dead_code)]
pub mod catalog;
pub mod http;
pub mod safety;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubConfig {
    pub endpoint: String,
    pub api_token: Option<String>,
    pub deployment_mode: HubDeploymentMode,
    pub enabled: bool,
    pub cache_root: PathBuf,
    pub timeout_ms: u64,
    pub cache_ttl_seconds: u64,
}

impl HubConfig {
    pub fn cache_ttl_seconds(&self) -> u64 {
        self.cache_ttl_seconds
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum HubDeploymentMode {
    Public,
    Private,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubStatus {
    pub enabled: bool,
    pub endpoint: String,
    pub deployment_mode: HubDeploymentMode,
    pub reachable: bool,
    pub cached_etags_count: usize,
    pub last_fetch_at: Option<String>,
    pub queue_depth: usize,
}

pub fn hub_status(workspace_root: String) -> Result<HubStatus, String> {
    let root = PathBuf::from(&workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;
    let cached = cache::list_cached_etags(&cfg.cache_root).unwrap_or_default();
    let queue_depth = cache::queue_depth(&root).unwrap_or(0);
    let reachable = if cfg.enabled {
        probe_health(&cfg).unwrap_or(false)
    } else {
        false
    };

    Ok(HubStatus {
        enabled: cfg.enabled,
        endpoint: cfg.endpoint.clone(),
        deployment_mode: cfg.deployment_mode,
        reachable,
        cached_etags_count: cached.len(),
        last_fetch_at: cache::last_fetch_at(&cfg.cache_root).ok(),
        queue_depth,
    })
}

fn probe_health(cfg: &HubConfig) -> Option<bool> {
    let client = http::build_client(cfg).ok()?;
    // `/health` lives at the deployment root, not under /api/v1. Strip the
    // /api/v1 suffix if present so the probe lands on the FastAPI health endpoint.
    let base = cfg
        .endpoint
        .strip_suffix("/api/v1")
        .or_else(|| cfg.endpoint.strip_suffix("/api/v1/"))
        .unwrap_or(&cfg.endpoint)
        .trim_end_matches('/');
    let url = format!("{}/health", base);
    let resp = client.get(&url).send().ok()?;
    Some(resp.status().is_success())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubFetchRequest {
    pub workspace_root: String,
    /// 자원 종류: templates | guidelines | glossary | context_packs | evidence_index | kpi_status | submission_gates
    pub resource: String,
    /// 추가 query params (예: `{"document_type": "change-request"}`)
    #[serde(default)]
    pub params: std::collections::HashMap<String, String>,
    /// false면 캐시 우선, true면 무조건 ETag revalidate.
    #[serde(default)]
    pub revalidate: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubFetchResponse {
    pub from_cache: bool,
    pub etag: Option<String>,
    pub body_json: String,
    pub fetched_at: String,
}

pub fn hub_fetch_catalog(req: HubFetchRequest) -> Result<HubFetchResponse, String> {
    let root = PathBuf::from(&req.workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;

    if !cfg.enabled {
        // Disabled — 캐시만 반환 (오프라인 fallback).
        return cache::load_cached_resource(&cfg.cache_root, &req.resource, &req.params)
            .map_err(|e| e.to_string());
    }

    // Online path — HTTP GET with ETag revalidation. On error, fall back to
    // the cache so the UI keeps working when the Hub is unreachable. The
    // shared etags index makes every cache write one coherent store, so the
    // whole cache tree is admitted before the first effect.
    with_path_transactions(
        PathTransactionRequest::new(vec![cfg.cache_root.clone()])?,
        |lease| hub_fetch_catalog_in_transaction(&cfg, &req, lease),
    )
}

fn hub_fetch_catalog_in_transaction(
    cfg: &HubConfig,
    req: &HubFetchRequest,
    lease: &PathTransactionLease,
) -> Result<HubFetchResponse, String> {
    lease.ensure_covered(vec![cfg.cache_root.clone()])?;
    lease.before_effect()?;
    match http::fetch_with_cache(cfg, &req.resource, &req.params, req.revalidate) {
        Ok(resp) => Ok(resp),
        Err(err) => {
            eprintln!("[hub_client] fetch error ({}): {}", req.resource, err);
            cache::load_cached_resource(&cfg.cache_root, &req.resource, &req.params)
                .map_err(|e| format!("hub fetch failed and cache empty: hub={} cache={}", err, e))
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSubmitGateRequest {
    pub workspace_root: String,
    pub program_id: String,
    pub business_unit_id: String,
    pub document_uri: String,
    pub document_type: String,
    pub document_sha256: String,
    pub submission_kind: String,
    pub target_org: String,
    pub deadline: Option<String>,
    pub evidence_sha256_list: Vec<String>,
    pub frontmatter_snapshot: serde_json::Value,
    pub notes: Option<String>,
}

/// Network payload for a submit gate. `workspace_root` is intentionally not
/// present: it is local routing state used to load config and the durable
/// queue, never Hub metadata.
#[derive(Debug, Serialize)]
struct HubSubmitGatePayload<'a> {
    program_id: &'a str,
    business_unit_id: &'a str,
    document_uri: &'a str,
    document_type: &'a str,
    document_sha256: &'a str,
    submission_kind: &'a str,
    target_org: &'a str,
    deadline: Option<&'a str>,
    evidence_sha256_list: &'a [String],
    frontmatter_snapshot: &'a serde_json::Value,
    notes: Option<&'a str>,
}

fn submit_gate_payload(req: &HubSubmitGateRequest) -> HubSubmitGatePayload<'_> {
    HubSubmitGatePayload {
        program_id: &req.program_id,
        business_unit_id: &req.business_unit_id,
        document_uri: &req.document_uri,
        document_type: &req.document_type,
        document_sha256: &req.document_sha256,
        submission_kind: &req.submission_kind,
        target_org: &req.target_org,
        deadline: req.deadline.as_deref(),
        evidence_sha256_list: &req.evidence_sha256_list,
        frontmatter_snapshot: &req.frontmatter_snapshot,
        notes: req.notes.as_deref(),
    }
}

fn serialize_submit_gate_payload(req: &HubSubmitGateRequest) -> Result<String, String> {
    serde_json::to_string(&submit_gate_payload(req)).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSubmitGateResponse {
    pub gate_id: Option<String>,
    pub state: String, // "pending" | "queued_offline" | "blocked_by_safety"
    pub queued_at: Option<String>,
    pub created_at: Option<String>,
}

/// POST one submit-gate request to the Hub. Returns `(gate_id, state)` parsed
/// leniently from the response body (missing fields fall back to
/// `None`/`"pending"` so an older Hub build still completes the round-trip).
fn post_submit_gate(
    cfg: &HubConfig,
    req: &HubSubmitGateRequest,
) -> Result<(Option<String>, String), String> {
    let client = http::build_client(cfg).map_err(|e| e.to_string())?;
    let body = serialize_submit_gate_payload(req)?;
    let text =
        http::post_resource(&client, cfg, "submission_gates", &body).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&text).unwrap_or(serde_json::Value::Null);
    let gate_id = json
        .get("gate_id")
        .or_else(|| json.get("id"))
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let state = json
        .get("state")
        .and_then(|v| v.as_str())
        .unwrap_or("pending")
        .to_string();
    Ok((gate_id, state))
}

fn blocked_by_safety(reason: String) -> HubSubmitGateResponse {
    HubSubmitGateResponse {
        gate_id: None,
        state: format!("blocked_by_safety:{}", reason),
        queued_at: None,
        created_at: None,
    }
}

/// Pre-flight safety for one submit-gate payload (hub-sync.md §9): the base
/// check plus, on public deployments, the real-name blocklist. Shared by
/// `hub_submit_gate` and `hub_queue_drain` so an item queued under one
/// deployment mode cannot bypass the policy of the mode it drains under.
fn preflight_submit_gate(cfg: &HubConfig, req: &HubSubmitGateRequest) -> Result<(), String> {
    safety::check_submit_gate(req)?;
    if cfg.deployment_mode == HubDeploymentMode::Public {
        // Check the exact network payload so nested frontmatter and future
        // metadata fields cannot bypass a hand-maintained field list.
        safety::check_public_safe(&serialize_submit_gate_payload(req)?)?;
    }
    Ok(())
}

/// Submit one document to the Hub submission gate. Pre-flight safety always
/// runs; with the Hub enabled the POST is attempted immediately and any
/// failure falls back to the durable offline queue (drained by
/// `hub_queue_drain`), so a submit is never lost.
pub fn hub_submit_gate(req: HubSubmitGateRequest) -> Result<HubSubmitGateResponse, String> {
    let root = PathBuf::from(&req.workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;

    if let Err(reason) = preflight_submit_gate(&cfg, &req) {
        return Ok(blocked_by_safety(reason));
    }

    if cfg.enabled {
        match post_submit_gate(&cfg, &req) {
            Ok((gate_id, state)) => {
                return Ok(HubSubmitGateResponse {
                    gate_id,
                    state,
                    queued_at: None,
                    created_at: Some(chrono::Utc::now().to_rfc3339()),
                });
            }
            Err(err) => {
                eprintln!("[hub_client] submit gate POST failed, queueing: {}", err);
            }
        }
    }

    enqueue_submit_gate_admitted(&root, &req)?;
    Ok(HubSubmitGateResponse {
        gate_id: None,
        state: "queued_offline".to_string(),
        queued_at: Some(chrono::Utc::now().to_rfc3339()),
        created_at: None,
    })
}

fn enqueue_submit_gate_admitted(
    root: &std::path::Path,
    req: &HubSubmitGateRequest,
) -> Result<(), String> {
    let queue = cache::queue_root(root);
    with_path_transactions(PathTransactionRequest::new(vec![queue.clone()])?, |lease| {
        lease.ensure_covered(vec![queue])?;
        lease.before_effect()?;
        cache::enqueue_submit_gate(root, req).map_err(|e| e.to_string())?;
        Ok(())
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubQueueDrainItem {
    pub request_id: String,
    pub outcome: String, // "submitted" | "failed"
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubQueueDrainResult {
    pub attempted: usize,
    pub submitted: usize,
    pub failed: usize,
    pub remaining: usize,
    pub items: Vec<HubQueueDrainItem>,
}

/// Drain the durable submit-gate queue oldest-first. Each item is POSTed;
/// success removes it, failure records `retry_count`/`last_error` and keeps
/// it for the next drain. With the Hub disabled this is a no-op that only
/// reports the backlog (`remaining`).
pub fn hub_queue_drain(workspace_root: String) -> Result<HubQueueDrainResult, String> {
    let root = PathBuf::from(&workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;
    let queued = cache::list_queue(&root).map_err(|e| e.to_string())?;

    if !cfg.enabled {
        // Read-only backlog report; no queue file is touched.
        let remaining = cache::queue_depth(&root).unwrap_or(0);
        return Ok(HubQueueDrainResult {
            attempted: 0,
            submitted: 0,
            failed: 0,
            remaining,
            items: Vec::new(),
        });
    }

    let queue = cache::queue_root(&root);
    with_path_transactions(PathTransactionRequest::new(vec![queue])?, |lease| {
        lease.ensure_covered(vec![cache::queue_root(&root)])?;
        lease.before_effect()?;
        hub_queue_drain_in_transaction(&root, &cfg, &queued, lease)
    })
}

fn hub_queue_drain_in_transaction(
    root: &std::path::Path,
    cfg: &HubConfig,
    queued: &[(std::path::PathBuf, cache::QueuedSubmitGate)],
    lease: &PathTransactionLease,
) -> Result<HubQueueDrainResult, String> {
    let mut items = Vec::new();
    let mut submitted = 0usize;
    let mut failed = 0usize;

    for (path, entry) in queued {
        if let Err(reason) = preflight_submit_gate(cfg, &entry.body) {
            let msg = format!("blocked_by_safety:{}", reason);
            let _ = cache::mark_retry(path, &msg);
            failed += 1;
            items.push(HubQueueDrainItem {
                request_id: entry.request_id.clone(),
                outcome: "failed".to_string(),
                error: Some(msg),
            });
            continue;
        }
        match post_submit_gate(cfg, &entry.body) {
            Ok(_) => {
                let _ = cache::remove_queued(path);
                submitted += 1;
                items.push(HubQueueDrainItem {
                    request_id: entry.request_id.clone(),
                    outcome: "submitted".to_string(),
                    error: None,
                });
            }
            Err(err) => {
                let _ = cache::mark_retry(path, &err);
                failed += 1;
                items.push(HubQueueDrainItem {
                    request_id: entry.request_id.clone(),
                    outcome: "failed".to_string(),
                    error: Some(err),
                });
            }
        }
    }
    let _ = lease;

    let remaining = cache::queue_depth(root).unwrap_or(0);
    Ok(HubQueueDrainResult {
        attempted: queued.len(),
        submitted,
        failed,
        remaining,
        items,
    })
}

pub fn hub_poll_gate(workspace_root: String, gate_id: String) -> Result<HubFetchResponse, String> {
    let root = PathBuf::from(&workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;
    let gate_id = sanitize_path_segment(&gate_id)?;
    let params = std::collections::HashMap::new();
    let resource = format!("submission-gates/{gate_id}");

    if !cfg.enabled {
        return cache::load_cached_resource(&cfg.cache_root, &resource, &params)
            .map_err(|e| e.to_string());
    }

    with_path_transactions(
        PathTransactionRequest::new(vec![cfg.cache_root.clone()])?,
        |lease| {
            lease.ensure_covered(vec![cfg.cache_root.clone()])?;
            lease.before_effect()?;
            match http::fetch_with_cache(&cfg, &resource, &params, true) {
                Ok(resp) => Ok(resp),
                Err(err) => {
                    eprintln!("[hub_client] poll gate error ({}): {}", gate_id, err);
                    cache::load_cached_resource(&cfg.cache_root, &resource, &params).map_err(|e| {
                        format!(
                            "hub poll gate failed and cache empty: hub={} cache={}",
                            err, e
                        )
                    })
                }
            }
        },
    )
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn hub_status(workspace_root: String) -> Result<HubStatus, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace_root).join("workspace.config.yaml")],
                "worker:hub_status",
            );
            super::hub_status(workspace_root)
        })
        .await
        .map_err(|err| format!("hub_status_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn hub_fetch_catalog(req: HubFetchRequest) -> Result<HubFetchResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[hub_cache_root(&req)], "worker:hub_fetch_catalog");
            super::hub_fetch_catalog(req)
        })
        .await
        .map_err(|err| format!("hub_fetch_catalog_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn hub_submit_gate(
        req: HubSubmitGateRequest,
    ) -> Result<HubSubmitGateResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[hub_queue_root(&req)], "worker:hub_submit_gate");
            super::hub_submit_gate(req)
        })
        .await
        .map_err(|err| format!("hub_submit_gate_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn hub_queue_drain(workspace_root: String) -> Result<HubQueueDrainResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[cache::queue_root(std::path::Path::new(&workspace_root))],
                "worker:hub_queue_drain",
            );
            super::hub_queue_drain(workspace_root)
        })
        .await
        .map_err(|err| format!("hub_queue_drain_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn hub_poll_gate(
        workspace_root: String,
        gate_id: String,
    ) -> Result<HubFetchResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace_root)
                    .join(".maru")
                    .join("cache")
                    .join("hub")],
                "worker:hub_poll_gate",
            );
            super::hub_poll_gate(workspace_root, gate_id)
        })
        .await
        .map_err(|err| format!("hub_poll_gate_task_failed: {err}"))?
    }
}

#[cfg(test)]
fn hub_cache_root(req: &HubFetchRequest) -> PathBuf {
    PathBuf::from(&req.workspace_root)
        .join(".maru")
        .join("cache")
        .join("hub")
}

#[cfg(test)]
fn hub_queue_root(req: &HubSubmitGateRequest) -> PathBuf {
    cache::queue_root(std::path::Path::new(&req.workspace_root))
}

/// workspace.config.yaml의 hub: 블록을 읽어 HubConfig 생성.
fn load_hub_config(workspace_root: &std::path::Path) -> std::io::Result<HubConfig> {
    let cfg_path = workspace_root.join("workspace.config.yaml");
    let text = std::fs::read_to_string(&cfg_path)?;

    // 가벼운 파싱 (serde_yaml은 lib.rs에 이미 의존성 있음)
    let yaml: serde_yaml::Value = serde_yaml::from_str(&text)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;

    let hub = yaml.get("hub");
    let endpoint = hub
        .and_then(|h| h.get("endpoint"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let enabled = hub
        .and_then(|h| h.get("enabled"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let deployment_mode = hub
        .and_then(|h| h.get("deployment_mode"))
        .and_then(|v| v.as_str())
        .map(|s| match s {
            "public" => HubDeploymentMode::Public,
            _ => HubDeploymentMode::Private,
        })
        .unwrap_or(HubDeploymentMode::Private);
    let timeout_ms = hub
        .and_then(|h| h.get("timeout_ms"))
        .and_then(|v| v.as_u64())
        .unwrap_or(8000);
    let cache_ttl_seconds = hub
        .and_then(|h| h.get("cache"))
        .and_then(|c| c.get("ttl_seconds"))
        .and_then(|v| v.as_u64())
        .unwrap_or(3600);
    let api_token_ref = hub
        .and_then(|h| h.get("api_token_ref"))
        .and_then(|v| v.as_str());
    let api_token = api_token_ref.and_then(|p| {
        let p = expand_tilde(p);
        std::fs::read_to_string(p)
            .ok()
            .map(|s| s.trim().to_string())
    });

    let cache_root = workspace_root.join(".maru").join("cache").join("hub");

    Ok(HubConfig {
        endpoint,
        api_token,
        deployment_mode,
        enabled,
        cache_root,
        timeout_ms,
        cache_ttl_seconds,
    })
}

fn sanitize_path_segment(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty()
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_' || ch == '-')
    {
        return Err("hub_path_segment_invalid".to_string());
    }
    Ok(trimmed.to_string())
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_segment_rejects_unsafe_gate_ids() {
        assert!(sanitize_path_segment("gate_123").is_ok());
        assert!(sanitize_path_segment("gate-123").is_ok());
        assert!(sanitize_path_segment("../gate").is_err());
        assert!(sanitize_path_segment("a/b").is_err());
        assert!(sanitize_path_segment("a?b").is_err());
        assert!(sanitize_path_segment("a#b").is_err());
        assert!(sanitize_path_segment("a%b").is_err());
        assert!(sanitize_path_segment("a:b").is_err());
        assert!(sanitize_path_segment(".gate").is_err());
        assert!(sanitize_path_segment("").is_err());
    }

    fn test_request(root: &std::path::Path) -> HubSubmitGateRequest {
        HubSubmitGateRequest {
            workspace_root: root.to_string_lossy().to_string(),
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

    fn workspace_with_hub_config(yaml: &str) -> tempfile::TempDir {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("workspace.config.yaml"), yaml).unwrap();
        tmp
    }

    #[test]
    fn submit_with_hub_disabled_queues() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n");
        let resp = hub_submit_gate(test_request(tmp.path())).unwrap();
        assert_eq!(resp.state, "queued_offline");
        assert!(resp.gate_id.is_none());
        assert_eq!(cache::queue_depth(tmp.path()).unwrap(), 1);
    }

    #[test]
    fn submit_network_payload_omits_local_workspace_root() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n");
        let req = test_request(tmp.path());
        let payload: serde_json::Value =
            serde_json::from_str(&serialize_submit_gate_payload(&req).unwrap()).unwrap();

        assert!(payload.get("workspace_root").is_none());
        assert_eq!(payload["program_id"], req.program_id);
        assert!(!payload.to_string().contains(&req.workspace_root));
    }

    #[test]
    fn submit_blocked_by_safety_is_not_queued() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n");
        let mut req = test_request(tmp.path());
        req.notes = Some("call 010-1234-5678".to_string());
        let resp = hub_submit_gate(req).unwrap();
        assert!(resp.state.starts_with("blocked_by_safety:"));
        assert_eq!(cache::queue_depth(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn submit_public_mode_blocks_real_names() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n  deployment_mode: public\n");
        let mut req = test_request(tmp.path());
        req.target_org = "KOICA 사업단".to_string();
        let resp = hub_submit_gate(req).unwrap();
        assert!(resp
            .state
            .starts_with("blocked_by_safety:real_name_in_public"));
        assert_eq!(cache::queue_depth(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn submit_public_mode_checks_nested_frontmatter_values() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n  deployment_mode: public\n");
        let mut req = test_request(tmp.path());
        req.frontmatter_snapshot = serde_json::json!({"project": {"label": "Koica demo"}});
        let resp = hub_submit_gate(req).unwrap();
        assert!(resp
            .state
            .starts_with("blocked_by_safety:real_name_in_public"));
        assert_eq!(cache::queue_depth(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn drain_with_hub_disabled_is_noop_reporting_backlog() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n");
        cache::enqueue_submit_gate(tmp.path(), &test_request(tmp.path())).unwrap();

        let result = hub_queue_drain(tmp.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(result.attempted, 0);
        assert_eq!(result.submitted, 0);
        assert_eq!(result.failed, 0);
        assert_eq!(result.remaining, 1);
        assert!(result.items.is_empty());
    }

    #[test]
    fn drain_public_mode_blocks_queued_real_names() {
        // Queued under private mode, drained under public mode: the drain
        // must re-run the public blocklist, not just the base safety check.
        let private_cfg = workspace_with_hub_config("hub:\n  enabled: false\n");
        let mut req = test_request(private_cfg.path());
        req.target_org = "KOICA 사업단".to_string();
        cache::enqueue_submit_gate(private_cfg.path(), &req).unwrap();

        std::fs::write(
            private_cfg.path().join("workspace.config.yaml"),
            "hub:\n  enabled: true\n  deployment_mode: public\n  endpoint: http://10.255.255.1:9/api/v1\n  timeout_ms: 300\n",
        )
        .unwrap();

        let result = hub_queue_drain(private_cfg.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(result.submitted, 0);
        assert_eq!(result.failed, 1);
        assert!(result.items[0]
            .error
            .as_deref()
            .unwrap()
            .contains("real_name_in_public"));
    }

    #[test]
    fn drain_with_unreachable_hub_marks_retry_and_keeps_item() {
        // enabled + unroutable endpoint: every queued item fails the POST and
        // stays queued with retry_count bumped (an RFC1918 blackhole address
        // that fails fast on connect with the short timeout).
        let tmp = workspace_with_hub_config(
            "hub:\n  enabled: true\n  endpoint: http://10.255.255.1:9/api/v1\n  timeout_ms: 300\n",
        );
        cache::enqueue_submit_gate(tmp.path(), &test_request(tmp.path())).unwrap();

        let result = hub_queue_drain(tmp.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(result.attempted, 1);
        assert_eq!(result.submitted, 0);
        assert_eq!(result.failed, 1);
        assert_eq!(result.remaining, 1);

        let items = cache::list_queue(tmp.path()).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].1.retry_count, 1);
        assert!(items[0].1.last_error.is_some());
    }
}

#[cfg(test)]
mod phase08_17 {
    use super::ipc;
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::workspace_files::{ipc as files_ipc, phase08_06::TrashFixture};
    use std::io::{Read, Write};
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &std::path::Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("hub fixture completion")
    }

    fn disabled_workspace(yaml: &str) -> (tempfile::TempDir, String) {
        let tmp = tempfile::TempDir::new().unwrap();
        std::fs::write(tmp.path().join("workspace.config.yaml"), yaml).unwrap();
        let root = text(tmp.path());
        (tmp, root)
    }

    /// Minimal localhost HTTP fixture: answers `requests` connections with a
    /// fixed JSON body and ETag, then stops. No external network is touched.
    struct HubServer {
        endpoint: String,
        handle: Option<std::thread::JoinHandle<()>>,
    }

    impl HubServer {
        fn start(body: &'static str, requests: usize) -> Self {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let handle = std::thread::spawn(move || {
                listener.set_nonblocking(true).unwrap();
                let deadline = std::time::Instant::now() + Duration::from_secs(30);
                let mut served = 0usize;
                while served < requests {
                    let (mut stream, _) = match listener.accept() {
                        Ok(accepted) => accepted,
                        Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => {
                            if std::time::Instant::now() >= deadline {
                                break;
                            }
                            std::thread::sleep(Duration::from_millis(5));
                            continue;
                        }
                        Err(_) => break,
                    };
                    served += 1;
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 1024];
                    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
                        let Ok(n) = stream.read(&mut chunk) else {
                            break;
                        };
                        if n == 0 {
                            break;
                        };
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let head = if String::from_utf8_lossy(&buf)
                        .to_ascii_lowercase()
                        .contains("if-none-match")
                    {
                        "HTTP/1.1 304 Not Modified\r\netag: \"tag-1\"\r\ncontent-length: 0\r\nconnection: close\r\n\r\n".to_string()
                    } else {
                        format!(
                            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\netag: \"tag-1\"\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                            body.len()
                        )
                    };
                    let _ = stream.write_all(head.as_bytes());
                    if !head.starts_with("HTTP/1.1 304") {
                        let _ = stream.write_all(body.as_bytes());
                    }
                }
            });
            Self {
                endpoint: format!("http://127.0.0.1:{port}/api/v1"),
                handle: Some(handle),
            }
        }
    }

    impl Drop for HubServer {
        fn drop(&mut self) {
            if let Some(handle) = self.handle.take() {
                let _ = handle.join();
            }
        }
    }

    fn fetch_templates(root: &str) -> HubFetchRequest {
        HubFetchRequest {
            workspace_root: root.to_string(),
            resource: "templates".to_string(),
            params: std::collections::HashMap::new(),
            revalidate: false,
        }
    }

    #[test]
    fn phase08_17_hub_all_wrappers_round_trip_and_legacy_rejections() {
        let (_tmp, root) = disabled_workspace("hub:\n  enabled: false\n");

        let status = run(ipc::hub_status(root.clone())).unwrap();
        assert!(!status.enabled);
        assert!(!status.reachable);
        assert_eq!(status.queue_depth, 0);

        let fetched = run(ipc::hub_fetch_catalog(fetch_templates(&root))).unwrap();
        assert!(!fetched.from_cache);
        assert!(fetched.body_json.is_empty());

        let submitted = run(ipc::hub_submit_gate(test_request(&root))).unwrap();
        assert_eq!(submitted.state, "queued_offline");
        assert_eq!(cache::queue_depth(std::path::Path::new(&root)).unwrap(), 1);

        let drained = run(ipc::hub_queue_drain(root.clone())).unwrap();
        assert_eq!(drained.attempted, 0);
        assert_eq!(drained.remaining, 1);

        assert_eq!(
            run(ipc::hub_poll_gate(root.clone(), "../gate".into())).unwrap_err(),
            "hub_path_segment_invalid"
        );

        // Online round trips against the local fixture server, covering the
        // admitted cache writes for fetch and poll.
        let server = HubServer::start(r#"{"items":[1,2,3]}"#, 4);
        let (_online_tmp, online_root) = disabled_workspace(&format!(
            "hub:\n  enabled: true\n  endpoint: {}\n  timeout_ms: 2000\n",
            server.endpoint
        ));
        let fetched = run(ipc::hub_fetch_catalog(fetch_templates(&online_root))).unwrap();
        assert!(!fetched.from_cache);
        assert_eq!(fetched.body_json, r#"{"items":[1,2,3]}"#);
        assert!(cache::etag_index_path(&cache_root(&online_root)).is_file());

        let mut revalidated = fetch_templates(&online_root);
        revalidated.revalidate = true;
        let cached = run(ipc::hub_fetch_catalog(revalidated)).unwrap();
        assert!(cached.from_cache);
        assert_eq!(cached.body_json, r#"{"items":[1,2,3]}"#);

        let polled = run(ipc::hub_poll_gate(online_root.clone(), "gate_123".into())).unwrap();
        assert_eq!(polled.body_json, r#"{"items":[1,2,3]}"#);
        assert!(cache::etag_index_path(&cache_root(&online_root)).is_file());

        let submitted = run(ipc::hub_submit_gate(test_request(&online_root))).unwrap();
        assert_eq!(submitted.state, "pending");
        assert!(submitted.gate_id.is_none());
        assert_eq!(
            cache::queue_depth(std::path::Path::new(&online_root)).unwrap(),
            0
        );
    }

    fn cache_root(root: &str) -> PathBuf {
        PathBuf::from(root).join(".maru").join("cache").join("hub")
    }

    fn test_request(root: &str) -> HubSubmitGateRequest {
        HubSubmitGateRequest {
            workspace_root: root.to_string(),
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
    fn phase08_17_hub_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let (_tmp, root) = disabled_workspace("hub:\n  enabled: false\n");
        let config_path = PathBuf::from(&root).join("workspace.config.yaml");
        let queue = cache::queue_root(std::path::Path::new(&root));
        let cache = cache_root(&root);

        boundary(config_path, "hub_status", ipc::hub_status(root.clone()));
        boundary(
            cache.clone(),
            "hub_fetch_catalog",
            ipc::hub_fetch_catalog(fetch_templates(&root)),
        );
        boundary(
            queue.clone(),
            "hub_submit_gate",
            ipc::hub_submit_gate(test_request(&root)),
        );
        boundary(queue, "hub_queue_drain", ipc::hub_queue_drain(root.clone()));
        boundary(
            cache,
            "hub_poll_gate",
            ipc::hub_poll_gate(root, "gate_1".into()),
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_17_hub_queue_parent_both_orders_and_aliases_no_recreation() {
        let home = Home::new();
        let root = home.root.path();
        for parent in ["rename", "trash"] {
            for parent_first in [false, true] {
                for alias in [false, true] {
                    if alias && parent == "trash" {
                        continue;
                    }
                    let fixture = tempfile::tempdir_in(root).unwrap();
                    let fixture_root = fixture.path();
                    std::fs::write(
                        fixture_root.join("workspace.config.yaml"),
                        "hub:\n  enabled: false\n",
                    )
                    .unwrap();
                    let maru_dir = fixture_root.join(".maru");
                    let key = maru_dir.join("queue").join("hub");
                    let external = fixture_root.join("external");
                    std::fs::create_dir(&external).unwrap();
                    let (selected, key) = if alias {
                        std::os::unix::fs::symlink(&external, &maru_dir).unwrap();
                        (external.clone(), key)
                    } else {
                        std::fs::create_dir(&maru_dir).unwrap();
                        (maru_dir.clone(), key)
                    };
                    let trash_target = fixture_root.join("trash-target");
                    let vault = text(fixture_root);
                    let selected_for_parent = selected.clone();
                    let trash_target_for_parent = trash_target.clone();
                    let parent_future = async move {
                        if parent == "rename" {
                            files_ipc::rename_workspace_entry(
                                vault,
                                text(&selected_for_parent),
                                "moved".into(),
                            )
                            .await
                            .map(|outcome| assert!(outcome.error.is_none()))
                        } else {
                            let _trash = TrashFixture::new(
                                selected_for_parent.clone(),
                                trash_target_for_parent.clone(),
                            );
                            files_ipc::trash_workspace_entries(
                                vault,
                                vec![text(&selected_for_parent)],
                            )
                            .await
                            .map(|outcomes| assert!(outcomes[0].error.is_none()))
                        }
                    };
                    let child_future = ipc::hub_submit_gate(test_request(&text(fixture_root)));
                    if parent_first {
                        let held = Held::new(selected.clone(), "pre-effect");
                        let p = start(parent_future);
                        held.wait();
                        let waiting = Held::new(key.clone(), "before-admission");
                        let c = start(child_future);
                        waiting.wait();
                        waiting.release();
                        assert!(c.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        done(p).unwrap();
                        assert!(
                            done(c).is_err(),
                            "{parent}/{alias}: renamed queue parent must fail revalidation"
                        );
                    } else {
                        let held = Held::new(key.clone(), "pre-effect");
                        let c = start(child_future);
                        held.wait();
                        let waiting = Held::new(selected.clone(), "before-admission");
                        let p = start(parent_future);
                        waiting.wait();
                        waiting.release();
                        assert!(p.recv_timeout(Duration::from_millis(20)).is_err());
                        held.release();
                        done(c).unwrap();
                        done(p).unwrap();
                        let moved = if parent == "rename" {
                            fixture_root.join("moved")
                        } else {
                            trash_target.clone()
                        };
                        assert_eq!(
                            std::fs::read_dir(moved.join("queue").join("hub"))
                                .unwrap()
                                .count(),
                            1,
                            "{parent}/{alias}: queued item must land in the moved parent"
                        );
                    }
                    assert!(
                        !selected.exists(),
                        "{parent}/{alias}: original queue parent recreated"
                    );
                }
            }
        }
    }

    #[test]
    fn phase08_17_hub_queue_error_release_and_drain_contention() {
        let (_tmp, root) = disabled_workspace("hub:\n  enabled: false\n");
        let queue = cache::queue_root(std::path::Path::new(&root));

        // An unwinding submit worker releases the admitted queue tree.
        {
            let _panic = PathTransactionTestHook::new(queue.clone(), "pre-effect", || {
                panic!("fixture hub submit unwind")
            });
            assert!(run(ipc::hub_submit_gate(test_request(&root)))
                .unwrap_err()
                .starts_with("hub_submit_gate_task_failed:"));
        }
        let submitted = run(ipc::hub_submit_gate(test_request(&root))).unwrap();
        assert_eq!(submitted.state, "queued_offline");
        assert_eq!(cache::queue_depth(std::path::Path::new(&root)).unwrap(), 1);

        // Drain against an unroutable hub keeps the item; two drains serialize
        // on the admitted queue tree.
        std::fs::write(
            PathBuf::from(&root).join("workspace.config.yaml"),
            "hub:\n  enabled: true\n  endpoint: http://10.255.255.1:9/api/v1\n  timeout_ms: 300\n",
        )
        .unwrap();
        for _round in 0..2 {
            let first = ipc::hub_queue_drain(root.clone());
            let second = ipc::hub_queue_drain(root.clone());
            let held = Held::new(queue.clone(), "pre-effect");
            let a = start(first);
            held.wait();
            let waiting = Held::new(queue.clone(), "before-admission");
            let b = start(second);
            waiting.wait();
            waiting.release();
            assert!(b.recv_timeout(Duration::from_millis(20)).is_err());
            held.release();
            let ra = done(a);
            let rb = done(b);
            assert_eq!(ra.unwrap().attempted, 1);
            assert_eq!(rb.unwrap().attempted, 1);
            assert_eq!(cache::queue_depth(std::path::Path::new(&root)).unwrap(), 1);
        }
        let items = cache::list_queue(std::path::Path::new(&root)).unwrap();
        assert_eq!(items[0].1.retry_count, 4);
    }

    #[cfg(unix)]
    #[test]
    fn phase08_17_hub_cache_fetch_contention_and_parent_revalidation() {
        let home = Home::new();
        let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
        let fixture_root = fixture.path();
        let server = HubServer::start(r#"{"ok":true}"#, 4);
        std::fs::write(
            fixture_root.join("workspace.config.yaml"),
            format!(
                "hub:\n  enabled: true\n  endpoint: {}\n  timeout_ms: 2000\n",
                server.endpoint
            ),
        )
        .unwrap();
        let root = text(fixture_root);
        let cache = cache_root(&root);

        // Same-target cache contention: the second fetch waits at admission
        // until the held first fetch passes pre-effect.
        for _round in 0..2 {
            let first = ipc::hub_fetch_catalog(fetch_templates(&root));
            let second = ipc::hub_fetch_catalog(fetch_templates(&root));
            let held = Held::new(cache.clone(), "pre-effect");
            let a = start(first);
            held.wait();
            let waiting = Held::new(cache.clone(), "before-admission");
            let b = start(second);
            waiting.wait();
            waiting.release();
            assert!(b.recv_timeout(Duration::from_millis(20)).is_err());
            held.release();
            assert_eq!(done(a).unwrap().body_json, r#"{"ok":true}"#);
            assert_eq!(done(b).unwrap().body_json, r#"{"ok":true}"#);
        }
        assert!(cache::etag_index_path(&cache).is_file());

        // Parent rename wins the admission order: a fetch that waited through
        // a Files rename of .maru fails revalidation instead of recreating it.
        let maru_dir = fixture_root.join(".maru");
        let moved = fixture_root.join("maru-moved");
        let held = Held::new(maru_dir.clone(), "pre-effect");
        let vault = text(fixture_root);
        let source = text(&maru_dir);
        let p = start(async move {
            files_ipc::rename_workspace_entry(vault, source, "maru-moved".into())
                .await
                .map(|outcome| assert!(outcome.error.is_none()))
        });
        held.wait();
        let waiting = Held::new(cache.clone(), "before-admission");
        let f = start(ipc::hub_fetch_catalog(fetch_templates(&root)));
        waiting.wait();
        waiting.release();
        assert!(f.recv_timeout(Duration::from_millis(20)).is_err());
        held.release();
        done(p).unwrap();
        assert!(done(f).is_err());
        assert!(moved.is_dir());
        assert!(!fixture_root.join(".maru").exists());
    }
}
