//! vault_graph — enrichment reader for `<vault>/reports/vault-graph.json`.
//!
//! The knowledge-graph JSON is produced by build-graph.py (skills/lib/) on the
//! weekly ritual. The app never builds the graph itself — the live graph comes
//! from `VaultEntry.links` in the frontend; this file only supplies the
//! community overlay (maru-vault-graph-spec §2.1 / work repo
//! `_meta/rules/knowledge-graph-integration.md` schema-freeze table).
//!
//! Contract: absent file → `Ok(None)` (UI degrades to live graph), corrupt →
//! `Err` (UI also degrades, but surfaces the reason). NetworkX ≥3.4 writes the
//! edge list under `"edges"`, older versions under `"links"` — accept both.

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::atomic_file::write_atomic;
use crate::vault::resolve_inside_vault;

/// Relative path of the disposable layout cache inside a workspace.
const LAYOUT_CACHE_REL: &[&str] = &[".maru", "cache", "graph-layout.json"];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultGraphNode {
    pub id: String,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub community: Option<i64>,
    #[serde(rename = "type", default)]
    pub node_type: Option<String>,
    #[serde(default)]
    pub domain: Option<String>,
    #[serde(default)]
    pub source_file: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultGraphEdge {
    pub source: String,
    pub target: String,
    #[serde(default)]
    pub relation: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultGraphFile {
    #[serde(default)]
    pub nodes: Vec<VaultGraphNode>,
    #[serde(alias = "links", default)]
    pub edges: Vec<VaultGraphEdge>,
}

#[tauri::command]
pub fn vault_graph_read(
    vault_path: String,
    source: Option<String>,
) -> Result<Option<VaultGraphFile>, String> {
    let report = match source.as_deref() {
        Some("workspace") => "reports/workspace-graph.json",
        _ => "reports/vault-graph.json",
    };
    let path = resolve_inside_vault(&vault_path, report)?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw =
        std::fs::read_to_string(&path).map_err(|err| format!("Cannot read {report}: {err}"))?;
    let parsed: VaultGraphFile =
        serde_json::from_str(&raw).map_err(|err| format!("Cannot parse {report}: {err}"))?;
    Ok(Some(parsed))
}

/// Persisted graph layout — node id → [x, y]. Disposable cache under
/// `<workspace>/.maru/cache/graph-layout.json`; the filesystem/live graph is
/// authoritative, this only warm-starts the force layout on re-entry.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayoutCache {
    #[serde(default)]
    pub version: u32,
    #[serde(default)]
    pub positions: BTreeMap<String, [f64; 2]>,
    #[serde(default)]
    pub pinned_ids: BTreeSet<String>,
}

fn layout_cache_path(workspace: &str) -> PathBuf {
    LAYOUT_CACHE_REL
        .iter()
        .fold(Path::new(workspace).to_path_buf(), |acc, part| {
            acc.join(part)
        })
}

#[tauri::command]
pub fn vault_graph_layout_read(workspace: String) -> Result<Option<GraphLayoutCache>, String> {
    let path = layout_cache_path(&workspace);
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read graph-layout.json: {err}"))?;
    // A corrupt disposable cache degrades to "no seed", never an error toast.
    let mut cache = match serde_json::from_str::<GraphLayoutCache>(&raw) {
        Ok(cache) => cache,
        Err(_) => return Ok(None),
    };
    if cache.version < 2 {
        cache.version = 2;
    }
    Ok(Some(cache))
}

#[tauri::command]
pub fn vault_graph_layout_save(
    workspace: String,
    mut cache: GraphLayoutCache,
) -> Result<(), String> {
    let path = layout_cache_path(&workspace);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create graph layout cache directory: {err}"))?;
    }
    // The client sends every current node's position (V4 filters by visibility,
    // not topology), so the map is already complete — merging the prior on-disk
    // positions would only re-accrete ids for deleted/renamed notes forever.
    cache.version = 2;
    let serialized = serde_json::to_string(&cache)
        .map_err(|err| format!("Cannot serialize graph layout cache: {err}"))?;
    write_atomic(&path, serialized.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn vault_with_reports() -> (TempDir, String) {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("reports")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        (tmp, root)
    }

    #[test]
    fn reads_networkx_modern_edges_form() {
        let (tmp, root) = vault_with_reports();
        fs::write(
            tmp.path().join("reports/vault-graph.json"),
            r#"{"directed": false, "multigraph": false, "graph": {},
                "nodes": [{"id": "a-note", "label": "A Note", "type": "insight",
                            "domain": "research", "community": 3,
                            "source_file": "notes/a-note.md", "topics": "projects"}],
                "edges": [{"source": "a-note", "target": "b-note",
                            "relation": "wiki_link", "confidence": 1.0,
                            "confidence_tag": "EXTRACTED"}]}"#,
        )
        .unwrap();
        let graph = vault_graph_read(root, None).unwrap().unwrap();
        assert_eq!(graph.nodes.len(), 1);
        assert_eq!(graph.nodes[0].community, Some(3));
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].relation.as_deref(), Some("wiki_link"));
    }

    #[test]
    fn reads_legacy_links_alias() {
        let (tmp, root) = vault_with_reports();
        fs::write(
            tmp.path().join("reports/vault-graph.json"),
            r#"{"nodes": [{"id": "a"}],
                "links": [{"source": "a", "target": "b"}]}"#,
        )
        .unwrap();
        let graph = vault_graph_read(root, None).unwrap().unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].target, "b");
    }

    #[test]
    fn absent_file_is_ok_none() {
        let (_tmp, root) = vault_with_reports();
        assert!(vault_graph_read(root, None).unwrap().is_none());
    }

    #[test]
    fn corrupt_file_is_err() {
        let (tmp, root) = vault_with_reports();
        fs::write(tmp.path().join("reports/vault-graph.json"), "{not json").unwrap();
        assert!(vault_graph_read(root, None).is_err());
    }

    #[test]
    fn layout_cache_round_trips() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert!(vault_graph_layout_read(root.clone()).unwrap().is_none());

        let mut positions = BTreeMap::new();
        positions.insert("a-note".to_string(), [12.5, -4.0]);
        positions.insert("b-note".to_string(), [0.0, 100.0]);
        let cache = GraphLayoutCache {
            version: 1,
            positions,
            pinned_ids: BTreeSet::from(["a-note".to_string()]),
        };
        vault_graph_layout_save(root.clone(), cache).unwrap();

        let read = vault_graph_layout_read(root).unwrap().unwrap();
        assert_eq!(read.version, 2);
        assert_eq!(read.positions.get("a-note"), Some(&[12.5, -4.0]));
        assert_eq!(read.positions.len(), 2);
        assert!(read.pinned_ids.contains("a-note"));
    }

    #[test]
    fn layout_cache_save_prunes_stale_ids() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let mut first = BTreeMap::new();
        first.insert("gone".to_string(), [1.0, 1.0]);
        first.insert("kept".to_string(), [2.0, 2.0]);
        vault_graph_layout_save(
            root.clone(),
            GraphLayoutCache {
                version: 2,
                positions: first,
                pinned_ids: BTreeSet::new(),
            },
        )
        .unwrap();

        let mut second = BTreeMap::new();
        second.insert("kept".to_string(), [3.0, 3.0]);
        vault_graph_layout_save(
            root.clone(),
            GraphLayoutCache {
                version: 2,
                positions: second,
                pinned_ids: BTreeSet::new(),
            },
        )
        .unwrap();

        let read = vault_graph_layout_read(root).unwrap().unwrap();
        assert_eq!(read.positions.len(), 1, "deleted-note id must not linger");
        assert_eq!(read.positions.get("kept"), Some(&[3.0, 3.0]));
    }

    #[test]
    fn corrupt_layout_cache_degrades_to_none() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let path = layout_cache_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "{not json").unwrap();
        // Disposable cache: corruption is a miss, not an error.
        assert!(vault_graph_layout_read(root).unwrap().is_none());
    }

    #[test]
    fn community_absent_tolerated() {
        // Hub nodes are excluded from Leiden clustering and carry no community.
        let (tmp, root) = vault_with_reports();
        fs::write(
            tmp.path().join("reports/vault-graph.json"),
            r#"{"nodes": [{"id": "projects", "type": "moc"}], "edges": []}"#,
        )
        .unwrap();
        let graph = vault_graph_read(root, None).unwrap().unwrap();
        assert_eq!(graph.nodes[0].community, None);
        assert_eq!(graph.nodes[0].node_type.as_deref(), Some("moc"));
    }
}
