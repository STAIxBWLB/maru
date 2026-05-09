use crate::inbox_settings::{self, InboxRuntimeConfig, InboxSettings};
use crate::vault::normalize_existing_dir;
use crate::vault::{
    lexical_normalize, load_anchorignore, matches_anchorignore, resolve_inside_vault, ScanFilter,
    ScanOptions,
};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
use crate::workspace_files::{
    copy_source, move_source, resolve_target_dir, unique_path, FileQueueSourceKind,
};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDropStageOutcome {
    pub id: String,
    pub source_path: String,
    pub target_path: Option<String>,
    pub file_name: Option<String>,
    pub channel: String,
    pub drop_path: String,
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxDropStagedEvent {
    pub work_path: String,
    pub channel: String,
    pub drop_path: String,
    pub outcomes: Vec<InboxDropStageOutcome>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxEntry {
    pub id: String,
    pub kind: String,
    pub path: String,
    pub rel_path: String,
    pub title: String,
    pub channel: String,
    pub source_kind: Option<String>,
    pub drop_path: Option<String>,
    pub configured_root: String,
    pub item_id: Option<String>,
    pub status: Option<String>,
    pub manifest_path: Option<String>,
    pub summary_path: Option<String>,
    pub route_path: Option<String>,
    pub size_bytes: u64,
    pub received_at: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PendingManifest {
    id: String,
    status: String,
    channel: String,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    metadata: PendingManifestMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct PendingManifestMetadata {
    #[serde(default)]
    source_kind: Option<String>,
}

const INBOX_FILE_ACCEPT_KIND: &str = "inbox.file.accept";
const INBOX_FILE_REJECT_KIND: &str = "inbox.file.reject";
const INBOX_BULK_KIND: &str = "inbox.bulk";

#[tauri::command]
pub fn scan_inbox_drop(
    vault_path: String,
    scan_options: Option<ScanOptions>,
) -> Result<Vec<InboxDropItem>, String> {
    let vault = resolve_inside_vault(&vault_path, ".")?;
    let scan_filter = ScanFilter::from_options(scan_options)?;
    let settings = inbox_settings::load(&vault);
    scan_inbox_with_settings(&vault, &settings, &scan_filter)
}

#[tauri::command]
pub fn scan_inbox_entries(
    work_path: String,
    scan_options: Option<ScanOptions>,
) -> Result<Vec<InboxEntry>, String> {
    let work = resolve_inside_vault(&work_path, ".")?;
    let scan_filter = ScanFilter::from_options(scan_options)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    scan_inbox_entries_with_config(&work, &config, &scan_filter)
}

#[tauri::command]
pub fn stage_inbox_drop_files(
    app: AppHandle,
    work_path: String,
    channel: Option<String>,
    drop_path: Option<String>,
    source_paths: Vec<String>,
) -> Result<Vec<InboxDropStageOutcome>, String> {
    let work = normalize_existing_dir(&work_path)?;
    assert_anchor_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Create)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    let target = resolve_file_drop_target(&work, &config, channel, drop_path)?;
    fs::create_dir_all(&target.target_dir)
        .map_err(|err| format!("Cannot create inbox drop directory: {err}"))?;
    if !target.target_dir.is_dir() {
        return Err("inbox_drop_target_not_directory".to_string());
    }

    let mut outcomes = Vec::new();
    for source in source_paths {
        outcomes.push(stage_one_drop_file(&target, source));
    }
    if outcomes.iter().any(|outcome| outcome.ok) {
        let _ = app.emit(
            "inbox://drop_staged",
            InboxDropStagedEvent {
                work_path: work.to_string_lossy().to_string(),
                channel: target.channel.clone(),
                drop_path: target.drop_path.clone(),
                outcomes: outcomes.clone(),
            },
        );
    }
    Ok(outcomes)
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
    scan_filter: &ScanFilter,
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
    for entry in WalkDir::new(&inbox_root)
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if scan_filter.is_excluded_path(path, vault, &[]) {
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
        let path = lexical_normalize(entry.path());
        let rel_to_vault = path.strip_prefix(vault).unwrap_or(&path).to_path_buf();
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

fn scan_inbox_entries_with_config(
    work: &Path,
    config: &InboxRuntimeConfig,
    scan_filter: &ScanFilter,
) -> Result<Vec<InboxEntry>, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let ignore_patterns = load_anchorignore(work);
    let mut entries = Vec::new();

    for (channel_key, channel) in &config.channels {
        for drop_path in &channel.drop_paths {
            let drop_root = inbox_settings::lexical_normalize_path(&root.join(drop_path));
            if !drop_root.exists() {
                continue;
            }
            if !drop_root.is_dir() {
                return Err(format!(
                    "{} exists but is not a directory",
                    drop_root.display()
                ));
            }
            for entry in WalkDir::new(&drop_root)
                .into_iter()
                .filter_entry(|entry| {
                    let path = entry.path();
                    if scan_filter.is_excluded_path(path, work, &[]) {
                        return false;
                    }
                    let rel = path.strip_prefix(work).unwrap_or(path);
                    !matches_anchorignore(rel, &ignore_patterns)
                })
                .filter_map(Result::ok)
            {
                if !entry.file_type().is_file() {
                    continue;
                }
                let path = inbox_settings::lexical_normalize_path(entry.path());
                let rel_to_work = path.strip_prefix(work).unwrap_or(&path).to_path_buf();
                if is_inbox_noise(&path) {
                    continue;
                }
                let metadata = fs::metadata(&path)
                    .map_err(|err| format!("Cannot read inbox item metadata: {err}"))?;
                let source_kind = source_kind_for_drop(&path, &drop_root, channel);
                let received_at = metadata
                    .modified()
                    .ok()
                    .map(DateTime::<Utc>::from)
                    .map(|dt| dt.to_rfc3339());
                let rel_path = rel_to_work.to_string_lossy().to_string();
                let title = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("Untitled")
                    .to_string();
                entries.push(InboxEntry {
                    id: rel_path.clone(),
                    kind: "dropFile".to_string(),
                    path: path.to_string_lossy().to_string(),
                    rel_path,
                    title,
                    channel: channel_key.clone(),
                    source_kind,
                    drop_path: Some(drop_path.clone()),
                    configured_root: root.to_string_lossy().to_string(),
                    item_id: None,
                    status: Some("drop".to_string()),
                    manifest_path: None,
                    summary_path: None,
                    route_path: None,
                    size_bytes: metadata.len(),
                    received_at,
                });
            }
        }
    }

    let pending_root = inbox_settings::lexical_normalize_path(&root.join(&config.paths.pending));
    if pending_root.is_dir() {
        let manifest_file = config.naming.manifest_file.as_str();
        for entry in WalkDir::new(&pending_root)
            .min_depth(1)
            .into_iter()
            .filter_entry(|entry| {
                let path = entry.path();
                if scan_filter.is_excluded_path(path, work, &[]) {
                    return false;
                }
                let rel = path.strip_prefix(work).unwrap_or(path);
                !matches_anchorignore(rel, &ignore_patterns)
            })
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file()
                || entry.file_name().to_string_lossy().as_ref() != manifest_file
            {
                continue;
            }
            let manifest_path = inbox_settings::lexical_normalize_path(entry.path());
            let raw = fs::read_to_string(&manifest_path)
                .map_err(|err| format!("Cannot read inbox manifest: {err}"))?;
            let manifest: PendingManifest = serde_yaml::from_str(&raw)
                .map_err(|err| format!("Cannot parse inbox manifest: {err}"))?;
            let item_dir = manifest_path.parent().unwrap_or(pending_root.as_path());
            let metadata = fs::metadata(&manifest_path)
                .map_err(|err| format!("Cannot read inbox manifest metadata: {err}"))?;
            let received_at = metadata
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|dt| dt.to_rfc3339());
            let title = manifest.id.clone();
            entries.push(InboxEntry {
                id: manifest_path
                    .strip_prefix(work)
                    .unwrap_or(&manifest_path)
                    .to_string_lossy()
                    .to_string(),
                kind: "pendingItem".to_string(),
                path: item_dir.to_string_lossy().to_string(),
                rel_path: item_dir
                    .strip_prefix(work)
                    .unwrap_or(item_dir)
                    .to_string_lossy()
                    .to_string(),
                title,
                channel: manifest.channel,
                source_kind: manifest.metadata.source_kind.or(manifest.kind),
                drop_path: None,
                configured_root: root.to_string_lossy().to_string(),
                item_id: Some(manifest.id),
                status: Some(manifest.status),
                manifest_path: Some(manifest_path.to_string_lossy().to_string()),
                summary_path: Some(
                    item_dir
                        .join(&config.naming.summary_file)
                        .to_string_lossy()
                        .to_string(),
                ),
                route_path: Some(
                    item_dir
                        .join(&config.naming.route_file)
                        .to_string_lossy()
                        .to_string(),
                ),
                size_bytes: 0,
                received_at,
            });
        }
    }

    entries.sort_by(|a, b| {
        b.received_at
            .cmp(&a.received_at)
            .then_with(|| a.channel.cmp(&b.channel))
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(entries)
}

fn source_kind_for_drop(
    path: &Path,
    drop_root: &Path,
    channel: &inbox_settings::InboxChannelConfig,
) -> Option<String> {
    let rel = path.strip_prefix(drop_root).ok()?;
    let first = rel
        .parent()
        .and_then(|parent| parent.components().next())
        .and_then(|component| component.as_os_str().to_str())
        .filter(|value| !value.is_empty())?;
    channel
        .source_kinds
        .get(first)
        .cloned()
        .or_else(|| Some(first.to_string()))
}

fn is_inbox_noise(path: &Path) -> bool {
    matches!(
        path.file_name().and_then(|name| name.to_str()),
        Some(".DS_Store" | ".gitkeep" | ".keep" | "Thumbs.db")
    )
}

#[derive(Debug)]
struct ResolvedFileDropTarget {
    channel: String,
    drop_path: String,
    target_dir: PathBuf,
}

fn resolve_file_drop_target(
    work: &Path,
    config: &InboxRuntimeConfig,
    channel_override: Option<String>,
    drop_path_override: Option<String>,
) -> Result<ResolvedFileDropTarget, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let explicit = channel_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some()
        || drop_path_override
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .is_some();

    let configured_channel = channel_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.file_drop.channel.as_str());
    let configured_drop_path = drop_path_override
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(config.file_drop.drop_path.as_str());

    if let Some(channel) = config.channels.get(configured_channel) {
        if channel
            .drop_paths
            .iter()
            .any(|path| path == configured_drop_path)
        {
            return resolved_drop_target(&root, configured_channel, configured_drop_path);
        }
        if explicit {
            return Err(format!(
                "drop_path_not_registered_for_channel: {configured_channel}/{configured_drop_path}"
            ));
        }
    } else if explicit {
        return Err(format!("unknown_inbox_channel: {configured_channel}"));
    }

    let Some((fallback_channel, fallback)) = config
        .channels
        .iter()
        .find_map(|(key, channel)| channel.drop_paths.first().map(|path| (key, path)))
    else {
        return Err("no_inbox_drop_path_configured".to_string());
    };
    resolved_drop_target(&root, fallback_channel, fallback)
}

fn resolved_drop_target(
    root: &Path,
    channel: &str,
    drop_path: &str,
) -> Result<ResolvedFileDropTarget, String> {
    let target_dir = inbox_settings::lexical_normalize_path(&root.join(drop_path));
    if !target_dir.starts_with(root) {
        return Err(format!("drop_path_outside_inbox: {drop_path}"));
    }
    Ok(ResolvedFileDropTarget {
        channel: channel.to_string(),
        drop_path: drop_path.to_string(),
        target_dir,
    })
}

fn stage_one_drop_file(target: &ResolvedFileDropTarget, source: String) -> InboxDropStageOutcome {
    let source_path = PathBuf::from(&source);
    match stage_one_drop_file_result(target, &source_path) {
        Ok((target_path, file_name)) => InboxDropStageOutcome {
            id: source.clone(),
            source_path: source,
            target_path: Some(target_path.to_string_lossy().to_string()),
            file_name: Some(file_name),
            channel: target.channel.clone(),
            drop_path: target.drop_path.clone(),
            ok: true,
            error: None,
        },
        Err(error) => InboxDropStageOutcome {
            id: source.clone(),
            source_path: source,
            target_path: None,
            file_name: None,
            channel: target.channel.clone(),
            drop_path: target.drop_path.clone(),
            ok: false,
            error: Some(error),
        },
    }
}

fn stage_one_drop_file_result(
    target: &ResolvedFileDropTarget,
    source_path: &Path,
) -> Result<(PathBuf, String), String> {
    let metadata =
        fs::symlink_metadata(source_path).map_err(|err| format!("Cannot inspect source: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Source symlinks are not supported: {}",
            source_path.display()
        ));
    }
    if !metadata.is_file() {
        return Err(format!("Source is not a file: {}", source_path.display()));
    }
    let file_name = source_path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Source file name is not valid UTF-8".to_string())?
        .to_string();
    let target_path = unique_path(target.target_dir.join(&file_name));
    copy_source(source_path, &target_path, FileQueueSourceKind::File)?;
    let final_name = target_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&file_name)
        .to_string();
    Ok((target_path, final_name))
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
        let items = scan_inbox_drop(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert!(items.is_empty());
    }

    #[test]
    fn scan_inbox_drop_finds_nested_source_files() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/gmail")).unwrap();
        fs::write(root.join("inbox/downloads/gmail/report.pdf"), b"pdf").unwrap();

        let items = scan_inbox_drop(root.to_string_lossy().to_string(), None).unwrap();

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

        let items = scan_inbox_drop(root.to_string_lossy().to_string(), None).unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "real.pdf");
    }

    #[test]
    fn scan_inbox_drop_skips_dot_folders_unless_allowlisted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("inbox/downloads/kakao/.omc/state")).unwrap();
        fs::write(
            root.join("inbox/downloads/kakao/.omc/state/replay.jsonl"),
            b"junk",
        )
        .unwrap();
        fs::write(root.join("inbox/downloads/kakao/real.txt"), b"real").unwrap();

        let default_items = scan_inbox_drop(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(default_items.len(), 1);
        assert_eq!(default_items[0].title, "real.txt");

        let allowlisted = scan_inbox_drop(
            root.to_string_lossy().to_string(),
            Some(ScanOptions {
                include_dot_folders: vec!["inbox/downloads/kakao/.omc".to_string()],
            }),
        )
        .unwrap();
        assert_eq!(allowlisted.len(), 2);
        assert!(allowlisted
            .iter()
            .any(|item| item.rel_path.ends_with("replay.jsonl")));
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

        let items = scan_inbox_drop(root.to_string_lossy().to_string(), None).unwrap();

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

        let items = scan_inbox_drop(root.to_string_lossy().to_string(), None).unwrap();

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

    #[test]
    fn stage_drop_file_copies_to_configured_target_with_conflict_safe_name() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let source_dir = TempDir::new().unwrap();
        let source = source_dir.path().join("report.pdf");
        fs::write(&source, b"new").unwrap();
        fs::create_dir_all(root.join("inbox/drop/incoming")).unwrap();
        fs::write(root.join("inbox/drop/incoming/report.pdf"), b"old").unwrap();

        let config = InboxRuntimeConfig::default();
        let target = resolve_file_drop_target(&root, &config, None, None).unwrap();
        let outcome = stage_one_drop_file(&target, source.to_string_lossy().to_string());

        assert!(outcome.ok);
        assert_eq!(outcome.channel, "incoming");
        assert_eq!(outcome.drop_path, "drop/incoming");
        assert_eq!(outcome.file_name.as_deref(), Some("report-copy.pdf"));
        assert_eq!(
            fs::read(root.join("inbox/drop/incoming/report-copy.pdf")).unwrap(),
            b"new"
        );
        assert!(source.exists(), "staging is copy-only");
    }

    #[test]
    fn stage_drop_file_rejects_directory_sources() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::create_dir_all(root.join("inbox/drop/incoming")).unwrap();
        let source_dir = TempDir::new().unwrap();

        let config = InboxRuntimeConfig::default();
        let target = resolve_file_drop_target(&root, &config, None, None).unwrap();
        let outcome = stage_one_drop_file(&target, source_dir.path().to_string_lossy().to_string());

        assert!(!outcome.ok);
        assert!(outcome.error.as_deref().unwrap().contains("not a file"));
    }

    #[test]
    fn explicit_drop_target_must_match_registered_channel_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let config = InboxRuntimeConfig::default();

        let unknown = resolve_file_drop_target(
            &root,
            &config,
            Some("missing".to_string()),
            Some("drop/missing".to_string()),
        )
        .unwrap_err();
        assert!(unknown.contains("unknown_inbox_channel"));

        let unregistered = resolve_file_drop_target(
            &root,
            &config,
            Some("incoming".to_string()),
            Some("drop/other".to_string()),
        )
        .unwrap_err();
        assert!(unregistered.contains("drop_path_not_registered"));
    }

    #[test]
    fn scan_inbox_entries_reads_configured_drop_files_and_pending_manifests() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(
            root.join("workspace.config.yaml"),
            r#"
inbox:
  root: inbox
  paths:
    drop: drop
    items: items
    pending: items/pending
    done: items/done
    failed: items/failed
    duplicate: items/duplicate
    state: _state
    receipts: _state/index.jsonl
  naming:
    item_id_template: "{date}-{channel}-{slug}"
    raw_dir: raw
    manifest_file: manifest.yaml
    extracted_file: extracted.md
    summary_file: digest.md
    route_file: route.md
  channels:
    kakao:
      provider: kakao
      skill: io-kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - drop/kakao
      source_kinds:
        messages: message
"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("inbox/drop/kakao/messages")).unwrap();
        fs::write(root.join("inbox/drop/kakao/messages/chat.txt"), b"hello").unwrap();
        fs::create_dir_all(root.join("inbox/items/pending/260510-kakao-chat")).unwrap();
        fs::write(
            root.join("inbox/items/pending/260510-kakao-chat/manifest.yaml"),
            r#"
id: 260510-kakao-chat
status: pending
channel: kakao
kind: message
metadata:
  source_kind: message
"#,
        )
        .unwrap();

        let entries = scan_inbox_entries(root.to_string_lossy().to_string(), None).unwrap();

        assert_eq!(entries.len(), 2);
        let drop_entry = entries
            .iter()
            .find(|entry| entry.kind == "dropFile")
            .unwrap();
        assert_eq!(drop_entry.channel, "kakao");
        assert_eq!(drop_entry.source_kind.as_deref(), Some("message"));
        assert_eq!(drop_entry.drop_path.as_deref(), Some("drop/kakao"));
        assert_eq!(drop_entry.rel_path, "inbox/drop/kakao/messages/chat.txt");

        let pending_entry = entries
            .iter()
            .find(|entry| entry.kind == "pendingItem")
            .unwrap();
        assert_eq!(pending_entry.item_id.as_deref(), Some("260510-kakao-chat"));
        assert_eq!(pending_entry.status.as_deref(), Some("pending"));
        assert!(pending_entry
            .summary_path
            .as_deref()
            .unwrap()
            .ends_with("inbox/items/pending/260510-kakao-chat/digest.md"));
    }

    #[test]
    fn scan_inbox_entries_skips_dot_folders_unless_allowlisted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::write(
            root.join("workspace.config.yaml"),
            r#"
inbox:
  root: inbox
  channels:
    kakao:
      provider: kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - drop/kakao
"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("inbox/drop/kakao/.omc/state")).unwrap();
        fs::write(
            root.join("inbox/drop/kakao/.omc/state/replay.jsonl"),
            b"junk",
        )
        .unwrap();
        fs::write(root.join("inbox/drop/kakao/real.txt"), b"real").unwrap();

        let default_entries = scan_inbox_entries(root.to_string_lossy().to_string(), None).unwrap();
        assert_eq!(default_entries.len(), 1);
        assert_eq!(default_entries[0].title, "real.txt");

        let allowlisted = scan_inbox_entries(
            root.to_string_lossy().to_string(),
            Some(ScanOptions {
                include_dot_folders: vec!["inbox/drop/kakao/.omc".to_string()],
            }),
        )
        .unwrap();
        assert_eq!(allowlisted.len(), 2);
        assert!(allowlisted
            .iter()
            .any(|entry| entry.rel_path.ends_with("replay.jsonl")));
    }

    #[test]
    fn scan_inbox_entries_uses_legacy_settings_when_workspace_config_has_no_inbox() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join(".anchor")).unwrap();
        fs::write(
            root.join(".anchor/inbox.json"),
            r#"{"inboxRoot":"incoming/spool","sources":["alpha"]}"#,
        )
        .unwrap();
        fs::create_dir_all(root.join("incoming/spool/alpha")).unwrap();
        fs::write(root.join("incoming/spool/alpha/note.md"), b"legacy").unwrap();

        let entries = scan_inbox_entries(root.to_string_lossy().to_string(), None).unwrap();

        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].kind, "dropFile");
        assert_eq!(entries[0].channel, "alpha");
        assert_eq!(entries[0].rel_path, "incoming/spool/alpha/note.md");
    }
}
