use crate::vault::{
    load_maruignore, matches_maruignore, normalize_existing_dir, resolve_inside_vault, ScanFilter,
    ScanOptions,
};
use crate::vault_guard::is_managed_root;
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::win_process::NoWindow;
use walkdir::WalkDir;

const GENERATED_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
];
const BINARY_SAMPLE_BYTES: usize = 8 * 1024;
const KNOWN_BINARY_EXTENSIONS: &[&str] = &[
    "7z", "app", "bin", "db", "dmg", "doc", "docx", "gif", "gz", "heic", "hwp", "hwpx", "icns",
    "ico", "jpeg", "jpg", "key", "mov", "mp3", "mp4", "numbers", "pages", "pdf", "png", "ppt",
    "pptx", "sqlite", "tar", "tiff", "webp", "xls", "xlsx", "zip",
];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceFileEntry {
    pub path: String,
    pub rel_path: String,
    pub name: String,
    pub extension: Option<String>,
    pub file_kind: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub git_tracked: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryKind {
    File,
    Directory,
    Symlink,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceEntryTargetKind {
    File,
    Directory,
    Missing,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntryNode {
    pub kind: WorkspaceEntryKind,
    pub target_kind: Option<WorkspaceEntryTargetKind>,
    pub path: String,
    pub rel_path: String,
    pub parent_rel_path: String,
    pub name: String,
    pub extension: Option<String>,
    pub file_kind: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub git_tracked: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceEntriesSnapshot {
    pub revision: String,
    pub entries: Vec<WorkspaceEntryNode>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceMutationStatus {
    Done,
    Error,
}

fn assert_files_mutation_allowed(vault: &Path, action: WorkspaceWriteAction) -> Result<(), String> {
    let vault_path = vault.to_string_lossy();
    assert_maru_can_write(&vault_path, action)?;
    if is_managed_root(&vault_path) {
        return Err("Managed workspaces are read-only in Files".to_string());
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceMutationOutcome {
    pub source_path: Option<String>,
    pub target_path: Option<String>,
    pub name: String,
    pub status: WorkspaceMutationStatus,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RenameTransaction {
    source_path: String,
    target_path: String,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileQueueOperation {
    Copy,
    Move,
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FileQueueSourceKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQueueApplyItem {
    pub id: String,
    pub source_path: String,
    pub source_kind: FileQueueSourceKind,
    pub target_dir: String,
    pub operation: FileQueueOperation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQueueApplyOutcome {
    pub id: String,
    pub source_path: String,
    pub target_path: String,
    pub file_name: String,
    pub operation: FileQueueOperation,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileQueueSourceInfo {
    pub path: String,
    pub source_rel_path: String,
    pub file_name: String,
    pub source_kind: FileQueueSourceKind,
}

#[tauri::command]
pub fn scan_workspace_files(
    vault_path: String,
    scan_options: Option<ScanOptions>,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let scan_filter = ScanFilter::from_options(scan_options)?;
    scan_workspace_files_at(&vault, &scan_filter)
}

#[tauri::command]
pub fn scan_workspace_entries(
    vault_path: String,
    scan_options: Option<ScanOptions>,
) -> Result<WorkspaceEntriesSnapshot, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    recover_rename_transactions(&vault)?;
    let scan_filter = ScanFilter::from_options(scan_options)?;
    scan_workspace_entries_at(&vault, &scan_filter)
}

#[tauri::command]
pub fn create_workspace_directory(
    vault_path: String,
    parent_path: String,
    name: String,
) -> Result<WorkspaceMutationOutcome, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    assert_files_mutation_allowed(&vault, WorkspaceWriteAction::Create)?;
    validate_entry_name(&name)?;
    let parent = resolve_inside_vault(&vault.to_string_lossy(), &parent_path)?;
    if !fs::metadata(&parent)
        .map(|value| value.is_dir())
        .unwrap_or(false)
    {
        return Err("Parent path is not a directory".to_string());
    }
    let target = parent.join(&name);
    if path_entry_exists(&target) {
        return Err(format!("An item named {name} already exists"));
    }
    fs::create_dir(&target).map_err(|err| format!("Cannot create directory: {err}"))?;
    Ok(success_outcome(None, Some(&target)))
}

#[tauri::command]
pub fn rename_workspace_entry(
    vault_path: String,
    source_path: String,
    new_name: String,
) -> Result<WorkspaceMutationOutcome, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    assert_files_mutation_allowed(&vault, WorkspaceWriteAction::RenameMove)?;
    validate_entry_name(&new_name)?;
    let source = resolve_workspace_entry(&vault, &source_path)?;
    if source == vault {
        return Err("The workspace root cannot be renamed".to_string());
    }
    let parent = source
        .parent()
        .ok_or_else(|| "Source path has no parent".to_string())?;
    let target = parent.join(&new_name);
    if source == target {
        return Ok(success_outcome(Some(&source), Some(&target)));
    }
    // On case-insensitive filesystems (macOS default) a case-only rename sees
    // its own file at the target path — allow it instead of reporting a clash.
    if path_entry_exists(&target) && !is_same_entry(&source, &target) {
        return Err(format!("An item named {new_name} already exists"));
    }
    journaled_rename(&vault, &source, &target)?;
    Ok(success_outcome(Some(&source), Some(&target)))
}

#[tauri::command]
pub fn duplicate_workspace_entries(
    vault_path: String,
    source_paths: Vec<String>,
) -> Result<Vec<WorkspaceMutationOutcome>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    assert_files_mutation_allowed(&vault, WorkspaceWriteAction::Create)?;
    let mut outcomes = Vec::with_capacity(source_paths.len());
    for raw_source in source_paths {
        let outcome = match resolve_workspace_entry(&vault, &raw_source) {
            Ok(source) if source != vault => {
                let parent = source.parent().unwrap_or(&vault);
                let name = entry_name(&source).unwrap_or_else(|_| raw_source.clone());
                let target = unique_path(parent.join(&name));
                match copy_entry(&source, &target) {
                    Ok(()) => success_outcome(Some(&source), Some(&target)),
                    Err(err) => error_outcome(Some(&source), name, err),
                }
            }
            Ok(_) => error_outcome(
                Some(&vault),
                raw_source,
                "The workspace root cannot be duplicated".to_string(),
            ),
            Err(err) => error_outcome(None, raw_source, err),
        };
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

#[tauri::command]
pub fn paste_workspace_entries(
    vault_path: String,
    source_paths: Vec<String>,
    target_dir: String,
    operation: FileQueueOperation,
) -> Result<Vec<WorkspaceMutationOutcome>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    let action = match operation {
        FileQueueOperation::Copy => WorkspaceWriteAction::Create,
        FileQueueOperation::Move => WorkspaceWriteAction::RenameMove,
    };
    assert_files_mutation_allowed(&vault, action)?;
    let target_dir = resolve_inside_vault(&vault.to_string_lossy(), &target_dir)?;
    if !fs::metadata(&target_dir)
        .map(|value| value.is_dir())
        .unwrap_or(false)
    {
        return Err("Paste target is not a directory".to_string());
    }

    let mut outcomes = Vec::with_capacity(source_paths.len());
    for raw_source in source_paths {
        let outcome = match resolve_workspace_entry(&vault, &raw_source) {
            Ok(source) if source != vault => {
                let name = entry_name(&source).unwrap_or_else(|_| raw_source.clone());
                let target = unique_path(target_dir.join(&name));
                if is_directory_entry(&source) && target.starts_with(&source) {
                    error_outcome(
                        Some(&source),
                        name,
                        "Target directory cannot be inside the source directory".to_string(),
                    )
                } else {
                    let result = match operation {
                        FileQueueOperation::Copy => copy_entry(&source, &target),
                        FileQueueOperation::Move => move_entry(&vault, &source, &target),
                    };
                    match result {
                        Ok(()) => success_outcome(Some(&source), Some(&target)),
                        Err(err) => error_outcome(Some(&source), name, err),
                    }
                }
            }
            Ok(_) => error_outcome(
                Some(&vault),
                raw_source,
                "The workspace root cannot be pasted".to_string(),
            ),
            Err(err) => error_outcome(None, raw_source, err),
        };
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

#[tauri::command]
pub fn trash_workspace_entries(
    vault_path: String,
    target_paths: Vec<String>,
) -> Result<Vec<WorkspaceMutationOutcome>, String> {
    let vault = normalize_existing_dir(&vault_path)?;
    assert_files_mutation_allowed(&vault, WorkspaceWriteAction::Delete)?;
    let mut outcomes = Vec::with_capacity(target_paths.len());
    for raw_target in target_paths {
        let outcome = match resolve_workspace_entry(&vault, &raw_target) {
            Ok(target) if target != vault => {
                let name = entry_name(&target).unwrap_or_else(|_| raw_target.clone());
                match move_path_to_system_trash(&target) {
                    Ok(()) => WorkspaceMutationOutcome {
                        source_path: Some(target.to_string_lossy().to_string()),
                        target_path: None,
                        name,
                        status: WorkspaceMutationStatus::Done,
                        error: None,
                    },
                    Err(err) => error_outcome(Some(&target), name, err),
                }
            }
            Ok(_) => error_outcome(
                Some(&vault),
                raw_target,
                "The workspace root cannot be trashed".to_string(),
            ),
            Err(err) => error_outcome(None, raw_target, err),
        };
        outcomes.push(outcome);
    }
    Ok(outcomes)
}

#[tauri::command]
pub fn describe_file_queue_sources(paths: Vec<String>) -> Result<Vec<FileQueueSourceInfo>, String> {
    let mut sources = Vec::new();
    for path in paths {
        let source_path = PathBuf::from(&path);
        let metadata = fs::symlink_metadata(&source_path)
            .map_err(|err| format!("Cannot inspect source: {err}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Source symlinks are not supported: {}",
                source_path.display()
            ));
        }
        let source_kind = if metadata.is_dir() {
            FileQueueSourceKind::Directory
        } else if metadata.is_file() {
            FileQueueSourceKind::File
        } else {
            return Err(format!(
                "Source is not a file or directory: {}",
                source_path.display()
            ));
        };
        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Source file name is not valid UTF-8".to_string())?
            .to_string();
        sources.push(FileQueueSourceInfo {
            path: source_path.to_string_lossy().to_string(),
            source_rel_path: file_name.clone(),
            file_name,
            source_kind,
        });
    }
    Ok(sources)
}

#[tauri::command]
pub fn apply_file_queue(
    vault_path: String,
    items: Vec<FileQueueApplyItem>,
) -> Result<Vec<FileQueueApplyOutcome>, String> {
    if items.is_empty() {
        return Ok(Vec::new());
    }
    let vault = normalize_existing_dir(&vault_path)?;
    let mut outcomes = Vec::new();
    for item in items {
        let action = match item.operation {
            FileQueueOperation::Copy => WorkspaceWriteAction::Create,
            FileQueueOperation::Move => WorkspaceWriteAction::RenameMove,
        };
        assert_maru_can_write(&vault.to_string_lossy(), action)?;
        let source_path = PathBuf::from(&item.source_path);
        validate_queue_source(&source_path, item.source_kind)?;
        let target_dir = resolve_target_dir(&vault, &item.target_dir)?;
        let file_name = source_path
            .file_name()
            .and_then(|value| value.to_str())
            .ok_or_else(|| "Source file name is not valid UTF-8".to_string())?
            .to_string();
        let target_path = unique_path(target_dir.join(&file_name));
        reject_target_inside_source(&source_path, &target_path, item.source_kind)?;
        fs::create_dir_all(&target_dir)
            .map_err(|err| format!("Cannot create target directory: {err}"))?;
        if !target_dir.is_dir() {
            return Err("Target path is not a directory".to_string());
        }
        match item.operation {
            FileQueueOperation::Copy => copy_source(&source_path, &target_path, item.source_kind)?,
            FileQueueOperation::Move => move_source(&source_path, &target_path, item.source_kind)?,
        }
        outcomes.push(FileQueueApplyOutcome {
            id: item.id,
            source_path: source_path.to_string_lossy().to_string(),
            target_path: target_path.to_string_lossy().to_string(),
            file_name: target_path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&file_name)
                .to_string(),
            operation: item.operation,
        });
    }
    Ok(outcomes)
}

fn validate_queue_source(path: &Path, kind: FileQueueSourceKind) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|err| format!("Cannot inspect source: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Source symlinks are not supported: {}",
            path.display()
        ));
    }
    match kind {
        FileQueueSourceKind::File if metadata.is_file() => Ok(()),
        FileQueueSourceKind::Directory if metadata.is_dir() => Ok(()),
        FileQueueSourceKind::File => Err(format!("Source is not a file: {}", path.display())),
        FileQueueSourceKind::Directory => {
            Err(format!("Source is not a directory: {}", path.display()))
        }
    }
}

pub(crate) fn copy_source(
    source: &Path,
    target: &Path,
    kind: FileQueueSourceKind,
) -> Result<(), String> {
    match kind {
        FileQueueSourceKind::File => {
            fs::copy(source, target).map_err(|err| format!("Cannot copy file: {err}"))?;
            Ok(())
        }
        FileQueueSourceKind::Directory => copy_dir_recursive(source, target),
    }
}

pub(crate) fn move_source(
    source: &Path,
    target: &Path,
    kind: FileQueueSourceKind,
) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_source(source, target, kind)?;
            match kind {
                FileQueueSourceKind::File => fs::remove_file(source)
                    .map_err(|err| format!("Cannot remove moved source: {err}")),
                FileQueueSourceKind::Directory => fs::remove_dir_all(source)
                    .map_err(|err| format!("Cannot remove moved directory: {err}")),
            }
        }
    }
}

fn copy_dir_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir_all(target).map_err(|err| format!("Cannot create target directory: {err}"))?;
    for entry in WalkDir::new(source).follow_links(false).into_iter() {
        let entry = entry.map_err(|err| format!("Cannot read source directory: {err}"))?;
        let path = entry.path();
        let rel = path
            .strip_prefix(source)
            .map_err(|err| format!("Cannot resolve directory entry: {err}"))?;
        if rel.as_os_str().is_empty() {
            continue;
        }
        let destination = target.join(rel);
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            return Err(format!(
                "Source symlinks are not supported: {}",
                path.display()
            ));
        }
        if file_type.is_dir() {
            fs::create_dir_all(&destination)
                .map_err(|err| format!("Cannot create target directory: {err}"))?;
        } else if file_type.is_file() {
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Cannot create target directory: {err}"))?;
            }
            fs::copy(path, &destination).map_err(|err| format!("Cannot copy file: {err}"))?;
        }
    }
    Ok(())
}

fn reject_target_inside_source(
    source: &Path,
    target: &Path,
    kind: FileQueueSourceKind,
) -> Result<(), String> {
    if kind != FileQueueSourceKind::Directory {
        return Ok(());
    }
    let source = source
        .canonicalize()
        .map_err(|err| format!("Cannot inspect source: {err}"))?;
    let target = resolve_through_existing_ancestor(target)
        .ok_or_else(|| "Cannot inspect target path".to_string())?;
    if target.starts_with(&source) {
        Err("Target directory cannot be inside the source directory".to_string())
    } else {
        Ok(())
    }
}

fn scan_workspace_files_at(
    vault: &Path,
    scan_filter: &ScanFilter,
) -> Result<Vec<WorkspaceFileEntry>, String> {
    let ignore_patterns = load_maruignore(vault);
    let tracked = git_tracked_paths(vault);
    let mut entries = Vec::new();
    for entry in WalkDir::new(vault)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if path == vault {
                return true;
            }
            if scan_filter.is_excluded_path(path, vault, GENERATED_DIRS) {
                return false;
            }
            let rel = path.strip_prefix(vault).unwrap_or(path);
            !matches_maruignore(rel, &ignore_patterns)
        })
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        let rel_path = path
            .strip_prefix(vault)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let metadata = entry
            .metadata()
            .map_err(|err| format!("Cannot read file metadata: {err}"))?;
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let file_kind = extension.clone().unwrap_or_else(|| "file".to_string());
        entries.push(WorkspaceFileEntry {
            path: path.to_string_lossy().to_string(),
            rel_path: rel_path.clone(),
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&rel_path)
                .to_string(),
            extension,
            file_kind,
            size_bytes: metadata.len(),
            updated_at: metadata
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|value| value.to_rfc3339()),
            git_tracked: tracked.contains(&rel_path),
            binary: is_binary_file(path),
        });
    }
    entries.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(entries)
}

fn scan_workspace_entries_at(
    vault: &Path,
    scan_filter: &ScanFilter,
) -> Result<WorkspaceEntriesSnapshot, String> {
    let ignore_patterns = load_maruignore(vault);
    let tracked = git_tracked_paths(vault);
    let mut entries = Vec::new();
    for entry in WalkDir::new(vault)
        .follow_links(true)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if path == vault {
                return true;
            }
            if scan_filter.is_excluded_path(path, vault, GENERATED_DIRS) {
                return false;
            }
            let rel = path.strip_prefix(vault).unwrap_or(path);
            !matches_maruignore(rel, &ignore_patterns)
        })
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path == vault {
            continue;
        }
        let Ok(link_metadata) = fs::symlink_metadata(path) else {
            continue;
        };
        let is_symlink = link_metadata.file_type().is_symlink();
        let target_metadata = if is_symlink {
            fs::metadata(path).ok()
        } else {
            None
        };
        let target_kind = if is_symlink {
            Some(match target_metadata.as_ref() {
                Some(metadata) if metadata.is_dir() => WorkspaceEntryTargetKind::Directory,
                Some(metadata) if metadata.is_file() => WorkspaceEntryTargetKind::File,
                _ => WorkspaceEntryTargetKind::Missing,
            })
        } else {
            None
        };
        let effective_metadata = target_metadata.as_ref().unwrap_or(&link_metadata);
        let kind = if is_symlink {
            WorkspaceEntryKind::Symlink
        } else if link_metadata.is_dir() {
            WorkspaceEntryKind::Directory
        } else if link_metadata.is_file() {
            WorkspaceEntryKind::File
        } else {
            continue;
        };
        let rel_path = path
            .strip_prefix(vault)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/");
        let parent_rel_path = Path::new(&rel_path)
            .parent()
            .map(|value| value.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let extension = path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| value.to_ascii_lowercase());
        let file_like =
            kind == WorkspaceEntryKind::File || target_kind == Some(WorkspaceEntryTargetKind::File);
        let file_kind = if kind == WorkspaceEntryKind::Directory
            || target_kind == Some(WorkspaceEntryTargetKind::Directory)
        {
            "directory".to_string()
        } else if kind == WorkspaceEntryKind::Symlink {
            extension.clone().unwrap_or_else(|| "symlink".to_string())
        } else {
            extension.clone().unwrap_or_else(|| "file".to_string())
        };
        entries.push(WorkspaceEntryNode {
            kind,
            target_kind,
            path: path.to_string_lossy().to_string(),
            rel_path: rel_path.clone(),
            parent_rel_path,
            name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&rel_path)
                .to_string(),
            extension,
            file_kind,
            size_bytes: if file_like {
                effective_metadata.len()
            } else {
                0
            },
            updated_at: effective_metadata
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|value| value.to_rfc3339()),
            git_tracked: tracked.contains(&rel_path),
            binary: file_like && is_binary_file(path),
        });
    }
    entries.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    let revision = format!("{}:{}", Utc::now().timestamp_millis(), entries.len());
    Ok(WorkspaceEntriesSnapshot { revision, entries })
}

fn validate_entry_name(name: &str) -> Result<(), String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Name is required".to_string());
    }
    if trimmed != name {
        return Err("Name cannot start or end with whitespace".to_string());
    }
    if matches!(trimmed, "." | "..") || trimmed.contains('/') || trimmed.contains('\\') {
        return Err("Name cannot contain path separators".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Name contains an invalid character".to_string());
    }
    Ok(())
}

fn resolve_workspace_entry(vault: &Path, raw_path: &str) -> Result<PathBuf, String> {
    let path = resolve_inside_vault(&vault.to_string_lossy(), raw_path)?;
    if !path_entry_exists(&path) {
        return Err(format!("Workspace item does not exist: {}", path.display()));
    }
    Ok(path)
}

fn path_entry_exists(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok()
}

#[cfg(unix)]
fn is_same_entry(a: &Path, b: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    match (fs::symlink_metadata(a), fs::symlink_metadata(b)) {
        (Ok(left), Ok(right)) => left.dev() == right.dev() && left.ino() == right.ino(),
        _ => false,
    }
}

#[cfg(not(unix))]
fn is_same_entry(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(left), Ok(right)) => left == right,
        _ => false,
    }
}

fn entry_name(path: &Path) -> Result<String, String> {
    path.file_name()
        .and_then(|value| value.to_str())
        .map(ToString::to_string)
        .ok_or_else(|| "Workspace item name is not valid UTF-8".to_string())
}

fn is_directory_entry(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
}

fn success_outcome(source: Option<&Path>, target: Option<&Path>) -> WorkspaceMutationOutcome {
    let name = target
        .or(source)
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .unwrap_or("item")
        .to_string();
    WorkspaceMutationOutcome {
        source_path: source.map(|path| path.to_string_lossy().to_string()),
        target_path: target.map(|path| path.to_string_lossy().to_string()),
        name,
        status: WorkspaceMutationStatus::Done,
        error: None,
    }
}

fn error_outcome(source: Option<&Path>, name: String, error: String) -> WorkspaceMutationOutcome {
    WorkspaceMutationOutcome {
        source_path: source.map(|path| path.to_string_lossy().to_string()),
        target_path: None,
        name,
        status: WorkspaceMutationStatus::Error,
        error: Some(error),
    }
}

fn copy_entry(source: &Path, target: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(source).map_err(|err| format!("Cannot inspect source: {err}"))?;
    if metadata.file_type().is_symlink() {
        return copy_symlink(source, target);
    }
    if metadata.is_dir() {
        copy_dir_recursive_with_symlinks(source, target)
    } else if metadata.is_file() {
        fs::copy(source, target)
            .map(|_| ())
            .map_err(|err| format!("Cannot copy file: {err}"))
    } else {
        Err("Source is not a file, directory, or symlink".to_string())
    }
}

fn move_entry(vault: &Path, source: &Path, target: &Path) -> Result<(), String> {
    match journaled_rename(vault, source, target) {
        Ok(()) => Ok(()),
        Err(rename_error) => {
            copy_entry(source, target).map_err(|copy_error| {
                format!("Cannot move item: {rename_error}; copy fallback failed: {copy_error}")
            })?;
            remove_entry(source).map_err(|remove_error| {
                let _ = remove_entry(target);
                format!("Cannot remove moved source: {remove_error}")
            })
        }
    }
}

fn remove_entry(path: &Path) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|err| format!("Cannot inspect item: {err}"))?;
    if metadata.file_type().is_symlink() || metadata.is_file() {
        fs::remove_file(path).map_err(|err| format!("Cannot remove file: {err}"))
    } else if metadata.is_dir() {
        fs::remove_dir_all(path).map_err(|err| format!("Cannot remove directory: {err}"))
    } else {
        Err("Item is not removable".to_string())
    }
}

fn copy_dir_recursive_with_symlinks(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|err| format!("Cannot create target directory: {err}"))?;
    for entry in WalkDir::new(source).follow_links(false).min_depth(1) {
        let entry = entry.map_err(|err| format!("Cannot read source directory: {err}"))?;
        let rel = entry
            .path()
            .strip_prefix(source)
            .map_err(|err| format!("Cannot resolve directory entry: {err}"))?;
        let destination = target.join(rel);
        let file_type = entry.file_type();
        if file_type.is_symlink() {
            copy_symlink(entry.path(), &destination)?;
        } else if file_type.is_dir() {
            fs::create_dir(&destination)
                .map_err(|err| format!("Cannot create target directory: {err}"))?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), &destination)
                .map_err(|err| format!("Cannot copy file: {err}"))?;
        }
    }
    Ok(())
}

#[cfg(unix)]
fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    let link = fs::read_link(source).map_err(|err| format!("Cannot read symlink: {err}"))?;
    std::os::unix::fs::symlink(link, target).map_err(|err| format!("Cannot copy symlink: {err}"))
}

#[cfg(windows)]
fn copy_symlink(source: &Path, target: &Path) -> Result<(), String> {
    let link = fs::read_link(source).map_err(|err| format!("Cannot read symlink: {err}"))?;
    if fs::metadata(source)
        .map(|metadata| metadata.is_dir())
        .unwrap_or(false)
    {
        std::os::windows::fs::symlink_dir(link, target)
            .map_err(|err| format!("Cannot copy directory symlink: {err}"))
    } else {
        std::os::windows::fs::symlink_file(link, target)
            .map_err(|err| format!("Cannot copy file symlink: {err}"))
    }
}

fn transaction_dir(vault: &Path) -> PathBuf {
    // Lives inside the existing per-workspace .maru dir so an interrupted
    // rename does not leave a new dot-directory in the user's repo root.
    vault.join(".maru").join("rename-txn")
}

fn journaled_rename(vault: &Path, source: &Path, target: &Path) -> Result<(), String> {
    let dir = transaction_dir(vault);
    fs::create_dir_all(&dir)
        .map_err(|err| format!("Cannot create rename transaction directory: {err}"))?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let journal = dir.join(format!("{}-{nonce}.json", std::process::id()));
    let temporary = dir.join(format!(".{}-{nonce}.tmp", std::process::id()));
    let payload = RenameTransaction {
        source_path: source.to_string_lossy().to_string(),
        target_path: target.to_string_lossy().to_string(),
    };
    let encoded = serde_json::to_vec(&payload)
        .map_err(|err| format!("Cannot serialize rename transaction: {err}"))?;
    fs::write(&temporary, encoded)
        .map_err(|err| format!("Cannot write rename transaction: {err}"))?;
    fs::rename(&temporary, &journal)
        .map_err(|err| format!("Cannot publish rename transaction: {err}"))?;
    match fs::rename(source, target) {
        Ok(()) => {
            let _ = fs::remove_file(&journal);
            cleanup_transaction_dir(&dir);
            Ok(())
        }
        Err(err) => {
            let _ = fs::remove_file(&journal);
            cleanup_transaction_dir(&dir);
            Err(format!("Cannot rename item: {err}"))
        }
    }
}

fn recover_rename_transactions(vault: &Path) -> Result<(), String> {
    let dir = transaction_dir(vault);
    if !dir.is_dir() {
        return Ok(());
    }
    let entries =
        fs::read_dir(&dir).map_err(|err| format!("Cannot read rename transactions: {err}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Ok(content) = fs::read(&path) else {
            continue;
        };
        let Ok(transaction) = serde_json::from_slice::<RenameTransaction>(&content) else {
            continue;
        };
        let source = PathBuf::from(transaction.source_path);
        let target = PathBuf::from(transaction.target_path);
        if !source.starts_with(vault) || !target.starts_with(vault) {
            continue;
        }
        let source_exists = path_entry_exists(&source);
        let target_exists = path_entry_exists(&target);
        if source_exists && !target_exists {
            if fs::rename(&source, &target).is_ok() {
                let _ = fs::remove_file(&path);
            }
        } else if !source_exists {
            let _ = fs::remove_file(&path);
        }
    }
    cleanup_transaction_dir(&dir);
    Ok(())
}

fn cleanup_transaction_dir(dir: &Path) {
    let is_empty = fs::read_dir(dir)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(false);
    if is_empty {
        let _ = fs::remove_dir(dir);
    }
}

fn move_path_to_system_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::new();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
            .delete(path)
            .map_err(|err| format!("Cannot move item to system trash: {err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path).map_err(|err| format!("Cannot move item to system trash: {err}"))
    }
}

fn git_tracked_paths(vault: &Path) -> HashSet<String> {
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(vault)
        .no_window()
        .output();
    let Ok(output) = output else {
        return HashSet::new();
    };
    if !output.status.success() {
        return HashSet::new();
    }
    String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.replace('\\', "/"))
        .collect()
}

fn is_binary_file(path: &Path) -> bool {
    if let Some(ext) = path.extension().and_then(|value| value.to_str()) {
        let lower = ext.to_ascii_lowercase();
        if KNOWN_BINARY_EXTENSIONS.iter().any(|item| *item == lower) {
            return true;
        }
    }
    let Ok(mut file) = fs::File::open(path) else {
        return false;
    };
    let mut buf = vec![0; BINARY_SAMPLE_BYTES];
    let Ok(read) = file.read(&mut buf) else {
        return false;
    };
    let sample = &buf[..read];
    sample.contains(&0) || std::str::from_utf8(sample).is_err()
}

pub(crate) fn resolve_target_dir(vault: &Path, target_dir: &str) -> Result<PathBuf, String> {
    let trimmed = target_dir.trim();
    let raw = if trimmed.is_empty() {
        PathBuf::from(".")
    } else {
        PathBuf::from(trimmed)
    };
    let candidate = if raw.is_absolute() {
        raw
    } else {
        vault.join(raw)
    };
    let normalized = lexical_normalize(&candidate);
    let resolved = if normalized.starts_with(vault) {
        normalized
    } else {
        resolve_through_existing_ancestor(&normalized)
            .filter(|path| path.starts_with(vault))
            .ok_or_else(|| "Target directory escapes the selected workspace".to_string())?
    };
    let canonical_target = resolve_through_existing_ancestor(&resolved)
        .ok_or_else(|| "Target directory escapes the selected workspace".to_string())?;
    if canonical_target.starts_with(vault) {
        Ok(resolved)
    } else {
        Err("Target directory escapes the selected workspace".to_string())
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::ParentDir => {
                if !out.pop() {
                    out.push("..");
                }
            }
            Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn resolve_through_existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut ancestor = path.to_path_buf();
    let mut suffix = PathBuf::new();
    while !ancestor.exists() {
        let name = ancestor.file_name()?.to_os_string();
        suffix = PathBuf::from(name).join(suffix);
        if !ancestor.pop() {
            return None;
        }
    }
    let canonical = ancestor.canonicalize().ok()?;
    Some(lexical_normalize(&canonical.join(suffix)))
}

pub(crate) fn unique_path(candidate: PathBuf) -> PathBuf {
    // symlink-aware existence: exists() follows links, so a broken symlink at
    // the candidate name would be silently overwritten.
    if !path_entry_exists(&candidate) {
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
    for index in 1.. {
        let suffix = if index == 1 {
            "copy".to_string()
        } else {
            format!("copy-{index}")
        };
        let file_name = match extension {
            Some(ext) if !ext.is_empty() => format!("{stem}-{suffix}.{ext}"),
            _ => format!("{stem}-{suffix}"),
        };
        let next = parent.join(file_name);
        if !path_entry_exists(&next) {
            return next;
        }
    }
    unreachable!()
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(root: &Path, rel: &str, content: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scanner_excludes_git_generated_hidden_and_maruignored_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "keep.md", b"# Keep\n");
        write_file(root, ".git/config", b"private");
        write_file(root, "node_modules/pkg/readme.md", b"# Dep\n");
        write_file(root, ".maru/cache/file.json", b"{}");
        write_file(root, ".maruignore", b"ignored\n");
        write_file(root, "ignored/file.txt", b"ignore me");

        let entries = scan_workspace_files_at(root, &ScanFilter::default()).unwrap();
        let rels: Vec<&str> = entries
            .iter()
            .map(|entry| entry.rel_path.as_str())
            .collect();
        assert_eq!(rels, vec!["keep.md"]);
    }

    #[test]
    fn scanner_includes_dot_folder_only_when_allowlisted() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "keep.md", b"# Keep\n");
        write_file(tmp.path(), ".github/workflows/ci.yml", b"name: ci\n");

        let default_entries = scan_workspace_files_at(tmp.path(), &ScanFilter::default()).unwrap();
        assert_eq!(
            default_entries
                .iter()
                .map(|entry| entry.rel_path.as_str())
                .collect::<Vec<_>>(),
            vec!["keep.md"]
        );

        let filter = ScanFilter::from_options(Some(ScanOptions {
            include_dot_folders: vec![".github".to_string()],
        }))
        .unwrap();
        let allowlisted = scan_workspace_files_at(tmp.path(), &filter).unwrap();
        assert!(allowlisted
            .iter()
            .any(|entry| entry.rel_path == ".github/workflows/ci.yml"));
    }

    #[test]
    fn scanner_marks_binary_without_reading_large_files_fully() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "report.pdf", b"%PDF-1.7\ntext");
        write_file(tmp.path(), "raw.bin", b"a\0b");
        write_file(tmp.path(), "note.txt", b"plain text");

        let entries = scan_workspace_files_at(tmp.path(), &ScanFilter::default()).unwrap();
        let binary: Vec<&str> = entries
            .iter()
            .filter(|entry| entry.binary)
            .map(|entry| entry.rel_path.as_str())
            .collect();
        assert_eq!(binary, vec!["raw.bin", "report.pdf"]);
    }

    #[test]
    fn entry_scanner_keeps_empty_directories_as_first_class_nodes() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("assets/empty")).unwrap();
        write_file(tmp.path(), "assets/logo.png", b"\x89PNG\r\n");

        let snapshot = scan_workspace_entries_at(tmp.path(), &ScanFilter::default()).unwrap();
        let empty = snapshot
            .entries
            .iter()
            .find(|entry| entry.rel_path == "assets/empty")
            .unwrap();

        assert_eq!(empty.kind, WorkspaceEntryKind::Directory);
        assert_eq!(empty.parent_rel_path, "assets");
        assert_eq!(empty.size_bytes, 0);
    }

    #[cfg(unix)]
    #[test]
    fn entry_scanner_reports_symlink_and_target_kind() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("real")).unwrap();
        std::os::unix::fs::symlink("real", tmp.path().join("linked")).unwrap();

        let snapshot = scan_workspace_entries_at(tmp.path(), &ScanFilter::default()).unwrap();
        let linked = snapshot
            .entries
            .iter()
            .find(|entry| entry.rel_path == "linked")
            .unwrap();

        assert_eq!(linked.kind, WorkspaceEntryKind::Symlink);
        assert_eq!(
            linked.target_kind,
            Some(WorkspaceEntryTargetKind::Directory)
        );
    }

    #[test]
    fn file_manager_create_rename_duplicate_and_paste_are_collision_safe() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_string_lossy().to_string();
        write_file(tmp.path(), "source.txt", b"source");

        create_workspace_directory(vault.clone(), vault.clone(), "folder".to_string()).unwrap();
        rename_workspace_entry(
            vault.clone(),
            tmp.path().join("folder").to_string_lossy().to_string(),
            "renamed".to_string(),
        )
        .unwrap();
        let duplicates =
            duplicate_workspace_entries(vault.clone(), vec!["source.txt".to_string()]).unwrap();
        let pasted = paste_workspace_entries(
            vault,
            vec!["source.txt".to_string()],
            "renamed".to_string(),
            FileQueueOperation::Copy,
        )
        .unwrap();

        assert_eq!(duplicates[0].status, WorkspaceMutationStatus::Done);
        assert_eq!(
            fs::read(tmp.path().join("source-copy.txt")).unwrap(),
            b"source"
        );
        assert_eq!(pasted[0].status, WorkspaceMutationStatus::Done);
        assert_eq!(
            fs::read(tmp.path().join("renamed/source.txt")).unwrap(),
            b"source"
        );
        assert!(!tmp.path().join("folder").exists());
    }

    #[test]
    fn rename_supports_case_only_changes() {
        let tmp = TempDir::new().unwrap();
        let vault = tmp.path().to_string_lossy().to_string();
        write_file(tmp.path(), "notes.txt", b"case");

        let outcome = rename_workspace_entry(
            vault,
            tmp.path().join("notes.txt").to_string_lossy().to_string(),
            "Notes.txt".to_string(),
        )
        .unwrap();

        assert_eq!(outcome.status, WorkspaceMutationStatus::Done);
        let name = fs::read_dir(tmp.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .find(|name| name.eq_ignore_ascii_case("notes.txt"))
            .unwrap();
        assert_eq!(name, "Notes.txt");
    }

    #[test]
    fn entry_scan_recovers_an_interrupted_rename_transaction() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let source = root.join("before.txt");
        let target = root.join("after.txt");
        write_file(&root, "before.txt", b"recover");
        let journal_dir = transaction_dir(&root);
        fs::create_dir_all(&journal_dir).unwrap();
        fs::write(
            journal_dir.join("interrupted.json"),
            serde_json::to_vec(&RenameTransaction {
                source_path: source.to_string_lossy().to_string(),
                target_path: target.to_string_lossy().to_string(),
            })
            .unwrap(),
        )
        .unwrap();

        let snapshot = scan_workspace_entries(root.to_string_lossy().to_string(), None).unwrap();

        assert!(!source.exists());
        assert_eq!(fs::read(&target).unwrap(), b"recover");
        assert!(snapshot
            .entries
            .iter()
            .any(|entry| entry.rel_path == "after.txt"));
        assert!(!journal_dir.exists());
    }

    #[test]
    fn git_tracked_filter_metadata_falls_back_outside_repo() {
        let tmp = TempDir::new().unwrap();
        write_file(tmp.path(), "note.md", b"# Note\n");
        let entries = scan_workspace_files_at(tmp.path(), &ScanFilter::default()).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(!entries[0].git_tracked);
    }

    #[test]
    fn queue_rejects_target_traversal() {
        let tmp = TempDir::new().unwrap();
        let err = resolve_target_dir(tmp.path(), "../outside").unwrap_err();
        assert!(err.contains("escapes"));
    }

    #[cfg(unix)]
    #[test]
    fn queue_rejects_target_symlink_to_outside_workspace() {
        let workspace = TempDir::new().unwrap();
        let outside = TempDir::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), workspace.path().join("external")).unwrap();

        let err = resolve_target_dir(workspace.path(), "external/drop").unwrap_err();
        assert!(err.contains("escapes"));
    }

    #[test]
    fn queue_copy_uses_unique_target_name() {
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        write_file(source_dir.path(), "drop.pdf", b"new");
        write_file(target_dir.path(), "drop.pdf", b"old");

        let item = FileQueueApplyItem {
            id: "1".to_string(),
            source_path: source_dir
                .path()
                .join("drop.pdf")
                .to_string_lossy()
                .to_string(),
            target_dir: target_dir.path().to_string_lossy().to_string(),
            operation: FileQueueOperation::Copy,
            source_kind: FileQueueSourceKind::File,
        };
        let outcomes =
            apply_file_queue(target_dir.path().to_string_lossy().to_string(), vec![item]).unwrap();

        assert_eq!(outcomes[0].file_name, "drop-copy.pdf");
    }

    #[test]
    fn queue_copies_directory_recursively_with_unique_name() {
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        write_file(source_dir.path(), "bundle/a.txt", b"a");
        write_file(source_dir.path(), "bundle/nested/b.txt", b"b");
        fs::create_dir_all(target_dir.path().join("bundle")).unwrap();

        let item = FileQueueApplyItem {
            id: "dir".to_string(),
            source_path: source_dir
                .path()
                .join("bundle")
                .to_string_lossy()
                .to_string(),
            target_dir: target_dir.path().to_string_lossy().to_string(),
            operation: FileQueueOperation::Copy,
            source_kind: FileQueueSourceKind::Directory,
        };
        let outcomes =
            apply_file_queue(target_dir.path().to_string_lossy().to_string(), vec![item]).unwrap();

        assert_eq!(outcomes[0].file_name, "bundle-copy");
        assert_eq!(
            fs::read(target_dir.path().join("bundle-copy/nested/b.txt")).unwrap(),
            b"b"
        );
    }

    #[test]
    fn queue_rejects_directory_target_inside_source() {
        let workspace = TempDir::new().unwrap();
        write_file(workspace.path(), "source/a.txt", b"a");

        let item = FileQueueApplyItem {
            id: "dir".to_string(),
            source_path: workspace
                .path()
                .join("source")
                .to_string_lossy()
                .to_string(),
            target_dir: workspace
                .path()
                .join("source/nested")
                .to_string_lossy()
                .to_string(),
            operation: FileQueueOperation::Copy,
            source_kind: FileQueueSourceKind::Directory,
        };
        let err = apply_file_queue(workspace.path().to_string_lossy().to_string(), vec![item])
            .unwrap_err();
        assert!(err.contains("inside the source"));
    }

    #[test]
    fn queue_moves_directory() {
        let source_dir = TempDir::new().unwrap();
        let target_dir = TempDir::new().unwrap();
        write_file(source_dir.path(), "bundle/a.txt", b"a");
        let source = source_dir.path().join("bundle");

        let item = FileQueueApplyItem {
            id: "dir".to_string(),
            source_path: source.to_string_lossy().to_string(),
            target_dir: target_dir.path().to_string_lossy().to_string(),
            operation: FileQueueOperation::Move,
            source_kind: FileQueueSourceKind::Directory,
        };
        let outcomes =
            apply_file_queue(target_dir.path().to_string_lossy().to_string(), vec![item]).unwrap();

        assert_eq!(outcomes[0].file_name, "bundle");
        assert!(!source.exists());
        assert_eq!(
            fs::read(target_dir.path().join("bundle/a.txt")).unwrap(),
            b"a"
        );
    }
}
