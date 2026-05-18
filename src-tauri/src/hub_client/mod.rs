// M7 Hub Connector (Phase 3 read, Phase 6 write)
//
// Anchor → Anchor Hub (read-mirror) 통신.
// 본문/원본 binary/개인정보 업로드 금지.
//
// Spec: ~/workspace/work/_sys/rules/hub-sync.md + plan §M7

pub mod catalog;
pub mod cache;
pub mod safety;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use catalog::{HubCatalog, HubTemplate, HubGuideline, HubGlossaryTerm};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubConfig {
    pub endpoint: String,
    pub api_token: Option<String>,
    pub deployment_mode: HubDeploymentMode,
    pub enabled: bool,
    pub cache_root: PathBuf,
    pub timeout_ms: u64,
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

    Ok(HubStatus {
        enabled: cfg.enabled,
        endpoint: cfg.endpoint.clone(),
        deployment_mode: cfg.deployment_mode,
        reachable: false, // 실제 health check은 W4에 구현
        cached_etags_count: cached.len(),
        last_fetch_at: cache::last_fetch_at(&cfg.cache_root).ok(),
        queue_depth,
    })
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
        // Disabled — 캐시만 반환
        return cache::load_cached_resource(&cfg.cache_root, &req.resource, &req.params)
            .map_err(|e| e.to_string());
    }

    // 실제 fetch는 W3-W4에 구현 (reqwest 의존성 추가 필요)
    // 현재 stub: 캐시 반환
    cache::load_cached_resource(&cfg.cache_root, &req.resource, &req.params)
        .map_err(|e| e.to_string())
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

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HubSubmitGateResponse {
    pub gate_id: Option<String>,
    pub state: String, // "pending" | "queued_offline" | "blocked_by_safety"
    pub queued_at: Option<String>,
    pub created_at: Option<String>,
}

/// Phase 6 W19에 활성화. Phase 3에서는 safety check만 동작 (실 호출은 큐로).
#[tauri::command]
pub fn hub_submit_gate(req: HubSubmitGateRequest) -> Result<HubSubmitGateResponse, String> {
    // Pre-flight safety check (hub-sync.md §9)
    if let Err(reason) = safety::check_submit_gate(&req) {
        return Ok(HubSubmitGateResponse {
            gate_id: None,
            state: format!("blocked_by_safety:{}", reason),
            queued_at: None,
            created_at: None,
        });
    }

    // Phase 3: 항상 큐로 (offline-first). Phase 6에서 즉시 POST 경로 추가.
    let root = PathBuf::from(&req.workspace_root);
    cache::enqueue_submit_gate(&root, &req).map_err(|e| e.to_string())?;

    Ok(HubSubmitGateResponse {
        gate_id: None,
        state: "queued_offline".to_string(),
        queued_at: Some(chrono::Utc::now().to_rfc3339()),
        created_at: None,
    })
}

#[tauri::command]
pub fn hub_poll_gate(_workspace_root: String, _gate_id: String) -> Result<HubFetchResponse, String> {
    // Phase 6 W20에 구현
    Err("hub_poll_gate: not implemented in Phase 3 scaffold".to_string())
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
    let api_token_ref = hub
        .and_then(|h| h.get("api_token_ref"))
        .and_then(|v| v.as_str());
    let api_token = api_token_ref.and_then(|p| {
        let p = expand_tilde(p);
        std::fs::read_to_string(p).ok().map(|s| s.trim().to_string())
    });

    let cache_root = workspace_root
        .join(".anchor")
        .join("cache")
        .join("hub");

    Ok(HubConfig {
        endpoint,
        api_token,
        deployment_mode,
        enabled,
        cache_root,
        timeout_ms,
    })
}

fn expand_tilde(p: &str) -> PathBuf {
    if let Some(rest) = p.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(p)
}
