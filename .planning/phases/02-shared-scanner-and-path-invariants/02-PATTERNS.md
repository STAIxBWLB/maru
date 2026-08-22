# Phase 2: Shared Scanner and Path Invariants - Pattern Map

**Mapped:** 2026-08-23
**Files analyzed:** 11 (10 code files + 1 filesystem deletion)
**Analogs found:** 10 / 11 (the `Users/` deletion is a filesystem op, no code analog)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|-------------------|------|-----------|----------------|---------------|
| `src-tauri/src/paths.rs` (NEW) | utility (path invariants) | transform (lexical path predicates) | `src-tauri/src/vault.rs` (`lexical_normalize`, `resolve_inside_vault`) + `src-tauri/src/maru_dir.rs` (`ensure_within`) | exact |
| `src-tauri/src/lib.rs` (mod) | config (module registry) | — | itself (flat alphabetical mod list, lines 1-82) | exact |
| `src-tauri/src/workspace_files.rs` (mod) | scanner | file-I/O (WalkDir + filter_entry) | itself (current const owner); `vault.rs` sibling scanner | exact |
| `src-tauri/src/vault.rs` (mod) | scanner + shared predicate owner | file-I/O (WalkDir + filter_entry) | `workspace_files.rs` | exact |
| `src-tauri/src/secrets.rs` (mod) | scanner | file-I/O (component-wise prune) | `workspace_files.rs` | exact |
| `src-tauri/src/project_activity.rs` (mod) | scanner | file-I/O (component-wise prune + dot-prefix rule) | `workspace_files.rs` | exact |
| `src-tauri/src/evidence_binder.rs` (mod) | scanner | file-I/O (`matches!` prune) | `workspace_files.rs` + special `.maru` retention rule | role-match |
| `src-tauri/src/content_search.rs` (mod) | scanner/search service | file-I/O + subprocess (rg globs, walkdir fallback) | `workspace_files.rs` (imports its const today) | exact |
| `src-tauri/src/maru_dir.rs` (mod) | service (bootstrap) | file-I/O | source of `ensure_within`; call sites switch import only | exact |
| `src-tauri/src/skill_host/fs.rs` (mod) | utility (path constructors) | transform (home-root constructors) | itself (guard targets + existing test fixture) | exact |
| `Users/` tree (delete) | filesystem op | — | none — `rm -rf Users/` + `test ! -e Users` verification | no analog |

## Pattern Assignments

### `src-tauri/src/paths.rs` (NEW — utility, transform)

**Analogs:** `vault.rs` (helper conventions), `maru_dir.rs` (function to move), `workspace_files.rs` (const to move), module registry in `lib.rs`.

**Module conventions — doc comments, flat module, no pub use unless needed.** `paths.rs` must be declared in the alphabetical mod list. From `lib.rs:48-50` (insert between `ops_catalog` and `outlook_mso`):

```rust
mod ops_catalog;
mod paths; // ← NEW, alphabetical position
mod outlook_mso;
```

**Imports pattern** (modeled on `vault.rs:1-11` — external crates first, `std` interleaved by rustfmt ordering, then `crate::` imports):

```rust
use std::path::{Path, PathBuf};

use crate::vault::lexical_normalize;
```

**Core pattern 1 — the shared constant** (moves verbatim shape from `workspace_files.rs:21-29`, widened per D-03; note `pub` not `pub(crate)` so all six consumers can import it):

```rust
/// Directories produced by tooling, never authored content. Every scanner
/// prunes these; adding one is a one-line edit here (SCAN-01).
///
/// `.maru` is deliberately NOT here — it is Maru state, not a generated dir
/// (evidence_binder keeps a module-local check for it).
pub const GENERATED_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo", ".cache",
    ".git", ".venv", ".context", ".omc", ".omx", ".pnpm-store", "__pycache__",
];
```

**Core pattern 2 — `ensure_within` promoted verbatim** (move from `maru_dir.rs:190-196`; keep lexical per D-07, keep `Result<(), String>` per D-08-era convention; error message generalization is Claude's-discretion — see Pitfall 4 in RESEARCH.md, safest is verbatim):

```rust
/// Containment check: `child` must resolve (lexically — symlinks untouched)
/// to a path under `parent`. Canonical example for new path-accepting
/// commands (SCAN-03).
///
/// ```
/// // doc example per D-06
/// ```
pub fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Path escapes the .maru directory".to_string());
    }
    Ok(())
}
```

**Lexical-containment precedent to cite in doc comments** — `vault.rs:590-595` documents why `canonicalize()` is forbidden; `paths.rs` should carry the same rationale:

```rust
// Lexical containment: resolve `..`/`.` without following symlinks, then
// require the result to live under the ... root. Using canonicalize() here
// was wrong — it follows symlinks, so a deliberate symlink inside the vault
// ... would resolve outside the vault and falsely trigger an "escapes" error.
// Path traversal via `..` is still blocked by lexical_normalize.
```

**Core pattern 3 — the absolute-base guard helper** (new, per D-02/D-08; `Err` return, no panic/debug_assert):

```rust
/// SCAN-04: a home-rooted base must be absolute before anything joins
/// against it — a relative base silently materializes trees in the cwd
/// (the stray `Users/` incident class).
pub fn require_absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(format!("Home root must be absolute, got: {}", path.display()))
    }
}
```

**Unit test idiom** (in-file `#[cfg(test)] mod tests` at file bottom, `tempfile::TempDir` fixtures — the convention in 100+ modules; canonical-example tests per D-06):

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_within_accepts_descendant_and_rejects_escape() {
        let root = Path::new("/work/.maru/rules");
        assert!(ensure_within(root, &root.join("a/b.md")).is_ok());
        assert!(ensure_within(root, &root.join("../secrets/key")).is_err());
        assert!(ensure_within(root, Path::new("/elsewhere/x.md")).is_err());
    }
}
```

---

### `src-tauri/src/workspace_files.rs` (scanner, file-I/O) — rewire const owner

**Analog:** itself — the change is deletion of `pub(crate) const GENERATED_DIRS` at lines 21-29 plus an import swap; consumption sites (lines 625, 697) are untouched.

**Current consumption pattern to preserve** (lines 620-630 — WalkDir + `filter_entry` + injected list via `ScanFilter::is_excluded_path`):

```rust
        .filter_entry(|entry| {
            let path = entry.path();
            if path == vault {
                return true;
            }
            if scan_filter.is_excluded_path(path, vault, GENERATED_DIRS) {
                return false;
            }
            let rel = path.strip_prefix(vault).unwrap_or(path);
            !matches_maruignore(rel, &ignore_patterns)
        })
```

**Rewire shape:**

```rust
// DELETE lines 21-29 (the pub(crate) const)
// ADD to the crate-import group (line 17 area, alphabetical):
use crate::paths::GENERATED_DIRS;
```

**Test conventions to extend for SCAN-02** (lines 1231-1261 — `TempDir` + `write_file` helper + assert on collected `rel_path`s):

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn write_file(root: &Path, rel: &str, content: &[u8]) {
        let path = root.join(rel);
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, content).unwrap();
    }

    #[test]
    fn scanner_excludes_git_generated_hidden_and_maruignored_paths() { /* ... */ }
}
```

---

### `src-tauri/src/vault.rs` (scanner + shared predicate owner, file-I/O)

**Analog:** `workspace_files.rs` — same WalkDir idiom.

**Rewire shape:** delete private `const GENERATED_DIRS` (lines 22-30), add `use crate::paths::GENERATED_DIRS;` to the crate-import group (lines 15-18).

**CRITICAL — preserve the `generated_dirs` parameter** (Pitfall 5). `ScanFilter::is_excluded_path` at lines 238-259 must keep its injected-list signature; only the constant's origin changes:

```rust
    pub fn is_excluded_path(&self, path: &Path, root: &Path, generated_dirs: &[&str]) -> bool {
        let Ok(rel) = path.strip_prefix(root) else {
            return true;
        };
        if rel.as_os_str().is_empty() {
            return false;
        }
        let mut has_dot_segment = false;
        for component in rel.components() {
            let Component::Normal(value) = component else {
                continue;
            };
            let name = value.to_string_lossy();
            if generated_dirs.iter().any(|dir| name == *dir) {
                return true;
            }
            if name.starts_with('.') {
                has_dot_segment = true;
            }
        }
        has_dot_segment && !self.dot_path_allowed(rel)
    }
```

**Why:** `inbox.rs:877` (also `:958`, `:1021`) deliberately passes `&[]` to stay outside the union — its tests allowlist `.omc` drop folders:

```rust
            if scan_filter.is_excluded_path(path, vault, &[]) {
                return false;
            }
```

**Leave in place:** `lexical_normalize` (`vault.rs:614-634`, `pub`, 4 importers) — `paths.rs` imports it; optionally `pub use` re-export from `paths.rs` so new authors get both from one module (D-02 "one place to reach for").

---

### `src-tauri/src/secrets.rs` (scanner, file-I/O)

**Rewire shape:** delete private const (lines 12-25), add `use crate::paths::GENERATED_DIRS;` (the file already imports `crate::vault::lexical_normalize` at line 1 — same import style).

**Consumer works unchanged** — `should_prune` (lines 725-733) iterates `&[&str]`, so the union swap is transparent:

```rust
    rel.components().any(|component| match component {
        Component::Normal(name) => {
            let name = name.to_string_lossy();
            GENERATED_DIRS
                .iter()
                .any(|generated| generated == &name.as_ref())
        }
        _ => false,
    })
```

**Leave untouched:** the module-specific extra rules above it (`vault` / `.maru/secrets` / `.secrets` prefix checks, lines 715-723) — these are secrets-domain exclusions, not generated dirs.

---

### `src-tauri/src/project_activity.rs` (scanner, file-I/O)

**Rewire shape:** delete `const PRUNED_DIRS: [&str; 6]` (lines 27-34), add `use crate::paths::GENERATED_DIRS;`.

**`is_pruned_dir` rewire** (lines 336-344) — **keep the dot-prefix rule** (line 343); it is a documented, broader policy (Korean doc comment at 334-335 explains the root-skip contract):

```rust
/// 호출자는 depth 0(스캔 루트)에서 이 검사를 건너뛴다. ... (keep doc comment)
fn is_pruned_dir(path: &Path) -> bool {
    let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
        return false;
    };
    if GENERATED_DIRS.contains(&name) {   // ← was PRUNED_DIRS
        return true;
    }
    name.starts_with('.') && name.len() > 1   // KEEP — broader dot-dir policy
}
```

---

### `src-tauri/src/evidence_binder.rs` (scanner, file-I/O) — special `.maru` retention

**Rewire shape** — `is_excluded_dir` (lines 1333-1337) currently:

```rust
fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".git" | "node_modules" | "target" | "dist" | ".maru"))
}
```

**Target (Pitfall 3 — `.maru` MUST stay excluded but MUST NOT join the union):**

```rust
fn is_excluded_dir(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        // `.maru` is Maru state, not a generated dir — it stays out of
        // GENERATED_DIRS and is excluded here module-locally.
        .is_some_and(|name| GENERATED_DIRS.contains(&name) || name == ".maru")
}
```

Plus `use crate::paths::GENERATED_DIRS;` in the import block.

---

### `src-tauri/src/content_search.rs` (scanner + rg subprocess, file-I/O) — the sixth consumer

**Import repoint (Pitfall 1)** — line 7 today:

```rust
use crate::workspace_files::{is_binary_file, GENERATED_DIRS};
```

becomes:

```rust
use crate::paths::GENERATED_DIRS;
use crate::workspace_files::is_binary_file;
```

**Three use sites rewired transparently:** `:203` (fallback `is_excluded_path`), `:467` (fallback walkdir filter), and the rg glob loop at `:359-362`:

```rust
    for directory in GENERATED_DIRS {
        command.arg("-g").arg(format!("!{directory}/**"));
        command.arg("-g").arg(format!("!**/{directory}/**"));
    }
```

**Pitfall 2 — reconcile `rg_visibility` with the union** (lines 266-271). Once `.git ∈ GENERATED_DIRS`, the glob loop excludes `.git` unconditionally, so `exclude_git: false` (allowlist resurrection) is dead behavior. Current shape:

```rust
fn rg_visibility(scan_filter: &ScanFilter) -> RgVisibility {
    RgVisibility {
        hidden: scan_filter.includes_dot_folders(),
        exclude_git: !scan_filter.could_include_dot_folder_named(".git"),
    }
}
```

Recommended: `exclude_git: true` unconditionally (`.git` is covered by the glob loop) — final shape is Claude's-discretion per RESEARCH.md Open Question 2. **Do NOT** add generated-dir rejection in `ScanFilter::from_options` (that turns a silent scope reduction into a user-facing settings error).

**Update the allowlist test expectation** (`:867-900`) — the `git_allowed` case at `:889-899` must flip to the new expectation:

```rust
        let git_allowed = ScanFilter::from_options(Some(ScanOptions {
            include_dot_folders: vec!["nested/.git/refs".to_string()],
        }))
        .unwrap();
        assert_eq!(
            rg_visibility(&git_allowed),
            RgVisibility {
                hidden: true,
                exclude_git: false,   // ← becomes true; generated dirs are un-allowlistable
            }
        );
```

**Parity tests exist** (`rg_and_fallback_produce_identical_results`, `:902-917`) and skip gracefully when `rg` is absent — run content_search tests locally (rg 15.0.0 present) before merge.

---

### `src-tauri/src/maru_dir.rs` (service, file-I/O) — promote `ensure_within`

**Delete** the private copy at lines 190-196 (verbatim source shown in the `paths.rs` section above).

**Rewire the two call sites** — both are `validate_leaf_name` + join + `ensure_within` sequences (`:893-898`, `:1113-1118`):

```rust
fn rule_path(work: &Path, name: &str) -> Result<PathBuf, String> {
    validate_leaf_name(name)?;
    let path = rules_dir(work).join(format!("{name}.md"));
    ensure_within(&rules_dir(work), &path)?;   // ← now crate::paths::ensure_within
    Ok(path)
}
```

Add `use crate::paths::ensure_within;` (the file already imports `crate::vault::lexical_normalize` at line 24 — same style).

**DO NOT TOUCH** (D-06): `MARUIGNORE_DEFAULTS` (lines 79-93, user-facing file format, 13 entries), and the two sibling `ensure_within` copies with their own messages:

- `studio/mod.rs:287-293` — `"Studio state path escapes .maru/studio"`
- `diagram/mod.rs:68-74` — `"Diagram path escapes the diagrams folder"`

---

### `src-tauri/src/skill_host/fs.rs` (utility, transform) — SCAN-04 guard site

**Guard targets** (lines 13-22, 35-40) — `Result<PathBuf, String>` constructors with a `#[cfg(test)]` override early-return in the middle:

```rust
pub fn maru_home() -> Result<PathBuf, String> {
    if let Some(path) = test_maru_home_override() {
        return Ok(path.join(".maru"));      // ← relative override slips through HERE
    }
    Ok(home_dir()?.join(".maru"))
}

pub fn install_root_base() -> Result<PathBuf, String> {
    if let Some(path) = test_maru_home_override() {
        return Ok(path);                    // ← and HERE
    }
    home_dir()
}
```

**Guard shape (D-09 + Pitfall 6):** validate the FINAL value on every return path — either restructure to a single exit or wrap each `Ok(...)` with `crate::paths::require_absolute(...)`. `env_root()` (`:28`) and `skills_root()` (`:24`) derive from `maru_home()` and are covered transitively. All 15 downstream call sites already propagate `Result` — a new `Err` variant is fully compatible.

**Test fixture pattern already exists — copy it** (lines 193-246):

```rust
#[cfg(test)]
fn test_maru_home_override() -> Option<PathBuf> {
    std::env::var_os("MARU_TEST_HOME").map(PathBuf::from)
}

#[cfg(test)]
static MARU_TEST_HOME_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(test)]
pub(crate) fn test_maru_home_lock() -> MutexGuard<'static, ()> {
    MARU_TEST_HOME_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}
```

**New guard test** (in the existing `mod tests` at `:249`; env set/restore idiom from `BundleTestHome`'s `Drop`, `:225-233`; edition 2021 so `set_var` is safe):

```rust
    #[test]
    fn maru_home_rejects_relative_test_home() {
        let _guard = test_maru_home_lock();
        let previous = std::env::var_os("MARU_TEST_HOME");
        std::env::set_var("MARU_TEST_HOME", "relative-home");

        let home = maru_home();
        let env = env_root();
        let install = install_root_base();

        match previous {
            Some(value) => std::env::set_var("MARU_TEST_HOME", value),
            None => std::env::remove_var("MARU_TEST_HOME"),
        }

        assert!(home.is_err());
        assert!(env.is_err());
        assert!(install.is_err());
        // SCAN-04: the failure is loud AND nothing materializes in the cwd.
        assert!(!Path::new("relative-home").exists());
    }
```

---

### `src-tauri/src/lib.rs` (module registry)

**Pattern:** flat, strictly alphabetical `mod` list, one file per feature, visibility mostly private with `pub(crate)`/`pub` exceptions annotated inline (`lib.rs:1`, `:52`, `:67-73`, `:79`). Insert:

```rust
mod ops_catalog;      // :48
mod paths;            // NEW
mod outlook_mso;      // :49
```

**Hazard:** `lib.rs` is currently dirty from a concurrent session (hwped) — the insertion must land cleanly alongside those edits; re-verify line numbers if that session lands first.

---

### `Users/` tree deletion (SCAN-05)

No code analog. Verification-only pattern: `rm -rf Users/` + `test ! -e Users && git status --porcelain -- Users/` returns empty (tree is fully untracked, invisible to git only via `.gitignore:13` `node_modules/`). Must ship in the same plan/commit as the guard + guard test (D-10 / Pitfall 7) — deleting without the guard is cosmetic.

---

## Shared Patterns

### Error handling: `Result<T, String>` everywhere

**Source:** every module in scope (`maru_dir.rs:190`, `skill_host/fs.rs:13-22`, `vault.rs:611`)
**Apply to:** `paths.rs` (all three items), `skill_host/fs.rs` guard

```rust
// Err with a plain String — either a literal:
Err("Path escapes the .maru directory".to_string())
// or formatted with the offending value:
Err(format!("Home root must be absolute, got: {}", path.display()))
// propagated with ?:
ensure_within(&rules_dir(work), &path)?;
```

No `assert!`/panic, no `debug_assert!` (D-08) — release builds must fail loudly via `Err`.

### WalkDir + `filter_entry` prune idiom

**Source:** `workspace_files.rs:689-703`, `inbox.rs:873-883`, `content_search.rs:460-474`
**Apply to:** understanding every scanner rewire (no scanner's walk structure changes — only the constant's origin)

```rust
    for entry in WalkDir::new(vault)
        .follow_links(false)          // workspaces symlink into cloud trees; never descend
        .into_iter()
        .filter_entry(|entry| {
            let path = entry.path();
            if path == vault {        // never prune the root itself
                return true;
            }
            if scan_filter.is_excluded_path(path, vault, GENERATED_DIRS) {
                return false;         // prunes DESCENT, not just the entry
            }
            let rel = path.strip_prefix(vault).unwrap_or(path);
            !matches_maruignore(rel, &ignore_patterns)
        })
        .filter_map(Result::ok)
```

### `ponytail:` comment convention for deliberate simplifications

**Source:** `skill_host/store.rs:3740`, `:4049`; `scheduler.rs:37`; `today.rs:736`
**Apply to:** the guard if it has a known ceiling (e.g. it cannot distinguish a malicious relative override from a bug — it only makes the failure loud)

```rust
// ponytail: setup.sh mutations to ~/.maru/env are NOT rolled back on ...
```

### Test conventions

**Source:** `workspace_files.rs:1231-1302` (TempDir + write_file + rel_path assertions), `skill_host/fs.rs:193-246` (env-mutation lock + set/restore)
**Apply to:** all new tests in this phase

- In-file `#[cfg(test)] mod tests` at file bottom, `use super::*;`
- `tempfile::TempDir` fixtures (existing dependency, `Cargo.toml:54`)
- Env-mutating tests MUST hold `test_maru_home_lock()` and restore the previous value on all paths (process-global env races otherwise)
- rg-dependent tests skip via `if resolve_program("rg").is_none() { return; }` (`content_search.rs:904`)

### Import grouping

**Source:** `vault.rs:1-18`, `workspace_files.rs:15-19`, `secrets.rs:1-7`
**Apply to:** every rewired file — external crates + std (rustfmt-ordered) first, then `use crate::...` group; new `use crate::paths::...` lines go in the crate group alphabetically.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `Users/` deletion | filesystem op | — | Not code; verification step in plan (`rm -rf` + `test ! -e Users`) |

All code files have exact analogs — this phase is a pure in-repo refactor where the analogs ARE the files being changed.

## Metadata

**Analog search scope:** `src-tauri/src/` (workspace_files.rs, vault.rs, secrets.rs, project_activity.rs, evidence_binder.rs, content_search.rs, maru_dir.rs, skill_host/fs.rs, studio/mod.rs, diagram/mod.rs, inbox.rs, lib.rs)
**Files scanned:** 12 (10 scope files + 2 sibling ensure_within copies + inbox.rs exception sites)
**Pattern extraction date:** 2026-08-23
**Line-number caveat:** working tree @ dirty (concurrent hwped session touches `lib.rs`) — re-verify `lib.rs` line numbers before the mod-declaration insertion lands.
