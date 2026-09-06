//! Diagram-mode workspace commands.
//!
//! Diagrams live at `<workspace>/diagrams/<name>.cmd.json`. Name validation
//! rejects path traversal (`..`, `/`, `\\`, NUL) and leading-dot entries, mirroring
//! the safety rules in `studio/mod.rs` and the workspace write-allow guard.
//!
use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::vault::{lexical_normalize, resolve_inside_vault};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const DIAGRAMS_DIR: &str = "diagrams";
const DIAGRAM_EXT: &str = ".cmd.json";
const TITLE_PROBE_BYTES: usize = 1024;
const MAX_NAME_LEN: usize = 160;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DiagramFile {
    pub name: String,
    pub size: u64,
    pub modified_at: i64,
    pub doc_title: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotMeta {
    pub doc_id: String,
    pub snapshot_ts: String,
    pub size: u64,
}

fn diagrams_root(work_path: &str) -> Result<PathBuf, String> {
    resolve_inside_vault(work_path, DIAGRAMS_DIR)
}

fn validate_name(name: &str) -> Result<&str, String> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err("Diagram name is required".to_string());
    }
    if trimmed.len() > MAX_NAME_LEN {
        return Err(format!("Diagram name too long (max {MAX_NAME_LEN})"));
    }
    if trimmed.starts_with('.')
        || trimmed.contains("..")
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.chars().any(char::is_control)
    {
        return Err(format!("Invalid diagram name: {name}"));
    }
    Ok(trimmed)
}

/// Windows-safe ASCII path component (report assets are machine-generated).
fn is_ascii_component(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Diagram path escapes the diagrams folder".to_string());
    }
    Ok(())
}

fn diagram_file_path(work_path: &str, name: &str) -> Result<PathBuf, String> {
    let trimmed = validate_name(name)?;
    let root = diagrams_root(work_path)?;
    let candidate = root.join(format!("{trimmed}{DIAGRAM_EXT}"));
    ensure_within(&root, &candidate)?;
    Ok(candidate)
}

fn modified_unix_ms(meta: &fs::Metadata) -> i64 {
    let modified = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    match modified.duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(err) => -(err.duration().as_millis() as i64),
    }
}

fn extract_doc_title(file_path: &Path) -> String {
    let Ok(file) = fs::File::open(file_path) else {
        return String::new();
    };
    use std::io::Read;
    let mut probe = Vec::with_capacity(TITLE_PROBE_BYTES);
    let _ = file.take(TITLE_PROBE_BYTES as u64).read_to_end(&mut probe);
    let text = String::from_utf8_lossy(&probe);
    let Some(idx) = text.find("\"docTitle\"") else {
        return String::new();
    };
    let after = &text[idx + "\"docTitle\"".len()..];
    let Some(colon) = after.find(':') else {
        return String::new();
    };
    let Some(open) = after[colon..].find('"') else {
        return String::new();
    };
    let start = colon + open + 1;
    let rest = &after[start..];
    let Some(end) = rest.find('"') else {
        return String::new();
    };
    rest[..end].to_string()
}

pub fn diagram_save_document(workspace: String, name: String, body: String) -> Result<(), String> {
    let path = diagram_file_path(&workspace, &name)?;
    let root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_save_document_in_transaction(workspace, name, body, lease)
    })
}

fn diagram_save_document_in_transaction(
    workspace: String,
    name: String,
    body: String,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    lease.ensure_workspace_registry()?;
    let path = diagram_file_path(&workspace, &name)?;
    lease.ensure_covered(vec![path.clone()])?;
    let action = if path.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(&workspace, action)?;
    lease.before_effect()?;
    let payload = if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    write_atomic(&path, payload.as_bytes())?;
    Ok(())
}

pub fn diagram_load_document(workspace: String, name: String) -> Result<String, String> {
    let path = diagram_file_path(&workspace, &name)?;
    if !path.is_file() {
        return Err(format!("Diagram not found: {name}"));
    }
    fs::read_to_string(&path).map_err(|err| format!("Cannot read diagram: {err}"))
}

pub fn diagram_list_documents(workspace: String) -> Result<Vec<DiagramFile>, String> {
    let root = diagrams_root(&workspace)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<DiagramFile> = Vec::new();
    let read = fs::read_dir(&root).map_err(|err| format!("Cannot read diagrams: {err}"))?;
    for entry in read {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.ends_with(DIAGRAM_EXT) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = file_name
            .strip_suffix(DIAGRAM_EXT)
            .unwrap_or(file_name)
            .to_string();
        let doc_title = extract_doc_title(&path);
        out.push(DiagramFile {
            name,
            size: meta.len(),
            modified_at: modified_unix_ms(&meta),
            doc_title,
        });
    }
    out.sort_by_key(|d| std::cmp::Reverse(d.modified_at));
    Ok(out)
}

pub fn diagram_delete_document(workspace: String, name: String) -> Result<bool, String> {
    let path = diagram_file_path(&workspace, &name)?;
    let root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_delete_document_in_transaction(workspace, name, lease)
    })
}

fn diagram_delete_document_in_transaction(
    workspace: String,
    name: String,
    lease: &PathTransactionLease,
) -> Result<bool, String> {
    lease.ensure_workspace_registry()?;
    let path = diagram_file_path(&workspace, &name)?;
    lease.ensure_covered(vec![path.clone()])?;
    if !path.is_file() {
        return Ok(false);
    }
    assert_maru_can_write(&workspace, WorkspaceWriteAction::Delete)?;
    lease.before_effect()?;
    fs::remove_file(&path).map_err(|err| format!("Cannot delete diagram: {err}"))?;
    Ok(true)
}

fn validate_export_kind(kind: &str) -> Result<&'static str, String> {
    match kind {
        "png" => Ok("png"),
        "jpg" | "jpeg" => Ok("jpg"),
        "svg" => Ok("svg"),
        "json" => Ok("json"),
        "pdf" => Ok("pdf"),
        "mmd" | "mermaid" => Ok("mmd"),
        "csv" => Ok("csv"),
        "tsv" => Ok("tsv"),
        "md" | "markdown" => Ok("md"),
        "html" | "htm" => Ok("html"),
        _ => Err(format!("Unsupported export kind: {kind}")),
    }
}

fn validate_export_target_path(target_path: &str, kind: &str) -> Result<PathBuf, String> {
    let trimmed = target_path.trim();
    if trimmed.is_empty() {
        return Err("Export path is required".to_string());
    }
    if trimmed.contains('\0') {
        return Err("Invalid export path".to_string());
    }
    let expected = validate_export_kind(kind)?;
    let path = PathBuf::from(trimmed);
    if path.file_name().and_then(|name| name.to_str()).is_none() {
        return Err("Export path must include a file name".to_string());
    }
    if path.is_dir() {
        return Err("Export path points to a directory".to_string());
    }
    let ext = path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .ok_or_else(|| "Export path must include an extension".to_string())?;
    let ext_ok = match expected {
        "jpg" => ext == "jpg" || ext == "jpeg",
        "mmd" => ext == "mmd" || ext == "mermaid",
        "md" => ext == "md" || ext == "markdown",
        "html" => ext == "html" || ext == "htm",
        _ => ext == expected,
    };
    if !ext_ok {
        return Err(format!(
            "Export path extension .{ext} does not match {expected}"
        ));
    }
    Ok(path)
}

pub fn diagram_export_blob(
    workspace: String,
    name: String,
    kind: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let trimmed = validate_name(&name)?;
    let ext = validate_export_kind(&kind)?;
    let root = diagrams_root(&workspace)?;
    let candidate = root.join(format!("{trimmed}.{ext}"));
    ensure_within(&root, &candidate)?;
    let workspace_root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![candidate])?
        .require_parent(&workspace_root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_export_blob_in_transaction(workspace, name, kind, bytes, lease)
    })
}

fn diagram_export_blob_in_transaction(
    workspace: String,
    name: String,
    kind: String,
    bytes: Vec<u8>,
    lease: &PathTransactionLease,
) -> Result<String, String> {
    lease.ensure_workspace_registry()?;
    let trimmed = validate_name(&name)?;
    let ext = validate_export_kind(&kind)?;
    let root = diagrams_root(&workspace)?;
    let candidate = root.join(format!("{trimmed}.{ext}"));
    ensure_within(&root, &candidate)?;
    lease.ensure_covered(vec![candidate.clone()])?;
    let action = if candidate.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(&workspace, action)?;
    lease.before_effect()?;
    if let Some(parent) = candidate.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create diagrams folder: {err}"))?;
    }
    fs::write(&candidate, &bytes).map_err(|err| format!("Cannot write export: {err}"))?;
    Ok(candidate.to_string_lossy().to_string())
}

pub fn diagram_export_blob_to_path(
    target_path: String,
    kind: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let path = validate_export_target_path(&target_path, &kind)?;
    let request = PathTransactionRequest::new(vec![path])?;
    with_path_transactions(request, |lease| {
        diagram_export_blob_to_path_in_transaction(target_path, kind, bytes, lease)
    })
}

fn diagram_export_blob_to_path_in_transaction(
    target_path: String,
    kind: String,
    bytes: Vec<u8>,
    lease: &PathTransactionLease,
) -> Result<String, String> {
    let path = validate_export_target_path(&target_path, &kind)?;
    lease.ensure_covered(vec![path.clone()])?;
    lease.before_effect()?;
    if let Some(parent) = path.parent() {
        if !parent.as_os_str().is_empty() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Cannot create export folder: {err}"))?;
        }
    }
    fs::write(&path, &bytes).map_err(|err| format!("Cannot write export: {err}"))?;
    Ok(path.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// One-time v7 backup (Report Pattern Studio schema v8)
// ---------------------------------------------------------------------------

const BACKUP_DIR: &str = ".maru/diagrams/backups";

/// Copy `<workspace>/diagrams/<name>.cmd.json` to
/// `<workspace>/.maru/diagrams/backups/<name>-v7-<unix-ts>.cmd.json` before the
/// first v8 save overwrites a v7 document. The copy goes through a temp file +
/// rename so a crash mid-copy cannot leave a truncated backup.
pub fn diagram_backup_document(workspace: String, name: String) -> Result<String, String> {
    let trimmed = validate_name(&name)?;
    let src = diagram_file_path(&workspace, trimmed)?;
    if !src.is_file() {
        return Err(format!("Diagram not found: {trimmed}"));
    }
    let root = resolve_inside_vault(&workspace, BACKUP_DIR)?;
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|err| format!("System clock error: {err}"))?
        .as_millis();
    let dest = root.join(format!("{trimmed}-v7-{ts}{DIAGRAM_EXT}"));
    ensure_within(&root, &dest)?;
    let tmp = root.join(format!(".{trimmed}-v7-{ts}.tmp"));
    ensure_within(&root, &tmp)?;
    let workspace_root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![src.clone(), dest.clone(), tmp.clone()])?
        .require_parent(&workspace_root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_backup_document_in_transaction(workspace, name, ts, lease)
    })
}

fn diagram_backup_document_in_transaction(
    workspace: String,
    name: String,
    ts: u128,
    lease: &PathTransactionLease,
) -> Result<String, String> {
    lease.ensure_workspace_registry()?;
    let trimmed = validate_name(&name)?;
    let src = diagram_file_path(&workspace, trimmed)?;
    if !src.is_file() {
        return Err(format!("Diagram not found: {trimmed}"));
    }
    lease.ensure_covered(vec![src.clone()])?;
    assert_maru_can_write(&workspace, WorkspaceWriteAction::Create)?;
    let root = resolve_inside_vault(&workspace, BACKUP_DIR)?;
    let dest = root.join(format!("{trimmed}-v7-{ts}{DIAGRAM_EXT}"));
    ensure_within(&root, &dest)?;
    let tmp = root.join(format!(".{trimmed}-v7-{ts}.tmp"));
    ensure_within(&root, &tmp)?;
    lease.ensure_covered(vec![dest.clone(), tmp.clone()])?;
    lease.before_effect()?;
    fs::create_dir_all(&root).map_err(|err| format!("Cannot create backup folder: {err}"))?;
    fs::copy(&src, &tmp).map_err(|err| format!("Cannot copy diagram for backup: {err}"))?;
    fs::rename(&tmp, &dest).map_err(|err| format!("Cannot finalize backup: {err}"))?;
    Ok(dest.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// Version-history snapshots
// ---------------------------------------------------------------------------

const SNAPSHOT_DIR: &str = ".maru/diagrams/history";
const SNAPSHOT_CAP: usize = 20;

fn validate_doc_id(doc_id: &str) -> Result<&str, String> {
    validate_name(doc_id)
}

fn validate_snapshot_ts(ts: &str) -> Result<&str, String> {
    if ts.trim().is_empty() {
        return Err("snapshot ts is required".to_string());
    }
    if ts.contains("..") || ts.contains('/') || ts.contains('\\') || ts.contains('\0') {
        return Err(format!("Invalid snapshot ts: {ts}"));
    }
    Ok(ts)
}

fn snapshot_dir(workspace: &str, doc_id: &str) -> Result<PathBuf, String> {
    let id = validate_doc_id(doc_id)?;
    let root = resolve_inside_vault(workspace, SNAPSHOT_DIR)?;
    let dir = root.join(id);
    ensure_within(&root, &dir)?;
    Ok(dir)
}

fn snapshot_file(workspace: &str, doc_id: &str, ts: &str) -> Result<PathBuf, String> {
    let ts = validate_snapshot_ts(ts)?;
    let dir = snapshot_dir(workspace, doc_id)?;
    let candidate = dir.join(format!("snapshot-{ts}.json"));
    ensure_within(&dir, &candidate)?;
    Ok(candidate)
}

pub fn diagram_save_snapshot(
    workspace: String,
    doc_id: String,
    snapshot_ts: String,
    content: String,
) -> Result<SnapshotMeta, String> {
    let dir = snapshot_dir(&workspace, &doc_id)?;
    let path = snapshot_file(&workspace, &doc_id, &snapshot_ts)?;
    let root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![dir, path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_save_snapshot_in_transaction(workspace, doc_id, snapshot_ts, content, lease)
    })
}

#[allow(clippy::too_many_arguments)]
fn diagram_save_snapshot_in_transaction(
    workspace: String,
    doc_id: String,
    snapshot_ts: String,
    content: String,
    lease: &PathTransactionLease,
) -> Result<SnapshotMeta, String> {
    lease.ensure_workspace_registry()?;
    let dir = snapshot_dir(&workspace, &doc_id)?;
    let path = snapshot_file(&workspace, &doc_id, &snapshot_ts)?;
    lease.ensure_covered(vec![dir.clone(), path.clone()])?;
    assert_maru_can_write(
        &workspace,
        if path.is_file() {
            WorkspaceWriteAction::Modify
        } else {
            WorkspaceWriteAction::Create
        },
    )?;
    lease.before_effect()?;
    fs::create_dir_all(&dir).map_err(|err| format!("Cannot create snapshot dir: {err}"))?;
    let body = if content.ends_with('\n') {
        content
    } else {
        format!("{content}\n")
    };
    fs::write(&path, &body).map_err(|err| format!("Cannot write snapshot: {err}"))?;
    let size = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);

    prune_snapshots(&dir, SNAPSHOT_CAP)?;

    Ok(SnapshotMeta {
        doc_id,
        snapshot_ts,
        size,
    })
}

fn prune_snapshots(dir: &Path, cap: usize) -> Result<(), String> {
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = Vec::new();
    let read = match fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return Ok(()),
    };
    for entry in read {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !(name.starts_with("snapshot-") && name.ends_with(".json")) {
            continue;
        }
        let mtime = entry
            .metadata()
            .and_then(|m| m.modified())
            .unwrap_or(std::time::UNIX_EPOCH);
        entries.push((path, mtime));
    }
    if entries.len() <= cap {
        return Ok(());
    }
    entries.sort_by_key(|a| a.1);
    for (path, _) in entries.iter().take(entries.len() - cap) {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

pub fn diagram_list_snapshots(
    workspace: String,
    doc_id: String,
) -> Result<Vec<SnapshotMeta>, String> {
    let dir = snapshot_dir(&workspace, &doc_id)?;
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<SnapshotMeta> = Vec::new();
    let read = fs::read_dir(&dir).map_err(|err| format!("Cannot read snapshots: {err}"))?;
    for entry in read {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        let Some(stripped) = name
            .strip_prefix("snapshot-")
            .and_then(|s| s.strip_suffix(".json"))
        else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        out.push(SnapshotMeta {
            doc_id: doc_id.clone(),
            snapshot_ts: stripped.to_string(),
            size: meta.len(),
        });
    }
    out.sort_by(|a, b| b.snapshot_ts.cmp(&a.snapshot_ts));
    Ok(out)
}

pub fn diagram_restore_snapshot(
    workspace: String,
    doc_id: String,
    snapshot_ts: String,
) -> Result<String, String> {
    let path = snapshot_file(&workspace, &doc_id, &snapshot_ts)?;
    if !path.is_file() {
        return Err(format!("snapshot not found: {snapshot_ts}"));
    }
    fs::read_to_string(&path).map_err(|err| format!("Cannot read snapshot: {err}"))
}

// ---------------------------------------------------------------------------
// Report assets (Insert/Update in report)
// ---------------------------------------------------------------------------

/// Managed-block image payloads live under
/// `<workspace>/attachments/diagrams/<doc_id>/<file_name>` — the only write
/// target outside `diagrams/` and `.maru/` that Diagram mode is allowed to
/// touch. Hash-named files make re-renders idempotent.
const REPORT_ASSET_ROOT: &str = "attachments/diagrams";

fn validate_report_file_name(file_name: &str) -> Result<&str, String> {
    let trimmed = validate_name(file_name)?;
    // Asset names are machine-generated (`<scope>-<hash8>.<ext>`), so a strict
    // ASCII allowlist is safe — and required for Windows, where ':' switches
    // to an NTFS alternate data stream.
    if !is_ascii_component(trimmed) {
        return Err(format!("Invalid report asset name: {file_name}"));
    }
    let Some((stem, ext)) = trimmed.rsplit_once('.') else {
        return Err(format!(
            "Report asset name must include an extension: {file_name}"
        ));
    };
    if stem.is_empty() {
        return Err(format!("Invalid report asset name: {file_name}"));
    }
    if !matches!(ext, "svg" | "png" | "json") {
        return Err(format!("Unsupported report asset extension: {ext}"));
    }
    Ok(trimmed)
}

/// Write a rendered report asset (SVG/PNG/JSON) for a managed Markdown block.
/// Returns the workspace-relative path (`attachments/diagrams/<doc_id>/<file_name>`).
pub fn diagram_write_report_asset(
    workspace: String,
    doc_id: String,
    file_name: String,
    bytes: Vec<u8>,
) -> Result<String, String> {
    let id = validate_doc_id(&doc_id)?;
    if !is_ascii_component(id) {
        return Err(format!("Invalid report asset doc id: {doc_id}"));
    }
    let name = validate_report_file_name(&file_name)?;
    let root = resolve_inside_vault(&workspace, REPORT_ASSET_ROOT)?;
    let dir = root.join(id);
    ensure_within(&root, &dir)?;
    let candidate = dir.join(name);
    ensure_within(&dir, &candidate)?;
    let workspace_root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![candidate])?
        .require_parent(&workspace_root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_write_report_asset_in_transaction(workspace, doc_id, file_name, bytes, lease)
    })
}

fn diagram_write_report_asset_in_transaction(
    workspace: String,
    doc_id: String,
    file_name: String,
    bytes: Vec<u8>,
    lease: &PathTransactionLease,
) -> Result<String, String> {
    lease.ensure_workspace_registry()?;
    let id = validate_doc_id(&doc_id)?;
    if !is_ascii_component(id) {
        return Err(format!("Invalid report asset doc id: {doc_id}"));
    }
    let name = validate_report_file_name(&file_name)?;
    let root = resolve_inside_vault(&workspace, REPORT_ASSET_ROOT)?;
    let dir = root.join(id);
    ensure_within(&root, &dir)?;
    let candidate = dir.join(name);
    ensure_within(&dir, &candidate)?;
    lease.ensure_covered(vec![candidate.clone()])?;
    let action = if candidate.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(&workspace, action)?;
    lease.before_effect()?;
    write_atomic(&candidate, &bytes)?;
    Ok(format!("{REPORT_ASSET_ROOT}/{id}/{name}"))
}

// ---------------------------------------------------------------------------
// Pattern presets (Report Pattern Studio)
// ---------------------------------------------------------------------------

const PATTERN_DIR: &str = ".maru/diagram-patterns";
const PATTERN_EXT: &str = ".pattern.json";

fn pattern_file_path(work_path: &str, name: &str) -> Result<PathBuf, String> {
    let trimmed = validate_name(name)?;
    let root = resolve_inside_vault(work_path, PATTERN_DIR)?;
    let candidate = root.join(format!("{trimmed}{PATTERN_EXT}"));
    ensure_within(&root, &candidate)?;
    Ok(candidate)
}

pub fn diagram_pattern_save(workspace: String, name: String, body: String) -> Result<(), String> {
    let path = pattern_file_path(&workspace, &name)?;
    let root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_pattern_save_in_transaction(workspace, name, body, lease)
    })
}

fn diagram_pattern_save_in_transaction(
    workspace: String,
    name: String,
    body: String,
    lease: &PathTransactionLease,
) -> Result<(), String> {
    lease.ensure_workspace_registry()?;
    let path = pattern_file_path(&workspace, &name)?;
    lease.ensure_covered(vec![path.clone()])?;
    let action = if path.is_file() {
        WorkspaceWriteAction::Modify
    } else {
        WorkspaceWriteAction::Create
    };
    assert_maru_can_write(&workspace, action)?;
    lease.before_effect()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create pattern folder: {err}"))?;
    }
    let payload = if body.ends_with('\n') {
        body
    } else {
        format!("{body}\n")
    };
    write_atomic(&path, payload.as_bytes())?;
    Ok(())
}

pub fn diagram_pattern_list(workspace: String) -> Result<Vec<DiagramFile>, String> {
    let root = resolve_inside_vault(&workspace, PATTERN_DIR)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut out: Vec<DiagramFile> = Vec::new();
    let read = fs::read_dir(&root).map_err(|err| format!("Cannot read pattern presets: {err}"))?;
    for entry in read {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !file_name.ends_with(PATTERN_EXT) {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let name = file_name
            .strip_suffix(PATTERN_EXT)
            .unwrap_or(file_name)
            .to_string();
        let doc_title = extract_doc_title(&path);
        out.push(DiagramFile {
            name,
            size: meta.len(),
            modified_at: modified_unix_ms(&meta),
            doc_title,
        });
    }
    out.sort_by_key(|d| std::cmp::Reverse(d.modified_at));
    Ok(out)
}

pub fn diagram_pattern_delete(workspace: String, name: String) -> Result<bool, String> {
    let path = pattern_file_path(&workspace, &name)?;
    let root = resolve_inside_vault(&workspace, ".")?;
    let request = PathTransactionRequest::new(vec![path])?
        .require_parent(&root)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        diagram_pattern_delete_in_transaction(workspace, name, lease)
    })
}

fn diagram_pattern_delete_in_transaction(
    workspace: String,
    name: String,
    lease: &PathTransactionLease,
) -> Result<bool, String> {
    lease.ensure_workspace_registry()?;
    let path = pattern_file_path(&workspace, &name)?;
    lease.ensure_covered(vec![path.clone()])?;
    if !path.is_file() {
        return Ok(false);
    }
    assert_maru_can_write(&workspace, WorkspaceWriteAction::Delete)?;
    lease.before_effect()?;
    fs::remove_file(&path).map_err(|err| format!("Cannot delete pattern preset: {err}"))?;
    Ok(true)
}

/// Owned IPC boundaries; synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn diagram_save_document(
        workspace: String,
        name: String,
        body: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_save_document",
            );
            super::diagram_save_document(workspace, name, body)
        })
        .await
        .map_err(|err| format!("diagram_save_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_load_document(workspace: String, name: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_load_document",
            );
            super::diagram_load_document(workspace, name)
        })
        .await
        .map_err(|err| format!("diagram_load_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_list_documents(workspace: String) -> Result<Vec<DiagramFile>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_list_documents",
            );
            super::diagram_list_documents(workspace)
        })
        .await
        .map_err(|err| format!("diagram_list_documents_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_delete_document(workspace: String, name: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_delete_document",
            );
            super::diagram_delete_document(workspace, name)
        })
        .await
        .map_err(|err| format!("diagram_delete_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_export_blob(
        workspace: String,
        name: String,
        kind: String,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_export_blob",
            );
            super::diagram_export_blob(workspace, name, kind, bytes)
        })
        .await
        .map_err(|err| format!("diagram_export_blob_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_export_blob_to_path(
        target_path: String,
        kind: String,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&target_path)],
                "worker:diagram_export_blob_to_path",
            );
            super::diagram_export_blob_to_path(target_path, kind, bytes)
        })
        .await
        .map_err(|err| format!("diagram_export_blob_to_path_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_backup_document(
        workspace: String,
        name: String,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_backup_document",
            );
            super::diagram_backup_document(workspace, name)
        })
        .await
        .map_err(|err| format!("diagram_backup_document_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_save_snapshot(
        workspace: String,
        doc_id: String,
        snapshot_ts: String,
        content: String,
    ) -> Result<SnapshotMeta, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_save_snapshot",
            );
            super::diagram_save_snapshot(workspace, doc_id, snapshot_ts, content)
        })
        .await
        .map_err(|err| format!("diagram_save_snapshot_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_list_snapshots(
        workspace: String,
        doc_id: String,
    ) -> Result<Vec<SnapshotMeta>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_list_snapshots",
            );
            super::diagram_list_snapshots(workspace, doc_id)
        })
        .await
        .map_err(|err| format!("diagram_list_snapshots_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_restore_snapshot(
        workspace: String,
        doc_id: String,
        snapshot_ts: String,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_restore_snapshot",
            );
            super::diagram_restore_snapshot(workspace, doc_id, snapshot_ts)
        })
        .await
        .map_err(|err| format!("diagram_restore_snapshot_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_write_report_asset(
        workspace: String,
        doc_id: String,
        file_name: String,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_write_report_asset",
            );
            super::diagram_write_report_asset(workspace, doc_id, file_name, bytes)
        })
        .await
        .map_err(|err| format!("diagram_write_report_asset_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_pattern_save(
        workspace: String,
        name: String,
        body: String,
    ) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_pattern_save",
            );
            super::diagram_pattern_save(workspace, name, body)
        })
        .await
        .map_err(|err| format!("diagram_pattern_save_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_pattern_list(workspace: String) -> Result<Vec<DiagramFile>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_pattern_list",
            );
            super::diagram_pattern_list(workspace)
        })
        .await
        .map_err(|err| format!("diagram_pattern_list_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn diagram_pattern_delete(workspace: String, name: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&workspace)],
                "worker:diagram_pattern_delete",
            );
            super::diagram_pattern_delete(workspace, name)
        })
        .await
        .map_err(|err| format!("diagram_pattern_delete_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::thread::sleep;
    use std::time::Duration;
    use tempfile::TempDir;

    fn setup_workspace() -> (TempDir, String) {
        let tmp = TempDir::new().expect("tempdir");
        let work = tmp.path().to_string_lossy().to_string();
        // create .maru folder so resolve_inside_vault treats it as a workspace
        fs::create_dir_all(tmp.path().join(".maru")).expect("maru dir");
        (tmp, work)
    }

    #[test]
    fn export_kind_whitelist_includes_tabular_codecs() {
        assert_eq!(validate_export_kind("csv").unwrap(), "csv");
        assert_eq!(validate_export_kind("tsv").unwrap(), "tsv");
        assert_eq!(validate_export_kind("md").unwrap(), "md");
        assert_eq!(validate_export_kind("markdown").unwrap(), "md");
        assert_eq!(validate_export_kind("html").unwrap(), "html");
        assert_eq!(validate_export_kind("htm").unwrap(), "html");
        assert!(validate_export_kind("xlsx").is_err());
    }

    #[test]
    fn export_target_path_matches_tabular_extensions() {
        assert!(validate_export_target_path("/tmp/out/report.csv", "csv").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.tsv", "tsv").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.md", "md").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.markdown", "md").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.html", "html").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.htm", "html").is_ok());
        assert!(validate_export_target_path("/tmp/out/report.csv", "tsv").is_err());
        assert!(validate_export_target_path("/tmp/out/report.txt", "md").is_err());
        assert!(validate_export_target_path("/tmp/out/report.png", "html").is_err());
    }

    #[test]
    fn validate_name_rejects_traversal() {
        assert!(validate_name("../bad").is_err());
        assert!(validate_name("..").is_err());
        assert!(validate_name("a/b").is_err());
        assert!(validate_name("a\\b").is_err());
        assert!(validate_name(".hidden").is_err());
        assert!(validate_name("").is_err());
        assert!(validate_name("with\0nul").is_err());
        assert!(validate_name("My Diagram 1").is_ok());
        assert!(validate_name("주가지표").is_ok());
    }

    #[test]
    fn save_load_round_trips() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":7,"docTitle":"hello","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "demo".into(), body.into()).unwrap();
        let loaded = diagram_load_document(work, "demo".into()).unwrap();
        assert!(loaded.contains("\"v\":7"));
        assert!(loaded.contains("hello"));
    }

    #[test]
    fn list_sorts_by_mtime_descending() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":7,"docTitle":"a","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "first".into(), body.into()).unwrap();
        sleep(Duration::from_millis(15));
        let body2 = r#"{"v":7,"docTitle":"b","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "second".into(), body2.into()).unwrap();
        let listed = diagram_list_documents(work).unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].name, "second");
        assert_eq!(listed[0].doc_title, "b");
        assert_eq!(listed[1].name, "first");
        assert_eq!(listed[1].doc_title, "a");
    }

    #[test]
    fn delete_returns_false_when_missing() {
        let (_tmp, work) = setup_workspace();
        assert_eq!(
            diagram_delete_document(work, "ghost".into()).unwrap(),
            false
        );
    }

    #[test]
    fn delete_removes_existing() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":7,"docTitle":"x","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "x".into(), body.into()).unwrap();
        assert!(diagram_delete_document(work.clone(), "x".into()).unwrap());
        let listed = diagram_list_documents(work).unwrap();
        assert!(listed.is_empty());
    }

    #[test]
    fn save_rejects_bad_name() {
        let (_tmp, work) = setup_workspace();
        assert!(diagram_save_document(work, "../escape".into(), "{}".into()).is_err());
    }

    #[test]
    fn list_skips_non_cmd_files() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":7,"docTitle":"keep","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "keep".into(), body.into()).unwrap();
        // stray file in diagrams/
        let path = PathBuf::from(&work).join(DIAGRAMS_DIR).join("stray.txt");
        fs::write(&path, "noise").unwrap();
        let listed = diagram_list_documents(work).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "keep");
    }

    #[test]
    fn export_blob_writes_png_file() {
        let (_tmp, work) = setup_workspace();
        let path = diagram_export_blob(
            work,
            "demo".into(),
            "png".into(),
            vec![0x89, 0x50, 0x4e, 0x47],
        )
        .unwrap();
        assert!(path.ends_with("/diagrams/demo.png") || path.contains("\\diagrams\\demo.png"));
        let bytes = fs::read(&path).unwrap();
        assert_eq!(&bytes, &[0x89, 0x50, 0x4e, 0x47]);
    }

    #[test]
    fn export_blob_rejects_unknown_kind() {
        let (_tmp, work) = setup_workspace();
        assert!(diagram_export_blob(work, "demo".into(), "exe".into(), vec![]).is_err());
    }

    #[test]
    fn export_blob_to_selected_path_writes_file() {
        let (tmp, _work) = setup_workspace();
        let target = tmp.path().join("chosen").join("demo.svg");
        let path = diagram_export_blob_to_path(
            target.to_string_lossy().to_string(),
            "svg".into(),
            b"<svg/>".to_vec(),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "<svg/>");
    }

    #[test]
    fn export_blob_to_selected_path_rejects_bad_extension() {
        let (tmp, _work) = setup_workspace();
        let target = tmp.path().join("demo.txt");
        assert!(diagram_export_blob_to_path(
            target.to_string_lossy().to_string(),
            "png".into(),
            vec![]
        )
        .is_err());
    }

    #[test]
    fn export_blob_to_selected_path_rejects_directory() {
        let (tmp, _work) = setup_workspace();
        assert!(diagram_export_blob_to_path(
            tmp.path().to_string_lossy().to_string(),
            "png".into(),
            vec![]
        )
        .is_err());
    }

    #[test]
    fn snapshot_save_list_restore_round_trip() {
        let (_tmp, work) = setup_workspace();
        let meta = diagram_save_snapshot(
            work.clone(),
            "doc-1".into(),
            "20260101T000000Z".into(),
            "{\"v\":7}".into(),
        )
        .unwrap();
        assert_eq!(meta.snapshot_ts, "20260101T000000Z");
        let list = diagram_list_snapshots(work.clone(), "doc-1".into()).unwrap();
        assert_eq!(list.len(), 1);
        let body =
            diagram_restore_snapshot(work, "doc-1".into(), "20260101T000000Z".into()).unwrap();
        assert!(body.contains("\"v\":7"));
    }

    #[test]
    fn snapshot_caps_history_at_20() {
        let (_tmp, work) = setup_workspace();
        for i in 0..25 {
            let _ = diagram_save_snapshot(
                work.clone(),
                "doc-2".into(),
                format!("20260101T{:06}Z", i),
                "{}".into(),
            )
            .unwrap();
        }
        let list = diagram_list_snapshots(work, "doc-2".into()).unwrap();
        assert_eq!(list.len(), SNAPSHOT_CAP);
        assert_eq!(list[0].snapshot_ts, "20260101T000024Z");
    }

    #[test]
    fn snapshot_rejects_bad_ts() {
        let (_tmp, work) = setup_workspace();
        assert!(
            diagram_save_snapshot(work, "doc".into(), "../escape".into(), "{}".into()).is_err()
        );
    }

    #[test]
    fn backup_creates_v7_copy() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":7,"docTitle":"legacy","nodes":[],"edges":[],"layers":[]}"#;
        diagram_save_document(work.clone(), "legacy".into(), body.into()).unwrap();
        let backup = diagram_backup_document(work.clone(), "legacy".into()).unwrap();
        assert!(
            backup.contains(".maru/diagrams/backups/")
                || backup.contains(".maru\\diagrams\\backups\\")
        );
        assert!(backup.contains("legacy-v7-"));
        assert!(backup.ends_with(DIAGRAM_EXT));
        let copied = fs::read_to_string(&backup).unwrap();
        assert!(copied.contains("\"v\":7"));
        // original untouched
        let original = diagram_load_document(work, "legacy".into()).unwrap();
        assert_eq!(original.trim_end(), body);
    }

    #[test]
    fn backup_rejects_traversal_name() {
        let (_tmp, work) = setup_workspace();
        assert!(diagram_backup_document(work, "../escape".into()).is_err());
    }

    #[test]
    fn backup_errors_when_source_missing() {
        let (_tmp, work) = setup_workspace();
        let err = diagram_backup_document(work, "ghost".into()).unwrap_err();
        assert!(err.contains("Diagram not found"));
    }

    #[test]
    fn pattern_save_list_delete_round_trip() {
        let (_tmp, work) = setup_workspace();
        let body = r#"{"v":1,"id":"p1","name":"My Preset","patternId":"table","createdAt":1,"updatedAt":1}"#;
        diagram_pattern_save(work.clone(), "preset-a".into(), body.into()).unwrap();
        let path = PathBuf::from(&work).join(".maru/diagram-patterns/preset-a.pattern.json");
        assert!(path.is_file());
        let listed = diagram_pattern_list(work.clone()).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "preset-a");
        assert!(diagram_pattern_delete(work.clone(), "preset-a".into()).unwrap());
        assert!(diagram_pattern_list(work).unwrap().is_empty());
    }

    #[test]
    fn pattern_delete_returns_false_when_missing() {
        let (_tmp, work) = setup_workspace();
        assert_eq!(diagram_pattern_delete(work, "ghost".into()).unwrap(), false);
    }

    #[test]
    fn pattern_save_rejects_traversal_name() {
        let (_tmp, work) = setup_workspace();
        assert!(diagram_pattern_save(work.clone(), "../escape".into(), "{}".into()).is_err());
        assert!(diagram_pattern_save(work.clone(), "a/b".into(), "{}".into()).is_err());
        assert!(diagram_pattern_save(work, ".hidden".into(), "{}".into()).is_err());
    }

    #[test]
    fn pattern_list_skips_non_preset_files() {
        let (_tmp, work) = setup_workspace();
        let body =
            r#"{"v":1,"id":"p1","name":"x","patternId":"table","createdAt":1,"updatedAt":1}"#;
        diagram_pattern_save(work.clone(), "keep".into(), body.into()).unwrap();
        let stray = PathBuf::from(&work).join(".maru/diagram-patterns/stray.txt");
        fs::write(&stray, "noise").unwrap();
        let listed = diagram_pattern_list(work).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "keep");
    }

    #[test]
    fn report_asset_round_trip() {
        let (_tmp, work) = setup_workspace();
        let rel = diagram_write_report_asset(
            work.clone(),
            "doc-1".into(),
            "pattern-view-1-ab12cd34.svg".into(),
            b"<svg/>".to_vec(),
        )
        .unwrap();
        assert_eq!(
            rel,
            "attachments/diagrams/doc-1/pattern-view-1-ab12cd34.svg"
        );
        let path = PathBuf::from(&work).join(&rel);
        assert_eq!(fs::read(&path).unwrap(), b"<svg/>");
    }

    #[test]
    fn report_asset_rejects_traversal() {
        let (_tmp, work) = setup_workspace();
        assert!(diagram_write_report_asset(
            work.clone(),
            "../escape".into(),
            "a.svg".into(),
            vec![]
        )
        .is_err());
        assert!(
            diagram_write_report_asset(work.clone(), "a/b".into(), "a.svg".into(), vec![]).is_err()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "../a.svg".into(), vec![])
                .is_err()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "a/b.svg".into(), vec![])
                .is_err()
        );
        assert!(diagram_write_report_asset(
            work.clone(),
            "doc".into(),
            ".hidden.svg".into(),
            vec![]
        )
        .is_err());
        assert!(diagram_write_report_asset(
            work.clone(),
            "doc".into(),
            "with\0nul.svg".into(),
            vec![]
        )
        .is_err());
        // ':' is an NTFS alternate-data-stream separator on Windows.
        assert!(diagram_write_report_asset(
            work.clone(),
            "doc".into(),
            "pattern:view-1.svg".into(),
            vec![]
        )
        .is_err());
        // Doc ids become directory names — same ASCII allowlist applies
        // (an imported doc id is an arbitrary JSON string).
        assert!(
            diagram_write_report_asset(work.clone(), "doc id".into(), "a.svg".into(), vec![])
                .is_err()
        );
        assert!(
            diagram_write_report_asset(work, "x)\ninjected".into(), "a.svg".into(), vec![])
                .is_err()
        );
    }

    #[test]
    fn validate_name_rejects_control_chars() {
        assert!(validate_name("line\nbreak").is_err());
        assert!(validate_name("tab\tname").is_err());
    }

    #[test]
    fn report_asset_rejects_bad_extension() {
        let (_tmp, work) = setup_workspace();
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "a.exe".into(), vec![]).is_err()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "noext".into(), vec![]).is_err()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "a.jpg".into(), vec![]).is_err()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "a.png".into(), vec![]).is_ok()
        );
        assert!(
            diagram_write_report_asset(work.clone(), "doc".into(), "a.json".into(), vec![]).is_ok()
        );
        assert!(diagram_write_report_asset(work, "doc".into(), "a.svg".into(), vec![]).is_ok());
    }

    #[test]
    fn report_asset_overwrite_is_complete() {
        let (_tmp, work) = setup_workspace();
        let rel = diagram_write_report_asset(
            work.clone(),
            "doc".into(),
            "doc-deadbeef.png".into(),
            vec![1u8; 64],
        )
        .unwrap();
        // Same hash-named path rewritten with shorter content must not leave
        // trailing bytes from the previous write.
        let rel2 = diagram_write_report_asset(
            work.clone(),
            "doc".into(),
            "doc-deadbeef.png".into(),
            vec![2u8; 8],
        )
        .unwrap();
        assert_eq!(rel, rel2);
        let full = PathBuf::from(&work).join(&rel);
        assert_eq!(fs::read(&full).unwrap(), vec![2u8; 8]);
        // No temp files left behind by the atomic write.
        let dir = full.parent().unwrap();
        let names: Vec<String> = fs::read_dir(dir)
            .unwrap()
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| entry.file_name().to_str().map(str::to_string))
            .collect();
        assert_eq!(names, vec!["doc-deadbeef.png".to_string()]);
    }
}

#[cfg(test)]
mod phase08_20 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::future::Future;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn workspace(home: &Home, name: &str) -> (PathBuf, String) {
        let root = home.root.path().join(name);
        fs::create_dir_all(root.join(".maru")).unwrap();
        (root.clone(), text(&root))
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<T>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("diagram fixture completion")
    }

    #[test]
    fn phase08_20_diagram_each_wrapper_yields_same_poll_and_maps_join_failure() {
        let home = Home::new();
        let (_root, work) = workspace(&home, "boundary");
        boundary(work.clone().into(), "diagram_save_document", {
            let work = work.clone();
            ipc::diagram_save_document(work, "demo".into(), "{}".into())
        });
        boundary(work.clone().into(), "diagram_load_document", {
            let work = work.clone();
            ipc::diagram_load_document(work, "demo".into())
        });
        boundary(
            work.clone().into(),
            "diagram_list_documents",
            ipc::diagram_list_documents(work.clone()),
        );
        boundary(work.clone().into(), "diagram_delete_document", {
            let work = work.clone();
            ipc::diagram_delete_document(work, "demo".into())
        });
        boundary(work.clone().into(), "diagram_export_blob", {
            let work = work.clone();
            ipc::diagram_export_blob(work, "demo".into(), "png".into(), vec![1, 2, 3])
        });
        let target = home.root.path().join("chosen/demo.svg");
        boundary(
            target.to_string_lossy().into_owned().into(),
            "diagram_export_blob_to_path",
            ipc::diagram_export_blob_to_path(
                target.to_string_lossy().into_owned(),
                "svg".into(),
                b"<svg/>".to_vec(),
            ),
        );
        boundary(work.clone().into(), "diagram_backup_document", {
            let work = work.clone();
            ipc::diagram_backup_document(work, "demo".into())
        });
        boundary(work.clone().into(), "diagram_save_snapshot", {
            let work = work.clone();
            ipc::diagram_save_snapshot(work, "doc-1".into(), "20260101T000000Z".into(), "{}".into())
        });
        boundary(
            work.clone().into(),
            "diagram_list_snapshots",
            ipc::diagram_list_snapshots(work.clone(), "doc-1".into()),
        );
        boundary(work.clone().into(), "diagram_restore_snapshot", {
            let work = work.clone();
            ipc::diagram_restore_snapshot(work, "doc-1".into(), "20260101T000000Z".into())
        });
        boundary(work.clone().into(), "diagram_write_report_asset", {
            let work = work.clone();
            ipc::diagram_write_report_asset(
                work,
                "doc-1".into(),
                "view-ab12cd34.svg".into(),
                b"<svg/>".to_vec(),
            )
        });
        boundary(work.clone().into(), "diagram_pattern_save", {
            let work = work.clone();
            ipc::diagram_pattern_save(work, "preset".into(), "{}".into())
        });
        boundary(
            work.clone().into(),
            "diagram_pattern_list",
            ipc::diagram_pattern_list(work.clone()),
        );
        boundary(work.clone().into(), "diagram_pattern_delete", {
            ipc::diagram_pattern_delete(work, "preset".into())
        });
    }

    #[test]
    fn phase08_20_diagram_real_fixture_results_and_legacy_rejections() {
        let home = Home::new();
        let (root, work) = workspace(&home, "fixture");
        let body = r#"{"v":8,"docTitle":"demo","nodes":[],"edges":[],"layers":[]}"#;

        run(ipc::diagram_save_document(
            work.clone(),
            "demo".into(),
            body.into(),
        ))
        .unwrap();
        let loaded = run(ipc::diagram_load_document(work.clone(), "demo".into())).unwrap();
        assert!(loaded.contains("\"v\":8"));
        let listed = run(ipc::diagram_list_documents(work.clone())).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].name, "demo");
        assert_eq!(listed[0].doc_title, "demo");

        let export_path = run(ipc::diagram_export_blob(
            work.clone(),
            "demo".into(),
            "png".into(),
            vec![0x89, 0x50, 0x4e, 0x47],
        ))
        .unwrap();
        assert_eq!(
            fs::read(&export_path).unwrap(),
            vec![0x89, 0x50, 0x4e, 0x47]
        );

        let meta = run(ipc::diagram_save_snapshot(
            work.clone(),
            "demo".into(),
            "20260101T000000Z".into(),
            "{\"v\":8}".into(),
        ))
        .unwrap();
        assert_eq!(meta.doc_id, "demo");
        assert_eq!(meta.snapshot_ts, "20260101T000000Z");
        assert_eq!(meta.size, 8);
        let snapshots = run(ipc::diagram_list_snapshots(work.clone(), "demo".into())).unwrap();
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].doc_id, meta.doc_id);
        assert_eq!(snapshots[0].snapshot_ts, meta.snapshot_ts);
        assert_eq!(snapshots[0].size, meta.size);
        let restored = run(ipc::diagram_restore_snapshot(
            work.clone(),
            "demo".into(),
            "20260101T000000Z".into(),
        ))
        .unwrap();
        assert_eq!(restored, "{\"v\":8}\n");

        let backup = run(ipc::diagram_backup_document(work.clone(), "demo".into())).unwrap();
        assert!(backup.contains("demo-v7-"));
        assert!(backup.ends_with(DIAGRAM_EXT));
        assert!(fs::read_to_string(&backup).unwrap().contains("\"v\":8"));

        let pattern = r#"{"v":1,"id":"p1","name":"Preset"}"#;
        run(ipc::diagram_pattern_save(
            work.clone(),
            "preset".into(),
            pattern.into(),
        ))
        .unwrap();
        let patterns = run(ipc::diagram_pattern_list(work.clone())).unwrap();
        assert_eq!(patterns.len(), 1);
        assert_eq!(patterns[0].name, "preset");

        let rel = run(ipc::diagram_write_report_asset(
            work.clone(),
            "demo".into(),
            "view-ab12cd34.svg".into(),
            b"<svg/>".to_vec(),
        ))
        .unwrap();
        assert_eq!(rel, "attachments/diagrams/demo/view-ab12cd34.svg");
        assert_eq!(fs::read(root.join(&rel)).unwrap(), b"<svg/>");

        assert!(run(ipc::diagram_pattern_delete(work.clone(), "preset".into())).unwrap());
        assert_eq!(
            run(ipc::diagram_delete_document(work.clone(), "demo".into())).unwrap(),
            true
        );
        assert!(run(ipc::diagram_list_documents(work.clone()))
            .unwrap()
            .is_empty());

        assert_eq!(
            run(ipc::diagram_load_document(work.clone(), "ghost".into())).unwrap_err(),
            "Diagram not found: ghost"
        );
        assert!(run(ipc::diagram_save_document(
            work.clone(),
            "../escape".into(),
            "{}".into()
        ))
        .unwrap_err()
        .starts_with("Invalid diagram name:"));
        assert!(run(ipc::diagram_export_blob(
            work.clone(),
            "demo".into(),
            "exe".into(),
            vec![]
        ))
        .unwrap_err()
        .starts_with("Unsupported export kind:"));
        assert_eq!(
            run(ipc::diagram_restore_snapshot(
                work.clone(),
                "demo".into(),
                "19990101T000000Z".into()
            ))
            .unwrap_err(),
            "snapshot not found: 19990101T000000Z"
        );
        assert!(run(ipc::diagram_write_report_asset(
            work.clone(),
            "demo".into(),
            "a.exe".into(),
            vec![]
        ))
        .unwrap_err()
        .starts_with("Unsupported report asset extension:"));
        assert_eq!(
            run(ipc::diagram_pattern_delete(work.clone(), "ghost".into())).unwrap(),
            false
        );
    }

    #[test]
    fn phase08_20_diagram_save_contends_with_document_save_both_orders() {
        let home = Home::new();
        for document_first in [false, true] {
            let (root, work) = workspace(&home, &format!("contend-{document_first}"));
            let target = root.join("diagrams/demo.cmd.json");
            fs::create_dir_all(target.parent().unwrap()).unwrap();
            fs::write(&target, "original").unwrap();
            let revision = crate::document::revision_for("original");
            let diagram_body = r#"{"v":8,"docTitle":"from diagram"}"#;
            if document_first {
                let held = Held::new(target.clone(), "admitted");
                let first = start(crate::document::ipc::save_document(
                    work.clone(),
                    "diagrams/demo.cmd.json".into(),
                    "from document".into(),
                    Some(revision),
                ));
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(ipc::diagram_save_document(
                    work.clone(),
                    "demo".into(),
                    diagram_body.into(),
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
            } else {
                let held = Held::new(target.clone(), "admitted");
                let first = start(ipc::diagram_save_document(
                    work.clone(),
                    "demo".into(),
                    diagram_body.into(),
                ));
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(crate::document::ipc::save_document(
                    work.clone(),
                    "diagrams/demo.cmd.json".into(),
                    "from document".into(),
                    Some(revision),
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                let err = done(second).unwrap_err();
                assert_eq!(err.code, crate::ipc_error::DOCUMENT_CONFLICT);
            }
            assert_eq!(
                run(ipc::diagram_load_document(work, "demo".into())).unwrap(),
                format!("{diagram_body}\n")
            );
        }
    }

    #[test]
    fn phase08_20_diagram_delete_then_save_serializes_and_error_releases() {
        let home = Home::new();
        let (root, work) = workspace(&home, "serialize");
        let target = root.join("diagrams/demo.cmd.json");
        let body = r#"{"v":8}"#;
        run(ipc::diagram_save_document(
            work.clone(),
            "demo".into(),
            body.into(),
        ))
        .unwrap();

        let held = Held::new(target.clone(), "admitted");
        let delete = start(ipc::diagram_delete_document(work.clone(), "demo".into()));
        held.wait();
        let waiting = Held::new(target.clone(), "before-admission");
        let save = start(ipc::diagram_save_document(
            work.clone(),
            "demo".into(),
            body.into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(save.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        assert!(done(delete).unwrap());
        done(save).unwrap();
        assert_eq!(
            run(ipc::diagram_load_document(work.clone(), "demo".into())).unwrap(),
            format!("{body}\n")
        );

        fs::remove_file(&target).unwrap();
        fs::create_dir(&target).unwrap();
        assert!(run(ipc::diagram_save_document(
            work.clone(),
            "demo".into(),
            body.into(),
        ))
        .unwrap_err()
        .starts_with("Cannot atomically replace"));
        fs::remove_dir(&target).unwrap();
        run(ipc::diagram_save_document(
            work.clone(),
            "demo".into(),
            body.into(),
        ))
        .unwrap();
        assert!(target.is_file());
    }
}
