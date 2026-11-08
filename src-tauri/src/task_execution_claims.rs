//! Durable, opt-in claims for one task execution at a time.
//!
//! The task markdown remains authoritative. This file only records admission,
//! native process ownership and the conditional revision that an execution
//! began from; it never changes task status or stores prompts.

use crate::agent_host::contracts::TaskExecutionRequest;
use crate::atomic_file::{
    with_path_transactions, write_atomic, write_atomic_private, PathTransactionLease,
    PathTransactionParent, PathTransactionRequest,
};
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::jobs::receipts::{
    identity, process_ownership, verify_lock_identity, JobRunReceipt, NativeProcessIdentity,
    ProcessOwnership,
};
use crate::vault::{
    lexical_normalize, normalize_existing_dir, parse_frontmatter, resolve_inside_vault,
};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;
use walkdir::WalkDir;

const CLAIM_DIR: &str = ".maru/task-execution";
const CLAIM_LOCK_DIR: &str = ".maru/task-execution/locks";
const MAX_CLAIM_BYTES: u64 = 512 * 1024;
const MAX_CLAIM_FILES: usize = 4096;
const MAX_TASK_FILES: usize = 20_000;
const MAX_TASK_BYTES: u64 = 4 * 1024 * 1024;
const REQUEST_HISTORY_LIMIT: usize = 100;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum TaskExecutionLifecycle {
    Active,
    Finished,
    Released,
    Reconciled,
    NeedsReview,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecutionToken {
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) run_id: String,
    pub(crate) generation: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct TaskExecutionClaim {
    pub(crate) workspace: String,
    pub(crate) task_id: String,
    pub(crate) request_id: String,
    pub(crate) run_id: String,
    pub(crate) task_path: String,
    #[serde(default)]
    request_path: String,
    pub(crate) tasks_root: String,
    /// Current task bytes after identity binding. The originating request's
    /// frozen revision remains in `receipt.jobRevision`.
    pub(crate) source_revision: String,
    pub(crate) generation: u64,
    pub(crate) lifecycle: TaskExecutionLifecycle,
    pub(crate) receipt: JobRunReceipt,
    #[serde(default)]
    child_reaped: bool,
    #[serde(default = "conservative_spawn_attempted")]
    spawn_attempted: bool,
    #[serde(default)]
    request_history: Vec<TaskExecutionRequestRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TaskExecutionRequestRecord {
    request_id: String,
    run_id: String,
    task_path: String,
    request_path: String,
    source_revision: String,
    generation: u64,
    lifecycle: TaskExecutionLifecycle,
    receipt: JobRunReceipt,
    #[serde(default)]
    child_reaped: bool,
    #[serde(default = "conservative_spawn_attempted")]
    spawn_attempted: bool,
}

fn conservative_spawn_attempted() -> bool {
    true
}

impl TaskExecutionRequestRecord {
    fn from_claim(claim: &TaskExecutionClaim) -> Self {
        Self {
            request_id: claim.request_id.clone(),
            run_id: claim.run_id.clone(),
            task_path: claim.task_path.clone(),
            request_path: claim.request_path.clone(),
            source_revision: claim.source_revision.clone(),
            generation: claim.generation,
            lifecycle: claim.lifecycle,
            receipt: claim.receipt.clone(),
            child_reaped: claim.child_reaped,
            spawn_attempted: claim.spawn_attempted,
        }
    }
}

impl TaskExecutionClaim {
    pub(crate) fn token(&self) -> TaskExecutionToken {
        TaskExecutionToken {
            task_id: self.task_id.clone(),
            request_id: self.request_id.clone(),
            run_id: self.run_id.clone(),
            generation: self.generation,
        }
    }

    fn historical(&self, record: &TaskExecutionRequestRecord) -> Self {
        Self {
            workspace: self.workspace.clone(),
            task_id: self.task_id.clone(),
            request_id: record.request_id.clone(),
            run_id: record.run_id.clone(),
            task_path: record.task_path.clone(),
            request_path: record.request_path.clone(),
            tasks_root: self.tasks_root.clone(),
            source_revision: record.source_revision.clone(),
            generation: record.generation,
            lifecycle: record.lifecycle,
            receipt: record.receipt.clone(),
            child_reaped: record.child_reaped,
            spawn_attempted: record.spawn_attempted,
            request_history: Vec::new(),
        }
    }

    pub(crate) fn execution_for_token(&self, token: &TaskExecutionToken) -> Option<Self> {
        if token_matches(self, token) {
            return Some(self.clone());
        }
        self.request_history
            .iter()
            .find(|record| {
                record.request_id == token.request_id
                    && record.run_id == token.run_id
                    && record.generation == token.generation
            })
            .map(|record| self.historical(record))
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Admission {
    pub(crate) claim: TaskExecutionClaim,
    pub(crate) replayed: bool,
}

/// Holds an existing opt-in claim lock across one managed task mutation.
/// Ordinary tasks receive no guard and create no claim infrastructure.
pub(crate) struct TaskMutationGuard {
    work: PathBuf,
    claim: TaskExecutionClaim,
    claim_path: PathBuf,
    task_lock_path: PathBuf,
    task_lock: File,
}

impl TaskMutationGuard {
    pub(crate) fn paths(&self) -> Vec<PathBuf> {
        vec![self.claim_path.clone(), self.task_lock_path.clone()]
    }

    pub(crate) fn check(&self, lease: &PathTransactionLease, source: &Path) -> Result<(), String> {
        lease.ensure_covered(self.paths())?;
        lease.ensure_covered([source.to_path_buf()])?;
        verify_lock_identity(&self.task_lock, &self.task_lock_path)?;
        let current = read_claim(&self.claim_path, &self.claim.task_id)?.ok_or_else(|| {
            action_error(
                "task_execution_claim_missing",
                &self.claim_path,
                "claim disappeared during mutation",
                "refresh the task and retry",
            )
        })?;
        if current.token() != self.claim.token() || current.lifecycle != self.claim.lifecycle {
            return Err(action_error(
                "task_execution_token_stale",
                &self.claim_path,
                "execution changed during mutation",
                "refresh the task and retry",
            ));
        }
        Ok(())
    }

    pub(crate) fn after_mutation(
        &mut self,
        lease: &PathTransactionLease,
        path: &Path,
    ) -> Result<(), String> {
        lease.ensure_covered(self.paths())?;
        lease.ensure_covered([path.to_path_buf()])?;
        verify_lock_identity(&self.task_lock, &self.task_lock_path)?;
        let roots = WorkspaceRoots {
            work: self.work.clone(),
            tasks: PathBuf::from(&self.claim.tasks_root),
            identity: display(&self.work),
        };
        let mut current = read_claim(&self.claim_path, &self.claim.task_id)?.ok_or_else(|| {
            action_error(
                "task_execution_claim_missing",
                &self.claim_path,
                "claim disappeared after mutation",
                "review the task and retry",
            )
        })?;
        validate_claim_token(&current, &self.claim.token())?;
        let new_path = relative_task_path(&roots, path)?;
        let snapshot = task_snapshot(&roots, path).ok();
        if matches!(
            current.lifecycle,
            TaskExecutionLifecycle::Active | TaskExecutionLifecycle::NeedsReview
        ) && snapshot.as_ref().is_none_or(|note| {
            note.task_id.as_deref() != Some(current.task_id.as_str())
                || note.revision != current.source_revision
                || note.archived
                || matches!(note.status.as_deref(), Some("done" | "cancelled"))
        }) {
            current.lifecycle = TaskExecutionLifecycle::NeedsReview;
            current.receipt.process_outcome = "needsReview".into();
        }
        if current.task_path != new_path || current.lifecycle != self.claim.lifecycle {
            current.task_path = new_path;
            write_claim(&roots, lease, &current, &self.task_lock)?;
        }
        self.claim = current;
        Ok(())
    }
}

struct TaskSnapshot {
    path: PathBuf,
    content: String,
    revision: String,
    task_id: Option<String>,
    status: Option<String>,
    archived: bool,
}

struct WorkspaceRoots {
    work: PathBuf,
    tasks: PathBuf,
    identity: String,
}

fn display(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn action_error(code: &str, path: &Path, cause: &str, next: &str) -> String {
    format!("{code}: path={} cause={cause}; next={next}", display(path))
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn hash_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_task_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn task_id_from_content(content: &str) -> Option<String> {
    let parsed = parse_frontmatter(content);
    let json = crate::tasks::yaml_to_json(&parsed.meta);
    crate::tasks::string_field(&json, "taskId")
}

fn status_from_content(content: &str) -> Option<String> {
    let parsed = parse_frontmatter(content);
    let json = crate::tasks::yaml_to_json(&parsed.meta);
    crate::tasks::string_field(&json, "status").map(|value| value.to_ascii_lowercase())
}

fn task_id_from_path_bounded(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    if length > MAX_TASK_BYTES {
        return None;
    }
    let mut prefix = Vec::new();
    file.take(MAX_TASK_BYTES + 1)
        .read_to_end(&mut prefix)
        .ok()?;
    if prefix.len() as u64 > MAX_TASK_BYTES {
        return None;
    }
    let text = std::str::from_utf8(&prefix).ok()?;
    task_id_from_content(text)
}

fn workspace_roots(work: &Path, raw_tasks_root: Option<&str>) -> Result<WorkspaceRoots, String> {
    let work = normalize_existing_dir(&display(work)).map_err(|error| {
        action_error(
            "task_execution_workspace_invalid",
            work,
            &error,
            "open the registered workspace and retry",
        )
    })?;
    let requested = raw_tasks_root.unwrap_or("tasks");
    let tasks = crate::tasks::resolve_tasks_root(&work, requested).map_err(|error| {
        action_error(
            "task_execution_tasks_root_invalid",
            Path::new(requested),
            &error,
            "choose a tasks directory inside this workspace",
        )
    })?;
    let metadata = fs::symlink_metadata(&tasks).map_err(|error| {
        action_error(
            "task_execution_tasks_root_missing",
            &tasks,
            &error.to_string(),
            "create the configured tasks directory and retry",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(action_error(
            "task_execution_tasks_root_invalid",
            &tasks,
            "expected a real directory",
            "choose a non-symlink tasks directory inside this workspace",
        ));
    }
    let tasks = tasks.canonicalize().map_err(|error| {
        action_error(
            "task_execution_tasks_root_invalid",
            &tasks,
            &error.to_string(),
            "repair the configured tasks directory and retry",
        )
    })?;
    if !tasks.starts_with(&work) {
        return Err(action_error(
            "task_execution_tasks_root_invalid",
            &tasks,
            "canonical path leaves workspace",
            "choose a tasks directory inside this workspace",
        ));
    }
    Ok(WorkspaceRoots {
        identity: display(&work),
        work,
        tasks,
    })
}

fn resolve_task_path(roots: &WorkspaceRoots, raw_path: &str) -> Result<PathBuf, String> {
    let path = resolve_inside_vault(&display(&roots.work), raw_path).map_err(|error| {
        action_error(
            "task_execution_path_invalid",
            Path::new(raw_path),
            &error,
            "refresh the task from its current workspace path",
        )
    })?;
    let metadata = fs::symlink_metadata(&path).map_err(|error| {
        action_error(
            "task_execution_task_missing",
            &path,
            &error.to_string(),
            "refresh the task list and retry with its current path",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(action_error(
            "task_execution_task_invalid",
            &path,
            "task path is not a regular file",
            "select a regular markdown task file",
        ));
    }
    if path.extension().and_then(|value| value.to_str()) != Some("md") {
        return Err(action_error(
            "task_execution_task_invalid",
            &path,
            "task path is not markdown",
            "select a markdown task file",
        ));
    }
    let canonical = path.canonicalize().map_err(|error| {
        action_error(
            "task_execution_task_invalid",
            &path,
            &error.to_string(),
            "repair the task path and retry",
        )
    })?;
    if !canonical.starts_with(&roots.tasks) {
        return Err(action_error(
            "task_execution_path_invalid",
            &path,
            "canonical task leaves tasks root",
            "select a task under the configured tasks root",
        ));
    }
    crate::tasks::bucket_from_task_path(&roots.tasks, &canonical).map_err(|error| {
        action_error(
            "task_execution_path_invalid",
            &canonical,
            &error,
            "select a task in an active, backlog, calendar or archive bucket",
        )
    })?;
    Ok(canonical)
}

fn task_snapshot(roots: &WorkspaceRoots, path: &Path) -> Result<TaskSnapshot, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        action_error(
            "task_execution_task_missing",
            path,
            &error.to_string(),
            "refresh the task and retry",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(action_error(
            "task_execution_task_invalid",
            path,
            "task leaf is not a regular file",
            "select a non-symlink markdown task",
        ));
    }
    if metadata.len() > MAX_TASK_BYTES {
        return Err(action_error(
            "task_execution_task_too_large",
            path,
            "task exceeds the execution claim size bound",
            "reduce the task file size before execution",
        ));
    }
    let content = fs::read_to_string(path).map_err(|error| {
        action_error(
            "task_execution_task_read_failed",
            path,
            &error.to_string(),
            "repair the task encoding or permissions and retry",
        )
    })?;
    let task_id = task_id_from_content(&content);
    if let Some(id) = task_id.as_deref() {
        if !valid_task_id(id) {
            return Err(action_error(
                "task_execution_id_invalid",
                path,
                "taskId contains unsupported characters",
                "repair the taskId frontmatter to use letters, digits, hyphens or underscores",
            ));
        }
    }
    let status = status_from_content(&content);
    let bucket = crate::tasks::bucket_from_task_path(&roots.tasks, path).ok();
    Ok(TaskSnapshot {
        path: path.to_path_buf(),
        revision: crate::document::revision_for(&content),
        content,
        task_id,
        status,
        archived: matches!(bucket, Some(crate::tasks::TaskBucket::Archive)),
    })
}

fn refuse_terminal(snapshot: &TaskSnapshot) -> Result<(), String> {
    if snapshot.archived || matches!(snapshot.status.as_deref(), Some("done" | "cancelled")) {
        return Err(action_error(
            "task_execution_task_terminal",
            &snapshot.path,
            "task is archived, done or cancelled",
            "reopen the task before requesting execution",
        ));
    }
    Ok(())
}

fn path_lock_key(path: &Path) -> String {
    let physical = path
        .canonicalize()
        .unwrap_or_else(|_| lexical_normalize(path));
    #[cfg(any(windows, target_os = "macos"))]
    let identity = display(&physical).to_lowercase();
    #[cfg(not(any(windows, target_os = "macos")))]
    let identity = display(&physical);
    hash_hex(identity.as_bytes())
}

fn claim_root(roots: &WorkspaceRoots) -> PathBuf {
    roots.work.join(CLAIM_DIR)
}

fn lock_root(roots: &WorkspaceRoots) -> PathBuf {
    roots.work.join(CLAIM_LOCK_DIR)
}

fn claim_path(roots: &WorkspaceRoots, task_id: &str) -> PathBuf {
    claim_root(roots).join(format!("{task_id}.json"))
}

fn task_lock_path(roots: &WorkspaceRoots, task_id: &str) -> PathBuf {
    lock_root(roots).join(format!("task-{task_id}.lock"))
}

fn bootstrap_lock_path(roots: &WorkspaceRoots, task_path: &Path) -> PathBuf {
    lock_root(roots).join(format!("path-{}.lock", path_lock_key(task_path)))
}

fn inspect_claim_directory(roots: &WorkspaceRoots) -> Result<(), String> {
    for path in [
        roots.work.join(".maru"),
        claim_root(roots),
        lock_root(roots),
    ] {
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
                return Err(action_error(
                    "task_execution_directory_invalid",
                    &path,
                    "claim path component is not a real directory",
                    "remove the symlink or file and retry",
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(action_error(
                    "task_execution_directory_invalid",
                    &path,
                    &error.to_string(),
                    "repair the workspace sidecar directory and retry",
                ))
            }
        }
    }
    Ok(())
}

fn ensure_claim_layout(roots: &WorkspaceRoots) -> Result<(), String> {
    inspect_claim_directory(roots)?;
    let lock_root = lock_root(roots);
    if lock_root.is_dir() {
        return Ok(());
    }
    assert_maru_can_write(&display(&roots.work), WorkspaceWriteAction::Create).map_err(
        |error| {
            action_error(
                "task_execution_write_refused",
                &lock_root,
                &error,
                "enable workspace writes and retry",
            )
        },
    )?;
    let request = PathTransactionRequest::new([claim_root(roots), lock_root.clone()])?;
    with_path_transactions(request, |lease| {
        inspect_claim_directory(roots)?;
        if !lock_root.exists() {
            lease.before_effect()?;
            fs::create_dir_all(&lock_root).map_err(|error| {
                action_error(
                    "task_execution_directory_create_failed",
                    &lock_root,
                    &error.to_string(),
                    "repair workspace permissions and retry",
                )
            })?;
        }
        Ok(())
    })
}

fn ensure_lock_file(roots: &WorkspaceRoots, path: &Path) -> Result<(), String> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(action_error(
                "task_execution_lock_invalid",
                path,
                "lock leaf is not a regular file",
                "remove the lock symlink/file and retry",
            ));
        }
        return Ok(());
    }
    assert_maru_can_write(&display(&roots.work), WorkspaceWriteAction::Create).map_err(
        |error| {
            action_error(
                "task_execution_write_refused",
                path,
                &error,
                "enable workspace writes and retry",
            )
        },
    )?;
    inspect_claim_directory(roots)?;
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(file) => drop(file),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let current = fs::symlink_metadata(path).map_err(|meta_error| {
                action_error(
                    "task_execution_lock_create_failed",
                    path,
                    &meta_error.to_string(),
                    "repair claim-lock permissions and retry",
                )
            })?;
            if current.file_type().is_symlink() || !current.is_file() {
                return Err(action_error(
                    "task_execution_lock_invalid",
                    path,
                    "concurrent lock creation produced a non-file",
                    "remove the invalid lock and retry",
                ));
            }
        }
        Err(error) => {
            return Err(action_error(
                "task_execution_lock_create_failed",
                path,
                &error.to_string(),
                "repair workspace permissions and retry",
            ))
        }
    }
    Ok(())
}

fn acquire_file_lock(roots: &WorkspaceRoots, path: &Path) -> Result<File, String> {
    ensure_lock_file(roots, path)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            action_error(
                "task_execution_lock_open_failed",
                path,
                &error.to_string(),
                "repair claim-lock permissions and retry",
            )
        })?;
    verify_lock_identity(&file, path).map_err(|error: String| {
        action_error(
            "task_execution_lock_changed",
            path,
            &error,
            "retry after restoring the claim lock",
        )
    })?;
    file.lock().map_err(|error| {
        action_error(
            "task_execution_lock_failed",
            path,
            &error.to_string(),
            "retry after the other task operation finishes",
        )
    })?;
    verify_lock_identity(&file, path).map_err(|error: String| {
        action_error(
            "task_execution_lock_changed",
            path,
            &error,
            "retry after restoring the claim lock",
        )
    })?;
    Ok(file)
}

fn read_claim(path: &Path, task_id: &str) -> Result<Option<TaskExecutionClaim>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(action_error(
                "task_execution_claim_read_failed",
                path,
                &error.to_string(),
                "repair claim storage and retry",
            ))
        }
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(action_error(
            "task_execution_claim_invalid",
            path,
            "claim leaf is not a regular file",
            "remove the claim symlink and review the task before retrying",
        ));
    }
    if metadata.len() > MAX_CLAIM_BYTES {
        return Err(action_error(
            "task_execution_claim_too_large",
            path,
            "claim exceeds its size bound",
            "review the task claim manually",
        ));
    }
    let bytes = fs::read(path).map_err(|error| {
        action_error(
            "task_execution_claim_read_failed",
            path,
            &error.to_string(),
            "repair claim storage and retry",
        )
    })?;
    let claim: TaskExecutionClaim = serde_json::from_slice(&bytes).map_err(|error| {
        action_error(
            "task_execution_claim_invalid",
            path,
            &error.to_string(),
            "review the claim file manually; do not delete an active claim",
        )
    })?;
    if claim.task_id != task_id || !valid_task_id(&claim.task_id) {
        return Err(action_error(
            "task_execution_claim_invalid",
            path,
            "claim taskId does not match its filename",
            "review the claim file manually",
        ));
    }
    Ok(Some(claim))
}

fn write_claim(
    roots: &WorkspaceRoots,
    lease: &PathTransactionLease,
    claim: &TaskExecutionClaim,
    lock: &File,
) -> Result<(), String> {
    let path = claim_path(roots, &claim.task_id);
    lease.ensure_covered([path.clone(), task_lock_path(roots, &claim.task_id)])?;
    let bytes = serde_json::to_vec(claim).map_err(|error| {
        action_error(
            "task_execution_claim_serialize_failed",
            &path,
            &error.to_string(),
            "retry after reviewing task metadata",
        )
    })?;
    if bytes.len() as u64 > MAX_CLAIM_BYTES {
        return Err(action_error(
            "task_execution_claim_too_large",
            &path,
            "claim exceeds its size bound",
            "review task metadata before retrying",
        ));
    }
    assert_maru_can_write(
        &display(&roots.work),
        if path.exists() {
            WorkspaceWriteAction::Modify
        } else {
            WorkspaceWriteAction::Create
        },
    )
    .map_err(|error| {
        action_error(
            "task_execution_write_refused",
            &path,
            &error,
            "enable workspace writes and retry",
        )
    })?;
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(action_error(
            "task_execution_claim_symlink_rejected",
            &path,
            "claim leaf is a symlink",
            "remove the symlink and review the task before retrying",
        ));
    }
    verify_lock_identity(lock, &task_lock_path(roots, &claim.task_id))?;
    crate::vault_guard::validate_managed_write(
        &display(&roots.work),
        &display(&path),
        &String::from_utf8_lossy(&bytes),
    )?;
    lease.before_effect()?;
    write_atomic_private(&path, &bytes).map_err(|error| {
        action_error(
            "task_execution_claim_write_failed",
            &path,
            &error,
            "retry after repairing claim storage",
        )
    })?;
    warn_parent_sync(&path);
    Ok(())
}

#[cfg(test)]
static SYNC_FAILURE_PARENT: std::sync::Mutex<Option<PathBuf>> = std::sync::Mutex::new(None);
#[cfg(test)]
static SYNC_FAILURES: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

fn warn_parent_sync(path: &Path) {
    if let Err(error) = sync_parent(path) {
        eprintln!("maru: task data was atomically written but directory sync failed: {error}; inspect storage health before restarting");
    }
}

fn sync_parent(path: &Path) -> Result<(), String> {
    #[cfg(test)]
    if SYNC_FAILURE_PARENT
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .as_deref()
        == path.parent()
    {
        SYNC_FAILURES.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        return Err("injected directory sync failure after atomic rename".into());
    }
    #[cfg(unix)]
    {
        let parent = path.parent().ok_or_else(|| {
            action_error(
                "task_execution_sync_failed",
                path,
                "parent directory is missing",
                "review task storage before retrying",
            )
        })?;
        File::open(parent)
            .and_then(|file| file.sync_all())
            .map_err(|error| {
                action_error(
                    "task_execution_sync_failed",
                    parent,
                    &error.to_string(),
                    "repair storage and review the claim before retrying",
                )
            })?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn transaction_request(
    roots: &WorkspaceRoots,
    task_path: &Path,
    claim_path: &Path,
    lock_paths: &[PathBuf],
) -> Result<PathTransactionRequest, String> {
    let mut paths = vec![task_path.to_path_buf(), claim_path.to_path_buf()];
    paths.extend(lock_paths.iter().cloned());
    let mut request = PathTransactionRequest::new(paths)?;
    let task_parent = task_path.parent().unwrap_or(roots.tasks.as_path());
    for parent in [roots.work.as_path(), roots.tasks.as_path(), task_parent] {
        request = request.require_parent_snapshot(&PathTransactionParent::capture(parent)?)?;
    }
    Ok(request)
}

fn relative_task_path(roots: &WorkspaceRoots, path: &Path) -> Result<String, String> {
    let relative = path.strip_prefix(&roots.work).map_err(|_| {
        action_error(
            "task_execution_path_invalid",
            path,
            "task is outside workspace",
            "select a task inside the workspace",
        )
    })?;
    Ok(relative.to_string_lossy().replace('\\', "/"))
}

fn request_path_key(roots: &WorkspaceRoots, raw_path: &str) -> Result<String, String> {
    let lexical = resolve_inside_vault(&display(&roots.work), raw_path).map_err(|error| {
        action_error(
            "task_execution_path_invalid",
            Path::new(raw_path),
            &error,
            "refresh the task from its current workspace path",
        )
    })?;
    let normalized = lexical
        .canonicalize()
        .unwrap_or_else(|_| lexical_normalize(&lexical));
    relative_task_path(roots, &normalized)
}

fn resolve_claim_tasks_root(
    roots: &WorkspaceRoots,
    claim: &TaskExecutionClaim,
) -> Result<PathBuf, String> {
    let root = crate::tasks::resolve_tasks_root(&roots.work, &claim.tasks_root)?;
    let metadata = fs::symlink_metadata(&root).map_err(|error| {
        action_error(
            "task_execution_tasks_root_invalid",
            &root,
            &error.to_string(),
            "restore the configured tasks root and retry",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(action_error(
            "task_execution_tasks_root_invalid",
            &root,
            "tasks root is not a real directory",
            "restore a non-symlink tasks root",
        ));
    }
    let root = root.canonicalize().map_err(|error| {
        action_error(
            "task_execution_tasks_root_invalid",
            &root,
            &error.to_string(),
            "repair the tasks root and retry",
        )
    })?;
    if !root.starts_with(&roots.work) || display(&root) != claim.tasks_root {
        return Err(action_error(
            "task_execution_tasks_root_invalid",
            &root,
            "recorded tasks root changed",
            "review the task claim and rebind it through the task move operation",
        ));
    }
    Ok(root)
}

fn snapshot_from_claim(
    roots: &WorkspaceRoots,
    claim: &TaskExecutionClaim,
) -> Result<TaskSnapshot, String> {
    let task_roots = resolve_claim_tasks_root(roots, claim)?;
    let recorded = resolve_task_path(roots, &claim.task_path);
    if let Ok(path) = recorded {
        if path.starts_with(&task_roots) {
            if let Ok(snapshot) = task_snapshot(roots, &path) {
                if snapshot.task_id.as_deref() == Some(claim.task_id.as_str()) {
                    let unique = find_task_by_id(roots, &task_roots, &claim.task_id)?;
                    if unique.path != snapshot.path {
                        return Err(action_error(
                            "task_execution_duplicate_id",
                            &snapshot.path,
                            "taskId resolves to a different or duplicate path",
                            "review duplicate task identities before retrying",
                        ));
                    }
                    return Ok(snapshot);
                }
                if snapshot.task_id.is_none()
                    && snapshot.revision == claim.receipt.job_revision
                    && task_note_with_id(&snapshot, &claim.task_id).is_ok_and(|content| {
                        crate::document::revision_for(&content) == claim.source_revision
                    })
                {
                    return Ok(snapshot);
                }
            }
        }
    }
    find_task_by_id(roots, &task_roots, &claim.task_id)
}

fn find_task_by_id(
    roots: &WorkspaceRoots,
    tasks_root: &Path,
    task_id: &str,
) -> Result<TaskSnapshot, String> {
    let mut found = None;
    let mut visited = 0usize;
    for entry in WalkDir::new(tasks_root).follow_links(false).into_iter() {
        let entry = entry.map_err(|error| {
            action_error(
                "task_execution_recovery_scan_failed",
                tasks_root,
                &error.to_string(),
                "repair task directory permissions and retry",
            )
        })?;
        visited += 1;
        if visited > MAX_TASK_FILES {
            return Err(action_error(
                "task_execution_recovery_scan_bounded",
                tasks_root,
                "task scan exceeded its entry limit",
                "narrow the tasks root or review the claim manually",
            ));
        }
        if !entry.file_type().is_file()
            || entry.path().extension().and_then(|value| value.to_str()) != Some("md")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|error| {
            action_error(
                "task_execution_recovery_scan_failed",
                entry.path(),
                &error.to_string(),
                "shorten the task filename or repair storage permissions, then refresh and retry",
            )
        })?;
        if metadata.file_type().is_symlink() || metadata.len() > MAX_TASK_BYTES {
            continue;
        }
        let path = entry.path().canonicalize().map_err(|error| {
            action_error(
                "task_execution_recovery_scan_failed",
                entry.path(),
                &error.to_string(),
                "repair the task path and retry",
            )
        })?;
        if !path.starts_with(tasks_root) {
            continue;
        }
        let snapshot = task_snapshot(roots, &path)?;
        if snapshot.task_id.as_deref() == Some(task_id) {
            if found.is_some() {
                return Err(action_error(
                    "task_execution_duplicate_id",
                    &path,
                    "multiple task files share this taskId",
                    "resolve the duplicate taskId before execution",
                ));
            }
            found = Some(snapshot);
        }
    }
    found.ok_or_else(|| {
        action_error(
            "task_execution_task_missing",
            tasks_root,
            "no task with this taskId was found",
            "restore or explicitly rebind the task before retrying",
        )
    })
}

/// Recover a still-owned path even when a manual edit removed its frontmatter ID.
/// Ordinary editing may ignore unrelated malformed receipts; fresh admission is
/// strict and cannot use a missing/changed ID to evade an existing live claim.
fn unfinished_claim_at_path(
    roots: &WorkspaceRoots,
    path: &Path,
    strict: bool,
) -> Result<Option<TaskExecutionClaim>, String> {
    let dir = claim_root(roots);
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(action_error(
                "task_execution_claim_scan_failed",
                &dir,
                &error.to_string(),
                "repair task claim storage and retry",
            ))
        }
    };
    let key = request_path_key(roots, &display(path))?;
    let mut found: Option<TaskExecutionClaim> = None;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_CLAIM_FILES {
            if !strict {
                return Ok(None);
            }
            return Err(action_error(
                "task_execution_claim_scan_bounded",
                &dir,
                "claim directory exceeded its entry limit",
                "review stale claims before retrying",
            ));
        }
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) if !strict => continue,
            Err(error) => {
                return Err(action_error(
                    "task_execution_claim_scan_failed",
                    &dir,
                    &error.to_string(),
                    "repair task claim storage and retry",
                ))
            }
        };
        let candidate = entry.path();
        if candidate.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = candidate
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|id| valid_task_id(id))
        else {
            continue;
        };
        let claim = match read_claim(&candidate, id) {
            Ok(Some(claim)) => claim,
            Ok(None) => continue,
            Err(_) if !strict => continue,
            Err(error) => return Err(error),
        };
        if claim.workspace != roots.identity
            || !matches!(
                claim.lifecycle,
                TaskExecutionLifecycle::Active | TaskExecutionLifecycle::NeedsReview
            )
        {
            continue;
        }
        let recorded = match request_path_key(roots, &claim.task_path) {
            Ok(recorded) => recorded,
            Err(_) if !strict => continue,
            Err(error) => return Err(error),
        };
        if recorded == key {
            if found.is_some() {
                return Err(action_error(
                    "task_execution_path_ambiguous",
                    path,
                    "multiple unfinished claims name this task path",
                    "review the claims before starting or editing this task",
                ));
            }
            found = Some(claim);
        }
    }
    Ok(found)
}

fn recorded_request_at_path(
    roots: &WorkspaceRoots,
    request: &TaskExecutionRequest,
    path: &str,
) -> Result<Option<TaskExecutionClaim>, String> {
    let mut found: Option<TaskExecutionClaim> = None;
    let entries = fs::read_dir(claim_root(roots)).map_err(|error| {
        action_error(
            "task_execution_claim_scan_failed",
            &claim_root(roots),
            &error.to_string(),
            "repair claim storage and retry",
        )
    })?;
    for (index, entry) in entries.enumerate() {
        if index >= MAX_CLAIM_FILES {
            return Err(action_error(
                "task_execution_claim_scan_bounded",
                &claim_root(roots),
                "too many claims for path recovery",
                "restore the taskId and retry",
            ));
        }
        let file = entry
            .map_err(|error| {
                action_error(
                    "task_execution_claim_scan_failed",
                    &claim_root(roots),
                    &error.to_string(),
                    "repair claim storage and retry",
                )
            })?
            .path();
        if file.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = file
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|id| valid_task_id(id))
        else {
            continue;
        };
        let Some(claim) = read_claim(&file, id)? else {
            continue;
        };
        if claim.workspace != roots.identity || claim.tasks_root != display(&roots.tasks) {
            continue;
        }
        let record = if claim.request_id == request.request_id {
            Some(claim.clone())
        } else {
            claim
                .request_history
                .iter()
                .find(|row| row.request_id == request.request_id)
                .map(|row| claim.historical(row))
        };
        let Some(record) = record else {
            continue;
        };
        if record.request_path != path && record.task_path != path && claim.task_path != path {
            continue;
        }
        if record.receipt.job_revision != request.source_revision {
            return Err(action_error(
                "task_execution_request_conflict",
                &file,
                "this task request used another source revision",
                "use a new requestId for this task",
            ));
        }
        if found
            .as_ref()
            .is_some_and(|prior| prior.task_id != claim.task_id)
        {
            return Err(action_error(
                "task_execution_path_ambiguous",
                &file,
                "several task identities match this missing path",
                "restore the original taskId before replaying",
            ));
        }
        found = Some(claim);
    }
    Ok(found)
}

fn validate_task_request(
    claim: &TaskExecutionClaim,
    request: &TaskExecutionRequest,
) -> Result<(), String> {
    let revision = if claim.request_id == request.request_id {
        Some(&claim.receipt.job_revision)
    } else {
        claim
            .request_history
            .iter()
            .find(|row| row.request_id == request.request_id)
            .map(|row| &row.receipt.job_revision)
    };
    if revision.is_some_and(|value| value != &request.source_revision) {
        return Err("task_execution_request_conflict: this task request used another source revision; use a new requestId for this task".into());
    }
    Ok(())
}

fn ensure_request(request: &TaskExecutionRequest, run_id: &str) -> Result<(), String> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || request
            .request_id
            .bytes()
            .any(|byte| !byte.is_ascii_alphanumeric() && !matches!(byte, b'-' | b'_'))
        || request.source_revision.is_empty()
        || request.source_revision.len() > 256
        || request.task_path.trim().is_empty()
        || run_id.trim().is_empty()
        || run_id.len() > 128
    {
        return Err("task_execution_request_invalid: requestId, taskPath, sourceRevision and runId must be bounded and nonempty; refresh the task and retry".into());
    }
    Ok(())
}

fn token_matches(claim: &TaskExecutionClaim, token: &TaskExecutionToken) -> bool {
    claim.task_id == token.task_id
        && claim.request_id == token.request_id
        && claim.run_id == token.run_id
        && claim.generation == token.generation
}

fn task_is_current(claim: &TaskExecutionClaim, snapshot: &TaskSnapshot) -> Result<(), String> {
    if snapshot.task_id.as_deref() != Some(claim.task_id.as_str()) {
        return Err(action_error(
            "task_execution_identity_changed",
            &snapshot.path,
            "taskId no longer matches the claim",
            "review and rebind the task identity before retrying",
        ));
    }
    if snapshot.revision != claim.source_revision {
        return Err(action_error(
            "task_execution_source_changed",
            &snapshot.path,
            "task bytes differ from the claimed revision",
            "review the current task and start a new execution from its current revision",
        ));
    }
    refuse_terminal(snapshot)
}

fn rebind_claim_path(
    roots: &WorkspaceRoots,
    claim: &mut TaskExecutionClaim,
    snapshot: &TaskSnapshot,
) -> Result<bool, String> {
    let path = relative_task_path(roots, &snapshot.path)?;
    if claim.task_path == path {
        return Ok(false);
    }
    claim.task_path = path;
    Ok(true)
}

fn ownership_proves_stopped(
    owner: ProcessOwnership,
    child: Option<ProcessOwnership>,
    child_reaped: bool,
    never_spawned: bool,
) -> bool {
    owner == ProcessOwnership::Dead
        && match child {
            Some(ProcessOwnership::Dead) => true,
            Some(ProcessOwnership::Live | ProcessOwnership::Unverified) => false,
            None => child_reaped || never_spawned,
        }
}

fn task_note_with_id(snapshot: &TaskSnapshot, task_id: &str) -> Result<String, String> {
    update_frontmatter_content(
        &snapshot.content,
        "taskId",
        Some(FrontmatterValue::String(task_id.to_string())),
    )
    .map_err(|error| {
        action_error(
            "task_execution_identity_write_invalid",
            &snapshot.path,
            &error,
            "repair task frontmatter and retry",
        )
    })
}

fn write_task_note(
    roots: &WorkspaceRoots,
    lease: &PathTransactionLease,
    path: &Path,
    content: &str,
) -> Result<(), String> {
    lease.ensure_covered([path.to_path_buf()])?;
    assert_maru_can_write(&display(&roots.work), WorkspaceWriteAction::Modify).map_err(
        |error| {
            action_error(
                "task_execution_write_refused",
                path,
                &error,
                "enable workspace writes and retry",
            )
        },
    )?;
    crate::vault_guard::validate_managed_write(&display(&roots.work), &display(path), content)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        action_error(
            "task_execution_task_changed",
            path,
            &error.to_string(),
            "refresh the task and retry",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(action_error(
            "task_execution_task_symlink_rejected",
            path,
            "task leaf changed to a symlink or non-file",
            "restore a regular task file and retry",
        ));
    }
    lease.before_effect()?;
    write_atomic(path, content.as_bytes()).map_err(|error| {
        action_error(
            "task_execution_identity_write_failed",
            path,
            &error,
            "repair task permissions and retry",
        )
    })?;
    warn_parent_sync(path);
    Ok(())
}

fn task_id_candidate() -> String {
    format!("task-{}", Uuid::new_v4())
}

fn path_transaction_for_claim(
    roots: &WorkspaceRoots,
    task_path: &Path,
    task_id: &str,
    extra_locks: &[PathBuf],
) -> Result<PathTransactionRequest, String> {
    let claim_path = claim_path(roots, task_id);
    let mut lock_paths = vec![task_lock_path(roots, task_id)];
    lock_paths.extend(extra_locks.iter().cloned());
    let mut request = transaction_request(roots, task_path, &claim_path, &lock_paths)?;
    request =
        request.require_parent_snapshot(&PathTransactionParent::capture(&claim_root(roots))?)?;
    request =
        request.require_parent_snapshot(&PathTransactionParent::capture(&lock_root(roots))?)?;
    Ok(request)
}

fn validate_claim_token(
    claim: &TaskExecutionClaim,
    token: &TaskExecutionToken,
) -> Result<(), String> {
    if !token_matches(claim, token) {
        return Err(format!("task_execution_token_stale: taskId={} requestId={} generation={}; refresh the active task execution", token.task_id, token.request_id, token.generation));
    }
    Ok(())
}

fn open_existing_claim_lock(path: &Path) -> Result<File, String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        action_error(
            "task_execution_lock_missing",
            path,
            &error.to_string(),
            "restore the original claim lock before retrying",
        )
    })?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(action_error(
            "task_execution_lock_invalid",
            path,
            "lock is not a regular file",
            "restore the original claim lock before retrying",
        ));
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|error| {
            action_error(
                "task_execution_lock_failed",
                path,
                &error.to_string(),
                "repair claim lock permissions and retry",
            )
        })?;
    verify_lock_identity(&file, path)?;
    file.lock().map_err(|error| {
        action_error(
            "task_execution_lock_failed",
            path,
            &error.to_string(),
            "retry after the current claim operation settles",
        )
    })?;
    verify_lock_identity(&file, path)?;
    Ok(file)
}

fn with_claim_identity<T>(
    work: &Path,
    token: &TaskExecutionToken,
    operation: impl FnOnce(
        &WorkspaceRoots,
        &mut TaskExecutionClaim,
        &PathTransactionLease,
        &File,
    ) -> Result<T, String>,
) -> Result<T, String> {
    if !valid_task_id(&token.task_id) {
        return Err(
            "task_execution_id_invalid: unsupported taskId; refresh the recorded task identity"
                .into(),
        );
    }
    let work = normalize_existing_dir(&display(work))?;
    let roots = WorkspaceRoots {
        work: work.clone(),
        tasks: work.clone(),
        identity: display(&work),
    };
    inspect_claim_directory(&roots)?;
    let file = claim_path(&roots, &token.task_id);
    let lock_path = task_lock_path(&roots, &token.task_id);
    let lock = open_existing_claim_lock(&lock_path)?;
    let request = PathTransactionRequest::new([file.clone(), lock_path.clone()])?
        .require_parent(&work)?
        .require_parent(&claim_root(&roots))?
        .require_parent(&lock_root(&roots))?;
    with_path_transactions(request, |lease| {
        verify_lock_identity(&lock, &lock_path)?;
        let mut claim = read_claim(&file, &token.task_id)?.ok_or_else(|| {
            action_error(
                "task_execution_claim_missing",
                &file,
                "recorded claim is missing",
                "refresh mission history before retrying",
            )
        })?;
        if claim.workspace != roots.identity {
            return Err(action_error(
                "task_execution_workspace_mismatch",
                &file,
                "claim belongs to another workspace",
                "open the original workspace and retry",
            ));
        }
        validate_claim_token(&claim, token)?;
        operation(&roots, &mut claim, lease, &lock)
    })
}

fn claim_task_context(
    work: &Path,
    task_id: &str,
) -> Result<(WorkspaceRoots, TaskExecutionClaim), String> {
    if !valid_task_id(task_id) {
        return Err(format!("task_execution_id_invalid: taskId={task_id}; refresh the task identity before retrying"));
    }
    let work = normalize_existing_dir(&display(work)).map_err(|error| {
        action_error(
            "task_execution_workspace_invalid",
            work,
            &error,
            "open the registered workspace and retry",
        )
    })?;
    let provisional = WorkspaceRoots {
        work: work.clone(),
        tasks: work.join("tasks"),
        identity: display(&work),
    };
    inspect_claim_directory(&provisional)?;
    let path = claim_path(&provisional, task_id);
    let claim = read_claim(&path, task_id)?.ok_or_else(|| {
        action_error(
            "task_execution_claim_missing",
            &path,
            "claim file does not exist",
            "refresh the task execution state before retrying",
        )
    })?;
    if claim.workspace != display(&work) {
        return Err(action_error(
            "task_execution_workspace_mismatch",
            &path,
            "claim belongs to another workspace identity",
            "open the original workspace and retry",
        ));
    }
    let roots = workspace_roots(&work, Some(&claim.tasks_root))?;
    Ok((roots, claim))
}

fn with_claim_operation<T>(
    work: &Path,
    task_id: &str,
    operation: impl FnOnce(
        &WorkspaceRoots,
        &mut TaskExecutionClaim,
        &TaskSnapshot,
        &PathTransactionLease,
        &File,
    ) -> Result<T, String>,
) -> Result<T, String> {
    let (roots, initial) = claim_task_context(work, task_id)?;
    ensure_claim_layout(&roots)?;
    let lock_path = task_lock_path(&roots, task_id);
    let lock = acquire_file_lock(&roots, &lock_path)?;
    let initial_snapshot = snapshot_from_claim(&roots, &initial)?;
    let claim_path = claim_path(&roots, task_id);
    let mut request = path_transaction_for_claim(&roots, &initial_snapshot.path, task_id, &[])?;
    request = request.require_parent_snapshot(&PathTransactionParent::capture(
        &initial_snapshot.path.parent().unwrap_or(&roots.tasks),
    )?)?;
    with_path_transactions(request, |lease| {
        verify_lock_identity(&lock, &lock_path)?;
        let mut claim = read_claim(&claim_path, task_id)?.ok_or_else(|| {
            action_error(
                "task_execution_claim_missing",
                &claim_path,
                "claim was removed",
                "refresh the task execution state and retry",
            )
        })?;
        if claim.workspace != roots.identity || claim.tasks_root != display(&roots.tasks) {
            return Err(action_error(
                "task_execution_claim_invalid",
                &claim_path,
                "claim workspace or tasks root changed",
                "review the claim before retrying",
            ));
        }
        let snapshot = snapshot_from_claim(&roots, &claim)?;
        if snapshot.path != initial_snapshot.path {
            return Err(action_error(
                "task_execution_path_changed",
                &snapshot.path,
                "task moved while the claim was being admitted",
                "refresh the task path and retry",
            ));
        }
        operation(&roots, &mut claim, &snapshot, lease, &lock)
    })
}

fn new_receipt(request: &TaskExecutionRequest, run_id: &str) -> JobRunReceipt {
    let now = now_seconds();
    JobRunReceipt {
        request_id: request.request_id.clone(),
        run_id: run_id.to_string(),
        source: "taskExecution".into(),
        job_revision: request.source_revision.clone(),
        scheduled_fire_at: None,
        admitted_at: now,
        started_at: Some(now),
        finished_at: None,
        process_outcome: "running".into(),
        exit_code: None,
        verification_outcome: "notRequested".into(),
        ledger_recorded: false,
        coalesced_into: None,
        owner: identity(std::process::id()),
        child: None,
    }
}

fn active_claim_for_other_request(
    roots: &WorkspaceRoots,
    lease: &PathTransactionLease,
    lock: &File,
    claim: &mut TaskExecutionClaim,
    snapshot: &TaskSnapshot,
) -> Result<(), String> {
    if claim.lifecycle != TaskExecutionLifecycle::Active {
        if claim.lifecycle == TaskExecutionLifecycle::NeedsReview {
            return Err(action_error(
                "task_execution_needs_review",
                &snapshot.path,
                "previous execution requires human review",
                "review native ownership and invoke stop_ai_mission for the recorded run before retrying",
            ));
        }
        return Ok(());
    }
    let owner = claim
        .receipt
        .owner
        .as_ref()
        .map(process_ownership)
        .unwrap_or(ProcessOwnership::Unverified);
    let child = claim.receipt.child.as_ref().map(process_ownership);
    if !ownership_proves_stopped(owner, child, claim.child_reaped, !claim.spawn_attempted) {
        return Err(action_error("task_execution_claim_held_for_review", &snapshot.path, "owner or child is live or unverified; an exited but unreaped process may remain unverified", "retry after the original launcher exits, or restart Maru and review ownership; elapsed time never releases a claim"));
    }
    if let Err(error) = task_is_current(claim, snapshot) {
        claim.lifecycle = TaskExecutionLifecycle::NeedsReview;
        claim.receipt.process_outcome = "interrupted".into();
        claim.receipt.finished_at = Some(now_seconds());
        write_claim(roots, lease, claim, lock)?;
        return Err(error);
    }
    claim.lifecycle = TaskExecutionLifecycle::Reconciled;
    claim.receipt.process_outcome = "interrupted".into();
    claim.receipt.finished_at = Some(now_seconds());
    write_claim(roots, lease, claim, lock)
}

/// Coordination guard for the existing managed Markdown mutation wrappers.
/// A note without an active task claim receives only the path bootstrap lock;
/// no taskId or claim is written for an ordinary note.
pub(crate) fn guard_task_mutation(
    work: &Path,
    source: &Path,
) -> Result<Option<TaskMutationGuard>, String> {
    let work = normalize_existing_dir(&display(work))?;
    let roots = WorkspaceRoots {
        work: work.clone(),
        tasks: work.clone(),
        identity: display(&work),
    };
    // Ordinary mutations never create or repair claim infrastructure, and
    // never read a foreign namespace through a symlink.
    for dir in [work.join(".maru"), claim_root(&roots)] {
        if !fs::symlink_metadata(&dir)
            .is_ok_and(|metadata| metadata.is_dir() && !metadata.file_type().is_symlink())
        {
            return Ok(None);
        }
    }
    let source = resolve_inside_vault(&display(&work), &display(source))?;
    if source.extension().and_then(|value| value.to_str()) != Some("md")
        || !fs::symlink_metadata(&source)
            .is_ok_and(|metadata| metadata.is_file() && !metadata.file_type().is_symlink())
    {
        return Ok(None);
    }
    let path = source.canonicalize().map_err(|error| {
        action_error(
            "task_execution_path_invalid",
            &source,
            &error.to_string(),
            "refresh the task path and retry",
        )
    })?;
    let Some(id) = task_id_from_path_bounded(&path).filter(|id| valid_task_id(id)) else {
        return Ok(None);
    };
    let Some(claim) = read_claim(&claim_path(&roots, &id), &id)? else {
        return Ok(None);
    };
    if claim.workspace != roots.identity {
        return Err(action_error(
            "task_execution_workspace_mismatch",
            &path,
            "claim belongs to another workspace",
            "open the original workspace and retry",
        ));
    }
    let task_lock_path = task_lock_path(&roots, &claim.task_id);
    let task_lock = open_existing_claim_lock(&task_lock_path)?;
    let file = claim_path(&roots, &claim.task_id);
    let current = read_claim(&file, &claim.task_id)?.ok_or_else(|| {
        action_error(
            "task_execution_claim_missing",
            &file,
            "claim disappeared while locking",
            "refresh the task and retry",
        )
    })?;
    Ok(Some(TaskMutationGuard {
        work,
        claim: current,
        claim_path: file,
        task_lock_path,
        task_lock,
    }))
}

/// Acquire or replay the single active task claim. No timer can take over an
/// active/uncertain owner; only an exact request replay, explicit release or
/// verified-dead reconciliation can advance it.
pub(crate) fn acquire(
    work: &Path,
    request: &TaskExecutionRequest,
    run_id: &str,
) -> Result<Admission, String> {
    ensure_request(request, run_id)?;
    let roots = workspace_roots(work, request.tasks_root.as_deref())?;
    ensure_claim_layout(&roots)?;

    let request_path = request_path_key(&roots, &request.task_path)?;
    let requested_path = lexical_normalize(&roots.work.join(&request_path));
    if requested_path.extension().and_then(|value| value.to_str()) != Some("md") {
        return Err(action_error(
            "task_execution_task_invalid",
            &requested_path,
            "task path is not markdown",
            "select a markdown task file",
        ));
    }
    let bootstrap_path = bootstrap_lock_path(&roots, &requested_path);
    let bootstrap_lock = acquire_file_lock(&roots, &bootstrap_path)?;

    let pending = match task_id_from_path_bounded(&requested_path).filter(|id| valid_task_id(id)) {
        Some(id) => read_claim(&claim_path(&roots, &id), &id)?.filter(|claim| {
            claim.workspace == roots.identity && claim.tasks_root == display(&roots.tasks)
        }),
        None => recorded_request_at_path(&roots, request, &request_path)?,
    };
    let pending = pending.filter(|claim| {
        claim.request_id == request.request_id
            || claim
                .request_history
                .iter()
                .any(|row| row.request_id == request.request_id)
    });
    if let Some(recorded) = &pending {
        validate_task_request(recorded, request)?;
        let id = &recorded.task_id;
        let replay_lock_path = task_lock_path(&roots, id);
        let replay_lock = acquire_file_lock(&roots, &replay_lock_path)?;
        let file = claim_path(&roots, id);
        let admission = PathTransactionRequest::new([
            file.clone(),
            replay_lock_path.clone(),
            bootstrap_path.clone(),
        ])?
        .require_parent(&roots.work)?;
        return with_path_transactions(admission, |_lease| {
            verify_lock_identity(&bootstrap_lock, &bootstrap_path)?;
            verify_lock_identity(&replay_lock, &replay_lock_path)?;
            let current = read_claim(&file, id)?.ok_or_else(|| {
                action_error(
                    "task_execution_claim_missing",
                    &file,
                    "recorded request disappeared",
                    "refresh task execution history before retrying",
                )
            })?;
            if current.workspace != roots.identity || current.tasks_root != display(&roots.tasks) {
                return Err(action_error(
                    "task_execution_workspace_mismatch",
                    &file,
                    "replay receipt belongs to a different workspace or task root",
                    "open the original workspace and retry the recorded request",
                ));
            }
            let matching = if current.request_id == request.request_id
                && current.receipt.job_revision == request.source_revision
            {
                Some(current.clone())
            } else {
                current
                    .request_history
                    .iter()
                    .find(|row| {
                        row.request_id == request.request_id
                            && row.receipt.job_revision == request.source_revision
                    })
                    .map(|row| current.historical(row))
            };
            matching
                .map(|claim| Admission {
                    claim,
                    replayed: true,
                })
                .ok_or_else(|| {
                    action_error(
                        "task_execution_request_conflict",
                        &file,
                        "request history changed while replaying",
                        "refresh the recorded run before retrying",
                    )
                })
        });
    }
    if requested_path.exists() {
        if let Some(owned) = unfinished_claim_at_path(&roots, &requested_path, true)? {
            let current = task_id_from_path_bounded(&requested_path);
            if current.as_deref() != Some(owned.task_id.as_str()) {
                return Err(action_error("task_execution_identity_changed", &requested_path, "an unfinished execution still owns this path after its taskId changed", "restore the original taskId, then review and release that run with stop_ai_mission before requesting a new identity"));
            }
        }
    }
    let path = resolve_task_path(&roots, &request.task_path)?;
    let initial_snapshot = task_snapshot(&roots, &path)?;
    if requested_path.exists() {
        let requested_current = resolve_task_path(&roots, &display(&requested_path))?;
        if requested_current != initial_snapshot.path {
            return Err(action_error(
                "task_execution_request_path_mismatch",
                &requested_current,
                "request path now refers to a different task than its durable claim",
                "refresh the task list and use a new requestId for the current file",
            ));
        }
    }
    let task_id = initial_snapshot
        .task_id
        .clone()
        .unwrap_or_else(task_id_candidate);
    if !valid_task_id(&task_id) {
        return Err(action_error(
            "task_execution_id_invalid",
            &initial_snapshot.path,
            "taskId is invalid",
            "repair taskId frontmatter before execution",
        ));
    }
    if initial_snapshot
        .task_id
        .as_deref()
        .is_some_and(|existing| existing != task_id)
    {
        return Err(action_error(
            "task_execution_identity_changed",
            &initial_snapshot.path,
            "taskId changed while selecting a claim lock",
            "refresh the task identity and retry",
        ));
    }
    let lock_path = task_lock_path(&roots, &task_id);
    let task_lock = acquire_file_lock(&roots, &lock_path)?;
    let claim_file = claim_path(&roots, &task_id);
    let request_paths = [bootstrap_path.clone()];
    let mut path_request =
        path_transaction_for_claim(&roots, &initial_snapshot.path, &task_id, &request_paths)?;
    path_request = path_request.require_parent_snapshot(&PathTransactionParent::capture(
        &initial_snapshot.path.parent().unwrap_or(&roots.tasks),
    )?)?;

    with_path_transactions(path_request, |lease| {
        verify_lock_identity(&bootstrap_lock, &bootstrap_path)?;
        verify_lock_identity(&task_lock, &lock_path)?;
        let snapshot = task_snapshot(&roots, &initial_snapshot.path)?;
        if requested_path.exists() {
            let requested_current = resolve_task_path(&roots, &display(&requested_path))?;
            if requested_current != snapshot.path {
                return Err(action_error(
                    "task_execution_request_path_mismatch",
                    &requested_current,
                    "request path changed during claim admission",
                    "refresh the task list and retry with a new requestId",
                ));
            }
        }
        if snapshot
            .task_id
            .as_deref()
            .is_some_and(|existing| existing != task_id)
        {
            return Err(action_error(
                "task_execution_identity_changed",
                &snapshot.path,
                "taskId changed before claim admission",
                "refresh the task and retry",
            ));
        }
        if snapshot.task_id.as_deref() == Some(task_id.as_str()) {
            let unique = find_task_by_id(&roots, &roots.tasks, &task_id)?;
            if unique.path != snapshot.path {
                return Err(action_error(
                    "task_execution_duplicate_id",
                    &snapshot.path,
                    "multiple task files share this taskId",
                    "resolve the duplicate task identity before execution",
                ));
            }
        }
        let mut previous = read_claim(&claim_file, &task_id)?;
        if let Some(existing) = previous.as_mut() {
            if existing.workspace != roots.identity || existing.tasks_root != display(&roots.tasks)
            {
                return Err(action_error(
                    "task_execution_claim_invalid",
                    &claim_file,
                    "claim workspace identity does not match",
                    "review the claim before retrying",
                ));
            }
            if let Some(record) = existing
                .request_history
                .iter()
                .find(|record| record.request_id == request.request_id)
            {
                if record.receipt.job_revision != request.source_revision {
                    return Err(action_error(
                        "task_execution_request_conflict",
                        &snapshot.path,
                        "requestId was already used with another source revision",
                        "refresh the task and use a new requestId",
                    ));
                }
                return Ok(Admission {
                    claim: existing.historical(record),
                    replayed: true,
                });
            }
            if existing.request_id == request.request_id
                && existing.receipt.job_revision == request.source_revision
            {
                // Exact replays return a recorded run; they never resume a
                // worker or adopt its result, even if the note changed later.
                return Ok(Admission {
                    claim: existing.clone(),
                    replayed: true,
                });
            }
            if existing.request_id == request.request_id {
                return Err(action_error(
                    "task_execution_request_conflict",
                    &snapshot.path,
                    "requestId was already used with another source revision",
                    "refresh the task and use a new requestId",
                ));
            }
            if existing.lifecycle == TaskExecutionLifecycle::NeedsReview {
                return Err(action_error(
                    "task_execution_needs_review",
                    &snapshot.path,
                    "previous execution requires human review",
                    "review native ownership and invoke stop_ai_mission for the recorded run before retrying",
                ));
            }
            if existing.lifecycle == TaskExecutionLifecycle::Active {
                active_claim_for_other_request(&roots, lease, &task_lock, existing, &snapshot)?;
            }
        } else if snapshot.revision != request.source_revision {
            return Err(action_error(
                "task_execution_source_changed",
                &snapshot.path,
                "task bytes differ from the requested source revision",
                "refresh the task and submit the current sourceRevision",
            ));
        }

        refuse_terminal(&snapshot)?;
        let updated_content = if snapshot.task_id.is_none() {
            Some(task_note_with_id(&snapshot, &task_id)?)
        } else {
            None
        };
        if let Some(content) = updated_content.as_deref() {
            crate::vault_guard::validate_managed_write(
                &display(&roots.work),
                &display(&snapshot.path),
                content,
            )?;
        } else if snapshot.revision != request.source_revision {
            return Err(action_error(
                "task_execution_source_changed",
                &snapshot.path,
                "task bytes differ from the requested source revision",
                "refresh the task and submit the current sourceRevision",
            ));
        }
        let committed_revision = updated_content
            .as_deref()
            .map(crate::document::revision_for)
            .unwrap_or_else(|| snapshot.revision.clone());
        let generation = previous
            .as_ref()
            .map_or(1, |claim| claim.generation.saturating_add(1));
        let mut request_history = previous
            .as_ref()
            .map(|claim| claim.request_history.clone())
            .unwrap_or_default();
        if let Some(previous_claim) = previous.as_ref() {
            if request_history.len() >= REQUEST_HISTORY_LIMIT {
                return Err(action_error(
                    "task_execution_request_history_full",
                    &snapshot.path,
                    "the replay-protection history reached its bound",
                    "archive or review this task claim before starting another execution",
                ));
            }
            request_history.push(TaskExecutionRequestRecord::from_claim(previous_claim));
        }
        let claim = TaskExecutionClaim {
            workspace: roots.identity.clone(),
            task_id: task_id.clone(),
            request_id: request.request_id.clone(),
            run_id: run_id.to_string(),
            task_path: relative_task_path(&roots, &snapshot.path)?,
            request_path: request_path.clone(),
            tasks_root: display(&roots.tasks),
            source_revision: committed_revision,
            generation,
            lifecycle: TaskExecutionLifecycle::Active,
            receipt: new_receipt(request, run_id),
            child_reaped: false,
            spawn_attempted: false,
            request_history,
        };
        // Bind identity before publishing ownership. If the note write fails,
        // no Active claim/session is stranded. No child can start before this
        // complete admission returns to the invocation owner.
        if let Some(content) = updated_content.as_deref() {
            write_task_note(&roots, lease, &snapshot.path, content)?;
            let verified = task_snapshot(&roots, &snapshot.path)?;
            if verified.task_id.as_deref() != Some(task_id.as_str())
                || verified.revision != claim.source_revision
            {
                return Err(action_error(
                    "task_execution_identity_write_conflict",
                    &snapshot.path,
                    "task changed during identity binding",
                    "refresh the task revision before retrying",
                ));
            }
        }
        write_claim(&roots, lease, &claim, &task_lock)?;
        Ok(Admission {
            claim,
            replayed: false,
        })
    })
}

/// Read-only preflight immediately before spawn/result use. An old token never
/// adopts a newer generation, and source drift is refused before the caller's
/// effect.
pub(crate) fn check(work: &Path, token: &TaskExecutionToken) -> Result<TaskExecutionClaim, String> {
    with_claim_operation(
        work,
        &token.task_id,
        |roots, claim, snapshot, _lease, _lock| {
            validate_claim_token(claim, token)?;
            if claim.lifecycle != TaskExecutionLifecycle::Active {
                return Err(action_error(
                    "task_execution_claim_not_active",
                    &snapshot.path,
                    &format!("claim lifecycle is {:?}", claim.lifecycle),
                    "refresh the task execution and start a new request if eligible",
                ));
            }
            task_is_current(claim, snapshot)?;
            let mut current = claim.clone();
            rebind_claim_path(roots, &mut current, snapshot)?;
            Ok(current)
        },
    )
}

/// Hold the exact claim lock and source-path lease across child spawn and
/// durable PID binding. This closes the check/spawn race with guarded task
/// edits. A child that cannot be bound is killed and reaped by its owner.
pub(crate) fn spawn_owned_child(
    work: &Path,
    token: &TaskExecutionToken,
    spawn: impl FnOnce() -> Result<Child, String>,
) -> Result<Child, String> {
    let mut spawn = Some(spawn);
    with_claim_operation(
        work,
        &token.task_id,
        |roots, claim, snapshot, lease, lock| {
            validate_claim_token(claim, token)?;
            if claim.lifecycle != TaskExecutionLifecycle::Active {
                return Err(action_error(
                    "task_execution_claim_not_active",
                    &snapshot.path,
                    &format!("claim lifecycle is {:?}", claim.lifecycle),
                    "refresh the task execution",
                ));
            }
            task_is_current(claim, snapshot)?;
            if claim.receipt.child.is_some() {
                return Err(action_error(
                    "task_execution_child_already_bound",
                    &snapshot.path,
                    "claim already has a child process",
                    "wait for or reconcile the owned child before spawning another",
                ));
            }
            // Clear the prior role's wait proof before entering the spawn window.
            // A crash after spawn but before PID persistence must remain uncertain.
            claim.child_reaped = false;
            claim.spawn_attempted = true;
            rebind_claim_path(roots, claim, snapshot)?;
            write_claim(roots, lease, claim, lock)?;
            let mut child = match spawn.take().expect("spawn closure is called once")() {
                Ok(child) => child,
                Err(error) => {
                    claim.lifecycle = TaskExecutionLifecycle::Finished;
                    claim.receipt.process_outcome = "failed".into();
                    claim.receipt.exit_code = None;
                    claim.receipt.finished_at = Some(now_seconds());
                    rebind_claim_path(roots, claim, snapshot)?;
                    write_claim(roots, lease, claim, lock)?;
                    return Err(format!("task_execution_spawn_failed: {error}; the failed request is recorded; refresh the task and use a new requestId to retry"));
                }
            };
            let pid = child.id();
            let child_identity = identity(pid).unwrap_or(NativeProcessIdentity {
                pid,
                start: String::new(),
            });
            claim.receipt.child = Some(child_identity);
            rebind_claim_path(roots, claim, snapshot)?;
            if let Err(error) = write_claim(roots, lease, claim, lock) {
                let cleanup = match child.kill() {
                Ok(()) => child.wait().map(|status| format!("owned child reaped with status {status}"))
                    .unwrap_or_else(|wait_error| format!("owned child kill succeeded but wait failed: {wait_error}")),
                Err(kill_error) => match child.try_wait() {
                    Ok(Some(status)) => format!("owned child already exited with status {status}; kill returned {kill_error}"),
                    Ok(None) => format!("kill failed and child may still be running: {kill_error}"),
                    Err(wait_error) => format!("kill failed: {kill_error}; nonblocking wait failed: {wait_error}"),
                },
            };
                return Err(format!("task_execution_child_bind_failed: {error}; cleanup={cleanup}; review the task claim before retrying"));
            }
            Ok(child)
        },
    )
}

/// Bind exactly one native child to the current generation. An unknown start
/// identity remains persisted as unverified and cannot be reconciled later.
#[cfg(test)]
pub(crate) fn record_child(
    work: &Path,
    token: &TaskExecutionToken,
    child: Option<NativeProcessIdentity>,
) -> Result<TaskExecutionClaim, String> {
    with_claim_operation(
        work,
        &token.task_id,
        |roots, claim, snapshot, lease, lock| {
            validate_claim_token(claim, token)?;
            if claim.lifecycle != TaskExecutionLifecycle::Active {
                return Err(action_error(
                    "task_execution_claim_not_active",
                    &snapshot.path,
                    &format!("claim lifecycle is {:?}", claim.lifecycle),
                    "refresh the active task execution",
                ));
            }
            task_is_current(claim, snapshot)?;
            if let Some(new_child) = child {
                if new_child.pid == 0 {
                    return Err(action_error(
                        "task_execution_child_identity_invalid",
                        &snapshot.path,
                        "child pid is zero",
                        "bind the spawned child using its native process identity",
                    ));
                }
                if let Some(existing) = claim.receipt.child.as_ref() {
                    if existing == &new_child {
                        return Ok(claim.clone());
                    }
                    if process_ownership(existing) != ProcessOwnership::Dead {
                        return Err(action_error(
                            "task_execution_child_already_bound",
                            &snapshot.path,
                            "previous child is live or unverified",
                            "wait for its owned child to exit before binding another",
                        ));
                    }
                }
                claim.receipt.child = Some(new_child);
                claim.child_reaped = false;
                claim.spawn_attempted = true;
            } else if let Some(existing) = claim.receipt.child.as_ref() {
                if process_ownership(existing) != ProcessOwnership::Dead {
                    return Err(action_error(
                        "task_execution_child_not_reaped",
                        &snapshot.path,
                        "child exit is not proven by native process identity",
                        "wait for and reap the owned child before clearing its receipt",
                    ));
                }
                claim.receipt.child = None;
                claim.child_reaped = true;
            } else {
                return Ok(claim.clone());
            }
            rebind_claim_path(roots, claim, snapshot)?;
            write_claim(roots, lease, claim, lock)?;
            Ok(claim.clone())
        },
    )
}

/// Clear a child only when the current launcher reports that its owned
/// `Child::wait`/`wait_with_output` completed. The PID must match the durable
/// binding and the launcher process identity must still match this generation.
pub(crate) fn record_reaped_child(
    work: &Path,
    token: &TaskExecutionToken,
    pid: u32,
) -> Result<TaskExecutionClaim, String> {
    with_claim_identity(work, token, |roots, claim, lease, lock| {
        let label = roots.work.join(&claim.task_path);
        validate_claim_token(claim, token)?;
        if !matches!(
            claim.lifecycle,
            TaskExecutionLifecycle::Active | TaskExecutionLifecycle::NeedsReview
        ) {
            return Err(action_error(
                "task_execution_claim_not_active",
                &label,
                &format!("claim lifecycle is {:?}", claim.lifecycle),
                "refresh the task execution",
            ));
        }
        let current_owner = identity(std::process::id()).ok_or_else(|| {
            action_error(
                "task_execution_launcher_unverified",
                &label,
                "native launcher start time is unavailable",
                "retain the claim for review instead of clearing child ownership",
            )
        })?;
        let owner = claim.receipt.owner.as_ref().ok_or_else(|| {
            action_error(
                "task_execution_launcher_unverified",
                &label,
                "claim has no native owner identity",
                "retain the claim for review instead of clearing child ownership",
            )
        })?;
        if owner != &current_owner || process_ownership(owner) != ProcessOwnership::Live {
            return Err(action_error(
                "task_execution_launcher_changed",
                &label,
                "current launcher does not match the recorded owner",
                "retain the claim for review",
            ));
        }
        let child = claim.receipt.child.as_ref().ok_or_else(|| {
            action_error(
                "task_execution_child_binding_missing",
                &label,
                "no child identity is recorded",
                "bind the owned child before acknowledging its wait result",
            )
        })?;
        if child.pid != pid {
            return Err(action_error(
                "task_execution_child_binding_mismatch",
                &label,
                "wait result PID differs from the claimed child",
                "retain the claim for review; do not clear another process",
            ));
        }
        claim.receipt.child = None;
        claim.child_reaped = true;
        write_claim(roots, lease, claim, lock)?;
        Ok(claim.clone())
    })
}

/// Record process completion only; task status remains owned by task APIs.
pub(crate) fn finish(
    work: &Path,
    token: &TaskExecutionToken,
    success: bool,
    exit_code: Option<i32>,
) -> Result<TaskExecutionClaim, String> {
    with_claim_operation(
        work,
        &token.task_id,
        |roots, claim, snapshot, lease, lock| {
            validate_claim_token(claim, token)?;
            let requested_outcome = if success { "succeeded" } else { "failed" };
            if claim.lifecycle == TaskExecutionLifecycle::Released
                && !success
                && exit_code.is_none()
            {
                return Ok(claim.clone());
            }
            if claim.lifecycle == TaskExecutionLifecycle::Finished {
                if claim.receipt.process_outcome == requested_outcome
                    && claim.receipt.exit_code == exit_code
                {
                    return Ok(claim.clone());
                }
                return Err(action_error(
                    "task_execution_finish_conflict",
                    &snapshot.path,
                    "this generation already has a different terminal result",
                    "refresh the current task execution; terminal results cannot be overwritten",
                ));
            }
            if claim.lifecycle == TaskExecutionLifecycle::NeedsReview {
                return Err(action_error(
                    "task_execution_needs_review",
                    &snapshot.path,
                    "task changed while the worker was running",
                    "review the task and discard or manually reconcile the result",
                ));
            }
            if claim.lifecycle != TaskExecutionLifecycle::Active {
                return Err(action_error(
                    "task_execution_claim_not_active",
                    &snapshot.path,
                    &format!("claim lifecycle is {:?}", claim.lifecycle),
                    "refresh the task execution",
                ));
            }
            if !claim.child_reaped {
                if let Some(child) = claim.receipt.child.as_ref() {
                    if process_ownership(child) != ProcessOwnership::Dead {
                        return Err(action_error(
                            "task_execution_child_not_reaped",
                            &snapshot.path,
                            "worker child is live or unverified",
                            "wait for and reap the owned child before finishing the claim",
                        ));
                    }
                }
                return Err(action_error(
                    "task_execution_child_reap_unconfirmed",
                    &snapshot.path,
                    "successful wait proof was not durably recorded",
                    "call record_reaped_child after waiting on the owned Child, then finish",
                ));
            }
            if let Err(error) = task_is_current(claim, snapshot) {
                claim.lifecycle = TaskExecutionLifecycle::NeedsReview;
                claim.receipt.process_outcome = "needsReview".into();
                claim.receipt.exit_code = exit_code;
                claim.receipt.finished_at = Some(now_seconds());
                rebind_claim_path(roots, claim, snapshot)?;
                write_claim(roots, lease, claim, lock)?;
                return Err(error);
            }
            claim.lifecycle = TaskExecutionLifecycle::Finished;
            claim.receipt.process_outcome = requested_outcome.into();
            claim.receipt.exit_code = exit_code;
            claim.receipt.finished_at = Some(now_seconds());
            rebind_claim_path(roots, claim, snapshot)?;
            write_claim(roots, lease, claim, lock)?;
            Ok(claim.clone())
        },
    )
}

/// Cleanup requires the same verified launcher and no live or uncertain
/// launch. It reads claim identity only, so a vanished note cannot strand it.
pub(crate) fn cancel_admission(work: &Path, token: &TaskExecutionToken) -> Result<(), String> {
    with_claim_identity(work, token, |roots, claim, lease, lock| {
        if matches!(
            claim.lifecycle,
            TaskExecutionLifecycle::Released
                | TaskExecutionLifecycle::Finished
                | TaskExecutionLifecycle::Reconciled
        ) {
            return Ok(());
        }
        let label = roots.work.join(&claim.task_path);
        let before_first_spawn = !claim.spawn_attempted;
        if !(claim.lifecycle == TaskExecutionLifecycle::Active
            || claim.lifecycle == TaskExecutionLifecycle::NeedsReview && before_first_spawn)
            || claim.receipt.child.is_some()
            || !before_first_spawn && !claim.child_reaped
        {
            return Err(action_error(
                "task_execution_cleanup_held",
                &label,
                "a child or uncertain launch history requires review",
                "review ownership and use stop_ai_mission after the launcher settles",
            ));
        }
        let owner = identity(std::process::id());
        if owner.is_none() || owner.as_ref() != claim.receipt.owner.as_ref() {
            return Err(action_error(
                "task_execution_cleanup_unverified",
                &label,
                "current launcher identity is not verified",
                "retain the claim for review",
            ));
        }
        claim.lifecycle = TaskExecutionLifecycle::Released;
        claim.receipt.process_outcome = "released".into();
        claim.receipt.finished_at = Some(now_seconds());
        write_claim(roots, lease, claim, lock)
    })
}

/// Reviewed release changes only the exact claim identity, never task bytes.
pub(crate) fn release(
    work: &Path,
    token: &TaskExecutionToken,
) -> Result<TaskExecutionClaim, String> {
    with_claim_identity(work, token, |roots, claim, lease, lock| {
        if claim.lifecycle == TaskExecutionLifecycle::Released {
            return Ok(claim.clone());
        }
        let label = roots.work.join(&claim.task_path);
        if !matches!(
            claim.lifecycle,
            TaskExecutionLifecycle::Active | TaskExecutionLifecycle::NeedsReview
        ) {
            return Err(action_error(
                "task_execution_claim_not_active",
                &label,
                "claim is already terminal",
                "refresh mission history before retrying",
            ));
        }
        if let Some(child) = &claim.receipt.child {
            if process_ownership(child) != ProcessOwnership::Dead {
                return Err(action_error("task_execution_child_not_reaped", &label,
                    "child is live or unverified; an exited but unreaped process can remain unverified",
                    "retry after the original launcher exits, or restart Maru and review ownership again"));
            }
        } else if !claim.child_reaped {
            let owner = identity(std::process::id());
            let current_owner = owner.is_some() && owner.as_ref() == claim.receipt.owner.as_ref();
            let owner_dead = claim
                .receipt
                .owner
                .as_ref()
                .is_some_and(|owner| process_ownership(owner) == ProcessOwnership::Dead);
            if claim.spawn_attempted || !(current_owner || owner_dead) {
                return Err(action_error("task_execution_release_unverified", &label, "launch or owner proof is incomplete",
                    "retry after the original launcher exits, or restart Maru and retain uncertain ownership for review"));
            }
        }
        claim.receipt.child = None;
        claim.child_reaped = true;
        claim.lifecycle = TaskExecutionLifecycle::Released;
        claim.receipt.process_outcome = "released".into();
        claim.receipt.finished_at = Some(now_seconds());
        write_claim(roots, lease, claim, lock)?;
        Ok(claim.clone())
    })
}

/// Reconcile only when both recorded process identities positively prove
/// death, or a durable wait/no-launch proof. A missing child after launch
/// remains uncertainty; elapsed time never supplies ownership evidence.
pub(crate) fn reconcile(work: &Path, task_id: &str) -> Result<TaskExecutionClaim, String> {
    with_claim_operation(work, task_id, |roots, claim, snapshot, lease, lock| {
        if claim.lifecycle != TaskExecutionLifecycle::Active {
            return Ok(claim.clone());
        }
        let owner_proof = claim
            .receipt
            .owner
            .as_ref()
            .map(process_ownership)
            .unwrap_or(ProcessOwnership::Unverified);
        let child_proof = claim.receipt.child.as_ref().map(process_ownership);
        if !ownership_proves_stopped(
            owner_proof,
            child_proof,
            claim.child_reaped,
            !claim.spawn_attempted,
        ) {
            return Ok(claim.clone());
        }
        if task_is_current(claim, snapshot).is_err() {
            claim.lifecycle = TaskExecutionLifecycle::NeedsReview;
            claim.receipt.process_outcome = "needsReview".into();
            claim.receipt.finished_at = Some(now_seconds());
            rebind_claim_path(roots, claim, snapshot)?;
            write_claim(roots, lease, claim, lock)?;
            return Ok(claim.clone());
        }
        claim.lifecycle = TaskExecutionLifecycle::Reconciled;
        claim.receipt.process_outcome = "interrupted".into();
        claim.receipt.finished_at = Some(now_seconds());
        claim.receipt.child = None;
        claim.child_reaped = true;
        rebind_claim_path(roots, claim, snapshot)?;
        write_claim(roots, lease, claim, lock)?;
        Ok(claim.clone())
    })
}

#[cfg(test)]
#[path = "task_execution_claims_tests.rs"]
mod tests;
