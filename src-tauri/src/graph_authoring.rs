use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::document::{
    read_document, revision_for, write_version_snapshot_in_transaction, DocumentPayload,
};
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::vault::{parse_frontmatter, resolve_inside_vault};
use crate::vault_guard::{is_managed_root, validate_managed_write};
use crate::vault_list::{assert_document_owner, assert_maru_can_write, WorkspaceWriteAction};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkRequest {
    pub source_workspace: String,
    pub source_document: String,
    pub target_workspace: String,
    pub target_document: String,
    pub relation: String,
    #[serde(default)]
    pub reciprocal: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkPatchPreview {
    pub workspace: String,
    pub document: String,
    pub field: String,
    pub wikilink: String,
    pub expected_revision: String,
    pub before_values: Vec<String>,
    pub after_values: Vec<String>,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkProposal {
    pub request: GraphLinkRequest,
    pub patches: Vec<GraphLinkPatchPreview>,
    pub changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLinkApplyResult {
    pub documents: Vec<DocumentPayload>,
}

fn validate_relation(value: &str) -> Result<String, String> {
    let relation = value.trim();
    if !matches!(relation, "related" | "supersedes" | "superseded_by") {
        return Err("graph_relation_invalid".to_string());
    }
    Ok(relation.to_string())
}

fn reciprocal_relation(relation: &str) -> String {
    match relation {
        "supersedes" => "superseded_by".to_string(),
        "superseded_by" => "supersedes".to_string(),
        _ => relation.to_string(),
    }
}

fn wikilink_for(path: &str) -> String {
    let normalized = path.replace('\\', "/");
    let without_ext = normalized
        .strip_suffix(".markdown")
        .or_else(|| normalized.strip_suffix(".md"))
        .or_else(|| normalized.strip_suffix(".mdx"))
        .unwrap_or(&normalized);
    format!("[[{without_ext}]]")
}

fn values_for_field(content: &str, field: &str) -> Vec<String> {
    let parts = parse_frontmatter(content);
    match parts.meta.get(field) {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Sequence(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(str::to_string))
            .collect(),
        _ => Vec::new(),
    }
}

fn patch_preview(
    workspace: &str,
    document: &str,
    field: &str,
    wikilink: String,
) -> Result<(GraphLinkPatchPreview, String, String), String> {
    let path = resolve_inside_vault(workspace, document)?;
    assert_document_owner(workspace, &path)?;
    assert_maru_can_write(workspace, WorkspaceWriteAction::Modify)?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let before_values = values_for_field(&original, field);
    let mut after_values = before_values.clone();
    if !after_values.iter().any(|value| value == &wikilink) {
        after_values.push(wikilink.clone());
    }
    let changed = after_values != before_values;
    let updated = if changed {
        update_frontmatter_content(
            &original,
            field,
            Some(FrontmatterValue::List(after_values.clone())),
        )?
    } else {
        original.clone()
    };
    validate_managed_write(workspace, document, &updated)?;
    Ok((
        GraphLinkPatchPreview {
            workspace: workspace.to_string(),
            document: document.to_string(),
            field: field.to_string(),
            wikilink,
            expected_revision: revision_for(&original),
            before_values,
            after_values,
            changed,
        },
        original,
        updated,
    ))
}

fn build_proposal(
    request: GraphLinkRequest,
) -> Result<(GraphLinkProposal, Vec<(String, String)>), String> {
    let relation = validate_relation(&request.relation)?;
    let mut normalized = request;
    normalized.relation = relation.clone();
    // A note relating to itself renders no edge (model.ts drops source==target)
    // and, when reciprocal, would issue two writes against one file where the
    // second clobbers the first. Reject it outright.
    if normalized.source_workspace == normalized.target_workspace
        && normalized.source_document == normalized.target_document
    {
        return Err("graph_relation_self".to_string());
    }
    // Supported workspace/file aliases can also name the very same note.
    // Reciprocal patches against that one target would clobber each other.
    if let (Ok(source), Ok(target)) = (
        resolve_inside_vault(&normalized.source_workspace, &normalized.source_document),
        resolve_inside_vault(&normalized.target_workspace, &normalized.target_document),
    ) {
        if let (Ok(source), Ok(target)) = (source.canonicalize(), target.canonicalize()) {
            if source == target {
                return Err("graph_relation_self".to_string());
            }
        }
    }
    let mut previews = Vec::new();
    let mut contents = Vec::new();
    let (source_preview, source_original, source_updated) = patch_preview(
        &normalized.source_workspace,
        &normalized.source_document,
        &relation,
        wikilink_for(&normalized.target_document),
    )?;
    previews.push(source_preview);
    contents.push((source_original, source_updated));
    if normalized.reciprocal {
        let reverse = reciprocal_relation(&relation);
        let (target_preview, target_original, target_updated) = patch_preview(
            &normalized.target_workspace,
            &normalized.target_document,
            &reverse,
            wikilink_for(&normalized.source_document),
        )?;
        previews.push(target_preview);
        contents.push((target_original, target_updated));
    }
    let changed = previews.iter().any(|patch| patch.changed);
    Ok((
        GraphLinkProposal {
            request: normalized,
            patches: previews,
            changed,
        },
        contents,
    ))
}

pub fn graph_link_preview(request: GraphLinkRequest) -> Result<GraphLinkProposal, String> {
    let mut paths = Vec::new();
    let mut roots = Vec::new();
    for (workspace, document) in
        std::iter::once((&request.source_workspace, &request.source_document)).chain(
            request
                .reciprocal
                .then_some((&request.target_workspace, &request.target_document)),
        )
    {
        let root = resolve_inside_vault(workspace, ".")?;
        let lexical = if Path::new(workspace).is_absolute() {
            std::path::PathBuf::from(workspace)
        } else {
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(workspace)
        };
        paths.extend([
            resolve_inside_vault(workspace, document)?,
            root.join(".maru/versions"),
            lexical.join(document),
            lexical.join(".maru/versions"),
        ]);
        if !root.join(".maru").exists() {
            paths.extend([root.join(".maru"), lexical.join(".maru")]);
        }
        roots.extend([root, lexical]);
    }
    paths.extend(
        paths
            .clone()
            .into_iter()
            .filter_map(|path| path.canonicalize().ok()),
    );
    let mut admission = PathTransactionRequest::new(paths)?.with_workspace_registry()?;
    for root in roots {
        admission = admission.require_parent(&root)?;
    }
    with_path_transactions(admission, |lease| {
        graph_link_preview_in_transaction(lease, request)
    })
}

fn graph_link_preview_in_transaction(
    lease: &PathTransactionLease,
    request: GraphLinkRequest,
) -> Result<GraphLinkProposal, String> {
    lease.ensure_workspace_registry()?;
    // Permission/schema loaders may migrate the legacy workspace registry.
    lease.before_effect()?;
    build_proposal(request).map(|(proposal, _)| proposal)
}

fn snapshot_if_managed(
    lease: &PathTransactionLease,
    patch: &GraphLinkPatchPreview,
    original: &str,
) -> Result<(), String> {
    if !patch.changed || !is_managed_root(&patch.workspace) {
        return Ok(());
    }
    let stem = Path::new(&patch.document)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    write_version_snapshot_in_transaction(
        lease,
        &patch.workspace,
        &patch.document,
        stem,
        original,
        "graph relationship write",
    )?;
    Ok(())
}

pub fn graph_link_apply(proposal: GraphLinkProposal) -> Result<GraphLinkApplyResult, String> {
    let mut paths = Vec::new();
    let mut roots = Vec::new();
    for (workspace, document) in std::iter::once((
        &proposal.request.source_workspace,
        &proposal.request.source_document,
    ))
    .chain(proposal.request.reciprocal.then_some((
        &proposal.request.target_workspace,
        &proposal.request.target_document,
    ))) {
        let root = resolve_inside_vault(workspace, ".")?;
        let lexical = if Path::new(workspace).is_absolute() {
            std::path::PathBuf::from(workspace)
        } else {
            std::env::current_dir()
                .map_err(|error| error.to_string())?
                .join(workspace)
        };
        paths.extend([
            resolve_inside_vault(workspace, document)?,
            root.join(".maru/versions"),
            lexical.join(document),
            lexical.join(".maru/versions"),
        ]);
        if !root.join(".maru").exists() {
            paths.extend([root.join(".maru"), lexical.join(".maru")]);
        }
        roots.extend([root, lexical]);
    }
    paths.extend(
        paths
            .clone()
            .into_iter()
            .filter_map(|path| path.canonicalize().ok()),
    );
    let mut admission = PathTransactionRequest::new(paths)?.with_workspace_registry()?;
    for root in roots {
        admission = admission.require_parent(&root)?;
    }
    with_path_transactions(admission, |lease| {
        graph_link_apply_in_transaction(lease, proposal)
    })
}

fn graph_link_apply_in_transaction(
    lease: &PathTransactionLease,
    proposal: GraphLinkProposal,
) -> Result<GraphLinkApplyResult, String> {
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    let (fresh, contents) = build_proposal(proposal.request.clone())?;
    if fresh.patches.len() != proposal.patches.len()
        || fresh
            .patches
            .iter()
            .zip(&proposal.patches)
            .any(|(current, expected)| current.expected_revision != expected.expected_revision)
    {
        return Err("document_conflict: graph relationship preview is stale".to_string());
    }
    for (patch, (original, _)) in fresh.patches.iter().zip(&contents) {
        snapshot_if_managed(lease, patch, original)?;
    }
    let mut written: Vec<usize> = Vec::new();
    for (index, (patch, (_, updated))) in fresh.patches.iter().zip(&contents).enumerate() {
        if !patch.changed {
            continue;
        }
        let path = resolve_inside_vault(&patch.workspace, &patch.document)?;
        lease.ensure_covered(vec![path.clone()])?;
        #[cfg(test)]
        PathTransactionLease::test_stage(std::slice::from_ref(&path), "graph-before-write");
        if let Err(error) = write_atomic(&path, updated.as_bytes()) {
            for written_index in written.into_iter().rev() {
                let prior_patch = &fresh.patches[written_index];
                let prior_path =
                    resolve_inside_vault(&prior_patch.workspace, &prior_patch.document)?;
                let _ = write_atomic(&prior_path, contents[written_index].0.as_bytes());
            }
            return Err(error);
        }
        written.push(index);
    }
    let mut documents = Vec::new();
    for patch in &fresh.patches {
        documents.push(read_document(
            patch.workspace.clone(),
            patch.document.clone(),
        )?);
    }
    Ok(GraphLinkApplyResult { documents })
}

pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn graph_link_preview(
        request: GraphLinkRequest,
    ) -> Result<GraphLinkProposal, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&request.source_workspace)],
                "worker:graph_link_preview",
            );
            super::graph_link_preview(request)
        })
        .await
        .map_err(|error| format!("graph_link_preview_task_failed: {error}"))?
    }

    #[tauri::command]
    pub async fn graph_link_apply(
        proposal: GraphLinkProposal,
    ) -> Result<GraphLinkApplyResult, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&proposal.request.source_workspace)],
                "worker:graph_link_apply",
            );
            super::graph_link_apply(proposal)
        })
        .await
        .map_err(|error| format!("graph_link_apply_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn preview_and_apply_preserve_unrelated_frontmatter() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(
            tmp.path().join("a.md"),
            "---\ntitle: A\n# keep\nstatus: draft\n---\n# A\n",
        )
        .unwrap();
        fs::write(tmp.path().join("b.md"), "# B\n").unwrap();
        let proposal = graph_link_preview(GraphLinkRequest {
            source_workspace: root.clone(),
            source_document: "a.md".to_string(),
            target_workspace: root.clone(),
            target_document: "b.md".to_string(),
            relation: "related".to_string(),
            reciprocal: false,
        })
        .unwrap();
        assert!(proposal.changed);
        graph_link_apply(proposal).unwrap();
        let updated = fs::read_to_string(tmp.path().join("a.md")).unwrap();
        assert!(updated.contains("# keep"));
        assert!(updated.contains("status: draft"));
        assert!(updated.contains("- \"[[b]]\""));
    }

    #[test]
    fn rejects_uncontrolled_relation_fields() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("a.md"), "# A\n").unwrap();
        fs::write(tmp.path().join("b.md"), "# B\n").unwrap();

        let error = graph_link_preview(GraphLinkRequest {
            source_workspace: root.clone(),
            source_document: "a.md".to_string(),
            target_workspace: root,
            target_document: "b.md".to_string(),
            relation: "arbitrary_field".to_string(),
            reciprocal: false,
        })
        .unwrap_err();

        assert_eq!(error, "graph_relation_invalid");
    }

    #[test]
    fn rejects_self_relation() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("a.md"), "# A\n").unwrap();

        let error = graph_link_preview(GraphLinkRequest {
            source_workspace: root.clone(),
            source_document: "a.md".to_string(),
            target_workspace: root,
            target_document: "a.md".to_string(),
            relation: "related".to_string(),
            reciprocal: true,
        })
        .unwrap_err();

        assert_eq!(error, "graph_relation_self");
    }
}

#[cfg(test)]
mod phase08_13 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::phase08_08::registry;
    use crate::workspace_files::phase08_06::TrashFixture;
    use std::path::PathBuf;
    use std::sync::mpsc;
    use std::time::Duration;

    const ORIGINAL: &str =
        "---\ntitle: A\n# keep this comment\nstatus: draft\n---\n# A\n\n본문 exact bytes\n";
    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn fixture(home: &Home) -> PathBuf {
        let root = home.root.path().join("work");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("a.md"), ORIGINAL).unwrap();
        fs::write(root.join("b.md"), "# B\n\nTarget body\n").unwrap();
        root
    }
    fn request(root: &Path) -> GraphLinkRequest {
        GraphLinkRequest {
            source_workspace: text(root),
            source_document: "a.md".into(),
            target_workspace: text(root),
            target_document: "b.md".into(),
            relation: "supersedes".into(),
            reciprocal: true,
        }
    }
    fn start<F>(future: F) -> mpsc::Receiver<F::Output>
    where
        F: std::future::Future + Send + 'static,
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
            .expect("actual graph command completion")
    }
    fn waiting(path: PathBuf) -> (PathTransactionTestHook, mpsc::Receiver<()>) {
        let (tx, rx) = mpsc::channel();
        let hook = PathTransactionTestHook::new(path, "before-admission", move || {
            let _ = tx.send(());
        });
        (hook, rx)
    }

    #[test]
    fn phase08_13_graph_all_wrappers_same_polling_task_yield_joinerror() {
        let home = Home::new();
        let root = fixture(&home);
        boundary(
            root.clone(),
            "graph_link_preview",
            ipc::graph_link_preview(request(&root)),
        );
        let proposal = graph_link_preview(request(&root)).unwrap();
        boundary(root, "graph_link_apply", ipc::graph_link_apply(proposal));
    }

    #[test]
    fn phase08_13_graph_nonempty_reciprocal_payload_legacy_errors_and_snapshots() {
        let home = Home::new();
        let root = fixture(&home);
        registry(&root, "managed");
        let proposal = run(ipc::graph_link_preview(request(&root))).unwrap();
        assert_eq!(proposal.patches.len(), 2);
        assert_eq!(proposal.patches[0].after_values, ["[[b]]"]);
        let original_b = fs::read_to_string(root.join("b.md")).unwrap();
        let result = run(ipc::graph_link_apply(proposal.clone())).unwrap();
        assert_eq!(result.documents.len(), 2);
        assert!(result.documents[0]
            .content
            .contains("# keep this comment\nstatus: draft\n"));
        assert_eq!(result.documents[0].body, parse_frontmatter(ORIGINAL).body);
        assert_eq!(result.documents[1].body, original_b);
        assert!(result.documents[1].content.contains("superseded_by:"));
        let versions: Vec<_> = fs::read_dir(root.join(".maru/versions"))
            .unwrap()
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect();
        assert_eq!(versions.len(), 2);
        assert!(versions
            .iter()
            .any(|s| s.ends_with(&parse_frontmatter(ORIGINAL).body)));
        assert!(versions.iter().any(|s| s.ends_with(&original_b)));
        assert!(run(ipc::graph_link_apply(proposal))
            .unwrap_err()
            .starts_with("document_conflict: "));
        let mut invalid = request(&root);
        invalid.relation = "arbitrary_field".into();
        assert_eq!(
            run(ipc::graph_link_preview(invalid)).unwrap_err(),
            "graph_relation_invalid"
        );
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("a.md"), root.join("self.md")).unwrap();
            let mut same_file = request(&root);
            same_file.target_document = "self.md".into();
            assert_eq!(
                run(ipc::graph_link_preview(same_file)).unwrap_err(),
                "graph_relation_self"
            );
        }
        let current = run(ipc::graph_link_preview(request(&root))).unwrap();
        assert!(!current.changed);
        run(ipc::graph_link_apply(current)).unwrap();
        assert_eq!(
            fs::read_dir(root.join(".maru/versions")).unwrap().count(),
            2
        );
    }

    #[test]
    fn phase08_13_graph_same_target_contention_error_and_unwind_release() {
        let home = Home::new();
        let root = fixture(&home);
        let proposal = graph_link_preview(request(&root)).unwrap();
        let hold = Held::new(root.join("a.md"), "admitted");
        let first = start(ipc::graph_link_apply(proposal.clone()));
        hold.wait();
        let (_hook, arrived) = waiting(root.join("a.md"));
        let second = start(ipc::graph_link_apply(proposal));
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(second.recv_timeout(Duration::from_millis(40)).is_err());
        hold.release();
        assert_eq!(done(first).unwrap().documents.len(), 2);
        assert!(done(second).unwrap_err().starts_with("document_conflict: "));
        drop(hold);
        let proposal = graph_link_preview(request(&root)).unwrap();
        let hook = PathTransactionTestHook::new(root.join("a.md"), "admitted", || {
            panic!("graph fixture unwind")
        });
        let error = run(ipc::graph_link_apply(proposal.clone())).unwrap_err();
        assert!(error.starts_with("graph_link_apply_task_failed:"));
        drop(hook);
        run(ipc::graph_link_apply(proposal)).unwrap();
    }

    #[test]
    fn phase08_13_graph_reciprocal_rollback_keeps_both_originals_and_snapshots() {
        let home = Home::new();
        let root = fixture(&home);
        registry(&root, "managed");
        let proposal = graph_link_preview(request(&root)).unwrap();
        let original_b = fs::read(root.join("b.md")).unwrap();
        let target = root.join("b.md");
        let preserved = root.join("b.original");
        let callback_target = target.clone();
        let callback_preserved = preserved.clone();
        // Actual atomic replacement fails at the second document. The test
        // deliberately preserves that document's bytes outside the write target.
        let hook = PathTransactionTestHook::new(target.clone(), "graph-before-write", move || {
            fs::rename(&callback_target, &callback_preserved).unwrap();
            fs::create_dir(&callback_target).unwrap();
        });
        let error = run(ipc::graph_link_apply(proposal)).unwrap_err();
        assert!(
            error.contains("Cannot") || error.contains("atomic"),
            "{error}"
        );
        assert_eq!(fs::read(root.join("a.md")).unwrap(), ORIGINAL.as_bytes());
        assert_eq!(fs::read(&preserved).unwrap(), original_b);
        assert_eq!(
            fs::read_dir(root.join(".maru/versions")).unwrap().count(),
            2
        );
        drop(hook);
        fs::remove_dir(&target).unwrap();
        fs::rename(preserved, target).unwrap();
        let proposal = run(ipc::graph_link_preview(request(&root))).unwrap();
        run(ipc::graph_link_apply(proposal)).unwrap();
        assert!(fs::read_to_string(root.join("a.md"))
            .unwrap()
            .contains("supersedes:"));
        assert!(fs::read_to_string(root.join("b.md"))
            .unwrap()
            .contains("superseded_by:"));
    }

    #[test]
    fn phase08_13_graph_cross_workspace_reciprocal_target_and_snapshot_admission() {
        let home = Home::new();
        let root = fixture(&home);
        let target = home.root.path().join("target");
        fs::create_dir(&target).unwrap();
        fs::write(target.join("b.md"), "# Target\n").unwrap();
        registry(&root, "managed");
        let path = crate::vault_list::workspace_registry_path().unwrap();
        let mut value: serde_json::Value =
            serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        value["workspaces"].as_array_mut().unwrap().push(serde_json::json!({
            "label": "Target", "path": text(&target), "visibility": "private", "provider": "local", "writePolicy": "managed"
        }));
        write_atomic(&path, serde_json::to_string(&value).unwrap().as_bytes()).unwrap();
        let mut input = request(&root);
        input.target_workspace = text(&target);
        let proposal = graph_link_preview(input).unwrap();
        let hold = Held::new(target.join("b.md"), "admitted");
        let graph = start(ipc::graph_link_apply(proposal));
        hold.wait();
        let (_hook, arrived) = waiting(target.join(".maru/versions"));
        let snapshot = start(crate::document::ipc::create_version(
            text(&target),
            "b.md".into(),
            "Target".into(),
            "# Independent\n".into(),
            "manual".into(),
        ));
        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(snapshot.recv_timeout(Duration::from_millis(40)).is_err());
        hold.release();
        assert_eq!(done(graph).unwrap().documents.len(), 2);
        done(snapshot).unwrap();
        assert_eq!(
            fs::read_dir(root.join(".maru/versions")).unwrap().count(),
            1
        );
        assert_eq!(
            fs::read_dir(target.join(".maru/versions")).unwrap().count(),
            2
        );
        assert!(fs::read_to_string(target.join("b.md"))
            .unwrap()
            .contains("superseded_by:"));
    }

    #[test]
    fn phase08_13_graph_document_races_both_orders_and_aliases() {
        let home = Home::new();
        for alias in [false, true] {
            for graph_first in [false, true] {
                let fixture_root = tempfile::tempdir_in(home.root.path()).unwrap();
                let root = fixture_root.path().join("work");
                fs::create_dir(&root).unwrap();
                fs::write(root.join("a.md"), ORIGINAL).unwrap();
                fs::write(root.join("b.md"), "# B\n").unwrap();
                let selected = if alias {
                    #[cfg(unix)]
                    {
                        let alias = fixture_root.path().join("alias");
                        std::os::unix::fs::symlink(&root, &alias).unwrap();
                        alias
                    }
                    #[cfg(not(unix))]
                    {
                        root.clone()
                    }
                } else {
                    root.clone()
                };
                let proposal = graph_link_preview(request(&selected)).unwrap();
                let revision = revision_for(ORIGINAL);
                let hold = Held::new(
                    if graph_first {
                        selected.join("a.md")
                    } else {
                        root.join("a.md")
                    },
                    "admitted",
                );
                if graph_first {
                    let graph = start(ipc::graph_link_apply(proposal));
                    hold.wait();
                    let (_hook, arrived) = waiting(root.join("a.md"));
                    let document = start(crate::document::ipc::save_document(
                        text(&root),
                        "a.md".into(),
                        "# Manual\n".into(),
                        Some(revision),
                    ));
                    arrived.recv_timeout(Duration::from_secs(5)).unwrap();
                    assert!(document.recv_timeout(Duration::from_millis(40)).is_err());
                    hold.release();
                    done(graph).unwrap();
                    assert_eq!(
                        done(document).unwrap_err().code,
                        crate::ipc_error::DOCUMENT_CONFLICT
                    );
                    assert!(fs::read_to_string(root.join("b.md"))
                        .unwrap()
                        .contains("superseded_by:"));
                } else {
                    let document = start(crate::document::ipc::save_document(
                        text(&root),
                        "a.md".into(),
                        "# Manual\n".into(),
                        Some(revision),
                    ));
                    hold.wait();
                    let (_hook, arrived) = waiting(selected.join("a.md"));
                    let graph = start(ipc::graph_link_apply(proposal));
                    arrived.recv_timeout(Duration::from_secs(5)).unwrap();
                    assert!(graph.recv_timeout(Duration::from_millis(40)).is_err());
                    hold.release();
                    done(document).unwrap();
                    assert!(done(graph).unwrap_err().starts_with("document_conflict: "));
                    assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), "# Manual\n");
                    assert_eq!(fs::read_to_string(root.join("b.md")).unwrap(), "# B\n");
                }
            }
        }
    }

    #[test]
    fn phase08_13_graph_files_parent_races_both_orders_aliases_and_no_recreation() {
        let home = Home::new();
        for alias in [false, true] {
            for graph_first in [false, true] {
                for trash in [false, true] {
                    let fixture_root = tempfile::tempdir_in(home.root.path()).unwrap();
                    let outer = fixture_root.path();
                    let root = outer.join("work");
                    fs::create_dir(&root).unwrap();
                    fs::write(root.join("a.md"), ORIGINAL).unwrap();
                    fs::write(root.join("b.md"), "# B\n").unwrap();
                    let selected = if alias {
                        #[cfg(unix)]
                        {
                            let alias = outer.join("alias");
                            std::os::unix::fs::symlink(&root, &alias).unwrap();
                            alias
                        }
                        #[cfg(not(unix))]
                        {
                            root.clone()
                        }
                    } else {
                        root.clone()
                    };
                    let proposal = graph_link_preview(request(&selected)).unwrap();
                    let destination = outer.join("moved");
                    let _trash = TrashFixture::new(root.clone(), destination.clone());
                    let files = {
                        let outer = text(outer);
                        async move {
                            if trash {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    outer,
                                    vec!["work".into()],
                                )
                                .await
                                .map(|_| ())
                            } else {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    outer,
                                    "work".into(),
                                    "moved".into(),
                                )
                                .await
                                .map(|_| ())
                            }
                        }
                    };
                    let hold = Held::new(
                        if graph_first {
                            selected.join("a.md")
                        } else {
                            root.clone()
                        },
                        "admitted",
                    );
                    if graph_first {
                        let graph = start(ipc::graph_link_apply(proposal));
                        hold.wait();
                        let (_hook, arrived) = waiting(root.clone());
                        let files = start(files);
                        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
                        assert!(files.recv_timeout(Duration::from_millis(40)).is_err());
                        hold.release();
                        done(graph).unwrap();
                        done(files).unwrap();
                        assert!(fs::read_to_string(destination.join("b.md"))
                            .unwrap()
                            .contains("superseded_by:"));
                    } else {
                        let files = start(files);
                        hold.wait();
                        let (_hook, arrived) = waiting(selected.join("a.md"));
                        let graph = start(ipc::graph_link_apply(proposal));
                        arrived.recv_timeout(Duration::from_secs(5)).unwrap();
                        assert!(graph.recv_timeout(Duration::from_millis(40)).is_err());
                        hold.release();
                        done(files).unwrap();
                        assert!(done(graph).is_err());
                        assert_eq!(
                            fs::read_to_string(destination.join("a.md")).unwrap(),
                            ORIGINAL
                        );
                        assert_eq!(
                            fs::read_to_string(destination.join("b.md")).unwrap(),
                            "# B\n"
                        );
                    }
                    assert!(
                        !root.exists(),
                        "graph must not resurrect the moved workspace"
                    );
                }
            }
        }
    }

    #[test]
    fn phase08_13_graph_parent_replacement_and_alias_retarget_reject_before_effect() {
        let home = Home::new();
        let root = fixture(&home);
        let proposal = graph_link_preview(request(&root)).unwrap();
        let hold = Held::new(root.join("a.md"), "admitted");
        let graph = start(ipc::graph_link_apply(proposal));
        hold.wait();
        fs::rename(&root, home.root.path().join("moved")).unwrap();
        fs::create_dir(&root).unwrap();
        fs::write(root.join("a.md"), ORIGINAL).unwrap();
        fs::write(root.join("b.md"), "# B\n").unwrap();
        hold.release();
        assert!(done(graph).unwrap_err().contains("parent changed"));
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), ORIGINAL);
        assert!(!root.join(".maru").exists());
        drop(hold);
        #[cfg(unix)]
        {
            let alias = home.root.path().join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            let proposal = graph_link_preview(request(&alias)).unwrap();
            let hold = Held::new(alias.join("a.md"), "admitted");
            let graph = start(ipc::graph_link_apply(proposal));
            hold.wait();
            fs::remove_file(&alias).unwrap();
            std::os::unix::fs::symlink(home.root.path().join("moved"), &alias).unwrap();
            hold.release();
            assert!(done(graph).is_err());
            assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), ORIGINAL);
        }
    }

    #[test]
    fn phase08_13_graph_current_readonly_policy_alias_directions_and_duplicates() {
        let home = Home::new();
        let root = fixture(&home);
        let proposal = graph_link_preview(request(&root)).unwrap();
        let hold = Held::new(root.join("a.md"), "admitted");
        let graph = start(ipc::graph_link_apply(proposal));
        hold.wait();
        registry(&root, "readOnly");
        hold.release();
        assert!(done(graph).unwrap_err().contains("blocked"));
        drop(hold);
        assert_eq!(fs::read_to_string(root.join("a.md")).unwrap(), ORIGINAL);
        #[cfg(unix)]
        {
            let alias = home.root.path().join("alias");
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            assert!(run(ipc::graph_link_preview(request(&alias)))
                .unwrap_err()
                .contains("blocked"));
            registry(&alias, "readOnly");
            assert!(run(ipc::graph_link_preview(request(&root)))
                .unwrap_err()
                .contains("blocked"));
            let path = crate::vault_list::workspace_registry_path().unwrap();
            let mut value: serde_json::Value =
                serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
            value["workspaces"].as_array_mut().unwrap().insert(0, serde_json::json!({
                "label": "Permissive alias", "path": text(&root), "visibility": "private", "provider": "local", "writePolicy": "direct"
            }));
            write_atomic(&path, serde_json::to_string(&value).unwrap().as_bytes()).unwrap();
            assert!(run(ipc::graph_link_preview(request(&root)))
                .unwrap_err()
                .contains("blocked"));
        }
    }
}
