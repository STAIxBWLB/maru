use crate::frontmatter::{build_frontmatter, FrontmatterValue};
use crate::vault::{parse_frontmatter, resolve_inside_vault, slugify, title_from_content};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use uuid::Uuid;

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
    let path = resolve_inside_vault(&vault_path, &document_path)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create parent directory: {err}"))?;
    }
    fs::write(&path, content).map_err(|err| format!("Cannot save document: {err}"))?;
    read_document(vault_path, path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn create_document(
    vault_path: String,
    title: String,
    doc_type: String,
    body: String,
) -> Result<CreatedDocument, String> {
    let now = Utc::now().to_rfc3339();
    let slug = slugify(&title);
    let rel_path = format!("{slug}.md");
    let path = resolve_inside_vault(&vault_path, &rel_path)?;
    if path.exists() {
        return Err("A document with that generated file name already exists".to_string());
    }

    // Frontmatter authored in deliberate order: type → status → created_at
    // → updated_at → id. build_frontmatter preserves this ordering, unlike
    // BTreeMap serialization which alphabetizes.
    let fields = vec![
        ("type", FrontmatterValue::String(doc_type)),
        ("status", FrontmatterValue::String("draft".to_string())),
        ("created_at", FrontmatterValue::String(now.clone())),
        ("updated_at", FrontmatterValue::String(now)),
        (
            "id",
            FrontmatterValue::String(format!("doc-{}", Uuid::new_v4())),
        ),
    ];
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

#[tauri::command]
pub fn create_version(
    vault_path: String,
    document_path: String,
    title: String,
    content: String,
    summary: String,
) -> Result<VersionSnapshot, String> {
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
