// Maru Today — explicit task lifecycle transitions (complete / reopen /
// cancel / defer) with expected-hash optimistic concurrency, plus task
// trash. Provider (Google Tasks) mutations are never applied inline: they
// are recorded in the integration outbox (today_outbox.rs) and drained
// separately, so a completed local transition never depends on the network.
//
// Complete ordering is load-bearing for crash recovery:
//   1. write the durable `prepared` outbox record (when googleTaskId exists)
//   2. patch frontmatter (status/done/completedAt)
//   3. mark the outbox record `ready`
//   4. move the note into the archive bucket
//   5. append the `task_completed` event + best-effort day-snapshot update
// `ready` must land BEFORE the bucket move: recovery resolves a `prepared`
// record via the recorded note path, which the move invalidates — with the
// old ordering a crash between move and ready silently dropped the owed
// provider completion. A crash between 1 and 3 leaves a `prepared` record;
// `recover_outbox` marks it ready when the note landed at the expected
// status, drops it otherwise. A crash between 3 and 4 leaves a done note in
// its old bucket — cosmetic, the provider op is preserved.

use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionRequest,
};
use crate::document::revision_for;
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::ipc_error::{IpcError, TASK_CONFLICT};
use crate::tasks::{
    bucket_from_task_path, conflict_free_path, normalize_task_frontmatter_aliases,
    resolve_tasks_root, string_field, target_path_for_bucket, yaml_to_json, TaskBucket,
};
use crate::today::{
    TaskSyncStatus, TaskTransitionKind, TaskTransitionOutcome, TaskTransitionRequest,
};
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
    web_action_id: Option<String>,
    now_iso: &str,
) -> Result<OutboxRecord, String> {
    today_outbox::enqueue_record(
        work,
        today_outbox::OutboxRecordDraft {
            op: OutboxOp::Complete,
            task_path: rel_path.to_string(),
            google_task_id: google_task_id.to_string(),
            google_task_list_id,
            payload: None,
            status: OutboxStatus::Prepared,
            web_action_id,
        },
        now_iso,
    )
}

fn load_context(
    work_path: &str,
    task_path: &str,
    expected_task_hash: &str,
    date: Option<&str>,
    now_iso: Option<&str>,
) -> Result<TransitionContext, IpcError> {
    let work = normalize_existing_dir(work_path)?;
    let path = resolve_inside_vault(work_path, task_path)?;
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let actual_hash = revision_for(&raw);
    if actual_hash != expected_task_hash {
        return Err(IpcError {
            code: TASK_CONFLICT.to_string(),
            message: format!("expected hash {expected_task_hash}, found {actual_hash}"),
        });
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

fn move_to_bucket(tasks_root: &Path, path: &Path, target: TaskBucket) -> Result<PathBuf, String> {
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

fn run_complete(
    ctx: TransitionContext,
    request: &TaskTransitionRequest,
) -> Result<TaskTransitionOutcome, String> {
    // 1. Durable prepared record FIRST (see module docs for recovery rules).
    let prepared = match &ctx.google_task_id {
        Some(google_task_id) => Some(prepare_complete_op(
            &ctx.work,
            &ctx.rel_path,
            google_task_id,
            ctx.google_task_list_id.clone(),
            request.web_action_id.clone(),
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
    // 3. Prepared -> ready, BEFORE the move invalidates the recorded path;
    // until this lands, recovery owns the record.
    let sync_status = match prepared {
        Some(mut record) => {
            today_outbox::set_record_status(
                &ctx.work,
                &mut record,
                OutboxStatus::Ready,
                &ctx.now_iso,
            )?;
            TaskSyncStatus::Syncing
        }
        None => TaskSyncStatus::Local,
    };
    // 4. Bucket move.
    let final_path = move_to_bucket(&ctx.tasks_root, &ctx.path, TaskBucket::Archive)?;
    let final_rel = rel_path_for(&ctx.work, &final_path);
    // 5. Event + day-snapshot reflection — best-effort: the completion and
    // its provider op are already durable, so an unwritable events dir must
    // not fail the transition (or, worse, strand the record `prepared`).
    let _ = append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_completed",
        Some(request.task_id.clone()),
        json!({
            "taskPath": final_rel,
            "bucket": "archive",
            "displayTitle": request
                .payload
                .get("displayTitle")
                .cloned()
                .unwrap_or(JsonValue::Null),
        }),
        ctx.now_iso.clone(),
    );
    let _ = note_task_transition(&ctx.work, &ctx.date, &request.task_id, "done");
    outcome_for(
        &final_path,
        TaskBucket::Archive,
        sync_status,
        &request.task_id,
    )
}

fn run_reopen(ctx: TransitionContext, task_id: &str) -> Result<TaskTransitionOutcome, String> {
    // Same durable ordering as complete: the provider mirror (only when a
    // complete op already drained — a reopen of a task the provider never
    // saw needs no remote call) is recorded `prepared` BEFORE the local
    // mutation, promoted to `ready` after the patch and before the move.
    let prepared = match &ctx.google_task_id {
        Some(google_task_id) if today_outbox::has_synced_complete(&ctx.work, google_task_id)? => {
            Some(today_outbox::enqueue_record(
                &ctx.work,
                today_outbox::OutboxRecordDraft {
                    op: OutboxOp::Reopen,
                    task_path: ctx.rel_path.clone(),
                    google_task_id: google_task_id.to_string(),
                    google_task_list_id: ctx.google_task_list_id.clone(),
                    payload: None,
                    status: OutboxStatus::Prepared,
                    web_action_id: None,
                },
                &ctx.now_iso,
            )?)
        }
        _ => None,
    };
    let mut updated = patch(
        &ctx.raw,
        "status",
        Some(FrontmatterValue::String("active".to_string())),
    )?;
    updated = patch(&updated, "done", None)?;
    updated = patch(&updated, "completedAt", None)?;
    write_atomic(&ctx.path, updated.as_bytes())?;
    let sync_status = match prepared {
        Some(mut record) => {
            today_outbox::set_record_status(
                &ctx.work,
                &mut record,
                OutboxStatus::Ready,
                &ctx.now_iso,
            )?;
            TaskSyncStatus::Syncing
        }
        None => TaskSyncStatus::Local,
    };
    let final_path = move_to_bucket(&ctx.tasks_root, &ctx.path, TaskBucket::Active)?;
    let final_rel = rel_path_for(&ctx.work, &final_path);
    let _ = append_task_event_for(
        &ctx.work,
        &ctx.date,
        "task_reopened",
        Some(task_id.to_string()),
        json!({ "taskPath": final_rel, "bucket": "active" }),
        ctx.now_iso.clone(),
    );
    let _ = note_task_transition(&ctx.work, &ctx.date, task_id, "active");
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
    outcome_for(
        &final_path,
        TaskBucket::Archive,
        TaskSyncStatus::Local,
        task_id,
    )
}

fn run_defer(
    ctx: TransitionContext,
    request: &TaskTransitionRequest,
) -> Result<TaskTransitionOutcome, String> {
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
/// sha256 must equal `expected_task_hash` or the transition is rejected;
/// shared path admission precedes the Today workspace lock and serializes
/// the hash-check-then-write against Files, document saves and task writers.
/// External editors remain outside process-local admission.
pub fn task_transition(
    work_path: String,
    request: TaskTransitionRequest,
) -> Result<TaskTransitionOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let source = resolve_inside_vault(&work_path, &request.task_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve task cwd: {err}"))?
            .join(&work_path)
    };
    // Reserve whole allocation directories: bucket and outbox/trash names are
    // chosen only after admission. Include lexical aliases as well as resolved
    // paths so renaming a workspace symlink cannot race its descendants.
    let tasks_root = resolve_tasks_root(&work, "tasks")?;
    let mut paths = vec![
        source.clone(),
        tasks_root.clone(),
        tasks_root.join("active"),
        tasks_root.join("archive"),
        work.join(".maru"),
        work.join(".maru/today"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/trash"),
        work.join(".maru/trash/tasks"),
    ];
    let target = match request.kind {
        TaskTransitionKind::Complete | TaskTransitionKind::Cancel => Some(TaskBucket::Archive),
        TaskTransitionKind::Reopen => Some(TaskBucket::Active),
        TaskTransitionKind::Defer => None,
    };
    if let Some(bucket) = target {
        let destination = target_path_for_bucket(&tasks_root, &source, bucket)?;
        paths.push(
            destination
                .parent()
                .ok_or_else(|| "Task target has no parent".to_string())?
                .to_path_buf(),
        );
    }
    // A parent reservation does not cover a child's distinct physical
    // symlink destination. Reserve existing endpoints independently, including
    // linked event files and linked allocation directories.
    for root in [
        &tasks_root,
        &work.join(".maru/today"),
        &work.join(".maru/trash"),
    ] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(root).follow_links(true) {
                let entry =
                    entry.map_err(|err| format!("Cannot inspect task transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths.into_iter().flat_map(|path| {
        let alias = path
            .strip_prefix(&work)
            .map(|rel| lexical_work.join(rel))
            .unwrap_or_else(|_| path.clone());
        [path, alias]
    });
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .require_parent(
            source
                .parent()
                .ok_or_else(|| "Task has no parent".to_string())?,
        )?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        Ok(task_transition_in_transaction(lease, work_path, request))
    })?
}

/// Borrowed entry for callers already holding the complete write set. Lock
/// order remains shared admission -> Today work lock -> event append lock;
/// outbox and day reflection helpers do not reacquire admission.
pub(crate) fn task_transition_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    request: TaskTransitionRequest,
) -> Result<TaskTransitionOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let source = resolve_inside_vault(&work_path, &request.task_path)?;
    let tasks_root = resolve_tasks_root(&work, "tasks")?;
    let mut paths = vec![
        source.clone(),
        tasks_root.clone(),
        tasks_root.join("active"),
        tasks_root.join("archive"),
        work.join(".maru"),
        work.join(".maru/today"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/trash"),
        work.join(".maru/trash/tasks"),
    ];
    let target = match request.kind {
        TaskTransitionKind::Complete | TaskTransitionKind::Cancel => Some(TaskBucket::Archive),
        TaskTransitionKind::Reopen => Some(TaskBucket::Active),
        TaskTransitionKind::Defer => None,
    };
    if let Some(bucket) = target {
        let destination = target_path_for_bucket(&tasks_root, &source, bucket)?;
        paths.push(
            destination
                .parent()
                .ok_or_else(|| "Task target has no parent".to_string())?
                .to_path_buf(),
        );
    }
    // A parent reservation does not cover a child's distinct physical
    // symlink destination. Reserve existing endpoints independently, including
    // linked event files and linked allocation directories.
    for root in [
        &tasks_root,
        &work.join(".maru/today"),
        &work.join(".maru/trash"),
    ] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(root).follow_links(true) {
                let entry =
                    entry.map_err(|err| format!("Cannot inspect task transaction paths: {err}"))?;
                if entry.path_is_symlink() {
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
    let lock = crate::today_store::work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
    let ctx = load_context(
        &work_path,
        &request.task_path,
        &request.expected_task_hash,
        request.date.as_deref(),
        request.now_iso.as_deref(),
    )?;
    let outcome = match request.kind {
        TaskTransitionKind::Complete => {
            assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
            run_complete(ctx, &request)
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
    };
    outcome.map_err(IpcError::from)
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

/// Rename with a copy+remove fallback (cross-device moves, some network
/// mounts). Shared with `web_actions.rs` for the pending -> applied move.
pub(crate) fn move_file(source: &Path, target: &Path) -> Result<(), String> {
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
pub fn task_trash(
    work_path: String,
    task_path: String,
    expected_task_hash: String,
    remote_delete: Option<bool>,
) -> Result<TaskTrashOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let source = resolve_inside_vault(&work_path, &task_path)?;
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| format!("Cannot resolve task cwd: {err}"))?
            .join(&work_path)
    };
    let tasks_root = resolve_tasks_root(&work, "tasks")?;
    let mut paths = vec![
        source.clone(),
        tasks_root.clone(),
        tasks_root.join("active"),
        tasks_root.join("archive"),
        work.join(".maru"),
        work.join(".maru/today"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/trash"),
        work.join(".maru/trash/tasks"),
    ];
    // A parent reservation does not cover a child's distinct physical
    // symlink destination. Reserve existing endpoints independently, including
    // linked event files and linked allocation directories.
    for root in [
        &tasks_root,
        &work.join(".maru/today"),
        &work.join(".maru/trash"),
    ] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(root).follow_links(true) {
                let entry =
                    entry.map_err(|err| format!("Cannot inspect task transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    let paths = paths.into_iter().flat_map(|path| {
        let alias = path
            .strip_prefix(&work)
            .map(|rel| lexical_work.join(rel))
            .unwrap_or_else(|_| path.clone());
        [path, alias]
    });
    let admission = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .require_parent(
            source
                .parent()
                .ok_or_else(|| "Task has no parent".to_string())?,
        )?
        .with_workspace_registry()?;
    with_path_transactions(admission, |lease| {
        Ok(task_trash_in_transaction(
            lease,
            work_path,
            task_path,
            expected_task_hash,
            remote_delete,
        ))
    })?
}

pub(crate) fn task_trash_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    task_path: String,
    expected_task_hash: String,
    remote_delete: Option<bool>,
) -> Result<TaskTrashOutcome, IpcError> {
    let work = normalize_existing_dir(&work_path)?;
    let source = resolve_inside_vault(&work_path, &task_path)?;
    let tasks_root = resolve_tasks_root(&work, "tasks")?;
    let mut paths = vec![
        source.clone(),
        tasks_root.clone(),
        tasks_root.join("active"),
        tasks_root.join("archive"),
        work.join(".maru"),
        work.join(".maru/today"),
        work.join(".maru/today/events"),
        work.join(".maru/today/outbox"),
        work.join(".maru/trash"),
        work.join(".maru/trash/tasks"),
    ];
    // A parent reservation does not cover a child's distinct physical
    // symlink destination. Reserve existing endpoints independently, including
    // linked event files and linked allocation directories.
    for root in [
        &tasks_root,
        &work.join(".maru/today"),
        &work.join(".maru/trash"),
    ] {
        if root.is_dir() {
            for entry in walkdir::WalkDir::new(root).follow_links(true) {
                let entry =
                    entry.map_err(|err| format!("Cannot inspect task transaction paths: {err}"))?;
                if entry.path_is_symlink() {
                    paths.push(entry.into_path());
                }
            }
        }
    }
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Delete)?;
    let work = normalize_existing_dir(&work_path)?;
    let lock = crate::today_store::work_lock_for(&work)?;
    let _guard = lock
        .lock()
        .map_err(|_| "today_work_lock_poisoned".to_string())?;
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
                today_outbox::OutboxRecordDraft {
                    op: OutboxOp::Delete,
                    task_path: ctx.rel_path.clone(),
                    google_task_id: google_task_id.to_string(),
                    google_task_list_id: ctx.google_task_list_id.clone(),
                    payload: None,
                    status: OutboxStatus::Ready,
                    web_action_id: None,
                },
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

/// Owned command inputs cross to the blocking pool before filesystem access
/// or either admission/domain lock can wait. The synchronous APIs also serve
/// web_actions; no caller must enter these adapters while holding a work lock.
pub mod ipc {
    use super::*;

    #[tauri::command]
    pub async fn task_transition(
        work_path: String,
        request: TaskTransitionRequest,
    ) -> Result<TaskTransitionOutcome, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:task_transition",
            );
            super::task_transition(work_path, request)
        })
        .await
        .map_err(|err| IpcError::from(format!("task_transition_task_failed: {err}")))?
    }

    #[tauri::command]
    pub async fn task_trash(
        work_path: String,
        task_path: String,
        expected_task_hash: String,
        remote_delete: Option<bool>,
    ) -> Result<TaskTrashOutcome, IpcError> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:task_trash");
            super::task_trash(work_path, task_path, expected_task_hash, remote_delete)
        })
        .await
        .map_err(|err| IpcError::from(format!("task_trash_task_failed: {err}")))?
    }
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
        (tmp, hash, "tasks/active/task.md".to_string())
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
            web_action_id: None,
            payload: json!({}),
        }
    }

    fn work(tmp: &tempfile::TempDir) -> String {
        tmp.path().to_string_lossy().to_string()
    }

    #[test]
    fn complete_patches_moves_and_emits_event() {
        let (tmp, hash, rel) =
            setup_task("---\ntitle: Ship\nstatus: active\nowner: Luca\n# a comment\n---\n# Body\n");
        let mut request = request(TaskTransitionKind::Complete, &hash, &rel);
        request.payload = json!({ "displayTitle": "Ship the release" });
        let outcome = task_transition(work(&tmp), request).unwrap();

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

        let events =
            fs::read_to_string(tmp.path().join(".maru/today/events/2026-07.jsonl")).unwrap();
        assert!(events.contains("\"kind\":\"task_completed\""));
        assert!(events.contains("\"taskId\":\"task-1\""));
        assert!(events.contains("\"displayTitle\":\"Ship the release\""));
    }

    #[test]
    fn transition_rejects_stale_expected_hash() {
        let (tmp, _hash, rel) = setup_task("---\nstatus: active\n---\n# Body\n");
        let mut req = request(TaskTransitionKind::Complete, "bogus", &rel);
        req.expected_task_hash = "bogus".to_string();
        let err = task_transition(work(&tmp), req).unwrap_err();
        assert_eq!(err.code, TASK_CONFLICT);
        assert!(err
            .to_string()
            .starts_with("task_conflict: expected hash bogus, found "));
    }

    #[test]
    fn complete_with_google_task_id_queues_outbox_op() {
        let (tmp, hash, rel) = setup_task(
            "---\nstatus: active\ngoogleTaskId: g-1\ngoogleTaskListId: list-1\n---\n# Body\n",
        );
        let outcome = task_transition(
            work(&tmp),
            request(TaskTransitionKind::Complete, &hash, &rel),
        )
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
    fn complete_marks_record_ready_before_move_and_survives_event_failure() {
        // Regression for the crash window that dropped provider completions:
        // `ready` must land before the archive move, and an unwritable
        // events dir must not abort a committed completion.
        let (tmp, hash, rel) = setup_task("---\nstatus: active\ngoogleTaskId: g-1\n---\n# Body\n");
        // `.maru/today/events` as a FILE makes every event append fail.
        let events_dir = tmp.path().join(".maru/today/events");
        fs::create_dir_all(events_dir.parent().unwrap()).unwrap();
        fs::write(&events_dir, "not a directory").unwrap();

        let outcome = task_transition(
            work(&tmp),
            request(TaskTransitionKind::Complete, &hash, &rel),
        )
        .unwrap();
        assert_eq!(outcome.sync_status, TaskSyncStatus::Syncing);
        assert!(tmp.path().join("tasks/archive/task.md").exists());
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records[0].status, OutboxStatus::Ready);
    }

    #[test]
    fn prepared_complete_recovers_when_patch_landed_before_ready() {
        // Crash between the frontmatter patch and prepared->ready: the note
        // is done at the RECORDED (pre-move) path, so recovery must promote
        // the record, not drop it.
        let (tmp, _hash, rel) = setup_task("---\nstatus: active\ngoogleTaskId: g-9\n---\n# Body\n");
        let record = prepare_complete_op(tmp.path(), &rel, "g-9", None, None, NOW).unwrap();
        let note = tmp.path().join(&rel);
        let patched = update_frontmatter_content(
            &fs::read_to_string(&note).unwrap(),
            "status",
            Some(FrontmatterValue::String("done".to_string())),
        )
        .unwrap();
        fs::write(&note, patched).unwrap();

        let recovery = today_outbox::recover_outbox(tmp.path()).unwrap();
        assert_eq!(recovery.recovered, 1);
        assert_eq!(recovery.dropped, 0);
        let records = list_records(tmp.path()).unwrap();
        assert_eq!(records[0].id, record.id);
        assert_eq!(records[0].status, OutboxStatus::Ready);
    }

    #[test]
    fn prepared_record_is_durable_before_local_mutation() {
        // Simulates a crash immediately after step 1: the prepared record
        // exists while the note is still active, and recovery drops it.
        let (tmp, _hash, rel) = setup_task("---\nstatus: active\n---\n# Body\n");
        let record = prepare_complete_op(tmp.path(), &rel, "g-9", None, None, NOW).unwrap();
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
        let mut synced =
            prepare_complete_op(tmp.path(), "tasks/archive/task.md", "g-1", None, None, NOW)
                .unwrap();
        today_outbox::set_record_status(tmp.path(), &mut synced, OutboxStatus::Synced, NOW)
            .unwrap();

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
        let (tmp, hash, rel) = setup_task("---\nstatus: active\ngoogleTaskId: g-1\n---\n# Body\n");
        let outcome =
            task_transition(work(&tmp), request(TaskTransitionKind::Cancel, &hash, &rel)).unwrap();

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
        assert_eq!(err.to_string(), "task_defer_date_required");
    }

    #[test]
    fn trash_moves_note_and_queues_delete_only_on_opt_in() {
        let (tmp, hash, rel) = setup_task("---\nstatus: active\ngoogleTaskId: g-1\n---\n# Body\n");

        // Default: local-only trash.
        let outcome = task_trash(work(&tmp), rel.clone(), hash, None).unwrap();
        assert!(outcome.trashed_path.starts_with(".maru/trash/tasks/task-"));
        assert!(outcome.trashed_path.ends_with(".md"));
        assert!(!tmp.path().join(&rel).exists());
        assert!(tmp.path().join(&outcome.trashed_path).exists());
        assert!(list_records(tmp.path()).unwrap().is_empty());
        // task_trash takes no date, so its event lands in the current UTC
        // month's file. Hardcoding one made this test fail on the 1st of every
        // month; derive it the way today_store does.
        let month = &Utc::now().to_rfc3339()[..7];
        let events =
            fs::read_to_string(tmp.path().join(format!(".maru/today/events/{month}.jsonl")))
                .unwrap();
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
        assert_eq!(err.code, TASK_CONFLICT);
        assert!(err
            .to_string()
            .starts_with("task_conflict: expected hash bogus, found "));
    }
}

#[cfg(test)]
mod phase08_11 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::phase08_08::registry;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;

    const REL: &str = "tasks/active/task.md";
    const DAY: &str = "2026-09-05";
    const RAW: &str = "---\ntitle: Original\nstatus: active\ncustom: preserved\n---\n# Original\n";

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn fixture(home: &Home) -> tempfile::TempDir {
        let tmp = tempfile::tempdir_in(home.root.path()).unwrap();
        fs::create_dir_all(tmp.path().join("tasks/active")).unwrap();
        fs::create_dir(tmp.path().join(".maru")).unwrap();
        fs::write(tmp.path().join(REL), RAW).unwrap();
        tmp
    }
    fn request(kind: TaskTransitionKind, task_path: &str, hash: String) -> TaskTransitionRequest {
        TaskTransitionRequest {
            task_id: "fixture-task".into(),
            task_path: task_path.into(),
            kind,
            expected_task_hash: hash,
            defer_date: Some("2026-09-06".into()),
            date: Some(DAY.into()),
            now_iso: Some("2026-09-05T09:00:00+09:00".into()),
            web_action_id: None,
            payload: json!({}),
        }
    }
    async fn mutate(op: &'static str, work: String, hash: String) -> Result<(), IpcError> {
        match op {
            "transition" => {
                ipc::task_transition(work, request(TaskTransitionKind::Defer, REL, hash))
                    .await
                    .map(|_| ())
            }
            "trash" => ipc::task_trash(work, REL.into(), hash, None)
                .await
                .map(|_| ()),
            _ => unreachable!(),
        }
    }
    fn start<F: std::future::Future + Send + 'static>(future: F) -> mpsc::Receiver<F::Output>
    where
        F::Output: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }
    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("bounded lifecycle completion")
    }

    #[test]
    fn phase08_11_lifecycle_real_wrappers_preserve_payloads_outbox_and_rejections() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let w = text(root);
        let raw = RAW.replace(
            "status: active",
            "status: active\ngoogleTaskId: fixture-google-task",
        );
        fs::write(root.join(REL), &raw).unwrap();
        let completed = run(ipc::task_transition(
            w.clone(),
            request(TaskTransitionKind::Complete, REL, revision_for(&raw)),
        ))
        .unwrap();
        assert_eq!(completed.bucket, "archive");
        assert_eq!(completed.sync_status, TaskSyncStatus::Syncing);
        let archived = "tasks/archive/task.md";
        let after = fs::read_to_string(root.join(archived)).unwrap();
        assert!(after.contains("custom: preserved"));
        assert!(after.contains("# Original"));
        assert_eq!(completed.new_task_hash, revision_for(&after));
        let records = today_outbox::list_records(root).unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].status, OutboxStatus::Ready);
        let reopened = run(ipc::task_transition(
            w.clone(),
            request(
                TaskTransitionKind::Reopen,
                archived,
                completed.new_task_hash,
            ),
        ))
        .unwrap();
        assert_eq!(reopened.bucket, "active");
        let deferred = run(ipc::task_transition(
            w.clone(),
            request(TaskTransitionKind::Defer, REL, reopened.new_task_hash),
        ))
        .unwrap();
        let raw = fs::read_to_string(root.join(REL)).unwrap();
        assert!(raw.contains("deferDate: 2026-09-06"));
        let stale = run(ipc::task_transition(
            w.clone(),
            request(TaskTransitionKind::Cancel, REL, "stale".into()),
        ))
        .unwrap_err();
        assert_eq!(stale.code, TASK_CONFLICT);
        let mut invalid = request(
            TaskTransitionKind::Defer,
            REL,
            deferred.new_task_hash.clone(),
        );
        invalid.defer_date = None;
        let invalid = run(ipc::task_transition(w.clone(), invalid)).unwrap_err();
        assert!(invalid.code.is_empty());
        assert_eq!(invalid.message, "task_defer_date_required");
        let cancelled = run(ipc::task_transition(
            w.clone(),
            request(TaskTransitionKind::Cancel, REL, deferred.new_task_hash),
        ))
        .unwrap();
        assert_eq!(cancelled.bucket, "archive");
        let stale = run(ipc::task_trash(
            w.clone(),
            archived.into(),
            "stale".into(),
            Some(true),
        ))
        .unwrap_err();
        assert_eq!(stale.code, TASK_CONFLICT);
        let trashed = run(ipc::task_trash(
            w,
            archived.into(),
            cancelled.new_task_hash,
            Some(true),
        ))
        .unwrap();
        assert!(trashed.trashed_path.starts_with(".maru/trash/tasks/"));
        assert!(root.join(&trashed.trashed_path).is_file());
        assert!(!root.join(archived).exists());
        let records = today_outbox::list_records(root).unwrap();
        assert!(records
            .iter()
            .any(|record| record.op == OutboxOp::Delete && record.status == OutboxStatus::Ready));
        let events = fs::read_dir(root.join(".maru/today/events"))
            .unwrap()
            .map(|entry| fs::read_to_string(entry.unwrap().path()).unwrap())
            .collect::<Vec<_>>()
            .join("\n");
        for kind in [
            "task_completed",
            "task_reopened",
            "task_deferred",
            "task_cancelled",
            "task_trashed",
        ] {
            assert!(events.contains(kind));
        }
    }

    #[test]
    fn phase08_11_lifecycle_wrappers_yield_on_same_task_distinct_worker_and_join_error() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            let tmp = fixture(&home);
            let root = tmp.path().to_path_buf();
            let work = text(&root);
            let command = if op == "transition" {
                "task_transition"
            } else {
                "task_trash"
            };
            boundary(root, command, async move {
                match mutate(op, work, revision_for(RAW)).await {
                    Ok(()) => Ok(()),
                    Err(error) => {
                        // Boundary checks the display-only JoinError contract;
                        // typed mutation conflicts never cross this conversion.
                        assert!(error.code.is_empty());
                        Err(error.message)
                    }
                }
            });
        }
    }

    #[test]
    fn phase08_11_lifecycle_same_target_unwind_releases_admission_before_domain_lock() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let work = text(root);
            let source = root.join(REL);
            let held = Held::new(source.clone(), "admitted");
            let first = start(mutate(op, work.clone(), revision_for(RAW)));
            held.wait();
            let waiting = Held::new(source.clone(), "before-admission");
            let second = start(mutate(op, work, revision_for(RAW)));
            waiting.wait();
            waiting.release();
            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
            let once = AtomicBool::new(false);
            let injection = PathTransactionTestHook::new(source, "pre-effect", move || {
                if !once.swap(true, Ordering::SeqCst) {
                    panic!("fixture lifecycle failure before domain lock");
                }
            });
            held.release();
            let error = done(first).unwrap_err();
            assert!(error.code.is_empty());
            assert!(error.message.contains("_task_failed:"));
            done(second).unwrap();
            drop(injection);
            if op == "transition" {
                assert!(fs::read_to_string(root.join(REL))
                    .unwrap()
                    .contains("deferDate:"));
            } else {
                assert!(!root.join(REL).exists());
                assert_eq!(
                    fs::read_dir(root.join(".maru/trash/tasks"))
                        .unwrap()
                        .count(),
                    1
                );
            }
        }
    }

    #[test]
    fn phase08_11_lifecycle_successful_transition_serializes_stale_trash_and_retry() {
        let home = Home::new();
        let tmp = fixture(&home);
        let root = tmp.path();
        let source = root.join(REL);
        let held = Held::new(source.clone(), "admitted");
        let first = start(mutate("transition", text(root), revision_for(RAW)));
        held.wait();
        let waiting = Held::new(source.clone(), "before-admission");
        let second = start(mutate("trash", text(root), revision_for(RAW)));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        assert_eq!(done(second).unwrap_err().code, TASK_CONFLICT);
        let raw = fs::read_to_string(source).unwrap();
        assert!(raw.contains("deferDate:"));
        assert!(!root.join(".maru/trash").exists());
        run(mutate("trash", text(root), revision_for(&raw))).unwrap();
        assert!(!root.join(REL).exists());
    }

    #[test]
    fn phase08_11_lifecycle_policy_rechecked_inside_admission_and_error_releases() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            registry(root, "direct");
            let held = Held::new(root.join(REL), "admitted");
            let first = start(mutate(op, text(root), revision_for(RAW)));
            held.wait();
            registry(root, "readOnly");
            held.release();
            let error = done(first).unwrap_err();
            assert!(error.code.is_empty());
            assert!(error.message.contains("Workspace writes are blocked"));
            assert_eq!(fs::read_to_string(root.join(REL)).unwrap(), RAW);
            assert!(!root.join(".maru/today").exists());
            assert!(!root.join(".maru/trash").exists());
            registry(root, "direct");
            run(mutate(op, text(root), revision_for(RAW))).unwrap();
        }
    }

    async fn parent_mutation(
        operation: &'static str,
        work: String,
        source: String,
        new_name: String,
    ) -> Result<(), String> {
        if operation == "rename" {
            crate::workspace_files::ipc::rename_workspace_entry(work, source, new_name).await?;
        } else {
            let outcomes =
                crate::workspace_files::ipc::trash_workspace_entries(work, vec![source]).await?;
            assert_eq!(outcomes.len(), 1);
            assert_eq!(
                outcomes[0].status,
                crate::workspace_files::WorkspaceMutationStatus::Done
            );
        }
        Ok(())
    }

    #[test]
    fn phase08_11_lifecycle_files_parent_rename_trash_both_orders_and_aliases() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            for files_op in ["rename", "trash"] {
                for parent_first in [false, true] {
                    for alias in [false, true] {
                        if alias && !cfg!(unix) {
                            continue;
                        }
                        let tmp = fixture(&home);
                        let root = tmp.path();
                        let parent = root.parent().unwrap();
                        let mut parent_work = text(parent);
                        #[cfg(unix)]
                        if alias {
                            let alias_path = parent.join(format!(
                                "alias-{}",
                                root.file_name().unwrap().to_string_lossy()
                            ));
                            std::os::unix::fs::symlink(parent, &alias_path).unwrap();
                            parent_work = text(&alias_path);
                        }
                        let source = root.file_name().unwrap().to_string_lossy().into_owned();
                        let new_name = format!("moved-{source}");
                        let moved = parent.join(&new_name);
                        let _trash = crate::workspace_files::phase08_06::TrashFixture::new(
                            root.to_path_buf(),
                            moved.clone(),
                        );
                        if parent_first {
                            let held = Held::new(root.to_path_buf(), "admitted");
                            let first =
                                start(parent_mutation(files_op, parent_work, source, new_name));
                            held.wait();
                            let waiting = Held::new(root.join(REL), "before-admission");
                            let second = start(mutate(op, text(root), revision_for(RAW)));
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            assert!(done(second).is_err());
                            assert_eq!(fs::read_to_string(moved.join(REL)).unwrap(), RAW);
                            assert!(!moved.join(".maru/today").exists());
                            assert!(!root.exists());
                        } else {
                            let held = Held::new(root.join(REL), "admitted");
                            let first = start(mutate(op, text(root), revision_for(RAW)));
                            held.wait();
                            let waiting = Held::new(root.to_path_buf(), "before-admission");
                            let second =
                                start(parent_mutation(files_op, parent_work, source, new_name));
                            waiting.wait();
                            waiting.release();
                            assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                            held.release();
                            done(first).unwrap();
                            done(second).unwrap();
                            assert!(!root.exists());
                            if op == "transition" {
                                assert!(fs::read_to_string(moved.join(REL))
                                    .unwrap()
                                    .contains("deferDate:"));
                            } else {
                                assert_eq!(
                                    fs::read_dir(moved.join(".maru/trash/tasks"))
                                        .unwrap()
                                        .count(),
                                    1
                                );
                            }
                        }
                    }
                }
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn phase08_11_lifecycle_nested_destination_aliases_contend_with_real_files() {
        let home = Home::new();
        for endpoint in [
            "archive",
            "events",
            "event-file",
            "double-event-file",
            "outbox",
            "trash",
        ] {
            for parent_first in [false, true] {
                let tmp = fixture(&home);
                let root = tmp.path();
                let target = tempfile::tempdir_in(home.root.path()).unwrap();
                let external = target.path();
                let destination = match endpoint {
                    "archive" => root.join("tasks/archive"),
                    "events" | "double-event-file" => root.join(".maru/today/events"),
                    "event-file" => root.join(".maru/today/events/2026-09.jsonl"),
                    "outbox" => root.join(".maru/today/outbox"),
                    "trash" => root.join(".maru/trash/tasks"),
                    _ => unreachable!(),
                };
                fs::create_dir_all(destination.parent().unwrap()).unwrap();
                // Keep the intermediary directory alive: the event directory
                // links here, and its month file links to a second physical root.
                let intermediary = tempfile::tempdir_in(home.root.path()).unwrap();
                if endpoint == "double-event-file" {
                    fs::write(external.join("events.jsonl"), "").unwrap();
                    std::os::unix::fs::symlink(
                        external.join("events.jsonl"),
                        intermediary.path().join("2026-09.jsonl"),
                    )
                    .unwrap();
                    std::os::unix::fs::symlink(intermediary.path(), &destination).unwrap();
                } else if endpoint == "event-file" {
                    fs::write(external.join("events.jsonl"), "").unwrap();
                    std::os::unix::fs::symlink(external.join("events.jsonl"), &destination)
                        .unwrap();
                } else {
                    std::os::unix::fs::symlink(external, &destination).unwrap();
                }
                let raw = RAW.replace(
                    "status: active",
                    "status: active\ngoogleTaskId: fixture-google-task",
                );
                fs::write(root.join(REL), &raw).unwrap();
                let work = text(root);
                let hash = revision_for(&raw);
                let lifecycle = async move {
                    if endpoint == "trash" {
                        ipc::task_trash(work, REL.into(), hash, Some(true))
                            .await
                            .map(|_| ())
                    } else {
                        ipc::task_transition(work, request(TaskTransitionKind::Complete, REL, hash))
                            .await
                            .map(|_| ())
                    }
                };
                let source = external.file_name().unwrap().to_string_lossy().into_owned();
                let new_name = format!("moved-{source}");
                let moved = home.root.path().join(&new_name);
                let files = parent_mutation("rename", text(home.root.path()), source, new_name);
                if parent_first {
                    let held = Held::new(external.to_path_buf(), "admitted");
                    let first = start(files);
                    held.wait();
                    let waiting = Held::new(root.join(REL), "before-admission");
                    let second = start(lifecycle);
                    waiting.wait();
                    waiting.release();
                    assert!(
                        second.recv_timeout(Duration::from_millis(30)).is_err(),
                        "{endpoint}"
                    );
                    held.release();
                    done(first).unwrap();
                    assert!(done(second).is_err(), "{endpoint}");
                    assert_eq!(fs::read_to_string(root.join(REL)).unwrap(), raw);
                    assert!(!external.exists());
                } else {
                    let held = Held::new(root.join(REL), "admitted");
                    let first = start(lifecycle);
                    held.wait();
                    let waiting = Held::new(external.to_path_buf(), "before-admission");
                    let second = start(files);
                    waiting.wait();
                    waiting.release();
                    assert!(
                        second.recv_timeout(Duration::from_millis(30)).is_err(),
                        "{endpoint}"
                    );
                    held.release();
                    done(first).unwrap();
                    done(second).unwrap();
                    assert!(!root.join(REL).exists());
                    assert!(!external.exists());
                    assert!(fs::read_dir(&moved).unwrap().next().is_some(), "{endpoint}");
                }
            }
        }
    }

    #[test]
    fn phase08_11_lifecycle_document_save_both_orders_preserves_typed_staleness() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            for lifecycle_first in [false, true] {
                let tmp = fixture(&home);
                let root = tmp.path();
                let work = text(root);
                let source = root.join(REL);
                let save = crate::document::ipc::save_document(
                    work.clone(),
                    text(&source),
                    RAW.replace("Original", "Editor"),
                    Some(revision_for(RAW)),
                );
                if lifecycle_first {
                    let held = Held::new(source.clone(), "admitted");
                    let first = start(mutate(op, work.clone(), revision_for(RAW)));
                    held.wait();
                    let waiting = Held::new(source, "before-admission");
                    let second = start(save);
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert_eq!(
                        done(second).unwrap_err().code,
                        crate::ipc_error::DOCUMENT_CONFLICT
                    );
                    assert_eq!(root.join(REL).exists(), op == "transition");
                } else {
                    let held = Held::new(source.clone(), "admitted");
                    let first = start(save);
                    held.wait();
                    let waiting = Held::new(source.clone(), "before-admission");
                    let second = start(mutate(op, work.clone(), revision_for(RAW)));
                    waiting.wait();
                    waiting.release();
                    assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                    held.release();
                    done(first).unwrap();
                    assert_eq!(done(second).unwrap_err().code, TASK_CONFLICT);
                    let raw = fs::read_to_string(source).unwrap();
                    assert!(raw.contains("Editor"));
                    assert!(!raw.contains("deferDate:"));
                    assert!(!root.join(".maru/today").exists());
                    run(mutate(op, work, revision_for(&raw))).unwrap();
                }
            }
        }
    }

    #[test]
    fn phase08_11_lifecycle_parent_replacement_and_borrowed_coverage_fail_before_effect() {
        let home = Home::new();
        for op in ["transition", "trash"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let source = root.join(REL);
            let held = Held::new(source, "before-admission");
            let first = start(mutate(op, text(root), revision_for(RAW)));
            held.wait();
            let original = root.join("tasks/active");
            let moved = root.join("tasks/original-active");
            fs::rename(&original, &moved).unwrap();
            fs::create_dir(&original).unwrap();
            fs::write(original.join("task.md"), RAW).unwrap();
            held.release();
            assert!(done(first).is_err());
            assert_eq!(fs::read_to_string(moved.join("task.md")).unwrap(), RAW);
            assert_eq!(fs::read_to_string(root.join(REL)).unwrap(), RAW);
            assert!(!root.join(".maru/today").exists());
            assert!(!root.join(".maru/trash").exists());
            let admission = PathTransactionRequest::new(vec![root.join(".maru")])
                .unwrap()
                .with_workspace_registry()
                .unwrap();
            let error = with_path_transactions(admission, |lease| {
                Ok(if op == "transition" {
                    task_transition_in_transaction(
                        lease,
                        text(root),
                        request(TaskTransitionKind::Defer, REL, revision_for(RAW)),
                    )
                    .map(|_| ())
                } else {
                    task_trash_in_transaction(
                        lease,
                        text(root),
                        REL.into(),
                        revision_for(RAW),
                        None,
                    )
                    .map(|_| ())
                })
            })
            .unwrap()
            .unwrap_err();
            assert!(error.code.is_empty());
            assert_eq!(
                error.message,
                "Nested mutation exceeds the admitted path set"
            );
            run(mutate(op, text(root), revision_for(RAW))).unwrap();
        }
    }
}
