use chrono::{DateTime, Utc};
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_yaml::Value;
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEntry {
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub doc_type: String,
    pub status: String,
    pub tags: Vec<String>,
    pub people: Vec<String>,
    pub project: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    pub word_count: usize,
    pub snippet: String,
    pub file_kind: String,
    pub version_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrontmatterParts {
    pub meta: BTreeMap<String, Value>,
    pub body: String,
}

#[tauri::command]
pub fn default_vault_path() -> Result<String, String> {
    let base = dirs::document_dir()
        .or_else(dirs::home_dir)
        .ok_or_else(|| "Cannot resolve a user documents directory".to_string())?;
    Ok(base.join("Anchor Vault").to_string_lossy().to_string())
}

#[tauri::command]
pub fn sample_vault_path() -> Result<String, String> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .ok_or_else(|| "Cannot resolve project root".to_string())?
        .join("sample-vault");
    Ok(root.to_string_lossy().to_string())
}

#[tauri::command]
pub fn scan_vault(vault_path: String) -> Result<Vec<VaultEntry>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let mut entries = Vec::new();

    for entry in WalkDir::new(&vault)
        .max_depth(6)
        .follow_links(false)
        .into_iter()
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if !entry.file_type().is_file() || is_hidden_or_system_path(path, &vault) {
            continue;
        }
        let Some(ext) = path.extension().and_then(|e| e.to_str()) else {
            continue;
        };
        if !matches!(ext, "md" | "markdown" | "html" | "htm") {
            continue;
        }
        if let Ok(item) = read_entry(path, &vault) {
            entries.push(item);
        }
    }

    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    Ok(entries)
}

pub fn normalize_existing_dir(input: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(input);
    if !path.exists() {
        fs::create_dir_all(&path).map_err(|err| format!("Cannot create vault directory: {err}"))?;
    }
    let canonical = path
        .canonicalize()
        .map_err(|err| format!("Cannot open vault directory: {err}"))?;
    if !canonical.is_dir() {
        return Err("Vault path is not a directory".to_string());
    }
    Ok(canonical)
}

pub fn resolve_inside_vault(vault_path: &str, document_path: &str) -> Result<PathBuf, String> {
    let vault = normalize_existing_dir(vault_path)?;
    let raw = PathBuf::from(document_path);
    let candidate = if raw.is_absolute() {
        raw
    } else {
        vault.join(raw)
    };

    if candidate.exists() {
        let canonical = candidate
            .canonicalize()
            .map_err(|err| format!("Cannot resolve document path: {err}"))?;
        if !canonical.starts_with(&vault) {
            return Err("Document path escapes the selected vault".to_string());
        }
        return Ok(canonical);
    }

    let parent = candidate
        .parent()
        .ok_or_else(|| "Document path has no parent directory".to_string())?;
    let parent = if parent.exists() {
        parent
            .canonicalize()
            .map_err(|err| format!("Cannot resolve parent directory: {err}"))?
    } else {
        let fallback = nearest_existing_parent(parent)?;
        fallback
            .canonicalize()
            .map_err(|err| format!("Cannot resolve parent directory: {err}"))?
    };
    if !parent.starts_with(&vault) {
        return Err("Document path escapes the selected vault".to_string());
    }
    Ok(candidate)
}

pub fn parse_frontmatter(content: &str) -> FrontmatterParts {
    if !content.starts_with("---\n") {
        return FrontmatterParts {
            meta: BTreeMap::new(),
            body: content.to_string(),
        };
    }
    let Some(end) = content[4..].find("\n---") else {
        return FrontmatterParts {
            meta: BTreeMap::new(),
            body: content.to_string(),
        };
    };
    let yaml_end = end + 4;
    let yaml = &content[4..yaml_end];
    let body_start = yaml_end + 4;
    let body = content.get(body_start..).unwrap_or_default();
    let meta = serde_yaml::from_str::<BTreeMap<String, Value>>(yaml).unwrap_or_default();
    FrontmatterParts {
        meta,
        body: body.trim_start_matches('\n').to_string(),
    }
}

pub fn serialize_frontmatter(meta: &BTreeMap<String, Value>, body: &str) -> String {
    let yaml = serde_yaml::to_string(meta).unwrap_or_default();
    format!("---\n{}---\n{}", yaml, body.trim_start_matches('\n'))
}

pub fn title_from_content(content: &str, fallback: &str) -> String {
    let body = parse_frontmatter(content).body;
    let h1 = Regex::new(r"(?m)^#\s+(.+)$").expect("valid h1 regex");
    if let Some(capture) = h1.captures(&body) {
        return capture
            .get(1)
            .map(|m| clean_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string());
    }

    let html_h1 = Regex::new(r"(?is)<h1[^>]*>(.*?)</h1>").expect("valid html h1 regex");
    if let Some(capture) = html_h1.captures(&body) {
        return capture
            .get(1)
            .map(|m| clean_text(m.as_str()))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| fallback.to_string());
    }

    fallback.to_string()
}

pub fn slugify(input: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in input.chars().flat_map(char::to_lowercase) {
        if ch.is_ascii_alphanumeric() {
            out.push(ch);
            last_dash = false;
        } else if ch.is_whitespace() || matches!(ch, '-' | '_' | '.' | '/') {
            if !last_dash && !out.is_empty() {
                out.push('-');
                last_dash = true;
            }
        } else if ('가'..='힣').contains(&ch) {
            out.push(ch);
            last_dash = false;
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed
    }
}

fn read_entry(path: &Path, vault: &Path) -> Result<VaultEntry, String> {
    let content = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let parts = parse_frontmatter(&content);
    let fallback = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Untitled");
    let title = title_from_content(&content, fallback);
    let rel_path = path
        .strip_prefix(vault)
        .unwrap_or(path)
        .to_string_lossy()
        .to_string();
    let file_kind = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("md")
        .to_string();
    let metadata = fs::metadata(path).ok();
    let modified = metadata
        .and_then(|m| m.modified().ok())
        .map(DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339());
    let snippet = clean_text(&parts.body)
        .chars()
        .take(240)
        .collect::<String>();
    let word_count = parts
        .body
        .split_whitespace()
        .filter(|part| !part.trim().is_empty())
        .count();

    Ok(VaultEntry {
        path: path.to_string_lossy().to_string(),
        rel_path,
        title,
        doc_type: scalar(&parts.meta, "type").unwrap_or_else(|| infer_type(&file_kind)),
        status: scalar(&parts.meta, "status").unwrap_or_else(|| "draft".to_string()),
        tags: string_list(&parts.meta, "tags"),
        people: string_list(&parts.meta, "people"),
        project: scalar(&parts.meta, "project"),
        updated_at: scalar(&parts.meta, "updated_at").or(modified),
        created_at: scalar(&parts.meta, "created_at"),
        word_count,
        snippet,
        file_kind,
        version_count: count_versions(path, vault),
    })
}

fn is_hidden_or_system_path(path: &Path, vault: &Path) -> bool {
    let Ok(rel) = path.strip_prefix(vault) else {
        return true;
    };
    rel.components().any(|component| {
        let value = component.as_os_str().to_string_lossy();
        value.starts_with('.') || value == "node_modules" || value == "target"
    })
}

fn nearest_existing_parent(path: &Path) -> Result<PathBuf, String> {
    let mut cur = path;
    loop {
        if cur.exists() {
            return Ok(cur.to_path_buf());
        }
        cur = cur
            .parent()
            .ok_or_else(|| "Cannot find an existing parent directory".to_string())?;
    }
}

fn scalar(meta: &BTreeMap<String, Value>, key: &str) -> Option<String> {
    match meta.get(key) {
        Some(Value::String(value)) => Some(value.clone()),
        Some(Value::Number(value)) => Some(value.to_string()),
        Some(Value::Bool(value)) => Some(value.to_string()),
        _ => None,
    }
}

fn string_list(meta: &BTreeMap<String, Value>, key: &str) -> Vec<String> {
    match meta.get(key) {
        Some(Value::Sequence(values)) => values
            .iter()
            .filter_map(|value| value.as_str().map(ToString::to_string))
            .collect(),
        Some(Value::String(value)) => value
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn infer_type(file_kind: &str) -> String {
    if matches!(file_kind, "html" | "htm") {
        "Document".to_string()
    } else {
        "Reference".to_string()
    }
}

fn clean_text(input: &str) -> String {
    let tags = Regex::new(r"(?is)<[^>]+>").expect("valid tag regex");
    let markup = Regex::new(r"(?m)^[-*#>\s]+").expect("valid markdown regex");
    let without_tags = tags.replace_all(input, " ");
    let without_markup = markup.replace_all(&without_tags, "");
    without_markup
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .to_string()
}

fn count_versions(path: &Path, vault: &Path) -> usize {
    let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
        return 0;
    };
    let dir = vault.join(".anchor").join("versions");
    if !dir.exists() {
        return 0;
    }
    WalkDir::new(dir)
        .max_depth(1)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| {
            entry.file_type().is_file()
                && entry
                    .path()
                    .file_name()
                    .and_then(|s| s.to_str())
                    .map(|name| name.starts_with(stem))
                    .unwrap_or(false)
        })
        .count()
}
