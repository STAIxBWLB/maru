# Project Retrospective

*A living document updated after each milestone. Lessons feed forward into future planning.*

## Milestone: v1.0 - Structural Debt Paydown

**Shipped:** 2026-08-28
**Phases:** 5 | **Plans:** 32 | **Tasks:** 74

### What Was Built

- A trustworthy `make verify` chain with pinned Rust, fmt/clippy, ESLint, full TypeScript project coverage, CI trace capture, and bundle/startup budgets.
- Shared Rust scanner/path invariants and a typed cross-language IPC error contract.
- Store-backed Outline, Editor, Documents, and Terminal facades with real-shell render isolation.
- An 18-mode lazy registry that removes mode routing and pane-local ownership from `MainApp`.
- Automated, security, Nyquist, browser E2E, extensibility, and native D-20 closeout evidence.

### What Worked

- Red-then-green gate drills proved failure detection instead of treating a green suite as sufficient evidence.
- Keyed external stores and stable command ports matched existing architecture and avoided a new state library.
- Goal-backward verification and adversarial review found integration and native-wire issues before closeout.
- Disposable native workspaces made direct filesystem, PTY, lazy-placement, and render-isolation checks safe.

### What Was Inefficient

- The shared checkout contained unrelated concurrent changes, so composite verification required repeated scope checks and careful explicit staging.
- Early native approval lacked per-flow observations, requiring a second direct D-20 run before Phase 5 could pass verification.
- Phase 01-03 validation metadata was not reconciled when those phases completed, leaving Nyquist closeout evidence inconsistent.
- The automatically generated milestone accomplishments were too granular and included one malformed summary line; closeout required manual distillation.

### Patterns Established

- Architectural invariants belong in normal tests: hook ceilings, prop budgets, import direction, render counts, and lazy registry exhaustiveness.
- Runtime handles and channels stay outside serializable stores; snapshots contain only observable state.
- Native-only behavior requires explicit granular observations, not a bare approval marker.
- Production extensibility drills must restore touched files in a `finally` boundary and assert shell byte identity.

### Key Lessons

1. Capture native observations at the original checkpoint; a yes/no approval is not reusable verification evidence.
2. Run validate/security reconciliation as each phase closes so milestone audit measures evidence, not stale metadata.
3. Keep implementation, verification, and unrelated checkout changes separately staged throughout a parallel milestone.
4. Distill milestone accomplishments by phase outcome rather than copying every plan summary.

### Cost Observations

- Model mix: not tracked by the available milestone artifacts.
- Sessions: not tracked reliably; 163 milestone commits across 7 calendar days.
- Notable: Phase 5's final plan took the longest because it combined architecture enforcement, extensibility drills, review fixes, and native verification.

---

## Milestone: v1.1 - Felt Quality and Native Proof

**Shipped:** 2026-09-27
**Phases:** 6 | **Plans:** 56 | **Tasks:** 64

### What Was Built

- A native WebDriver e2e suite that drives the real app's WKWebView DOM, PTY, IME composition, and menu commands, runs unattended on hosted macOS for `main` and release tags, and gates `release-preflight`.
- Poison recovery on six named locks, generated-tree pruning at every recursive watcher, a sanitizer provenance gate, and an inbox-free document index.
- Main-thread isolation for every production command (383 today), with per-command evidence gated in `make verify` and a negative-controlled native load test.
- A process-group terminal kill ladder, one shared autosave saver flushed on unmount and quit, one quit guard, and recovery copies for failed teardown saves.
- A `'self'`-only shipped `script-src`, per-mode lazy CSS inside the unchanged budget, non-gating coverage, and the retired v1.0 evidence debt.

### What Worked

- Deciding CI placement with a spike: the hosted-macOS session established on the first attempt, and Phases 8 and 9 then verified against the real app (responsiveness and quit specs) instead of a human at the keyboard.
- Landing guardrails before churn: the sanitizer guard later covered the #379 HWPX preview sink with no change, and lock recovery was in place before Phase 8 rewrote the registry lock region.
- Recorded per-command evidence turned PERF-01 into a checkable claim, and the count gate flagged every later command addition (`write_recovery_copy`, #379, #384) as an explicit evidence update.
- Owner real-app checks found what no automated check covered: the main window could never close (`core:window:allow-destroy` was missing) and foreground jobs escaped the quit sweep.
- The audit's integration check found a real cross-phase gap (recovery copies firing watcher events), and it was fixed in #390 before close.

### What Was Inefficient

- Nyquist metadata for four phases stayed `draft` until the audit, the same debt VALID-01 retired for v1.0; closing it took a separate PR (#391).
- The native e2e job only started failing on a failed spec with #385, so hosted-runner flakes (#388) surfaced at the end of the milestone rather than as they appeared.
- Phase 8 ran 29 plans in 29 sequential waves, which made it the longest phase by far.
- Agent worktrees installed with pnpm's global virtual store broke `pnpm typecheck`, and the first reading blamed the code.
- Auto-generated accomplishments again came out too granular (22 plan-level lines) and needed manual distillation, and phase archival moved an input of a live gate: `check-command-isolation` reads the Phase 8 inventory, so its path had to follow the archive at close.

### Patterns Established

- A spike verdict is recorded as a settled fact that later phases plan their verification against.
- Gate inputs are committed evidence (`docs/performance/*.json`), never hand-edited to make a run pass.
- Ship-time properties get two-half guards: a source or dist scan in the normal build plus an artifact scan in `release-checks` (CSP, native-e2e isolation).
- Every autosave surface goes through one shared saver and one teardown flush hook; there is one quit guard.
- Evidence lives in the repo, not in expiring CI artifacts.

### Key Lessons

1. Reconcile Nyquist metadata at each phase transition; the v1.0 lesson was written down but not applied.
2. Make a failing check fail the job from its first run, or its flakes accumulate unseen.
3. Keep live gate inputs out of directories that milestone close archives.
4. Native e2e narrows but does not replace owner real-app checks for macOS-only behavior.

### Cost Observations

- Model mix: not tracked by the available milestone artifacts.
- Sessions: not tracked reliably; 121 commits on `main` across 30 calendar days, including parallel product releases.
- Notable: Phase 8 carried 29 of the 56 plans.

---

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
| --- | --- | ---: | --- |
| v1.0 | not tracked | 5 | Verification-first structural refactoring with native closeout evidence |
| v1.1 | not tracked | 6 | Behavior-changing work proven in the real app by a spike-placed native e2e suite and recorded evidence |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-dependency additions |
| --- | --- | --- | ---: |
| v1.0 | 1,942 Vitest, 1,225 Rust, 203 Playwright, 76 terminal matrix | reporting not configured | 0 state libraries |
| v1.1 | 2,186 Vitest (228 files), 1,800 Rust lib (both at the Phase 11 baseline), 8 native e2e spec files | TS lines 61.0%, Rust lines 90.5% (non-gating) | 0 state libraries |

### Top Lessons

1. Treat direct native observations as first-class phase artifacts.
2. Keep validation metadata current with implementation verification. This recurred in v1.1, so reconcile it at each phase transition, not at the audit.
3. Make a failing check fail the job from its first run.
