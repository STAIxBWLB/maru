---
phase: 01-trustworthy-verify-signal
plan: 03
subsystem: testing
tags: [playwright, e2e, ci, trace, todo-ledger]

# Dependency graph
requires:
  - phase: 01-trustworthy-verify-signal (plan 01)
    provides: "rust-toolchain.toml pin used to date the CI run's baseline behavior"
provides:
  - "playwright.config.ts trace: retain-on-failure - CI e2e failures leave a downloadable trace.zip with zero retries"
  - "src/lib/e2eFlow.ts TODO_LEDGER with five genuinely-open entries and a hand-maintained provenance comment"
affects: [phase-2, phase-4, phase-5]

# Actuals (#2632)
actuals:
  tokens: 310
  tasks: 3
  commits: 2

# Tech tracking
tech-stack:
  added: []
  patterns: []

key-files:
  created: []
  modified:
    - playwright.config.ts
    - src/lib/e2eFlow.ts

key-decisions:
  - "D-12 held: retain-on-failure chosen over on-first-retry + retries. Empirically confirmed in the GATE-04 CI probe run - the failing test ran exactly once (1 failed / 202 passed, no retry line) and still produced a trace.zip"
  - "The GATE-04 empirical proof (D-13) required a workflow_dispatch run, not a plain branch push: ci.yml's push trigger is scoped to branches: [main], so a feature-branch push alone does not run CI. The team lead ran the probe via manual dispatch since this plan's executor was instructed not to push or touch CI"
  - "skill-name-drift was deleted outright rather than flipped to status: done, per GATE-07's 'ledger lists only open items' requirement; native-tauri-e2e-runner-missing stays open on purpose (PROJECT.md scopes it out of this milestone, tracked as v2)"

patterns-established: []

requirements-completed: [GATE-04, GATE-07]

coverage:
  - id: D1
    description: "playwright.config.ts use.trace is retain-on-failure, no retries key added, and the local e2e suite still passes"
    requirement: GATE-04
    verification:
      - kind: other
        ref: "node -e check (retain-on-failure present, no ^\\s*retries\\s*: line) + make test-e2e -> 203 passed (2.0m)"
        status: pass
    human_judgment: false
  - id: D2
    description: "A real CI run with a deliberately failing e2e spec produces a downloadable trace.zip artifact, with the failing test running exactly once (no retry)"
    requirement: GATE-04
    verification:
      - kind: manual_procedural
        ref: "CI run https://github.com/STAIxBWLB/maru/actions/runs/32559390372 (head 489aa6b); artifact playwright-report id 9472520034, 411208 bytes; trace.zip at test-results/smoke-boots-the-sample-wor-5acf6--opens-multiple-editor-tabs-chromium/trace.zip, confirmed non-empty on download (1752382 bytes uncompressed, 14 entries)"
        status: pass
    human_judgment: false
  - id: D3
    description: "TODO_LEDGER contains exactly five open entries (skill-name-drift removed) with no duplicate ids, and a hand-maintained provenance comment sits directly above the declaration"
    requirement: GATE-07
    verification:
      - kind: unit
        ref: "src/lib/e2eFlow.test.ts (pnpm test) - 1853 passed, including the readme-slide-export-conflict toContainEqual assertion"
        status: pass
    human_judgment: false
  - id: D4
    description: "pnpm typecheck exits 0 after the ledger edit"
    requirement: GATE-07
    verification:
      - kind: other
        ref: "pnpm typecheck (tsc -b) - clean exit"
        status: pass
    human_judgment: false

# Metrics
duration: 51min
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 03: CI Trace Capture and Truthful E2E Ledger Summary

**Playwright now captures a trace on the first e2e failure with zero retries (proven in a real CI run), and the shipped E2E flow TODO ledger dropped its one already-resolved entry and declares itself hand-maintained.**

## Performance

- **Duration:** 51 min
- **Started:** 2026-08-22T06:47:58Z
- **Completed:** 2026-08-22T07:39:28Z
- **Tasks:** 3
- **Files modified:** 2 (`playwright.config.ts`, `src/lib/e2eFlow.ts`) plus one CI probe commit and its revert on `e2e/smoke.spec.ts` (net zero)

## Accomplishments

- `playwright.config.ts` `use.trace` switched from `on-first-retry` to `retain-on-failure` (one-line change, no `retries` key added). Local proof: `make test-e2e` passed 203/203, `git diff --numstat playwright.config.ts` exactly `1  1`, `.github/workflows/ci.yml` unchanged.
- `src/lib/e2eFlow.ts` `TODO_LEDGER`: removed the resolved `skill-name-drift` entry (its premise - stale skill names in README - no longer holds), added a one-line `/** Hand-maintained: ... */` comment directly above the declaration following the `sites.ts:267` convention. Five entries remain, all genuinely open, no duplicate ids, none marked `done`.
- GATE-04 proven empirically per D-13: a deliberately-failing e2e assertion was pushed and run via `workflow_dispatch` on this branch (`ci.yml`'s `push` trigger only fires on `main`), and the resulting `playwright-report` artifact contained a real, non-empty `trace.zip` for the failing test, with the failing test running exactly once (no retry).
- The probe was reverted; `e2e/smoke.spec.ts` is byte-identical to its pre-probe content (`git diff c82b093 HEAD -- e2e/smoke.spec.ts` is empty).

## Task Commits

Each task was committed atomically:

1. **Task 1: Capture a Playwright trace on the first failure, without buying it with a retry** - `c8c9c59` (feat)
2. **Task 2: Drop the resolved ledger entry and declare the ledger hand-maintained** - `c82b093` (fix)
3. **Task 3: Prove in real CI that a failing e2e leaves a downloadable trace** - checkpoint, satisfied by the team lead's CI probe (`e711b59` add / `71931f3` revert, both outside this plan's own commit set - see Deviations)

**Plan metadata:** (this commit, docs: complete plan)

## Files Created/Modified

- `playwright.config.ts` - `use.trace` value changed from `on-first-retry` to `retain-on-failure`; nothing else touched
- `src/lib/e2eFlow.ts` - `skill-name-drift` entry removed from `TODO_LEDGER`, one-line hand-maintained doc comment added above the declaration

## Verification Evidence

**Task 1:**
```
node -e "... retain-on-failure present, no ^\s*retries\s*: line ..." -> ok
make test-e2e -> 203 passed (2.0m)
git diff --numstat playwright.config.ts -> 1  1  playwright.config.ts
git diff --stat .github/workflows/ci.yml -> (empty)
```

**Task 2:**
```
TODO_LEDGER ids: readme-slide-export-conflict, monorepo-extraction-deferred,
  native-tauri-e2e-runner-missing, hub-connector-deferred-local-first, stage-baseline-gaps
grep -c 'status: "done"' src/lib/e2eFlow.ts -> 0
grep -c "skill-name-drift" src/lib/e2eFlow.ts -> 0
grep -B1 "^const TODO_LEDGER" -> "/** Hand-maintained: edited as flow gaps are found and closed, not derived from README or REQUIREMENTS. */"
pnpm test -- src/lib/e2eFlow.test.ts -> 188 test files passed (1853 tests), including the readme-slide-export-conflict assertion
pnpm typecheck -> clean exit
```

**Task 3 (GATE-04, D-13 empirical proof, executed by the team lead per this plan's no-push constraint):**
- CI run: https://github.com/STAIxBWLB/maru/actions/runs/32559390372, triggered via `workflow_dispatch` on `gsd/phase-1-trustworthy-verify-signal` (head `489aa6b`), since `ci.yml`'s `push` trigger is scoped to `branches: [main]` and a feature-branch push does not run CI on its own
- "Run verify" -> success; "Run e2e" -> failure; "Upload e2e artifacts on failure" -> success
- Artifact: `playwright-report`, 411,208 bytes, artifact id `9472520034`
- Trace path inside the artifact: `test-results/smoke-boots-the-sample-wor-5acf6--opens-multiple-editor-tabs-chromium/trace.zip`
- Confirmed non-empty and real: 1,752,382 bytes uncompressed, 14 entries including `0-trace.network` (471,331 bytes), `0-trace.stacks`, and 7 `resources/page@*.jpeg` screenshots
- No-retry confirmation: e2e summary line reads `1 failed` / `202 passed (7.2m)`, no flaky/retry line, no second attempt for the failing test - the D-12 no-retry property held under the new trace mode
- Probe lifecycle: `e711b59` added the deliberately-failing assertion to `e2e/smoke.spec.ts`; `71931f3` reverted it; `git diff c82b093 HEAD -- e2e/smoke.spec.ts` is empty (byte-identical to pre-probe)

## Decisions Made

- `retain-on-failure` over `on-first-retry` + `retries`, per D-12, holding the no-retry signal the suite earned at v0.4.58 (193/193 first-attempt). The CI probe is the empirical confirmation this trade-off actually works: the trace landed without needing a second attempt.
- `skill-name-drift` deleted outright rather than marked `status: "done"` - GATE-07 requires the shipped ledger to list only open items, not a history of resolved ones.
- The CI proof used `workflow_dispatch` rather than a plain feature-branch push, because `ci.yml`'s `push` trigger only fires on `main`. This is a fact about the existing workflow, not a change made by this plan.

## Deviations from Plan

### Auto-fixed Issues

None - Tasks 1 and 2 executed exactly as written, no deviation-rule fixes needed.

### Process note (not a code deviation)

**1. Task 3's CI push and revert were performed by the team lead, not the plan executor**
- **Found during:** Task 3 (checkpoint:human-verify)
- **Reason:** This plan's environment notes explicitly forbid `git push` and any PR interaction by the executor - GATE-04's proof requires pushing a deliberately-failing spec to observe a real CI run, which is the orchestrator's/user's call. The executor halted at the checkpoint and returned the exact manual steps; the team lead ran them (`e711b59` probe commit, `workflow_dispatch` run, `71931f3` revert) and supplied the CI run URL, artifact name, and trace path back to the executor.
- **Verified by the executor independently:** `git log` confirms both commits exist on the branch and `git diff c82b093 HEAD -- e2e/smoke.spec.ts` is empty, so the revert is byte-identical as required by Task 3's acceptance criteria.

**2. A pre-existing gate from plan 01-02 (GATE-01) blocked the first CI dispatch, unrelated to this plan's files**
- **Found during:** the first CI dispatch attempt (run `32558565444`), before the successful run above
- **Issue:** `make verify` failed at the `clippy` target (added in 01-02) with 9 Linux-only `dead_code` errors in `browser_passkeys.rs`, `site_view.rs`, and a `lib.rs` import - macOS-only code whose call sites compile out on `ubuntu-22.04`, a platform this repo's local dev machine (macOS) never exercises for that gate.
- **Fix:** commit `489aa6b`, `fix(01-02): gate macOS-only site_view and passkey helpers behind cfg` - `#[cfg(target_os = "macos")]` on the affected items, no `allow` escapes (D-08 respected). This commit is attributed to plan 01-02/GATE-01, not to this plan; it is recorded here because it is why GATE-04's proof took two CI runs, and it is the first defect the new clippy gate actually caught in CI.
- **Files modified (by the team lead, not part of this plan's own commit set):** `src-tauri/src/browser_passkeys.rs`, `src-tauri/src/lib.rs`, `src-tauri/src/site_view.rs`.

---

**Total deviations:** 0 auto-fixed within this plan's own scope. 2 process notes recorded for traceability (checkpoint execution split between executor and team lead per explicit no-push instruction; one unrelated pre-existing-gate fix surfaced by the same CI run and already committed under 01-02).
**Impact on plan:** None on GATE-04/GATE-07 scope or correctness. No files outside `playwright.config.ts` and `src/lib/e2eFlow.ts` were touched by this plan's own commits.

## Issues Encountered

None beyond the two process notes documented above as deviations.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GATE-04 and GATE-07 fully satisfied. `make verify`'s e2e path now leaves a real, downloadable trace on any first-attempt CI failure, with the no-retry signal intact.
- The E2E flow ledger shipped in `todos.json` no longer carries a stale claim; `native-tauri-e2e-runner-missing` remains open and correctly tracked as v2 scope.
- No blockers for the remaining Phase 1 plans (01-04 through 01-07).

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*

## Self-Check: PASSED

- Commit `c8c9c59` (Task 1): found in `git log --oneline --all`
- Commit `c82b093` (Task 2): found in `git log --oneline --all`
- Commit `e711b59` (Task 3 probe): found in `git log --oneline --all`
- Commit `71931f3` (Task 3 revert): found in `git log --oneline --all`
- `.planning/phases/01-trustworthy-verify-signal/01-03-SUMMARY.md`: exists
- `playwright.config.ts` contains `retain-on-failure`, no `retries` key
- `src/lib/e2eFlow.ts` TODO_LEDGER has 5 entries, no `skill-name-drift`
