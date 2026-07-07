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

use serde::{Deserialize, Serialize};

use crate::vault::resolve_inside_vault;

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
pub fn vault_graph_read(vault_path: String) -> Result<Option<VaultGraphFile>, String> {
    let path = resolve_inside_vault(&vault_path, "reports/vault-graph.json")?;
    if !path.is_file() {
        return Ok(None);
    }
    let raw = std::fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read vault-graph.json: {err}"))?;
    let parsed: VaultGraphFile = serde_json::from_str(&raw)
        .map_err(|err| format!("Cannot parse vault-graph.json: {err}"))?;
    Ok(Some(parsed))
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
        let graph = vault_graph_read(root).unwrap().unwrap();
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
        let graph = vault_graph_read(root).unwrap().unwrap();
        assert_eq!(graph.edges.len(), 1);
        assert_eq!(graph.edges[0].target, "b");
    }

    #[test]
    fn absent_file_is_ok_none() {
        let (_tmp, root) = vault_with_reports();
        assert!(vault_graph_read(root).unwrap().is_none());
    }

    #[test]
    fn corrupt_file_is_err() {
        let (tmp, root) = vault_with_reports();
        fs::write(tmp.path().join("reports/vault-graph.json"), "{not json").unwrap();
        assert!(vault_graph_read(root).is_err());
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
        let graph = vault_graph_read(root).unwrap().unwrap();
        assert_eq!(graph.nodes[0].community, None);
        assert_eq!(graph.nodes[0].node_type.as_deref(), Some("moc"));
    }
}
