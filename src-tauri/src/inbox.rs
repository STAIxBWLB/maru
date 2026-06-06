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

/// One confirmed routing decision from the inbox batch review flow. `item_dir`
/// is the PENDING item directory (workspace-relative or absolute inside the
/// inbox). `accept` files raw originals into `destination` (if set) and promotes
/// the item to `done/`; `reject` moves it to `rejected/<channel>/`.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxApplyDecision {
    pub item_dir: String,
    pub decision: String,
    #[serde(default)]
    pub destination: Option<String>,
    #[serde(default)]
    pub classification: Option<String>,
    #[serde(default)]
    pub project: Option<String>,
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

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxTrashTarget {
    pub id: String,
    pub kind: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxTrashOutcome {
    pub id: String,
    pub kind: String,
    pub original_path: String,
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

/// Latest digest summary for a source channel, parsed from
/// `_state/digests/*.md` frontmatter (`inbox-digest/v1`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSourceDigest {
    pub generated_at: Option<String>,
    pub items_total: Option<u64>,
    pub items_high: Option<u64>,
    pub items_med: Option<u64>,
    pub items_low: Option<u64>,
    pub threads: Option<u64>,
    pub window_start: Option<String>,
    pub window_end: Option<String>,
    pub note: Option<String>,
}

/// Per-source processing run state, merged from `_state/sync-cursors.jsonl`
/// (last run per channel) and the latest `_state/digests/*.md` for that channel.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxSourceRun {
    pub channel: String,
    pub provider: Option<String>,
    pub account: Option<String>,
    pub last_run_at: Option<String>,
    pub last_run_kind: Option<String>,
    pub last_internal_date_iso: Option<String>,
    pub items_fetched: Option<u64>,
    pub items_new: Option<u64>,
    pub digest: Option<InboxSourceDigest>,
}

/// One line of `_state/sync-cursors.jsonl`. Disk keys are snake_case; unknown
/// fields (schema, last_message_id_*, digest path, …) are ignored.
#[derive(Debug, Default, Deserialize)]
struct SyncCursorLine {
    #[serde(default)]
    channel: Option<String>,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    account: Option<String>,
    #[serde(default)]
    last_run_at: Option<String>,
    #[serde(default)]
    last_run_kind: Option<String>,
    #[serde(default)]
    last_internal_date_iso: Option<String>,
    #[serde(default)]
    items_fetched: Option<u64>,
    #[serde(default)]
    items_new: Option<u64>,
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

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum ProcessedManifestFile {
    Path(String),
    Object {
        #[serde(default, rename = "path")]
        path: Option<String>,
    },
}

impl ProcessedManifestFile {
    fn path(&self) -> Option<&str> {
        match self {
            Self::Path(path) => Some(path.as_str()),
            Self::Object { path } => path.as_deref(),
        }
    }
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
const INBOX_FILE_TRASH_KIND: &str = "inbox.file.trash";
const INBOX_BULK_KIND: &str = "inbox.bulk";
const INBOX_ROUTE_KIND: &str = "inbox.route";

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
pub fn read_inbox_source_runs(work_path: String) -> Result<Vec<InboxSourceRun>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    read_source_runs_with_config(&work, &config)
}

/// Total processed items per channel across done/failed/duplicate, with no
/// status/query filter and no result cap. The dashboard source badges use this
/// so the per-source totals stay stable regardless of the search box or status
/// chip and do not silently cap at the processed-item list limit.
#[tauri::command]
pub fn count_inbox_processed_by_channel(
    work_path: String,
) -> Result<std::collections::HashMap<String, usize>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    count_processed_by_channel_with_config(&work, &config)
}

#[tauri::command]
pub fn trash_inbox_items(
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: String,
    targets: Vec<InboxTrashTarget>,
    approval_id: Option<String>,
) -> Result<Vec<InboxTrashOutcome>, String> {
    crate::approval::require_approval(&approvals, approval_id, INBOX_FILE_TRASH_KIND)?;
    let work = normalize_existing_dir(&work_path)?;
    assert_anchor_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Delete)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    Ok(trash_inbox_items_with(
        &work,
        &config,
        targets,
        move_path_to_system_trash,
    ))
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

/// Apply confirmed routing decisions for the inbox batch review flow. Each
/// pending item directory is moved as a whole (manifest + raw + extracted +
/// summary + route) — never a single file — so nothing is orphaned. A receipt
/// is appended per item to the configured `_state/index.jsonl`.
#[tauri::command]
pub fn apply_inbox_decisions(
    app: AppHandle,
    approvals: tauri::State<'_, crate::approval::ApprovalState>,
    work_path: String,
    decisions: Vec<InboxApplyDecision>,
    approval_id: Option<String>,
) -> Result<Vec<InboxDecisionOutcome>, String> {
    crate::approval::require_approval_any(
        &approvals,
        approval_id,
        &[INBOX_ROUTE_KIND, INBOX_BULK_KIND],
    )?;
    let work = normalize_existing_dir(&work_path)?;
    assert_anchor_can_write(&work.to_string_lossy(), WorkspaceWriteAction::RenameMove)?;
    let config = inbox_settings::load_runtime_config_or_legacy(&work)?;
    let root = inbox_settings::resolve_runtime_root(&work, &config)?;
    let mut outcomes = Vec::new();
    for decision in decisions {
        let event = if decision.decision == "reject" {
            "inbox://rejected"
        } else {
            "inbox://accepted"
        };
        let fallback_decision = apply_inbox_error_decision_label(&decision.decision);
        match apply_inbox_decision_at(&work, &config, &root, &decision) {
            Ok(outcome) => {
                emit_decision(&app, event, &outcome);
                outcomes.push(outcome);
            }
            Err(err) => outcomes.push(error_outcome(decision.item_dir, fallback_decision, err)),
        }
    }
    Ok(outcomes)
}

fn apply_inbox_error_decision_label(decision: &str) -> &'static str {
    match decision {
        "accept" => "accepted",
        "reject" => "rejected",
        _ => "pending",
    }
}

fn apply_inbox_decision_at(
    work: &Path,
    config: &InboxRuntimeConfig,
    root: &Path,
    decision: &InboxApplyDecision,
) -> Result<InboxDecisionOutcome, String> {
    let raw = PathBuf::from(&decision.item_dir);
    let item_dir = if raw.is_absolute() {
        inbox_settings::lexical_normalize_path(&raw)
    } else {
        resolve_inside_vault(&work.to_string_lossy(), &decision.item_dir)?
    };
    let item_metadata = fs::symlink_metadata(&item_dir).map_err(|err| {
        if err.kind() == std::io::ErrorKind::NotFound {
            "inbox_item_missing".to_string()
        } else {
            format!("Cannot inspect inbox item: {err}")
        }
    })?;
    if item_metadata.file_type().is_symlink() {
        return Err("inbox_item_symlink_unsupported".to_string());
    }
    if !item_metadata.is_dir() {
        return Err("inbox_item_not_directory".to_string());
    }
    if !is_pending_item_dir(work, config, &item_dir)? {
        return Err("inbox_item_not_pending".to_string());
    }
    let manifest_path = item_dir.join(&config.naming.manifest_file);
    let dir_name = item_dir
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "inbox_item_name_invalid".to_string())?
        .to_string();

    match decision.decision.as_str() {
        "accept" => {
            if let Some(dest) = decision
                .destination
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
            {
                let dest_dir = resolve_target_dir(work, dest)?;
                file_raw_originals(&item_dir, config, &dest_dir)?;
            }
            // Best-effort: stamp manifest status before moving the whole dir.
            let _ = set_manifest_status(&manifest_path, "done");
            let done_root = processed_status_dir(root, config, "done")?;
            fs::create_dir_all(&done_root)
                .map_err(|err| format!("Cannot create done directory: {err}"))?;
            let target = unique_path(done_root.join(&dir_name));
            move_source(&item_dir, &target, FileQueueSourceKind::Directory)?;
            append_inbox_receipt(root, config, "route", decision, &dir_name, Some(&target));
            Ok(decision_outcome(
                &decision.item_dir,
                "accepted",
                &item_dir,
                Some(&target),
            ))
        }
        "reject" => {
            let channel = read_manifest_channel(&manifest_path);
            let rejected_dir = rejected_item_target_dir(work, root, channel.as_deref())?;
            fs::create_dir_all(&rejected_dir)
                .map_err(|err| format!("Cannot create rejected directory: {err}"))?;
            let target = unique_path(rejected_dir.join(&dir_name));
            move_source(&item_dir, &target, FileQueueSourceKind::Directory)?;
            append_inbox_receipt(root, config, "reject", decision, &dir_name, Some(&target));
            Ok(decision_outcome(
                &decision.item_dir,
                "rejected",
                &item_dir,
                Some(&target),
            ))
        }
        other => Err(format!("inbox_unsupported_decision: {other}")),
    }
}

/// Copy raw originals from `<item>/<raw_dir>` into the destination project
/// folder. Copies (not moves) so the inbox `done/` item keeps its full record.
fn file_raw_originals(
    item_dir: &Path,
    config: &InboxRuntimeConfig,
    dest_dir: &Path,
) -> Result<(), String> {
    let raw_dir = item_dir.join(&config.naming.raw_dir);
    let raw_metadata = match fs::symlink_metadata(&raw_dir) {
        Ok(metadata) => metadata,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(err) => return Err(format!("Cannot inspect raw directory: {err}")),
    };
    if raw_metadata.file_type().is_symlink() {
        return Err(format!(
            "Source symlinks are not supported: {}",
            raw_dir.display()
        ));
    }
    if !raw_metadata.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(dest_dir)
        .map_err(|err| format!("Cannot create destination directory: {err}"))?;
    for entry in
        fs::read_dir(&raw_dir).map_err(|err| format!("Cannot read raw directory: {err}"))?
    {
        let entry = entry.map_err(|err| format!("Cannot read raw entry: {err}"))?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path)
            .map_err(|err| format!("Cannot inspect raw entry: {err}"))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "Source symlinks are not supported: {}",
                path.display()
            ));
        }
        let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        if name == ".DS_Store" {
            continue;
        }
        let kind = if metadata.is_dir() {
            FileQueueSourceKind::Directory
        } else if metadata.is_file() {
            FileQueueSourceKind::File
        } else {
            continue;
        };
        let target = unique_path(dest_dir.join(name));
        copy_source(&path, &target, kind)?;
    }
    Ok(())
}

/// Set `status:` in a pending manifest, preserving all other keys.
fn set_manifest_status(manifest_path: &Path, status: &str) -> Result<(), String> {
    let raw =
        fs::read_to_string(manifest_path).map_err(|err| format!("Cannot read manifest: {err}"))?;
    let mut value: YamlValue =
        serde_yaml::from_str(&raw).map_err(|err| format!("Cannot parse manifest: {err}"))?;
    if let YamlValue::Mapping(map) = &mut value {
        map.insert(
            YamlValue::String("status".to_string()),
            YamlValue::String(status.to_string()),
        );
    }
    let serialized =
        serde_yaml::to_string(&value).map_err(|err| format!("Cannot serialize manifest: {err}"))?;
    fs::write(manifest_path, serialized).map_err(|err| format!("Cannot write manifest: {err}"))?;
    Ok(())
}

fn read_manifest_channel(manifest_path: &Path) -> Option<String> {
    let raw = fs::read_to_string(manifest_path).ok()?;
    let manifest: PendingManifest = serde_yaml::from_str(&raw).ok()?;
    let channel = manifest.channel.trim().to_string();
    (!channel.is_empty()).then_some(channel)
}

/// Mirror of `rejected_target_dir` but for whole item directories: a sibling
/// `rejected/<channel>/` of the runtime inbox root, kept inside the workspace.
fn rejected_item_target_dir(
    work: &Path,
    root: &Path,
    channel: Option<&str>,
) -> Result<PathBuf, String> {
    let base = root
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .map(|parent| parent.join("rejected"))
        .unwrap_or_else(|| PathBuf::from("rejected"));
    let target = match channel {
        Some(channel) if !channel.is_empty() => base.join(channel),
        _ => base,
    };
    resolve_target_dir(work, &target.to_string_lossy())
}

fn decision_outcome(
    id: &str,
    decision: &str,
    source: &Path,
    target: Option<&Path>,
) -> InboxDecisionOutcome {
    InboxDecisionOutcome {
        id: id.to_string(),
        decision: decision.to_string(),
        source_path: source.to_string_lossy().to_string(),
        target_path: target.map(|path| path.to_string_lossy().to_string()),
        file_name: target
            .and_then(|path| path.file_name())
            .and_then(|value| value.to_str())
            .map(str::to_string),
        ok: true,
        error: None,
    }
}

/// Append a single JSON receipt line to the configured `_state/index.jsonl`.
/// Best-effort: a receipt failure must not roll back a successful move.
fn append_inbox_receipt(
    root: &Path,
    config: &InboxRuntimeConfig,
    event: &str,
    decision: &InboxApplyDecision,
    item_id: &str,
    dest: Option<&Path>,
) {
    let receipts_path = inbox_settings::lexical_normalize_path(&root.join(&config.paths.receipts));
    if let Some(parent) = receipts_path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let record = serde_json::json!({
        "schema": "inbox-receipt/v1",
        "event": event,
        "item_id": item_id,
        "status": if event == "route" { "done" } else { "rejected" },
        "classification": decision.classification,
        "project": decision.project,
        "dest": dest.map(|path| path.to_string_lossy().to_string()),
        "created_at": Utc::now().to_rfc3339(),
    });
    if let Ok(line) = serde_json::to_string(&record) {
        use std::io::Write;
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&receipts_path)
        {
            let _ = writeln!(file, "{line}");
        }
    }
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

struct DigestEntry {
    channel: String,
    provider: Option<String>,
    account: Option<String>,
    digest: InboxSourceDigest,
}

fn read_source_runs_with_config(
    work: &Path,
    config: &InboxRuntimeConfig,
) -> Result<Vec<InboxSourceRun>, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let state_dir = inbox_settings::lexical_normalize_path(&root.join(&config.paths.state));
    if !state_dir.starts_with(&root) {
        return Err("inbox_state_path_outside_inbox".to_string());
    }

    // Cursors: keep the last entry per channel (file is append-ordered).
    let mut cursors: Vec<(String, SyncCursorLine)> = Vec::new();
    let cursor_path = state_dir.join("sync-cursors.jsonl");
    if cursor_path.is_file() {
        let raw = fs::read_to_string(&cursor_path)
            .map_err(|err| format!("Cannot read inbox sync cursors: {err}"))?;
        for line in raw.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            // Malformed lines are skipped rather than failing the whole read.
            let Ok(parsed) = serde_json::from_str::<SyncCursorLine>(trimmed) else {
                continue;
            };
            let Some(channel) = parsed.channel.clone() else {
                continue;
            };
            match cursors
                .iter_mut()
                .find(|(existing, _)| *existing == channel)
            {
                Some(slot) => slot.1 = parsed,
                None => cursors.push((channel, parsed)),
            }
        }
    }

    // Digests: keep the latest per channel by `generated_at` (RFC3339 string compare).
    let mut digests: Vec<DigestEntry> = Vec::new();
    let digest_dir = state_dir.join("digests");
    if digest_dir.is_dir() {
        let read_dir =
            fs::read_dir(&digest_dir).map_err(|err| format!("Cannot scan inbox digests: {err}"))?;
        for entry in read_dir {
            let entry = entry.map_err(|err| format!("Cannot scan inbox digest: {err}"))?;
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("md") {
                continue;
            }
            let Ok(raw) = fs::read_to_string(&path) else {
                continue;
            };
            let (frontmatter, _) = split_markdown_frontmatter(&raw);
            let fm = frontmatter.as_ref();
            let Some(channel) = yaml_string(fm, "channel") else {
                continue;
            };
            let parsed = DigestEntry {
                channel: channel.clone(),
                provider: yaml_string(fm, "provider"),
                account: yaml_string(fm, "account"),
                digest: InboxSourceDigest {
                    generated_at: yaml_string(fm, "generated_at"),
                    items_total: yaml_u64(fm, "items_total"),
                    items_high: yaml_u64(fm, "items_high"),
                    items_med: yaml_u64(fm, "items_med"),
                    items_low: yaml_u64(fm, "items_low"),
                    threads: yaml_u64(fm, "threads"),
                    window_start: yaml_nested_string(fm, "window", "start"),
                    window_end: yaml_nested_string(fm, "window", "end"),
                    note: yaml_string(fm, "note"),
                },
            };
            match digests
                .iter_mut()
                .find(|existing| existing.channel == channel)
            {
                Some(slot)
                    if digest_generated_after(
                        &parsed.digest.generated_at,
                        &slot.digest.generated_at,
                    ) =>
                {
                    *slot = parsed
                }
                Some(_) => {}
                None => digests.push(parsed),
            }
        }
    }

    // Channel set = union(cursor channels, digest channels).
    let mut channels: Vec<String> = Vec::new();
    for (channel, _) in &cursors {
        if !channels.contains(channel) {
            channels.push(channel.clone());
        }
    }
    for entry in &digests {
        if !channels.contains(&entry.channel) {
            channels.push(entry.channel.clone());
        }
    }

    let mut runs: Vec<InboxSourceRun> = channels
        .into_iter()
        .map(|channel| {
            let cursor = cursors
                .iter()
                .find(|(existing, _)| *existing == channel)
                .map(|(_, value)| value);
            let digest_entry = digests.iter().find(|entry| entry.channel == channel);
            InboxSourceRun {
                channel: channel.clone(),
                // Prefer the cursor's provider/account, fall back to the digest frontmatter.
                provider: cursor
                    .and_then(|c| c.provider.clone())
                    .or_else(|| digest_entry.and_then(|d| d.provider.clone())),
                account: cursor
                    .and_then(|c| c.account.clone())
                    .or_else(|| digest_entry.and_then(|d| d.account.clone())),
                last_run_at: cursor.and_then(|c| c.last_run_at.clone()),
                last_run_kind: cursor.and_then(|c| c.last_run_kind.clone()),
                last_internal_date_iso: cursor.and_then(|c| c.last_internal_date_iso.clone()),
                items_fetched: cursor.and_then(|c| c.items_fetched),
                items_new: cursor.and_then(|c| c.items_new),
                digest: digest_entry.map(|d| d.digest.clone()),
            }
        })
        .collect();

    runs.sort_by(|a, b| {
        b.last_run_at
            .cmp(&a.last_run_at)
            .then_with(|| a.channel.cmp(&b.channel))
    });
    Ok(runs)
}

fn count_processed_by_channel_with_config(
    work: &Path,
    config: &InboxRuntimeConfig,
) -> Result<std::collections::HashMap<String, usize>, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let mut counts: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for status in ["done", "failed", "duplicate"] {
        let status_dir = processed_status_dir(&root, config, status)?;
        if !status_dir.is_dir() {
            continue;
        }
        let read_dir = fs::read_dir(&status_dir)
            .map_err(|err| format!("Cannot scan inbox processed items: {err}"))?;
        for entry in read_dir {
            let entry = entry.map_err(|err| format!("Cannot scan inbox processed item: {err}"))?;
            if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            let manifest_path = entry.path().join(&config.naming.manifest_file);
            let channel = read_processed_channel(&manifest_path);
            *counts.entry(channel).or_insert(0) += 1;
        }
    }
    Ok(counts)
}

/// Channel for a processed item, matching `build_processed_item`'s resolution
/// (manifest `channel`, trimmed, falling back to `"unknown"`).
fn read_processed_channel(manifest_path: &Path) -> String {
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|raw| serde_yaml::from_str::<ProcessedManifest>(&raw).ok())
        .and_then(|manifest| manifest.channel)
        .map(|channel| channel.trim().to_string())
        .filter(|channel| !channel.is_empty())
        .unwrap_or_else(|| "unknown".to_string())
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

fn trash_inbox_items_with<F>(
    work: &Path,
    config: &InboxRuntimeConfig,
    targets: Vec<InboxTrashTarget>,
    mut trasher: F,
) -> Vec<InboxTrashOutcome>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    targets
        .into_iter()
        .map(|target| {
            let kind = target.kind.clone();
            let id = target.id.clone();
            match resolve_inbox_trash_target(work, config, &target) {
                Ok(path) => {
                    let original_path = path.to_string_lossy().to_string();
                    match trasher(&path) {
                        Ok(()) => InboxTrashOutcome {
                            id,
                            kind,
                            original_path,
                            ok: true,
                            error: None,
                        },
                        Err(err) => InboxTrashOutcome {
                            id,
                            kind,
                            original_path,
                            ok: false,
                            error: Some(err),
                        },
                    }
                }
                Err(err) => InboxTrashOutcome {
                    id,
                    kind,
                    original_path: target.path,
                    ok: false,
                    error: Some(err),
                },
            }
        })
        .collect()
}

fn resolve_inbox_trash_target(
    work: &Path,
    config: &InboxRuntimeConfig,
    target: &InboxTrashTarget,
) -> Result<PathBuf, String> {
    let raw_path = target.path.trim();
    if raw_path.is_empty() {
        return Err("inbox_trash_path_required".to_string());
    }
    let path = resolve_inside_vault(&work.to_string_lossy(), raw_path)?;
    if !path.exists() {
        return Err("inbox_trash_target_missing".to_string());
    }
    reject_symlink_trash_target(&path)?;

    match target.kind.as_str() {
        "dropFile" => {
            if !path.is_file() {
                return Err("inbox_trash_drop_file_not_file".to_string());
            }
            if !is_configured_drop_file(work, config, &path)? {
                return Err("inbox_trash_drop_file_outside_configured_roots".to_string());
            }
        }
        "pendingItem" => {
            if !path.is_dir() {
                return Err("inbox_trash_pending_item_not_directory".to_string());
            }
            if !is_pending_item_dir(work, config, &path)? {
                return Err("inbox_trash_pending_item_outside_pending_root".to_string());
            }
        }
        "processedItem" => {
            if !path.is_dir() {
                return Err("inbox_trash_processed_item_not_directory".to_string());
            }
            if !is_processed_item_dir(work, config, &path)? {
                return Err("inbox_trash_processed_item_outside_processed_roots".to_string());
            }
        }
        other => return Err(format!("inbox_trash_kind_unsupported: {other}")),
    }

    Ok(path)
}

fn reject_symlink_trash_target(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|err| format!("Cannot inspect inbox trash target: {err}"))?;
    if metadata.file_type().is_symlink() {
        return Err("inbox_trash_target_symlink_unsupported".to_string());
    }
    Ok(())
}

fn is_configured_drop_file(
    work: &Path,
    config: &InboxRuntimeConfig,
    path: &Path,
) -> Result<bool, String> {
    let settings = inbox_settings::load(work);
    let legacy_root = resolve_inside_vault(&work.to_string_lossy(), settings.inbox_root.as_str())?;
    if path.starts_with(&legacy_root) {
        return Ok(true);
    }

    let runtime_root = inbox_settings::resolve_runtime_root(work, config)?;
    let mut drop_roots = Vec::new();
    for channel in config.channels.values() {
        for drop_path in &channel.drop_paths {
            drop_roots.push(runtime_drop_root(&runtime_root, drop_path)?);
        }
    }
    drop_roots.push(runtime_drop_root(
        &runtime_root,
        &config.file_drop.drop_path,
    )?);
    Ok(drop_roots.into_iter().any(|root| path.starts_with(root)))
}

fn runtime_drop_root(runtime_root: &Path, drop_path: &str) -> Result<PathBuf, String> {
    let root = inbox_settings::lexical_normalize_path(&runtime_root.join(drop_path));
    if !root.starts_with(runtime_root) {
        return Err(format!("inbox_drop_path_outside_root: {drop_path}"));
    }
    Ok(root)
}

fn is_pending_item_dir(
    work: &Path,
    config: &InboxRuntimeConfig,
    path: &Path,
) -> Result<bool, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    let pending_root = processed_status_dir(&root, config, "pending")?;
    if path == pending_root || !path.starts_with(&pending_root) {
        return Ok(false);
    }
    Ok(path.join(&config.naming.manifest_file).is_file())
}

fn is_processed_item_dir(
    work: &Path,
    config: &InboxRuntimeConfig,
    path: &Path,
) -> Result<bool, String> {
    let root = inbox_settings::resolve_runtime_root(work, config)?;
    for status in ["done", "failed", "duplicate"] {
        let status_dir = processed_status_dir(&root, config, status)?;
        if path.parent() == Some(status_dir.as_path()) {
            return Ok(true);
        }
    }
    Ok(false)
}

fn move_path_to_system_trash(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        let mut context = trash::TrashContext::new();
        context.set_delete_method(DeleteMethod::NsFileManager);
        context
            .delete(path)
            .map_err(|err| format!("Cannot move inbox item to system trash: {err}"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        trash::delete(path).map_err(|err| format!("Cannot move inbox item to system trash: {err}"))
    }
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
        .filter(|file| {
            file.path()
                .map(str::trim)
                .is_some_and(|path| !path.is_empty())
        })
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

fn yaml_u64(value: Option<&YamlValue>, key: &str) -> Option<u64> {
    let YamlValue::Mapping(map) = value? else {
        return None;
    };
    match map.get(YamlValue::String(key.to_string()))? {
        YamlValue::Number(number) => number.as_u64(),
        YamlValue::String(text) => text.trim().parse::<u64>().ok(),
        _ => None,
    }
}

fn yaml_nested_string(value: Option<&YamlValue>, outer: &str, inner: &str) -> Option<String> {
    let YamlValue::Mapping(map) = value? else {
        return None;
    };
    let nested = map.get(YamlValue::String(outer.to_string()))?;
    yaml_string(Some(nested), inner)
}

/// True when `candidate`'s `generated_at` is chronologically newer than
/// `current`'s. Parses RFC3339 so digests with different offsets/precision
/// (e.g. `…+09:00` vs `…Z`) compare by instant, not lexical string order;
/// falls back to lexical compare only when both timestamps are unparseable.
fn digest_generated_after(candidate: &Option<String>, current: &Option<String>) -> bool {
    let parse = |value: &Option<String>| {
        value
            .as_deref()
            .and_then(|raw| DateTime::parse_from_rfc3339(raw).ok())
    };
    match (parse(candidate), parse(current)) {
        (Some(c), Some(cur)) => c > cur,
        (Some(_), None) => true,
        (None, Some(_)) => false,
        (None, None) => candidate > current,
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
    use std::collections::BTreeMap;
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
    fn read_source_runs_reads_cursors_and_latest_digest() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        fs::create_dir_all(root.join("inbox/_state/digests")).unwrap();
        fs::write(
            root.join("inbox/_state/sync-cursors.jsonl"),
            concat!(
                r#"{"schema":"sync-cursor/v1","channel":"gws","provider":"gmail","account":"a@b","last_run_at":"2026-05-10T00:00:00+09:00","last_run_kind":"full","items_fetched":10,"items_new":2}"#,
                "\n",
                r#"{"schema":"sync-cursor/v1","channel":"gws","provider":"gmail","account":"a@b","last_run_at":"2026-05-20T00:00:00+09:00","last_run_kind":"incremental","last_internal_date_iso":"2026-05-19T23:55:00+09:00","items_fetched":31,"items_new":7}"#,
                "\n",
                r#"{"schema":"sync-cursor/v1","channel":"mso","provider":"mso","account":"c@d","last_run_at":"2026-05-15T00:00:00+09:00","items_fetched":4,"items_new":1}"#,
                "\n",
                "not-json-should-be-skipped\n",
            ),
        )
        .unwrap();
        fs::write(
            root.join("inbox/_state/digests/260520-gws-incr-digest.md"),
            concat!(
                "---\n",
                "schema: inbox-digest/v1\n",
                "channel: gws\n",
                "provider: gmail\n",
                "account: a@b\n",
                "kind: incremental\n",
                "window:\n",
                "  start: \"2026-05-19T00:00:00+09:00\"\n",
                "  end: \"2026-05-20T00:00:00+09:00\"\n",
                "generated_at: \"2026-05-20T01:00:00+09:00\"\n",
                "items_total: 7\n",
                "items_high: 3\n",
                "items_med: 2\n",
                "items_low: 2\n",
                "threads: 7\n",
                "note: hello\n",
                "---\n\n# Digest\n",
            ),
        )
        .unwrap();

        let runs = read_inbox_source_runs(root.to_string_lossy().to_string()).unwrap();

        let gws = runs
            .iter()
            .find(|run| run.channel == "gws")
            .expect("gws run");
        // Newer cursor line wins.
        assert_eq!(gws.items_new, Some(7));
        assert_eq!(gws.items_fetched, Some(31));
        assert_eq!(gws.last_run_kind.as_deref(), Some("incremental"));
        assert_eq!(gws.provider.as_deref(), Some("gmail"));
        let digest = gws.digest.as_ref().expect("gws digest");
        assert_eq!(digest.items_total, Some(7));
        assert_eq!(digest.items_high, Some(3));
        assert_eq!(
            digest.window_start.as_deref(),
            Some("2026-05-19T00:00:00+09:00")
        );
        assert!(runs.iter().any(|run| run.channel == "mso"));
        // gws has the most recent last_run_at → sorted first.
        assert_eq!(runs[0].channel, "gws");
    }

    #[test]
    fn read_source_runs_returns_empty_when_state_absent() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");

        let runs = read_inbox_source_runs(root.to_string_lossy().to_string()).unwrap();

        assert!(runs.is_empty());
    }

    #[test]
    fn count_processed_by_channel_aggregates_all_statuses_unfiltered() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        write_processed_item(root, "done", "a", "gws", "P", "summary a");
        write_processed_item(root, "done", "b", "gws", "P", "summary b");
        write_processed_item(root, "failed", "c", "mso", "P", "summary c");
        write_processed_item(root, "duplicate", "d", "kakao", "P", "summary d");

        let counts = count_inbox_processed_by_channel(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(counts.get("gws"), Some(&2));
        assert_eq!(counts.get("mso"), Some(&1));
        assert_eq!(counts.get("kakao"), Some(&1));
        assert_eq!(counts.values().sum::<usize>(), 4);
    }

    #[test]
    fn digest_generated_after_compares_instants_across_offsets() {
        // 00:30Z is later than 09:00+09:00 (== 00:00Z) despite smaller wall-clock text.
        assert!(digest_generated_after(
            &Some("2026-05-20T00:30:00Z".to_string()),
            &Some("2026-05-20T09:00:00+09:00".to_string()),
        ));
        assert!(!digest_generated_after(
            &Some("2026-05-20T09:00:00+09:00".to_string()),
            &Some("2026-05-20T00:30:00Z".to_string()),
        ));
        assert!(digest_generated_after(
            &Some("2026-05-20T00:00:00Z".to_string()),
            &None
        ));
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
    fn processed_manifest_accepts_string_file_entries_as_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        let dir = root.join("inbox/items/done/string-file");
        fs::create_dir_all(dir.join("source")).unwrap();
        fs::write(dir.join("source/meeting-note.md"), "# meeting\n").unwrap();
        fs::write(
            dir.join("manifest.yaml"),
            r#"
id: string-file
status: done
channel: meeting
files:
  - source/meeting-note.md
"#,
        )
        .unwrap();
        fs::write(
            dir.join("summary.md"),
            "---\ntitle: string file\n---\n\nsummary\n",
        )
        .unwrap();

        let items =
            scan_inbox_processed_items(root.to_string_lossy().to_string(), None, None, None)
                .unwrap();

        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "string-file");
        assert_eq!(items[0].title, "string file");
        assert_eq!(items[0].raw_file_count, 1);
        assert!(items[0].error.is_none());
    }

    #[test]
    fn processed_manifest_uses_folder_fallbacks_for_missing_identity_fields() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        write_processed_config(root, "summary.md", "route.md", "extracted.md");
        let dir = root.join("inbox/items/failed/missing-fields");
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("manifest.yaml"),
            "files:\n  - original_name: source.txt\n",
        )
        .unwrap();
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

    #[test]
    fn trash_inbox_items_validates_and_trashes_local_inbox_targets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let config = runtime_config_with_kakao_drop();
        let drop_file = root.join("inbox/drop/kakao/chat.txt");
        let pending_dir = root.join("inbox/items/pending/pending-a");
        let processed_dir = root.join("inbox/items/done/done-a");
        fs::create_dir_all(drop_file.parent().unwrap()).unwrap();
        fs::write(&drop_file, b"chat").unwrap();
        fs::create_dir_all(&pending_dir).unwrap();
        fs::write(
            pending_dir.join("manifest.yaml"),
            "id: pending-a\nstatus: pending\nchannel: kakao\n",
        )
        .unwrap();
        fs::create_dir_all(&processed_dir).unwrap();
        fs::write(
            processed_dir.join("manifest.yaml"),
            "id: done-a\nstatus: done\nchannel: kakao\n",
        )
        .unwrap();

        let mut trashed = Vec::new();
        let outcomes = trash_inbox_items_with(
            &root,
            &config,
            vec![
                trash_target("drop", "dropFile", &drop_file),
                trash_target("pending", "pendingItem", &pending_dir),
                trash_target("processed", "processedItem", &processed_dir),
            ],
            |path| {
                trashed.push(path.to_path_buf());
                remove_for_test(path)
            },
        );

        assert!(outcomes.iter().all(|outcome| outcome.ok));
        assert_eq!(trashed, vec![drop_file, pending_dir, processed_dir]);
        assert!(outcomes
            .iter()
            .all(|outcome| !outcome.original_path.is_empty()));
    }

    #[test]
    fn trash_inbox_items_rejects_outside_missing_and_wrong_kind_targets() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let outside = TempDir::new().unwrap();
        let outside_file = outside.path().join("outside.txt");
        fs::write(&outside_file, b"outside").unwrap();
        let config = runtime_config_with_kakao_drop();
        let drop_file = root.join("inbox/drop/kakao/chat.txt");
        fs::create_dir_all(drop_file.parent().unwrap()).unwrap();
        fs::write(&drop_file, b"chat").unwrap();

        let outcomes = trash_inbox_items_with(
            &root,
            &config,
            vec![
                trash_target("outside", "dropFile", &outside_file),
                InboxTrashTarget {
                    id: "missing".to_string(),
                    kind: "dropFile".to_string(),
                    path: "inbox/drop/kakao/missing.txt".to_string(),
                },
                trash_target("wrong", "pendingItem", &drop_file),
            ],
            |_| Ok(()),
        );

        assert_eq!(outcomes.len(), 3);
        assert!(outcomes.iter().all(|outcome| !outcome.ok));
        assert!(outcomes[0].error.as_deref().unwrap().contains("escapes"));
        assert_eq!(
            outcomes[1].error.as_deref(),
            Some("inbox_trash_target_missing")
        );
        assert_eq!(
            outcomes[2].error.as_deref(),
            Some("inbox_trash_pending_item_not_directory")
        );
    }

    #[cfg(unix)]
    #[test]
    fn trash_inbox_items_rejects_symlink_targets() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let config = runtime_config_with_kakao_drop();
        fs::create_dir_all(root.join("inbox/drop/kakao")).unwrap();
        let real = root.join("inbox/drop/kakao/real.txt");
        let link = root.join("inbox/drop/kakao/link.txt");
        fs::write(&real, b"real").unwrap();
        symlink(&real, &link).unwrap();

        let outcomes = trash_inbox_items_with(
            &root,
            &config,
            vec![trash_target("link", "dropFile", &link)],
            |_| Ok(()),
        );

        assert_eq!(outcomes.len(), 1);
        assert!(!outcomes[0].ok);
        assert_eq!(
            outcomes[0].error.as_deref(),
            Some("inbox_trash_target_symlink_unsupported")
        );
        assert!(link.exists());
    }

    #[test]
    fn trash_inbox_items_keeps_batch_failures_per_item() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let config = runtime_config_with_kakao_drop();
        let drop_file = root.join("inbox/drop/kakao/chat.txt");
        fs::create_dir_all(drop_file.parent().unwrap()).unwrap();
        fs::write(&drop_file, b"chat").unwrap();

        let outcomes = trash_inbox_items_with(
            &root,
            &config,
            vec![
                trash_target("ok", "dropFile", &drop_file),
                InboxTrashTarget {
                    id: "missing".to_string(),
                    kind: "dropFile".to_string(),
                    path: "inbox/drop/kakao/missing.txt".to_string(),
                },
            ],
            remove_for_test,
        );

        assert_eq!(outcomes.len(), 2);
        assert!(outcomes[0].ok);
        assert!(!outcomes[1].ok);
        assert!(!drop_file.exists());
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

    fn runtime_config_with_kakao_drop() -> InboxRuntimeConfig {
        let mut config = InboxRuntimeConfig::default();
        config.channels.insert(
            "kakao".to_string(),
            inbox_settings::InboxChannelConfig {
                provider: "local".to_string(),
                skill: None,
                kind: "file".to_string(),
                drop_paths: vec!["drop/kakao".to_string()],
                source_kinds: BTreeMap::new(),
                dedupe: "sha256".to_string(),
                extra: BTreeMap::new(),
            },
        );
        config
    }

    fn trash_target(id: &str, kind: &str, path: &Path) -> InboxTrashTarget {
        InboxTrashTarget {
            id: id.to_string(),
            kind: kind.to_string(),
            path: path.to_string_lossy().to_string(),
        }
    }

    fn remove_for_test(path: &Path) -> Result<(), String> {
        if path.is_dir() {
            fs::remove_dir_all(path).map_err(|err| format!("remove dir failed: {err}"))
        } else {
            fs::remove_file(path).map_err(|err| format!("remove file failed: {err}"))
        }
    }

    const APPLY_CONFIG: &str = r#"
inbox:
  root: inbox
  channels:
    kakao:
      provider: kakao
      kind: bundle
      dedupe: sha256
      drop_paths:
        - drop/kakao
"#;

    fn apply_fixture(root: &Path, id: &str) -> PathBuf {
        fs::write(root.join("workspace.config.yaml"), APPLY_CONFIG).unwrap();
        let item = root.join(format!("inbox/items/pending/{id}"));
        fs::create_dir_all(item.join("raw")).unwrap();
        fs::write(
            item.join("manifest.yaml"),
            format!("id: {id}\nstatus: pending\nchannel: kakao\n"),
        )
        .unwrap();
        fs::write(item.join("raw/chat.txt"), b"hello").unwrap();
        fs::write(item.join("summary.md"), b"# summary").unwrap();
        item
    }

    #[test]
    fn apply_inbox_decision_labels_unsupported_apply_error_as_pending() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let item = apply_fixture(&root, "260604-kakao-unsupported");

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: "inbox/items/pending/260604-kakao-unsupported".to_string(),
            decision: "defer".to_string(),
            destination: Some("projects/rise/inbox".to_string()),
            classification: Some("action".to_string()),
            project: Some("rise".to_string()),
        };

        let err = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap_err();
        let fallback_label = apply_inbox_error_decision_label(&decision.decision);
        let outcome = error_outcome(decision.item_dir.clone(), fallback_label, err);

        assert!(!outcome.ok);
        assert_eq!(outcome.decision, "pending");
        assert!(outcome.target_path.is_none());
        assert!(outcome
            .error
            .as_deref()
            .is_some_and(|err| err.contains("inbox_unsupported_decision")));
        assert!(item.exists());
        assert!(!root
            .join("inbox/items/done/260604-kakao-unsupported")
            .exists());
        assert!(!root
            .join("rejected/kakao/260604-kakao-unsupported")
            .exists());
    }

    #[test]
    fn apply_inbox_decision_routes_accept_files_and_records_receipt() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let item = apply_fixture(&root, "260604-kakao-a");

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: "inbox/items/pending/260604-kakao-a".to_string(),
            decision: "accept".to_string(),
            destination: Some("projects/rise/inbox".to_string()),
            classification: Some("action".to_string()),
            project: Some("rise".to_string()),
        };

        let outcome = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap();
        assert!(outcome.ok);
        assert_eq!(outcome.decision, "accepted");

        // Pending dir promoted to done/ as a whole, nothing orphaned.
        assert!(!item.exists());
        let done_item = root.join("inbox/items/done/260604-kakao-a");
        assert!(done_item.join("manifest.yaml").is_file());
        assert!(done_item.join("summary.md").is_file());
        assert!(done_item.join("raw/chat.txt").is_file());

        // Manifest status stamped done.
        let manifest = fs::read_to_string(done_item.join("manifest.yaml")).unwrap();
        assert!(manifest.contains("status: done"));

        // Raw original filed into the destination project folder.
        assert!(root.join("projects/rise/inbox/chat.txt").is_file());

        // Receipt appended.
        let receipts = fs::read_to_string(root.join("inbox/_state/index.jsonl")).unwrap();
        assert!(receipts.contains("\"event\":\"route\""));
        assert!(receipts.contains("260604-kakao-a"));
    }

    #[test]
    fn apply_inbox_decision_reject_moves_item_to_rejected_channel() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let item = apply_fixture(&root, "260604-kakao-b");

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: item.to_string_lossy().to_string(),
            decision: "reject".to_string(),
            destination: None,
            classification: None,
            project: None,
        };

        let outcome = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap();
        assert_eq!(outcome.decision, "rejected");
        assert!(!item.exists());
        assert!(root.join("rejected/kakao/260604-kakao-b").is_dir());
    }

    #[cfg(unix)]
    #[test]
    fn apply_inbox_decision_rejects_symlink_pending_item_dir() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::write(root.join("workspace.config.yaml"), APPLY_CONFIG).unwrap();
        let real = root.join("real-pending-target");
        fs::create_dir_all(&real).unwrap();
        fs::write(
            real.join("manifest.yaml"),
            "id: 260604-kakao-link\nstatus: pending\nchannel: kakao\n",
        )
        .unwrap();
        let link = root.join("inbox/items/pending/260604-kakao-link");
        fs::create_dir_all(link.parent().unwrap()).unwrap();
        symlink(&real, &link).unwrap();

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: "inbox/items/pending/260604-kakao-link".to_string(),
            decision: "reject".to_string(),
            destination: None,
            classification: None,
            project: None,
        };

        let err = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap_err();
        assert_eq!(err, "inbox_item_symlink_unsupported");
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(real.is_dir());
        assert!(!root.join("rejected/kakao/260604-kakao-link").exists());
    }

    #[cfg(unix)]
    #[test]
    fn apply_inbox_decision_rejects_raw_symlink_entries() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        let item = apply_fixture(&root, "260604-kakao-raw-link");
        fs::remove_file(item.join("raw/chat.txt")).unwrap();
        let outside = root.join("outside-secret.txt");
        fs::write(&outside, b"secret").unwrap();
        symlink(&outside, item.join("raw/leak.txt")).unwrap();

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: "inbox/items/pending/260604-kakao-raw-link".to_string(),
            decision: "accept".to_string(),
            destination: Some("projects/rise/inbox".to_string()),
            classification: Some("action".to_string()),
            project: Some("rise".to_string()),
        };

        let err = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap_err();
        assert!(err.contains("Source symlinks are not supported"));
        assert!(item.exists());
        assert!(!root.join("inbox/items/done/260604-kakao-raw-link").exists());
        assert!(!root.join("projects/rise/inbox/leak.txt").exists());
    }

    #[test]
    fn apply_inbox_decision_rejects_non_pending_dir() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().canonicalize().unwrap();
        fs::write(root.join("workspace.config.yaml"), APPLY_CONFIG).unwrap();
        let stray = root.join("inbox/items/done/stray");
        fs::create_dir_all(&stray).unwrap();
        fs::write(
            stray.join("manifest.yaml"),
            "id: x\nstatus: done\nchannel: kakao\n",
        )
        .unwrap();

        let config = inbox_settings::load_runtime_config_or_legacy(&root).unwrap();
        let inbox_root = inbox_settings::resolve_runtime_root(&root, &config).unwrap();
        let decision = InboxApplyDecision {
            item_dir: "inbox/items/done/stray".to_string(),
            decision: "accept".to_string(),
            destination: None,
            classification: None,
            project: None,
        };

        let err = apply_inbox_decision_at(&root, &config, &inbox_root, &decision).unwrap_err();
        assert_eq!(err, "inbox_item_not_pending");
    }
}
