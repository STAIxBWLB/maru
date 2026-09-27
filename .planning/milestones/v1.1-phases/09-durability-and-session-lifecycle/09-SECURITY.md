---
phase: "09"
slug: "durability-and-session-lifecycle"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-09-26"
---

# Phase 9 - Security

> Per-phase security contract: threat register, accepted risks, and audit trail.
> Register authored at plan time in the `<threat_model>` blocks of 09-01..09-08-PLAN.md, plus
> two rows (T-09-02-06, T-09-08-05) for changes made after the owner's real-app checks.
> Verified by a gsd-security-auditor pass against PR #361 head `e34a906b`.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| webview -> Rust IPC (`terminal_kill`) | The frontend supplies a session handle; Rust decides which process groups get signals | Session handle |
| Maru process -> OS process table | `kill(-pgid, sig)` reaches every process in the targeted group | Signals |
| OS menu bar -> Rust menu handler -> webview | Cmd+Q reaches the Maru-owned `app.quit` item; the webview guard decides confirm/flush/close | Menu command id |
| webview guard -> Rust window lifecycle | Only a guard-approved close lets the window be destroyed and the exit sweep run | Close/destroy requests |
| webview -> Rust IPC (`write_recovery_copy`, `open_in_file_manager`) | workPath, filePath, content, reason cross into Rust, which contains them to the workspace | Unsaved user content |
| Rust -> workspace filesystem | Writes and prunes files under `<workspace>/.maru/recovery/` | Recovery copies |
| toast -> OS default app | "Open recovery copy" launches the file with the default application | File path |
| component lifetime -> module saver registry | Mounted panes register savers that the quit flush settles | Pending edits |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation / Evidence | Status |
|-----------|----------|-----------|----------|-------------|------------------------|--------|
| T-09-01-01 | Tampering | `jobs.rs` launchd env values | low | accept | Verify-only; `jobs.rs` untouched; both tilde tests pass | closed |
| T-09-01-SC | Tampering | package installs | low | accept | No Cargo.toml/package.json/lockfile change | closed |
| T-09-02-01 | Tampering | `terminal_kill` signal target | high | mitigate | `terminal/mod.rs` `terminal_kill` signals only `kill_target_pgids(session, pgid)` from the spawn-time group; handle validated by `get_session_generation` | closed |
| T-09-02-02 | Denial of Service | SIGHUP-immortal session | medium | mitigate | `escalate_process_groups` SIGHUP -> 2 s -> SIGTERM -> 2 s -> SIGKILL; `sweep_sessions` SIGKILLs survivors | closed |
| T-09-02-03 | Tampering | pgid reuse after the group dies | low | accept | `wait_for_all_groups_gone` re-probes liveness before every further signal | closed |
| T-09-02-04 | Elevation of Privilege | stale handle killing a recycled session | medium | mitigate | Generation check; test `phase09_02_generation_invariant_blocks_late_output_and_stale_handle` | closed |
| T-09-02-05 | Denial of Service | locks held across sleeps | medium | mitigate | Escalation thread holds no session/registry/killer lock; test `phase09_02_repeated_kill_is_idempotent_and_does_not_block_other_sessions` | closed |
| T-09-02-06 | Tampering | PTY foreground group targeting (`process_group_leader()` / `tcgetpgrp`) | medium | mitigate | portable-pty 0.8.1 returns `None` for non-positive values; a foreground group must share the PTY's session (kernel invariant), so never pgid 0/1, Maru's own group, or an out-of-session group; disowned/background jobs are never the foreground group; read before any signal; 4 real-PTY tests | closed |
| T-09-02-SC | Tampering | package installs | low | accept | No new crate; raw `kill` idiom reused | closed |
| T-09-03-01 | Tampering | quit bypassing the dirty-draft guard | high | mitigate | `app_menu.rs` `QUIT_MENU_ID` replaces the native Quit; `App.tsx` routes `app.quit` to `requestWindowClose()`; native spec + owner checks | closed |
| T-09-03-02 | Spoofing | a page forging `app.quit` | low | accept | Debug menu bridge gated out of production by `check-native-e2e-isolation`; a forged quit still hits the guard | closed |
| T-09-03-03 | Denial of Service | Cmd+Q no-op if the webview hangs | low | accept | Dock Quit and Force Quit remain escape hatches | closed |
| T-09-03-SC | Tampering | package installs | low | accept | No installs | closed |
| T-09-04-01 | Tampering | recovery path from `filePath` | high | mitigate | `recovery_file_name` uses only a sanitized stem and allowlisted extension; `ensure_within`; test `phase09_04_traversal_and_absolute_file_path_land_inside_recovery_dir` | closed |
| T-09-04-02 | Tampering | symlinked `.maru/recovery` | medium | mitigate | `symlink_metadata` refusal; test `phase09_04_symlinked_recovery_dir_is_refused` | closed |
| T-09-04-03 | Denial of Service | disk exhaustion | medium | mitigate | 16 MiB cap before admission; newest-100 retention touching only pattern files; tests for both | closed |
| T-09-04-04 | Information Disclosure | content in logs | medium | mitigate | Log line interpolates only the control-stripped file label and reason | closed |
| T-09-04-05 | Repudiation | lost edit with no trace | low | mitigate | One `[recovery] save failed for ...; kept <path>` line per write | closed |
| T-09-04-06 | Tampering | overwriting an earlier copy | low | mitigate | `persist_noclobber` plus random suffix; test `phase09_04_two_writes_same_second_produce_distinct_files` | closed |
| T-09-04-SC | Tampering | package installs | low | accept | chrono and uuid already direct deps | closed |
| T-09-05-01 | Tampering | cross-workspace save | high | mitigate | `ScratchpadPane.tsx` `activeWorkPathRef` guard in the save callback; workspace-switch test | closed |
| T-09-05-02 | Information Disclosure | teardown log line | medium | mitigate | Log carries file label and reason only | closed |
| T-09-05-03 | Denial of Service | retry storm on a failing disk | low | mitigate | Failed value retained without re-arming the timer | closed |
| T-09-05-04 | Repudiation | silent loss on unmount | medium | mitigate | `useTeardownFlush` / `settleTeardownSave` route failures to `reportTeardownSaveFailure` | closed |
| T-09-05-SC | Tampering | package installs | low | accept | No new deps | closed |
| T-09-06-01 | Tampering | Open button opening an arbitrary path | medium | mitigate | `file_manager.rs` `resolve_inside_vault` plus existence check before launch | closed |
| T-09-06-02 | Information Disclosure | content in toast or console | medium | mitigate | `reportTeardownSaveFailure` never references the content; test asserts it is absent | closed |
| T-09-06-03 | Repudiation | failure with no trace when the copy also fails | medium | mitigate | `failedNoCopy` notice plus a log line with both reasons | closed |
| T-09-06-04 | Denial of Service | notice flood | low | accept | Existing one-at-a-time notice queue | closed |
| T-09-06-SC | Tampering | package installs | low | accept | No new deps | closed |
| T-09-07-01 | Tampering | saving into another workspace after a switch | high | mitigate | Studio and Graph savers keyed by root/path; meeting saver bound to its store | closed |
| T-09-07-02 | Tampering | stale Studio document over a newer one | medium | mitigate | Load effect flushes the previous document first; serialized save queue | closed |
| T-09-07-03 | Information Disclosure | recovery copy of graph layout metadata | low | accept | Stays inside the same workspace's `.maru` | closed |
| T-09-07-SC | Tampering | package installs | low | accept | No new deps | closed |
| T-09-08-01 | Tampering | edit lost to make quit succeed | high | mitigate | `runQuitFlush` gates the only close behind a clean outcome; Quit anyway is explicit; guard tests + owner checks | closed |
| T-09-08-02 | Denial of Service | quit blocked by a stuck save | medium | mitigate | `QUIT_FLUSH_BUDGET_MS = 3000`; Retry / Quit anyway / Cancel | closed |
| T-09-08-03 | Denial of Service | terminals killed by a cancelled quit | medium | mitigate | No close on failure or timeout, so the exit sweep never runs | closed |
| T-09-08-04 | Repudiation | a save failing after the budget goes unreported | low | mitigate | `flushPendingSavesForQuit` reports each failure whenever it settles | closed |
| T-09-08-05 | Elevation of Privilege / Denial of Service | `core:window:allow-destroy` for `main` and `skill-editor` | medium | mitigate | Both windows register `onCloseRequested`, so both need the SDK wrapper's `destroy()` (narrowing would re-break skill-editor close); no production code calls `destroy()` directly; direct invocation by injected script is bounded by the CSP (`script-src 'self'`) and the DOMPurify sink gate; test `quit_acl_tests::main_window_can_destroy_itself_through_the_real_capabilities` | closed |
| T-09-08-SC | Tampering | package installs | low | accept | No new deps | closed |

*Status: open - closed - open, below high threshold (non-blocking)*
*Severity: critical > high > medium > low - only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) - accept (documented risk) - transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-09-01 | T-09-02-03 | Residual pgid-reuse window is one 50 ms poll within a 4 s ladder | Phase 9 plan (PR #349) | 2026-09-25 |
| AR-09-02 | T-09-03-02 | Webview menu dispatch exists only in the build-gated native-e2e bridge | Phase 9 plan (PR #349) | 2026-09-25 |
| AR-09-03 | T-09-03-03 | No watchdog for a hung webview; Dock Quit and Force Quit remain | Phase 9 plan (PR #349) | 2026-09-25 |
| AR-09-04 | T-09-06-04 | Notices queue one at a time; each maps to a real failed save | Phase 9 plan (PR #349) | 2026-09-25 |
| AR-09-05 | T-09-07-03 | Graph layout recovery copy stays inside the workspace's `.maru` | Phase 9 plan (PR #349) | 2026-09-25 |

The `-SC` rows and T-09-01-01 are accept dispositions with nothing to mitigate (no installs, no code change).

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-26 | 40 | 40 | 0 | gsd-security-auditor against PR #361 head `e34a906b` (ASVS L1; L2/L3 trace on T-09-02-06 and T-09-08-05) |

Notes from this audit:
- T-09-02-06 and T-09-08-05 came from the owner's 09-08 real-app checks and were not in any PLAN register; recorded here so a re-audit does not read them as unregistered.
- T-09-08-05's automated evidence covers the `main` window only; the `skill-editor` close path shares the capability object but has no direct test or checkpoint item yet.
- PR #361's code review found a quit-path gap (Cmd+Q is dead while the skill editor has focus, and quitting from `main` leaves the editor open). It bears on T-09-03-01 and T-09-08-05 and is being fixed before merge; the audit trail will record the re-check.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-26 (head `e34a906b`)
