// Lightweight git status by shelling out to the user's git binary. tolaria
// uses git2 for a much richer surface (commit, blame, log) but Phase 1B
// only needs a dirty/clean indicator, and shelling out keeps the dep
// surface flat. If we add commit-from-app, swap to git2 then.

use serde::Serialize;
use std::path::Path;
use std::process::Command;

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
    /// Convenience: true when modified + staged + untracked == 0.
    pub clean: bool,
    /// Current branch name from `## …` line, or None when detached HEAD or
    /// repo not yet initialised.
    pub branch: Option<String>,
}

#[tauri::command]
pub fn git_status(vault_path: String) -> Result<GitStatus, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Vault path is not a directory: {vault_path}"));
    }

    let output = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall", "--branch"])
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
        clean: modified == 0 && staged == 0 && untracked == 0,
        branch,
    })
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileChange {
    /// Vault-relative path. Renamed entries surface only the new path —
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
        return Err(format!("Vault path is not a directory: {vault_path}"));
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
        return Err(format!("Vault path is not a directory: {vault_path}"));
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
pub fn git_commit(vault_path: String, message: String) -> Result<GitStatus, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty.".to_string());
    }

    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Vault path is not a directory: {vault_path}"));
    }

    let stage = Command::new("git")
        .args(["add", "-A"])
        .current_dir(path)
        .output()
        .map_err(|err| format!("git add failed: {err}"))?;
    if !stage.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&stage.stderr).trim()
        ));
    }

    let commit = Command::new("git")
        .args(["commit", "-m", trimmed])
        .current_dir(path)
        .output()
        .map_err(|err| format!("git commit failed: {err}"))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        let stdout = String::from_utf8_lossy(&commit.stdout);
        // git emits "nothing to commit" on stdout, error elsewhere on stderr.
        let detail = if stderr.trim().is_empty() { stdout.trim() } else { stderr.trim() };
        return Err(format!("git commit failed: {detail}"));
    }

    git_status(vault_path)
}

#[cfg(test)]
mod tests {
    use super::*;

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
    }

    #[test]
    fn commit_with_empty_message_errors() {
        let result = git_commit("/tmp".to_string(), "   \n\t".to_string());
        assert!(result.is_err());
    }
}
