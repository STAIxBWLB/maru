---
status: passed
phase: 08-main-thread-responsiveness
verified: 2026-09-21
requirements: [PERF-01, PERF-02]
summary: All three ROADMAP success criteria verified against code, inline unit tests, and native e2e artifacts; PERF-01 and PERF-02 both verified, with minor evidence-hygiene notes listed under Gaps.
---

# Phase 8 Verification: Main-Thread Responsiveness

Verdict: **passed**. The phase goal holds. `skills_sync_source` no longer holds `REGISTRY_LOCK` across its network round-trip and its post-lock write reloads the registry from disk, the blocking-command set was re-measured at kickoff and closed exhaustively (365 commands, 356 ISOLATED + 9 platform-dispatch UI rows, zero AUDIT), and a native concurrency load test with a frozen-threshold negative control shows an unrelated command's latency staying flat under four overlapping real operations.

Verification method: read-only checks only (file reads, greps, JSON parses). No tests were re-run and no source files were modified; executable evidence is quoted from the 29 plan SUMMARYs, the `docs/performance/phase08-*.json` shards, and `artifacts/native-responsiveness/*.json`. The phase goal is ROADMAP.md:93 and the success criteria are ROADMAP.md:95-100; the phase closed 2026-09-06 with 29/29 plans executed (ROADMAP.md:25, :282).

## Criterion 1: registry lock released over the network round-trip; removed source never resurrected

**Verified** (PERF-02). Three independent evidence layers.

Code (`src-tauri/src/skill_host/store.rs`):

- The command wrapper is async and offloads the entire implementation to a blocking worker: `#[tauri::command] pub async fn skills_sync_source` awaits `tauri::async_runtime::spawn_blocking(move || ... skills_sync_source_impl(...))` (store.rs:1203-1224). Network and subprocess work runs on the blocking pool, not the main thread and not a shared async worker.
- `sync_source_transaction` (store.rs:1259-1400) captures the source snapshot and canonical path inside a scoped block whose `let _guard = registry_guard()?;` drops before admission, so the guard is released before the network stage.
- The network closure runs with no registry guard held: after pre-network revalidation under a fresh guard (source still exists, generation and canonical path match, otherwise `SKILLS_SOURCE_STALE`), the tail calls `network_lease.before_effect()?; network(&snapshot.source, progress)?;` with no `_guard` in scope, then hashes the directory and drops the network lease. The inline comment at store.rs:1309-1315 records the contract: a settings change or a removal landing inside the saturation window is caught by the revalidations instead of being written back over the newer state.
- The commit stage re-acquires the guard and reloads fresh from disk rather than reusing the pre-network copy: `let _guard = registry_guard()?; let mut registry = load_registry_unlocked()?;` inside the tail's commit step (store.rs:1316-1400), followed by path/content-hash/source/generation revalidation, a rescan into the freshly loaded registry, and `save_registry_unlocked(&registry)`. `load_registry_unlocked()` (store.rs:3692) reads and parses the file from disk on every call. This satisfies "reloads the registry fresh rather than writing back a pre-network copy".
- `admit_source_operation` (store.rs:253-298) admits per (registry_path, source_id) plus canonical Git checkout key and fails closed busy (`SKILLS_SOURCE_BUSY`); no registry or lease guard is held during the `git rev-parse --show-toplevel` subprocess (comment at store.rs:262).
- `registry_guard()` routes through the Phase 7 poison recovery: `crate::lock_recovery::recover_guard(REGISTRY_LOCK..., "skills", "REGISTRY_LOCK")` (store.rs:3650-3658; declaration at store.rs:47-51).

Unit tests (`phase08_source_transactions` suite in the same file):

- `phase08_01_deleted_source_never_returns_at_all_three_edges` (store.rs:8735-8750): for each of before_admission, network, and before_commit, the concurrent mutation `skills_remove_source("tracer")` makes the in-flight sync fail with `unknown_source: tracer`, and the saved registry contains neither the source nor any skill from it. This is the exact resurrection criterion.
- `phase08_01_identical_remove_readd_rejects_old_incarnation` (store.rs:8752-8766): a remove/re-add during flight rejects with `source_changed`, so even a same-name reincarnation is not overwritten by the stale result.
- `phase08_01_removed_checkout_is_not_recreated_or_committed` (store.rs:8965-8992): registry bytes stay stable and the checkout is not recreated.
- `phase08_01_registry_read_and_edit_progress_while_network_is_held` (store.rs:9041-9085): while the sync holds the network edge, an unrelated thread acquires `REGISTRY_LOCK`, edits, and saves; the sync then completes and its fresh reload preserves the unrelated edit. This directly proves the lock is available during the network round-trip.

Native e2e (`e2e-native/specs/responsiveness.spec.ts:538-565`): "PERF-02 a source removed during sync is never resurrected by its late write-back" arms an isolated in-flight `skills_sync_source`, removes the source mid-flight, asserts the sync is rejected (`source_changed|unknown_source`), asserts the registry has no source immediately and again after 1200ms (explicit "late sync write-back resurrected the removed source" assertion), and asserts `removedSourceIds` records the tombstone. Executed green inside `make test-e2e-native` per 08-27-SUMMARY (10/10 responsiveness tests, 23 tests across 6 spec files).

## Criterion 2: re-measured blocking-command set, all off the main thread

**Verified** (PERF-01 surface). The kickoff set was re-measured, not carried forward as the definition.

- Kickoff re-measure: 08-RESEARCH.md:80 opened the full `generate_handler` block (lib.rs:229) and reconciled **365 registered commands, 365 matched definitions, zero unmatched** (forms: 240 ordinary sync, 76 `#[tauri::command(async)]`, 49 `async fn`). It states explicitly that "The historical 37 is not a conversion count" and produced 159 conversion candidates plus 152 mandatory AUDIT rows, where every AUDIT row was a required executor disposition task, not an exclusion from PERF-01.
- Exhaustive closure: `08-COMMAND-INVENTORY.md` carries a FINAL disposition for every row. An independent recount of the table during this verification: **365 rows total, 356 FINAL ISOLATED + 9 FINAL UI, zero AUDIT**, matching the 08-28 closure. The 9 UI rows are the per-tab `site_view` commands (inventory lines 95-103; cross-checked by 08-24-SUMMARY): pure platform dispatch that must remain on the main thread through required native webview APIs, with offload-only incidental I/O. They reach no network, subprocess, or unbounded walk.
- Machine gate: `scripts/check-command-isolation.mjs` exists and is wired into `make verify` (08-28-SUMMARY). It re-resolves live registrations from `src-tauri/src/lib.rs` on every run, asserts 1:1 inventory parity, rejects unresolved or AUDIT placeholders in nested evidence, and rejects mutation rows phrased as exact-path-only exclusion or existing-domain-guard exemption. Its own header honestly scopes it as "Evidence/registration drift gate, not a Rust call-graph or thread-safety proof".
- Spot-checks against code (this run): `git_status` registers as `git::ipc::git_status` (lib.rs:258) and its body awaits `spawn_blocking` (git.rs:1502-1531); `scan_vault` registers as `vault::ipc::scan_vault` (lib.rs:231) with a `spawn_blocking` body (vault.rs:1943-1975); `skills_read_skill` registers as `skill_host::store::ipc::skills_read_skill` (lib.rs:515) with a `spawn_blocking` wrapper (store.rs:6669-6678); all skills-store `pub mod ipc` wrappers offload (store.rs:6595 onward), and the module comment at store.rs:6593 records the pattern ("IPC owns scheduling; synchronous domain entry points remain shared with the CLI"). The only synchronous `cmd.output()` helper, `run_command` (store.rs:6565-6577), is reached only from spawn_blocking closures or from synchronous impls called inside them. Dispatch boundaries offload finite setup to the blocking pool while PTY readers and child waits keep dedicated threads (dispatch.rs:1423-1500).
- Test evidence: grep measured **457 `fn phase08*` definitions across `src-tauri/src`** during this verification (the 2026-09-21 validation audit recorded 449 at its time; the suite grew with the final plans). 08-VALIDATION.md records 119/119 mapped verification commands as pass at execution time (0 fail, 0 skip).

## Criterion 3: concurrency load test with flat unrelated latency

**Verified** (PERF-01 verification clause). Flatness is a measured property, not the absence of a visible freeze.

- Harness plumbing: `e2e-native/specs/responsiveness.spec.ts` (10 tests) plus `e2e-native/helpers/responsivenessSamples.ts`. Every timing value is measured inside the webview with `performance.now()` around real IPC promises, never around WebDriver round trips (helper header, responsivenessSamples.ts:4-12). The unrelated series are the same-runtime async probe and the production `parse_korean_date_cmd`, and the parse sample asserts the exact next-day instant for '내일' against a fixed now (responsivenessSamples.ts:25-27), so a no-op wrapper cannot pass.
- Load: four real registered commands fire at once, `git_status` x2 on dirty repos, `scan_vault` over a 2000-file tree, and `skills_sync_source` against a local bare remote, with a deterministic 2500ms pre-work interval held inside their real blocking closures by the feature-gated load control (`LOAD_CONTROL_OPS`, native_e2e.rs:27; `with_load_control`, native_e2e.rs:286-299). The runtime is installed as exactly two Tokio workers and asserted at startup (`install_test_runtime`, native_e2e.rs:29-48), so starvation of a shared pool is genuinely exercised.
- Frozen thresholds before any loaded run: idle calibration over three rounds writes `calibration.json`; thresholds are frozen from calibration before any loaded run (test order, responsiveness.spec.ts:251-270). `assertRoundOutcomes` requires `maxConcurrent == 4` and worker count 2 (spec:141-166); `assertWithinThresholds` requires zero missing samples, exact sample counts, loaded and recovery p95 within the frozen bounds, and max stall within 250ms (spec:178-200).
- Measured results (`artifacts/native-responsiveness/fixed-run.json`, generated 2026-09-06, buildRevision 65c73cb..., thresholdHash recorded): all three rounds pass at maxConcurrent 4 on 2 workers; probe loaded/recovery p95 = 2ms against the frozen 27ms bound; parse p95 = 6-7ms against 32ms; max stall 8/15/29ms against 250ms; missing = 0 in every series and window.
- Negative control: the same four operations are routed back onto the two async workers in blocking_async mode (`is_blocking_async` and `blocking_async_interval`, native_e2e.rs:304-318). `negative-control.json` records `violatedFrozenBounds: true` with probe loaded p95 of about 4790ms (max about 5092ms) against the 27ms bound. The harness demonstrably detects relocated blocking work, so the isolated pass is non-vacuous, exactly what the criterion's "not merely the absence of a visible freeze" wording demands.

## Requirement traceability

| Requirement | Status | Evidence |
| --- | --- | --- |
| PERF-02 | verified | store.rs:1203-1224 (async spawn_blocking wrapper), store.rs:1259-1400 (guard-scoped snapshot, guard-free network stage, fresh `load_registry_unlocked()` reload before guarded rescan/save), busy admission store.rs:253-298, `phase08_01_deleted_source_never_returns_at_all_three_edges` store.rs:8735-8750, native PERF-02 case responsiveness.spec.ts:538-565 |
| PERF-01 | verified | kickoff re-measure 08-RESEARCH.md:80 (365 commands), exhaustive closure 356 ISOLATED + 9 UI with zero AUDIT (08-COMMAND-INVENTORY.md FINAL column, recounted independently), checker wired into make verify (08-28-SUMMARY), native saturation fixed-run.json (probe p95 2ms, parse p95 6-7ms, maxStall at most 29ms, missing 0, maxConcurrent 4, workers 2) with the blockingAsync negative control violating the frozen bound (negative-control.json) |

`docs/performance/phase08-final.json` (decisionSourceAudit) maps both requirements to the same physical tests and artifacts. `.planning/REQUIREMENTS.md` still shows PERF-01/02 as `- [ ]` with traceability "Pending" (lines 26, 33, 187-188); flipping those checkboxes is the parent's bookkeeping step after accepting this verification and is not a code gap.

## Gaps

No gap blocks the phase goal. Notes for the record:

1. `scripts/check-command-isolation.mjs` is an evidence/registration drift gate, not a compiler-proven call graph (its own header and the inventory header say so). Function-body extraction can miss work hidden behind dynamic calls, traits, or conditional compilation. Mitigated by the full-body AUDIT closure across all 365 rows and by the native saturation run.
2. The native load harness covers exactly the three allowlisted ops (`git_status`, `scan_vault`, `skills_sync_source`), not all 356 isolated commands. This is a documented known limit (08-27-SUMMARY lines 135-136) with a recorded one-line extension path (`LOAD_CONTROL_OPS` plus arm validation and fixtures).
3. `artifacts/native-responsiveness/*.json` are local/untracked per the session contract (08-28-SUMMARY handoff); the numbers are quoted in committed summaries but the raw artifacts are not committed.
4. Pre-existing evidence drift, reproducing on pristine HEAD and unrelated to this phase's conversions (08-27-SUMMARY line 100): `node scripts/check-command-isolation.mjs --plan 05` fails because `phase08-05.json` names `phase08_05::pull_and_commit_push_wait_for_transaction_before_validation_or_process`, which is absent from `git.rs`. Recommend a follow-up evidence-shard correction.

## Human-judgment items

Already recorded honestly in coverage entries; no new human verification is required for this phase goal:

- 08-06 windows-parent-identity (human_judgment true, target-gated, not inferred from macOS results).
- 08-29 initial-fixture-escape-history: the first dispatch launch-error fixture could have selected the installed Claude executable, so historical external effects cannot be established or excluded. This bounds the pre-phase history, not the Phase 8 conversion work.
