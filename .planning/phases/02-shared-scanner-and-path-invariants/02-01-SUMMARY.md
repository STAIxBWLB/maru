---
phase: 02-shared-scanner-and-path-invariants
plan: "01"
subsystem: infra
tags: [rust, path-invariants, scanner, ripgrep, walkdir]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: fmt-check/clippy/lint gates live in `make verify` — the gate set this plan proves itself against
provides:
  - src-tauri/src/paths.rs — single home for path invariants (D-01/D-02): GENERATED_DIRS (flat 14-entry union, D-03), ensure_within (canonical lexical containment, D-07), require_absolute (SCAN-04 guard predicate for plan 02-03), lexical_normalize re-export
  - workspace_files.rs and content_search.rs rewired to the shared union; rg_visibility reconciled so generated dirs are un-allowlistable (SCAN-02)
  - maru_dir.rs resolving containment through crate::paths::ensure_within with byte-identical error message (SCAN-03)
affects: [02-shared-scanner-and-path-invariants (plans 02-02 scanner rewires, 02-03 SCAN-04 guard)]

actuals:
  tokens: 2296
  tasks: 3
  commits: 4

tech-stack:
  added: []
  patterns:
    - "Shared path-invariants module: one constant + canonical helpers in crate::paths, scanners import rather than copy"
    - "Temporary #[allow(dead_code)] on promoted helpers, removed in the same commit the first consumer lands"

key-files:
  created:
    - src-tauri/src/paths.rs
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/src/workspace_files.rs
    - src-tauri/src/content_search.rs
    - src-tauri/src/vault.rs
    - src-tauri/src/maru_dir.rs

key-decisions:
  - "mod paths; placed between outlook_mso and project_activity (true alphabetical, rustfmt-verified) — the plan's stated ops_catalog/outlook_mso slot violates the strictly-alphabetical registry convention"
  - "could_include_dot_folder_named deleted from vault.rs rather than kept — its only caller was rg_visibility and dead code fails the clippy -D warnings gate"
  - "ensure_within error message kept byte-identical (\"Path escapes the .maru directory\") per RESEARCH Pitfall 4 — live user-visible string, behavior-preserving phase"

patterns-established:
  - "Generated-dir pruning: one flat 14-entry union in paths.rs consumed by every scanner; .maru deliberately absent (Maru state, excluded module-locally by evidence_binder)"
  - "Allowlist semantics: a generated dir can never be allowlisted back into content search — rg_visibility reports exclude_git: true unconditionally"

requirements-completed: [SCAN-01, SCAN-02, SCAN-03]

coverage:
  - id: D1
    description: "paths.rs holds GENERATED_DIRS (14-entry union), ensure_within, require_absolute together with unit tests"
    requirement: SCAN-01
    verification:
      - kind: unit
        ref: "src-tauri/src/paths.rs#paths::tests (6 tests: descendant/equal/escape/unrelated-absolute, require_absolute abs/rel)"
        status: pass
    human_judgment: false
  - id: D2
    description: "workspace_files.rs and content_search.rs consume the shared GENERATED_DIRS union and test green"
    requirement: SCAN-01
    verification:
      - kind: unit
        ref: "cargo test --lib -- workspace_files:: content_search::"
        status: pass
    human_judgment: false
  - id: D3
    description: "Generated dirs un-allowlistable in content search — rg_visibility exclude_git unconditional; parity tests run locally with rg 15.0.0"
    requirement: SCAN-02
    verification:
      - kind: unit
        ref: "src-tauri/src/content_search.rs#rg_hidden_and_git_traversal_follow_dot_folder_allowlist (red-then-green flip) + rg_and_fallback_produce_identical_results"
        status: pass
    human_judgment: false
  - id: D4
    description: "maru_dir.rs resolves containment through crate::paths::ensure_within, byte-identical error message, no private copy remains"
    requirement: SCAN-03
    verification:
      - kind: unit
        ref: "cargo test --lib maru_dir:: (21 tests)"
        status: pass
    human_judgment: false

duration: 9min
completed: 2026-08-22
status: complete
---

# Phase 2 Plan 01: Shared Paths Module Summary

**paths.rs created as the single home for the 14-entry generated-dir union, lexical ensure_within, and require_absolute — workspace_files, content_search, and maru_dir rewired, with rg visibility reconciled so generated dirs can never be allowlisted back into search.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-08-22T21:32:50Z
- **Completed:** 2026-08-22T21:42:01Z
- **Tasks:** 3
- **Files modified:** 6 (1 created, 5 modified)

## Accomplishments

- NEW `src-tauri/src/paths.rs`: `GENERATED_DIRS` (flat 14-entry D-03 union), `ensure_within` (promoted verbatim from maru_dir.rs, lexical per D-07, no canonicalize), `require_absolute` (SCAN-04 guard consumed by plan 02-03), `lexical_normalize` re-export — with 6 unit tests
- Registered `mod paths;` in lib.rs, staged hunk-level alongside the concurrent hwped session's uncommitted edits
- `workspace_files.rs` (former const owner) and `content_search.rs` (sixth consumer, compile-forced repoint) both consume the shared union
- rg_visibility reconciled with the union via deliberate red-then-green test flip: `exclude_git` is now unconditional — allowlisting `nested/.git/refs` changes nothing (SCAN-02's real delta); rg/fallback parity tests ran locally (rg 15.0.0, not skipped)
- `maru_dir.rs` dropped its private `ensure_within`; both call sites resolve through `crate::paths::ensure_within` with the byte-identical message; studio/diagram sibling copies and MARUIGNORE_DEFAULTS untouched (D-05/D-06)

## Task Commits

Each task was committed atomically:

1. **Task 1 (tracer): shared paths module + registry + two consumer rewires** - `562ea71` (feat)
2. **Task 2 RED: flip git_allowed rg_visibility expectation** - `ab8b843` (test)
3. **Task 2 GREEN: exclude_git unconditional; dead helper removed** - `d41b057` (feat)
4. **Task 3: maru_dir.rs drops private ensure_within** - `6eedb97` (feat)

**Plan metadata:** recorded below (docs commit)

## Tracer Feedback Gate

Plan frontmatter declares `autonomous: true`, so the tracer gate ran in autonomous mode: Task 1's `<verify>` (scoped tests + clippy + fmt) passed at commit time, and the full `cargo test --lib` suite (1211 passed / 0 failed) was re-run after Task 3 with the tracer still green end-to-end. No halt required — expansion tasks proceeded on a verified slice.

## Test Count Evidence

- **Baseline (HEAD 62936ea):** 1205 passed — derived arithmetically (final 1211 minus the 6 new paths::tests); see Deviations #1 for why the baseline was derived rather than directly measured
- **Final (after Task 3):** 1211 passed, 0 failed, 3 ignored — delta is exactly the 6 new paths::tests; no existing test count changed (content_search stays 20, maru_dir stays 21, workspace_files unchanged)
- **Red-then-green proof (Task 2):** RED run `test result: FAILED. 19 passed; 1 failed` — `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` failed with `left: RgVisibility { hidden: true, exclude_git: false }, right: ... exclude_git: true }`; GREEN run after the rg_visibility edit: `test result: ok. 20 passed`
- **Parity tests executed, not skipped:** `rg_and_fallback_produce_identical_results`, `rg_and_fallback_agree_across_search_options`, `rg_text_mode_matches_fallback_after_late_nul` all ran and passed with ripgrep 15.0.0 installed

## Files Created/Modified

- `src-tauri/src/paths.rs` — NEW shared path-invariants module (union, containment, absolute-base guard, tests)
- `src-tauri/src/lib.rs` — `mod paths;` registered (single hunk staged via `git add -p`; concurrent hwped hunks left uncommitted)
- `src-tauri/src/workspace_files.rs` — local `pub(crate) const GENERATED_DIRS` deleted; imports shared union
- `src-tauri/src/content_search.rs` — import split (`crate::paths::GENERATED_DIRS` + `crate::workspace_files::is_binary_file`); rg_visibility exclude_git unconditional; allowlist test expectation flipped
- `src-tauri/src/vault.rs` — `could_include_dot_folder_named` removed (lost its only caller)
- `src-tauri/src/maru_dir.rs` — private ensure_within deleted; calls canonical helper; unused lexical_normalize import dropped

## Decisions Made

- `mod paths;` sits between `outlook_mso` and `project_activity` — the truly alphabetical position, accepted by rustfmt's reorder_modules; the plan's stated slot (between ops_catalog and outlook_mso) misorders the registry
- `could_include_dot_folder_named` deleted rather than kept for future use — dead `pub(crate)` code fails the clippy gate, and the semantic it expressed (allowlist resurrection of .git) is exactly what SCAN-02 removes
- `require_absolute` keeps its `#[allow(dead_code)]` (with a comment naming plan 02-03 as the removal point) — its first consumer lands in that plan

## Deviations from Plan

### Pre-existing work adoption

**0. Task 1's edits were already present, uncommitted, in the working tree at executor start**
- **Found during:** Task 1 pre-flight
- **Situation:** `src-tauri/src/paths.rs` (untracked), the workspace_files.rs/content_search.rs rewires, and the `mod paths;` line in lib.rs already existed — evidently from an interrupted prior execution attempt; content matched the plan's spec (14-entry union in order, verbatim ensure_within, require_absolute, re-export, 6 tests)
- **Resolution:** verified the work against every Task 1 acceptance criterion (all passed), adopted it, and committed it as Task 1. Baseline test count derived arithmetically (1205 = 1211 − 6 paths::tests) since a clean HEAD measurement would have required reverting the tree
- **Committed in:** `562ea71`

### Auto-fixed Issues

**1. [Rule 3 - Blocking] `mod paths;` placement corrected to true alphabetical position**
- **Found during:** Task 1
- **Issue:** Plan/PATTERNS say insert between `mod ops_catalog;` and `mod outlook_mso;`, but the registry is strictly alphabetical and `ops_catalog < outlook_mso < paths` — the stated slot breaks the convention
- **Fix:** placed between `outlook_mso` and `project_activity`; rustfmt (reorder_modules) confirms no diff on the line
- **Files modified:** src-tauri/src/lib.rs
- **Committed in:** `562ea71`

**2. [Rule 3 - Blocking] Temporary `#[allow(dead_code)]` on promoted helpers in the Task 1 commit**
- **Found during:** Task 1 (in the pre-existing work; confirmed necessary)
- **Issue:** ensure_within/require_absolute had no consumers until Tasks 3 / plan 02-03; without the allow, `cargo clippy -- -D warnings` fails on dead_code
- **Fix:** allow attributes with comments naming the commit/plan that removes each; ensure_within's allow removed in `6eedb97` as designed; require_absolute's remains until 02-03
- **Files modified:** src-tauri/src/paths.rs
- **Committed in:** `562ea71`, removal in `6eedb97`

**3. [Rule 3 - Blocking] Removed `could_include_dot_folder_named` from vault.rs**
- **Found during:** Task 2 GREEN
- **Issue:** rg_visibility was its only caller; after the exclude_git change the `pub(crate)` method is dead code and fails the clippy gate
- **Fix:** deleted the method (grep-verified zero remaining callers; vault suite 29/29 green)
- **Files modified:** src-tauri/src/vault.rs
- **Committed in:** `d41b057`

**4. [Rule 3 - Blocking] Dropped unused `lexical_normalize` import from maru_dir.rs**
- **Found during:** Task 3
- **Issue:** the private ensure_within was lexical_normalize's only use in maru_dir.rs; deleting the function orphans the import (clippy/unused-import failure)
- **Fix:** removed it from the `crate::vault` import group; added `use crate::paths::ensure_within;` alphabetically
- **Files modified:** src-tauri/src/maru_dir.rs
- **Committed in:** `6eedb97`

---

**Total deviations:** 4 auto-fixed (all Rule 3 - blocking) + 1 pre-existing-work adoption
**Impact on plan:** All fixes necessary to keep the Phase 1 gates green. No scope creep; no behavioral change beyond the plan's intended SCAN-02 delta.

## Issues Encountered

- **Concurrent-session gate failures (out of scope, per Phase 1 precedent):** `cargo fmt --check` fails solely on the concurrent session's uncommitted `src-tauri/src/hwped.rs` and its two hwped hunks in lib.rs (mod-placement and use-ordering); `cargo clippy -- -D warnings` fails on exactly 2 errors, both in hwped.rs (needless_borrow :164, useless_format :381). Neither traces to this plan's diff. Owned files proven individually green: `rustfmt --edition 2021 --check` passes on paths.rs, workspace_files.rs, content_search.rs, vault.rs, maru_dir.rs, and the fmt/clippy error lists contain zero entries outside hwped.rs. CI is the authoritative composite.
- No test-race with the concurrent session's cargo processes occurred during this run.

## Threat Flags

None — the plan's threat register (T-02-01/02/03) covered all touched surface; no new endpoints, auth paths, or trust-boundary schema changes introduced. T-02-02's mitigation (generated dirs un-allowlistable) landed in Task 2; T-02-01's (canonical tested containment helper) in Tasks 1+3.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- paths.rs is ready for plan 02-02 (rewire vault.rs, secrets.rs, project_activity.rs, evidence_binder.rs to the union — inbox.rs keeps its `&[]` exception) and plan 02-03 (require_absolute guard in skill_host/fs.rs; remove the remaining allow(dead_code) there)
- Watch-item for 02-02: vault.rs's scanner rewire must keep the `generated_dirs` parameter on `ScanFilter::is_excluded_path` (Pitfall 5); this plan already removed `could_include_dot_folder_named`, so 02-02 diffs against vault.rs should expect it gone
- The concurrent hwped session's uncommitted files remain in the tree; future plans on this checkout must keep using hunk-level staging for lib.rs

---
*Phase: 02-shared-scanner-and-path-invariants*
*Completed: 2026-08-22*

## Self-Check: PASSED

- FOUND: src-tauri/src/paths.rs (created, committed in 562ea71)
- FOUND: .planning/phases/02-shared-scanner-and-path-invariants/02-01-SUMMARY.md
- FOUND commits: 562ea71 (Task 1), ab8b843 (Task 2 RED), d41b057 (Task 2 GREEN), 6eedb97 (Task 3)
