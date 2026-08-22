---
phase: 01-trustworthy-verify-signal
plan: 07
subsystem: testing
tags: [eslint, makefile, verify-gate, react-hooks, hook-dependency-gate, gate-flip]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: "01-06's eslint.config.js (D-02 four-rule set) and src/App.tsx cleared to zero, plus the measured 52-error/7-warning backlog this plan sizes against"
provides:
  - "src/ ESLint-clean at zero errors/warnings across all files, not just App.tsx"
  - "e2e/ confirmed ESLint-clean (was already zero before this plan touched it)"
  - "Makefile `lint` target (node_modules prerequisite, `$(PNPM) lint` recipe) runnable standalone"
  - "Makefile `verify` prerequisite list includes `lint` immediately after `typecheck`; GATE-02 is now a live gate, not just a script"
affects: ["Phase 4-5 (the 8 App.tsx exhaustive-deps disables from 01-06 plus the 27 elsewhere are the grep-able decomposition worklist)"]

actuals:
  tokens: 6400
  tasks: 3
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Positional/required-interface unused args (favoriteIds, settings, warnings, hdbg, headerBg) renamed with a leading underscore in the destructure/param list only, leaving the prop type or call-site arity untouched, rather than deleting and risking a caller-side ripple"
    - "A dead object-destructured prop (workspacePath, defaultRuntime, DraftStatus type) deleted outright when nothing else in the file references it and it isn't positional"

key-files:
  modified:
    - Makefile
    - src/components/OutlinePane.tsx
    - src/components/RichMarkdownEditor.tsx
    - src/components/TerminalPanel.tsx
    - src/components/catalog/WritingGuidelineSidebar.tsx
    - src/components/dashboard/DashboardPane.tsx
    - src/components/diagram/modals/MappingPreviewDialog.test.tsx
    - src/components/diagram/modals/PatternGalleryDialog.tsx
    - src/components/diagram/panels/RightPanel.tsx
    - src/components/diagram/ribbon/RibbonFormat.tsx
    - src/components/diagram/ribbon/RibbonTable.test.tsx
    - src/components/drafts/DraftsPane.tsx
    - src/components/drafts/useIdeationDrafts.ts
    - src/components/graph/GraphCanvas.tsx
    - src/components/graph/GraphView.tsx
    - src/components/meetings/MeetingsPane.tsx
    - src/components/studio/MarkdownSourceEditor.tsx
    - src/components/studio/StudioMode.tsx
    - src/components/tasks/TaskFormFields.tsx
    - src/components/today/useTodayPlanner.ts
    - src/components/today/useTodayTasks.ts
    - src/lib/api.ts
    - src/lib/dashboard.ts
    - src/lib/diagram/convert.ts
    - src/lib/diagram/tableActions.ts
    - src/lib/diagram/templates.ts
    - src/lib/i18n.ts
    - src/lib/markdown.ts
    - src/lib/settings.ts
    - src/lib/useInboxEvents.ts

key-decisions:
  - "Re-measured src/ backlog at exactly 52 errors + 7 warnings across 28 files (excluding App.tsx and the foreign, already-clean src/lib/hwped.ts), matching 01-06's SUMMARY prediction exactly"
  - "e2e/ needed zero fixes: pnpm exec eslint e2e --max-warnings 0 was already exit 0 before this plan touched it, and pnpm exec tsc -p tsconfig.e2e.json stayed exit 0. Task 2 produced no diff and no commit"
  - "src/lib/hwped.ts (a concurrent session's untracked file, inside this plan's src/ lint scope) was independently confirmed lint-clean by running eslint on it directly, so no --ignore-pattern was needed and it never appeared in any inventory run"
  - "Full make verify could not be run to a clean exit on this shared checkout. First attempt failed at test-rust: 12 outlook_mso tests failed on wall-clock 'm365_timeout: readiness probe exceeded its deadline' assertions while a concurrent session's own `cargo test --workspace` process was running against the same target/ directory, consistent with CPU/build-lock contention, not a code defect (this plan touches zero Rust files). A direct `cd src-tauri && cargo clippy --offline -- -D warnings` also fails, but only on 2 clippy errors (needless_borrow, useless_format) entirely inside the concurrent session's uncommitted src-tauri/src/hwped.rs; `cargo fmt --check` likewise reports diffs entirely inside that same foreign file. Per the team lead's explicit instruction, none of this was diagnosed or fixed. The gate-flip proof instead ran `make lint` standalone (both directions), plus `pnpm typecheck`, `pnpm test`, and `make test-e2e` individually, all green. CI, which checks out the committed tree without the foreign files, is the authoritative composite make verify run"

patterns-established: []

requirements-completed: [GATE-02]

coverage:
  - id: D1
    description: "src/ (all files, not just App.tsx) reports zero ESLint errors and zero warnings under the D-02 four-rule set; every exhaustive-deps disable comment THIS PLAN ADDED names the rule and carries a same-line reason (8 pre-existing bare directives, all dated July and untouched here, still survive elsewhere in src/ — ESLint registers no rule requiring reasons, so GATE-02 is unaffected); all 7 dead no-console directives removed; no dependency array's contents changed; no console. call touched; the one no-floating-promises site got a `void`, not an `await`"
    requirement: "GATE-02"
    verification:
      - kind: unit
        ref: "pnpm exec eslint src --max-warnings 0 (exit 0)"
        status: pass
      - kind: unit
        ref: "grep -rc 'eslint-disable-next-line no-console' src == 0; grep -rc 'eslint-disable-next-line$' src == 0"
        status: pass
      - kind: unit
        ref: "grep -rn 'console\\.' src (non-test) == 35, unchanged from 01-06's baseline"
        status: pass
      - kind: unit
        ref: "pnpm typecheck (exit 0); pnpm test (1853/1853, unchanged count)"
        status: pass
    human_judgment: false
  - id: D2
    description: "e2e/ confirmed ESLint-clean under the two registered rules (no-unused-vars, no-floating-promises); tsconfig.e2e.json typecheck unregressed; full Playwright suite still passes"
    requirement: "GATE-02"
    verification:
      - kind: unit
        ref: "pnpm exec eslint e2e --max-warnings 0 (exit 0, zero diff needed)"
        status: pass
      - kind: unit
        ref: "pnpm exec tsc -p tsconfig.e2e.json (exit 0)"
        status: pass
      - kind: e2e
        ref: "make test-e2e (203 passed, 1.6m)"
        status: pass
    human_judgment: false
  - id: D3
    description: "make lint target added (node_modules prerequisite, `$(PNPM) lint` recipe, `##` help description) and wired into the verify prerequisite list immediately after typecheck; the verify `##` gloss rewritten to mention all three of this phase's Makefile-verify additions (lint, clippy, fmt-check)"
    requirement: "GATE-02"
    verification:
      - kind: unit
        ref: "grep -c 'lint' Makefile: 6 -> 9 (+3: .PHONY line, target line, verify prerequisite); grep -n '^lint:' shows node_modules prerequisite; grep -n '^verify:' shows lint immediately after typecheck; make help | grep lint shows a non-empty description row"
        status: pass
      - kind: unit
        ref: "make lint on the reverted tree (exit 0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Deliberate-break proof: a wrong hook dependency list makes make lint fail naming react-hooks/exhaustive-deps; an unused symbol without a leading underscore makes make lint fail naming no-unused-vars; both revert to a clean git diff and a green make lint"
    requirement: "GATE-02"
    verification:
      - kind: manual_procedural
        ref: "src/components/today/useTodayTasks.ts useEffect deps temporarily changed [refresh] -> []: make lint failed exit 1 naming react-hooks/exhaustive-deps on the missing 'refresh' dependency; reverted via git checkout -- <file>, git diff empty, make lint exit 0"
        status: pass
      - kind: manual_procedural
        ref: "same file: temporary `const unusedGateProbe = 1;` added: make lint failed exit 1 naming @typescript-eslint/no-unused-vars; reverted via git checkout -- <file>, git diff empty, make lint exit 0"
        status: pass
    human_judgment: false
  - id: D5
    description: "Full make verify with all seven Phase 1 gates live at once (could not be proven green on this shared checkout due to two independent foreign-file failures (see key-decisions)); each gate this plan owns was instead proven individually green, and CI is the authoritative composite check"
    verification: []
    human_judgment: true
    rationale: "The composite make verify result depends on files this plan does not own and was explicitly instructed not to touch (src-tauri/src/hwped.rs, the hwped import block of src-tauri/src/lib.rs) plus a timing-sensitive Rust test suite that raced a concurrent session's own cargo test --workspace process. Neither failure traces to any file this plan modified. A human (the team lead) must confirm the CI run on the committed tree, which excludes the foreign files."

duration: ~1h10min active
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 07: Finish ESLint Backlog + Flip the GATE-02 verify Gate Summary

**Cleared the remaining 52-error/7-warning `src/` ESLint backlog (28 files), confirmed `e2e/` was already clean, and wired `make lint` into `make verify` immediately after `typecheck`; GATE-02 is now a live gate, proven red-then-green on both its correctness rules.**

## Performance

- **Duration:** ~1h10min active (includes waiting on/diagnosing shared-checkout contention from a concurrent session)
- **Started:** 2026-08-22 (picked up immediately after 01-06)
- **Completed:** 2026-08-22T10:10:25Z
- **Tasks:** 3/3 (Task 2 produced no diff, see below)
- **Files modified:** 30 (Makefile + 29 `src/` files; `e2e/` untouched)

## Accomplishments

- Re-ran `pnpm exec eslint src` and confirmed the exact backlog 01-06 predicted: **52 errors + 7 warnings across 28 files** (24 `no-unused-vars`, 27 `exhaustive-deps`, 1 `no-floating-promises`, 7 dead `no-console` directives)
- Drove `src/` to zero: every `no-unused-vars` site fixed (dead imports/bindings deleted; positional or required-interface args (`favoriteIds`, `settings`, `warnings`, `hdbg`, `headerBg`) renamed with a leading underscore rather than deleted, since deleting them would have required touching call sites outside this plan's fixing-not-rewriting mandate); every `exhaustive-deps` site annotated with a named, reasoned `eslint-disable-next-line`, including 12 in one `useEffect` cleanup block in `TerminalPanel.tsx` (12 separate ref reads, 12 separate directives, since ESLint reports each independently); the one `no-floating-promises` site in `WritingGuidelineSidebar.tsx` fixed with `void`, not `await`; all 7 dead `eslint-disable-next-line no-console` comments deleted (the underlying `console.` calls untouched)
- Confirmed `e2e/` was **already ESLint-clean** (`pnpm exec eslint e2e --max-warnings 0` exit 0 with zero changes needed) and typecheck-clean (`tsc -p tsconfig.e2e.json` exit 0); ran the full Playwright suite anyway per the plan's verify step; **203/203 passed** in 1.6m
- Added `make lint` (mirrors `typecheck`'s `node_modules` prerequisite pattern) and wired it into `verify` immediately after `typecheck` per D-04; rewrote the `verify` `##` gloss to name all three Makefile-verify gates this phase added (lint, clippy, fmt-check)
- Proved the gate both directions twice: a wrong `useEffect` dependency array failed `make lint` naming `react-hooks/exhaustive-deps`; an unused symbol without a leading underscore failed `make lint` naming `@typescript-eslint/no-unused-vars`; both reverted to a clean `git diff` and a green `make lint`
- `pnpm exec eslint src e2e --max-warnings 0` exits 0; `pnpm typecheck` exits 0; `pnpm test` 1853/1853 unchanged; non-test `src/` `console.` count unchanged at 35

## Task Commits

1. **Task 1: Clear the remaining src/ violations and delete the dead disable directives** - `9ad161e` (fix)
2. **Task 2: Clear the e2e/ violations** - no commit; `e2e/` was already ESLint-clean and typecheck-clean before this task ran, so there was nothing to fix or stage. Verified via `pnpm exec eslint e2e --max-warnings 0` (exit 0), `pnpm exec tsc -p tsconfig.e2e.json` (exit 0), and `make test-e2e` (203/203 passed)
3. **Task 3: Add the lint make target, wire it into verify, prove it goes red both ways** - `1998736` (feat)

**Plan metadata:** _(this commit, made after this SUMMARY)_

## Files Created/Modified

- `Makefile` - new `lint: node_modules` target; `verify` prerequisite list gains `lint` immediately after `typecheck`; `##` gloss on `verify` rewritten to cover lint, clippy, and fmt-check
- 29 `src/` files - see `key-files.modified` in frontmatter for the full list; each received one or more of: dead-import/binding deletion, underscore-prefix rename on a positional/required-interface unused arg, a named-and-reasoned `eslint-disable-next-line react-hooks/exhaustive-deps`, a `void` on one floating promise, or deletion of a dead `no-console` disable comment
- `e2e/` - untouched (already clean)

## Decisions Made

- **28-file, 52-error/7-warning backlog matched 01-06's prediction exactly** - no re-scoping needed, unlike 01-06's own App.tsx re-measurement.
- **`e2e/` needed no work.** 01-06's SUMMARY flagged it as "never measured before this phase," but by the time this plan ran, it was already at zero on both rules registered for that tree. Task 2 is documented as a clean pass-through, not skipped.
- **`src/lib/hwped.ts` (the concurrent session's untracked file, inside this plan's `src/` lint scope) needed no exclusion.** Running `pnpm exec eslint src/lib/hwped.ts` directly confirmed it lint-clean, so it was never flagged in any inventory and no `--ignore-pattern` was ever necessary; the file simply never appeared as a violation.
- **12 separate `eslint-disable-next-line` comments in one `TerminalPanel.tsx` cleanup block, not one block-level disable.** ESLint reports each of the 12 ref reads at unmount as an independent `exhaustive-deps` diagnostic; matching 01-06's established one-directive-per-diagnostic convention (rather than a `/* eslint-disable */ ... /* eslint-enable */` block) keeps every directive individually load-bearing and grep-able.
- **Positional/required-interface unused args renamed with a leading underscore instead of deleted:** `favoriteIds` (GraphCanvas.tsx, `StaticGraphFallback`'s prop, still passed by its one caller), `settings` (MeetingsPane.tsx, required prop type, passed by `LazyMeetingsPane` in App.tsx), `warnings` (convert.ts `buildFlowFromRecords`, 5th positional param, passed at 2 call sites), `hdbg`/`headerBg` (templates.ts, arrow-function params inside an already-dead-but-intentionally-kept `styleFor`/`sec` helper pattern marked with `void styleFor;`). Deleting any of these would have required touching call sites or type signatures outside this plan's "fix the violation, don't rewrite the code" mandate.
- **`Full make verify` could not be proven green on this shared checkout (reported honestly rather than claimed).** See `key-decisions` in frontmatter for the full breakdown of both independent foreign-file failures (test-rust timeout contention, clippy/fmt-check failures entirely inside `src-tauri/src/hwped.rs`). Per the team lead's explicit instruction, this plan verified each gate it owns individually instead: `make lint` (both break-and-revert directions), `pnpm typecheck`, `pnpm test`, `make test-e2e`, all green. CI is the authoritative composite check.

## Deviations from Plan

### Auto-fixed Issues

None requiring a Rule 1-3 code fix beyond what Task 1's and Task 3's action text specified.

### Environment note (not a deviation in this plan's own scope)

Two independent foreign-file failures blocked a clean `make verify` on this shared checkout:

1. **`test-rust` failed on 12 `outlook_mso` tests** (`m365_timeout: readiness probe exceeded its deadline`) while a concurrent session's own `cargo test --workspace` process (PID 74855, observed running for 10+ minutes against the same `src-tauri/target/`) was active. This plan touches zero Rust files; the failing tests are wall-clock deadline assertions in a module unrelated to anything in this diff, consistent with CPU/build-artifact contention between two simultaneous `cargo test` invocations sharing one `target/` directory.
2. **`cd src-tauri && cargo clippy --offline -- -D warnings` failed to compile** on 2 clippy errors (`needless_borrow`, `useless_format`), both at specific lines inside the concurrent session's uncommitted `src-tauri/src/hwped.rs`. `cargo fmt --check` independently confirmed every reported diff also lives entirely inside that same foreign file.

Per the team lead's explicit instruction, neither was diagnosed, fixed, or worked around. This plan's own verification claim is scoped to what it can prove in isolation: `pnpm exec eslint src e2e --max-warnings 0` (exit 0), `pnpm typecheck` (exit 0), `pnpm test` (1853/1853), `make test-e2e` (203/203), and `make lint` proven red-then-green twice on the reverted tree. `test-rust`, `fmt-check`, `clippy`, and the full composite `make verify` remain unverified end-to-end on this checkout pending the concurrent session's work landing or the checkout being unblocked; CI (which checks out the committed tree without the foreign files) is the authoritative composite check, to be run by the team lead after this plan lands.

Also reverted `docs/design-qa/*.png` after `make test-e2e` rewrote them with rendering jitter, per the environment notes (`git checkout -- docs/design-qa/`); not a deviation, a known re-run artifact.

---

**Total deviations:** 0 requiring a Rule 1-3 fix; 2 environment/contamination interactions (documented above, not diagnosed per instruction)
**Impact on plan:** None on this plan's own deliverable. `make verify`'s composite green run is deferred to CI.

## Issues Encountered

See "Environment note" above for the full detail on the two foreign-file failures that blocked a clean `make verify`.

## User Setup Required

None.

## Next Phase Readiness

- GATE-02 is fully live: `src/` and `e2e/` are both ESLint-clean under the exact D-02 four-rule set, `make lint` is runnable standalone and wired into `verify` immediately after `typecheck`, and the gate is proven to fail loudly on both a bad hook dependency list and an unused symbol.
- Phase 1's three Makefile-`verify` additions (`fmt-check` from 01-01, `clippy` from 01-02, `lint` here) are all present in the `verify` prerequisite list; the two new `tsc -b` project references from 01-04/01-05 are live in `typecheck`. All four are committed on this branch even though the composite `make verify` run itself was not observed green locally.
- **Action needed from the team lead (already flagged in the checkpoint-equivalent note above):** trigger the CI run against this branch to get the authoritative all-seven-gates-green proof this phase's success criteria require. This plan cannot self-certify that criterion on the current shared checkout.
- The 27 `exhaustive-deps` disable comments this plan added, plus 01-06's 8 in `App.tsx` (35 total across the phase, all named + reasoned), are the grep-able worklist Phases 4-5 burn down as they touch each pane during decomposition.
- `src-tauri/src/hwped.rs`, `src/lib/hwped.ts`, `docs/hwp-editor.md`, and the `hwped` import block of `src-tauri/src/lib.rs` remain uncommitted, foreign, and untouched by this plan or any Phase 1 plan.

## Self-Check: PASSED

All 30 modified files verified present on disk with the expected changes; both task commit hashes (`9ad161e`, `1998736`) verified present in `git log --oneline`.

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*
