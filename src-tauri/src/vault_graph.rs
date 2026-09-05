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

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::vault::{normalize_existing_dir, resolve_inside_vault};

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

pub fn vault_graph_read(
    vault_path: String,
    source: Option<String>,
) -> Result<Option<VaultGraphFile>, String> {
    let report = match source.as_deref() {
        Some("workspace") => "reports/workspace-graph.json",
        _ => "reports/vault-graph.json",
    };
    // The vault is the workspace root, or a `vault/` submodule inside it
    // (work-repo layout). Root wins so an existing report is never shadowed.
    for rel in [report.to_string(), format!("vault/{report}")] {
        let path = resolve_inside_vault(&vault_path, &rel)?;
        if !path.is_file() {
            continue;
        }
        let raw =
            std::fs::read_to_string(&path).map_err(|err| format!("Cannot read {rel}: {err}"))?;
        let parsed: VaultGraphFile =
            serde_json::from_str(&raw).map_err(|err| format!("Cannot parse {rel}: {err}"))?;
        return Ok(Some(parsed));
    }
    Ok(None)
}

/// `<workspace>/vault` when that looks like the managed vault — a `reports/`
/// or `notes/` subdirectory must exist, so an unrelated `vault/` folder (an
/// Obsidian vault, an export dir) cannot hijack the Vault graph source.
/// `None` means the workspace is its own vault. A root-level
/// `reports/vault-graph.json` also forces `None`: reads prefer the root, so
/// the Vault source must stay there too or the overlay and the scanned
/// entries would come from different trees.
pub fn vault_graph_root(workspace: String) -> Option<String> {
    let root = Path::new(&workspace);
    if root.join("reports/vault-graph.json").is_file() {
        return None;
    }
    let nested = root.join("vault");
    (nested.join("reports").is_dir() || nested.join("notes").is_dir())
        .then(|| nested.to_string_lossy().into_owned())
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

pub fn vault_graph_layout_save(workspace: String, cache: GraphLayoutCache) -> Result<(), String> {
    let root = normalize_existing_dir(&workspace)?;
    let path = layout_cache_path(&workspace);
    // Reserve both selected lexical and resolved endpoints, including an exact
    // cache-file alias and its atomic temporary-file allocation directory.
    let mut paths = vec![
        path.clone(),
        path.parent().unwrap().to_path_buf(),
        layout_cache_path(&root.to_string_lossy()),
    ];
    if !root.join(".maru").exists() {
        paths.extend([PathBuf::from(&workspace).join(".maru"), root.join(".maru")]);
    }
    // Pin existing physical cache parents too, including a cache-file symlink.
    paths.extend(
        paths
            .clone()
            .into_iter()
            .filter_map(|path| path.canonicalize().ok()),
    );
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&workspace))?
        .require_parent(&root)?;
    with_path_transactions(request, |lease| {
        vault_graph_layout_save_in_transaction(lease, workspace, cache)
    })
}

fn vault_graph_layout_save_in_transaction(
    lease: &PathTransactionLease,
    workspace: String,
    mut cache: GraphLayoutCache,
) -> Result<(), String> {
    normalize_existing_dir(&workspace)?;
    let path = layout_cache_path(&workspace);
    lease.ensure_covered(vec![path.clone(), path.parent().unwrap().to_path_buf()])?;
    // The client supplies the complete current node set: never merge stale ids.
    cache.version = 2;
    let serialized = serde_json::to_string(&cache)
        .map_err(|err| format!("Cannot serialize graph layout cache: {err}"))?;
    lease.before_effect()?;
    std::fs::create_dir_all(path.parent().unwrap())
        .map_err(|err| format!("Cannot create graph layout cache directory: {err}"))?;
    write_atomic(&path, serialized.as_bytes())
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn vault_graph_read(
        vault_path: String,
        source: Option<String>,
    ) -> Result<Option<VaultGraphFile>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:vault_graph_read",
            );
            super::vault_graph_read(vault_path, source)
        })
        .await
        .map_err(|err| format!("vault_graph_read_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn vault_graph_root(workspace: String) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:vault_graph_root",
            );
            super::vault_graph_root(workspace)
        })
        .await
        .map_err(|err| format!("vault_graph_root_task_failed: {err}"))
    }

    #[tauri::command]
    pub async fn vault_graph_layout_read(
        workspace: String,
    ) -> Result<Option<GraphLayoutCache>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:vault_graph_layout_read",
            );
            super::vault_graph_layout_read(workspace)
        })
        .await
        .map_err(|err| format!("vault_graph_layout_read_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn vault_graph_layout_save(
        workspace: String,
        cache: GraphLayoutCache,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:vault_graph_layout_save",
            );
            super::vault_graph_layout_save(workspace, cache)
        })
        .await
        .map_err(|err| format!("vault_graph_layout_save_task_failed: {err}"))?
    }
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
    fn reads_report_from_nested_vault_submodule() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("vault/reports")).unwrap();
        fs::write(
            tmp.path().join("vault/reports/workspace-graph.json"),
            r#"{"nodes": [{"id": "a", "community": 7}], "edges": []}"#,
        )
        .unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let graph = vault_graph_read(root, Some("workspace".into()))
            .unwrap()
            .unwrap();
        assert_eq!(graph.nodes[0].community, Some(7));
    }

    #[test]
    fn root_report_wins_over_nested_vault() {
        let (tmp, root) = vault_with_reports();
        fs::create_dir_all(tmp.path().join("vault/reports")).unwrap();
        fs::write(
            tmp.path().join("reports/vault-graph.json"),
            r#"{"nodes": [{"id": "root", "community": 1}], "edges": []}"#,
        )
        .unwrap();
        fs::write(
            tmp.path().join("vault/reports/vault-graph.json"),
            r#"{"nodes": [{"id": "nested", "community": 2}], "edges": []}"#,
        )
        .unwrap();
        let graph = vault_graph_read(root, None).unwrap().unwrap();
        assert_eq!(graph.nodes[0].id, "root");
    }

    #[test]
    fn vault_graph_root_reports_nested_submodule_only() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert_eq!(vault_graph_root(root.clone()), None);
        // A bare `vault/` folder is not evidence — it must look like the
        // managed vault (`reports/` or `notes/`) to qualify.
        fs::create_dir_all(tmp.path().join("vault")).unwrap();
        assert_eq!(vault_graph_root(root.clone()), None);
        fs::create_dir_all(tmp.path().join("vault/notes")).unwrap();
        assert_eq!(
            vault_graph_root(root),
            Some(tmp.path().join("vault").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn vault_graph_root_accepts_nested_reports_dir() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("vault/reports")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert_eq!(
            vault_graph_root(root),
            Some(tmp.path().join("vault").to_string_lossy().into_owned())
        );
    }

    #[test]
    fn vault_graph_root_defers_to_root_report() {
        // Root-level report wins every read, so the Vault source must not be
        // rerouted into the submodule even when one exists.
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("reports")).unwrap();
        fs::write(
            tmp.path().join("reports/vault-graph.json"),
            r#"{"nodes": []}"#,
        )
        .unwrap();
        fs::create_dir_all(tmp.path().join("vault/notes")).unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        assert_eq!(vault_graph_root(root), None);
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

#[cfg(test)]
mod phase08_13 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Home};
    use std::fs;

    #[test]
    fn phase08_13_graph_wrappers_yield_same_task_and_report_join_failure() {
        let home = Home::new();
        let root = home.root.path().to_string_lossy().into_owned();
        boundary(
            root.clone().into(),
            "vault_graph_read",
            ipc::vault_graph_read(root.clone(), None),
        );
        boundary(
            root.clone().into(),
            "vault_graph_root",
            ipc::vault_graph_root(root.clone()),
        );
        boundary(
            root.clone().into(),
            "vault_graph_layout_read",
            ipc::vault_graph_layout_read(root.clone()),
        );
        boundary(
            root.clone().into(),
            "vault_graph_layout_save",
            ipc::vault_graph_layout_save(root, GraphLayoutCache::default()),
        );
    }

    #[test]
    fn phase08_13_graph_wrappers_preserve_nonempty_outputs_and_legacy_errors() {
        let home = Home::new();
        let root = home.root.path().join("workspace");
        fs::create_dir_all(root.join("vault/notes")).unwrap();
        fs::create_dir_all(root.join("reports")).unwrap();
        let work = root.to_string_lossy().into_owned();
        assert_eq!(
            run(ipc::vault_graph_root(work.clone())).unwrap(),
            Some(root.join("vault").to_string_lossy().into_owned())
        );
        fs::write(
            root.join("reports/vault-graph.json"),
            r#"{"nodes":[{"id":"Alpha"}],"edges":[{"source":"Alpha","target":"Beta"}]}"#,
        )
        .unwrap();
        let graph = run(ipc::vault_graph_read(work.clone(), None))
            .unwrap()
            .unwrap();
        assert_eq!(graph.nodes[0].id, "Alpha");
        assert_eq!(graph.edges[0].target, "Beta");
        let cache = GraphLayoutCache {
            version: 1,
            positions: BTreeMap::from([("Alpha".into(), [1.0, 2.0])]),
            pinned_ids: BTreeSet::from(["Alpha".into()]),
        };
        run(ipc::vault_graph_layout_save(work.clone(), cache)).unwrap();
        let saved = run(ipc::vault_graph_layout_read(work.clone()))
            .unwrap()
            .unwrap();
        assert_eq!(saved.version, 2);
        assert_eq!(saved.positions["Alpha"], [1.0, 2.0]);
        assert!(saved.pinned_ids.contains("Alpha"));
        fs::write(root.join("reports/vault-graph.json"), "broken").unwrap();
        let expected = vault_graph_read(work.clone(), None).unwrap_err();
        assert_eq!(
            run(ipc::vault_graph_read(work.clone(), None)).unwrap_err(),
            expected
        );
        fs::write(layout_cache_path(&work), "broken").unwrap();
        assert!(run(ipc::vault_graph_layout_read(work)).unwrap().is_none());
    }
}
