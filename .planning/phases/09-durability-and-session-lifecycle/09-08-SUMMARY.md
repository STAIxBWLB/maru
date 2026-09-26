---
phase: 09-durability-and-session-lifecycle
plan: 08
subsystem: infra
tags: [tauri, acl, quit, terminal, pty, process-groups, i18n, rust, react]

# Dependency graph
requires:
  - phase: 09-02
    provides: terminal escalation ladder (SIGHUP -> SIGTERM -> SIGKILL) and the quit-time sweep hook
  - phase: 09-03
    provides: one quit path (app.quit and window close both reach useDestructiveActionGuard's onCloseRequested)
  - phase: 09-05
    provides: SettlingDebouncedSaver / flushSettled, the settling-saver primitive teardown flushes build on
  - phase: 09-06
    provides: reportTeardownSaveFailure, recovery-copy writer, OperationNotice toast surface
  - phase: 09-07
    provides: every autosave surface registered through useTeardownFlush
provides:
  - flushPendingSavesForQuit in teardownSave.ts: settles every mounted autosave surface with a 3s budget before a quit is allowed to proceed
  - useDestructiveActionGuard extended with quitSaving (300ms indicator), quitFailureKind, failedQuitAction, retryQuit, quitAnyway, and the "save-failed" pending-action state
  - App.tsx save-failed dialog variant and quit-saving toast indicator
  - core:window:allow-destroy granted in capabilities/default.json, without which no quit path could ever actually close the window
  - kill_target_pgids / escalate_process_groups in terminal/mod.rs: both terminal_kill and the quit sweep now also kill the pty's current foreground process group, not just the terminal child's own leader group
  - e2e-native/specs/quit.spec.ts as CI-side native coverage for a clean quit actually exiting the process
affects: [10-*, any future phase touching window lifecycle, terminal process management, or the destructive-action guard]

# Actuals (#2632)
actuals:
  tokens: 20078
  tasks: 3
  commits: 9

tech-stack:
  added: []
  patterns:
    - "Tauri ACL capabilities must be checked against the actual IPC command the JS SDK issues internally (onCloseRequested's wrapper calls destroy(), not close()), not just the command the app code calls directly."
    - "tauri::test::MockRuntime + tauri::generate_context!() drives the real ACL/capability resolution path without a real window or socket -- the fastest, most deterministic way to prove a permission gap, when a native-e2e/WebDriver harness cannot be relied on in the current environment."
    - "generate_context!() embeds a #[no_mangle] static once per final binary; a second live call site in the same compiled artifact is a link error. A #[cfg(not(test))]/#[cfg(test)] split on the function that calls it keeps a production entry point and a test-only entry point mutually exclusive in any one build."
    - "An interactive, job-control shell assigns a NEW process group to every foreground external command, distinct from the shell's own leader group; a kill/escalation ladder that only targets the leader misses anything running in the foreground at that moment. tcgetpgrp on the pty master (portable-pty's process_group_leader()), captured before any signal is sent, finds the current foreground group without touching background/disowned jobs."

key-files:
  created:
    - src/lib/useDestructiveActionGuard.test.tsx
    - e2e-native/specs/quit.spec.ts
  modified:
    - src/lib/teardownSave.ts
    - src/lib/teardownSave.test.ts
    - src/lib/useDestructiveActionGuard.ts
    - src/App.tsx
    - src/lib/i18n/locales/en.ts
    - src/lib/i18n/locales/ko.ts
    - src-tauri/capabilities/default.json
    - src-tauri/src/lib.rs
    - src-tauri/src/terminal/mod.rs
    - docs/native-e2e.md
    - docs/performance/phase08-18.json

key-decisions:
  - "Quit flush budget is 3s (QUIT_FLUSH_BUDGET_MS), with a 300ms indicator threshold (QUIT_SAVING_INDICATOR_MS) below which no UI appears at all -- matches D-04's stated UX."
  - "A failed or timed-out flush never closes the window on its own; Quit anyway / Relaunch anyway is an explicit, non-default button (Retry is primary) -- matches D-05."
  - "core:window:allow-destroy added to capabilities/default.json (main + skill-editor windows): the onCloseRequested wrapper in @tauri-apps/api always calls destroy() when the handler does not preventDefault(), and Tauri's own default on_window_event always prevents the native close once any JS close-requested listener exists, so a granted destroy permission is the only path to an actual close, for every quit route (Cmd+Q, menu Quit, close button, Retry, Quit anyway) alike."
  - "terminal_kill and the quit sweep both target the terminal session's own leader process group PLUS the pty's current foreground process group (via tcgetpgrp), captured before either group is signaled. A background or disowned job is never the pty's foreground group, so REL-01/D-09 survival semantics are unchanged."
  - "QUIT_SWEEP_STEP shortened from 1.5s to 1s per stage (still SIGHUP-wait / SIGTERM-wait / SIGKILL): the previous timing measured ~4s end to end in the real app, overrunning the 3s quit budget once signal-send and thread/reap overhead are added on top of the raw poll windows. Tab close keeps its own 2s + 2s ladder (KILL_ESCALATION_GRACE) -- only the quit sweep is boxed against a fixed external deadline."
  - "The quit-sweep D-11 log line now names the final signal (\"... escalated N process group(s) past SIGHUP; final signal SIGKILL\"), matching the per-tab-close line's existing convention instead of only ever mentioning SIGHUP."
  - "run() in lib.rs is split behind #[cfg(not(test))] (the real body) / #[cfg(test)] (an unreachable!() stub): generate_context!() can only have one live call site per compiled binary, and quit_acl_tests needed its own call against this crate's real tauri.conf.json + capabilities. main.rs's dependency edge on the lib is compiled without --cfg test, so production builds are unaffected."
  - "The native-e2e WebDriver harness (tauri-plugin-wdio-webdriver, port 4445) could not be relied on in this sandboxed execution environment -- its embedded server bound successfully exactly once across many attempts, including for an untouched, unrelated existing spec, ruling out a code regression as the cause. e2e-native/specs/quit.spec.ts is committed as real coverage for the CI environment where this harness works (docs/native-e2e.md: CI compiles and runs native-e2e per PR); the tauri::test::MockRuntime ACL test was used instead as the reliable local substitute for proving the destroy-permission fix in this session."

requirements-completed: [REL-02, REL-03]

coverage:
  - id: D1
    description: "Quit flushes every mounted autosave surface within a 3s budget before allowing the window to close (flushPendingSavesForQuit), with the flush call preceding the dirty-draft check in the close handler"
    requirement: REL-02
    verification:
      - kind: unit
        ref: "src/lib/teardownSave.test.ts#flushPendingSavesForQuit"
        status: pass
      - kind: unit
        ref: "src/lib/useDestructiveActionGuard.test.tsx#onCloseRequested"
        status: pass
    human_judgment: false
  - id: D2
    description: "300ms saving indicator and a save-failed dialog (Retry primary, Quit anyway / Relaunch anyway and Cancel as ghost buttons) for both close and relaunch, with i18n copy in en/ko"
    requirement: REL-02
    verification:
      - kind: unit
        ref: "src/lib/useDestructiveActionGuard.test.tsx#quitSaving indicator and the save-failed dialog"
        status: pass
    human_judgment: false
  - id: D3
    description: "core:window:allow-destroy granted so a clean quit (Cmd+Q, menu Quit, close button, Retry, Quit anyway) actually closes the window, not just runs the flush -- the round-1 owner regression"
    requirement: REL-02
    verification:
      - kind: unit
        ref: "src-tauri/src/lib.rs#quit_acl_tests::main_window_can_destroy_itself_through_the_real_capabilities"
        status: pass
    human_judgment: true
    rationale: "Real window-close behavior (Cmd+Q, menu Quit, the close button) can only be observed on a real macOS build; the owner re-verified this across checkpoint rounds 2 and 3 in the real app."
  - id: D4
    description: "terminal_kill (tab close) and the quit sweep both kill the pty's current foreground process group in addition to the session's own leader group, so a foreground job (e.g. trap '' HUP; sleep 600) no longer survives and reparents to launchd -- the round-2 owner regression -- while a background/disowned job still survives both paths"
    requirement: REL-03
    verification:
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs#phase09_02::phase09_02_tab_close_kills_the_interactive_foreground_job_group"
        status: pass
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs#phase09_02::phase09_02_quit_sweep_kills_the_interactive_foreground_job_group_within_budget"
        status: pass
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs#phase09_02::phase09_02_disowned_job_survives_tab_close_even_with_foreground_targeting"
        status: pass
      - kind: unit
        ref: "src-tauri/src/terminal/mod.rs#phase09_02::phase09_02_disowned_job_survives_quit_sweep"
        status: pass
    human_judgment: true
    rationale: "Real process survival/exit and OS reparenting to launchd can only be observed on a real build; the owner re-verified this in checkpoint round 3."
  - id: D5
    description: "End-to-end human verification of the whole phase's quit and teardown behavior in the real app: clean quit, failing-save dialog with recovery copy, Retry, Quit anyway, terminal cleanup at quit and at tab close, and disowned-process survival"
    requirement: REL-03
    verification: []
    human_judgment: true
    rationale: "Task 3 is a checkpoint:human-verify by design -- physical key/menu delivery, real disk permission failures, and OS process state after quit require a person on a real build. The owner completed three checkpoint rounds (see Issues Encountered) and approved all items in round 3."

# Metrics
duration: 4h37m
completed: 2026-09-26
status: complete
---

# Phase 9 Plan 8: Quit-flush-before-close, the destroy-permission gap, and the foreground-job kill gap Summary

**Quit now flushes every mounted autosave within a 3s budget, refuses to close over a failed save, and actually exits the process afterward (closing two ACL/process-group gaps a human found in the real app that no automated check in this repo had caught before).**

## Performance

- **Duration:** 4h37m (spans three human checkpoint rounds; see Issues Encountered)
- **Started:** 2026-09-26T00:39:00Z (approx.)
- **Completed:** 2026-09-26T05:15:47Z
- **Tasks:** 3 (2 automated + 1 human-verify checkpoint, re-run across 3 rounds)
- **Files modified:** 13 (2 created, 11 modified)

## Accomplishments

- `flushPendingSavesForQuit` (`teardownSave.ts`) settles every mounted autosave surface with a 3s budget before a quit proceeds; a failed or timed-out flush never closes the window on its own.
- `useDestructiveActionGuard` gained a 300ms "saving" indicator, a `save-failed` dialog variant (Retry primary; Quit anyway / Relaunch anyway and Cancel as ghost buttons), `retryQuit`, and `quitAnyway`, wired into `App.tsx` with new en/ko i18n copy.
- **Round-1 regression, fixed:** `core:window:allow-destroy` was never granted in `capabilities/default.json`. `@tauri-apps/api`'s `onCloseRequested` wrapper always calls `destroy()` when the handler doesn't `preventDefault()`, and Tauri's runtime always prevents the native close once any JS close-requested listener exists; so every quit route (Cmd+Q, menu Quit, close button, Retry, Quit anyway) silently never closed the window at all, despite a successful flush. Confirmed with a real denied-invoke error via a `tauri::test::MockRuntime` test against this crate's actual capabilities, then fixed by granting the permission.
- **Round-2 regression, fixed:** an interactive, job-control terminal shell puts a foreground external command (e.g. `sleep 600`) into its own process group, separate from the shell's leader group that `terminal_kill`/the quit sweep signaled. `kill_target_pgids` now also captures the pty's current foreground group (`tcgetpgrp` via portable-pty) before signaling, so both the tab-close ladder and the quit sweep kill it too (while a background/disowned job still survives both paths untouched, REL-01/D-09). The quit sweep's timing was also tightened (1.5s to 1s per stage) to fit inside the 3s quit budget, and its D-11 log line now names the final signal.
- **Round 3:** the owner approved all remaining items in the real app.

## Task Commits

Each task/round was committed atomically:

1. **Task 1: Quit flushes pending autosaves before close** (`4308f5a3`, feat)
2. **Task 2 (RED/GREEN): quit-saving indicator and save-failed dialog** (`ba7d7602` test, `ba1a62b9` feat)
3. **Task 3, round-1 regression fix (RED/GREEN): destroy-permission ACL gap** (`3bd9379e` test, `522d23a3` fix)
4. **Task 3, round-2 regression fix (RED/GREEN): foreground-job kill gap** (`43078388` test, `1f18e67d` fix, `ab33a43a` fix for dead-code cleanup, `e41f1493` fix for command-isolation evidence narrative)

**Plan metadata:** (this commit) `docs(09-08): complete quit-flush-before-close plan`

## Files Created/Modified

- `src/lib/teardownSave.ts` (`QUIT_FLUSH_BUDGET_MS`, `QuitFlushOutcome`, `flushPendingSavesForQuit`)
- `src/lib/teardownSave.test.ts` (tests for the new flush function: empty registry, pending saver, failing saver, 3s timeout)
- `src/lib/useDestructiveActionGuard.ts` (quit-flush integration, `quitSaving`, `quitFailureKind`, `failedQuitAction`, `retryQuit`, `quitAnyway`, `"save-failed"` pending-action state)
- `src/lib/useDestructiveActionGuard.test.tsx` (new test file covering the close handler, the indicator, and the save-failed/retry/quit-anyway flows for both close and relaunch)
- `src/App.tsx` (quit-saving toast indicator, save-failed dialog variant)
- `src/lib/i18n/locales/en.ts`, `src/lib/i18n/locales/ko.ts` (`app.quit.*` keys)
- `src-tauri/capabilities/default.json` (`core:window:allow-destroy` grant)
- `src-tauri/src/lib.rs` (`run()` split behind `#[cfg(not(test))]`/`#[cfg(test)]`; `quit_acl_tests` module with the MockRuntime ACL test)
- `src-tauri/src/terminal/mod.rs` (`kill_target_pgids`, `escalate_process_groups` generalizing the removed single-pgid `escalate_process_group`/`wait_for_group_exit`, `escalation_warn_line_for`, `QUIT_SWEEP_STEP` timing, D-11 log-line fix, four new `phase09_02` tests, `interactive_shell_args` test fixture)
- `docs/native-e2e.md` (checklist items for the quit flush, failure dialog, recovery copy, and terminal cleanup at quit)
- `docs/performance/phase08-18.json` (`terminal_kill`'s command-isolation evidence narrative updated to name the current call chain)
- `e2e-native/specs/quit.spec.ts` (new native-e2e spec: `app.quit` on a clean state must actually exit the process; committed for CI, could not be verified green in this sandboxed session, see below)

## Decisions Made

See `key-decisions` in the frontmatter above for the full list. The two load-bearing ones: `core:window:allow-destroy` must be granted for ANY quit path to close a window with a JS close-requested listener registered (a Tauri runtime invariant, not app-specific), and a kill/escalation ladder in an interactive terminal must target the pty's current foreground process group, not just the terminal child's own leader group.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `core:window:allow-destroy` missing from `capabilities/default.json`**
- **Found during:** Task 3, checkpoint round 1 (owner: clean quit, retry-then-quit, and quit-anyway all failed to actually close the window)
- **Issue:** Every quit path ends in `requestWindowClose()` → `onCloseRequested` → `destroy()`, and `destroy` was never ACL-granted, so the invoke was silently denied.
- **Fix:** Added `"core:window:allow-destroy"` to `src-tauri/capabilities/default.json`.
- **Files modified:** `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs` (new `quit_acl_tests` module + `run()` cfg split needed to test it)
- **Verification:** `quit_acl_tests::main_window_can_destroy_itself_through_the_real_capabilities` RED (denied-invoke error) → GREEN (passes); owner re-verified in the real app across rounds 2-3.
- **Committed in:** `3bd9379e` (test), `522d23a3` (fix)

**2. [Rule 1 - Bug] Foreground process-group not targeted by `terminal_kill`/the quit sweep**
- **Found during:** Task 3, checkpoint round 2 (owner: `trap '' HUP; sleep 600` then Cmd+Q left the process alive, reparented to launchd; quit took ~4s, over the 3s budget)
- **Issue:** `session.process_group` (REL-01) is only the terminal child's own leader pgid, captured at spawn. An interactive job-control shell assigns a *new* process group to a foreground external command, which the leader-only kill never reached.
- **Fix:** `kill_target_pgids` captures the pty's current foreground group (`tcgetpgrp`) before signaling; both kill paths escalate the leader group and the foreground group together (`escalate_process_groups`). `QUIT_SWEEP_STEP` shortened 1.5s → 1s per stage to fit the 3s budget; the D-11 log line now names the final signal.
- **Files modified:** `src-tauri/src/terminal/mod.rs`
- **Verification:** four new `phase09_02` tests (interactive-shell foreground job via tab close and via quit sweep; disowned-job survival via both paths) RED → GREEN; owner re-verified in the real app in round 3.
- **Committed in:** `43078388` (test), `1f18e67d` (fix)

**3. [Rule 3 - Blocking] Removing the old single-pgid escalation function left it and its helper dead in non-test builds**
- **Found during:** `make verify`'s clippy step, immediately after the round-2 fix commit
- **Issue:** `escalate_process_group`/`wait_for_group_exit` had no callers left outside `#[cfg(test)]` code once `terminal_kill`/`sweep_sessions` moved to `escalate_process_groups`; `cargo clippy -- -D warnings` failed on dead-code lints.
- **Fix:** Deleted both functions; pointed the one remaining direct-spawn test at `escalate_process_groups(&[pgid], grace)` directly.
- **Files modified:** `src-tauri/src/terminal/mod.rs`
- **Verification:** `cargo clippy -- -D warnings` clean; full `cargo test --lib` still 1821 passed.
- **Committed in:** `ab33a43a`

**4. [Rule 3 - Blocking] Deleting that function broke `check-command-isolation`'s evidence narrative**
- **Found during:** `make verify`'s `check-command-isolation` step, immediately after the dead-code cleanup
- **Issue:** `docs/performance/phase08-18.json`'s `terminal_kill` evidence prose cited `src-tauri/src/terminal/mod.rs::escalate_process_group` by name; the gate greps every cited symbol against the real source and failed on the now-deleted reference.
- **Fix:** Updated the narrative to accurately describe the current call chain (`kill_target_pgids` → `begin_group_kill` → `escalate_process_groups`) rather than leaving a stale citation.
- **Files modified:** `docs/performance/phase08-18.json`
- **Verification:** `node scripts/check-command-isolation.mjs --all --expected-count 383` → `PASS all`.
- **Committed in:** `e41f1493`

---

**Total deviations:** 4 auto-fixed (2 bugs found via the owner's human checkpoint, 2 blocking issues surfaced by `make verify` immediately after fixing the first two). **Impact on plan:** all four were necessary for correctness; the first two are the actual substance of what shipped in this plan (the plan's own Task 3 exists specifically to catch exactly this class of gap: real quit/process behavior no automated test in the repo exercised before). No scope creep.

## Known Stubs

None.

## Issues Encountered

**The Task 3 human checkpoint ran three rounds, not one**, because it did its job: it caught two real regressions no test in the repo had ever exercised.

- **Round 1, NOT approved.** Items 2, 5, 6, 8 (this plan's own checkpoint numbering) failed: a clean quit, retry-then-quit, and quit-anyway all left Maru open with no dialog and no crash; the flush succeeded but the window never closed. Root cause: `core:window:allow-destroy` was never granted. Fixed (see Deviations #1); a new checkpoint asked the owner to re-verify only the previously-failing items.
- **Round 2, items 1, 2, 3, 5 passed; item 4 failed.** `trap '' HUP; sleep 600` then Cmd+Q: the app itself quit (~4s, over the 3s budget), but the `sleep 600` process survived, reparented to launchd. Root cause: the kill ladder targeted only the terminal's leader process group, missing the foreground job's own group under job control. Fixed (see Deviations #2); a new checkpoint asked the owner to re-verify only the quit path, the same scenario via tab close, and that a disowned job still survives both paths.
- **Round 3, all approved.** Owner's verbatim note for item 3's second half (Cmd+Q after confirming tab-close survival): "이어서 Cmd+Q → 앱은 1초 내 종료, disowned 프로세스는 여전히 생존 ✓ (의도된 동작). 테스트 후 kill로 정리 완료." (quit within 1s; the disowned process still survived, as intended; cleaned up with `kill` afterward). Items 1, 2, and the first half of item 3 were answered "all approved" with no further per-item notes.

**The native-e2e WebDriver harness (`tauri-plugin-wdio-webdriver`, embedded provider on port 4445) could not be relied on in this sandboxed execution environment.** Across roughly eight attempts (including a full-suite run and repeated standalone `--spec` invocations of both the new `quit.spec.ts` and the existing `menu.spec.ts`), its embedded server bound successfully exactly once, for an untouched, unrelated existing spec (`ime.spec.ts`), which then ran and passed normally. Every other attempt hit the same 60s "server did not become ready" timeout regardless of which spec ran, and `sample` on a spawned app during one failure showed it genuinely alive and idle in the AppKit event loop with nothing bound on port 4445 (a harness-startup problem, not an app hang or a code regression). `e2e-native/specs/quit.spec.ts` is committed as real coverage for the CI environment where this harness works (per `docs/native-e2e.md`, native-e2e is compiled and run there per PR), but it could not be verified green in this session. The `tauri::test::MockRuntime`-based `quit_acl_tests` in `src-tauri/src/lib.rs` served as the reliable local substitute for proving the destroy-permission fix.

**A checklist wording correction, not a bug:** `docs/native-e2e.md`'s original wording (inherited from the plan's own Task 3 text) implied the terminal escalation ladder should stop at SIGTERM for `trap '' HUP; while :; do sleep 1; done`. That's incorrect for that command: an *interactive* bash hosting a foreground loop can outlive SIGTERM (the shell itself, not just the child, is the process-group leader), so reaching SIGKILL there is the ladder working correctly, confirmed by `src-tauri/src/terminal/mod.rs`'s own D-11 log line (`escalation_warn_line`/`escalation_warn_line_for`, exactly one warn line per escalation, naming whichever signal actually finished the job). The functional check is "the process is gone within ~3s," not which exact signal name appears in the log.

## User Setup Required

None (no external service configuration required).

## Next Phase Readiness

- ROADMAP success criterion 2 holds end to end: a pending debounced save is performed when its pane unmounts (09-05, 09-07) and when the app quits, with the quit driven by the Rust-owned menu item and window lifecycle rather than a webview unload handler.
- Criterion 3 holds on the quit path too (failed saves are visible via toast + recovery copy, and never silently dropped to make quit succeed).
- Criterion 1's terminal behavior is confirmed at both tab close and app quit, including the foreground-job gap this plan's checkpoint caught and fixed.
- Phase 9 (durability-and-session-lifecycle) is now fully covered by this plan's requirements; REL-02 and REL-03 are the last two requirements this phase declares (see REQUIREMENTS.md), and both are now complete.
- No known blockers for the next phase. The native-e2e harness's flakiness in constrained/sandboxed execution environments (this session's specific limitation, not a stable CI concern) may be worth a future look if it recurs in CI.

## Self-Check: PASSED

- Key files exist on disk: `src/lib/teardownSave.ts`, `src/lib/useDestructiveActionGuard.ts`, `src/lib/useDestructiveActionGuard.test.tsx`, `src/App.tsx`, `src-tauri/capabilities/default.json`, `src-tauri/src/lib.rs`, `src-tauri/src/terminal/mod.rs`, `docs/native-e2e.md`, `docs/performance/phase08-18.json`, `e2e-native/specs/quit.spec.ts` (all confirmed present).
- All 9 task commit hashes confirmed present via `git log --oneline` on this branch: `4308f5a3`, `ba7d7602`, `ba1a62b9`, `3bd9379e`, `522d23a3`, `43078388`, `1f18e67d`, `ab33a43a`, `e41f1493`.
- Acceptance criteria re-verified: `grep -c "export function flushPendingSavesForQuit" src/lib/teardownSave.ts` is 1; `grep -c "flushPendingSavesForQuit(" src/lib/useDestructiveActionGuard.ts` is 1; `grep -c '"save-failed"' src/lib/useDestructiveActionGuard.ts` is 4; `grep -c "app.quit.saving" src/App.tsx` is 1.
- Plan-level verification re-run: `pnpm exec vitest run src/lib/useDestructiveActionGuard.test.tsx src/lib/teardownSave.test.ts` passes (29/29); `make verify` passes (typecheck, lint, i18n, TS tests 2239/2239, Rust tests 1821/1821, `cargo fmt --check`, `cargo clippy -D warnings`, frontend build, `command-isolation: PASS all` with 383 evidence rows); `make test-e2e` passes (250/250 Playwright).
- The human checkpoint recorded observations across three rounds (see Issues Encountered) and reached final approval ("all approved") in round 3.

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-26*
