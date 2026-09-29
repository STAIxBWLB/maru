//! Architecture blueprint gallery (#410): the archify `*-rendered.html` viewers that dev/ and
//! sites/ submodules keep next to their `<slug>.architecture.json` specs.
//! Maru reads the working tree, so a regenerated blueprint shows before it is
//! committed, and it grants the asset protocol one listed file at a time.

use crate::git::list_workspace_submodules;
use crate::vault::normalize_existing_dir;
use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::Manager;

const VIEWER_SUFFIX: &str = "-rendered.html";
const SPEC_SUFFIX: &str = ".architecture.json";
/// Scanned flat (non-recursive) inside every submodule.
const BLUEPRINT_DIRS: [&str; 3] = ["docs/architecture", "docs", "architecture"];
const GROUPS: [&str; 2] = ["dev", "sites"];

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchitectureBlueprint {
    pub slug: String,
    pub title: String,
    pub group: &'static str,
    /// Workspace-relative submodule path.
    pub repo_path: String,
    /// Canonical absolute path of the viewer file.
    pub html_path: String,
    /// Milliseconds since the Unix epoch.
    pub modified_at: Option<u64>,
}

struct Found {
    slug: String,
    group: &'static str,
    repo_path: String,
    path: PathBuf,
}

/// Viewer files of submodules under dev/ or sites/. Stray clones are not
/// submodules and never appear; symlinked viewers and anything resolving
/// outside the workspace are skipped.
fn scan_blueprints(root: &Path) -> Result<Vec<Found>, String> {
    let mut found = Vec::new();
    for repo_path in list_workspace_submodules(root.to_string_lossy().into_owned())? {
        let Some(group) = GROUPS.into_iter().find(|group| {
            repo_path
                .strip_prefix(group)
                .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/'))
        }) else {
            continue;
        };
        for dir in BLUEPRINT_DIRS {
            let Ok(entries) = fs::read_dir(root.join(&repo_path).join(dir)) else {
                continue;
            };
            for entry in entries.flatten() {
                // DirEntry::file_type does not follow symlinks.
                if !entry.file_type().is_ok_and(|kind| kind.is_file()) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().into_owned();
                let Some(slug) = name.strip_suffix(VIEWER_SUFFIX).filter(|s| !s.is_empty()) else {
                    continue;
                };
                // A symlinked docs/ directory can still point outside.
                let Ok(path) = entry.path().canonicalize() else {
                    continue;
                };
                if !path.starts_with(root) {
                    continue;
                }
                found.push(Found {
                    slug: slug.to_string(),
                    group,
                    repo_path: repo_path.clone(),
                    path,
                });
            }
        }
    }
    Ok(found)
}

fn spec_title(viewer: &Path, slug: &str) -> Option<String> {
    let spec = viewer.with_file_name(format!("{slug}{SPEC_SUFFIX}"));
    let value: serde_json::Value = serde_json::from_str(&fs::read_to_string(spec).ok()?).ok()?;
    let title = value.pointer("/meta/title")?.as_str()?.trim();
    (!title.is_empty()).then(|| title.to_string())
}

fn modified_millis(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

pub fn list_architecture_blueprints(
    workspace_path: String,
) -> Result<Vec<ArchitectureBlueprint>, String> {
    let root = normalize_existing_dir(&workspace_path)?;
    let mut blueprints: Vec<ArchitectureBlueprint> = scan_blueprints(&root)?
        .into_iter()
        .map(|found| ArchitectureBlueprint {
            title: spec_title(&found.path, &found.slug).unwrap_or_else(|| found.slug.clone()),
            modified_at: modified_millis(&found.path),
            html_path: found.path.to_string_lossy().into_owned(),
            slug: found.slug,
            group: found.group,
            repo_path: found.repo_path,
        })
        .collect();
    blueprints.sort_by(|a, b| (&a.repo_path, &a.slug).cmp(&(&b.repo_path, &b.slug)));
    Ok(blueprints)
}

/// Only a file the listing itself returns passes: the canonical form resolves
/// `..` and symlinks before the comparison.
fn resolve_listed_blueprint(workspace_path: &str, html_path: &str) -> Result<PathBuf, String> {
    let root = normalize_existing_dir(workspace_path)?;
    let target = root
        .join(html_path)
        .canonicalize()
        .map_err(|err| format!("Cannot open blueprint: {err}"))?;
    if scan_blueprints(&root)?
        .iter()
        .any(|found| found.path == target)
    {
        Ok(target)
    } else {
        Err("Not a listed architecture blueprint".to_string())
    }
}

/// Grants that single file (never its directory) to the asset protocol.
pub fn prepare_architecture_blueprint<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    workspace_path: String,
    html_path: String,
) -> Result<String, String> {
    let target = resolve_listed_blueprint(&workspace_path, &html_path)?;
    app.asset_protocol_scope()
        .allow_file(&target)
        .map_err(|err| format!("Cannot allow blueprint asset: {err}"))?;
    Ok(target.to_string_lossy().into_owned())
}

pub mod ipc {
    use super::ArchitectureBlueprint;

    #[tauri::command]
    pub async fn list_architecture_blueprints(
        workspace_path: String,
    ) -> Result<Vec<ArchitectureBlueprint>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            super::list_architecture_blueprints(workspace_path)
        })
        .await
        .map_err(|err| format!("list_architecture_blueprints_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn prepare_architecture_blueprint<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        workspace_path: String,
        html_path: String,
    ) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            super::prepare_architecture_blueprint(app, workspace_path, html_path)
        })
        .await
        .map_err(|err| format!("prepare_architecture_blueprint_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;
    use tempfile::TempDir;

    fn git(dir: &Path, args: &[&str]) {
        // Isolated from the developer's global config (signing, hooks).
        let mut command = Command::new("git");
        crate::git::configure_git(&mut command);
        let output = command.args(args).current_dir(dir).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn repo(dir: &Path, files: &[(&str, &str)]) {
        fs::create_dir_all(dir).unwrap();
        git(dir, &["init", "-q"]);
        for (path, body) in files {
            let file = dir.join(path);
            fs::create_dir_all(file.parent().unwrap()).unwrap();
            fs::write(file, body).unwrap();
        }
        git(dir, &["add", "."]);
        git(dir, &["commit", "-qm", "init"]);
    }

    /// Workspace with dev/alpha (docs/architecture + spec), sites/beta
    /// (docs/, no spec), sites/gamma (architecture/), and a stray clone at
    /// dev/stray that is not a submodule.
    fn workspace() -> (TempDir, PathBuf) {
        let tmp = TempDir::new().unwrap();
        let sources = tmp.path().join("sources");
        repo(
            &sources.join("alpha"),
            &[
                (
                    "docs/architecture/alpha-rendered.html",
                    "<html>alpha</html>",
                ),
                (
                    "docs/architecture/alpha.architecture.json",
                    r#"{"meta":{"title":"Alpha Service"}}"#,
                ),
                ("docs/architecture/notes.html", "not a viewer"),
            ],
        );
        repo(
            &sources.join("beta"),
            &[("docs/beta-rendered.html", "<html>beta</html>")],
        );
        repo(
            &sources.join("gamma"),
            &[("architecture/gamma-rendered.html", "<html>gamma</html>")],
        );
        let root = tmp.path().join("work");
        repo(&root, &[("README.md", "work")]);
        for (source, path) in [
            ("alpha", "dev/alpha"),
            ("beta", "sites/beta"),
            ("gamma", "sites/gamma"),
        ] {
            git(
                &root,
                &[
                    "submodule",
                    "add",
                    "-q",
                    sources.join(source).to_str().unwrap(),
                    path,
                ],
            );
        }
        git(&root, &["commit", "-qm", "submodules"]);
        repo(
            &root.join("dev/stray"),
            &[(
                "docs/architecture/stray-rendered.html",
                "<html>stray</html>",
            )],
        );
        let root = root.canonicalize().unwrap();
        (tmp, root)
    }

    fn root_arg(root: &Path) -> String {
        root.to_string_lossy().into_owned()
    }

    #[test]
    fn architecture_lists_submodule_viewers_with_titles_and_groups() {
        let (_tmp, root) = workspace();

        let listed = list_architecture_blueprints(root_arg(&root)).unwrap();

        let rows: Vec<_> = listed
            .iter()
            .map(|b| {
                (
                    b.group,
                    b.repo_path.as_str(),
                    b.slug.as_str(),
                    b.title.as_str(),
                )
            })
            .collect();
        assert_eq!(
            rows,
            vec![
                ("dev", "dev/alpha", "alpha", "Alpha Service"),
                ("sites", "sites/beta", "beta", "beta"),
                ("sites", "sites/gamma", "gamma", "gamma"),
            ]
        );
        let alpha = &listed[0];
        assert_eq!(
            PathBuf::from(&alpha.html_path),
            root.join("dev/alpha/docs/architecture/alpha-rendered.html")
        );
        assert!(alpha.modified_at.is_some_and(|ms| ms > 0));
    }

    #[test]
    fn architecture_accepts_a_listed_viewer_by_absolute_or_relative_path() {
        let (_tmp, root) = workspace();
        let viewer = root.join("sites/beta/docs/beta-rendered.html");

        assert_eq!(
            resolve_listed_blueprint(&root_arg(&root), viewer.to_str().unwrap()).unwrap(),
            viewer
        );
        assert_eq!(
            resolve_listed_blueprint(&root_arg(&root), "sites/beta/docs/beta-rendered.html")
                .unwrap(),
            viewer
        );
    }

    #[test]
    fn architecture_rejects_outside_traversal_stray_and_bad_names() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("outside-rendered.html");
        fs::write(&outside, "<html>outside</html>").unwrap();
        let root_s = root_arg(&root);

        for path in [
            outside.to_string_lossy().into_owned(),
            "dev/alpha/docs/architecture/../../../../outside-rendered.html".to_string(),
            "dev/stray/docs/architecture/stray-rendered.html".to_string(),
            "dev/alpha/docs/architecture/notes.html".to_string(),
            "dev/alpha/docs/architecture/alpha.architecture.json".to_string(),
            "dev/alpha/docs/architecture/missing-rendered.html".to_string(),
        ] {
            assert!(
                resolve_listed_blueprint(&root_s, &path).is_err(),
                "accepted {path}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn architecture_skips_symlinks_escaping_the_workspace() {
        let (tmp, root) = workspace();
        let outside_dir = tmp.path().join("outside-docs");
        fs::create_dir_all(&outside_dir).unwrap();
        fs::write(outside_dir.join("linked-rendered.html"), "<html>x</html>").unwrap();
        // A symlinked viewer file and a symlinked docs/ directory.
        std::os::unix::fs::symlink(
            outside_dir.join("linked-rendered.html"),
            root.join("sites/gamma/architecture/evil-rendered.html"),
        )
        .unwrap();
        std::os::unix::fs::symlink(&outside_dir, root.join("sites/gamma/docs")).unwrap();

        let listed = list_architecture_blueprints(root_arg(&root)).unwrap();
        assert_eq!(listed.len(), 3);
        for path in [
            "sites/gamma/architecture/evil-rendered.html",
            "sites/gamma/docs/linked-rendered.html",
        ] {
            assert!(
                resolve_listed_blueprint(&root_arg(&root), path).is_err(),
                "accepted {path}"
            );
        }
    }

    #[test]
    fn architecture_ipc_wrappers_list_and_grant_through_the_worker() {
        let (_tmp, root) = workspace();
        let app = tauri::test::mock_app();
        tauri::async_runtime::block_on(async {
            let listed = ipc::list_architecture_blueprints(root_arg(&root))
                .await
                .unwrap();
            assert_eq!(listed.len(), 3);
            let granted = ipc::prepare_architecture_blueprint(
                app.handle().clone(),
                root_arg(&root),
                listed[0].html_path.clone(),
            )
            .await
            .unwrap();
            assert_eq!(granted, listed[0].html_path);
            assert!(ipc::prepare_architecture_blueprint(
                app.handle().clone(),
                root_arg(&root),
                "dev/stray/docs/architecture/stray-rendered.html".to_string(),
            )
            .await
            .is_err());
        });
    }
}
