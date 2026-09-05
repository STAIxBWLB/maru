use crate::atomic_file::{with_path_transactions, PathTransactionRequest};
use crate::vault::{
    lexical_normalize, normalize_existing_dir, parse_frontmatter, resolve_inside_vault,
};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use serde_yaml::Value as YamlValue;
use std::collections::{BTreeMap, BTreeSet};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

const MEETINGS_LOG_DEFAULT_LIMIT: usize = 200;
const MEETINGS_LOG_MAX_LIMIT: usize = 2000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNoteRow {
    pub path: String,
    pub rel_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
    pub frontmatter: JsonValue,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingMetadata {
    pub rel_path: String,
    pub frontmatter: JsonValue,
    pub tags: Vec<String>,
    pub attendees: Vec<String>,
    pub date: Option<String>,
    pub preview: String,
    pub line_count: usize,
    pub char_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingsLogLine {
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGuides {
    pub quick_start: Option<String>,
    pub glossary: Option<String>,
    pub people: Option<String>,
    pub tag_standards: Option<String>,
    pub notes_guidelines: Option<String>,
}

pub fn scan_meeting_notes(
    work_path: String,
    root: Option<String>,
) -> Result<Vec<MeetingNoteRow>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let scan_root = resolve_meetings_root(&work, root.as_deref().unwrap_or("meetings"))?;
    if !scan_root.exists() {
        return Ok(Vec::new());
    }
    if !scan_root.is_dir() {
        return Err("meeting_notes_root_not_directory".to_string());
    }
    let mut rows = Vec::new();
    for entry in WalkDir::new(&scan_root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| should_enter_meeting_path(entry.path(), &scan_root))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let path = entry.path();
        if path
            .extension()
            .and_then(|value| value.to_str())
            .map(|value| !value.eq_ignore_ascii_case("md"))
            .unwrap_or(true)
        {
            continue;
        }
        let metadata = entry
            .metadata()
            .map_err(|err| format!("Cannot read meeting note metadata: {err}"))?;
        let rel_path = rel_path_for(&work, path);
        let frontmatter = fs::read_to_string(path)
            .map(|raw| yaml_to_json(&parse_frontmatter(&raw).meta))
            .unwrap_or_else(|_| JsonValue::Object(JsonMap::new()));
        rows.push(MeetingNoteRow {
            path: path.to_string_lossy().to_string(),
            rel_path: rel_path.clone(),
            file_name: path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&rel_path)
                .to_string(),
            size_bytes: metadata.len(),
            updated_at: metadata
                .modified()
                .ok()
                .map(DateTime::<Utc>::from)
                .map(|value| value.to_rfc3339()),
            frontmatter,
        });
    }
    rows.sort_by(|a, b| {
        a.rel_path
            .to_lowercase()
            .cmp(&b.rel_path.to_lowercase())
            .then_with(|| a.rel_path.cmp(&b.rel_path))
    });
    Ok(rows)
}

pub fn read_meeting_metadata(
    work_path: String,
    rel_path: String,
) -> Result<MeetingMetadata, String> {
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read meeting note metadata: {err}"))?;
    let parts = parse_frontmatter(&raw);
    let frontmatter_json = yaml_to_json(&parts.meta);
    let tags = string_list_field(&frontmatter_json, "tags");
    let attendees = unique_strings(
        string_list_field(&frontmatter_json, "attendees")
            .into_iter()
            .chain(string_list_field(&frontmatter_json, "people")),
    );
    let date = string_field(&frontmatter_json, "date")
        .or_else(|| string_field(&frontmatter_json, "created_at"))
        .or_else(|| string_field(&frontmatter_json, "created"));
    let preview = parts.body.lines().take(200).collect::<Vec<_>>().join("\n");
    Ok(MeetingMetadata {
        rel_path,
        frontmatter: frontmatter_json,
        tags,
        attendees,
        date,
        preview,
        line_count: raw.lines().count(),
        char_count: raw.chars().count(),
    })
}

pub fn read_meeting_guides(work_path: String) -> Result<MeetingGuides, String> {
    let work = normalize_existing_dir(&work_path)?;
    let guide_paths = read_guide_paths(&work);
    Ok(MeetingGuides {
        quick_start: read_optional_guide(&work, guide_paths.get("quickStart")),
        glossary: read_optional_guide(&work, guide_paths.get("glossary")),
        people: read_optional_guide(&work, guide_paths.get("people")),
        tag_standards: read_optional_guide(&work, guide_paths.get("tagStandards")),
        notes_guidelines: read_optional_guide(&work, guide_paths.get("notesGuidelines")),
    })
}

pub fn append_meetings_log(work_path: String, line: String) -> Result<(), String> {
    let work = normalize_existing_dir(&work_path)?;
    let parent = work.join(".maru");
    let log_path = parent.join("meetings-log.md");
    // Admit the parent as well as the append target: creating .maru and aliases
    // must serialize with Files parent moves and registry migration writes.
    let requested_work = PathBuf::from(&work_path);
    let requested_work = lexical_normalize(&if requested_work.is_absolute() {
        requested_work
    } else {
        std::env::current_dir()
            .map_err(|err| err.to_string())?
            .join(requested_work)
    });
    let request = PathTransactionRequest::new(vec![
        parent.clone(),
        log_path.clone(),
        requested_work.join(".maru"),
        requested_work.join(".maru/meetings-log.md"),
    ])?
    .require_parent(&work)?
    .with_workspace_registry()?;
    with_path_transactions(request, |lease| {
        lease.ensure_workspace_registry()?;
        lease.before_effect()?;
        let current_work = normalize_existing_dir(&work_path)?;
        if current_work != work {
            return Err("Transaction parent changed; retry the operation".into());
        }
        crate::vault_list::assert_document_owner(&work_path, &log_path)?;
        crate::vault_list::assert_maru_can_write(
            &current_work.to_string_lossy(),
            crate::vault_list::WorkspaceWriteAction::Modify,
        )?;
        // An existing parent is pinned by the request and cannot be recreated
        // after another admitted writer moves it while this append waits.
        if !parent.exists() {
            fs::create_dir(&parent)
                .map_err(|err| format!("Cannot create meetings log dir: {err}"))?;
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&log_path)
            .map_err(|err| format!("Cannot open meetings log: {err}"))?;
        writeln!(file, "{line}").map_err(|err| format!("Cannot append meetings log: {err}"))?;
        Ok(())
    })
}

pub fn read_meetings_log(
    work_path: String,
    limit: Option<usize>,
    event_filter: Option<Vec<String>>,
) -> Result<Vec<MeetingsLogLine>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let log_path = work.join(".maru").join("meetings-log.md");
    if !log_path.exists() {
        return Ok(Vec::new());
    }
    let raw =
        fs::read_to_string(&log_path).map_err(|err| format!("Cannot read meetings log: {err}"))?;
    let cap = limit
        .unwrap_or(MEETINGS_LOG_DEFAULT_LIMIT)
        .clamp(1, MEETINGS_LOG_MAX_LIMIT);
    let filter: Option<BTreeSet<String>> = event_filter
        .map(|values| values.into_iter().filter(|v| !v.is_empty()).collect())
        .filter(|set: &BTreeSet<String>| !set.is_empty());

    let mut entries: Vec<MeetingsLogLine> = raw
        .lines()
        .rev()
        .filter_map(|line| {
            let trimmed = line.trim_end_matches('\r');
            if trimmed.trim().is_empty() {
                None
            } else {
                Some(parse_meetings_log_line(trimmed))
            }
        })
        .filter(|entry| {
            filter
                .as_ref()
                .map_or(true, |set| set.contains(&entry.event))
        })
        .take(cap)
        .collect();
    entries.shrink_to_fit();
    Ok(entries)
}

fn parse_meetings_log_line(raw: &str) -> MeetingsLogLine {
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
                return MeetingsLogLine {
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

        if let Some((skill, target)) = rest.split_once(':') {
            let skill = skill.trim();
            let target = target.trim();
            if !skill.is_empty() {
                return MeetingsLogLine {
                    raw: raw.to_string(),
                    ts,
                    event: "followup".to_string(),
                    run_id: None,
                    status: Some("started".to_string()),
                    skill: Some(skill.to_string()),
                    target: if target.is_empty() {
                        None
                    } else {
                        Some(target.to_string())
                    },
                    payload: None,
                    legacy: true,
                };
            }
        }
    }

    MeetingsLogLine {
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
    let trimmed = input.trim_start();
    let end = trimmed
        .char_indices()
        .find(|(_, ch)| ch.is_whitespace())
        .map(|(idx, _)| idx)
        .unwrap_or(trimmed.len());
    let head = &trimmed[..end];
    let rest = trimmed[end..].trim_start();
    let rest = if rest.is_empty() { None } else { Some(rest) };
    if DateTime::parse_from_rfc3339(head).is_ok() {
        (Some(head.to_string()), rest)
    } else {
        (None, Some(trimmed))
    }
}

fn should_enter_meeting_path(path: &Path, root: &Path) -> bool {
    if path == root {
        return true;
    }
    let rel = path.strip_prefix(root).unwrap_or(path);
    !rel.components().any(|component| {
        matches!(component, Component::Normal(value) if {
            let segment = value.to_string_lossy();
            segment.starts_with('_') || segment == "uiac-meeting-records"
        })
    })
}

fn rel_path_for(work: &Path, path: &Path) -> String {
    path.strip_prefix(work)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
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

fn resolve_meetings_root(work: &Path, raw: &str) -> Result<PathBuf, String> {
    let candidate = lexical_normalize(&resolve_config_path(work, raw));
    if candidate.starts_with(work) {
        return Ok(candidate);
    }
    if let Ok(canonical) = candidate.canonicalize() {
        if canonical.starts_with(work) {
            return Ok(canonical);
        }
    }
    Err("meeting_notes_root_escapes_workspace".to_string())
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

fn unique_strings(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut unique = Vec::new();
    for value in values {
        if seen.insert(value.clone()) {
            unique.push(value);
        }
    }
    unique
}

fn read_guide_paths(work: &Path) -> BTreeMap<String, String> {
    let mut paths = BTreeMap::new();
    if let Some(settings) = read_global_settings_json() {
        collect_guide_paths(settings.pointer("/meetings/guides"), &mut paths);
    }
    let workspace_config = work.join("workspace.config.yaml");
    if let Ok(raw) = fs::read_to_string(workspace_config) {
        if let Ok(value) = serde_yaml::from_str::<YamlValue>(&raw) {
            collect_yaml_guide_paths(
                value.get("meetings").and_then(|v| v.get("guides")),
                &mut paths,
            );
            collect_yaml_guide_paths(
                value.get("meeting_notes").and_then(|v| v.get("guides")),
                &mut paths,
            );
        }
    }
    paths
}

fn read_global_settings_json() -> Option<JsonValue> {
    let path = crate::skill_host::fs::maru_home()
        .ok()?
        .join("settings.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<JsonValue>(&raw).ok()
}

fn collect_guide_paths(value: Option<&JsonValue>, paths: &mut BTreeMap<String, String>) {
    let Some(JsonValue::Object(map)) = value else {
        return;
    };
    for (target, aliases) in guide_aliases() {
        for alias in aliases {
            if let Some(path) = map
                .get(*alias)
                .and_then(|value| value.as_str())
                .map(str::trim)
            {
                if !path.is_empty() {
                    paths.insert(target.to_string(), path.to_string());
                    break;
                }
            }
        }
    }
}

fn collect_yaml_guide_paths(value: Option<&YamlValue>, paths: &mut BTreeMap<String, String>) {
    let Some(YamlValue::Mapping(map)) = value else {
        return;
    };
    for (target, aliases) in guide_aliases() {
        for alias in aliases {
            let key = YamlValue::String(alias.to_string());
            if let Some(YamlValue::String(path)) = map.get(&key) {
                let trimmed = path.trim();
                if !trimmed.is_empty() {
                    paths.insert(target.to_string(), trimmed.to_string());
                    break;
                }
            }
        }
    }
}

fn guide_aliases() -> [(&'static str, &'static [&'static str]); 5] {
    [
        (
            "quickStart",
            &[
                "quickStart",
                "quick_start",
                "quickStartPath",
                "quick_start_path",
            ],
        ),
        ("glossary", &["glossary", "glossaryPath", "glossary_path"]),
        ("people", &["people", "peoplePath", "people_path"]),
        (
            "tagStandards",
            &[
                "tagStandards",
                "tag_standards",
                "tagStandardsPath",
                "tag_standards_path",
            ],
        ),
        (
            "notesGuidelines",
            &[
                "notesGuidelines",
                "notes_guidelines",
                "notesGuidelinesPath",
                "notes_guidelines_path",
            ],
        ),
    ]
}

fn read_optional_guide(work: &Path, raw: Option<&String>) -> Option<String> {
    let path = resolve_config_path(work, raw?);
    fs::read_to_string(path).ok()
}

/// Owned IPC boundaries; synchronous entry points remain available to Rust callers.
pub mod ipc {
    use super::*;
    #[tauri::command]
    pub async fn scan_meeting_notes(
        work_path: String,
        root: Option<String>,
    ) -> Result<Vec<MeetingNoteRow>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:scan_meeting_notes",
            );
            super::scan_meeting_notes(work_path, root)
        })
        .await
        .map_err(|error| format!("scan_meeting_notes_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn read_meeting_metadata(
        work_path: String,
        rel_path: String,
    ) -> Result<MeetingMetadata, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_meeting_metadata",
            );
            super::read_meeting_metadata(work_path, rel_path)
        })
        .await
        .map_err(|error| format!("read_meeting_metadata_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn read_meeting_guides(work_path: String) -> Result<MeetingGuides, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_meeting_guides",
            );
            super::read_meeting_guides(work_path)
        })
        .await
        .map_err(|error| format!("read_meeting_guides_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn append_meetings_log(work_path: String, line: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:append_meetings_log",
            );
            super::append_meetings_log(work_path, line)
        })
        .await
        .map_err(|error| format!("append_meetings_log_task_failed: {error}"))?
    }
    #[tauri::command]
    pub async fn read_meetings_log(
        work_path: String,
        limit: Option<usize>,
        event_filter: Option<Vec<String>>,
    ) -> Result<Vec<MeetingsLogLine>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[PathBuf::from(&work_path)],
                "worker:read_meetings_log",
            );
            super::read_meetings_log(work_path, limit, event_filter)
        })
        .await
        .map_err(|error| format!("read_meetings_log_task_failed: {error}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scan_notes_reads_markdown_and_excludes_generated_dirs() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("meetings/2026/2026-04");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("04-20 회의 - Maru - KPI.md"),
            "---\ntitle: Maru KPI 점검\n---\n# A",
        )
        .unwrap();
        fs::write(root.join("04-20 회의 - Maru - KPI.txt"), "no").unwrap();
        let excluded = tmp
            .path()
            .join("meetings/2026/2026-04/_raw/uiac-meeting-records");
        fs::create_dir_all(&excluded).unwrap();
        fs::write(excluded.join("04-20 회의 - Hidden - Raw.md"), "# H").unwrap();

        let rows = scan_meeting_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].rel_path,
            "meetings/2026/2026-04/04-20 회의 - Maru - KPI.md"
        );
        assert_eq!(rows[0].frontmatter["title"], "Maru KPI 점검");
    }

    #[test]
    fn scan_notes_rejects_roots_outside_workspace() {
        let tmp = tempdir().unwrap();
        let outside = tempdir().unwrap();

        let err = scan_meeting_notes(
            tmp.path().to_string_lossy().to_string(),
            Some(outside.path().to_string_lossy().to_string()),
        )
        .unwrap_err();

        assert_eq!(err, "meeting_notes_root_escapes_workspace");
    }

    #[test]
    fn metadata_reads_frontmatter_preview_and_counts() {
        let tmp = tempdir().unwrap();
        let note = tmp
            .path()
            .join("meetings/2026/2026-04/04-20 회의 - Maru - KPI.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\ntags:\n  - 회의록\nattendees:\n  - Lee\n  - Kim\npeople:\n  - Lee\ndate: 2026-04-20\n---\n# Body\n\nText",
        )
        .unwrap();

        let metadata = read_meeting_metadata(
            tmp.path().to_string_lossy().to_string(),
            "meetings/2026/2026-04/04-20 회의 - Maru - KPI.md".to_string(),
        )
        .unwrap();

        assert_eq!(metadata.tags, vec!["회의록"]);
        assert_eq!(metadata.attendees, vec!["Lee", "Kim"]);
        assert_eq!(metadata.date.as_deref(), Some("2026-04-20"));
        assert!(metadata.preview.contains("# Body"));
        assert!(metadata.line_count > 0);
    }

    #[test]
    fn scalar_frontmatter_is_returned_as_empty_object() {
        let tmp = tempdir().unwrap();
        let note = tmp
            .path()
            .join("meetings/2026/2026-04/04-20 회의 - Maru - KPI.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(&note, "---\n- invalid\n---\n# Body").unwrap();

        let metadata = read_meeting_metadata(
            tmp.path().to_string_lossy().to_string(),
            "meetings/2026/2026-04/04-20 회의 - Maru - KPI.md".to_string(),
        )
        .unwrap();

        assert_eq!(metadata.frontmatter, JsonValue::Object(JsonMap::new()));
    }

    #[test]
    fn missing_guides_return_nulls() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        let guides = read_meeting_guides(tmp.path().to_string_lossy().to_string()).unwrap();

        assert!(guides.quick_start.is_none());
        assert!(guides.glossary.is_none());
    }

    #[test]
    fn reads_guides_from_meetings_workspace_alias() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        let guide = tmp.path().join("docs/GLOSSARY.md");
        fs::create_dir_all(guide.parent().unwrap()).unwrap();
        fs::write(&guide, "# Glossary").unwrap();
        fs::write(
            tmp.path().join("workspace.config.yaml"),
            "meetings:\n  guides:\n    glossary: docs/GLOSSARY.md\n",
        )
        .unwrap();

        let guides = read_meeting_guides(tmp.path().to_string_lossy().to_string()).unwrap();

        assert_eq!(guides.glossary.as_deref(), Some("# Glossary"));
    }

    #[test]
    fn appends_meetings_log() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        append_meetings_log(
            tmp.path().to_string_lossy().to_string(),
            "- entry".to_string(),
        )
        .unwrap();

        let log = fs::read_to_string(tmp.path().join(".maru/meetings-log.md")).unwrap();
        assert_eq!(log, "- entry\n");
    }

    #[test]
    fn reads_meetings_log_returns_empty_when_missing() {
        let tmp = tempdir().unwrap();
        let entries =
            read_meetings_log(tmp.path().to_string_lossy().to_string(), None, None).unwrap();
        assert!(entries.is_empty());
    }

    #[test]
    fn reads_structured_meetings_log_lines() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        append_meetings_log(
            work.clone(),
            "- 2026-05-12T08:14:33Z [apply] {\"runId\":\"r1\",\"status\":\"completed\",\"skill\":\"meeting-notes\",\"files\":2,\"followups\":1,\"target\":\"meetings/2026/2026-05/note.md\"}".to_string(),
        )
        .unwrap();
        append_meetings_log(
            work.clone(),
            "- 2026-05-12T08:15:00Z [clear] {\"runId\":\"r1\",\"status\":\"cleared\",\"skill\":\"meeting-notes\"}".to_string(),
        )
        .unwrap();

        let entries = read_meetings_log(work, None, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].event, "clear");
        assert_eq!(entries[0].run_id.as_deref(), Some("r1"));
        assert_eq!(entries[0].status.as_deref(), Some("cleared"));
        assert!(!entries[0].legacy);
        assert_eq!(entries[1].event, "apply");
        assert_eq!(
            entries[1].target.as_deref(),
            Some("meetings/2026/2026-05/note.md")
        );
        assert!(entries[1]
            .payload
            .as_ref()
            .and_then(|value| value.get("files"))
            .and_then(JsonValue::as_i64)
            .is_some());
    }

    #[test]
    fn reads_legacy_meetings_log_lines() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        append_meetings_log(
            work.clone(),
            "- 2026-05-12T08:14:33.111Z vault-extract: meetings/2026/2026-05/note.md".to_string(),
        )
        .unwrap();
        append_meetings_log(work.clone(), "free text without prefix".to_string()).unwrap();

        let entries = read_meetings_log(work, None, None).unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries[0].legacy);
        assert_eq!(entries[0].event, "unknown");
        assert_eq!(entries[1].event, "followup");
        assert_eq!(entries[1].skill.as_deref(), Some("vault-extract"));
        assert_eq!(
            entries[1].target.as_deref(),
            Some("meetings/2026/2026-05/note.md")
        );
        assert_eq!(entries[1].status.as_deref(), Some("started"));
        assert!(entries[1].legacy);
    }

    #[test]
    fn reads_meetings_log_respects_limit_and_filter() {
        let _home = crate::atomic_file::phase08_06::Home::new();
        let tmp = tempdir().unwrap();
        let work = tmp.path().to_string_lossy().to_string();
        for index in 0..5 {
            append_meetings_log(
                work.clone(),
                format!(
                    "- 2026-05-12T08:14:0{index}Z [apply] {{\"runId\":\"r{index}\",\"status\":\"completed\",\"skill\":\"meeting-notes\"}}",
                ),
            )
            .unwrap();
            append_meetings_log(
                work.clone(),
                format!(
                    "- 2026-05-12T08:15:0{index}Z [clear] {{\"runId\":\"r{index}\",\"status\":\"cleared\",\"skill\":\"meeting-notes\"}}",
                ),
            )
            .unwrap();
        }

        let limited = read_meetings_log(work.clone(), Some(3), None).unwrap();
        assert_eq!(limited.len(), 3);
        assert_eq!(limited[0].event, "clear");
        assert_eq!(limited[0].run_id.as_deref(), Some("r4"));

        let filtered = read_meetings_log(work, Some(10), Some(vec!["apply".to_string()])).unwrap();
        assert_eq!(filtered.len(), 5);
        assert!(filtered.iter().all(|entry| entry.event == "apply"));
    }
}

#[cfg(test)]
mod phase08_09 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Held, Home};
    use std::future::Future;
    use std::sync::mpsc;
    use std::time::Duration;

    fn text(path: &Path) -> String {
        path.to_string_lossy().into_owned()
    }

    fn start<F, T>(future: F) -> mpsc::Receiver<T>
    where
        F: Future<Output = T> + Send + 'static,
        T: Send + 'static,
    {
        let (tx, rx) = mpsc::channel();
        tauri::async_runtime::spawn(async move {
            let _ = tx.send(future.await);
        });
        rx
    }

    fn done<T>(rx: mpsc::Receiver<T>) -> T {
        rx.recv_timeout(Duration::from_secs(10))
            .expect("meeting fixture completion")
    }

    #[test]
    fn phase08_09_meetings_all_five_wrappers_yield_and_preserve_join_errors() {
        let home = Home::new();
        let root = home.root.path();
        boundary(
            root.into(),
            "scan_meeting_notes",
            ipc::scan_meeting_notes(text(root), None),
        );
        boundary(
            root.into(),
            "read_meeting_metadata",
            ipc::read_meeting_metadata(text(root), "meeting.md".into()),
        );
        boundary(
            root.into(),
            "read_meeting_guides",
            ipc::read_meeting_guides(text(root)),
        );
        boundary(
            root.into(),
            "append_meetings_log",
            ipc::append_meetings_log(text(root), "entry".into()),
        );
        boundary(
            root.into(),
            "read_meetings_log",
            ipc::read_meetings_log(text(root), None, None),
        );
        assert!(!root.join(".maru").exists());
    }

    #[test]
    fn phase08_09_meetings_nonempty_payloads_and_legacy_errors() {
        let home = Home::new();
        let root = home.root.path().join("work");
        fs::create_dir_all(root.join("meetings")).unwrap();
        fs::write(root.join("meetings/note.md"), "---\ntitle: 회의\ntags: [review]\nattendees: [Lee]\npeople: [Lee, Kim]\ndate: 2026-09-05\n---\n# Body\n").unwrap();
        fs::write(root.join("guide.md"), "# Guide").unwrap();
        fs::write(
            root.join("workspace.config.yaml"),
            "meetings:\n  guides:\n    glossary: guide.md\n",
        )
        .unwrap();
        let rows = run(ipc::scan_meeting_notes(text(&root), None)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].frontmatter["title"], "회의");
        let metadata = run(ipc::read_meeting_metadata(
            text(&root),
            "meetings/note.md".into(),
        ))
        .unwrap();
        assert_eq!(metadata.attendees, ["Lee", "Kim"]);
        assert_eq!(metadata.tags, ["review"]);
        assert_eq!(metadata.preview, "# Body");
        assert!(metadata.char_count > 0);
        assert_eq!(
            run(ipc::read_meeting_guides(text(&root)))
                .unwrap()
                .glossary
                .as_deref(),
            Some("# Guide")
        );
        run(ipc::append_meetings_log(
            text(&root),
            "- 2026-09-05T00:00:00Z [apply] {\"runId\":\"r1\"}".into(),
        ))
        .unwrap();
        run(ipc::append_meetings_log(
            text(&root),
            "- 2026-09-05T00:00:01Z vault-extract: note.md".into(),
        ))
        .unwrap();
        let entries = run(ipc::read_meetings_log(text(&root), Some(1), None)).unwrap();
        assert_eq!(entries.len(), 1);
        assert!(entries[0].legacy);
        assert_eq!(entries[0].skill.as_deref(), Some("vault-extract"));
        let entries = run(ipc::read_meetings_log(
            text(&root),
            None,
            Some(vec!["apply".into()]),
        ))
        .unwrap();
        assert_eq!(entries[0].run_id.as_deref(), Some("r1"));
        assert_eq!(
            run(ipc::scan_meeting_notes(
                text(&root),
                Some("../outside".into())
            ))
            .unwrap_err(),
            "meeting_notes_root_escapes_workspace"
        );
        assert!(
            run(ipc::read_meeting_metadata(text(&root), "missing.md".into()))
                .unwrap_err()
                .starts_with("Cannot read meeting note metadata:")
        );
        let missing = text(&root.join("missing"));
        assert!(run(ipc::read_meeting_guides(missing.clone())).is_err());
        assert!(run(ipc::append_meetings_log(missing.clone(), "entry".into())).is_err());
        assert!(run(ipc::read_meetings_log(missing, None, None)).is_err());
    }

    #[test]
    fn phase08_09_meetings_same_target_append_serializes_complete_lines() {
        let home = Home::new();
        let root = home.root.path();
        fs::create_dir(root.join(".maru")).unwrap();
        let target = root.join(".maru/meetings-log.md");
        let first_line = "first".repeat(10000);
        let second_line = "second".repeat(10000);
        let held = Held::new(target.clone(), "admitted");
        let first = start(ipc::append_meetings_log(text(root), first_line.clone()));
        held.wait();
        let waiting = Held::new(target.clone(), "before-admission");
        let second = start(ipc::append_meetings_log(text(root), second_line.clone()));
        waiting.wait();
        waiting.release();
        assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(first).unwrap();
        done(second).unwrap();
        assert_eq!(
            fs::read_to_string(target).unwrap(),
            format!("{first_line}\n{second_line}\n")
        );
    }

    #[test]
    fn phase08_09_meetings_parent_rename_both_orders_without_recreation() {
        let home = Home::new();
        for parent_first in [false, true] {
            let root = home.root.path().join(format!("work-{parent_first}"));
            fs::create_dir_all(root.join(".maru")).unwrap();
            let parent = root.clone();
            let target = root.join(".maru/meetings-log.md");
            let moved = home.root.path().join(format!("moved-{parent_first}"));
            fs::write(&target, "seed\n").unwrap();
            let rename = crate::workspace_files::ipc::rename_workspace_entry(
                text(home.root.path()),
                format!("work-{parent_first}"),
                format!("moved-{parent_first}"),
            );
            let append = ipc::append_meetings_log(text(&root), "appended".into());
            if parent_first {
                let held = Held::new(parent.clone(), "pre-effect");
                let first = start(rename);
                held.wait();
                let waiting = Held::new(target.clone(), "before-admission");
                let second = start(append);
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                assert!(done(second).unwrap_err().contains("parent"));
                assert_eq!(
                    fs::read_to_string(moved.join(".maru/meetings-log.md")).unwrap(),
                    "seed\n"
                );
            } else {
                let held = Held::new(target.clone(), "admitted");
                let first = start(append);
                held.wait();
                let waiting = Held::new(parent.clone(), "before-admission");
                let second = start(rename);
                waiting.wait();
                waiting.release();
                assert!(second.recv_timeout(Duration::from_millis(30)).is_err());
                held.release();
                done(first).unwrap();
                done(second).unwrap();
                assert_eq!(
                    fs::read_to_string(moved.join(".maru/meetings-log.md")).unwrap(),
                    "seed\nappended\n"
                );
            }
            assert!(!parent.exists());
        }
    }

    #[test]
    fn phase08_09_meetings_document_error_releases_append_admission() {
        let home = Home::new();
        let root = home.root.path();
        fs::create_dir(root.join(".maru")).unwrap();
        let target = root.join(".maru/meetings-log.md");
        fs::write(&target, "seed\n").unwrap();
        let held = Held::new(target.clone(), "admitted");
        let document = start(crate::document::ipc::save_document(
            text(root),
            ".maru/meetings-log.md".into(),
            "overwrite".into(),
            Some("stale".into()),
        ));
        held.wait();
        let waiting = Held::new(target.clone(), "before-admission");
        let append = start(ipc::append_meetings_log(text(root), "after error".into()));
        waiting.wait();
        waiting.release();
        assert!(append.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        assert_eq!(
            done(document).unwrap_err().code,
            crate::ipc_error::DOCUMENT_CONFLICT
        );
        done(append).unwrap();
        assert_eq!(fs::read_to_string(target).unwrap(), "seed\nafter error\n");
    }

    #[test]
    fn phase08_09_meetings_production_policy_denial_has_no_effect_and_releases() {
        let home = Home::new();
        let root = home.root.path().join("work");
        fs::create_dir(&root).unwrap();
        crate::scratchpad::phase08_08::registry(&root, "readOnly");
        assert!(run(ipc::append_meetings_log(text(&root), "denied".into()))
            .unwrap_err()
            .contains("Workspace writes are blocked"));
        assert!(!root.join(".maru").exists());
        crate::scratchpad::phase08_08::registry(&root, "direct");
        run(ipc::append_meetings_log(text(&root), "allowed".into())).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".maru/meetings-log.md")).unwrap(),
            "allowed\n"
        );
        // A filesystem error must also release admission for the actual next append.
        fs::remove_file(root.join(".maru/meetings-log.md")).unwrap();
        fs::create_dir(root.join(".maru/meetings-log.md")).unwrap();
        assert!(run(ipc::append_meetings_log(text(&root), "error".into()))
            .unwrap_err()
            .starts_with("Cannot open meetings log:"));
        fs::remove_dir(root.join(".maru/meetings-log.md")).unwrap();
        run(ipc::append_meetings_log(text(&root), "recovered".into())).unwrap();
        assert_eq!(
            fs::read_to_string(root.join(".maru/meetings-log.md")).unwrap(),
            "recovered\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn phase08_09_meetings_symlink_alias_conflicts_with_physical_parent() {
        let home = Home::new();
        let root = home.root.path().join("work");
        fs::create_dir_all(root.join("physical")).unwrap();
        std::os::unix::fs::symlink(root.join("physical"), root.join(".maru")).unwrap();
        let held = Held::new(root.join(".maru/meetings-log.md"), "admitted");
        let append = start(ipc::append_meetings_log(text(&root), "alias".into()));
        held.wait();
        let waiting = Held::new(root.join("physical"), "before-admission");
        let rename = start(crate::workspace_files::ipc::rename_workspace_entry(
            text(home.root.path()),
            "work/physical".into(),
            "moved".into(),
        ));
        waiting.wait();
        waiting.release();
        assert!(rename.recv_timeout(Duration::from_millis(30)).is_err());
        held.release();
        done(append).unwrap();
        done(rename).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("moved/meetings-log.md")).unwrap(),
            "alias\n"
        );
        assert!(!root.join("physical").exists());
    }
}
