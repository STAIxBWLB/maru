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
    pub deadline: Option<String>,        // YYYY-MM-DD
    pub approval_status: Option<String>, // draft|review|in_review|approved|...
    pub evidence_kind: Option<String>,   // receipt|contract|...
    pub last_updated: String,            // ISO8601
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

        let limit = if q.limit == 0 {
            filtered.len()
        } else {
            q.limit
        };
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


#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn entry(path: &str, kind: CatalogItemKind, deadline: Option<&str>, updated: &str) -> CatalogEntry {
        CatalogEntry {
            path: path.to_string(),
            kind,
            title: path.to_string(),
            business_unit: None,
            category: None,
            deadline: deadline.map(|s| s.to_string()),
            approval_status: None,
            evidence_kind: None,
            last_updated: updated.to_string(),
        }
    }

    #[test]
    fn query_filters_bu_category_and_kinds() {
        let mut with_bu = entry("a.md", CatalogItemKind::DeadlineDue, Some("2026-02-01"), "2026-01-01");
        with_bu.business_unit = Some("bu-a".to_string());
        with_bu.category = Some(DocCategory::FormalReport);
        let mut other_bu = entry("b.md", CatalogItemKind::DeadlineDue, Some("2026-02-02"), "2026-01-02");
        other_bu.business_unit = Some("bu-b".to_string());
        let mut other_kind = entry("c.md", CatalogItemKind::InboxPending, Some("2026-01-15"), "2026-01-03");
        other_kind.business_unit = Some("bu-a".to_string());

        let index = CatalogIndex {
            version: 1,
            generated_at: "2026-01-10T00:00:00Z".to_string(),
            entries: vec![with_bu, other_bu, other_kind],
        };

        let by_bu = index.query(&CatalogQuery {
            business_unit: Some("bu-a".to_string()),
            ..CatalogQuery::default()
        });
        assert_eq!(by_bu.len(), 2);
        assert!(by_bu.iter().all(|e| e.business_unit.as_deref() == Some("bu-a")));

        let by_category = index.query(&CatalogQuery {
            category: Some(DocCategory::FormalReport),
            ..CatalogQuery::default()
        });
        assert_eq!(by_category.len(), 1);
        assert_eq!(by_category[0].path, "a.md");

        let by_kind = index.query(&CatalogQuery {
            kinds: vec![CatalogItemKind::InboxPending],
            ..CatalogQuery::default()
        });
        assert_eq!(by_kind.len(), 1);
        assert_eq!(by_kind[0].path, "c.md");
    }

    #[test]
    fn query_sorts_deadline_first_then_recent_and_honors_limit() {
        let index = CatalogIndex {
            version: 1,
            generated_at: "2026-01-10T00:00:00Z".to_string(),
            entries: vec![
                entry("a.md", CatalogItemKind::DeadlineDue, None, "2026-01-01"),
                entry("b.md", CatalogItemKind::DeadlineDue, Some("2026-03-01"), "2026-01-02"),
                entry("c.md", CatalogItemKind::DeadlineDue, Some("2026-02-01"), "2026-01-03"),
                entry("d.md", CatalogItemKind::DeadlineDue, None, "2026-02-01"),
            ],
        };

        let all = index.query(&CatalogQuery::default());
        let order: Vec<&str> = all.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(order, ["c.md", "b.md", "d.md", "a.md"]);

        let limited = index.query(&CatalogQuery {
            limit: 2,
            ..CatalogQuery::default()
        });
        assert_eq!(limited.len(), 2);
        assert_eq!(limited[0].path, "c.md");
    }

    #[test]
    fn drilldown_extracts_frontmatter_manifest_readme_and_siblings() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let dir = root.join("inbox/items/x");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("doc.md"), "---\ntitle: Hello\n---\nbody text").unwrap();
        std::fs::write(dir.join("manifest.yaml"), "id: 1").unwrap();
        std::fs::write(dir.join("README.md"), "line1\nline2").unwrap();
        std::fs::write(dir.join("other.md"), "sibling").unwrap();

        let resp = drilldown_impl(root, "inbox/items/x/doc.md").unwrap();
        assert_eq!(resp.frontmatter_yaml.as_deref(), Some("title: Hello"));
        assert_eq!(resp.manifest_yaml.as_deref(), Some("id: 1"));
        assert!(resp.readme_excerpt.as_deref().unwrap().contains("line2"));
        assert!(resp.related_paths.iter().any(|p| p.ends_with("other.md")));
        // The entry itself is excluded from its own related list.
        assert!(!resp.related_paths.iter().any(|p| p.ends_with("doc.md")));
    }

    #[test]
    fn drilldown_missing_entry_returns_default() {
        let tmp = TempDir::new().unwrap();
        let resp = drilldown_impl(tmp.path(), "nope.md").unwrap();
        assert!(resp.frontmatter_yaml.is_none());
        assert!(resp.manifest_yaml.is_none());
        assert!(resp.related_paths.is_empty());
    }
}
