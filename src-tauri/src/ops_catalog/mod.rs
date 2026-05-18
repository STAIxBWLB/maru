// M1 Operations Catalog (Phase 3)
//
// Indexes project-registry.yaml + tasks + inbox manifests + project/admin READMEs
// into a single Catalog view (deadlines, in-flight approvals, unlinked evidence).
//
// Spec: ~/workspace/work/_sys/rules/bu-lifecycle.md + plan §M1
//
// Cache: <workspace>/.anchor/cache/catalog.json (gitignored)

pub mod scan;
pub mod index;

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

pub use scan::{CatalogScanReport, scan_catalog_impl};
pub use index::{CatalogIndex, CatalogEntry, CatalogQuery};

/// Operations Catalog 캐시 경로 헬퍼.
pub(crate) fn catalog_cache_path(workspace_root: &std::path::Path) -> PathBuf {
    workspace_root.join(".anchor").join("cache").join("catalog.json")
}

/// 4 doc categories (frontmatter-schema.md §3).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum DocCategory {
    FormalReport,
    AdminApproval,
    EvidenceCert,
    Operations,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum CatalogItemKind {
    /// 마감 임박 문서 (frontmatter.deadline ≤ 14d).
    DeadlineDue,
    /// 결재 진행 중 (frontmatter.approval.status ∈ [review, in_review]).
    ApprovalInFlight,
    /// 미연결 증빙 후보 (binary or inbox manifest, no evidence_links parent).
    EvidenceUnlinked,
    /// inbox pending 항목.
    InboxPending,
    /// tasks 마감 임박.
    TaskDue,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogScanRequest {
    pub workspace_root: String,
    /// false면 캐시 사용; true면 강제 재인덱싱.
    #[serde(default)]
    pub force_refresh: bool,
}

#[tauri::command]
pub fn catalog_scan(req: CatalogScanRequest) -> Result<CatalogScanReport, String> {
    let root = PathBuf::from(&req.workspace_root);
    scan_catalog_impl(&root, req.force_refresh).map_err(|e| e.to_string())
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogQueryRequest {
    pub workspace_root: String,
    #[serde(default)]
    pub business_unit: Option<String>,
    #[serde(default)]
    pub category: Option<DocCategory>,
    #[serde(default)]
    pub kinds: Option<Vec<CatalogItemKind>>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[tauri::command]
pub fn catalog_query(req: CatalogQueryRequest) -> Result<Vec<CatalogEntry>, String> {
    let root = PathBuf::from(&req.workspace_root);
    let index = index::load_or_empty(&root).map_err(|e| e.to_string())?;
    let q = CatalogQuery {
        business_unit: req.business_unit,
        category: req.category,
        kinds: req.kinds.unwrap_or_default(),
        limit: req.limit.unwrap_or(200),
    };
    Ok(index.query(&q))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogDrilldownRequest {
    pub workspace_root: String,
    /// CatalogEntry.path (relative to workspace).
    pub entry_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CatalogDrilldownResponse {
    pub frontmatter_yaml: Option<String>,
    pub manifest_yaml: Option<String>,
    pub readme_excerpt: Option<String>,
    pub related_paths: Vec<String>,
}

#[tauri::command]
pub fn catalog_drilldown(
    req: CatalogDrilldownRequest,
) -> Result<CatalogDrilldownResponse, String> {
    let root = PathBuf::from(&req.workspace_root);
    index::drilldown_impl(&root, &req.entry_path).map_err(|e| e.to_string())
}
