---
phase: 07-guardrails-before-churn
plan: 03
subsystem: filesystem-watchers
tags: [generated-dirs, watcher-pruning, ssot, perf-04, rust, tauri, notify]

requires:
  - phase: 07-guardrails-before-churn
    provides: the phase's D-04/D-05/D-06 decisions and the GENERATED_DIRS SSOT constant from Phase 2 (paths.rs)
provides:
  - "src-tauri/src/paths.rs::is_under_generated_dir — the root-agnostic exact-component generated-dir predicate beside GENERATED_DIRS, colocated unit tests"
  - "Dispatch-time pruning of GENERATED_DIRS paths at all five recursive watchers (vault_watcher, inbox_watcher, scratchpad_watcher, ops_catalog/watcher, terminal_hooks)"
  - "vault_watcher's hand-rolled five-name generated-dir arm in relevant_path replaced by the shared predicate (D-05 SSOT convergence)"
affects: [phase-08, phase-09, perf-04, watcher-event-pipeline]

actuals:
  tokens: 2842
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "is_under_generated_dir(path: &Path) -> bool: root-agnostic exact Component::Normal name match against GENERATED_DIRS; no root parameter (ops_catalog watches many roots), no globs/regex; prefix siblings never prune"
    - "Watcher prune at the per-path dispatch filter stage (before sort+dedup / before other continue-guards), never whole-event drop — D-04"
    - "Callback-closure wiring pinned by split-needle include_str! source assertions when the closure is not unit-testable without refactor (07-02 warn-count precedent)"

key-files:
  created: []
  modified:
    - src-tauri/src/paths.rs
    - src-tauri/src/vault_watcher.rs
    - src-tauri/src/inbox_watcher.rs
    - src-tauri/src/scratchpad_watcher.rs
    - src-tauri/src/ops_catalog/watcher.rs
    - src-tauri/src/terminal_hooks.rs

key-decisions:
  - "ops_catalog's gate composed as pure fn should_dispatch_catalog_event(predicate && is_catalog_relevant) so the plan's dispatch-relevance test is a real behavioral assertion, not a source grep; the next()-only extraction shape is untouched"
  - "scratchpad_watcher's drain test mirrors the filter chain (predicate call inline) because the generated-dir prune lives in the drain closure, not in relevant_path; its predicate reference count is 2 (production filter + chain-mirroring test), the other four modules are exactly 1"
  - "inbox_watcher and terminal_hooks callback closures pinned with split-needle include_str! assertions (exactly-once reference) rather than refactored for testability, per the plan's explicit scope boundary"

patterns-established:
  - "New recursive watchers prune generated-dir paths through paths::is_under_generated_dir at the per-path dispatch filter; a watcher that grows its own generated-dir name list re-fragments the D-05 SSOT"

requirements-completed: [PERF-04]

coverage:
  - id: D1
    description: "is_under_generated_dir has exact-component semantics: deep match prunes, prefix sibling (node_modules_backup) does not, root/empty paths safe, every one of the 14 GENERATED_DIRS entries prunes a path carrying it"
    requirement: PERF-04
    verification:
      - kind: unit
        ref: "src-tauri/src/paths.rs#is_under_generated_dir_matches_deep_component, is_under_generated_dir_rejects_prefix_sibling, is_under_generated_dir_rejects_root_and_empty_path, is_under_generated_dir_prunes_every_generated_dir_entry (cargo test --lib paths: 40 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "vault_watcher rejects generated-dir paths (including the nine entries beyond its old hand-rolled five), accepts prefix siblings, and a mixed batch emits only legitimate paths through the drain filter chain"
    requirement: PERF-04
    verification:
      - kind: unit
        ref: "src-tauri/src/vault_watcher.rs#rejects_generated_dir_paths_via_shared_predicate, accepts_prefix_sibling_of_generated_dir_name, mixed_batch_keeps_only_legitimate_paths (cargo test --lib vault_watcher: 5 passed)"
        status: pass
      - kind: other
        ref: "git diff 6ef89dc..HEAD: hand-rolled .git|node_modules|target|dist|build matches! arm replaced by the shared-predicate call; .maru/cache, .maru/versions, .maruignore, extension arms unchanged"
        status: pass
    human_judgment: false
  - id: D3
    description: "inbox_watcher and scratchpad_watcher prune per path at dispatch time; non-generated siblings in the same event still process"
    requirement: PERF-04
    verification:
      - kind: unit
        ref: "src-tauri/src/inbox_watcher.rs#callback_prunes_generated_dir_paths_via_shared_predicate (split-needle source assertion); src-tauri/src/scratchpad_watcher.rs#drain_filter_drops_generated_dir_paths_but_keeps_siblings (mixed batch); cargo test --lib inbox_watcher (5) and scratchpad_watcher (3) passed"
        status: pass
    human_judgment: false
  - id: D4
    description: "ops_catalog and terminal_hooks prune generated-dir paths; the mixed-batch/per-path pin lives in the vault_watcher and scratchpad_watcher drain-chain tests (shared filter shape)"
    requirement: PERF-04
    verification:
      - kind: unit
        ref: "src-tauri/src/ops_catalog/watcher.rs#generated_dir_path_under_catalog_surface_is_not_dispatch_relevant (path that is catalog-relevant without the gate is rejected); src-tauri/src/terminal_hooks.rs#hook_watcher_callback_prunes_generated_dir_paths_via_shared_predicate; cargo test --lib ops_catalog (22) and terminal_hooks (16) passed"
        status: pass
    human_judgment: false
  - id: D5
    description: "All five recursive watchers reference the SSOT predicate; no watcher defines a new local generated-dir name list; full crate suite green with clippy and fmt"
    requirement: PERF-04
    verification:
      - kind: other
        ref: "grep: predicate references — vault_watcher 1, inbox_watcher 1, scratchpad_watcher 2 (1 production + 1 chain-mirroring test), ops_catalog/watcher 1, terminal_hooks 1; diff added-lines scan for generated-dir name literals returns none"
        status: pass
      - kind: unit
        ref: "cargo test --lib 1264 passed; cargo clippy --lib -- -D warnings exit 0; cargo fmt --check exit 0"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-09-05
status: complete
---

# Phase 7 Plan 3: PERF-04 Watcher Generated-Dir Pruning Summary

**A single root-agnostic `is_under_generated_dir` predicate beside `GENERATED_DIRS` in `paths.rs` now prunes all 14 generated-directory names from every one of the five recursive filesystem watchers at dispatch time — replacing vault_watcher's hand-rolled five-name arm and closing the event-volume bottleneck for watched roots that grow heavy generated subtrees.**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-09-05T09:50:00Z
- **Completed:** 2026-09-05T09:56:00Z
- **Tasks:** 3
- **Files modified:** 6

## Accomplishments
- `src-tauri/src/paths.rs` gains `pub fn is_under_generated_dir(path: &Path) -> bool` directly below `GENERATED_DIRS` (D-05): exact `Component::Normal` name matching against the SSOT list, root-agnostic on purpose (ops_catalog registers one recursive watch per business unit, so no root parameter — unlike `ScanFilter::is_excluded_path`), no globs/regex, prefix siblings like `node_modules_backup` never prune (T-7-08).
- All five recursive watchers prune at the per-path dispatch filter (D-04), never whole-event: `vault_watcher` (the shared predicate replaces the hand-rolled `.git|node_modules|target|dist|build` arm of `relevant_path`, widening coverage to the full 14-entry union the vault scanner already uses), `inbox_watcher` (continue-guard at the top of the callback's per-path loop), `scratchpad_watcher` (drain-thread filter chained ahead of `relevant_path`, before strip_prefix/sort/dedup), `ops_catalog/watcher` (dispatch gate composed with `is_catalog_relevant` — the motivating per-BU growth case), and `terminal_hooks` (continue-guard alongside the filename-mismatch guard).
- Every prune case pinned: predicate edge cases in `paths.rs`, the mixed-batch per-path behavior in the vault and scratchpad drain-chain tests (generated paths in a batch never drop legitimate siblings, Pitfall 7), a behavioral dispatch test for ops_catalog, and split-needle source assertions for the two callback closures that are not unit-testable without refactor.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing predicate + vault_watcher prune tests** - `d057739` (test)
2. **Task 1 GREEN: is_under_generated_dir SSOT predicate + vault_watcher wiring** - `6376f35` (feat)
3. **Task 2: inbox_watcher + scratchpad_watcher dispatch-time prune** - `08aad67` (feat)
4. **Task 3: ops_catalog + terminal_hooks prune + full sweep** - `d424421` (feat)

_Note: Task 1 is a tdd="true" tracer — RED commit verified failing (E0425 unresolved predicate), GREEN verified green end-to-end (paths 40/40, vault_watcher 5/5, clippy) before expansion._

**Plan metadata:** see final docs commit below.

## Files Created/Modified
- `src-tauri/src/paths.rs` — `is_under_generated_dir` predicate beside `GENERATED_DIRS` + 4 colocated edge-case tests
- `src-tauri/src/vault_watcher.rs` — `relevant_path` delegates generated-dir pruning to the shared predicate; 3 new tests (rejection incl. `.venv`, prefix sibling, mixed batch)
- `src-tauri/src/inbox_watcher.rs` — per-path continue-guard in the callback loop; split-needle wiring assertion
- `src-tauri/src/scratchpad_watcher.rs` — drain-filter prune chained ahead of `relevant_path`; mixed-batch drain-chain test
- `src-tauri/src/ops_catalog/watcher.rs` — `should_dispatch_catalog_event` pure gate; dispatch-relevance test
- `src-tauri/src/terminal_hooks.rs` — per-path continue-guard in the callback loop; split-needle wiring assertion

## Decisions Made
- ops_catalog's gate is a composed pure fn (`should_dispatch_catalog_event`) rather than an inline `if` in the closure, so the plan's "not catalog-relevant for dispatch" test is a real behavioral assertion on a path that would dispatch without the gate; the `next()`-only extraction shape is unchanged (existing behavior outside this plan's scope).
- inbox_watcher and terminal_hooks closures stay un-refactored; their wiring is pinned by split-needle `include_str!` exactly-once assertions (the 07-02 warn-count precedent) per the plan's explicit scope boundary.
- The mixed-batch pin lives in vault_watcher and scratchpad_watcher tests since all four drain/callback filters share the per-path filter shape; the ops_catalog gate is single-path by design (existing `next()` extraction).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `PathBuf::new(...)` called with an argument in the RED mixed-batch test**
- **Found during:** Task 1 RED (compile error before the intended E0425 failure surfaced)
- **Issue:** The vault_watcher mixed-batch fixture used `PathBuf::new("/work/notes/a.md")`; `PathBuf::new` takes no arguments, so the test file itself failed to compile for a reason unrelated to the TDD red state.
- **Fix:** Changed to `PathBuf::from(...)`; the RED run then failed for the intended reason (unresolved `is_under_generated_dir`, E0425).
- **Files modified:** src-tauri/src/vault_watcher.rs
- **Verification:** RED commit `d057739` fails with E0425 (unresolved predicate) only
- **Committed in:** `d057739` (RED commit)

---

**Total deviations:** 1 auto-fixed (Rule 1, inside the RED test fixture)
**Impact on plan:** None on production behavior — the fix corrected the test's own syntax so the TDD red state asserted the intended unresolved-symbol failure. GREEN and all subsequent verifies ran exactly as planned.

## TDD Gate Compliance

- RED gate: `test(07-03)` commit `d057739` (failing — unresolved `is_under_generated_dir`, E0425, verified by cargo exit failure)
- GREEN gate: `feat(07-03)` commit `6376f35` (tests pass: paths 40/40, vault_watcher 5/5)
- No REFACTOR commit needed (only `cargo fmt` line wrapping, absorbed into the Task 3 commit)

## Issues Encountered
- None beyond the RED-fixture deviation above. The full `cargo test --lib` run (1264 passed) confirms no watcher consumer (inbox, scratchpad, catalog UI paths) regressed.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- PERF-04 is live: a watched root that grows a heavy generated subtree (the per-BU ops_catalog case) no longer floods the debounce/drain pipeline; filtering is per-path with exact-name semantics through one SSOT predicate.
- ROADMAP criterion 2 holds at all five recursive-watch sites; D-06's fixed five-site scope is fully covered.
- Registration-time exclusion was rejected by D-04 and remains so; the predicate is root-agnostic, so any future watcher gets pruning by referencing `paths::is_under_generated_dir`.
- Full `make verify` composite not run here; every gate this plan owns was verified individually (module suites, full `cargo test --lib`, clippy, fmt). CI is the authoritative composite check.

## Self-Check: PASSED
- All six key-files exist on disk: FOUND
- Commits d057739 / 6376f35 / 08aad67 / d424421 present in git log: FOUND
- Plan-level verification re-run after all tasks: `cargo test --lib paths` 40/40; `cargo test --lib` 1264 passed, 0 failed; `cargo clippy --lib -- -D warnings` exit 0; `cargo fmt --check` exit 0
- Five-watcher grep: predicate referenced in all five modules, no new inline generated-dir name lists in the diff

---
*Phase: 07-guardrails-before-churn*
*Completed: 2026-09-05*
