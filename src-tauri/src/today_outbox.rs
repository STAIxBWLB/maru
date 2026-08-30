// Maru Today — Google Tasks integration outbox.
//
// Every provider mutation is first recorded durably as JSON in
// `<work>/.maru/today/outbox/<id>.json`, then drained by shelling out to the
// user's `gws` CLI (same spawn conventions as gmail_gws.rs: explicit override
// → PATH probe, augmented PATH, stdout/stderr capture, auth classification).
//
// Crash-recovery semantics:
// - `prepared`: written BEFORE the local task mutation. On recovery, a
//   prepared record whose task note shows the local mutation landed (op-
//   aware: complete → note done, reopen → note no longer done, delete →
//   note gone) is marked `ready` (sync is still owed); otherwise it is
//   dropped (the mutation never happened, so nothing to sync).
// - `syncing`: set while a gws call is in flight. A crash leaves it behind;
//   recovery/drain treat it as `ready` (gws ops are idempotent, so a repeat
//   is safe).
// - `retryNeeded`: retried once `nextRetryAt <= now` on the backoff schedule
//   1, 5, 15, 60 minutes, then hourly.
// - `authBlocked`: skipped by drain until `task_integrations_retry` requeues.

use crate::atomic_file::write_atomic;
use crate::cli_path::{augmented_path, is_executable, resolve_program};
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::gmail_gws::classify_gws_auth_state;
use crate::today_store::today_dir;
use crate::vault::{normalize_existing_dir, parse_frontmatter};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutboxOp {
    Complete,
    Reopen,
    Delete,
    /// Create-or-update the provider task from the note (web-originated).
    /// Unlike the other ops it carries a `payload` and, on creation, writes
    /// the returned id back into the note's frontmatter.
    Upsert,
}

/// Provider-task fields for an `Upsert`, snapshotted from the note when the
/// record is enqueued so the drain never has to re-read the file.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UpsertPayload {
    pub title: String,
    pub notes: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub due: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum OutboxStatus {
    Prepared,
    Ready,
    Syncing,
    Synced,
    RetryNeeded,
    AuthBlocked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecord {
    pub id: String,
    pub op: OutboxOp,
    pub task_path: String,
    /// Provider task id. Empty only for an `Upsert` that has not created the
    /// task yet — the drain then inserts and fills this in before marking the
    /// record synced, so a retry patches instead of inserting twice.
    pub google_task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_task_list_id: Option<String>,
    /// `Upsert` only: the fields to send to the provider.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<UpsertPayload>,
    pub status: OutboxStatus,
    /// Id of the `maru.web-task-action.v1` receipt this record was created
    /// from (`web_actions.rs`). Present only for web-originated ops; it is
    /// how a replayed receipt is recognized as already applied.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub web_action_id: Option<String>,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// Canonical identity returned to the UI only. It is never persisted in
    /// the durable JSON record, so a rendered revision cannot become mutable
    /// outbox state by accident.
    #[serde(default, skip_deserializing, skip_serializing_if = "Option::is_none")]
    pub record_revision: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DrainOutcome {
    pub drained: usize,
    pub failed: usize,
    pub blocked: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RetryOutcome {
    pub requeued: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OutboxRecovery {
    pub recovered: usize,
    pub dropped: usize,
}

// --- Storage ----------------------------------------------------------------

fn outbox_dir_for(work: &Path) -> PathBuf {
    today_dir(work).join("outbox")
}

fn record_path(work: &Path, id: &str) -> PathBuf {
    outbox_dir_for(work).join(format!("{id}.json"))
}

fn validate_record_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    {
        return Err("outbox record id is invalid".to_string());
    }
    Ok(())
}

/// Read one exact outbox record for a guarded operation. Unlike `list_records`,
/// malformed JSON is an error rather than an entry silently omitted from a UI
/// listing.
pub(crate) fn read_record(work: &Path, id: &str) -> Result<OutboxRecord, String> {
    validate_record_id(id)?;
    let raw = fs::read_to_string(record_path(work, id))
        .map_err(|err| format!("Cannot read outbox record: {err}"))?;
    let mut record = serde_json::from_str::<OutboxRecord>(&raw)
        .map_err(|err| format!("Cannot parse outbox record: {err}"))?;
    if record.id != id {
        return Err("outbox record identity does not match its file".to_string());
    }
    record.record_revision = Some(record_revision(&record));
    Ok(record)
}

/// The only linkage shapes the one-off web-action repair may replace. A
/// populated linkage is accepted only when the durable provider error itself
/// identifies it as unusable; this avoids turning the action into a generic
/// list selector for ordinary `authBlocked` records.
pub(crate) fn has_unusable_task_list_linkage(record: &OutboxRecord) -> bool {
    if record
        .google_task_list_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_none()
    {
        return true;
    }
    let detail = record
        .last_error
        .as_deref()
        .unwrap_or_default()
        .to_lowercase();
    (detail.contains("invalid task list")
        || detail.contains("invalid tasklist")
        || detail.contains("task list not found")
        || detail.contains("tasklist not found"))
        && (detail.contains("task list") || detail.contains("tasklist"))
}

pub(crate) fn write_record(work: &Path, record: &OutboxRecord) -> Result<(), String> {
    let mut stored = record.clone();
    stored.record_revision = None;
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|err| format!("Cannot serialize outbox record: {err}"))?;
    write_atomic(&record_path(work, &record.id), json.as_bytes())
}

/// Stable identity for an outbox record as rendered to Today. The transient
/// wire-only field is excluded so the revision describes only durable state.
pub(crate) fn record_revision(record: &OutboxRecord) -> String {
    let mut stable = record.clone();
    stable.record_revision = None;
    let json = serde_json::to_string(&stable).expect("OutboxRecord must serialize");
    crate::document::revision_for(&json)
}

pub(crate) fn list_records(work: &Path) -> Result<Vec<OutboxRecord>, String> {
    let dir = outbox_dir_for(work);
    let mut records = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return Ok(records);
    };
    for entry in entries.filter_map(Result::ok) {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        let Ok(raw) = fs::read_to_string(&path) else {
            continue;
        };
        if let Ok(mut record) = serde_json::from_str::<OutboxRecord>(&raw) {
            record.record_revision = Some(record_revision(&record));
            records.push(record);
        }
    }
    records.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(records)
}

/// The record content `enqueue_record` writes, everything except the
/// workspace and the timestamp it stamps the record with. Bundled to keep
/// the function's argument count under clippy's threshold.
pub(crate) struct OutboxRecordDraft {
    pub op: OutboxOp,
    pub task_path: String,
    pub google_task_id: String,
    pub google_task_list_id: Option<String>,
    pub payload: Option<UpsertPayload>,
    pub status: OutboxStatus,
    pub web_action_id: Option<String>,
}

/// Persist a new outbox record. Written BEFORE the local mutation when
/// `status` is `Prepared` (see crash-recovery semantics in the module docs).
pub(crate) fn enqueue_record(
    work: &Path,
    draft: OutboxRecordDraft,
    now_iso: &str,
) -> Result<OutboxRecord, String> {
    let OutboxRecordDraft {
        op,
        task_path,
        google_task_id,
        google_task_list_id,
        payload,
        status,
        web_action_id,
    } = draft;
    let stamp = now_iso.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let unique = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let record = OutboxRecord {
        id: format!("{stamp}-{unique}"),
        op,
        task_path,
        google_task_id,
        google_task_list_id,
        payload,
        status,
        web_action_id,
        attempts: 0,
        next_retry_at: None,
        last_error: None,
        created_at: now_iso.to_string(),
        updated_at: now_iso.to_string(),
        record_revision: None,
    };
    write_record(work, &record)?;
    Ok(record)
}

pub(crate) fn set_record_status(
    work: &Path,
    record: &mut OutboxRecord,
    status: OutboxStatus,
    now_iso: &str,
) -> Result<(), String> {
    record.status = status;
    record.updated_at = now_iso.to_string();
    write_record(work, record)
}

/// True when a `complete` op for this provider task already drained
/// successfully — the condition under which a local reopen must be mirrored
/// to the provider.
pub(crate) fn has_synced_complete(work: &Path, google_task_id: &str) -> Result<bool, String> {
    Ok(list_records(work)?.iter().any(|record| {
        record.op == OutboxOp::Complete
            && record.status == OutboxStatus::Synced
            && record.google_task_id == google_task_id
    }))
}

/// True when a record for this web-action receipt id already exists — the
/// receipt's provider op was queued on an earlier apply, so replaying it must
/// not queue a second one.
pub(crate) fn has_web_action(work: &Path, web_action_id: &str) -> Result<bool, String> {
    Ok(list_records(work)?
        .iter()
        .any(|record| record.web_action_id.as_deref() == Some(web_action_id)))
}

// --- Recovery ----------------------------------------------------------------

/// Reconcile crash-interrupted records. Tolerant by design: callers (e.g.
/// `today_open`) treat a failure here as log-worthy, never fatal.
pub fn recover_outbox(work: &Path) -> Result<OutboxRecovery, String> {
    let now = Utc::now().to_rfc3339();
    let mut outcome = OutboxRecovery {
        recovered: 0,
        dropped: 0,
    };
    for mut record in list_records(work)? {
        match record.status {
            OutboxStatus::Syncing => {
                set_record_status(work, &mut record, OutboxStatus::Ready, &now)?;
                outcome.recovered += 1;
            }
            OutboxStatus::Prepared => {
                if local_mutation_landed(work, &record) {
                    set_record_status(work, &mut record, OutboxStatus::Ready, &now)?;
                    outcome.recovered += 1;
                } else {
                    fs::remove_file(record_path(work, &record.id))
                        .map_err(|err| format!("Cannot drop prepared outbox record: {err}"))?;
                    outcome.dropped += 1;
                }
            }
            _ => {}
        }
    }
    Ok(outcome)
}

/// Op-aware "did the local mutation land" predicate for prepared records.
/// The record path is the pre-move note path (ready lands before any bucket
/// move), so the note is expected there in every prepared crash window.
fn local_mutation_landed(work: &Path, record: &OutboxRecord) -> bool {
    match record.op {
        OutboxOp::Complete => matches!(
            task_note_status(work, &record.task_path),
            Some(status) if status.eq_ignore_ascii_case("done")
        ),
        OutboxOp::Reopen => matches!(
            task_note_status(work, &record.task_path),
            Some(status) if !status.eq_ignore_ascii_case("done")
        ),
        OutboxOp::Delete => !work.join(&record.task_path).exists(),
        // Upsert records are enqueued `ready` (the web already committed the
        // note), so they never reach recovery as `prepared`; the note simply
        // has to still be there for the op to mean anything.
        OutboxOp::Upsert => work.join(&record.task_path).exists(),
    }
}

fn task_note_status(work: &Path, task_path: &str) -> Option<String> {
    let raw = fs::read_to_string(work.join(task_path)).ok()?;
    let parts = parse_frontmatter(&raw);
    let frontmatter = crate::tasks::yaml_to_json(&parts.meta);
    crate::tasks::string_field(&frontmatter, "status")
}

// --- gws spawning -------------------------------------------------------------

pub(crate) fn resolve_gws(override_path: Option<&str>) -> Result<PathBuf, String> {
    if let Some(raw) = override_path {
        let trimmed = raw.trim();
        if !trimmed.is_empty() {
            let candidate = PathBuf::from(trimmed);
            if is_executable(&candidate) {
                return Ok(candidate);
            }
            return Err(format!(
                "cli_missing: gws override not executable: {trimmed}"
            ));
        }
    }
    resolve_program("gws").ok_or_else(|| {
        "cli_missing: gws CLI not found. Install via `brew install gws` or set the path in inbox settings (https://github.com/googleworkspace/gws)"
            .to_string()
    })
}

/// Request body for an `Upsert`: the note's title, a pointer back to the
/// note, and the due date. Same shape the `task-management` skill sends, so
/// the two producers converge on one provider task.
///
/// `due` is the one field that differs between the two verbs. `tasks.patch`
/// leaves an omitted field unchanged, so a note whose due date was cleared
/// would keep its old remote deadline forever; a patch therefore sends an
/// explicit `null`. An insert omits it, because there is nothing to clear.
fn upsert_body(record: &OutboxRecord, clear_missing_due: bool) -> String {
    let Some(payload) = &record.payload else {
        return json!({}).to_string();
    };
    let mut body = json!({ "title": payload.title, "notes": payload.notes });
    match &payload.due {
        Some(due) => body["due"] = json!(due),
        None if clear_missing_due => body["due"] = json!(null),
        None => {}
    }
    body.to_string()
}

fn gws_args(record: &OutboxRecord) -> Vec<String> {
    let list = record.google_task_list_id.as_deref().unwrap_or("@default");
    let params = json!({ "tasklist": list, "task": record.google_task_id }).to_string();
    match record.op {
        // No provider id yet: create. Otherwise patch in place, so a retry
        // after a crashed insert converges instead of duplicating.
        OutboxOp::Upsert if record.google_task_id.is_empty() => vec![
            "tasks".to_string(),
            "tasks".to_string(),
            "insert".to_string(),
            "--params".to_string(),
            json!({ "tasklist": list }).to_string(),
            "--json".to_string(),
            upsert_body(record, false),
            "--format".to_string(),
            "json".to_string(),
        ],
        OutboxOp::Upsert => vec![
            "tasks".to_string(),
            "tasks".to_string(),
            "patch".to_string(),
            "--params".to_string(),
            params,
            "--json".to_string(),
            upsert_body(record, true),
            "--format".to_string(),
            "json".to_string(),
        ],
        OutboxOp::Complete => vec![
            "tasks".to_string(),
            "tasks".to_string(),
            "update".to_string(),
            "--params".to_string(),
            params,
            "--json".to_string(),
            json!({ "status": "completed" }).to_string(),
            "--format".to_string(),
            "json".to_string(),
        ],
        OutboxOp::Reopen => vec![
            "tasks".to_string(),
            "tasks".to_string(),
            "update".to_string(),
            "--params".to_string(),
            params,
            "--json".to_string(),
            json!({ "status": "needsAction" }).to_string(),
            "--format".to_string(),
            "json".to_string(),
        ],
        OutboxOp::Delete => vec![
            "tasks".to_string(),
            "tasks".to_string(),
            "delete".to_string(),
            "--params".to_string(),
            params,
            "--format".to_string(),
            "json".to_string(),
        ],
    }
}

/// Provider task id from a successful insert response (`{"id": ...}`).
fn task_id_from_stdout(stdout: &[u8]) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_slice(stdout).ok()?;
    parsed
        .get("id")
        .and_then(|value| value.as_str())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

/// Write the provider ids back into the note so later completes/reopens can
/// find the task in the right list. Unknown keys, comments, and the body are
/// preserved by the frontmatter editor.
///
/// Both ids matter, and not only on creation: a note that already carried a
/// `googleTaskId` but no `googleTaskListId` was patched against the resolved
/// default list, and unless that list lands in the note a later
/// complete/reopen falls back to `@default` and touches the wrong list.
///
/// Only missing keys are filled. The record's payload was snapshotted when the
/// receipt was applied, so the note may have been relinked since; overwriting
/// would replace a newer linkage with a stale one. A note pointing at a
/// different task is a conflict a human has to settle, so it errors rather
/// than picking a winner, and the record stays visible in the sync panel. A
/// patch that owes nothing leaves the file byte-identical.
fn write_back_provider_ids(work: &Path, record: &OutboxRecord) -> Result<(), String> {
    let path = work.join(&record.task_path);
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let frontmatter = crate::tasks::yaml_to_json(&parse_frontmatter(&raw).meta);
    let note_task_id = crate::tasks::string_field(&frontmatter, "googleTaskId");
    // The payload was snapshotted at enqueue time, so the note may have been
    // relinked since. Filling only what is missing means a newer linkage is
    // never clobbered by a stale record.
    if let Some(existing) = &note_task_id {
        if existing != &record.google_task_id {
            return Err(format!(
                "note_relinked: note points at {existing}, record at {}",
                record.google_task_id
            ));
        }
    }
    let mut updated = raw.clone();
    if note_task_id.is_none() {
        updated = update_frontmatter_content(
            &updated,
            "googleTaskId",
            Some(FrontmatterValue::String(record.google_task_id.clone())),
        )?;
    }
    if let Some(list) = &record.google_task_list_id {
        if crate::tasks::string_field(&frontmatter, "googleTaskListId").is_none() {
            updated = update_frontmatter_content(
                &updated,
                "googleTaskListId",
                Some(FrontmatterValue::String(list.clone())),
            )?;
        }
    }
    if updated == raw {
        return Ok(());
    }
    write_atomic(&path, updated.as_bytes())
}

/// True when a terminal provider failure should recreate the task rather than
/// discharge the record: an `Upsert` that was patching a `googleTaskId` the
/// provider no longer knows.
fn upsert_needs_recreate(record: &OutboxRecord) -> bool {
    record.op == OutboxOp::Upsert && !record.google_task_id.is_empty()
}

/// Retry backoff in minutes after the n-th failed attempt: 1, 5, 15, 60,
/// then hourly.
fn backoff_minutes(attempts: u32) -> i64 {
    match attempts {
        0 | 1 => 1,
        2 => 5,
        3 => 15,
        _ => 60,
    }
}

pub(crate) fn is_auth_error(detail: &str) -> bool {
    classify_gws_auth_state(detail) == "auth_required"
}

/// Provider failures that no amount of retrying can fix — the remote task
/// (or its list) no longer exists, so the op is moot and the record must be
/// discharged instead of retrying hourly forever.
/// ponytail: substring match on gws output; switch to structured error codes
/// if gws ever emits them.
pub(crate) fn is_terminal_error(detail: &str) -> bool {
    let lower = detail.to_lowercase();
    lower.contains("404") || lower.contains("not found") || lower.contains("notfound")
}

// --- Commands -----------------------------------------------------------------

fn parse_now(now_iso: &str) -> Result<DateTime<chrono::FixedOffset>, String> {
    DateTime::parse_from_rfc3339(now_iso).map_err(|err| format!("now_iso must be RFC3339: {err}"))
}

fn record_due(record: &OutboxRecord, now: DateTime<chrono::FixedOffset>) -> bool {
    if !matches!(
        record.status,
        OutboxStatus::Ready | OutboxStatus::RetryNeeded
    ) {
        return false;
    }
    match &record.next_retry_at {
        None => true,
        Some(at) => DateTime::parse_from_rfc3339(at)
            .map(|retry_at| retry_at <= now)
            .unwrap_or(true),
    }
}

/// Process one due record against the provider. Status transitions are
/// persisted before and after the gws call so a crash mid-drain leaves a
/// `syncing` record that recovery can requeue.
fn drain_record(
    work: &Path,
    gws_bin: &Path,
    record: &OutboxRecord,
    now_iso: &str,
    now: DateTime<chrono::FixedOffset>,
) -> Result<OutboxStatus, String> {
    let mut record = record.clone();
    set_record_status(work, &mut record, OutboxStatus::Syncing, now_iso)?;
    let output = Command::new(gws_bin)
        .env("PATH", augmented_path())
        .args(gws_args(&record))
        .no_window()
        .output();
    let next = match output {
        Ok(output) if output.status.success() => {
            // The attempt counter is NOT reset here: an upsert whose local
            // follow-up work fails still has to back off on the documented
            // schedule, or a persistently unwritable note would drive a remote
            // patch every minute forever. It is cleared only once the record
            // is genuinely done, below.
            let back_off = |record: &mut OutboxRecord, error: String| -> Result<(), String> {
                record.attempts = record.attempts.saturating_add(1);
                let retry_at = now + Duration::minutes(backoff_minutes(record.attempts));
                record.next_retry_at = Some(retry_at.to_rfc3339_opts(SecondsFormat::Secs, true));
                record.last_error = Some(error);
                set_record_status(work, record, OutboxStatus::RetryNeeded, now_iso)
            };
            if record.op == OutboxOp::Upsert {
                if record.google_task_id.is_empty() {
                    let Some(created) = task_id_from_stdout(&output.stdout) else {
                        // A success exit with no id in the body: treat it like
                        // any other failure so it backs off and stays visible.
                        back_off(
                            &mut record,
                            format!(
                                "upsert_response_missing_id: {}",
                                String::from_utf8_lossy(&output.stdout).trim()
                            ),
                        )?;
                        return Ok(OutboxStatus::RetryNeeded);
                    };
                    // Persist the id BEFORE marking synced: a crash here leaves
                    // a record whose retry patches rather than inserting again.
                    record.google_task_id = created;
                    write_record(work, &record)?;
                }
                // The note is where later completes and reopens look up the
                // task, so the record is not done until the ids land there.
                // Staying recoverable is what stops a note that never received
                // its googleTaskId from being upserted again later as a new
                // task; the retry patches, so it cannot duplicate.
                if let Err(err) = write_back_provider_ids(work, &record) {
                    back_off(&mut record, format!("write_back_failed: {err}"))?;
                    return Ok(OutboxStatus::RetryNeeded);
                }
            }
            record.attempts = 0;
            record.next_retry_at = None;
            record.last_error = None;
            OutboxStatus::Synced
        }
        Ok(output) => {
            let detail = [output.stderr.as_slice(), output.stdout.as_slice()]
                .into_iter()
                .map(|bytes| String::from_utf8_lossy(bytes).trim().to_string())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>()
                .join("\n");
            if is_auth_error(&detail) {
                record.last_error = Some(detail);
                OutboxStatus::AuthBlocked
            } else if is_terminal_error(&detail) && upsert_needs_recreate(&record) {
                // The remote task behind a stale googleTaskId is gone, but an
                // upsert is not satisfied by its absence the way a complete or
                // a delete is: the requested update still has to land. Clear
                // the id so the retry inserts instead of patching. If the
                // tasklist itself is what 404s, the insert 404s too and falls
                // through to the discharge below, so this converges.
                record.google_task_id = String::new();
                record.attempts = record.attempts.saturating_add(1);
                let retry_at = now + Duration::minutes(backoff_minutes(record.attempts));
                record.next_retry_at = Some(retry_at.to_rfc3339_opts(SecondsFormat::Secs, true));
                record.last_error = Some(format!("upsert_task_missing_recreating: {detail}"));
                set_record_status(work, &mut record, OutboxStatus::RetryNeeded, now_iso)?;
                return Ok(OutboxStatus::RetryNeeded);
            } else if is_terminal_error(&detail) {
                // Remote task/list is gone: the op is moot. Discharge the
                // record (delete + event) instead of retrying forever; count
                // it as drained.
                fs::remove_file(record_path(work, &record.id))
                    .map_err(|err| format!("Cannot drop terminal outbox record: {err}"))?;
                let _ = crate::today_store::append_task_event_for(
                    work,
                    now_iso.get(..10).unwrap_or(now_iso),
                    "outbox_dropped_terminal",
                    None,
                    json!({ "id": record.id, "op": record.op, "error": detail }),
                    now_iso.to_string(),
                );
                return Ok(OutboxStatus::Synced);
            } else {
                record.attempts = record.attempts.saturating_add(1);
                let retry_at = now + Duration::minutes(backoff_minutes(record.attempts));
                record.next_retry_at = Some(retry_at.to_rfc3339_opts(SecondsFormat::Secs, true));
                record.last_error = Some(detail);
                OutboxStatus::RetryNeeded
            }
        }
        Err(err) => {
            record.attempts = record.attempts.saturating_add(1);
            let retry_at = now + Duration::minutes(backoff_minutes(record.attempts));
            record.next_retry_at = Some(retry_at.to_rfc3339_opts(SecondsFormat::Secs, true));
            record.last_error = Some(format!("gws_spawn_failed: {err}"));
            OutboxStatus::RetryNeeded
        }
    };
    set_record_status(work, &mut record, next, now_iso)?;
    Ok(next)
}

/// Drain due outbox records (`ready`, or `retryNeeded` past `nextRetryAt`)
/// through `gws`. Idempotent: records that are not due are untouched, and a
/// second drain with no changes is a no-op. `authBlocked` records are
/// skipped until `task_integrations_retry` requeues them.
#[tauri::command]
pub fn task_integrations_drain(
    work_path: String,
    now_iso: String,
    gws_path: Option<String>,
) -> Result<DrainOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let now = parse_now(&now_iso)?;
    let mut outcome = DrainOutcome {
        drained: 0,
        failed: 0,
        blocked: 0,
    };
    // A `syncing` record left by a crashed drain is treated as ready.
    let _ = recover_outbox(&work);
    let due: Vec<OutboxRecord> = list_records(&work)?
        .into_iter()
        .filter(|record| record_due(record, now))
        .collect();
    if due.is_empty() {
        return Ok(outcome);
    }
    let gws_bin = resolve_gws(gws_path.as_deref())?;
    for record in due {
        match drain_record(&work, &gws_bin, &record, &now_iso, now)? {
            OutboxStatus::Synced => outcome.drained += 1,
            OutboxStatus::AuthBlocked => outcome.blocked += 1,
            _ => outcome.failed += 1,
        }
    }
    Ok(outcome)
}

/// Requeue `retryNeeded`/`authBlocked` records (all, or only `ids`) so the
/// next drain attempts them again immediately.
#[tauri::command]
pub fn task_integrations_retry(
    work_path: String,
    ids: Option<Vec<String>>,
    now_iso: String,
) -> Result<RetryOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    parse_now(&now_iso)?;
    let mut requeued = 0;
    for mut record in list_records(&work)? {
        if !matches!(
            record.status,
            OutboxStatus::RetryNeeded | OutboxStatus::AuthBlocked
        ) {
            continue;
        }
        if let Some(ids) = &ids {
            if !ids.iter().any(|id| id == &record.id) {
                continue;
            }
        }
        record.next_retry_at = None;
        set_record_status(&work, &mut record, OutboxStatus::Ready, &now_iso)?;
        requeued += 1;
    }
    Ok(RetryOutcome { requeued })
}

/// All outbox records, for the frontend sync-status surface.
#[tauri::command]
pub fn read_task_integrations(work_path: String) -> Result<Vec<OutboxRecord>, String> {
    let work = normalize_existing_dir(&work_path)?;
    list_records(&work)
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: &str = "2026-07-21T09:00:00+09:00";

    fn write_fake_gws(dir: &Path, name: &str, body: &str) -> PathBuf {
        let bin = dir.join(name);
        fs::write(&bin, body).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&bin, fs::Permissions::from_mode(0o755)).unwrap();
        }
        bin
    }

    fn sample_record(work: &Path, op: OutboxOp, status: OutboxStatus) -> OutboxRecord {
        enqueue_record(
            work,
            OutboxRecordDraft {
                op,
                task_path: "tasks/active/task.md".to_string(),
                google_task_id: "gtask-1".to_string(),
                google_task_list_id: None,
                payload: None,
                status,
                web_action_id: None,
            },
            NOW,
        )
        .unwrap()
    }

    #[test]
    fn backoff_schedule_is_1_5_15_60_then_hourly() {
        assert_eq!(backoff_minutes(1), 1);
        assert_eq!(backoff_minutes(2), 5);
        assert_eq!(backoff_minutes(3), 15);
        assert_eq!(backoff_minutes(4), 60);
        assert_eq!(backoff_minutes(5), 60);
        assert_eq!(backoff_minutes(12), 60);
    }

    #[test]
    fn gws_args_match_op_shapes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut record = sample_record(tmp.path(), OutboxOp::Complete, OutboxStatus::Ready);
        let args = gws_args(&record);
        assert_eq!(
            args,
            vec![
                "tasks",
                "tasks",
                "update",
                "--params",
                r#"{"task":"gtask-1","tasklist":"@default"}"#,
                "--json",
                r#"{"status":"completed"}"#,
                "--format",
                "json"
            ]
        );
        record.op = OutboxOp::Reopen;
        assert!(gws_args(&record).contains(&r#"{"status":"needsAction"}"#.to_string()));
        record.op = OutboxOp::Delete;
        let args = gws_args(&record);
        assert_eq!(args[2], "delete");
        assert!(!args.contains(&"--json".to_string()));
        record.google_task_list_id = Some("list-9".to_string());
        assert!(
            gws_args(&record).contains(&r#"{"task":"gtask-1","tasklist":"list-9"}"#.to_string())
        );
    }

    #[test]
    fn drain_marks_success_synced_and_second_drain_is_noop() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let work = tmp.path();
        let log = tmp.path().join("gws-args.log");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-ok",
            &format!("#!/bin/sh\necho \"$@\" >> {}\nexit 0\n", log.display()),
        );
        sample_record(work, OutboxOp::Complete, OutboxStatus::Ready);

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.drained, 1);
        assert_eq!(outcome.failed, 0);
        let records = read_task_integrations(work_path.clone()).unwrap();
        assert_eq!(records[0].status, OutboxStatus::Synced);
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("tasks tasks update"));
        assert!(logged.contains(r#"{"status":"completed"}"#));

        // Idempotent: nothing due anymore.
        let second = task_integrations_drain(
            work_path,
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(second.drained, 0);
        assert_eq!(second.failed, 0);
        assert_eq!(second.blocked, 0);
    }

    #[test]
    fn drain_auth_failure_blocks_until_retry_requeues() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let work = tmp.path();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-auth",
            "#!/bin/sh\necho 'token expired: re-login required' >&2\nexit 1\n",
        );
        sample_record(work, OutboxOp::Complete, OutboxStatus::Ready);

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.blocked, 1);
        assert_eq!(outcome.drained, 0);
        assert_eq!(
            read_task_integrations(work_path.clone()).unwrap()[0].status,
            OutboxStatus::AuthBlocked
        );

        // Drain skips authBlocked records.
        let skipped = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(skipped.blocked, 0);
        assert_eq!(skipped.drained, 0);

        // Retry requeues so the next drain attempts again.
        let retry = task_integrations_retry(work_path.clone(), None, NOW.to_string()).unwrap();
        assert_eq!(retry.requeued, 1);
        let record = &read_task_integrations(work_path.clone()).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::Ready);
        assert!(record.next_retry_at.is_none());

        let again = task_integrations_drain(
            work_path,
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(again.blocked, 1);
    }

    #[test]
    fn drain_non_auth_failure_retries_with_backoff() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let work = tmp.path();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-down",
            "#!/bin/sh\necho 'network unreachable' >&2\nexit 1\n",
        );
        sample_record(work, OutboxOp::Delete, OutboxStatus::Ready);

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.failed, 1);
        let record = &read_task_integrations(work_path.clone()).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::RetryNeeded);
        assert_eq!(record.attempts, 1);
        // First backoff step: 1 minute after now.
        assert_eq!(
            record.next_retry_at.as_deref(),
            Some("2026-07-21T09:01:00+09:00")
        );

        // Not yet due: drain one second later skips it.
        let early = task_integrations_drain(
            work_path.clone(),
            "2026-07-21T09:00:30+09:00".to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(early.failed, 0);

        // Due again after the backoff elapses: second failure backs off 5m.
        let later = task_integrations_drain(
            work_path.clone(),
            "2026-07-21T09:01:00+09:00".to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(later.failed, 1);
        let record = &read_task_integrations(work_path).unwrap()[0];
        assert_eq!(record.attempts, 2);
        assert_eq!(
            record.next_retry_at.as_deref(),
            Some("2026-07-21T09:06:00+09:00")
        );
    }

    #[test]
    fn drain_terminal_failure_drops_record_instead_of_retrying() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-404",
            "#!/bin/sh\necho 'Error 404: task not found' >&2\nexit 1\n",
        );
        sample_record(tmp.path(), OutboxOp::Complete, OutboxStatus::Ready);

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        // Remote task is gone: the op is moot — discharged, not retried.
        assert_eq!(outcome.drained, 1);
        assert_eq!(outcome.failed, 0);
        assert!(list_records(tmp.path()).unwrap().is_empty());
        let events =
            fs::read_to_string(tmp.path().join(".maru/today/events/2026-07.jsonl")).unwrap();
        assert!(events.contains("outbox_dropped_terminal"));
    }

    #[test]
    fn recovery_predicate_is_op_aware_for_reopen() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let note = work.join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        // Reopen prepared + note still done: the local reopen never landed,
        // so the record must be dropped (the done-note predicate that is
        // correct for complete would wrongly mark this ready).
        fs::write(&note, "---\nstatus: done\n---\n").unwrap();
        sample_record(work, OutboxOp::Reopen, OutboxStatus::Prepared);
        let outcome = recover_outbox(work).unwrap();
        assert_eq!(
            outcome,
            OutboxRecovery {
                recovered: 0,
                dropped: 1
            }
        );
        // Reopen prepared + note active: the reopen landed — sync is owed.
        fs::write(&note, "---\nstatus: active\n---\n").unwrap();
        sample_record(work, OutboxOp::Reopen, OutboxStatus::Prepared);
        let outcome = recover_outbox(work).unwrap();
        assert_eq!(
            outcome,
            OutboxRecovery {
                recovered: 1,
                dropped: 0
            }
        );
        assert_eq!(list_records(work).unwrap()[0].status, OutboxStatus::Ready);
    }

    #[test]
    fn recovery_reconciles_prepared_and_syncing_records() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        let note = work.join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nstatus: active\n---\n# Task").unwrap();

        let syncing = sample_record(work, OutboxOp::Complete, OutboxStatus::Syncing);
        let prepared_not_done = sample_record(work, OutboxOp::Complete, OutboxStatus::Prepared);
        let prepared_done = enqueue_record(
            work,
            OutboxRecordDraft {
                op: OutboxOp::Complete,
                task_path: "tasks/archive/done.md".to_string(),
                google_task_id: "gtask-2".to_string(),
                google_task_list_id: None,
                payload: None,
                status: OutboxStatus::Prepared,
                web_action_id: None,
            },
            NOW,
        )
        .unwrap();
        let done_note = work.join("tasks/archive/done.md");
        fs::create_dir_all(done_note.parent().unwrap()).unwrap();
        fs::write(&done_note, "---\nstatus: done\n---\n# Done").unwrap();

        let outcome = recover_outbox(work).unwrap();
        assert_eq!(outcome.recovered, 2);
        assert_eq!(outcome.dropped, 1);

        let records = list_records(work).unwrap();
        let by_id = |id: &str| records.iter().find(|record| record.id == id).cloned();
        assert_eq!(by_id(&syncing.id).unwrap().status, OutboxStatus::Ready);
        assert_eq!(
            by_id(&prepared_done.id).unwrap().status,
            OutboxStatus::Ready
        );
        assert!(by_id(&prepared_not_done.id).is_none());

        // Missing outbox dir is fine.
        let empty = tempfile::tempdir().unwrap();
        let outcome = recover_outbox(empty.path()).unwrap();
        assert_eq!(
            outcome,
            OutboxRecovery {
                recovered: 0,
                dropped: 0
            }
        );
    }

    #[test]
    fn retry_with_ids_only_requeues_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let work = tmp.path();
        let first = sample_record(work, OutboxOp::Complete, OutboxStatus::RetryNeeded);
        let second = sample_record(work, OutboxOp::Reopen, OutboxStatus::RetryNeeded);

        let outcome =
            task_integrations_retry(work_path, Some(vec![first.id.clone()]), NOW.to_string())
                .unwrap();
        assert_eq!(outcome.requeued, 1);
        let records = list_records(work).unwrap();
        let by_id = |id: &str| records.iter().find(|record| record.id == id).unwrap();
        assert_eq!(by_id(&first.id).status, OutboxStatus::Ready);
        assert_eq!(by_id(&second.id).status, OutboxStatus::RetryNeeded);
    }

    fn upsert_record(work: &Path, google_task_id: &str) -> OutboxRecord {
        let note = work.join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nstatus: active\nowner: Luca\n---\n# Ship it\n").unwrap();
        enqueue_record(
            work,
            OutboxRecordDraft {
                op: OutboxOp::Upsert,
                task_path: "tasks/active/task.md".to_string(),
                google_task_id: google_task_id.to_string(),
                google_task_list_id: Some("list-7".to_string()),
                payload: Some(UpsertPayload {
                    title: "Ship it".to_string(),
                    notes: "File: tasks/active/task.md".to_string(),
                    due: Some("2026-08-31T00:00:00.000Z".to_string()),
                }),
                status: OutboxStatus::Ready,
                web_action_id: Some("wa-1".to_string()),
            },
            NOW,
        )
        .unwrap()
    }

    #[test]
    fn upsert_args_insert_without_an_id_and_patch_with_one() {
        let tmp = tempfile::tempdir().unwrap();
        let mut record = upsert_record(tmp.path(), "");
        let args = gws_args(&record);
        assert_eq!(
            args,
            vec![
                "tasks",
                "tasks",
                "insert",
                "--params",
                r#"{"tasklist":"list-7"}"#,
                "--json",
                r#"{"due":"2026-08-31T00:00:00.000Z","notes":"File: tasks/active/task.md","title":"Ship it"}"#,
                "--format",
                "json"
            ]
        );
        // Once the task exists, converge with patch — never a second insert.
        record.google_task_id = "g-new".to_string();
        let args = gws_args(&record);
        assert_eq!(args[2], "patch");
        assert!(args.contains(&r#"{"task":"g-new","tasklist":"list-7"}"#.to_string()));
    }

    #[test]
    fn a_cleared_due_is_sent_as_null_on_patch_but_omitted_on_insert() {
        let tmp = tempfile::tempdir().unwrap();
        let mut record = upsert_record(tmp.path(), "");
        record.payload.as_mut().unwrap().due = None;
        // Insert: nothing to clear, so `due` stays out of the body.
        assert_eq!(
            upsert_body(&record, false),
            r#"{"notes":"File: tasks/active/task.md","title":"Ship it"}"#
        );
        // Patch: tasks.patch leaves an omitted field unchanged, so a due date
        // the note no longer has must be cleared explicitly.
        record.google_task_id = "g-new".to_string();
        assert_eq!(
            upsert_body(&record, true),
            r#"{"due":null,"notes":"File: tasks/active/task.md","title":"Ship it"}"#
        );
        assert!(gws_args(&record).contains(
            &r#"{"due":null,"notes":"File: tasks/active/task.md","title":"Ship it"}"#.to_string()
        ));
    }

    #[test]
    fn upsert_patch_against_a_missing_task_recreates_instead_of_discharging() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let log = tmp.path().join("gws-args.log");
        // 404 on patch, success on insert — the two calls this test drives.
        let fake = write_fake_gws(
            tmp.path(),
            "gws-404-then-ok",
            &format!(
                "#!/bin/sh\necho \"$@\" >> {log}\nif echo \"$@\" | grep -q patch; then echo 'Error 404: task not found' >&2; exit 1; fi\necho '{{\"id\":\"g-recreated\"}}'\nexit 0\n",
                log = log.display()
            ),
        );
        upsert_record(tmp.path(), "g-stale");

        // First drain: the patch 404s. The op is NOT satisfied by the task
        // being gone, so the record survives with the stale id cleared.
        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.drained, 0);
        let record = &read_task_integrations(work_path.clone()).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::RetryNeeded);
        assert_eq!(record.google_task_id, "");
        assert!(record
            .last_error
            .as_deref()
            .unwrap()
            .starts_with("upsert_task_missing_recreating"));

        // Second drain, once the backoff elapses: it inserts and writes the
        // new id back into the note.
        let outcome = task_integrations_drain(
            work_path.clone(),
            "2026-07-21T09:05:00+09:00".to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.drained, 1);
        let record = &read_task_integrations(work_path).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::Synced);
        assert_eq!(record.google_task_id, "g-recreated");
        assert!(fs::read_to_string(tmp.path().join("tasks/active/task.md"))
            .unwrap()
            .contains("googleTaskId: g-recreated"));
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("tasks tasks patch"));
        assert!(logged.contains("tasks tasks insert"));
    }

    #[test]
    fn a_404_on_the_recreated_insert_still_discharges_the_record() {
        // The tasklist itself is gone: clearing the id cannot help, so the
        // record must not retry forever.
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-404",
            "#!/bin/sh\necho 'Error 404: tasklist not found' >&2\nexit 1\n",
        );
        upsert_record(tmp.path(), "");

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.drained, 1);
        assert!(list_records(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn upsert_create_writes_the_returned_id_back_into_the_note() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-insert",
            "#!/bin/sh\necho '{\"id\":\"g-new\",\"title\":\"Ship it\"}'\nexit 0\n",
        );
        upsert_record(tmp.path(), "");

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.drained, 1);

        let record = &read_task_integrations(work_path.clone()).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::Synced);
        assert_eq!(record.google_task_id, "g-new");
        // The note now carries both provider ids, unknown keys intact.
        let raw = fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap();
        assert!(raw.contains("googleTaskId: g-new"));
        assert!(raw.contains("googleTaskListId: list-7"));
        assert!(raw.contains("owner: Luca"));
        assert!(raw.contains("# Ship it"));

        // Idempotent: nothing is due, so no second insert.
        let second = task_integrations_drain(
            work_path,
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(second.drained, 0);
    }

    #[test]
    fn upsert_success_without_an_id_backs_off_instead_of_reporting_synced() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(tmp.path(), "gws-empty", "#!/bin/sh\necho '{}'\nexit 0\n");
        upsert_record(tmp.path(), "");

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.drained, 0);
        let record = &read_task_integrations(work_path).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::RetryNeeded);
        assert_eq!(record.google_task_id, "");
        assert!(record
            .last_error
            .as_deref()
            .unwrap()
            .starts_with("upsert_response_missing_id"));
    }

    #[test]
    fn upsert_update_persists_the_resolved_list_id_but_rewrites_nothing_else() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let log = tmp.path().join("gws-args.log");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-patch",
            &format!(
                "#!/bin/sh\necho \"$@\" >> {}\necho '{{\"id\":\"g-old\"}}'\nexit 0\n",
                log.display()
            ),
        );
        // The note names the task but not its list: the patch targets the
        // resolved list, so the note has to learn it or a later
        // complete/reopen falls back to @default and touches the wrong list.
        upsert_record(tmp.path(), "g-old");

        task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();

        assert!(fs::read_to_string(&log)
            .unwrap()
            .contains("tasks tasks patch"));
        assert_eq!(
            read_task_integrations(work_path.clone()).unwrap()[0].google_task_id,
            "g-old"
        );
        let note = tmp.path().join("tasks/active/task.md");
        let raw = fs::read_to_string(&note).unwrap();
        assert!(raw.contains("googleTaskId: g-old"), "{raw}");
        assert!(raw.contains("googleTaskListId: list-7"), "{raw}");
        assert!(raw.contains("owner: Luca"));

        // Nothing owed the second time: the note is left byte-identical.
        let before = raw;
        task_integrations_retry(work_path.clone(), None, NOW.to_string()).unwrap();
        task_integrations_drain(
            work_path,
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(fs::read_to_string(&note).unwrap(), before);
    }

    #[test]
    fn an_unwritten_provider_id_keeps_the_record_recoverable() {
        // If the note never receives googleTaskId, a later web upsert would
        // treat the task as new and create a duplicate. The record therefore
        // stays retryable until the write-back lands — and because the id is
        // already on the record, the retry patches instead of re-inserting.
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let log = tmp.path().join("gws-args.log");
        let fake = write_fake_gws(
            tmp.path(),
            "gws-insert",
            &format!(
                "#!/bin/sh\necho \"$@\" >> {}\necho '{{\"id\":\"g-new\"}}'\nexit 0\n",
                log.display()
            ),
        );
        upsert_record(tmp.path(), "");
        // Make the note unwritable by replacing it with a directory.
        let note = tmp.path().join("tasks/active/task.md");
        fs::remove_file(&note).unwrap();
        fs::create_dir(&note).unwrap();

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.failed, 1);
        assert_eq!(outcome.drained, 0);
        let record = &read_task_integrations(work_path.clone()).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::RetryNeeded);
        // The provider id is held on the record, so nothing is lost...
        assert_eq!(record.google_task_id, "g-new");
        assert!(record
            .last_error
            .as_deref()
            .unwrap()
            .starts_with("write_back_failed"));

        // ...and the retry patches rather than inserting a second task.
        fs::remove_dir(&note).unwrap();
        fs::write(&note, "---\nstatus: active\n---\n# Ship it\n").unwrap();
        let outcome = task_integrations_drain(
            work_path.clone(),
            "2026-07-21T09:05:00+09:00".to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.drained, 1);
        assert_eq!(
            read_task_integrations(work_path).unwrap()[0].status,
            OutboxStatus::Synced
        );
        assert!(fs::read_to_string(&note)
            .unwrap()
            .contains("googleTaskId: g-new"));
        let logged = fs::read_to_string(&log).unwrap();
        assert_eq!(
            logged.matches("insert").count(),
            1,
            "exactly one insert: {logged}"
        );
        assert!(logged.contains("tasks tasks patch"));
    }

    #[test]
    fn a_relinked_note_is_never_overwritten_by_a_stale_record() {
        // The payload is snapshotted when the receipt is applied, so the note
        // can be relinked before the drain. Overwriting would replace the
        // newer linkage with a stale one and orphan a real Google task.
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-patch",
            "#!/bin/sh\necho '{\"id\":\"g-old\"}'\nexit 0\n",
        );
        upsert_record(tmp.path(), "g-old");
        let note = tmp.path().join("tasks/active/task.md");
        fs::write(
            &note,
            "---\nstatus: active\ngoogleTaskId: g-relinked\ngoogleTaskListId: list-9\n---\n# Ship it\n",
        )
        .unwrap();
        let before = fs::read_to_string(&note).unwrap();

        let outcome = task_integrations_drain(
            work_path.clone(),
            NOW.to_string(),
            Some(fake.to_string_lossy().to_string()),
        )
        .unwrap();
        assert_eq!(outcome.failed, 1);
        // The note keeps its newer linkage; the conflict is surfaced instead.
        assert_eq!(fs::read_to_string(&note).unwrap(), before);
        let record = &read_task_integrations(work_path).unwrap()[0];
        assert_eq!(record.status, OutboxStatus::RetryNeeded);
        assert!(record
            .last_error
            .as_deref()
            .unwrap()
            .contains("note_relinked"));
    }

    #[test]
    fn a_repeatedly_unwritable_note_backs_off_instead_of_patching_every_minute() {
        // Regression: resetting `attempts` on provider success made every
        // write-back failure look like attempt 1, pinning nextRetryAt one
        // minute out forever and hammering the provider at that interval.
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let fake = write_fake_gws(
            tmp.path(),
            "gws-patch",
            "#!/bin/sh\necho '{\"id\":\"g-old\"}'\nexit 0\n",
        );
        upsert_record(tmp.path(), "g-old");
        // Unwritable note: the provider call keeps succeeding, the local
        // follow-up keeps failing.
        let note = tmp.path().join("tasks/active/task.md");
        fs::remove_file(&note).unwrap();
        fs::create_dir(&note).unwrap();

        for (at, expected_attempts, expected_retry) in [
            (NOW, 1, "2026-07-21T09:01:00+09:00"),
            ("2026-07-21T09:01:00+09:00", 2, "2026-07-21T09:06:00+09:00"),
            ("2026-07-21T09:06:00+09:00", 3, "2026-07-21T09:21:00+09:00"),
            ("2026-07-21T09:21:00+09:00", 4, "2026-07-21T10:21:00+09:00"),
        ] {
            let outcome = task_integrations_drain(
                work_path.clone(),
                at.to_string(),
                Some(fake.to_string_lossy().to_string()),
            )
            .unwrap();
            assert_eq!(outcome.failed, 1, "at {at}");
            let record = &read_task_integrations(work_path.clone()).unwrap()[0];
            assert_eq!(record.attempts, expected_attempts, "at {at}");
            assert_eq!(
                record.next_retry_at.as_deref(),
                Some(expected_retry),
                "at {at}"
            );
        }
    }

    #[test]
    fn has_synced_complete_matches_by_google_task_id() {
        let tmp = tempfile::tempdir().unwrap();
        let work = tmp.path();
        assert!(!has_synced_complete(work, "gtask-1").unwrap());
        sample_record(work, OutboxOp::Complete, OutboxStatus::Synced);
        assert!(has_synced_complete(work, "gtask-1").unwrap());
        assert!(!has_synced_complete(work, "gtask-other").unwrap());
    }
}
