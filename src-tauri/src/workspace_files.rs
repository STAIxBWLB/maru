use crate::vault::{
    load_anchorignore, matches_anchorignore, normalize_existing_dir, ScanFilter, ScanOptions,
};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::io::Read;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
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
        assert_anchor_can_write(&vault.to_string_lossy(), action)?;
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
    let ignore_patterns = load_anchorignore(vault);
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
            !matches_anchorignore(rel, &ignore_patterns)
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

fn git_tracked_paths(vault: &Path) -> HashSet<String> {
    let output = Command::new("git")
        .args(["ls-files", "-z"])
        .current_dir(vault)
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
        if !next.exists() {
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
    fn scanner_excludes_git_generated_hidden_and_anchorignored_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_file(root, "keep.md", b"# Keep\n");
        write_file(root, ".git/config", b"private");
        write_file(root, "node_modules/pkg/readme.md", b"# Dep\n");
        write_file(root, ".anchor/cache/file.json", b"{}");
        write_file(root, ".anchorignore", b"ignored\n");
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
