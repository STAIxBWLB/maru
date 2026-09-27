# Project Milestones: maru

## v1.1 Felt Quality and Native Proof (Shipped: 2026-09-27)

**Delivered:** Maru stops freezing, ends terminal sessions cleanly on close and quit, flushes pending saves on teardown and keeps a recovery copy when a save fails (one known gap remains: #381), and proves it with a native e2e suite that drives the real app on hosted macOS instead of a human at the keyboard.

**Phases completed:** 6-11 (56 plans, 64 tasks)

**Closeout:** audit status `tech_debt`, debt accepted by the owner on 2026-09-27. Requirements 17/17, phases 6/6, integration 14/15, flows 4/5; the one partial link (recovery-copy watcher churn) was fixed in PR #390 before close. Nyquist compliant for all six phases after PR #391.

**Key accomplishments:**

- A native WebDriver runner drives the real app's WKWebView DOM, a real PTY (text mirror plus canvas ink check), synthetic IME composition, and menu commands. The spike verdict is `ci-viable`: the full suite runs unattended on `main` and release tags and gates `make release-preflight`.
- Six named process-global locks recover from poisoning, one `is_under_generated_dir` predicate prunes generated trees at all five recursive watchers, `check-dom-sanitizer` gates `make verify`, and the inbox root is out of the document index on all three index paths.
- `skills_sync_source` releases `REGISTRY_LOCK` across its network round-trip and reloads fresh before writing. All 383 production commands carry isolation evidence (374 ISOLATED, 9 UI) gated by `check-command-isolation`, and the native load test keeps an unrelated command's p95 at 2 ms against a 4,789 ms negative control.
- SIGHUP-trapping terminals die through a process-group kill ladder with a quit sweep. Every autosave surface saves on unmount and quit through one shared saver, Cmd+Q and window close share one guard with a 3 s flush budget, and a failed teardown save keeps a `.maru/recovery/` copy and raises a toast.
- The shipped CSP `script-src` is `'self'`, enforced by `check-csp-blob`. Per-mode CSS rides each mode's lazy chunk, leaving the entry CSS at 45 KiB gzip against the unchanged 70 KiB budget.
- Coverage is measured without gating (`make coverage`, push-to-main `coverage.yml`), the narrowed Playwright trace is re-proven by a deliberate CI failure, and v1.0's evidence debt (Nyquist 01-03, Phase 02 security report) is retired.

**Stats:**

- 673 files changed on `main` over the range, 299 of them in `src`, `src-tauri`, `scripts`, `e2e` and `e2e-native`
- 191,407 insertions and 22,212 deletions, including committed evidence JSON and parallel product work
- 354,955 current tracked lines across TypeScript, TSX, Rust, and `.mjs` scripts
- 6 phases, 56 plans, 64 tasks, 121 commits
- 30 calendar days (2026-08-29 to 2026-09-27)
- Product releases v1.1.0 through v1.1.12 shipped during the milestone (v0.6.0 and v0.6.1 before the numbering realignment)

**Git range:** `dd86036e` to `1aea53b7`

Known verification overrides: 1 newly acknowledged, 0 carried forward from a prior close (see STATE.md Deferred Items)

### Accepted technical debt

The full register is the frontmatter `tech_debt` list in
`milestones/v1.1-MILESTONE-AUDIT.md`. The open items:

- Native e2e hosted-runner flakes: pty.spec and menu.spec `terminal.split` (#388). `native-e2e.yml` has no `paths-ignore`, so docs-only pushes run the full macOS suite.
- Phase 7 review info findings IN-01..IN-04.
- Phase 8: WR-01 (the skills sync commit tail holds `REGISTRY_LOCK` across a git subprocess and a checkout hash), the pre-existing `--plan 05` evidence drift, and a native load harness that covers three allowlisted ops rather than every isolated command.
- Phase 9: Dock-icon Quit and system logout bypass the webview quit guard; the Scratchpad localStorage mirror is the safety net.
- Phase 10: `check-csp-blob --binary` cannot read the shipped release binary (Linux evidence owner-accepted), `.empty-state` has two entry-side homes, and most CSS ownership pins are source-string checks.
- Phase 11: agent worktrees installed with pnpm's global virtual store fail `pnpm typecheck` (acknowledged at close as a deferred item).
- Post-phase follow-ups: #380, #381, #382, #386, #387, #389, hwp-cli#385, maru-hub#8.

Resolved before close: the `.maru/recovery` watcher churn (PR #390), draft Nyquist metadata for phases 06, 07, 09 and 11 (PR #391), and the stale README command-count and milestone rows (#374, closeout PR).

### Closeout notes

- No `v1.1` tag was created (`git.create_tag: false`); the `v*` namespace stays with releases.
- Phase directories moved to `milestones/v1.1-phases/`. `check-command-isolation` now reads the Phase 8 command inventory and plan map from `milestones/v1.1-phases/08-main-thread-responsiveness/`.

**What's next:** Milestone v1.2, scope being defined by the owner. Opening it moves releases to 1.2.0.

---

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

### Post-close amendment: numbering realignment (2026-08-30)

- Superseded the line above about keeping `v1.0` immutable. The tag was deleted
  from origin and locally, because milestone tags and release tags shared the
  `v*` namespace and `v1.0` sorted above every real release, which broke the
  Homebrew tap audit on four consecutive releases.
- Milestone numbering and release versions are now aligned: milestone `vN.M`
  owns major and minor, releases own patch. Milestone v1.1 ships as `1.1.x`.
  The rule lives in README's Release Process section.
- Milestone completion no longer creates a git tag
  (`.planning/config.json` sets `git.create_tag: false`).
- Nothing unique was lost. The full v1.0 archive is on `main` under
  `.planning/milestones/v1.0-*`, and the tag annotation duplicated this entry.
- Note for anyone following the Git range above: `363f8a6` is not on `main`
  either. It lived on the deleted `ci/parallel-workflow-validation` branch.
  This predates the realignment.

**What's next:** Milestone v1.1 Felt Quality and Native Proof, phases 6-11.

---
