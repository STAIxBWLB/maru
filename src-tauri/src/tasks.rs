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

    fn parse(value: &str) -> Option<Self> {
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

#[tauri::command]
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

#[tauri::command]
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

#[tauri::command]
pub fn create_task_note(
    work_path: String,
    draft: CreateTaskDraft,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Create)?;
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

#[tauri::command]
pub fn update_task_status(
    work_path: String,
    rel_path: String,
    status: TaskStatus,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
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
    if updated != original {
        fs::write(&path, &updated).map_err(|err| format!("Cannot update task status: {err}"))?;
    }
    let target_bucket = status.target_bucket();
    let current_bucket = bucket_from_task_path(&tasks_root, &path)?;
    if current_bucket == target_bucket {
        return task_row_for_path(&work, &path, current_bucket);
    }
    assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    let target = conflict_free_path(&target_path_for_bucket(&tasks_root, &path, target_bucket)?);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create task target: {err}"))?;
    }
    fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))?;
    task_row_for_path(&work, &target, target_bucket)
}

#[tauri::command]
pub fn update_task_schedule_fields(
    work_path: String,
    rel_path: String,
    fields: UpdateTaskScheduleFields,
) -> Result<TaskNoteRow, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
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

#[tauri::command]
pub fn update_task_details(
    work_path: String,
    rel_path: String,
    fields: UpdateTaskDetailsFields,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::Modify)?;
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

    if updated != original {
        fs::write(&path, &updated).map_err(|err| format!("Cannot update task details: {err}"))?;
    }

    let target_bucket = target_status.target_bucket();
    if fields.status.is_some() && target_status != current_status && current_bucket != target_bucket
    {
        assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
        let target =
            conflict_free_path(&target_path_for_bucket(&tasks_root, &path, target_bucket)?);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("Cannot create task target: {err}"))?;
        }
        fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))?;
        return task_row_for_path(&work, &target, target_bucket);
    }

    task_row_for_path(&work, &path, current_bucket)
}

#[tauri::command]
pub fn move_task_note(
    work_path: String,
    rel_path: String,
    target_bucket: TaskBucket,
    root: Option<String>,
) -> Result<TaskNoteRow, String> {
    assert_maru_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
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

#[tauri::command]
pub fn append_tasks_log(work_path: String, line: String) -> Result<(), String> {
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

#[tauri::command]
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
        .min(TASKS_LOG_MAX_LIMIT)
        .max(1);
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
    Ok(TaskNoteRow {
        path: path.to_string_lossy().to_string(),
        rel_path: rel_path.clone(),
        file_name: path
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or(&rel_path)
            .to_string(),
        bucket,
        size_bytes: metadata.len(),
        updated_at: metadata
            .modified()
            .ok()
            .map(DateTime::<Utc>::from)
            .map(|value| value.to_rfc3339()),
        frontmatter: normalize_task_frontmatter_aliases(yaml_to_json(&parts.meta)),
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
        if let Some(first) = map
            .get("projects")
            .and_then(JsonValue::as_array)
            .and_then(|items| {
                items
                    .iter()
                    .filter_map(JsonValue::as_str)
                    .map(str::trim)
                    .find(|value| !value.is_empty())
            })
        {
            map.insert(
                "project".to_string(),
                JsonValue::String(first.to_string()),
            );
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
        // Canonical values unchanged.
        assert_eq!(parse_task_status("active"), Some(TaskStatus::Active));
        assert_eq!(parse_task_status("In_Progress"), Some(TaskStatus::InProgress));
        assert_eq!(parse_task_status("bogus"), None);
    }

    #[test]
    fn scan_rows_normalize_legacy_projects_alias_to_first_entry() {
        let tmp = tempdir().unwrap();
        let active = tmp.path().join("tasks/active");
        fs::create_dir_all(&active).unwrap();
        fs::write(
            active.join("task.md"),
            "---\nstatus: open\nprojects:\n  - alpha\n  - beta\n---\n# Task",
        )
        .unwrap();

        let rows = scan_task_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].frontmatter["project"], json!("alpha"));
        // Original alias key stays untouched; writers never see `project` here.
        assert!(rows[0].frontmatter["projects"].is_array());
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
        fs::write(dir.join("done-only.md"), "---\nstatus: done\ndone: 2026-07-05\n---\n# Task")
            .unwrap();
        let metadata =
            read_task_metadata(work.clone(), "tasks/archive/done-only.md".to_string()).unwrap();
        assert_eq!(metadata.frontmatter["done"], json!("2026-07-05"));
        assert!(metadata.frontmatter.get("completedAt").is_none());

        // Boolean `completed: true` carries no date — none is invented.
        fs::write(dir.join("flag.md"), "---\nstatus: done\ncompleted: true\n---\n# Task").unwrap();
        let metadata = read_task_metadata(work, "tasks/archive/flag.md".to_string()).unwrap();
        assert!(metadata.frontmatter.get("completedAt").is_none());
    }
}
