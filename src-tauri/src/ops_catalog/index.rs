// Operations Catalog index types + query + drilldown.

use serde::{Deserialize, Serialize};
use std::io;
use std::path::Path;

use super::{catalog_cache_path, CatalogDrilldownResponse, CatalogItemKind, DocCategory};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CatalogIndex {
    pub version: u32,
    pub generated_at: String,
    pub entries: Vec<CatalogEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    /// workspace-relative path (예: "projects/oda-koica-tiu/.../CR-2026-02.md")
    pub path: String,
    pub kind: CatalogItemKind,
    pub title: String,
    pub business_unit: Option<String>,
    pub category: Option<DocCategory>,
    pub deadline: Option<String>,         // YYYY-MM-DD
    pub approval_status: Option<String>,  // draft|review|in_review|approved|...
    pub evidence_kind: Option<String>,    // receipt|contract|...
    pub last_updated: String,             // ISO8601
}

#[derive(Debug, Clone, Default)]
pub struct CatalogQuery {
    pub business_unit: Option<String>,
    pub category: Option<DocCategory>,
    pub kinds: Vec<CatalogItemKind>,
    pub limit: usize,
}

impl CatalogIndex {
    pub fn query(&self, q: &CatalogQuery) -> Vec<CatalogEntry> {
        let mut filtered: Vec<&CatalogEntry> = self
            .entries
            .iter()
            .filter(|e| {
                q.business_unit
                    .as_ref()
                    .map_or(true, |bu| e.business_unit.as_deref() == Some(bu.as_str()))
            })
            .filter(|e| {
                q.category
                    .as_ref()
                    .map_or(true, |c| e.category.as_ref() == Some(c))
            })
            .filter(|e| q.kinds.is_empty() || q.kinds.contains(&e.kind))
            .collect();

        // 정렬: deadline 우선(임박순), 그 다음 last_updated 최신순
        filtered.sort_by(|a, b| match (&a.deadline, &b.deadline) {
            (Some(x), Some(y)) => x.cmp(y),
            (Some(_), None) => std::cmp::Ordering::Less,
            (None, Some(_)) => std::cmp::Ordering::Greater,
            (None, None) => b.last_updated.cmp(&a.last_updated),
        });

        let limit = if q.limit == 0 { filtered.len() } else { q.limit };
        filtered.into_iter().take(limit).cloned().collect()
    }
}

pub fn load_or_empty(workspace_root: &Path) -> io::Result<CatalogIndex> {
    let path = catalog_cache_path(workspace_root);
    if !path.exists() {
        return Ok(CatalogIndex::default());
    }
    let text = std::fs::read_to_string(&path)?;
    serde_json::from_str(&text).map_err(|e| io::Error::new(io::ErrorKind::Other, e))
}

pub fn drilldown_impl(
    workspace_root: &Path,
    entry_path: &str,
) -> io::Result<CatalogDrilldownResponse> {
    let full = workspace_root.join(entry_path);
    let mut resp = CatalogDrilldownResponse::default();

    if !full.exists() {
        return Ok(resp);
    }

    // frontmatter 추출 (--- ... --- 블록)
    if let Ok(content) = std::fs::read_to_string(&full) {
        if content.starts_with("---\n") {
            if let Some(end) = content[4..].find("\n---") {
                resp.frontmatter_yaml = Some(content[4..4 + end].to_string());
            }
        }
    }

    // 인접 manifest.yaml (inbox manifest 또는 산출물 manifest)
    if let Some(parent) = full.parent() {
        let manifest = parent.join("manifest.yaml");
        if manifest.exists() {
            resp.manifest_yaml = std::fs::read_to_string(&manifest).ok();
        }
        let readme = parent.join("README.md");
        if readme.exists() {
            if let Ok(text) = std::fs::read_to_string(&readme) {
                let excerpt: String = text.lines().take(40).collect::<Vec<_>>().join("\n");
                resp.readme_excerpt = Some(excerpt);
            }
        }
        // 같은 디렉토리의 형제 파일들을 related로 표시
        if let Ok(siblings) = std::fs::read_dir(parent) {
            for s in siblings.flatten() {
                let sp = s.path();
                if sp == full {
                    continue;
                }
                if let Ok(rel) = sp.strip_prefix(workspace_root) {
                    resp.related_paths.push(rel.to_string_lossy().to_string());
                }
            }
        }
    }

    Ok(resp)
}
