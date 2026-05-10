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
use serde_yaml::Value as YamlValue;
use std::fs;
use std::io::Read;
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxProcessedItem {
    pub id: String,
    pub status: String,
    pub channel: String,
    pub provider: Option<String>,
    pub kind: Option<String>,
    pub received_at: Option<String>,
    pub item_dir: String,
    pub manifest_path: String,
    pub summary_path: Option<String>,
    pub route_path: Option<String>,
    pub extracted_path: Option<String>,
    pub title: String,
    pub description: Option<String>,
    pub project: Option<String>,
    pub classification: Option<String>,
    pub route_status: Option<String>,
    pub summary_preview: String,
    pub raw_file_count: usize,
    pub updated_at: Option<String>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxProcessedRawFile {
    pub path: String,
    pub rel_path: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxProcessedItemDetail {
    pub item: InboxProcessedItem,
    pub manifest_text: String,
    pub summary_text: Option<String>,
    pub route_text: Option<String>,
    pub extracted_text: Option<String>,
    pub extracted_truncated: bool,
    pub raw_files: Vec<InboxProcessedRawFile>,
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

#[derive(Debug, Default, Deserialize)]
struct ProcessedManifest {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    kind: Option<String>,
    #[serde(default)]
    received_at: Option<String>,
    #[serde(default)]
    files: Vec<ProcessedManifestFile>,
    #[serde(default)]
    metadata: ProcessedManifestMetadata,
}

#[derive(Debug, Default, Deserialize)]
struct ProcessedManifestFile {
    #[serde(default, rename = "path")]
    path: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct ProcessedManifestMetadata {
    #[serde(default)]
    source_kind: Option<String>,
    #[serde(default)]
    processing_hints: ProcessedProcessingHints,
}

#[derive(Debug, Default, Deserialize)]
struct ProcessedProcessingHints {
    #[serde(default)]
    project: Option<String>,
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
pub fn scan_inbox_processed_items(
    work_path: String,
    statuses: Option<Vec<String>>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<InboxProcessedItem>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    scan_processed_items_with_config(&work, &config, statuses, query, limit)
}

#[tauri::command]
pub fn read_inbox_processed_item(
    work_path: String,
    item_dir: String,
) -> Result<InboxProcessedItemDetail, String> {
    let work = normalize_existing_dir(&work_path)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    read_processed_item_with_config(&work, &config, &item_dir)
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

fn scan_processed_items_with_config(
    work: &Path,
    config: &InboxRuntimeConfig,
    statuses: Option<Vec<String>>,
    query: Option<String>,
    limit: Option<usize>,
) -> Result<Vec<InboxProcessedItem>, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let statuses = normalize_processed_statuses(statuses)?;
    let query = query
        .map(|value| value.trim().to_lowercase())
        .filter(|value| !value.is_empty());
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let mut items = Vec::new();

    for status in statuses {
        let status_dir = processed_status_dir(&root, config, &status)?;
        if !status_dir.exists() {
            continue;
        }
        if !status_dir.is_dir() {
            return Err(format!(
                "{} exists but is not a directory",
                status_dir.display()
            ));
        }
        let read_dir = fs::read_dir(&status_dir)
            .map_err(|err| format!("Cannot scan inbox processed items: {err}"))?;
        for entry in read_dir {
            let entry = entry.map_err(|err| format!("Cannot scan inbox processed item: {err}"))?;
            let file_type = entry
                .file_type()
                .map_err(|err| format!("Cannot inspect inbox processed item: {err}"))?;
            if !file_type.is_dir() {
                continue;
            }
            let item_dir = inbox_settings::lexical_normalize_path(&entry.path());
            let item = match build_processed_item(work, &root, config, &item_dir, &status) {
                Ok(item) => item,
                Err(err) => error_processed_item(work, config, &item_dir, &status, err),
            };
            if query
                .as_deref()
                .map(|needle| processed_item_matches_query(&item, needle))
                .unwrap_or(true)
            {
                items.push(item);
            }
        }
    }

    items.sort_by(|a, b| {
        b.received_at
            .cmp(&a.received_at)
            .then_with(|| b.updated_at.cmp(&a.updated_at))
            .then_with(|| a.id.cmp(&b.id))
    });
    items.truncate(limit);
    Ok(items)
}

fn read_processed_item_with_config(
    work: &Path,
    config: &InboxRuntimeConfig,
    item_dir: &str,
) -> Result<InboxProcessedItemDetail, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let item_dir = resolve_processed_item_dir(work, &root, config, item_dir)?;
    let status = processed_status_for_item_dir(&root, config, &item_dir)
        .ok_or_else(|| "processed_item_outside_configured_statuses".to_string())?;
    let item = build_processed_item(work, &root, config, &item_dir, &status)?;
    let manifest_text = fs::read_to_string(&item.manifest_path)
        .map_err(|err| format!("Cannot read inbox manifest: {err}"))?;
    let summary_text = read_optional_text(item.summary_path.as_deref())?;
    let route_text = read_optional_text(item.route_path.as_deref())?;
    let (extracted_text, extracted_truncated) =
        read_optional_text_limited(item.extracted_path.as_deref(), 200 * 1024)?;
    let raw_files = list_raw_files(&item_dir, &config.naming.raw_dir)?;

    Ok(InboxProcessedItemDetail {
        item,
        manifest_text,
        summary_text,
        route_text,
        extracted_text,
        extracted_truncated,
        raw_files,
    })
}

fn normalize_processed_statuses(statuses: Option<Vec<String>>) -> Result<Vec<String>, String> {
    let default = vec![
        "done".to_string(),
        "failed".to_string(),
        "duplicate".to_string(),
    ];
    let Some(values) = statuses else {
        return Ok(default);
    };
    let mut out = Vec::new();
    for raw in values {
        let value = raw.trim().to_lowercase();
        if value.is_empty() {
            continue;
        }
        if value == "all" {
            return Ok(default);
        }
        if !matches!(value.as_str(), "done" | "failed" | "duplicate") {
            return Err(format!("unsupported_inbox_processed_status: {value}"));
        }
        if !out.contains(&value) {
            out.push(value);
        }
    }
    if out.is_empty() {
        Ok(default)
    } else {
        Ok(out)
    }
}

fn processed_status_dir(
    root: &Path,
    config: &InboxRuntimeConfig,
    status: &str,
) -> Result<PathBuf, String> {
    let rel = match status {
        "done" => &config.paths.done,
        "failed" => &config.paths.failed,
        "duplicate" => &config.paths.duplicate,
        "pending" => &config.paths.pending,
        _ => return Err(format!("unsupported_inbox_processed_status: {status}")),
    };
    let path = inbox_settings::lexical_normalize_path(&root.join(rel));
    if !path.starts_with(root) {
        return Err(format!("processed_status_path_outside_inbox: {rel}"));
    }
    Ok(path)
}

fn resolve_processed_item_dir(
    work: &Path,
    root: &Path,
    config: &InboxRuntimeConfig,
    item_dir: &str,
) -> Result<PathBuf, String> {
    let raw = PathBuf::from(item_dir);
    let path = if raw.is_absolute() {
        inbox_settings::lexical_normalize_path(&raw)
    } else {
        resolve_inside_vault(&work.to_string_lossy(), item_dir)?
    };
    if !path.exists() {
        return Err("processed_item_missing".to_string());
    }
    if !path.is_dir() {
        return Err("processed_item_not_directory".to_string());
    }
    if !path.starts_with(root) {
        return Err("processed_item_outside_inbox".to_string());
    }
    if processed_status_for_item_dir(root, config, &path).is_none() {
        return Err("processed_item_outside_configured_statuses".to_string());
    }
    Ok(path)
}

fn processed_status_for_item_dir(
    root: &Path,
    config: &InboxRuntimeConfig,
    item_dir: &Path,
) -> Option<String> {
    for status in ["done", "failed", "duplicate"] {
        let status_dir = processed_status_dir(root, config, status).ok()?;
        if item_dir.starts_with(status_dir) {
            return Some(status.to_string());
        }
    }
    None
}

fn build_processed_item(
    _work: &Path,
    root: &Path,
    config: &InboxRuntimeConfig,
    item_dir: &Path,
    folder_status: &str,
) -> Result<InboxProcessedItem, String> {
    if !item_dir.starts_with(root) {
        return Err("processed_item_outside_inbox".to_string());
    }
    let manifest_path = item_dir.join(&config.naming.manifest_file);
    let manifest_raw = fs::read_to_string(&manifest_path)
        .map_err(|err| format!("Cannot read inbox manifest: {err}"))?;
    let manifest: ProcessedManifest = serde_yaml::from_str(&manifest_raw)
        .map_err(|err| format!("Cannot parse inbox manifest: {err}"))?;
    let summary_path = item_dir.join(&config.naming.summary_file);
    let route_path = item_dir.join(&config.naming.route_file);
    let extracted_path = item_dir.join(&config.naming.extracted_file);
    let summary_raw = read_file_if_exists(&summary_path)?;
    let route_raw = read_file_if_exists(&route_path)?;
    let (summary_meta, summary_body) = summary_raw
        .as_deref()
        .map(split_markdown_frontmatter)
        .unwrap_or((None, ""));
    let (route_meta, _route_body) = route_raw
        .as_deref()
        .map(split_markdown_frontmatter)
        .unwrap_or((None, ""));
    let fallback_id = item_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let id = manifest
        .id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(fallback_id.as_str())
        .to_string();
    let channel = manifest
        .channel
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let title = yaml_string(summary_meta.as_ref(), "title").unwrap_or_else(|| id.clone());
    let description = yaml_string(summary_meta.as_ref(), "description");
    let project = yaml_string(summary_meta.as_ref(), "project")
        .or_else(|| yaml_string(route_meta.as_ref(), "project"))
        .or(manifest.metadata.processing_hints.project);
    let classification = yaml_string(route_meta.as_ref(), "classification");
    let route_status = yaml_string(route_meta.as_ref(), "route_status");
    let provider = manifest.provider.or_else(|| {
        config
            .channels
            .get(&channel)
            .map(|channel| channel.provider.clone())
    });
    let kind = manifest.kind.or(manifest.metadata.source_kind);
    let status = manifest
        .status
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(folder_status)
        .to_string();
    let manifest_raw_file_count = manifest
        .files
        .iter()
        .filter(|file| file.path.as_deref().map(str::trim).is_some_and(|path| !path.is_empty()))
        .count();
    let raw_file_count = if manifest_raw_file_count > 0 {
        manifest_raw_file_count
    } else {
        count_raw_files(item_dir, &config.naming.raw_dir)?
    };
    let updated_at = latest_modified_time(&[
        manifest_path.as_path(),
        summary_path.as_path(),
        route_path.as_path(),
        extracted_path.as_path(),
    ]);

    Ok(InboxProcessedItem {
        id,
        status,
        channel,
        provider,
        kind,
        received_at: manifest.received_at,
        item_dir: item_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        summary_path: path_string_if_exists(&summary_path),
        route_path: path_string_if_exists(&route_path),
        extracted_path: path_string_if_exists(&extracted_path),
        title,
        description,
        project,
        classification,
        route_status,
        summary_preview: preview_text(summary_body, 280),
        raw_file_count,
        updated_at,
        error: None,
    })
}

fn error_processed_item(
    _work: &Path,
    config: &InboxRuntimeConfig,
    item_dir: &Path,
    status: &str,
    error: String,
) -> InboxProcessedItem {
    let id = item_dir
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("unknown")
        .to_string();
    let manifest_path = item_dir.join(&config.naming.manifest_file);
    InboxProcessedItem {
        id: id.clone(),
        status: status.to_string(),
        channel: "unknown".to_string(),
        provider: None,
        kind: None,
        received_at: None,
        item_dir: item_dir.to_string_lossy().to_string(),
        manifest_path: manifest_path.to_string_lossy().to_string(),
        summary_path: path_string_if_exists(&item_dir.join(&config.naming.summary_file)),
        route_path: path_string_if_exists(&item_dir.join(&config.naming.route_file)),
        extracted_path: path_string_if_exists(&item_dir.join(&config.naming.extracted_file)),
        title: id,
        description: None,
        project: None,
        classification: None,
        route_status: None,
        summary_preview: String::new(),
        raw_file_count: count_raw_files(item_dir, &config.naming.raw_dir).unwrap_or(0),
        updated_at: fs::metadata(item_dir)
            .ok()
            .and_then(|metadata| metadata.modified().ok())
            .map(DateTime::<Utc>::from)
            .map(|dt| dt.to_rfc3339()),
        error: Some(error),
    }
}

fn split_markdown_frontmatter(raw: &str) -> (Option<YamlValue>, &str) {
    if !raw.starts_with("---\n") && !raw.starts_with("---\r\n") {
        return (None, raw);
    }
    let body_start = if raw.starts_with("---\r\n") { 5 } else { 4 };
    let rest = &raw[body_start..];
    let Some(end) = rest.find("\n---") else {
        return (None, raw);
    };
    let yaml = &rest[..end];
    let after_marker = &rest[end + "\n---".len()..];
    let body = after_marker.trim_start_matches(['\r', '\n']);
    let parsed = serde_yaml::from_str::<YamlValue>(yaml).ok();
    (parsed, body)
}

fn yaml_string(value: Option<&YamlValue>, key: &str) -> Option<String> {
    let YamlValue::Mapping(map) = value? else {
        return None;
    };
    let value = map.get(YamlValue::String(key.to_string()))?;
    match value {
        YamlValue::String(text) => Some(text.clone()),
        YamlValue::Number(number) => Some(number.to_string()),
        YamlValue::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn preview_text(body: &str, max_chars: usize) -> String {
    let compact = body.split_whitespace().collect::<Vec<_>>().join(" ");
    if compact.chars().count() <= max_chars {
        return compact;
    }
    let mut preview = compact.chars().take(max_chars).collect::<String>();
    preview.push_str("...");
    preview
}

fn processed_item_matches_query(item: &InboxProcessedItem, needle: &str) -> bool {
    [
        item.id.as_str(),
        item.channel.as_str(),
        item.title.as_str(),
        item.summary_preview.as_str(),
        item.project.as_deref().unwrap_or(""),
        item.classification.as_deref().unwrap_or(""),
        item.route_status.as_deref().unwrap_or(""),
    ]
    .iter()
    .any(|value| value.to_lowercase().contains(needle))
}

fn read_file_if_exists(path: &Path) -> Result<Option<String>, String> {
    if !path.exists() {
        return Ok(None);
    }
    fs::read_to_string(path).map(Some).map_err(|err| {
        format!(
            "Cannot read inbox processed artifact {}: {err}",
            path.display()
        )
    })
}

fn read_optional_text(path: Option<&str>) -> Result<Option<String>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    fs::read_to_string(path)
        .map(Some)
        .map_err(|err| format!("Cannot read inbox processed artifact {path}: {err}"))
}

fn read_optional_text_limited(
    path: Option<&str>,
    limit_bytes: usize,
) -> Result<(Option<String>, bool), String> {
    let Some(path) = path else {
        return Ok((None, false));
    };
    let mut file = fs::File::open(path)
        .map_err(|err| format!("Cannot read inbox processed artifact {path}: {err}"))?;
    let mut buffer = Vec::new();
    let limit = limit_bytes.saturating_add(1) as u64;
    file.by_ref()
        .take(limit)
        .read_to_end(&mut buffer)
        .map_err(|err| format!("Cannot read inbox processed artifact {path}: {err}"))?;
    let truncated = buffer.len() > limit_bytes;
    if truncated {
        buffer.truncate(limit_bytes);
    }
    Ok((
        Some(String::from_utf8_lossy(&buffer).to_string()),
        truncated,
    ))
}

fn path_string_if_exists(path: &Path) -> Option<String> {
    path.exists().then(|| path.to_string_lossy().to_string())
}

fn count_raw_files(item_dir: &Path, raw_dir: &str) -> Result<usize, String> {
    let raw_root = item_dir.join(raw_dir);
    if !raw_root.is_dir() {
        return Ok(0);
    }
    Ok(WalkDir::new(&raw_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .count())
}

fn list_raw_files(item_dir: &Path, raw_dir: &str) -> Result<Vec<InboxProcessedRawFile>, String> {
    let raw_root = item_dir.join(raw_dir);
    if !raw_root.is_dir() {
        return Ok(Vec::new());
    }
    let mut files = Vec::new();
    for entry in WalkDir::new(&raw_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
    {
        let path = inbox_settings::lexical_normalize_path(entry.path());
        let metadata =
            fs::metadata(&path).map_err(|err| format!("Cannot read raw file metadata: {err}"))?;
        files.push(InboxProcessedRawFile {
            path: path.to_string_lossy().to_string(),
            rel_path: path
                .strip_prefix(item_dir)
                .unwrap_or(&path)
                .to_string_lossy()
                .to_string(),
            size_bytes: metadata.len(),
        });
    }
    files.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
    Ok(files)
}

fn latest_modified_time(paths: &[&Path]) -> Option<String> {
    paths
        .iter()
        .filter_map(|path| fs::metadata(path).ok())
        .filter_map(|metadata| metadata.modified().ok())
        .max()
        .map(DateTime::<Utc>::from)
        .map(|dt| dt.to_rfc3339())
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

    #[test]
    fn scan_processed_items_reads_done_failed_duplicate_and_excludes_pending_by_default() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        write_processed_item(root, "done", "a", "kakao", "Project A", "요약 A");
        write_processed_item(root, "failed", "b", "gws", "Project B", "요약 B");
        write_processed_item(root, "duplicate", "c", "mso", "Project C", "요약 C");
        fs::create_dir_all(root.join("inbox/items/pending/p")).unwrap();
        fs::write(
            root.join("inbox/items/pending/p/manifest.yaml"),
            "id: p\nstatus: pending\nchannel: kakao\n",
        )
        .unwrap();

        let items =
            scan_inbox_processed_items(root.to_string_lossy().to_string(), None, None, None)
                .unwrap();

        assert_eq!(items.len(), 3);
        assert!(items
            .iter()
            .any(|item| item.id == "a" && item.status == "done"));
        assert!(items.iter().all(|item| item.status != "pending"));
    }

    #[test]
    fn scan_processed_items_uses_custom_filenames_and_query() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "digest.md", "routing.md", "text.md");
        write_processed_item_custom(
            root,
            "done",
            "custom",
            "kakao",
            "digest.md",
            "routing.md",
            "text.md",
            "Special Project",
            "custom summary body",
        );

        let items = scan_inbox_processed_items(
            root.to_string_lossy().to_string(),
            Some(vec!["done".to_string()]),
            Some("special".to_string()),
            Some(10),
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert!(items[0]
            .summary_path
            .as_deref()
            .unwrap()
            .ends_with("digest.md"));
        assert_eq!(items[0].project.as_deref(), Some("Special Project"));
    }

    #[test]
    fn malformed_processed_manifest_returns_item_error() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        fs::create_dir_all(root.join("inbox/items/done/bad")).unwrap();
        fs::write(
            root.join("inbox/items/done/bad/manifest.yaml"),
            "id: [not-valid-for-struct\n",
        )
        .unwrap();

        let items =
            scan_inbox_processed_items(root.to_string_lossy().to_string(), None, None, None)
                .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "bad");
        assert!(items[0].error.as_deref().unwrap().contains("Cannot parse"));
    }

    #[test]
    fn processed_manifest_allows_file_entries_without_raw_path() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        let dir = root.join("inbox/items/done/no-raw");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.yaml"),
            r#"
id: no-raw
status: done
channel: kakao
files:
  - original_name: source.txt
"#,
        )
        .unwrap();
        fs::write(
            dir.join("summary.md"),
            "---\ntitle: no raw\n---\n\nsummary\n",
        )
        .unwrap();

        let items =
            scan_inbox_processed_items(root.to_string_lossy().to_string(), None, None, None)
                .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "no-raw");
        assert_eq!(items[0].raw_file_count, 0);
        assert!(items[0].error.is_none());
    }

    #[test]
    fn processed_manifest_uses_folder_fallbacks_for_missing_identity_fields() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        let dir = root.join("inbox/items/failed/missing-fields");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("manifest.yaml"), "files:\n  - original_name: source.txt\n").unwrap();
        fs::write(
            dir.join("summary.md"),
            "---\ndescription: field sparse item\n---\n\nsummary\n",
        )
        .unwrap();

        let items = scan_inbox_processed_items(
            root.to_string_lossy().to_string(),
            Some(vec!["failed".to_string()]),
            None,
            None,
        )
        .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "missing-fields");
        assert_eq!(items[0].title, "missing-fields");
        assert_eq!(items[0].status, "failed");
        assert_eq!(items[0].channel, "unknown");
        assert!(items[0].error.is_none());
    }

    #[test]
    fn read_processed_item_rejects_traversal_and_truncates_extracted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        write_processed_config(&root, "summary.md", "route.md", "extracted.md");
        write_processed_item(&root, "done", "large", "kakao", "Project", "요약");
        fs::write(
            root.join("inbox/items/done/large/extracted.md"),
            "x".repeat(220 * 1024),
        )
        .unwrap();
        let outside =
            read_inbox_processed_item(root.to_string_lossy().to_string(), "../outside".to_string())
                .unwrap_err();
        assert!(outside.contains("escapes"));

        let detail = read_inbox_processed_item(
            root.to_string_lossy().to_string(),
            root.join("inbox/items/done/large")
                .to_string_lossy()
                .to_string(),
        )
        .unwrap();
        assert!(detail.extracted_truncated);
        assert!(detail.extracted_text.unwrap().len() <= 200 * 1024);
    }

    fn write_processed_config(root: &Path, summary: &str, route: &str, extracted: &str) {
        fs::write(
            root.join("workspace.config.yaml"),
            format!(
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
    item_id_template: "{{date}}-{{channel}}-{{slug}}"
    raw_dir: raw
    manifest_file: manifest.yaml
    extracted_file: {extracted}
    summary_file: {summary}
    route_file: {route}
  channels:
    kakao:
      provider: kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - drop/kakao
"#
            ),
        )
        .unwrap();
    }

    fn write_processed_item(
        root: &Path,
        status: &str,
        id: &str,
        channel: &str,
        project: &str,
        summary_body: &str,
    ) {
        write_processed_item_custom(
            root,
            status,
            id,
            channel,
            "summary.md",
            "route.md",
            "extracted.md",
            project,
            summary_body,
        );
    }

    fn write_processed_item_custom(
        root: &Path,
        status: &str,
        id: &str,
        channel: &str,
        summary_name: &str,
        route_name: &str,
        extracted_name: &str,
        project: &str,
        summary_body: &str,
    ) {
        let dir = root.join("inbox/items").join(status).join(id);
        fs::create_dir_all(dir.join("raw")).unwrap();
        fs::write(dir.join("raw/input.txt"), b"raw").unwrap();
        fs::write(
            dir.join("manifest.yaml"),
            format!(
                "id: {id}\nstatus: {status}\nchannel: {channel}\nprovider: {channel}\nkind: bundle\nreceived_at: 2026-05-10T00:00:00Z\nfiles:\n  - path: raw/input.txt\nmetadata:\n  source_kind: message\n"
            ),
        )
        .unwrap();
        fs::write(
            dir.join(summary_name),
            format!(
                "---\ntitle: {id} title\nproject: {project}\ndescription: item description\n---\n\n{summary_body}\n"
            ),
        )
        .unwrap();
        fs::write(
            dir.join(route_name),
            "---\nclassification: reference\nroute_status: routed\n---\n\nroute\n",
        )
        .unwrap();
        fs::write(dir.join(extracted_name), "extracted").unwrap();
    }
}
