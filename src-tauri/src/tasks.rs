use crate::frontmatter::{update_frontmatter_content, FrontmatterValue};
use crate::vault::{
    lexical_normalize, normalize_existing_dir, parse_frontmatter, resolve_inside_vault, slugify,
};
use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};
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
    fn as_str(self) -> &'static str {
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
    let frontmatter_json = yaml_to_json(&parts.meta);
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
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::Create)?;
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
) -> Result<TaskNoteRow, String> {
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::Modify)?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
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
    let current_bucket = bucket_from_rel_path(&rel_path).unwrap_or(TaskBucket::Active);
    if current_bucket == target_bucket {
        return task_row_for_path(&work, &path, current_bucket);
    }
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    let target = conflict_free_path(&target_path_for_bucket(&work, &rel_path, target_bucket)?);
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
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::Modify)?;
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
pub fn move_task_note(
    work_path: String,
    rel_path: String,
    target_bucket: TaskBucket,
) -> Result<TaskNoteRow, String> {
    assert_anchor_can_write(&work_path, WorkspaceWriteAction::RenameMove)?;
    let work = normalize_existing_dir(&work_path)?;
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let current_bucket = bucket_from_rel_path(&rel_path).unwrap_or(TaskBucket::Active);
    if current_bucket == target_bucket {
        return task_row_for_path(&work, &path, current_bucket);
    }
    let target = conflict_free_path(&target_path_for_bucket(&work, &rel_path, target_bucket)?);
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|err| format!("Cannot create task target: {err}"))?;
    }
    fs::rename(&path, &target).map_err(|err| format!("Cannot move task note: {err}"))?;
    task_row_for_path(&work, &target, target_bucket)
}

#[tauri::command]
pub fn append_tasks_log(work_path: String, line: String) -> Result<(), String> {
    let work = normalize_existing_dir(&work_path)?;
    let log_path = work.join(".anchor").join("tasks-log.md");
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
    let log_path = work.join(".anchor").join("tasks-log.md");
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
        frontmatter: yaml_to_json(&parts.meta),
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
    !rel.components().any(|component| {
        matches!(component, Component::Normal(value) if {
            let segment = value.to_string_lossy();
            segment.starts_with('.') || segment.starts_with('_')
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

fn resolve_tasks_root(work: &Path, raw: &str) -> Result<PathBuf, String> {
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

fn target_path_for_bucket(
    work: &Path,
    rel_path: &str,
    target_bucket: TaskBucket,
) -> Result<PathBuf, String> {
    let parts = rel_path
        .replace('\\', "/")
        .split('/')
        .filter(|part| !part.is_empty())
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let Some(bucket_index) = parts
        .iter()
        .position(|part| TaskBucket::parse(part).is_some())
    else {
        return Err("task_bucket_not_found".to_string());
    };
    let file_name = parts
        .last()
        .ok_or_else(|| "task_file_name_missing".to_string())?;
    let mut target = work.to_path_buf();
    for part in &parts[..bucket_index] {
        target.push(part);
    }
    target.push(target_bucket.as_str());
    for part in &parts[bucket_index + 1..parts.len().saturating_sub(1)] {
        target.push(part);
    }
    target.push(file_name);
    let normalized = lexical_normalize(&target);
    if normalized.starts_with(work) {
        Ok(normalized)
    } else {
        Err("task_target_escapes_workspace".to_string())
    }
}

fn bucket_from_rel_path(rel_path: &str) -> Option<TaskBucket> {
    rel_path
        .replace('\\', "/")
        .split('/')
        .find_map(TaskBucket::parse)
}

fn conflict_free_path(path: &Path) -> PathBuf {
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

fn rel_path_for(work: &Path, path: &Path) -> String {
    path.strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

fn yaml_to_json(value: &BTreeMap<String, YamlValue>) -> JsonValue {
    serde_json::to_value(value)
        .ok()
        .filter(JsonValue::is_object)
        .unwrap_or_else(|| JsonValue::Object(JsonMap::new()))
}

fn string_field(value: &JsonValue, key: &str) -> Option<String> {
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
            "---\ntags:\n  - tasks\ntopics:\n  - anchor\nstatus: active\n---\n# Body\n\nText",
        )
        .unwrap();

        let metadata = read_task_metadata(
            tmp.path().to_string_lossy().to_string(),
            "tasks/active/task.md".to_string(),
        )
        .unwrap();

        assert_eq!(metadata.tags, vec!["anchor", "tasks"]);
        assert_eq!(metadata.frontmatter["status"], json!("active"));
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
                project: Some(Some("Anchor".to_string())),
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
        assert!(raw.contains("project: Anchor"));
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
                project: Some(Some("Anchor".to_string())),
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
            "---\nproject: Anchor\ndue: 2026-05-15\ncalendarStart: 2026-05-15T09:00\nestimateMinutes: 45\n---\n# Body\n",
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
            "project": "Anchor",
            "unknown": "no",
        }))
        .unwrap_err();

        assert!(err.to_string().contains("unknown field"));
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
        )
        .unwrap();

        assert_eq!(row.rel_path, "tasks/backlog/task-2.md");
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
}
