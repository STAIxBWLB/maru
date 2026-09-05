// Lightweight git status by shelling out to the user's git binary. tolaria
// uses git2 for a much richer surface (commit, blame, log) but Phase 1B
// only needs a dirty/clean indicator, and shelling out keeps the dep
// surface flat. If we add commit-from-app, swap to git2 then.

use serde::Serialize;
use serde_json::json;
use serde_yaml::Value as YamlValue;
use std::collections::HashSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::Mutex;

// Conservative Git-domain serialization includes aliases and linked worktrees,
// whose stash refs live in the common git directory. Plan 08-29 adds shared
// path admission before this guard. Poisoning remains fail-closed.
static GIT_ACTION_LOCK: Mutex<()> = Mutex::new(());

fn git_command() -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new("git");
    #[cfg(test)]
    phase08_05::configure_git(&mut command);
    command
}

use crate::agent_host::contracts::{CompletionRequest, COMPLETION_REQUEST_SCHEMA_VERSION};
use crate::agent_host::provider::{build_cli_command, CliProviderKind};
use crate::approval::{require_approval, ApprovalState};
use crate::vault_list::{assert_maru_can_write, WorkspaceWriteAction};
use crate::win_process::NoWindow;

pub const GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND: &str = "git.sync.commit_push";

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

pub fn git_status(vault_path: String) -> Result<GitStatus, String> {
    git_status_with_mode(vault_path, true)
}

fn git_status_with_mode(vault_path: String, include_untracked: bool) -> Result<GitStatus, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }

    let untracked_arg = if include_untracked { "-uall" } else { "-uno" };
    let output = git_command()
        .args(["status", "--porcelain=v1", untracked_arg, "--branch"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(path)
        .no_window()
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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncExcludedPath {
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncRepo {
    pub path: String,
    pub rel_path: String,
    pub branch: Option<String>,
    pub status: String,
    pub changes: usize,
    pub paths: Vec<String>,
    pub clean: bool,
    pub excluded: bool,
    pub exclusion_reason: Option<String>,
    pub is_root: bool,
    pub depth: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncScanResult {
    pub sync_root: String,
    pub confirm_before_commit: bool,
    pub repos: Vec<GitSyncRepo>,
    pub excluded: Vec<GitSyncExcludedPath>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncPullResult {
    pub repo_path: String,
    pub stashed: bool,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncCommitPushResult {
    pub repo_path: String,
    pub committed: bool,
    pub pushed: bool,
    pub commit_stdout: String,
    pub push_stdout: String,
}

#[derive(Debug, Clone)]
struct RepoStatus {
    branch: Option<String>,
    paths: Vec<String>,
}

#[derive(Debug, Clone)]
struct ExclusionRule {
    path: String,
    reason: String,
}

/// List per-file changes in the working tree, capped so a runaway
/// vault doesn't bloat the commit-dialog payload. Caller can issue a
/// terminal `git status` for full detail when truncated.
const MAX_CHANGE_ROWS: usize = 200;

pub fn git_changes(vault_path: String) -> Result<Vec<GitFileChange>, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    let output = git_command()
        .args(["status", "--porcelain=v1", "-uall"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(path)
        .no_window()
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

pub fn git_diff(vault_path: String, file_path: String) -> Result<String, String> {
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    git_diff_for_path(path, &file_path)
}

fn git_diff_for_path(path: &Path, file_path: &str) -> Result<String, String> {
    // Combined diff: index changes ∪ worktree changes for this path. -U2
    // keeps context tight so dialog stays compact.
    let output = git_command()
        .args(["diff", "HEAD", "--", file_path])
        .arg("-U2")
        .current_dir(path)
        .no_window()
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
        let abs = path.join(file_path);
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

const MAX_COMMIT_PROMPT_BYTES: usize = 18 * 1024;
const MAX_COMMIT_DIFF_BYTES_PER_FILE: usize = 4 * 1024;

pub fn git_generate_commit_message(
    vault_path: String,
    paths: Vec<String>,
    runtime: String,
    command_override: Option<String>,
) -> Result<String, String> {
    if paths.is_empty() {
        return Err("No files selected for commit message generation.".to_string());
    }
    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    let selected_paths = validate_git_paths(paths)?;
    let prompt = build_commit_message_prompt(path, &selected_paths)?;
    let provider = CliProviderKind::parse(&runtime)?;
    let request = CompletionRequest {
        schema_version: COMPLETION_REQUEST_SCHEMA_VERSION.to_string(),
        provider: provider.id().to_string(),
        prompt,
        cwd: path.to_string_lossy().into_owned(),
        mode: "commit-message".to_string(),
        metadata: Some(json!({ "origin": "gitGenerateCommitMessage" })),
    };
    let add_dirs = vec![request.cwd.clone()];
    let (mut cmd, stdin_payload) = build_cli_command(
        provider,
        &request,
        &add_dirs,
        command_override
            .as_deref()
            .filter(|value| !value.trim().is_empty()),
        "plan",
    )?;
    cmd.current_dir(path)
        .stdin(if stdin_payload.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .no_window();
    let mut child = cmd
        .spawn()
        .map_err(|err| format!("commit_message_provider_spawn_failed: {err}"))?;
    if let Some(payload) = stdin_payload {
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(payload.as_bytes())
                .map_err(|err| format!("commit_message_provider_stdin_failed: {err}"))?;
        }
    }
    let output = child
        .wait_with_output()
        .map_err(|err| format!("commit_message_provider_wait_failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        let stdout = String::from_utf8_lossy(&output.stdout);
        let detail = [stderr.trim(), stdout.trim()]
            .into_iter()
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>()
            .join("\n");
        return Err(format!(
            "commit_message_provider_failed: {}",
            if detail.is_empty() {
                "provider exited without output"
            } else {
                detail.as_str()
            }
        ));
    }
    sanitize_commit_message(&String::from_utf8_lossy(&output.stdout))
}

fn build_commit_message_prompt(repo: &Path, paths: &[String]) -> Result<String, String> {
    reject_sensitive_paths_for_commit_message(paths)?;

    let mut out = String::new();
    out.push_str(
        "Write exactly one conventional commit subject line for these selected git changes.\n",
    );
    out.push_str("Rules:\n");
    out.push_str("- Output one line only.\n");
    out.push_str("- Use conventional format: type(scope): summary.\n");
    out.push_str(
        "- Do not include markdown, quotes, explanations, trailers, or co-author lines.\n",
    );
    out.push_str("- Base the message only on the selected paths and diffs below.\n\n");

    if let Ok(log) = git_output(repo, &["log", "--oneline", "-8"]) {
        if !log.trim().is_empty() {
            out.push_str("<recent_commits>\n");
            out.push_str(log.trim());
            out.push_str("\n</recent_commits>\n\n");
        }
    }

    out.push_str("<selected_paths>\n");
    for path in paths {
        out.push_str("- ");
        out.push_str(path);
        out.push('\n');
    }
    out.push_str("</selected_paths>\n\n");

    out.push_str("<diffs>\n");
    for path in paths {
        let mut diff = git_diff_for_path(repo, path)?;
        if diff.len() > MAX_COMMIT_DIFF_BYTES_PER_FILE {
            diff.truncate(MAX_COMMIT_DIFF_BYTES_PER_FILE);
            diff.push_str("\n... (file diff truncated)");
        }
        out.push_str("## ");
        out.push_str(path);
        out.push('\n');
        out.push_str(&diff);
        if !diff.ends_with('\n') {
            out.push('\n');
        }
        if out.len() > MAX_COMMIT_PROMPT_BYTES {
            out.truncate(MAX_COMMIT_PROMPT_BYTES);
            out.push_str("\n... (prompt truncated)");
            break;
        }
    }
    out.push_str("\n</diffs>");
    Ok(out)
}

fn sanitize_commit_message(raw: &str) -> Result<String, String> {
    for line in raw.lines() {
        let mut value = line.trim();
        if value.is_empty()
            || value.starts_with("```")
            || value.eq_ignore_ascii_case("commit message:")
            || value.eq_ignore_ascii_case("commit:")
        {
            continue;
        }
        if let Some(rest) = value.strip_prefix("- ") {
            value = rest.trim();
        }
        if let Some(rest) = value.strip_prefix("Commit message:") {
            value = rest.trim();
        }
        if let Some(rest) = value.strip_prefix("commit message:") {
            value = rest.trim();
        }
        let cleaned = value
            .trim_matches('"')
            .trim_matches('\'')
            .trim_matches('`')
            .trim()
            .to_string();
        if cleaned.is_empty() {
            continue;
        }
        let one_line = cleaned
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(160)
            .collect::<String>();
        return Ok(one_line);
    }
    Err("commit_message_provider_empty_output".to_string())
}

pub fn git_sync_scan(
    vault_path: String,
    include_excluded: Option<bool>,
) -> Result<GitSyncScanResult, String> {
    let start = Path::new(&vault_path);
    if !start.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    let sync_root = git_toplevel(start)?;
    let sync_root = sync_root
        .canonicalize()
        .map_err(|err| format!("git sync root invalid: {err}"))?;
    let config_path = find_workspace_config(start);
    let (confirm_before_commit, exclusion_rules) =
        read_git_sync_config(config_path.as_deref(), &sync_root)?;
    let include_excluded = include_excluded.unwrap_or(false);

    let mut repo_rels = list_submodule_paths(&sync_root)?;
    repo_rels.sort_by(|a, b| path_depth(b).cmp(&path_depth(a)).then_with(|| a.cmp(b)));
    repo_rels.push(String::new());

    let mut repos = Vec::new();
    let mut excluded = Vec::new();
    let mut seen_excluded = HashSet::new();
    for rule in &exclusion_rules {
        if seen_excluded.insert(rule.path.clone()) {
            excluded.push(GitSyncExcludedPath {
                path: rule.path.clone(),
                reason: rule.reason.clone(),
            });
        }
    }
    for rel in repo_rels {
        let exclusion = matching_exclusion(&rel, &exclusion_rules);
        if exclusion.is_some() && !include_excluded {
            continue;
        }
        let repo_path = if rel.is_empty() {
            sync_root.clone()
        } else {
            sync_root.join(&rel)
        };
        if !repo_path.is_dir() {
            continue;
        }
        let mut status = repo_status(&repo_path)?;
        if rel.is_empty() && !include_excluded {
            status
                .paths
                .retain(|path| matching_exclusion(path, &exclusion_rules).is_none());
        }
        let changes = status.paths.len();
        repos.push(GitSyncRepo {
            path: repo_path.to_string_lossy().into_owned(),
            rel_path: if rel.is_empty() {
                "<root>".to_string()
            } else {
                rel.clone()
            },
            branch: status.branch,
            status: if changes == 0 {
                "clean".to_string()
            } else {
                "modified".to_string()
            },
            changes,
            paths: status.paths,
            clean: changes == 0,
            excluded: exclusion.is_some(),
            exclusion_reason: exclusion.map(|rule| rule.reason.clone()),
            is_root: rel.is_empty(),
            depth: path_depth(&rel),
        });
    }

    Ok(GitSyncScanResult {
        sync_root: sync_root.to_string_lossy().into_owned(),
        confirm_before_commit,
        repos,
        excluded,
    })
}

/// Submodule display paths under a workspace root, for the Documents pane scope
/// filter. `git submodule foreach` reports `$displaypath` relative to the cwd,
/// so running it at the workspace root yields paths that line up with
/// `VaultEntry.rel_path`.
pub fn list_workspace_submodules(workspace_path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&workspace_path);
    if !root.is_dir() {
        return Err(format!(
            "Workspace path is not a directory: {workspace_path}"
        ));
    }
    let mut paths = list_submodule_paths(root)?;
    // A workspace nested inside a bigger repo also sees the superproject's other
    // submodules; those come back as "../..." and sit outside this workspace.
    paths.retain(|path| !path.starts_with("../") && !Path::new(path).is_absolute());
    Ok(paths)
}

pub fn git_sync_pull_rebase(repo_path: String) -> Result<GitSyncPullResult, String> {
    let _guard = GIT_ACTION_LOCK
        .lock()
        .map_err(|_| "git_action_lock_poisoned".to_string())?;
    #[cfg(test)]
    phase08_05::transaction_edge();
    let repo = Path::new(&repo_path);
    if !repo.is_dir() {
        return Err(format!("Repository path is not a directory: {repo_path}"));
    }
    assert_maru_can_write(&repo_path, WorkspaceWriteAction::Modify)?;

    let dirty_before = !repo_status(repo)?.paths.is_empty();
    let mut stashed = false;
    if dirty_before {
        let stash = git_command()
            .args(["stash", "push", "-u", "-m", "maru-git-sync-before-pull"])
            .current_dir(repo)
            .no_window()
            .output()
            .map_err(|err| format!("git stash failed: {err}"))?;
        if !stash.status.success() {
            return Err(format!(
                "git stash failed: {}",
                String::from_utf8_lossy(&stash.stderr).trim()
            ));
        }
        let stdout = String::from_utf8_lossy(&stash.stdout);
        stashed = !stdout.contains("No local changes to save");
    }

    let pull = git_command()
        .args(["pull", "--rebase"])
        .current_dir(repo)
        .no_window()
        .output()
        .map_err(|err| format!("git pull --rebase failed: {err}"))?;
    if !pull.status.success() {
        return Err(format!(
            "git pull --rebase failed: {}",
            String::from_utf8_lossy(&pull.stderr).trim()
        ));
    }

    if stashed {
        let pop = git_command()
            .args(["stash", "pop"])
            .current_dir(repo)
            .no_window()
            .output()
            .map_err(|err| format!("git stash pop failed: {err}"))?;
        if !pop.status.success() {
            return Err(format!(
                "git stash pop failed: {}",
                String::from_utf8_lossy(&pop.stderr).trim()
            ));
        }
    }

    Ok(GitSyncPullResult {
        repo_path,
        stashed,
        stdout: String::from_utf8_lossy(&pull.stdout).to_string(),
        stderr: String::from_utf8_lossy(&pull.stderr).to_string(),
    })
}

pub fn git_sync_commit_push(
    state: tauri::State<'_, ApprovalState>,
    repo_path: String,
    message: String,
    paths: Option<Vec<String>>,
    approval_id: Option<String>,
) -> Result<GitSyncCommitPushResult, String> {
    let _guard = GIT_ACTION_LOCK
        .lock()
        .map_err(|_| "git_action_lock_poisoned".to_string())?;
    #[cfg(test)]
    phase08_05::transaction_edge();
    require_git_sync_commit_push_approval(state.inner(), approval_id)?;
    let repo = Path::new(&repo_path);
    if !repo.is_dir() {
        return Err(format!("Repository path is not a directory: {repo_path}"));
    }
    assert_maru_can_write(&repo_path, WorkspaceWriteAction::Modify)?;
    let selected_paths = match paths {
        Some(paths) if !paths.is_empty() => Some(validate_git_paths(paths)?),
        _ => None,
    };
    let paths_for_secret_check = selected_paths.clone().unwrap_or_else(|| {
        repo_status(repo)
            .map(|status| status.paths)
            .unwrap_or_default()
    });
    reject_sensitive_paths(&paths_for_secret_check)?;

    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty.".to_string());
    }

    let mut stage_cmd = git_command();
    stage_cmd.current_dir(repo);
    if let Some(paths) = selected_paths.as_ref() {
        stage_cmd.args(["add", "--"]).args(paths);
    } else {
        stage_cmd.args(["add", "-A"]);
    }
    let stage = stage_cmd
        .no_window()
        .output()
        .map_err(|err| format!("git add failed: {err}"))?;
    if !stage.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&stage.stderr).trim()
        ));
    }

    let mut commit_cmd = git_command();
    commit_cmd.args(["commit", "-m", trimmed]);
    if let Some(paths) = selected_paths.as_ref() {
        commit_cmd.arg("--").args(paths);
    }
    let commit = commit_cmd
        .current_dir(repo)
        .no_window()
        .output()
        .map_err(|err| format!("git commit failed: {err}"))?;
    if !commit.status.success() {
        let stderr = String::from_utf8_lossy(&commit.stderr);
        let stdout = String::from_utf8_lossy(&commit.stdout);
        let detail = if stderr.trim().is_empty() {
            stdout.trim()
        } else {
            stderr.trim()
        };
        return Err(format!("git commit failed: {detail}"));
    }

    let push = git_command()
        .args(git_push_args())
        .current_dir(repo)
        .no_window()
        .output()
        .map_err(|err| format!("git push failed: {err}"))?;
    if !push.status.success() {
        return Err(format!(
            "git push failed: {}",
            String::from_utf8_lossy(&push.stderr).trim()
        ));
    }

    Ok(GitSyncCommitPushResult {
        repo_path,
        committed: true,
        pushed: true,
        commit_stdout: String::from_utf8_lossy(&commit.stdout).to_string(),
        push_stdout: String::from_utf8_lossy(&push.stdout).to_string(),
    })
}

fn require_git_sync_commit_push_approval(
    state: &ApprovalState,
    approval_id: Option<String>,
) -> Result<(), String> {
    require_approval(state, approval_id, GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND)
}

fn git_toplevel(start: &Path) -> Result<PathBuf, String> {
    let output = git_command()
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(start)
        .no_window()
        .output()
        .map_err(|err| format!("git rev-parse failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git rev-parse failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(PathBuf::from(
        String::from_utf8_lossy(&output.stdout).trim(),
    ))
}

fn repo_status(repo: &Path) -> Result<RepoStatus, String> {
    let output = git_command()
        .args(["status", "--porcelain=v1", "-uall", "--branch"])
        .env("GIT_OPTIONAL_LOCKS", "0")
        .current_dir(repo)
        .no_window()
        .output()
        .map_err(|err| format!("git status failed: {err}"))?;
    if !output.status.success() {
        return Err(format!(
            "git status failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let mut branch = None;
    let mut paths = Vec::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            let name = rest.split("...").next().unwrap_or(rest);
            branch = Some(name.split_whitespace().next().unwrap_or(name).to_string());
            continue;
        }
        if line.len() < 4 {
            continue;
        }
        let raw_path = &line[3..];
        let path = if let Some(idx) = raw_path.find(" -> ") {
            raw_path[idx + 4..].to_string()
        } else {
            raw_path.to_string()
        };
        paths.push(path);
    }
    Ok(RepoStatus { branch, paths })
}

fn git_output(repo: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .args(args)
        .current_dir(repo)
        .no_window()
        .output()
        .map_err(|err| format!("git {:?} failed: {err}", args))?;
    if !output.status.success() {
        return Err(format!(
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).to_string())
}

fn list_submodule_paths(sync_root: &Path) -> Result<Vec<String>, String> {
    let output = git_command()
        .args([
            "submodule",
            "foreach",
            "--recursive",
            "--quiet",
            "printf '%s\n' \"$displaypath\"",
        ])
        .current_dir(sync_root)
        .no_window()
        .output()
        .map_err(|err| format!("git submodule foreach failed: {err}"))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if !stderr.trim().is_empty() {
            return Err(format!("git submodule foreach failed: {}", stderr.trim()));
        }
    }
    let mut paths: Vec<String> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
        .map(str::to_string)
        .collect();
    paths.sort();
    paths.dedup();
    Ok(paths)
}

fn path_depth(path: &str) -> usize {
    path.split('/').filter(|part| !part.is_empty()).count()
}

fn find_workspace_config(start: &Path) -> Option<PathBuf> {
    let mut current = Some(start);
    while let Some(path) = current {
        let candidate = path.join("workspace.config.yaml");
        if candidate.is_file() {
            return Some(candidate);
        }
        current = path.parent();
    }
    None
}

fn read_git_sync_config(
    config_path: Option<&Path>,
    sync_root: &Path,
) -> Result<(bool, Vec<ExclusionRule>), String> {
    let Some(config_path) = config_path else {
        return Ok((true, Vec::new()));
    };
    let content = std::fs::read_to_string(config_path)
        .map_err(|err| format!("Cannot read {}: {err}", config_path.display()))?;
    let yaml: YamlValue = serde_yaml::from_str(&content)
        .map_err(|err| format!("workspace.config.yaml parse failed: {err}"))?;
    let git_sync = yaml.get("git_sync").unwrap_or(&YamlValue::Null);
    let confirm = git_sync
        .get("confirm_before_commit")
        .and_then(YamlValue::as_bool)
        .unwrap_or(true);
    let mut rules = Vec::new();
    let Some(items) = git_sync
        .get("recursive_excludes")
        .and_then(YamlValue::as_sequence)
    else {
        return Ok((confirm, rules));
    };
    let canonical_sync_root = sync_root
        .canonicalize()
        .unwrap_or_else(|_| sync_root.to_path_buf());
    for item in items {
        let root = item.get("root").and_then(YamlValue::as_str).unwrap_or("");
        if root.trim().is_empty() {
            continue;
        }
        let expanded_root = expand_home(root);
        let normalized_root = expanded_root
            .canonicalize()
            .unwrap_or_else(|_| expanded_root.clone());
        if normalized_root != canonical_sync_root {
            continue;
        }
        let reason = item
            .get("reason")
            .and_then(YamlValue::as_str)
            .unwrap_or("configured recursive exclusion")
            .to_string();
        if let Some(paths) = item.get("paths").and_then(YamlValue::as_sequence) {
            for path in paths {
                let value = path
                    .as_str()
                    .or_else(|| path.get("path").and_then(YamlValue::as_str))
                    .unwrap_or("")
                    .trim()
                    .trim_end_matches('/');
                if !value.is_empty() {
                    rules.push(ExclusionRule {
                        path: value.to_string(),
                        reason: reason.clone(),
                    });
                }
            }
        }
    }
    Ok((confirm, rules))
}

fn expand_home(value: &str) -> PathBuf {
    if let Some(rest) = value.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(value)
}

fn matching_exclusion<'a>(rel: &str, rules: &'a [ExclusionRule]) -> Option<&'a ExclusionRule> {
    if rel.is_empty() {
        return None;
    }
    rules.iter().find(|rule| {
        rel == rule.path
            || rel
                .strip_prefix(&rule.path)
                .is_some_and(|rest| rest.starts_with('/'))
    })
}

fn validate_git_paths(paths: Vec<String>) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("No files selected for commit.".to_string());
    }
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        out.push(validate_git_pathspec(&path)?);
    }
    Ok(out)
}

fn reject_sensitive_paths(paths: &[String]) -> Result<(), String> {
    let sensitive = sensitive_git_paths(paths);
    if sensitive.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "git sync refuses to stage sensitive runtime/credential paths: {}",
            sensitive.join(", ")
        ))
    }
}

fn reject_sensitive_paths_for_commit_message(paths: &[String]) -> Result<(), String> {
    let sensitive = sensitive_git_paths(paths);
    if sensitive.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "commit message generation refuses to send sensitive runtime/credential paths to an AI provider: {}",
            sensitive.join(", ")
        ))
    }
}

fn sensitive_git_paths(paths: &[String]) -> Vec<String> {
    paths
        .iter()
        .filter(|path| is_sensitive_git_path(path))
        .cloned()
        .collect()
}

/// Secret-shaped repo path: credentials, keys, and runtime secret stores that
/// must never be staged, sent to an AI provider, or written by a remote
/// actor. Shared with `web_actions.rs`, which applies it to web-supplied
/// task paths.
pub(crate) fn is_sensitive_git_path(path: &str) -> bool {
    let lower = path.to_lowercase();
    let name = Path::new(&lower)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    lower.starts_with(".secrets/")
        || lower.contains("/.secrets/")
        || lower.starts_with(".maru/secrets/")
        || lower.contains("/.maru/secrets/")
        || lower.starts_with(".env")
        || lower.contains("/.env")
        || name == "id_rsa"
        || name == "id_ed25519"
        || name.ends_with(".pem")
        || name.ends_with(".key")
        || name.ends_with(".p12")
        || name.ends_with(".pfx")
        || lower.contains("credential")
        || lower.contains("token")
}

fn git_push_args() -> [&'static str; 3] {
    ["push", "origin", "HEAD"]
}

/// Stage all changes and create a commit. Hooks (pre-commit, commit-msg)
/// run as configured by the user — we never pass --no-verify, so a
/// failing hook surfaces as an error the user must resolve.
pub fn git_commit(
    vault_path: String,
    message: String,
    paths: Option<Vec<String>>,
) -> Result<GitStatus, String> {
    let _guard = GIT_ACTION_LOCK
        .lock()
        .map_err(|_| "git_action_lock_poisoned".to_string())?;
    #[cfg(test)]
    phase08_05::transaction_edge();
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Commit message is empty.".to_string());
    }

    let path = Path::new(&vault_path);
    if !path.is_dir() {
        return Err(format!("Workspace path is not a directory: {vault_path}"));
    }
    assert_maru_can_write(&vault_path, WorkspaceWriteAction::Modify)?;

    let selected_paths = match paths {
        Some(paths) => {
            if paths.is_empty() {
                return Err("No files selected for commit.".to_string());
            }
            Some(validate_git_paths(paths)?)
        }
        None => None,
    };

    let mut stage_cmd = git_command();
    stage_cmd.current_dir(path);
    if let Some(paths) = selected_paths.as_ref() {
        stage_cmd.args(["add", "--"]).args(paths);
    } else {
        stage_cmd.args(["add", "-A"]);
    }
    let stage = stage_cmd
        .current_dir(path)
        .no_window()
        .output()
        .map_err(|err| format!("git add failed: {err}"))?;
    if !stage.status.success() {
        return Err(format!(
            "git add failed: {}",
            String::from_utf8_lossy(&stage.stderr).trim()
        ));
    }

    let mut commit_cmd = git_command();
    commit_cmd.args(["commit", "-m", trimmed]);
    if let Some(paths) = selected_paths.as_ref() {
        commit_cmd.arg("--").args(paths);
    }
    let commit = commit_cmd
        .current_dir(path)
        .no_window()
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
    use tempfile::TempDir;

    #[test]
    fn non_directory_path_errors() {
        let result = git_status("/nonexistent/path/maru-test".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn maru_repo_reports_main_branch() {
        let fixture = TempDir::new().unwrap();
        run_git(fixture.path(), &["init", "-b", "main"]);
        let result = git_status(fixture.path().to_string_lossy().to_string()).unwrap();
        assert!(result.is_repo);
        assert!(result.branch.is_some());
        assert!(result.untracked_known);
    }

    #[test]
    fn fast_status_skips_untracked_enumeration() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "maru@example.test"]);
        run_git(root, &["config", "user.name", "Maru Test"]);
        fs::write(root.join("tracked.md"), "a\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "initial"]);
        fs::write(root.join("untracked.md"), "new\n").unwrap();

        let full = git_status(root.to_string_lossy().to_string()).unwrap();
        let fast = git_status_with_mode(root.to_string_lossy().to_string(), false).unwrap();

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
        let _home = phase08_05::Home::new();
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "maru@example.test"]);
        run_git(root, &["config", "user.name", "Maru Test"]);

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
        let committed = git_command()
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
        let _home = phase08_05::Home::new();
        let result = git_commit(
            "/tmp".to_string(),
            "msg".to_string(),
            Some(vec!["../outside.md".to_string()]),
        );

        assert!(result.is_err());
    }

    #[test]
    fn commit_message_prompt_uses_only_selected_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        fs::write(root.join("a.md"), "a\n").unwrap();
        fs::write(root.join("b.md"), "b\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "initial"]);

        fs::write(root.join("a.md"), "selected change\n").unwrap();
        fs::write(root.join("b.md"), "unselected change\n").unwrap();

        let prompt = build_commit_message_prompt(root, &["a.md".to_string()]).unwrap();

        assert!(prompt.contains("a.md"));
        assert!(prompt.contains("selected change"));
        assert!(!prompt.contains("b.md"));
        assert!(!prompt.contains("unselected change"));
    }

    #[test]
    fn commit_message_prompt_truncates_large_diffs() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        fs::write(root.join("big.md"), "a\n").unwrap();
        run_git(root, &["add", "."]);
        run_git(root, &["commit", "-m", "initial"]);
        fs::write(root.join("big.md"), "x\n".repeat(30_000)).unwrap();

        let prompt = build_commit_message_prompt(root, &["big.md".to_string()]).unwrap();

        assert!(prompt.len() <= MAX_COMMIT_PROMPT_BYTES + 64);
        assert!(prompt.contains("truncated"));
    }

    #[test]
    fn commit_message_prompt_rejects_sensitive_paths_before_diffing() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        init_repo(root);
        fs::write(root.join(".env"), "API_TOKEN=secret\n").unwrap();

        let result = build_commit_message_prompt(root, &[".env".to_string()]);

        let err = result.unwrap_err();
        assert!(err.contains("refuses to send sensitive"));
        assert!(err.contains(".env"));
    }

    #[test]
    fn sensitive_path_check_rejects_maru_secrets() {
        assert!(is_sensitive_git_path(
            ".maru/secrets/apple/keychain-password"
        ));
        assert!(is_sensitive_git_path("nested/.maru/secrets/workspace.env"));
    }

    #[test]
    fn git_sync_scan_respects_workspace_recursive_excludes() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let child_src = tmp.path().join("child-src");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&child_src).unwrap();
        init_repo(&child_src);
        fs::write(child_src.join("child.md"), "child\n").unwrap();
        run_git(&child_src, &["add", "."]);
        run_git(&child_src, &["commit", "-m", "child initial"]);

        init_repo(&root);
        run_git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child_src.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(&root, &["commit", "-am", "add child"]);
        fs::write(
            root.join("workspace.config.yaml"),
            format!(
                "git_sync:\n  confirm_before_commit: true\n  recursive_excludes:\n    - root: {}\n      paths:\n        - deps/child\n      reason: skip child\n",
                root.display()
            ),
        )
        .unwrap();
        fs::write(root.join("deps/child/child.md"), "dirty child\n").unwrap();

        let scan = git_sync_scan(root.to_string_lossy().to_string(), Some(false)).unwrap();

        assert_eq!(scan.excluded.len(), 1);
        assert_eq!(scan.excluded[0].path, "deps/child");
        assert!(scan.repos.iter().all(|repo| repo.rel_path != "deps/child"));
        let root_repo = scan.repos.iter().find(|repo| repo.is_root).unwrap();
        assert!(!root_repo.paths.iter().any(|path| path == "deps/child"));
    }

    #[test]
    fn list_workspace_submodules_reports_workspace_relative_paths() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path().join("root");
        let child_src = tmp.path().join("child-src");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&child_src).unwrap();
        init_repo(&child_src);
        fs::write(child_src.join("child.md"), "child\n").unwrap();
        run_git(&child_src, &["add", "."]);
        run_git(&child_src, &["commit", "-m", "child initial"]);

        init_repo(&root);
        run_git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                child_src.to_str().unwrap(),
                "deps/child",
            ],
        );
        run_git(&root, &["commit", "-am", "add child"]);

        let paths = list_workspace_submodules(root.to_string_lossy().to_string()).unwrap();

        // The Documents scope filter matches these against VaultEntry.rel_path,
        // so they must be workspace-relative, not absolute and not "../"-prefixed.
        assert_eq!(paths, vec!["deps/child".to_string()]);
    }

    #[test]
    fn git_sync_commit_push_requires_approval_kind() {
        let state = ApprovalState::default();
        let result = require_git_sync_commit_push_approval(&state, None);

        assert!(result.unwrap_err().starts_with("approval_required"));
    }

    #[test]
    fn git_sync_push_args_never_force_or_skip_hooks() {
        let args = git_push_args();

        assert_eq!(args, ["push", "origin", "HEAD"]);
        assert!(!args.contains(&"--force"));
        assert!(!args.contains(&"--no-verify"));
    }

    fn run_git(root: &Path, args: &[&str]) {
        let output = git_command().args(args).current_dir(root).output().unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}{}",
            args,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn init_repo(root: &Path) {
        run_git(root, &["init"]);
        run_git(root, &["config", "user.email", "maru@example.test"]);
        run_git(root, &["config", "user.name", "Maru Test"]);
    }
}

/// IPC owns values before offloading; synchronous Rust callers keep their API.
pub mod ipc {
    use super::*;
    use tauri::Manager;

    #[tauri::command]
    pub async fn git_status(vault_path: String) -> Result<GitStatus, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_status");
            super::git_status(vault_path)
        })
        .await
        .map_err(|err| format!("git_status_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_changes(vault_path: String) -> Result<Vec<GitFileChange>, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_changes");
            super::git_changes(vault_path)
        })
        .await
        .map_err(|err| format!("git_changes_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_diff(vault_path: String, file_path: String) -> Result<String, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_diff");
            super::git_diff(vault_path, file_path)
        })
        .await
        .map_err(|err| format!("git_diff_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_generate_commit_message(
        vault_path: String,
        paths: Vec<String>,
        runtime: String,
        command_override: Option<String>,
    ) -> Result<String, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_generate_commit_message");
            super::git_generate_commit_message(vault_path, paths, runtime, command_override)
        })
        .await
        .map_err(|err| format!("git_generate_commit_message_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_sync_scan(
        vault_path: String,
        include_excluded: Option<bool>,
    ) -> Result<GitSyncScanResult, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_sync_scan");
            super::git_sync_scan(vault_path, include_excluded)
        })
        .await
        .map_err(|err| format!("git_sync_scan_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn list_workspace_submodules(workspace_path: String) -> Result<Vec<String>, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "list_workspace_submodules");
            super::list_workspace_submodules(workspace_path)
        })
        .await
        .map_err(|err| format!("list_workspace_submodules_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_sync_pull_rebase(repo_path: String) -> Result<GitSyncPullResult, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_sync_pull_rebase");
            super::git_sync_pull_rebase(repo_path)
        })
        .await
        .map_err(|err| format!("git_sync_pull_rebase_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_sync_commit_push<R: tauri::Runtime>(
        app: tauri::AppHandle<R>,
        repo_path: String,
        message: String,
        paths: Option<Vec<String>>,
        approval_id: Option<String>,
    ) -> Result<GitSyncCommitPushResult, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_sync_commit_push");
            super::git_sync_commit_push(
                app.state::<ApprovalState>(),
                repo_path,
                message,
                paths,
                approval_id,
            )
        })
        .await
        .map_err(|err| format!("git_sync_commit_push_task_failed: {err}"))?
    }

    #[tauri::command]
    pub async fn git_commit(
        vault_path: String,
        message: String,
        paths: Option<Vec<String>>,
    ) -> Result<GitStatus, String> {
        #[cfg(test)]
        let fixture = phase08_05::capture();
        tauri::async_runtime::spawn_blocking(move || {
            #[cfg(test)]
            let _fixture = phase08_05::enter(fixture, "git_commit");
            super::git_commit(vault_path, message, paths)
        })
        .await
        .map_err(|err| format!("git_commit_task_failed: {err}"))?
    }
}

#[cfg(test)]
mod phase08_05 {
    use super::*;
    use std::cell::RefCell;
    use std::future::Future;
    use std::sync::{mpsc, Arc};
    use std::time::Duration;
    use tauri::Manager;
    use tempfile::TempDir;

    type Hook = Arc<dyn Fn(&str) + Send + Sync>;
    thread_local! { static HOOK: RefCell<Option<Hook>> = RefCell::new(None); }
    pub(super) fn capture() -> Option<Hook> {
        HOOK.with(|hook| hook.borrow().clone())
    }
    pub(super) struct Reset(Option<Hook>);
    impl Drop for Reset {
        fn drop(&mut self) {
            HOOK.with(|hook| *hook.borrow_mut() = self.0.take());
        }
    }
    pub(super) fn enter(hook: Option<Hook>, edge: &str) -> Reset {
        let old = HOOK.with(|slot| slot.replace(hook));
        let reset = Reset(old);
        if let Some(hook) = capture() {
            hook(edge);
        }
        reset
    }
    pub(super) fn transaction_edge() {
        if let Some(hook) = capture() {
            hook("transaction");
        }
    }
    pub(super) fn configure_git(command: &mut Command) {
        // Per-child isolation; never rewrite the developer's global Git config.
        for (key, _) in std::env::vars_os() {
            if key.to_string_lossy().starts_with("GIT_") {
                command.env_remove(key);
            }
        }
        let null = if cfg!(windows) { "NUL" } else { "/dev/null" };
        command
            .env("GIT_CONFIG_GLOBAL", null)
            .env("GIT_CONFIG_SYSTEM", null)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GIT_ALLOW_PROTOCOL", "file")
            .args([
                "-c",
                "user.name=Maru Fixture",
                "-c",
                "user.email=fixture@example.test",
                "-c",
                "commit.gpgsign=false",
                "-c",
                "tag.gpgsign=false",
                "-c",
                &format!("core.hooksPath={null}"),
                "-c",
                "credential.helper=",
                "-c",
                "protocol.file.allow=always",
            ]);
        if let Some(hook) = capture() {
            hook("process");
        }
    }
    pub(super) struct Home {
        _dir: TempDir,
        previous: Option<std::ffi::OsString>,
        _guard: std::sync::MutexGuard<'static, ()>,
    }
    impl Home {
        pub(super) fn new() -> Self {
            let guard = crate::skill_host::fs::test_maru_home_lock();
            let dir = TempDir::new().unwrap();
            let previous = std::env::var_os("MARU_TEST_CONFIG_DIR");
            std::env::set_var("MARU_TEST_CONFIG_DIR", dir.path());
            Self {
                _dir: dir,
                previous,
                _guard: guard,
            }
        }
    }
    impl Drop for Home {
        fn drop(&mut self) {
            match self.previous.take() {
                Some(value) => std::env::set_var("MARU_TEST_CONFIG_DIR", value),
                None => std::env::remove_var("MARU_TEST_CONFIG_DIR"),
            }
        }
    }
    fn run(repo: &Path, args: &[&str]) -> String {
        let output = git_command().args(args).current_dir(repo).output().unwrap();
        assert!(
            output.status.success(),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).into_owned()
    }
    fn repo() -> TempDir {
        let dir = TempDir::new().unwrap();
        run(dir.path(), &["init", "-b", "main"]);
        std::fs::write(dir.path().join("note.md"), "initial\n").unwrap();
        run(dir.path(), &["add", "--", "note.md"]);
        run(dir.path(), &["commit", "-m", "initial"]);
        dir
    }
    fn app() -> tauri::App<tauri::test::MockRuntime> {
        let app = tauri::test::mock_app();
        app.manage(ApprovalState::default());
        app
    }
    // Both futures are polled by one task on Tauri's runtime. A direct blocking
    // call freezes the probe even if another runtime worker is idle.
    fn boundary<T: Send + 'static>(
        name: &'static str,
        future: impl Future<Output = Result<T, String>> + Send + 'static,
    ) {
        let (entered_tx, entered_rx) = tauri::async_runtime::channel(1);
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let hook: Hook = Arc::new(move |edge| {
            if edge == name {
                entered_tx
                    .blocking_send(std::thread::current().id())
                    .unwrap();
                release_rx
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_secs(5))
                    .unwrap();
                panic!("fixture boundary panic");
            }
        });
        tauri::async_runtime::block_on(tauri::async_runtime::spawn(async move {
            let caller = std::thread::current().id();
            let _reset = enter(Some(hook), "caller");
            let mut future = Box::pin(future);
            // Start the actual wrapper on this task, then cooperatively await the
            // worker marker. A sync wrapper blocks here until the timeout/panic.
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(future.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            drop(_reset);
            let mut entered_rx = entered_rx;
            let worker = entered_rx.recv().await.unwrap();
            let mut yielded = false;
            std::future::poll_fn(|cx| {
                if yielded {
                    std::task::Poll::Ready(())
                } else {
                    yielded = true;
                    cx.waker().wake_by_ref();
                    std::task::Poll::Pending
                }
            })
            .await;
            assert_ne!(caller, worker);
            release_tx.send(()).unwrap();
            assert!(
                matches!(future.await, Err(e) if e.starts_with(&format!("{name}_task_failed:")))
            );
        }))
        .unwrap();
    }
    #[test]
    fn every_git_wrapper_holds_a_distinct_worker_and_same_task_yields() {
        let app = app();
        boundary("git_status", ipc::git_status(String::new()));
        boundary("git_changes", ipc::git_changes(String::new()));
        boundary("git_diff", ipc::git_diff(String::new(), String::new()));
        boundary(
            "git_generate_commit_message",
            ipc::git_generate_commit_message(String::new(), vec![], String::new(), None),
        );
        boundary("git_sync_scan", ipc::git_sync_scan(String::new(), None));
        boundary(
            "list_workspace_submodules",
            ipc::list_workspace_submodules(String::new()),
        );
        boundary(
            "git_sync_pull_rebase",
            ipc::git_sync_pull_rebase(String::new()),
        );
        boundary(
            "git_sync_commit_push",
            ipc::git_sync_commit_push(
                app.handle().clone(),
                String::new(),
                String::new(),
                None,
                None,
            ),
        );
        boundary(
            "git_commit",
            ipc::git_commit(String::new(), String::new(), None),
        );
    }
    #[test]
    fn read_wrappers_return_real_nonempty_payloads_and_legacy_errors() {
        let root = repo();
        let path = root.path().to_string_lossy().into_owned();
        std::fs::write(root.path().join("note.md"), "changed\n").unwrap();
        tauri::async_runtime::block_on(async {
            assert_eq!(ipc::git_status(path.clone()).await.unwrap().modified, 1);
            assert_eq!(
                ipc::git_changes(path.clone()).await.unwrap()[0].path,
                "note.md"
            );
            assert!(ipc::git_diff(path.clone(), "note.md".into())
                .await
                .unwrap()
                .contains("+changed"));
            let scan = ipc::git_sync_scan(path.clone(), None).await.unwrap();
            assert_eq!(scan.repos.len(), 1);
            assert_eq!(scan.repos[0].changes, 1);
            assert!(ipc::list_workspace_submodules(path.clone())
                .await
                .unwrap()
                .is_empty());
            assert_eq!(
                ipc::git_generate_commit_message(path.clone(), vec![], "invalid".into(), None)
                    .await
                    .unwrap_err(),
                "No files selected for commit message generation."
            );
            assert!(ipc::git_generate_commit_message(
                path,
                vec![".env".into()],
                "invalid".into(),
                None
            )
            .await
            .unwrap_err()
            .contains("refuses to send sensitive"));
        });
    }
    #[test]
    fn selected_commit_and_denied_approval_preserve_disk_and_contract() {
        let _home = Home::new();
        let root = repo();
        let path = root.path().to_string_lossy().into_owned();
        std::fs::write(root.path().join("note.md"), "changed\n").unwrap();
        std::fs::write(root.path().join("other.md"), "retain\n").unwrap();
        let app = app();
        let before = run(root.path(), &["rev-parse", "HEAD"]);
        let (tx, rx) = mpsc::channel();
        let _reset = enter(
            Some(Arc::new(move |edge| {
                if edge == "process" {
                    tx.send(()).unwrap();
                }
            })),
            "caller",
        );
        let err = tauri::async_runtime::block_on(ipc::git_sync_commit_push(
            app.handle().clone(),
            path.clone(),
            "denied".into(),
            None,
            None,
        ))
        .unwrap_err();
        assert_eq!(err, "approval_required: git.sync.commit_push");
        assert!(rx.try_recv().is_err(), "denied approval launched Git");
        assert_eq!(run(root.path(), &["rev-parse", "HEAD"]), before);
        let status = tauri::async_runtime::block_on(ipc::git_commit(
            path,
            "update note".into(),
            Some(vec!["note.md".into()]),
        ))
        .unwrap();
        assert_eq!(status.untracked, 1);
        assert!(!status.clean);
        assert_eq!(
            run(root.path(), &["show", "--format=", "--name-only", "HEAD"]).trim(),
            "note.md"
        );
    }
    #[test]
    fn local_pull_failure_retains_stash_and_releases_transaction() {
        let _home = Home::new();
        let root = repo();
        std::fs::write(root.path().join("note.md"), "stash me\n").unwrap();
        let path = root.path().to_string_lossy().into_owned();
        let error =
            tauri::async_runtime::block_on(ipc::git_sync_pull_rebase(path.clone())).unwrap_err();
        assert!(error.starts_with("git pull --rebase failed:"));
        assert!(run(root.path(), &["stash", "list"]).contains("maru-git-sync-before-pull"));
        assert!(GIT_ACTION_LOCK.try_lock().is_ok());
        assert!(
            tauri::async_runtime::block_on(ipc::git_commit(path, " ".into(), None))
                .unwrap_err()
                .contains("empty")
        );
    }
    #[cfg(unix)]
    #[test]
    fn alias_commits_wait_inside_worker_and_keep_both_selected_updates() {
        let _home = Home::new();
        let root = repo();
        std::fs::write(root.path().join("note.md"), "one\n").unwrap();
        std::fs::write(root.path().join("other.md"), "two\n").unwrap();
        let alias_parent = TempDir::new().unwrap();
        let alias = alias_parent.path().join("alias");
        std::os::unix::fs::symlink(root.path(), &alias).unwrap();
        let (held_tx, held_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let release_rx = Mutex::new(release_rx);
        let first_path = root.path().to_string_lossy().into_owned();
        let first = std::thread::spawn(move || {
            let _reset = enter(
                Some(Arc::new(move |edge| {
                    if edge == "transaction" {
                        held_tx.send(()).unwrap();
                        release_rx
                            .lock()
                            .unwrap()
                            .recv_timeout(Duration::from_secs(5))
                            .unwrap();
                    }
                })),
                "caller",
            );
            tauri::async_runtime::block_on(ipc::git_commit(
                first_path,
                "first".into(),
                Some(vec!["note.md".into()]),
            ))
        });
        held_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        let (started_tx, started_rx) = mpsc::channel();
        let (entered_tx, entered_rx) = mpsc::channel();
        let second = std::thread::spawn(move || {
            let _reset = enter(
                Some(Arc::new(move |edge| {
                    if edge == "git_commit" {
                        started_tx.send(()).unwrap();
                    }
                    if edge == "transaction" {
                        entered_tx.send(()).unwrap();
                    }
                })),
                "caller",
            );
            tauri::async_runtime::block_on(ipc::git_commit(
                alias.to_string_lossy().into_owned(),
                "second".into(),
                Some(vec!["other.md".into()]),
            ))
        });
        started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(GIT_ACTION_LOCK.try_lock().is_err());
        assert!(entered_rx.try_recv().is_err());
        release_tx.send(()).unwrap();
        assert_eq!(first.join().unwrap().unwrap().untracked, 1);
        assert!(second.join().unwrap().unwrap().clean);
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert_eq!(
            run(root.path(), &["rev-list", "--count", "HEAD"]).trim(),
            "3"
        );
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.md")).unwrap(),
            "one\n"
        );
    }
    #[test]
    fn approved_commit_push_and_dirty_pull_use_only_local_remote() {
        let _home = Home::new();
        let root = repo();
        let remote = TempDir::new().unwrap();
        run(remote.path(), &["init", "--bare", "-b", "main"]);
        run(
            root.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        run(root.path(), &["push", "-u", "origin", "main"]);
        let app = app();
        let request = crate::approval::prepare_approval(
            app.state(),
            GIT_SYNC_COMMIT_PUSH_APPROVAL_KIND.into(),
            "fixture".into(),
            None,
            None,
        )
        .unwrap();
        crate::approval::record_approval(
            app.state(),
            request.id.clone(),
            crate::approval::ApprovalDecision::Approved,
            None,
        )
        .unwrap();
        std::fs::write(root.path().join("note.md"), "committed\n").unwrap();
        let path = root.path().to_string_lossy().into_owned();
        let pushed = tauri::async_runtime::block_on(ipc::git_sync_commit_push(
            app.handle().clone(),
            path.clone(),
            "approved".into(),
            Some(vec!["note.md".into()]),
            Some(request.id.clone()),
        ))
        .unwrap();
        assert!(pushed.committed && pushed.pushed);
        assert_eq!(
            run(root.path(), &["rev-parse", "HEAD"]),
            run(remote.path(), &["rev-parse", "main"])
        );
        let repeated = tauri::async_runtime::block_on(ipc::git_sync_commit_push(
            app.handle().clone(),
            path.clone(),
            "repeat".into(),
            None,
            Some(request.id),
        ))
        .unwrap_err();
        assert_eq!(repeated, "approval_consumed");
        std::fs::write(root.path().join("note.md"), "dirty preserved\n").unwrap();
        let pull = tauri::async_runtime::block_on(ipc::git_sync_pull_rebase(path)).unwrap();
        assert!(pull.stashed);
        assert!(run(root.path(), &["stash", "list"]).is_empty());
        assert_eq!(
            std::fs::read_to_string(root.path().join("note.md")).unwrap(),
            "dirty preserved\n"
        );
    }
    #[test]
    fn permission_is_reread_under_transaction_before_any_process() {
        let home = Home::new();
        let root = repo();
        let path = root.path().to_string_lossy().into_owned();
        let config = home
            ._dir
            .path()
            .join("com.maru.app")
            .join("workspaces.json");
        std::fs::create_dir_all(config.parent().unwrap()).unwrap();
        let registry = json!({"workspaces":[{"label":"fixture","path":path,"visibility":"private","provider":"local","writePolicy":"readOnly"}]});
        let (tx, rx) = mpsc::channel();
        let _reset = enter(
            Some(Arc::new(move |edge| {
                if edge == "transaction" {
                    std::fs::write(&config, registry.to_string()).unwrap();
                }
                if edge == "process" {
                    tx.send(()).unwrap();
                }
            })),
            "caller",
        );
        let error =
            tauri::async_runtime::block_on(ipc::git_commit(path.clone(), "denied".into(), None))
                .unwrap_err();
        assert!(error.starts_with("Workspace writes are blocked"), "{error}");
        let error = tauri::async_runtime::block_on(ipc::git_sync_pull_rebase(path)).unwrap_err();
        assert!(error.starts_with("Workspace writes are blocked"));
        assert!(rx.try_recv().is_err(), "permission denial launched Git");
    }
    #[cfg(unix)]
    #[test]
    fn fake_commit_provider_preserves_readonly_argv_stdin_and_exit_error() {
        use std::os::unix::fs::PermissionsExt;
        let root = repo();
        std::fs::write(root.path().join("note.md"), "provider fixture\n").unwrap();
        let script = root.path().join("fixture-provider");
        std::fs::write(&script, "#!/bin/sh\nprintf '%s\\n' \"$@\" > provider-args\ncat > provider-input\nprintf '%s\\n' 'feat(fixture): generated subject'\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        let path = root.path().to_string_lossy().into_owned();
        let result = tauri::async_runtime::block_on(ipc::git_generate_commit_message(
            path.clone(),
            vec!["note.md".into()],
            "codex".into(),
            Some(script.to_string_lossy().into_owned()),
        ))
        .unwrap();
        assert_eq!(result, "feat(fixture): generated subject");
        let args = std::fs::read_to_string(root.path().join("provider-args")).unwrap();
        assert!(args.starts_with("exec\n--sandbox\nread-only\n--cd\n"));
        assert!(args.ends_with("-\n"));
        assert!(std::fs::read_to_string(root.path().join("provider-input"))
            .unwrap()
            .contains("+provider fixture"));
        std::fs::write(
            &script,
            "#!/bin/sh\ncat >/dev/null\necho fixture failure >&2\nexit 7\n",
        )
        .unwrap();
        let error = tauri::async_runtime::block_on(ipc::git_generate_commit_message(
            path,
            vec!["note.md".into()],
            "codex".into(),
            Some(script.to_string_lossy().into_owned()),
        ))
        .unwrap_err();
        assert_eq!(error, "commit_message_provider_failed: fixture failure");
    }
    #[test]
    fn rebase_conflict_preserves_stash_and_does_not_automatically_retry() {
        let _home = Home::new();
        let root = repo();
        let remote = TempDir::new().unwrap();
        let peer = TempDir::new().unwrap();
        run(remote.path(), &["init", "--bare", "-b", "main"]);
        run(
            root.path(),
            &["remote", "add", "origin", remote.path().to_str().unwrap()],
        );
        run(root.path(), &["push", "-u", "origin", "main"]);
        run(
            peer.path(),
            &["clone", remote.path().to_str().unwrap(), "."],
        );
        std::fs::write(peer.path().join("note.md"), "remote conflict\n").unwrap();
        run(peer.path(), &["commit", "-am", "remote"]);
        run(peer.path(), &["push", "origin", "HEAD"]);
        std::fs::write(root.path().join("note.md"), "local conflict\n").unwrap();
        run(root.path(), &["commit", "-am", "local"]);
        std::fs::write(root.path().join("retain.md"), "stash fixture\n").unwrap();
        let error = tauri::async_runtime::block_on(ipc::git_sync_pull_rebase(
            root.path().to_string_lossy().into_owned(),
        ))
        .unwrap_err();
        assert!(error.starts_with("git pull --rebase failed:"));
        assert!(run(root.path(), &["status", "--porcelain"]).contains("UU note.md"));
        assert_eq!(run(root.path(), &["stash", "list"]).lines().count(), 1);
        assert!(GIT_ACTION_LOCK.try_lock().is_ok());
    }
    #[test]
    fn pull_and_commit_push_wait_for_transaction_before_validation_or_process() {
        let _home = Home::new();
        let root = repo();
        let app = app();
        // Hold the same domain gate as git_commit. Both other writer entry
        // points must queue in blocking workers, before even consuming approval.
        let guard = GIT_ACTION_LOCK.lock().unwrap();
        let (entered_tx, entered_rx) = mpsc::channel();
        let (effect_tx, effect_rx) = mpsc::channel();
        let hook: Hook = Arc::new(move |edge| {
            if edge == "git_sync_pull_rebase" || edge == "git_sync_commit_push" {
                entered_tx.send(()).unwrap();
            }
            if edge == "transaction" || edge == "process" {
                effect_tx.send(()).unwrap();
            }
        });
        let pull_path = root.path().to_string_lossy().into_owned();
        let push_path = pull_path.clone();
        let pull_hook = hook.clone();
        let pull = std::thread::spawn(move || {
            let _reset = enter(Some(pull_hook), "caller");
            tauri::async_runtime::block_on(ipc::git_sync_pull_rebase(pull_path))
        });
        let handle = app.handle().clone();
        let push = std::thread::spawn(move || {
            let _reset = enter(Some(hook), "caller");
            tauri::async_runtime::block_on(ipc::git_sync_commit_push(
                handle,
                push_path,
                "denied".into(),
                None,
                None,
            ))
        });
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
        assert!(effect_rx.try_recv().is_err());
        drop(guard);
        assert!(pull
            .join()
            .unwrap()
            .unwrap_err()
            .starts_with("git pull --rebase failed:"));
        assert_eq!(
            push.join().unwrap().unwrap_err(),
            "approval_required: git.sync.commit_push"
        );
    }
}
