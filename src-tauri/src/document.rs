use crate::filename_rules::{validate_filename_stem, validate_folder_name};
use crate::frontmatter::{build_frontmatter, update_frontmatter_content, FrontmatterValue};
use crate::ipc_error::{IpcError, DOCUMENT_CONFLICT};
use crate::vault::{
    is_document_extension, parse_frontmatter, resolve_inside_vault, semantic_title_from_parts,
    slugify,
};
use crate::vault_guard::{is_managed_root, validate_managed_write};
use crate::vault_list::{assert_document_owner, assert_maru_can_write, WorkspaceWriteAction};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::evidence_binder::rekey_document_states;

/// Frontend-supplied value for a single frontmatter field. Untagged so React
/// can send a bare string / array / number / boolean and we figure it out.
/// Sending `null` (Option::None) deletes the key.
#[derive(Debug, Clone, Deserialize)]
#[serde(untagged)]
pub enum FieldInput {
    Bool(bool),
    Number(f64),
    Str(String),
    List(Vec<String>),
}

impl From<FieldInput> for FrontmatterValue {
    fn from(input: FieldInput) -> Self {
        match input {
            FieldInput::Bool(value) => FrontmatterValue::Bool(value),
            FieldInput::Number(value) => FrontmatterValue::Number(value),
            FieldInput::Str(value) => FrontmatterValue::String(value),
            FieldInput::List(values) => FrontmatterValue::List(values),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentPayload {
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub content: String,
    pub body: String,
    pub meta: BTreeMap<String, Value>,
    pub file_kind: String,
    pub revision: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedDocument {
    pub path: String,
    pub rel_path: String,
    pub title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionSnapshot {
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedDocument {
    pub original_path: String,
    pub original_rel_path: String,
    pub trash_path: String,
    pub trash_rel_path: String,
}

pub fn read_document(vault_path: String, document_path: String) -> Result<DocumentPayload, String> {
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let content =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let parts = parse_frontmatter(&content);
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");
    let title = semantic_title_from_parts(&parts, fallback);
    let rel_path = path
        .strip_prefix(vault)
        .unwrap_or(&path)
        .to_string_lossy()
        .to_string();
    let file_kind = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_string();
    let revision = revision_for(&content);

    Ok(DocumentPayload {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        content,
        body: parts.body,
        meta: parts.meta,
        file_kind,
        revision,
    })
}

pub(crate) fn revision_for(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn assert_expected_revision(current: &str, expected: Option<&str>) -> Result<(), IpcError> {
    if let Some(expected) = expected {
        let actual = revision_for(current);
        if actual != expected {
            return Err(IpcError {
                code: DOCUMENT_CONFLICT.to_string(),
                message: format!("expected revision {expected}, found {actual}"),
            });
        }
    }
    Ok(())
}

pub fn save_document(
    vault_path: String,
    document_path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<DocumentPayload, IpcError> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let request = PathTransactionRequest::new(vec![path, vault.join(".maru/versions")])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    // Keep structured inner conflicts; admission failures remain display-only.
    with_path_transactions(request, |lease| {
        Ok(save_document_in_transaction(
            lease,
            vault_path,
            document_path,
            content,
            expected_revision,
        ))
    })?
}

pub(crate) fn save_document_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
    content: String,
    expected_revision: Option<String>,
) -> Result<DocumentPayload, IpcError> {
    lease.ensure_workspace_registry()?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    lease.ensure_covered(vec![path.clone(), vault.join(".maru/versions")])?;
    assert_document_owner(&vault_path, &path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Modify)?;
    validate_managed_write(&vault_path, &document_path, &content)?;
    if path.is_file() {
        let current =
            fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
        assert_expected_revision(&current, expected_revision.as_deref())?;
    } else if let Some(expected) = expected_revision.as_deref() {
        return Err(IpcError {
            code: DOCUMENT_CONFLICT.to_string(),
            message: format!("expected revision {expected}, file is missing"),
        });
    }
    lease.before_effect()?;
    // Managed roots snapshot the on-disk content before every overwrite
    // (maru-vault-graph-spec §2.4 가드 불변식) — conflict safety vs MCP co-writes.
    if is_managed_root(&vault_path) && path.is_file() {
        if let Ok(previous) = fs::read_to_string(&path) {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("document");
            write_version_snapshot_in_transaction(
                lease,
                &vault_path,
                &document_path,
                stem,
                &previous,
                "managed-write auto snapshot",
            )?;
        }
    }
    // Re-assert the revision right before the write: the checks above (and the
    // managed-root snapshot read) widen the window in which an external
    // co-writer could delete or modify the file. When a revision was expected,
    // a file that vanished or changed in that window must conflict rather than
    // be silently recreated/overwritten — that is exactly this command's
    // guarantee. ponytail: shrinks the TOCTOU to the temp-file rename; the race
    // against an external deleter cannot be fully closed without OS locks it
    // does not honor.
    if expected_revision.is_some() {
        if path.is_file() {
            let current =
                fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
            assert_expected_revision(&current, expected_revision.as_deref())?;
        } else {
            return Err(IpcError {
                code: DOCUMENT_CONFLICT.to_string(),
                message: format!(
                    "expected revision {}, file is missing",
                    expected_revision.as_deref().unwrap_or_default()
                ),
            });
        }
    }
    write_atomic(&path, content.as_bytes())?;
    read_document(vault_path, path.to_string_lossy().to_string()).map_err(Into::into)
}

/// Patch a single frontmatter field on disk while preserving the order and
/// comments of every other key. Sending `value: null` deletes the field.
/// This is the load-bearing primitive for the InspectorPane inline editors.
pub fn update_frontmatter_field(
    vault_path: String,
    document_path: String,
    key: String,
    value: Option<FieldInput>,
    expected_revision: Option<String>,
) -> Result<DocumentPayload, IpcError> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let request = PathTransactionRequest::new(vec![path, vault.join(".maru/versions")])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    // Keep structured inner conflicts; admission failures remain display-only.
    with_path_transactions(request, |lease| {
        Ok(update_frontmatter_field_in_transaction(
            lease,
            vault_path,
            document_path,
            key,
            value,
            expected_revision,
        ))
    })?
}

pub(crate) fn update_frontmatter_field_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
    key: String,
    value: Option<FieldInput>,
    expected_revision: Option<String>,
) -> Result<DocumentPayload, IpcError> {
    lease.ensure_workspace_registry()?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let is_html = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "html" | "htm"))
        .unwrap_or(false);
    if is_html {
        return Err("frontmatter editing is not supported for HTML documents"
            .to_string()
            .into());
    }
    let vault = resolve_inside_vault(&vault_path, ".")?;
    lease.ensure_covered(vec![path.clone(), vault.join(".maru/versions")])?;
    assert_document_owner(&vault_path, &path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Modify)?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    assert_expected_revision(&original, expected_revision.as_deref())?;
    let mapped = value.map(FrontmatterValue::from);
    let updated = update_frontmatter_content(&original, &key, mapped)?;
    if updated != original {
        validate_managed_write(&vault_path, &document_path, &updated)?;
        lease.before_effect()?;
        if is_managed_root(&vault_path) {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("document");
            write_version_snapshot_in_transaction(
                lease,
                &vault_path,
                &document_path,
                stem,
                &original,
                "managed-write auto snapshot",
            )?;
        }
        write_atomic(&path, updated.as_bytes())?;
    }
    read_document(vault_path, path.to_string_lossy().to_string()).map_err(Into::into)
}

/// Optional Hub-driven prefill values. When the user picks a template +
/// guidelines in NewDocumentDialog, the resulting metadata flows here so
/// the new document carries it as proper frontmatter (no HTML comment
/// trailer). All fields are optional — empty values are not written.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocumentExtras {
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub template_slug: Option<String>,
    #[serde(default)]
    pub template_version: Option<u32>,
    #[serde(default)]
    pub guideline_ids: Option<Vec<String>>,
    #[serde(default)]
    pub business_unit: Option<String>,
    #[serde(default)]
    pub program_id: Option<String>,
}

pub fn create_document(
    vault_path: String,
    title: String,
    doc_type: String,
    body: String,
    target_rel_path: Option<String>,
    #[allow(non_snake_case)] extras: Option<CreateDocumentExtras>,
) -> Result<CreatedDocument, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let rel_path = match target_rel_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target) => validate_target_rel_path(target, None)?,
        None => {
            let slug = slugify(&title);
            validate_filename_stem(&slug)?;
            format!("{slug}.md")
        }
    };
    let path = resolve_inside_vault(&vault_path, &rel_path)?;
    let request = PathTransactionRequest::new(vec![path])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        create_document_in_transaction(
            lease,
            vault_path,
            title,
            doc_type,
            body,
            target_rel_path,
            extras,
        )
    })
}

pub(crate) fn create_document_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    title: String,
    doc_type: String,
    body: String,
    target_rel_path: Option<String>,
    #[allow(non_snake_case)] extras: Option<CreateDocumentExtras>,
) -> Result<CreatedDocument, String> {
    lease.ensure_workspace_registry()?;
    let now = Utc::now().to_rfc3339();
    let rel_path = match target_rel_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target) => validate_target_rel_path(target, None)?,
        None => {
            let slug = slugify(&title);
            validate_filename_stem(&slug)?;
            format!("{slug}.md")
        }
    };
    let path = resolve_inside_vault(&vault_path, &rel_path)?;
    lease.ensure_covered(vec![path.clone()])?;
    assert_document_owner(&vault_path, &path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    if path.exists() {
        return Err("A document with that generated file name already exists".to_string());
    }

    // Frontmatter authored in deliberate order: type → status → created_at
    // → updated_at → id (+ optional Hub prefill after). build_frontmatter
    // preserves this ordering, unlike BTreeMap serialization which
    // alphabetizes.
    let mut fields: Vec<(&str, FrontmatterValue)> = vec![
        ("type", FrontmatterValue::String(doc_type)),
        ("status", FrontmatterValue::String("draft".to_string())),
        ("created_at", FrontmatterValue::String(now.clone())),
        ("updated_at", FrontmatterValue::String(now)),
        (
            "id",
            FrontmatterValue::String(format!("doc-{}", Uuid::new_v4())),
        ),
    ];

    if let Some(extras) = extras.as_ref() {
        if let Some(value) = non_empty_string(&extras.template_id) {
            fields.push(("template_id", FrontmatterValue::String(value)));
        }
        if let Some(value) = non_empty_string(&extras.template_slug) {
            fields.push(("template_slug", FrontmatterValue::String(value)));
        }
        if let Some(version) = extras.template_version {
            fields.push((
                "template_version",
                FrontmatterValue::String(format!("v{}", version)),
            ));
        }
        if let Some(value) = non_empty_string(&extras.business_unit) {
            fields.push((
                "business_unit",
                FrontmatterValue::String(format!("[[{}]]", value)),
            ));
        }
        if let Some(value) = non_empty_string(&extras.program_id) {
            fields.push(("program_id", FrontmatterValue::String(value)));
        }
        if let Some(ids) = extras.guideline_ids.as_ref() {
            let cleaned: Vec<String> = ids
                .iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            if !cleaned.is_empty() {
                fields.push(("guideline_ids", FrontmatterValue::List(cleaned)));
            }
        }
    }

    let body_with_heading = format!("# {title}\n\n{body}\n");
    let content = build_frontmatter(&fields, &body_with_heading);
    validate_managed_write(&vault_path, &rel_path, &content)?;

    lease.before_effect()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create parent directory: {err}"))?;
    }
    write_atomic(&path, content.as_bytes())?;

    Ok(CreatedDocument {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
    })
}

fn non_empty_string(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn validate_target_rel_path(target: &str, fallback_ext: Option<&str>) -> Result<String, String> {
    let trimmed = target.trim().trim_matches('/');
    if trimmed.is_empty() || Path::new(trimmed).is_absolute() {
        return Err("Invalid document path".to_string());
    }

    // Preserve a recognized document extension (md/markdown/html/htm) with its
    // original case; a target without one falls back to the caller's
    // extension (e.g. the source file's on move), then `.md`.
    let recognized_ext = Path::new(trimmed)
        .extension()
        .and_then(|value| value.to_str())
        .filter(|value| is_document_extension(value));
    let (without_ext, ext) = match recognized_ext {
        Some(ext) => (
            trimmed[..trimmed.len() - ext.len() - 1].to_string(),
            ext.to_string(),
        ),
        None => (
            trimmed.to_string(),
            fallback_ext.unwrap_or("md").to_string(),
        ),
    };
    let parts: Vec<&str> = without_ext.split('/').collect();
    if parts.is_empty() {
        return Err("Invalid document path".to_string());
    }

    for folder in &parts[..parts.len().saturating_sub(1)] {
        validate_folder_name(folder)?;
    }
    let stem = parts[parts.len() - 1];
    validate_filename_stem(stem)?;

    Ok(format!("{without_ext}.{ext}"))
}

pub fn move_document(
    vault_path: String,
    document_path: String,
    target_rel_path: String,
) -> Result<DocumentPayload, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let source = resolve_inside_vault(&vault_path, &document_path)?;
    let target = validate_target_rel_path(
        &target_rel_path,
        source.extension().and_then(|s| s.to_str()),
    )?;
    let target = resolve_inside_vault(&vault_path, &target)?;
    let request = PathTransactionRequest::new(vec![source, target, vault.join(".maru/binder")])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        move_document_in_transaction(lease, vault_path, document_path, target_rel_path)
    })
}

pub(crate) fn move_document_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
    target_rel_path: String,
) -> Result<DocumentPayload, String> {
    lease.ensure_workspace_registry()?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_existing_document(&source_path)?;

    let source_ext = source_path.extension().and_then(|value| value.to_str());
    let rel_path = validate_target_rel_path(&target_rel_path, source_ext)?;
    let target_path = resolve_inside_vault(&vault_path, &rel_path)?;
    lease.ensure_covered(vec![
        source_path.clone(),
        target_path.clone(),
        vault.join(".maru/binder"),
    ])?;
    assert_document_owner(&vault_path, &source_path)?;
    assert_document_owner(&vault_path, &target_path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::RenameMove)?;
    if paths_match(&source_path, &target_path) {
        return read_document(vault_path, source_path.to_string_lossy().to_string());
    }
    if target_path.exists() {
        return Err("A document already exists at that path".to_string());
    }

    lease.before_effect()?;
    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create target directory: {err}"))?;
    }
    move_file(&source_path, &target_path)?;
    if let Err(err) = rekey_document_states(&vault, &source_path, &target_path) {
        if let Err(rollback_err) = move_file(&target_path, &source_path) {
            return Err(format!(
                "Evidence Binder rekey failed after document move: {err}; move rollback failed: {rollback_err}"
            ));
        }
        return Err(format!(
            "Evidence Binder rekey failed; document move rolled back: {err}"
        ));
    }

    let payload = read_document(vault_path, target_path.to_string_lossy().to_string())?;
    if payload.rel_path != relative(&target_path, &vault) {
        return Err("Moved document resolved outside the selected workspace".to_string());
    }
    Ok(payload)
}

pub fn duplicate_document(
    vault_path: String,
    document_path: String,
) -> Result<DocumentPayload, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let source = resolve_inside_vault(&vault_path, &document_path)?;
    // Reserve the allocation directory plus the exact source's physical alias.
    let parent = source
        .parent()
        .ok_or("Document has no parent")?
        .to_path_buf();
    let request = PathTransactionRequest::new(vec![source, parent])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        duplicate_document_in_transaction(lease, vault_path, document_path)
    })
}

pub(crate) fn duplicate_document_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
) -> Result<DocumentPayload, String> {
    lease.ensure_workspace_registry()?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    lease.ensure_covered(vec![
        source_path.clone(),
        source_path
            .parent()
            .ok_or("Document has no parent")?
            .to_path_buf(),
    ])?;
    assert_document_owner(&vault_path, &source_path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    ensure_existing_document(&source_path)?;
    let target_path = unique_duplicate_path(&source_path);
    if is_managed_root(&vault_path) {
        let vault = resolve_inside_vault(&vault_path, ".")?;
        let content = fs::read_to_string(&source_path)
            .map_err(|err| format!("Cannot read document: {err}"))?;
        validate_managed_write(&vault_path, &relative(&target_path, &vault), &content)?;
    }
    lease.ensure_covered(vec![target_path.clone()])?;
    lease.before_effect()?;
    fs::copy(&source_path, &target_path)
        .map_err(|err| format!("Cannot duplicate document: {err}"))?;
    read_document(vault_path, target_path.to_string_lossy().to_string())
}

pub fn trash_document(
    vault_path: String,
    document_path: String,
) -> Result<DeletedDocument, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let source = resolve_inside_vault(&vault_path, &document_path)?;
    let request = PathTransactionRequest::new(vec![source, vault.join(".maru/trash/documents")])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        trash_document_in_transaction(lease, vault_path, document_path)
    })
}

pub(crate) fn trash_document_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
) -> Result<DeletedDocument, String> {
    lease.ensure_workspace_registry()?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    lease.ensure_covered(vec![
        source_path.clone(),
        vault.join(".maru/trash/documents"),
    ])?;
    assert_document_owner(&vault_path, &source_path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Delete)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_existing_document(&source_path)?;
    let original_rel_path = relative(&source_path, &vault);
    let trash_path = unique_trash_path(&source_path, &vault)?;
    lease.ensure_covered(vec![trash_path.clone()])?;
    lease.before_effect()?;
    if let Some(parent) = trash_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create trash directory: {err}"))?;
    }
    move_file(&source_path, &trash_path)?;
    let trash_rel_path = relative(&trash_path, &vault);

    Ok(DeletedDocument {
        original_path: source_path.to_string_lossy().to_string(),
        original_rel_path,
        trash_path: trash_path.to_string_lossy().to_string(),
        trash_rel_path,
    })
}

fn ensure_existing_document(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Err("Document file does not exist".to_string());
    }
    if !path.is_file() {
        return Err("Document path is not a file".to_string());
    }
    Ok(())
}

fn paths_match(left: &Path, right: &Path) -> bool {
    left == right || left.canonicalize().ok() == right.canonicalize().ok()
}

fn move_file(source_path: &Path, target_path: &Path) -> Result<(), String> {
    match fs::rename(source_path, target_path) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            fs::copy(source_path, target_path).map_err(|copy_err| {
                format!("Cannot move document: {rename_err}; copy fallback failed: {copy_err}")
            })?;
            fs::remove_file(source_path)
                .map_err(|remove_err| format!("Cannot remove original after move: {remove_err}"))
        }
    }
}

fn unique_duplicate_path(source_path: &Path) -> PathBuf {
    let parent = source_path.parent().unwrap_or_else(|| Path::new(""));
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let ext = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let mut counter = 1;
    loop {
        let suffix = if counter == 1 {
            "-copy".to_string()
        } else {
            format!("-copy-{counter}")
        };
        let candidate = parent.join(format!("{stem}{suffix}.{ext}"));
        if !candidate.exists() {
            return candidate;
        }
        counter += 1;
    }
}

fn unique_trash_path(source_path: &Path, vault: &Path) -> Result<PathBuf, String> {
    let original_rel_parent = source_path
        .strip_prefix(vault)
        .unwrap_or(source_path)
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let stem = source_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("document");
    let ext = source_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let trash_dir = vault
        .join(".maru")
        .join("trash")
        .join("documents")
        .join(original_rel_parent);
    let base = format!("{stem}-{timestamp}");
    for counter in 1.. {
        let file_name = if counter == 1 {
            format!("{base}.{ext}")
        } else {
            format!("{base}-{counter}.{ext}")
        };
        let candidate = trash_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Cannot allocate trash path".to_string())
}

pub fn create_version(
    vault_path: String,
    document_path: String,
    title: String,
    content: String,
    summary: String,
) -> Result<VersionSnapshot, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let request = PathTransactionRequest::new(vec![path, vault.join(".maru/versions")])?
        .with_workspace_registry()?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        create_version_in_transaction(lease, vault_path, document_path, title, content, summary)
    })
}

pub(crate) fn create_version_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    document_path: String,
    title: String,
    content: String,
    summary: String,
) -> Result<VersionSnapshot, String> {
    lease.ensure_workspace_registry()?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    lease.ensure_covered(vec![source_path.clone(), vault.join(".maru/versions")])?;
    assert_document_owner(&vault_path, &source_path)?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    write_version_snapshot_in_transaction(
        lease,
        &vault_path,
        &document_path,
        &title,
        &content,
        &summary,
    )
}

/// Snapshot-writing body of create_version, shared with the managed-write
/// path (which snapshots the on-disk content before every overwrite —
/// maru-vault-graph-spec §2.4 가드 불변식). No capability assert here; the
/// command wrapper and the managed gate each own their own checks.
pub(crate) fn write_version_snapshot(
    vault_path: &str,
    document_path: &str,
    title: &str,
    content: &str,
    summary: &str,
) -> Result<VersionSnapshot, String> {
    let vault = resolve_inside_vault(vault_path, ".")?;
    let source = resolve_inside_vault(vault_path, document_path)?;
    let request = PathTransactionRequest::new(vec![source, vault.join(".maru/versions")])?
        .require_parent(&vault)?;
    with_path_transactions(request, |lease| {
        write_version_snapshot_in_transaction(
            lease,
            vault_path,
            document_path,
            title,
            content,
            summary,
        )
    })
}

pub(crate) fn write_version_snapshot_in_transaction(
    lease: &PathTransactionLease,
    vault_path: &str,
    document_path: &str,
    title: &str,
    content: &str,
    summary: &str,
) -> Result<VersionSnapshot, String> {
    let source_path = resolve_inside_vault(vault_path, document_path)?;
    let vault = resolve_inside_vault(vault_path, ".")?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let ext = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("md");
    let timestamp = Utc::now();
    let version_dir = vault.join(".maru").join("versions");
    lease.ensure_covered(vec![source_path.clone(), version_dir.clone()])?;
    lease.before_effect()?;
    fs::create_dir_all(&version_dir)
        .map_err(|err| format!("Cannot create version directory: {err}"))?;
    let file_name = format!(
        "{stem}-{}-{}.{}",
        timestamp.format("%Y%m%d-%H%M%S%.3f"),
        Uuid::new_v4().simple(),
        ext
    );
    let version_path = version_dir.join(file_name);

    let body = if content.trim_start().starts_with("---\n") {
        parse_frontmatter(content).body
    } else {
        content.to_string()
    };
    let snapshot_title = format!("{title} - {}", timestamp.format("%Y.%m.%d %H:%M"));

    let fields = vec![
        ("type", FrontmatterValue::String("Version".to_string())),
        ("status", FrontmatterValue::String("snapshot".to_string())),
        (
            "version_of",
            FrontmatterValue::String(relative(&source_path, &vault)),
        ),
        ("summary", FrontmatterValue::String(summary.to_string())),
        (
            "created_at",
            FrontmatterValue::String(timestamp.to_rfc3339()),
        ),
    ];
    let body_with_heading = format!("# {snapshot_title}\n\n{body}");
    let snapshot = build_frontmatter(&fields, &body_with_heading);

    write_atomic(&version_path, snapshot.as_bytes())?;

    Ok(VersionSnapshot {
        path: version_path.to_string_lossy().to_string(),
        rel_path: relative(&version_path, &vault),
        title: snapshot_title,
        created_at: timestamp.to_rfc3339(),
    })
}

fn relative(path: &Path, vault: &Path) -> String {
    path.strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string()
}

/// IPC scheduling boundary; synchronous domain/CLI APIs remain available.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn read_document(
        vault_path: String,
        document_path: String,
    ) -> Result<DocumentPayload, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:read_document");
            super::read_document(vault_path, document_path)
        })
        .await
        .map_err(|err| format!("read_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn save_document(
        vault_path: String,
        document_path: String,
        content: String,
        expected_revision: Option<String>,
    ) -> Result<DocumentPayload, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:save_document");
            super::save_document(vault_path, document_path, content, expected_revision)
        })
        .await
        .map_err(|err| IpcError::from(format!("save_document_task_failed: {err}")))?
    }
    #[tauri::command]
    pub async fn update_frontmatter_field(
        vault_path: String,
        document_path: String,
        key: String,
        value: Option<FieldInput>,
        expected_revision: Option<String>,
    ) -> Result<DocumentPayload, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:update_frontmatter_field",
            );
            super::update_frontmatter_field(
                vault_path,
                document_path,
                key,
                value,
                expected_revision,
            )
        })
        .await
        .map_err(|err| IpcError::from(format!("update_frontmatter_field_task_failed: {err}")))?
    }
    #[tauri::command]
    pub async fn create_document(
        vault_path: String,
        title: String,
        doc_type: String,
        body: String,
        target_rel_path: Option<String>,
        #[allow(non_snake_case)] extras: Option<CreateDocumentExtras>,
    ) -> Result<CreatedDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:create_document",
            );
            super::create_document(vault_path, title, doc_type, body, target_rel_path, extras)
        })
        .await
        .map_err(|err| format!("create_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn move_document(
        vault_path: String,
        document_path: String,
        target_rel_path: String,
    ) -> Result<DocumentPayload, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:move_document");
            super::move_document(vault_path, document_path, target_rel_path)
        })
        .await
        .map_err(|err| format!("move_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn duplicate_document(
        vault_path: String,
        document_path: String,
    ) -> Result<DocumentPayload, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:duplicate_document",
            );
            super::duplicate_document(vault_path, document_path)
        })
        .await
        .map_err(|err| format!("duplicate_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn trash_document(
        vault_path: String,
        document_path: String,
    ) -> Result<DeletedDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:trash_document",
            );
            super::trash_document(vault_path, document_path)
        })
        .await
        .map_err(|err| format!("trash_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn create_version(
        vault_path: String,
        document_path: String,
        title: String,
        content: String,
        summary: String,
    ) -> Result<VersionSnapshot, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:create_version",
            );
            super::create_version(vault_path, document_path, title, content, summary)
        })
        .await
        .map_err(|err| format!("create_version_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// The Phase 0 verification gate as a unit test: a real-world Korean
    /// frontmatter note read by maru and written back unchanged must
    /// produce byte-identical output. If this ever breaks, Obsidian users
    /// pointing maru at their vault will see frontmatter mangle.
    #[test]
    fn read_then_save_unchanged_is_byte_identical() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let original = "---\n\
            title: 제주한라대 RISE 2026\n\
            status: 진행중\n\
            tags:\n  - 보고서\n  - 행정\n\
            author: 이영준 (李永俊)\n\
            project: \"[[Maru]]\"\n\
            ---\n\
            # 본문\n\
            \n\
            한국어 + 한자(重要) + emoji 🌊 + KaTeX $\\sum$ 모두 보존되어야 함.\n";
        fs::write(tmp.path().join("note.md"), original).unwrap();

        let payload = read_document(root.clone(), "note.md".to_string()).unwrap();
        // The raw content surfaced to React must equal what's on disk —
        // any normalization in read would break byte-identity.
        assert_eq!(
            payload.content, original,
            "read_document.content must match disk byte-for-byte"
        );

        save_document(
            root.clone(),
            payload.path.clone(),
            payload.content.clone(),
            Some(payload.revision.clone()),
        )
        .unwrap();

        let after = fs::read_to_string(tmp.path().join("note.md")).unwrap();
        assert_eq!(
            after, original,
            "read→save with unchanged content must be byte-identical (frontmatter order, comments, trailing newline all preserved)"
        );
    }

    #[test]
    fn semantic_title_matches_vault_scan_for_frontmatter_only_document() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let original =
            "---\ntitle: '  Frontmatter title  '\nstatus: draft\n---\nNo heading here.\n";
        fs::write(tmp.path().join("note.md"), original).unwrap();

        let scanned = crate::vault::scan_vault(root.clone(), None).unwrap();
        let opened = read_document(root, "note.md".to_string()).unwrap();

        assert_eq!(scanned[0].title, "Frontmatter title");
        assert_eq!(opened.title, scanned[0].title);
        assert_eq!(opened.content, original);
        assert_eq!(opened.body, "No heading here.\n");
        assert_eq!(
            opened.meta.get("status").and_then(Value::as_str),
            Some("draft")
        );
        assert_eq!(opened.file_kind, "md");
    }

    #[test]
    fn save_rejects_stale_revision() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("note.md"), "# Original\n").unwrap();
        let opened = read_document(root.clone(), "note.md".to_string()).unwrap();
        fs::write(tmp.path().join("note.md"), "# External edit\n").unwrap();

        let error = save_document(
            root,
            "note.md".to_string(),
            "# Maru edit\n".to_string(),
            Some(opened.revision),
        )
        .unwrap_err();

        assert_eq!(error.code, DOCUMENT_CONFLICT);
        assert!(error.to_string().starts_with("document_conflict:"));
        assert_eq!(
            fs::read_to_string(tmp.path().join("note.md")).unwrap(),
            "# External edit\n"
        );
    }

    /// update_frontmatter_field is the InspectorPane backend — a single-field
    /// patch must touch only that key, leaving order/comments/values of every
    /// other field byte-identical.
    #[test]
    fn update_frontmatter_field_isolates_changes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let original = "---\n\
            title: 제주한라대 RISE 2026\n\
            status: 진행중\n\
            # 내부 메모 — 외부 공개 X\n\
            tags:\n  - 보고서\n  - 행정\n\
            author: 이영준 (李永俊)\n\
            ---\n\
            # 본문\n\nhello\n";
        fs::write(tmp.path().join("note.md"), original).unwrap();

        let payload = update_frontmatter_field(
            root.clone(),
            "note.md".to_string(),
            "status".to_string(),
            Some(FieldInput::Str("완료".to_string())),
            None,
        )
        .unwrap();

        // Title, comment, tags, author all preserved verbatim.
        assert!(payload.content.contains("title: 제주한라대 RISE 2026"));
        assert!(payload.content.contains("# 내부 메모 — 외부 공개 X"));
        assert!(payload.content.contains("- 보고서"));
        assert!(payload.content.contains("- 행정"));
        assert!(payload.content.contains("author: 이영준 (李永俊)"));
        // Status updated.
        assert!(payload.content.contains("status: 완료"));
        assert!(!payload.content.contains("status: 진행중"));
        // Order preserved.
        let title_pos = payload.content.find("title:").unwrap();
        let status_pos = payload.content.find("status:").unwrap();
        let tags_pos = payload.content.find("tags:").unwrap();
        let author_pos = payload.content.find("author:").unwrap();
        assert!(title_pos < status_pos);
        assert!(status_pos < tags_pos);
        assert!(tags_pos < author_pos);
        // Body intact + trailing newline preserved.
        assert!(payload.content.contains("# 본문"));
        assert!(payload.content.ends_with('\n'));
    }

    /// Updating a list-typed field (tags) must round-trip the array form.
    #[test]
    fn update_frontmatter_field_list_round_trips() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let original = "---\nstatus: draft\ntags:\n  - old\n---\n# X\n";
        fs::write(tmp.path().join("note.md"), original).unwrap();

        let payload = update_frontmatter_field(
            root,
            "note.md".to_string(),
            "tags".to_string(),
            Some(FieldInput::List(vec![
                "alpha".to_string(),
                "beta".to_string(),
            ])),
            None,
        )
        .unwrap();

        assert!(payload.content.contains("- \"alpha\""));
        assert!(payload.content.contains("- \"beta\""));
        assert!(!payload.content.contains("- old"));
        assert!(payload.content.contains("status: draft"));
    }

    /// Sending None must delete the key without disturbing siblings.
    #[test]
    fn update_frontmatter_field_null_deletes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let original = "---\ntitle: keep\nephemeral: drop\nstatus: keep\n---\n# X\n";
        fs::write(tmp.path().join("note.md"), original).unwrap();

        let payload = update_frontmatter_field(
            root,
            "note.md".to_string(),
            "ephemeral".to_string(),
            None,
            None,
        )
        .unwrap();

        assert!(!payload.content.contains("ephemeral"));
        assert!(payload.content.contains("title: keep"));
        assert!(payload.content.contains("status: keep"));
    }

    #[test]
    fn create_document_emits_deterministic_field_order() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let created = create_document(
            root.clone(),
            "테스트 문서".to_string(),
            "meeting".to_string(),
            "본문".to_string(),
            None,
            None,
        )
        .unwrap();

        let content = fs::read_to_string(tmp.path().join(&created.rel_path)).unwrap();
        // Field order must be type → status → created_at → updated_at → id.
        // BTreeMap-based serialization (the prior bug) would alphabetize them.
        let type_pos = content.find("\ntype:").unwrap_or(0);
        let status_pos = content.find("\nstatus:").unwrap_or(0);
        let created_pos = content.find("\ncreated_at:").unwrap_or(0);
        let updated_pos = content.find("\nupdated_at:").unwrap_or(0);
        let id_pos = content.find("\nid:").unwrap_or(0);
        assert!(type_pos < status_pos, "type must precede status");
        assert!(status_pos < created_pos, "status must precede created_at");
        assert!(
            created_pos < updated_pos,
            "created_at must precede updated_at"
        );
        assert!(updated_pos < id_pos, "updated_at must precede id");

        // Korean title must round-trip through slugify + write.
        assert!(
            created.rel_path.ends_with(".md"),
            "rel_path must end with .md"
        );
    }

    #[test]
    fn create_document_accepts_valid_nested_target_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let created = create_document(
            root,
            "새 회의록".to_string(),
            "meeting".to_string(),
            "".to_string(),
            Some("meetings/새 회의록".to_string()),
            None,
        )
        .unwrap();

        assert_eq!(created.rel_path, "meetings/새 회의록.md");
        assert!(tmp.path().join("meetings").join("새 회의록.md").exists());
    }

    #[test]
    fn create_document_rejects_unsafe_target_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let traversal = create_document(
            root.clone(),
            "Bad".to_string(),
            "reference".to_string(),
            "".to_string(),
            Some("../Bad".to_string()),
            None,
        );
        assert!(traversal.is_err());

        let reserved = create_document(
            root,
            "Bad".to_string(),
            "reference".to_string(),
            "".to_string(),
            Some("projects/CON".to_string()),
            None,
        );
        assert!(reserved.is_err());
    }

    #[test]
    fn create_document_emits_hub_prefill_in_deterministic_order() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let created = create_document(
            root,
            "Y2-2 중간보고".to_string(),
            "report".to_string(),
            "본문".to_string(),
            None,
            Some(CreateDocumentExtras {
                template_id: Some("tpl_01HZ8FX9TESTTEMPLATEABC123".to_string()),
                template_slug: Some("business-plan-default".to_string()),
                template_version: Some(1),
                guideline_ids: Some(vec![
                    "gdl_gaejosik".to_string(),
                    "gdl_vocational_writing_style".to_string(),
                ]),
                business_unit: Some("koica-tiu".to_string()),
                program_id: Some("prg_01HZ8FX9KOICATIU000000001".to_string()),
            }),
        )
        .unwrap();
        let content = fs::read_to_string(tmp.path().join(&created.rel_path)).unwrap();

        // Deterministic order: core fields first, then Hub prefill in spec
        // order (template_id → template_slug → template_version →
        // business_unit → program_id → guideline_ids).
        let positions = [
            "\ntype:",
            "\nstatus:",
            "\ncreated_at:",
            "\nupdated_at:",
            "\nid:",
            "\ntemplate_id:",
            "\ntemplate_slug:",
            "\ntemplate_version:",
            "\nbusiness_unit:",
            "\nprogram_id:",
            "\nguideline_ids:",
        ];
        let mut last = 0;
        for key in positions {
            let pos = content
                .find(key)
                .unwrap_or_else(|| panic!("missing field {key} in:\n{content}"));
            assert!(pos > last, "field {key} out of order");
            last = pos;
        }
        assert!(content.contains("business_unit: \"[[koica-tiu]]\""));
        assert!(content.contains("template_version: v1"));
        assert!(content.contains("- \"gdl_gaejosik\""));
        assert!(content.contains("- \"gdl_vocational_writing_style\""));
    }

    #[test]
    fn create_document_skips_empty_extras() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let created = create_document(
            root,
            "noop".to_string(),
            "reference".to_string(),
            "".to_string(),
            None,
            Some(CreateDocumentExtras {
                template_id: Some("   ".to_string()),
                template_slug: None,
                template_version: None,
                guideline_ids: Some(vec!["".to_string(), "  ".to_string()]),
                business_unit: None,
                program_id: None,
            }),
        )
        .unwrap();
        let content = fs::read_to_string(tmp.path().join(&created.rel_path)).unwrap();
        assert!(!content.contains("template_id:"));
        assert!(!content.contains("template_slug:"));
        assert!(!content.contains("guideline_ids:"));
    }

    #[test]
    fn move_document_moves_nested_document_and_returns_payload() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let source = tmp.path().join("notes").join("weekly.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "# Weekly\n\nbody\n").unwrap();
        let binder_dir = tmp.path().join(".maru").join("binder");
        fs::create_dir_all(&binder_dir).unwrap();
        fs::write(
            binder_dir.join("notes-weekly.json"),
            format!(
                r#"{{"schemaVersion":2,"docId":"notes-weekly","documentPath":{},"bindings":[],"updatedAt":"2026-07-25T00:00:00Z"}}"#,
                serde_json::to_string(&source.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();

        let payload = move_document(
            root,
            "notes/weekly.md".to_string(),
            "archive/weekly-renamed".to_string(),
        )
        .unwrap();

        assert_eq!(payload.rel_path, "archive/weekly-renamed.md");
        assert_eq!(payload.content, "# Weekly\n\nbody\n");
        assert!(!source.exists());
        assert!(tmp
            .path()
            .join("archive")
            .join("weekly-renamed.md")
            .exists());
        assert!(!binder_dir.join("notes-weekly.json").exists());
        let binder: serde_json::Value = serde_json::from_str(
            &fs::read_to_string(binder_dir.join("archive-weekly-renamed.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(binder["docId"], "archive-weekly-renamed");
        assert_eq!(
            binder["documentPath"],
            tmp.path()
                .join("archive/weekly-renamed.md")
                .to_string_lossy()
                .as_ref()
        );
    }

    #[test]
    fn move_document_rejects_unsafe_and_existing_targets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("source.md"), "# Source\n").unwrap();
        fs::write(tmp.path().join("existing.md"), "# Existing\n").unwrap();

        let traversal = move_document(
            root.clone(),
            "source.md".to_string(),
            "../outside.md".to_string(),
        );
        assert!(traversal.is_err());

        let invalid = move_document(
            root.clone(),
            "source.md".to_string(),
            "notes/bad:name.md".to_string(),
        );
        assert!(invalid.is_err());

        let overwrite = move_document(root, "source.md".to_string(), "existing.md".to_string());
        assert!(overwrite.is_err());
        assert!(tmp.path().join("source.md").exists());
        assert!(tmp.path().join("existing.md").exists());
    }

    #[test]
    fn duplicate_document_creates_unique_copy_and_preserves_bytes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let original = b"---\ntype: reference\n---\n# Binary-ish bytes\n\x00\x01\n";
        fs::write(tmp.path().join("source.md"), original).unwrap();
        fs::write(tmp.path().join("source-copy.md"), b"existing").unwrap();

        let payload = duplicate_document(root, "source.md".to_string()).unwrap();

        assert_eq!(payload.rel_path, "source-copy-2.md");
        assert_eq!(
            fs::read(tmp.path().join("source-copy-2.md")).unwrap(),
            original
        );
    }

    #[test]
    fn trash_document_moves_to_maru_trash_and_removes_source() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let source = tmp.path().join("meetings").join("weekly.md");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "# Weekly\n").unwrap();

        let deleted = trash_document(root, "meetings/weekly.md".to_string()).unwrap();

        assert_eq!(deleted.original_rel_path, "meetings/weekly.md");
        assert!(!source.exists());
        assert!(deleted
            .trash_rel_path
            .starts_with(".maru/trash/documents/meetings/weekly-"));
        assert!(Path::new(&deleted.trash_path).exists());
        assert_eq!(
            fs::read_to_string(deleted.trash_path).unwrap(),
            "# Weekly\n"
        );
    }

    #[test]
    fn move_document_preserves_html_extension_and_case() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        let source = tmp.path().join("notes").join("page.HTML");
        fs::create_dir_all(source.parent().unwrap()).unwrap();
        fs::write(&source, "<html><body>hi</body></html>").unwrap();

        // Target without an extension falls back to the source extension.
        let payload = move_document(
            root.clone(),
            "notes/page.HTML".to_string(),
            "archive/renamed".to_string(),
        )
        .unwrap();
        assert_eq!(payload.rel_path, "archive/renamed.HTML");
        assert!(tmp.path().join("archive").join("renamed.HTML").exists());

        // An explicit recognized extension is kept as given.
        let payload = move_document(
            root,
            "archive/renamed.HTML".to_string(),
            "archive/final.htm".to_string(),
        )
        .unwrap();
        assert_eq!(payload.rel_path, "archive/final.htm");
        assert!(tmp.path().join("archive").join("final.htm").exists());
    }

    #[test]
    fn duplicate_document_preserves_html_extension_and_case() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("page.HTML"), "<html></html>").unwrap();

        let payload = duplicate_document(root, "page.HTML".to_string()).unwrap();

        assert_eq!(payload.rel_path, "page-copy.HTML");
        assert!(tmp.path().join("page-copy.HTML").exists());
    }

    #[test]
    fn trash_document_preserves_html_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("page.htm"), "<html></html>").unwrap();

        let deleted = trash_document(root, "page.htm".to_string()).unwrap();

        assert!(deleted.trash_rel_path.ends_with(".htm"));
        assert!(Path::new(&deleted.trash_path).exists());
    }

    #[test]
    fn create_version_snapshot_uses_source_extension() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("page.HTML"), "<html></html>").unwrap();

        let snapshot = create_version(
            root,
            "page.HTML".to_string(),
            "page".to_string(),
            "<html></html>".to_string(),
            "manual snapshot".to_string(),
        )
        .unwrap();

        assert!(snapshot.rel_path.ends_with(".HTML"));
        assert!(Path::new(&snapshot.path).exists());
    }

    #[test]
    fn update_frontmatter_field_rejects_html_documents() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();
        fs::write(tmp.path().join("page.html"), "<html></html>").unwrap();

        let error = update_frontmatter_field(
            root,
            "page.html".to_string(),
            "status".to_string(),
            Some(FieldInput::Str("done".to_string())),
            None,
        )
        .unwrap_err();

        assert_eq!(
            error.to_string(),
            "frontmatter editing is not supported for HTML documents"
        );
    }

    #[test]
    fn save_document_with_expected_revision_and_missing_file_conflicts() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let error = save_document(
            root,
            "ghost.md".to_string(),
            "# New\n".to_string(),
            Some("abc123".to_string()),
        )
        .unwrap_err();

        assert_eq!(error.code, DOCUMENT_CONFLICT);
        assert_eq!(
            error.to_string(),
            "document_conflict: expected revision abc123, file is missing"
        );
        assert!(!tmp.path().join("ghost.md").exists());
    }
}

#[cfg(test)]
mod phase08_07 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::workspace_files::phase08_06::TrashFixture;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
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
            .expect("bounded real command completion")
    }
    fn binder(root: &Path, rel: &str, id: &str) {
        fs::create_dir_all(root.join(".maru/binder")).unwrap();
        fs::write(
            root.join(format!(".maru/binder/{id}.json")),
            serde_json::json!({
                "schemaVersion": 2, "docId": id, "documentPath": text(&root.join(rel)),
                "bindings": [], "updatedAt": "2026-09-05T00:00:00Z"
            })
            .to_string(),
        )
        .unwrap();
    }
    fn assert_binder(root: &Path, rel: &str, id: &str) {
        let value: serde_json::Value = serde_json::from_slice(
            &fs::read(root.join(format!(".maru/binder/{id}.json"))).unwrap(),
        )
        .unwrap();
        assert_eq!(value["docId"], id);
        assert_eq!(value["documentPath"], text(&root.join(rel)));
    }

    #[test]
    fn phase08_07_all_document_wrappers_yield_on_same_polling_task() {
        let home = Home::new();
        let root = home.root.path();
        let s = text(root);
        boundary(
            root.into(),
            "read_document",
            ipc::read_document(s.clone(), "note.md".into()),
        );
        let t = s.clone();
        boundary(root.into(), "save_document", async move {
            ipc::save_document(t, "note.md".into(), "body".into(), None)
                .await
                .map_err(|e| e.to_string())
        });
        let t = s.clone();
        boundary(root.into(), "update_frontmatter_field", async move {
            ipc::update_frontmatter_field(t, "note.md".into(), "status".into(), None, None)
                .await
                .map_err(|e| e.to_string())
        });
        boundary(
            root.into(),
            "create_document",
            ipc::create_document(
                s.clone(),
                "new".into(),
                "reference".into(),
                "body".into(),
                None,
                None,
            ),
        );
        boundary(
            root.into(),
            "move_document",
            ipc::move_document(s.clone(), "note.md".into(), "next.md".into()),
        );
        boundary(
            root.into(),
            "duplicate_document",
            ipc::duplicate_document(s.clone(), "note.md".into()),
        );
        boundary(
            root.into(),
            "trash_document",
            ipc::trash_document(s.clone(), "note.md".into()),
        );
        boundary(
            root.into(),
            "create_version",
            ipc::create_version(
                s,
                "note.md".into(),
                "title".into(),
                "body".into(),
                "snapshot".into(),
            ),
        );
    }

    #[test]
    fn phase08_07_actual_wrappers_preserve_nonempty_payloads_and_typed_conflicts() {
        let home = Home::new();
        let root = home.root.path();
        let s = text(root);
        let created = run(ipc::create_document(
            s.clone(),
            "note".into(),
            "reference".into(),
            "본문 bytes".into(),
            None,
            None,
        ))
        .unwrap();
        let opened = run(ipc::read_document(s.clone(), created.rel_path.clone())).unwrap();
        assert!(opened.body.contains("본문 bytes"));
        let patched = run(ipc::update_frontmatter_field(
            s.clone(),
            created.rel_path.clone(),
            "status".into(),
            Some(FieldInput::Str("done".into())),
            Some(opened.revision.clone()),
        ))
        .unwrap();
        assert_eq!(opened.body.as_bytes(), patched.body.as_bytes());
        let error = run(ipc::save_document(
            s.clone(),
            created.rel_path.clone(),
            "stale".into(),
            Some(opened.revision),
        ))
        .unwrap_err();
        assert_eq!(error.code, DOCUMENT_CONFLICT);
        assert_eq!(fs::read_to_string(&created.path).unwrap(), patched.content);
        let saved = run(ipc::save_document(
            s.clone(),
            created.rel_path.clone(),
            "# saved\nbody\n".into(),
            Some(patched.revision),
        ))
        .unwrap();
        let copy = run(ipc::duplicate_document(s.clone(), saved.rel_path.clone())).unwrap();
        assert_eq!(copy.content, saved.content);
        binder(root, &copy.rel_path, "note-copy");
        let moved = run(ipc::move_document(
            s.clone(),
            copy.rel_path,
            "nested/moved.md".into(),
        ))
        .unwrap();
        assert_binder(root, "nested/moved.md", "nested-moved");
        assert!(!root.join(".maru/binder/note-copy.json").exists());
        let snap = run(ipc::create_version(
            s.clone(),
            moved.rel_path.clone(),
            "title".into(),
            moved.content.clone(),
            "reason".into(),
        ))
        .unwrap();
        assert!(fs::read_to_string(snap.path).unwrap().contains("reason"));
        let trash = run(ipc::trash_document(s.clone(), moved.rel_path)).unwrap();
        assert_eq!(fs::read_to_string(trash.trash_path).unwrap(), saved.content);
        assert!(!Path::new(&trash.original_path).exists());
        let missing = run(ipc::save_document(
            s,
            "missing.md".into(),
            "new".into(),
            Some("previous".into()),
        ))
        .unwrap_err();
        assert_eq!(missing.code, DOCUMENT_CONFLICT);
    }

    #[cfg(unix)]
    #[test]
    fn phase08_07_parent_child_races_all_pairs_both_orders_and_aliases() {
        let home = Home::new();
        for parent in ["rename", "trash"] {
            for child in ["save", "create"] {
                for parent_first in [false, true] {
                    for alias in ["lexical", "symlink", "ancestor"] {
                        let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
                        let root = fixture.path();
                        let s = text(root);
                        let a = root.join("a");
                        fs::create_dir(&a).unwrap();
                        fs::write(a.join("note.md"), "# original\nbody\n").unwrap();
                        binder(root, "a/note.md", "a-note");
                        let child_rel = match alias {
                            "symlink" => {
                                std::os::unix::fs::symlink(&a, root.join("alias")).unwrap();
                                "alias"
                            }
                            "ancestor" => {
                                std::os::unix::fs::symlink(root, root.join("ancestor")).unwrap();
                                "ancestor/a"
                            }
                            _ => "a",
                        };
                        let name = if child == "save" { "note.md" } else { "new.md" };
                        let rel = format!("{child_rel}/{name}");
                        let target = root.join(&rel);
                        let moved = root.join("b");
                        let trashed = root.join("fixture-trash");
                        let _trash = TrashFixture::new(a.clone(), trashed.clone());
                        let parent_future = async move {
                            if parent == "rename" {
                                crate::workspace_files::ipc::rename_workspace_entry(
                                    s,
                                    "a".into(),
                                    "b".into(),
                                )
                                .await
                                .map(|o| assert!(o.error.is_none()))
                            } else {
                                crate::workspace_files::ipc::trash_workspace_entries(
                                    s,
                                    vec!["a".into()],
                                )
                                .await
                                .map(|o| {
                                    assert_eq!(o.len(), 1);
                                    assert!(o[0].error.is_none());
                                })
                            }
                        };
                        let s = text(root);
                        let revision = revision_for("# original\nbody\n");
                        let child_future = async move {
                            if child == "save" {
                                ipc::save_document(
                                    s,
                                    rel,
                                    "# child committed\nbody\n".into(),
                                    Some(revision),
                                )
                                .await
                                .map(|_| ())
                                .map_err(|e| e.to_string())
                            } else {
                                ipc::create_document(
                                    s,
                                    "child committed".into(),
                                    "reference".into(),
                                    "body".into(),
                                    Some(rel),
                                    None,
                                )
                                .await
                                .map(|_| ())
                            }
                        };
                        if parent_first {
                            let held = Held::new(a.clone(), "pre-effect");
                            let p = start(parent_future);
                            held.wait();
                            let wait = Held::new(target, "before-admission");
                            let c = start(child_future);
                            wait.wait();
                            wait.release();
                            assert!(c.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(p).unwrap();
                            assert!(
                                done(c).is_err(),
                                "{parent}/{child}/{alias}: old child must fail"
                            );
                        } else {
                            let held = Held::new(target, "pre-effect");
                            let c = start(child_future);
                            held.wait();
                            let wait = Held::new(a.clone(), "before-admission");
                            let p = start(parent_future);
                            wait.wait();
                            wait.release();
                            assert!(p.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(c).unwrap();
                            done(p).unwrap();
                            let final_root = if parent == "rename" { &moved } else { &trashed };
                            assert!(fs::read_to_string(final_root.join(name))
                                .unwrap()
                                .contains("child committed"));
                        }
                        assert!(
                            !a.exists(),
                            "{parent}/{child}/{alias}: original tree resurrected"
                        );
                        if parent == "rename" {
                            assert_binder(root, "b/note.md", "b-note");
                            assert!(!root.join(".maru/binder/a-note.json").exists());
                        } else {
                            assert_binder(root, "a/note.md", "a-note");
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_07_frontmatter_save_same_revision_is_serial_and_preserves_body() {
        let home = Home::new();
        let root = home.root.path();
        let s = text(root);
        let original = "---\n# keep comment\nstatus: draft\ntitle: keep\n---\n# 한글\n\nbody  \n";
        for patch_first in [false, true] {
            fs::write(root.join("note.md"), original).unwrap();
            let revision = revision_for(original);
            let held = Held::new(root.join("note.md"), "pre-effect");
            let patch = ipc::update_frontmatter_field(
                s.clone(),
                "note.md".into(),
                "status".into(),
                Some(FieldInput::Str("done".into())),
                Some(revision.clone()),
            );
            let save = ipc::save_document(
                s.clone(),
                "note.md".into(),
                "# saved body\n".into(),
                Some(revision),
            );
            if patch_first {
                let first = start(patch);
                held.wait();
                let wait = Held::new(root.join("note.md"), "before-admission");
                let second = start(save);
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                let result = done(first).unwrap();
                assert_eq!(result.body, parse_frontmatter(original).body);
                assert!(result.content.contains("# keep comment"));
                assert_eq!(done(second).unwrap_err().code, DOCUMENT_CONFLICT);
            } else {
                let first = start(save);
                held.wait();
                let wait = Held::new(root.join("note.md"), "before-admission");
                let second = start(patch);
                wait.wait();
                wait.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                assert_eq!(done(second).unwrap_err().code, DOCUMENT_CONFLICT);
                assert_eq!(
                    fs::read_to_string(root.join("note.md")).unwrap(),
                    "# saved body\n"
                );
            }
        }
    }

    #[test]
    fn phase08_07_each_mutation_same_target_contention_and_error_release() {
        let home = Home::new();
        for command in [
            "save",
            "frontmatter",
            "create",
            "move",
            "duplicate",
            "trash",
            "version",
        ] {
            let fixture = tempfile::tempdir_in(home.root.path()).unwrap();
            let root = fixture.path();
            let s = text(root);
            fs::write(root.join("note.md"), "---\nstatus: draft\n---\n# body\n").unwrap();
            let target = root.join(if command == "create" {
                "new.md"
            } else {
                "note.md"
            });
            let invoke = |root: String| async move {
                match command {
                    "save" => ipc::save_document(root, "note.md".into(), "# saved".into(), None)
                        .await
                        .map(|_| ())
                        .map_err(|e| e.to_string()),
                    "frontmatter" => ipc::update_frontmatter_field(
                        root,
                        "note.md".into(),
                        "status".into(),
                        Some(FieldInput::Str("done".into())),
                        None,
                    )
                    .await
                    .map(|_| ())
                    .map_err(|e| e.to_string()),
                    "create" => ipc::create_document(
                        root,
                        "new".into(),
                        "reference".into(),
                        "body".into(),
                        None,
                        None,
                    )
                    .await
                    .map(|_| ()),
                    "move" => ipc::move_document(root, "note.md".into(), "moved.md".into())
                        .await
                        .map(|_| ()),
                    "duplicate" => ipc::duplicate_document(root, "note.md".into())
                        .await
                        .map(|_| ()),
                    "trash" => ipc::trash_document(root, "note.md".into())
                        .await
                        .map(|_| ()),
                    _ => ipc::create_version(
                        root,
                        "note.md".into(),
                        "title".into(),
                        "body".into(),
                        "snapshot".into(),
                    )
                    .await
                    .map(|_| ()),
                }
            };
            let held = Held::new(target.clone(), "pre-effect");
            let first = start(invoke(s.clone()));
            held.wait();
            let wait = Held::new(target.clone(), "before-admission");
            let second = start(invoke(s.clone()));
            wait.wait();
            wait.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{command}: overlap bypassed admission"
            );
            held.release();
            done(first).unwrap();
            let second = done(second);
            if matches!(command, "move" | "trash" | "create") {
                assert!(second.is_err());
            } else {
                second.unwrap();
            }
            // Every mutation gets a real denied write, then a successful fresh operation.
            fs::write(root.join("note.md"), "# reset body\n").unwrap();
            if root.join("new.md").exists() {
                fs::remove_file(root.join("new.md")).unwrap();
            }
            if root.join("moved.md").exists() {
                fs::remove_file(root.join("moved.md")).unwrap();
            }
            let registry = crate::vault_list::workspace_registry_path().unwrap();
            fs::create_dir_all(registry.parent().unwrap()).unwrap();
            fs::write(&registry,serde_json::json!({"workspaces":[{"label":"fixture","visibility":"private","path":s,"writePolicy":"readOnly"}]}).to_string()).unwrap();
            assert!(
                run(invoke(text(root))).unwrap_err().contains("blocked"),
                "{command}"
            );
            fs::write(registry, r#"{"workspaces":[]}"#).unwrap();
            run(invoke(text(root))).unwrap();
        }
    }

    #[test]
    fn phase08_07_move_rekey_collision_rolls_back_every_binder_and_releases() {
        let home = Home::new();
        let root = home.root.path();
        let s = text(root);
        fs::write(root.join("note.md"), "# source bytes\n").unwrap();
        binder(root, "note.md", "note");
        let original = fs::read(root.join(".maru/binder/note.json")).unwrap();
        fs::write(root.join(".maru/binder/moved.json"), "collision bytes").unwrap();
        let error = run(ipc::move_document(
            s.clone(),
            "note.md".into(),
            "moved.md".into(),
        ))
        .unwrap_err();
        assert!(error.contains("rolled back"));
        assert!(!root.join("moved.md").exists());
        assert_eq!(fs::read(root.join("note.md")).unwrap(), b"# source bytes\n");
        assert_eq!(
            fs::read(root.join(".maru/binder/note.json")).unwrap(),
            original
        );
        assert_eq!(
            fs::read(root.join(".maru/binder/moved.json")).unwrap(),
            b"collision bytes"
        );
        fs::remove_file(root.join(".maru/binder/moved.json")).unwrap();
        run(ipc::move_document(s, "note.md".into(), "moved.md".into())).unwrap();
        assert_binder(root, "moved.md", "moved");
        assert!(!root.join(".maru/binder/note.json").exists());
    }
}
