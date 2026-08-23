# Phase 2: Shared Scanner and Path Invariants - Research

**Researched:** 2026-08-23
**Domain:** Rust backend refactoring — shared directory-prune constant, lexical path-containment helper, absolute-base guard (no new dependencies, no external APIs)
**Confidence:** HIGH (every claim below was verified against the working tree this session; no external research needed)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions
- **D-01:** A new `src-tauri/src/paths.rs` module is the canonical home. Not a widened `workspace_files.rs`, not `vault.rs`.
- **D-02:** `paths.rs` holds all three invariants together: `pub const GENERATED_DIRS`, `ensure_within`, and the absolute-base join guard.
- **D-03:** One flat `GENERATED_DIRS` constant, the full 14-entry union: `node_modules, target, dist, build, .next, .turbo, .cache, .git, .venv, .context, .omc, .omx, .pnpm-store, __pycache__`. No core+extras split.
- **D-04:** All five scanners consume the union, including `evidence_binder.rs`'s `matches!` (widens 4 → 14). The resulting scan-scope reduction (no `.git`/`.venv` descent anywhere) is the intended behavior change of SCAN-02, not a regression.
- **D-05:** `maru_dir.rs`'s `MARUIGNORE_DEFAULTS` stays separate and unchanged — it is a user-facing file format, not a scanner constant.
- **D-06:** `ensure_within` is promoted to `paths.rs` with a module-level doc example and unit tests as the canonical demonstration. No existing caller is converted — `Component::ParentDir` checks, substring `..` checks, and `ensure_within`'s `starts_with` check are not equivalent, so converting a caller is a behavior change this phase must not smuggle in.
- **D-07:** Path containment stays lexical. No `canonicalize()` in `ensure_within` — user-created symlinks inside a workspace stay part of it.
- **D-08:** The non-absolute-base guard returns `Err`, matching the `Result<T, String>` command convention. No `assert!`/panic, no `debug_assert!`.
- **D-09:** The guard lives inside `maru_home()` / `install_root_base()` (in `skill_host/fs.rs`), which validate `is_absolute` before returning. One check covers every join site.
- **D-10:** SCAN-05's delete of `Users/` ships in the same phase as the guard.

### Claude's Discretion
- Exact unit-test shapes, fixture layout, and how each scanner's call site is rewired to the shared constant (mechanical, planner-owned).
- Whether `ensure_within`'s error message ("Path escapes the .maru directory") is generalized now that it is no longer maru-dir-specific.

### Deferred Ideas (OUT OF SCOPE)
None — discussion stayed within phase scope.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| SCAN-01 | One-line, one-file prune-list edit honored by all five scanners | Rewire map in §Architecture Patterns; the five lists verified verbatim below; sixth consumer `content_search.rs` discovered (Pitfall 1) |
| SCAN-02 | Workspace/vault scans no longer descend into `.git`/`.venv` | Actual current mechanism mapped (dot-segment rule vs. explicit list, §Patterns); behavioral delta is narrower than the roadmap implies for ScanFilter scans but real for `__pycache__` and allowlist-resurrection (Pitfall 2) |
| SCAN-03 | `ensure_within` importable outside `maru_dir.rs`, one obvious canonical example | Verified three identical private copies exist (`maru_dir.rs:190`, `studio/mod.rs:287`, `diagram/mod.rs:68`); message-safety verified (Pitfall 4) |
| SCAN-04 | Non-absolute home-rooted base fails loudly | Guard placement inside `maru_home()`/`install_root_base()` verified compatible with all 15 call sites (§Patterns); test fixture (`MARU_TEST_HOME` + `test_maru_home_lock`) already exists |
| SCAN-05 | Stray `Users/yj.lee/.maru/env/` tree gone from repo root | Confirmed present, fully untracked, invisible to git only via `.gitignore:13` `node_modules/` rule (§Runtime State Inventory) |
</phase_requirements>

## Summary

This phase is a pure in-repo Rust refactor: one new module (`src-tauri/src/paths.rs`), five prune-list call sites rewired to a shared 14-entry constant, one helper promoted, one guard added inside two home-root functions, and one untracked directory deleted. Every target line was opened and read this session; the constants, consumers, tests, and gate commands below are quoted verbatim from the working tree.

The two findings the CONTEXT.md line-level narrative did not fully capture, and the planner must handle explicitly:

1. **`content_search.rs` is a sixth consumer of the constant.** It imports `crate::workspace_files::GENERATED_DIRS` (`content_search.rs:7`) and uses it in three places (`:203`, `:359-362`, `:467`). Moving the constant forces a decision there, and widening it collides with an existing test (`rg_hidden_and_git_traversal_follow_dot_folder_allowlist`, `:867-900`) that asserts a `.git` path can be allowlisted back into search. See Pitfalls 1-2.
2. **`.maru` must NOT join the union, but `evidence_binder.rs` currently excludes it.** `is_excluded_dir` (`evidence_binder.rs:1333-1337`) matches `.git | node_modules | target | dist | .maru`. Rewiring to the 14-entry union without keeping a module-local `.maru` check would start scanning Maru's own state directory for evidence files. See Pitfall 3.

**Primary recommendation:** Add `mod paths;` (alphabetical, between `lib.rs:48` and `:49`), move `GENERATED_DIRS` + `ensure_within` + an absolute-base guard helper into it, rewire all six importers by import-path swap while keeping `ScanFilter::is_excluded_path`'s `generated_dirs: &[&str]` parameter (inbox.rs passes `&[]` and must keep doing so), put the guard helper call inside `maru_home()`/`install_root_base()`, and `rm -rf Users/` in the same plan as the guard.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Prune-list definition (`GENERATED_DIRS`) | New `paths.rs` module | — | D-01/D-02: scanner modules must not own path invariants |
| Prune-list consumption (walkdir filter_entry / component checks) | Each scanner module | `vault.rs::ScanFilter::is_excluded_path` | The exclusion *predicate* is shared; the *list* is injected per call site — this split must survive the refactor (Pitfall 5) |
| Path containment (`ensure_within`) | `paths.rs` | `vault.rs::lexical_normalize` (stays) | D-06; `lexical_normalize` is `pub` in vault.rs and imported by 4 modules — leave it, import it |
| Absolute-base guard | `paths.rs` (helper) | `skill_host/fs.rs` (application site) | D-02 + D-09 reconcile as: predicate lives in paths.rs, invoked inside `maru_home()`/`install_root_base()` |
| Frontend | None | — | No IPC signature, payload shape, or error string the frontend branches on changes (verified: `gapAnalysis.ts:34` matches only `"Document path escapes"`, which is untouched) |

## Standard Stack

No new packages. This phase uses only existing dependencies, verified in `src-tauri/Cargo.toml`:

| Library | Version | Purpose | Why Standard |
|---------|---------|---------|--------------|
| `walkdir` | `2` [VERIFIED: src-tauri/Cargo.toml:58 — `walkdir = "2"`] | All five scanners' traversal | Already the sole tree-walk mechanism |
| `dirs` | `5` [VERIFIED: src-tauri/Cargo.toml:32 — `dirs = "5"`] | `home_dir()` behind the guard | Existing home resolution |
| `tempfile` | `3` [VERIFIED: src-tauri/Cargo.toml:54 — `tempfile = "3"`] | Test fixtures (`TempDir`) | Existing test convention (e.g. `workspace_files.rs:1234`) |
| std `std::path::{Path, PathBuf, Component}` | — | All containment logic | `lexical_normalize` precedent |

**Installation:** none.

## Package Legitimacy Audit

No external packages are installed, upgraded, or removed in this phase. Gate not triggered.

**Packages removed due to [SLOP] verdict:** none
**Packages flagged as suspicious [SUS]:** none

## Architecture Patterns

### System Architecture Diagram

```
                        src-tauri/src/paths.rs  (NEW — D-01/D-02)
                        ┌─────────────────────────────────────────┐
                        │ pub const GENERATED_DIRS: &[&str] (14)  │
                        │ pub fn ensure_within(parent, child)     │
                        │ pub fn require_absolute(path, ...)      │
                        └───────┬─────────────────────┬───────────┘
              GENERATED_DIRS    │                     │  require_absolute
        ┌───────────────┬───────┼───────┬─────────┐   │   (called inside)
        ▼               ▼       ▼       ▼         ▼   ▼        ▼
 workspace_files  vault.rs  secrets  project_  evidence_  content_   skill_host/fs.rs
 .rs:625,:697    :372,:481  .rs:728  activity  binder     search.rs  maru_home():17
 (via ScanFilter::          (should_ .rs:340   .rs:1333   :203,:359, :17-22,
  is_excluded_path           prune,  (is_pruned (is_excluded :467      install_root_base()
  :238, list injected)       compo-   _dir,      _dir,      (rg globs  :35-40
                            nent-    keep dot-  KEEP .maru  + fallback) → validated before
                            wise)    prefix                     return (D-09)
                                     rule :343)  local)
```

`inbox.rs` (`:877`, `:958`, `:1021`) calls `is_excluded_path(path, root, &[])` — **deliberately outside the union** (its tests allowlist `.omc`, e.g. `inbox.rs:2761`). Do not touch.

### Recommended Project Structure

No structural change beyond one file:

```
src-tauri/src/
├── paths.rs            # NEW: GENERATED_DIRS + ensure_within + absolute-base guard helper
├── lib.rs              # +1 line: `mod paths;` between :48 (ops_catalog) and :49 (outlook_mso) — list is alphabetical
└── (everything else unchanged)
```

### Pattern 1: The shared constant, verbatim sources

The five existing lists, quoted from the working tree:

```rust
// workspace_files.rs:21-29 — pub(crate), the base the union extends
pub(crate) const GENERATED_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo", ".cache",
];

// vault.rs:22-30 — identical 7 entries, private
// secrets.rs:12-25 — 12 entries:
//   ".git", "node_modules", ".next", ".venv", "target", "dist", "build",
//   ".cache", ".context", ".omc", ".omx", ".pnpm-store"
// project_activity.rs:27-34 — 6 entries, typed [&str; 6]:
//   "node_modules", "target", "dist", "build", ".venv", "__pycache__"
// evidence_binder.rs:1333-1337 — is_excluded_dir matches!
//   ".git" | "node_modules" | "target" | "dist" | ".maru"
```

Target (D-03), the union — note it is 14 entries and contains **no** `.maru`:

```rust
// src-tauri/src/paths.rs (new)
/// Directories produced by tooling, never authored content. Every scanner
/// prunes these; adding one is a one-line edit here (SCAN-01).
pub const GENERATED_DIRS: &[&str] = &[
    "node_modules", "target", "dist", "build", ".next", ".turbo", ".cache",
    ".git", ".venv", ".context", ".omc", ".omx", ".pnpm-store", "__pycache__",
];
```

Per-file rewire (all mechanical):

| File | Today | Change |
|------|-------|--------|
| `workspace_files.rs:21` | owns `pub(crate)` const | delete const; `use crate::paths::GENERATED_DIRS;` |
| `vault.rs:22` | owns private const | delete; same import |
| `secrets.rs:12` | owns private const | delete; same import (`should_prune` at `:725-733` works unchanged — it iterates `&[&str]`) |
| `project_activity.rs:27` | `const PRUNED_DIRS: [&str; 6]` | delete; `is_pruned_dir` (`:336-344`) becomes `GENERATED_DIRS.contains(&name) \|\| (name.starts_with('.') && name.len() > 1)` — **keep the dot-prefix rule** (`:343`), it is a documented, broader policy |
| `evidence_binder.rs:1333` | 5-name `matches!` | `GENERATED_DIRS.contains(&name) \|\| name == ".maru"` — see Pitfall 3 |
| `content_search.rs:7` | imports from `workspace_files` | repoint to `crate::paths::GENERATED_DIRS` + resolve the rg/allowlist contradiction — see Pitfall 2 |

### Pattern 2: `ensure_within` promotion

Current implementation to move verbatim (D-06), keeping it lexical (D-07):

```rust
// Source: maru_dir.rs:190-196 (read this session; CONTEXT.md said :189, actual is :190)
fn ensure_within(parent: &Path, child: &Path) -> Result<(), String> {
    let normalized = lexical_normalize(child);
    if !normalized.starts_with(parent) {
        return Err("Path escapes the .maru directory".to_string());
    }
    Ok(())
}
```

- `lexical_normalize` is `pub` at `vault.rs:618-634` and already imported by `maru_dir.rs:24`, `secrets.rs:1`, `inbox.rs:4`, `content_search.rs:3-5`. **Leave it in vault.rs**; `paths.rs` imports it (`use crate::vault::lexical_normalize;`). Optionally `pub use` re-export it from paths.rs so new authors get both from one module.
- `maru_dir.rs`'s two call sites (`:896`, `:1116`) use the moved function — they switch to `crate::paths::ensure_within` (or a thin private wrapper if the message is kept; see Pitfall 4).
- Two more identical private copies exist with their own messages and **stay untouched** per D-06: `studio/mod.rs:287-293` ("Studio state path escapes .maru/studio"), `diagram/mod.rs:68-74` ("Diagram path escapes the diagrams folder").

### Pattern 3: The SCAN-04 guard

Guard targets (read this session):

```rust
// Source: skill_host/fs.rs:17-22 and :35-40
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

Guard shape (helper in paths.rs per D-02, applied inside both functions per D-09, `Err` per D-08):

```rust
// paths.rs
pub fn require_absolute(path: PathBuf) -> Result<PathBuf, String> {
    if path.is_absolute() {
        Ok(path)
    } else {
        Err(format!("Home root must be absolute, got: {}", path.display()))
    }
}

// fs.rs — validate the FINAL value in both branches, i.e. after the override
// early-returns are restructured to fall through one exit, or by wrapping each
// return. env_root() (:28) and skills_root() (:24) derive from maru_home() and
// are covered transitively.
```

All 15 call sites already propagate `Result` (`?` or `let Ok(..) = .. else`, e.g. `store.rs:2887`), so a new `Err` variant is fully compatible. Note `test_maru_home_override()` is `#[cfg(test)]`-gated (`fs.rs:193-196` test / `:209-212` non-test returns `None`); in production only `dirs::home_dir()` feeds these functions, and the guard is cheap insurance.

**Guard test fixture already exists:** `test_maru_home_lock()` (`fs.rs:201-207`) serializes `MARU_TEST_HOME` mutation; `BundleTestHome`/`test_home_for_bundle_tests` (`:217-246`) show the set/restore idiom. Crate is `edition = "2021"` [VERIFIED: Cargo.toml:7], so `std::env::set_var` is safe (not `unsafe`).

### Anti-Patterns to Avoid

- **Baking `GENERATED_DIRS` into `ScanFilter::is_excluded_path`:** inbox.rs relies on passing `&[]`. Keep the `generated_dirs: &[&str]` parameter (Pitfall 5).
- **Converting studio/diagram/secret validators to `ensure_within`:** D-06 forbids; their checks are individually sound and differently-shaped.
- **`canonicalize()` anywhere in the containment path:** D-07 / PROJECT.md constraint; `resolve_inside_vault`'s comment (`vault.rs:590-595`) documents why.
- **Touching `MARUIGNORE_DEFAULTS`:** D-05. (Note: CONTEXT says "twelve-entry"; the file actually lists **13** entries at `maru_dir.rs:79-93` — `node_modules, .venv, dist, build, target, .next, .turbo, .cache, .maru/secrets, .secrets, .maru/cache, .maru/studio, _sys/env`. Irrelevant to the change, but quote it correctly if referenced.)
- **Touching `ops_catalog/scan.rs:664` `is_excluded_dir`:** it is a domain-specific BU-scan list (includes `vault`, `_Archived Items`, `.obsidian`) and is not one of the five in-scope scanners.

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Lexical `..`/`.` resolution | A new normalizer | `vault.rs::lexical_normalize` (`pub`) | Already handles the pop-past-root edge case (`:622-628`); 4 importers |
| Containment check | A fourth `ensure_within` copy | promoted `paths::ensure_within` | Three identical copies already exist (maru_dir/studio/diagram) |
| Tree walking with prune | Hand-rolled recursion | `WalkDir` + `filter_entry` | Prunes descent, not just entries; existing idiom everywhere |
| Env-mutating tests | Unlocked `set_var` | `test_maru_home_lock()` + `BundleTestHome` idiom | Process-global env races without the lock (fs.rs:199-207) |

**Key insight:** this codebase's rule is "one obvious canonical example," not "convert every caller." The phase wins by making the right thing findable, not by making everything uniform.

## Runtime State Inventory

This phase deletes a directory and changes scan scope, so all five categories answered explicitly:

| Category | Items Found | Action Required |
|----------|-------------|------------------|
| Stored data | `Users/yj.lee/.maru/env/` at repo root — confirmed present this session (`Users/yj.lee/.maru/env/node_modules/...` incl. `.bin/tsserver`, `vite`, `playwright`). `git ls-files Users/` returns empty → **fully untracked**; invisible to `git status` only via `.gitignore:13` `node_modules/`. Also: the vault scan cache (`.maru/cache/workspace-index-v3.json`, `vault.rs:20`) can hold pre-change entries — see Open Question 1 | Delete via `rm -rf Users/` (no git ceremony); cache is self-healing or optionally filtered (planner decision) |
| Live service config | None — desktop app, no external services keyed by these paths | None |
| OS-registered state | None — no launchd/systemd/Task Scheduler registrations reference these paths (guard targets are in-process path constructors) | None |
| Secrets/env vars | `MARU_TEST_HOME` — test-only override (`fs.rs:193-196`, `#[cfg(test)]`); the guard test sets it to a *relative* value deliberately. No rename. | None beyond the new test |
| Build artifacts | `paths.rs` addition is handled by cargo; no stale artifacts. The `Users/` tree IS the stray artifact (above). | Rebuild only |

## Common Pitfalls

### Pitfall 1: content_search.rs is the sixth consumer nobody listed
**What goes wrong:** The plan rewires five files, moves the constant, and `cargo check` fails at `content_search.rs:7` (`use crate::workspace_files::{is_binary_file, GENERATED_DIRS};`).
**Why it happens:** CONTEXT.md and CONCERNS.md enumerate five call sites; content_search *imports* the constant rather than defining its own, so it wasn't counted.
**How to avoid:** Include the import repoint (`crate::paths::GENERATED_DIRS`) in the same task that moves the constant. Uses at `:203`, `:359-362` (rg glob emission), `:467`.

### Pitfall 2: The rg fast path contradicts the union until reconciled
**What goes wrong:** `collect_with_rg` emits `!{dir}/**` globs for every `GENERATED_DIRS` entry (`content_search.rs:359-362`). Once `.git` joins the union, `.git` is excluded even when `rg_visibility` (`:266-271`) computed `exclude_git: false` because a user allowlisted e.g. `nested/.git/refs`. The fallback walkdir path excludes it via `is_excluded_path` *before* the dot-allowlist runs. The existing test `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` (`:867-900`) asserts `exclude_git: false` for exactly that allowlist — it still passes (it only asserts `rg_visibility`'s return) while behavior silently diverges, and the rg/fallback parity tests (`:902`, `:919`) can fail on machines with `rg` installed (this machine has ripgrep 15.0.0).
**Why it happens:** allowlist-resurrection of generated dirs was possible before; the union makes exclusion unconditional (SCAN-02's intent).
**How to avoid:** Decide consciously — recommended: make generated dirs never allowlistable (simplify `rg_visibility`'s `exclude_git` to account for the union, e.g. `exclude_git: true` unconditionally since `.git` is now covered by the glob loop, or `!GENERATED_DIRS.contains(".git") || !scan_filter.could_include_dot_folder_named(".git")`), and **update the `:889-899` assertion** to the new expectation. Do NOT add rejection of generated dirs in `ScanFilter::from_options` — that turns a silent scope reduction into a user-facing settings error.
**Warning signs:** rg/fallback parity tests failing locally but not in CI (CI may lack rg; the tests skip when absent, `:904`).

### Pitfall 3: evidence_binder must keep `.maru`
**What goes wrong:** Rewiring `is_excluded_dir` (`evidence_binder.rs:1333-1337`) to only `GENERATED_DIRS.contains(&name)` drops `.maru` from the exclusion set; evidence discovery (`discover_sidecar_candidates`, `:896-909`, bases = `work/projects` + `work/admin` per `scoped_bases:1148-1153`) then descends into any nested `.maru/` and can surface Maru state files as evidence candidates.
**How to avoid:** `is_excluded_dir` becomes "in `GENERATED_DIRS` **or** `name == ".maru"`", with a one-line comment that `.maru` is Maru state, not a generated dir, and deliberately stays out of the shared constant.

### Pitfall 4: Changing the `ensure_within` error message silently
**What goes wrong:** Generalizing "Path escapes the .maru directory" (Claude's-discretion item) looks safe — no frontend matcher exists (verified: `gapAnalysis.ts:34` matches only `"Document path escapes"`) — but it is still a user-visible error string on a live command path.
**How to avoid:** Either keep the message verbatim (safest; maru_dir's two call sites stay byte-identical in behavior) or generalize deliberately and note the change in the plan's verification. Do not parameterize per-caller messages — that re-fragments the canonical example.

### Pitfall 5: "Simplifying" `is_excluded_path` to read the constant directly
**What goes wrong:** Removing the `generated_dirs: &[&str]` parameter from `ScanFilter::is_excluded_path` (`vault.rs:238`) breaks inbox.rs's three `&[]` call sites (`:877`, `:958`, `:1021`) and, worse, would subject inbox's allowlisted `.omc` drop folders (tests at `inbox.rs:2761`, `:3349`) to the union — a behavior regression.
**How to avoid:** Signature stays; only the constant's origin changes.

### Pitfall 6: Guarding only the override branch
**What goes wrong:** The guard is placed inside `test_maru_home_override()` or only around the `cfg(test)` branch, so a non-absolute `dirs::home_dir()` result (theoretical) slips through, and the code reads as test-only.
**How to avoid:** Validate the final return value of `maru_home()`/`install_root_base()` regardless of branch (D-09: "validate is_absolute before returning").

### Pitfall 7: Deleting `Users/` without the guard test landing
**What goes wrong:** D-10 — the delete without the guard is cosmetic; a later relative-home bug recreates it.
**How to avoid:** One plan (or one commit) carries: guard + guard test (relative `MARU_TEST_HOME` → `Err`, and assert no `relative-home/` tree appears in cwd) + `rm -rf Users/` + verification `test ! -e Users`.

## Code Examples

Verified patterns from the working tree (all paths/lines read this session):

### Guard test (new, modeled on the existing fixture)

```rust
// src-tauri/src/skill_host/fs.rs `mod tests` — fixture pattern from fs.rs:201-246
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

### `ensure_within` unit tests (new, in paths.rs)

```rust
// paths.rs — canonical example tests (D-06)
#[test]
fn ensure_within_accepts_descendant_and_rejects_escape() {
    let root = Path::new("/work/.maru/rules");
    assert!(ensure_within(root, &root.join("a/b.md")).is_ok());
    assert!(ensure_within(root, &root.join("../secrets/key")).is_err());
    assert!(ensure_within(root, Path::new("/elsewhere/x.md")).is_err());
}
```

### Union proof test (SCAN-02, e.g. extending `workspace_files.rs`'s existing style at :1244-1261)

```rust
#[test]
fn scanner_excludes_git_venv_and_pycache_even_without_dot_rule() {
    let tmp = TempDir::new().unwrap();
    let root = tmp.path();
    write_file(root, "keep.md", b"# Keep\n");
    write_file(root, "__pycache__/mod.cpython-312.pyc", b"x"); // non-dot: genuinely NEW exclusion
    write_file(root, ".git/objects/ab/cdef", b"x");
    write_file(root, ".venv/lib/python3.12/site.py", b"x");
    let entries = scan_workspace_files_at(root, &ScanFilter::default()).unwrap();
    assert_eq!(entries.iter().map(|e| e.rel_path.as_str()).collect::<Vec<_>>(), vec!["keep.md"]);
}
```

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|--------------|--------|
| Five private prune lists | One `pub const GENERATED_DIRS` in `paths.rs` | this phase | SCAN-01 one-line edit |
| Dot-segment rule accidentally covering `.git`/`.venv` for ScanFilter scans | Explicit, un-allowlistable union membership | this phase | SCAN-02; see Pitfall 2 for the rg path |
| Three private `ensure_within` copies | One canonical helper + doc example | this phase | SCAN-03; copies stay (D-06) |
| Unguarded home-root joins | `is_absolute` validated at return (Err) | this phase | SCAN-04 |

**Deprecated/outdated:** nothing external; the roadmap's framing that workspace scans "walk into git object storage" is partially stale for ScanFilter-based scans — the dot-segment rule at `vault.rs:245-258` already excludes `.git`/`.venv` by default there. The genuinely new exclusions for `workspace_files`/`vault`/`content_search` are `__pycache__` (non-dot) and the loss of allowlist-resurrection for generated dot-dirs. For `secrets` the union adds `.turbo` + `__pycache__`; for `evidence_binder` it adds 10 entries. Plan verification should assert the real deltas, not the stale framing.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | CI runners may lack `rg`, so rg/fallback parity tests skip there but run locally (ripgrep 15.0.0 present on this machine) | Pitfall 2 | Pitfall-2 regression could pass CI and fail locally — mitigate by running the content_search tests locally before merge |
| A2 | The historical producer of the stray `Users/` tree was a relative `MARU_TEST_HOME`-style join (per CONCERNS.md:190); the exact producer is unproven since `test_maru_home_override` is `cfg(test)`-only in current code | Pattern 3 | Low — the guard covers both branches regardless of the historical cause |
| A3 | No user has a generated-dir name (e.g. `.git`) in their `scan.includeDotFolders` setting in the wild; if one does, their allowlist silently stops resurrecting it | Pitfall 2 | Silent, narrow behavior change; accepted by D-04's "intended behavior change" framing |

## Open Questions (RESOLVED)

1. **Stale vault cache after scope reduction.**
   - What we know: `read_vault_cache` (`vault.rs:509-525`) emits cached entries filtered only by the scratchpad prefix — a cache written before this phase can surface now-pruned paths (e.g. `__pycache__/*.md` if any existed) on first paint until the next `scan_vault` rewrites the cache (`:417`). Precedent: `read_vault_cache_drops_stale_scratchpad_entries` test (`:1245`) and its comment (:512-513) show the fix pattern.
   - What's unclear: whether the planner wants a cache-read filter against `GENERATED_DIRS` (mirroring the scratchpad precedent) or accepts self-healing on next scan.
   - Recommendation: accept self-healing (entries were rare-to-nonexistent before, since dot-dirs were already excluded and `__pycache__` rarely holds documents). Flag in the plan as a known, bounded transient; do not add the filter unless the executor's verification shows visible staleness.
   - **Resolution:** ACCEPT self-healing per the recommendation — no cache-read filter added. Documented as a bounded transient in 02-02-PLAN.md's "Flagged assumptions" (SCAN-02 / stale vault cache), with an instruction to surface visible staleness rather than silently adding the filter.

2. **`rg_visibility` final shape after the union.**
   - What we know: Pitfall 2's contradiction must be resolved; the test at `content_search.rs:867-900` needs its `git_allowed` expectation updated.
   - What's unclear: exact code shape (collapse `exclude_git` into the glob loop vs. keep both checks).
   - Recommendation: keep the struct, make `exclude_git` reflect "can never include .git" (i.e. `true` while `.git ∈ GENERATED_DIRS`), and rename/extend the test to assert generated dirs are un-allowlistable. Planner owns the final shape (Claude's-discretion: call-site rewiring).
   - **Resolution:** Follow the recommendation — 02-01-PLAN.md Task 2 keeps the `RgVisibility` struct, sets `exclude_git: true` unconditionally (generated dirs are un-allowlistable), and flips the `git_allowed` expectation in `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` with a red-then-green proof. Final micro-shape left to executor discretion per the plan's task action.

## Environment Availability

| Dependency | Required By | Available | Version | Fallback |
|------------|------------|-----------|---------|----------|
| Rust toolchain (pinned) | all Rust changes, clippy/fmt gates | ✓ | 1.98.0 (`rust-toolchain.toml`: channel `1.98.0`, components clippy+rustfmt — VERIFIED this session) | — |
| cargo / rustc | `make test-rust`, `make clippy` | ✓ | cargo 1.98.0 / rustc 1.98.0 | — |
| pnpm | `make verify` frontend steps | ✓ | 9.15.0 | — (frontend untouched; verify still runs it) |
| node | `make verify` frontend steps | ✓ | 25.9.0 local (CI pins 22.22.3) | — |
| ripgrep (`rg`) | content_search parity tests | ✓ | 15.0.0 (tests skip gracefully if absent) | tests no-op without it |
| Phase 1 gate set | behavior-preservation evidence | ✓ live | `make verify` = typecheck, lint, release-version-check, icons-check, lint-i18n, check-select-chrome, check-type-tokens, test-ts, test-rust, fmt-check, clippy, build-frontend [VERIFIED: Makefile:321] | per-gate runs (`make test-rust` = `cargo test --lib` [Makefile:192], `make clippy` = `cargo clippy -- -D warnings` [Makefile:199-201], `make fmt-check` [Makefile:195-196]) |

**Missing dependencies with no fallback:** none.
**Missing dependencies with fallback:** none.
**Known environmental hazard (from Phase 1 / current `git status`):** a concurrent session has uncommitted Rust files in this checkout (`src-tauri/src/hwped.rs`, modified `lib.rs`). A full `make verify` can fail on those files' fmt/clippy state, exactly as in Phase 1 plan 01-07. Plans should verify owned gates individually and treat CI as the composite check; also note `lib.rs` is currently dirty — the `mod paths;` insertion must land cleanly alongside that session's edits.

## Validation Architecture

> `.planning/config.json` does not exist; `nyquist_validation` treated as enabled.

### Test Framework

| Property | Value |
|----------|-------|
| Framework | Rust built-in `#[test]` (`#[cfg(test)] mod tests` per file, at file bottom — 100+ existing modules) |
| Config file | none — convention only; fixtures via `tempfile = "3"` |
| Quick run command | `cd src-tauri && cargo test --lib paths::` (or `fs::tests::`, `workspace_files::tests::` per module) |
| Full suite command | `make test-rust` (`cargo test --lib`), then `make verify` |

### Phase Requirements → Test Map

| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|--------------|
| SCAN-01 | One constant, five+one importers | compile + unit | `cargo test --lib` (compile is the proof: lists deleted, single source) | ❌ new `paths.rs` |
| SCAN-02 | `.git`/`.venv`/`__pycache__` excluded | unit | `cargo test --lib -- workspace_files::tests:: vault::tests:: content_search::tests::` | ✅ extend existing (`workspace_files.rs:1231`, `vault.rs:1298`, `content_search.rs:867`) |
| SCAN-03 | `ensure_within` importable + canonical | unit + doc | `cargo test --lib paths::tests::` | ❌ new tests in `paths.rs` |
| SCAN-04 | Relative home root → `Err`, no cwd tree | unit | `cargo test --lib skill_host::fs::tests::` | ❌ new test in `fs.rs` (fixture exists) |
| SCAN-05 | `Users/` gone | manual/filesystem | `test ! -e Users && git status --porcelain -- Users/` empty | ❌ verification step in plan |

### Sampling Rate

- **Per task commit:** `cd src-tauri && cargo test --lib <touched-module>::` + `cargo fmt --check` + `cargo clippy -- -D warnings`
- **Per wave merge:** `make test-rust` (full `cargo test --lib`)
- **Phase gate:** full `make verify` green (or per-gate green + CI composite, per the concurrent-checkout hazard above) before `/gsd:verify-work`

### Wave 0 Gaps

- [ ] `src-tauri/src/paths.rs` — new module with `GENERATED_DIRS`, `ensure_within`, guard helper, doc example, unit tests (SCAN-01/03)
- [ ] New guard test in `src-tauri/src/skill_host/fs.rs` `mod tests` (SCAN-04) — fixture (`test_maru_home_lock`, `BundleTestHome` idiom) already exists at `fs.rs:199-246`
- [ ] Updated expectation in `content_search.rs:867-900` for un-allowlistable `.git` (Pitfall 2)
- [ ] Framework install: none — all infrastructure exists

## Security Domain

> `security_enforcement` not explicitly disabled (no config.json); included.

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-----------------|
| V2 Authentication | no | — |
| V3 Session Management | no | — |
| V4 Access Control | no | — |
| V5 Input Validation | yes | Path-traversal containment: lexical `lexical_normalize` + `starts_with` (`ensure_within`); `is_absolute` guard on home roots. Never hand-roll a new variant — that is the phase's thesis |
| V6 Cryptography | no | — |
| V12 Files & Resources | yes | Symlink policy: containment stays lexical by deliberate design (`vault.rs:590-595` comment) so user symlinks inside a workspace remain valid; do not "harden" with `canonicalize()` |

### Known Threat Patterns for {stack}

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|---------------------|
| Path traversal via `..` in caller-supplied relative paths (CWE-22) | Tampering / Elevation | `ensure_within` (lexical) for new path-accepting commands; existing per-module checks stay (D-06) |
| Relative home root materializing a tree in cwd (the `Users/` incident class) | Tampering | `is_absolute` guard returning `Err` inside `maru_home()`/`install_root_base()` (D-08/D-09) |
| Scanning secrets/state into indexes (`.maru/secrets`, `.git` internals) | Information disclosure | Union prune + evidence_binder's retained `.maru` exclusion + secrets.rs's existing `should_prune` extra rules (`:715-723`, untouched) |

## Sources

### Primary (HIGH confidence) — all read this session, working tree @ 4866c90 + dirty

- `src-tauri/src/workspace_files.rs:21-29, 610-709, 1231-1300` — base constant, ScanFilter consumption, test conventions
- `src-tauri/src/vault.rs:22-30, 174-266, 324-379, 505-554, 566-634, 1245-1310, 1500-1523` — second list, ScanFilter/dot-rule, scan+cache, `resolve_inside_vault`/`lexical_normalize`, tests, ignored bench
- `src-tauri/src/secrets.rs:1-28, 710-784` — 12-entry list, `should_prune`, `normalize_secret_rel_path`
- `src-tauri/src/project_activity.rs:22-34, 336-344` — 6-entry list, dot-prefix rule
- `src-tauri/src/evidence_binder.rs:896-940, 1148-1153, 1333-1337` — `is_excluded_dir` incl. `.maru`, walk site, scan bases
- `src-tauri/src/content_search.rs:7, 199-207, 266-271, 330-372, 463-470, 855-930` — sixth consumer, `rg_visibility`, rg glob loop, allowlist test
- `src-tauri/src/maru_dir.rs:24, 79-93, 190-196, 894-897, 1114-1117` — `MARUIGNORE_DEFAULTS` (13 entries), `ensure_within` + call sites
- `src-tauri/src/skill_host/fs.rs:13-60, 193-283` — guard targets, `MARU_TEST_HOME` fixture, test idiom
- `src-tauri/src/studio/mod.rs:287-293`, `src-tauri/src/diagram/mod.rs:68-74`, `src-tauri/src/terminal_hooks.rs:59-63` — sibling `ensure_within` copies + private `maru_home` (stay untouched)
- `src-tauri/src/inbox.rs:877, 958, 1021, 2758-2763, 3346-3351` — `&[]` call sites, `.omc` allowlist tests
- `src-tauri/src/lib.rs:1-82` — flat alphabetical mod list
- `src-tauri/Cargo.toml:7-8, 32, 54, 58`; `Makefile:159-201, 321`; `rust-toolchain.toml`; `.gitignore:13`
- `src/lib/gapAnalysis.ts:34` — only frontend error-prefix matcher (untouched by message change)
- `.planning/codebase/CONCERNS.md` §Tech Debt; `.planning/PROJECT.md` §Constraints; `.planning/ROADMAP.md` §Phase 2
- Repo state probes: `git ls-files Users/` (empty), `find Users/` (tree present), `git check-ignore` (`.gitignore:13`)

### Secondary (MEDIUM confidence)

- None — no web sources used; the phase domain is entirely this repository.

### Tertiary (LOW confidence)

- A1/A2/A3 in Assumptions Log.

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH — no new deps; versions read from Cargo.toml
- Architecture: HIGH — every call site, list, test, and gate command verified by direct read
- Pitfalls: HIGH — the two structural surprises (sixth consumer, `.maru` retention) are demonstrated from code, not inferred

**Research date:** 2026-08-23
**Valid until:** 2026-09-22 (stable — but re-verify line numbers if the concurrent hwped session lands first, since it modifies `lib.rs`)
