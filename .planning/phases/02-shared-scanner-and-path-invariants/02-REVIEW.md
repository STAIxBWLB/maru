---
phase: 02-shared-scanner-and-path-invariants
reviewed: 2026-08-22T22:11:25Z
depth: standard
files_reviewed: 10
files_reviewed_list:
  - src-tauri/src/content_search.rs
  - src-tauri/src/evidence_binder.rs
  - src-tauri/src/lib.rs
  - src-tauri/src/maru_dir.rs
  - src-tauri/src/paths.rs
  - src-tauri/src/project_activity.rs
  - src-tauri/src/secrets.rs
  - src-tauri/src/skill_host/fs.rs
  - src-tauri/src/vault.rs
  - src-tauri/src/workspace_files.rs
findings:
  critical: 0
  warning: 3
  info: 7
  total: 10
status: issues_found
---

# Phase 2: Code Review Report

**Reviewed:** 2026-08-22T22:11:25Z
**Depth:** standard
**Files Reviewed:** 10
**Status:** issues_found

## Summary

The phase's core invariants hold up under review. The 14-entry `GENERATED_DIRS` union in `paths.rs` is genuinely shared: `vault.rs` (scan_vault, scan_vault_paths), `content_search.rs` (both rg and fallback engines), `workspace_files.rs` (both scan paths), `secrets.rs` (`should_prune`), `project_activity.rs` (`is_pruned_dir`), and `evidence_binder.rs` (`is_excluded_dir`) all consume it. `ScanFilter::is_excluded_path` keeps its injected `generated_dirs` parameter; containment stays lexical in `ensure_within`/`resolve_inside_vault`; `.maru` stays out of the union and is excluded module-locally in `evidence_binder.rs:1340` with a clear rationale comment; `require_absolute` returns `Err` on every `maru_home()`/`install_root_base()` path, never panics, and its test verifies no tree materializes in cwd.

The findings below are about the *edges* of the consolidation: a second unguarded `.maru` home constructor that SCAN-04 did not cover, a Windows symlink-type bug in the secrets migration (pre-existing, in a reviewed file), `normalize_existing_dir` still materializing directories on scan commands, and a private `lexical_normalize` copy that survived the promotion. No blockers.

## Warnings

### WR-01: SCAN-04 invariant not applied to `maru_dir::maru_home_dir()` — a second, unguarded `.maru` home constructor

**File:** `src-tauri/src/maru_dir.rs:158-162`
**Issue:** The phase added `require_absolute` to `skill_host/fs.rs::maru_home()` and `install_root_base()`, but `maru_dir.rs` keeps its own parallel home-rooted constructor:

```rust
fn maru_home_dir() -> Result<PathBuf, String> {
    dirs::home_dir()
        .map(|home| home.join(".maru"))
        .ok_or_else(|| "Could not determine home directory for ~/.maru".to_string())
}
```

On Unix, `dirs::home_dir()` returns `$HOME` verbatim when set — a relative or empty-but-present `HOME` yields a relative base, and this function then joins `.maru` onto it without the absolute guard. The result feeds `global_settings_json_path()` (maru_dir.rs:169-171), which `read_maru_settings`/`save_maru_settings` write through — the exact "relative base silently materializes trees in the cwd" incident class (stray `Users/`) that SCAN-04 was created to kill. The phase's invariant is therefore only half-applied: which guard you get depends on which of the two `~/.maru` constructors a caller happened to use. (`meetings.rs:440` repeats the same unguarded pattern but is outside this review's file set.)

**Fix:** Delete the private copy and route through the guarded constructor:

```rust
fn maru_home_dir() -> Result<PathBuf, String> {
    crate::skill_host::fs::maru_home()
}
```

If `skill_host` visibility makes that awkward, call `crate::paths::require_absolute(dirs::home_dir().ok_or_else(...)?.join(".maru"))` here — but one constructor is the better end state, matching the phase's "one place to reach for these invariants" rationale.

### WR-02: `create_relative_symlink` creates a file-type symlink for a directory target on Windows

**File:** `src-tauri/src/secrets.rs:1059-1063` (bug), triggered from `src-tauri/src/secrets.rs:292`
**Issue:** The `create-legacy-symlink` migration action does `create_relative_symlink(&paths.primary, &paths.legacy)` where `paths.primary` is the `.maru/secrets` **directory**. The Windows arm unconditionally calls `std::os::windows::fs::symlink_file`, producing a file-type symlink pointing at a directory. On Windows such a link is unusable (wrong link type; resolution fails), so the legacy `.secrets` compatibility symlink the migration promises is broken on exactly one platform. The other two call sites (lines 322, 343) target files and are fine. Note the neighboring code gets this right in both directions: `workspace_files.rs::copy_symlink` (lines 975-988) inspects target metadata to pick `symlink_dir` vs `symlink_file`, while `skill_host/fs.rs::create_symlink_no_clobber` (line 182) hardcodes `symlink_dir` — three call sites, three different answers.

**Fix:** Pick the link type from the target, mirroring `copy_symlink`:

```rust
#[cfg(not(unix))]
{
    if target.is_dir() {
        std::os::windows::fs::symlink_dir(&rel, link)
    } else {
        std::os::windows::fs::symlink_file(&rel, link)
    }
    .map_err(|err| format!("Cannot create symlink {}: {err}", link.display()))?;
}
```

### WR-03: `normalize_existing_dir` creates missing directories — scan commands still materialize trees on a typo path

**File:** `src-tauri/src/vault.rs:550-563`
**Issue:** Despite the name suggesting pure normalization, this helper calls `fs::create_dir_all` when the path does not exist. It fronts `scan_vault`, `scan_vault_paths`, `scan_workspace_files`, `scan_workspace_entries`, `evidence_binder_read`, and other commands whose job is to *read* a workspace. A mistyped or stale path from the frontend silently creates an empty directory tree at that location — the same "silent materialization" failure class SCAN-04 just guarded against for home roots, here on the workspace axis. The phase's own `content_search.rs::normalize_search_root` (lines 140-152) demonstrates the stricter contract: it returns `"Workspace path does not exist"` and its test (`missing_workspace_is_not_created`, content_search.rs:848-859) asserts nothing is created. This is pre-existing behavior and may be load-bearing for workspace-provisioning flows, which is why this is a Warning rather than a demand for immediate change — but the two sibling "normalize a workspace root" helpers now have opposite side-effect contracts, and the permissive one backs most read commands.

**Fix:** If auto-create is needed only for workspace provisioning, split the helpers: keep a `create_or_normalize_dir` for the provisioning call sites and make `normalize_existing_dir` fail on a missing path like `normalize_search_root` does. At minimum, document on the function that it creates directories so future read-only commands don't reach for it unknowingly.

## Info

### IN-01: Private `lexical_normalize` copy survives the promotion in `workspace_files.rs`

**File:** `src-tauri/src/workspace_files.rs:1159-1173`
**Issue:** A hand-rolled `lexical_normalize` remains in this file even though the phase promoted the canonical one to `crate::paths` (re-exported from `crate::vault`), and this same file already imports from `crate::vault` (lines 3-6). The two implementations are currently identical, but that is precisely the drift trap the shared module exists to close — `paths.rs`'s own doc comment says "new path-accepting commands import from here instead of growing another private copy."

**Fix:** Delete lines 1159-1173 and add `lexical_normalize` to the existing `use crate::vault::{...}` (or `use crate::paths::lexical_normalize;`).

### IN-02: `ensure_within` normalizes only the child, and its error text hardcodes ".maru directory"

**File:** `src-tauri/src/paths.rs:51-57`
**Issue:** Two small robustness gaps in the helper now advertised as the "canonical example for new path-accepting commands" (SCAN-03): (1) `parent` is not run through `lexical_normalize` — a caller passing a parent containing `.`/`..` segments gets false rejections (fail-closed in the cases I traced, but surprising); (2) the error message "Path escapes the .maru directory" is baked in even though the helper is generic — a future caller guarding a skills or evidence root would emit a misleading message.

**Fix:** Normalize both sides and parameterize or genericize the message, e.g. `Err(format!("Path escapes its allowed root: {}", child.display()))`, or accept a `context: &str` label.

### IN-03: `codex_home()` test-override branch bypasses the `require_absolute` guard

**File:** `src-tauri/src/skill_host/fs.rs:55-64`
**Issue:** When `MARU_TEST_HOME` is set, `codex_home()` returns `path.join(".codex")` directly without the absolute check that `maru_home()` and `install_root_base()` now apply to the same override value. A test that sets a relative `MARU_TEST_HOME` gets a loud `Err` from `maru_home()` but a silent relative path from `codex_home()` — inconsistent enforcement of the D-08/D-09 guard. Production impact is nil (the override is `cfg(test)`-only), hence Info.

**Fix:** Route the override branch through `require_absolute(path.join(".codex"))`, or share the base resolution with `maru_home()`.

### IN-04: Stale comment claims `prefixes` is sorted by descending path length; no sort exists

**File:** `src-tauri/src/project_activity.rs:259-271`
**Issue:** The comment says "(정규화 경로, id) 를 경로 길이 내림차순으로" (sorted by path length, descending), but `prefixes` is pushed in registry order and never sorted. This happens to be harmless — the loop at lines 303-314 checks *every* prefix against each file rather than first-match-wins, so order is irrelevant — but the comment describes an invariant the code does not maintain, and a future reader may "optimize" to first-match on the assumption the sort exists.

**Fix:** Either delete the sorting claim from the comment (order is irrelevant because all prefixes are checked) or actually sort if first-match semantics are ever introduced.

### IN-05: `.git` exclusion globs are passed to ripgrep twice

**File:** `src-tauri/src/content_search.rs:359-366`
**Issue:** `visibility.exclude_git` is unconditionally `true`, adding `-g '!.git/**' -g '!**/.git/**'` at lines 360-362, and then the `GENERATED_DIRS` loop at lines 363-366 adds the identical pair again because `.git` is in the union. Harmless (rg accepts duplicate globs) and the SCAN-02 comment explains the intent, but the `exclude_git` field is now dead weight — it can never be `false`.

**Fix:** Drop the `exclude_git` field and its arg block; the union loop already guarantees the exclusion. Keep the SCAN-02 comment on the loop.

### IN-06: `validate_leaf_name` validates the trimmed name, but callers join the untrimmed original

**File:** `src-tauri/src/maru_dir.rs:176-189` (validation), used at `src-tauri/src/maru_dir.rs:888` and `src-tauri/src/maru_dir.rs:1108`
**Issue:** `validate_leaf_name` checks `name.trim()` for emptiness and illegal characters, but `rule_path`/`template_path` then build the filename with the original `name`: `format!("{name}.md")`. A name like `" foo "` passes validation (trimmed `"foo"` is legal) and creates `.maru/rules/ foo .md` — a whitespace-padded filename the list/read commands then surface under a different stem than the caller intended. No traversal risk (slashes and `..` are still rejected), purely an input-normalization gap.

**Fix:** Have `validate_leaf_name` return the trimmed `&str` and join that: `let name = validate_leaf_name(name)?;` then `format!("{name}.md")`.

### IN-07: Scope observation — two private prune lists remain outside the union (outside reviewed file set)

**File:** `src-tauri/src/vault_watcher.rs:25-31` and `src-tauri/src/ops_catalog/scan.rs:672-726`
**Issue:** The phase collapsed five scanner prune lists into `GENERATED_DIRS`, but `vault_watcher.rs::relevant_path` still carries a 5-entry hardcoded list (`.git`, `node_modules`, `target`, `dist`, `build`) and `ops_catalog/scan.rs` carries two more private lists (including entries like `.obsidian`, `_axvsys` that are deliberately *not* in the union). Neither file is in this phase's review scope, and both plausibly have different requirements (watcher noise vs. ops-catalog semantics), so this is not a defect in the reviewed code — but `paths.rs:26-30` now claims "Every scanner prunes these," which these two modules falsify. If the divergence is intentional, the claim and the module inventory should be reconciled; if not, they are the remaining migration debt.

**Fix:** Decide per-module: rewire `vault_watcher.rs` to `GENERATED_DIRS` (its list is a strict subset), and either rewire `ops_catalog/scan.rs` with a local *extension* list or document why it intentionally differs.

---

_Reviewed: 2026-08-22T22:11:25Z_
_Reviewer: Claude (gsd-code-reviewer)_
_Depth: standard_
