use crate::vault::resolve_inside_vault;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum MemoFormat {
    Plain,
    Markdown,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileStoreOperation {
    Copy,
    Move,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredFileOutcome {
    source_path: String,
    target_path: String,
    file_name: String,
    operation: FileStoreOperation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoEntry {
    name: String,
    path: String,
    format: MemoFormat,
    updated_at: Option<String>,
    size_bytes: u64,
    preview: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoDocument {
    #[serde(flatten)]
    entry: MemoEntry,
    content: String,
}

#[tauri::command]
pub fn store_shelf_files(
    vault_path: String,
    sources: Vec<String>,
    operation: FileStoreOperation,
) -> Result<Vec<StoredFileOutcome>, String> {
    let target_dir = resolve_inside_vault(&vault_path, ".anchor/stash/files")?;
    store_files_into_dir(&sources, &target_dir, operation)
}

#[tauri::command]
pub fn store_shelf_files_as(
    sources: Vec<String>,
    target_dir: String,
    operation: FileStoreOperation,
) -> Result<Vec<StoredFileOutcome>, String> {
    store_files_into_dir(&sources, &PathBuf::from(target_dir), operation)
}

#[tauri::command]
pub fn list_memos(vault_path: String) -> Result<Vec<MemoEntry>, String> {
    let dir = memo_dir(&vault_path)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut entries = Vec::new();
    for item in fs::read_dir(&dir).map_err(|err| format!("Cannot read memos: {err}"))? {
        let item = item.map_err(|err| format!("Cannot read memo entry: {err}"))?;
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(format) = memo_format_for_path(&path) else {
            continue;
        };
        let content = fs::read_to_string(&path).unwrap_or_default();
        let metadata = item
            .metadata()
            .map_err(|err| format!("Cannot read memo metadata: {err}"))?;
        entries.push(memo_entry_from_parts(path, format, &content, &metadata)?);
    }
    entries.sort_by(|a, b| {
        b.updated_at
            .cmp(&a.updated_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    Ok(entries)
}

#[tauri::command]
pub fn read_memo(vault_path: String, memo_path: String) -> Result<MemoDocument, String> {
    let path = resolve_memo_path(&vault_path, &memo_path)?;
    let content = fs::read_to_string(&path).map_err(|err| format!("Cannot read memo: {err}"))?;
    let metadata =
        fs::metadata(&path).map_err(|err| format!("Cannot read memo metadata: {err}"))?;
    let format = memo_format_for_path(&path).unwrap_or(MemoFormat::Markdown);
    Ok(MemoDocument {
        entry: memo_entry_from_parts(path, format, &content, &metadata)?,
        content,
    })
}

#[tauri::command]
pub fn save_memo(
    vault_path: String,
    name: String,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    let dir = memo_dir(&vault_path)?;
    fs::create_dir_all(&dir).map_err(|err| format!("Cannot create memo directory: {err}"))?;
    let file_name = normalize_memo_name(&name, format);
    let path = dir.join(file_name);
    write_memo_document(path, format, content)
}

#[tauri::command]
pub fn delete_memo(vault_path: String, memo_path: String) -> Result<(), String> {
    let path = resolve_memo_path(&vault_path, &memo_path)?;
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(format!("Cannot delete memo: {err}")),
    }
}

#[tauri::command]
pub fn save_memo_as(target_path: String, content: String) -> Result<MemoDocument, String> {
    let path = PathBuf::from(target_path);
    if path.is_dir() {
        return Err("Memo target is a directory".to_string());
    }
    let format = memo_format_for_path(&path).unwrap_or(MemoFormat::Markdown);
    write_memo_document(path, format, content)
}

fn store_files_into_dir(
    sources: &[String],
    target_dir: &Path,
    operation: FileStoreOperation,
) -> Result<Vec<StoredFileOutcome>, String> {
    fs::create_dir_all(target_dir)
        .map_err(|err| format!("Cannot create target directory: {err}"))?;
    if !target_dir.is_dir() {
        return Err("Target path is not a directory".to_string());
    }
    let mut outcomes = Vec::new();
    for source in sources {
        let source_path = PathBuf::from(source);
        if !source_path.is_file() {
            return Err(format!("Source is not a file: {}", source_path.display()));
        }
        let file_name = source_path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| "Source file name is not valid UTF-8".to_string())?
            .to_string();
        let target_path = unique_path(target_dir.join(&file_name));
        if operation == FileStoreOperation::Copy {
            fs::copy(&source_path, &target_path)
                .map_err(|err| format!("Cannot copy file: {err}"))?;
        } else {
            move_file(&source_path, &target_path)?;
        }
        outcomes.push(StoredFileOutcome {
            source_path: source_path.to_string_lossy().to_string(),
            target_path: target_path.to_string_lossy().to_string(),
            file_name: target_path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or(&file_name)
                .to_string(),
            operation,
        });
    }
    Ok(outcomes)
}

fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            fs::copy(source, target).map_err(|err| format!("Cannot copy file for move: {err}"))?;
            fs::remove_file(source).map_err(|err| format!("Cannot remove moved source: {err}"))
        }
    }
}

fn unique_path(candidate: PathBuf) -> PathBuf {
    if !candidate.exists() {
        return candidate;
    }
    let parent = candidate
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_default();
    let stem = candidate
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("file");
    let extension = candidate.extension().and_then(|value| value.to_str());
    for i in 1.. {
        let suffix = if i == 1 {
            "copy".to_string()
        } else {
            format!("copy-{i}")
        };
        let file_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem}-{suffix}.{ext}"),
            _ => format!("{stem}-{suffix}"),
        };
        let next = parent.join(file_name);
        if !next.exists() {
            return next;
        }
    }
    unreachable!()
}

fn memo_dir(vault_path: &str) -> Result<PathBuf, String> {
    resolve_inside_vault(vault_path, ".anchor/memos")
}

fn resolve_memo_path(vault_path: &str, memo_path: &str) -> Result<PathBuf, String> {
    let dir = memo_dir(vault_path)?;
    let path = resolve_inside_vault(vault_path, memo_path)?;
    if !path.starts_with(&dir) {
        return Err("Memo path escapes .anchor/memos".to_string());
    }
    Ok(path)
}

fn write_memo_document(
    path: PathBuf,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create memo parent: {err}"))?;
    }
    fs::write(&path, &content).map_err(|err| format!("Cannot save memo: {err}"))?;
    let metadata =
        fs::metadata(&path).map_err(|err| format!("Cannot read memo metadata: {err}"))?;
    Ok(MemoDocument {
        entry: memo_entry_from_parts(path, format, &content, &metadata)?,
        content,
    })
}

fn memo_entry_from_parts(
    path: PathBuf,
    format: MemoFormat,
    content: &str,
    metadata: &fs::Metadata,
) -> Result<MemoEntry, String> {
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Memo name is not valid UTF-8".to_string())?
        .to_string();
    let updated_at = metadata
        .modified()
        .ok()
        .map(DateTime::<Utc>::from)
        .map(|value| value.to_rfc3339());
    Ok(MemoEntry {
        name,
        path: path.to_string_lossy().to_string(),
        format,
        updated_at,
        size_bytes: metadata.len(),
        preview: memo_preview(content),
    })
}

fn memo_preview(content: &str) -> String {
    content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .unwrap_or("")
        .chars()
        .take(160)
        .collect()
}

fn normalize_memo_name(name: &str, format: MemoFormat) -> String {
    let fallback = format!("memo-{}", Utc::now().format("%Y%m%d-%H%M%S"));
    let trimmed = name.trim();
    let raw = if trimmed.is_empty() {
        &fallback
    } else {
        trimmed
    };
    let leaf = Path::new(raw)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&fallback);
    let sanitized: String = leaf
        .chars()
        .map(|ch| match ch {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect();
    let without_ext = sanitized
        .strip_suffix(".md")
        .or_else(|| sanitized.strip_suffix(".txt"))
        .unwrap_or(&sanitized);
    let ext = match format {
        MemoFormat::Plain => "txt",
        MemoFormat::Markdown => "md",
    };
    format!("{without_ext}.{ext}")
}

fn memo_format_for_path(path: &Path) -> Option<MemoFormat> {
    match path.extension().and_then(|value| value.to_str()) {
        Some("txt") => Some(MemoFormat::Plain),
        Some("md") | Some("markdown") => Some(MemoFormat::Markdown),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn unique_path_uses_copy_suffix() {
        let tmp = TempDir::new().unwrap();
        let first = tmp.path().join("note.md");
        fs::write(&first, "x").unwrap();
        assert_eq!(unique_path(first).file_name().unwrap(), "note-copy.md");
    }

    #[test]
    fn default_memos_stay_under_anchor() {
        let tmp = TempDir::new().unwrap();
        let doc = save_memo(
            tmp.path().to_string_lossy().to_string(),
            "daily".to_string(),
            MemoFormat::Markdown,
            "# Daily".to_string(),
        )
        .unwrap();
        assert!(doc.entry.path.contains(".anchor/memos/daily.md"));
        let list = list_memos(tmp.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "daily.md");
    }

    #[test]
    fn memo_read_must_stay_in_memo_dir() {
        let tmp = TempDir::new().unwrap();
        fs::write(tmp.path().join("outside.md"), "x").unwrap();
        let err = read_memo(
            tmp.path().to_string_lossy().to_string(),
            "outside.md".to_string(),
        )
        .unwrap_err();
        assert!(err.contains(".anchor/memos"));
    }

    #[test]
    fn delete_memo_removes_default_memo_only() {
        let tmp = TempDir::new().unwrap();
        let doc = save_memo(
            tmp.path().to_string_lossy().to_string(),
            "scratch".to_string(),
            MemoFormat::Plain,
            "memo".to_string(),
        )
        .unwrap();
        let memo_path = PathBuf::from(&doc.entry.path);
        assert!(doc.entry.path.contains(".anchor/memos/scratch.txt"));
        assert!(memo_path.exists());

        delete_memo(
            tmp.path().to_string_lossy().to_string(),
            doc.entry.path.clone(),
        )
        .unwrap();
        assert!(!memo_path.exists());

        let err = delete_memo(
            tmp.path().to_string_lossy().to_string(),
            "outside.txt".to_string(),
        )
        .unwrap_err();
        assert!(err.contains(".anchor/memos"));
    }

    #[test]
    fn store_files_never_overwrites() {
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("drop.pdf");
        fs::write(&source, "new").unwrap();
        fs::write(target_dir.path().join("drop.pdf"), "old").unwrap();
        let outcomes = store_shelf_files_as(
            vec![source.to_string_lossy().to_string()],
            target_dir.path().to_string_lossy().to_string(),
            FileStoreOperation::Copy,
        )
        .unwrap();
        assert_eq!(outcomes[0].file_name, "drop-copy.pdf");
    }
}
