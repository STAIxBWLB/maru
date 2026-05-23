use crate::document::{read_document, DocumentPayload};
use crate::kordoc_lite::KordocLiteCheck;
use crate::vault::{lexical_normalize, resolve_inside_vault};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn studio_state_save(work_path: String, mut state: StudioState) -> Result<StudioState, String> {
    validate_doc_id(&state.doc_id)?;
    state.schema_version = STUDIO_SCHEMA_VERSION;
    state.updated_at = Utc::now().to_rfc3339();

    let path = state_path(&work_path, &state.doc_id)?;
    let write_action = if path.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_anchor_can_write(&work_path, write_action)?;
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

#[tauri::command]
pub fn studio_state_delete(
    work_path: String,
    #[allow(non_snake_case)] doc_id: String,
) -> Result<bool, String> {
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    let dir = state_dir(&work_path, &doc_id)?;
    if !dir.exists() {
        return Ok(false);
    }
    fs::remove_dir_all(&dir).map_err(|err| format!("Cannot delete Studio state: {err}"))?;
    Ok(true)
}

#[tauri::command]
pub fn studio_apply_body(
    work_path: String,
    document_path: String,
    body_markdown: String,
) -> Result<DocumentPayload, String> {
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let path = resolve_inside_vault(&work_path, &document_path)?;
    if !path.is_file() {
        return Err("Document file does not exist".to_string());
    }
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let updated = replace_body_preserving_frontmatter(&original, &body_markdown);
    fs::write(&path, updated).map_err(|err| format!("Cannot save document: {err}"))?;
    read_document(work_path, path.to_string_lossy().to_string())
}

fn studio_root(work_path: &str) -> Result<PathBuf, String> {
    resolve_inside_vault(work_path, ".anchor/studio")
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
        return Err("Studio state path escapes .anchor/studio".to_string());
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
        let bad_dir = dir.path().join(".anchor").join("studio").join("bad");
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
