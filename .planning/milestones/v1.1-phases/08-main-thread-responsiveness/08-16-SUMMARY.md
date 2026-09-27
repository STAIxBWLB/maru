---
phase: 08-main-thread-responsiveness
plan: "16"
subsystem: agents-missions-agent-host
tags: [rust, tauri, agents, ai-router, mission-state, skill-proposals, structured-loop, concurrency]
requires:
  - phase: 08-14
    provides: Current isolated registration set and complete original-parent path admission contracts
  - phase: 08-15
    provides: Shared alias-ancestor parent pinning in the path transaction helper
provides:
  - Twelve isolated agents/ai-router/mission-state/skill-proposal/structured-loop commands with preserved synchronous exports
  - Admitted ~/.maru/agents.json registry writes, mission record writes, and proposal apply write sets with run-event appends
  - Eighteen behavioral tests and exact twelve-row evidence
  - Completed 08-29 mission_state module-integration handoff record
affects: [08-17, 08-25, 08-26, 08-27, 08-28]
actuals:
  tokens: 95000
  tasks: 1
  commits: 0
tech-stack:
  added: []
  patterns: [spawn_blocking, owned AppHandle, generic-over-Runtime sync exports, shared path admission, in-transaction nested adapters]
key-files:
  created: [docs/performance/phase08-16.json]
  modified: [src-tauri/src/agents.rs, src-tauri/src/ai_router.rs, src-tauri/src/mission_state.rs, src-tauri/src/agent_host/proposal.rs, src-tauri/src/agent_host/structured_loop.rs, src-tauri/src/lib.rs]
key-decisions:
  - Synchronous command exports stay available for Rust callers and are now generic over tauri::Runtime (plan-14 telegram precedent), so unit tests can drive the async wrappers under MockRuntime; ai_router's whole spawn chain (start_agent_cli_invocation, start_claude_cli_invocation, spawn_streaming_invocation, spawn_line_pump) and mission_state's register_mission_logical followed the same generalization.
  - agents mutations admit only ~/.maru/agents.json; the write_atomic random tempfile is covered by pinning the ~/.maru parent, and the non-transactional save_file helper is kept test-only for fixture seeding.
  - agent_apply_skill_proposal builds the complete write set before admission (every vault-resolved file target, its .maru-write.tmp sidecar, and the run-events log when a run id is present) and appends run events through append_run_event_payload_in_transaction under the same lease.
  - The mission_state parent-race test registers the mission before the contention starts, so the stop transaction's lease (not the register transaction's) races the workspace rename/trash competitor in both orders.
  - The ai_router launch proof stays hermetic by driving the generic bridge with fake claude/codex executables through command_override; the legacy start_claude_cli_invocation wrapper keeps its host-dependent PATH resolution and its happy path is documented as a limit rather than faked.
requirements-completed: [PERF-01]
coverage:
  - id: AGENTS-MISSIONS-ISOLATION
    description: All 12 actual IPC futures preserve meaningful synthetic results and error channels while yielding on their own polling task with a distinct blocked worker.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_16
        status: pass
      - kind: other
        ref: node scripts/check-command-isolation.mjs --plan 16
        status: pass
    human_judgment: false
  - id: AGENTS-MISSIONS-MUTATION-LIFETIME
    description: Shared admission covers the agents registry, mission records and proposal apply write sets with original parents and aliases; cross-domain contention in both orders, error/unwind release and alias-parent revalidation pass.
    requirement: PERF-01
    verification:
      - kind: unit
        ref: cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_16
        status: pass
    human_judgment: false
duration: cross-session
completed: 2026-09-05
status: complete
---

# Phase 08 Plan 16: Agents, Missions and Agent-Host Isolation Summary

All 12 agents, ai-router, mission-state, skill-proposal and structured-loop commands now run their blocking work and lock waits in awaited workers. Shared admission protects the ~/.maru/agents.json registry, mission records and proposal apply write sets; original synchronous APIs, wire names, approval checks and error strings remain intact.

## Execution and Commits

This plan crossed sessions: wrappers, transaction adapters and tests landed uncommitted from a prior session; this session fixed the red tests, closed admission-path mismatches, authored the evidence shard and closed the 08-29 mission_state handoff. No commit was made per the session contract; all changes stay uncommitted for the parent to land.

| Command | Disposition |
|---|---|
| cargo test --manifest-path src-tauri/Cargo.toml --lib phase08_16 | Passed: 18 passed, 0 failed |
| cargo test --manifest-path src-tauri/Cargo.toml --lib (full suite) | Passed: 1654 passed, 0 failed, 3 ignored |
| cargo check --manifest-path src-tauri/Cargo.toml -p maru-cli | Passed |
| cargo clippy --manifest-path src-tauri/Cargo.toml --lib -- -D warnings | Passed |
| cargo fmt --manifest-path src-tauri/Cargo.toml -- --check | Passed |
| node scripts/check-command-isolation.mjs --plan 16 | Passed: exact 12 rows, 365 production registrations, 0 native-only commands |

The 18 tests comprise agents 4, missions 4, ai_router 2, proposals 6 and structured_loop 2. Every wrapper has a meaningful result/rejection fixture and a same-runtime yield while a distinct blocking worker is held. Mutation cases cover parent rename/trash in both orders, lexical-alias variants, error/unwind admission release and no parent recreation.

## Corrections and Evidence History

1. The contention tests' Held hooks originally targeted fixture paths the commands never admitted: the agents commands resolve ~/.maru from MARU_TEST_HOME (now re-pointed at the per-iteration fixture), and the mission commands with MARU_MISSION_STATE_DIR set write directly into the override directory (the key now matches the admitted json path instead of a phantom missions/ child). Restore renames also targeted a non-existent parent and are fixed.
2. The child-first contention branches never awaited the competitor future, racing its rename against the moved-file assertion; both the agents and mission tests now join the parent task before asserting.
3. In the proposal apply parent-race test, the non-alias rename happens inside work/, not the fixture root (moved_dir computed per alias mode), the note fixture is written after the alias symlink is in place, and "{broken" is replaced with "{broken}" because an unbalanced object is reported as skill_proposal_json_missing, not invalid.
4. The ai_router launch test originally invoked the legacy claude wrapper with no command override, which resolves a real claude binary from PATH and never finishes hermetically; the round-trip now drives the generic bridge with fake claude/codex executables while the wrapper's own rejection cases stay covered.
5. check-command-isolation --all previously reported `08-29 missing 08-16 completed handoff` from the pre-existing uncommitted dispatch.rs overlay work; this shard now carries the completed mission_state handoff record and --all fails only on `08-29 missing 08-17 completed handoff` (event_store.rs, owned by the not-yet-executed plan 08-17), identical before and after this shard.

## Frontend Handoff and Limits

- `src/lib/agents.ts`, `src/lib/api.ts`, `src/lib/agentChat.ts`, `src/lib/skills.ts` and `src/components/skills/SkillRunsPanel.tsx` keep existing invocation, polling, busy and error handling; wire payloads and error strings are unchanged, so no frontend edit is required. D-04 completion ownership, stale-view protection and exactly-one terminal notices remain Plans25/26.
- The completed 08-29 mission_state handoff (docs/performance/phase08-16.json moduleIntegrations) records the existing _in_transaction entry symbols as final-module-owned; the pre-existing uncommitted `skill_host/dispatch.rs` caller-parents work stays untouched for its later plan.
- Admission excludes cooperating in-process writers only. Real provider CLIs, other processes and network state stay outside the lease; tests use fake executables, real short-lived sleep children and disposable homes.
- No automatic sync retry, duplicate queue, new agent center, new dependency or Phase09 quit/terminal escalation was introduced.
- PERF-01/PERF-02 remain globally outstanding. This SUMMARY records only Plan16's contribution.

## Threats and Self-Check

- T-08-16-01: original-parent and alias snapshots, approval gating, bounded line clamps and real cross-domain both-order tests mitigate owned-write tampering.
- T-08-16-02: awaited blocking workers, same-runtime yield proof, fail-closed revalidation and unwind release mitigate new async-pool stalls and deadlocks.
- T-08-16-03: disposable homes, fixture executables and synthetic missions constrain the proof; no live provider, credential or user-registry claim is made.

## Self-Check: PASSED

All 12 owned rows are final in docs/performance/phase08-16.json, the 08-29 mission_state handoff is complete, and all required checks pass (phase tests, full suite, maru-cli check, clippy, fmt, checker --plan 16). The only --all failure is the pre-existing 08-17 handoff owned by a later plan. Changes remain uncommitted per the session contract.
