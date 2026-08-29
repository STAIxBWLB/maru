# Roadmap: maru

## Milestones

- [x] **v1.0 Structural Debt Paydown** - Phases 1-5, 32 plans, shipped 2026-08-28. [Archive](milestones/v1.0-ROADMAP.md)
- [ ] **v1.1 Felt Quality and Native Proof** - Phases 6-11, in progress (started 2026-08-29).

## Active Milestone

### v1.1 Felt Quality and Native Proof

**Goal:** Maru stops freezing, stops losing terminal sessions and unsaved text, and proves it in the runtime users actually run rather than through a human driving the app by hand.

**Constraint:** Unlike v1.0, this milestone deliberately changes observable behavior. `make verify` staying green is a floor, not a success criterion; each phase's success criteria state what is newly true that was not true before, in terms someone could check, not merely that nothing else broke.

**Phase Numbering:** Continues from v1.0, which ended at Phase 5. v1.1 spans Phase 6 through Phase 11.

## Phases

- [x] **Phase 6: Native E2E Runner Foundation** - A native runner drives the real app against the real backend, and the CI-vs-local question is settled by a spike rather than assumed. (completed 2026-08-29)
- [ ] **Phase 7: Guardrails Before Churn** - Lock poisoning recovers, watchers prune generated directories, and a sanitizer guard lands before the milestone's own later work can trip it.
- [ ] **Phase 8: Main-Thread Responsiveness** - The skills registry lock narrows and the main-thread-blocking commands move off it, proven by a concurrency load test rather than the absence of a visible freeze.
- [ ] **Phase 9: Durability and Session Lifecycle** - A SIGHUP-trapping terminal can still be killed, and a pending edit is saved (or its failure surfaced) on unmount and app quit.
- [ ] **Phase 10: Bundle and Build Hardening** - The packaged CSP drops an unused directive and per-mode CSS restores the budget headroom spent since v0.4.46.
- [ ] **Phase 11: Milestone Verification & Evidence** - Coverage is measured, the narrowed CI trace configuration is proven, and v1.0's closeout evidence debt is retired.

## Phase Details

### Phase 6: Native E2E Runner Foundation

**Goal**: A native test runner drives the real application (WKWebView DOM, a real PTY, and IME input) against the real Rust backend, and the milestone knows whether any part of it can run unattended in CI rather than assuming it can.
**Depends on**: Nothing (first phase of v1.1)
**Requirements**: TEST-01
**Uncertainty**: HIGH. Research did not converge on whether the embedded WebDriver provider runs unattended on a hosted macOS CI runner or requires a human-attended local target; this phase's first slice is the CI-viability spike that decides it, and the phase plan must not presuppose the answer.
**Success Criteria** (what must be TRUE):

  1. A CI-viability spike has run the embedded WebDriver provider against a hosted macOS runner and produced a definitive answer (not an assumption) on whether a session establishes with no interactive permission prompt.
  2. A real PTY's output is readable through a canvas-based pixel assertion, since the terminal renders to `<canvas>` and DOM queries cannot see it.
  3. A full run of whatever subset the spike proves out completes with no human present; if the spike fails instead, exactly one local-only runner target exists and is wired into `release-preflight`.
  4. A separate IME-composition sub-spike shows whether synthetic key events can substitute for real OS-level IME input, or whether that surface also needs human attendance.
  5. The runner's CI-vs-local scope is recorded as a settled fact that Phase 8 and Phase 9 plan their own verification against, not an assumption carried forward.

**Plans**: 5/5 plans executed in 4 waves

Plans:
**Wave 1**

- [x] 06-01-PLAN.md - Runner dependencies, fail-closed workspace isolation, and the CI-viability tracer (wave 1)

**Wave 2** *(blocked on Wave 1 completion)*

- [x] 06-02-PLAN.md - Real PTY: build-gated text mirror and canvas ink check (wave 2)

**Wave 3** *(blocked on Wave 2 completion)*

- [x] 06-03-PLAN.md - OS-owned input surfaces: IME sub-spike and the macOS menu-command path (wave 3)
- [x] 06-04-PLAN.md - Ship-isolation guard and the e2e-native TypeScript project (wave 3)

**Wave 4** *(blocked on Wave 3 completion)*

- [x] 06-05-PLAN.md - Recorded verdict, release-preflight gate, and CI placement (wave 4)

### Phase 7: Guardrails Before Churn

**Goal**: The locks, watchers, and sanitizer boundary that this milestone's own later work will stress are hardened first, so those later phases inherit a safety net instead of a race to add one after an incident.
**Depends on**: Nothing (independent of Phase 6; sequenced early so SEC-02 is in place before the refactor churn in Phases 8-10)
**Requirements**: PERF-03, PERF-04, SEC-02
**Success Criteria** (what must be TRUE):

  1. A panic while holding any of the six named process-global locks (`REGISTRY_LOCK`, `JOBS_LOCK`, `DOT_ACTION_LOCK`, `BINDER_WRITE_LOCK`, and the terminal registry and killer locks) leaves that lock's feature usable on the next call instead of bricked until app restart, with each lock's recovery justified on its own terms rather than a blanket copy-paste.
  2. A recursive filesystem watcher generates no events for paths under the shared `GENERATED_DIRS` prune list, so a watched root that grows a heavy generated subtree does not become an event-volume bottleneck.
  3. `make verify` fails the moment a new `dangerouslySetInnerHTML` value in `src/` does not trace to a DOMPurify-backed helper, proven by a deliberate red-then-green break of the guard itself.

**Plans**: TBD

### Phase 8: Main-Thread Responsiveness

**Goal**: The skills registry lock stops being held across a network round-trip, and commands that reach the network, a subprocess, or an unbounded filesystem walk stop blocking the main thread.
**Depends on**: Phase 7 (PERF-02 rewrites the same `store.rs` function region PERF-03 touches); benefits from Phase 6 (PERF-01's success criterion is a concurrency load test the native runner is positioned to drive)
**Requirements**: PERF-02, PERF-01
**Success Criteria** (what must be TRUE):

  1. `skills_sync_source` releases `REGISTRY_LOCK` for the duration of its network round-trip, and a source removed while a sync is in flight is not resurrected by that sync's write-back after the lock is re-acquired.
  2. Every command that reaches the network, a subprocess, or an unbounded filesystem walk is off the main thread. The 37 commands counted during research are the known set at kickoff, not the definition: that count came from scanning each command's first 80 lines, so a command that blocks further down is equally in scope and the set must be re-measured when the phase starts.
  3. A concurrency load test fires several converted commands at once and shows an unrelated command's latency stays flat (not merely the absence of a visible freeze, which cannot by itself distinguish a real fix from one that relocated the block onto Tauri's shared async worker pool).

**Plans**: TBD

### Phase 9: Durability and Session Lifecycle

**Goal**: A terminal child that traps SIGHUP can still be killed, and no pending edit is silently lost when a pane unmounts or the app quits.
**Depends on**: Phase 6 (REL-01's SIGHUP-trap-and-kill claim is only verifiable against a real PTY; the mocked-IPC suite cannot spawn one)
**Requirements**: REL-01, REL-02, REL-03
**Uncertainty**: MEDIUM on REL-01. Research could not verify `portable_pty`'s spawn-time process-group setup, and the existing `command_output.rs` escalation pattern targets `std::process::Command`, so it cannot be assumed to port unchanged; needs a source-level confirmation before implementation.
**Success Criteria** (what must be TRUE):

  1. A terminal child that traps SIGHUP is still killed, via a timeout-gated process-group escalation, while a deliberately backgrounded grandchild still survives tab close and the generation-token invariant still holds.
  2. A pending debounced editor save is performed (not merely cancelled) both when its pane unmounts and when the application quits, with the quit path driven from the Rust side rather than a webview unload handler.
  3. A save that fails on a teardown path produces a visible signal to the user (log, toast, or equivalent) instead of disappearing with no trace.

**Plans**: TBD

### Phase 10: Bundle and Build Hardening

**Goal**: The shipped bundle carries a tighter CSP and its original CSS budget headroom back, both verified against the packaged build rather than the dev server.
**Depends on**: Nothing (independent of the native-verification chain)
**Requirements**: SEC-01, PERF-05
**Success Criteria** (what must be TRUE):

  1. `script-src 'self' blob:` is absent from the CSP measured against a packaged production build, if nothing in that build still requires it.
  2. Per-mode CSS ships inside that mode's own lazy chunk instead of the entry stylesheet, and the initial-CSS budget check passes at its original threshold, not a raised one.
  3. No mode shows unstyled content on its first activation after the split.

**Plans**: TBD
**UI hint**: yes

### Phase 11: Milestone Verification & Evidence

**Goal**: The milestone's own audit trail becomes as trustworthy as the product changes it verifies: coverage is visible, the narrowed CI trace configuration is proven, and v1.0's closeout evidence debt is retired.
**Depends on**: Nothing structurally; sequenced last as the milestone's audit closeout
**Requirements**: TEST-02, GATE-08, VALID-01, SEC-03
**Success Criteria** (what must be TRUE):

  1. Test coverage for both the TypeScript and Rust sides is measured and reported as a non-gating artifact, readable after a run, outside `make verify`.
  2. A deliberate CI failure against the narrowed Playwright trace configuration actually produces a trace, closing the evidence gap accepted at v1.0 closeout.
  3. Nyquist validation metadata for v1.0 phases 01-03 matches what `$gsd-validate-phase` reports, with no stale drift remaining.
  4. Milestone v1.0 Phase 02 has a security report on file, so security evidence is uniform across every v1.0 phase.

**Plans**: TBD

## Progress

**Execution Order:**
Phases execute in numeric order: 6 → 7 → 8 → 9 → 10 → 11

| Phase | Plans Complete | Status | Completed |
|-------|-----------------|--------|-----------|
| 6. Native E2E Runner Foundation | 5/5 | Complete    | 2026-08-29 |
| 7. Guardrails Before Churn | 0/TBD | Not started | - |
| 8. Main-Thread Responsiveness | 0/TBD | Not started | - |
| 9. Durability and Session Lifecycle | 0/TBD | Not started | - |
| 10. Bundle and Build Hardening | 0/TBD | Not started | - |
| 11. Milestone Verification & Evidence | 0/TBD | Not started | - |
