// Maru Today — explicit task lifecycle transitions (complete / reopen /
// cancel / defer) with expected-hash optimistic concurrency, plus task
// trash. Provider (Google Tasks) mutations are never applied inline: they
// are recorded in the integration outbox (today_outbox.rs) and drained
// separately, so a completed local transition never depends on the network.
//
// Complete ordering is load-bearing for crash recovery:
//   1. write the durable `prepared` outbox record (when googleTaskId exists)
//   2. patch frontmatter (status/done/completedAt)
//   3. move the note into the archive bucket
//   4. append the `task_completed` event + best-effort day-snapshot update
//   5. mark the outbox record `ready`
// A crash between 1 and 5 leaves a `prepared` record; `recover_outbox`
// marks it ready when the note landed at `status: done`, drops it otherwise.

use crate::atomic_file::write_atomic;
use crate::document::revision_for;
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::tasks::{
    bucket_from_task_path, conflict_free_path, normalize_task_frontmatter_aliases,
    resolve_tasks_root, string_field, target_path_for_bucket, yaml_to_json, TaskBucket,
};
use crate::today::{TaskSyncStatus, TaskTransitionKind, TaskTransitionOutcome, TaskTransitionRequest};
use crate::today_outbox::{self, OutboxOp, OutboxRecord, OutboxStatus};
use crate::today_store::{append_task_event_for, note_task_transition};
use crate::vault::{normalize_existing_dir, parse_frontmatter, resolve_inside_vault};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::Utc;
use serde::Serialize;
use serde_json::{json, Value as JsonValue};
use std::fs;
use std::path::{Path, PathBuf};

struct TransitionContext {
    work: PathBuf,
    tasks_root: PathBuf,
    path: PathBuf,
    rel_path: String,
    raw: String,
    now_iso: String,
    date: String,
    google_task_id: Option<String>,
    google_task_list_id: Option<String>,
}

/// Step 1 of `complete`, factored out so the durable-before-local ordering
/// is directly testable: the `prepared` record exists on disk before any
/// local mutation happens.
pub(crate) fn prepare_complete_op(
    work: &Path,
    rel_path: &str,
    google_task_id: &str,
    google_task_list_id: Option<String>,
    now_iso: &str,
) -> Result<OutboxRecord, String> {
    today_outbox::enqueue_record(
        work,
        OutboxOp::Complete,
        rel_path,
        google_task_id,
        google_task_list_id,
        OutboxStatus::Prepared,
        now_iso,
    )
}

fn load_context(
    work_path: &str,
    task_path: &str,
    expected_task_hash: &str,
    date: Option<&str>,
    now_iso: Option<&str>,
) -> Result<TransitionContext, String> {
    let work = normalize_existing_dir(work_path)?;
    let path = resolve_inside_vault(work_path, task_path)?;
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let actual_hash = revision_for(&raw);
    if actual_hash != expected_task_hash {
        return Err(format!(
            "task_conflict: expected hash {expected_task_hash}, found {actual_hash}"
        ));
    }
    let tasks_root = resolve_tasks_root(&work, "tasks")?;
    let parts = parse_frontmatter(&raw);
    let frontmatter = normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta));
    let now_iso = now_iso
        .map(ToString::to_string)
        .unwrap_or_else(|| Utc::now().to_rfc3339());
    let date = date
        .map(ToString::to_string)
        .unwrap_or_else(|| now_iso.get(..10).unwrap_or(&now_iso).to_string());
    Ok(TransitionContext {
        work,
        tasks_root,
        path,
        rel_path: task_path.to_string(),
        raw,
        google_task_id: string_field(&frontmatter, "googleTaskId"),
        google_task_list_id: string_field(&frontmatter, "googleTaskListId"),
        now_iso,
        date,
    })
}

fn patch(content: &str, key: &str, value: Option<FrontmatterValue>) -> Result<String, String> {
    update_frontmatter_content(content, key, value)
}

fn move_to_bucket(
    tasks_root: &Path,
    path: &Path,
    target: TaskBucket,
) -> Result<PathBuf, String> {
    let current = bucket_from_task_path(tasks_root, path)?;
    if current == target {
        return Ok(path.to_path_buf());
    }
    let dest = conflict_free_path(&target_path_for_bucket(tasks_root, path, target)?);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create task target: {err}"))?;
    }
    fs::rename(path, &dest).map_err(|err| format!("Cannot move task note: {err}"))?;
    Ok(dest)
}

fn rel_path_for(work: &Path, path: &Path) -> String {
    path.strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn outcome_for(
    final_path: &Path,
    bucket: TaskBucket,
    sync_status: TaskSyncStatus,
    task_id: &str,
) -> Result<TaskTransitionOutcome, String> {
    let raw =
        fs::read_to_string(final_path).map_err(|err| format!("Cannot read task note: {err}"))?;
    Ok(TaskTransitionOutcome {
        task_id: task_id.to_string(),
        new_task_hash: revision_for(&raw),
        bucket: bucket.as_str().to_string(),
        sync_status,
    })
}

fn run_complete(ctx: TransitionContext, task_id: &str) -> Result<TaskTransitionOutcome, String> {
    // 1. Durable prepared record FIRST (see module docs for recovery rules).
    let prepared = match &ctx.google_task_id {
        Some(google_task_id) => Some(prepare_complete_op(
            &ctx.work,
            &ctx.rel_path,
            google_task_id,
            ctx.google_task_list_id.clone(),
            &ctx.now_iso,
        )?),
        None => None,
    };
    // 2. Frontmatter patch; unknown keys/comments preserved by the editor.
    let mut updated = patch(
        &ctx.raw,
        "status",
        Some(FrontmatterValue::String("done".to_string())),
    )?;
    updated = patch(
        &updated,
        "done",
        Some(FrontmatterValue::String(ctx.date.clone())),
    )?;
    updated = patch(
        &updated,
        "completedAt",
        Some(FrontmatterValue::String(ctx.now_iso.clone())),
    )?;
    write_atomic(&ctx.path, updated.as_bytes())?;
    // 3. Bucket move.
    let final_path = move_to_bucket(&ctx.tasks_root, &ctx.path, TaskBucket::Archive)?;
    let final_rel = rel_path_for(&ctx.work, &final_path);
    // 4. Event + best-effort day-snapshot reflection (never fatal).
    append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_completed",
        Some(task_id.to_string()),
        json!({ "taskPath": final_rel, "bucket": "archive" }),
        ctx.now_iso.clone(),
    )?;
    let _ = note_task_transition(&ctx.work, &ctx.date, task_id, "done");
    // 5. Prepared -> ready; until this lands, recovery owns the record.
    let sync_status = match prepared {
        Some(mut record) => {
            today_outbox::set_record_status(&ctx.work, &mut record, OutboxStatus::Ready, &ctx.now_iso)?;
            TaskSyncStatus::Syncing
        }
        None => TaskSyncStatus::Local,
    };
    outcome_for(&final_path, TaskBucket::Archive, sync_status, task_id)
}

fn run_reopen(ctx: TransitionContext, task_id: &str) -> Result<TaskTransitionOutcome, String> {
    let mut updated = patch(
        &ctx.raw,
        "status",
        Some(FrontmatterValue::String("active".to_string())),
    )?;
    updated = patch(&updated, "done", None)?;
    updated = patch(&updated, "completedAt", None)?;
    write_atomic(&ctx.path, updated.as_bytes())?;
    let final_path = move_to_bucket(&ctx.tasks_root, &ctx.path, TaskBucket::Active)?;
    let final_rel = rel_path_for(&ctx.work, &final_path);
    append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_reopened",
        Some(task_id.to_string()),
        json!({ "taskPath": final_rel, "bucket": "active" }),
        ctx.now_iso.clone(),
    )?;
    let _ = note_task_transition(&ctx.work, &ctx.date, task_id, "active");
    // Mirror to the provider only when a complete op already drained — a
    // reopen of a task the provider never saw needs no remote call.
    let sync_status = match &ctx.google_task_id {
        Some(google_task_id)
            if today_outbox::has_synced_complete(&ctx.work, google_task_id)? =>
        {
            today_outbox::enqueue_record(
                &ctx.work,
                OutboxOp::Reopen,
                &final_rel,
                google_task_id,
                ctx.google_task_list_id.clone(),
                OutboxStatus::Ready,
                &ctx.now_iso,
            )?;
            TaskSyncStatus::Syncing
        }
        _ => TaskSyncStatus::Local,
    };
    outcome_for(&final_path, TaskBucket::Active, sync_status, task_id)
}

fn run_cancel(ctx: TransitionContext, task_id: &str) -> Result<TaskTransitionOutcome, String> {
    // Maru-only by default: cancelling never queues provider ops.
    let updated = patch(
        &ctx.raw,
        "status",
        Some(FrontmatterValue::String("cancelled".to_string())),
    )?;
    write_atomic(&ctx.path, updated.as_bytes())?;
    let final_path = move_to_bucket(&ctx.tasks_root, &ctx.path, TaskBucket::Archive)?;
    let final_rel = rel_path_for(&ctx.work, &final_path);
    append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_cancelled",
        Some(task_id.to_string()),
        json!({ "taskPath": final_rel, "bucket": "archive" }),
        ctx.now_iso.clone(),
    )?;
    let _ = note_task_transition(&ctx.work, &ctx.date, task_id, "cancelled");
    outcome_for(&final_path, TaskBucket::Archive, TaskSyncStatus::Local, task_id)
}

fn run_defer(ctx: TransitionContext, request: &TaskTransitionRequest) -> Result<TaskTransitionOutcome, String> {
    let defer_date = request
        .defer_date
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "task_defer_date_required".to_string())?;
    let mut updated = patch(
        &ctx.raw,
        "deferDate",
        Some(FrontmatterValue::String(defer_date.to_string())),
    )?;
    // Optional new due date rides in the free-form payload.
    if let Some(due) = request
        .payload
        .get("due")
        .and_then(JsonValue::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        updated = patch(
            &updated,
            "due",
            Some(FrontmatterValue::String(due.to_string())),
        )?;
    }
    write_atomic(&ctx.path, updated.as_bytes())?;
    let bucket = bucket_from_task_path(&ctx.tasks_root, &ctx.path)?;
    append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_deferred",
        Some(request.task_id.clone()),
        json!({ "taskPath": ctx.rel_path, "deferDate": defer_date }),
        ctx.now_iso.clone(),
    )?;
    let _ = note_task_transition(&ctx.work, &ctx.date, &request.task_id, "deferred");
    outcome_for(&ctx.path, bucket, TaskSyncStatus::Local, &request.task_id)
}

/// Apply an explicit task lifecycle transition. Concurrency: the note's
/// sha256 must equal `expected_task_hash` or the transition is rejected.
#[tauri::command]
pub fn task_transition(
    work_path: String,
    request: TaskTransitionRequest,
) -> Result<TaskTransitionOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let ctx = load_context(
        &work_path,
        &request.task_path,
        &request.expected_task_hash,
        request.date.as_deref(),
        request.now_iso.as_deref(),
    )?;
    match request.kind {
        TaskTransitionKind::Complete => {
            assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
            run_complete(ctx, &request.task_id)
        }
        TaskTransitionKind::Reopen => {
            assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
            run_reopen(ctx, &request.task_id)
        }
        TaskTransitionKind::Cancel => {
            assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
            run_cancel(ctx, &request.task_id)
        }
        TaskTransitionKind::Defer => run_defer(ctx, &request),
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TaskTrashOutcome {
    pub trashed_path: String,
}

fn unique_task_trash_path(work: &Path, source: &Path) -> Result<PathBuf, String> {
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("task");
    let timestamp = Utc::now().format("%Y%m%d-%H%M%S");
    let trash_dir = work.join(".maru").join("trash").join("tasks");
    let base = format!("{stem}-{timestamp}");
    for counter in 1.. {
        let file_name = if counter == 1 {
            format!("{base}.md")
        } else {
            format!("{base}-{counter}.md")
        };
        let candidate = trash_dir.join(file_name);
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Cannot allocate trash path".to_string())
}

fn move_file(source: &Path, target: &Path) -> Result<(), String> {
    match fs::rename(source, target) {
        Ok(()) => Ok(()),
        Err(rename_err) => {
            fs::copy(source, target).map_err(|copy_err| {
                format!("Cannot move task note: {rename_err}; copy fallback failed: {copy_err}")
            })?;
            fs::remove_file(source)
                .map_err(|remove_err| format!("Cannot remove original after move: {remove_err}"))
        }
    }
}

/// Move a task note to `.maru/trash/tasks/`. Provider deletion is opt-in:
/// only `remote_delete: true` with a googleTaskId queues a `delete` op.
#[tauri::command]
pub fn task_trash(
    work_path: String,
    task_path: String,
    expected_task_hash: String,
    remote_delete: Option<bool>,
) -> Result<TaskTrashOutcome, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    let ctx = load_context(&work_path, &task_path, &expected_task_hash, None, None)?;
    let trash_path = unique_task_trash_path(&ctx.work, &ctx.path)?;
    if let Some(parent) = trash_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create trash directory: {err}"))?;
    }
    move_file(&ctx.path, &trash_path)?;
    if remote_delete.unwrap_or(false) {
        if let Some(google_task_id) = &ctx.google_task_id {
            today_outbox::enqueue_record(
                &ctx.work,
                OutboxOp::Delete,
                &ctx.rel_path,
                google_task_id,
                ctx.google_task_list_id.clone(),
                OutboxStatus::Ready,
                &ctx.now_iso,
            )?;
        }
    }
    let day = ctx.date.clone();
    append_task_event_for(
        &ctx.work,
        &day,
        "task_trashed",
        None,
        json!({
            "taskPath": ctx.rel_path,
            "trashedPath": rel_path_for(&ctx.work, &trash_path),
            "remoteDelete": remote_delete.unwrap_or(false),
        }),
        ctx.now_iso.clone(),
    )?;
    Ok(TaskTrashOutcome {
        trashed_path: rel_path_for(&ctx.work, &trash_path),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::today::TaskTransitionKind;
    use crate::today_outbox::list_records;
    use serde_json::json;

    const NOW: &str = "2026-07-21T09:00:00+09:00";
    const DAY: &str = "2026-07-21";

    fn setup_task(content: &str) -> (tempfile::TempDir, String, String) {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, content).unwrap();
        let hash = revision_for(&fs::read_to_string(&note).unwrap());
        (
            tmp,
            hash,
            "tasks/active/task.md".to_string(),
        )
    }

    fn request(kind: TaskTransitionKind, hash: &str, rel: &str) -> TaskTransitionRequest {
        TaskTransitionRequest {
            task_id: "task-1".to_string(),
            task_path: rel.to_string(),
            kind,
            expected_task_hash: hash.to_string(),
            defer_date: None,
            date: Some(DAY.to_string()),
            now_iso: Some(NOW.to_string()),
            payload: json!({}),
        }
    }

    fn work(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    #[test]
    fn complete_patches_moves_and_emits_event() {
        let (tmp, hash, rel) = setup_task(
            "---\ntitle: Ship\nstatus: active\nowner: Luca\n# a comment\n---\n# Body\n",
        );
        let outcome = task_transition(work(&tmp), request(TaskTransitionKind::Complete, &hash, &rel))
            .unwrap();

        assert_eq!(outcome.bucket, "archive");
        assert_eq!(outcome.sync_status, TaskSyncStatus::Local);
        let archived = tmp.path().join("tasks/archive/task.md");
        assert!(archived.exists());
        let raw = fs::read_to_string(&archived).unwrap();
        assert!(raw.contains("status: done"));
        assert!(raw.contains(&format!("done: {DAY}")));
        assert!(raw.contains(&format!("completedAt: \"{NOW}\"")));
        // Unknown keys, comments, and body survive.
        assert!(raw.contains("owner: Luca"));
        assert!(raw.contains("# a comment"));
        assert!(raw.contains("# Body"));
        assert_eq!(outcome.new_task_hash, revision_for(&raw));

        let events = fs::read_to_string(
            tmp.path().join(".maru/today/events/2026-07.jsonl"),
        )
        .unwrap();
        assert!(events.contains("\"kind\":\"task_completed\""));
        assert!(events.contains("\"taskId\":\"task-1\""));
    }

    #[test]
    fn transition_rejects_stale_expected_hash() {
        let (tmp, _hash, rel) = setup_task("---\nstatus: active\n---\n# Body\n");
        let mut req = request(TaskTransitionKind::Complete, "bogus", &rel);
        req.expected_task_hash = "bogus".to_string();
        let err = task_transition(work(&tmp), req).unwrap_err();
        assert!(err.starts_with("task_conflict: expected hash bogus, found "));
    }

    #[test]
    fn complete_with_google_task_id_queues_outbox_op() {
        let (tmp, hash, rel) = setup_task(
            "---\nstatus: active\ngoogleTaskId: g-1\ngoogleTaskListId: list-1\n---\n# Body\n",
        );
        let outcome = task_transition(work(&tmp), request(TaskTransitionKind::Complete, &hash, &rel))
            .unwrap();

        assert_eq!(outcome.sync_status, TaskSyncStatus::Syncing);
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].op, OutboxOp::Complete);
        assert_eq!(records[0].status, OutboxStatus::Ready);
        assert_eq!(records[0].google_task_id, "g-1");
        assert_eq!(records[0].google_task_list_id.as_deref(), Some("list-1"));
    }

    #[test]
    fn prepared_record_is_durable_before_local_mutation() {
        // Simulates a crash immediately after step 1: the prepared record
        // exists while the note is still active, and recovery drops it.
        let (tmp, _hash, rel) = setup_task("---\nstatus: active\n---\n# Body\n");
        let record = prepare_complete_op(tmp.path(), &rel, "g-9", None, NOW).unwrap();
        assert_eq!(record.status, OutboxStatus::Prepared);
        assert!(tmp
            .path()
            .join(format!(".maru/today/outbox/{}.json", record.id))
            .exists());

        let recovery = today_outbox::recover_outbox(tmp.path()).unwrap();
        assert_eq!(recovery.dropped, 1);
        assert!(list_records(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn reopen_restores_active_and_queues_provider_op_after_synced_complete() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("tasks/archive/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\nstatus: done\ndone: 2026-07-20\ncompletedAt: \"2026-07-20T10:00:00+09:00\"\ngoogleTaskId: g-1\n---\n# Body\n",
        )
        .unwrap();
        // A complete op already drained to the provider.
        let mut synced = prepare_complete_op(tmp.path(), "tasks/archive/task.md", "g-1", None, NOW)
            .unwrap();
        today_outbox::set_record_status(tmp.path(), &mut synced, OutboxStatus::Synced, NOW).unwrap();

        let hash = revision_for(&fs::read_to_string(&note).unwrap());
        let outcome = task_transition(
            work(&tmp),
            request(TaskTransitionKind::Reopen, &hash, "tasks/archive/task.md"),
        )
        .unwrap();

        assert_eq!(outcome.bucket, "active");
        assert_eq!(outcome.sync_status, TaskSyncStatus::Syncing);
        let raw = fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap();
        assert!(raw.contains("status: active"));
        assert!(!raw.contains("done:"));
        assert!(!raw.contains("completedAt"));
        assert!(raw.contains("googleTaskId: g-1"));
        let reopen = list_records(tmp.path())
            .unwrap()
            .into_iter()
            .find(|record| record.op == OutboxOp::Reopen)
            .expect("provider reopen op queued");
        assert_eq!(reopen.status, OutboxStatus::Ready);
    }

    #[test]
    fn reopen_without_prior_sync_stays_local() {
        let tmp = tempfile::tempdir().unwrap();
        let note = tmp.path().join("tasks/archive/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nstatus: done\n---\n# Body\n").unwrap();
        let hash = revision_for(&fs::read_to_string(&note).unwrap());
        let outcome = task_transition(
            work(&tmp),
            request(TaskTransitionKind::Reopen, &hash, "tasks/archive/task.md"),
        )
        .unwrap();
        assert_eq!(outcome.sync_status, TaskSyncStatus::Local);
        assert!(list_records(tmp.path()).unwrap().is_empty());
    }

    #[test]
    fn cancel_moves_to_archive_without_provider_ops() {
        let (tmp, hash, rel) =
            setup_task("---\nstatus: active\ngoogleTaskId: g-1\n---\n# Body\n");
        let outcome = task_transition(work(&tmp), request(TaskTransitionKind::Cancel, &hash, &rel))
            .unwrap();

        assert_eq!(outcome.bucket, "archive");
        assert_eq!(outcome.sync_status, TaskSyncStatus::Local);
        let raw = fs::read_to_string(tmp.path().join("tasks/archive/task.md")).unwrap();
        assert!(raw.contains("status: cancelled"));
        // Maru-only: nothing queued despite the googleTaskId.
        assert!(list_records(tmp.path()).unwrap().is_empty());
        let events =
            fs::read_to_string(tmp.path().join(".maru/today/events/2026-07.jsonl")).unwrap();
        assert!(events.contains("\"kind\":\"task_cancelled\""));
    }

    #[test]
    fn defer_sets_dates_without_bucket_move() {
        let (tmp, hash, rel) = setup_task("---\nstatus: active\n---\n# Body\n");
        let mut req = request(TaskTransitionKind::Defer, &hash, &rel);
        req.defer_date = Some("2026-07-25".to_string());
        req.payload = json!({ "due": "2026-07-26" });
        let outcome = task_transition(work(&tmp), req).unwrap();

        assert_eq!(outcome.bucket, "active");
        assert!(tmp.path().join("tasks/active/task.md").exists());
        let raw = fs::read_to_string(tmp.path().join("tasks/active/task.md")).unwrap();
        assert!(raw.contains("deferDate: 2026-07-25"));
        assert!(raw.contains("due: 2026-07-26"));

        // deferDate is required.
        let (tmp2, hash2, rel2) = setup_task("---\nstatus: active\n---\n# Body\n");
        let err = task_transition(
            work(&tmp2),
            request(TaskTransitionKind::Defer, &hash2, &rel2),
        )
        .unwrap_err();
        assert_eq!(err, "task_defer_date_required");
    }

    #[test]
    fn trash_moves_note_and_queues_delete_only_on_opt_in() {
        let (tmp, hash, rel) =
            setup_task("---\nstatus: active\ngoogleTaskId: g-1\n---\n# Body\n");

        // Default: local-only trash.
        let outcome = task_trash(work(&tmp), rel.clone(), hash, None).unwrap();
        assert!(outcome.trashed_path.starts_with(".maru/trash/tasks/task-"));
        assert!(outcome.trashed_path.ends_with(".md"));
        assert!(!tmp.path().join(&rel).exists());
        assert!(tmp.path().join(&outcome.trashed_path).exists());
        assert!(list_records(tmp.path()).unwrap().is_empty());
        let events =
            fs::read_to_string(tmp.path().join(".maru/today/events/2026-07.jsonl")).unwrap();
        assert!(events.contains("\"kind\":\"task_trashed\""));

        // Opt-in: provider delete queued.
        let (tmp2, hash2, rel2) =
            setup_task("---\nstatus: active\ngoogleTaskId: g-2\n---\n# Body\n");
        task_trash(work(&tmp2), rel2, hash2, Some(true)).unwrap();
        let records = list_records(tmp2.path()).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].op, OutboxOp::Delete);
        assert_eq!(records[0].status, OutboxStatus::Ready);
        assert_eq!(records[0].google_task_id, "g-2");

        // Hash is enforced on trash too.
        let (tmp3, _hash3, rel3) = setup_task("---\nstatus: active\n---\n# Body\n");
        let err = task_trash(work(&tmp3), rel3, "bogus".to_string(), None).unwrap_err();
        assert!(err.starts_with("task_conflict: expected hash bogus, found "));
    }
}
