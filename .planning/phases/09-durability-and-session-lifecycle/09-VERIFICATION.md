---
phase: 09-durability-and-session-lifecycle
verified: 2026-09-26T00:00:00Z
status: passed
score: 16/16 must-haves verified
behavior_unverified: 0
overrides_applied: 0
re_verification:
  previous_status: none
  previous_score: none
  gaps_closed: []
  gaps_remaining: []
  regressions: []
gaps: []
deferred: []
human_verification: []
---

# Phase 9: Durability and Session Lifecycle Verification Report

**Phase Goal:** A terminal child that traps SIGHUP can still be killed, no pending edit is silently lost when a pane unmounts or the app quits, and a scheduled job stops failing silently because its own PATH never resolved.
**Verified:** 2026-09-26
**Status:** passed
**Re-verification:** No - initial verification

## Goal Achievement

### Observable Truths

Truths are grouped by the four ROADMAP success criteria. Each row was checked against the actual source (not the SUMMARY narrative) and, where the truth is a state-transition/cancellation invariant, against a named test I confirmed passes in an independent `make verify` run on this branch (see Behavioral Spot-Checks / Probe Execution below), not merely against symbol presence.

| # | Truth | Status | Evidence |
| --- | --- | --- | --- |
| 1 | A SIGHUP-trapping terminal child's process group is still killed via timeout-gated SIGHUP -> SIGTERM -> SIGKILL escalation (D-09) | VERIFIED | `src-tauri/src/terminal/mod.rs::begin_group_kill`/`escalate_process_groups`; behavioral test `phase09_02_sighup_trapping_child_dies_via_escalation_ladder` passes (independently re-run, `cargo test --lib`, part of the 1821-pass run) |
| 2 | A child trapping both SIGHUP and SIGTERM is removed by SIGKILL | VERIFIED | `phase09_02_direct_spawn_escalates_to_sigkill_when_hup_and_term_trapped` passes |
| 3 | A deliberately backgrounded/disowned grandchild survives its tab's kill ladder and the quit sweep; only the terminal child's own (and current foreground) process group is signaled (D-09) | VERIFIED | `phase09_02_backgrounded_grandchild_survives_tab_close`, `phase09_02_disowned_job_survives_tab_close_even_with_foreground_targeting`, `phase09_02_disowned_job_survives_quit_sweep` all pass |
| 4 | `terminal_kill` returns quickly (escalation runs detached, holding no lock while it sleeps) | VERIFIED | `begin_group_kill` spawns a detached `thread::spawn`; no lock held across `escalate_process_groups`'s sleeps (code read directly) |
| 5 | The generation-token invariant keeps late output from a dying child out of a recycled session id | VERIFIED | `phase09_02_generation_invariant_blocks_late_output_and_stale_handle` passes |
| 6 | An escalation beyond SIGHUP writes exactly one warn line naming SIGTERM/SIGKILL, no toast (D-11) | VERIFIED | `phase09_02_escalation_warn_line_matches_d11_format` passes; `escalation_warn_line`/`escalation_warn_line_for` are the single format site (code read) |
| 7 | At app quit, every live and mid-ladder terminal process group is swept (SIGHUP -> SIGTERM -> SIGKILL) within a bounded 3 s budget, wired only into the `RunEvent::ExitRequested \| RunEvent::Exit` arm (D-06, D-12) | VERIFIED | `terminal::shutdown_all_sessions` called from `src-tauri/src/lib.rs:662`, the only call site; `phase09_02_sweep_sessions_clears_live_and_mid_ladder_groups`, `phase09_02_sweep_sessions_on_empty_state_returns_immediately` pass |
| 8 | Round-2 regression fix: the ladder also kills the pty's current foreground process group (not just the terminal leader's group), so an interactive foreground job (`sleep 600` under a job-control shell) no longer survives tab close or quit | VERIFIED | `kill_target_pgids` (captures `tcgetpgrp` via `process_group_leader()` before signaling); `phase09_02_tab_close_kills_the_interactive_foreground_job_group`, `phase09_02_quit_sweep_kills_the_interactive_foreground_job_group_within_budget` pass; owner confirmed in real app (checkpoint round 3) |
| 9 | Every debounced autosave surface (Scratchpad, Studio, Today brain dump, meeting source, graph layout) flushes (not merely cancels) its pending save on unmount, via a shared `createDebouncedSaver`/`useTeardownFlush` (D-01) | VERIFIED | `useTeardownFlush` call sites confirmed in all five files (`ScratchpadPane.tsx`, `StudioMode.tsx`, `TodayBrainDump.tsx`, `MeetingSourceWorkbench.tsx`, `GraphView.tsx`); `src/lib/teardownSave.surfaces.test.ts` pins all five plus HtmlVisualEditor's already-compliant unmount serialize; part of the 4426-pass Vitest run |
| 10 | `HtmlVisualEditor` is left as-is (its 300 ms timer serializes into parent state, not a disk save; unmount already flushes) | VERIFIED | Confirmed by the surfaces pin test asserting `serializeNowRef.current()` still runs on unmount |
| 11 | Cmd+Q and window close (and the App-menu Quit item) share one guard: `app.quit` is a Maru-owned macOS menu item that reaches `requestWindowClose()`, the same path the red close button uses; not two implementations kept in sync (D-03) | VERIFIED | `src-tauri/src/app_menu.rs` builds a hand-rolled macOS App submenu replacing tauri's `PredefinedMenuItem::quit()` (which called `NSApplication terminate:` and bypassed the webview); `src/App.tsx`'s `case "app.quit": requestWindowClose();`; native e2e spec `menu.spec.ts` plus a real-build human checkpoint ("approved") in plan 09-03 |
| 12 | Quit flushes every mounted autosave surface within a 3 s budget before the window is allowed to close; a 300 ms "saving" indicator appears only past that threshold (D-03, D-04) | VERIFIED | `flushPendingSavesForQuit` (`teardownSave.ts`) awaited inside `onCloseRequested` before the dirty-draft check (`useDestructiveActionGuard.ts`); `QUIT_FLUSH_BUDGET_MS = 3000`, `QUIT_SAVING_INDICATOR_MS = 300`; part of the 4426-pass Vitest run (`useDestructiveActionGuard.test.tsx`) |
| 13 | A failed or timed-out flush cancels the quit: the window is not closed, a dialog offers Retry (primary, default), Quit anyway (non-default), and Cancel (D-05) | VERIFIED | `App.tsx` `save-failed` dialog block (~line 8840): `retryQuit` is `button-primary`, `quitAnyway`/`cancelDestructiveAction` are `button-ghost`; `runQuitFlush` only proceeds to close when `outcome.kind === "clean"` |
| 14 | A cancelled quit never kills terminals: the quit sweep is reachable only from the exit arms that fire after the window actually closes (D-06) | VERIFIED | `shutdown_all_sessions` call site is inside the same `RunEvent` match arm as the existing Telegram-poller stop, which only fires post-close; JS never calls a quit-sweep IPC directly |
| 15 | A failed teardown save (unmount or quit) is never silently dropped: content is preserved as a real file under `.maru/recovery/`, a toast names the file and reason, and one log line is written on each side (Rust `[recovery]`, JS `[save] teardown save failed`) (D-07, D-08) | VERIFIED | `src-tauri/src/maru_dir.rs::write_recovery_copy` (byte-exact write, `ensure_within`, symlink refusal, 16 MiB cap, 100-file retention, control-char-stripped log line) with passing tests `phase09_04_*` (8 of them); `src/lib/teardownSave.ts::reportTeardownSaveFailure` calls it, publishes via `publishOperationNotice`, and never includes `content` in the message or log (code read) |
| 16 | An env value in `program.env` with several `:`-separated tilde entries expands every segment to absolute in the generated launchd plist; a colon-bearing non-path value and a single-path value stay byte-identical; segment order and bare-`~` adjacency are preserved (REL-04, D-13) | VERIFIED | `src-tauri/src/jobs.rs::expand_tilde_segments`, shipped pre-phase (`86e7074f`); this phase re-ran and confirmed `env_value_expands_every_tilde_segment` and `plist_env_expands_colon_separated_tildes` still pass, no production line touched (`git diff` clean on `jobs.rs` per 09-01-SUMMARY, independently spot-checked: both tests present and passing in the current `cargo test --lib` run) |

**Score:** 16/16 truths verified (0 present-but-behavior-unverified).

### Judgment call: success criterion 2's "driven from the Rust side rather than a webview unload handler"

The CONTEXT.md D-03 language anticipated a literal `RunEvent::ExitRequested` veto handshake ("prevent exit, ask the webview to flush and confirm, then exit"). What shipped instead keeps the codebase's pre-existing architecture (documented in `src-tauri/src/lib.rs`'s own comment and in CONTEXT.md's "Established Patterns": Rust already defers window close to a JS `preventDefault`, to avoid a previously-fixed force-destroy race) and adds `app.quit` as a **Rust-owned menu item** that funnels into the same `onCloseRequested` guard the red close button already used, rather than adding a second, parallel Rust-side veto path via `RunEvent::ExitRequested`.

Judged against the actual risk success criterion 2 exists to prevent (silent data loss because a webview `beforeunload`/`pagehide` handler is unreliable inside Tauri and doesn't even fire for the native-Quit-menu path, per `09-RESEARCH.md`): this is satisfied. The trigger for Cmd+Q is now a Rust-owned menu item (not a JS unload handler), it no longer reaches `NSApplication terminate:` directly, and the existing `beforeunload`/`pagehide` flush is explicitly kept only as a "best-effort extra" (09-08 must-haves), not the enforcement mechanism. I mark this VERIFIED rather than FAILED, since the literal implementation detail (no new `RunEvent::ExitRequested` veto) is a documented, deliberate design choice that still achieves the criterion's substance, and the plan-checker accepted it at plan time.

**Known, explicitly-scoped gap (not a phase-goal failure):** Dock icon "Quit" and a system logout still terminate via AppKit without reaching the webview (tao/tauri install no `applicationShouldTerminate:` delegate). `09-03-PLAN.md` names this explicitly as an accepted, low-severity risk ("Dock Quit and Force Quit remain as escape hatches... D-03 names window close and Cmd+Q only"), with the Scratchpad localStorage mirror (D-02) as the abnormal-exit safety net. This is a scoped design decision recorded in the plan, not a silent omission, so it is not listed as a gap.

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `src-tauri/src/terminal/mod.rs` | Process-group capture, escalation ladder, quit sweep | VERIFIED | `process_group`, `kill_target_pgids`, `begin_group_kill`, `escalate_process_groups`, `sweep_sessions`, `shutdown_all_sessions`, 12 `phase09_02` tests, all pass |
| `src-tauri/src/lib.rs` | Quit-sweep wired into `RunEvent` exit arm; `run()` cfg(test)/cfg(not(test)) split | VERIFIED | `terminal::shutdown_all_sessions(...)` at line 662, only call site; `#[cfg(not(test))]`/`#[cfg(test)]` split confirmed, production `main.rs` path unaffected (no `--cfg test` in normal build) |
| `src-tauri/src/app_menu.rs` | macOS-only `app.quit` menu item replacing predefined native Quit | VERIFIED | `QUIT_MENU_ID = "app.quit"`, `cfg(target_os = "macos")`-gated, ends the hand-built App submenu |
| `src/App.tsx` | `runMenuCommand` `case "app.quit"`; save-failed dialog; quit-saving indicator | VERIFIED | Confirmed at ~line 6957 and ~line 8840; `quitSaving`/`quitFailureKind`/`retryQuit`/`quitAnyway` all consumed |
| `src/lib/useDestructiveActionGuard.ts` | Flush-first close/relaunch flow with 300 ms indicator and save-failed state | VERIFIED | `runQuitFlush`, `onCloseRequested` awaits `flushPendingSavesForQuit` before the dirty-draft check |
| `src/lib/teardownSave.ts` | `useTeardownFlush`, `flushPendingSavesForQuit`, `reportTeardownSaveFailure` | VERIFIED | All three exported and consumed by the surfaces and the guard |
| `src/lib/debouncedSave.ts` | `flushSettled`, retain-on-failure | VERIFIED | `SaveSettlement`, `SettlingDebouncedSaver`, failed value re-armed for retry unless superseded |
| `src-tauri/src/maru_dir.rs` | `write_recovery_copy`, naming, retention, symlink/traversal guards | VERIFIED | 8 `phase09_04` tests pass, including oversize refusal, retention, traversal containment, symlink refusal, scan_vault exclusion |
| `src/components/OperationNoticeToast.tsx` | Toast with "Open recovery copy" action | VERIFIED | Calls `openInFileManager(recovery.workPath, recovery.path)` |
| `src-tauri/capabilities/default.json` | `core:window:allow-destroy` grant | VERIFIED | Present; `quit_acl_tests::main_window_can_destroy_itself_through_the_real_capabilities` passes against the real capabilities file via `tauri::test::MockRuntime` |
| `src-tauri/src/jobs.rs` | `expand_tilde_segments` (verify-only, REL-04) | VERIFIED | Unmodified by this phase (git diff clean per 09-01-SUMMARY); its two named tests pass |
| `.planning/REQUIREMENTS.md` | REL-01..04 all ticked Complete | VERIFIED | All four rows read `| Phase 9 | Complete |`; no orphaned Phase 9 requirement IDs found |

### Key Link Verification

| From | To | Via | Status | Details |
| --- | --- | --- | --- | --- |
| `app_menu.rs` (`app.quit`) | `App.tsx` `runMenuCommand` | `MENU_COMMAND_EVENT` | WIRED | Same generic dispatch every other menu command uses; no new IPC command (command-isolation count held at 383 across the phase, growing only by the destroy-permission ACL test module, not a new registered command) |
| `App.tsx` `requestWindowClose` | `useDestructiveActionGuard.ts` `onCloseRequested` | `getCurrentWindow().onCloseRequested` | WIRED | Confirmed by reading the effect; `event.preventDefault()` on first entry, `runQuitFlush` awaited, only then `closeAfterSettingsFlush` -> `getCurrentWindow().close()` |
| `useDestructiveActionGuard.ts` `runQuitFlush` | `teardownSave.ts` `flushPendingSavesForQuit` | direct call | WIRED | `const outcome = await flushPendingSavesForQuit();` |
| `teardownSave.ts` `flushPendingSavesForQuit` | each registered surface's `settleTeardownSave` | `Promise.all(entries.map(entry => entry.settle()))` | WIRED | `teardownSaves` module registry populated by every `useTeardownFlush` call site |
| `teardownSave.ts` `reportTeardownSaveFailure` | `src/lib/maruDir.ts` `writeRecoveryCopy` | IPC to Rust `write_recovery_copy` | WIRED | Confirmed both the JS wrapper and the Rust command exist and match signatures |
| `src-tauri/src/lib.rs` `RunEvent` exit arm | `terminal::shutdown_all_sessions` | direct call, single call site | WIRED | Confirmed by grep; no second call site anywhere in the crate |
| `terminal_kill` / quit sweep | pty foreground process group | `process_group_leader()` (`tcgetpgrp`) | WIRED | `kill_target_pgids` used identically by both `terminal_kill` and `sweep_sessions` |

### Behavioral Spot-Checks / Probe Execution

Rather than spot-checking individual commands, I re-ran the project's own verification gate in full, once, from a clean invocation (not trusting the SUMMARY's cached claim of this same run):

```
make verify
```

Result: **exit 0.** Confirmed via the background task's own completion event and by inspecting the captured log directly:

- `cargo test --lib` (full workspace): `test result: ok. 1821 passed; 0 failed; 3 ignored`
- All 12 `terminal::phase09_02::*` tests: pass (SIGHUP ladder, SIGKILL fallback, grandchild/disowned survival at both tab-close and quit-sweep, generation invariant, D-11 line format, idempotent repeated kill, empty-sweep fast path, foreground-job kill at both paths)
- All 8 `maru_dir::phase09_04::*` tests: pass (byte-exact write, naming, two-writes-same-second distinctness, traversal/absolute containment, oversize refusal, retention, symlinked-dir refusal, scan_vault exclusion)
- `quit_acl_tests::main_window_can_destroy_itself_through_the_real_capabilities`: pass
- `cargo clippy -- -D warnings`: clean; `cargo fmt --check`: clean
- Vitest: `Test Files 460 passed (460)`, `Tests 4426 passed (4426)` (includes `teardownSave.test.ts`, `useDestructiveActionGuard.test.tsx`, `debouncedSave.test.ts`, `teardownSave.surfaces.test.ts`, `OperationNoticeToast.test.tsx`, `ScratchpadPane.test.tsx`)
- `node scripts/check-command-isolation.mjs --all --expected-count 383`: `PASS all; 383 command evidence rows, 383 production registrations`
- Frontend build succeeded; bundle-budget, native-e2e-isolation, csp-blob, and mode-css-ownership guards all passed

This is independent, fresh evidence (I ran it myself in this verification pass), not a re-statement of the SUMMARY's own claim, and it corroborates every SUMMARY-reported number exactly (1821 Rust tests, 4426 Vitest tests, 383 command evidence rows).

**Native e2e note (informational, not a gap):** `e2e-native/specs/quit.spec.ts` is committed but was not observed green locally, because the executor's own sandboxed session could not get the WebDriver harness's embedded server to bind reliably (documented in 09-08-SUMMARY as a harness-startup problem, reproduced across ~8 attempts, unrelated to this phase's code). The behavior it targets (a clean quit actually exits the process) was independently confirmed by the owner on a real build across the plan 09-08 human checkpoint's three rounds, and by the `tauri::test::MockRuntime`-based `quit_acl_tests` unit test, which I re-ran and confirmed passes. CI is expected to run the native spec per PR per `docs/native-e2e.md`. I did not attempt to run the native-e2e harness myself in this verification pass (it is known unreliable outside a real macOS CI environment and is out of scope for a code-reading verification); this is recorded as an open, low-risk CI-coverage item, not a blocker.

### Requirements Coverage

| Requirement | Source Plans | Description | Status | Evidence |
| --- | --- | --- | --- | --- |
| REL-01 | 09-02 | SIGHUP-trapping terminal child still killed via escalation, grandchild survives, generation invariant holds | SATISFIED | 12 passing `phase09_02` tests, quit-sweep wiring confirmed |
| REL-02 | 09-03, 09-05, 09-06, 09-07, 09-08 | Pending debounced save performed (not cancelled) on unmount and app quit, Rust-driven quit path | SATISFIED | All 5 autosave surfaces wired through `useTeardownFlush`; quit flush wired through `useDestructiveActionGuard`; see judgment note above on the "Rust side" wording |
| REL-03 | 09-04, 09-05, 09-06, 09-08 | A failed teardown save is visible (log, toast, recovery copy), never silent | SATISFIED | `reportTeardownSaveFailure`, `write_recovery_copy`, `OperationNoticeToast` all wired and tested |
| REL-04 | 09-01 | Every `:`-separated tilde segment in `program.env` expands to absolute in the launchd plist; non-path/single-path values byte-identical | SATISFIED | Pre-existing `expand_tilde_segments` (shipped `86e7074f`), reconfirmed by this phase's verify-only plan, tests still pass, no production code touched |

No orphaned Phase 9 requirement IDs found in `.planning/REQUIREMENTS.md` beyond REL-01..04, all four declared across the eight plans' `requirements:` frontmatter fields.

### Anti-Patterns Found

Scanned every file this phase's `git diff main...HEAD` touched under `src/` and `src-tauri/` for `TBD`/`FIXME`/`XXX` (debt markers) and `TODO`/`HACK`/`PLACEHOLDER`/"not yet implemented"/"coming soon".

- **Debt markers (`TBD`/`FIXME`/`XXX`):** none found.
- **`TODO`/`HACK`:** none found.
- **`placeholder` matches:** all are legitimate UI input placeholder copy (`t("...placeholder")` i18n keys, `<textarea placeholder=...>`) or pre-existing demo/mock-data string literals in `maruDir.ts` unrelated to this phase's recovery-copy code; none are stubs on a phase-9 code path.
- No blockers or warnings raised.

### Human Verification Required

None outstanding. The phase's own `checkpoint:human-verify` (plan 09-08, Task 3) already ran to completion across three rounds and reached final approval ("all approved," round 3), catching and fixing two real regressions (`core:window:allow-destroy` missing; foreground process-group not targeted) that no automated test in the repository had previously exercised. I independently confirmed those fixes' regression tests still pass in a fresh `make verify` run. No further human action is needed for this phase; the native-e2e CI-coverage note above is informational only.

### Gaps Summary

No gaps. All four ROADMAP success criteria hold with both static (artifact/wiring) and dynamic (passing named test, or human real-app checkpoint for what only a real build can show) evidence. `make verify` passes cleanly and was independently re-run in this verification pass, not merely cited from the SUMMARY.

---

_Verified: 2026-09-26_
_Verifier: Claude (gsd-verifier)_
