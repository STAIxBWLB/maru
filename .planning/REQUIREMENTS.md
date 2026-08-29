# Requirements: maru - Milestone v1.1 Felt Quality and Native Proof

**Defined:** 2026-08-29
**Core Value:** The filesystem stays the source of truth - everything Maru shows is derived from real files the user owns, and nothing is lost if Maru is uninstalled.

Milestone v1.1 promotes the reliability, performance, security, and verification
backlog deferred at v1.0 into committed requirements. It adds no user-facing
product features. Unlike v1.0, whose success metric was that behavior did *not*
change, this milestone deliberately changes observable behavior - so "the
existing suite still passes" is a floor, not evidence.

REQ-IDs continue the v1.0 scheme. `PERF-01..04`, `REL-01`, `SEC-01/02`, and
`TEST-01/02` were already minted as v2 candidates in
`.planning/milestones/v1.0-REQUIREMENTS.md` and are promoted here unchanged in
identity; `PERF-05`, `REL-02/03`, `SEC-03`, `GATE-08`, and `VALID-01` are new.

## v1.1 Requirements

### Responsiveness

- [ ] **PERF-01**: A command that reaches the network, a subprocess, or an
  unbounded filesystem walk no longer blocks the main thread. Verification is a
  concurrency load test, not the absence of a visible freeze: several converted
  commands fire at once and an unrelated command's latency stays flat. This
  distinguishes a real fix from a command that merely moved its blocking call
  onto Tauri's shared async worker pool, which has no passive warning sign.
- [ ] **PERF-02**: `skills_sync_source` releases the global registry lock across
  its network round-trip, and the write after re-acquiring the lock reloads the
  registry fresh rather than writing back a pre-network copy. A source removed
  concurrently must not be resurrected by the sync that was already in flight.
- [ ] **PERF-03**: A panic under one of the six named process-global locks
  (`REGISTRY_LOCK`, `JOBS_LOCK`, `DOT_ACTION_LOCK`, `BINDER_WRITE_LOCK`, and the
  terminal registry and killer locks) leaves that feature usable instead of
  bricked until app restart. Each lock carries its own recorded justification for
  why recovery is safe for the data it protects; the recovery is not extended to
  any lock outside the six.
- [ ] **PERF-04**: A recursive filesystem watcher does not generate events for
  paths under the shared generated-directory prune list, so a watched root that
  gains a heavy subtree does not become an event-volume bottleneck.
- [ ] **PERF-05**: Per-mode CSS ships in the lazy chunk of the mode that uses it
  rather than in the entry stylesheet, restoring the initial-CSS budget headroom
  spent since v0.4.46. The budget numbers themselves are not raised, and no mode
  shows unstyled content on its first activation.

### Durability and Session Lifecycle

- [ ] **REL-01**: A terminal child that traps SIGHUP can still be killed. The
  escalation is timeout-gated rather than a blanket replacement, so the existing
  behavior where a deliberately backgrounded grandchild survives tab close is
  preserved, and the generation-token invariant that stops a stale frontend
  handle writing into a recycled session still holds.
- [ ] **REL-02**: A pending debounced editor save is performed, not merely
  cancelled, when its pane unmounts and when the application quits. The app-quit
  path is driven from the Rust side rather than from a webview unload handler,
  which is documented-unreliable inside Tauri.
- [ ] **REL-03**: A save that fails on a teardown path is visible to the user
  rather than silent. Today a failed flush produces no log, no toast, and no test
  failure; the user learns of it only by reopening the document and finding the
  edit gone.

### Security

- [ ] **SEC-01**: `script-src 'self' blob:` is dropped from the CSP if the Vite
  production build no longer requires it, verified against a packaged build
  rather than a dev server, since this class of removal can pass in development
  and fail only in the shipped bundle.
- [ ] **SEC-02**: `make verify` fails when a `dangerouslySetInnerHTML` value in
  `src/` does not trace to a DOMPurify-backed helper. The guard is a static
  check in the shape of the existing `scripts/check-*.mjs` family, not a new lint
  framework.
- [ ] **SEC-03**: Phase 02 of milestone v1.0 has a security report, so the
  milestone audit measures uniform evidence across phases.

### Native Verification

- [ ] **TEST-01**: A native runner drives the real application - WKWebView DOM,
  a real PTY, and IME input - against the real Rust backend rather than mocked
  IPC. Whether any part of it runs unattended in CI is decided by a spike that is
  the first slice of the owning phase, not assumed: the spike must show a session
  establishing with no interactive permission prompt on a hosted macOS runner,
  PTY output readable by screenshot assertion (the terminal renders to a
  `<canvas>`, so DOM queries cannot see it), and a full run surviving with no
  human present. If the spike succeeds, the runner splits into a CI-gated subset
  plus a human-attended local gate for the macOS menu bar, which the
  Accessibility permission wall keeps unscriptable either way. If it fails, the
  runner is a single local target wired into `release-preflight`, following the
  `verify-integration` precedent.
- [ ] **TEST-02**: Test coverage is measured and reported for both the
  TypeScript and Rust sides, as a non-gating report kept outside `make verify`.
- [ ] **GATE-08**: The narrowed Playwright trace configuration shipped in v1.0 is
  proven by a deliberate CI failure that actually produces a trace, closing the
  evidence gap accepted at v1.0 closeout.
- [ ] **VALID-01**: Nyquist validation metadata for phases 01-03 of milestone
  v1.0 is reconciled, so the milestone audit measures evidence rather than stale
  metadata.

## v2 Requirements

Deferred. Acknowledged but not in this roadmap.

### Typed IPC

- **ERR-05**: The IPC error contract constrains which codes Rust can emit, not
  only which it declares. Deferred again because it is a developer-facing
  correctness gap rather than something a user feels.

### Testing

- **TEST-03**: The remaining large untested components have co-located tests
  (`MeetingsPane`, `FilesWorkbench`, `GraphCanvas`, `DiagramMode`, `SkillsTab`,
  `StudioMode`, `GraphView`, `InboxPane`, and others)
- **TEST-04**: `app_menu.rs` has a smoke test

### Product

- **HUB-01**: Hub graph-metadata sync - the ingested doc set's only explicit
  deferral, held until a Hub consumer exists
- **HWPE-01..03**: Registration of the adopted `hwped_*` hwp-editor bridge as
  first-class requirements, owed since the parallel track landed it during v1.0
- **SEMA-01..04**: The Semantica adoption plan's S1-S4 stages (decision records
  and provenance, LLM-assisted entity and relation proposals, entity resolution,
  versioned vault schema with MCP read tools)

## Out of Scope

| Feature | Reason |
|---------|--------|
| Cancel-button UI for any converted command | Moving work off the main thread does not require exposing cancellation; a cancel affordance that does not actually abort the underlying work is worse than none |
| Progress UI on operations that are already fast | A spinner on a 20 ms operation makes the app feel slower, not faster |
| Raising the bundle budget to accommodate CSS growth | The gate working is the point; the fix is splitting the stylesheet, not moving the line |
| A new lint framework for the sanitizer guard | One grep-shaped script in the existing `check-*.mjs` family suffices |
| Blanket `into_inner()` recovery across all locks | Correct only for re-derivable state; applied to an invariant-bearing structure it converts a loud panic into silent corruption |
| Playwright for the native suite | It drives its own managed browser binaries, not the app's real WKWebView, IPC, or PTY |
| New user-facing product features | This milestone changes how existing surfaces behave under load; adding surface area would move the target it is trying to hit |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| PERF-01 | Phase 8 | Pending |
| PERF-02 | Phase 8 | Pending |
| PERF-03 | Phase 7 | Pending |
| PERF-04 | Phase 7 | Pending |
| PERF-05 | Phase 10 | Pending |
| REL-01 | Phase 9 | Pending |
| REL-02 | Phase 9 | Pending |
| REL-03 | Phase 9 | Pending |
| SEC-01 | Phase 10 | Pending |
| SEC-02 | Phase 7 | Pending |
| SEC-03 | Phase 11 | Pending |
| TEST-01 | Phase 6 | Pending |
| TEST-02 | Phase 11 | Pending |
| GATE-08 | Phase 11 | Pending |
| VALID-01 | Phase 11 | Pending |

**Coverage:**
- v1.1 requirements: 15 total
- Mapped to phases: 15
- Unmapped: 0

---
*Requirements defined: 2026-08-29*
*Last updated: 2026-08-29 after roadmap creation (Phases 6-11, 15/15 mapped)*
