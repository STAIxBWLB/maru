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

#[tauri::command]
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

#[tauri::command]
pub fn hub_fetch_catalog(req: HubFetchRequest) -> Result<HubFetchResponse, String> {
    let root = PathBuf::from(&req.workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;

    if !cfg.enabled {
        // Disabled — 캐시만 반환 (오프라인 fallback).
        return cache::load_cached_resource(&cfg.cache_root, &req.resource, &req.params)
            .map_err(|e| e.to_string());
    }

    // Online path — HTTP GET with ETag revalidation. On error, fall back to
    // the cache so the UI keeps working when the Hub is unreachable.
    match http::fetch_with_cache(&cfg, &req.resource, &req.params, req.revalidate) {
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
#[tauri::command]
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

    cache::enqueue_submit_gate(&root, &req).map_err(|e| e.to_string())?;
    Ok(HubSubmitGateResponse {
        gate_id: None,
        state: "queued_offline".to_string(),
        queued_at: Some(chrono::Utc::now().to_rfc3339()),
        created_at: None,
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
#[tauri::command]
pub fn hub_queue_drain(workspace_root: String) -> Result<HubQueueDrainResult, String> {
    let root = PathBuf::from(&workspace_root);
    let cfg = load_hub_config(&root).map_err(|e| e.to_string())?;
    let queued = cache::list_queue(&root).map_err(|e| e.to_string())?;

    let mut items = Vec::new();
    let mut submitted = 0usize;
    let mut failed = 0usize;

    if cfg.enabled {
        for (path, entry) in &queued {
            if let Err(reason) = preflight_submit_gate(&cfg, &entry.body) {
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
            match post_submit_gate(&cfg, &entry.body) {
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
    }

    let remaining = cache::queue_depth(&root).unwrap_or(0);
    Ok(HubQueueDrainResult {
        attempted: if cfg.enabled { queued.len() } else { 0 },
        submitted,
        failed,
        remaining,
        items,
    })
}

#[tauri::command]
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
        assert!(resp.state.starts_with("blocked_by_safety:real_name_in_public"));
        assert_eq!(cache::queue_depth(tmp.path()).unwrap(), 0);
    }

    #[test]
    fn submit_public_mode_checks_nested_frontmatter_values() {
        let tmp = workspace_with_hub_config("hub:\n  enabled: false\n  deployment_mode: public\n");
        let mut req = test_request(tmp.path());
        req.frontmatter_snapshot = serde_json::json!({"project": {"label": "Koica demo"}});
        let resp = hub_submit_gate(req).unwrap();
        assert!(resp.state.starts_with("blocked_by_safety:real_name_in_public"));
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
