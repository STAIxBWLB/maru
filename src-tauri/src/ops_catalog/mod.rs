// M1 Operations Catalog (Phase 3)
//
// Indexes project-registry.yaml + tasks + inbox manifests + project/admin READMEs
// into a single Catalog view (deadlines, in-flight approvals, unlinked evidence).
//
// Spec: ~/workspace/work/_sys/rules/bu-lifecycle.md + plan §M1
//
// Cache: <workspace>/.maru/cache/catalog.json (gitignored)

pub mod index;
pub mod scan;
pub mod watcher;

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};

pub use index::{CatalogEntry, CatalogQuery};
pub use scan::{scan_catalog_impl, CatalogScanReport};

/// Operations Catalog 캐시 경로 헬퍼.
pub(crate) fn catalog_cache_path(workspace_root: &std::path::Path) -> PathBuf {
    workspace_root
        .join(".maru")
        .join("cache")
        .join("catalog.json")
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

pub fn catalog_drilldown(req: CatalogDrilldownRequest) -> Result<CatalogDrilldownResponse, String> {
    let root = PathBuf::from(&req.workspace_root);
    index::drilldown_impl(&root, &req.entry_path).map_err(|e| e.to_string())
}

// Scan is also called directly by Rust consumers. Its producer enters here so
// every cache write shares admission with Files and document mutations.
fn catalog_publish_path(root: &Path) -> std::io::Result<PathBuf> {
    let mut path = catalog_cache_path(root);
    for _ in 0..40 {
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                let target = std::fs::read_link(&path)?;
                path = crate::vault::lexical_normalize(&if target.is_absolute() {
                    target
                } else {
                    path.parent().unwrap().join(target)
                });
            }
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(path),
            Err(error) => return Err(error),
        }
    }
    Err(std::io::Error::other(
        "Cannot resolve cyclic catalog cache alias",
    ))
}

fn catalog_mutation_paths(root: &Path) -> std::io::Result<Vec<PathBuf>> {
    let cache = catalog_cache_path(root);
    let mut paths = vec![cache.clone(), cache.parent().unwrap().to_path_buf()];
    let mut parent = cache.parent().unwrap();
    while parent != root && !parent.exists() {
        paths.push(parent.to_path_buf());
        parent = parent.parent().unwrap();
    }
    let publish = catalog_publish_path(root)?;
    if publish != cache {
        let parent = publish.parent().unwrap();
        // A link never grants permission to recreate an absent external parent.
        if !parent.is_dir() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "Catalog cache alias parent is missing",
            ));
        }
        paths.extend([publish.clone(), parent.to_path_buf()]);
    }
    Ok(paths)
}

fn scan_catalog_with_transaction(
    root: &Path,
    force_refresh: bool,
) -> std::io::Result<CatalogScanReport> {
    // Keep the existing missing-root rejection, and do not allow a missing
    // workspace to be recreated by the cache's create_dir_all.
    if !root.exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            format!("workspace_root not found: {}", root.display()),
        ));
    }
    let root = if root.is_absolute() {
        root.to_path_buf()
    } else {
        std::env::current_dir()?.join(root)
    };
    let root = crate::vault::lexical_normalize(&root);
    let request = PathTransactionRequest::new(catalog_mutation_paths(&root)?)
        .and_then(|request| request.require_parent(&root))
        .map_err(std::io::Error::other)?;
    with_path_transactions(request, |lease| {
        Ok(scan::scan_catalog_impl_in_transaction(
            lease,
            &root,
            force_refresh,
        ))
    })
    .map_err(std::io::Error::other)?
}

fn write_catalog_cache(
    lease: &PathTransactionLease,
    root: &Path,
    json: &[u8],
) -> std::io::Result<()> {
    lease
        .ensure_covered(catalog_mutation_paths(root)?)
        .map_err(std::io::Error::other)?;
    lease.before_effect().map_err(std::io::Error::other)?;
    let cache = catalog_cache_path(root);
    std::fs::create_dir_all(cache.parent().unwrap())?;
    crate::atomic_file::write_atomic(&catalog_publish_path(root)?, json)
        .map_err(std::io::Error::other)
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn catalog_scan(req: CatalogScanRequest) -> Result<CatalogScanReport, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&req.workspace_root)],
                "worker:catalog_scan",
            );
            super::catalog_scan(req)
        })
        .await
        .map_err(|error| format!("catalog_scan_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn catalog_query(req: CatalogQueryRequest) -> Result<Vec<CatalogEntry>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&req.workspace_root)],
                "worker:catalog_query",
            );
            super::catalog_query(req)
        })
        .await
        .map_err(|error| format!("catalog_query_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn catalog_drilldown(
        req: CatalogDrilldownRequest,
    ) -> Result<CatalogDrilldownResponse, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&req.workspace_root)],
                "worker:catalog_drilldown",
            );
            super::catalog_drilldown(req)
        })
        .await
        .map_err(|error| format!("catalog_drilldown_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod phase08_13 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use std::{fs, future::Future, sync::mpsc, time::Duration};

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn fixture(home: &Home) -> tempfile::TempDir {
        let tmp = tempfile::tempdir_in(home.root.path()).unwrap();
        let item = tmp.path().join("inbox/items/pending/example");
        fs::create_dir_all(&item).unwrap();
        fs::write(
            item.join("manifest.yaml"),
            "schema: inbox-item/v1\ntitle: Catalog fixture\n",
        )
        .unwrap();
        fs::write(item.join("doc.md"), "---\ntitle: Fixture\n---\nBody\n").unwrap();
        fs::write(item.join("README.md"), "Fixture context\n").unwrap();
        fs::create_dir_all(tmp.path().join(".maru/cache")).unwrap();
        tmp
    }
    fn scan_req(root: &Path) -> CatalogScanRequest {
        CatalogScanRequest {
            workspace_root: text(root),
            force_refresh: true,
        }
    }
    fn query_req(root: &Path) -> CatalogQueryRequest {
        CatalogQueryRequest {
            workspace_root: text(root),
            business_unit: None,
            category: None,
            kinds: None,
            limit: None,
        }
    }
    fn drill_req(root: &Path) -> CatalogDrilldownRequest {
        CatalogDrilldownRequest {
            workspace_root: text(root),
            entry_path: "inbox/items/pending/example/doc.md".into(),
        }
    }
    fn start<F: Future + Send + 'static>(future: F) -> mpsc::Receiver<F::Output>
    where
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
            .expect("bounded catalog completion")
    }
    #[test]
    fn phase08_13_catalog_all_wrappers_same_poll_task_yield_and_join_errors() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        boundary(
            root.into(),
            "catalog_scan",
            ipc::catalog_scan(scan_req(root)),
        );
        boundary(
            root.into(),
            "catalog_query",
            ipc::catalog_query(query_req(root)),
        );
        boundary(
            root.into(),
            "catalog_drilldown",
            ipc::catalog_drilldown(drill_req(root)),
        );
    }
    #[test]
    fn phase08_13_catalog_actual_payloads_cache_and_legacy_errors() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let report = run(ipc::catalog_scan(scan_req(root))).unwrap();
        assert!(report.entries_count > 0);
        let entries = run(ipc::catalog_query(query_req(root))).unwrap();
        assert!(entries.iter().any(|entry| entry.title == "Catalog fixture"));
        let detail = run(ipc::catalog_drilldown(drill_req(root))).unwrap();
        assert_eq!(detail.frontmatter_yaml.as_deref(), Some("title: Fixture"));
        assert!(detail.manifest_yaml.unwrap().contains("Catalog fixture"));
        assert_eq!(detail.readme_excerpt.as_deref(), Some("Fixture context"));
        assert!(!detail.related_paths.is_empty());
        let cached = scan_catalog_impl(root, false).unwrap();
        assert_eq!(cached.scanned_at, report.scanned_at);
        assert_eq!(cached.entries_count, report.entries_count);
        fs::write(catalog_cache_path(root), "invalid cache").unwrap();
        assert_eq!(
            run(ipc::catalog_query(query_req(root))).unwrap_err(),
            catalog_query(query_req(root)).unwrap_err()
        );
        let missing = root.join("missing");
        assert_eq!(
            run(ipc::catalog_scan(scan_req(&missing))).unwrap_err(),
            catalog_scan(scan_req(&missing)).unwrap_err()
        );
        // Drilldown deliberately preserves its existing empty-success contract.
        assert!(run(ipc::catalog_drilldown(drill_req(&missing)))
            .unwrap()
            .related_paths
            .is_empty());
        assert!(!missing.exists());
        run(ipc::catalog_scan(scan_req(root))).unwrap();
        let index = index::load_or_empty(root).unwrap();
        assert_eq!(index.entries.len(), report.entries_count);
    }
    #[test]
    fn phase08_13_catalog_sync_producer_contends_and_error_unwind_release() {
        let home = Home::new();
        for failure in ["success", "io-error", "unwind"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let key = catalog_cache_path(root);
            if failure == "io-error" {
                fs::create_dir(&key).unwrap();
            }
            let held = Held::new(key.clone(), "admitted");
            let first = start(ipc::catalog_scan(scan_req(root)));
            held.wait();
            let waiting = Held::new(key.clone(), "before-admission");
            let second_root = root.to_path_buf();
            let second = start(async move {
                tauri::async_runtime::spawn_blocking(move || scan_catalog_impl(&second_root, true))
                    .await
                    .unwrap()
            });
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            let panic_once = std::sync::atomic::AtomicBool::new(false);
            let hook = (failure == "unwind").then(|| {
                PathTransactionTestHook::new(key.clone(), "pre-effect", move || {
                    if !panic_once.swap(true, std::sync::atomic::Ordering::SeqCst) {
                        panic!("catalog fixture unwind");
                    }
                })
            });
            held.release();
            let result = done(first);
            let successor = done(second);
            match failure {
                "success" => {
                    assert!(result.is_ok());
                    assert!(successor.is_ok());
                }
                "io-error" => {
                    assert!(result.is_err());
                    assert!(successor.is_err());
                    fs::remove_dir(&key).unwrap();
                }
                _ => {
                    assert!(result.unwrap_err().starts_with("catalog_scan_task_failed:"));
                    assert!(successor.is_ok());
                }
            }
            drop(hook);
            run(ipc::catalog_scan(scan_req(root))).unwrap();
            assert!(!index::load_or_empty(root).unwrap().entries.is_empty());
        }
    }
    #[test]
    fn phase08_13_catalog_files_parent_both_orders_alias_and_replacement() {
        let home = Home::new();
        for operation in ["rename", "trash"] {
            for parent_first in [false, true] {
                for alias in [false, true] {
                    for replace in [false, true] {
                        let tmp = fixture(&home);
                        let root = tmp.path().to_path_buf();
                        let parent = root.parent().unwrap();
                        let mut scan_root = root.clone();
                        #[cfg(unix)]
                        if alias {
                            scan_root = parent.join(format!(
                                "alias-{}",
                                root.file_name().unwrap().to_string_lossy()
                            ));
                            std::os::unix::fs::symlink(&root, &scan_root).unwrap();
                        }
                        let new_name =
                            format!("moved-{}", root.file_name().unwrap().to_string_lossy());
                        let moved = parent.join(&new_name);
                        let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                            root.clone(),
                            moved.clone(),
                        );
                        let parent_text = text(parent);
                        let root_text = text(&root);
                        let rename = async move {
                            if operation == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    parent_text,
                                    root_text,
                                    new_name,
                                )
                                .await
                                .map(|outcome| assert!(outcome.error.is_none()))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    parent_text,
                                    vec![root_text],
                                )
                                .await
                                .map(|outcomes| {
                                    assert_eq!(outcomes.len(), 1);
                                    assert!(outcomes[0].error.is_none());
                                })
                            }
                        };
                        if parent_first {
                            let held = Held::new(root.clone(), "admitted");
                            let first = start(rename);
                            held.wait();
                            let waiting =
                                Held::new(catalog_cache_path(&scan_root), "before-admission");
                            let second = start(ipc::catalog_scan(scan_req(&scan_root)));
                            waiting.wait();
                            held.release();
                            done(first).unwrap();
                            if replace {
                                run(crate::workspace_files::ipc::create_workspace_directory(
                                    text(parent),
                                    text(parent),
                                    root.file_name().unwrap().to_string_lossy().into_owned(),
                                ))
                                .unwrap();
                            }
                            waiting.release();
                            assert!(done(second).is_err());
                            assert!(!root.join(".maru").exists());
                        } else {
                            let held = Held::new(catalog_cache_path(&scan_root), "admitted");
                            let first = start(ipc::catalog_scan(scan_req(&scan_root)));
                            held.wait();
                            let waiting = Held::new(root.clone(), "before-admission");
                            let second = start(rename);
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            done(second).unwrap();
                            assert!(!root.exists());
                            assert!(!index::load_or_empty(&moved).unwrap().entries.is_empty());
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn phase08_13_catalog_document_cache_both_orders_alias_and_conflict_release() {
        let home = Home::new();
        for scan_first in [false, true] {
            for alias in [false, true] {
                let tmp = fixture(&home);
                let root = tmp.path();
                let key = catalog_cache_path(root);
                fs::write(&key, "{}").unwrap();
                let mut scan_root = root.to_path_buf();
                #[cfg(unix)]
                if alias {
                    scan_root = root.parent().unwrap().join(format!(
                        "alias-{}",
                        root.file_name().unwrap().to_string_lossy()
                    ));
                    std::os::unix::fs::symlink(root, &scan_root).unwrap();
                }
                let save = crate::document::ipc::save_document(
                    text(root),
                    text(&key),
                    "{\"editor\":true}".into(),
                    Some(crate::document::revision_for("{}")),
                );
                if scan_first {
                    let held = Held::new(catalog_cache_path(&scan_root), "admitted");
                    let first = start(ipc::catalog_scan(scan_req(&scan_root)));
                    held.wait();
                    let waiting = Held::new(key.clone(), "before-admission");
                    let second = start(save);
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert_eq!(
                        done(second).unwrap_err().code,
                        crate::ipc_error::DOCUMENT_CONFLICT
                    );
                } else {
                    let held = Held::new(key.clone(), "admitted");
                    let first = start(save);
                    held.wait();
                    let waiting = Held::new(catalog_cache_path(&scan_root), "before-admission");
                    let second = start(ipc::catalog_scan(scan_req(&scan_root)));
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                }
                assert!(!index::load_or_empty(root).unwrap().entries.is_empty());
                run(ipc::catalog_scan(scan_req(root))).unwrap();
            }
        }
    }
    #[cfg(unix)]
    #[test]
    fn phase08_13_catalog_final_file_alias_preserved_and_document_contention() {
        let home = Home::new();
        for scan_first in [false, true] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let external = tempfile::tempdir_in(home.root.path()).unwrap();
            let target = external.path().join("catalog.json");
            fs::write(&target, "{}").unwrap();
            let cache = catalog_cache_path(root);
            std::os::unix::fs::symlink(&target, &cache).unwrap();
            let save = crate::document::ipc::save_document(
                text(external.path()),
                text(&target),
                "{\"editor\":true}".into(),
                Some(crate::document::revision_for("{}")),
            );
            if scan_first {
                let held = Held::new(cache.clone(), "admitted");
                let first = start(ipc::catalog_scan(scan_req(root)));
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(save);
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                assert_eq!(
                    done(second).unwrap_err().code,
                    crate::ipc_error::DOCUMENT_CONFLICT
                );
            } else {
                let held = Held::new(target.clone(), "admitted");
                let first = start(save);
                held.wait();
                let waiting = Held::new(cache.clone(), "before-admission");
                let second = start(ipc::catalog_scan(scan_req(root)));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
            }
            assert!(fs::symlink_metadata(&cache)
                .unwrap()
                .file_type()
                .is_symlink());
            assert!(!index::load_or_empty(root).unwrap().entries.is_empty());
            // Existing semantics also create the missing target of a dangling
            // file link when its original parent still exists.
            fs::remove_file(&target).unwrap();
            run(ipc::catalog_scan(scan_req(root))).unwrap();
            assert!(target.is_file());
            assert!(fs::symlink_metadata(&cache)
                .unwrap()
                .file_type()
                .is_symlink());
        }
    }
}
