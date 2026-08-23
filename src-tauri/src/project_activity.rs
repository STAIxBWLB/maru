//! 프로젝트별 활동 신호 스캔 (대시보드 포트폴리오 카드).
//!
//! 프론트엔드가 계산할 수 없는 두 가지만 담당한다.
//!   1. 프로젝트별 최근 회의일 — meetings/ 전체(2026년만 500여 건)의 frontmatter 를
//!      IPC 로 실어보내지 않기 위해 여기서 집계한다.
//!   2. 프로젝트별 최근 파일 활동 — 이에 해당하는 기존 커맨드가 없다.
//!
//! 태스크↔프로젝트 매칭은 의도적으로 여기서 하지 않는다. TS 쪽 `resolveTaskEntryProjects`
//! 가 Tasks 모드와 동일한 파이프라인이라, 백엔드에서 따로 세면 두 화면의 숫자가 어긋난다.
//!
//! Spec: issue #256

use serde::Serialize;
use serde_yaml::Value as YamlValue;
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use walkdir::WalkDir;

use crate::maru_dir::workspace_project_entries;
use crate::paths::GENERATED_DIRS;
use crate::vault::{normalize_existing_dir, parse_frontmatter};

/// 회의 조회 기본 창(일). 이보다 오래된 회의는 "최근 회의 없음"으로 표시된다.
const DEFAULT_MEETING_WINDOW_DAYS: u32 = 180;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivityRow {
    /// 레지스트리 프로젝트 id.
    pub id: String,
    /// 워크스페이스 상대 경로 (예: "projects/oda/koica-tiu").
    pub path: String,
    /// 최근 회의일 (YYYY-MM-DD). 회의 파일명의 YYMMDD 에서 뽑는다.
    pub last_meeting_day: Option<String>,
    /// 프로젝트 경로 아래 파일 mtime 의 최댓값 (RFC3339).
    pub last_activity_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectActivityReport {
    pub generated_at: String,
    pub rows: Vec<ProjectActivityRow>,
    pub warnings: Vec<String>,
    pub elapsed_ms: u64,
}

#[tauri::command(async)]
pub fn scan_project_activity(
    work_path: String,
    meeting_window_days: Option<u32>,
) -> Result<ProjectActivityReport, String> {
    let work = normalize_existing_dir(&work_path)?;
    scan_project_activity_impl(&work, meeting_window_days)
}

pub(crate) fn scan_project_activity_impl(
    work: &Path,
    meeting_window_days: Option<u32>,
) -> Result<ProjectActivityReport, String> {
    let started = std::time::Instant::now();
    let mut warnings = Vec::new();

    let projects = workspace_project_entries(work, false)?;
    let window_days = meeting_window_days.unwrap_or(DEFAULT_MEETING_WINDOW_DAYS);

    // 매칭 후보: id, 경로 마지막 세그먼트, vault_note stem 을 모두 프로젝트 id 로 이어둔다.
    let mut aliases: HashMap<String, String> = HashMap::new();
    for project in &projects {
        let register = |raw: &str, aliases: &mut HashMap<String, String>| {
            let key = normalize_link_target(raw);
            if !key.is_empty() {
                // 먼저 등록된 프로젝트가 이긴다. id 는 아래에서 마지막으로 덮어써 우선권을 준다.
                aliases.entry(key).or_insert_with(|| project.id.clone());
            }
        };
        if let Some(segment) = last_path_segment(&project.path) {
            register(segment, &mut aliases);
        }
        if let Some(note) = project.vault_note.as_deref() {
            register(note, &mut aliases);
        }
        let id_key = normalize_link_target(&project.id);
        if !id_key.is_empty() {
            aliases.insert(id_key, project.id.clone());
        }
    }

    let last_meeting = scan_meeting_days(work, window_days, &aliases, &mut warnings);
    let last_activity = scan_last_activity(work, &projects, &mut warnings);

    let mut rows: Vec<ProjectActivityRow> = projects
        .into_iter()
        .map(|project| ProjectActivityRow {
            last_meeting_day: last_meeting.get(&project.id).cloned(),
            last_activity_at: last_activity.get(&project.id).cloned(),
            id: project.id,
            path: project.path,
        })
        .collect();
    rows.sort_by(|a, b| a.id.cmp(&b.id));

    Ok(ProjectActivityReport {
        generated_at: chrono::Utc::now().to_rfc3339(),
        rows,
        warnings,
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

// ---------------------------------------------------------------------------
// 회의
// ---------------------------------------------------------------------------

/// 회의 frontmatter 에서 프로젝트를 가리키는 키. 워크스페이스에 네 가지 표기가
/// 공존하므로(2026년 503건 기준) 전부 읽는다.
const MEETING_PROJECT_KEYS: [&str; 4] = ["project", "projects", "related_projects", "related"];

fn scan_meeting_days(
    work: &Path,
    window_days: u32,
    aliases: &HashMap<String, String>,
    warnings: &mut Vec<String>,
) -> HashMap<String, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let root = work.join("meetings");
    if !root.is_dir() {
        return out;
    }
    let cutoff = chrono::Utc::now().date_naive() - chrono::Duration::days(window_days as i64);

    for entry in WalkDir::new(&root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_pruned_dir(entry.path()))
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
        let Some(file_name) = path.file_name().and_then(|value| value.to_str()) else {
            continue;
        };
        // 파일명의 YYMMDD 가 유일하게 믿을 수 있는 날짜다(frontmatter `date:` 는 누락 사례가 있다).
        let Some(day) = meeting_day_from_file_name(file_name) else {
            continue;
        };
        // 창 밖 회의는 본문을 읽지 않고 건너뛴다.
        if day < cutoff {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(path) else {
            warnings.push(format!("meeting unreadable: {}", file_name));
            continue;
        };
        let meta = parse_frontmatter(&raw).meta;
        let day_text = day.format("%Y-%m-%d").to_string();
        for project_id in meeting_project_ids(&meta, aliases) {
            out.entry(project_id)
                .and_modify(|existing| {
                    if day_text > *existing {
                        *existing = day_text.clone();
                    }
                })
                .or_insert_with(|| day_text.clone());
        }
    }
    out
}

/// "260817-meeting-foo.md" → 2026-08-17. 선두 6자리가 없으면 None.
fn meeting_day_from_file_name(file_name: &str) -> Option<chrono::NaiveDate> {
    let digits: String = file_name.chars().take_while(char::is_ascii_digit).collect();
    if digits.len() != 6 {
        return None;
    }
    let year: i32 = 2000 + digits[0..2].parse::<i32>().ok()?;
    let month: u32 = digits[2..4].parse().ok()?;
    let day: u32 = digits[4..6].parse().ok()?;
    chrono::NaiveDate::from_ymd_opt(year, month, day)
}

fn meeting_project_ids(
    meta: &BTreeMap<String, YamlValue>,
    aliases: &HashMap<String, String>,
) -> Vec<String> {
    let mut ids = Vec::new();
    for key in MEETING_PROJECT_KEYS {
        let Some(value) = meta.get(key) else { continue };
        for raw in yaml_strings(value) {
            let normalized = normalize_link_target(&raw);
            if normalized.is_empty() {
                continue;
            }
            // 매칭되지 않는 참조는 조용히 버린다(자유 텍스트 링크가 흔하다).
            if let Some(id) = aliases.get(&normalized) {
                if !ids.contains(id) {
                    ids.push(id.clone());
                }
            }
        }
    }
    ids
}

fn yaml_strings(value: &YamlValue) -> Vec<String> {
    match value {
        YamlValue::String(text) => vec![text.clone()],
        YamlValue::Sequence(items) => items.iter().flat_map(yaml_strings).collect(),
        _ => Vec::new(),
    }
}

/// "[[projects/foo|별칭]]" / "foo.md" → "foo". taskProjectLabels.ts 의 normalizeTarget 대응.
fn normalize_link_target(raw: &str) -> String {
    let mut value = raw.trim();
    value = value
        .strip_prefix("[[")
        .map(|rest| rest.strip_suffix("]]").unwrap_or(rest))
        .unwrap_or(value);
    if let Some((before, _alias)) = value.split_once('|') {
        value = before;
    }
    if let Some((before, _anchor)) = value.split_once('#') {
        value = before;
    }
    let value = value.trim().trim_end_matches('/');
    let value = value.strip_suffix(".md").unwrap_or(value);
    let value = last_path_segment(value).unwrap_or(value);
    value.trim().to_lowercase()
}

fn last_path_segment(value: &str) -> Option<&str> {
    let trimmed = value.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return None;
    }
    trimmed.rsplit('/').next().filter(|s| !s.is_empty())
}

// ---------------------------------------------------------------------------
// 파일 활동
// ---------------------------------------------------------------------------

fn scan_last_activity(
    work: &Path,
    projects: &[crate::maru_dir::ProjectPickerEntry],
    warnings: &mut Vec<String>,
) -> HashMap<String, String> {
    // (정규화 경로, id) 를 경로 길이 내림차순으로. 접두사 비교 한 번으로 모든 소유 프로젝트를 찾는다.
    let mut prefixes: Vec<(String, &str)> = Vec::new();
    for project in projects {
        let rel = project.path.trim_matches('/');
        if rel.is_empty() {
            continue;
        }
        if !work.join(rel).is_dir() {
            warnings.push(format!("project path missing: {}", project.path));
            continue;
        }
        prefixes.push((format!("{rel}/"), project.id.as_str()));
    }

    let mut out: HashMap<String, String> = HashMap::new();
    if prefixes.is_empty() {
        return out;
    }

    let mut newest: HashMap<&str, std::time::SystemTime> = HashMap::new();
    for entry in WalkDir::new(work)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| entry.depth() == 0 || !is_pruned_dir(entry.path()))
        .filter_map(Result::ok)
    {
        if !entry.file_type().is_file() {
            continue;
        }
        let Ok(rel) = entry.path().strip_prefix(work) else {
            continue;
        };
        let Some(rel) = rel.to_str() else { continue };
        // Registry paths are always "/"-separated; strip_prefix hands back the
        // platform separator, so on Windows nothing would ever match and every
        // project would read as untouched.
        let rel = rel.replace('\\', "/");
        let Ok(modified) = entry
            .metadata()
            .map_err(std::io::Error::from)
            .and_then(|meta| meta.modified())
        else {
            continue;
        };
        for (prefix, id) in &prefixes {
            if rel.starts_with(prefix.as_str()) {
                newest
                    .entry(id)
                    .and_modify(|existing| {
                        if modified > *existing {
                            *existing = modified;
                        }
                    })
                    .or_insert(modified);
            }
        }
    }

    for (id, time) in newest {
        let stamp: chrono::DateTime<chrono::Utc> = time.into();
        out.insert(id.to_string(), stamp.to_rfc3339());
    }
    out
}

/// 호출자는 depth 0(스캔 루트)에서 이 검사를 건너뛴다. 루트 이름이 점으로 시작할 수
/// 있어서(tempdir 등) 루트까지 걸러내면 순회 자체가 비어버린다.
fn is_pruned_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if GENERATED_DIRS.contains(&name) {
        return true;
    }
    name.starts_with('.') && name.len() > 1
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn registry(tmp: &Path) {
        fs::write(
            tmp.join("project-registry.yaml"),
            r#"
projects:
  - id: oda-koica-tiu
    name: KOICA TIU
    path: projects/oda/koica-tiu
    status: active
    vault_note: notes/koica-tiu.md
  - id: rise
    name: RISE
    path: projects/rise
    status: active
    sub_projects:
      - id: rise-5g3t-a2cl
        name: A2CL
        path: projects/rise/a2cl-growth-engine
        status: active
  - id: ghost
    name: Missing Dir
    path: projects/ghost
    status: active
"#,
        )
        .expect("registry");
    }

    fn meeting(tmp: &Path, name: &str, front: &str) {
        let dir = tmp.join("meetings/2026/2026-08");
        fs::create_dir_all(&dir).expect("mkdir");
        fs::write(dir.join(name), format!("---\n{front}---\nbody\n")).expect("meeting");
    }

    fn today_stamp(offset_days: i64) -> String {
        (chrono::Utc::now().date_naive() - chrono::Duration::days(offset_days))
            .format("%y%m%d")
            .to_string()
    }

    fn setup(tmp: &Path) {
        registry(tmp);
        for rel in [
            "projects/oda/koica-tiu",
            "projects/rise",
            "projects/rise/a2cl-growth-engine",
        ] {
            fs::create_dir_all(tmp.join(rel)).expect("mkdir");
            fs::write(tmp.join(rel).join("README.md"), "x").expect("file");
        }
    }

    #[test]
    fn rows_cover_registry_projects_including_sub_projects() {
        let tmp = tempfile::tempdir().expect("tempdir");
        setup(tmp.path());

        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        let ids: Vec<&str> = report.rows.iter().map(|row| row.id.as_str()).collect();

        assert!(ids.contains(&"oda-koica-tiu"));
        assert!(ids.contains(&"rise"));
        assert!(ids.contains(&"rise-5g3t-a2cl"), "sub_projects must appear");
        // 경로가 없는 프로젝트도 행은 남기되 활동은 비고 경고를 남긴다.
        let ghost = report
            .rows
            .iter()
            .find(|row| row.id == "ghost")
            .expect("ghost row");
        assert!(ghost.last_activity_at.is_none());
        assert!(report
            .warnings
            .iter()
            .any(|warning| warning.contains("projects/ghost")));
    }

    #[test]
    fn meeting_day_comes_from_filename_and_all_link_spellings_match() {
        let tmp = tempfile::tempdir().expect("tempdir");
        setup(tmp.path());

        // 네 가지 표기가 각각 매칭되어야 한다. frontmatter 의 date: 는 일부러 틀리게 둔다.
        meeting(
            tmp.path(),
            &format!("{}-meeting-a.md", today_stamp(3)),
            "date: 1999-01-01\nproject: \"[[koica-tiu]]\"\n",
        );
        meeting(
            tmp.path(),
            &format!("{}-meeting-b.md", today_stamp(9)),
            "projects:\n  - oda-koica-tiu\n",
        );
        meeting(
            tmp.path(),
            &format!("{}-meeting-c.md", today_stamp(4)),
            "related_projects:\n  - rise\n",
        );
        meeting(
            tmp.path(),
            &format!("{}-meeting-d.md", today_stamp(2)),
            "related: \"[[a2cl-growth-engine|A2CL 회의]]\"\n",
        );
        // 매칭되지 않는 참조는 조용히 버려진다.
        meeting(
            tmp.path(),
            &format!("{}-meeting-e.md", today_stamp(1)),
            "project: \"[[nobody-knows-this]]\"\n",
        );

        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        let by_id: HashMap<&str, Option<&str>> = report
            .rows
            .iter()
            .map(|row| (row.id.as_str(), row.last_meeting_day.as_deref()))
            .collect();

        let expect_day = |offset: i64| {
            (chrono::Utc::now().date_naive() - chrono::Duration::days(offset))
                .format("%Y-%m-%d")
                .to_string()
        };
        // 3일 전(파일명)이 9일 전보다 최신이므로 그쪽이 남는다.
        assert_eq!(by_id["oda-koica-tiu"], Some(expect_day(3).as_str()));
        assert_eq!(by_id["rise"], Some(expect_day(4).as_str()));
        assert_eq!(by_id["rise-5g3t-a2cl"], Some(expect_day(2).as_str()));
    }

    #[test]
    fn meetings_outside_the_window_are_ignored() {
        let tmp = tempfile::tempdir().expect("tempdir");
        setup(tmp.path());
        meeting(
            tmp.path(),
            &format!("{}-meeting-old.md", today_stamp(200)),
            "project: oda-koica-tiu\n",
        );

        let report = scan_project_activity_impl(tmp.path(), Some(180)).expect("scan");
        let row = report
            .rows
            .iter()
            .find(|row| row.id == "oda-koica-tiu")
            .expect("row");
        assert_eq!(row.last_meeting_day, None);

        let wide = scan_project_activity_impl(tmp.path(), Some(365)).expect("scan wide");
        let row = wide
            .rows
            .iter()
            .find(|row| row.id == "oda-koica-tiu")
            .expect("row");
        assert!(
            row.last_meeting_day.is_some(),
            "wider window must pick it up"
        );
    }

    #[test]
    fn activity_attributes_nested_files_to_parent_and_child() {
        let tmp = tempfile::tempdir().expect("tempdir");
        setup(tmp.path());
        fs::write(
            tmp.path().join("projects/rise/a2cl-growth-engine/note.md"),
            "fresh",
        )
        .expect("write");

        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        let by_id: HashMap<&str, Option<&str>> = report
            .rows
            .iter()
            .map(|row| (row.id.as_str(), row.last_activity_at.as_deref()))
            .collect();

        // 하위 파일은 서브프로젝트와 상위 프로젝트 양쪽에 잡힌다.
        assert!(by_id["rise-5g3t-a2cl"].is_some());
        assert!(by_id["rise"].is_some());
        assert!(by_id["oda-koica-tiu"].is_some());
    }

    #[test]
    fn pruned_directories_do_not_contribute_activity() {
        let tmp = tempfile::tempdir().expect("tempdir");
        registry(tmp.path());
        // koica-tiu 에는 node_modules 안의 파일만 둔다 → 활동 없음으로 나와야 한다.
        fs::create_dir_all(tmp.path().join("projects/oda/koica-tiu/node_modules/pkg"))
            .expect("mkdir");
        fs::write(
            tmp.path()
                .join("projects/oda/koica-tiu/node_modules/pkg/index.js"),
            "x",
        )
        .expect("write");
        fs::create_dir_all(tmp.path().join("projects/rise")).expect("mkdir");

        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        let row = report
            .rows
            .iter()
            .find(|row| row.id == "oda-koica-tiu")
            .expect("row");
        assert_eq!(row.last_activity_at, None, "node_modules must be pruned");
    }

    #[test]
    fn activity_matching_is_separator_agnostic() {
        // strip_prefix returns the platform separator. Registry paths are
        // always "/"-separated, so the comparison has to normalize or Windows
        // reports every project as untouched.
        let tmp = tempfile::tempdir().expect("tempdir");
        setup(tmp.path());

        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        let touched = report
            .rows
            .iter()
            .filter(|row| row.last_activity_at.is_some())
            .count();
        assert!(
            touched >= 3,
            "every seeded project dir holds a file: {:?}",
            report.rows
        );
    }

    #[test]
    fn empty_workspace_returns_no_rows() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let report = scan_project_activity_impl(tmp.path(), None).expect("scan");
        assert!(report.rows.is_empty());
    }

    #[test]
    fn link_target_normalization_strips_wikilinks_alias_and_extension() {
        assert_eq!(normalize_link_target("[[projects/foo|별칭]]"), "foo");
        assert_eq!(normalize_link_target(" Foo.md "), "foo");
        assert_eq!(normalize_link_target("[[bar#섹션]]"), "bar");
        assert_eq!(
            normalize_link_target("projects/oda/koica-tiu/"),
            "koica-tiu"
        );
        assert_eq!(normalize_link_target("   "), "");
    }

    #[test]
    fn meeting_day_parser_requires_six_leading_digits() {
        assert_eq!(
            meeting_day_from_file_name("260817-meeting-foo.md"),
            chrono::NaiveDate::from_ymd_opt(2026, 8, 17)
        );
        assert_eq!(meeting_day_from_file_name("meeting-foo.md"), None);
        assert_eq!(meeting_day_from_file_name("2608-short.md"), None);
        assert_eq!(meeting_day_from_file_name("269917-badmonth.md"), None);
    }
}
