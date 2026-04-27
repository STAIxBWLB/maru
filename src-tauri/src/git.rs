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
