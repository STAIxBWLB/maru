// Maru Desktop — consumer for `maru.web-task-action.v1` receipts.
//
// The Maru web app commits task mutations straight into the workspace repo
// but never performs external side effects. A mutation that needs one (a
// Google Tasks completion, a Google Task upsert) commits a receipt at
// `shared/web/task-actions/pending/YYYY-MM/<uuid>.yaml` in the same atomic
// commit as the task change. After `git pull`, the desktop validates those
// receipts and applies them through the paths it already owns — the task
// lifecycle (today_lifecycle.rs) and the integration outbox
// (today_outbox.rs) — then moves the receipt to `applied/YYYY-MM/`.
//
// Three rules are load-bearing:
// - Explicit, never automatic. Applying is a user-invoked command. It never
//   stages, commits, or pushes; the pending -> applied move is a working-tree
//   change that rides the user's normal Git Sync cadence.
// - Fail closed on the task path. The receipt is written by a remote actor,
//   so the path goes through traversal/dotfile/secret-shape/bucket checks
//   before anything reads or writes it.
// - Never apply a stale receipt. `expectedTaskBlobSha` is the git blob sha of
//   the task content the web committed; if the local file no longer hashes to
//   it, the local copy diverged and the receipt is marked `retry-needed` in
//   place instead of being applied.

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::document::revision_for;
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::ipc_error::{IpcError, TODAY_CONFLICT, WEB_ACTION_REPAIR_CONFLICT};
use crate::tasks::{
    normalize_task_frontmatter_aliases, string_field, task_display_title, yaml_to_json, TaskBucket,
};
use crate::today::{
    CalendarSyncState, DailyPlanItem, DailyPlanV1, PlanItemRef, PlanLane, TaskTransitionKind,
    TaskTransitionRequest, TodayMutation, TOP_LANE_DEFAULT, TOP_LANE_MAX,
};
use crate::today_lifecycle::{move_file, task_transition_in_transaction};
use crate::today_outbox::{
    enqueue_record_in_transaction, has_unusable_task_list_linkage, has_web_action, read_record,
    record_revision, write_record_in_transaction, OutboxOp, OutboxRecordDraft, OutboxStatus,
    UpsertPayload,
};
use crate::today_store::{
    load_snapshot, today_mutate_in_transaction, JOURNAL_END_MARKER, JOURNAL_START_MARKER,
};
use crate::vault::{normalize_existing_dir, parse_frontmatter, resolve_inside_vault};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;

pub const WEB_ACTION_SCHEMA_VERSION: &str = "maru.web-task-action.v1";

const PENDING_ROOT: &str = "shared/web/task-actions/pending";
const APPLIED_ROOT: &str = "shared/web/task-actions/applied";

/// Marker written into a pending receipt whose task blob no longer matches.
const RETRY_NEEDED: &str = "retry-needed";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WebActionOperation {
    Upsert,
    Complete,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum WebActionState {
    /// Valid and ready to apply (what `web_actions_scan` reports).
    Pending,
    /// Applied this run; the receipt moved to `applied/`.
    Applied,
    /// Already applied on an earlier run; the receipt moved without redoing
    /// the side effect.
    Skipped,
    /// `expectedTaskBlobSha` mismatch (or the note is gone). Left in
    /// `pending/`, marked `retry-needed`.
    Stale,
    /// Failed validation. Left in `pending/`, untouched.
    Invalid,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebActionSummary {
    /// Workspace-relative path of the receipt file itself.
    pub receipt_path: String,
    pub id: String,
    pub operation: Option<WebActionOperation>,
    pub task_path: String,
    pub requested_at: String,
    pub requested_by: String,
    pub state: WebActionState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebActionsOutcome {
    pub applied: usize,
    pub skipped: usize,
    pub stale: usize,
    pub invalid: usize,
    pub items: Vec<WebActionSummary>,
}

// --- Receipt parsing + validation --------------------------------------------

/// Raw document shape. Every field is a String and validated below; serde
/// ignores unknown keys, so a receipt carrying our own `status:` marker (or a
/// future v1-compatible field) still parses.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawReceipt {
    #[serde(default)]
    schema_version: String,
    #[serde(default)]
    id: String,
    #[serde(default)]
    operation: String,
    #[serde(default)]
    task_path: String,
    #[serde(default)]
    expected_task_blob_sha: String,
    #[serde(default)]
    requested_at: String,
    #[serde(default)]
    requested_by: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Receipt {
    id: String,
    operation: WebActionOperation,
    task_path: String,
    expected_task_blob_sha: String,
    requested_at: String,
    requested_by: String,
}

/// Task paths a receipt may name. Fails closed: anything that could escape
/// the workspace, hide from a listing, name a secret, or point outside the
/// task buckets Maru actually scans is rejected before it is read.
///
/// `_`-prefixed segments are rejected on purpose: `tasks/_inbox/` is a
/// web-only bucket that Maru never scans (`tasks::should_enter_task_path`),
/// so a receipt naming one is malformed by construction.
fn validate_task_path(raw: &str) -> Result<(), String> {
    if raw.is_empty() {
        return Err("taskPath is empty".to_string());
    }
    if raw.contains('\0') {
        return Err("taskPath contains a NUL byte".to_string());
    }
    if raw.contains('\\') {
        return Err("taskPath contains a backslash".to_string());
    }
    let path = Path::new(raw);
    if path.is_absolute() {
        return Err("taskPath is absolute".to_string());
    }
    let mut segments = Vec::new();
    for component in path.components() {
        match component {
            Component::Normal(value) => {
                let Some(value) = value.to_str() else {
                    return Err("taskPath is not valid UTF-8".to_string());
                };
                if value.starts_with('.') || value.starts_with('_') {
                    return Err(format!("taskPath contains a hidden segment: {value}"));
                }
                segments.push(value);
            }
            // `.`, `..`, `/`, and Windows prefixes are all rejected outright.
            _ => return Err("taskPath contains a traversal component".to_string()),
        }
    }
    if !raw.ends_with(".md") {
        return Err("taskPath is not a markdown note".to_string());
    }
    if crate::git::is_sensitive_git_path(raw) {
        return Err("taskPath is secret-shaped".to_string());
    }
    let [root, bucket, ..] = segments.as_slice() else {
        return Err("taskPath names no task bucket".to_string());
    };
    if *root != "tasks" {
        return Err("taskPath is outside tasks/".to_string());
    }
    if TaskBucket::parse(bucket).is_none() {
        return Err(format!("taskPath names an unknown bucket: {bucket}"));
    }
    Ok(())
}

fn validate_receipt(raw: &RawReceipt) -> Result<Receipt, String> {
    if raw.schema_version != WEB_ACTION_SCHEMA_VERSION {
        return Err(format!(
            "unsupported schemaVersion: {} (expected {WEB_ACTION_SCHEMA_VERSION})",
            raw.schema_version
        ));
    }
    uuid::Uuid::parse_str(raw.id.trim()).map_err(|_| format!("id is not a uuid: {}", raw.id))?;
    let operation = match raw.operation.as_str() {
        "upsert" => WebActionOperation::Upsert,
        "complete" => WebActionOperation::Complete,
        other => return Err(format!("unknown operation: {other}")),
    };
    validate_task_path(&raw.task_path)?;
    if raw.expected_task_blob_sha.trim().is_empty() {
        return Err("expectedTaskBlobSha is empty".to_string());
    }
    DateTime::parse_from_rfc3339(raw.requested_at.trim())
        .map_err(|_| format!("requestedAt is not RFC3339: {}", raw.requested_at))?;
    if raw.requested_by.trim().is_empty() {
        return Err("requestedBy is empty".to_string());
    }
    Ok(Receipt {
        id: raw.id.trim().to_string(),
        operation,
        task_path: raw.task_path.clone(),
        expected_task_blob_sha: raw.expected_task_blob_sha.trim().to_string(),
        requested_at: raw.requested_at.trim().to_string(),
        requested_by: raw.requested_by.trim().to_string(),
    })
}

// --- Receipt files ------------------------------------------------------------

/// Pending receipts, sorted by path so a run is deterministic. A missing
/// directory is an empty scan, never an error — most workspaces have no
/// `shared/web/` at all.
fn pending_receipt_files(work: &Path) -> Vec<PathBuf> {
    receipt_files_under(work, PENDING_ROOT)
}

fn receipt_files_under(work: &Path, root: &str) -> Vec<PathBuf> {
    let root = work.join(root);
    let mut files = Vec::new();
    let Ok(months) = fs::read_dir(&root) else {
        return files;
    };
    for month in months.filter_map(Result::ok) {
        let Ok(entries) = fs::read_dir(month.path()) else {
            continue;
        };
        for entry in entries.filter_map(Result::ok) {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("yaml") {
                files.push(path);
            }
        }
    }
    files.sort();
    files
}

fn receipt_for_web_action(work: &Path, id: &str) -> Result<Receipt, String> {
    for path in receipt_files_under(work, PENDING_ROOT)
        .into_iter()
        .chain(receipt_files_under(work, APPLIED_ROOT))
    {
        let Ok(receipt) = load_receipt(work, &path) else {
            continue;
        };
        if receipt.id == id {
            return Ok(receipt);
        }
    }
    Err("matching web-action receipt is missing or invalid".to_string())
}

fn repair_conflict(message: impl Into<String>) -> IpcError {
    IpcError {
        code: WEB_ACTION_REPAIR_CONFLICT.to_string(),
        message: message.into(),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WebActionLinkageRepairOutcome {
    /// True only when the record or note linkage was changed. An exact repeat
    /// is intentionally a no-op so the user can safely retry after a UI race.
    pub changed: bool,
}

/// Repair the task-list linkage for one failed web-originated first upsert.
///
/// This is deliberately not an outbox editor. It never resolves a provider,
/// starts a drain, changes an outbox status, stages Git work, or moves a
/// receipt. The only possible writes are the record's `googleTaskListId` and
/// the matching note's `googleTaskListId` through the byte-preserving
/// frontmatter editor. The existing Retry control remains the sole provider
/// actuator.
pub fn web_action_repair_task_list_linkage(
    work_path: String,
    record_id: String,
    expected_record_revision: String,
    expected_updated_at: String,
    expected_web_action_id: String,
    expected_task_path: String,
    default_task_list_id: String,
) -> Result<WebActionLinkageRepairOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve web-action cwd: {err}"))?
            .join(&work_path)
    };
    let mut paths = vec![
        work.clone(),
        lexical_work,
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    // Dynamic allocation and rename/rollback stay inside these domains. A
    // workspace key alone cannot cover a nested alias's physical endpoint.
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        Ok(web_action_repair_task_list_linkage_in_transaction(
            lease,
            work_path,
            record_id,
            expected_record_revision,
            expected_updated_at,
            expected_web_action_id,
            expected_task_path,
            default_task_list_id,
        ))
    })?
}

#[allow(clippy::too_many_arguments)] // Borrowed lease plus the unchanged seven wire arguments.
pub(crate) fn web_action_repair_task_list_linkage_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    record_id: String,
    expected_record_revision: String,
    expected_updated_at: String,
    expected_web_action_id: String,
    expected_task_path: String,
    default_task_list_id: String,
) -> Result<WebActionLinkageRepairOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.clone(),
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let default_task_list_id = default_task_list_id.trim();
    if default_task_list_id.is_empty() {
        return Err(repair_conflict("A current default task list is required."));
    }

    let mut record = read_record(&work, &record_id).map_err(repair_conflict)?;
    if record_revision(&record) != expected_record_revision
        || record.updated_at != expected_updated_at
        || record.web_action_id.as_deref() != Some(expected_web_action_id.as_str())
        || record.task_path != expected_task_path
    {
        return Err(repair_conflict(
            "This blocked sync record changed. Refresh Today before repairing it.",
        ));
    }
    if record.op != OutboxOp::Upsert
        || record.status != OutboxStatus::AuthBlocked
        || !record.google_task_id.trim().is_empty()
        || record
            .web_action_id
            .as_deref()
            .unwrap_or_default()
            .is_empty()
    {
        return Err(repair_conflict(
            "This sync record is not eligible for task-list linkage repair.",
        ));
    }

    let receipt =
        receipt_for_web_action(&work, &expected_web_action_id).map_err(repair_conflict)?;
    if receipt.operation != WebActionOperation::Upsert || receipt.task_path != record.task_path {
        return Err(repair_conflict(
            "The matching web action no longer describes this task upsert.",
        ));
    }
    let note = resolve_inside_vault(&work_path, &receipt.task_path).map_err(repair_conflict)?;
    if !note.is_file() {
        return Err(repair_conflict("The matching task note is missing."));
    }
    let raw = fs::read_to_string(&note)
        .map_err(|err| repair_conflict(format!("Cannot read task note: {err}")))?;
    let frontmatter =
        normalize_task_frontmatter_aliases(yaml_to_json(&parse_frontmatter(&raw).meta));
    if string_field(&frontmatter, "googleTaskId").is_some() {
        return Err(repair_conflict(
            "The matching task is already linked to a provider task.",
        ));
    }

    let note_list_id = string_field(&frontmatter, "googleTaskListId");
    let current_list_id = record
        .google_task_list_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty());
    let already_repaired = current_list_id == Some(default_task_list_id)
        && note_list_id.as_deref() == Some(default_task_list_id);
    if already_repaired {
        return Ok(WebActionLinkageRepairOutcome { changed: false });
    }
    if !has_unusable_task_list_linkage(&record) {
        return Err(repair_conflict(
            "The stored task-list linkage is no longer eligible for repair.",
        ));
    }
    if let Some(note_list_id) = note_list_id.as_deref().filter(|value| !value.is_empty()) {
        if note_list_id != default_task_list_id && Some(note_list_id) != current_list_id {
            return Err(repair_conflict(
                "The task note has a different task-list linkage. Repair was not applied.",
            ));
        }
    }

    let updated_note = if note_list_id.as_deref() == Some(default_task_list_id) {
        raw.clone()
    } else {
        update_frontmatter_content(
            &raw,
            "googleTaskListId",
            Some(FrontmatterValue::String(default_task_list_id.to_string())),
        )
        .map_err(repair_conflict)?
    };
    record.google_task_list_id = Some(default_task_list_id.to_string());
    // Write the note first: a record must never advertise a linkage that the
    // task note did not receive. `write_atomic` leaves all unrelated bytes
    // exactly as the shared frontmatter implementation produced them.
    if updated_note != raw {
        write_atomic(&note, updated_note.as_bytes()).map_err(repair_conflict)?;
    }
    write_record_in_transaction(lease, &work, &record).map_err(repair_conflict)?;
    Ok(WebActionLinkageRepairOutcome { changed: true })
}

fn rel_path_for(work: &Path, path: &Path) -> String {
    path.strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Applied destination for a pending receipt, preserving the `YYYY-MM`
/// segment: `pending/2026-08/<id>.yaml` -> `applied/2026-08/<id>.yaml`.
fn applied_path_for(work: &Path, receipt_path: &Path) -> Result<PathBuf, String> {
    let rel = receipt_path
        .strip_prefix(work.join(PENDING_ROOT))
        .map_err(|_| "receipt is not under the pending root".to_string())?;
    Ok(work.join(APPLIED_ROOT).join(rel))
}

/// Rewrite the receipt's `status:` line, or drop it when `status` is `None`.
/// A line splice, not a re-serialize: every other byte of the committed file
/// is preserved so the diff stays reviewable.
fn rewrite_status_line(content: &str, status: Option<&str>) -> String {
    let mut lines: Vec<String> = content
        .lines()
        .filter(|line| !line.starts_with("status:"))
        .map(ToString::to_string)
        .collect();
    if let Some(status) = status {
        lines.push(format!("status: {status}"));
    }
    let mut out = lines.join("\n");
    out.push('\n');
    out
}

fn mark_retry_needed(path: &Path) -> Result<(), String> {
    let raw = fs::read_to_string(path).map_err(|err| format!("Cannot read receipt: {err}"))?;
    write_atomic(
        path,
        rewrite_status_line(&raw, Some(RETRY_NEEDED)).as_bytes(),
    )
}

/// Move a receipt to `applied/`, dropping any `retry-needed` marker a
/// previous run left on it.
fn move_to_applied(work: &Path, receipt_path: &Path) -> Result<String, String> {
    let raw =
        fs::read_to_string(receipt_path).map_err(|err| format!("Cannot read receipt: {err}"))?;
    let cleaned = rewrite_status_line(&raw, None);
    if cleaned != raw {
        write_atomic(receipt_path, cleaned.as_bytes())?;
    }
    let dest = applied_path_for(work, receipt_path)?;
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create applied directory: {err}"))?;
    }
    move_file(receipt_path, &dest)?;
    Ok(rel_path_for(work, &dest))
}

// --- Applied ledger -----------------------------------------------------------

/// Durable, local (untracked) acknowledgement of applied receipts, appended
/// after the side effect lands and before the pending -> applied move.
///
/// Without it, a `complete` on a note carrying no `googleTaskId` leaves no
/// trace at all: it creates no outbox record, so a crash before the move would
/// strand the receipt in `pending/` forever — every later run would report it
/// stale, because its note has already been archived.
fn applied_ledger_path(work: &Path) -> PathBuf {
    crate::today_store::today_dir(work)
        .join("web-actions")
        .join("applied.jsonl")
}

fn ledger_has(work: &Path, id: &str) -> bool {
    let Ok(raw) = fs::read_to_string(applied_ledger_path(work)) else {
        return false;
    };
    raw.lines().any(|line| {
        serde_json::from_str::<serde_json::Value>(line)
            .ok()
            .and_then(|entry| {
                entry
                    .get("id")
                    .and_then(|value| value.as_str())
                    .map(|value| value == id)
            })
            .unwrap_or(false)
    })
}

fn ledger_append(work: &Path, receipt: &Receipt, now_iso: &str) -> Result<(), String> {
    let path = applied_ledger_path(work);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create web-actions directory: {err}"))?;
    }
    let line = serde_json::json!({
        "id": receipt.id,
        "operation": receipt.operation,
        "taskPath": receipt.task_path,
        "appliedAt": now_iso,
    });
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|err| format!("Cannot open applied ledger: {err}"))?;
    writeln!(file, "{line}").map_err(|err| format!("Cannot append applied ledger: {err}"))
}

// --- Blob sha -----------------------------------------------------------------

/// Git blob sha of the working-tree file, computed by git itself so it always
/// matches the id GitHub assigned the blob the web committed. `--no-filters`
/// hashes the raw bytes, which is what the web hashed.
fn blob_sha(path: &Path) -> Result<String, String> {
    let mut command = Command::new("git");
    // Tests hash only disposable notes; inherited user Git configuration,
    // repository overrides, credentials and hooks never enter the fixture.
    #[cfg(test)]
    command
        .current_dir(path.parent().expect("fixture note parent"))
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env(
            "GIT_CONFIG_GLOBAL",
            if cfg!(windows) { "NUL" } else { "/dev/null" },
        )
        .env("GIT_CONFIG_COUNT", "0")
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .args([
            "-c",
            "core.hooksPath=",
            "-c",
            "commit.gpgsign=false",
            "-c",
            "credential.helper=",
        ]);
    let output = command
        .args(["hash-object", "--no-filters", "--"])
        .arg(path)
        .no_window()
        .output()
        .map_err(|err| format!("git hash-object failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git hash-object failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

// --- Apply --------------------------------------------------------------------

fn summary_for(
    work: &Path,
    receipt_path: &Path,
    receipt: &Receipt,
    state: WebActionState,
    reason: Option<String>,
) -> WebActionSummary {
    WebActionSummary {
        receipt_path: rel_path_for(work, receipt_path),
        id: receipt.id.clone(),
        operation: Some(receipt.operation),
        task_path: receipt.task_path.clone(),
        requested_at: receipt.requested_at.clone(),
        requested_by: receipt.requested_by.clone(),
        state,
        reason,
    }
}

fn invalid_summary(
    work: &Path,
    receipt_path: &Path,
    raw: Option<&RawReceipt>,
    reason: String,
) -> WebActionSummary {
    WebActionSummary {
        receipt_path: rel_path_for(work, receipt_path),
        id: raw.map(|raw| raw.id.clone()).unwrap_or_default(),
        operation: None,
        task_path: raw.map(|raw| raw.task_path.clone()).unwrap_or_default(),
        requested_at: raw.map(|raw| raw.requested_at.clone()).unwrap_or_default(),
        requested_by: raw.map(|raw| raw.requested_by.clone()).unwrap_or_default(),
        state: WebActionState::Invalid,
        reason: Some(reason),
    }
}

/// Read + validate one receipt file. `Err` carries the summary so the caller
/// can report it without re-deriving the fields.
fn load_receipt(work: &Path, path: &Path) -> Result<Receipt, Box<WebActionSummary>> {
    let raw = fs::read_to_string(path).map_err(|err| {
        Box::new(invalid_summary(
            work,
            path,
            None,
            format!("Cannot read receipt: {err}"),
        ))
    })?;
    let parsed: RawReceipt = serde_yaml::from_str(&raw).map_err(|err| {
        Box::new(invalid_summary(
            work,
            path,
            None,
            format!("Cannot parse receipt: {err}"),
        ))
    })?;
    validate_receipt(&parsed)
        .map_err(|reason| Box::new(invalid_summary(work, path, Some(&parsed), reason)))
}

/// Google Tasks wants an RFC3339 timestamp; task notes carry a plain
/// `YYYY-MM-DD`. A value that already looks like a timestamp is passed
/// through, so a hand-edited note is never mangled.
fn provider_due(value: &str) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    if trimmed.contains('T') {
        return Some(trimmed.to_string());
    }
    chrono::NaiveDate::parse_from_str(trimmed, "%Y-%m-%d")
        .ok()
        .map(|date| format!("{date}T00:00:00.000Z"))
}

/// Queue the provider create-or-update for a web `upsert`. The payload is
/// snapshotted here, so the drain never re-reads the note, and the list id is
/// resolved once: note frontmatter, then the caller's configured default,
/// then the outbox's `@default` fallback.
fn queue_upsert(
    lease: &PathTransactionLease,
    work: &Path,
    note: &Path,
    receipt: &Receipt,
    default_task_list_id: Option<&str>,
    now_iso: &str,
) -> Result<(), String> {
    let raw = fs::read_to_string(note).map_err(|err| format!("Cannot read task note: {err}"))?;
    let parts = parse_frontmatter(&raw);
    let frontmatter = normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta));
    let file_name = note
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&receipt.task_path);
    let payload = UpsertPayload {
        title: task_display_title(&frontmatter, &parts.body, file_name),
        // Same `File:` pointer the task-management skill writes, so both
        // producers converge on one provider task shape.
        notes: format!("File: {}", receipt.task_path),
        due: string_field(&frontmatter, "due").and_then(|value| provider_due(&value)),
    };
    let list_id = string_field(&frontmatter, "googleTaskListId").or_else(|| {
        default_task_list_id
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
    });
    enqueue_record_in_transaction(
        lease,
        work,
        OutboxRecordDraft {
            op: OutboxOp::Upsert,
            task_path: receipt.task_path.clone(),
            // Empty on first sight of the task: the drain inserts, then
            // writes the returned id back into the note.
            google_task_id: string_field(&frontmatter, "googleTaskId").unwrap_or_default(),
            google_task_list_id: list_id,
            payload: Some(payload),
            // Ready, not Prepared: the web already committed the note, so
            // there is no local mutation for recovery to reconcile against.
            status: OutboxStatus::Ready,
            web_action_id: Some(receipt.id.clone()),
        },
        now_iso,
    )?;
    Ok(())
}

/// Apply one validated receipt. Returns the state to report.
///
/// Replay safety uses two checks because they cover different crash windows:
/// the applied ledger is written for every receipt but only after the side
/// effect, while an outbox record carrying `web_action_id` exists from the
/// moment the provider op is queued. Together they mean a replay never
/// duplicates a side effect and never strands an already-applied receipt.
fn apply_receipt(
    lease: &PathTransactionLease,
    work_path: &str,
    work: &Path,
    receipt: &Receipt,
    default_task_list_id: Option<&str>,
    now_iso: &str,
) -> Result<WebActionState, String> {
    if ledger_has(work, &receipt.id) || has_web_action(work, &receipt.id)? {
        return Ok(WebActionState::Skipped);
    }
    let note = resolve_inside_vault(work_path, &receipt.task_path)?;
    if !note.is_file() {
        return Err("task note is missing".to_string());
    }
    let actual_sha = blob_sha(&note)?;
    if actual_sha != receipt.expected_task_blob_sha {
        return Err(format!(
            "task blob changed locally: expected {}, found {actual_sha}",
            receipt.expected_task_blob_sha
        ));
    }
    match receipt.operation {
        WebActionOperation::Complete => {
            let raw =
                fs::read_to_string(&note).map_err(|err| format!("Cannot read task note: {err}"))?;
            // The web already recorded WHEN the task was completed, and the
            // blob check just proved those values are the current ones. The
            // desktop is only mirroring the completion, so the transition is
            // driven by the note's own timestamps — restamping with the
            // desktop's apply time would silently move the task to a
            // different completion day (the UI passes a UTC `now`, which is
            // yesterday's date for a Korean morning).
            let parts = parse_frontmatter(&raw);
            let frontmatter = normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta));
            let completed_at = string_field(&frontmatter, "completedAt")
                .unwrap_or_else(|| receipt.requested_at.clone());
            let done = string_field(&frontmatter, "done")
                .unwrap_or_else(|| completed_at.get(..10).unwrap_or(&completed_at).to_string());
            task_transition_in_transaction(
                lease,
                work_path.to_string(),
                TaskTransitionRequest {
                    task_id: receipt.task_path.clone(),
                    task_path: receipt.task_path.clone(),
                    kind: TaskTransitionKind::Complete,
                    expected_task_hash: revision_for(&raw),
                    defer_date: None,
                    date: Some(done),
                    now_iso: Some(completed_at),
                    web_action_id: Some(receipt.id.clone()),
                    payload: serde_json::json!({}),
                },
            )
            .map_err(|e| e.to_string())?;
            ledger_append(work, receipt, now_iso)?;
            Ok(WebActionState::Applied)
        }
        WebActionOperation::Upsert => {
            queue_upsert(lease, work, &note, receipt, default_task_list_id, now_iso)?;
            ledger_append(work, receipt, now_iso)?;
            Ok(WebActionState::Applied)
        }
    }
}

// --- Web-selected Top 3 -------------------------------------------------------

/// The day plan (`tasks/daily/YYYY-MM-DD.md`) is Maru's one-way projection of
/// the local snapshot, and the web may rewrite only the `## Top` entry list
/// inside the managed block. Importing reads that list back and reconciles it
/// into the snapshot through `today_mutate`, so the plan's optimistic
/// concurrency still decides who wins: a revision mismatch loses cleanly
/// instead of clobbering a plan Maru changed in the meantime.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TopImportOutcome {
    /// Number of Top entries the snapshot now holds, when a change landed.
    pub imported: usize,
    /// True when the snapshot was rewritten. False means "nothing to do" or
    /// "declined"; `reason` says which.
    pub changed: bool,
    /// Resolvable journal entries the lane had no room for. Zero on the early
    /// skips, where the journal was never compared against the cap.
    #[serde(default)]
    pub truncated: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

fn skipped(reason: &str) -> TopImportOutcome {
    TopImportOutcome {
        imported: 0,
        changed: false,
        truncated: 0,
        reason: Some(reason.to_string()),
    }
}

/// The full grammar `today_store::journal_item_line` emits: the item ref,
/// then a duration group, then an optional `: <outcome>` suffix. Anchored at
/// both ends and non-greedy on the ref, so an outcome containing its own
/// parentheses ("Call Alice (follow up)") cannot be mistaken for the
/// duration group.
static JOURNAL_ITEM_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();

fn journal_item_re() -> &'static regex::Regex {
    JOURNAL_ITEM_RE.get_or_init(|| {
        regex::Regex::new(r"^(.*?)\s*\((?:\d+m|estimate pending)\)(?::\s.*)?$")
            .expect("journal item regex")
    })
}

/// Item ref from one journal entry line, i.e. the exact inverse of
/// `today_store::journal_item_line`. Returns `None` for a line that is not an
/// entry.
///
/// The ref is not always a task path: `item_ref.id()` is whatever identifies
/// the plan item, which for a capture is an opaque id. Resolution to a real
/// task is the caller's job (`web_actions_import_top`), which matches against
/// the plan's existing refs before requiring a path.
fn journal_entry_path(line: &str) -> Option<String> {
    let body = line.strip_prefix("- ")?;
    let head = match journal_item_re().captures(body) {
        Some(captures) => captures[1].to_string(),
        None => {
            // Hand-edited or estimate-less line. Drop a trailing parenthetical
            // first, then an outcome suffix — `journal_item_line` emits
            // `- <ref>: <outcome>` when an item has an outcome but no estimate.
            let trimmed = body.trim_end();
            let without_group = match (trimmed.rfind(" ("), trimmed.ends_with(')')) {
                (Some(index), true) if !trimmed[index + 2..].contains('(') => &trimmed[..index],
                _ => trimmed,
            };
            without_group
                .split_once(": ")
                .map(|(head, _)| head)
                .unwrap_or(without_group)
                .to_string()
        }
    };
    let path = head.trim();
    (!path.is_empty()).then(|| path.to_string())
}

/// Task paths under `## Top` inside the managed block, in order. `None` when
/// the file, the markers, or the section are missing — the caller then skips
/// rather than inventing an empty Top lane.
fn read_journal_top(raw: &str) -> Option<Vec<String>> {
    let start = raw.find(JOURNAL_START_MARKER)?;
    let end = raw.find(JOURNAL_END_MARKER)?;
    if end < start {
        return None;
    }
    let lines: Vec<&str> = raw[start..end].lines().collect();
    let heading = lines.iter().position(|line| line.trim() == "## Top")?;
    Some(
        lines[heading + 1..]
            .iter()
            .skip_while(|line| line.trim().is_empty())
            // The section ends at the first line that is not an entry.
            .map_while(|line| journal_entry_path(line))
            .collect(),
    )
}

/// Rebuild the plan with `top` set to the imported refs. An imported path
/// that already exists anywhere in the plan keeps its item verbatim (outcome,
/// estimate, pinned, block, calendar sync); a new one gets a provisional
/// estimate. Displaced Top items move to the front of Flexible, and Overflow
/// is untouched — nothing is dropped, and no ref appears twice
/// (`today::validate_plan` rejects duplicates).
fn plan_with_top(plan: &DailyPlanV1, revision: &str, wanted: &[PlanItemRef]) -> DailyPlanV1 {
    let promoted = |item_ref: &PlanItemRef| wanted.contains(item_ref);

    let mut next = plan.clone();
    next.input_revision = revision.to_string();
    next.top = wanted
        .iter()
        .enumerate()
        .map(|(order, item_ref)| {
            let mut item = plan
                .items()
                .find(|existing| existing.item_ref == *item_ref)
                .cloned()
                .unwrap_or_else(|| DailyPlanItem {
                    item_ref: item_ref.clone(),
                    lane: PlanLane::Top,
                    order: 0,
                    outcome: None,
                    estimate_minutes: None,
                    estimate_provisional: true,
                    pinned: false,
                    proposed_block: None,
                    calendar_sync: CalendarSyncState::none(),
                });
            item.lane = PlanLane::Top;
            item.order = order as u32;
            item
        })
        .collect();

    // Old Top items the web dropped land at the front of Flexible; anything
    // promoted out of Flexible/Overflow is removed from where it was.
    let displaced = plan
        .top
        .iter()
        .filter(|item| !promoted(&item.item_ref))
        .cloned();
    let kept = next
        .flexible
        .iter()
        .filter(|item| !promoted(&item.item_ref))
        .cloned()
        .collect::<Vec<_>>();
    next.flexible = displaced
        .chain(kept)
        .enumerate()
        .map(|(order, mut item)| {
            item.lane = PlanLane::Flexible;
            item.order = order as u32;
            item
        })
        .collect();
    next.overflow.retain(|item| !promoted(&item.item_ref));
    next
}

/// Import a web-rewritten `## Top` lane back into the day snapshot.
///
/// Explicit, like applying receipts, and conservative at every step: it never
/// creates a plan, never invents entries for tasks that do not exist, clamps
/// to `top_lane_size`, and declines on a revision conflict rather than
/// overwriting a plan Maru changed while the web edit was in flight.
///
/// `top_lane_size` is the caller's `tasks.today.topLaneSize`, passed the way
/// `today_open` already receives `day_start` / `sleep_start`. It arrives over
/// IPC, so it is clamped here rather than trusted: below 1 would empty the
/// lane, above `TOP_LANE_MAX` would build a plan `validate_plan` rejects.
pub fn web_actions_import_top(
    work_path: String,
    logical_day: String,
    dry_run: Option<bool>,
    top_lane_size: Option<usize>,
) -> Result<TopImportOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve web-action cwd: {err}"))?
            .join(&work_path)
    };
    let mut paths = vec![
        work.clone(),
        lexical_work,
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    // Dynamic allocation and rename/rollback stay inside these domains. A
    // workspace key alone cannot cover a nested alias's physical endpoint.
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        web_actions_import_top_in_transaction(lease, work_path, logical_day, dry_run, top_lane_size)
    })
}

pub(crate) fn web_actions_import_top_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    logical_day: String,
    dry_run: Option<bool>,
    top_lane_size: Option<usize>,
) -> Result<TopImportOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.clone(),
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    let dry_run = dry_run.unwrap_or(false);
    let lane_size = top_lane_size
        .unwrap_or(TOP_LANE_DEFAULT)
        .clamp(1, TOP_LANE_MAX);
    if !dry_run {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    }
    let work = normalize_existing_dir(&work_path)?;
    let journal = work
        .join("tasks")
        .join("daily")
        .join(format!("{logical_day}.md"));
    let Ok(raw) = fs::read_to_string(&journal) else {
        return Ok(skipped("journal_missing"));
    };
    let Some(paths) = read_journal_top(&raw) else {
        return Ok(skipped("journal_top_section_missing"));
    };
    let Ok(snapshot) = load_snapshot(&work, &logical_day) else {
        return Ok(skipped("today_state_missing"));
    };
    let Some(plan) = snapshot.plan.as_ref() else {
        return Ok(skipped("today_plan_missing"));
    };

    // Journal entries are `item_ref.id()`, which is a task path only for
    // items Maru created from a note — a capture-backed item carries an opaque
    // id instead. Resolve against the plan's existing refs first, so those
    // survive an import verbatim; only an entry the plan does not already know
    // has to look like a real task note (that is the web adding something).
    // Resolve every entry before clamping, rather than breaking at the cap.
    // Stopping early left the tail unvalidated, so there was no way to tell a
    // genuine overflow from entries that would have been rejected anyway --
    // `paths.len()` counts rejects and duplicates too, and reporting that as
    // dropped would overstate it several times over.
    // `seen` rather than `resolved.contains`: the loop no longer stops at the
    // lane, so a journal listing many valid paths would otherwise be quadratic,
    // and this runs as a dry run on every Today load.
    let mut resolved: Vec<PlanItemRef> = Vec::new();
    let mut seen: HashSet<PlanItemRef> = HashSet::new();
    for entry in paths {
        let item_ref = match plan.items().find(|item| item.item_ref.id() == entry) {
            Some(item) => item.item_ref.clone(),
            None if validate_task_path(&entry).is_ok()
                && resolve_inside_vault(&work_path, &entry).is_ok_and(|note| note.is_file()) =>
            {
                PlanItemRef::Task { task_id: entry }
            }
            None => continue,
        };
        if seen.insert(item_ref.clone()) {
            resolved.push(item_ref);
        }
    }
    let truncated = resolved.len().saturating_sub(lane_size);
    resolved.truncate(lane_size);
    let wanted = resolved;

    let current: Vec<&str> = plan.top.iter().map(|item| item.item_ref.id()).collect();
    if current == wanted.iter().map(PlanItemRef::id).collect::<Vec<_>>() {
        // Not `skipped()`: the journal *was* compared against the cap here, so
        // an overflow still has to be reported. This is the case that hides
        // worst -- "nothing to do" while entries are being dropped every run.
        return Ok(TopImportOutcome {
            imported: 0,
            changed: false,
            truncated,
            reason: Some("already_current".to_string()),
        });
    }
    if dry_run {
        return Ok(TopImportOutcome {
            imported: wanted.len(),
            changed: true,
            truncated,
            reason: Some("pending".to_string()),
        });
    }

    let next = plan_with_top(plan, &snapshot.revision, &wanted);
    // today_mutate takes the workspace lock, so this must not hold it.
    match today_mutate_in_transaction(
        lease,
        work_path,
        logical_day,
        snapshot.revision.clone(),
        TodayMutation::SetPlan { plan: next },
    ) {
        Ok(_) => Ok(TopImportOutcome {
            imported: wanted.len(),
            changed: true,
            truncated,
            reason: None,
        }),
        // The snapshot moved under us: re-read on the next run, never clobber.
        Err(err) if err.code == TODAY_CONFLICT => Ok(skipped("conflict")),
        Err(err) => Err(err.to_string()),
    }
}

// --- Commands -----------------------------------------------------------------

/// Pending web-action receipts, for the sync panel's badge. Read-only:
/// invalid receipts are reported, never rewritten.
pub fn web_actions_scan(work_path: String) -> Result<Vec<WebActionSummary>, String> {
    let work = normalize_existing_dir(&work_path)?;
    Ok(pending_receipt_files(&work)
        .into_iter()
        .map(|path| match load_receipt(&work, &path) {
            Ok(receipt) => summary_for(&work, &path, &receipt, WebActionState::Pending, None),
            Err(summary) => *summary,
        })
        .collect())
}

/// Apply pending web-action receipts. Explicit and local-only: it never
/// stages, commits, or pushes — the pending -> applied move is a working-tree
/// change that rides the user's normal Git Sync cadence.
pub fn web_actions_apply(
    work_path: String,
    now_iso: String,
    default_task_list_id: Option<String>,
) -> Result<WebActionsOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve web-action cwd: {err}"))?
            .join(&work_path)
    };
    let mut paths = vec![
        work.clone(),
        lexical_work,
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    // Dynamic allocation and rename/rollback stay inside these domains. A
    // workspace key alone cannot cover a nested alias's physical endpoint.
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        web_actions_apply_in_transaction(lease, work_path, now_iso, default_task_list_id)
    })
}

pub(crate) fn web_actions_apply_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    now_iso: String,
    default_task_list_id: Option<String>,
) -> Result<WebActionsOutcome, String> {
    let work = normalize_existing_dir(&work_path)?;
    let mut paths = vec![
        work.clone(),
        work.join("tasks"),
        work.join(".maru"),
        work.join("shared"),
    ];
    for root in [work.join("tasks"), work.join(".maru"), work.join("shared")] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(&root).follow_links(true) {
                let entry = entry
                    .map_err(|err| format!("Cannot inspect web-action transaction paths: {err}"))?;
                if entry.file_type().is_dir() || entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    DateTime::parse_from_rfc3339(&now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))?;
    let work = normalize_existing_dir(&work_path)?;
    let mut outcome = WebActionsOutcome::default();
    for path in pending_receipt_files(&work) {
        let receipt = match load_receipt(&work, &path) {
            Ok(receipt) => receipt,
            Err(summary) => {
                outcome.invalid += 1;
                outcome.items.push(*summary);
                continue;
            }
        };
        // Each receipt is applied independently: `task_transition` takes the
        // workspace lock itself, so this loop must never hold it.
        match apply_receipt(
            lease,
            &work_path,
            &work,
            &receipt,
            default_task_list_id.as_deref(),
            &now_iso,
        ) {
            Ok(state) => {
                move_to_applied(&work, &path)?;
                match state {
                    WebActionState::Skipped => outcome.skipped += 1,
                    _ => outcome.applied += 1,
                }
                outcome
                    .items
                    .push(summary_for(&work, &path, &receipt, state, None));
            }
            Err(reason) => {
                mark_retry_needed(&path)?;
                outcome.stale += 1;
                outcome.items.push(summary_for(
                    &work,
                    &path,
                    &receipt,
                    WebActionState::Stale,
                    Some(reason),
                ));
            }
        }
    }
    Ok(outcome)
}

/// IPC owns every argument; all filesystem/process work and admission waits
/// stay on the finite blocking worker. Synchronous Rust callers share admission.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn web_action_repair_task_list_linkage(
        work_path: String,
        record_id: String,
        expected_record_revision: String,
        expected_updated_at: String,
        expected_web_action_id: String,
        expected_task_path: String,
        default_task_list_id: String,
    ) -> Result<WebActionLinkageRepairOutcome, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:web_action_repair_task_list_linkage",
            );
            super::web_action_repair_task_list_linkage(
                work_path,
                record_id,
                expected_record_revision,
                expected_updated_at,
                expected_web_action_id,
                expected_task_path,
                default_task_list_id,
            )
        })
        .await
        .map_err(|err| {
            IpcError::from(format!(
                "web_action_repair_task_list_linkage_task_failed: {err}"
            ))
        })?
    }
    #[tauri::command]
    pub async fn web_actions_import_top(
        work_path: String,
        logical_day: String,
        dry_run: Option<bool>,
        top_lane_size: Option<usize>,
    ) -> Result<TopImportOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:web_actions_import_top",
            );
            super::web_actions_import_top(work_path, logical_day, dry_run, top_lane_size)
        })
        .await
        .map_err(|err| format!("web_actions_import_top_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn web_actions_apply(
        work_path: String,
        now_iso: String,
        default_task_list_id: Option<String>,
    ) -> Result<WebActionsOutcome, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:web_actions_apply",
            );
            super::web_actions_apply(work_path, now_iso, default_task_list_id)
        })
        .await
        .map_err(|err| format!("web_actions_apply_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn web_actions_scan(work_path: String) -> Result<Vec<WebActionSummary>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:web_actions_scan",
            );
            super::web_actions_scan(work_path)
        })
        .await
        .map_err(|err| format!("web_actions_scan_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today_outbox::{list_records, write_record, OutboxOp, OutboxStatus};
    use crate::today_store::today_mutate;

    const NOW: &str = "2026-08-16T09:00:00+09:00";
    const ID: &str = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
    const OTHER_ID: &str = "9c858901-8a57-4791-81fe-4c455b099bc9";

    fn work_path(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    /// Task note + a receipt whose expectedTaskBlobSha matches it.
    fn setup(operation: &str, task_path: &str, content: &str) -> (tempfile::TempDir, PathBuf) {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join(task_path);
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, content).unwrap();
        let sha = blob_sha(&note).unwrap();
        let receipt = write_receipt(
            tmp.path(),
            ID,
            &format!(
                "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {ID}\noperation: {operation}\ntaskPath: {task_path}\nexpectedTaskBlobSha: {sha}\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner@example.com\n"
            ),
        );
        (tmp, receipt)
    }

    fn write_receipt(work: &Path, id: &str, body: &str) -> PathBuf {
        let path = work
            .join(PENDING_ROOT)
            .join("2026-08")
            .join(format!("{id}.yaml"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, body).unwrap();
        path
    }

    fn apply(tmp: &tempfile::TempDir) -> WebActionsOutcome {
        web_actions_apply(work_path(tmp), NOW.to_string(), None).unwrap()
    }

    fn apply_with_list(tmp: &tempfile::TempDir, list: &str) -> WebActionsOutcome {
        web_actions_apply(work_path(tmp), NOW.to_string(), Some(list.to_string())).unwrap()
    }

    fn blocked_web_upsert(tmp: &tempfile::TempDir) -> crate::today_outbox::OutboxRecord {
        apply_with_list(tmp, "invalid-list");
        let mut record = list_records(tmp.path()).unwrap().pop().unwrap();
        record.status = OutboxStatus::AuthBlocked;
        record.last_error = Some("Invalid task list".to_string());
        write_record(tmp.path(), &record).unwrap();
        read_record(tmp.path(), &record.id).unwrap()
    }

    fn repair(
        tmp: &tempfile::TempDir,
        record: &crate::today_outbox::OutboxRecord,
        list: &str,
    ) -> Result<WebActionLinkageRepairOutcome, IpcError> {
        web_action_repair_task_list_linkage(
            work_path(tmp),
            record.id.clone(),
            record.record_revision.clone().unwrap_or_default(),
            record.updated_at.clone(),
            record.web_action_id.clone().unwrap_or_default(),
            record.task_path.clone(),
            list.to_string(),
        )
    }

    #[test]
    fn phase08_12_web_wrappers_preserve_real_payloads_typed_and_legacy_errors() {
        use crate::atomic_file::phase08_06::{run, Home};
        let _home = Home::new();
        let (tmp, receipt) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\n---\n# Synthetic task\n",
        );
        let w = work_path(&tmp);
        let scan = run(ipc::web_actions_scan(w.clone())).unwrap();
        assert_eq!(scan.len(), 1);
        assert_eq!(scan[0].state, WebActionState::Pending);
        let applied = run(ipc::web_actions_apply(
            w.clone(),
            NOW.into(),
            Some("invalid-list".into()),
        ))
        .unwrap();
        assert_eq!(applied.applied, 1);
        assert!(!receipt.exists());
        let mut record = list_records(tmp.path()).unwrap().pop().unwrap();
        assert_eq!(record.payload.as_ref().unwrap().title, "Synthetic task");
        record.status = OutboxStatus::AuthBlocked;
        record.last_error = Some("Invalid task list".into());
        write_record(tmp.path(), &record).unwrap();
        let record = read_record(tmp.path(), &record.id).unwrap();
        let repaired = run(ipc::web_action_repair_task_list_linkage(
            w.clone(),
            record.id.clone(),
            record_revision(&record),
            record.updated_at.clone(),
            ID.into(),
            record.task_path.clone(),
            "synthetic-list".into(),
        ))
        .unwrap();
        assert!(repaired.changed);
        assert!(fs::read_to_string(tmp.path().join("tasks/active/task.md"))
            .unwrap()
            .contains("googleTaskListId: synthetic-list"));
        let stale = run(ipc::web_action_repair_task_list_linkage(
            w.clone(),
            record.id.clone(),
            record_revision(&record),
            record.updated_at,
            ID.into(),
            record.task_path,
            "synthetic-list".into(),
        ))
        .unwrap_err();
        assert_eq!(stale.code, WEB_ACTION_REPAIR_CONFLICT);
        assert!(run(ipc::web_actions_apply(w, "invalid-time".into(), None))
            .unwrap_err()
            .starts_with("now_iso must be RFC3339:"));

        let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
        web_rewrites_top(&tmp, &["tasks/active/b.md"]);
        let outcome = run(ipc::web_actions_import_top(
            work_path(&tmp),
            DAY.into(),
            None,
            None,
        ))
        .unwrap();
        assert!(outcome.changed);
        assert_eq!(outcome.imported, 1);
        assert_eq!(ids(&plan_of(&tmp).top), ["tasks/active/b.md"]);

        let (tmp, _) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ndone: 2026-08-16\n---\n# Completed synthetic task\n",
        );
        assert_eq!(
            run(ipc::web_actions_apply(work_path(&tmp), NOW.into(), None))
                .unwrap()
                .applied,
            1
        );
        assert!(tmp.path().join("tasks/archive/task.md").is_file());
        assert!(list_records(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn phase08_12_web_all_wrappers_yield_on_same_task_and_preserve_join_errors() {
        use crate::atomic_file::phase08_06::{boundary, Home};
        let _home = Home::new();
        for op in [
            "web_actions_scan",
            "web_actions_apply",
            "web_actions_import_top",
            "web_action_repair_task_list_linkage",
        ] {
            let tmp = tempfile::tempdir().unwrap();
            let w = work_path(&tmp);
            boundary(tmp.path().to_path_buf(), op, async move {
                match op {
                    "web_actions_scan" => ipc::web_actions_scan(w).await.map(|_| ()),
                    "web_actions_apply" => ipc::web_actions_apply(w, NOW.into(), None)
                        .await
                        .map(|_| ()),
                    "web_actions_import_top" => {
                        ipc::web_actions_import_top(w, DAY.into(), None, None)
                            .await
                            .map(|_| ())
                    }
                    _ => ipc::web_action_repair_task_list_linkage(
                        w,
                        "record".into(),
                        "revision".into(),
                        NOW.into(),
                        ID.into(),
                        "tasks/active/task.md".into(),
                        "list".into(),
                    )
                    .await
                    .map(|_| ())
                    .map_err(|err| {
                        assert!(err.code.is_empty());
                        err.message
                    }),
                }
            });
        }
    }

    #[test]
    fn phase08_12_web_same_target_contention_unwind_releases_before_domain_locks() {
        use crate::atomic_file::{
            phase08_06::{Held, Home},
            PathTransactionTestHook,
        };
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            mpsc,
        };
        use std::time::Duration;
        let _home = Home::new();
        for unwind in [false, true] {
            for op in ["apply", "import", "repair"] {
                let tmp = if op == "import" {
                    let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
                    web_rewrites_top(&tmp, &["tasks/active/b.md"]);
                    tmp
                } else {
                    setup(
                        "upsert",
                        "tasks/active/task.md",
                        "---\nstatus: active\n---\n# Synthetic\n",
                    )
                    .0
                };
                let record = (op == "repair").then(|| blocked_web_upsert(&tmp));
                let root = tmp.path().canonicalize().unwrap();
                let w = root.to_string_lossy().into_owned();
                let start = |w: String, record: Option<crate::today_outbox::OutboxRecord>| {
                    let (tx, rx) = mpsc::channel();
                    tauri::async_runtime::spawn(async move {
                        let result = match op {
                            "apply" => ipc::web_actions_apply(w, NOW.into(), None)
                                .await
                                .map(|v| v.applied == 1)
                                .map_err(IpcError::from),
                            "import" => ipc::web_actions_import_top(w, DAY.into(), None, None)
                                .await
                                .map(|v| v.changed)
                                .map_err(IpcError::from),
                            _ => {
                                let record = record.unwrap();
                                ipc::web_action_repair_task_list_linkage(
                                    w,
                                    record.id.clone(),
                                    record_revision(&record),
                                    record.updated_at,
                                    ID.into(),
                                    record.task_path,
                                    "synthetic-list".into(),
                                )
                                .await
                                .map(|v| v.changed)
                            }
                        };
                        tx.send(result).unwrap();
                    });
                    rx
                };
                let held = Held::new(root.clone(), "admitted");
                let first = start(w.clone(), record.clone());
                held.wait();
                let waiting = Held::new(root.clone(), "before-admission");
                let second = start(w, record);
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                let once = AtomicBool::new(false);
                let _injection = PathTransactionTestHook::new(root, "pre-effect", move || {
                    if unwind && !once.swap(true, Ordering::SeqCst) {
                        panic!("synthetic web-action failure before domain locks");
                    }
                });
                held.release();
                let first_result = first.recv_timeout(Duration::from_secs(5)).unwrap();
                let second_result = second.recv_timeout(Duration::from_secs(5)).unwrap();
                if unwind {
                    let error = first_result.unwrap_err();
                    assert!(error.code.is_empty());
                    assert!(error.message.contains("_task_failed:"));
                    assert!(second_result.unwrap());
                } else {
                    assert!(first_result.unwrap());
                    if op == "repair" {
                        assert_eq!(second_result.unwrap_err().code, WEB_ACTION_REPAIR_CONFLICT);
                    } else {
                        assert!(!second_result.unwrap());
                    }
                    if op == "apply" {
                        assert_eq!(list_records(tmp.path()).unwrap().len(), 1);
                    }
                }
            }
        }
    }

    #[test]
    fn phase08_12_web_mutations_serialize_real_document_saves_and_release_on_errors() {
        use crate::atomic_file::phase08_06::{run, Held, Home};
        use std::sync::mpsc;
        use std::time::Duration;
        let _home = Home::new();
        for op in ["apply", "import", "repair"] {
            let tmp = if op == "import" {
                let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
                web_rewrites_top(&tmp, &["tasks/active/b.md"]);
                tmp
            } else {
                setup(
                    if op == "apply" { "complete" } else { "upsert" },
                    "tasks/active/task.md",
                    "---\nstatus: active\n---\n# Synthetic\n",
                )
                .0
            };
            let record = (op == "repair").then(|| blocked_web_upsert(&tmp));
            let root = tmp.path().canonicalize().unwrap();
            let w = root.to_string_lossy().into_owned();
            let rel = if op == "import" {
                format!("tasks/daily/{DAY}.md")
            } else {
                "tasks/active/task.md".into()
            };
            let old = fs::read_to_string(root.join(&rel)).unwrap();
            let held = Held::new(root.clone(), "admitted");
            let (tx, rx) = mpsc::channel();
            let first_w = w.clone();
            tauri::async_runtime::spawn(async move {
                let result = match op {
                    "apply" => ipc::web_actions_apply(first_w, NOW.into(), None)
                        .await
                        .map(|v| v.applied == 1)
                        .map_err(IpcError::from),
                    "import" => ipc::web_actions_import_top(first_w, DAY.into(), None, None)
                        .await
                        .map(|v| v.changed)
                        .map_err(IpcError::from),
                    _ => {
                        let record = record.unwrap();
                        ipc::web_action_repair_task_list_linkage(
                            first_w,
                            record.id.clone(),
                            record_revision(&record),
                            record.updated_at,
                            ID.into(),
                            record.task_path,
                            "synthetic-list".into(),
                        )
                        .await
                        .map(|v| v.changed)
                    }
                };
                tx.send(result).unwrap();
            });
            held.wait();
            let waiting = Held::new(root.join(&rel), "before-admission");
            let (tx, doc) = mpsc::channel();
            let document_w = w.clone();
            let document_rel = rel.clone();
            tauri::async_runtime::spawn(async move {
                tx.send(
                    crate::document::ipc::save_document(
                        document_w,
                        document_rel,
                        "# Racing document\n".into(),
                        Some(revision_for(&old)),
                    )
                    .await,
                )
                .unwrap();
            });
            waiting.wait();
            waiting.release();
            assert!(doc.recv_timeout(Duration::from_millis(30)).is_err());
            held.release();
            assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap().unwrap());
            let error = doc
                .recv_timeout(Duration::from_secs(5))
                .unwrap()
                .unwrap_err();
            assert_eq!(error.code, crate::ipc_error::DOCUMENT_CONFLICT);
            // A denied/stale document leaves admission available for the next
            // real web operation; no hidden provider drain is involved.
            assert!(run(ipc::web_actions_scan(w)).unwrap().is_empty());
        }
    }

    #[test]
    fn phase08_12_web_parent_files_rename_trash_both_orders_and_aliases() {
        use crate::atomic_file::phase08_06::{Held, Home};
        use crate::workspace_files::phase08_06::TrashFixture;
        use std::{future::Future, pin::Pin, sync::mpsc, time::Duration};
        let home = Home::new();
        let start = |future: Pin<Box<dyn Future<Output = Result<(), IpcError>> + Send>>| {
            let (tx, rx) = mpsc::channel();
            tauri::async_runtime::spawn(async move {
                tx.send(future.await).unwrap();
            });
            rx
        };
        for op in ["apply", "import", "repair"] {
            // Both orders for both Files operations; alias selection alternates
            // without duplicating the entire matrix. Trash is a captured,
            // root-scoped synthetic move, never the native desktop Trash.
            for (parent_op, parent_first, alias) in [
                ("rename", true, false),
                ("rename", false, true),
                ("trash", true, true),
                ("trash", false, false),
            ] {
                let tmp = if op == "import" {
                    let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
                    web_rewrites_top(&tmp, &["tasks/active/b.md"]);
                    tmp
                } else {
                    setup(
                        "upsert",
                        "tasks/active/task.md",
                        "---\nstatus: active\n---\n# Synthetic\n",
                    )
                    .0
                };
                let record = (op == "repair").then(|| blocked_web_upsert(&tmp));
                let tag = format!("web-{op}-{parent_op}-{parent_first}");
                let root = home.root.path().join(&tag);
                fs::rename(tmp.path(), &root).unwrap();
                let alias_path = home.root.path().join(format!("alias-{tag}"));
                let alias = alias && cfg!(unix);
                #[cfg(unix)]
                if alias {
                    std::os::unix::fs::symlink(&root, &alias_path).unwrap();
                }
                let w = if alias { &alias_path } else { &root }
                    .to_string_lossy()
                    .into_owned();
                let destination = home.root.path().join(format!("moved-{tag}"));
                let _trash = TrashFixture::new(root.clone(), destination.clone());
                let owner = home.root.path().to_string_lossy().into_owned();
                let source = root.to_string_lossy().into_owned();
                let new_name = destination
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .into_owned();
                let parent: Pin<Box<dyn Future<Output = Result<(), IpcError>> + Send>> =
                    Box::pin(async move {
                        if parent_op == "rename" {
                            crate::workspace_files::ipc::rename_workspace_entry(
                                owner, source, new_name,
                            )
                            .await
                            .map(|value| assert!(value.error.is_none()))
                            .map_err(IpcError::from)
                        } else {
                            crate::workspace_files::ipc::trash_workspace_entries(
                                owner,
                                vec![source],
                            )
                            .await
                            .map(|value| assert!(value[0].error.is_none()))
                            .map_err(IpcError::from)
                        }
                    });
                let child: Pin<Box<dyn Future<Output = Result<(), IpcError>> + Send>> =
                    Box::pin(async move {
                        match op {
                            "apply" => ipc::web_actions_apply(w, NOW.into(), None)
                                .await
                                .map(|value| assert_eq!(value.applied, 1))
                                .map_err(IpcError::from),
                            "import" => ipc::web_actions_import_top(w, DAY.into(), None, None)
                                .await
                                .map(|value| assert!(value.changed))
                                .map_err(IpcError::from),
                            _ => {
                                let record = record.unwrap();
                                ipc::web_action_repair_task_list_linkage(
                                    w,
                                    record.id.clone(),
                                    record_revision(&record),
                                    record.updated_at,
                                    ID.into(),
                                    record.task_path,
                                    "synthetic-list".into(),
                                )
                                .await
                                .map(|value| assert!(value.changed))
                            }
                        }
                    });
                let (first, second) = if parent_first {
                    (parent, child)
                } else {
                    (child, parent)
                };
                let held = Held::new(root.clone(), "admitted");
                let first = start(first);
                held.wait();
                let waiting = Held::new(root.clone(), "before-admission");
                let second = start(second);
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                first.recv_timeout(Duration::from_secs(5)).unwrap().unwrap();
                let result = second.recv_timeout(Duration::from_secs(5)).unwrap();
                if parent_first {
                    let error = result.unwrap_err();
                    assert!(
                        error.message.contains("parent disappeared")
                            || error.message.contains("alias changed"),
                        "{error:?}"
                    );
                } else {
                    result.unwrap();
                    match op {
                        "apply" => {
                            assert_eq!(list_records(&destination).unwrap().len(), 1);
                            assert!(ledger_has(&destination, ID));
                            assert!(destination
                                .join(APPLIED_ROOT)
                                .join("2026-08")
                                .join(format!("{ID}.yaml"))
                                .is_file());
                        }
                        "import" => assert_eq!(
                            ids(&load_snapshot(&destination, DAY).unwrap().plan.unwrap().top),
                            ["tasks/active/b.md"]
                        ),
                        _ => assert!(fs::read_to_string(destination.join("tasks/active/task.md"))
                            .unwrap()
                            .contains("googleTaskListId: synthetic-list")),
                    }
                }
                assert!(!root.exists(), "original workspace must not be recreated");
                assert!(destination.join("tasks").is_dir());
                #[cfg(unix)]
                if alias {
                    fs::remove_file(alias_path).unwrap();
                }
            }
        }
    }

    #[test]
    #[cfg(unix)]
    fn phase08_12_web_current_policy_in_both_alias_directions_denies_and_releases() {
        use crate::atomic_file::phase08_06::{run, Home};
        use crate::scratchpad::phase08_08::registry;
        let home = Home::new();
        for op in ["apply", "import", "repair"] {
            let tmp = if op == "import" {
                let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
                web_rewrites_top(&tmp, &["tasks/active/b.md"]);
                tmp
            } else {
                setup(
                    "upsert",
                    "tasks/active/task.md",
                    "---\nstatus: active\n---\n# Synthetic\n",
                )
                .0
            };
            let record = (op == "repair").then(|| blocked_web_upsert(&tmp));
            let root = tmp.path().canonicalize().unwrap();
            let alias = home.root.path().join(format!("alias-{op}"));
            std::os::unix::fs::symlink(&root, &alias).unwrap();
            for reverse in [false, true] {
                let (registered, caller) = if reverse {
                    (&alias, &root)
                } else {
                    (&root, &alias)
                };
                for policy in ["readOnly", "delegated"] {
                    registry(registered, policy);
                    let w = caller.to_string_lossy().into_owned();
                    let record = record.clone();
                    let result = run(async move {
                        match op {
                            "apply" => ipc::web_actions_apply(w, NOW.into(), None)
                                .await
                                .map(|_| ())
                                .map_err(IpcError::from),
                            "import" => ipc::web_actions_import_top(w, DAY.into(), None, None)
                                .await
                                .map(|_| ())
                                .map_err(IpcError::from),
                            _ => {
                                let record = record.unwrap();
                                ipc::web_action_repair_task_list_linkage(
                                    w,
                                    record.id.clone(),
                                    record_revision(&record),
                                    record.updated_at,
                                    ID.into(),
                                    record.task_path,
                                    "synthetic-list".into(),
                                )
                                .await
                                .map(|_| ())
                            }
                        }
                    });
                    let error = result.unwrap_err();
                    assert!(error.code.is_empty());
                    assert!(error.message.contains("writes are blocked"), "{error:?}");
                }
            }
            registry(&root, "direct");
            // The same mutation remains available after every rejection.
            match op {
                "apply" => assert_eq!(
                    run(ipc::web_actions_apply(work_path(&tmp), NOW.into(), None))
                        .unwrap()
                        .applied,
                    1
                ),
                "import" => assert!(
                    run(ipc::web_actions_import_top(
                        work_path(&tmp),
                        DAY.into(),
                        None,
                        None
                    ))
                    .unwrap()
                    .changed
                ),
                _ => assert!(
                    repair(&tmp, &record.unwrap(), "synthetic-list")
                        .unwrap()
                        .changed
                ),
            }
        }
    }

    // --- Validation ---------------------------------------------------------

    #[test]
    fn rejects_receipts_that_fail_the_v1_contract() {
        // One field replaced per case; the rest stays valid, so the error
        // always names the field under test.
        let document = |key: &str, value: &str| {
            [
                ("schemaVersion", WEB_ACTION_SCHEMA_VERSION.to_string()),
                ("id", ID.to_string()),
                ("operation", "complete".to_string()),
                ("taskPath", "tasks/active/task.md".to_string()),
                ("expectedTaskBlobSha", "abc123".to_string()),
                ("requestedAt", format!("\"{NOW}\"")),
                ("requestedBy", "web:owner".to_string()),
            ]
            .into_iter()
            .map(|(field, default)| {
                let value = if field == key {
                    value.to_string()
                } else {
                    default
                };
                format!("{field}: {value}\n")
            })
            .collect::<String>()
        };
        let cases = [
            ("schemaVersion", "maru.web-task-action.v2", "schemaVersion"),
            ("id", "not-a-uuid", "uuid"),
            ("operation", "delete", "operation"),
            ("requestedAt", "yesterday", "RFC3339"),
            ("requestedBy", "\"\"", "requestedBy"),
            ("expectedTaskBlobSha", "\"\"", "expectedTaskBlobSha"),
            ("taskPath", "../escape.md", "traversal"),
            // Wrong scalar types still land in the String fields and fail
            // their own validator rather than blowing up the parse.
            ("id", "42", "uuid"),
            ("operation", "true", "operation"),
        ];
        for (key, value, expected) in cases {
            let raw: RawReceipt = serde_yaml::from_str(&document(key, value))
                .unwrap_or_else(|err| panic!("{key}: {value} should still parse: {err}"));
            let err = validate_receipt(&raw)
                .unwrap_err_or_panic(&format!("{key}: {value} must be rejected"));
            assert!(
                err.contains(expected),
                "{key}: {value} -> {err} (expected mention of {expected})"
            );
        }
    }

    #[test]
    fn rejects_traversal_dotfile_secret_and_non_bucket_task_paths() {
        for bad in [
            "",
            "../secrets.md",
            "tasks/../../etc/passwd.md",
            "tasks/active/../../../escape.md",
            "/etc/passwd.md",
            "C:/Windows/system.md",
            "tasks\\active\\task.md",
            ".hidden/task.md",
            "tasks/.hidden/task.md",
            // `_inbox` is a web-only bucket Maru never scans.
            "tasks/_inbox/task.md",
            "tasks/active/.env.md",
            "tasks/active/deploy.key",
            "tasks/active/service.pem",
            "tasks/active/credentials.md",
            // Not markdown, no bucket, wrong root.
            "tasks/active/task.txt",
            "tasks/task.md",
            "notes/active/task.md",
            "tasks/nowhere/task.md",
        ] {
            assert!(validate_task_path(bad).is_err(), "{bad} must be rejected");
        }
        for good in [
            "tasks/active/task.md",
            "tasks/backlog/260816-plan.md",
            "tasks/archive/done.md",
            "tasks/calendar/260816-1300-meeting.md",
            "tasks/active/project/sub-note.md",
        ] {
            validate_task_path(good).unwrap_or_else(|err| panic!("{good} rejected: {err}"));
        }
    }

    #[test]
    fn invalid_receipts_are_reported_and_left_in_place() {
        let tmp = tempfile::tempdir().unwrap();
        let receipt = write_receipt(tmp.path(), ID, "schemaVersion: nope\nid: x\n");
        let outcome = apply(&tmp);
        assert_eq!(outcome.invalid, 1);
        assert_eq!(outcome.applied, 0);
        assert_eq!(outcome.items[0].state, WebActionState::Invalid);
        assert!(receipt.exists(), "invalid receipts stay in pending/");
        assert!(!tmp.path().join(APPLIED_ROOT).exists());
    }

    #[test]
    fn missing_shared_web_directory_is_an_empty_scan() {
        let tmp = tempfile::tempdir().unwrap();
        assert!(web_actions_scan(work_path(&tmp)).unwrap().is_empty());
        assert_eq!(apply(&tmp), WebActionsOutcome::default());
    }

    // --- guarded task-list linkage repair ---------------------------------

    #[test]
    fn repair_changes_only_the_blocked_linkage_and_preserves_note_bytes() {
        let note = "---\nstatus: active\ngoogleTaskListId: invalid-list\nowner: Luca # keep\n---\n# Keep this body byte-for-byte\n";
        let (tmp, _) = setup("upsert", "tasks/active/task.md", note);
        let original = blocked_web_upsert(&tmp);
        let receipt = tmp
            .path()
            .join(APPLIED_ROOT)
            .join("2026-08")
            .join(format!("{ID}.yaml"));
        let receipt_before = fs::read_to_string(&receipt).unwrap();
        let ledger = tmp.path().join(".maru/today/web-actions/applied.jsonl");
        let ledger_before = fs::read_to_string(&ledger).unwrap();
        let expected_note = update_frontmatter_content(
            note,
            "googleTaskListId",
            Some(FrontmatterValue::String("current-list".to_string())),
        )
        .unwrap();

        assert!(repair(&tmp, &original, " current-list ").unwrap().changed);

        assert_eq!(
            fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap(),
            expected_note
        );
        let repaired = read_record(tmp.path(), &original.id).unwrap();
        let mut expected = original.clone();
        expected.google_task_list_id = Some("current-list".to_string());
        expected.record_revision = None;
        expected.record_revision = Some(record_revision(&expected));
        assert_eq!(repaired, expected, "all other outbox fields stay intact");
        assert_eq!(fs::read_to_string(&receipt).unwrap(), receipt_before);
        assert_eq!(fs::read_to_string(&ledger).unwrap(), ledger_before);
    }

    #[test]
    fn repair_is_an_idempotent_local_noop_after_the_linkage_is_fixed() {
        let (tmp, _) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\ngoogleTaskListId: invalid-list\n---\n# Body\n",
        );
        let original = blocked_web_upsert(&tmp);
        assert!(repair(&tmp, &original, "current-list").unwrap().changed);
        let repaired = read_record(tmp.path(), &original.id).unwrap();
        let note_before = fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap();

        assert!(!repair(&tmp, &repaired, "current-list").unwrap().changed);
        assert_eq!(
            fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap(),
            note_before
        );
        assert_eq!(read_record(tmp.path(), &original.id).unwrap(), repaired);
    }

    #[test]
    fn repair_refuses_stale_or_non_matching_guards_without_writing() {
        let (tmp, _) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\ngoogleTaskListId: invalid-list\n---\n# Body\n",
        );
        let original = blocked_web_upsert(&tmp);
        let note_path = tmp.path().join("tasks/active/task.md");
        let record_path = crate::today_store::today_dir(tmp.path())
            .join("outbox")
            .join(format!("{}.json", original.id));
        let note_before = fs::read_to_string(&note_path).unwrap();
        let record_before = fs::read_to_string(&record_path).unwrap();

        let stale = web_action_repair_task_list_linkage(
            work_path(&tmp),
            original.id.clone(),
            "old-rendered-revision".to_string(),
            "old-rendered-revision".to_string(),
            original.web_action_id.clone().unwrap(),
            original.task_path.clone(),
            "current-list".to_string(),
        )
        .unwrap_err();
        assert_eq!(stale.code, WEB_ACTION_REPAIR_CONFLICT);

        for (mut record, list, expected) in [
            (
                {
                    let mut record = original.clone();
                    record.status = OutboxStatus::Ready;
                    record
                },
                "current-list",
                "not eligible",
            ),
            (
                {
                    let mut record = original.clone();
                    record.google_task_id = "provider-task".to_string();
                    record
                },
                "current-list",
                "not eligible",
            ),
            (original.clone(), " ", "default task list"),
        ] {
            write_record(tmp.path(), &record).unwrap();
            let current = read_record(tmp.path(), &record.id).unwrap();
            let err = repair(&tmp, &current, list).unwrap_err();
            assert_eq!(err.code, WEB_ACTION_REPAIR_CONFLICT);
            assert!(
                err.message.to_lowercase().contains(expected),
                "{}",
                err.message
            );
            record = original.clone();
            write_record(tmp.path(), &record).unwrap();
        }
        assert_eq!(fs::read_to_string(&note_path).unwrap(), note_before);
        assert_eq!(fs::read_to_string(&record_path).unwrap(), record_before);
    }

    #[test]
    fn repair_refuses_missing_or_mismatched_receipt_and_provider_linked_note() {
        let (tmp, _) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\ngoogleTaskListId: invalid-list\n---\n# Body\n",
        );
        let original = blocked_web_upsert(&tmp);
        let receipt = tmp
            .path()
            .join(APPLIED_ROOT)
            .join("2026-08")
            .join(format!("{ID}.yaml"));
        fs::remove_file(&receipt).unwrap();
        let err = repair(&tmp, &original, "current-list").unwrap_err();
        assert_eq!(err.code, WEB_ACTION_REPAIR_CONFLICT);
        assert!(err.message.contains("receipt"));

        let receipt_body = format!(
            "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {ID}\noperation: complete\ntaskPath: tasks/active/task.md\nexpectedTaskBlobSha: any\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner\n"
        );
        fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        fs::write(&receipt, receipt_body).unwrap();
        let err = repair(&tmp, &original, "current-list").unwrap_err();
        assert!(err.message.contains("upsert"));

        let note = tmp.path().join("tasks/active/task.md");
        fs::write(
            &note,
            "---\nstatus: active\ngoogleTaskId: already-linked\ngoogleTaskListId: invalid-list\n---\n# Body\n",
        )
        .unwrap();
        let receipt_body = format!(
            "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {ID}\noperation: upsert\ntaskPath: tasks/active/task.md\nexpectedTaskBlobSha: any\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner\n"
        );
        fs::write(&receipt, receipt_body).unwrap();
        let err = repair(&tmp, &original, "current-list").unwrap_err();
        assert!(err.message.contains("already linked"));
    }

    // --- Staleness ----------------------------------------------------------

    #[test]
    fn stale_blob_sha_marks_retry_needed_and_applies_nothing() {
        let (tmp, receipt) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ndone: 2026-08-16\n---\n# Body\n",
        );
        // Local edit after the web committed: the blob no longer matches.
        let note = tmp.path().join("tasks/active/task.md");
        fs::write(
            &note,
            "---\nstatus: done\ndone: 2026-08-16\n---\n# Edited\n",
        )
        .unwrap();

        let outcome = apply(&tmp);
        assert_eq!(outcome.stale, 1);
        assert_eq!(outcome.applied, 0);
        assert_eq!(outcome.items[0].state, WebActionState::Stale);
        assert!(outcome.items[0]
            .reason
            .as_deref()
            .unwrap()
            .contains("task blob changed locally"));
        // Nothing moved, nothing queued, and the receipt carries the marker.
        assert!(note.exists());
        assert!(!tmp.path().join("tasks/archive/task.md").exists());
        assert!(list_records(tmp.path()).unwrap().is_empty());
        let raw = fs::read_to_string(&receipt).unwrap();
        assert!(raw.contains(&format!("status: {RETRY_NEEDED}")));
        // The v1 field set survives the marker splice.
        assert!(raw.contains(&format!("id: {ID}")));
        assert!(raw.contains("operation: complete"));

        // Re-marking is stable: one status line, not two.
        apply(&tmp);
        let raw = fs::read_to_string(&receipt).unwrap();
        assert_eq!(raw.matches("status:").count(), 1);
    }

    #[test]
    fn missing_task_note_is_stale_not_fatal() {
        let (tmp, _) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\n---\n",
        );
        fs::remove_file(tmp.path().join("tasks/active/task.md")).unwrap();
        let outcome = apply(&tmp);
        assert_eq!(outcome.stale, 1);
        assert_eq!(
            outcome.items[0].reason.as_deref(),
            Some("task note is missing")
        );
    }

    // --- complete -----------------------------------------------------------

    #[test]
    fn complete_archives_the_note_queues_one_op_and_acknowledges_the_receipt() {
        // Deliberately a different day from NOW: the desktop must mirror the
        // web's recorded completion time, never restamp with its apply time.
        let (tmp, receipt) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ndone: 2026-08-14\ncompletedAt: \"2026-08-14T23:40:00+09:00\"\ngoogleTaskId: g-1\ngoogleTaskListId: list-1\nowner: Luca\n---\n# Body\n",
        );
        let outcome = apply(&tmp);

        assert_eq!(outcome.applied, 1);
        assert_eq!(outcome.stale, 0);
        assert_eq!(outcome.items[0].state, WebActionState::Applied);

        // Active -> Archive.
        assert!(!tmp.path().join("tasks/active/task.md").exists());
        let archived = fs::read_to_string(tmp.path().join("tasks/archive/task.md")).unwrap();
        // The web-set completion triple survives byte-for-byte, as do unknown keys.
        assert!(archived.contains("status: done"));
        assert!(archived.contains("done: 2026-08-14"), "{archived}");
        assert!(
            archived.contains("completedAt: \"2026-08-14T23:40:00+09:00\""),
            "{archived}"
        );
        assert!(archived.contains("owner: Luca"));

        // Exactly one provider op, stamped with the receipt id.
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].op, OutboxOp::Complete);
        assert_eq!(records[0].status, OutboxStatus::Ready);
        assert_eq!(records[0].google_task_id, "g-1");
        assert_eq!(records[0].web_action_id.as_deref(), Some(ID));

        // pending -> applied, marker-free.
        assert!(!receipt.exists());
        let applied = tmp
            .path()
            .join(APPLIED_ROOT)
            .join("2026-08")
            .join(format!("{ID}.yaml"));
        let raw = fs::read_to_string(&applied).unwrap();
        assert!(!raw.contains("status:"));
        assert!(raw.contains("operation: complete"));
    }

    #[test]
    fn complete_falls_back_to_the_receipt_time_not_the_apply_time() {
        // Defensive: a web complete always writes the triple, but if the note
        // somehow lacks it the receipt's own timestamp is still closer to the
        // truth than the desktop's apply clock.
        let (tmp, _) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ngoogleTaskId: g-1\n---\n# Body\n",
        );
        apply(&tmp);
        let archived = fs::read_to_string(tmp.path().join("tasks/archive/task.md")).unwrap();
        // NOW is the receipt's requestedAt in this fixture.
        assert!(
            archived.contains(&format!("completedAt: \"{NOW}\"")),
            "{archived}"
        );
        assert!(archived.contains("done: 2026-08-16"), "{archived}");
    }

    #[test]
    fn a_completed_receipt_with_no_provider_id_is_still_acknowledged_durably() {
        // No googleTaskId means no outbox record, so the applied ledger is the
        // only thing that stops a replay from reporting the receipt stale
        // forever once its note has been archived.
        let (tmp, receipt) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ndone: 2026-08-16\n---\n# Body\n",
        );
        assert_eq!(apply(&tmp).applied, 1);
        assert!(list_records(tmp.path()).unwrap().is_empty());
        let ledger =
            fs::read_to_string(tmp.path().join(".maru/today/web-actions/applied.jsonl")).unwrap();
        assert!(ledger.contains(ID));
        assert!(ledger.contains("tasks/active/task.md"));

        // Simulate a crash after the transition but before the move: the
        // receipt is back in pending/ while the note is already archived.
        fs::create_dir_all(receipt.parent().unwrap()).unwrap();
        fs::write(
            &receipt,
            format!(
                "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {ID}\noperation: complete\ntaskPath: tasks/active/task.md\nexpectedTaskBlobSha: deadbeef\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner\n"
            ),
        )
        .unwrap();

        // Recovery finishes the move instead of reporting it stale forever.
        let outcome = apply(&tmp);
        assert_eq!(outcome.skipped, 1);
        assert_eq!(outcome.stale, 0);
        assert!(!receipt.exists());
    }

    #[test]
    fn replaying_an_applied_receipt_is_a_no_op() {
        let (tmp, _) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\ngoogleTaskId: g-1\n---\n# Body\n",
        );
        assert_eq!(apply(&tmp).applied, 1);

        // The web re-delivers the same receipt (e.g. a revert + re-pull).
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nstatus: done\ngoogleTaskId: g-1\n---\n# Body\n").unwrap();
        let sha = blob_sha(&note).unwrap();
        write_receipt(
            tmp.path(),
            ID,
            &format!(
                "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {ID}\noperation: complete\ntaskPath: tasks/active/task.md\nexpectedTaskBlobSha: {sha}\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner\n"
            ),
        );

        let outcome = apply(&tmp);
        assert_eq!(outcome.skipped, 1);
        assert_eq!(outcome.applied, 0);
        assert_eq!(outcome.items[0].state, WebActionState::Skipped);
        // Still exactly one provider op, and the note was not re-archived.
        assert_eq!(list_records(tmp.path()).unwrap().len(), 1);
        assert!(note.exists());
    }

    // --- upsert -------------------------------------------------------------

    #[test]
    fn upsert_queues_a_create_with_the_note_title_due_and_default_list() {
        let (tmp, receipt) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\ntitle: 보고서 제출\nstatus: active\ndue: 2026-08-31\n---\n# Body\n",
        );
        let outcome = apply_with_list(&tmp, "list-default");

        assert_eq!(outcome.applied, 1);
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].op, OutboxOp::Upsert);
        assert_eq!(records[0].status, OutboxStatus::Ready);
        // No provider id yet: the drain inserts and fills it in.
        assert_eq!(records[0].google_task_id, "");
        assert_eq!(
            records[0].google_task_list_id.as_deref(),
            Some("list-default")
        );
        assert_eq!(records[0].web_action_id.as_deref(), Some(ID));
        let payload = records[0].payload.as_ref().unwrap();
        assert_eq!(payload.title, "보고서 제출");
        assert_eq!(payload.notes, "File: tasks/active/task.md");
        assert_eq!(payload.due.as_deref(), Some("2026-08-31T00:00:00.000Z"));
        assert!(!receipt.exists());
    }

    #[test]
    fn upsert_prefers_the_notes_own_list_and_id_over_the_default() {
        let (tmp, _) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\ngoogleTaskId: g-existing\ngoogleTaskListId: list-note\n---\n# Fallback title\n",
        );
        apply_with_list(&tmp, "list-default");
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records[0].google_task_id, "g-existing");
        assert_eq!(records[0].google_task_list_id.as_deref(), Some("list-note"));
        // No frontmatter title: the H1 is the display title.
        assert_eq!(records[0].payload.as_ref().unwrap().title, "Fallback title");
        // No due in frontmatter: nothing invented.
        assert!(records[0].payload.as_ref().unwrap().due.is_none());
    }

    #[test]
    fn upsert_without_a_configured_list_defers_to_the_outbox_fallback() {
        let (tmp, _) = setup(
            "upsert",
            "tasks/active/task.md",
            "---\nstatus: active\n---\n# T\n",
        );
        apply(&tmp);
        assert!(list_records(tmp.path()).unwrap()[0]
            .google_task_list_id
            .is_none());
    }

    #[test]
    fn provider_due_normalizes_dates_and_passes_timestamps_through() {
        assert_eq!(
            provider_due("2026-08-31").as_deref(),
            Some("2026-08-31T00:00:00.000Z")
        );
        assert_eq!(
            provider_due("2026-08-31T09:00:00+09:00").as_deref(),
            Some("2026-08-31T09:00:00+09:00")
        );
        assert!(provider_due("").is_none());
        assert!(provider_due("   ").is_none());
        assert!(provider_due("someday").is_none());
    }

    #[test]
    fn scan_reports_pending_receipts_without_touching_them() {
        let (tmp, receipt) = setup(
            "complete",
            "tasks/active/task.md",
            "---\nstatus: done\n---\n# Body\n",
        );
        let before = fs::read_to_string(&receipt).unwrap();
        let items = web_actions_scan(work_path(&tmp)).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].state, WebActionState::Pending);
        assert_eq!(items[0].id, ID);
        assert_eq!(items[0].operation, Some(WebActionOperation::Complete));
        assert_eq!(items[0].task_path, "tasks/active/task.md");
        assert_eq!(items[0].requested_by, "web:owner@example.com");
        assert_eq!(fs::read_to_string(&receipt).unwrap(), before);
        assert!(list_records(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn multiple_receipts_are_applied_in_deterministic_order() {
        let (tmp, _) = setup(
            "complete",
            "tasks/active/a.md",
            "---\nstatus: done\n---\n# A\n",
        );
        let note = tmp.path().join("tasks/active/b.md");
        fs::write(&note, "---\nstatus: done\n---\n# B\n").unwrap();
        let sha = blob_sha(&note).unwrap();
        write_receipt(
            tmp.path(),
            OTHER_ID,
            &format!(
                "schemaVersion: {WEB_ACTION_SCHEMA_VERSION}\nid: {OTHER_ID}\noperation: complete\ntaskPath: tasks/active/b.md\nexpectedTaskBlobSha: {sha}\nrequestedAt: \"{NOW}\"\nrequestedBy: web:owner\n"
            ),
        );

        let outcome = apply(&tmp);
        assert_eq!(outcome.applied, 2);
        // Sorted by receipt path, so the ordering is stable across runs.
        assert_eq!(outcome.items[0].id, ID);
        assert_eq!(outcome.items[1].id, OTHER_ID);
        assert!(tmp.path().join("tasks/archive/a.md").exists());
        assert!(tmp.path().join("tasks/archive/b.md").exists());
    }

    // --- Web-selected Top 3 --------------------------------------------------

    const DAY: &str = "2026-08-16";

    fn task_ref(path: &str) -> PlanItemRef {
        PlanItemRef::Task {
            task_id: path.to_string(),
        }
    }

    fn plan_item(path: &str, lane: PlanLane, order: u32) -> DailyPlanItem {
        DailyPlanItem {
            item_ref: task_ref(path),
            lane,
            order,
            outcome: Some(format!("Ship {path}")),
            estimate_minutes: Some(45),
            estimate_provisional: false,
            pinned: false,
            proposed_block: None,
            calendar_sync: CalendarSyncState::none(),
        }
    }

    /// A workspace with real task notes, a planned snapshot, and the journal
    /// Maru would have projected from it.
    fn setup_day(top: &[&str], flexible: &[&str], overflow: &[&str]) -> tempfile::TempDir {
        let tmp = tempfile::tempdir().unwrap();
        for path in top.iter().chain(flexible).chain(overflow) {
            let note = tmp.path().join(path);
            fs::create_dir_all(note.parent().unwrap()).unwrap();
            fs::write(&note, "---\nstatus: active\n---\n# Task\n").unwrap();
        }
        let mut snapshot = crate::today::TodaySnapshot::new(
            DAY.to_string(),
            NOW.to_string(),
            "Asia/Seoul".to_string(),
            "03:30".to_string(),
            "21:30".to_string(),
        );
        snapshot.day_state = crate::today::DayState::Planned;
        snapshot.plan = Some(DailyPlanV1 {
            logical_day: DAY.to_string(),
            input_revision: String::new(),
            top: top
                .iter()
                .enumerate()
                .map(|(order, path)| plan_item(path, PlanLane::Top, order as u32))
                .collect(),
            flexible: flexible
                .iter()
                .enumerate()
                .map(|(order, path)| plan_item(path, PlanLane::Flexible, order as u32))
                .collect(),
            overflow: overflow
                .iter()
                .enumerate()
                .map(|(order, path)| plan_item(path, PlanLane::Overflow, order as u32))
                .collect(),
            reasons: vec![],
            warnings: vec![],
        });
        crate::today_store::persist_snapshot(tmp.path(), &mut snapshot).unwrap();
        crate::today_store::project_journal(tmp.path(), &tmp.path().join("tasks"), &snapshot)
            .unwrap();
        tmp
    }

    fn journal_path(tmp: &tempfile::TempDir) -> PathBuf {
        tmp.path().join(format!("tasks/daily/{DAY}.md"))
    }

    /// Rewrite the `## Top` entry list the way the web app does.
    fn web_rewrites_top(tmp: &tempfile::TempDir, paths: &[&str]) {
        let path = journal_path(tmp);
        let raw = fs::read_to_string(&path).unwrap();
        let lines: Vec<&str> = raw.lines().collect();
        let heading = lines
            .iter()
            .position(|line| line.trim() == "## Top")
            .unwrap();
        let mut end = heading + 1;
        while end < lines.len() && lines[end].starts_with("- ") {
            end += 1;
        }
        let mut next: Vec<String> = lines[..=heading].iter().map(ToString::to_string).collect();
        next.extend(paths.iter().map(|path| format!("- {path} (30m)")));
        next.extend(lines[end..].iter().map(ToString::to_string));
        fs::write(&path, next.join("\n")).unwrap();
    }

    fn import(tmp: &tempfile::TempDir) -> TopImportOutcome {
        web_actions_import_top(work_path(tmp), DAY.to_string(), None, None).unwrap()
    }

    /// Import with an explicit `tasks.today.topLaneSize`.
    fn import_sized(tmp: &tempfile::TempDir, lane: usize) -> TopImportOutcome {
        web_actions_import_top(work_path(tmp), DAY.to_string(), None, Some(lane)).unwrap()
    }

    fn preview(tmp: &tempfile::TempDir) -> TopImportOutcome {
        web_actions_import_top(work_path(tmp), DAY.to_string(), Some(true), None).unwrap()
    }

    fn plan_of(tmp: &tempfile::TempDir) -> DailyPlanV1 {
        crate::today_store::load_snapshot(tmp.path(), DAY)
            .unwrap()
            .plan
            .unwrap()
    }

    fn ids(items: &[DailyPlanItem]) -> Vec<String> {
        items
            .iter()
            .map(|item| item.item_ref.id().to_string())
            .collect()
    }

    #[test]
    fn journal_entry_grammar_round_trips_maru_own_lines() {
        assert_eq!(
            journal_entry_path("- tasks/active/a.md (30m)").as_deref(),
            Some("tasks/active/a.md")
        );
        assert_eq!(
            journal_entry_path("- tasks/active/a.md (estimate pending)").as_deref(),
            Some("tasks/active/a.md")
        );
        assert_eq!(
            journal_entry_path("- tasks/active/a.md (45m): Ship the release").as_deref(),
            Some("tasks/active/a.md")
        );
        // Bare path (a hand-edited line) still yields the path.
        assert_eq!(
            journal_entry_path("- tasks/active/a.md").as_deref(),
            Some("tasks/active/a.md")
        );
        // An outcome carrying its own parentheses must not be mistaken for
        // the duration group.
        assert_eq!(
            journal_entry_path("- tasks/active/a.md (45m): Call Alice (follow up)").as_deref(),
            Some("tasks/active/a.md")
        );
        // journal_item_line emits `- <ref>: <outcome>` when an item has an
        // outcome but neither an estimate nor the provisional flag.
        assert_eq!(
            journal_entry_path("- tasks/active/a.md: Ship it").as_deref(),
            Some("tasks/active/a.md")
        );
        assert_eq!(
            journal_entry_path("- tasks/active/a.md: Call Alice (follow up)").as_deref(),
            Some("tasks/active/a.md")
        );
        // Capture-backed items carry an opaque id, not a path.
        assert_eq!(
            journal_entry_path("- capture-abc123 (30m)").as_deref(),
            Some("capture-abc123")
        );
        // Not entries.
        assert!(journal_entry_path("## Flexible").is_none());
        assert!(journal_entry_path("").is_none());
        assert!(journal_entry_path("- ").is_none());
    }

    #[test]
    fn a_dry_run_reports_a_pending_import_without_writing_anything() {
        let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
        assert_eq!(preview(&tmp).changed, false);

        web_rewrites_top(&tmp, &["tasks/active/b.md"]);
        let before =
            fs::read_to_string(tmp.path().join(format!(".maru/today/{DAY}.json"))).unwrap();
        let outcome = preview(&tmp);
        assert!(outcome.changed);
        assert_eq!(outcome.imported, 1);
        assert_eq!(outcome.reason.as_deref(), Some("pending"));
        // Nothing written: the snapshot is byte-identical.
        assert_eq!(
            fs::read_to_string(tmp.path().join(format!(".maru/today/{DAY}.json"))).unwrap(),
            before
        );
        // And the real import still lands afterwards.
        assert!(import(&tmp).changed);
    }

    #[test]
    fn import_promotes_web_selection_and_preserves_the_other_lanes() {
        let tmp = setup_day(
            &["tasks/active/a.md"],
            &["tasks/active/b.md", "tasks/active/c.md"],
            &["tasks/active/d.md"],
        );
        // The web picks b (from Flexible) and a fresh note, dropping a.
        let fresh = tmp.path().join("tasks/active/e.md");
        fs::write(&fresh, "---\nstatus: active\n---\n# E\n").unwrap();
        web_rewrites_top(&tmp, &["tasks/active/b.md", "tasks/active/e.md"]);

        let outcome = import(&tmp);
        assert_eq!(
            outcome,
            TopImportOutcome {
                imported: 2,
                changed: true,
                truncated: 0,
                reason: None
            }
        );

        let plan = plan_of(&tmp);
        assert_eq!(ids(&plan.top), ["tasks/active/b.md", "tasks/active/e.md"]);
        // A promoted item keeps its estimate and outcome; a new one is provisional.
        assert_eq!(plan.top[0].estimate_minutes, Some(45));
        assert_eq!(
            plan.top[0].outcome.as_deref(),
            Some("Ship tasks/active/b.md")
        );
        assert!(plan.top[1].estimate_provisional);
        assert!(plan.top[1].estimate_minutes.is_none());
        // Displaced Top item leads Flexible; b is no longer duplicated there.
        assert_eq!(
            ids(&plan.flexible),
            ["tasks/active/a.md", "tasks/active/c.md"]
        );
        // Overflow untouched.
        assert_eq!(ids(&plan.overflow), ["tasks/active/d.md"]);
        // Lanes are renumbered, so validate_plan and the UI agree on order.
        assert_eq!(
            plan.top.iter().map(|item| item.order).collect::<Vec<_>>(),
            [0, 1]
        );
        assert_eq!(
            plan.flexible
                .iter()
                .map(|item| item.order)
                .collect::<Vec<_>>(),
            [0, 1]
        );
    }

    #[test]
    fn journal_entries_that_are_not_paths_resolve_against_the_existing_plan() {
        // `journal_item_line` writes item_ref.id(), which for a capture-backed
        // item is an opaque id, not a note path. Requiring every entry to be a
        // path would silently drop those items out of Top on any import.
        let tmp = setup_day(&["tasks/active/a.md"], &[], &[]);
        let mut snapshot = crate::today_store::load_snapshot(tmp.path(), DAY).unwrap();
        let plan = snapshot.plan.as_mut().unwrap();
        plan.top.push(DailyPlanItem {
            item_ref: PlanItemRef::Capture {
                capture_id: "capture-abc123".to_string(),
            },
            lane: PlanLane::Top,
            order: 1,
            outcome: Some("Review the captured request".to_string()),
            estimate_minutes: Some(20),
            estimate_provisional: false,
            pinned: false,
            proposed_block: None,
            calendar_sync: CalendarSyncState::none(),
        });
        crate::today_store::persist_snapshot(tmp.path(), &mut snapshot).unwrap();
        crate::today_store::project_journal(tmp.path(), &tmp.path().join("tasks"), &snapshot)
            .unwrap();

        // Untouched journal: the capture entry must survive, not be dropped.
        assert_eq!(import(&tmp).reason.as_deref(), Some("already_current"));

        // The web reorders, keeping the capture. Its ref stays a Capture, so
        // the stable identity (and its estimate/outcome) is preserved.
        web_rewrites_top(&tmp, &["capture-abc123", "tasks/active/a.md"]);
        assert!(import(&tmp).changed);
        let plan = plan_of(&tmp);
        assert_eq!(ids(&plan.top), ["capture-abc123", "tasks/active/a.md"]);
        assert!(matches!(plan.top[0].item_ref, PlanItemRef::Capture { .. }));
        assert_eq!(plan.top[0].estimate_minutes, Some(20));
    }

    #[test]
    fn import_clamps_to_the_lane_cap_and_drops_unknown_paths() {
        let tmp = setup_day(&["tasks/active/a.md"], &[], &[]);
        for name in ["b", "c", "d"] {
            fs::write(
                tmp.path().join(format!("tasks/active/{name}.md")),
                "---\nstatus: active\n---\n",
            )
            .unwrap();
        }
        web_rewrites_top(
            &tmp,
            &[
                // Rejected by the path policy, never by silently trusting it.
                "tasks/_inbox/hidden.md",
                "../escape.md",
                // Valid shape but no such note.
                "tasks/active/ghost.md",
                // Duplicate of the first accepted entry.
                "tasks/active/b.md",
                "tasks/active/b.md",
                "tasks/active/c.md",
                "tasks/active/d.md",
                // Beyond TOP_LANE_DEFAULT.
                "tasks/active/a.md",
            ],
        );

        let outcome = import(&tmp);
        assert_eq!(outcome.imported, TOP_LANE_DEFAULT);
        assert_eq!(
            ids(&plan_of(&tmp).top),
            [
                "tasks/active/b.md",
                "tasks/active/c.md",
                "tasks/active/d.md"
            ]
        );
        // Four entries resolved (b, c, d, a); the default lane took three. The
        // rejects and the duplicate are not truncation, so this is 1 and not
        // the 5 a `paths.len() - imported` would have claimed.
        assert_eq!(outcome.truncated, 1);
    }

    /// The lane size is the caller's setting, not a constant: a wider lane
    /// takes the entry the default dropped, and reports nothing truncated.
    #[test]
    fn import_fills_the_configured_lane_rather_than_the_default() {
        let tmp = setup_day(&["tasks/active/a.md"], &[], &[]);
        for name in ["b", "c", "d"] {
            fs::write(
                tmp.path().join(format!("tasks/active/{name}.md")),
                "---\nstatus: active\n---\n",
            )
            .unwrap();
        }
        let entries = [
            "tasks/active/b.md",
            "tasks/active/c.md",
            "tasks/active/d.md",
            "tasks/active/a.md",
        ];
        web_rewrites_top(&tmp, &entries);

        let outcome = import_sized(&tmp, 5);
        assert_eq!(outcome.imported, 4);
        assert_eq!(outcome.truncated, 0);
        assert_eq!(ids(&plan_of(&tmp).top), entries);
    }

    /// The quiet case: the lane already holds what fits, so nothing changes and
    /// the run reports "already_current" -- but entries are still being dropped
    /// on every poll. Reporting 0 there would hide it permanently.
    #[test]
    fn import_reports_truncation_even_when_the_lane_is_already_current() {
        let tmp = setup_day(&["tasks/active/a.md"], &[], &[]);
        for name in ["b", "c"] {
            fs::write(
                tmp.path().join(format!("tasks/active/{name}.md")),
                "---\nstatus: active\n---\n",
            )
            .unwrap();
        }
        // The plan already holds what a lane of one can take, and the web wrote
        // two more. No import will ever move them, so the run has to say so.
        web_rewrites_top(
            &tmp,
            &[
                "tasks/active/a.md",
                "tasks/active/b.md",
                "tasks/active/c.md",
            ],
        );

        let outcome = import_sized(&tmp, 1);
        assert!(!outcome.changed);
        assert_eq!(outcome.reason.as_deref(), Some("already_current"));
        assert_eq!(outcome.truncated, 2);
    }

    /// Out-of-range sizes are clamped, not trusted: the argument crosses IPC.
    /// Zero would empty the lane; past the ceiling would build a plan
    /// `validate_plan` rejects.
    #[test]
    fn import_clamps_a_caller_supplied_lane_size_into_range() {
        let tmp = setup_day(&["tasks/active/a.md"], &[], &[]);
        for name in ["b", "c"] {
            fs::write(
                tmp.path().join(format!("tasks/active/{name}.md")),
                "---\nstatus: active\n---\n",
            )
            .unwrap();
        }
        web_rewrites_top(
            &tmp,
            &[
                "tasks/active/b.md",
                "tasks/active/c.md",
                "tasks/active/a.md",
            ],
        );

        let outcome = import_sized(&tmp, 0);
        assert_eq!(outcome.imported, 1, "0 clamps up to 1");
        assert_eq!(outcome.truncated, 2);
        assert_eq!(ids(&plan_of(&tmp).top), ["tasks/active/b.md"]);
    }

    #[test]
    fn import_is_a_no_op_when_the_journal_already_matches() {
        let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
        let before =
            fs::read_to_string(tmp.path().join(format!(".maru/today/{DAY}.json"))).unwrap();
        let outcome = import(&tmp);
        assert_eq!(outcome.changed, false);
        assert_eq!(outcome.reason.as_deref(), Some("already_current"));
        assert_eq!(
            fs::read_to_string(tmp.path().join(format!(".maru/today/{DAY}.json"))).unwrap(),
            before
        );
    }

    #[test]
    fn import_merges_into_current_state_rather_than_restoring_a_stale_snapshot() {
        let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
        // Maru edits the day locally first...
        let snapshot = crate::today_store::load_snapshot(tmp.path(), DAY).unwrap();
        today_mutate(
            work_path(&tmp),
            DAY.to_string(),
            snapshot.revision,
            TodayMutation::SetBrainDump {
                brain_dump: "local edit".to_string(),
            },
        )
        .unwrap();
        // ...then the pulled web edit is applied on top.
        web_rewrites_top(&tmp, &["tasks/active/b.md"]);

        assert!(import(&tmp).changed);
        // The import mutates against the revision it just read, so unrelated
        // local state survives — it never writes back a snapshot captured
        // before the local edit.
        let snapshot = crate::today_store::load_snapshot(tmp.path(), DAY).unwrap();
        assert_eq!(snapshot.brain_dump, "local edit");
        assert_eq!(ids(&snapshot.plan.unwrap().top), ["tasks/active/b.md"]);
        // A stale revision is still rejected by today_mutate, which is what
        // makes a real read/write race lose cleanly instead of clobbering.
        let stale = today_mutate(
            work_path(&tmp),
            DAY.to_string(),
            "stale-revision".to_string(),
            TodayMutation::SetBrainDump {
                brain_dump: "racing".to_string(),
            },
        )
        .unwrap_err();
        assert_eq!(stale.code, "today_conflict");
    }

    #[test]
    fn a_local_mutation_reprojects_the_journal_so_an_unimported_web_edit_loses() {
        // The journal is Maru's one-way projection: any mutation of a planned
        // day rewrites the whole managed block. A web Top edit that is not
        // imported before the next local mutation is therefore lost — cleanly,
        // and by design, since the local snapshot is the source of truth.
        let tmp = setup_day(&["tasks/active/a.md"], &["tasks/active/b.md"], &[]);
        web_rewrites_top(&tmp, &["tasks/active/b.md"]);
        assert_eq!(
            read_journal_top(&fs::read_to_string(journal_path(&tmp)).unwrap()).unwrap(),
            ["tasks/active/b.md"]
        );

        let snapshot = crate::today_store::load_snapshot(tmp.path(), DAY).unwrap();
        today_mutate(
            work_path(&tmp),
            DAY.to_string(),
            snapshot.revision,
            TodayMutation::SetBrainDump {
                brain_dump: "local edit".to_string(),
            },
        )
        .unwrap();

        // Re-projected back to Maru's Top, so the import has nothing to do.
        assert_eq!(
            read_journal_top(&fs::read_to_string(journal_path(&tmp)).unwrap()).unwrap(),
            ["tasks/active/a.md"]
        );
        assert_eq!(import(&tmp).reason.as_deref(), Some("already_current"));
        assert_eq!(ids(&plan_of(&tmp).top), ["tasks/active/a.md"]);
    }

    #[test]
    fn plan_with_top_declines_nothing_and_never_duplicates_a_ref() {
        let plan = DailyPlanV1 {
            logical_day: DAY.to_string(),
            input_revision: String::new(),
            top: vec![plan_item("tasks/active/a.md", PlanLane::Top, 0)],
            flexible: vec![plan_item("tasks/active/b.md", PlanLane::Flexible, 0)],
            overflow: vec![plan_item("tasks/active/c.md", PlanLane::Overflow, 0)],
            reasons: vec![],
            warnings: vec![],
        };
        let next = plan_with_top(
            &plan,
            "rev-1",
            &[task_ref("tasks/active/c.md"), task_ref("tasks/active/b.md")],
        );
        assert_eq!(next.input_revision, "rev-1");
        assert_eq!(ids(&next.top), ["tasks/active/c.md", "tasks/active/b.md"]);
        assert_eq!(ids(&next.flexible), ["tasks/active/a.md"]);
        assert!(next.overflow.is_empty());
        // No ref appears twice — validate_plan would reject the plan otherwise.
        let all = ids(&next.items().cloned().collect::<Vec<_>>());
        let mut sorted = all.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), all.len());
    }

    #[test]
    fn import_skips_without_a_journal_snapshot_or_top_section() {
        // No journal at all.
        let tmp = tempfile::tempdir().unwrap();
        assert_eq!(import(&tmp).reason.as_deref(), Some("journal_missing"));

        // Journal without the managed block.
        let tmp = tempfile::tempdir().unwrap();
        let journal = journal_path(&tmp);
        fs::create_dir_all(journal.parent().unwrap()).unwrap();
        fs::write(&journal, "# Today\n\n- tasks/active/a.md (30m)\n").unwrap();
        assert_eq!(
            import(&tmp).reason.as_deref(),
            Some("journal_top_section_missing")
        );

        // Managed block, no Top section, and no snapshot behind it.
        fs::write(
            &journal,
            format!("{JOURNAL_START_MARKER}\n# Today: {DAY}\n\n## Flexible\n- tasks/active/a.md (30m)\n{JOURNAL_END_MARKER}\n"),
        )
        .unwrap();
        assert_eq!(
            import(&tmp).reason.as_deref(),
            Some("journal_top_section_missing")
        );

        // Top section present, but no day snapshot to reconcile into.
        fs::write(
            &journal,
            format!("{JOURNAL_START_MARKER}\n# Today: {DAY}\n\n## Top\n- tasks/active/a.md (30m)\n{JOURNAL_END_MARKER}\n"),
        )
        .unwrap();
        assert_eq!(import(&tmp).reason.as_deref(), Some("today_state_missing"));
    }

    // Work item 6 (status alignment) needs no code here: Maru already
    // accepts every status the web writes. Asserted where the parser lives,
    // in `tasks::tests::parse_task_status_accepts_legacy_open_alias`.

    /// `Result::unwrap_err` with a message, so the validation table above
    /// names the case that failed instead of printing a bare `Ok(..)`.
    trait UnwrapErrOrPanic<T> {
        fn unwrap_err_or_panic(self, message: &str) -> String;
    }

    impl<T: std::fmt::Debug> UnwrapErrOrPanic<T> for Result<T, String> {
        fn unwrap_err_or_panic(self, message: &str) -> String {
            match self {
                Ok(value) => panic!("{message}, got Ok({value:?})"),
                Err(err) => err,
            }
        }
    }
}
