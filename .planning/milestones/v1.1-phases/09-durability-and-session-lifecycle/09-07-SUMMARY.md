---
phase: 09-durability-and-session-lifecycle
plan: 07
subsystem: durability
tags: [react, debounce, autosave, teardown, studio, graph, today, meetings]

# Dependency graph
requires:
  - phase: 09-durability-and-session-lifecycle
    provides: "src/lib/debouncedSave.ts (SettlingDebouncedSaver, flushSettled) and src/lib/teardownSave.ts (useTeardownFlush) from plan 09-05"
provides:
  - "MeetingSourceWorkbench's SourceEditor autosave on createDebouncedSaver keyed by the editor store, unmount flush via useTeardownFlush, IME deferral and stop-after-failure preserved"
  - "StudioMode autosave on createDebouncedSaver keyed by workspaceRoot, document-switch flush before the next document loads, unmount flush"
  - "GraphView layout autosave on createDebouncedSaver keyed by workspacePath, unmount flush"
  - "TodayBrainDump autosave on createDebouncedSaver, registered flush and unmount flush routed through the saver instead of a hand-rolled timer"
  - "src/lib/teardownSave.surfaces.test.ts: source-level pin that all five in-scope surfaces call useTeardownFlush/createDebouncedSaver and no longer hand-roll a timer, and that HtmlVisualEditor's compliant unmount serialize is unchanged"
affects: ["09-06 (toast + recovery copy consumes useTeardownFlush's onError path across all five surfaces)", "09-08 (quit-time flush walks the teardownSave registry, now covering every in-scope surface)"]

# Actuals (#2632)
actuals:
  tokens: 5505
  tasks: 3
  commits: 5

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-identity saver via useMemo (keyed on editor / workspaceRoot / workspacePath): a workspace or document-store switch swaps the saver, and useTeardownFlush's own effect settles the outgoing saver before the incoming one starts scheduling (T-09-07-01)."
    - "Document-switch flush before load: when the saver's key (workspaceRoot) does not change but the loaded document does, the load effect calls `void saver?.flush()` before overwriting state, so the debounced saver's single pending slot cannot be silently overwritten by the next document's schedule (T-09-07-02)."
    - "Rethrow-after-bookkeeping: enqueueStudioSave keeps its existing setError/setSaving side effects on failure but now rethrows, so the wrapping debounced saver observes the failure as a failed settlement instead of swallowing it."

key-files:
  created:
    - src/lib/teardownSave.surfaces.test.ts
  modified:
    - src/components/meetings/MeetingSourceWorkbench.tsx
    - src/components/meetings/MeetingSourceWorkbench.test.tsx
    - src/components/studio/StudioMode.tsx
    - src/components/graph/GraphView.tsx
    - src/components/today/TodayBrainDump.tsx
    - src/components/today/TodayPrepare.test.tsx

key-decisions:
  - "Studio and GraphView keep their savers keyed by workspaceRoot/workspacePath only (not by document id), matching the plan; a same-workspace document switch relies on the load effect's explicit saver.flush() rather than a saver swap, since the saver instance itself does not change on that transition."
  - "enqueueStudioSave's shared save-queue tail is kept non-rejecting (`saveQueueRef.current = run.catch(() => undefined)`) even though the promise returned to callers (and to the debounced saver) can now reject, so a failed save cannot poison the next enqueue's chain."
  - "No component tests were added for StudioMode or GraphView (matching the plan's flagged_assumptions): both lack a test harness and heavy dependencies (Studio's export/template pipeline, Sigma/graphology). Their conversion is covered by the source-level surfaces pin plus 09-05's saver/hook unit tests, not new component behavior tests."

patterns-established:
  - "The full set of in-scope debounced autosave surfaces (Scratchpad from 09-05, plus Meeting source, Studio, Graph layout, Today brain dump from this plan) now uniformly flush on unmount via useTeardownFlush, closing out D-01 (REL-02) except for HtmlVisualEditor, pinned as already-compliant."

requirements-completed: [REL-02, REL-03]

coverage:
  - id: D1
    description: "A meeting-source edit made inside the 700ms autosave window is saved when the SourceEditor unmounts, instead of the timer being cleared; Korean IME deferral and stop-after-failure behavior are preserved."
    requirement: "REL-02"
    verification:
      - kind: unit
        ref: "src/components/meetings/MeetingSourceWorkbench.test.tsx#saves an edit made just before the editor closes"
        status: pass
      - kind: unit
        ref: "src/components/meetings/MeetingSourceWorkbench.test.tsx#defers autosave until Korean IME composition finishes"
        status: pass
      - kind: unit
        ref: "src/components/meetings/MeetingSourceWorkbench.test.tsx#preserves visible edits when autosave fails and never reports confirmation"
        status: pass
    human_judgment: false
  - id: D2
    description: "A Studio draft change made inside the 600ms window is saved when Studio unmounts, and switching Studio to another document inside that window saves the old document's state via the load effect's explicit flush instead of coalescing it away."
    requirement: "REL-02"
    verification: []
    human_judgment: true
    rationale: "StudioMode has no component test harness (heavy export/template pipeline dependencies); covered by the source-level surfaces pin (useTeardownFlush/createDebouncedSaver present, saveTimerRef gone) and 09-05's saver/hook unit tests, but the Studio-specific unmount/document-switch behavior itself has no automated test."
  - id: D3
    description: "A graph layout change made inside the 1500ms window is saved to .maru/cache/graph-layout.json when the graph view unmounts."
    requirement: "REL-02"
    verification: []
    human_judgment: true
    rationale: "GraphView has no component test harness (Sigma/graphology, layout worker); covered by the source-level surfaces pin, but the unmount-save behavior itself has no automated test."
  - id: D4
    description: "The Today brain dump keeps flushing its typed tail on unmount and on Finish/Quick skip, now through the shared saver, and Undo still discards unsaved typing."
    requirement: "REL-02"
    verification:
      - kind: unit
        ref: "src/components/today/TodayPrepare.test.tsx#saves a pending brain dump edit made just before Prepare unmounts"
        status: pass
      - kind: unit
        ref: "src/components/today/TodayPrepare.test.tsx#updates the brain dump text and counter while typing, then autosaves"
        status: pass
      - kind: unit
        ref: "src/components/today/TodayPrepare.test.tsx#enables undo only after a save lands, then disables it when the backend reports nothing to undo"
        status: pass
    human_judgment: false
  - id: D5
    description: "Every in-scope autosave surface (Scratchpad, Studio, Today brain dump, meeting source, graph layout) calls useTeardownFlush with a describe callback naming a real file label and the unsaved content; HtmlVisualEditor is pinned as already-compliant and left unconverted."
    requirement: "REL-02"
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.surfaces.test.ts (5 cases)"
        status: pass
    human_judgment: false

duration: 16min
completed: 2026-09-26
status: complete
---

# Phase 9 Plan 7: Meeting source, Studio, graph layout, and Today brain dump autosave conversion Summary

**MeetingSourceWorkbench, StudioMode, GraphView, and TodayBrainDump now all schedule their debounced autosave through `createDebouncedSaver` and flush the pending save on unmount via `useTeardownFlush`, closing out D-01/REL-02 for every remaining hand-rolled autosave timer research's inventory found, with a source-level pin test guarding all five converted surfaces plus HtmlVisualEditor's already-compliant unmount serialize.**

## Performance

- **Duration:** 16 min
- **Started:** 2026-09-26T08:32:00+09:00
- **Completed:** 2026-09-26T08:48:09+09:00
- **Tasks:** 3 completed
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- `src/components/meetings/MeetingSourceWorkbench.tsx` (SourceEditor): the cancel-only 700ms `window.setTimeout` autosave effect is replaced by a `createDebouncedSaver<MeetingSourceEditorStore>` created per `editor` identity; the effect now calls `saver.cancel()` when dirty/composing/busy/saveError gating says no, else `saver.schedule(editor)`. `useTeardownFlush` settles the pending save on unmount or editor swap. IME deferral and stop-after-failure tests pass unchanged.
- `src/components/studio/StudioMode.tsx`: `saveTimerRef` is gone. A `createDebouncedSaver<StudioState>` keyed by `workspaceRoot` replaces the 600ms timer effect; `enqueueStudioSave` now rethrows after its existing `setError`/`setSaving` bookkeeping so the saver can observe a failed save (its shared queue tail stays non-rejecting via `.catch(() => undefined)` so the next enqueue is unaffected), and `saveNow` cancels the saver and swallows the already-surfaced rejection. The document/root-load effect calls `void saver?.flush()` before loading the next document, so a same-workspace document switch cannot silently overwrite the previous document's pending save.
- `src/components/graph/GraphView.tsx`: `saveTimerRef` is gone. A `createDebouncedSaver<GraphLayoutCache>` keyed by `workspacePath` replaces the 1500ms timer effect; the settle effect keeps every existing guard (settled-node identity, finite positions) and calls `saver.schedule(payload)` with no cancelling cleanup.
- `src/components/today/TodayBrainDump.tsx`: the hand-rolled `timerRef`/`pendingTextRef` pair and manual unmount effect are gone. One `createDebouncedSaver<string>` per mount (via a `saveRef` indirection so the saver's stable callback always calls the latest `save`) backs `handleChange`'s `saver.schedule`, the registered Finish/Quick-skip flush (`() => saver.flush()`), and `handleUndo`'s `saver.cancel()`. `save()` now throws `today_brain_dump_save_failed` when `mutate` resolves null (after resetting status to idle); the no-snapshot degraded-mode no-op is unchanged.
- New `src/lib/teardownSave.surfaces.test.ts`: readFileSync source-assertion pin (Scratchpad, Studio, Meeting source, Graph, and Today brain dump each call `useTeardownFlush(` and `createDebouncedSaver`), and Scratchpad/Studio/Graph/Today no longer contain their former hand-rolled timer ref identifiers; HtmlVisualEditor is pinned as already-compliant (its unmount cleanup still calls `serializeNowRef.current()`).
- New tests: MeetingSourceWorkbench "saves an edit made just before the editor closes" (unmount inside the 700ms window saves once); TodayPrepare "saves a pending brain dump edit made just before Prepare unmounts" (unmount inside the 800ms window saves once via real timers).

## Task Commits

1. **Task 1: A meeting-source edit made just before the editor closes is saved** - `b8872375` (feat)
2. **Task 2: Studio and the graph layout save on unmount, pinned by a source-level surfaces test** - `b526b404` (feat)
3. **Task 3: The Today brain dump runs on the shared saver with its flush-on-unmount, Finish/Quick-skip flush, and Undo discard intact** - `f43c3efa` (feat)

**Plan metadata:** `24c2f432` (docs: complete plan)
**Deviation fix (found during `make verify` after Task 1's commit):** `af9b4e5d` (fix: silence i18n-lint false positive)

## Files Created/Modified

- `src/lib/teardownSave.surfaces.test.ts` - source-level pin for all five in-scope surfaces plus HtmlVisualEditor
- `src/components/meetings/MeetingSourceWorkbench.tsx` - SourceEditor saver + teardown hook, IME/failure behavior preserved
- `src/components/meetings/MeetingSourceWorkbench.test.tsx` - new unmount-saves-pending-edit test
- `src/components/studio/StudioMode.tsx` - saver keyed by workspaceRoot, rethrowing enqueueStudioSave, document-switch flush
- `src/components/graph/GraphView.tsx` - saver keyed by workspacePath, settle-effect schedule
- `src/components/today/TodayBrainDump.tsx` - saver conversion, save() throws on null mutate, Undo cancels the saver
- `src/components/today/TodayPrepare.test.tsx` - new unmount-saves-pending-braindump test

## Decisions Made

- Studio and GraphView savers are keyed by `workspaceRoot`/`workspacePath` only (per the plan); a same-workspace document switch in Studio relies on the load effect's explicit `saver?.flush()` rather than a saver swap, since the saver's identity does not change on that transition; only `useTeardownFlush`'s automatic swap-settle covers a workspace-root change.
- `enqueueStudioSave`'s shared save-queue tail (`saveQueueRef.current`) is kept non-rejecting via `.catch(() => undefined)` even though the promise returned to callers can now reject, so a failed save cannot poison the next enqueue's `.then()` chain.
- No new component tests for StudioMode/GraphView (per the plan's flagged_assumptions): neither has an existing test harness, and both carry heavy dependencies (Studio's template/export pipeline, Sigma/graphology for Graph). Coverage comes from the source-level surfaces pin plus 09-05's saver/hook unit tests.
- Added a trailing `// i18n-lint-ignore` comment on MeetingSourceWorkbench's saver line: `scripts/lint-i18n.mjs`'s JSX-text heuristic false-positives on `=> createDebouncedSaver<Generic>(...)` (the `=>` arrow's `>` and the generic's `<MeetingSourceEditorStore>` bracket together look like a JSX text node to its regex). Verified this is the documented escape hatch, not a suppressed real violation: `node scripts/lint-i18n.mjs` reports "ok, 3797 keys in parity, no hardcoded UI strings" after the change.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Fixed an i18n-lint false positive on a generic-typed arrow function**
- **Found during:** Task 1 (`make verify`'s `lint-i18n` step)
- **Issue:** `scripts/lint-i18n.mjs`'s naive `>text<` JSX-text regex matched the `=>` arrow immediately followed by `createDebouncedSaver<MeetingSourceEditorStore>` as if it were JSX text, flagging `"createDebouncedSaver"` as hardcoded UI copy. This is plain TypeScript, not JSX render output.
- **Fix:** Added the script's documented escape hatch, a trailing `// i18n-lint-ignore` comment, to the affected line.
- **Files modified:** `src/components/meetings/MeetingSourceWorkbench.tsx`
- **Verification:** `node scripts/lint-i18n.mjs` reports zero violations; `make verify`'s `lint-i18n` step passes.
- **Committed in:** `af9b4e5d` (separate fix commit, found during the post-Task-3 `make verify` run, applied after Task 1's own commit)

---

**Total deviations:** 1 auto-fixed (1 blocking)
**Impact on plan:** No scope creep; a pre-existing linter blind spot on a syntax shape this plan's pattern (a generic-typed saver factory) happened to trigger. The escape hatch is the tool's own documented mechanism for exactly this case.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Verification

- `pnpm exec vitest run src/components/meetings/MeetingSourceWorkbench.test.tsx src/components/today/TodayPrepare.test.tsx src/lib/teardownSave.surfaces.test.ts`: all pass (9 + 14 + 5 = 28 tests).
- `pnpm test` (full `vitest run src scripts` + node:test scripts): 2206 tests pass, 230 test files pass (the pre-existing `scripts/check-command-isolation.test.mjs` "no test suite found" harness quirk is unrelated to this plan; file untouched, present before this plan started).
- `pnpm typecheck`: clean.
- `pnpm lint` (`--max-warnings 0`): clean.
- `make verify`: full gate passed (exit code 0): typecheck, lint, icon/i18n/DOM/type-token guards, TS + Rust tests, `cargo fmt --check`, `cargo clippy -- -D warnings`, `pnpm build:frontend` (bundle-budget, native-e2e-isolation, csp-blob, mode-css-ownership all pass), `check-command-isolation` (382/382 PASS).

## Next Phase Readiness

- All five in-scope debounced autosave surfaces (Scratchpad from 09-05; Meeting source, Studio, Graph layout, Today brain dump from this plan) now uniformly flush on unmount via `useTeardownFlush`, and `src/lib/teardownSave.surfaces.test.ts` pins that no surface reintroduces a cancel-only timer.
- 09-06's toast + recovery-copy wiring (the `onError` callback on each saver, and the `.maru/recovery/` copy) now has all five surfaces to wire against, not just Scratchpad.
- 09-08's quit-time flush, walking `teardownSave.ts`'s module-private registry, now covers every in-scope surface once it lands.
- No blockers for 09-06/09-08.

## Self-Check: PASSED

- All key files found on disk: `src/lib/teardownSave.surfaces.test.ts`, `src/components/meetings/MeetingSourceWorkbench.tsx`, `src/components/meetings/MeetingSourceWorkbench.test.tsx`, `src/components/studio/StudioMode.tsx`, `src/components/graph/GraphView.tsx`, `src/components/today/TodayBrainDump.tsx`, `src/components/today/TodayPrepare.test.tsx`.
- All commit hashes found in `git log`: `b8872375`, `b526b404`, `f43c3efa`, `24c2f432`, `af9b4e5d`.
- Task 1 acceptance criteria re-verified via grep: `useTeardownFlush(` count 1, `createDebouncedSaver` count 2 in `MeetingSourceWorkbench.tsx`.
- Task 2 acceptance criteria re-verified: `useTeardownFlush(` count 1 in both `StudioMode.tsx` and `GraphView.tsx`; `saveTimerRef` count 0 in both.
- Task 3 acceptance criteria re-verified: `useTeardownFlush(` count 1, `createDebouncedSaver` count 2 in `TodayBrainDump.tsx`.
- Plan-level `<verification>` re-run: both listed vitest invocations pass; `pnpm test`, `pnpm typecheck`, `pnpm lint` all pass.
- `make verify` re-run in full: PASSED (exit code 0; TS+Rust tests, fmt/clippy/build/command-isolation all clean).

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-26*
