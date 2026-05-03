// Lightweight git status by shelling out to the user's git binary. tolaria
// uses git2 for a much richer surface (commit, blame, log) but Phase 1B
// only needs a dirty/clean indicator, and shelling out keeps the dep
// surface flat. If we add commit-from-app, swap to git2 then.

use serde::Serialize;
use std::path::{Component, Path};
use std::process::Command;

use crate::vault_list::{assert_anchor_can_write, WorkspaceWriteAction};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    /// False when the path isn't inside a git repo at all.
    pub is_repo: bool,
    /// Files with unstaged changes (M/D in the second porcelain column).
    pub modified: usize,
    /// Files with staged changes (anything other than space/? in column 1).
    pub staged: usize,
    /// Untracked files (`?? path`).
    pub untracked: usize,
    /// False for fast badge polling where untracked files were intentionally
    /// skipped to avoid cold-start I/O.
    pub untracked_known: bool,
    /// Convenience: true when modified + staged + untracked == 0.
    pub clean: bool,
    /// Current branch name from `## …` line, or None when detached HEAD or
    /// repo not yet initialised.
    pub branch: Option<String>,
}

#[tauri::command]
pub fn git_status(vault_path: String) -> Result<GitStatus, String> {
    git_status_with_mode(vault_path, true)
}

#[tauri::command]
pub fn git_status_fast(vault_path: String) -> Result<GitStatus, String> {
    git_status_with_mode(vault_path, false)
}

fn git_status_with_mode(vault_path: String, include_untracked: bool) -> Result<GitStatus, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }

    let untracked_arg = if include_untracked { "-uall" } else { "-uno" };
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", untracked_arg, "--branch"])
        .current_dir(path)
        .output()
        .map_err(|err| format!("git invocation failed: {err}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // "not a git repository" is the legitimate not-a-repo case — surface
        // a clean GitStatus rather than an error so the badge can hide.
        if stderr.contains("not a git repository") {
            return Ok(GitStatus {
                is_repo: false,
                modified: 0,
                staged: 0,
                untracked: 0,
                untracked_known: include_untracked,
                clean: true,
                branch: None,
            });
        }
        return Err(format!("git status failed: {}", stderr.trim()));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut modified = 0usize;
    let mut staged = 0usize;
    let mut untracked = 0usize;
    let mut branch: Option<String> = None;

    for line in stdout.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            // Branch line: `main...origin/main` or `HEAD (no branch)` etc.
            let name = rest.split("...").next().unwrap_or(rest);
            // Trim ahead/behind annotation: "main [ahead 1, behind 2]"
            let trimmed = name.split_whitespace().next().unwrap_or(name).to_string();
            branch = Some(trimmed);
            continue;
        }
        if line.len() < 2 {
            continue;
        }
        let bytes = line.as_bytes();
        let staged_ch = bytes[0];
        let unstaged_ch = bytes[1];
        if staged_ch == b'?' && unstaged_ch == b'?' {
            untracked += 1;
            continue;
        }
        if staged_ch != b' ' && staged_ch != b'?' {
            staged += 1;
        }
        if unstaged_ch != b' ' && unstaged_ch != b'?' {
            modified += 1;
        }
    }

    Ok(GitStatus {
        is_repo: true,
        modified,
        staged,
        untracked,
        untracked_known: include_untracked,
        clean: modified == 0 && staged == 0 && (untracked == 0 || !include_untracked),
        branch,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Workspace-relative path. Renamed entries surface only the new path —
    /// commit dialog Phase 1B doesn't visualise renames yet.
    pub path: String,
    /// Porcelain v1 column 1 (index/staged status). Single char: M, A, D,
    /// R, C, ?, ! or space.
    pub index_status: String,
    /// Porcelain v1 column 2 (worktree status).
    pub worktree_status: String,
    /// Convenience flag — true when index_status indicates a staged change.
    pub staged: bool,
    /// True for `??` lines.
    pub untracked: bool,
}

/// List per-file changes in the working tree, capped so a runaway
/// vault doesn't bloat the commit-dialog payload. Caller can issue a
/// terminal `git status` for full detail when truncated.
const MAX_CHANGE_ROWS: usize = 200;

#[tauri::command]
pub fn git_changes(vault_path: String) -> Result<Vec<GitFileChange>, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(path)
        .output()
        .map_err(|err| format!("git invocation failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("not a git repository") {
            return Ok(Vec::new());
        }
        return Err(format!("git status failed: {}", stderr.trim()));
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut rows = Vec::new();
    for line in stdout.lines().take(MAX_CHANGE_ROWS) {
        if line.len() < 4 {
            continue;
        }
        let bytes = line.as_bytes();
        let index_ch = bytes[0] as char;
        let worktree_ch = bytes[1] as char;
        // Path follows the two-status chars and a space.
        let raw_path = &line[3..];
        // Rename lines: `R  old -> new` — surface only the new (right) side.
        let path = if let Some(idx) = raw_path.find(" -> ") {
            raw_path[idx + 4..].to_string()
        } else {
            raw_path.to_string()
        };
        let untracked = index_ch == '?' && worktree_ch == '?';
        let staged = !untracked && index_ch != ' ' && index_ch != '?';
        rows.push(GitFileChange {
            path,
            index_status: index_ch.to_string(),
            worktree_status: worktree_ch.to_string(),
            staged,
            untracked,
        });
    }
    Ok(rows)
}

/// Cap on diff bytes returned to the dialog. Anything larger gets
/// truncated with a tail marker — Phase 1B doesn't render full diffs
/// of huge files inline.
const MAX_DIFF_BYTES: usize = 64 * 1024;

#[tauri::command]
pub fn git_diff(vault_path: String, file_path: String) -> Result<String, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }

    // Combined diff: index changes ∪ worktree changes for this path. -U2
    // keeps context tight so dialog stays compact.
    let output = Command::new("git")
        .args(["diff", "HEAD", "--", &file_path])
        .arg("-U2")
        .current_dir(path)
        .output()
        .map_err(|err| format!("git diff failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        // For untracked files git diff HEAD errors. Fall through to a
        // raw-content fallback below.
        if !stderr.contains("does not exist in") && !stderr.is_empty() {
            return Err(format!("git diff failed: {}", stderr.trim()));
        }
    }

    let mut text = String::from_utf8_lossy(&output.stdout).to_string();
    if text.is_empty() {
        // Untracked file: synthesise a "+" diff from raw content so the
        // dialog has something useful to show.
        let abs = path.join(&file_path);
        if let Ok(content) = std::fs::read_to_string(&abs) {
            let prefixed: String = content
                .lines()
                .take(400)
                .map(|line| format!("+{line}\n"))
                .collect();
            text = format!("@@ untracked: {} @@\n{}", file_path, prefixed);
        }
    }

    if text.len() > MAX_DIFF_BYTES {
        text.truncate(MAX_DIFF_BYTES);
        text.push_str("\n… (truncated, run `git diff` for full output)");
    }

    Ok(text)
}

/// Stage all changes and create a commit. Hooks (pre-commit, commit-msg)
/// run as configured by the user — we never pass --no-verify, so a
/// failing hook surfaces as an error the user must resolve.
#[tauri::command]
pub fn git_commit(
    vault_path: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty.".to_string());
    }

    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    assert_anchor_can_write(&vault_path, WorkspaceWriteAction::Modify)?;

    let selected_paths = match paths {
        Some(paths) => {
            if paths.is_empty() {
                return Err("No files selected for commit.".to_string());
            }
            let mut out = Vec::with_capacity(paths.len());
            for path in paths {
                out.push(validate_git_pathspec(&path)?);
            }
            Some(out)
        }
        None => None,
    };

    let mut stage_cmd = Command::new("git");
    stage_cmd.current_dir(path);
    if let Some(paths) = selected_paths.as_ref() {
        stage_cmd.args(["add", "--"]).args(paths);
    } else {
        stage_cmd.args(["add", "-A"]);
    }
    let stage = stage_cmd
        .current_dir(path)
        .output()
        .map_err(|err| format!("git add failed: {err}"))?;
    if !stage.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&stage.stderr).trim()
        ));
    }

    let mut commit_cmd = Command::new("git");
    commit_cmd.args(["commit", "-m", trimmed]);
    if let Some(paths) = selected_paths.as_ref() {
        commit_cmd.arg("--").args(paths);
    }
    let commit = commit_cmd
        .current_dir(path)
        .output()
        .map_err(|err| format!("git commit failed: {err}"))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        let stdout = String::from_utf8_lossy(&commit.stdout);
        // git emits "nothing to commit" on stdout, error elsewhere on stderr.
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("git commit failed: {detail}"));
    }

    git_status(vault_path)
}

fn validate_git_pathspec(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("Invalid git path: empty".to_string());
    }
    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("Invalid git path: absolute paths are not allowed".to_string());
    }
    for component in path.components() {
        if matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        ) {
            return Err("Invalid git path: path traversal is not allowed".to_string());
        }
    }
    Ok(trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::process::Command;
    use tempfile::TempDir;

    #[test]
    fn non_directory_path_errors() {
        let result = git_status("/nonexistent/path/anchor-test".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn anchor_repo_reports_main_branch() {
        // The test runs from src-tauri/, which is inside the anchor git
        // repo. We don't assert clean/dirty (depends on test-time state),
        // but is_repo + branch should be populated.
        let cwd = std::env::current_dir().unwrap();
        let result = git_status(cwd.to_string_lossy().to_string()).unwrap();
        assert!(result.is_repo);
        assert!(result.branch.is_some());
        assert!(result.untracked_known);
    }

    #[test]
    fn fast_status_skips_untracked_enumeration() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "anchor@example.test"]);
        run_git(root, &["config", "user.name", "Anchor Test"]);
        fs::write(root.join("tracked.md"), "a\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "initial"]);
        fs::write(root.join("untracked.md"), "new\n").unwrap();

        let full = git_status(root.to_string_lossy().to_string()).unwrap();
        let fast = git_status_fast(root.to_string_lossy().to_string()).unwrap();

        assert_eq!(full.untracked, 1);
        assert!(full.untracked_known);
        assert_eq!(fast.untracked, 0);
        assert!(!fast.untracked_known);
    }

    #[test]
    fn commit_with_empty_message_errors() {
        let result = git_commit("/tmp".to_string(), "   \n\t".to_string(), None);
        assert!(result.is_err());
    }

    #[test]
    fn selected_commit_leaves_unselected_changes_dirty() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "anchor@example.test"]);
        run_git(root, &["config", "user.name", "Anchor Test"]);

        fs::write(root.join("a.md"), "a\n").unwrap();
        fs::write(root.join("b.md"), "b\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "initial"]);

        fs::write(root.join("a.md"), "a changed\n").unwrap();
        fs::write(root.join("b.md"), "b changed\n").unwrap();

        let status = git_commit(
            root.to_string_lossy().to_string(),
            "update a".to_string(),
            Some(vec!["a.md".to_string()]),
        )
        .unwrap();

        assert_eq!(status.modified, 1);
        assert!(!status.clean);
        let committed = Command::new("git")
            .args(["show", "--name-only", "--format=", "HEAD"])
            .current_dir(root)
            .output()
            .unwrap();
        let stdout = String::from_utf8_lossy(&committed.stdout);
        assert!(stdout.lines().any(|line| line == "a.md"));
        assert!(!stdout.lines().any(|line| line == "b.md"));
    }

    #[test]
    fn selected_commit_rejects_unsafe_paths() {
        let result = git_commit(
            "/tmp".to_string(),
            "msg".to_string(),
            Some(vec!["../outside.md".to_string()]),
        );

        assert!(result.is_err());
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = Command::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}
