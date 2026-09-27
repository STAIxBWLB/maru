# Phase 8: Main-Thread Responsiveness - Context

**Gathered:** 2026-09-05
**Status:** Ready for planning

<domain>
## Phase Boundary

Implement PERF-02 and PERF-01: release the skills registry lock during network
work, and move commands that perform network calls, subprocess work or unbounded
filesystem walks off the main thread. Re-read current registry state before
writing results; a source removed during synchronization must never reappear.

Re-inventory the entire relevant command paths. The earlier count of 37 commands
came from an 80-line scan and is a starting lead, not the scope limit. Verify
responsiveness with concurrent real commands and unrelated-command latency in
the native application, not only with mocked IPC or a visually responsive UI.

This is an existing-behavior reliability phase. Preserve permission checks,
write guards, IPC error contracts and data ownership. Do not introduce a new
job center, general retry framework, scheduling feature or app-quit persistence
mechanism. App quit and pending editor-save durability belong to Phase 9.

</domain>

<decisions>
## Implementation Decisions

### Synchronization conflicting with edits or deletion

- **D-01:** If source settings change while synchronization is in flight,
  discard the result derived from the old settings, preserve the latest
  settings, and briefly notify the user. The user explicitly starts another
  synchronization; do not automatically retry against the changed settings.
  Deletion wins as required by PERF-02: never resurrect a removed source.
- **D-02:** A second synchronization request for the same source does not start
  another operation and does not queue a later run. Report that synchronization
  is already in progress.
- **D-03:** When Sync All encounters an already synchronizing source, skip that
  source and report it as skipped; synchronize the remaining sources. Do not
  delay the whole batch until the existing operation finishes. A skipped source
  must not be presented as newly synchronized by this batch.

### Work surviving a screen change

- **D-04:** User-started synchronization or file processing within the phase's
  existing command scope continues when the user moves to another screen.
  Report completion or failure through the existing notification surface.
  Do not require the user to stay on the initiating screen.
- Preserve the existing workspace ownership and stale-response rules when
  implementing D-04: completion belongs to the initiating workspace and must
  not overwrite another workspace's current view or force navigation back.
  This is an inherited safety constraint, not a newly requested job service.

### Slow work and failure feedback

- **D-05:** On synchronization failure, report the reason and leave retry to
  the user. Do not add automatic retries, including a one-time retry for a
  transient network error.
- Keep the existing progress indication while work is in progress. Preserve
  successful results from other sources when one source fails, consistent with
  the existing per-source Sync All outcome. No new timing threshold, global
  blocking dialog or progress UI was requested.

### Inherited Requirements and Constraints

- PERF-02 precedes changes to the broader blocking-command surface where they
  touch the same `skill_host/store.rs` implementation.
- Phase 7's scoped poison-recovery behavior and per-lock justifications remain
  intact; shortening lock duration must not bypass registry mutation safety.
- Phase 6's native runner is the established verification path. Keep temporary
  workspace isolation and production build isolation; do not use the owner's
  live workspace or credentials for the load test.
- The native concurrency proof must distinguish real isolation from moving
  blocking work onto a shared async pool that still stalls unrelated commands.

### Implementation Details Left to Research and Planning

No explicit blanket delegation was requested. These technical details were not
asked as product-preference questions and remain bounded engineering choices:

- Source identity/revision checks, per-source in-flight ownership, cleanup on
  failure and the brief notice/error codes implementing D-01 through D-03.
- Blocking-work execution mechanism and command-by-command conversion approach.
- Load-test workload, baseline, sampling and defensible pass thresholds. Record
  the evidence and rationale; do not relax the requirement to make a test pass.
- Reuse of existing progress and notification ports for D-04 and D-05.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and Product Contracts

- `.planning/ROADMAP.md`, Phase 8: scope, ordering and the three success criteria.
- `.planning/REQUIREMENTS.md`, PERF-02 and PERF-01: latest-registry write-back,
  deleted-source protection and native concurrency requirements.
- `.planning/PROJECT.md`: filesystem authority, write safety, skill-host
  boundaries and CI reality.
- `README.md`: repository structure, safety contracts and verification commands.
- `docs/SSOT-TIERS.md` and `docs/BOUNDARIES.md`: ownership constraints for sync
  and install paths. This phase does not change ownership between repositories.

### Prior Decisions and Evidence

- `.planning/phases/07-guardrails-before-churn/07-CONTEXT.md`: scoped recovery,
  continued terminal use and lock-specific justification rules.
- `.planning/phases/07-guardrails-before-churn/07-VERIFICATION.md`: completed
  guardrails that the store refactor must preserve.
- `.planning/phases/06-native-e2e-runner-foundation/06-CONTEXT.md`: native
  test workspace and build isolation decisions.
- `docs/native-e2e.md`: runner invocation, actual runtime scope and CI placement.
- `.planning/codebase/CONCERNS.md`: historical blocking-command and registry-lock
  findings. Re-measure against current source rather than treating counts as exact.

### Current Integration Points

- `src-tauri/src/skill_host/store.rs`: registry guard, single-source sync,
  Sync All, source removal and progress reporting.
- `src-tauri/src/lock_recovery.rs`: Phase 7 recovery contract.
- `src-tauri/src/lib.rs`: registered IPC command inventory.
- `src/lib/skills.ts`: frontend sync wrappers, progress IDs and batch outcomes.
- `src/lib/api.ts`: frontend IPC boundary and browser fallback distinction.
- `e2e-native/wdio.conf.ts`: existing native runner and fixture lifecycle.
- `src/lib/nativeE2eBridge.ts`: build-gated native observation seam.
- `scripts/check-native-e2e-isolation.mjs`: production artifact isolation guard.
- `Makefile`: hermetic verification and native test targets.

No additional external specification was supplied during this discussion.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets

- `registry_guard()` already routes poisoned lock acquisition through Phase 7's
  `recover_guard`. Keep that protection while narrowing critical sections.
- `ProgressReporter` and optional `progress_id` already report sync stages;
  `src/lib/skills.ts` carries the matching frontend contract.
- Sync All already collects per-source success/error outcomes and continues
  after a source failure. D-03 adds an explicit already-running outcome without
  treating it as successful synchronization.
- Native WebDriver fixtures and the build-gated observation bridge provide the
  starting point for deterministic concurrency verification.

### Established Patterns

- Rust owns mutations and revalidates ownership and write policy.
- Frontend completion handling is scoped; stale results must not overwrite a
  newer workspace or view. Background completion does not grant new write rights.
- Existing module stores and notification surfaces are preferred to new global
  state infrastructure.

### Integration Points

- Current `skills_sync_source_impl` holds the registry guard while loading a
  source, performing `git pull --ff-only`, rescanning and saving the registry.
- Current `skills_sync_all_sources_impl` holds the same guard across the entire
  loop and calls the shared sync helper. Planning must account for this caller,
  not only the single-source wrapper.
- `skills_remove_source` uses the same registry guard today. Releasing the lock
  during network work makes edit/remove interleavings observable and requires
  current-state validation before commit.
- Other blocking commands must be discovered through their reachable work,
  including helper calls and code beyond the first 80 lines.

</code_context>

<specifics>
## Concrete Expected Flows

- Start synchronization, change that source's settings, then let the old
  operation finish: latest settings remain, old results are not committed,
  a short explanation appears, and no automatic retry starts.
- Start synchronization for source A, then invoke Sync All: A remains owned by
  the first request; the batch reports A skipped and processes other sources.
- Start work and change screens: the work continues, completion is reported
  through existing UI, and the selected screen stays selected.
- One source fails while other sources succeed: successful results remain,
  the failing source has an actionable reason, and retry is manual.

</specifics>

<deferred>
## Deferred Ideas

No new capability was proposed. The previously recorded Inbox/right-panel
layout overlap remains outside Phase 8; its evidence is in
`.planning/phases/07-guardrails-before-churn/07-UAT.md`.

</deferred>

---

*Phase: 08-Main-Thread Responsiveness*
*Context gathered: 2026-09-05*
