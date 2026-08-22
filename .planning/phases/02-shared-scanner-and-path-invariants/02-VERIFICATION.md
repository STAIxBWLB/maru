---
phase: 02-shared-scanner-and-path-invariants
verified: 2026-08-22T22:16:53Z
status: passed
score: 13/13 must-haves verified
behavior_unverified: 0
overrides_applied: 0
---

# Phase 2: Shared Scanner and Path Invariants — Verification Report

**Phase Goal:** A new command author has exactly one prune list and one containment helper to reach for
**Verified:** 2026-08-22T22:16:53Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | `src-tauri/src/paths.rs` is the single module holding `GENERATED_DIRS`, `ensure_within`, and `require_absolute` together, with a doc comment naming it "the one place to reach for" (D-01, D-02) | ✓ VERIFIED | paths.rs:1-71 — all three present; module doc states the single-home intent; `lexical_normalize` re-exported at :24 |
| 2 | `GENERATED_DIRS` is the flat 14-entry union (node_modules, target, dist, build, .next, .turbo, .cache, .git, .venv, .context, .omc, .omx, .pnpm-store, __pycache__), no core+extras split, no `.maru` (D-03) | ✓ VERIFIED | paths.rs:31-46 — exactly 14 entries in the specified order; `grep -v '^\s*//' paths.rs \| grep -c '"\.maru"'` = 0 (doc-comment-only mention) |
| 3 | All five scanners — `workspace_files.rs`, `vault.rs`, `secrets.rs`, `project_activity.rs`, `evidence_binder.rs` — plus the sixth consumer `content_search.rs` import `crate::paths::GENERATED_DIRS`; all private lists deleted (SCAN-01, roadmap SC1) | ✓ VERIFIED | Import present in all six files; `const GENERATED_DIRS` count = 0 in all six; `PRUNED_DIRS` = 0 in project_activity.rs; one-line edit claim is structurally true (single `pub const`) |
| 4 | Generated dirs can no longer be allowlisted back into content search — `rg_visibility` reports `exclude_git: true` unconditionally (SCAN-02's real delta) | ✓ VERIFIED | content_search.rs:267-275 — `exclude_git: true` with SCAN-02 comment; test `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` asserts the flipped expectation (:877-906) and PASSES in the full suite; `could_include_dot_folder_named` dead helper removed |
| 5 | A vault scan over a tree containing `__pycache__/`, `.git/`, `.venv/` returns none of their contents (SCAN-02, roadmap SC2) | ✓ VERIFIED (behavioral) | `vault::tests::scan_excludes_generated_dirs_union_including_pycache` (vault.rs:1305-1319) asserts exactly `["keep.md"]` and PASSES; red-then-green pair committed (86f0075 RED → 14df41f GREEN) |
| 6 | `ensure_within` returns Ok on child==parent and descendants, Err on lexical escape, with no `canonicalize()` in the containment path (D-07, roadmap SC3) | ✓ VERIFIED (behavioral) | paths.rs:51-57 — `lexical_normalize` + `starts_with` only; 4 passing unit tests (descendant/equal/dotdot-escape/unrelated-absolute) |
| 7 | `maru_dir.rs` resolves containment through `crate::paths::ensure_within`; no private copy remains; error message byte-identical; studio/diagram sibling copies and `MARUIGNORE_DEFAULTS` untouched (SCAN-03, D-05, D-06) | ✓ VERIFIED | `fn ensure_within` count in maru_dir.rs = 0; `use crate::paths::ensure_within;` at :24; message lives only in paths.rs (maru_dir count = 0); `git diff 62936ea..HEAD` on studio/mod.rs + diagram/mod.rs is EMPTY; MARUIGNORE_DEFAULTS shows the same 13 entries research quoted |
| 8 | `maru_home()`, `install_root_base()`, and (transitively) `env_root()` return Err when the resolved home base is not absolute — on every return path including the test-override branch (SCAN-04, D-08, D-09, Pitfall 6) | ✓ VERIFIED (behavioral) | fs.rs:18-28 and :42-51 — both constructors single-exit through `require_absolute(base)`; `skill_host::fs::tests::maru_home_rejects_relative_test_home` passes (asserts Err ×3); red-then-green pair committed (2ac1bc6 RED → 60a9d0b GREEN) |
| 9 | No directory tree materializes in the process cwd when the guard fires — proven by test assertion (roadmap SC4) | ✓ VERIFIED (behavioral) | The same test asserts `!Path::new("relative-home").exists()` and passes in the full 1213-test suite |
| 10 | The stray `Users/` tree no longer exists at the repo root, deleted in the same plan as the guard (SCAN-05, D-10, roadmap SC5) | ✓ VERIFIED | `test ! -e Users` exit 0; `git status --porcelain -- Users/` empty; pre-delete `git ls-files Users/` evidence recorded in 02-03-SUMMARY |
| 11 | All 15 existing `maru_home`/`env_root`/`install_root_base` call sites compile unchanged | ✓ VERIFIED | Full lib build + `cargo test --lib` green (1213/0); no call-site edits in the phase diff |
| 12 | `evidence_binder.rs` keeps its module-local `.maru` exclusion ORed with the union; `project_activity.rs` keeps its dot-prefix rule (Pitfall 3, T-02-04) | ✓ VERIFIED | evidence_binder.rs:1334-1340 — `GENERATED_DIRS.contains(&name) \|\| name == ".maru"` with rationale comment; project_activity.rs:326-334 — union check + `name.starts_with('.') && name.len() > 1`, Korean doc comment intact |
| 13 | `inbox.rs`'s three empty-slice `is_excluded_path` call sites and `.omc` allowlist tests survive (Pitfall 5) | ✓ VERIFIED | inbox.rs:877, :958, :1021 all pass `&[]`; inbox tests pass in the full suite; `ScanFilter::is_excluded_path` keeps `generated_dirs: &[&str]` (vault.rs:222) |

**Score:** 13/13 truths verified (0 present-but-behavior-unverified)

### Prohibitions (must-NOT checks)

| Prohibition | Status | Evidence |
|-------------|--------|----------|
| `GENERATED_DIRS` never contains `.maru` | ✓ HELD | grep count 0 outside doc comments (paths.rs) |
| `ScanFilter::is_excluded_path` keeps its `generated_dirs` parameter; inbox keeps passing `&[]` | ✓ HELD | vault.rs:222 signature intact; inbox.rs 3 `&[]` call sites intact |
| `ScanFilter::from_options` gains no rejection of user-allowlisted generated dirs | ✓ HELD | vault.rs:179-... — from_options validates empty/glob/absolute only; no GENERATED_DIRS reference |
| Guard fails via Err only — no `assert!`/`panic!`/`debug_assert!` in the guard path (D-08) | ✓ HELD | grep of fs.rs:1-60 (guard code) finds zero assertion macros; assertions exist only inside the test body |
| `test_maru_home_override` stays cfg(test)-gated | ✓ HELD | fs.rs:203 `#[cfg(test)]` / :219 `#[cfg(not(test))]` dual definition, unchanged pattern |
| `env_root()`/`skills_root()` get no separate guard | ✓ HELD | fs.rs:30-36 — both derive via `maru_home()?`, no `require_absolute` call |
| `ops_catalog/scan.rs` `is_excluded_dir` stays untouched | ✓ HELD | `git diff 62936ea..HEAD -- ops_catalog/scan.rs` empty |
| `.maruignore` defaults unchanged (D-05) | ✓ HELD | maru_dir.rs MARUIGNORE_DEFAULTS shows the identical 13 entries research quoted verbatim |

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `src-tauri/src/paths.rs` | Shared path-invariants module (union, containment, absolute-base guard) | ✓ VERIFIED | 111 lines; exports GENERATED_DIRS, ensure_within, require_absolute, lexical_normalize re-export; 6 unit tests; zero `allow(` attributes (dead-code ledger closed by 02-03) |
| `src-tauri/src/lib.rs` | Module registry entry | ✓ VERIFIED | `mod paths;` at :50, alphabetical between `outlook_mso` and `project_activity` (rustfmt-consistent true-alphabetical slot; documented deviation from the plan's stated slot) |
| `src-tauri/src/workspace_files.rs` | Scanner consuming the shared constant | ✓ VERIFIED | Import at :2; local const gone |
| `src-tauri/src/content_search.rs` | Sixth consumer repointed; rg visibility reconciled | ✓ VERIFIED | Import at :3; `exclude_git: true` unconditional |
| `src-tauri/src/maru_dir.rs` | First caller of promoted `ensure_within` | ✓ VERIFIED | Import at :24; private copy deleted |
| `src-tauri/src/vault.rs` | Scanner consuming union; predicate signature preserved | ✓ VERIFIED | Import at :16; `is_excluded_path(..., generated_dirs: &[&str])` intact at :222; union-proof test added |
| `src-tauri/src/secrets.rs` | Scanner consuming union; domain prefix rules intact | ✓ VERIFIED | Import at :1; should_prune vault/.maru/secrets/.secrets rules byte-intact (:696-710) |
| `src-tauri/src/project_activity.rs` | Scanner consuming union; dot-prefix rule retained | ✓ VERIFIED | Import at :20; is_pruned_dir union + dot rule |
| `src-tauri/src/evidence_binder.rs` | Scanner consuming union + module-local `.maru` | ✓ VERIFIED | Import at :3; is_excluded_dir OR-branch with comment |
| `src-tauri/src/skill_host/fs.rs` | Guarded home-root constructors + regression test | ✓ VERIFIED | `require_absolute` at :5, :28, :49; regression test at :278 |

### Key Link Verification

| From | To | Via | Status | Details |
|------|----|-----|--------|---------|
| workspace_files.rs | paths.rs | `use crate::paths::GENERATED_DIRS` consumed by filter_entry call sites | ✓ WIRED | Import :2; const origin swapped, call sites unchanged |
| content_search.rs | paths.rs | import + rg glob loop iterates the union (:363) + fallback `is_excluded_path(..., GENERATED_DIRS)` (:204, :471) | ✓ WIRED | Both engines consume the shared union |
| vault.rs | paths.rs | injected-list predicate preserved; only the constant's origin changed | ✓ WIRED | Import :16; signature :222 intact |
| secrets.rs | paths.rs | `should_prune` iterates the wider union | ✓ WIRED | Import :1 |
| project_activity.rs | paths.rs | `is_pruned_dir` membership check reads the union | ✓ WIRED | Import :20 |
| evidence_binder.rs | paths.rs | union membership OR module-local `.maru` | ✓ WIRED | :1334-1340 |
| maru_dir.rs | paths.rs | both former private-call sites resolve to the promoted helper | ✓ WIRED | Import :24; zero remaining `fn ensure_within` |
| skill_host/fs.rs | paths.rs | `maru_home()`/`install_root_base()` wrap final values in `require_absolute` | ✓ WIRED | :5, :28, :49 |
| paths.rs | vault.rs | `pub use crate::vault::lexical_normalize` — containment stays lexical (D-07) | ✓ WIRED | paths.rs:24 |

### Data-Flow Trace (Level 4)

This phase renders no UI; the "data" is the prune list and guards flowing into scanner/guard call paths. Traced: `GENERATED_DIRS` (static-but-canonical constant — the intended single source) flows into 6 scanner consumption sites, all confirmed by grep above. No hollow props, no disconnected static fallbacks. The guard flows: `MARU_TEST_HOME`/`dirs::home_dir()` → `maru_home()`/`install_root_base()` → `require_absolute` → Err/Ok — exercised end-to-end by the passing regression test.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Full lib suite green | `cargo test --lib` | `1213 passed; 0 failed; 3 ignored` (29.21s) | ✓ PASS |
| paths.rs unit tests | suite output grep `paths::tests` | 6/6 ok | ✓ PASS |
| SCAN-02 union proof | suite output grep `scan_excludes_generated_dirs_union_including_pycache` | ok | ✓ PASS |
| SCAN-04 guard regression | suite output grep `maru_home_rejects_relative_test_home` | ok | ✓ PASS |
| rg parity + allowlist flip | suite output grep `rg_and_fallback_produce_identical_results` / `rg_hidden_and_git_traversal...` | both ok (rg installed — tests ran, not skipped) | ✓ PASS |
| Users/ absent | `test ! -e Users && git status --porcelain -- Users/` | exit 0, empty | ✓ PASS |

### Probe Execution

SKIPPED — no probes declared in any PLAN/SUMMARY for this phase; the project's verification vehicle is the Phase 1 gate set (`cargo test --lib`, clippy, fmt), not probe scripts.

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|------------|-------------|--------|----------|
| SCAN-01 | 02-01, 02-02 | One-line, one-file prune-list edit honored by all five scanners | ✓ SATISFIED | Single `pub const GENERATED_DIRS` in paths.rs; all 5 scanners + content_search import it; all private lists deleted |
| SCAN-02 | 02-01, 02-02 | Workspace/vault scans no longer descend into `.git`/`.venv` | ✓ SATISFIED | Union includes `.git`/`.venv`/`__pycache__`; rg globs + fallback predicate both consume it; allowlist-resurrection removed; passing union-proof + rg-parity tests |
| SCAN-03 | 02-01 | Canonical `ensure_within` importable outside `maru_dir.rs`, one obvious example; existing per-module checks untouched | ✓ SATISFIED | `crate::paths::ensure_within` with doc example + 4 tests; maru_dir converted; studio/diagram copies byte-untouched per D-06 |
| SCAN-04 | 02-03 | Non-absolute home-rooted base fails loudly instead of materializing a tree | ✓ SATISFIED | `require_absolute` on every return path of both constructors; regression test asserts Err ×3 + no cwd tree |
| SCAN-05 | 02-03 | Stray `Users/yj.lee/.maru/env/` tree gone from repo root | ✓ SATISFIED | Filesystem + git checks green; deleted in the same plan as the guard (D-10) |

All 5 requirement IDs declared across plan frontmatter ({SCAN-01, SCAN-02, SCAN-03} ∪ {SCAN-01, SCAN-02} ∪ {SCAN-04, SCAN-05}) are accounted for. No orphaned requirements: REQUIREMENTS.md maps exactly SCAN-01..05 to Phase 2 and marks all Complete.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | — | — | No TBD/FIXME/XXX, TODO, placeholder, or empty-implementation patterns in any phase-modified file |

### Review Findings Disposition (02-REVIEW.md: 3 warnings, 7 info)

Judged per D-06 and the roadmap's explicit out-of-scope row ("Retrofitting all ~20 existing path-traversal validators"):

- **WR-01** (`maru_dir::maru_home_dir()` unguarded relative-HOME path) — pre-existing parallel constructor the phase deliberately did not retrofit. Roadmap SC4 (the contract) scopes SCAN-04 to `maru_home()`/`env_root()` results, which ARE guarded and test-proven. Does not break any SCAN-* requirement as written. **Follow-up candidate, not a phase-goal gap.**
- **WR-02** (Windows symlink-type bug in secrets.rs migration) — pre-existing, in a code path the phase did not touch (create_relative_symlink, not the prune-list rewire). No SCAN-* requirement covers symlink creation. **Pre-existing/out-of-scope.**
- **WR-03** (`normalize_existing_dir` create_dir_all on read commands) — pre-existing permissive contract; the phase's guard decision (D-09) explicitly targeted home roots, not workspace roots. **Pre-existing/out-of-scope.**
- IN-01..IN-07 — info-level; IN-01 (private `lexical_normalize` copy in workspace_files.rs) and IN-07 (vault_watcher/ops_catalog lists falsifying the "every scanner" doc claim in paths.rs:26-27) are legitimate polish follow-ups but do not falsify the phase goal: the goal is one obvious canonical place to reach for, which exists.

**Environmental note (not a gap):** the shared checkout carries a concurrent session's uncommitted `src-tauri/src/hwped.rs` (+ hwped hunks in lib.rs, confirmed dirty in `git status` during verification). Full `make verify` composite fails only on those foreign files; every gate this phase owns was proven individually green (full `cargo test --lib` 1213/0 re-run by this verifier; fmt/clippy cleanliness of owned files documented in all three SUMMARYs). CI is the authoritative composite per Phase 1 precedent.

### Human Verification Required

None. This is a pure Rust refactor with no visual, real-time, or external-service surface; every behavior-dependent truth is exercised by a passing behavioral test (confirmed by this verifier's own test run, not SUMMARY narration).

### Gaps Summary

None. All 13 merged truths verified against the codebase with behavioral evidence; all 8 prohibitions held; all 5 SCAN-* requirements satisfied; no anti-patterns; no orphaned requirements.

---

_Verified: 2026-08-22T22:16:53Z_
_Verifier: Claude (gsd-verifier)_
