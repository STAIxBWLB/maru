---
phase: 09-durability-and-session-lifecycle
plan: 05
subsystem: durability
tags: [react, debounce, autosave, teardown, scratchpad]

# Dependency graph
requires:
  - phase: 09-durability-and-session-lifecycle
    provides: "src/lib/debouncedSave.ts baseline (schedule/flush/cancel, SaveQueue) from earlier phases"
provides:
  - "SettlingDebouncedSaver<T>.flushSettled() reporting clean/saved/failed, with retry-preserving failure semantics"
  - "src/lib/teardownSave.ts useTeardownFlush() hook + module-private mounted-saver registry for a later quit-flush walk"
  - "Scratchpad memo autosave converted onto the shared debounced-save helper; unmount performs the pending save instead of cancelling it"
affects: ["09-06 (toast + recovery copy)", "09-07 (other autosave surfaces: Studio, TodayBrainDump, MeetingSourceWorkbench)", "09-08 (quit-time flush walking the teardownSave registry)"]

# Actuals (#2632)
actuals:
  tokens: 5131
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "SettlingDebouncedSaver<T>: a superset of DebouncedSaver<T> that adds flushSettled() reporting {clean|saved|failed} instead of silently resolving"
    - "useTeardownFlush(saver, describe, t): registers a mounted saver in a module-private Set; unmount/saver-swap settles (never just cancels) and logs one console.error line on failure, never the content"
    - "ref-indirection for a stable per-mount saver: flushCurrentRef/lastSaveErrorRef let a lazily-created saver call the latest flushCurrent without recreating the saver every render"

key-files:
  created:
    - src/lib/teardownSave.ts
    - src/lib/teardownSave.test.ts
  modified:
    - src/lib/debouncedSave.ts
    - src/lib/debouncedSave.test.ts
    - src/components/ScratchpadPane.tsx
    - src/components/ScratchpadPane.test.tsx

key-decisions:
  - "flushSettled() tracks the most recently started drain's settlement (activeSettlement) so a call that finds nothing newly pending still awaits an already in-flight save instead of reporting a false 'clean', needed because ScratchpadPane's teardown is the only path that observes save failures in this plan (onError wiring to the toast lands in 09-06)."
  - "On a rejected save, the failed value is re-stored as pending only when nothing newer was scheduled while it was in flight; the timer is never re-armed on failure. Retries only happen via an explicit schedule() or flush(), so a broken disk cannot spin on its own."
  - "ScratchpadPane's saver is created once via a lazy useState initializer and stays stable across the pane's lifetime, including workPath changes (a prop change, not an unmount); this is what keeps the workspace-switch no-cross-save test passing unchanged."

patterns-established:
  - "Teardown-settle over cancel-only: any future debounced-save surface conversion (Studio, TodayBrainDump, MeetingSourceWorkbench in 09-07) wires through useTeardownFlush the same way Scratchpad does here."

requirements-completed: [REL-02, REL-03]

coverage:
  - id: D1
    description: "A Scratchpad memo edit made just before the pane closes is written to its file: unmounting performs the pending save instead of cancelling it."
    requirement: "REL-02"
    verification:
      - kind: unit
        ref: "src/components/ScratchpadPane.test.tsx#saves a memo edit made just before the pane closes"
        status: pass
    human_judgment: false
  - id: D2
    description: "The shared debounced saver reports clean/saved/failed via flushSettled(), retains a failed value for the next flush unless a newer value was scheduled meanwhile, never re-arms the timer on failure, and never double-saves or races an in-flight save against a newly-pending one."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/debouncedSave.test.ts#createDebouncedSaver settlement (6 cases)"
        status: pass
    human_judgment: false
  - id: D3
    description: "useTeardownFlush settles exactly once per unmount or saver swap and writes a single console.error line naming the file and reason on failure, never the content; a describe() returning null writes nothing."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts (4 cases)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Switching the Scratchpad to another workspace while mounted still does not cross-save; the localStorage mirror keeps the draft recoverable. The pre-existing regression test is unaffected by the conversion."
    verification:
      - kind: unit
        ref: "src/components/ScratchpadPane.test.tsx#keeps a workspace-scoped draft across a switch without cross-saving"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-09-25
status: complete
---

# Phase 9 Plan 5: Scratchpad autosave on the shared debounced-save helper, with a settle-on-teardown hook Summary

**Scratchpad's memo autosave now runs on `createDebouncedSaver`, unmount performs the pending save via a new `useTeardownFlush` hook instead of only cancelling it, and the saver reports clean/saved/failed with retry-preserving failure semantics.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-09-25T22:18:59Z
- **Completed:** 2026-09-25T22:34:00Z
- **Tasks:** 2 completed
- **Files modified:** 6 (2 created, 4 modified)

## Accomplishments

- `src/lib/debouncedSave.ts`: added `SaveSettlement<T>` and `SettlingDebouncedSaver<T>`; `createDebouncedSaver` now returns the settling variant with `flushSettled()`, plus retry-preserving failure (a rejected save's value stays pending unless a newer value was scheduled while it was in flight, and the timer is never re-armed on failure). `createContextualDebouncedSaver` is untouched (verified via `git diff`).
- `src/lib/teardownSave.ts` (new): `useTeardownFlush(saver, describe, t)` registers a mounted saver in a module-private registry and settles it (via `flushSettled()`) on unmount or saver swap, logging `[save] teardown save failed for <filePath>: <reason>` on failure and never logging content.
- `src/components/ScratchpadPane.tsx`: the hand-rolled 700ms `autoSaveTimerRef`/`clearAutoSaveTimer` timer is gone. A single stable saver (lazy `useState`) now owns the debounce; `scheduleAutoSave` calls `saver.schedule(workPath)`, the workPath-change effect calls `saver.cancel()` (preserving the no-cross-save behavior), and the cancel-only unmount effect is replaced by `useTeardownFlush`.
- New test: unmounting the pane inside the 700ms debounce window now asserts exactly one save call with the typed content, for the memo's path.

## Task Commits

1. **Task 1: A Scratchpad memo edit made just before the pane closes is saved, through the shared saver and the teardown hook** - `b05d58d1` (feat)
2. **Task 2: Harden the saver and hook contracts (TDD)** - `d81a850d` (test, RED) then `3504efa1` (feat, GREEN)

_No REFACTOR commit; the GREEN implementation needed no follow-up cleanup._

## Files Created/Modified

- `src/lib/teardownSave.ts` - `useTeardownFlush` hook, module-private mounted-saver registry, `settleTeardownSave`
- `src/lib/teardownSave.test.ts` - hook probe-component tests (exactly-once settle, saver swap, log line contents, null-describe no-op)
- `src/lib/debouncedSave.ts` - `SaveSettlement<T>`, `SettlingDebouncedSaver<T>`, `flushSettled()`, retention-on-failure
- `src/lib/debouncedSave.test.ts` - settlement behavior tests (clean/saved/failed, retention, idempotent/ordered flush)
- `src/components/ScratchpadPane.tsx` - saver conversion, teardown hook wiring
- `src/components/ScratchpadPane.test.tsx` - new unmount-saves-pending-edit test

## Decisions Made

- `flushSettled()` tracks the last drain's settlement (`activeSettlement`) so a call finding nothing newly pending still awaits an already in-flight save rather than reporting a false "clean"; this is the only path that currently observes teardown save failures (the toast wiring via `onError` lands in plan 09-06).
- Retention-on-failure re-stores the failed value as pending only if nothing newer was scheduled during the in-flight window, and never re-arms the timer itself (retries happen only via an explicit `schedule()`/`flush()`), per the plan's D-05 groundwork.
- The Scratchpad's saver is created once per mount and survives `workPath` prop changes (a re-render, not an unmount); this is what keeps the existing workspace-switch no-cross-save test passing unchanged.

## Deviations from Plan

None - plan executed exactly as written. Task 1's `drainSettled`/`activeSettlement` design already satisfied the ordering/idempotency edge cases the plan called out under Task 1's own acceptance criteria (calling flush twice with one pending value performs exactly one save; unmounting while an earlier save is in flight saves the pending value after it completes, in order); Task 2's genuinely new work was the retry-preserving-failure semantics, confirmed via the RED-to-GREEN cycle (`d81a850d` then `3504efa1`).

## TDD Gate Compliance

Task 2 (`tdd="true"`) followed RED then GREEN:
- RED: `d81a850d` `test(09-05): add failing test for saver retention-on-failure and hook settle behavior`. Of the new behavior tests, only "flushSettled resolves failed and retains the value for the next flush" failed pre-implementation (expected `save` called twice, got once); the rest already held given Task 1's design and were confirmed passing intentionally, not skipped.
- GREEN: `3504efa1` `feat(09-05): retain a failed save's value for the next flush`; all 20 `debouncedSave.test.ts` cases and all 4 `teardownSave.test.ts` cases pass.
- No REFACTOR commit was needed.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run src/lib/debouncedSave.test.ts src/lib/teardownSave.test.ts src/components/ScratchpadPane.test.tsx`: 34 tests pass (10 pre-existing + 6 new in `debouncedSave.test.ts`, 4 new in `teardownSave.test.ts`, 9 pre-existing + 1 new in `ScratchpadPane.test.tsx`).
- `pnpm typecheck`: clean.
- `pnpm lint` (`--max-warnings 0`): clean.
- `make verify`: full gate passed. typecheck, lint, icons/i18n/select-chrome/dom-sanitizer/type-token guards, `vitest run src scripts` (229 files / 2198 tests passed), Rust `cargo test` (1800 passed, 0 failed, 3 ignored), `cargo fmt --check`, `cargo clippy -- -D warnings` (clean), `pnpm build:frontend` (bundle-budget, native-e2e-isolation, csp-blob, mode-css-ownership all pass), `check-command-isolation` (382/382, PASS all).

## Next Phase Readiness

- `src/lib/teardownSave.ts` and the hardened `flushSettled()` contract are ready for plan 09-07 to convert Studio, TodayBrainDump, and MeetingSourceWorkbench onto the same pattern.
- The module-private `teardownSaves` registry inside `teardownSave.ts` is in place but not yet walked by anything; plan 09-08's quit-time flush needs to add the "walk the registry" export when it lands.
- The `onError` callback on Scratchpad's saver is not yet wired to the global toast (`errorStore.setError`); that wiring, plus the recovery-copy write, is explicitly plan 09-06's scope per the plan's `flagged_assumptions` note.
- No blockers for 09-06/09-07/09-08.

## Self-Check: PASSED

- All key files found on disk: `src/lib/teardownSave.ts`, `src/lib/teardownSave.test.ts`, `src/lib/debouncedSave.ts`, `src/lib/debouncedSave.test.ts`, `src/components/ScratchpadPane.tsx`, `src/components/ScratchpadPane.test.tsx`.
- All commit hashes found in `git log`: `b05d58d1`, `d81a850d`, `3504efa1`.
- Task 1 acceptance criteria re-verified via grep: `useTeardownFlush(` count 1, `createDebouncedSaver` count 2, `autoSaveTimerRef` count 0, `from "../components` in `teardownSave.ts` count 0.
- Task 2 acceptance criteria re-verified: `flushSettled` count 3 in `debouncedSave.ts`; `git diff` shows no change inside `createContextualDebouncedSaver`.
- Plan-level `<verification>` re-run: `pnpm exec vitest run src/lib/debouncedSave.test.ts src/lib/teardownSave.test.ts src/components/ScratchpadPane.test.tsx` (34 passed), `pnpm typecheck` (clean), `pnpm lint` (clean).
- `make verify` re-run in full: PASSED (TS 2198 tests, Rust 1800 tests, fmt/clippy/build/command-isolation all clean).

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-25*
