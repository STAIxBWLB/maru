use crate::atomic_file::write_atomic_create;
use crate::scratchpad::{
    assert_scratchpad_workspace_access, resolve_scratchpad_memos_root, scratchpad_list,
    scratchpad_read, scratchpad_save, scratchpad_trash, ScratchpadCollection, ScratchpadDocument,
    ScratchpadEntry, ScratchpadFormat,
};
use crate::vault::resolve_inside_vault;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
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
    let target_dir = resolve_inside_vault(&vault_path, ".maru/stash/files")?;
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
    scratchpad_list(vault_path).map(|entries| {
        entries
            .into_iter()
            .filter(|entry| entry.collection == ScratchpadCollection::Memos)
            .map(|entry| memo_entry_from_scratchpad(entry, &dir))
            .collect()
    })
}

#[tauri::command]
pub fn read_memo(vault_path: String, memo_path: String) -> Result<MemoDocument, String> {
    let path = resolve_memo_path(&vault_path, &memo_path)?;
    let dir = memo_dir(&vault_path)?;
    let relative = path
        .strip_prefix(&dir)
        .map_err(|_| "Memo path escapes scratchpad/memos".to_string())?;
    let document = scratchpad_read(
        vault_path,
        ScratchpadCollection::Memos,
        relative.to_string_lossy().replace('\\', "/"),
    )?;
    Ok(memo_document_from_scratchpad(document, &dir))
}

#[tauri::command]
pub fn save_memo(
    vault_path: String,
    name: String,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    let file_name = normalize_memo_name(&name, format);
    let dir = memo_dir(&vault_path)?;
    let document = scratchpad_save(
        vault_path,
        ScratchpadCollection::Memos,
        file_name,
        scratchpad_format(format),
        content,
        None,
        false,
    )?;
    Ok(memo_document_from_scratchpad(document, &dir))
}

#[tauri::command]
pub fn delete_memo(
    vault_path: String,
    memo_path: String,
    expected_revision: Option<String>,
) -> Result<(), String> {
    let expected_revision = expected_revision.ok_or_else(|| {
        "memo_conflict: expectedRevision is required; use the revision-checked Scratchpad API"
            .to_string()
    })?;
    let path = resolve_memo_path(&vault_path, &memo_path)?;
    let dir = memo_dir(&vault_path)?;
    let relative = path
        .strip_prefix(&dir)
        .map_err(|_| "Memo path escapes scratchpad/memos".to_string())?;
    scratchpad_trash(
        vault_path,
        ScratchpadCollection::Memos,
        relative.to_string_lossy().replace('\\', "/"),
        expected_revision,
    )
}

#[tauri::command]
pub fn save_memo_as(
    vault_path: Option<String>,
    target_path: String,
    content: String,
) -> Result<MemoDocument, String> {
    let vault_path = vault_path.ok_or_else(|| {
        "memo_export_disabled: vaultPath is required for capability-checked Save As".to_string()
    })?;
    assert_scratchpad_workspace_access(Path::new(&vault_path))?;
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Create)?;
    let path = PathBuf::from(target_path);
    if path.is_dir() {
        return Err("Memo target is a directory".to_string());
    }
    let format = memo_format_for_path(&path).unwrap_or(MemoFormat::Markdown);
    write_new_memo_document(path, format, content)
}

fn scratchpad_format(format: MemoFormat) -> ScratchpadFormat {
    match format {
        MemoFormat::Plain => ScratchpadFormat::Plain,
        MemoFormat::Markdown => ScratchpadFormat::Markdown,
    }
}

fn memo_format(format: ScratchpadFormat) -> MemoFormat {
    match format {
        ScratchpadFormat::Plain => MemoFormat::Plain,
        ScratchpadFormat::Markdown => MemoFormat::Markdown,
    }
}

fn memo_entry_from_scratchpad(entry: ScratchpadEntry, dir: &Path) -> MemoEntry {
    MemoEntry {
        name: entry.name,
        path: dir.join(&entry.relative_path).to_string_lossy().to_string(),
        format: memo_format(entry.format),
        updated_at: entry.updated_at,
        size_bytes: entry.size_bytes,
        preview: entry.preview,
    }
}

fn memo_document_from_scratchpad(document: ScratchpadDocument, dir: &Path) -> MemoDocument {
    MemoDocument {
        entry: memo_entry_from_scratchpad(document.entry, dir),
        content: document.content,
    }
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
    resolve_scratchpad_memos_root(Path::new(vault_path))
}

fn resolve_memo_path(vault_path: &str, memo_path: &str) -> Result<PathBuf, String> {
    let dir = memo_dir(vault_path)?;
    let requested = PathBuf::from(memo_path);
    let path = if requested.is_absolute() {
        requested
    } else {
        PathBuf::from(vault_path).join(requested)
    };
    if !path.starts_with(&dir) {
        return Err("Memo path escapes scratchpad/memos".to_string());
    }
    let relative = path
        .strip_prefix(&dir)
        .map_err(|_| "Memo path escapes scratchpad/memos".to_string())?;
    if relative
        .components()
        .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err("Memo path escapes scratchpad/memos".to_string());
    }
    let mut current = dir.clone();
    for component in relative.components() {
        current.push(component.as_os_str());
        if fs::symlink_metadata(&current)
            .map(|metadata| metadata.file_type().is_symlink())
            .unwrap_or(false)
        {
            return Err("Memo path contains a symlink".to_string());
        }
    }
    Ok(path)
}

fn write_new_memo_document(
    path: PathBuf,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create memo parent: {err}"))?;
    }
    if path.exists() {
        return Err(
            "memo_conflict: target already exists; use the revision-checked Scratchpad API"
                .to_string(),
        );
    }
    write_atomic_create(&path, content.as_bytes())?;
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
    fn default_memos_stay_under_scratchpad() {
        let tmp = TempDir::new().unwrap();
        let doc = save_memo(
            tmp.path().to_string_lossy().to_string(),
            "daily".to_string(),
            MemoFormat::Markdown,
            "# Daily".to_string(),
        )
        .unwrap();
        assert!(doc.entry.path.contains("scratchpad/memos/daily.md"));
        let list = list_memos(tmp.path().to_string_lossy().to_string()).unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "daily.md");
    }

    #[test]
    fn compatibility_saves_are_create_only() {
        let tmp = TempDir::new().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let created = save_memo(
            work.clone(),
            "daily".to_string(),
            MemoFormat::Markdown,
            "original".to_string(),
        )
        .unwrap();

        let overwrite = save_memo(
            work,
            "daily".to_string(),
            MemoFormat::Markdown,
            "replacement".to_string(),
        )
        .unwrap_err();
        assert!(overwrite.contains("scratchpad_conflict"));
        assert_eq!(fs::read_to_string(&created.entry.path).unwrap(), "original");

        let export = tmp.path().join("export.md");
        fs::write(&export, "keep").unwrap();
        let export_error = save_memo_as(
            Some(tmp.path().to_string_lossy().to_string()),
            export.to_string_lossy().to_string(),
            "replace".to_string(),
        )
        .unwrap_err();
        assert!(export_error.contains("memo_conflict"));
        assert_eq!(fs::read_to_string(export).unwrap(), "keep");
    }

    #[test]
    fn compatibility_reads_use_bounded_scratchpad_storage() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("scratchpad/memos");
        fs::create_dir_all(&root).unwrap();
        let large = root.join("large.md");
        fs::write(&large, vec![b'x'; 2 * 1024 * 1024 + 1]).unwrap();
        let work = tmp.path().to_string_lossy().to_string();

        let entries = list_memos(work.clone()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].preview.len() <= 160);
        let error = read_memo(work, entries[0].path.clone()).unwrap_err();
        assert!(error.contains("scratchpad_too_large"));
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
        assert!(err.contains("scratchpad/memos"));
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
        assert!(doc.entry.path.contains("scratchpad/memos/scratch.txt"));
        assert!(memo_path.exists());

        let work = tmp.path().to_string_lossy().to_string();
        let revision = scratchpad_read(
            work.clone(),
            ScratchpadCollection::Memos,
            "scratch.txt".to_string(),
        )
        .unwrap()
        .entry
        .revision;
        let missing_revision = delete_memo(work.clone(), doc.entry.path.clone(), None).unwrap_err();
        assert!(missing_revision.contains("expectedRevision"));
        assert!(memo_path.exists());
        delete_memo(work.clone(), doc.entry.path.clone(), Some(revision)).unwrap();
        assert!(!memo_path.exists());

        let err =
            delete_memo(work, "outside.txt".to_string(), Some("missing".to_string())).unwrap_err();
        assert!(err.contains("scratchpad/memos"));
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
