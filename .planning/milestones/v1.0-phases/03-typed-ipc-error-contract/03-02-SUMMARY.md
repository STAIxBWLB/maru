---
phase: 03-typed-ipc-error-contract
plan: "02"
subsystem: ipc
tags: [rust, ipc, error-contract, today, document]

requires:
  - phase: 03-typed-ipc-error-contract
    provides: "03-01's IpcError { code, message } struct, the four contract-code constants, and the tracer shape (evidence_binder_mutate) this plan copies"
provides:
  - "check_revision, today_mutate, today_finalize_setup, today_calendar_publish, load_context, task_transition, task_trash, assert_expected_revision, save_document all return Result<_, IpcError>"
  - "TODAY_CONFLICT / TASK_CONFLICT / DOCUMENT_CONFLICT constructed at every contract emit site; all three constants now have consumers, clearing the transient clippy red 03-01 left"
  - "map_err(|e| e.to_string()) adapter pattern for a non-branch-on caller of a migrated shared helper, used at four call sites (today_apply_plan_result, task_calendar_set_sync, update_frontmatter_field, web_actions.rs's apply_receipt/web_actions_import_top)"
  - "Post-migration ERR-04 signature count measured at 1128 (B-10, exact match against 03-01's baseline)"
affects: [03-typed-ipc-error-contract (03-03 frontend branch sites, 03-04 gates)]

actuals:
  tokens: 5558
  tasks: 2
  commits: 3

tech-stack:
  added: []
  patterns:
    - "A shared guard's conflict emit site constructs IpcError directly; every other error path in a migrated command's body rides From<String> unchanged, either automatically via ? or explicitly via .into() at a direct return-Err(String) site"
    - "A command that is NOT in the branch-on set but calls a migrated shared helper stays Result<_, String> via a .map_err(|e| e.to_string()) adapter at the call site (the same shape 03-01 established for evidence_binder's tracer, now applied four more times)"
    - "A private helper called via ? inside a match tail-expression (not itself the migrated fn) needs the match result captured in a let binding, then .map_err(IpcError::from) once, rather than converting every arm individually"

key-files:
  created: []
  modified:
    - src-tauri/src/today_store.rs
    - src-tauri/src/today_calendar.rs
    - src-tauri/src/today_lifecycle.rs
    - src-tauri/src/today_ai.rs
    - src-tauri/src/document.rs
    - src-tauri/src/web_actions.rs

key-decisions:
  - "web_actions.rs is not in this plan's declared file list but calls today_mutate and task_transition directly; both call sites and one internal conflict-code branch needed changes to keep the crate compiling (Rule 3 - blocking issue caused directly by this plan's signature changes)"
  - "document.rs's update_frontmatter_field (not named in PATTERNS.md) calls assert_expected_revision and needed the same map_err adapter as today_apply_plan_result, for the same ERR-04 reason: no frontend branch on this command's error"
  - "The day_conflict guard the plan calls today_mutate's 'second inline revision guard' actually lives inside apply_mutation, a private helper today_mutate calls via ? on TodayMutation::SetPlan - not literally inside today_mutate's own body. The behavior (IpcError with TODAY_CONFLICT, verbatim suffix) is unchanged; only the plan's location description was imprecise"
  - "Eleven prefix-string test assertions needed migration in total, not the six PATTERNS.md/PLAN.md enumerated by line number: every unwrap_err() on a migrated command yields IpcError now, regardless of which of that command's error paths fired, so non-conflict legacy-string assertions (today_undo_unavailable, today_yesterday_item_missing, today_block_crosses_sleep, task_defer_date_required, web_actions.rs's stale-revision check) needed a .to_string() insertion to keep compiling, even though they carry no contract code"

requirements-completed: [ERR-04]

coverage:
  - id: D1
    description: "The four migrated today-domain commands and their two shared helpers (check_revision, today_mutate, today_finalize_setup, today_calendar_publish, load_context, task_transition, task_trash) return Result<_, IpcError>, constructing TODAY_CONFLICT/TASK_CONFLICT at every conflict site with the legacy suffix text verbatim"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "cargo --offline test --lib today (96 passed)"
        status: pass
      - kind: unit
        ref: "cargo --offline test --lib web_actions (29 passed, covers the today_mutate/task_transition fallout call sites)"
        status: pass
    human_judgment: false
  - id: D2
    description: "save_document and assert_expected_revision return Result<_, IpcError>, constructing DOCUMENT_CONFLICT at all three conflict sites (the shared guard plus the two inline missing-file checks); non-conflict read errors keep byte-identical text"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "cargo --offline test --lib document (42 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "cargo clippy --lib -D warnings is green: all three not-yet-consumed contract-code constants (TODAY_CONFLICT, TASK_CONFLICT, DOCUMENT_CONFLICT) 03-01 left with no consumer now have one, with zero new suppression attributes added anywhere"
    requirement: ERR-01
    verification:
      - kind: other
        ref: "cargo --offline clippy --lib -- -D warnings (exit 0, no output)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Post-migration ERR-04 signature count is measured and matches the predicted B-10 delta exactly, confirming only the 10-signature migration set changed"
    requirement: ERR-04
    verification:
      - kind: other
        ref: "grep -roE 'Result<.*, String>' src-tauri/src --include='*.rs' | wc -l -> 1128 (B=1138, B-10=1128)"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-23
status: complete
---

# Phase 3 Plan 02: Today-domain and save_document IpcError migration Summary

**Nine commands/helpers across five files now emit typed `IpcError` at their conflict sites, clearing the last of 03-01's three unconsumed contract-code constants, with the post-migration `Result<T, String>` count landing at exactly `B-10` (1128).**

## Performance

- **Tasks:** 2 completed
- **Files modified:** 6 (5 declared by the plan + web_actions.rs, an undeclared fallout fix)
- **Duration:** ~50min (approximate; the session's start timestamp was not captured before the investigation phase began)

## Accomplishments

- `check_revision`, `today_mutate`, `today_finalize_setup`, and `today_calendar_publish` (today_store.rs, today_calendar.rs) all return `Result<_, IpcError>`, constructing `TODAY_CONFLICT` at three emit sites: the shared `check_revision` guard, `today_mutate`'s own inline revision check, and a second inline guard inside `apply_mutation`'s `SetPlan` branch (a private helper `today_mutate` calls via `?`, not literally inside `today_mutate`'s body as the plan's read_first block described).
- `load_context`, `task_transition`, and `task_trash` (today_lifecycle.rs) return `Result<_, IpcError>`, constructing `TASK_CONFLICT` at `load_context`'s hash-mismatch guard. `task_transition`'s dispatch `match` (four `run_*` helpers that stay `Result<_, String>`) is captured in a `let` binding and converted once via `.map_err(IpcError::from)`.
- `assert_expected_revision` and `save_document` (document.rs) return `Result<_, IpcError>`, constructing `DOCUMENT_CONFLICT` at all three conflict sites (the shared guard plus `save_document`'s two inline missing-file checks). The two "Cannot read document" read-failure paths and the `read_document` tail call keep byte-identical text (the latter via an explicit `.map_err(Into::into)`, since it's a direct, non-`?` tail call into the unmigrated `read_document`).
- Every non-contract error path inside these nine functions keeps its exact legacy string, riding `IpcError`'s `From<String>` either automatically through `?` or explicitly via `.into()` at direct `return Err(string)` sites (today_finalize_setup alone has nine such sites).
- Three callers that are NOT in the branch-on set but call a migrated shared helper (`today_apply_plan_result`, `task_calendar_set_sync`, `update_frontmatter_field`) stay `Result<_, String>` via a `.map_err(|e| e.to_string())` adapter, the same shape 03-01 established for the tracer, now proven at four more call sites (the fourth being web_actions.rs, see Deviations).
- `cargo clippy --lib -- -D warnings` is green: `TODAY_CONFLICT`, `TASK_CONFLICT`, and `DOCUMENT_CONFLICT` all have consumers now, clearing the transient red 03-01 left with no suppression attribute added.
- Post-migration ERR-04 count measured at **1128**, exactly `B-10` (`B=1138` from 03-01's baseline, 10 = the 7 commands + 3 shared helpers), confirming no signature outside the declared migration set changed.

## Task Commits

1. **Task 1: Migrate the today domain (today_store, today_calendar, today_lifecycle, today_ai) to IpcError** - `e603f69` (feat); also touched web_actions.rs (undeclared fallout fix, see Deviations)
2. **Task 2: Migrate save_document (document.rs) to IpcError and record the ERR-04 signature count** - `eff3526` (feat)

## Files Created/Modified

- `src-tauri/src/today_store.rs` - check_revision, today_mutate, today_finalize_setup, apply_mutation flip to IpcError; nine legacy-string sites in today_finalize_setup get `.into()`; five test assertions migrated
- `src-tauri/src/today_calendar.rs` - today_calendar_publish flips to IpcError; task_calendar_set_sync gets the map_err adapter; one test assertion migrated
- `src-tauri/src/today_lifecycle.rs` - load_context, task_transition, task_trash flip to IpcError; three test assertions migrated
- `src-tauri/src/today_ai.rs` - today_apply_plan_result's today_mutate call site gets the map_err adapter (no signature change)
- `src-tauri/src/document.rs` - assert_expected_revision, save_document flip to IpcError; update_frontmatter_field gets the map_err adapter; two test assertions migrated
- `src-tauri/src/web_actions.rs` - apply_receipt's task_transition call and web_actions_import_top's today_mutate call get the map_err adapter / code-based branch; one test assertion migrated (undeclared fallout fix)

## Decisions Made

- **web_actions.rs adopted as an undeclared fallout fix, not a scope change.** It calls `today_mutate` (4 sites) and `task_transition` (1 site) directly and is not in this plan's `files_modified` list or `03-PATTERNS.md`'s file classification. Once `today_mutate`/`task_transition` flip to `IpcError`, `web_actions.rs` fails to compile without changes at every one of those call sites. Two of the four `today_mutate` sites are `.unwrap()` success-path tests requiring no change; the other two (`apply_receipt`'s `task_transition` call, `web_actions_import_top`'s `today_mutate` match) needed the map_err adapter, and `web_actions_import_top`'s internal `Err(err) if err.starts_with("today_conflict")` branch (a real Rust-side retry decision, not just a test) moved to `err.code == TODAY_CONFLICT`. This is Rule 3 (blocking issue caused directly by this plan's own signature changes), not new functionality.
- **`update_frontmatter_field` also needed the map_err adapter.** Not named in PATTERNS.md's file classification or the plan's action text, it directly calls `assert_expected_revision(...)?` and fails to compile once that helper flips to `IpcError`. Same ERR-04 reasoning as `today_apply_plan_result`: no frontend branch reads this command's error by code, so it stays `Result<_, String>`.
- **The plan's "today_mutate's two inline revision guards" description was imprecise for the second guard.** It lives inside `apply_mutation` (a private helper `today_mutate` calls via `?` on the `TodayMutation::SetPlan` arm), not inside `today_mutate`'s own body. The constructed `IpcError` is identical either way; only the location description needed correcting during implementation.
- **Eleven prefix-string assertions migrated, not six.** The plan's read_first blocks enumerated six by line number (today_store.rs, today_lifecycle.rs, document.rs). Because every `unwrap_err()` on a migrated command now yields `IpcError` regardless of which error path inside that command fired, five more assertions needed a `.to_string()` insertion just to keep compiling, even though they check non-contract legacy strings (`today_undo_unavailable`, `today_yesterday_item_missing`, `today_block_crosses_sleep`, `task_defer_date_required`, and web_actions.rs's stale-revision check). None were weakened; each still asserts the same text it did before, just through `.to_string()`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking compile issue] web_actions.rs call sites needed the map_err adapter / code-based branch**
- **Found during:** Task 1, after flipping today_mutate and task_transition
- **Issue:** `cargo build --lib` failed with three type mismatches: `apply_receipt`'s `task_transition(...)?` (E0277, no `From<IpcError> for String`), and `web_actions_import_top`'s `today_mutate(...)` match arms (`err.starts_with(...)` doesn't exist on `IpcError`; `Err(err) => Err(err)` type mismatch)
- **Fix:** `.map_err(|e| e.to_string())?` at the `task_transition` call; `err.code == TODAY_CONFLICT` (imported from `crate::ipc_error`) replacing `err.starts_with("today_conflict")` in the retry-branch match guard, and `Err(err.to_string())` for the fallthrough arm
- **Files modified:** src-tauri/src/web_actions.rs
- **Verification:** `cargo --offline test --lib web_actions` (29 passed)
- **Committed in:** `e603f69` (part of task 1 commit); the guard's literal-vs-constant follow-up below landed in a separate commit

**2. [Rule 1 - Bug/compile fix] today_mutate's own today_undo_unavailable sites and task_calendar_set_sync's tail call also needed conversion**
- **Found during:** Task 1, first `cargo build --lib` after the signature flips
- **Issue:** Two `return Err("today_undo_unavailable".to_string())` sites inside `today_mutate`'s `Undo` branch (separate from the revision-conflict guard) failed to compile once the function's error type flipped; `task_calendar_set_sync` (today_calendar.rs) tail-calls `today_mutate` directly and is not in the branch-on set
- **Fix:** `.into()` appended to both `today_undo_unavailable` sites; `.map_err(|e| e.to_string())` appended to `task_calendar_set_sync`'s `today_mutate` call
- **Files modified:** src-tauri/src/today_store.rs, src-tauri/src/today_calendar.rs
- **Verification:** `cargo --offline build --lib` clean; `cargo --offline test --lib today` (96 passed)
- **Committed in:** `e603f69` (part of task 1 commit)

**3. [Rule 3 - Blocking compile issue] document.rs's update_frontmatter_field needed the map_err adapter**
- **Found during:** Task 2, first `cargo build --lib` after assert_expected_revision flipped
- **Issue:** `update_frontmatter_field` calls `assert_expected_revision(...)?` directly and is not in the branch-on set; `?` requires `From<IpcError> for String`, which doesn't exist
- **Fix:** `.map_err(|e| e.to_string())?` at the call site
- **Files modified:** src-tauri/src/document.rs
- **Verification:** `cargo --offline test --lib document` (42 passed)
- **Committed in:** `eff3526` (part of task 2 commit)

**4. [Rule 1 - Test compile fix] Five additional prefix-string test assertions needed migration**
- **Found during:** Both tasks, `cargo test --lib --no-run`
- **Issue:** `unwrap_err()` on today_mutate/task_transition/today_calendar_publish now yields `IpcError` for every error path, not just the conflict path the plan's read_first blocks named; five assertions comparing the raw `String` (`assert_eq!(err, "...")` / `err.starts_with(...)`) failed to compile
- **Fix:** `.to_string()` inserted before the existing comparison/`starts_with` call, preserving the exact same assertion text
- **Files modified:** src-tauri/src/today_store.rs, src-tauri/src/today_lifecycle.rs, src-tauri/src/web_actions.rs
- **Verification:** `cargo --offline test --lib today`, `cargo --offline test --lib web_actions` (both fully green)
- **Committed in:** `e603f69` (part of task 1 commit)

**5. [Review-caught - ERR-02 defect] web_actions.rs's retry branch compared err.code against a raw string literal instead of TODAY_CONFLICT**
- **Found during:** Team-lead review of this plan's commits, after task 1/2 landed
- **Issue:** `Err(err) if err.code == "today_conflict" => Ok(skipped("conflict"))` is the only Rust-side branch on a contract code in the whole tree. Comparing against the literal instead of the `TODAY_CONFLICT` constant defeats ERR-02 at exactly the site it protects: renaming the constant's value would fail `ipc_error_codes_are_stable` but leave this literal matching nothing, silently breaking the conflict-retry recovery path with no build error
- **Fix:** imported `TODAY_CONFLICT` from `crate::ipc_error`; changed the guard to `err.code == TODAY_CONFLICT`. The test assertion at web_actions.rs:1863 (`assert_eq!(stale.code, "today_conflict")`) is left as a literal by design, it is what makes a rename of the constant observable
- **Files modified:** src-tauri/src/web_actions.rs
- **Verification:** `cargo --offline test --lib web_actions`, `cargo --offline clippy --lib -- -D warnings`, `cargo --offline fmt -- --check`
- **Committed in:** `98f655b` (separate fix commit on top of task 1)
- **Note for 03-04:** `web_actions.rs:860` (`web_actions_import_top`'s retry-branch match guard) is the only Rust-side branch on a contract code in the tree (confirmed by grep across `src-tauri/src`). 03-04's ERR-02 rename drill must exercise this site too, not just the TypeScript union, or the drill only proves half the contract.

---

**Total deviations:** 5 (2x Rule 3, 2x Rule 1, 1 review-caught). All are compile-correctness or contract-integrity fixes made necessary by this plan's own signature changes rippling into callers PATTERNS.md/PLAN.md did not enumerate. No scope creep: no new functionality, no reworded user-visible text, no new suppression attributes.

## Issues Encountered

- **Full `cargo --offline test --lib` raced a concurrent unrelated session's `cargo test --workspace` on this shared machine** (a separate hwp-cli project checkout, PID 82928, running the entire time this plan executed). The first full-suite run failed 12 `outlook_mso::tests::*` cases with `m365_timeout: readiness probe exceeded its deadline`, a CPU-contention timeout, not a real regression: `outlook_mso.rs` is untouched by this plan's diff (`git diff --stat` confirms only the six files listed above changed), and this exact failure mode is already documented in STATE.md's Phase 1 decision log ("test-rust failed on 12 outlook_mso timeout tests racing a concurrent session's own cargo test --workspace process"). Verified unrelated by running the task-scoped test filters this plan's diff actually covers (`today`, `document`, `web_actions`, 167 tests, 100% pass) plus `cargo clippy --lib -- -D warnings` (clean) and `cargo fmt -- --check` (clean) independently of the full-suite run. A second full-suite run, started once the first returned, finished with the identical result (1205 passed, the same 12 outlook_mso cases failed, same "readiness probe exceeded its deadline" pattern), confirming the failure is stable and unrelated to this plan's diff rather than a one-off flake.

## Requirement Completion Note

ERR-01 is claimed by all three of 03-01, 03-02, and 03-03's frontmatter (a requirement spanning multiple plans, the same pattern Phase 1 hit with GATE-03). REQUIREMENTS.md is left with ERR-01 unmarked here: the requirement text says "a frontend caller can read" the code, and that is only true today for `evidence_binder_revision_conflict` (03-01's tracer). The other six codes this plan produced on the Rust side have no frontend caller reading `.code` yet; that lands in 03-03. Only ERR-04 (a pure Rust-side signature-count invariant, fully true as of this commit) is marked complete here.

## Next Phase Readiness

03-03 (frontend branch-site migration) is unblocked: all seven Rust commands in the branch-on set now emit `{ code, message }` on their conflict paths. 03-04's ERR-04 gate can check the measured `1128` against its `[B-20, B]` band directly from this SUMMARY without re-deriving it. The map_err-adapter pattern documented here (four instances: today_apply_plan_result, task_calendar_set_sync, update_frontmatter_field, web_actions.rs) is worth 03-04 checking exhaustively: any other caller of `today_mutate`/`task_transition`/`check_revision`/`load_context`/`assert_expected_revision` outside the seven-command set would need the same treatment, and this plan's own discovery process (build-error-driven, not a full call-graph audit) does not guarantee every such caller was found, though `cargo build --lib` succeeding is strong evidence none remain.

## Self-Check: PASSED

All six modified source files (today_store.rs, today_calendar.rs, today_lifecycle.rs, today_ai.rs, document.rs, web_actions.rs) confirmed present on disk. All commits (e603f69, eff3526, 4eb2716, 98f655b) confirmed present in git log.

---
*Phase: 03-typed-ipc-error-contract*
*Completed: 2026-08-23*
