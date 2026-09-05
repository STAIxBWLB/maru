use crate::atomic_file::{with_path_transactions, PathTransactionLease, PathTransactionRequest};
use crate::document::{read_document, DocumentPayload};
use crate::kordoc_lite::KordocLiteCheck;
use crate::vault::{lexical_normalize, resolve_inside_vault};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

const STUDIO_SCHEMA_VERSION: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StudioStep {
    Source,
    Template,
    Guidelines,
    Sections,
    Hwp,
    Export,
    Package,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum StudioSourceMode {
    ActiveDocument,
    NewDocument,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioSourceState {
    pub mode: StudioSourceMode,
    pub document_path: Option<String>,
    pub title: String,
    pub doc_type: String,
    pub target_rel_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioTemplateState {
    pub id: String,
    pub slug: String,
    pub version: u32,
    pub title: String,
    pub business_unit: Option<String>,
    pub document_type_code: Option<String>,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub hwpx_template_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioHwpTemplateFieldState {
    pub key: String,
    pub label: String,
    pub required: bool,
    pub occurrences: u32,
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub confidence: Option<f32>,
    #[serde(default)]
    pub matched_key: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioHwpFieldsState {
    pub status: String,
    #[serde(default)]
    pub template_path: Option<String>,
    #[serde(default)]
    pub fields: Vec<StudioHwpTemplateFieldState>,
    #[serde(default)]
    pub values: BTreeMap<String, String>,
    #[serde(default)]
    pub last_output_path: Option<String>,
    #[serde(default)]
    pub form_filled_count: u32,
    #[serde(default)]
    pub unmatched_fields: Vec<String>,
    #[serde(default)]
    pub validation_checks: Vec<KordocLiteCheck>,
    #[serde(default)]
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioExportState {
    #[serde(default)]
    pub formats: Vec<String>,
    pub manifest_path: Option<String>,
    pub summary: Option<String>,
    pub last_run_at: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioPackageState {
    pub frozen: bool,
    pub frozen_at: Option<String>,
    pub snapshot_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioState {
    pub schema_version: u32,
    pub doc_id: String,
    pub current_step: StudioStep,
    pub source: StudioSourceState,
    pub template: Option<StudioTemplateState>,
    #[serde(default)]
    pub guideline_ids: Vec<String>,
    pub body_draft: String,
    #[serde(default)]
    pub lint_dismissals: Vec<String>,
    pub hwp_fields: StudioHwpFieldsState,
    pub export: StudioExportState,
    pub package: StudioPackageState,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioStateSummary {
    pub doc_id: String,
    pub current_step: StudioStep,
    pub document_path: Option<String>,
    pub title: String,
    pub updated_at: String,
}

pub fn studio_state_list(work_path: String) -> Result<Vec<StudioStateSummary>, String> {
    let root = studio_root(&work_path)?;
    if !root.exists() {
        return Ok(Vec::new());
    }

    let mut states = Vec::new();
    for entry in fs::read_dir(&root).map_err(|err| format!("Cannot read Studio state: {err}"))? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path().join("state.json");
        if !path.is_file() {
            continue;
        }
        let Ok(state) = read_state_file(&path) else {
            continue;
        };
        states.push(StudioStateSummary {
            doc_id: state.doc_id,
            current_step: state.current_step,
            document_path: state.source.document_path,
            title: state.source.title,
            updated_at: state.updated_at,
        });
    }
    states.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
    Ok(states)
}

pub fn studio_state_read(
    work_path: String,
    #[allow(non_snake_case)] doc_id: String,
) -> Result<Option<StudioState>, String> {
    let path = state_path(&work_path, &doc_id)?;
    if !path.is_file() {
        return Ok(None);
    }
    read_state_file(&path).map(Some)
}

pub fn studio_state_save(work_path: String, state: StudioState) -> Result<StudioState, String> {
    validate_doc_id(&state.doc_id)?;
    let path = state_path(&work_path, &state.doc_id)?;
    let dir = path
        .parent()
        .ok_or_else(|| "Studio state path has no parent".to_string())?
        .to_path_buf();
    let root = resolve_inside_vault(&work_path, ".")?;
    let request = PathTransactionRequest::new(vec![dir, path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        studio_state_save_in_transaction(work_path, state, lease)
    })
}

fn studio_state_save_in_transaction(
    work_path: String,
    mut state: StudioState,
    lease: &PathTransactionLease,
) -> Result<StudioState, String> {
    lease.ensure_workspace_registry()?;
    let path = state_path(&work_path, &state.doc_id)?;
    lease.ensure_covered(vec![path.clone()])?;
    state.schema_version = STUDIO_SCHEMA_VERSION;
    state.updated_at = Utc::now().to_rfc3339();
    let write_action = if path.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(&work_path, write_action)?;
    lease.before_effect()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create Studio state directory: {err}"))?;
    }
    let body = serde_json::to_string_pretty(&state)
        .map_err(|err| format!("Cannot serialize Studio state: {err}"))?;
    fs::write(&path, format!("{body}\n"))
        .map_err(|err| format!("Cannot write Studio state: {err}"))?;
    Ok(state)
}

pub fn studio_state_delete(
    work_path: String,
    #[allow(non_snake_case)] doc_id: String,
) -> Result<bool, String> {
    let dir = state_dir(&work_path, &doc_id)?;
    let root = resolve_inside_vault(&work_path, ".")?;
    let request = PathTransactionRequest::new(vec![dir])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        studio_state_delete_in_transaction(work_path, doc_id, lease)
    })
}

fn studio_state_delete_in_transaction(
    work_path: String,
    #[allow(non_snake_case)] doc_id: String,
    lease: &PathTransactionLease,
) -> Result<bool, String> {
    lease.ensure_workspace_registry()?;
    let dir = state_dir(&work_path, &doc_id)?;
    lease.ensure_covered(vec![dir.clone()])?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    lease.before_effect()?;
    if !dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|err| format!("Cannot delete Studio state: {err}"))?;
    Ok(true)
}

pub fn studio_apply_body(
    work_path: String,
    document_path: String,
    body_markdown: String,
) -> Result<DocumentPayload, String> {
    let path = resolve_inside_vault(&work_path, &document_path)?;
    let root = resolve_inside_vault(&work_path, ".")?;
    let request = PathTransactionRequest::new(vec![path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        studio_apply_body_in_transaction(work_path, document_path, body_markdown, lease)
    })
}

fn studio_apply_body_in_transaction(
    work_path: String,
    document_path: String,
    body_markdown: String,
    lease: &PathTransactionLease,
) -> Result<DocumentPayload, String> {
    lease.ensure_workspace_registry()?;
    let path = resolve_inside_vault(&work_path, &document_path)?;
    lease.ensure_covered(vec![path.clone()])?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    lease.before_effect()?;
    if !path.is_file() {
        return Err("Document file does not exist".to_string());
    }
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let updated = replace_body_preserving_frontmatter(&original, &body_markdown);
    fs::write(&path, updated).map_err(|err| format!("Cannot save document: {err}"))?;
    read_document(work_path, path.to_string_lossy().to_string())
}

/// Owned IPC boundaries; synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn studio_state_list(work_path: String) -> Result<Vec<StudioStateSummary>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:studio_state_list",
            );
            super::studio_state_list(work_path)
        })
        .await
        .map_err(|err| format!("studio_state_list_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn studio_state_read(
        work_path: String,
        #[allow(non_snake_case)] doc_id: String,
    ) -> Result<Option<StudioState>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:studio_state_read",
            );
            super::studio_state_read(work_path, doc_id)
        })
        .await
        .map_err(|err| format!("studio_state_read_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn studio_state_save(
        work_path: String,
        state: StudioState,
    ) -> Result<StudioState, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:studio_state_save",
            );
            super::studio_state_save(work_path, state)
        })
        .await
        .map_err(|err| format!("studio_state_save_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn studio_state_delete(
        work_path: String,
        #[allow(non_snake_case)] doc_id: String,
    ) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:studio_state_delete",
            );
            super::studio_state_delete(work_path, doc_id)
        })
        .await
        .map_err(|err| format!("studio_state_delete_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn studio_apply_body(
        work_path: String,
        document_path: String,
        body_markdown: String,
    ) -> Result<DocumentPayload, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:studio_apply_body",
            );
            super::studio_apply_body(work_path, document_path, body_markdown)
        })
        .await
        .map_err(|err| format!("studio_apply_body_task_failed: {err}"))?
    }
}

fn studio_root(work_path: &str) -> Result<PathBuf, String> {
    resolve_inside_vault(work_path, ".maru/studio")
}

fn state_dir(work_path: &str, doc_id: &str) -> Result<PathBuf, String> {
    validate_doc_id(doc_id)?;
    let root = studio_root(work_path)?;
    let dir = root.join(doc_id);
    ensure_within(&root, &dir)?;
    Ok(dir)
}

fn state_path(work_path: &str, doc_id: &str) -> Result<PathBuf, String> {
    Ok(state_dir(work_path, doc_id)?.join("state.json"))
}

fn read_state_file(path: &Path) -> Result<StudioState, String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("Cannot read Studio state: {err}"))?;
    let state: StudioState =
        serde_json::from_str(&raw).map_err(|err| format!("Cannot parse Studio state: {err}"))?;
    if state.schema_version != STUDIO_SCHEMA_VERSION {
        return Err(format!(
            "Unsupported Studio state schema: {}",
            state.schema_version
        ));
    }
    validate_doc_id(&state.doc_id)?;
    Ok(state)
}

fn validate_doc_id(doc_id: &str) -> Result<(), String> {
    let trimmed = doc_id.trim();
    if trimmed.is_empty() {
        return Err("Studio doc id is required".to_string());
    }
    if trimmed.len() > 160
        || trimmed.starts_with('.')
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || !trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' || ch == '.')
    {
        return Err(format!("Invalid Studio doc id: {doc_id}"));
    }
    Ok(())
}

fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Studio state path escapes .maru/studio".to_string());
    }
    Ok(())
}

fn replace_body_preserving_frontmatter(original: &str, body_markdown: &str) -> String {
    let mut body = body_markdown.trim_end_matches(['\r', '\n']).to_string();
    body.push('\n');

    let Some(prefix_len) = frontmatter_prefix_len(original) else {
        return body;
    };
    let prefix = &original[..prefix_len];
    if prefix.ends_with('\n') {
        format!("{prefix}{body}")
    } else {
        format!("{prefix}\n{body}")
    }
}

fn frontmatter_prefix_len(content: &str) -> Option<usize> {
    let (first, mut cursor) = next_line(content, 0)?;
    if line_without_newline(first) != "---" {
        return None;
    }
    while cursor < content.len() {
        let (line, next) = next_line(content, cursor)?;
        if line_without_newline(line) == "---" {
            return Some(next);
        }
        cursor = next;
    }
    None
}

fn next_line(content: &str, start: usize) -> Option<(&str, usize)> {
    if start >= content.len() {
        return None;
    }
    let rest = &content[start..];
    match rest.find('\n') {
        Some(offset) => {
            let end = start + offset + 1;
            Some((&content[start..end], end))
        }
        None => Some((&content[start..], content.len())),
    }
}

fn line_without_newline(line: &str) -> &str {
    line.trim_end_matches(['\r', '\n'])
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn sample_state(doc_id: &str) -> StudioState {
        StudioState {
            schema_version: 1,
            doc_id: doc_id.to_string(),
            current_step: StudioStep::Sections,
            source: StudioSourceState {
                mode: StudioSourceMode::ActiveDocument,
                document_path: Some("docs/report.md".to_string()),
                title: "Report".to_string(),
                doc_type: "report".to_string(),
                target_rel_path: Some("docs/report.md".to_string()),
            },
            template: Some(StudioTemplateState {
                id: "tpl-1".to_string(),
                slug: "business-plan-default".to_string(),
                version: 2,
                title: "Business Plan".to_string(),
                business_unit: Some("koica-tiu".to_string()),
                document_type_code: Some("business-plan".to_string()),
                source: Some("hwpx_skill".to_string()),
                hwpx_template_key: Some("사업계획서_기본".to_string()),
            }),
            guideline_ids: vec!["guideline-1".to_string()],
            body_draft: "# Report\n\nBody".to_string(),
            lint_dismissals: Vec::new(),
            hwp_fields: StudioHwpFieldsState {
                status: "placeholder".to_string(),
                template_path: None,
                fields: Vec::new(),
                values: BTreeMap::new(),
                last_output_path: None,
                form_filled_count: 0,
                unmatched_fields: Vec::new(),
                validation_checks: Vec::new(),
                warnings: Vec::new(),
            },
            export: StudioExportState {
                formats: vec!["docx".to_string(), "hwpx".to_string(), "pdf".to_string()],
                manifest_path: None,
                summary: None,
                last_run_at: None,
            },
            package: StudioPackageState {
                frozen: false,
                frozen_at: None,
                snapshot_path: None,
            },
            updated_at: "2026-05-23T00:00:00Z".to_string(),
        }
    }

    #[test]
    fn state_roundtrip_list_delete() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let saved = studio_state_save(root.clone(), sample_state("doc-123")).unwrap();
        assert_eq!(saved.schema_version, 1);
        assert!(!saved.updated_at.is_empty());

        let read = studio_state_read(root.clone(), "doc-123".to_string())
            .unwrap()
            .unwrap();
        assert_eq!(read.source.title, "Report");
        assert_eq!(read.guideline_ids, vec!["guideline-1"]);

        let listed = studio_state_list(root.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].doc_id, "doc-123");
        assert!(studio_state_delete(root.clone(), "doc-123".to_string()).unwrap());
        assert!(studio_state_read(root, "doc-123".to_string())
            .unwrap()
            .is_none());
    }

    #[test]
    fn state_list_skips_invalid_entries() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        studio_state_save(root.clone(), sample_state("good")).unwrap();
        let bad_dir = dir.path().join(".maru").join("studio").join("bad");
        fs::create_dir_all(&bad_dir).unwrap();
        fs::write(bad_dir.join("state.json"), "{not valid json").unwrap();

        let listed = studio_state_list(root).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].doc_id, "good");
    }

    #[test]
    fn rejects_unsafe_doc_ids() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        assert!(studio_state_save(root.clone(), sample_state("../bad")).is_err());
        assert!(studio_state_read(root.clone(), "bad/path".to_string()).is_err());
        assert!(studio_state_delete(root, ".hidden".to_string()).is_err());
    }

    #[test]
    fn apply_body_preserves_frontmatter_bytes() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let doc = dir.path().join("docs").join("report.md");
        fs::create_dir_all(doc.parent().unwrap()).unwrap();
        fs::write(
            &doc,
            "---\n# keep this comment\ntype: report\nstatus: draft\n---\n# Old\n\nBody\n",
        )
        .unwrap();

        let payload = studio_apply_body(
            root,
            "docs/report.md".to_string(),
            "# New\n\nUpdated".to_string(),
        )
        .unwrap();
        assert_eq!(payload.body, "# New\n\nUpdated\n");
        let raw = fs::read_to_string(doc).unwrap();
        assert_eq!(
            raw,
            "---\n# keep this comment\ntype: report\nstatus: draft\n---\n# New\n\nUpdated\n"
        );
    }

    #[test]
    fn apply_body_without_frontmatter_writes_body_only() {
        let dir = tempdir().unwrap();
        let root = dir.path().to_string_lossy().to_string();
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# Old\n").unwrap();

        studio_apply_body(root, "note.md".to_string(), "# New".to_string()).unwrap();
        assert_eq!(fs::read_to_string(doc).unwrap(), "# New\n");
    }
}

#[cfg(test)]
mod phase08_20 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::future::Future;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn sample(doc_id: &str, title: &str) -> StudioState {
        StudioState {
            schema_version: 1,
            doc_id: doc_id.to_string(),
            current_step: StudioStep::Sections,
            source: StudioSourceState {
                mode: StudioSourceMode::ActiveDocument,
                document_path: Some("docs/report.md".to_string()),
                title: title.to_string(),
                doc_type: "report".to_string(),
                target_rel_path: Some("docs/report.md".to_string()),
            },
            template: None,
            guideline_ids: Vec::new(),
            body_draft: String::new(),
            lint_dismissals: Vec::new(),
            hwp_fields: StudioHwpFieldsState {
                status: "placeholder".to_string(),
                template_path: None,
                fields: Vec::new(),
                values: BTreeMap::new(),
                last_output_path: None,
                form_filled_count: 0,
                unmatched_fields: Vec::new(),
                validation_checks: Vec::new(),
                warnings: Vec::new(),
            },
            export: StudioExportState {
                formats: Vec::new(),
                manifest_path: None,
                summary: None,
                last_run_at: None,
            },
            package: StudioPackageState {
                frozen: false,
                frozen_at: None,
                snapshot_path: None,
            },
            updated_at: String::new(),
        }
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<T>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("studio fixture completion")
    }

    #[test]
    fn phase08_20_studio_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let root = home.root.path();
        boundary(
            root.into(),
            "studio_state_list",
            ipc::studio_state_list(text(root)),
        );
        boundary(
            root.into(),
            "studio_state_read",
            ipc::studio_state_read(text(root), "doc".into()),
        );
        boundary(
            root.into(),
            "studio_state_save",
            ipc::studio_state_save(text(root), sample("doc", "title")),
        );
        boundary(
            root.into(),
            "studio_state_delete",
            ipc::studio_state_delete(text(root), "doc".into()),
        );
        boundary(
            root.into(),
            "studio_apply_body",
            ipc::studio_apply_body(text(root), "docs/report.md".into(), "# Body".into()),
        );
    }

    #[test]
    fn phase08_20_studio_real_fixture_results_and_legacy_rejections() {
        let home = Home::new();
        let root = home.root.path().join("work");
        fs::create_dir_all(root.join("docs")).unwrap();
        let work = text(&root);

        let saved = run(ipc::studio_state_save(
            work.clone(),
            sample("doc-1", "Report"),
        ))
        .unwrap();
        assert_eq!(saved.doc_id, "doc-1");
        assert_eq!(saved.schema_version, STUDIO_SCHEMA_VERSION);
        assert!(!saved.updated_at.is_empty());
        let read = run(ipc::studio_state_read(work.clone(), "doc-1".into()))
            .unwrap()
            .unwrap();
        assert_eq!(read.source.title, "Report");
        let listed = run(ipc::studio_state_list(work.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].doc_id, "doc-1");

        fs::write(
            root.join("docs/report.md"),
            "---\ntype: report\n---\n# Old\n\nBody\n",
        )
        .unwrap();
        let payload = run(ipc::studio_apply_body(
            work.clone(),
            "docs/report.md".into(),
            "# New\n\nUpdated".into(),
        ))
        .unwrap();
        assert_eq!(payload.body, "# New\n\nUpdated\n");
        assert_eq!(
            fs::read_to_string(root.join("docs/report.md")).unwrap(),
            "---\ntype: report\n---\n# New\n\nUpdated\n"
        );

        assert!(run(ipc::studio_state_delete(work.clone(), "doc-1".into())).unwrap());
        assert!(run(ipc::studio_state_read(work.clone(), "doc-1".into()))
            .unwrap()
            .is_none());

        assert_eq!(
            run(ipc::studio_state_save(work.clone(), sample("../bad", "x"))).unwrap_err(),
            "Invalid Studio doc id: ../bad"
        );
        assert!(run(ipc::studio_state_read(work.clone(), "bad/path".into())).is_err());
        assert_eq!(
            run(ipc::studio_apply_body(
                work.clone(),
                "docs/missing.md".into(),
                "# x".into()
            ))
            .unwrap_err(),
            "Document file does not exist"
        );
    }

    #[test]
    fn phase08_20_studio_save_serializes_same_target_both_orders() {
        let home = Home::new();
        for swap in [false, true] {
            let root = home.root.path().join(format!("save-{swap}"));
            fs::create_dir_all(&root).unwrap();
            let work = text(&root);
            let target = root.join(".maru/studio/doc-a/state.json");
            let first_state = sample("doc-a", if swap { "second" } else { "first" });
            let second_state = sample("doc-a", if swap { "first" } else { "second" });
            let expected = if swap { "first" } else { "second" };
            let held = Held::new(target.clone(), "admitted");
            let first = start(ipc::studio_state_save(work.clone(), first_state));
            held.wait();
            let waiting = Held::new(target.clone(), "before-admission");
            let second = start(ipc::studio_state_save(work.clone(), second_state));
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(first).unwrap();
            let written = done(second).unwrap();
            assert_eq!(written.source.title, expected);
            let read = run(ipc::studio_state_read(work, "doc-a".into()))
                .unwrap()
                .unwrap();
            assert_eq!(read.source.title, expected);
            assert_eq!(
                fs::read_to_string(target).unwrap(),
                format!("{}\n", serde_json::to_string_pretty(&written).unwrap())
            );
        }
    }

    #[test]
    fn phase08_20_studio_apply_body_contends_with_document_save_both_orders() {
        let home = Home::new();
        for document_first in [false, true] {
            let root = home.root.path().join(format!("apply-{document_first}"));
            fs::create_dir_all(root.join("docs")).unwrap();
            fs::write(root.join("docs/report.md"), "original").unwrap();
            let work = text(&root);
            let target = root.join("docs/report.md");
            let revision = crate::document::revision_for("original");
            if document_first {
                let held = Held::new(target.clone(), "admitted");
                let first = start(crate::document::ipc::save_document(
                    work.clone(),
                    "docs/report.md".into(),
                    "from document".into(),
                    Some(revision),
                ));
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(ipc::studio_apply_body(
                    work.clone(),
                    "docs/report.md".into(),
                    "from studio".into(),
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                let payload = done(second).unwrap();
                assert_eq!(payload.body, "from studio\n");
            } else {
                let held = Held::new(target.clone(), "admitted");
                let first = start(ipc::studio_apply_body(
                    work.clone(),
                    "docs/report.md".into(),
                    "from studio".into(),
                ));
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(crate::document::ipc::save_document(
                    work.clone(),
                    "docs/report.md".into(),
                    "from document".into(),
                    Some(revision),
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                let err = done(second).unwrap_err();
                assert_eq!(err.code, crate::ipc_error::DOCUMENT_CONFLICT);
            }
            assert_eq!(fs::read_to_string(&target).unwrap(), "from studio\n");
        }
    }

    #[test]
    fn phase08_20_studio_denied_and_error_release_admission() {
        let home = Home::new();
        let root = home.root.path().join("policy");
        fs::create_dir_all(&root).unwrap();
        let work = text(&root);
        crate::scratchpad::phase08_08::registry(&root, "readOnly");
        assert!(run(ipc::studio_state_save(
            work.clone(),
            sample("doc", "denied")
        ))
        .unwrap_err()
        .contains("Workspace writes are blocked"));
        assert!(!root.join(".maru/studio").exists());
        crate::scratchpad::phase08_08::registry(&root, "direct");
        run(ipc::studio_state_save(
            work.clone(),
            sample("doc", "allowed"),
        ))
        .unwrap();

        let target = root.join(".maru/studio/doc/state.json");
        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(
            run(ipc::studio_state_save(work.clone(), sample("doc", "error")))
                .unwrap_err()
                .starts_with("Cannot write Studio state:")
        );
        fs::remove_dir(&target).unwrap();
        run(ipc::studio_state_save(work, sample("doc", "recovered"))).unwrap();
        assert_eq!(
            run(ipc::studio_state_read(text(&root), "doc".into()))
                .unwrap()
                .unwrap()
                .source
                .title,
            "recovered"
        );
    }
}
