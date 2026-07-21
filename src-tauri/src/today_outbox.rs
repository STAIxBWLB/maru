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
    pub google_task_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub google_task_list_id: Option<String>,
    pub status: OutboxStatus,
    #[serde(default)]
    pub attempts: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_retry_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
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

pub(crate) fn write_record(work: &Path, record: &OutboxRecord) -> Result<(), String> {
    let json = serde_json::to_string_pretty(record)
        .map_err(|err| format!("Cannot serialize outbox record: {err}"))?;
    write_atomic(&record_path(work, &record.id), json.as_bytes())
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
        if let Ok(record) = serde_json::from_str::<OutboxRecord>(&raw) {
            records.push(record);
        }
    }
    records.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(records)
}

/// Persist a new outbox record. Written BEFORE the local mutation when
/// `status` is `Prepared` (see crash-recovery semantics in the module docs).
pub(crate) fn enqueue_record(
    work: &Path,
    op: OutboxOp,
    task_path: &str,
    google_task_id: &str,
    google_task_list_id: Option<String>,
    status: OutboxStatus,
    now_iso: &str,
) -> Result<OutboxRecord, String> {
    let stamp = now_iso.replace(|c: char| !c.is_ascii_alphanumeric(), "");
    let unique = &uuid::Uuid::new_v4().simple().to_string()[..8];
    let record = OutboxRecord {
        id: format!("{stamp}-{unique}"),
        op,
        task_path: task_path.to_string(),
        google_task_id: google_task_id.to_string(),
        google_task_list_id,
        status,
        attempts: 0,
        next_retry_at: None,
        last_error: None,
        created_at: now_iso.to_string(),
        updated_at: now_iso.to_string(),
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
            return Err(format!("cli_missing: gws override not executable: {trimmed}"));
        }
    }
    resolve_program("gws").ok_or_else(|| {
        "cli_missing: gws CLI not found. Install via `brew install gws` or set the path in inbox settings (https://github.com/googleworkspace/gws)"
            .to_string()
    })
}

fn gws_args(record: &OutboxRecord) -> Vec<String> {
    let list = record
        .google_task_list_id
        .as_deref()
        .unwrap_or("@default");
    let params = json!({ "tasklist": list, "task": record.google_task_id }).to_string();
    match record.op {
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
    DateTime::parse_from_rfc3339(now_iso)
        .map_err(|err| format!("now_iso must be RFC3339: {err}"))
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
                record.next_retry_at =
                    Some(retry_at.to_rfc3339_opts(SecondsFormat::Secs, true));
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
            op,
            "tasks/active/task.md",
            "gtask-1",
            None,
            status,
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
        assert!(gws_args(&record)
            .contains(&r#"{"task":"gtask-1","tasklist":"list-9"}"#.to_string()));
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

        let outcome =
            task_integrations_drain(work_path.clone(), NOW.to_string(), Some(fake.to_string_lossy().to_string()))
                .unwrap();
        assert_eq!(outcome.drained, 1);
        assert_eq!(outcome.failed, 0);
        let records = read_task_integrations(work_path.clone()).unwrap();
        assert_eq!(records[0].status, OutboxStatus::Synced);
        let logged = fs::read_to_string(&log).unwrap();
        assert!(logged.contains("tasks tasks update"));
        assert!(logged.contains(r#"{"status":"completed"}"#));

        // Idempotent: nothing due anymore.
        let second =
            task_integrations_drain(work_path, NOW.to_string(), Some(fake.to_string_lossy().to_string()))
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
        assert_eq!(read_task_integrations(work_path.clone()).unwrap()[0].status, OutboxStatus::AuthBlocked);

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
        let events = fs::read_to_string(
            tmp.path().join(".maru/today/events/2026-07.jsonl"),
        )
        .unwrap();
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
        assert_eq!(outcome, OutboxRecovery { recovered: 0, dropped: 1 });
        // Reopen prepared + note active: the reopen landed — sync is owed.
        fs::write(&note, "---\nstatus: active\n---\n").unwrap();
        sample_record(work, OutboxOp::Reopen, OutboxStatus::Prepared);
        let outcome = recover_outbox(work).unwrap();
        assert_eq!(outcome, OutboxRecovery { recovered: 1, dropped: 0 });
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
            OutboxOp::Complete,
            "tasks/archive/done.md",
            "gtask-2",
            None,
            OutboxStatus::Prepared,
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
        assert_eq!(by_id(&prepared_done.id).unwrap().status, OutboxStatus::Ready);
        assert!(by_id(&prepared_not_done.id).is_none());

        // Missing outbox dir is fine.
        let empty = tempfile::tempdir().unwrap();
        let outcome = recover_outbox(empty.path()).unwrap();
        assert_eq!(outcome, OutboxRecovery { recovered: 0, dropped: 0 });
    }

    #[test]
    fn retry_with_ids_only_requeues_selected() {
        let tmp = tempfile::tempdir().unwrap();
        let work_path = tmp.path().to_string_lossy().to_string();
        let work = tmp.path();
        let first = sample_record(work, OutboxOp::Complete, OutboxStatus::RetryNeeded);
        let second = sample_record(work, OutboxOp::Reopen, OutboxStatus::RetryNeeded);

        let outcome = task_integrations_retry(
            work_path,
            Some(vec![first.id.clone()]),
            NOW.to_string(),
        )
        .unwrap();
        assert_eq!(outcome.requeued, 1);
        let records = list_records(work).unwrap();
        let by_id = |id: &str| records.iter().find(|record| record.id == id).unwrap();
        assert_eq!(by_id(&first.id).status, OutboxStatus::Ready);
        assert_eq!(by_id(&second.id).status, OutboxStatus::RetryNeeded);
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
