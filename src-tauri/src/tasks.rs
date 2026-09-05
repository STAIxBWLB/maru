use crate::atomic_file::{
    with_path_transactions, write_atomic, PathTransactionLease, PathTransactionParent,
    PathTransactionRequest,
};
use crate::document::revision_for;
use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::vault::{
    lexical_normalize, normalize_existing_dir, parse_frontmatter, resolve_inside_vault, slugify,
};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map as JsonMap, Value as JsonValue};
use serde_yaml::Value as YamlValue;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const TASKS_LOG_DEFAULT_LIMIT: usize = 200;
const TASKS_LOG_MAX_LIMIT: usize = 2000;
const TASK_BUCKETS: [TaskBucket; 4] = [
    TaskBucket::Active,
    TaskBucket::Backlog,
    TaskBucket::Archive,
    TaskBucket::Calendar,
];

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskBucket {
    Active,
    Backlog,
    Archive,
    Calendar,
}

impl TaskBucket {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            TaskBucket::Active => "active",
            TaskBucket::Backlog => "backlog",
            TaskBucket::Archive => "archive",
            TaskBucket::Calendar => "calendar",
        }
    }

    pub(crate) fn parse(value: &str) -> Option<Self> {
        match value {
            "active" => Some(TaskBucket::Active),
            "backlog" => Some(TaskBucket::Backlog),
            "archive" => Some(TaskBucket::Archive),
            "calendar" => Some(TaskBucket::Calendar),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum TaskStatus {
    Active,
    InProgress,
    Done,
    Cancelled,
    Backlog,
}

impl TaskStatus {
    fn as_str(self) -> &'static str {
        match self {
            TaskStatus::Active => "active",
            TaskStatus::InProgress => "in-progress",
            TaskStatus::Done => "done",
            TaskStatus::Cancelled => "cancelled",
            TaskStatus::Backlog => "backlog",
        }
    }

    fn target_bucket(self) -> TaskBucket {
        match self {
            TaskStatus::Done | TaskStatus::Cancelled => TaskBucket::Archive,
            TaskStatus::Backlog => TaskBucket::Backlog,
            TaskStatus::Active | TaskStatus::InProgress => TaskBucket::Active,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskNoteRow {
    pub path: String,
    pub rel_path: String,
    pub file_name: String,
    pub display_title: String,
    pub bucket: TaskBucket,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub frontmatter: JsonValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskMetadata {
    pub rel_path: String,
    pub frontmatter: JsonValue,
    pub body: String,
    pub preview: String,
    pub line_count: usize,
    pub char_count: usize,
    pub tags: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskDraft {
    pub slug: String,
    pub title: String,
    pub frontmatter: BTreeMap<String, JsonValue>,
    pub body: String,
    pub bucket: TaskBucket,
}

#[derive(Debug, Clone)]
pub(crate) struct MaterializedTaskWrite {
    pub row: TaskNoteRow,
    pub created: bool,
}

#[derive(Clone)]
pub(crate) struct PreparedCaptureTask {
    parent: PathTransactionParent,
    workspace_parent: PathTransactionParent,
    path: PathBuf,
    pub rel_path: String,
    bucket: TaskBucket,
    capture_id: String,
    content: String,
    pub content_hash: String,
    pub will_create: bool,
}

impl std::fmt::Debug for PreparedCaptureTask {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PreparedCaptureTask")
            .field("path", &self.path)
            .field("rel_path", &self.rel_path)
            .field("bucket", &self.bucket)
            .field("capture_id", &self.capture_id)
            .field("content", &self.content)
            .field("content_hash", &self.content_hash)
            .field("will_create", &self.will_create)
            .finish()
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTaskScheduleFields {
    pub project: Option<Option<String>>,
    pub priority: Option<Option<String>>,
    pub due: Option<Option<String>>,
    pub calendar_start: Option<Option<String>>,
    pub calendar_end: Option<Option<String>>,
    pub estimate_minutes: Option<Option<f64>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateTaskDetailsFields {
    pub title: Option<String>,
    pub status: Option<TaskStatus>,
    pub project: Option<Option<String>>,
    pub priority: Option<Option<String>>,
    pub due: Option<Option<String>>,
    pub calendar_start: Option<Option<String>>,
    pub calendar_end: Option<Option<String>>,
    pub estimate_minutes: Option<Option<f64>>,
    pub body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TasksLogLine {
    pub raw: String,
    pub ts: Option<String>,
    pub event: String,
    pub run_id: Option<String>,
    pub status: Option<String>,
    pub skill: Option<String>,
    pub target: Option<String>,
    pub payload: Option<JsonValue>,
    pub legacy: bool,
}

pub fn scan_task_notes(
    work_path: String,
    root: Option<String>,
) -> Result<Vec<TaskNoteRow>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let scan_root = resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?;
    if !scan_root.exists() {
        return Ok(Vec::new());
    }
    if !scan_root.is_dir() {
        return Err("tasks_root_not_directory".to_string());
    }
    let mut rows = Vec::new();
    for bucket in TASK_BUCKETS {
        let bucket_root = scan_root.join(bucket.as_str());
        if !bucket_root.exists() {
            continue;
        }
        if !bucket_root.is_dir() {
            return Err("task_bucket_not_directory".to_string());
        }
        for entry in WalkDir::new(&bucket_root)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| should_enter_task_path(entry.path(), &bucket_root))
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() || !is_markdown(entry.path()) {
                continue;
            }
            rows.push(task_row_for_path(&work, entry.path(), bucket)?);
        }
    }
    rows.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(rows)
}

pub fn read_task_metadata(work_path: String, rel_path: String) -> Result<TaskMetadata, String> {
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let raw = fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let parts = parse_frontmatter(&raw);
    let frontmatter_json = normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta));
    let preview = parts.body.lines().take(200).collect::<Vec<_>>().join("\n");
    Ok(TaskMetadata {
        rel_path,
        tags: string_list_field(&frontmatter_json, "tags")
            .into_iter()
            .chain(string_list_field(&frontmatter_json, "topics"))
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect(),
        frontmatter: frontmatter_json,
        body: parts.body.clone(),
        preview,
        line_count: raw.lines().count(),
        char_count: raw.chars().count(),
    })
}

pub fn create_task_note(
    work_path: String,
    draft: CreateTaskDraft,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?.join(draft.bucket.as_str()),
    ];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        create_task_note_in_transaction(lease, work_path, draft, root)
    })
}

pub(crate) fn create_task_note_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    draft: CreateTaskDraft,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?.join(draft.bucket.as_str()),
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;

    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::Create,
    )?;
    let work = normalize_existing_dir(&work_path)?;
    let tasks_root = resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?;
    let bucket_root = tasks_root.join(draft.bucket.as_str());
    fs::create_dir_all(&bucket_root).map_err(|err| format!("Cannot create task bucket: {err}"))?;
    let slug = slugify(&draft.slug);
    let stem = if slug == "untitled" {
        let title_slug = slugify(&draft.title);
        if title_slug == "untitled" {
            format!("{}-task", Utc::now().format("%y%m%d"))
        } else {
            format!("{}-{title_slug}", Utc::now().format("%y%m%d"))
        }
    } else if slug.starts_with(&Utc::now().format("%y%m%d").to_string()) {
        slug
    } else {
        format!("{}-{slug}", Utc::now().format("%y%m%d"))
    };
    let path = conflict_free_path(&bucket_root.join(format!("{stem}.md")));
    let mut frontmatter = draft.frontmatter;
    if !frontmatter.contains_key("title") && !draft.title.trim().is_empty() {
        frontmatter.insert(
            "title".to_string(),
            JsonValue::String(draft.title.trim().to_string()),
        );
    }
    if !frontmatter.contains_key("status") {
        frontmatter.insert(
            "status".to_string(),
            JsonValue::String(default_status_for_bucket(draft.bucket).to_string()),
        );
    }
    let content = serialize_task_note(&frontmatter, &draft.body)?;
    fs::write(&path, content).map_err(|err| format!("Cannot write task note: {err}"))?;
    task_row_for_path(&work, &path, draft.bucket)
}

/// Build the deterministic path and bytes before writing. The Today finalize
/// journal records this plan first, closing the crash window between creating
/// the note and remembering how to roll it back.
pub(crate) fn prepare_capture_task_materialization(
    work: &Path,
    logical_day: &str,
    capture_id: &str,
    mut draft: CreateTaskDraft,
) -> Result<PreparedCaptureTask, String> {
    let tasks_root = resolve_tasks_root(work, "tasks")?;
    let bucket_root = tasks_root.join(draft.bucket.as_str());
    let workspace_parent = PathTransactionParent::capture(work)?;
    let mut existing = bucket_root.as_path();
    while !existing.is_dir() {
        existing = existing.parent().ok_or("Task parent missing")?;
    }
    let parent = PathTransactionParent::capture(existing)?;

    let capture_hash = revision_for(capture_id);
    let suffix = capture_hash.get(..10).unwrap_or(&capture_hash);
    let day_prefix = logical_day.replace('-', "");
    let day_prefix = day_prefix.get(2..).unwrap_or(&day_prefix);
    let title_slug = slugify(&draft.title);
    let title_slug = if title_slug == "untitled" {
        "capture".to_string()
    } else {
        title_slug
    };
    let path = bucket_root.join(format!("{day_prefix}-{title_slug}-{suffix}.md"));
    let task_id = format!("capture-{suffix}");

    draft
        .frontmatter
        .insert("taskId".to_string(), JsonValue::String(task_id));
    draft.frontmatter.insert(
        "maruCaptureId".to_string(),
        JsonValue::String(capture_id.to_string()),
    );
    if !draft.frontmatter.contains_key("title") && !draft.title.trim().is_empty() {
        draft.frontmatter.insert(
            "title".to_string(),
            JsonValue::String(draft.title.trim().to_string()),
        );
    }
    if !draft.frontmatter.contains_key("status") {
        draft.frontmatter.insert(
            "status".to_string(),
            JsonValue::String(default_status_for_bucket(draft.bucket).to_string()),
        );
    }
    let content = serialize_task_note(&draft.frontmatter, &draft.body)?;
    let rel_path = path
        .strip_prefix(work)
        .unwrap_or(&path)
        .to_string_lossy()
        .to_string();
    let content_hash = revision_for(&content);
    let will_create = !path.exists();
    Ok(PreparedCaptureTask {
        parent,
        workspace_parent,
        path,
        rel_path,
        bucket: draft.bucket,
        capture_id: capture_id.to_string(),
        content,
        content_hash,
        will_create,
    })
}

/// Commit a prepared capture-derived task note. Replaying the same capture
/// returns the original row; an unrelated file at that path is never
/// overwritten.
pub(crate) fn materialize_capture_task(
    work: &Path,
    prepared: &PreparedCaptureTask,
) -> Result<MaterializedTaskWrite, String> {
    let request = PathTransactionRequest::new(vec![prepared.path.clone()])?
        .require_parent_snapshot(&prepared.parent)?
        .require_parent_snapshot(&prepared.workspace_parent)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        materialize_capture_task_in_transaction(lease, work, prepared)
    })
}

pub(crate) fn materialize_capture_task_in_transaction(
    lease: &PathTransactionLease,
    work: &Path,
    prepared: &PreparedCaptureTask,
) -> Result<MaterializedTaskWrite, String> {
    lease.ensure_covered(vec![prepared.path.clone()])?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_maru_can_write(&work.to_string_lossy(), WorkspaceWriteAction::Create)?;
    if prepared.path.exists() {
        let row = task_row_for_path(work, &prepared.path, prepared.bucket)?;
        let stored_capture = row
            .frontmatter
            .get("maruCaptureId")
            .and_then(JsonValue::as_str);
        if stored_capture != Some(prepared.capture_id.as_str()) {
            return Err(format!("today_capture_path_conflict: {}", row.rel_path));
        }
        return Ok(MaterializedTaskWrite {
            row,
            created: false,
        });
    }

    write_atomic(&prepared.path, prepared.content.as_bytes())
        .map_err(|err| format!("Cannot write capture task note: {err}"))?;
    let row = task_row_for_path(work, &prepared.path, prepared.bucket)?;
    Ok(MaterializedTaskWrite { row, created: true })
}

pub fn update_task_status(
    work_path: String,
    rel_path: String,
    status: TaskStatus,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        update_task_status_in_transaction(lease, work_path, rel_path, status, root)
    })
}

pub(crate) fn update_task_status_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    rel_path: String,
    status: TaskStatus,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;

    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::Modify,
    )?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let tasks_root = resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let updated = update_frontmatter_content(
        &original,
        "status",
        Some(FrontmatterValue::String(status.as_str().to_string())),
    )?;
    let target_bucket = status.target_bucket();
    let current_bucket = bucket_from_task_path(&tasks_root, &path)?;
    if current_bucket != target_bucket {
        assert_maru_can_write(
            &normalize_existing_dir(&work_path)?.to_string_lossy(),
            WorkspaceWriteAction::RenameMove,
        )?;
    }
    if updated != original {
        write_atomic(&path, updated.as_bytes())
            .map_err(|err| format!("Cannot update task status: {err}"))?;
    }
    if current_bucket == target_bucket {
        return task_row_for_path(&work, &path, current_bucket);
    }
    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::RenameMove,
    )?;
    let target = conflict_free_path(&target_path_for_bucket(&tasks_root, &path, target_bucket)?);
    let moved = (|| {
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Cannot create task target: {err}"))?;
        }
        fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))
    })();
    if let Err(error) = moved {
        write_atomic(&path, original.as_bytes())
            .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
        return Err(error);
    }
    task_row_for_path(&work, &target, target_bucket)
}

pub fn update_task_schedule_fields(
    work_path: String,
    rel_path: String,
    fields: UpdateTaskScheduleFields,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![resolve_inside_vault(&work_path, &rel_path)?];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        update_task_schedule_fields_in_transaction(lease, work_path, rel_path, fields)
    })
}

pub(crate) fn update_task_schedule_fields_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    rel_path: String,
    fields: UpdateTaskScheduleFields,
) -> Result<TaskNoteRow, String> {
    let paths = vec![resolve_inside_vault(&work_path, &rel_path)?];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;

    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::Modify,
    )?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let mut updated = original.clone();
    updated = patch_optional_string_field(updated, "project", fields.project)?;
    updated = patch_optional_string_field(updated, "priority", fields.priority)?;
    updated = patch_optional_string_field(updated, "due", fields.due)?;
    updated = patch_optional_string_field(updated, "calendarStart", fields.calendar_start)?;
    updated = patch_optional_string_field(updated, "calendarEnd", fields.calendar_end)?;
    updated = patch_optional_number_field(updated, "estimateMinutes", fields.estimate_minutes)?;
    if updated != original {
        fs::write(&path, &updated).map_err(|err| format!("Cannot update task schedule: {err}"))?;
    }
    let bucket = bucket_from_rel_path(&rel_path).unwrap_or(TaskBucket::Active);
    task_row_for_path(&work, &path, bucket)
}

pub fn update_task_details(
    work_path: String,
    rel_path: String,
    fields: UpdateTaskDetailsFields,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        update_task_details_in_transaction(lease, work_path, rel_path, fields, root)
    })
}

pub(crate) fn update_task_details_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    rel_path: String,
    fields: UpdateTaskDetailsFields,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;

    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::Modify,
    )?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let tasks_root = resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?;
    let current_bucket = bucket_from_task_path(&tasks_root, &path)?;
    let original =
        fs::read_to_string(&path).map_err(|err| format!("Cannot read task note: {err}"))?;
    let current_status = task_status_from_content(&original, current_bucket);
    let target_status = fields.status.unwrap_or(current_status);

    let mut updated = original.clone();
    if let Some(title) = fields.title {
        let title = title.trim();
        if title.is_empty() {
            return Err("task_title_required".to_string());
        }
        updated = update_frontmatter_content(
            &updated,
            "title",
            Some(FrontmatterValue::String(title.to_string())),
        )?;
    }
    if fields.status.is_some() {
        updated = update_frontmatter_content(
            &updated,
            "status",
            Some(FrontmatterValue::String(target_status.as_str().to_string())),
        )?;
    }
    updated = patch_optional_string_field(updated, "project", fields.project)?;
    updated = patch_optional_string_field(updated, "priority", fields.priority)?;
    updated = patch_optional_string_field(updated, "due", fields.due)?;
    updated = patch_optional_string_field(updated, "calendarStart", fields.calendar_start)?;
    updated = patch_optional_string_field(updated, "calendarEnd", fields.calendar_end)?;
    updated = patch_optional_number_field(updated, "estimateMinutes", fields.estimate_minutes)?;
    if let Some(body) = fields.body {
        updated = replace_markdown_body(&updated, &body)?;
    }

    let target_bucket = target_status.target_bucket();
    let will_move = fields.status.is_some()
        && target_status != current_status
        && current_bucket != target_bucket;
    if will_move {
        assert_maru_can_write(
            &normalize_existing_dir(&work_path)?.to_string_lossy(),
            WorkspaceWriteAction::RenameMove,
        )?;
    }
    if updated != original {
        write_atomic(&path, updated.as_bytes())
            .map_err(|err| format!("Cannot update task details: {err}"))?;
    }
    if fields.status.is_some() && target_status != current_status && current_bucket != target_bucket
    {
        assert_maru_can_write(
            &normalize_existing_dir(&work_path)?.to_string_lossy(),
            WorkspaceWriteAction::RenameMove,
        )?;
        let target =
            conflict_free_path(&target_path_for_bucket(&tasks_root, &path, target_bucket)?);
        let moved = (|| {
            if let Some(parent) = target.parent() {
                fs::create_dir_all(parent)
                    .map_err(|err| format!("Cannot create task target: {err}"))?;
            }
            fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))
        })();
        if let Err(error) = moved {
            write_atomic(&path, original.as_bytes())
                .map_err(|rollback| format!("{error}; rollback failed: {rollback}"))?;
            return Err(error);
        }
        return task_row_for_path(&work, &target, target_bucket);
    }

    task_row_for_path(&work, &path, current_bucket)
}

pub fn move_task_note(
    work_path: String,
    rel_path: String,
    target_bucket: TaskBucket,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        move_task_note_in_transaction(lease, work_path, rel_path, target_bucket, root)
    })
}

pub(crate) fn move_task_note_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    rel_path: String,
    target_bucket: TaskBucket,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![
        resolve_inside_vault(&work_path, &rel_path)?,
        resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?,
    ];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;

    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::RenameMove,
    )?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let tasks_root = resolve_tasks_root(&work, root.as_deref().unwrap_or("tasks"))?;
    let current_bucket = bucket_from_task_path(&tasks_root, &path)?;
    if current_bucket == target_bucket {
        return task_row_for_path(&work, &path, current_bucket);
    }
    let target = conflict_free_path(&target_path_for_bucket(&tasks_root, &path, target_bucket)?);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create task target: {err}"))?;
    }
    fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))?;
    task_row_for_path(&work, &target, target_bucket)
}

pub fn append_tasks_log(work_path: String, line: String) -> Result<(), String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![work.join(".maru/tasks-log.md")];
    let lexical_work = if Path::new(&work_path).is_absolute() {
        PathBuf::from(&work_path)
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(&work_path)
    };
    let paths = paths
        .into_iter()
        .flat_map(|path| {
            let alias = path
                .strip_prefix(&work)
                .map(|rel| lexical_work.join(rel))
                .unwrap_or_else(|_| path.clone());
            [path, alias]
        })
        .collect::<Vec<_>>();
    let request = PathTransactionRequest::new(paths)?
        .require_parent(&work)?
        .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        append_tasks_log_in_transaction(lease, work_path, line)
    })
}

pub(crate) fn append_tasks_log_in_transaction(
    lease: &PathTransactionLease,
    work_path: String,
    line: String,
) -> Result<(), String> {
    let work = normalize_existing_dir(&work_path)?;
    let paths = vec![work.join(".maru/tasks-log.md")];
    lease.ensure_covered(paths)?;
    lease.ensure_workspace_registry()?;
    lease.before_effect()?;
    assert_maru_can_write(
        &normalize_existing_dir(&work_path)?.to_string_lossy(),
        WorkspaceWriteAction::Modify,
    )?;

    let work = normalize_existing_dir(&work_path)?;
    let log_path = work.join(".maru").join("tasks-log.md");
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create tasks log dir: {err}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("Cannot open tasks log: {err}"))?;
    writeln!(file, "{line}").map_err(|err| format!("Cannot append tasks log: {err}"))?;
    Ok(())
}

pub fn read_tasks_log(
    work_path: String,
    limit: Option<usize>,
    event_filter: Option<Vec<String>>,
) -> Result<Vec<TasksLogLine>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let log_path = work.join(".maru").join("tasks-log.md");
    if !log_path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        fs::read_to_string(&log_path).map_err(|err| format!("Cannot read tasks log: {err}"))?;
    let cap = limit
        .unwrap_or(TASKS_LOG_DEFAULT_LIMIT)
        .clamp(1, TASKS_LOG_MAX_LIMIT);
    let filter: Option<BTreeSet<String>> = event_filter
        .map(|values| {
            values
                .into_iter()
                .filter(|value| !value.is_empty())
                .collect()
        })
        .filter(|set: &BTreeSet<String>| !set.is_empty());
    Ok(raw
        .lines()
        .rev()
        .filter(|line| !line.trim().is_empty())
        .map(parse_tasks_log_line)
        .filter(|entry| {
            filter
                .as_ref()
                .map_or(true, |set| set.contains(&entry.event))
        })
        .take(cap)
        .collect())
}

fn task_row_for_path(work: &Path, path: &Path, bucket: TaskBucket) -> Result<TaskNoteRow, String> {
    let raw = fs::read_to_string(path).unwrap_or_default();
    let parts = parse_frontmatter(&raw);
    let metadata = path
        .metadata()
        .map_err(|err| format!("Cannot read task note metadata: {err}"))?;
    let rel_path = rel_path_for(work, path);
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(&rel_path)
        .to_string();
    let frontmatter = normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta));
    let display_title = task_display_title(&frontmatter, &parts.body, &file_name);
    Ok(TaskNoteRow {
        path: path.to_string_lossy().to_string(),
        rel_path: rel_path.clone(),
        file_name,
        display_title,
        bucket,
        size_bytes: metadata.len(),
        updated_at: metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .map(|value| value.to_rfc3339()),
        frontmatter,
    })
}

/// Human title for a task note: `title`, then `name`, then the first H1,
/// then the file stem. Shared with `web_actions.rs` so a Google Task created
/// from a note is named the same way Maru names it everywhere else.
pub(crate) fn task_display_title(frontmatter: &JsonValue, body: &str, file_name: &str) -> String {
    string_field(frontmatter, "title")
        .or_else(|| string_field(frontmatter, "name"))
        .or_else(|| {
            body.lines().find_map(|line| {
                let trimmed = line.trim_start();
                let title = trimmed.strip_prefix("# ")?.trim();
                (!title.is_empty()).then(|| title.to_string())
            })
        })
        .unwrap_or_else(|| {
            Path::new(file_name)
                .file_stem()
                .and_then(|value| value.to_str())
                .unwrap_or(file_name)
                .to_string()
        })
}

fn parse_tasks_log_line(raw: &str) -> TasksLogLine {
    let trimmed_dash = raw.trim_start().trim_start_matches('-').trim_start();
    let (ts, rest) = split_iso_timestamp(trimmed_dash);
    if let Some(rest) = rest {
        if let Some(after_bracket) = rest.strip_prefix('[') {
            if let Some(end) = after_bracket.find(']') {
                let event = after_bracket[..end].trim().to_string();
                let payload_text = after_bracket[end + 1..].trim();
                let payload = if payload_text.is_empty() {
                    None
                } else {
                    serde_json::from_str::<JsonValue>(payload_text).ok()
                };
                let payload_ref = payload.as_ref();
                return TasksLogLine {
                    raw: raw.to_string(),
                    ts,
                    run_id: payload_ref.and_then(|p| string_field(p, "runId")),
                    status: payload_ref.and_then(|p| string_field(p, "status")),
                    skill: payload_ref.and_then(|p| string_field(p, "skill")),
                    target: payload_ref.and_then(|p| string_field(p, "target")),
                    payload,
                    event,
                    legacy: false,
                };
            }
        }
    }
    TasksLogLine {
        raw: raw.to_string(),
        ts,
        event: "unknown".to_string(),
        run_id: None,
        status: None,
        skill: None,
        target: None,
        payload: None,
        legacy: true,
    }
}

fn split_iso_timestamp(input: &str) -> (Option<String>, Option<&str>) {
    let trimmed = input.trim();
    let Some((head, rest)) = trimmed.split_once(char::is_whitespace) else {
        return (None, Some(trimmed));
    };
    if DateTime::parse_from_rfc3339(head).is_ok() {
        (Some(head.to_string()), Some(rest.trim()))
    } else {
        (None, Some(trimmed))
    }
}

fn should_enter_task_path(path: &Path, root: &Path) -> bool {
    if path == root {
        return true;
    }
    let rel = path.strip_prefix(root).unwrap_or(path);
    !rel.components().enumerate().any(|(index, component)| {
        matches!(component, Component::Normal(value) if {
            let segment = value.to_string_lossy();
            // Hidden/_-prefixed segments anywhere; `daily` journals at the
            // top level (tasks/daily is Maru Today output, not a task note).
            segment.starts_with('.')
                || segment.starts_with('_')
                || (index == 0 && segment == "daily")
        })
    })
}

fn is_markdown(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("md"))
        .unwrap_or(false)
}

fn resolve_config_path(work: &Path, raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    let path = PathBuf::from(trimmed);
    if path.is_absolute() {
        path
    } else {
        work.join(path)
    }
}

pub(crate) fn resolve_tasks_root(work: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = lexical_normalize(&resolve_config_path(work, raw));
    if candidate.starts_with(work) {
        return Ok(candidate);
    }
    if let Ok(canonical) = candidate.canonicalize() {
        if canonical.starts_with(work) {
            return Ok(canonical);
        }
    }
    Err("tasks_root_escapes_workspace".to_string())
}

fn patch_optional_string_field(
    content: String,
    key: &str,
    value: Option<Option<String>>,
) -> Result<String, String> {
    let Some(value) = value else {
        return Ok(content);
    };
    let next = value
        .map(|text| text.trim().to_string())
        .filter(|text| !text.is_empty())
        .map(FrontmatterValue::String);
    update_frontmatter_content(&content, key, next)
}

fn patch_optional_number_field(
    content: String,
    key: &str,
    value: Option<Option<f64>>,
) -> Result<String, String> {
    let Some(value) = value else {
        return Ok(content);
    };
    let next = value
        .filter(|number| number.is_finite() && *number > 0.0)
        .map(FrontmatterValue::Number);
    update_frontmatter_content(&content, key, next)
}

fn replace_markdown_body(content: &str, body: &str) -> Result<String, String> {
    let clean_body = body.trim_start_matches('\n');
    if !content.starts_with("---\n") {
        return Ok(clean_body.to_string());
    }
    let Some(end) = content[4..].find("\n---") else {
        return Err("Malformed frontmatter: no closing ---".to_string());
    };
    let closing_end = 4 + end + "\n---".len();
    let mut next = content[..closing_end].to_string();
    next.push('\n');
    next.push_str(clean_body);
    Ok(next)
}

fn task_status_from_content(content: &str, bucket: TaskBucket) -> TaskStatus {
    let parts = parse_frontmatter(content);
    let frontmatter = yaml_to_json(&parts.meta);
    string_field(&frontmatter, "status")
        .and_then(|value| parse_task_status(&value))
        .unwrap_or_else(|| default_status_for_bucket_enum(bucket))
}

fn parse_task_status(value: &str) -> Option<TaskStatus> {
    match value.trim().to_lowercase().replace('_', "-").as_str() {
        // `open` is the legacy pre-canonical alias for active tasks.
        "open" | "active" => Some(TaskStatus::Active),
        "in-progress" => Some(TaskStatus::InProgress),
        "done" => Some(TaskStatus::Done),
        "cancelled" => Some(TaskStatus::Cancelled),
        "backlog" => Some(TaskStatus::Backlog),
        _ => None,
    }
}

/// Legacy completion-date aliases, checked in order. `done` is canonical and
/// needs no alias. Nothing is invented when no alias holds a value.
const COMPLETED_AT_ALIASES: [&str; 3] = ["completed", "completed_at", "dateCompleted"];

/// Read-side normalization for legacy frontmatter aliases. Additive only:
/// canonical fields (`project`, `completedAt`) are derived from legacy
/// aliases when missing; the original keys stay untouched and writers keep
/// emitting canonical fields only.
pub(crate) fn normalize_task_frontmatter_aliases(mut frontmatter: JsonValue) -> JsonValue {
    let Some(map) = frontmatter.as_object_mut() else {
        return frontmatter;
    };
    if !map.contains_key("project") {
        if let Some(first) = map.get("projects").and_then(|value| match value {
            JsonValue::String(text) if !text.trim().is_empty() => Some(text.trim()),
            JsonValue::Array(items) => items
                .iter()
                .filter_map(JsonValue::as_str)
                .map(str::trim)
                .find(|value| !value.is_empty()),
            _ => None,
        }) {
            map.insert("project".to_string(), JsonValue::String(first.to_string()));
        }
    }
    if !map.contains_key("completedAt") {
        for alias in COMPLETED_AT_ALIASES {
            let Some(value) = map.get(alias) else {
                continue;
            };
            let text = match value {
                JsonValue::String(text) if !text.trim().is_empty() => Some(text.trim().to_string()),
                // Boolean `completed: true` carries no date — never invent one.
                _ => None,
            };
            if let Some(text) = text {
                map.insert("completedAt".to_string(), JsonValue::String(text));
                break;
            }
        }
    }
    frontmatter
}

pub(crate) fn target_path_for_bucket(
    tasks_root: &Path,
    path: &Path,
    target_bucket: TaskBucket,
) -> Result<PathBuf, String> {
    let rel = path
        .strip_prefix(tasks_root)
        .map_err(|_| "task_not_under_tasks_root".to_string())?;
    let mut components = rel.components();
    let Some(Component::Normal(bucket_segment)) = components.next() else {
        return Err("task_bucket_not_found".to_string());
    };
    let bucket_text = bucket_segment.to_string_lossy();
    if TaskBucket::parse(&bucket_text).is_none() {
        return Err("task_bucket_not_found".to_string());
    }
    let mut target = tasks_root.to_path_buf();
    target.push(target_bucket.as_str());
    for component in components {
        match component {
            Component::Normal(part) => target.push(part),
            _ => return Err("task_target_escapes_workspace".to_string()),
        }
    }
    let normalized = lexical_normalize(&target);
    if normalized.starts_with(tasks_root) {
        Ok(normalized)
    } else {
        Err("task_target_escapes_workspace".to_string())
    }
}

pub(crate) fn bucket_from_task_path(tasks_root: &Path, path: &Path) -> Result<TaskBucket, String> {
    let rel = path
        .strip_prefix(tasks_root)
        .map_err(|_| "task_not_under_tasks_root".to_string())?;
    let Some(Component::Normal(bucket_segment)) = rel.components().next() else {
        return Err("task_bucket_not_found".to_string());
    };
    TaskBucket::parse(&bucket_segment.to_string_lossy())
        .ok_or_else(|| "task_bucket_not_found".to_string())
}

fn bucket_from_rel_path(rel_path: &str) -> Option<TaskBucket> {
    rel_path
        .replace('\\', "/")
        .split('/')
        .find_map(TaskBucket::parse)
}

pub(crate) fn conflict_free_path(path: &Path) -> PathBuf {
    if !path.exists() {
        return path.to_path_buf();
    }
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("task");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("md");
    for index in 2..1000 {
        let candidate = parent.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    parent.join(format!("{stem}-{}.{}", Utc::now().timestamp(), extension))
}

fn serialize_task_note(
    frontmatter: &BTreeMap<String, JsonValue>,
    body: &str,
) -> Result<String, String> {
    let yaml = serde_yaml::to_string(frontmatter)
        .map_err(|err| format!("Cannot serialize task frontmatter: {err}"))?;
    let clean_body = body.trim_start_matches('\n');
    if clean_body.is_empty() {
        Ok(format!("---\n{yaml}---\n"))
    } else {
        Ok(format!("---\n{yaml}---\n{clean_body}"))
    }
}

fn default_status_for_bucket(bucket: TaskBucket) -> &'static str {
    match bucket {
        TaskBucket::Active | TaskBucket::Calendar => "active",
        TaskBucket::Backlog => "backlog",
        TaskBucket::Archive => "done",
    }
}

fn default_status_for_bucket_enum(bucket: TaskBucket) -> TaskStatus {
    match bucket {
        TaskBucket::Active | TaskBucket::Calendar => TaskStatus::Active,
        TaskBucket::Backlog => TaskStatus::Backlog,
        TaskBucket::Archive => TaskStatus::Done,
    }
}

fn rel_path_for(work: &Path, path: &Path) -> String {
    path.strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

pub(crate) fn yaml_to_json(value: &BTreeMap<String, YamlValue>) -> JsonValue {
    serde_json::to_value(value)
        .ok()
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()))
}

pub(crate) fn string_field(value: &JsonValue, key: &str) -> Option<String> {
    let item = value.get(key)?;
    if let Some(text) = item.as_str() {
        let trimmed = text.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }
    if item.is_number() || item.is_boolean() {
        return Some(item.to_string());
    }
    None
}

fn string_list_field(value: &JsonValue, key: &str) -> Vec<String> {
    let Some(item) = value.get(key) else {
        return Vec::new();
    };
    match item {
        JsonValue::Array(items) => items
            .iter()
            .filter_map(|value| value.as_str())
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        JsonValue::String(text) => text
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn scan_task_notes_reads_bucketed_markdown_only() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        let hidden = tmp.path().join("tasks/active/_generated");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&hidden).unwrap();
        fs::write(active.join("task.md"), "---\nstatus: active\n---\n# Task").unwrap();
        fs::write(active.join("task.txt"), "no").unwrap();
        fs::write(hidden.join("hidden.md"), "# Hidden").unwrap();

        let rows = scan_task_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].bucket, TaskBucket::Active);
        assert_eq!(rows[0].rel_path, "tasks/active/task.md");
        assert_eq!(rows[0].frontmatter["status"], json!("active"));
    }

    #[test]
    fn scan_task_notes_excludes_daily_journals() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        let daily = tmp.path().join("tasks/daily");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&daily).unwrap();
        fs::write(active.join("task.md"), "---\nstatus: active\n---\n# Task").unwrap();
        fs::write(daily.join("2026-07-21.md"), "# Today").unwrap();

        let rows = scan_task_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].rel_path, "tasks/active/task.md");
        // The path guard itself also rejects top-level `daily` segments.
        let root = tmp.path().join("tasks");
        assert!(!should_enter_task_path(&daily.join("2026-07-21.md"), &root));
        assert!(should_enter_task_path(&active.join("task.md"), &root));
    }

    #[test]
    fn scan_task_notes_rejects_root_escape() {
        let tmp = tempdir().unwrap();
        let outside = tempdir().unwrap();

        let err = scan_task_notes(
            tmp.path().to_string_lossy().to_string(),
            Some(outside.path().to_string_lossy().to_string()),
        )
        .unwrap_err();

        assert_eq!(err, "tasks_root_escapes_workspace");
    }

    #[test]
    fn read_task_metadata_returns_frontmatter_preview_and_tags() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\ntags:\n  - tasks\ntopics:\n  - maru\nstatus: active\n---\n# Body\n\nText",
        )
        .unwrap();

        let metadata = read_task_metadata(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
        )
        .unwrap();

        assert_eq!(metadata.tags, vec!["maru", "tasks"]);
        assert_eq!(metadata.frontmatter["status"], json!("active"));
        assert_eq!(metadata.body, "# Body\n\nText");
        assert!(metadata.preview.contains("# Body"));
        assert!(metadata.line_count > 0);
    }

    #[test]
    fn create_task_note_uses_conflict_safe_names() {
        let tmp = tempdir().unwrap();
        let mut frontmatter = BTreeMap::new();
        frontmatter.insert("priority".to_string(), json!("high"));
        let draft = CreateTaskDraft {
            slug: "demo".to_string(),
            title: "Demo".to_string(),
            frontmatter,
            body: "# Demo\n".to_string(),
            bucket: TaskBucket::Active,
        };

        let first = create_task_note(
            tmp.path().to_string_lossy().to_string(),
            draft.clone(),
            None,
        )
        .unwrap();
        let second =
            create_task_note(tmp.path().to_string_lossy().to_string(), draft, None).unwrap();

        assert_ne!(first.rel_path, second.rel_path);
        assert!(first.rel_path.starts_with("tasks/active/"));
        assert!(second.rel_path.ends_with("-2.md"));
    }

    #[test]
    fn update_task_status_patches_and_moves_done_to_archive() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\nstatus: active\npriority: high\n---\n# Body\n").unwrap();

        let row = update_task_status(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            TaskStatus::Done,
            None,
        )
        .unwrap();

        assert_eq!(row.bucket, TaskBucket::Archive);
        assert_eq!(row.rel_path, "tasks/archive/task.md");
        let raw = fs::read_to_string(tmp.path().join("tasks/archive/task.md")).unwrap();
        assert!(raw.contains("status: done"));
        assert!(raw.contains("priority: high"));
        assert!(raw.contains("# Body"));
    }

    #[test]
    fn update_task_schedule_fields_preserves_body_and_unrelated_frontmatter() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\nstatus: active\nowner: Luca\n---\n# Body\n\nKeep me.\n",
        )
        .unwrap();

        let row = update_task_schedule_fields(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            UpdateTaskScheduleFields {
                project: Some(Some("Maru".to_string())),
                priority: Some(Some("high".to_string())),
                due: Some(Some("2026-05-15".to_string())),
                calendar_start: Some(Some("2026-05-15T09:00".to_string())),
                calendar_end: Some(Some("2026-05-15T10:00".to_string())),
                estimate_minutes: Some(Some(60.0)),
            },
        )
        .unwrap();

        assert_eq!(row.rel_path, "tasks/active/task.md");
        let raw = fs::read_to_string(&note).unwrap();
        assert!(raw.contains("status: active"));
        assert!(raw.contains("owner: Luca"));
        assert!(raw.contains("project: Maru"));
        assert!(raw.contains("priority: high"));
        assert!(raw.contains("due: 2026-05-15"));
        assert!(raw.contains("calendarStart: \"2026-05-15T09:00\""));
        assert!(raw.contains("calendarEnd: \"2026-05-15T10:00\""));
        assert!(raw.contains("estimateMinutes: 60"));
        assert!(raw.contains("# Body\n\nKeep me."));
    }

    #[test]
    fn update_task_schedule_fields_rejects_path_escape() {
        let tmp = tempdir().unwrap();

        let err = update_task_schedule_fields(
            tmp.path().to_string_lossy().to_string(),
            "../outside.md".to_string(),
            UpdateTaskScheduleFields {
                project: Some(Some("Maru".to_string())),
                priority: None,
                due: None,
                calendar_start: None,
                calendar_end: None,
                estimate_minutes: None,
            },
        )
        .unwrap_err();

        assert!(err.contains("escapes") || err.contains("outside"));
    }

    #[test]
    fn update_task_schedule_fields_removes_empty_or_null_fields() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\nproject: Maru\ndue: 2026-05-15\ncalendarStart: 2026-05-15T09:00\nestimateMinutes: 45\n---\n# Body\n",
        )
        .unwrap();

        update_task_schedule_fields(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            UpdateTaskScheduleFields {
                project: Some(None),
                priority: None,
                due: Some(Some(" ".to_string())),
                calendar_start: Some(None),
                calendar_end: None,
                estimate_minutes: Some(None),
            },
        )
        .unwrap();

        let raw = fs::read_to_string(&note).unwrap();
        assert!(!raw.contains("project:"));
        assert!(!raw.contains("due:"));
        assert!(!raw.contains("calendarStart:"));
        assert!(!raw.contains("estimateMinutes:"));
        assert!(raw.contains("# Body"));
    }

    #[test]
    fn update_task_schedule_fields_rejects_unknown_fields() {
        let err = serde_json::from_value::<UpdateTaskScheduleFields>(json!({
            "project": "Maru",
            "unknown": "no",
        }))
        .unwrap_err();

        assert!(err.to_string().contains("unknown field"));
    }

    #[test]
    fn update_task_details_preserves_unrelated_frontmatter_and_replaces_body() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\ntitle: Old title\nstatus: active\n# keep this comment\nowner: Luca\ntags:\n  - keep\n---\n# Old\n\nKeep no.\n",
        )
        .unwrap();

        let row = update_task_details(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            UpdateTaskDetailsFields {
                title: Some("New title".to_string()),
                status: Some(TaskStatus::InProgress),
                project: Some(Some("Maru".to_string())),
                priority: Some(Some("high".to_string())),
                due: Some(Some("2026-05-15".to_string())),
                calendar_start: Some(Some("2026-05-15T09:00".to_string())),
                calendar_end: Some(Some("2026-05-15T10:00".to_string())),
                estimate_minutes: Some(Some(60.0)),
                body: Some("# New\n\nKeep yes.\n".to_string()),
            },
            None,
        )
        .unwrap();

        assert_eq!(row.rel_path, "tasks/active/task.md");
        let raw = fs::read_to_string(&note).unwrap();
        assert!(raw.contains("title: New title"));
        assert!(raw.contains("status: in-progress"));
        assert!(raw.contains("# keep this comment"));
        assert!(raw.contains("owner: Luca"));
        assert!(raw.contains("- keep"));
        assert!(raw.contains("project: Maru"));
        assert!(raw.contains("priority: high"));
        assert!(raw.contains("due: 2026-05-15"));
        assert!(raw.contains("calendarStart: \"2026-05-15T09:00\""));
        assert!(raw.contains("calendarEnd: \"2026-05-15T10:00\""));
        assert!(raw.contains("estimateMinutes: 60"));
        assert!(raw.ends_with("# New\n\nKeep yes.\n"));
        assert!(!raw.contains("# Old"));
    }

    #[test]
    fn update_task_details_moves_when_status_changes_bucket() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/active/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\ntitle: Task\nstatus: active\n---\n# Body\n").unwrap();

        let row = update_task_details(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            UpdateTaskDetailsFields {
                title: None,
                status: Some(TaskStatus::Done),
                project: None,
                priority: None,
                due: None,
                calendar_start: None,
                calendar_end: None,
                estimate_minutes: None,
                body: Some("# Done body\n".to_string()),
            },
            None,
        )
        .unwrap();

        assert_eq!(row.bucket, TaskBucket::Archive);
        assert_eq!(row.rel_path, "tasks/archive/task.md");
        assert!(!note.exists());
        let raw = fs::read_to_string(tmp.path().join("tasks/archive/task.md")).unwrap();
        assert!(raw.contains("status: done"));
        assert!(raw.ends_with("# Done body\n"));
    }

    #[test]
    fn update_task_details_does_not_move_calendar_when_status_is_unchanged() {
        let tmp = tempdir().unwrap();
        let note = tmp.path().join("tasks/calendar/task.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\ntitle: Task\nstatus: active\n---\n# Body\n").unwrap();

        let row = update_task_details(
            tmp.path().to_string_lossy().to_string(),
            "tasks/calendar/task.md".to_string(),
            UpdateTaskDetailsFields {
                title: Some("Task edited".to_string()),
                status: Some(TaskStatus::Active),
                project: None,
                priority: None,
                due: None,
                calendar_start: None,
                calendar_end: None,
                estimate_minutes: None,
                body: None,
            },
            None,
        )
        .unwrap();

        assert_eq!(row.bucket, TaskBucket::Calendar);
        assert_eq!(row.rel_path, "tasks/calendar/task.md");
        assert!(note.exists());
    }

    #[test]
    fn update_task_details_rejects_path_escape() {
        let tmp = tempdir().unwrap();

        let err = update_task_details(
            tmp.path().to_string_lossy().to_string(),
            "../outside.md".to_string(),
            UpdateTaskDetailsFields {
                title: Some("Maru".to_string()),
                status: None,
                project: None,
                priority: None,
                due: None,
                calendar_start: None,
                calendar_end: None,
                estimate_minutes: None,
                body: None,
            },
            None,
        )
        .unwrap_err();

        assert!(err.contains("escapes") || err.contains("outside"));
    }

    #[test]
    fn move_task_note_uses_conflict_safe_target() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        let backlog = tmp.path().join("tasks/backlog");
        fs::create_dir_all(&active).unwrap();
        fs::create_dir_all(&backlog).unwrap();
        fs::write(active.join("task.md"), "# A").unwrap();
        fs::write(backlog.join("task.md"), "# B").unwrap();

        let row = move_task_note(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
            TaskBucket::Backlog,
            None,
        )
        .unwrap();

        assert_eq!(row.rel_path, "tasks/backlog/task-2.md");
    }

    #[test]
    fn move_task_note_uses_bucket_relative_to_tasks_root() {
        let tmp = tempdir().unwrap();
        let task = tmp
            .path()
            .join("work/active/tasks/active/project/active/task.md");
        fs::create_dir_all(task.parent().unwrap()).unwrap();
        fs::write(&task, "---\nstatus: active\n---\n# A").unwrap();

        let row = move_task_note(
            tmp.path().to_string_lossy().to_string(),
            "work/active/tasks/active/project/active/task.md".to_string(),
            TaskBucket::Archive,
            Some("work/active/tasks".to_string()),
        )
        .unwrap();

        assert_eq!(
            row.rel_path,
            "work/active/tasks/archive/project/active/task.md",
        );
        assert!(tmp
            .path()
            .join("work/active/tasks/archive/project/active/task.md")
            .exists());
    }

    #[test]
    fn task_log_round_trips_structured_lines() {
        let tmp = tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        append_tasks_log(
            work.clone(),
            "- 2026-05-14T08:00:00Z [sync] {\"runId\":\"r1\",\"status\":\"completed\",\"skill\":\"task-management\",\"target\":\"tasks/active/task.md\"}".to_string(),
        )
        .unwrap();

        let rows = read_tasks_log(work, None, None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].event, "sync");
        assert_eq!(rows[0].run_id.as_deref(), Some("r1"));
        assert_eq!(rows[0].skill.as_deref(), Some("task-management"));
    }

    #[test]
    fn parse_task_status_accepts_legacy_open_alias() {
        assert_eq!(parse_task_status("open"), Some(TaskStatus::Active));
        assert_eq!(parse_task_status("Open"), Some(TaskStatus::Active));
        assert_eq!(parse_task_status("OPEN"), Some(TaskStatus::Active));
        // Canonical values unchanged. These five are exactly what the Maru
        // web app writes (issue #232 work item 6), so no alias work is owed
        // for web-originated task notes.
        assert_eq!(parse_task_status("active"), Some(TaskStatus::Active));
        assert_eq!(
            parse_task_status("In_Progress"),
            Some(TaskStatus::InProgress)
        );
        assert_eq!(
            parse_task_status("in-progress"),
            Some(TaskStatus::InProgress)
        );
        assert_eq!(parse_task_status("done"), Some(TaskStatus::Done));
        assert_eq!(parse_task_status("cancelled"), Some(TaskStatus::Cancelled));
        assert_eq!(parse_task_status("backlog"), Some(TaskStatus::Backlog));
        assert_eq!(parse_task_status("bogus"), None);
    }

    #[test]
    fn scan_rows_normalize_scalar_and_list_project_aliases() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        fs::create_dir_all(&active).unwrap();
        fs::write(
            active.join("task.md"),
            "---\nstatus: open\nprojects:\n  - alpha\n  - beta\n---\n# Task",
        )
        .unwrap();
        fs::write(
            active.join("scalar.md"),
            "---\nstatus: active\nprojects: gamma\n---\n# Scalar project",
        )
        .unwrap();

        let rows = scan_task_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 2);
        let list = rows.iter().find(|row| row.file_name == "task.md").unwrap();
        let scalar = rows
            .iter()
            .find(|row| row.file_name == "scalar.md")
            .unwrap();
        assert_eq!(list.frontmatter["project"], json!("alpha"));
        assert_eq!(scalar.frontmatter["project"], json!("gamma"));
        // Original alias key stays untouched; writers never see `project` here.
        assert!(list.frontmatter["projects"].is_array());
        assert_eq!(scalar.frontmatter["projects"], json!("gamma"));
    }

    #[test]
    fn scan_rows_use_title_name_h1_then_filename_for_display() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        fs::create_dir_all(&active).unwrap();
        fs::write(
            active.join("title.md"),
            "---\ntitle: Frontmatter title\nname: Name\n---\n# Heading",
        )
        .unwrap();
        fs::write(
            active.join("name.md"),
            "---\nname: Frontmatter name\n---\n# Heading",
        )
        .unwrap();
        fs::write(
            active.join("heading.md"),
            "---\nstatus: active\n---\n# Body heading",
        )
        .unwrap();
        fs::write(
            active.join("filename-only.md"),
            "---\nstatus: active\n---\nBody",
        )
        .unwrap();

        let rows = scan_task_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();
        let titles = rows
            .into_iter()
            .map(|row| (row.file_name, row.display_title))
            .collect::<BTreeMap<_, _>>();
        assert_eq!(titles["title.md"], "Frontmatter title");
        assert_eq!(titles["name.md"], "Frontmatter name");
        assert_eq!(titles["heading.md"], "Body heading");
        assert_eq!(titles["filename-only.md"], "filename-only");
    }

    #[test]
    fn metadata_normalizes_completion_aliases_without_inventing_dates() {
        let tmp = tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        let dir = tmp.path().join("tasks/archive");
        fs::create_dir_all(&dir).unwrap();

        let cases = [
            ("completed", "completed: 2026-07-01", "2026-07-01"),
            ("completedAt", "completedAt: 2026-07-02", "2026-07-02"),
            ("completed_at", "completed_at: 2026-07-03", "2026-07-03"),
            ("dateCompleted", "dateCompleted: 2026-07-04", "2026-07-04"),
        ];
        for (name, field, expected) in cases {
            fs::write(
                dir.join(format!("{name}.md")),
                format!("---\nstatus: done\n{field}\n---\n# Task"),
            )
            .unwrap();
            let metadata =
                read_task_metadata(work.clone(), format!("tasks/archive/{name}.md")).unwrap();
            assert_eq!(
                metadata.frontmatter["completedAt"],
                json!(expected),
                "alias {name}"
            );
        }

        // Canonical `done` date stays canonical; no completedAt is invented.
        fs::write(
            dir.join("done-only.md"),
            "---\nstatus: done\ndone: 2026-07-05\n---\n# Task",
        )
        .unwrap();
        let metadata =
            read_task_metadata(work.clone(), "tasks/archive/done-only.md".to_string()).unwrap();
        assert_eq!(metadata.frontmatter["done"], json!("2026-07-05"));
        assert!(metadata.frontmatter.get("completedAt").is_none());

        // Boolean `completed: true` carries no date — none is invented.
        fs::write(
            dir.join("flag.md"),
            "---\nstatus: done\ncompleted: true\n---\n# Task",
        )
        .unwrap();
        let metadata = read_task_metadata(work, "tasks/archive/flag.md".to_string()).unwrap();
        assert!(metadata.frontmatter.get("completedAt").is_none());
    }
}

/// IPC owns inputs; all filesystem work and admission waits run inside workers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn scan_task_notes(
        work_path: String,
        root: Option<String>,
    ) -> Result<Vec<TaskNoteRow>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scan_task_notes",
            );
            super::scan_task_notes(work_path, root)
        })
        .await
        .map_err(|err| format!("scan_task_notes_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn read_task_metadata(
        work_path: String,
        rel_path: String,
    ) -> Result<TaskMetadata, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_task_metadata",
            );
            super::read_task_metadata(work_path, rel_path)
        })
        .await
        .map_err(|err| format!("read_task_metadata_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn create_task_note(
        work_path: String,
        draft: CreateTaskDraft,
        root: Option<String>,
    ) -> Result<TaskNoteRow, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:create_task_note",
            );
            super::create_task_note(work_path, draft, root)
        })
        .await
        .map_err(|err| format!("create_task_note_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn update_task_status(
        work_path: String,
        rel_path: String,
        status: TaskStatus,
        root: Option<String>,
    ) -> Result<TaskNoteRow, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:update_task_status",
            );
            super::update_task_status(work_path, rel_path, status, root)
        })
        .await
        .map_err(|err| format!("update_task_status_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn update_task_schedule_fields(
        work_path: String,
        rel_path: String,
        fields: UpdateTaskScheduleFields,
    ) -> Result<TaskNoteRow, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:update_task_schedule_fields",
            );
            super::update_task_schedule_fields(work_path, rel_path, fields)
        })
        .await
        .map_err(|err| format!("update_task_schedule_fields_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn update_task_details(
        work_path: String,
        rel_path: String,
        fields: UpdateTaskDetailsFields,
        root: Option<String>,
    ) -> Result<TaskNoteRow, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:update_task_details",
            );
            super::update_task_details(work_path, rel_path, fields, root)
        })
        .await
        .map_err(|err| format!("update_task_details_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn move_task_note(
        work_path: String,
        rel_path: String,
        target_bucket: TaskBucket,
        root: Option<String>,
    ) -> Result<TaskNoteRow, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:move_task_note");
            super::move_task_note(work_path, rel_path, target_bucket, root)
        })
        .await
        .map_err(|err| format!("move_task_note_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn append_tasks_log(work_path: String, line: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:append_tasks_log",
            );
            super::append_tasks_log(work_path, line)
        })
        .await
        .map_err(|err| format!("append_tasks_log_task_failed: {err}"))?
    }
    #[tauri::command]
    pub async fn read_tasks_log(
        work_path: String,
        limit: Option<usize>,
        event_filter: Option<Vec<String>>,
    ) -> Result<Vec<TasksLogLine>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            PathTransactionLease::test_stage(&[PathBuf::from(&work_path)], "worker:read_tasks_log");
            super::read_tasks_log(work_path, limit, event_filter)
        })
        .await
        .map_err(|err| format!("read_tasks_log_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_09 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use crate::atomic_file::PathTransactionTestHook;
    use crate::scratchpad::phase08_08::registry;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        mpsc,
    };
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }
    fn fixture(home: &Home) -> tempfile::TempDir {
        let temp = tempfile::tempdir_in(home.root.path()).unwrap();
        fs::create_dir_all(temp.path().join("tasks/active")).unwrap();
        fs::create_dir_all(temp.path().join(".maru")).unwrap();
        fs::write(
            temp.path().join("tasks/active/task.md"),
            "---\ntitle: Original\nstatus: active\ncustom: preserved\n---\n# Original\n",
        )
        .unwrap();
        temp
    }
    fn draft() -> CreateTaskDraft {
        CreateTaskDraft {
            slug: "fixture".into(),
            title: "Fixture".into(),
            frontmatter: BTreeMap::new(),
            body: "# Created".into(),
            bucket: TaskBucket::Active,
        }
    }
    fn schedule() -> UpdateTaskScheduleFields {
        UpdateTaskScheduleFields {
            project: Some(Some("project".into())),
            priority: None,
            due: None,
            calendar_start: Some(Some("2026-09-05T10:00".into())),
            calendar_end: None,
            estimate_minutes: Some(Some(30.0)),
        }
    }
    fn details() -> UpdateTaskDetailsFields {
        UpdateTaskDetailsFields {
            title: Some("Changed".into()),
            status: None,
            project: None,
            priority: None,
            due: None,
            calendar_start: None,
            calendar_end: None,
            estimate_minutes: None,
            body: Some("# Changed".into()),
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
            .expect("bounded task completion")
    }
    async fn mutate(operation: &'static str, work: String) -> Result<(), String> {
        match operation {
            "create" => ipc::create_task_note(work, draft(), None).await.map(|_| ()),
            "status" => {
                ipc::update_task_status(work, "tasks/active/task.md".into(), TaskStatus::Done, None)
                    .await
                    .map(|_| ())
            }
            "schedule" => {
                ipc::update_task_schedule_fields(work, "tasks/active/task.md".into(), schedule())
                    .await
                    .map(|_| ())
            }
            "details" => {
                ipc::update_task_details(work, "tasks/active/task.md".into(), details(), None)
                    .await
                    .map(|_| ())
            }
            "move" => ipc::move_task_note(
                work,
                "tasks/active/task.md".into(),
                TaskBucket::Backlog,
                None,
            )
            .await
            .map(|_| ()),
            "log" => {
                ipc::append_tasks_log(
                    work,
                    "2026-09-05T10:00:00Z [DONE] {\"target\":\"fixture\"}".into(),
                )
                .await
            }
            _ => unreachable!(),
        }
    }
    fn key(root: &Path, op: &str) -> PathBuf {
        match op {
            "create" => root.join("tasks/active"),
            "log" => root.join(".maru/tasks-log.md"),
            _ => root.join("tasks/active/task.md"),
        }
    }

    #[test]
    fn phase08_09_tasks_all_nine_wrappers_yield_on_same_polling_task() {
        let home = Home::new();
        let root = home.root.path();
        let w = text(root);
        boundary(
            root.into(),
            "scan_task_notes",
            ipc::scan_task_notes(w.clone(), None),
        );
        boundary(
            root.into(),
            "read_task_metadata",
            ipc::read_task_metadata(w.clone(), "tasks/active/task.md".into()),
        );
        boundary(
            root.into(),
            "create_task_note",
            ipc::create_task_note(w.clone(), draft(), None),
        );
        boundary(
            root.into(),
            "update_task_status",
            ipc::update_task_status(
                w.clone(),
                "tasks/active/task.md".into(),
                TaskStatus::Done,
                None,
            ),
        );
        boundary(
            root.into(),
            "update_task_schedule_fields",
            ipc::update_task_schedule_fields(w.clone(), "tasks/active/task.md".into(), schedule()),
        );
        boundary(
            root.into(),
            "update_task_details",
            ipc::update_task_details(w.clone(), "tasks/active/task.md".into(), details(), None),
        );
        boundary(
            root.into(),
            "move_task_note",
            ipc::move_task_note(
                w.clone(),
                "tasks/active/task.md".into(),
                TaskBucket::Backlog,
                None,
            ),
        );
        boundary(
            root.into(),
            "append_tasks_log",
            ipc::append_tasks_log(w.clone(), "fixture".into()),
        );
        boundary(
            root.into(),
            "read_tasks_log",
            ipc::read_tasks_log(w, Some(10), None),
        );
    }
    #[test]
    fn phase08_09_tasks_real_payloads_schedule_transition_and_legacy_errors() {
        let home = Home::new();
        let tmp = fixture(&home);
        let w = text(tmp.path());
        assert_eq!(run(ipc::scan_task_notes(w.clone(), None)).unwrap().len(), 1);
        let row = run(ipc::create_task_note(w.clone(), draft(), None)).unwrap();
        assert_eq!(row.frontmatter["title"], "Fixture");
        let row2 = run(ipc::create_task_note(w.clone(), draft(), None)).unwrap();
        assert_ne!(row.rel_path, row2.rel_path);
        run(mutate("schedule", w.clone())).unwrap();
        run(mutate("details", w.clone())).unwrap();
        let meta = run(ipc::read_task_metadata(
            w.clone(),
            "tasks/active/task.md".into(),
        ))
        .unwrap();
        assert_eq!(meta.frontmatter["custom"], "preserved");
        assert_eq!(meta.frontmatter["project"], "project");
        assert_eq!(meta.frontmatter["estimateMinutes"], 30.0);
        assert!(meta.body.contains("Changed"));
        let moved = run(ipc::update_task_status(
            w.clone(),
            "tasks/active/task.md".into(),
            TaskStatus::Done,
            None,
        ))
        .unwrap();
        assert_eq!(moved.bucket, TaskBucket::Archive);
        assert_eq!(moved.frontmatter["status"], "done");
        let moved = run(ipc::move_task_note(
            w.clone(),
            moved.rel_path,
            TaskBucket::Backlog,
            None,
        ))
        .unwrap();
        assert_eq!(moved.bucket, TaskBucket::Backlog);
        run(mutate("log", w.clone())).unwrap();
        let logs = run(ipc::read_tasks_log(
            w.clone(),
            Some(1),
            Some(vec!["DONE".into()]),
        ))
        .unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].target.as_deref(), Some("fixture"));
        assert_eq!(
            run(ipc::scan_task_notes(w.clone(), Some("../escape".into()))).unwrap_err(),
            "tasks_root_escapes_workspace"
        );
        let bad = UpdateTaskDetailsFields {
            title: Some(" ".into()),
            ..details()
        };
        assert_eq!(
            run(ipc::update_task_details(w, moved.rel_path, bad, None)).unwrap_err(),
            "task_title_required"
        );
    }
    #[test]
    fn phase08_09_tasks_every_writer_same_target_contention_and_unwind_release() {
        let home = Home::new();
        for op in ["create", "status", "schedule", "details", "move", "log"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let w = text(root);
            let k = key(root, op);
            let held = Held::new(k.clone(), "admitted");
            let first = start(mutate(op, w.clone()));
            held.wait();
            let waiting = Held::new(k.clone(), "before-admission");
            let second = start(mutate(op, w));
            waiting.wait();
            waiting.release();
            assert!(
                second.recv_timeout(Duration::from_millis(30)).is_err(),
                "{op}"
            );
            let once = AtomicBool::new(false);
            let injection = PathTransactionTestHook::new(k, "pre-effect", move || {
                if !once.swap(true, Ordering::SeqCst) {
                    panic!("fixture transaction failure");
                }
            });
            held.release();
            assert!(done(first).unwrap_err().contains("_task_failed:"));
            done(second).unwrap();
            drop(injection);
            match op {
                "create" => assert_eq!(fs::read_dir(root.join("tasks/active")).unwrap().count(), 2),
                "status" => assert!(root.join("tasks/archive/task.md").is_file()),
                "move" => assert!(root.join("tasks/backlog/task.md").is_file()),
                "log" => assert_eq!(
                    fs::read_to_string(root.join(".maru/tasks-log.md"))
                        .unwrap()
                        .lines()
                        .count(),
                    1
                ),
                _ => assert!(root.join("tasks/active/task.md").is_file()),
            }
        }
    }
    #[test]
    fn phase08_09_tasks_every_writer_production_policy_rechecked_after_admission() {
        let home = Home::new();
        for op in ["create", "status", "schedule", "details", "move", "log"] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let w = text(root);
            registry(root, "direct");
            let before = fs::read(root.join("tasks/active/task.md")).unwrap();
            let held = Held::new(key(root, op), "admitted");
            let first = start(mutate(op, w.clone()));
            held.wait();
            registry(root, "readOnly");
            held.release();
            assert!(
                done(first)
                    .unwrap_err()
                    .contains("Workspace writes are blocked"),
                "{op}"
            );
            assert_eq!(fs::read(root.join("tasks/active/task.md")).unwrap(), before);
            assert!(!root.join(".maru/tasks-log.md").exists());
            registry(root, "direct");
            run(mutate(op, w)).unwrap();
        }
    }
    #[cfg(unix)]
    #[test]
    fn phase08_09_tasks_and_meetings_workspace_alias_cannot_bypass_write_policy() {
        let home = Home::new();
        let tmp = fixture(&home);
        let alias = home.root.path().join("work-alias");
        std::os::unix::fs::symlink(tmp.path(), &alias).unwrap();
        for reverse in [false, true] {
            for policy in ["readOnly", "delegated"] {
                let (registered, caller) = if reverse {
                    (alias.as_path(), tmp.path())
                } else {
                    (tmp.path(), alias.as_path())
                };
                registry(registered, policy);
                for op in ["create", "status", "schedule", "details", "move", "log"] {
                    assert!(
                        run(mutate(op, text(caller)))
                            .unwrap_err()
                            .contains("Workspace writes are blocked"),
                        "{op} {policy} reverse={reverse}"
                    );
                }
                assert!(run(crate::meetings::ipc::append_meetings_log(
                    text(caller),
                    "denied".into()
                ))
                .unwrap_err()
                .contains("Workspace writes are blocked"));
            }
        }
        assert_eq!(
            fs::read_dir(tmp.path().join("tasks/active"))
                .unwrap()
                .count(),
            1
        );
        assert!(!tmp.path().join(".maru/tasks-log.md").exists());
        assert!(!tmp.path().join(".maru/meetings-log.md").exists());
        // Duplicate registry spellings must not let direct policy hide denial.
        registry(tmp.path(), "direct");
        let registry_path = crate::vault_list::workspace_registry_path().unwrap();
        let mut document: serde_json::Value =
            serde_json::from_slice(&fs::read(&registry_path).unwrap()).unwrap();
        document["workspaces"].as_array_mut().unwrap().push(serde_json::json!({"label":"Alias", "path":text(&alias), "visibility":"private", "provider":"local", "writePolicy":"readOnly"}));
        fs::write(&registry_path, document.to_string()).unwrap();
        assert!(run(mutate("create", text(tmp.path())))
            .unwrap_err()
            .contains("Workspace writes are blocked"));
        assert!(run(crate::meetings::ipc::append_meetings_log(
            text(&alias),
            "denied".into()
        ))
        .is_err());
        registry(&alias, "direct");
        run(mutate("create", text(tmp.path()))).unwrap();
        run(crate::meetings::ipc::append_meetings_log(
            text(&alias),
            "allowed".into(),
        ))
        .unwrap();
    }

    #[test]
    fn phase08_09_tasks_all_writers_files_parent_both_orders_aliases() {
        let home = Home::new();
        for op in ["create", "status", "schedule", "details", "move", "log"] {
            for parent_first in [false, true] {
                for alias in [false, true] {
                    let tmp = fixture(&home);
                    let root = tmp.path().to_path_buf();
                    let w = text(&root);
                    let parent = root.parent().unwrap();
                    let mut parent_w = text(parent);
                    let source = text(&root);
                    #[cfg(unix)]
                    if alias {
                        let alias_path = parent.join(format!(
                            "alias-{}",
                            root.file_name().unwrap().to_string_lossy()
                        ));
                        std::os::unix::fs::symlink(parent, &alias_path).unwrap();
                        parent_w = text(&alias_path);
                    }
                    let new_name = format!("moved-{}", root.file_name().unwrap().to_string_lossy());
                    let moved = parent.join(&new_name);
                    if parent_first {
                        let held = Held::new(root.clone(), "admitted");
                        let first = start(crate::workspace_files::ipc::rename_workspace_entry(
                            parent_w, source, new_name,
                        ));
                        held.wait();
                        let waiting = Held::new(key(&root, op), "before-admission");
                        let second = start(mutate(op, w));
                        waiting.wait();
                        waiting.release();
                        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        done(first).unwrap();
                        assert!(done(second).is_err(), "{op}");
                        assert!(!root.exists());
                    } else {
                        let held = Held::new(key(&root, op), "admitted");
                        let first = start(mutate(op, w));
                        held.wait();
                        let waiting = Held::new(root.clone(), "before-admission");
                        let second = start(crate::workspace_files::ipc::rename_workspace_entry(
                            parent_w, source, new_name,
                        ));
                        waiting.wait();
                        waiting.release();
                        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                        held.release();
                        done(first).unwrap();
                        done(second).unwrap();
                        assert!(!root.exists());
                        match op {
                            "status" => assert!(moved.join("tasks/archive/task.md").is_file()),
                            "move" => assert!(moved.join("tasks/backlog/task.md").is_file()),
                            "log" => assert!(moved.join(".maru/tasks-log.md").is_file()),
                            _ => assert!(moved.join("tasks/active/task.md").is_file()),
                        }
                    }
                }
            }
        }
    }
    #[test]
    fn phase08_09_tasks_document_save_order_and_typed_error_release() {
        let home = Home::new();
        for task_first in [false, true] {
            let tmp = fixture(&home);
            let root = tmp.path();
            let w = text(root);
            let path = root.join("tasks/active/task.md");
            let original = fs::read_to_string(&path).unwrap();
            let revision = revision_for(&original);
            if task_first {
                let held = Held::new(path.clone(), "admitted");
                let first = start(mutate("schedule", w.clone()));
                held.wait();
                let waiting = Held::new(path.clone(), "before-admission");
                let second = start(crate::document::ipc::save_document(
                    w.clone(),
                    text(&path),
                    "editor".into(),
                    Some(revision),
                ));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                let error = done(second).unwrap_err();
                assert_eq!(error.code, crate::ipc_error::DOCUMENT_CONFLICT);
            } else {
                let held = Held::new(path.clone(), "admitted");
                let first = start(crate::document::ipc::save_document(
                    w.clone(),
                    text(&path),
                    original.replace("Original", "Editor"),
                    Some(revision),
                ));
                held.wait();
                let waiting = Held::new(path.clone(), "before-admission");
                let second = start(mutate("schedule", w.clone()));
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                let result = fs::read_to_string(&path).unwrap();
                assert!(result.contains("Editor"));
                assert!(result.contains("project: project"));
            }
            run(mutate("details", w)).unwrap();
        }
    }
    #[test]
    fn phase08_09_tasks_capture_preparation_is_read_only_and_parent_snapshot_survives() {
        let home = Home::new();
        let root = home.root.path().join("capture");
        fs::create_dir(&root).unwrap();
        let prepared =
            prepare_capture_task_materialization(&root, "2026-09-05", "capture-id", draft())
                .unwrap();
        assert!(!root.join("tasks").exists());
        fs::rename(&root, home.root.path().join("old")).unwrap();
        fs::create_dir(&root).unwrap();
        assert!(materialize_capture_task(&root, &prepared).is_err());
        assert!(!root.join("tasks").exists());
        let prepared =
            prepare_capture_task_materialization(&root, "2026-09-05", "capture-id", draft())
                .unwrap();
        let first = materialize_capture_task(&root, &prepared).unwrap();
        assert!(first.created);
        let second = materialize_capture_task(&root, &prepared).unwrap();
        assert!(!second.created);
        assert_eq!(first.row.rel_path, second.row.rel_path);
    }
}
