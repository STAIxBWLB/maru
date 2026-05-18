use crate::filename_rules::{validate_filename_stem, validate_folder_name};
use crate::frontmatter::{build_frontmatter, update_frontmatter_content, FrontmatterValue};
use crate::vault::{parse_frontmatter, resolve_inside_vault, slugify, title_from_content};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use uuid::Uuid;

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

#[tauri::command]
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
    let title = title_from_content(&content, fallback);
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

    Ok(DocumentPayload {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        content,
        body: parts.body,
        meta: parts.meta,
        file_kind,
    })
}

#[tauri::command]
pub fn save_document(
    vault_path: String,
    document_path: String,
    content: String,
) -> Result<DocumentPayload, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Modify)?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create parent directory: {err}"))?;
    }
    fs::write(&path, content).map_err(|err| format!("Cannot save document: {err}"))?;
    read_document(vault_path, path.to_string_lossy().to_string())
}

/// Patch a single frontmatter field on disk while preserving the order and
/// comments of every other key. Sending `value: null` deletes the field.
/// This is the load-bearing primitive for the InspectorPane inline editors.
#[tauri::command]
pub fn update_frontmatter_field(
    vault_path: String,
    document_path: String,
    key: String,
    value: Option<FieldInput>,
) -> Result<DocumentPayload, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Modify)?;
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read document: {err}"))?;
    let mapped = value.map(FrontmatterValue::from);
    let updated = update_frontmatter_content(&original, &key, mapped)?;
    if updated != original {
        fs::write(&path, &updated).map_err(|err| format!("Cannot save document: {err}"))?;
    }
    read_document(vault_path, path.to_string_lossy().to_string())
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

#[tauri::command]
pub fn create_document(
    vault_path: String,
    title: String,
    doc_type: String,
    body: String,
    target_rel_path: Option<String>,
    #[allow(non_snake_case)] extras: Option<CreateDocumentExtras>,
) -> Result<CreatedDocument, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    let now = Utc::now().to_rfc3339();
    let rel_path = match target_rel_path
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(target) => validate_target_rel_path(target)?,
        None => {
            let slug = slugify(&title);
            validate_filename_stem(&slug)?;
            format!("{slug}.md")
        }
    };
    let path = resolve_inside_vault(&vault_path, &rel_path)?;
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

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create parent directory: {err}"))?;
    }
    fs::write(&path, content).map_err(|err| format!("Cannot create document: {err}"))?;

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

fn validate_target_rel_path(target: &str) -> Result<String, String> {
    let trimmed = target.trim().trim_matches('/');
    if trimmed.is_empty() || Path::new(trimmed).is_absolute() {
        return Err("Invalid document path".to_string());
    }

    let without_ext = trimmed
        .strip_suffix(".markdown")
        .or_else(|| trimmed.strip_suffix(".md"))
        .unwrap_or(trimmed);
    let parts: Vec<&str> = without_ext.split('/').collect();
    if parts.is_empty() {
        return Err("Invalid document path".to_string());
    }

    for folder in &parts[..parts.len().saturating_sub(1)] {
        validate_folder_name(folder)?;
    }
    let stem = parts[parts.len() - 1];
    validate_filename_stem(stem)?;

    Ok(format!("{without_ext}.md"))
}

#[tauri::command]
pub fn move_document(
    vault_path: String,
    document_path: String,
    target_rel_path: String,
) -> Result<DocumentPayload, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::RenameMove)?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_existing_document(&source_path)?;

    let rel_path = validate_target_rel_path(&target_rel_path)?;
    let target_path = resolve_inside_vault(&vault_path, &rel_path)?;
    if paths_match(&source_path, &target_path) {
        return read_document(vault_path, source_path.to_string_lossy().to_string());
    }
    if target_path.exists() {
        return Err("A document already exists at that path".to_string());
    }

    if let Some(parent) = target_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create target directory: {err}"))?;
    }
    move_file(&source_path, &target_path)?;

    let payload = read_document(vault_path, target_path.to_string_lossy().to_string())?;
    if payload.rel_path != relative(&target_path, &vault) {
        return Err("Moved document resolved outside the selected workspace".to_string());
    }
    Ok(payload)
}

#[tauri::command]
pub fn duplicate_document(
    vault_path: String,
    document_path: String,
) -> Result<DocumentPayload, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    ensure_existing_document(&source_path)?;
    let target_path = unique_duplicate_path(&source_path);
    fs::copy(&source_path, &target_path)
        .map_err(|err| format!("Cannot duplicate document: {err}"))?;
    read_document(vault_path, target_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn trash_document(
    vault_path: String,
    document_path: String,
) -> Result<DeletedDocument, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Delete)?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    ensure_existing_document(&source_path)?;
    let original_rel_path = relative(&source_path, &vault);
    let trash_path = unique_trash_path(&source_path, &vault)?;
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
    let mut counter = 1;
    loop {
        let suffix = if counter == 1 {
            "-copy".to_string()
        } else {
            format!("-copy-{counter}")
        };
        let candidate = parent.join(format!("{stem}{suffix}.md"));
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
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let trash_dir = vault
        .join(".anchor")
        .join("trash")
        .join("documents")
        .join(original_rel_parent);
    let base = format!("{stem}-{timestamp}");
    for counter in 1.. {
        let file_name = if counter == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{counter}.md")
        };
        let candidate = trash_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Cannot allocate trash path".to_string())
}

#[tauri::command]
pub fn create_version(
    vault_path: String,
    document_path: String,
    title: String,
    content: String,
    summary: String,
) -> Result<VersionSnapshot, String> {
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    let source_path = resolve_inside_vault(&vault_path, &document_path)?;
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("document");
    let timestamp = Utc::now();
    let version_dir = vault.join(".anchor").join("versions");
    fs::create_dir_all(&version_dir)
        .map_err(|err| format!("Cannot create version directory: {err}"))?;
    let file_name = format!("{stem}-{}.md", timestamp.format("%Y%m%d-%H%M%S"));
    let version_path = version_dir.join(file_name);

    let body = if content.trim_start().starts_with("---\n") {
        parse_frontmatter(&content).body
    } else {
        content
    };
    let snapshot_title = format!("{title} - {}", timestamp.format("%Y.%m.%d %H:%M"));

    let fields = vec![
        ("type", FrontmatterValue::String("Version".to_string())),
        ("status", FrontmatterValue::String("snapshot".to_string())),
        (
            "version_of",
            FrontmatterValue::String(relative(&source_path, &vault)),
        ),
        ("summary", FrontmatterValue::String(summary)),
        (
            "created_at",
            FrontmatterValue::String(timestamp.to_rfc3339()),
        ),
    ];
    let body_with_heading = format!("# {snapshot_title}\n\n{body}");
    let snapshot = build_frontmatter(&fields, &body_with_heading);

    fs::write(&version_path, snapshot).map_err(|err| format!("Cannot write version: {err}"))?;

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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    /// The Phase 0 verification gate as a unit test: a real-world Korean
    /// frontmatter note read by anchor and written back unchanged must
    /// produce byte-identical output. If this ever breaks, Obsidian users
    /// pointing anchor at their vault will see frontmatter mangle.
    #[test]
    fn read_then_save_unchanged_is_byte_identical() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().to_string_lossy().to_string();

        let original = "---\n\
            title: 제주한라대 RISE 2026\n\
            status: 진행중\n\
            tags:\n  - 보고서\n  - 행정\n\
            author: 이영준 (李永俊)\n\
            project: \"[[Anchor]]\"\n\
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

        save_document(root.clone(), payload.path.clone(), payload.content.clone()).unwrap();

        let after = fs::read_to_string(tmp.path().join("note.md")).unwrap();
        assert_eq!(
            after, original,
            "read→save with unchanged content must be byte-identical (frontmatter order, comments, trailing newline all preserved)"
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

        let payload =
            update_frontmatter_field(root, "note.md".to_string(), "ephemeral".to_string(), None)
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
    fn trash_document_moves_to_anchor_trash_and_removes_source() {
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
            .starts_with(".anchor/trash/documents/meetings/weekly-"));
        assert!(Path::new(&deleted.trash_path).exists());
        assert_eq!(
            fs::read_to_string(deleted.trash_path).unwrap(),
            "# Weekly\n"
        );
    }
}
