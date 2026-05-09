---
name: git-sync
description: >
  Public-safe Git synchronization skill for CWD-scoped pull, commit, and push
  workflows across nested submodules. Use when the user asks to sync
  repositories, pull all, push all, commit pending changes, update submodules,
  or run recursive repository maintenance. Workspace-specific paths, exclusions,
  project labels, owner identity, and remote details must be loaded from
  workspace.config.yaml, project-registry.yaml, .gitmodules, and the live Git
  repository, never from this skill package.
---

# Git Sync

Synchronize the current Git repository and its submodules without hardcoded
workspace identity. The current directory determines the sync boundary: operate
inside the current Git toplevel and its descendants only.

## Boot Sequence

1. Set `SYNC_ROOT` with `git rev-parse --show-toplevel`.
2. Walk up from the current directory to find `workspace.config.yaml`.
3. If found, read:
   - `git_sync` for confirmation and recursive exclusion policy
   - `submodules` for configured submodule metadata
   - `ssot.project_registry` for the project registry path
4. If `project-registry.yaml` is configured and present, read active entries for
   project labels, paths, and `is_submodule` hints.
5. Always read `.gitmodules` from `SYNC_ROOT` when present. Live Git topology and
   `git status` are the authority; config and registry data only label or filter
   the workflow.

If no workspace config exists, fall back to a normal Git repository workflow
using only `SYNC_ROOT`, `.gitmodules`, and live Git commands.

## Commands

```bash
/git-sync                     # pull -> commit -> push
/git-sync pull                # pull only
/git-sync push                # commit + push only
/git-sync --dry-run           # report status and planned actions only
/git-sync --include-excluded  # ignore configured recursive exclusions
/git-sync --auto              # skip per-commit confirmation when safe
```

## Scope Rules

- `SYNC_ROOT` is the current Git toplevel.
- Process only submodules below `SYNC_ROOT`.
- Include `SYNC_ROOT` itself in commit and push steps.
- Never update the parent repository of `SYNC_ROOT`.
- If the user starts inside a submodule, update that submodule and its children
  only. Parent pointer updates wait until the user runs the skill from the
  parent repository.

## Recursive Exclusions

Do not hardcode private workspace exclusions in this skill. Load them from:

```yaml
git_sync:
  confirm_before_commit: true
  recursive_excludes:
    - root: ~/path/to/workspace
      paths:
        - path/to/skip/
      reason: why this subtree is skipped during parent-level recursive sync
```

Apply an exclusion only when the expanded `root` equals `SYNC_ROOT`. The
`--include-excluded` flag bypasses these filters for the current run. Always list
skipped paths in the status report with the configured reason.

## Workflow

### 1. Status Scan

From `SYNC_ROOT`, collect status for the root and every included submodule:

```bash
git status --porcelain=v1
git submodule foreach --recursive 'git status --porcelain=v1'
```

Report clean, modified, staged, untracked, and pointer-only changes separately.
In `--dry-run` mode, stop after the report.

### 2. Bottom-Up Order

Process submodules deepest first so child commits exist before parent pointer
updates:

```bash
git submodule foreach --recursive --quiet 'printf "%s\n" "$displaypath"' \
  | awk '{ depth = gsub("/", "/"); print depth, $0 }' \
  | sort -rn \
  | cut -d" " -f2-
```

Filter this list with `git_sync.recursive_excludes` unless
`--include-excluded` is present.

### 3. Pull

For `sync` and `pull` modes:

- If a repo is dirty, stash before `git pull --rebase`, then pop the stash.
- If stash pop or rebase conflicts, stop work in that repo, leave the conflict
  visible, and report the path.
- If remote access fails, skip that repo and report the failing command.

### 4. Commit

For `sync` and `push` modes:

- Inspect `git status --porcelain=v1` and `git diff --stat` before staging.
- Stage only files that belong to the requested sync scope.
- Never stage secrets or private runtime files such as `.env`, credential files,
  key material, token caches, or files under configured secrets paths.
- Generate a conventional commit message from the actual diff.
- Ask before each commit unless `--auto` is present or
  `git_sync.confirm_before_commit: false`.
- Do not invent a personal `Co-Authored-By` trailer. Preserve existing repo
  conventions if they are already documented or present in recent commits.

### 5. Push

Push each changed repo with:

```bash
git push origin HEAD
```

Never force push, never use `--no-verify`, and do not run heavyweight history
maintenance such as `git gc` or `git repack` as part of this skill.

### 6. Root Update

After child repos are committed and pushed, return to `SYNC_ROOT`. If submodule
pointers or root files changed, stage only the relevant paths, commit, and push
`SYNC_ROOT`. Do not move upward to a parent repository.

## Output

Status reports should include:

```markdown
## Git Status Scan

SYNC_ROOT: <path>

| Repo | Branch | Status | Changes |
|------|--------|--------|---------|
| <root> | main | modified | 2 files |
| submodule/path | main | clean | - |

## Excluded From Recursive Sync

| Path | Reason |
|------|--------|
| path/to/skip/ | configured reason |
```

Completion reports should include:

```markdown
## Git Sync Report

SYNC_ROOT: <path>

| Repo | Action | Result |
|------|--------|--------|
| submodule/path | pull+commit+push | ok |
| <root> | pointer commit+push | ok |

Synced: 1
Skipped: 0
Errors: 0
```

## Safety Defaults

- Treat live Git output as authoritative.
- Keep dirty user changes visible; do not revert or discard them.
- Stop at conflicts and report exact paths.
- Keep parent pointer updates scoped to the repository where the user invoked
  the skill.
- Use `workspace.config.yaml` and `project-registry.yaml` for local policy and
  labels, not for embedded public-skill assumptions.
