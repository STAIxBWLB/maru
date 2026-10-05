//! Architecture blueprint gallery (#410): the archify `*-rendered.html` viewers that dev/ and
//! sites/ submodules keep next to their `<slug>.architecture.json` specs.
//! Maru reads the working tree, so a regenerated blueprint shows before it is
//! committed, and it grants the asset protocol one listed file at a time.

use crate::git::list_workspace_submodules;
use crate::vault::{lexical_normalize, normalize_existing_dir};
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SiblingSpec {
    /// Raw `<slug>.architecture.json` body.
    pub spec_json: String,
    pub title: Option<String>,
    /// Workspace-relative submodule path the spec was proven to live in.
    pub submodule: String,
    /// Submodule HEAD sha, best effort (read from the gitdir, no subprocess).
    pub commit: Option<String>,
}

#[derive(Clone)]
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
    // A plain-folder workspace has no submodules, not a failed listing.
    if !root.ancestors().any(|dir| dir.join(".git").exists()) {
        return Ok(found);
    }
    for repo_path in list_workspace_submodules(root.to_string_lossy().into_owned())? {
        let Some(group) = GROUPS.into_iter().find(|group| {
            repo_path
                .strip_prefix(group)
                .is_some_and(|rest| rest.len() > 1 && rest.starts_with('/'))
        }) else {
            continue;
        };
        let Ok(repo_root) = root.join(&repo_path).canonicalize() else {
            continue;
        };
        if !repo_root.starts_with(root) {
            continue;
        }
        for dir in BLUEPRINT_DIRS {
            let Ok(entries) = fs::read_dir(repo_root.join(dir)) else {
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
                // A symlinked docs/ directory can still point out of its
                // submodule, into a stray clone or outside the workspace.
                let Ok(path) = entry.path().canonicalize() else {
                    continue;
                };
                // An in-repo link (docs/architecture -> ../architecture)
                // reaches the same file twice.
                if !path.starts_with(&repo_root) || found.iter().any(|f: &Found| f.path == path) {
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
// ponytail: rescans (git submodule foreach, ~0.6 s on the real workspace) per
// selection; cache the listing per workspace if that latency starts to show.
fn resolve_listed_found(workspace_path: &str, html_path: &str) -> Result<Found, String> {
    let root = normalize_existing_dir(workspace_path)?;
    let target = root
        .join(html_path)
        .canonicalize()
        .map_err(|err| format!("Cannot open blueprint: {err}"))?;
    scan_blueprints(&root)?
        .into_iter()
        .find(|found| found.path == target)
        .ok_or_else(|| "Not a listed architecture blueprint".to_string())
}

fn resolve_listed_blueprint(workspace_path: &str, html_path: &str) -> Result<PathBuf, String> {
    Ok(resolve_listed_found(workspace_path, html_path)?.path)
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

/// Sibling specs larger than this are rejected before parsing.
const MAX_SPEC_BYTES: u64 = 1024 * 1024;

/// Best-effort HEAD sha of a submodule, read from its gitdir without spawning
/// git: `<submodule>/.git` is a `gitdir:` pointer file (or a real directory),
/// and HEAD names a ref resolved from loose refs or packed-refs.
fn submodule_head_sha(repo_root: &Path) -> Option<String> {
    let is_sha = |value: &str| value.len() >= 40 && value.chars().all(|c| c.is_ascii_hexdigit());
    let dotgit = repo_root.join(".git");
    let gitdir = if dotgit.is_dir() {
        dotgit
    } else {
        let pointer = fs::read_to_string(&dotgit).ok()?;
        let target = pointer.trim().strip_prefix("gitdir:")?.trim();
        if Path::new(target).is_absolute() {
            PathBuf::from(target)
        } else {
            lexical_normalize(&repo_root.join(target))
        }
    };
    let head = fs::read_to_string(gitdir.join("HEAD")).ok()?;
    let head = head.trim();
    if is_sha(head) {
        return Some(head.to_string());
    }
    let reference = head.strip_prefix("ref:")?.trim();
    if let Ok(loose) = fs::read_to_string(gitdir.join(reference)) {
        let sha = loose.trim();
        if is_sha(sha) {
            return Some(sha.to_string());
        }
    }
    let packed = fs::read_to_string(gitdir.join("packed-refs")).ok()?;
    for line in packed.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.starts_with('^') {
            continue;
        }
        if let Some((sha, name)) = line.split_once(' ') {
            if name.trim() == reference && is_sha(sha) {
                return Some(sha.to_string());
            }
        }
    }
    None
}

/// Reads the `<slug>.architecture.json` sibling of a listed gallery blueprint
/// (#433). A safe listed HTML proves nothing about the JSON, so the sibling
/// gets its own checks: canonicalize, stay inside the same submodule (a
/// symlink escaping the submodule root is refused), size cap, and a parse
/// requiring `diagram_type == "architecture"` and a numeric `schema_version`.
pub fn architecture_read_sibling_spec(
    workspace_path: String,
    html_path: String,
) -> Result<SiblingSpec, String> {
    let root = normalize_existing_dir(&workspace_path)?;
    // Fresh listing scan: never trust the caller's path.
    let found = resolve_listed_found(&workspace_path, &html_path)?;
    let repo_root = root
        .join(&found.repo_path)
        .canonicalize()
        .map_err(|err| format!("Cannot open submodule: {err}"))?;
    let spec = found
        .path
        .with_file_name(format!("{}{SPEC_SUFFIX}", found.slug));
    let canonical = spec
        .canonicalize()
        .map_err(|_| format!("Sibling spec not found: {}{SPEC_SUFFIX}", found.slug))?;
    if !canonical.starts_with(&repo_root) {
        return Err("Sibling spec escapes its submodule".to_string());
    }
    let size = fs::metadata(&canonical)
        .map_err(|err| format!("Cannot stat sibling spec: {err}"))?
        .len();
    if size > MAX_SPEC_BYTES {
        return Err(format!(
            "Sibling spec too large ({size} bytes, max {MAX_SPEC_BYTES})"
        ));
    }
    let body =
        fs::read_to_string(&canonical).map_err(|err| format!("Cannot read sibling spec: {err}"))?;
    let value: serde_json::Value = serde_json::from_str(&body)
        .map_err(|err| format!("Sibling spec is not valid JSON: {err}"))?;
    if value.get("diagram_type").and_then(|v| v.as_str()) != Some("architecture") {
        return Err("Sibling spec is not an architecture spec".to_string());
    }
    if !value.get("schema_version").is_some_and(|v| v.is_number()) {
        return Err("Sibling spec has no numeric schema_version".to_string());
    }
    let title = value
        .pointer("/meta/title")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string);
    Ok(SiblingSpec {
        spec_json: body,
        title,
        commit: submodule_head_sha(&repo_root),
        submodule: found.repo_path,
    })
}

pub mod ipc {
    use super::{ArchitectureBlueprint, SiblingSpec};

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

    #[tauri::command]
    pub async fn architecture_read_sibling_spec(
        workspace_path: String,
        html_path: String,
    ) -> Result<SiblingSpec, String> {
        tauri::async_runtime::spawn_blocking(move || {
            super::architecture_read_sibling_spec(workspace_path, html_path)
        })
        .await
        .map_err(|err| format!("architecture_read_sibling_spec_task_failed: {err}"))?
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
                    r#"{"schema_version":1,"diagram_type":"architecture","meta":{"title":"Alpha Service"}}"#,
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

    fn git_out(dir: &Path, args: &[&str]) -> String {
        let mut command = Command::new("git");
        crate::git::configure_git(&mut command);
        let output = command.args(args).current_dir(dir).output().unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
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
    fn architecture_lists_nothing_for_a_plain_folder_workspace() {
        let tmp = TempDir::new().unwrap();
        fs::create_dir_all(tmp.path().join("dev/alpha/docs")).unwrap();
        fs::write(tmp.path().join("dev/alpha/docs/alpha-rendered.html"), "x").unwrap();

        let listed = list_architecture_blueprints(root_arg(tmp.path())).unwrap();

        assert!(listed.is_empty());
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
    fn architecture_skips_symlinks_escaping_the_submodule() {
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
        // An in-repo directory link must not list beta twice.
        std::os::unix::fs::symlink(
            root.join("sites/beta/docs"),
            root.join("sites/beta/architecture"),
        )
        .unwrap();
        // A submodule directory linked into the stray clone stays in the workspace.
        std::os::unix::fs::symlink(
            root.join("dev/stray/docs/architecture"),
            root.join("dev/alpha/architecture"),
        )
        .unwrap();

        let listed = list_architecture_blueprints(root_arg(&root)).unwrap();
        assert_eq!(listed.len(), 3);
        for path in [
            "sites/gamma/architecture/evil-rendered.html",
            "sites/gamma/docs/linked-rendered.html",
            "dev/alpha/architecture/stray-rendered.html",
            "dev/stray/docs/architecture/stray-rendered.html",
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
            // Exactly that file: no sibling, directory or workspace-root grant.
            let scope = app.asset_protocol_scope();
            assert!(scope.is_allowed(&granted));
            for other in [
                root.join("dev/alpha/docs/architecture/notes.html"),
                root.join("dev/alpha/docs/architecture/alpha.architecture.json"),
                root.join("README.md"),
            ] {
                assert!(!scope.is_allowed(&other), "{}", other.display());
            }
            assert!(ipc::prepare_architecture_blueprint(
                app.handle().clone(),
                root_arg(&root),
                "dev/stray/docs/architecture/stray-rendered.html".to_string(),
            )
            .await
            .is_err());
        });
    }

    #[test]
    fn sibling_spec_returns_spec_and_provenance() {
        let (_tmp, root) = workspace();

        let spec = architecture_read_sibling_spec(
            root_arg(&root),
            "dev/alpha/docs/architecture/alpha-rendered.html".to_string(),
        )
        .unwrap();

        assert!(spec.spec_json.contains("Alpha Service"));
        assert_eq!(spec.title.as_deref(), Some("Alpha Service"));
        assert_eq!(spec.submodule, "dev/alpha");
        let head = git_out(&root.join("dev/alpha"), &["rev-parse", "HEAD"]);
        assert_eq!(spec.commit.as_deref(), Some(head.as_str()));
    }

    #[test]
    fn sibling_spec_missing_is_a_typed_diagnostic() {
        let (_tmp, root) = workspace();

        let err = architecture_read_sibling_spec(
            root_arg(&root),
            "sites/beta/docs/beta-rendered.html".to_string(),
        )
        .unwrap_err();

        assert_eq!(err, "Sibling spec not found: beta.architecture.json");
    }

    #[cfg(unix)]
    #[test]
    fn sibling_spec_symlink_escaping_the_submodule_is_refused() {
        let (tmp, root) = workspace();
        let outside = tmp.path().join("escaped.architecture.json");
        fs::write(
            &outside,
            r#"{"schema_version":1,"diagram_type":"architecture"}"#,
        )
        .unwrap();
        std::os::unix::fs::symlink(
            &outside,
            root.join("sites/gamma/architecture/gamma.architecture.json"),
        )
        .unwrap();

        let err = architecture_read_sibling_spec(
            root_arg(&root),
            "sites/gamma/architecture/gamma-rendered.html".to_string(),
        )
        .unwrap_err();

        assert_eq!(err, "Sibling spec escapes its submodule");
    }

    #[test]
    fn sibling_spec_oversize_is_refused() {
        let (_tmp, root) = workspace();
        let padded = format!(
            r#"{{"schema_version":1,"diagram_type":"architecture","pad":"{}"}}"#,
            "x".repeat(MAX_SPEC_BYTES as usize)
        );
        fs::write(
            root.join("sites/gamma/architecture/gamma.architecture.json"),
            padded,
        )
        .unwrap();

        let err = architecture_read_sibling_spec(
            root_arg(&root),
            "sites/gamma/architecture/gamma-rendered.html".to_string(),
        )
        .unwrap_err();

        assert!(err.starts_with("Sibling spec too large"), "{err}");
    }

    #[test]
    fn sibling_spec_wrong_type_or_version_is_refused() {
        let (_tmp, root) = workspace();
        let spec_path = root.join("sites/gamma/architecture/gamma.architecture.json");
        let viewer = "sites/gamma/architecture/gamma-rendered.html".to_string();

        fs::write(
            &spec_path,
            r#"{"schema_version":1,"diagram_type":"workflow"}"#,
        )
        .unwrap();
        assert_eq!(
            architecture_read_sibling_spec(root_arg(&root), viewer.clone()).unwrap_err(),
            "Sibling spec is not an architecture spec"
        );

        fs::write(
            &spec_path,
            r#"{"schema_version":"1","diagram_type":"architecture"}"#,
        )
        .unwrap();
        assert_eq!(
            architecture_read_sibling_spec(root_arg(&root), viewer).unwrap_err(),
            "Sibling spec has no numeric schema_version"
        );
    }

    #[test]
    fn sibling_spec_requires_a_listed_html_path() {
        let (_tmp, root) = workspace();

        for path in [
            "dev/stray/docs/architecture/stray-rendered.html".to_string(),
            "dev/alpha/docs/architecture/alpha.architecture.json".to_string(),
        ] {
            let err = architecture_read_sibling_spec(root_arg(&root), path.clone()).unwrap_err();
            assert_eq!(err, "Not a listed architecture blueprint", "{path}");
        }
        // A viewer that does not exist fails even earlier, at canonicalization.
        assert!(architecture_read_sibling_spec(
            root_arg(&root),
            "dev/alpha/docs/architecture/missing-rendered.html".to_string(),
        )
        .unwrap_err()
        .starts_with("Cannot open blueprint:"));
    }
}
