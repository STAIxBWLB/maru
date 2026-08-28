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

## Cross-Milestone Trends

### Process Evolution

| Milestone | Sessions | Phases | Key Change |
| --- | --- | ---: | --- |
| v1.0 | not tracked | 5 | Verification-first structural refactoring with native closeout evidence |

### Cumulative Quality

| Milestone | Tests | Coverage | Zero-dependency additions |
| --- | --- | --- | ---: |
| v1.0 | 1,942 Vitest, 1,225 Rust, 203 Playwright, 76 terminal matrix | reporting not configured | 0 state libraries |

### Top Lessons

1. Treat direct native observations as first-class phase artifacts.
2. Keep validation metadata current with implementation verification.
