---
phase: 02-shared-scanner-and-path-invariants
plan: "02"
subsystem: infra
tags: [rust, scanner, path-invariants, walkdir, tdd]

requires:
  - phase: 02-shared-scanner-and-path-invariants
    plan: "01"
    provides: src-tauri/src/paths.rs — the shared 14-entry GENERATED_DIRS union this plan rewires the four remaining scanners to
provides:
  - vault.rs, secrets.rs, project_activity.rs, evidence_binder.rs all consuming crate::paths::GENERATED_DIRS — SCAN-01's one-line-edit claim now true for every scanner
  - SCAN-02 red→green proof: vault scan excludes __pycache__ (the genuinely new, non-dot exclusion) via scan_excludes_generated_dirs_union_including_pycache
  - evidence_binder module-local .maru exclusion preserved ORed with the union (Pitfall 3, T-02-04)
affects: [02-shared-scanner-and-path-invariants (plan 02-03 SCAN-04 guard — last consumer of paths.rs)]

actuals:
  tokens: 1431
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "Red-then-green scanner rewire: union-proof test committed failing first, private prune lists deleted second"
    - "Injected predicate, shared constant: ScanFilter::is_excluded_path keeps its generated_dirs: &[&str] parameter; only the constant's origin moved to crate::paths"

key-files:
  created: []
  modified:
    - src-tauri/src/vault.rs
    - src-tauri/src/secrets.rs
    - src-tauri/src/project_activity.rs
    - src-tauri/src/evidence_binder.rs

key-decisions:
  - "Union-proof fixture leaves written as .md documents (not the plan's literal .pyc/extensionless/.py leaves) — scan_vault only collects md/markdown/html/htm, so the literal fixture could never go red; the red proof is the phase's core SCAN-02 evidence"
  - "PRUNED_DIRS's Korean comment (attached to the deleted constant) removed with it; the doc comment above is_pruned_dir (the one the plan required byte-intact) untouched"

requirements-completed: [SCAN-01, SCAN-02]

coverage:
  - id: D1
    description: "vault.rs consumes the shared union; ScanFilter::is_excluded_path keeps its injected generated_dirs: &[&str] parameter; union-proof test red→green"
    requirement: SCAN-01, SCAN-02
    verification:
      - kind: unit
        ref: "src-tauri/src/vault.rs#scan_excludes_generated_dirs_union_including_pycache (RED: left [__pycache__/cached.md, keep.md]; GREEN after rewire) + cargo test --lib vault:: (30 tests)"
        status: pass
    human_judgment: false
  - id: D2
    description: "secrets.rs consumes the shared union; vault/.maru/secrets/.secrets domain prefix rules in should_prune untouched"
    requirement: SCAN-01
    verification:
      - kind: unit
        ref: "cargo test --lib secrets:: (8 tests) + grep-proof of prefix rules at should_prune"
        status: pass
    human_judgment: false
  - id: D3
    description: "project_activity.rs consumes the union with the broader dot-prefix rule retained; evidence_binder.rs keeps .maru excluded module-locally ORed with union membership"
    requirement: SCAN-01, SCAN-02
    verification:
      - kind: unit
        ref: "cargo test --lib -- project_activity:: evidence_binder:: inbox:: (72 tests) + grep-proofs of dot-prefix rule and .maru branch"
        status: pass
    human_judgment: false
  - id: D4
    description: "Full lib suite green with exactly the allowed +1 delta over the 02-01 baseline; inbox untouched; ops_catalog/scan.rs untouched"
    requirement: SCAN-01, SCAN-02
    verification:
      - kind: unit
        ref: "cargo test --lib → 1212 passed / 0 failed / 3 ignored (1211 baseline + 1); git diff ops_catalog/scan.rs empty"
        status: pass
    human_judgment: false

duration: 5min
completed: 2026-08-22
status: complete
---

# Phase 2 Plan 02: Scanner Rewires to the Shared Union Summary

**All four remaining scanners (vault, secrets, project_activity, evidence_binder) rewired to the shared 14-entry GENERATED_DIRS union with each module's non-union rules intact — and the SCAN-02 delta proven red→green: a vault scan over a fixture tree containing __pycache__/, .git/, and .venv/ now returns none of their contents.**

## Performance

- **Duration:** 5 min
- **Started:** 2026-08-22T21:46:41Z
- **Completed:** 2026-08-22T21:51:45Z
- **Tasks:** 3
- **Files modified:** 4 (0 created)

## Accomplishments

- `vault.rs`: private 7-entry prune-list constant deleted; `use crate::paths::GENERATED_DIRS;` added to the crate-import group (alphabetical). `ScanFilter::is_excluded_path` keeps its `generated_dirs: &[&str]` injected parameter exactly as-is (Pitfall 5, T-02-05); dot-segment rule and `lexical_normalize`/`resolve_inside_vault` untouched.
- `secrets.rs`: private 12-entry list deleted; same import added ahead of the existing `crate::vault` import. `should_prune` iterates `&[&str]` and works unchanged against the wider union (adds `.turbo`, `__pycache__` — intended D-04 behavior); the vault / `.maru/secrets` / `.secrets` domain prefix rules are byte-intact.
- `project_activity.rs`: `PRUNED_DIRS: [&str; 6]` deleted; `is_pruned_dir` membership check reads `GENERATED_DIRS` while the broader dot-prefix rule (`name.starts_with('.') && name.len() > 1`) and the Korean doc comment above the function stay byte-for-byte intact.
- `evidence_binder.rs`: 5-name `matches!` replaced by `GENERATED_DIRS.contains(&name) || name == ".maru"` with a comment explaining `.maru` is Maru state, not a generated dir, and deliberately stays out of the shared constant (Pitfall 3, T-02-04). Union widening 4→14 entries for this scanner is the intended D-04 scan-scope reduction.
- New SCAN-02 union-proof test `scan_excludes_generated_dirs_union_including_pycache` in vault.rs's test module, committed RED first.

## Task Commits

Each task was committed atomically:

1. **Task 1 (tdd RED): union-proof test, committed failing** — `86f0075` (test)
2. **Task 2: vault.rs + secrets.rs rewired (turns Task 1 green)** — `14df41f` (feat)
3. **Task 3: project_activity.rs + evidence_binder.rs rewired** — `c3d62ce` (feat)

**Plan metadata:** recorded below (docs commit)

## Test Count Evidence

- **02-01 baseline:** 1211 passed / 0 failed / 3 ignored (from 02-01-SUMMARY.md)
- **Final (after Task 3):** `test result: ok. 1212 passed; 0 failed; 3 ignored` — delta is exactly +1, this plan's new vault union-proof test. Same-wave plan 02-03 has NOT yet run, so the +1 ordering applied (no maru_home_rejects_relative_test_home in the count).
- **Red→green pair (SCAN-02's real delta):**
  - RED (commit `86f0075`, pre-rewire): `test result: FAILED. 29 passed; 1 failed` — `scan_excludes_generated_dirs_union_including_pycache` panicked with `left: ["__pycache__/cached.md", "keep.md"]`, `right: ["keep.md"]`. Every other vault test passed.
  - GREEN (commit `14df41f`, post-rewire): `cargo test --lib -- vault:: secrets::` → `test result: ok. 38 passed; 0 failed`.
- **Pitfall 5 regression check:** `cargo test --lib inbox::` runs inside the Task 3 scoped run (72 tests across project_activity/evidence_binder/inbox, all ok) — the three empty-slice `is_excluded_path` call sites and the `.omc` allowlist tests survived untouched.
- **`git diff --stat src-tauri/src/ops_catalog/scan.rs` is empty** — the domain-specific BU-scan list is untouched.

## Files Created/Modified

- `src-tauri/src/vault.rs` — private 7-entry `GENERATED_DIRS` const deleted; shared import added; new union-proof test in the test module (+25/−9 net across tasks 1–2)
- `src-tauri/src/secrets.rs` — private 12-entry `GENERATED_DIRS` const deleted; shared import added
- `src-tauri/src/project_activity.rs` — `PRUNED_DIRS` const deleted; `is_pruned_dir` reads the union; dot-prefix rule + Korean doc comment intact
- `src-tauri/src/evidence_binder.rs` — `is_excluded_dir` is now union-membership OR module-local `.maru`; shared import added

## Decisions Made

- **Union-proof fixture leaves are `.md` documents**, not the plan's literal `mod.cpython-312.pyc` / extensionless `cdef` / `site.py` leaves: `scan_vault` only collects `md/markdown/html/htm`, so the literal fixture would have passed pre-rewire and the RED proof — the phase's core SCAN-02 evidence — would have been impossible. The directory structure (`__pycache__/`, `.git/objects/ab/`, `.venv/lib/python3.12/`) and the exact-`["keep.md"]` assertion are unchanged; the test comment explains the real deltas (__pycache__ non-dot + unconditional union membership, not the stale git-object framing). Recorded as Deviation 1.
- The Korean comment that sat above the deleted `PRUNED_DIRS` constant was removed with it; the plan's "byte-for-byte intact" requirement applies to the doc comment above `is_pruned_dir`, which is untouched.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Plan's fixture could never go red — fixture leaves changed to document extensions**
- **Found during:** Task 1 (pre-write analysis of `is_document_extension` at vault.rs:551-556)
- **Issue:** The plan's fixture (`__pycache__/mod.cpython-312.pyc`, `.git/objects/ab/cdef`, `.venv/lib/python3.12/site.py`) contains no document files; `scan_vault` filters to md/markdown/html/htm before pruning even matters, so the test would PASS pre-rewire — silently destroying the red-then-green proof the plan's acceptance criteria demand ("it must FAIL because vault's current private 7-entry list lacks __pycache__"). The TDD fail-fast rule also forbids proceeding to GREEN on a passing RED.
- **Fix:** Kept the plan's directory structure and assertion exactly; changed the three fixture leaves to `.md` documents (`__pycache__/cached.md`, `.git/objects/ab/cdef.md`, `.venv/lib/python3.12/site.md`). The test then failed pre-rewire for precisely the stated reason (`__pycache__/cached.md` surfaced) and passed post-rewire.
- **Files modified:** src-tauri/src/vault.rs
- **Commit:** `86f0075`

**Total deviations:** 1 auto-fixed (Rule 1). No other deviations — plan executed as written otherwise.

## Issues Encountered

- **Concurrent-session gate failures (out of scope, Phase 1/02-01 precedent):** `cargo clippy -- -D warnings` fails on exactly 2 errors, both in the concurrent hwped session's uncommitted `src-tauri/src/hwped.rs` (needless_borrow :164, useless_format :381 — identical to what 02-01 recorded); `cargo fmt --check` diffs exist only in hwped.rs and the foreign hwped hunks of lib.rs. Neither traces to this plan's diff. Owned files proven individually green: `rustfmt --edition 2021 --check` passes on vault.rs, secrets.rs, project_activity.rs, evidence_binder.rs, and scoped + full `cargo test --lib` suites are green (1212/0). CI is the authoritative composite.
- No test-race with concurrent cargo processes occurred during this run.

## Threat Flags

None — the plan's threat register (T-02-04/05/06) covered all touched surface; no new endpoints, auth paths, or trust-boundary schema changes introduced. T-02-04's mitigation (module-local `.maru` OR-branch) landed in Task 3 and is grep-proven; T-02-05's (injected-parameter signature preserved + inbox regression run) in Tasks 2–3; T-02-06 (secrets union widening) was dispositioned `accept` in the plan.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- SCAN-01's one-line-edit claim is now true end to end: all five original scanners plus content_search (02-01) consume `crate::paths::GENERATED_DIRS`; inbox.rs keeps its `&[]` exception by design.
- Plan 02-03 is unblocked: `require_absolute` (still `#[allow(dead_code)]` in paths.rs) gets its first consumer in `skill_host/fs.rs` (SCAN-04); removing that allow belongs to 02-03. If 02-03 runs next, the full-suite baseline for its count check is 1212.
- The concurrent hwped session's uncommitted files remain in the tree; future plans on this checkout must keep staging only owned files.

---
*Phase: 02-shared-scanner-and-path-invariants*
*Completed: 2026-08-22*

## Self-Check: PASSED

- FOUND: src-tauri/src/vault.rs, src-tauri/src/secrets.rs, src-tauri/src/project_activity.rs, src-tauri/src/evidence_binder.rs (all rewired, committed)
- FOUND: .planning/phases/02-shared-scanner-and-path-invariants/02-02-SUMMARY.md
- FOUND commits: 86f0075 (Task 1 RED), 14df41f (Task 2), c3d62ce (Task 3)
