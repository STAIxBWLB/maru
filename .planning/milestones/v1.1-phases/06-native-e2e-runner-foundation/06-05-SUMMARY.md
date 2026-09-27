---
phase: 06-native-e2e-runner-foundation
plan: 05
subsystem: testing
tags: [webdriverio, github-actions, macos-ci, release-preflight, verdict-ratification, d-01, d-03, d-04, d-16]

requires:
  - phase: 06-01
    provides: "hosted spike workflow + spike log's first hosted pass (session establishment evidence)"
  - phase: 06-02
    provides: "pty.spec.ts — the PTY-through-canvas readability proof (D-01 condition 2)"
  - phase: 06-03
    provides: "ime.spec.ts + menu.spec.ts completing the four-spec suite, and the doc's IME sub-spike / macOS menu bar sections naming the human-attended halves (D-08)"
  - phase: 06-04
    provides: "ship-isolation guard inside make verify / release-checks that the release-preflight wiring inherits"
provides:
  - "Settled D-01 verdict: ci-viable, ratified item-by-item at a blocking human checkpoint with named per-condition evidence"
  - "native-e2e-compile job in ci.yml (macos-14, every PR, compiles/typechecks only — D-03)"
  - "native-e2e.yml with native-e2e-suite on main pushes, release tags, and workflow_dispatch; spike workflow retired (D-16)"
  - "make release-preflight blocking on make test-e2e-native on every machine (D-03, both verdict branches)"
  - "docs/native-e2e.md complete: seven sections plus ratification record and per-item human-checklist observations (D-04)"
  - ".planning/PROJECT.md CI reality constraint rewritten to the verdict, pointing at docs/native-e2e.md (D-04)"
affects: [Phase 8 (PERF-02/01 verification plans against docs/native-e2e.md), Phase 9 (REL-01 SIGHUP spec attaches to this runner; needs the checklist observations), Phase 10 (release-preflight evidence trail)]

actuals:
  tokens: 6255
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Three-condition verdict rule applied item-by-item at a blocking human checkpoint, with the evidence named per condition — a partial pass cannot be promoted (D-01, T-06-04)"
    - "CI placement written only after the record says which branch to write: compile job in both branches, gated suite workflow iff ci-viable (D-16)"
    - "Per-item observations recorded for human-attended checklist items, not a blanket approval (T-06-08; v1.0 retrospective lesson 1)"

key-files:
  created:
    - .github/workflows/native-e2e.yml
  modified:
    - .github/workflows/ci.yml
    - Makefile
    - docs/native-e2e.md
    - .planning/PROJECT.md
  deleted:
    - .github/workflows/native-e2e-spike.yml

key-decisions:
  - "Verdict ratified ci-viable: all three D-01 conditions evidenced on hosted macos-14 runs 33243419439 (1 spec) and 33250704926 (4 specs) — no TCC prompt, PTY read through canvas (pty.spec 1 passing, shell-produced marker + ink check), full unattended run (4 passed, 4 total)"
  - "Suite workflow lives in its own file rather than ci.yml: ci.yml's push trigger is scoped to branches [main], and adding a tag trigger there would change when the entire pipeline runs"
  - "release-preflight blocks on the native suite in both verdict branches; release-preflight-core and make verify deliberately untouched (the native target launches a real macOS app and cannot be hermetic, same reason verify-integration sits outside verify)"
  - "Known issue recorded app-side, not runner-side: first syllable after switching to the Korean 2-set input source arrives decomposed (suspected WKWebView IME-context attach race); the app's composition handlers are guarded by the 06-03 specs"

patterns-established:
  - "Verdict records live in exactly two places that must agree (docs/native-e2e.md + PROJECT.md CI reality); Phase 8/9 plan against these, not CONTEXT.md"
  - "Hosted-run modal detection by timing signature: zero TCC lines + failure-screencapture step skipped + normal duration, since a permission dialog can only be observed as a hang-to-timeout"

requirements-completed: [TEST-01]

coverage:
  - id: D1
    description: "D-03 compile job: native-e2e-compile in ci.yml on macos-14, gated by needs: decision + run_full, steps install/typecheck/lint/cargo check --locked --features native-e2e, never executes the suite"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "plan structural one-liner over ci.yml + Makefile (compile job present, macos-14, no suite invocation, release-preflight blocks on test-e2e-native, verify untouched)"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-16 gated full suite: native-e2e.yml native-e2e-suite on main pushes, v* tags, workflow_dispatch; spike workflow deleted; ci.yml diff purely additive"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "https://github.com/STAIxBWLB/maru/actions/runs/33250704926 — 4 passed, 4 total, unattended"
        status: pass
    human_judgment: false
  - id: D3
    description: "Blocking local release gate: make release-preflight fails when the native suite fails, in both verdict branches"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "make release-preflight exit 0 on macOS 2026-08-29 (attempt 4; attempts 1-3 failed only on two pre-existing flaky tests and a missing Playwright browser install, each green on rerun, none implicating phase 06)"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-04 records: docs/native-e2e.md (seven sections + ratification + per-item checklist observations) and PROJECT.md CI reality rewritten to the verdict, both pointing at each other"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "plan doc one-liners: all seven sections present, both make targets named, PROJECT.md no longer carries the pre-phase claim and points at docs/native-e2e.md"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-01 verdict ratification: three conditions answered individually with named evidence; human-attended checklist worked end to end with per-item observations"
    requirement: TEST-01
    verification:
      - kind: manual_procedural
        ref: "blocking human-verify checkpoint 2026-08-29 — approved with per-condition evidence and six per-item observations, recorded in docs/native-e2e.md '### Ratification' and '### Observations'"
        status: pass
    human_judgment: true
    rationale: "The absence of an interactive/TCC permission prompt is only observable by looking (plan Task 3); per-item checklist observations are required by T-06-08 and the v1.0 retrospective"

duration: cross-session (checkpoint-gated)
completed: 2026-08-29
status: complete
---

# Phase 06-05: CI Placement, Release Gate, and Verdict Ratification Summary

**The native runner's CI-vs-local scope is now a settled written fact: the spike verdict ratified `ci-viable` item-by-item at a blocking human checkpoint, a macOS compile job guards every PR, the full suite runs unattended on `main` and release tags, `make release-preflight` blocks on the suite (exit 0 recorded), and both records Phase 8/9 will read say the same thing.**

## Performance

- **Duration:** cross-session — prep/Tasks 1-2 executed in a prior session, which stopped at the blocking Task 3 checkpoint; ratification evidence gathered by direct human verification and recorded in this session
- **Started:** 2026-08-29 (prior session)
- **Completed:** 2026-08-29T13:09Z
- **Tasks:** 3/3 (+ prep task)
- **Commits:** 5 (9774bef prep, 8231f8d Task 1, 874420b Task 2, 20ec2ff Task 3 record-keeping, plus the plan-metadata commit)
- **Files modified:** 6 (ci.yml, native-e2e.yml created, native-e2e-spike.yml deleted, Makefile, docs/native-e2e.md, PROJECT.md)

## Accomplishments

- **Verdict settled and ratified `ci-viable`.** Prep ran the full four-spec
  suite on the hosted runner (attempt 2 of the capped 3): run 33250704926,
  `4 passed, 4 total`, no human present. The blocking checkpoint then
  ratified D-01's three conditions **individually with named evidence** —
  zero TCC/permission lines and a skipped failure-screencapture step in both
  hosted runs (a modal can only appear as a hang-to-timeout), `pty.spec.ts 1
  passing (4.7s)` with the shell-produced marker plus canvas ink check, and
  the full unattended `workflow_dispatch` run. Recorded in
  `docs/native-e2e.md` `### Ratification`.
- **CI placement matches the verdict exactly.** `ci.yml` gained
  `native-e2e-compile` on `macos-14` (install, typecheck, lint,
  `cargo check --locked --features native-e2e`; never runs the suite — D-03),
  with a purely additive diff (0 deleted lines; `verify` and `e2e` jobs
  untouched). `native-e2e.yml` runs `native-e2e-suite` on `main` pushes,
  `v*` tags, and `workflow_dispatch` (D-16); `native-e2e-spike.yml` is
  deleted, superseded.
- **`make release-preflight` blocks on the native suite** on every machine
  (both verdict branches, D-03); recorded exit code **0** on macOS. Attempts
  1-3 failed only on two pre-existing flaky tests (editorSurfaceRenderIsolation
  vitest timing; graph.spec ghost-node under parallel load) and a missing
  Playwright browser install — each passed on rerun; none implicate phase 06
  changes.
- **Both verdict records written and in agreement** (D-04):
  `docs/native-e2e.md` completed around the existing spike-log/sub-spike
  sections (scope, how to run, which target runs which suite, CI placement,
  human-attended checklist, known limits), and `.planning/PROJECT.md`'s
  `CI reality` bullet rewritten to the verdict in three lines, pointing at
  the document; no other constraint touched.
- **Human-attended checklist worked end to end** with per-item observations
  (T-06-08): menu-bar click-through (Documents, New Shell, Split Terminal)
  all PASS with before/after DOM states recorded; OS-IME items PASS, with one
  known issue (below).

## Known issue (app-side, not a runner defect)

The first syllable typed immediately after switching the input source from
English to Korean 2-set arrives decomposed (ㅎㅏㄴ as raw jamo instead of
composed 한); from the second character onward composition is normal, and the
committed word lands exactly once. Suspected WKWebView IME-context attach
race on input-source switch. Recorded in `docs/native-e2e.md`
`### Observations — 2026-08-29`, item 4. The app's composition handlers
remain guarded by the 06-03 specs; this is an OS-engine attach-timing issue
for a future phase, not a gap in the runner.

A measurement note for whoever works the checklist next: the debug binary and
the installed Maru.app share a process name — probes that target the process
by name hit the wrong app; all recorded results used PID-targeted
accessibility calls.

## Task Commits

1. **Prep: Settle the spike verdict with a full-suite hosted run** — `9774bef` (test)
2. **Task 1: CI placement per the verdict, and the blocking local release gate** — `8231f8d` (feat)
3. **Task 2: Write the verdict into the two places Phase 8 and Phase 9 will read** — `874420b` (docs)
4. **Task 3: Ratify D-01's three conditions and the recorded verdict** (blocking human-verify, APPROVED) — `20ec2ff` (docs: record-keeping)

**Plan metadata:** recorded in the final docs commit alongside this SUMMARY.

## Files Created/Modified

- `.github/workflows/native-e2e.yml` — created: `native-e2e-suite` on
  `macos-14`, triggers `main` push / `v*` tags / `workflow_dispatch`, runs
  `make test-e2e-native`, uploads wdio output on failure
- `.github/workflows/ci.yml` — additive `native-e2e-compile` job (48 added
  lines, 0 deleted)
- `.github/workflows/native-e2e-spike.yml` — deleted (superseded; verdict
  settled ci-viable)
- `Makefile` — `release-preflight` recipe invokes `test-e2e-native`;
  `release-preflight-core` and `verify` untouched
- `docs/native-e2e.md` — completed per D-04: seven required sections plus
  `### Ratification` (per-condition evidence, preflight exit code, CI
  reconfirmation) and `### Observations — 2026-08-29` (six per-item checklist
  results + the known IME issue)
- `.planning/PROJECT.md` — `CI reality` bullet rewritten to the verdict,
  pointing at `docs/native-e2e.md`

## Decisions Made

- Suite workflow placed in its own file, not `ci.yml`: `ci.yml`'s push
  trigger is scoped to `branches: [main]`, and adding a tag trigger there
  would change when the entire pipeline runs (plan-directed, recorded here
  for Phase 10's release work).
- `release-preflight` gating landed identically in both verdict branches
  before branching on the verdict, per D-03 — the local gate is
  verdict-independent.
- The known IME first-syllable issue was classified app-side rather than a
  runner defect, because the runner's synthetic-composition specs (06-03)
  guard the app's handlers and the issue only manifests on real OS-engine
  input-source switch.

## Deviations from Plan

None — plan executed exactly as written. The only pre-existing interference
was the flaky-test noise during `make release-preflight` attempts 1-3, which
the plan's own verification anticipated (exit code recorded; flakes are
pre-existing and out of scope per the deviation scope boundary).

## Issues Encountered

- `make release-preflight` attempts 1-3 failed on two pre-existing flaky
  tests (editorSurfaceRenderIsolation vitest timing, graph.spec ghost-node
  under parallel load) and a missing Playwright browser install; each passed
  on rerun and attempt 4 exited 0. None implicate phase 06 changes; left
  un-fixed per the scope boundary (out-of-scope discoveries).
- Pre-existing uncommitted modifications to `docs/design-qa/*.png` in the
  working tree predate this plan; left untouched and uncommitted (same
  handling as 06-03).

## User Setup Required

None.

## Next Phase Readiness

- **Phase 8 and Phase 9 can plan against the two records without reading this
  phase's CONTEXT** (the D-04 success criterion): `docs/native-e2e.md` says
  what the runner covers, how to run it, and what a human must still do;
  `PROJECT.md` says the same in one bullet.
- Phase 9's REL-01 SIGHUP spec attaches to the runner's four-surface
  mechanics (D-14); the checklist observations (including the PID-targeting
  note and the IME known issue) are recorded where Phase 9 will read them.
- The `native-e2e-suite` job on `main`/tags carries ongoing proof of D-01
  condition 3; a future regression there is a signal, not a silent gap.
- No blockers.

---
*Phase: 06-native-e2e-runner-foundation*
*Completed: 2026-08-29*

## Self-Check: PASSED

- All plan artifacts confirmed on disk: native-e2e.yml present, native-e2e-spike.yml confirmed deleted, docs/native-e2e.md carrying all seven required sections plus ### Ratification and ### Observations, PROJECT.md CI reality rewritten, 06-05-SUMMARY.md written.
- All four task commits found in git log: 9774bef (prep), 8231f8d (Task 1), 874420b (Task 2), 20ec2ff (Task 3 record-keeping).
- Verify evidence: all four plan one-liners exit 0 after the Task 3 doc edits (ci.yml/Makefile gates intact; ciViable/suite-present/spike-absent consistency; seven sections + both make targets; PROJECT.md constraint current).
