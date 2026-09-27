# Phase 08: Main-Thread Responsiveness - Research

**Researched:** 2026-09-05
**Requirements:** PERF-02, PERF-01
**Dispatch:** generic-agent workaround; project-local GSD phase-researcher role used, typed dispatch unavailable.
**Confidence:** Opened repository facts and registration counts are directly evidenced. Architecture choices are proposals; runtime thresholds and saturation controls remain to be measured. The installed confidence seam returned LOW for provider `webfetch --verified`; official-documentation claims below are therefore cited directly rather than presented as tool-classified HIGH evidence.

## User Constraints

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

## Deferred Ideas

No new capability was proposed. The previously recorded Inbox/right-panel
layout overlap remains outside Phase 8; its evidence is in
`.planning/phases/07-guardrails-before-churn/07-UAT.md`.

## Summary

[VERIFIED: src-tauri/src/lib.rs, full generate_handler block; 08-COMMAND-INVENTORY.md] The registered surface contains **365 commands**, all reconciled to source definitions. The forms are **240 ordinary sync functions, 76 synchronous bodies with `#[tauri::command(async)]`, and 49 `async fn` functions**. The historical 37 is not a conversion count. The companion inventory records every command and its owning module. Current evidence identifies **159 conversion candidates, 20 already using blocking isolation, 15 UI-affinity boundaries, 18 pure/model retain candidates, one background-loop boundary, and 152 mandatory audit rows**. These are research dispositions, not final verified safety counts.

[CITED: https://v2.tauri.app/develop/calling-rust/#async-commands] `#[tauri::command(async)]` moves a synchronous body to an async task, not to the blocking pool. Therefore much of the apparently asynchronous scanning surface still threatens unrelated async commands. Use async IPC wrappers plus `tauri::async_runtime::spawn_blocking` around finite blocking domain work. Preserve existing sync helpers for Rust/CLI callers.

[VERIFIED: src-tauri/src/skill_host/store.rs:582-709] Both `skills_sync_source_impl` and `skills_sync_all_sources_impl` hold `registry_guard()` while `sync_one_source_in_registry` performs Git pull and scan. Fix PERF-02 first with snapshot/network/fresh-commit phases and per-source ownership shared by single and batch sync. The write must reload disk, validate source incarnation/configuration, and update only the still-current source. Never save the original whole registry.

## Project Constraints (from README.md and project context)

[VERIFIED: README.md, Safety Contracts/Development/Verification; .planning/PROJECT.md, Constraints] README is the project source of truth; no root CLAUDE.md was present in this checkout. Preserve lexical path containment, the frontmatter writer boundary, structured IPC errors, write permissions, ownership checks and revision-checked atomic replacement. New shared frontend state follows existing module stores, not a Context tree or new MainApp props. Preserve five skill ownership tiers and cross-repository boundaries. Keep Korean/English locale keys paired. Browser mocked IPC is not native evidence. No new packages are needed.

[VERIFIED: docs/SSOT-TIERS.md; docs/BOUNDARIES.md; 07-CONTEXT.md; 07-VERIFICATION.md] Keep registry poison recovery scoped to the previously justified lock. Do not extend recovery to a new invariant-bearing map by copying `into_inner()`. CLI and desktop share domain code, but process-local mutexes are not cross-process locks; do not claim this phase solves arbitrary concurrent CLI/external file edits unless separately proven.

## Standard Stack

[VERIFIED: src-tauri/Cargo.toml:42-88] Existing dependencies include `tauri`, `reqwest` with `blocking`, `rayon`, `uuid` with `v4`, `tempfile`, `walkdir`, and `serde`. Keep these existing versions and APIs. Tauri exposes the needed blocking executor without adding a direct Tokio dependency. Existing `hwped_read` and peers use the desired wrapper shape at `src-tauri/src/hwped.rs:646-706`; `check_gws_auth`, Outlook, Kakao and `dot_sync_*` also provide in-tree examples.

[CITED: https://docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html] The blocking closure and return value must be owned, Send and static. Move owned String/request/AppHandle values into closures. Acquire any State-owned Arc or owned session handle before offload, or retrieve managed state from an owned AppHandle inside the worker. Never move a borrowed `State` or a MutexGuard across an await.

[CITED: https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html] Blocking tasks are intended to finish; started tasks cannot be cancelled with abort. Preserve dedicated threads for indefinite PTY readers, polling loops and schedulers. Navigation is not cancellation. App-quit durability and kill escalation are Phase 9, not new features here.

## Architecture Patterns

### Registry synchronization transaction

[VERIFIED: src-tauri/src/skill_host/store.rs:53-69] The existing `SkillSource` stores `id`, `kind`, `ownership_class`, `path`, `repo_url`, `skills_subdir`, `branch`, and `last_synced_at`. It has equality but no incarnation or configuration revision. Comparing the full record would wrongly treat a derived timestamp as a settings change; comparing only source ID permits stale writes to a deleted/re-added source.

[PROPOSED, not an existing symbol] Implement a narrow source-operation lease, scoped by registry identity and source ID, shared by single-source and Sync All. Admission must be nonblocking for duplicates; an active lease returns already-running or a skipped batch row immediately, never a queued run. Cleanup is RAII and releases on success, ordinary error and unwind. Distinguish operation ownership from mutation generation: deletion does not clear the old lease and accidentally let another sync mutate the same checkout.

[PROPOSED] Under REGISTRY_LOCK, load current disk registry, admit ownership, capture source identity and settings, then drop REGISTRY_LOCK before Git/network. Reacquire, reload disk, reject missing/tombstoned/changed source, and rescan/commit against that fresh registry. Initial minimal-safe design may keep the fresh scan and commit in one guarded blocking section; it avoids stale saved hashes and source-local file edits while satisfying the mandatory network unlock. Moving scan outside the guard requires an additional source-content generation protocol and is not automatically safer.

[PROPOSED] Prevent same-ID remove/re-add ABA with a source incarnation plus configuration revision or an equivalent mutation generation protocol. Prefer a backward-compatible persisted optional/defaulted incarnation when cross-process identity must survive; if using a process-local generation, explicitly restrict claims to commands within this application and cover every in-process mutator. Existing `removed_source_ids` tombstones are insufficient once add clears them. Change-then-revert settings must invalidate old work too. Assign/update identity at add/default insertion/reset; increment configuration generation when relevant fields actually change; derived `last_synced_at` updates must not count as settings changes. Existing metadata must load unchanged and gain defaults safely. Test identical configuration delete/re-add, not only different paths.

[VERIFIED: src-tauri/src/skill_host/store.rs:423-523,4151-4231] `skills_add_source` is an add operation, rejects duplicate IDs and can clone under REGISTRY_LOCK. There is no registered edit-source command in the 365-name registry; workspace-derived `upsert_linked_source` replaces linked source configuration and remove/re-add is another mutation route. Plan D-01 tests around these actual routes or the underlying transaction seam; do not invent a new source settings UI. Clone-add network scope and bundle check/apply/reconcile network scope must be explicitly audited, so another operation does not retain the global lock across a slow request after sync is fixed.

[VERIFIED: src-tauri/src/skill_host/store.rs:642-709] Sync All currently loads once, loops and saves once. It must instead snapshot source identities briefly, release the guard, and call the same per-source transaction. Persist each successful source independently. Preserve other sources if one fails. A busy source contributes a distinct skipped result, not success or failure. A source deleted or changed before its turn must not be silently resolved to a replacement identity. Reconcile `total`, `succeeded`, `failed`, and proposed `skipped` against every returned result.

[PROPOSED] Keep single-source successful return compatible if practical; duplicate/stale errors should be structured IpcError codes if the frontend branches on them. Proposed codes and outcome fields must be added to Rust/TypeScript SSOT together, not parsed from prose. `src/lib/skills.ts` invokes Tauri directly, so it needs the existing normalizer at the affected boundary if structured errors are introduced. Update batch TS types, browser fallback and all callers; CLI also serializes outcomes.

### Blocking IPC migration

[PROPOSED] For each CONVERT row, retain/create a sync domain helper and expose an async command that awaits spawn_blocking. Reuse a small helper only if it preserves both existing String errors and IpcError without converting structured failures to strings. Join failures need contextual display errors; avoid a broad error-contract migration. Commands called by other Rust functions must call the sync helper, not block_on the async IPC function. Compile the CLI as well as the app.

[VERIFIED: src-tauri/src/terminal/mod.rs:369-504,508-602,749-908] `terminal_spawn` is async but performs PTY creation/process spawn before its reader thread. Writes reach `write_shared`; resize holds locks through the PTY ioctl; kill calls the child killer. Offload the blocking portion while preserving generation tokens, session reservation, writer ordering, reservation rollback, resize serialization and existing kill semantics. Do not move model-only input/ack operations indiscriminately or add Phase 9 escalation.

[VERIFIED: src-tauri/src/site_view.rs:184-301,400-425; src-tauri/src/browser_passkeys.rs:234-309] Webview/passkey commands have native UI threading requirements. Keep native dispatch where Tauri/platform requires it. `site_view_open_external` and `site_view_open_safari` perform process launch in an async body and need a blocking boundary. A full-function blanket offload of all webview commands is unsafe. Watcher start commands similarly create/register native recursive watches before their drain threads; preserve epochs and stale-start rules if setup is offloaded.

### Navigation and completion ownership

[VERIFIED: src/components/settings/tabs/SkillsTab.tsx:105-175,307-386,521-573] SkillsTab owns busy/progress/error state locally; its refresh sequence captures workPath and later writes component state without a current-workspace generation check. A pending promise survives unmount, but its local result notice does not become visible on another screen. Simply adding async Rust cannot satisfy D-04.

[VERIFIED: src/lib/errorStore.ts:1-57; src/lib/useUpdaterToasts.ts:16-42; src/lib/missionProgress.ts:1-28] There is an existing global error toast store, updater-specific toasts, and mission progress support; no generic success-notice port was found in these opened modules. Extend the existing toast surface minimally for operation completion and reuse current Skills progress display. Keep a narrow module-level operation state keyed by initiating workspace + operation identity, with useSyncExternalStore subscriptions. Do not add a job center, persistence, scheduling or retry service.

[PROPOSED] Separate mutation lifetime from visible refresh lifetime. Capture the originating workspace at invocation. Run mutation/notification to settlement regardless of screen subscription; use workspace and request-generation checks only before changing current view data. Returning to the same workspace may reattach progress and refresh disk results. Do not force navigation, overwrite another workspace, silently drop failure, or cancel the operation on component cleanup. Dispose event listeners on operation settlement, including listener-registration failure. Apply the same rules to file processing callers in the inventory, especially Files, Inbox, export and template flows; model existing event-based missions rather than wrapping all reads in a new service.

## Complete Scope and Plan Ownership

[VERIFIED: 08-COMMAND-INVENTORY.md] The companion document owns the exhaustive command names, definitions, runtime forms and initial dispositions. Its final section lists every AUDIT command grouped by actual module. The planner must assign each group to exactly one plan. No unowned residual group, no 'not found by regex therefore safe', and no final PERF-01 pass while AUDIT remains.

[PROPOSED] Recommended tracer-first sequence:

1. Skills single-source end-to-end tracer: per-source lease + fresh write-back + ABA protection + async wrapper + current toast/progress lifetime + deterministic race tests. Include direct native smoke before expanding.
2. Skills batch and remaining registry/environment/dispatch boundaries: shared lease, skip result contract, partial success, clone/bundle/reconcile lock audit, default-source mutation and CLI caller compatibility.
3. Scanning and filesystem boundaries: vault, workspace_files, Inbox, scratchpad/shelf/drafts, document move/trash, content/calendar search, meetings/tasks, secrets, graph/KG, catalog/project activity, diagram/studio and related AUDIT modules. Split this group into bounded plans by module ownership; do not create a single 100-file plan.
4. Provider/subprocess and lifecycle boundaries: Git, Gmail/Outlook/Telegram/Kakao, jobs/scheduler/launchd, Hub, export/templates/hwped, agent host, terminal setup/writes and watcher lifecycle. Preserve existing isolated operations and close the corresponding AUDIT modules.
5. Remaining bounded/native UI audit and operation completion call sites: maru_dir/workspace/vault_list/settings, approval/parsing/status/model commands, site/passkey, frontend workspace/request-generation and error normalization checks. Retained commands need positive bounds or a native thread-affinity reason.
6. Native concurrency closure and production isolation: all 365 rows have final evidence; real overlapping workload, true async probe, deliberate failing control, native navigation completion and race proof, normal artifact rebuilt/guarded.

## Don't Hand-Roll

- [PROPOSED] No new executor, worker pool, generic job registry, retry queue or cancellation affordance. Use existing Tauri blocking executor and event surfaces.
- [PROPOSED] No new token/credential fixture and no production workspace or remote provider calls for native load tests. Use local fixture Git repositories and deterministic test-only barriers around real work.
- [PROPOSED] No atomics-only substitute for registry persistence and current-state validation; an in-flight flag alone does not prevent stale whole-registry writes.
- [PROPOSED] No percentage progress based on a skipped source being completed successfully. Skip is an outcome of the batch, never a new sync.

## Common Pitfalls

- [CITED: https://v2.tauri.app/develop/calling-rust/#async-commands] Assuming `command(async)` isolates blocking work; it does not supply a blocking executor.
- [CITED: https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html] Taking std mutexes or waiting on processes inside async tasks still stalls the shared worker pool; a lock wait belongs in the worker with the operation.
- [PROPOSED] Frontend duplicate disabling cannot guard two windows, a remount or direct IPC. Backend source ownership is authoritative.
- [PROPOSED] Comparing ID+settings misses identical remove/re-add and settings change/revert. Include mutation identity, and test both.
- [PROPOSED] Offloading code changes interleavings previously serialized by main-thread execution. Preserve write guards and introduce scoped serialization where existing file transactions require it; do not infer that an existing revision check alone atomically serializes two worker writes.
- [PROPOSED] A source's Git checkout can change before a stale-result rejection. D-01 rejects registry write-back derived from obsolete settings; do not claim automatic rollback of completed Git network side effects. Never rollback against a newly owned checkout.
- [PROPOSED] Timing full WebDriver element commands measures service overhead and can hide latency. Timestamp IPC promises within the webview and export raw samples after settlement.

## Code Examples

[VERIFIED: src-tauri/src/hwped.rs:646-654] Existing wrapper pattern (source names quoted verbatim):

```rust
#[tauri::command]
pub async fn hwped_read(
    document: HwpedDocumentRef,
    workspace_root: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || read_now(document, workspace_root))
        .await
        .map_err(|err| format!("hwped_task_failed: {err}"))?
}
```

[PROPOSED] Registry algorithm, pseudocode only; names below do not yet exist:

```text
lease = admit_source_operation(registry_identity, source_id)
snapshot = with_registry_lock(load_fresh_and_capture_incarnation_and_settings)
network_result = perform_network(snapshot)
with_registry_lock:
  current = load_fresh_registry()
  require_same_incarnation_and_config(current, snapshot)
  rescan_current_source_and_merge_into_current_registry()
  persist_current_registry()
release lease on every exit
```

## Validation Architecture

### Fast feedback

[VERIFIED: README.md Development; Makefile:199-203,226-237,359] Existing commands: `make test-rust`, `make fmt-check`, `make clippy`, `pnpm typecheck`, `pnpm lint:i18n`, `pnpm test`, `make verify`, and `make test-e2e-native`. Native target builds the frontend with its isolated flag and Rust with the default-off native feature, then runs WebDriver.

[PROPOSED] During a module tranche run `cargo test --manifest-path src-tauri/Cargo.toml --lib <module_filter>` and `cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli`; retain sync helper test call sites. Run focused Vitest using `pnpm exec vitest run <new-operation-store-test> <affected-component-test>` once those test files exist. Final module names/test files must be written in each PLAN, not copied as literal placeholders from this research.

[PROPOSED] Rust test seams should inject the network step or a two-party barrier into the real sync transaction, use temporary registry roots and real files, and assert: lock accessible while network blocked; unrelated source edits retained; remove wins; same-ID identical re-add rejected; settings change and change/revert rejected; duplicate runs once; failure releases lease; panic releases lease without broad poison recovery; Sync All skips A while progressing B; successful B persists when C fails; no automatic retry. Avoid sleep-only race tests and process-global environment changes in parallel tests; prefer explicit paths/dependency injection or existing serialized test guard.

[PROPOSED] Frontend controlled promises test unmount/screen switch then resolve/reject, workspace switch A->B, B->A late response, duplicate remount, independent operations, exact once completion notice, progress event scoping, skip counts and actionable failure with manual retry. Test native and browser-wrapper normalization separately; browser fallback is not native performance proof.

### Native evidence strategy

[VERIFIED: e2e-native/wdio.conf.ts:9-13; src/lib/nativeE2eBridge.ts:1-29] `withGlobalTauri` is false and the existing bridge exposes only `terminalText` and `menuCommand`. Add a narrowly allowlisted, build-gated responsiveness harness on the same namespace. It must invoke actual registered Rust commands through imported invoke, not call their helpers directly and not install an unrestricted eval/IPC surface in production.

[VERIFIED: e2e-native/helpers/fixtureWorkspace.ts:1-35,99-144] The runner seeds temporary home/config/workspace and sets `MARU_NATIVE_E2E_HOME` and `MARU_NATIVE_E2E_CONFIG_DIR` before app launch. Extend that fixture with disposable Git sources and a sufficiently large local tree. Persist machine-readable timing and outcome evidence outside disposable fixture cleanup, using explicit artifact paths in the plan. No credentials or production repository.

[PROPOSED] Workload must overlap multiple distinct converted commands (Git subprocess, scan/filesystem, and skills sync against a local Git remote), with test-only deterministic barriers/delays inside their real blocking worker paths to guarantee overlap. Do not substitute a new sleep-only command for the workload. Assert nonzero expected results so unsupported/empty/no-op calls cannot pass. For source concurrency use backend transaction barriers; do not mutate fixture registry behind a held lock from Node and call that an application race.

[CITED: https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html#method.worker_threads] Tokio honors `TOKIO_WORKER_THREADS` unless its builder overrides worker count. [PROPOSED] A dedicated native load configuration can set it to 2 before app spawn, then verify the installed Tauri runtime actually honors that setting from local dependency source or a diagnostic. Launch at least four guaranteed-overlapping real heavy operations. Do not assume a small fixed workload saturates a many-core default pool.

[PROPOSED] Measure both (a) an unrelated real production command and (b) a genuinely async no-blocking native probe that is scheduled by the SAME Tauri async runtime. An ordinary sync probe and a DOM animation can stay responsive while all async workers are stalled. The probe must not use spawn_blocking itself; report request-to-result webview monotonic timestamps. Sample warm idle baseline, loaded window and recovery with identical sample cadence, warm-up exclusion and multiple rounds. Record raw samples, median/p95/max, overlap intervals, operation outcomes, runtime worker setting, build revision and fixture sizes.

[PROPOSED, unverified engineering starting point] Choose thresholds only after baseline variance is measured, and freeze them before the fixed run. A starting criterion is loaded p95 <= max(idle p95 * 2, idle p95 + 25 ms) and no probe stall above 250 ms; these are not locked product requirements or demonstrated achievable values. If noise exceeds the bound, investigate and record evidence rather than widening until green. Include deliberate red control that routes one workload back to blocking async execution and demonstrably fails while normal spawn_blocking passes, then restore source and rerun.

[PROPOSED] Native behavioral acceptance also starts a sync, changes screen while it remains in flight, observes completion/failure through the existing toast area without navigation changes, and revisits original workspace to verify persisted results. Include real source deletion/stale outcome and Sync All skipped-source assertions. The native bridge may coordinate only test fixtures under the existing build gates; compile-time feature-gate any Rust test hook and guard its absence from a normal binary.

[VERIFIED: scripts/check-native-e2e-isolation.mjs:1-40; Makefile:182-184,289-305] Rebuild a normal production frontend after native tests and run isolation checks; default-feature binary checks remain necessary for Rust test hooks. Namespace scanning alone does not prove an added Rust command is absent. Add a distinctive Rust hook marker to binary checks if required. Final success requires zero AUDIT entries and passing contract/native evidence, not just make verify.

### Runtime State Inventory

- [VERIFIED: store.rs:49,124-136] Process memory: existing global registry lock; new source lease/generation bookkeeping must have explicit failure cleanup and scoped ownership.
- [VERIFIED: store.rs:2659-2735] Disk state: registry and derived skill records; reload after network, never replace newer registry with a pre-network copy.
- [VERIFIED: store.rs:423-523,608-627] External state: source Git checkouts can change independently of registry; source-path identity and stale completion must be checked.
- [VERIFIED: SkillsTab.tsx:105-175,307-386] Frontend state: current local progress/busy/error and captured workspace; extract only operation lifetime needed by D-04.
- [VERIFIED: nativeE2eBridge.ts:1-29; fixtureWorkspace.ts:1-35] Test/runtime state: build-gated bridge, fixture env/config and spawned native process; teardown retains evidence while cleaning fixture and process.

## Security and Ownership

[PROPOSED] This phase changes scheduling, not permission policy. Test denied writes still fail before external effects; review approval lifetime when extracting owned requests; revalidate target ownership in the actual worker just before mutation where existing helpers require it. Preserve lexical containment, source ownership tiers and signed bundle validation. Use fixed argv, no shell interpolation or credentialed public remotes in fixtures. New outcome codes cannot bypass IPC known-code normalization. Test-only commands and environment overrides remain compile-time gated.

## Package Legitimacy Audit

No package installation is recommended. Existing manifest dependencies suffice. No package-legitimacy gate is triggered by this research.

## Open Questions and Evidence Limits

- [PROPOSED] All 152 AUDIT rows require bounded source closure inside assigned plans; they are named and grouped in the companion inventory. A lightweight textual call graph is not a Rust compiler analysis.
- [PROPOSED] Persisted incarnation versus process-local mutation generation is an engineering decision, bounded by tests for all actual application mutations and truthful cross-process scope. No new source-edit UI is requested.
- [PROPOSED] Native timing bounds and runtime worker configuration require calibration and a failing control. This research did not run a performance benchmark and claims no latency result.
- [PROPOSED] Existing operation notification surface needs a minimal success/info extension for D-04; no generic global success API has been established in the opened source. The planner must choose concrete existing toast integration and test it.

## Sources

Primary documentation opened on 2026-09-05:

- [Tauri command execution semantics](https://v2.tauri.app/develop/calling-rust/#async-commands).
- [Tauri blocking executor API](https://docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html).
- [Tokio blocking work and cancellation](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html).
- [Tokio runtime worker and blocking-pool configuration](https://docs.rs/tokio/latest/tokio/runtime/struct.Builder.html#method.worker_threads).

Local primary evidence: all canonical references from 08-CONTEXT.md, opened command definitions, `08-COMMAND-INVENTORY.md` and the specific source locations above. The online latest API pages resolve newer releases than the manifest's minimum semver requirement; use installed Cargo.lock/local source to confirm runtime configuration before implementation. No dependency upgrade is implied.

## Research Complete

Research artifacts are planning inputs. No implementation, native benchmark, full regression run, phase completion or Git commit was performed by this researcher.
