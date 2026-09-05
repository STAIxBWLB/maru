use crate::vault::{
    load_maruignore, matches_maruignore, normalize_existing_dir, resolve_inside_vault,
};
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

const MAX_RESULTS: usize = 500;

pub fn search_calendar_notes(
    work_path: String,
    roots: Vec<String>,
    query: String,
) -> Result<Vec<String>, String> {
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let needle = trimmed.to_lowercase();
    let work = normalize_existing_dir(&work_path)?;
    let ignore_patterns = load_maruignore(&work);
    let mut hits: Vec<String> = Vec::new();
    for root in roots {
        let trimmed_root = root.trim();
        if trimmed_root.is_empty() {
            continue;
        }
        let resolved = match resolve_inside_vault(&work_path, trimmed_root) {
            Ok(path) => path,
            Err(_) => continue,
        };
        if !resolved.exists() || !resolved.is_dir() {
            continue;
        }
        for entry in WalkDir::new(&resolved)
            .follow_links(false)
            .into_iter()
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
            let rel = rel_path_for(&work, path);
            if matches_maruignore(Path::new(&rel), &ignore_patterns) {
                continue;
            }
            let Ok(body) = fs::read_to_string(path) else {
                continue;
            };
            if body.to_lowercase().contains(&needle) {
                hits.push(rel);
                if hits.len() >= MAX_RESULTS {
                    return Ok(hits);
                }
            }
        }
    }
    hits.sort();
    hits.dedup();
    Ok(hits)
}

fn rel_path_for(vault: &Path, file: &Path) -> String {
    file.strip_prefix(vault)
        .unwrap_or(file)
        .to_string_lossy()
        .replace('\\', "/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn write(path: &Path, contents: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, contents).unwrap();
    }

    #[test]
    fn matches_substring_case_insensitive() {
        let dir = tempdir().unwrap();
        let work = dir.path();
        write(&work.join("tasks/active/a.md"), "본문에 주간점검 단어");
        write(&work.join("tasks/active/b.md"), "irrelevant content");
        write(
            &work.join("meetings/2026/2026-05/05-14 회의 - 주간.md"),
            "Body text WITH 주간점검 KEY",
        );
        let hits = search_calendar_notes(
            work.to_string_lossy().into_owned(),
            vec!["tasks".into(), "meetings".into()],
            "주간점검".into(),
        )
        .unwrap();
        assert_eq!(hits.len(), 2);
        assert!(hits.iter().any(|p| p.ends_with("tasks/active/a.md")));
    }

    #[test]
    fn empty_query_returns_empty() {
        let dir = tempdir().unwrap();
        let hits = search_calendar_notes(
            dir.path().to_string_lossy().into_owned(),
            vec!["tasks".into()],
            "   ".into(),
        )
        .unwrap();
        assert!(hits.is_empty());
    }

    #[test]
    fn skips_non_markdown_files() {
        let dir = tempdir().unwrap();
        let work = dir.path();
        write(&work.join("tasks/note.txt"), "find me");
        write(&work.join("tasks/note.md"), "also find me");
        let hits = search_calendar_notes(
            work.to_string_lossy().into_owned(),
            vec!["tasks".into()],
            "find me".into(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("note.md"));
    }

    #[test]
    fn respects_maruignore() {
        let dir = tempdir().unwrap();
        let work = dir.path();
        write(&work.join(".maruignore"), "skipme\n");
        write(&work.join("tasks/skipme/a.md"), "needle");
        write(&work.join("tasks/keep/b.md"), "needle");
        let hits = search_calendar_notes(
            work.to_string_lossy().into_owned(),
            vec!["tasks".into()],
            "needle".into(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].ends_with("tasks/keep/b.md"));
    }

    #[test]
    fn ignores_nonexistent_root_silently() {
        let dir = tempdir().unwrap();
        let work = dir.path();
        write(&work.join("tasks/a.md"), "alpha");
        let hits = search_calendar_notes(
            work.to_string_lossy().into_owned(),
            vec!["tasks".into(), "nowhere".into()],
            "alpha".into(),
        )
        .unwrap();
        assert_eq!(hits.len(), 1);
    }
}

/// Owned IPC scheduling; synchronous domain APIs remain available to Rust callers.
pub mod ipc {
    #[tauri::command]
    pub async fn search_calendar_notes(
        work_path: String,
        roots: Vec<String>,
        query: String,
    ) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            crate::atomic_file::PathTransactionLease::test_stage(
                &[std::path::PathBuf::from(&work_path)],
                "worker:search_calendar_notes",
            );
            super::search_calendar_notes(work_path, roots, query)
        })
        .await
        .map_err(|err| format!("search_calendar_notes_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_06 {
    use super::*;
    use crate::atomic_file::phase08_06::{boundary, run, Home};
    #[test]
    fn phase08_06_calendar_worker_returns_real_hits_and_legacy_errors() {
        let home = Home::new();
        let root = home.root.path().to_path_buf();
        let s = root.to_string_lossy().into_owned();
        boundary(
            root.clone(),
            "search_calendar_notes",
            ipc::search_calendar_notes(s.clone(), vec!["tasks".into()], "needle".into()),
        );
        fs::create_dir(root.join("tasks")).unwrap();
        fs::write(root.join("tasks/note.md"), "calendar needle").unwrap();
        assert_eq!(
            run(ipc::search_calendar_notes(
                s,
                vec!["tasks".into()],
                "needle".into()
            ))
            .unwrap(),
            vec!["tasks/note.md"]
        );
        let not_dir = root.join("file");
        fs::write(&not_dir, "x").unwrap();
        assert_eq!(
            run(ipc::search_calendar_notes(
                not_dir.to_string_lossy().into_owned(),
                vec!["tasks".into()],
                "needle".into()
            ))
            .unwrap_err(),
            "Workspace path is not a directory"
        );
    }
}
