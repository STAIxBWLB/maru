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

use crate::atomic_file::write_atomic;
use crate::document::revision_for;
use crate::tasks::{
    normalize_task_frontmatter_aliases, string_field, task_display_title, yaml_to_json, TaskBucket,
};
use crate::today::{TaskTransitionKind, TaskTransitionRequest};
use crate::today_lifecycle::{move_file, task_transition};
use crate::today_outbox::{
    enqueue_record, has_web_action, OutboxOp, OutboxStatus, UpsertPayload,
};
use crate::vault::{normalize_existing_dir, parse_frontmatter, resolve_inside_vault};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;
use chrono::DateTime;
use serde::{Deserialize, Serialize};
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
    let root = work.join(PENDING_ROOT);
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
    write_atomic(path, rewrite_status_line(&raw, Some(RETRY_NEEDED)).as_bytes())
}

/// Move a receipt to `applied/`, dropping any `retry-needed` marker a
/// previous run left on it.
fn move_to_applied(work: &Path, receipt_path: &Path) -> Result<String, String> {
    let raw = fs::read_to_string(receipt_path).map_err(|err| format!("Cannot read receipt: {err}"))?;
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
    let output = Command::new("git")
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
fn load_receipt(work: &Path, path: &Path) -> Result<Receipt, WebActionSummary> {
    let raw = fs::read_to_string(path)
        .map_err(|err| invalid_summary(work, path, None, format!("Cannot read receipt: {err}")))?;
    let parsed: RawReceipt = serde_yaml::from_str(&raw)
        .map_err(|err| invalid_summary(work, path, None, format!("Cannot parse receipt: {err}")))?;
    validate_receipt(&parsed).map_err(|reason| invalid_summary(work, path, Some(&parsed), reason))
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
    enqueue_record(
        work,
        OutboxOp::Upsert,
        &receipt.task_path,
        // Empty on first sight of the task: the drain inserts, then writes
        // the returned id back into the note.
        &string_field(&frontmatter, "googleTaskId").unwrap_or_default(),
        list_id,
        Some(payload),
        // Ready, not Prepared: the web already committed the note, so there
        // is no local mutation for recovery to reconcile against.
        OutboxStatus::Ready,
        Some(receipt.id.clone()),
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
            let done = string_field(&frontmatter, "done").unwrap_or_else(|| {
                completed_at
                    .get(..10)
                    .unwrap_or(&completed_at)
                    .to_string()
            });
            task_transition(
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
            )?;
            ledger_append(work, receipt, now_iso)?;
            Ok(WebActionState::Applied)
        }
        WebActionOperation::Upsert => {
            queue_upsert(work, &note, receipt, default_task_list_id, now_iso)?;
            ledger_append(work, receipt, now_iso)?;
            Ok(WebActionState::Applied)
        }
    }
}

// --- Commands -----------------------------------------------------------------

/// Pending web-action receipts, for the sync panel's badge. Read-only:
/// invalid receipts are reported, never rewritten.
#[tauri::command(async)]
pub fn web_actions_scan(work_path: String) -> Result<Vec<WebActionSummary>, String> {
    let work = normalize_existing_dir(&work_path)?;
    Ok(pending_receipt_files(&work)
        .into_iter()
        .map(|path| match load_receipt(&work, &path) {
            Ok(receipt) => summary_for(&work, &path, &receipt, WebActionState::Pending, None),
            Err(summary) => summary,
        })
        .collect())
}

/// Apply pending web-action receipts. Explicit and local-only: it never
/// stages, commits, or pushes — the pending -> applied move is a working-tree
/// change that rides the user's normal Git Sync cadence.
#[tauri::command(async)]
pub fn web_actions_apply(
    work_path: String,
    now_iso: String,
    default_task_list_id: Option<String>,
) -> Result<WebActionsOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    DateTime::parse_from_rfc3339(&now_iso).map_err(|err| format!("now_iso must be RFC3339: {err}"))?;
    let work = normalize_existing_dir(&work_path)?;
    let mut outcome = WebActionsOutcome::default();
    for path in pending_receipt_files(&work) {
        let receipt = match load_receipt(&work, &path) {
            Ok(receipt) => receipt,
            Err(summary) => {
                outcome.invalid += 1;
                outcome.items.push(summary);
                continue;
            }
        };
        // Each receipt is applied independently: `task_transition` takes the
        // workspace lock itself, so this loop must never hold it.
        match apply_receipt(
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today_outbox::{list_records, OutboxOp, OutboxStatus};

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
        let path = work.join(PENDING_ROOT).join("2026-08").join(format!("{id}.yaml"));
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
                let value = if field == key { value.to_string() } else { default };
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
            assert!(
                validate_task_path(bad).is_err(),
                "{bad} must be rejected"
            );
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
        fs::write(&note, "---\nstatus: done\ndone: 2026-08-16\n---\n# Edited\n").unwrap();

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
        let (tmp, _) = setup("complete", "tasks/active/task.md", "---\nstatus: done\n---\n");
        fs::remove_file(tmp.path().join("tasks/active/task.md")).unwrap();
        let outcome = apply(&tmp);
        assert_eq!(outcome.stale, 1);
        assert_eq!(outcome.items[0].reason.as_deref(), Some("task note is missing"));
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
        let applied = tmp.path().join(APPLIED_ROOT).join("2026-08").join(format!("{ID}.yaml"));
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
        assert!(archived.contains(&format!("completedAt: \"{NOW}\"")), "{archived}");
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
        let ledger = fs::read_to_string(
            tmp.path().join(".maru/today/web-actions/applied.jsonl"),
        )
        .unwrap();
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
        assert_eq!(records[0].google_task_list_id.as_deref(), Some("list-default"));
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
        let (tmp, _) = setup("upsert", "tasks/active/task.md", "---\nstatus: active\n---\n# T\n");
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
