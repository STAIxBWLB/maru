---
phase: 07-guardrails-before-churn
plan: 05
subsystem: ui
tags: [perf-06, document-views, inbox-removal, i18n, persisted-state, frontend]

requires:
  - phase: 07-guardrails-before-churn
    provides: 07-04's backend inbox index exclusion — the switcher Inbox view would otherwise be permanently empty
provides:
  - "BuiltInDocumentView narrowed to drafts/archive/recentlyUpdated, with BUILT_IN_DOCUMENT_VIEWS runtime valid-set and isBuiltInDocumentView guard exported from documentIndex.ts"
  - "pruneCustomDocumentFiltersInState extended to fail-open reset a persisted { kind: \"view\" } filter holding a removed built-in view to { kind: \"all\" }, silently, per visibility"
  - "Documents view switcher rendering exactly All -> Drafts -> Archive -> Recently Updated -> custom views, with the Inbox row, count, icon, and locale keys gone"
affects: [phase-07, perf-06, inbox-pane, document-index, i18n]

actuals:
  tokens: 2365
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "runtime valid-set constant beside a TS union: BUILT_IN_DOCUMENT_VIEWS backs the persisted-filter prune because the union type leaves no runtime trace"
    - "built-in view prune rides the existing pruneCustomDocumentFiltersInState pass: same changed flag, same copy-on-write, same per-visibility loop, no signature change to the publish wrapper"

key-files:
  created: []
  modified:
    - src/lib/documentIndex.ts
    - src/lib/documentIndex.test.ts
    - src/components/Sidebar.tsx
    - src/App.tsx
    - src/lib/workspaceStore.ts
    - src/lib/workspaceStore.test.ts
    - src/lib/outlinePaneStore.ts
    - src/lib/outlinePaneStore.test.ts
    - src/lib/i18n/locales/en.ts
    - src/lib/i18n/locales/ko.ts

key-decisions:
  - "outlinePaneStore.ts empty-slice viewCounts initializer and its two test fixtures retired in Task 1 (not Task 2 as the plan's file grouping suggested) because the narrowed union made them typecheck errors — the tracer gate could not go green otherwise"
  - "removed-view fixture in the new workspaceStore test uses an `as unknown as DocumentFilter` cast: the persisted JSON shape is exactly what the prune must tolerate, and the union type can no longer express it"

patterns-established:
  - "Persisted filters referencing a removed built-in view reset to All silently in the same load-time prune pass that already handles orphaned custom views — removals are normal operation, not user-facing events"

requirements-completed: [PERF-06]

coverage:
  - id: D1
    description: "Switcher composition after removal: exactly All -> Drafts -> Archive -> Recently Updated -> custom views; no Inbox row, icon, label, or count anywhere in the switcher (UI-SPEC E1)"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "grep sweeps: zero `view: \"inbox\"` / `Inbox` icon import in Sidebar.tsx; builtInViews memo has exactly three entries; pnpm typecheck + pnpm lint exit 0"
        status: pass
      - kind: unit
        ref: "src/lib/documentIndex.test.ts#filters built-in document views (pnpm test: 1975 passed)"
        status: pass
    human_judgment: true
    rationale: "The static-row/backstop visual checks (rows visible while counts settle, badge rendering at 0/1/many) are held-out UI-state items per the plan's flagged assumptions; the row-list composition itself is proven by the type-level Record<BuiltInDocumentView, number> agreement plus grep sweeps"
  - id: D2
    description: "builtInDocumentViewCounts carries exactly the three remaining built-in entries; no inbox key in the counts map or the union (UI-SPEC E2)"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "grep: zero `inbox:` in builtInDocumentViewCounts literal (App.tsx:1301-1311); union at documentIndex.ts:5 is exactly drafts/archive/recentlyUpdated; pnpm typecheck exit 0"
        status: pass
    human_judgment: false
  - id: D3
    description: "A persisted document filter { kind: \"view\", view: \"inbox\" } (or any built-in view outside the post-removal union) resets to { kind: \"all\" } at load, silently — no banner, toast, or first-run notice (UI-SPEC E3)"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "src/lib/workspaceStore.test.ts#pruneCustomDocumentFiltersInState resets persisted filters holding a removed built-in view (pnpm test: 1975 passed)"
        status: pass
    human_judgment: false
  - id: D4
    description: "sidebar.view.inbox removed from both en.ts and ko.ts in the same commit; i18n key parity holds"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "pnpm lint:i18n — 3738 keys in parity, no hardcoded UI strings"
        status: pass
    human_judgment: false
  - id: D5
    description: "Inbox pane, Files browser, and content search still resolve inbox paths: the removal stays inside the documents view switcher"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "full pnpm test 1975 passed / 0 failed (inbox-pane-adjacent frontend suites green); e2e/ grep: no spec drives the documents-switcher Inbox row (all hits are the app-mode pane, dashboard, or drafts fixtures)"
        status: pass
      - kind: e2e
        ref: "pnpm exec playwright test e2e/inbox*.spec.ts — phase gate, deferred to /gsd-verify-work per plan-level verification block"
        status: unknown
    human_judgment: true
    rationale: "The plan-level verification explicitly schedules the Inbox-pane Playwright regression watch at /gsd-verify-work time, not inside any task; the unit suites prove the switcher-side contract only"

duration: 6min
completed: 2026-09-05
status: complete
---

# Phase 7 Plan 5: Inbox View Removal from the Documents Switcher (Frontend PERF-06) Summary

**The built-in Inbox view is removed from the documents view switcher — narrowed `BuiltInDocumentView` union, deleted switcher row/icon/count, both locale keys gone, and a silent fail-open reset of any persisted filter still pointing at the removed view, all landing in the same load-time prune that already handles orphaned custom views.**

## Performance

- **Duration:** ~6 min
- **Started:** 2026-09-05T01:11:00Z
- **Completed:** 2026-09-05T01:17:29Z
- **Tasks:** 2
- **Files modified:** 10

## Accomplishments
- `BuiltInDocumentView` narrows to `drafts | archive | recentlyUpdated`; the `case "inbox"` arm of `matchesBuiltInView` is deleted with no fallback, deprecation shim, or runtime warning. `BUILT_IN_DOCUMENT_VIEWS` (switcher-order valid-set) and `isBuiltInDocumentView` are exported from `documentIndex.ts` for the persisted-filter prune.
- The switcher's `builtInViews` memo drops the Inbox row and the lucide `Inbox` import; `builtInDocumentViewCounts` in App.tsx drops the `inbox:` entry — the `Record<BuiltInDocumentView, number>` annotation self-updated, so counts map and union agree by construction.
- `pruneCustomDocumentFiltersInState` resets a persisted `{ kind: "view", view }` filter whose view is outside `BUILT_IN_DOCUMENT_VIEWS` to `{ kind: "all" }` per visibility — same pass, same `changed` flag, same copy-on-write as the existing custom-view prune, and no signature change to the `pruneCustomDocumentFilters` publish wrapper the MainApp load effect already calls.
- `sidebar.view.inbox` removed from both `en.ts` and `ko.ts` in the same commit; `pnpm lint:i18n` reports 3738 keys in parity.

## Task Commits

Each task was committed atomically:

1. **Task 1 (tracer): Remove the Inbox view from the union, switcher, and counts** - `b5361c5` (feat)
2. **Task 2: Persisted-filter fail-open reset, i18n key removal** - `424e87e` (feat)

**Plan metadata:** see final docs commit below.

## Files Created/Modified
- `src/lib/documentIndex.ts` - narrowed union, deleted inbox arm, new `BUILT_IN_DOCUMENT_VIEWS` + `isBuiltInDocumentView`
- `src/lib/documentIndex.test.ts` - inbox fixture/assertion retired, surviving-view assertions re-indexed
- `src/components/Sidebar.tsx` - Inbox row and icon import removed; three rows remain in order
- `src/App.tsx` - `inbox:` count entry removed from `builtInDocumentViewCounts`
- `src/lib/workspaceStore.ts` - built-in view prune arm added to `pruneCustomDocumentFiltersInState`
- `src/lib/workspaceStore.test.ts` - new case pinning the persisted removed-view reset (removed reset, surviving untouched, idempotent)
- `src/lib/outlinePaneStore.ts` - empty-slice `viewCounts` initializer loses the inbox key
- `src/lib/outlinePaneStore.test.ts` - two `documentFilter` fixtures repointed at `drafts`
- `src/lib/i18n/locales/en.ts`, `ko.ts` - `sidebar.view.inbox` removed (same commit)

## Decisions Made
- Retired the `outlinePaneStore.ts` empty-slice inbox key and the two `outlinePaneStore.test.ts` fixtures inside Task 1 rather than Task 2 as the plan's file grouping suggested: the narrowed union turned them into `tsc` errors immediately, so the tracer's `pnpm typecheck` gate could not go green without them. The change is the plan's own prescribed edit, only its commit slot moved.
- The new workspaceStore test's removed-view fixture uses `as unknown as DocumentFilter` — the persisted pre-upgrade JSON shape is precisely what the prune must tolerate, and the narrowed union can no longer express it in the type system.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] outlinePaneStore edits moved from Task 2 into Task 1**
- **Found during:** Task 1 verify (`pnpm typecheck`)
- **Issue:** `outlinePaneStore.ts:113` (`viewCounts` empty-slice initializer) and `outlinePaneStore.test.ts:168,176` reference the inbox built-in view; the narrowed union made them TS2322/TS2353 errors, blocking the tracer's typecheck acceptance criterion.
- **Fix:** Applied the plan's prescribed edits (delete the `inbox` key from the empty-slice record; repoint both fixtures at `drafts`) inside the Task 1 commit.
- **Files modified:** src/lib/outlinePaneStore.ts, src/lib/outlinePaneStore.test.ts
- **Verification:** `pnpm typecheck` exit 0; outlinePaneStore suite green in full `pnpm test`
- **Committed in:** `b5361c5` (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (Rule 3, task-boundary move — no edits beyond the plan's own prescribed changes)
**Impact on plan:** None on behavior; Task 2's remaining work (prune extension, new test, locale keys) landed exactly as written.

## TDD Gate Compliance

- This plan is `type: execute`, not `type: tdd`; no RED/GREEN gate applies. Task 1 is a `type="tracer"` task: its `<verify>` (typecheck, `pnpm test -- documentIndex`, `pnpm lint`) was re-run end-to-end green after the commit per the #3299 row-3 tracer feedback gate (interactive run, `human_verify_mode` end-of-phase, automated-only verify — no checkpoint synthesized) before Task 2 expansion.

## Issues Encountered
- None beyond the deviation above.

## e2e/ Regression Surface Note
The Task 1 action's e2e grep came up empty for the documents-switcher Inbox row: `e2e/inbox*.spec.ts`, `smoke.spec.ts`, and `workbench-layout.spec.ts` hits all target the standalone Inbox pane (app mode), which the plan keeps; `dashboard.spec.ts` and `drafts.spec.ts` hits are dashboard cards and draft fixtures. No e2e spec was updated.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Frontend half of PERF-06 is live: the switcher renders exactly All -> Drafts -> Archive -> Recently Updated -> custom views, and a pre-upgrade persisted inbox filter lands silently on All.
- With 07-04's backend exclusion, PERF-06 is now complete end-to-end; the shared-ID gate (#2388) clears once this SUMMARY exists.
- Phase gate deferred to `/gsd-verify-work` per the plan: `pnpm exec playwright test e2e/inbox*.spec.ts` must prove the standalone Inbox pane still lists pending/drop items after the switcher removal (recorded as coverage D5, status unknown until that run).

## Self-Check: PASSED
- All 10 key-files exist on disk: FOUND
- Commits `b5361c5` / `424e87e` present in `git log`: FOUND
- Plan-level verification re-run after both tasks: `pnpm typecheck` exit 0; `pnpm lint` exit 0; `pnpm lint:i18n` exit 0 (3738 keys parity); full `pnpm test` 1975 passed / 0 failed
- Zero-reference sweep: no `view: "inbox"` / `case "inbox"` / `sidebar.view.inbox` anywhere in src/ except the intentional persisted-state fixture in the new workspaceStore test; `App.tsx:6055 case "inbox"` is the unrelated app-mode switch
- Silent-reset contract: the prune diff adds no toast/banner/log call (asserted by review of the `424e87e` diff)

---
*Phase: 07-guardrails-before-churn*
*Completed: 2026-09-05*
