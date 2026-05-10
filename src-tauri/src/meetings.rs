use crate::vault::{normalize_existing_dir, resolve_inside_vault};
use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{Map as JsonMap, Value as JsonValue};
use serde_yaml::Value as YamlValue;
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingNoteRow {
    pub path: String,
    pub rel_path: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub updated_at: Option<String>,
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

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingGuides {
    pub quick_start: Option<String>,
    pub glossary: Option<String>,
    pub people: Option<String>,
    pub tag_standards: Option<String>,
    pub notes_guidelines: Option<String>,
}

#[tauri::command]
pub fn scan_meeting_notes(
    work_path: String,
    root: Option<String>,
) -> Result<Vec<MeetingNoteRow>, String> {
    let work = normalize_existing_dir(&work_path)?;
    let scan_root = resolve_config_path(&work, root.as_deref().unwrap_or("meetings"));
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

#[tauri::command]
pub fn read_meeting_metadata(
    work_path: String,
    rel_path: String,
) -> Result<MeetingMetadata, String> {
    let path = resolve_inside_vault(&work_path, &rel_path)?;
    let raw = fs::read_to_string(&path)
        .map_err(|err| format!("Cannot read meeting note metadata: {err}"))?;
    let (frontmatter, body) = parse_frontmatter(&raw);
    let frontmatter_json = yaml_to_json(frontmatter.as_ref());
    let tags = string_list_field(&frontmatter_json, "tags");
    let attendees = string_list_field(&frontmatter_json, "attendees")
        .into_iter()
        .chain(string_list_field(&frontmatter_json, "people"))
        .collect();
    let date = string_field(&frontmatter_json, "date")
        .or_else(|| string_field(&frontmatter_json, "created_at"))
        .or_else(|| string_field(&frontmatter_json, "created"));
    let preview = body.lines().take(200).collect::<Vec<_>>().join("\n");
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

#[tauri::command]
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

#[tauri::command]
pub fn append_meetings_log(work_path: String, line: String) -> Result<(), String> {
    let work = normalize_existing_dir(&work_path)?;
    let log_path = work.join("vault").join("log.md");
    if let Some(parent) = log_path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Cannot create meetings log dir: {err}"))?;
    }
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|err| format!("Cannot open meetings log: {err}"))?;
    writeln!(file, "{line}").map_err(|err| format!("Cannot append meetings log: {err}"))?;
    Ok(())
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

fn parse_frontmatter(raw: &str) -> (Option<YamlValue>, String) {
    if !raw.starts_with("---\n") {
        return (None, raw.to_string());
    }
    let mut offset = 4;
    for line in raw[4..].split_inclusive('\n') {
        if line.trim_end() == "---" {
            let yaml = &raw[4..offset];
            let body = raw[offset + line.len()..].to_string();
            let parsed = serde_yaml::from_str::<YamlValue>(yaml).ok();
            return (parsed, body);
        }
        offset += line.len();
    }
    (None, raw.to_string())
}

fn yaml_to_json(value: Option<&YamlValue>) -> JsonValue {
    value
        .and_then(|frontmatter| serde_json::to_value(frontmatter).ok())
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

fn read_guide_paths(work: &Path) -> BTreeMap<String, String> {
    let mut paths = BTreeMap::new();
    if let Some(settings) = read_global_settings_json() {
        collect_guide_paths(settings.pointer("/meetings/guides"), &mut paths);
    }
    let workspace_config = work.join("workspace.config.yaml");
    if let Ok(raw) = fs::read_to_string(workspace_config) {
        if let Ok(value) = serde_yaml::from_str::<YamlValue>(&raw) {
            collect_yaml_guide_paths(
                value.get("meeting_notes").and_then(|v| v.get("guides")),
                &mut paths,
            );
        }
    }
    paths
}

fn read_global_settings_json() -> Option<JsonValue> {
    let path = dirs::home_dir()?.join(".anchor").join("settings.json");
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

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn scan_notes_reads_markdown_and_excludes_generated_dirs() {
        let tmp = tempdir().unwrap();
        let root = tmp.path().join("meetings/2026/2026-04");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("04-20 회의 - Anchor - KPI.md"), "# A").unwrap();
        fs::write(root.join("04-20 회의 - Anchor - KPI.txt"), "no").unwrap();
        let excluded = tmp
            .path()
            .join("meetings/2026/2026-04/_raw/uiac-meeting-records");
        fs::create_dir_all(&excluded).unwrap();
        fs::write(excluded.join("04-20 회의 - Hidden - Raw.md"), "# H").unwrap();

        let rows = scan_meeting_notes(tmp.path().to_string_lossy().to_string(), None).unwrap();

        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0].rel_path,
            "meetings/2026/2026-04/04-20 회의 - Anchor - KPI.md"
        );
    }

    #[test]
    fn metadata_reads_frontmatter_preview_and_counts() {
        let tmp = tempdir().unwrap();
        let note = tmp
            .path()
            .join("meetings/2026/2026-04/04-20 회의 - Anchor - KPI.md");
        fs::create_dir_all(note.parent().unwrap()).unwrap();
        fs::write(
            &note,
            "---\ntags:\n  - 회의록\nattendees:\n  - Lee\ndate: 2026-04-20\n---\n# Body\n\nText",
        )
        .unwrap();

        let metadata = read_meeting_metadata(
            tmp.path().to_string_lossy().to_string(),
            "meetings/2026/2026-04/04-20 회의 - Anchor - KPI.md".to_string(),
        )
        .unwrap();

        assert_eq!(metadata.tags, vec!["회의록"]);
        assert_eq!(metadata.attendees, vec!["Lee"]);
        assert_eq!(metadata.date.as_deref(), Some("2026-04-20"));
        assert!(metadata.preview.contains("# Body"));
        assert!(metadata.line_count > 0);
    }

    #[test]
    fn missing_guides_return_nulls() {
        let tmp = tempdir().unwrap();
        let guides = read_meeting_guides(tmp.path().to_string_lossy().to_string()).unwrap();

        assert!(guides.quick_start.is_none());
        assert!(guides.glossary.is_none());
    }

    #[test]
    fn appends_meetings_log() {
        let tmp = tempdir().unwrap();
        append_meetings_log(
            tmp.path().to_string_lossy().to_string(),
            "- entry".to_string(),
        )
        .unwrap();

        let log = fs::read_to_string(tmp.path().join("vault/log.md")).unwrap();
        assert_eq!(log, "- entry\n");
    }
}
