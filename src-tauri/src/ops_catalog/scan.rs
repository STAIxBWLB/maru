// Operations Catalog scan (Phase 3 W1 scaffold).
//
// 입력 소스 (plan §M1):
//   - project-registry.yaml → 활성 프로젝트 목록
//   - tasks/active/ + tasks/calendar/ → 마감 임박
//   - inbox/items/pending/*/manifest.yaml → 미처리 inbox
//   - projects/*/README.md + admin/*/README.md → 사업/조직 메타
//   - projects/*/.anchor/bu-config.yaml → BU 트리 매핑
//   - frontmatter 스캔 → 결재 진행 중, 미연결 증빙

use serde::{Deserialize, Serialize};
use std::io;
use std::path::{Path, PathBuf};

use super::{catalog_cache_path, index::{CatalogIndex, CatalogEntry}, CatalogItemKind};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct CatalogScanReport {
    pub scanned_at: String,
    pub entries_count: usize,
    pub by_kind: std::collections::HashMap<String, usize>,
    pub bus_seen: Vec<String>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
}

/// 전체 인덱싱. force_refresh=false면 캐시 유효성 확인 후 그대로 반환.
///
/// **Phase 3 W1 stub**: 골격만 작성. 실제 스캔 로직은 W2-W3에 구현.
pub fn scan_catalog_impl(
    workspace_root: &Path,
    _force_refresh: bool,
) -> io::Result<CatalogScanReport> {
    let started = std::time::Instant::now();
    let mut warnings = Vec::new();

    // 1. project-registry.yaml 로드
    let registry_path = workspace_root.join("project-registry.yaml");
    if !registry_path.exists() {
        warnings.push(format!("project-registry.yaml not found at {}", registry_path.display()));
    }

    // 2. BU configs 수집 (projects/**/.anchor/bu-config.yaml)
    let bus_seen = collect_bu_configs(workspace_root, &mut warnings);

    // 3-6. 추후 W2-W3 구현:
    //   - tasks 스캔 → TaskDue 엔트리
    //   - inbox manifests 스캔 → InboxPending 엔트리
    //   - frontmatter 스캔 → DeadlineDue, ApprovalInFlight 엔트리
    //   - binary 사이드카 검토 → EvidenceUnlinked

    let index = CatalogIndex::default();
    let cache_path = catalog_cache_path(workspace_root);
    if let Some(parent) = cache_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_string_pretty(&index)
        .map_err(|e| io::Error::new(io::ErrorKind::Other, e))?;
    std::fs::write(&cache_path, json)?;

    let report = CatalogScanReport {
        scanned_at: chrono::Utc::now().to_rfc3339(),
        entries_count: index.entries.len(),
        by_kind: std::collections::HashMap::new(),
        bus_seen,
        warnings,
        elapsed_ms: started.elapsed().as_millis() as u64,
    };
    Ok(report)
}

/// projects/**/.anchor/bu-config.yaml + admin/**/.anchor/bu-config.yaml 수집.
///
/// bu_id 만 추출하고 상세 매핑은 index.rs에서 사용.
fn collect_bu_configs(workspace_root: &Path, warnings: &mut Vec<String>) -> Vec<String> {
    let mut bus = Vec::new();
    let candidates: Vec<PathBuf> = [
        workspace_root.join("projects"),
        workspace_root.join("admin"),
    ]
    .into_iter()
    .collect();

    for base in candidates {
        if !base.exists() {
            continue;
        }
        // walkdir 사용 — 신규 의존성 필요 시 Cargo.toml에 walkdir 추가
        // 현재는 stub: 직접 1-depth만 스캔
        match std::fs::read_dir(&base) {
            Ok(entries) => {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        let cfg = path.join(".anchor").join("bu-config.yaml");
                        if cfg.exists() {
                            if let Some(id) = parse_bu_id(&cfg) {
                                bus.push(id);
                            }
                        }
                    }
                }
            }
            Err(e) => warnings.push(format!("cannot read {}: {}", base.display(), e)),
        }
    }
    bus.sort();
    bus.dedup();
    bus
}

fn parse_bu_id(cfg_path: &Path) -> Option<String> {
    let content = std::fs::read_to_string(cfg_path).ok()?;
    for line in content.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("bu_id:") {
            return Some(rest.trim().trim_matches('"').to_string());
        }
    }
    None
}

#[allow(dead_code)]
pub(crate) fn empty_entry_for_test() -> CatalogEntry {
    CatalogEntry {
        path: String::new(),
        kind: CatalogItemKind::DeadlineDue,
        title: String::new(),
        business_unit: None,
        category: None,
        deadline: None,
        approval_status: None,
        evidence_kind: None,
        last_updated: String::new(),
    }
}
