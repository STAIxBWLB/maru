---
phase: 09-durability-and-session-lifecycle
plan: 02
subsystem: terminal
tags: [rust, tauri, portable-pty, process-groups, signals, terminal-lifecycle]

# Dependency graph
requires: []
provides:
  - "Process-group-targeted, timeout-gated SIGHUP -> SIGTERM -> SIGKILL escalation ladder for terminal_kill (REL-01)"
  - "D-12 quit-time sweep (shutdown_all_sessions) that clears every live and in-flight terminal process group within a 3s budget"
affects: [09-durability-and-session-lifecycle, terminal-subsystem]

# Actuals (#2632)
actuals:
  tokens: 8677
  tasks: 2
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Raw extern \"C\" fn kill(pid, signal) FFI idiom (reused from command_output.rs) parameterized by signal number instead of hardcoded SIGKILL"
    - "Detached std::thread per escalation, holding no session/registry/killer lock while sleeping"
    - "Batch ladder (sweep_sessions) that polls a whole Vec<u32> of process groups against one shared step deadline, instead of a per-group grace period, to stay inside a fixed total quit budget"

key-files:
  created: []
  modified:
    - src-tauri/src/terminal/mod.rs
    - src-tauri/src/lib.rs
    - docs/performance/phase08-18.json

key-decisions:
  - "portable-pty already calls setsid() before exec, so the terminal child's captured pid equals its pgid and sid for its whole lifetime -- no setpgid()/pre_exec injection needed, confirmed at vendored source level per 09-RESEARCH.md Pattern 2"
  - "Kept the existing killer.kill() (ProcessSignaller) path unchanged for sessions with no captured process_group (Windows, or any future non-PTY spawn path), so the killer field stays read on every platform"
  - "escalation_warn_line builds both the SIGTERM and SIGKILL warn lines from one format! call parameterized by signal name, so exactly one format site produces the D-11 line"
  - "sweep_sessions runs one shared ladder across the whole batch of drained groups (send SIGHUP to all, poll all together, escalate survivors together) rather than looping a per-group escalate_process_group call, so the quit sweep stays inside a fixed 2 x QUIT_SWEEP_STEP budget regardless of how many terminals are open"

requirements-completed: [REL-01]

coverage:
  - id: D1
    description: "Closing a tab whose child traps SIGHUP still kills it via the SIGHUP -> SIGTERM -> SIGKILL escalation ladder, targeted at the child's own process group"
    requirement: "REL-01"
    verification:
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_sighup_trapping_child_dies_via_escalation_ladder"
        status: pass
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_direct_spawn_escalates_to_sigkill_when_hup_and_term_trapped"
        status: pass
    human_judgment: false
  - id: D2
    description: "A grandchild deliberately backgrounded into its own process group survives the tab's kill ladder; only the terminal child's own group is signaled"
    requirement: "REL-01"
    verification:
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_backgrounded_grandchild_survives_tab_close"
        status: pass
    human_judgment: false
  - id: D3
    description: "terminal_kill returns immediately (under 500ms) and the generation-token invariant keeps late output from a dying child out of a recycled session id"
    requirement: "REL-01"
    verification:
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_sighup_trapping_child_dies_via_escalation_ladder"
        status: pass
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_generation_invariant_blocks_late_output_and_stale_handle"
        status: pass
    human_judgment: false
  - id: D4
    description: "An escalation beyond SIGHUP writes exactly one D-11 warn line naming SIGTERM or SIGKILL, and a repeated terminal_kill on the same handle is idempotent without blocking other sessions' spawn/kill"
    requirement: "REL-01"
    verification:
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_escalation_warn_line_matches_d11_format"
        status: pass
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_repeated_kill_is_idempotent_and_does_not_block_other_sessions"
        status: pass
    human_judgment: false
  - id: D5
    description: "D-12: at app quit, every live terminal session and every process group whose tab-close ladder is still in flight is swept (SIGHUP -> SIGTERM -> SIGKILL) within a bounded budget, wired into the existing RunEvent exit arm with no new Rust CloseRequested handler"
    requirement: "REL-01"
    verification:
      - kind: integration
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_sweep_sessions_clears_live_and_mid_ladder_groups"
        status: pass
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs::phase09_02::phase09_02_sweep_sessions_on_empty_state_returns_immediately"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-09-26
status: complete
---

# Phase 9 Plan 2: Terminal Force-Kill Escalation Summary

**SIGHUP-trapping terminal children now die through a process-group-targeted SIGHUP -> SIGTERM -> SIGKILL ladder, and a D-12 quit sweep kills every live or in-flight terminal group within a bounded budget when Maru exits.**

## Performance

- **Duration:** 55 min
- **Tasks:** 2 completed
- **Files modified:** 3 (`src-tauri/src/terminal/mod.rs`, `src-tauri/src/lib.rs`, `docs/performance/phase08-18.json`)
- **Commits:** 3

## Accomplishments

- `terminal_kill` captures the terminal child's spawn-time pid (`TerminalSession.process_group`) at spawn (already its own process-group and session leader via portable-pty's `setsid()`) and signals `-pgid` instead of a bare pid, so foreground descendants sharing that group die too while a deliberately backgrounded grandchild (its own group) survives.
- A detached thread (`escalate_process_group`) runs the SIGHUP -> 2s -> SIGTERM -> 2s -> SIGKILL ladder without holding any session, registry, or killer lock while sleeping, so `terminal_kill` still returns in well under 500ms and other terminal operations are never blocked by it.
- Escalation beyond SIGHUP writes exactly one D-11 `warn`-level stderr line (`[terminal] pgid <n> survived SIGHUP; escalated to SIGTERM|SIGKILL`), built from a single `format!` call parameterized by signal name.
- `sweep_sessions`/`shutdown_all_sessions` implement D-12: at app quit, every live session and every process group whose per-tab escalation is still in flight is drained into one batch and run through a shared SIGHUP -> SIGTERM -> SIGKILL ladder bounded by two 1.5s steps (`QUIT_SWEEP_STEP`), keeping the whole sweep inside the 3s quit budget. An empty sweep (the common case) returns in under 50ms.
- `shutdown_all_sessions` is wired into the existing `RunEvent::ExitRequested | RunEvent::Exit` arm in `lib.rs`, after `stop_poller_on_exit`, with no new Rust `CloseRequested` handler; per D-06 this only fires once the webview's own close guards have already let the quit proceed.
- Six new real-PTY / direct-spawn `phase09_02` tests cover the SIGHUP-trap-and-kill path, the SIGKILL fallback when both HUP and TERM are trapped, the grandchild-survival precondition, the D-11 line format, repeated-kill idempotency without blocking other sessions, and the sweep over live plus mid-ladder groups.
- Refreshed the `terminal_kill` evidence row's `helperChain` text in `docs/performance/phase08-18.json` to name the new `signal_process_group`/`escalate_process_group` call chain; the command-isolation gate still passes at the pinned count of 382.

## Task Commits

Each task was committed atomically (Task 2 followed the TDD RED/GREEN cycle):

1. **Task 1: Closing a SIGHUP-trapping tab kills its process group through the escalation ladder** - `7fce77c` (feat)
2. **Task 2 RED: failing tests for SIGKILL escalation, one-warn-line, and the D-12 quit sweep** - `a1a5ff7` (test)
3. **Task 2 GREEN: D-12 quit sweep implementation** - `fabf294` (feat)

_Note: Task 2 carried `tdd="true"`; no REFACTOR commit was needed. The GREEN implementation needed no follow-up cleanup beyond the `escalation_warn_line` single-format-site shape, which was written directly into the GREEN commit._

## Files Created/Modified

- `src-tauri/src/terminal/mod.rs` - `TerminalSession.process_group`, `TerminalState.escalations`, `signal_process_group`/`process_group_alive`/`escalate_process_group`/`escalation_warn_line`/`begin_group_kill`/`kill_via_signaller` helpers, rewritten `terminal_kill`, `sweep_sessions`/`shutdown_all_sessions`, and the `phase09_02` test module (8 tests)
- `src-tauri/src/lib.rs` - one added call to `terminal::shutdown_all_sessions` inside the existing `RunEvent` exit arm
- `docs/performance/phase08-18.json` - `terminal_kill` row's `helperChain` second sentence refreshed to name the new signal path; no other field touched

## Decisions Made

- Confirmed via vendored `portable-pty-0.8.1` source (matching 09-RESEARCH.md) that `setsid()` already runs in the child's `pre_exec`, so no `pre_exec`/`setpgid` injection was added; only the kill-side FFI needed porting from `command_output.rs`.
- Kept the bare `ChildKiller::kill()` fallback path for any session with no captured `process_group` (non-unix, or a future spawn path that doesn't yield a pid), rather than special-casing it out, so the `killer` field stays read (and clippy-clean) on every platform.
- Chose a single parameterized `format!` call in `escalation_warn_line` over two separate `format!` calls per stage, to keep exactly one format site producing the D-11 line text (the acceptance criterion this task's grep check is designed against).
- Designed `sweep_sessions` as one shared batch ladder (signal all targets, poll all together, escalate survivors together) instead of calling `escalate_process_group` per session, so the quit sweep's total duration stays bounded by `2 x QUIT_SWEEP_STEP` regardless of how many terminals are open at quit time.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixture race: SIGHUP sent before the shell installed its `trap`**
- **Found during:** Task 1, first run of `phase09_02_sighup_trapping_child_dies_via_escalation_ladder`
- **Issue:** The test captured the session's `process_group` and sent SIGHUP immediately after `terminal_spawn` returned. `terminal_spawn` returns once the PTY child is registered, not once the shell has finished executing `trap '' HUP`; so the SIGHUP sometimes reached the shell before the trap was installed, killing it via the default disposition and producing a false failure that looked like the escalation ladder was not needed.
- **Fix:** Each trap-based fixture script now echoes a `TRAP-READY` marker immediately after installing its trap; a new `wait_for_marker` test helper polls `terminal_text` until that marker appears before the test proceeds to capture the pgid and call `terminal_kill`. Applied to all three trap-based `phase09_02` tests introduced in Task 1.
- **Files modified:** `src-tauri/src/terminal/mod.rs` (test-only)
- **Verification:** `cargo test --lib phase09_02` run 4x consecutively with 0 flakes after the fix (was reproducing ~100% before it).
- **Committed in:** `7fce77c` (part of Task 1's commit; the race was caught and fixed before committing, so no separate fix commit was needed)

**2. [Rule 1 - Bug] Two direct-kill assertions raced the kernel's own teardown of a just-SIGKILLed process**
- **Found during:** Task 2 GREEN, first run of `phase09_02_direct_spawn_escalates_to_sigkill_when_hup_and_term_trapped` and `phase09_02_sweep_sessions_clears_live_and_mid_ladder_groups`
- **Issue:** Both `escalate_process_group` and `sweep_sessions` return immediately after sending the final SIGKILL, by design (no polling after the kill signal; polling belongs to the ladder's own retry logic, not its exit). The two tests asserted `!process_group_alive(pgid)` in the very next line, racing the kernel's actual process teardown and the waiter thread's `child.wait()` reap; a zombie process still answers `kill(pid, 0)` successfully until reaped.
- **Fix:** Replaced the immediate single-shot assertions with the existing `wait_until_group_gone(pgid, Duration::from_secs(2))` poll-with-timeout helper (already used by Task 1's SIGHUP test), giving the kernel/waiter-thread a bounded window to finish.
- **Files modified:** `src-tauri/src/terminal/mod.rs` (test-only)
- **Verification:** Both tests pass consistently across repeated runs after the fix.
- **Committed in:** `fabf294` (part of Task 2's GREEN commit)

---

**Total deviations:** 2 auto-fixed (both Rule 1, test-fixture timing bugs, not production code bugs)
**Impact on plan:** Both fixes are confined to the new test module; no production code (`terminal_kill`, `escalate_process_group`, `sweep_sessions`) was changed to accommodate them. No scope creep.

## Issues Encountered

None beyond the two test-timing races documented above as deviations.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- REL-01 (terminal force-kill) is fully implemented and verified on a real PTY: the escalation ladder, grandchild survival, the generation-token invariant, and the D-12 quit sweep all pass.
- `src-tauri/src/terminal/mod.rs`'s `phase09_02` module (`process_group`, `escalations`, `signal_process_group`, `escalate_process_group`, `sweep_sessions`) is now available as an established pattern for any later plan touching terminal lifecycle.
- REL-02/REL-03 (debounced-save flush on unmount/quit, quit-flush failure visibility) and REL-04 (verify-only tilde-expansion check) remain for other plans in this phase; this plan did not touch `src/lib/debouncedSave.ts`, any autosave surface, `useDestructiveActionGuard.ts`, or `app_menu.rs`.
- No blockers for subsequent Phase 9 plans.

---

*Phase: 09-durability-and-session-lifecycle*
*Plan: 02*
*Completed: 2026-09-26*

## Self-Check: PASSED

- FOUND: src-tauri/src/terminal/mod.rs
- FOUND: src-tauri/src/lib.rs
- FOUND: docs/performance/phase08-18.json
- FOUND commit: 7fce77c (feat: process-group escalation ladder)
- FOUND commit: a1a5ff7 (test: RED-phase failing tests)
- FOUND commit: fabf294 (feat: D-12 quit sweep, GREEN)
- Re-ran plan `<verification>`: `cargo test --lib phase09_02` (8 passed), `cargo test --lib phase08_18` (4 passed), `cargo clippy -- -D warnings` (clean), `cargo fmt --check` (clean), `cargo check -p maru-cli` (clean), `node scripts/check-command-isolation.mjs --plan 18 --expected-count 382` (PASS)
