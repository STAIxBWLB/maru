use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_yaml::Value;

use crate::atomic_file::write_atomic;
use crate::document::{read_document, revision_for, write_version_snapshot, DocumentPayload};
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

#[tauri::command]
pub fn graph_link_preview(request: GraphLinkRequest) -> Result<GraphLinkProposal, String> {
    build_proposal(request).map(|(proposal, _)| proposal)
}

fn snapshot_if_managed(patch: &GraphLinkPatchPreview, original: &str) -> Result<(), String> {
    if !patch.changed || !is_managed_root(&patch.workspace) {
        return Ok(());
    }
    let stem = Path::new(&patch.document)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    write_version_snapshot(
        &patch.workspace,
        &patch.document,
        stem,
        original,
        "graph relationship write",
    )?;
    Ok(())
}

#[tauri::command]
pub fn graph_link_apply(proposal: GraphLinkProposal) -> Result<GraphLinkApplyResult, String> {
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
        snapshot_if_managed(patch, original)?;
    }
    let mut written: Vec<usize> = Vec::new();
    for (index, (patch, (_, updated))) in fresh.patches.iter().zip(&contents).enumerate() {
        if !patch.changed {
            continue;
        }
        let path = resolve_inside_vault(&patch.workspace, &patch.document)?;
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
