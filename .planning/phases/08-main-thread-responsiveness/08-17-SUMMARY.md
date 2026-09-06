---
phase: 08-main-thread-responsiveness
plan: "17"
subsystem: agent-data-hub
tags: [rust, tauri, agent-host, hub-client, path-admission, concurrency]
requires:
  - phase: 08-16
    provides: Current isolated registration set and complete original-parent path admission contracts
provides:
  - Eleven isolated agent-status/event-store/cloud-dashboard/hub commands with preserved synchronous exports
  - Admitted single-file redacted-summary export writes, hub cache-tree writes and hub submit-queue writes
  - Thirteen behavioral tests and exact eleven-row evidence
  - Completed 08-29 agent_host/event_store module-integration handoff record
affects: [08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 120000
  tasks: 1
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, same-name pub mod ipc wrappers, shared path admission, in-transaction nested adapters, test-only credential-home seam, localhost HTTP fixture with ETag/304]
key-files:
  created: [docs/performance/phase08-17.json]
  modified: [src-tauri/src/agent_host/status.rs, src-tauri/src/agent_host/event_store.rs, src-tauri/src/agent_host/cloud_dashboard.rs, src-tauri/src/hub_client/mod.rs, src-tauri/src/lib.rs]
key-decisions:
  - Vec-returning status commands become Result<Vec<AgentAccountStatus>, String> / Result<Vec<AgentUsageStatus>, String>; the frontend success payload is byte-identical (the sync function's Vec is wrapped in Ok by the worker) and only a JoinError becomes the display-only agents_*_task_failed String.
  - agent_write_redacted_run_summary resolves relative export targets against std::env::current_dir() before lexical normalization so the admitted single-file write set lands exactly where the prior std::fs::write placement put it.
  - hub_fetch_catalog and hub_poll_gate admit the whole <workspace>/.maru/cache/hub tree because the shared etags.json index couples every cache write into one coherent store; hub_submit_gate and the enabled hub_queue_drain admit cache::queue_root, while disabled drains and all read-only paths take no lease.
  - The event_store append_run_event*_in_transaction adapters from the 08-29 staged integration stay synchronous and untouched; only the two read commands crossed the async boundary, and the shard records the completed module-integration handoff.
  - Status probes gained a test-only MARU_TEST_CLI_PROBE_TIMEOUT_MS knob (default 500ms unchanged) because full-suite parallel load made the 500ms spawn+exec budget flaky for the new fake-CLI fixture; the pre-existing sleeping-CLI timeout test now scales its upper bound with the same knob it exercises.
requirements-completed: [PERF-01]
coverage:
  - id: AGENT-DATA-HUB-ISOLATION
    description: All 11 owned IPC futures preserve meaningful synthetic results and typed/legacy rejections while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_17
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 17
        status: pass
    human_judgment: false
  - id: AGENT-DATA-HUB-MUTATION-LIFETIME
    description: Shared admission covers the redacted-summary export file, the hub cache tree and the hub submit queue with original parents and aliases; cross-domain contention in both orders, error/unwind release and alias-parent revalidation pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_17
        status: pass
    human_judgment: false
duration: cross-session
completed: 2026-09-06
status: complete
---

# Phase 08 Plan 17: Agent Data and Hub Command Isolation Summary

All 11 agent-status, event-store, cloud-dashboard and hub commands now run their blocking work (CLI probes, run-event reads, file writes, queue/cache mutation and bounded HTTP) in awaited `spawn_blocking` workers behind same-name `pub mod ipc` wrappers. Shared path admission protects the redacted-summary export file, the hub cache tree and the hub submit queue; original synchronous APIs, wire names, preflight policy and error strings remain intact.

## Execution and Commits

This plan crossed sessions: wrappers, transaction adapters and tests landed uncommitted from a prior session; this session fixed three red tests and one hang, hardened one fixture against full-suite process-spawn load, authored the evidence shard and closed the 08-29 event_store handoff. No commit was made per the session contract; all changes stay uncommitted for the parent to land.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_17 | Passed: 13 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1667 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 17 | Passed: exact 11 rows, 365 production registrations, 0 native-only commands |

The 13 tests comprise status 2, event_store 2, cloud_dashboard 4 and hub 5. Every wrapper has a meaningful result/rejection fixture and a same-runtime yield while a distinct blocking worker is held. Mutation cases cover Files rename/trash parent races in both admission orders with lexical and symlink-alias variants, same-target cache/queue contention, error/unwind admission release and no parent recreation.

## Corrections and Evidence History

1. The cloud write and hub queue parent-race fixtures started the Files rename/trash competitor against an export/.maru directory that did not exist yet; `rename_workspace_entry_in_transaction` resolves the source before `before_effect`, so the parent errored early and the Held hook timed out. The fixtures now create the parent up front, matching the real world where a previous export/enqueue created it.
2. The hub round-trip test hung: `fetch_with_cache` only returns `from_cache: true` on a 304, but the localhost fixture always answered 200, so the assertion panicked and the fixture server's fixed-count accept loop blocked its Drop join forever. The fixture now honors `If-None-Match` with a 304, the second fetch sends `revalidate: true`, and the accept loop is deadline-bounded so a count mismatch can never hang the suite again.
3. `phase08_17_hub_queue_error_release_and_drain_contention` loops two rounds of two serialized drains; the final `retry_count` assertion expected 2 but each of the 4 drains bumps the retried item once, so it now expects 4.
4. The full suite exposed load-dependent flakiness in the new status fixture: the pre-existing 500ms `run_cli` test budget was exceeded by process-spawn contention. `cli_probe_timeout` gained a `MARU_TEST_CLI_PROBE_TIMEOUT_MS` test override used by the phase08_17 fixtures, and the pre-existing `run_cli_times_out_on_sleeping_process` upper bound now scales with the same knob instead of a hard 5s, preserving its kill-before-30s intent under both values.
5. check-command-isolation rejected one evidence row for a behavior-case typo (`..._map_join_failure` vs the physical `..._maps_join_failure`); the shard now names every case exactly.

## Frontend Handoff and Limits

- `src/lib/api.ts`, `src/lib/skills.ts`, `src/lib/hubClient.ts`, `src/components/skills/SkillRunsPanel.tsx`, `src/components/tasks/TasksRunsPanel.tsx`, `src/components/inbox/InboxRunsPanel.tsx` and `src/components/catalog/CatalogPane.tsx` keep existing invocation, polling, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and exactly-one terminal notices remain Plans25/26. `hub_poll_gate` has no frontend caller today; the evidence records that explicitly.
- The completed 08-29 event_store handoff (docs/performance/phase08-17.json moduleIntegrations) records the five append_run_event* entry symbols as final-module-owned synchronous adapters; the pre-existing uncommitted `skill_host/dispatch.rs` caller-parents work stays untouched for its later plan.
- Admission excludes cooperating in-process writers only. Real provider CLIs, other processes and network state stay outside the lease; tests use fake executables, a localhost HTTP fixture, RFC1918 blackhole endpoints and disposable homes/workspaces, and never call live account usage endpoints.
- No automatic sync retry, duplicate queue, new job center, new dependency or Phase09 quit/terminal escalation was introduced.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan17's contribution.

## Threats and Self-Check

- T-08-17-01: original-parent and alias snapshots, preflight safety gating, run-id validation and real cross-domain both-order tests mitigate owned-write tampering.
- T-08-17-02: awaited blocking workers, same-runtime yield proof, fail-closed revalidation, unwind release and the deadline-bounded fixture mitigate new async-pool stalls and deadlocks.
- T-08-17-03: disposable homes/workspaces, fixture executables, redaction-preserving summaries and synthetic fixture paths constrain the proof; no live provider, credential or user-registry claim is made.

## Self-Check: PASSED

All 11 owned rows are final in docs/performance/phase08-17.json, the 08-29 event_store handoff is complete, and all required checks pass (phase tests 13/13, full suite 1667/0/3, maru-cli check, clippy, fmt, checker --plan 17). Changes remain uncommitted per the session contract.
