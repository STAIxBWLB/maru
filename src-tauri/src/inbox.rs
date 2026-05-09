use crate::inbox_settings::{self, InboxSettings};
use crate::vault::normalize_existing_dir;
use crate::vault::{
    lexical_normalize, load_anchorignore, matches_anchorignore, resolve_inside_vault,
};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
use crate::workspace_files::{move_source, resolve_target_dir, unique_path, FileQueueSourceKind};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDropItem {
    pub id: String,
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub source: String,
    pub size_bytes: u64,
    pub received_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxAcceptRequest {
    pub id: String,
    #[serde(default)]
    pub target_folder: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDecisionOutcome {
    pub id: String,
    pub decision: String,
    pub source_path: String,
    pub target_path: Option<String>,
    pub file_name: Option<String>,
    pub ok: bool,
    pub error: Option<String>,
}

const INBOX_FILE_ACCEPT_KIND: &str = "inbox.file.accept";
const INBOX_FILE_REJECT_KIND: &str = "inbox.file.reject";
const INBOX_BULK_KIND: &str = "inbox.bulk";

#[tauri::command]
pub fn scan_inbox_drop(vault_path: String) -> Result<Vec<InboxDropItem>, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let settings = inbox_settings::load(&vault);
    scan_inbox_with_settings(&vault, &settings)
}

#[tauri::command]
pub fn accept_inbox_item(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: String,
    id: String,
    target_folder: Option<String>,
    approval_id: Option<String>,
) -> Result<InboxDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, INBOX_FILE_ACCEPT_KIND)?;
    let vault = normalize_existing_dir(&vault_path)?;
    let outcome = accept_inbox_item_at(&vault, id, target_folder)?;
    emit_decision(&app, "inbox://accepted", &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn accept_inbox_items(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: String,
    items: Vec<InboxAcceptRequest>,
    approval_id: Option<String>,
) -> Result<Vec<InboxDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[INBOX_FILE_ACCEPT_KIND, INBOX_BULK_KIND],
    )?;
    let vault = normalize_existing_dir(&vault_path)?;
    let mut outcomes = Vec::new();
    for item in items {
        match accept_inbox_item_at(&vault, item.id.clone(), item.target_folder) {
            Ok(outcome) => {
                emit_decision(&app, "inbox://accepted", &outcome);
                outcomes.push(outcome);
            }
            Err(err) => outcomes.push(error_outcome(item.id, "accepted", err)),
        }
    }
    Ok(outcomes)
}

#[tauri::command]
pub fn reject_inbox_item(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: String,
    id: String,
    approval_id: Option<String>,
) -> Result<InboxDecisionOutcome, String> {
    crate::approval::require_approval(&approvals, approval_id, INBOX_FILE_REJECT_KIND)?;
    let vault = normalize_existing_dir(&vault_path)?;
    let outcome = reject_inbox_item_at(&vault, id)?;
    emit_decision(&app, "inbox://rejected", &outcome);
    Ok(outcome)
}

#[tauri::command]
pub fn reject_inbox_items(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    vault_path: String,
    ids: Vec<String>,
    approval_id: Option<String>,
) -> Result<Vec<InboxDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[INBOX_FILE_REJECT_KIND, INBOX_BULK_KIND],
    )?;
    let vault = normalize_existing_dir(&vault_path)?;
    let mut outcomes = Vec::new();
    for id in ids {
        match reject_inbox_item_at(&vault, id.clone()) {
            Ok(outcome) => {
                emit_decision(&app, "inbox://rejected", &outcome);
                outcomes.push(outcome);
            }
            Err(err) => outcomes.push(error_outcome(id, "rejected", err)),
        }
    }
    Ok(outcomes)
}

fn scan_inbox_with_settings(
    vault: &Path,
    settings: &InboxSettings,
) -> Result<Vec<InboxDropItem>, String> {
    let inbox_root = resolve_inside_vault(&vault.to_string_lossy(), settings.inbox_root.as_str())?;
    if !inbox_root.exists() {
        return Ok(Vec::new());
    }
    if !inbox_root.is_dir() {
        return Err(format!(
            "{} exists but is not a directory",
            settings.inbox_root
        ));
    }

    let ignore_patterns = load_anchorignore(vault);
    let allow_all_sources = settings.sources.is_empty();

    let mut items = Vec::new();
    for entry in WalkDir::new(&inbox_root).into_iter().filter_map(Result::ok) {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = lexical_normalize(entry.path());
        let rel_to_vault = path.strip_prefix(vault).unwrap_or(&path).to_path_buf();
        if matches_anchorignore(&rel_to_vault, &ignore_patterns) {
            continue;
        }
        let metadata =
            fs::metadata(&path).map_err(|err| format!("Cannot read inbox item metadata: {err}"))?;
        let rel_path = rel_to_vault.to_string_lossy().to_string();
        let source = path
            .parent()
            .and_then(|parent| parent.strip_prefix(&inbox_root).ok())
            .and_then(|rel| rel.components().next())
            .and_then(|component| component.as_os_str().to_str())
            .filter(|value| !value.is_empty())
            .unwrap_or("downloads")
            .to_string();
        if !allow_all_sources && !settings.sources.iter().any(|s| s == &source) {
            continue;
        }
        let title = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("Untitled")
            .to_string();
        let received_at = metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .map(|dt| dt.to_rfc3339());
        items.push(InboxDropItem {
            id: rel_path.clone(),
            path: path.to_string_lossy().to_string(),
            rel_path,
            title,
            source,
            size_bytes: metadata.len(),
            received_at,
        });
    }

    items.sort_by(|a, b| {
        b.received_at
            .cmp(&a.received_at)
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(items)
}

fn accept_inbox_item_at(
    vault: &Path,
    id: String,
    target_folder: Option<String>,
) -> Result<InboxDecisionOutcome, String> {
    assert_anchor_can_write(&vault.to_string_lossy(), WorkspaceWriteAction::RenameMove)?;
    let settings = inbox_settings::load(vault);
    let source = resolve_inbox_source(vault, &settings, &id)?;
    let target_folder = target_folder
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "target_folder_required".to_string())?;
    let target_dir = resolve_target_dir(vault, target_folder)?;
    move_inbox_file(id, "accepted", source.source_path, target_dir)
}

fn reject_inbox_item_at(vault: &Path, id: String) -> Result<InboxDecisionOutcome, String> {
    assert_anchor_can_write(&vault.to_string_lossy(), WorkspaceWriteAction::RenameMove)?;
    let settings = inbox_settings::load(vault);
    let source = resolve_inbox_source(vault, &settings, &id)?;
    let target_dir = rejected_target_dir(vault, &settings, &source.source)?;
    move_inbox_file(id, "rejected", source.source_path, target_dir)
}

#[derive(Debug)]
struct InboxSource {
    source_path: PathBuf,
    source: String,
}

fn resolve_inbox_source(
    vault: &Path,
    settings: &InboxSettings,
    id: &str,
) -> Result<InboxSource, String> {
    let vault_path = vault.to_string_lossy();
    let inbox_root = resolve_inside_vault(&vault_path, settings.inbox_root.as_str())?;
    let source_path = resolve_inside_vault(&vault_path, id)?;
    if !source_path.exists() {
        return Err("inbox_item_missing".to_string());
    }
    if !source_path.is_file() {
        return Err("inbox_item_not_file".to_string());
    }
    let normalized_source = lexical_normalize(&source_path);
    if !normalized_source.starts_with(&inbox_root) {
        return Err("inbox_item_outside_root".to_string());
    }
    let source = normalized_source
        .parent()
        .and_then(|parent| parent.strip_prefix(&inbox_root).ok())
        .and_then(|rel| rel.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("downloads")
        .to_string();
    Ok(InboxSource {
        source_path: normalized_source,
        source,
    })
}

fn rejected_target_dir(
    vault: &Path,
    settings: &InboxSettings,
    source: &str,
) -> Result<PathBuf, String> {
    let root = Path::new(settings.inbox_root.as_str());
    let rejected = root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join("rejected"))
        .unwrap_or_else(|| PathBuf::from("rejected"))
        .join(source);
    resolve_target_dir(vault, &rejected.to_string_lossy())
}

fn move_inbox_file(
    id: String,
    decision: &str,
    source_path: PathBuf,
    target_dir: PathBuf,
) -> Result<InboxDecisionOutcome, String> {
    fs::create_dir_all(&target_dir)
        .map_err(|err| format!("Cannot create target directory: {err}"))?;
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "inbox_file_name_invalid".to_string())?
        .to_string();
    let target_path = unique_path(target_dir.join(&file_name));
    move_source(&source_path, &target_path, FileQueueSourceKind::File)?;
    Ok(InboxDecisionOutcome {
        id,
        decision: decision.to_string(),
        source_path: source_path.to_string_lossy().to_string(),
        target_path: Some(target_path.to_string_lossy().to_string()),
        file_name: target_path
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_string),
        ok: true,
        error: None,
    })
}

fn error_outcome(id: String, decision: &str, error: String) -> InboxDecisionOutcome {
    InboxDecisionOutcome {
        id,
        decision: decision.to_string(),
        source_path: String::new(),
        target_path: None,
        file_name: None,
        ok: false,
        error: Some(error),
    }
}

fn emit_decision(app: &AppHandle, event: &str, outcome: &InboxDecisionOutcome) {
    let _ = app.emit(event, outcome);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    #[test]
    fn scan_inbox_drop_returns_empty_when_folder_is_absent() {
        let tmp = TempDir::new().unwrap();
        let items = scan_inbox_drop(tmp.path().to_string_lossy().to_string()).unwrap();

        assert!(items.is_empty());
    }

    #[test]
    fn scan_inbox_drop_finds_nested_source_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/gmail")).unwrap();
        fs::write(root.join("inbox/downloads/gmail/report.pdf"), b"pdf").unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "gmail");
        assert_eq!(items[0].rel_path, "inbox/downloads/gmail/report.pdf");
        assert_eq!(items[0].size_bytes, 3);
    }

    #[test]
    fn scan_inbox_drop_skips_default_dotfiles() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/outlook")).unwrap();
        fs::create_dir_all(root.join("inbox/downloads/sharepoint")).unwrap();
        fs::write(root.join("inbox/downloads/outlook/.DS_Store"), b"junk").unwrap();
        fs::write(root.join("inbox/downloads/sharepoint/.gitkeep"), b"").unwrap();
        fs::write(root.join("inbox/downloads/outlook/real.pdf"), b"abc").unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "real.pdf");
    }

    #[test]
    fn scan_inbox_drop_uses_custom_root_from_settings() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("incoming/spool/alpha")).unwrap();
        fs::write(root.join("incoming/spool/alpha/note.md"), b"hi").unwrap();
        fs::create_dir_all(root.join(".anchor")).unwrap();
        fs::write(
            root.join(".anchor/inbox.json"),
            r#"{"inboxRoot":"incoming/spool","sources":["alpha"]}"#,
        )
        .unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "alpha");
        assert_eq!(items[0].rel_path, "incoming/spool/alpha/note.md");
    }

    #[test]
    fn scan_inbox_drop_filters_unregistered_sources() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/outlook")).unwrap();
        fs::create_dir_all(root.join("inbox/downloads/random")).unwrap();
        fs::write(root.join("inbox/downloads/outlook/a.pdf"), b"a").unwrap();
        fs::write(root.join("inbox/downloads/random/b.pdf"), b"b").unwrap();
        fs::create_dir_all(root.join(".anchor")).unwrap();
        fs::write(
            root.join(".anchor/inbox.json"),
            r#"{"inboxRoot":"inbox/downloads","sources":["outlook"]}"#,
        )
        .unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].source, "outlook");
    }

    #[test]
    fn accept_inbox_item_moves_to_target_with_conflict_safe_name() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/gmail")).unwrap();
        fs::create_dir_all(root.join("projects/ref")).unwrap();
        fs::write(root.join("inbox/downloads/gmail/report.pdf"), b"new").unwrap();
        fs::write(root.join("projects/ref/report.pdf"), b"existing").unwrap();
        let root = root.canonicalize().unwrap();

        let outcome = accept_inbox_item_at(
            &root,
            "inbox/downloads/gmail/report.pdf".to_string(),
            Some("projects/ref".to_string()),
        )
        .unwrap();

        assert!(outcome.ok);
        assert_eq!(outcome.file_name.as_deref(), Some("report-copy.pdf"));
        assert!(!root.join("inbox/downloads/gmail/report.pdf").exists());
        assert_eq!(
            fs::read(root.join("projects/ref/report-copy.pdf")).unwrap(),
            b"new"
        );
    }

    #[test]
    fn accept_inbox_item_rejects_target_traversal() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/gmail")).unwrap();
        fs::write(root.join("inbox/downloads/gmail/report.pdf"), b"new").unwrap();
        let root = root.canonicalize().unwrap();

        let err = accept_inbox_item_at(
            &root,
            "inbox/downloads/gmail/report.pdf".to_string(),
            Some("../outside".to_string()),
        )
        .unwrap_err();

        assert!(err.contains("escapes"));
    }

    #[test]
    fn reject_inbox_item_moves_to_default_rejected_source_folder() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/kakao")).unwrap();
        fs::write(root.join("inbox/downloads/kakao/note.txt"), b"no").unwrap();
        let root = root.canonicalize().unwrap();

        let outcome =
            reject_inbox_item_at(&root, "inbox/downloads/kakao/note.txt".to_string()).unwrap();

        assert!(outcome.ok);
        assert!(root.join("inbox/rejected/kakao/note.txt").exists());
    }

    #[test]
    fn reject_inbox_item_uses_custom_root_sibling_rejected_folder() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("incoming/spool/alpha")).unwrap();
        fs::write(root.join("incoming/spool/alpha/note.md"), b"no").unwrap();
        fs::create_dir_all(root.join(".anchor")).unwrap();
        fs::write(
            root.join(".anchor/inbox.json"),
            r#"{"inboxRoot":"incoming/spool","sources":["alpha"]}"#,
        )
        .unwrap();
        let root = root.canonicalize().unwrap();

        let outcome =
            reject_inbox_item_at(&root, "incoming/spool/alpha/note.md".to_string()).unwrap();

        assert!(outcome.ok);
        assert!(root.join("incoming/rejected/alpha/note.md").exists());
    }

    #[test]
    fn batch_error_outcome_keeps_failed_item_local() {
        let outcome = error_outcome("missing".to_string(), "accepted", "nope".to_string());
        assert!(!outcome.ok);
        assert_eq!(outcome.id, "missing");
        assert_eq!(outcome.error.as_deref(), Some("nope"));
    }
}
