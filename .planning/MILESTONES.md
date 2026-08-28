# Project Milestones: maru

## v1.0 Structural Debt Paydown (Shipped: 2026-08-28)

**Delivered:** A trustworthy refactor gate, shared Rust invariants, typed IPC errors, and a store-backed shell where pane state and 18 lazy modes no longer require `MainApp` ownership.

**Phases completed:** 1-5 (32 plans, 74 tasks)

**Key accomplishments:**

- Made `make verify` authoritative with pinned Rust, fmt/clippy, ESLint, complete TypeScript project coverage, and CI trace capture.
- Consolidated generated-directory pruning and lexical containment into shared Rust invariants consumed across scanner and home-path boundaries.
- Replaced branched-on string-prefix errors with a cross-language `{ code, message }` contract and rename-fails-the-build drills.
- Moved Outline and Editor state behind four-input facades with real-`MainApp` render isolation and preview DOM-identity regression coverage.
- Completed `DocumentList`, terminal, and 18-mode lazy registry extraction; `MainApp` is held to 15 `useState` and 24 `useEffect` calls.
- Passed 24/24 requirements, 5/5 phase verifications, integration 8/8, E2E flows 5/5, and native D-20 UAT 5/5.

**Stats:**

- 318 files changed
- 35,155 insertions and 3,936 deletions
- 276,964 current lines across TypeScript, TSX, Rust, and project scripts/E2E
- 5 phases, 32 plans, 74 tasks, 163 commits
- 7 calendar days (2026-08-22 to 2026-08-28)

**Git range:** `2d2e866` to `363f8a6`

### Accepted technical debt

- Re-run a deliberate failing CI E2E against the shipped narrowed Playwright trace configuration.
- Reconcile Phase 1-3 Nyquist metadata with `$gsd-validate-phase`.
- Add a Phase 2 security report if uniform milestone security evidence is required.

### Post-close amendment: v0.5.0

- Closed ERR-06 in PR #283 by preserving typed conflict codes across every
  conflict-emitting command and normalizing the remaining frontend API funnel.
- Added a recursive Rust source guard with direct red-probe evidence, plus a
  Phase 3 security report with seven threats closed and `threats_open: 0`.
- Published the milestone summary and rewrote README.md against the shipped
  18-mode architecture, current safety contracts, and release pipeline.
- Kept the planning milestone tag `v1.0` immutable at its archive commit;
  product release `v0.5.0` is the commemorative distribution tag.

**What's next:** No next milestone is selected. Start discovery with `$gsd-new-milestone`.

---
