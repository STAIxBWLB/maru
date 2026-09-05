use crate::atomic_file::{
    with_path_transactions, write_atomic_create, PathTransactionLease, PathTransactionRequest,
};
use crate::scratchpad::{
    assert_scratchpad_workspace_access, resolve_scratchpad_memos_root, resolve_scratchpad_root,
    scratchpad_list_in_transaction, scratchpad_read_in_transaction, scratchpad_save_in_transaction,
    scratchpad_trash_in_transaction, ScratchpadCollection, ScratchpadDocument, ScratchpadEntry,
    ScratchpadFormat,
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

pub fn store_shelf_files(
    vault_path: String,
    sources: Vec<String>,
    operation: FileStoreOperation,
) -> Result<Vec<StoredFileOutcome>, String> {
    let target_dir = resolve_inside_vault(&vault_path, ".maru/stash/files")?;
    store_files_into_dir(&sources, &target_dir, operation)
}

pub fn store_shelf_files_as(
    sources: Vec<String>,
    target_dir: String,
    operation: FileStoreOperation,
) -> Result<Vec<StoredFileOutcome>, String> {
    store_files_into_dir(&sources, &PathBuf::from(target_dir), operation)
}

pub fn list_memos(vault_path: String) -> Result<Vec<MemoEntry>, String> {
    let paths = vec![
        resolve_scratchpad_root(Path::new(&vault_path))?,
        Path::new(&vault_path).join("workspace.config.yaml"),
    ];
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&vault_path))?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        list_memos_in_transaction(lease, vault_path)
    })
}

fn list_memos_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
) -> Result<Vec<MemoEntry>, String> {
    let dir = memo_dir(&vault_path)?;
    scratchpad_list_in_transaction(lease, vault_path).map(|entries| {
        entries
            .into_iter()
            .filter(|entry| entry.collection == ScratchpadCollection::Memos)
            .map(|entry| memo_entry_from_scratchpad(entry, &dir))
            .collect()
    })
}

pub fn read_memo(vault_path: String, memo_path: String) -> Result<MemoDocument, String> {
    let mut paths = vec![
        resolve_scratchpad_root(Path::new(&vault_path))?,
        Path::new(&vault_path).join("workspace.config.yaml"),
    ];
    paths.push(resolve_memo_path(&vault_path, &memo_path)?);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&vault_path))?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        read_memo_in_transaction(lease, vault_path, memo_path)
    })
}

fn read_memo_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    memo_path: String,
) -> Result<MemoDocument, String> {
    let path = resolve_memo_path(&vault_path, &memo_path)?;
    let dir = memo_dir(&vault_path)?;
    let relative = path
        .strip_prefix(&dir)
        .map_err(|_| "Memo path escapes scratchpad/memos".to_string())?;
    let document = scratchpad_read_in_transaction(
        lease,
        vault_path,
        ScratchpadCollection::Memos,
        relative.to_string_lossy().replace('\\', "/"),
    )?;
    Ok(memo_document_from_scratchpad(document, &dir))
}

pub fn save_memo(
    vault_path: String,
    name: String,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    let mut paths = vec![
        resolve_scratchpad_root(Path::new(&vault_path))?,
        Path::new(&vault_path).join("workspace.config.yaml"),
    ];
    paths.push(memo_dir(&vault_path)?.join(normalize_memo_name(&name, format)));
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&vault_path))?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        save_memo_in_transaction(lease, vault_path, name, format, content)
    })
}

fn save_memo_in_transaction(
    lease: &PathTransactionLease,
    vault_path: String,
    name: String,
    format: MemoFormat,
    content: String,
) -> Result<MemoDocument, String> {
    let file_name = normalize_memo_name(&name, format);
    let dir = memo_dir(&vault_path)?;
    let document = scratchpad_save_in_transaction(
        lease,
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

pub fn delete_memo(
    vault_path: String,
    memo_path: String,
    expected_revision: Option<String>,
) -> Result<(), String> {
    if expected_revision.is_none() {
        return Err(
            "memo_conflict: expectedRevision is required; use the revision-checked Scratchpad API"
                .to_string(),
        );
    }
    let mut paths = vec![
        resolve_scratchpad_root(Path::new(&vault_path))?,
        Path::new(&vault_path).join("workspace.config.yaml"),
    ];
    paths.push(resolve_memo_path(&vault_path, &memo_path)?);
    let request = PathTransactionRequest::new(paths)?
        .require_parent(Path::new(&vault_path))?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        delete_memo_in_transaction(lease, vault_path, memo_path, expected_revision)
    })
}

fn delete_memo_in_transaction(
    lease: &PathTransactionLease,
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
    scratchpad_trash_in_transaction(
        lease,
        vault_path,
        ScratchpadCollection::Memos,
        relative.to_string_lossy().replace('\\', "/"),
        expected_revision,
    )
}

pub fn save_memo_as(
    vault_path: Option<String>,
    target_path: String,
    content: String,
) -> Result<MemoDocument, String> {
    let vault_path = vault_path.ok_or_else(|| {
        "memo_export_disabled: vaultPath is required for capability-checked Save As".to_string()
    })?;
    let path = PathBuf::from(target_path);
    let admission_path = if path.is_absolute() {
        path.clone()
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&path)
    };
    let request = PathTransactionRequest::new(vec![admission_path])?
        .require_parent(Path::new(&vault_path))?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        // The permission loader can migrate the registry before the memo write.
        lease.before_effect()?;
        assert_scratchpad_workspace_access(Path::new(&vault_path))?;
        assert_maru_can_write(&vault_path, WorkspaceWriteAction::Create)?;
        if path.is_dir() {
            return Err("Memo target is a directory".to_string());
        }
        let format = memo_format_for_path(&path).unwrap_or(MemoFormat::Markdown);
        write_new_memo_document(path, format, content)
    })
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
    let current = std::env::current_dir().map_err(|err| err.to_string())?;
    let admission_target = if target_dir.is_absolute() {
        target_dir.to_path_buf()
    } else {
        current.join(target_dir)
    };
    // Reserve the allocation directory because collision handling selects a
    // destination after admission. Sources participate in copy as well as move.
    let mut paths = vec![admission_target];
    paths.extend(sources.iter().map(|source| {
        let path = PathBuf::from(source);
        if path.is_absolute() {
            path
        } else {
            current.join(path)
        }
    }));
    with_path_transactions(PathTransactionRequest::new(paths)?, |lease| {
        lease.before_effect()?;
        store_shelf_files_in_transaction(sources, target_dir, operation, lease)
    })
}

fn store_shelf_files_in_transaction(
    sources: &[String],
    target_dir: &Path,
    operation: FileStoreOperation,
    lease: &PathTransactionLease,
) -> Result<Vec<StoredFileOutcome>, String> {
    let current = std::env::current_dir().map_err(|err| err.to_string())?;
    let mut paths = vec![current.join(target_dir)];
    paths.extend(sources.iter().map(|source| current.join(source)));
    lease.ensure_covered(paths)?;
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

pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn store_shelf_files(
        vault_path: String,
        sources: Vec<String>,
        operation: FileStoreOperation,
    ) -> Result<Vec<StoredFileOutcome>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&vault_path)],
                "worker:store_shelf_files",
            );
            super::store_shelf_files(vault_path, sources, operation)
        })
        .await
        .map_err(|err| format!("store_shelf_files_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn store_shelf_files_as(
        sources: Vec<String>,
        target_dir: String,
        operation: FileStoreOperation,
    ) -> Result<Vec<StoredFileOutcome>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&target_dir)],
                "worker:store_shelf_files_as",
            );
            super::store_shelf_files_as(sources, target_dir, operation)
        })
        .await
        .map_err(|err| format!("store_shelf_files_as_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn list_memos(vault_path: String) -> Result<Vec<MemoEntry>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:list_memos");
            super::list_memos(vault_path)
        })
        .await
        .map_err(|err| format!("list_memos_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn read_memo(vault_path: String, memo_path: String) -> Result<MemoDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:read_memo");
            super::read_memo(vault_path, memo_path)
        })
        .await
        .map_err(|err| format!("read_memo_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn save_memo(
        vault_path: String,
        name: String,
        format: MemoFormat,
        content: String,
    ) -> Result<MemoDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:save_memo");
            super::save_memo(vault_path, name, format, content)
        })
        .await
        .map_err(|err| format!("save_memo_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn delete_memo(
        vault_path: String,
        memo_path: String,
        expected_revision: Option<String>,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&vault_path)], "worker:delete_memo");
            super::delete_memo(vault_path, memo_path, expected_revision)
        })
        .await
        .map_err(|err| format!("delete_memo_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn save_memo_as(
        vault_path: Option<String>,
        target_path: String,
        content: String,
    ) -> Result<MemoDocument, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&target_path)], "worker:save_memo_as");
            super::save_memo_as(vault_path, target_path, content)
        })
        .await
        .map_err(|err| format!("save_memo_as_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scratchpad::scratchpad_read;
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

#[cfg(test)]
mod phase08_08 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::future::Future;
    use std::pin::Pin;
    use std::sync::mpsc;
    use std::time::Duration;

    type Command = Pin<Box<dyn Future<Output = Result<(), String>> + Send>>;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<Result<T, String>>
    where
        F: Future<Output = Result<T, String>> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<Result<T, String>>) -> Result<T, String> {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("shelf fixture completion")
    }

    fn mutation(kind: &str, root: &Path, invalid: bool) -> Command {
        let work = text(root);
        let source = text(&root.join(if invalid { "missing.pdf" } else { "source.pdf" }));
        let kind = kind.to_string();
        let target = text(&root.join("exports/memo.md"));
        let export_dir = text(&root.join("exports"));
        let memo = text(&root.join("scratchpad/memos/memo.md"));
        Box::pin(async move {
            match kind.as_str() {
                "store_shelf_files" => {
                    ipc::store_shelf_files(work, vec![source], FileStoreOperation::Copy)
                        .await
                        .map(|outcomes| {
                            assert_eq!(outcomes.len(), 1);
                            assert!(!outcomes[0].file_name.is_empty());
                        })
                }
                "store_shelf_files_as" => {
                    ipc::store_shelf_files_as(vec![source], export_dir, FileStoreOperation::Copy)
                        .await
                        .map(|outcomes| {
                            assert_eq!(outcomes.len(), 1);
                            assert!(!outcomes[0].file_name.is_empty());
                        })
                }
                "save_memo" => ipc::save_memo(
                    work,
                    "memo".into(),
                    MemoFormat::Markdown,
                    "memo bytes".into(),
                )
                .await
                .map(|document| assert_eq!(document.content, "memo bytes")),
                "save_memo_as" => ipc::save_memo_as(Some(work), target, "export bytes".into())
                    .await
                    .map(|document| assert_eq!(document.content, "export bytes")),
                "delete_memo" => ipc::delete_memo(work, memo, Some("stale revision".into())).await,
                _ => unreachable!(),
            }
        })
    }

    fn fixture(root: &Path) {
        fs::create_dir_all(root.join("scratchpad/memos")).unwrap();
        fs::create_dir_all(root.join("exports")).unwrap();
        fs::create_dir_all(root.join(".maru/stash/files")).unwrap();
        fs::write(root.join("source.pdf"), "source bytes").unwrap();
    }

    fn target(kind: &str, root: &Path) -> PathBuf {
        match kind {
            "store_shelf_files" => root.join(".maru/stash/files"),
            "store_shelf_files_as" => root.join("exports"),
            "save_memo" | "delete_memo" => root.join("scratchpad/memos/memo.md"),
            "save_memo_as" => root.join("exports/memo.md"),
            _ => unreachable!(),
        }
    }

    #[test]
    fn phase08_08_shelf_all_seven_wrappers_yield_and_preserve_join_errors() {
        let home = Home::new();
        let root = home.root.path();
        let work = text(root);
        for kind in [
            "store_shelf_files",
            "store_shelf_files_as",
            "save_memo",
            "save_memo_as",
            "delete_memo",
        ] {
            let hook = match kind {
                "store_shelf_files_as" => root.join("exports"),
                "save_memo_as" => root.join("exports/memo.md"),
                _ => root.to_path_buf(),
            };
            boundary(hook, kind, mutation(kind, root, false));
        }
        boundary(
            root.to_path_buf(),
            "list_memos",
            ipc::list_memos(work.clone()),
        );
        boundary(
            root.to_path_buf(),
            "read_memo",
            ipc::read_memo(work, "memo.md".into()),
        );
        assert!(!root.join("scratchpad").exists());
    }

    #[test]
    fn phase08_08_shelf_nonempty_results_and_legacy_rejections() {
        let home = Home::new();
        let root = home.root.path();
        fixture(root);
        let work = text(root);
        let saved = run(ipc::save_memo(
            work.clone(),
            "memo".into(),
            MemoFormat::Markdown,
            "한글 memo bytes".into(),
        ))
        .unwrap();
        let listed = run(ipc::list_memos(work.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "memo.md");
        assert_eq!(
            run(ipc::read_memo(work.clone(), saved.entry.path.clone()))
                .unwrap()
                .content,
            saved.content
        );
        assert!(run(ipc::save_memo(
            work.clone(),
            "memo".into(),
            MemoFormat::Markdown,
            "replacement".into()
        ))
        .unwrap_err()
        .contains("scratchpad_conflict"));
        assert!(run(ipc::delete_memo(
            work.clone(),
            saved.entry.path.clone(),
            None
        ))
        .unwrap_err()
        .starts_with("memo_conflict:"));
        assert!(run(ipc::delete_memo(
            work.clone(),
            saved.entry.path.clone(),
            Some("stale".into())
        ))
        .unwrap_err()
        .contains("scratchpad_conflict"));
        assert!(run(ipc::read_memo(work.clone(), "../outside.md".into()))
            .unwrap_err()
            .contains("escapes"));
        assert!(run(ipc::save_memo_as(
            None,
            text(&root.join("uncreated.md")),
            "body".into()
        ))
        .unwrap_err()
        .starts_with("memo_export_disabled:"));
        assert!(!root.join("uncreated.md").exists());
        run(mutation("store_shelf_files", root, false)).unwrap();
        run(mutation("store_shelf_files_as", root, false)).unwrap();
        run(mutation("save_memo_as", root, false)).unwrap();
        assert!(run(mutation("save_memo_as", root, false))
            .unwrap_err()
            .contains("memo_conflict"));
        assert_eq!(
            fs::read_to_string(&saved.entry.path).unwrap(),
            "한글 memo bytes"
        );
        let revision = crate::scratchpad::scratchpad_read(
            work.clone(),
            ScratchpadCollection::Memos,
            "memo.md".into(),
        )
        .unwrap()
        .entry
        .revision;
        run(ipc::delete_memo(
            work,
            saved.entry.path.clone(),
            Some(revision),
        ))
        .unwrap();
        assert!(!Path::new(&saved.entry.path).exists());
        // Move exercises source deletion while holding the same complete set.
        let moved = run(ipc::store_shelf_files_as(
            vec![text(&root.join("source.pdf"))],
            text(&root.join("moved")),
            FileStoreOperation::Move,
        ))
        .unwrap();
        assert!(!root.join("source.pdf").exists());
        assert_eq!(
            fs::read_to_string(&moved[0].target_path).unwrap(),
            "source bytes"
        );
    }

    #[test]
    fn phase08_08_shelf_every_write_same_target_and_error_release() {
        let home = Home::new();
        for kind in [
            "store_shelf_files",
            "store_shelf_files_as",
            "save_memo",
            "save_memo_as",
            "delete_memo",
        ] {
            let root = home.root.path().join(kind);
            fixture(&root);
            if kind == "delete_memo" {
                fs::write(root.join("scratchpad/memos/memo.md"), "keep").unwrap();
            }
            let key = target(kind, &root);
            let held = Held::new(key.clone(), "admitted");
            let first = start(mutation(kind, &root, false));
            held.wait();
            let waiting = Held::new(key.clone(), "before-admission");
            let second = start(mutation(kind, &root, false));
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{kind}"
            );
            held.release();
            if kind == "delete_memo" {
                assert!(done(first).unwrap_err().contains("scratchpad_conflict"));
                assert!(done(second).unwrap_err().contains("scratchpad_conflict"));
                assert_eq!(fs::read_to_string(&key).unwrap(), "keep");
            } else {
                done(first).unwrap();
                let result = done(second);
                if kind.starts_with("save_") {
                    assert!(result.unwrap_err().contains("conflict"));
                } else {
                    result.unwrap();
                }
            }
            drop(waiting);
            drop(held);
            // A failing real write releases admission to a waiting Files writer.
            let held = Held::new(key.clone(), "admitted");
            let first = start(mutation(kind, &root, true));
            held.wait();
            let parent = match kind {
                "store_shelf_files" => ".maru/stash/files",
                "store_shelf_files_as" | "save_memo_as" => "exports",
                _ => "scratchpad/memos",
            };
            // Directory creation must overlap the exact reserved file for saves.
            let child = if matches!(kind, "save_memo" | "save_memo_as" | "delete_memo") {
                "memo.md"
            } else {
                "after-error"
            };
            let contender_key = root.join(parent).join(child);
            let waiting = Held::new(contender_key, "before-admission");
            let second = start(crate::workspace_files::ipc::create_workspace_directory(
                text(&root),
                parent.into(),
                child.into(),
            ));
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{kind}: error wait"
            );
            held.release();
            assert!(done(first).is_err(), "{kind}: expected denied write");
            let released = done(second);
            if child == "memo.md" {
                assert!(released.unwrap_err().contains("already exists"));
            } else {
                released.unwrap();
                assert!(root.join(parent).join(child).is_dir());
            }
        }
    }

    #[test]
    fn phase08_08_shelf_export_permission_denial_then_success() {
        let home = Home::new();
        let root = home.root.path();
        fixture(root);
        let registry = crate::vault_list::workspace_registry_path().unwrap();
        fs::create_dir_all(registry.parent().unwrap()).unwrap();
        fs::write(&registry, serde_json::json!({"workspaces":[{"label":"fixture","visibility":"private","path":text(root),"writePolicy":"readOnly"}]}).to_string()).unwrap();
        assert!(run(mutation("save_memo_as", root, false))
            .unwrap_err()
            .contains("blocked"));
        assert!(!root.join("exports/memo.md").exists());
        fs::write(registry, r#"{"workspaces":[]}"#).unwrap();
        run(mutation("save_memo_as", root, false)).unwrap();
    }
    #[test]
    fn phase08_08_shelf_all_writers_versus_parent_rename_both_orders() {
        let home = Home::new();
        for kind in [
            "store_shelf_files",
            "store_shelf_files_as",
            "save_memo",
            "save_memo_as",
            "delete_memo",
        ] {
            for parent_first in [false, true] {
                let root = home.root.path().join(format!("{kind}-{parent_first}"));
                fixture(&root);
                if kind == "delete_memo" {
                    fs::write(root.join("scratchpad/memos/memo.md"), "keep").unwrap();
                }
                let parent_rel = match kind {
                    "store_shelf_files" => ".maru/stash/files",
                    "store_shelf_files_as" | "save_memo_as" => "exports",
                    _ => "scratchpad/memos",
                };
                let parent_path = root.join(parent_rel);
                let moved = parent_path.with_file_name("renamed");
                let rename = crate::workspace_files::ipc::rename_workspace_entry(
                    text(&root),
                    parent_rel.into(),
                    "renamed".into(),
                );
                let child = mutation(kind, &root, false);
                if parent_first {
                    let held = Held::new(parent_path.clone(), "pre-effect");
                    let parent = start(rename);
                    held.wait();
                    let waiting = Held::new(target(kind, &root), "before-admission");
                    let child = start(child);
                    waiting.wait();
                    waiting.release();
                    assert!(child.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(parent).unwrap();
                    assert!(
                        done(child).is_err(),
                        "{kind}: removed parent must reject child"
                    );
                } else {
                    let held = Held::new(target(kind, &root), "admitted");
                    let child = start(child);
                    held.wait();
                    let waiting = Held::new(parent_path.clone(), "before-admission");
                    let parent = start(rename);
                    waiting.wait();
                    waiting.release();
                    assert!(parent.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    let child_result = done(child);
                    if kind == "delete_memo" {
                        assert!(child_result.unwrap_err().contains("scratchpad_conflict"));
                    } else {
                        child_result.unwrap();
                    }
                    done(parent).unwrap();
                    let name = if kind.starts_with("store_") {
                        "source.pdf"
                    } else {
                        "memo.md"
                    };
                    let body = fs::read_to_string(moved.join(name)).unwrap();
                    assert!(matches!(
                        body.as_str(),
                        "source bytes" | "memo bytes" | "export bytes" | "keep"
                    ));
                }
                assert!(!parent_path.exists(), "{kind}: original parent resurrected");
                assert!(moved.is_dir());
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_08_shelf_copy_and_export_aliases_conflict_with_physical_parent() {
        let home = Home::new();
        let root = home.root.path();
        for export in [false, true] {
            let physical = root.join(format!("physical-{export}"));
            let alias = root.join(format!("alias-{export}"));
            fs::create_dir(&physical).unwrap();
            std::os::unix::fs::symlink(&physical, &alias).unwrap();
            let source = root.join(format!("source-{export}.md"));
            fs::write(&source, "alias bytes").unwrap();
            let future: Command = if export {
                let work = text(root);
                let target = text(&alias.join("memo.md"));
                Box::pin(async move {
                    ipc::save_memo_as(Some(work), target, "alias bytes".into())
                        .await
                        .map(|_| ())
                })
            } else {
                let source = text(&source);
                let target = text(&alias);
                Box::pin(async move {
                    ipc::store_shelf_files_as(vec![source], target, FileStoreOperation::Copy)
                        .await
                        .map(|_| ())
                })
            };
            let key = if export {
                alias.join("memo.md")
            } else {
                alias.clone()
            };
            let held = Held::new(key, "admitted");
            let child = start(future);
            held.wait();
            let waiting = Held::new(physical.clone(), "before-admission");
            let parent = start(crate::workspace_files::ipc::rename_workspace_entry(
                text(root),
                text(&physical),
                format!("moved-{export}"),
            ));
            waiting.wait();
            waiting.release();
            assert!(parent.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            done(child).unwrap();
            done(parent).unwrap();
            let name = if export {
                "memo.md".into()
            } else {
                format!("source-{export}.md")
            };
            assert_eq!(
                fs::read_to_string(root.join(format!("moved-{export}")).join(name)).unwrap(),
                "alias bytes"
            );
        }
    }
    #[test]
    fn phase08_08_shelf_actual_primary_workspace_and_read_only_guards() {
        use crate::scratchpad::phase08_08::{registry, PrimaryWorkspaceAccessFixture};
        let home = Home::new();
        let root = home.root.path().join("workspace");
        fixture(&root);
        fs::write(root.join("scratchpad/memos/memo.md"), "keep").unwrap();
        let _guard = PrimaryWorkspaceAccessFixture::new(root.clone());
        registry(home.root.path(), "direct");
        let work = text(&root);
        assert!(run(ipc::list_memos(work.clone()))
            .unwrap_err()
            .starts_with("scratchpad_workspace_denied:"));
        assert!(run(ipc::read_memo(
            work.clone(),
            text(&root.join("scratchpad/memos/memo.md"))
        ))
        .unwrap_err()
        .starts_with("scratchpad_workspace_denied:"));
        for kind in ["save_memo", "delete_memo", "save_memo_as"] {
            assert!(
                run(mutation(kind, &root, false))
                    .unwrap_err()
                    .starts_with("scratchpad_workspace_denied:"),
                "{kind}"
            );
        }
        registry(&root, "readOnly");
        assert_eq!(run(ipc::list_memos(work)).unwrap().len(), 1);
        for kind in ["save_memo", "delete_memo", "save_memo_as"] {
            assert!(
                run(mutation(kind, &root, false))
                    .unwrap_err()
                    .contains("Workspace writes are blocked"),
                "{kind}"
            );
        }
        assert_eq!(
            fs::read_to_string(root.join("scratchpad/memos/memo.md")).unwrap(),
            "keep"
        );
        assert!(!root.join("exports/memo.md").exists());
        registry(&root, "direct");
        fs::remove_file(root.join("scratchpad/memos/memo.md")).unwrap();
        run(mutation("save_memo", &root, false)).unwrap();
        run(mutation("save_memo_as", &root, false)).unwrap();
        let revision = crate::scratchpad::scratchpad_read(
            text(&root),
            ScratchpadCollection::Memos,
            "memo.md".into(),
        )
        .unwrap()
        .entry
        .revision;
        run(ipc::delete_memo(
            text(&root),
            text(&root.join("scratchpad/memos/memo.md")),
            Some(revision),
        ))
        .unwrap();
        assert!(!root.join("scratchpad/memos/memo.md").exists());
    }
}
