---
phase: 09-durability-and-session-lifecycle
plan: 06
subsystem: durability
tags: [react, errorStore, teardown, recovery, toast, i18n]

requires:
  - phase: 09-durability-and-session-lifecycle
    provides: "write_recovery_copy IPC + writeRecoveryCopy wrapper (09-04); SettlingDebouncedSaver/flushSettled and useTeardownFlush (09-05); all in-scope autosave surfaces converted onto useTeardownFlush (09-07)"
provides:
  - "reportTeardownSaveFailure(target, error, t) in src/lib/teardownSave.ts: writes a recovery copy, publishes an OperationNotice, logs one line, and clears a matching single-slot error toast"
  - "OperationNotice.recovery?: { workPath, path } in src/lib/errorStore.ts"
  - "src/components/OperationNoticeToast.tsx: the operation-notice toast extracted from App.tsx, with an Open recovery copy action"
  - "save.teardown.failed / failedNoCopy / openCopy i18n keys (en/ko)"
affects: ["09-08 (quit-time flush reuses reportTeardownSaveFailure for the same visibility on the quit path)"]

# Actuals (#2632)
actuals:
  tokens: 6657
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "reportTeardownSaveFailure is the single choke point every teardown-save failure (unmount today, app quit in 09-08) routes through: recovery copy -> toast -> log -> single-slot dedupe, in that order, with the unsaved content never touching the message or the log."
    - "OperationNoticeToast extracted from App.tsx's inline block (step 9's pattern for MainApp extraction), preserving the exact markup, classes, role=status, and data-skill-operation attribute e2e selectors depend on."

key-files:
  created:
    - src/components/OperationNoticeToast.tsx
    - src/components/OperationNoticeToast.test.tsx
  modified:
    - src/lib/teardownSave.ts
    - src/lib/teardownSave.test.ts
    - src/lib/errorStore.ts
    - src/lib/i18n/locales/en.ts
    - src/lib/i18n/locales/ko.ts
    - src/components/ScratchpadPane.test.tsx
    - src/App.tsx

key-decisions:
  - "reportTeardownSaveFailure derives `reason` the same way ScratchpadPane's own flushCurrent().catch() already did (error instanceof Error ? error.message : String(error)), so the setError((current) => current === reason ? null : current) dedupe actually matches the single-slot toast a surface raised for the same failure, closing the idempotency edge probe without new plumbing."
  - "The Open recovery copy button's click handler chains .catch(setError).finally(dismiss): a resolved openInFileManager dismisses immediately, a rejected one raises the global error toast with its message and still dismisses (matching the plan's 'always dismisses' requirement without a separate try/finally block)."
  - "ScratchpadPane.test.tsx's identity-style `t` mock (returns the key verbatim) cannot exercise real {file}/{reason} interpolation, so it gained a small local `templates` lookup for exactly the two new save.teardown.* keys; every other key's behavior (return-the-key) is unchanged, so none of the file's other 14 assertions on raw key text were affected."
  - "teardownSave.test.ts gained a file-level afterEach that drains the whole operation-notice queue (not just dismissing one), because unmount tests in the sibling useTeardownFlush describe block now also route through reportTeardownSaveFailure and leave notices in the same module-level queue reportTeardownSaveFailure's own tests read from; a single-notice dismiss left a stale notice at the head of the queue and produced a cross-test false pass (caught by running the new test in isolation vs. the full file)."

patterns-established:
  - "Any future teardown-failure caller (09-08's quit flush) reports through reportTeardownSaveFailure exactly like unmount does; no new toast/log/recovery logic to duplicate."

requirements-completed: []

coverage:
  - id: D1
    description: "A failed teardown save keeps the edit as a real recovery file under .maru/recovery/ and raises a toast naming the file and the reason (D-07, D-08)."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/components/ScratchpadPane.test.tsx#keeps a recovery copy and raises a toast when a close-time save fails"
        status: pass
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#publishes the failed message with a recovery path when the copy succeeds, and never leaks content"
        status: pass
    human_judgment: false
  - id: D2
    description: "If the recovery write itself fails, the toast still names the file and reason (without an open action) and the log line carries both reasons; the failure is never silent."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#publishes the failedNoCopy message and logs both reasons when the recovery copy also fails"
        status: pass
    human_judgment: false
  - id: D3
    description: "One failed teardown save produces exactly one toast, and clears the single-slot error toast only when it holds this same reason (idempotency edge probe, resolved explicit)."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#clears the single-slot error toast only when it holds this same reason"
        status: pass
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#leaves the single-slot error toast untouched when it holds a different message"
        status: pass
    human_judgment: false
  - id: D4
    description: "Two teardown saves failing at the same time produce two queued toasts and two distinct recovery files; dismissing one shows the other (concurrency edge probe, resolved explicit)."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#two concurrent failures publish two distinct notices, dismissing the first exposes the second, and each gets its own recovery write"
        status: pass
    human_judgment: false
  - id: D5
    description: "The toast offers Open recovery copy only when a recovery exists; clicking it opens the file via open_in_file_manager and dismisses the toast; a rejection routes to the global error toast and still dismisses."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/components/OperationNoticeToast.test.tsx (5 cases)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Neither the toast message nor the log line ever contains the unsaved content."
    requirement: "REL-03"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts (content-leak assertions across the failed/failedNoCopy/concurrent cases)"
        status: pass
    human_judgment: false
  - id: D7
    description: "The extracted OperationNoticeToast preserves App.tsx's exact toast markup, classes, role=status, and data-skill-operation attribute that existing e2e selectors depend on."
    verification:
      - kind: e2e
        ref: "make test-e2e (250 passed, incl. Skills operation-toast flows)"
        status: pass
    human_judgment: false

duration: ~28min
completed: 2026-09-26
status: complete
---

# Phase 9 Plan 6: Teardown save failure visibility Summary

**A failed teardown save now keeps the edit as a real `.maru/recovery/` file and raises a dismissible toast (with an Open recovery copy action) naming the file and reason, deduping against any single-slot toast the same failure already raised.**

## Performance

- **Duration:** ~28 min
- **Started:** 2026-09-26T09:01:00+09:00 (approx.)
- **Completed:** 2026-09-26T09:29:00+09:00
- **Tasks:** 2 completed
- **Files modified:** 9 (2 created, 7 modified)

## Accomplishments

- `src/lib/teardownSave.ts`: new exported `reportTeardownSaveFailure(target, error, t)`:
  writes a recovery copy via `writeRecoveryCopy` (09-04's IPC wrapper), publishes one
  `OperationNotice` (`save.teardown.failed` with `recovery` when the copy succeeds,
  `save.teardown.failedNoCopy` without it when the copy also fails), logs exactly one
  `[save] teardown save failed for <file>: <reason>; kept <path>` (or
  `...; recovery copy failed: <reason>`) line, and clears the single-slot error toast
  only when it holds this same failure's reason. `settleTeardownSave` now routes every
  failed settlement through this reporter instead of only logging.
- `src/lib/errorStore.ts`: `OperationNotice` gains an optional
  `recovery?: { workPath: string; path: string }` field.
- `src/components/OperationNoticeToast.tsx` (new): the operation-notice toast moved out
  of `App.tsx` verbatim (same classes, `role="status"`, `data-skill-operation`), with a
  new "Open recovery copy" button rendered only when `notice.recovery` is set. Clicking
  it calls `openInFileManager(recovery.workPath, recovery.path)`, routes a rejection to
  the global error toast, and always dismisses the notice.
- `src/App.tsx`: renders `<OperationNoticeToast notice={operationNotice} t={t} />` in
  place of the inline block; dropped the now-unused `dismissOperationNotice` import.
- i18n: `save.teardown.failed`, `save.teardown.failedNoCopy`, `save.teardown.openCopy`
  added to both `en.ts` and `ko.ts`.
- Tests: a new `ScratchpadPane.test.tsx` case proves a close-time save failure keeps a
  recovery file and raises the toast end to end; a new
  `OperationNoticeToast.test.tsx` (5 cases) covers the toast's rendering and open/dismiss
  behavior in isolation; `teardownSave.test.ts` gained 5 cases hardening
  `reportTeardownSaveFailure` itself (failedNoCopy path, concurrent failures, single-slot
  dedupe both ways, content-leak assertions).

## Task Commits

Each task was committed atomically:

1. **Task 1: A Scratchpad save that fails on close leaves a recovery file and a toast naming the file and the reason** - `6bcdceb` (feat)
2. **Task 2: The toast opens the recovery copy, and the reporter stays honest under double and failed-copy cases (TDD)** - `6e9bc60` (test, RED) then `f2e8b01` (feat, GREEN)

_No REFACTOR commit; the GREEN implementation needed no follow-up cleanup._

## Files Created/Modified

- `src/lib/teardownSave.ts` - `reportTeardownSaveFailure`, wired into `settleTeardownSave`
- `src/lib/errorStore.ts` - `OperationNotice.recovery?`
- `src/lib/i18n/locales/en.ts`, `src/lib/i18n/locales/ko.ts` - `save.teardown.*` keys
- `src/components/ScratchpadPane.test.tsx` - close-time-save-failure test, `../lib/maruDir` mock, `t` template lookup for the two new keys
- `src/components/OperationNoticeToast.tsx` - extracted toast + Open recovery copy action
- `src/components/OperationNoticeToast.test.tsx` - 5 new tests
- `src/App.tsx` - renders `<OperationNoticeToast>`, dropped unused import
- `src/lib/teardownSave.test.ts` - 5 new `reportTeardownSaveFailure` tests, file-level notice-queue drain in `afterEach`

## Decisions Made

- `reportTeardownSaveFailure` derives `reason` identically to how `ScratchpadPane.flushCurrent()`'s own catch already computed the message it passes to `setError`; this is what makes the dedupe (`setError((current) => current === reason ? null : current)`) actually match instead of silently never firing.
- The Open button's handler is a single `.catch(setError).finally(dismiss)` chain rather than a `try/finally`, matching "dismiss always happens, error routing only on rejection" in one expression.
- `ScratchpadPane.test.tsx`'s existing `t` mock returns keys verbatim (by design, so its other 14 assertions can match on raw key text); it gained a two-entry `templates` lookup so only the two new `save.teardown.*` keys interpolate `{file}`/`{reason}` for this plan's assertions, leaving every other key's behavior unchanged.
- `teardownSave.test.ts` needed a file-level `afterEach` draining the *entire* operation-notice queue, not a single dismiss: unmount tests in the pre-existing `useTeardownFlush` describe block now also call `reportTeardownSaveFailure` (since it's wired into `settleTeardownSave`), so they leave notices in the same shared module-level queue the new `reportTeardownSaveFailure` describe block's tests read from. A single dismiss left one stale notice at the queue's head, which a later test's `getOperationNotice()` picked up instead of its own; caught by running the failing test in isolation (passed) vs. the full file (failed with an unrelated leftover message), the standard signature of cross-test module-state leakage.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Test-harness `t` mock could not exercise real i18n interpolation**
- **Found during:** Task 1 (writing the ScratchpadPane failure test)
- **Issue:** `ScratchpadPane.test.tsx`'s local `t` mock returns the translation key verbatim with no dictionary lookup, so asserting the toast message actually contains the file path and reason (as the plan's acceptance criteria require) was impossible with the existing mock.
- **Fix:** Added a small `templates` map for exactly the two new `save.teardown.*` keys; every other key's identity behavior is unchanged (verified: none of the file's other tests reference these keys).
- **Files modified:** `src/components/ScratchpadPane.test.tsx`
- **Verification:** all 15 existing + 1 new test in the file pass.
- **Committed in:** `6bcdceb` (Task 1 commit)

**2. [Rule 1 - Bug] Cross-test operation-notice leakage in teardownSave.test.ts**
- **Found during:** Task 2 (hardening `reportTeardownSaveFailure`'s test coverage)
- **Issue:** Wiring `reportTeardownSaveFailure` into `settleTeardownSave` means the pre-existing `useTeardownFlush` unmount tests (which deliberately fail a save) now also publish an `OperationNotice` into the shared module-level queue, but their own cleanup never dismissed it. A later `reportTeardownSaveFailure` test's `getOperationNotice()` picked up that stale notice instead of its own, producing a message mismatch that looked like a production bug but was purely test isolation.
- **Fix:** Added a file-level `afterEach` that drains the operation-notice queue completely (loop until `getOperationNotice()` is null) after every test in the file.
- **Files modified:** `src/lib/teardownSave.test.ts`
- **Verification:** all 9 tests in the file pass together and the previously-failing test passes both alone and in the full run.
- **Committed in:** `f2e8b01` (Task 2 GREEN commit)

**3. [Out of scope, cleaned up] `make test-e2e`'s `today-design-qa.spec.ts` wrote 6 new screenshots to `docs/design-qa/`**
- **Found during:** running the plan's `make test-e2e` verification
- **Issue:** An unrelated, pre-existing e2e spec captures design-QA screenshots as a side effect of running the full suite; these are not part of this plan's scope and were left untracked after the run.
- **Fix:** Deleted the untracked screenshots rather than committing incidental test-run artifacts; the spec itself and its behavior are untouched.
- **Files modified:** none (files removed, never staged)

---

**Total deviations:** 2 auto-fixed (2 test-harness/isolation bugs), 1 out-of-scope cleanup (untracked artifacts removed, not committed)
**Impact on plan:** Both auto-fixes are test-infrastructure corrections needed to get an accurate pass/fail signal from this plan's own new tests; neither touches production code or scope. No scope creep.

## Issues Encountered

None beyond the two test-isolation bugs documented above (which were symptoms of test infrastructure, not production behavior, and are fully resolved).

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run src/components/ScratchpadPane.test.tsx src/lib/teardownSave.test.ts src/lib/errorStore.test.tsx src/components/OperationNoticeToast.test.tsx`: 36 tests pass.
- `pnpm typecheck`, `pnpm lint` (`--max-warnings 0`), `pnpm lint:i18n`: all clean.
- `make test-e2e`: 250 passed (Playwright/chromium), including the Skills operation-toast flows the extracted `data-skill-operation` attribute backs.
- `make verify`: full gate passed (exit code 0): typecheck, lint, icon/i18n/DOM/type-token guards, TS tests (231 files / 2219 tests), Rust tests (1816 passed, 0 failed, 3 ignored), `cargo fmt --check`, `cargo clippy -- -D warnings`, `pnpm build:frontend` (bundle-budget, native-e2e-isolation, csp-blob, mode-css-ownership all pass), `check-command-isolation` (383/383 PASS, unchanged by this plan; no new IPC commands).

## Next Phase Readiness

- `reportTeardownSaveFailure` is a complete, tested, self-contained failure-reporting path
  (recovery copy -> toast -> log -> dedupe) that plan 09-08's quit-time flush can call
  directly for the same visibility on the quit path, with no new toast/log/recovery logic
  to write.
- REL-03 stays open in `REQUIREMENTS.md` (still `Pending`): it is shared with sibling plan
  09-08, which has not produced a SUMMARY yet in this worktree's view. No requirements were
  marked complete by this plan (correct per the shared-ID gate; verified `09-08-SUMMARY.md`
  does not yet exist).
- No blockers for 09-08.

## Self-Check: PASSED

- All key files found on disk: `src/lib/teardownSave.ts`, `src/lib/errorStore.ts`,
  `src/lib/i18n/locales/en.ts`, `src/lib/i18n/locales/ko.ts`,
  `src/components/ScratchpadPane.test.tsx`, `src/components/OperationNoticeToast.tsx`,
  `src/components/OperationNoticeToast.test.tsx`, `src/App.tsx`,
  `src/lib/teardownSave.test.ts`.
- All commit hashes found in `git log`: `6bcdceb`, `6e9bc60`, `f2e8b01`.
- Task 1 acceptance criteria re-verified via grep: `export async function reportTeardownSaveFailure` count 1 in `teardownSave.ts`; `recovery?:` count 1 in `errorStore.ts`; `save.teardown.failed` count 2 in both `en.ts` and `ko.ts` (matches `failed` + `failedNoCopy`).
- Task 2 acceptance criteria re-verified: `<OperationNoticeToast` count 1 and `data-skill-operation` count 0 in `App.tsx`; `openInFileManager(` count 1 and `data-skill-operation` count 1 in `OperationNoticeToast.tsx`.
- Plan-level `<verification>` re-run: all four listed vitest files pass (36 tests); `pnpm typecheck`, `pnpm lint`, `pnpm lint:i18n`, `make test-e2e` (250 passed) all pass.
- `make verify` re-run in full: PASSED (exit code 0; TS 2219 tests, Rust 1816 tests, fmt/clippy/build/command-isolation all clean, 383/383 unchanged).

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-26*
