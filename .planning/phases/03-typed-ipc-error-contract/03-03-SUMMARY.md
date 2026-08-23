---
phase: 03-typed-ipc-error-contract
plan: "03"
subsystem: ipc
tags: [typescript, ipc, error-contract, today, diagram, e2e]

requires:
  - phase: 03-typed-ipc-error-contract
    provides: "03-01's IpcError class, normalizeIpcError funnel entry, and IpcErrorCode union (src/lib/ipcError.ts, src/lib/types.ts); 03-02's seven Rust commands emitting typed IpcError on their conflict paths"
provides:
  - "todayInvoke (src/lib/today.ts) and saveDocument (src/lib/api.ts) normalize every rejection through normalizeIpcError, on both their e2e-override and real-invoke branches"
  - "isTodayConflict, isTaskConflict, reportInsert's isConflict, and TodayReview's saveReflection catch all branch on `err instanceof IpcError && err.code === '<literal>'`, joining EvidenceBinderPane's tracer branch as the five sites that complete D-04's four-code contract"
  - "todayErrorCode deleted (D-08); zero remaining references in src/ or e2e/"
  - "e2e/helpers/todayFixtures.ts's three today_conflict throw sites and e2e/smoke.spec.ts's save_document mock throw the raw wire shape (prefix-free message + separate code field, per D-02) instead of the retired prefix string"
affects: [03-typed-ipc-error-contract (03-04 gates: ERR-02 rename drill, ERR-04 count re-check)]

actuals:
  tokens: 3789
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Frontend invoke funnel normalization: wrap the WHOLE function body (both the e2e-override branch and the real invoke branch) in try/catch, rethrow normalizeIpcError(err) - so a Playwright fixture throw and a real Tauri rejection reach every branch site through the identical shape"
    - "e2e fixtures throw the raw wire shape (Object.assign(new Error(prefixFreeMessage), { code }))  - the funnel's whole-body normalizer is what re-attaches the 'code: ' prefix exactly once, matching what migrated Rust actually sends over the bridge"
    - "TS-side rename safety rides the type checker, not an imported constant: err.code is typed IpcErrorCode (a union), so `err.code === \"literal\"` fails tsc -b (TS2367, no overlap) the moment a code is renamed in the union - verified empirically this plan, see Deviations"

key-files:
  created: []
  modified:
    - src/lib/today.ts
    - src/lib/today.test.ts
    - src/components/today/TodayReview.tsx
    - src/components/today/TodayExecute.test.tsx
    - src/lib/api.ts
    - src/lib/diagram/reportInsert.ts
    - src/lib/diagram/reportInsert.test.ts
    - e2e/helpers/todayFixtures.ts
    - e2e/smoke.spec.ts

key-decisions:
  - "All three today_conflict throw sites in todayFixtures.ts were migrated (today_mutate's expectedRevision guard, today_mutate's setPlan inputRevision guard, and today_finalize_setup's guard), not just the two the plan's action text named by line number. The behavior clause required every fixture throw to carry the raw wire shape, and a third guard existed inside the same today_mutate handler the plan already named - leaving it as a prefix string would mean todayInvoke's normalizer double-prefixes an already-migrated command's third code path."
  - "ERR-01 and ERR-03 marked complete in REQUIREMENTS.md, not on frontmatter alone. Verified: ERR-01's text (\"a frontend caller can read\" the code) is now true for all four contract codes - evidence_binder_revision_conflict (03-01), today_conflict/task_conflict (today.ts, this plan), document_conflict (TodayReview.tsx + reportInsert.ts, this plan). ERR-03's residual-matcher grep over src/ returns zero. ERR-02 is NOT marked - this plan's frontmatter never claimed it, and the formal two-sided rename drill (Rust const test + TS union) is 03-04's job; this plan's Deviations section records a one-sided empirical check on the TS half only."

patterns-established:
  - "Literal string comparison against a typed IpcErrorCode union IS the TS-side rename gate (no separate imported constant needed, unlike the Rust side's pub const values) - confirmed by deliberately breaking one comparison and watching tsc -b fail with TS2367, then reverting"

requirements-completed: [ERR-01, ERR-03]

coverage:
  - id: D1
    description: "todayInvoke and saveDocument normalize every rejection (both e2e-override and real-invoke branches) through normalizeIpcError before any branch site sees it"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "src/lib/today.test.ts (conflict helpers describe, 2 tests)"
        status: pass
      - kind: e2e
        ref: 'e2e/smoke.spec.ts:1261 "keeps a Files draft intact when revision-checked save conflicts"'
        status: pass
    human_judgment: false
  - id: D2
    description: "isTodayConflict, isTaskConflict, reportInsert's isConflict, and TodayReview's saveReflection catch all branch on err.code via IpcError instead of a message substring; todayErrorCode deleted with zero remaining references"
    requirement: ERR-03
    verification:
      - kind: unit
        ref: "src/lib/today.test.ts, src/lib/diagram/reportInsert.test.ts, src/components/today/TodayExecute.test.tsx (53 tests total across the 4 touched vitest files)"
        status: pass
      - kind: other
        ref: 'grep -rnE ''\.includes\("(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)"'' src/ | wc -l -> 0; grep -rn "todayErrorCode" src/ e2e/ | wc -l -> 0'
        status: pass
    human_judgment: false
  - id: D3
    description: "ERR-04 invariant held: this plan's diff touches only src/ and e2e/, zero Rust signature changes, so the post-migration count stays at 03-02's measured 1128"
    requirement: ERR-04
    verification:
      - kind: other
        ref: "git diff --stat (this plan's 2 commits) - src-tauri/ absent from the file list"
        status: pass
    human_judgment: false

duration: ~15min
completed: 2026-08-23
status: complete
---

# Phase 3 Plan 03: Frontend IPC Error Branch-Site Migration Summary

**All five frontend branch sites now read `err.code` off a typed `IpcError` instead of parsing a message prefix, `todayErrorCode` is deleted, and both remaining invoke funnels (`todayInvoke`, `saveDocument`) normalize every rejection through the same `normalizeIpcError` entry point 03-01 built.**

## Performance

- **Tasks:** 2 completed
- **Files modified:** 9
- **Duration:** ~15min

## Accomplishments

- `todayInvoke` (`src/lib/today.ts`) wraps its entire body - the e2e-override branch and the real `invoke` branch - in try/catch, rethrowing `normalizeIpcError(err)`, so a Playwright fixture throw and a real Tauri rejection reach `isTodayConflict`/`isTaskConflict` through the identical shape.
- `isTodayConflict` and `isTaskConflict` now read `err instanceof IpcError && err.code === "today_conflict" / "task_conflict"`. `todayErrorCode`, the prefix parser these two and `TodayReview.tsx` used, is deleted (D-08); `grep -rn "todayErrorCode" src/ e2e/` returns zero.
- `TodayReview.tsx`'s `saveReflection` catch branches on `err instanceof IpcError && err.code === "document_conflict"` directly, no longer importing the retired parser.
- `saveDocument` (`src/lib/api.ts`) gets the same whole-body normalization treatment as `todayInvoke`, covering both its `!isTauri()` override branch (what Playwright exercises) and the real `invoke` branch.
- `reportInsert.ts`'s `isConflict` now takes the caught error object (`err: unknown`) instead of a message string, checking `err instanceof IpcError && err.code === "document_conflict"`; its one caller inside `insertDiagramIntoReport` passes the raw error.
- `e2e/helpers/todayFixtures.ts`'s three `today_conflict` throw sites (both inline guards in `today_mutate`, plus `today_finalize_setup`'s guard) and `e2e/smoke.spec.ts`'s `save_document` mock now throw `Object.assign(new Error(prefixFreeMessage), { code })` - the raw wire shape migrated Rust actually sends - instead of a pre-formatted prefix string. `todayInvoke`/`saveDocument`'s normalizer re-attaches the prefix exactly once on the way to the branch sites, keeping the smoke.spec alert text (`document_conflict: revision changed`) byte-identical.

## Task Commits

1. **Task 1: today funnel normalization, typed conflict helpers, and todayErrorCode retirement (D-08)** - `81a4bb0` (feat)
2. **Task 2: save_document funnel, reportInsert branch, and e2e mock-layer alignment** - `6805b26` (feat)

## Files Created/Modified

- `src/lib/today.ts` - `todayInvoke` whole-body normalization; `isTodayConflict`/`isTaskConflict` rewritten to `err.code ===`; `todayErrorCode` deleted
- `src/lib/today.test.ts` - `todayErrorCode` describe deleted; conflict-helper describes rewritten to construct `IpcError` instances and assert legacy strings/plain Errors/null/undefined all return false
- `src/components/today/TodayReview.tsx` - `saveReflection` catch branches on `err instanceof IpcError && err.code === "document_conflict"`; retired-parser import removed
- `src/components/today/TodayExecute.test.tsx` - conflict-mock rejection changed from a raw prefix string to a real `IpcError` instance
- `src/lib/api.ts` - `saveDocument` whole-body normalization (override + invoke branches)
- `src/lib/diagram/reportInsert.ts` - `isConflict` takes `err: unknown`, checks `err.code ===`; caller passes the raw error
- `src/lib/diagram/reportInsert.test.ts` - conflict mock rejects with a real `IpcError` instance
- `e2e/helpers/todayFixtures.ts` - three `today_conflict` throw sites converted to the raw wire shape
- `e2e/smoke.spec.ts` - `save_document` mock throw converted to the raw wire shape

## Decisions Made

- **Migrated all three `today_conflict` fixture throw sites, not the two the plan's action text named by line number.** `today_mutate`'s handler has two inline conflict guards (expected-revision and setPlan input-revision); the plan's read_first/action blocks focused on the first and on `today_finalize_setup`'s guard, but the second inline guard is inside the same function already being touched and the behavior clause ("the conflict throws use the raw wire shape") applies to it equally. Left as a prefix string, it would still work today (normalizeIpcError is a pass-through for shapeless rejections's message text) but would silently defeat the one-normalization-point invariant this plan establishes elsewhere.
- **ERR-01 and ERR-03 marked complete in REQUIREMENTS.md, verified rather than taken from frontmatter.** ERR-01's text ("a frontend caller can read" the code) is now true for all four contract codes - the fourth (`document_conflict`) gained its second and third frontend readers this plan (`TodayReview.tsx`, `reportInsert.ts`), joining `evidence_binder_revision_conflict` from 03-01. ERR-03's residual-matcher grep over `src/` returns zero. ERR-02 was intentionally left unmarked: this plan's frontmatter never claimed it, and the formal two-sided (Rust const test + TS union) rename drill belongs to 03-04 - see Deviations for a one-sided TS-only empirical check done here as a sanity check, not a substitute for that drill.

## Deviations from Plan

None requiring a rule - both tasks executed as specified, with the one scope-completion note above (all three fixture throw sites vs. two named by line number, same behavior clause, same files list).

### Verification note (not a deviation - empirical confirmation of the plan's rename-safety claim)

The carried-forward wave-2 note warned against inline string-literal branch comparisons, citing 03-02's Rust-side defect (`err.code == "today_conflict"` as a raw `String` comparison, invisible to the Rust compiler on rename). On the TypeScript side this plan's branch sites ARE literal comparisons (`err.code === "today_conflict"`), exactly as PATTERNS.md's retired-helper pattern and this plan's own acceptance criteria (`err instanceof IpcError && err.code ===`) prescribe - there is no separate exported single-value constant on the TS side analogous to Rust's `pub const TODAY_CONFLICT`, D-03 instead ties rename-safety to the `IpcErrorCode` union in `src/lib/types.ts`. To confirm this actually protects against a silent rename before marking ERR-01/ERR-03 complete, one literal (`today.ts`'s `"today_conflict"` in `isTodayConflict`) was temporarily changed to `"today_conflict_typo"`: `pnpm typecheck` failed with `TS2367: This comparison appears to be unintentional because the types '...' and '"today_conflict_typo"' have no overlap`. The file was reverted immediately after; `git status --short` confirmed a clean tree before continuing. This is a one-sided check (TS only, not the Rust const test) and does not substitute for 03-04's formal two-sided rename drill.

## Issues Encountered

None.

## Requirement Completion Note

ERR-01 and ERR-03 marked complete (see Decisions Made above for the verification basis, not frontmatter alone). ERR-04 stays at 03-02's measured value (1128) - this plan's two commits touch only `src/` and `e2e/`, confirmed via `git diff --stat`, with zero `src-tauri/` files in either commit.

## Next Phase Readiness

03-04 is unblocked. It inherits: the ERR-04 count unchanged at 1128 (03-02's baseline, untouched by this plan); ERR-01 and ERR-03 now complete; ERR-02 still open, needing the formal two-sided rename drill (this plan's Deviations section did a one-sided TS-only sanity check that is evidence, not a substitute). `web_actions.rs:860` (noted in 03-02's SUMMARY) remains the one Rust-side branch on a contract code in the tree and should be part of that drill alongside the TypeScript union.

## Self-Check: PASSED

All nine modified files confirmed present on disk with the expected content. Both commits (`81a4bb0`, `6805b26`) confirmed present in `git log`.

---
*Phase: 03-typed-ipc-error-contract*
*Completed: 2026-08-23*
