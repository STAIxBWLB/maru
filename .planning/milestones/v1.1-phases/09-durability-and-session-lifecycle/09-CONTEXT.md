# Phase 9: Durability and Session Lifecycle - Context

**Gathered:** 2026-09-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Work must never disappear without a signal. Three failure modes are in scope:

- **REL-01:** A terminal child that traps SIGHUP can still be killed.
- **REL-02:** A pending debounced editor save is performed, not merely cancelled, when its pane unmounts and when the app quits.
- **REL-03:** A save that fails on those teardown paths is visible.

**REL-04** (job env `:`-separated tilde expansion) is already shipped. It landed as `86e7074f` in #328 and was released in v1.1.8; issue #295 is closed. It stays in the phase only to be verified against success criterion 4 and marked in the traceability table. It is not re-implemented.

New capabilities (session restore, crash reporting, a terminal process manager UI, etc.) are out of scope.

</domain>

<decisions>
## Implementation Decisions

### Save scope (REL-02)
- **D-01:** Every debounced autosave surface flushes its pending save on unmount and on app quit, not just Scratchpad. Surfaces that hand-roll a save timer (Scratchpad 700 ms, Studio, Today brain dump 800 ms, plus any other surface the researcher's inventory turns up) move onto the existing `src/lib/debouncedSave.ts` helper, which already exposes `schedule`/`flush`/`cancel`. Unmount calls `flush()`, never only `cancel()`. `HtmlVisualEditor` already flushes on unmount and needs no change beyond conforming, if that is cheap. - **Reversibility:** costly - every autosave surface's save path moves onto the helper.
- **D-02:** Scratchpad's localStorage mirror stays as a secondary safety net for abnormal exits (crash, force-quit, OS kill). The file remains the source of truth. The mirror is used only for recovery and is cleared once the file save lands.

### Quit flush behavior (REL-02)
- **D-03:** One quit path. Window close and Cmd+Q (Rust `RunEvent::ExitRequested`) both go through the same unsaved-changes confirm (the existing `useDestructiveActionGuard` dirty-draft dialog) and the same flush of pending autosaves. Today Cmd+Q bypasses both. Per REL-02, the quit path is driven from the Rust side (prevent exit, ask the webview to flush and confirm, then exit), not from a webview unload handler.
- **D-04:** Quit waits at most 3 s for pending saves. A "saving" indicator appears if the wait exceeds about 300 ms.
- **D-05:** If a save fails or the 3 s window expires during quit, the quit is cancelled. The app stays open and shows the failure, and the user can retry or explicitly choose "quit anyway". An edit is never dropped silently to make quit succeed.
- **D-06:** Ordering: terminal cleanup at quit (D-12) starts only after the quit is committed, meaning the save flush and confirm passed or the user chose "quit anyway". A quit cancelled by D-05 never kills terminals.

### Save failure visibility (REL-03)
- **D-07:** A failed teardown save (on unmount or at quit) raises the global toast through the existing `src/lib/errorStore.ts`, which survives the pane unmounting. The toast names the file and the reason. The same line goes to the log.
- **D-08:** The unsaved content is preserved as a recovery copy under the workspace's `.maru/recovery/`, and the toast offers to open it. This keeps the "files are the source of truth" principle: the edit survives as a real file, not only in memory or localStorage.

### Terminal force kill (REL-01)
- **D-09:** Escalation ladder when a closed tab's child survives SIGHUP: SIGHUP, then 2 s, then SIGTERM, then 2 s, then SIGKILL. It targets the terminal child's process group, never the whole session. A grandchild deliberately backgrounded into its own session or process group (nohup/setsid/disown) must survive, per REL-01.
- **D-10:** The tab closes immediately, as today. Escalation runs in the background. The existing generation-token invariant keeps late output from a dying child out of any new session.
- **D-11:** An escalation beyond SIGHUP is recorded as one `warn`-level log line, in the same style as Phase 7 D-01. There is no toast.
- **D-12:** At app quit, any live terminal children are cleaned up inside the 3 s quit window (SIGHUP, then SIGTERM), and any process group still alive just before exit is SIGKILLed. No orphans outlive Maru.

### REL-04 (already shipped)
- **D-13:** Verify-only. Confirm success criterion 4 against the shipped `expand_tilde_segments` in `src-tauri/src/jobs.rs`: every tilde segment becomes absolute, and a colon-bearing non-path value and a single-path value are byte-identical to the pre-fix output. Add a missing test only if a criterion has no test. Mark REL-04 complete in REQUIREMENTS.md traceability.

### Claude's Discretion
- The exact mechanism for the Rust-driven quit handshake: `prevent_exit`, the event to the webview, the ack command, and the native fallback dialog if the webview does not answer within the window.
- Recovery-copy naming, retention, and cleanup policy under `.maru/recovery/`.
- Whether `portable_pty` sets up a distinct process group at spawn (flagged MEDIUM uncertainty in ROADMAP). The researcher must confirm this at source level before D-09 is implemented, and add process-group setup if it is missing.
- How the 300 ms "saving" indicator threshold and its copy are presented.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` § "Phase 9: Durability and Session Lifecycle": goal, 4 success criteria, and the REL-01 uncertainty note on `portable_pty` process groups.
- `.planning/REQUIREMENTS.md`: REL-01, REL-02, REL-03, REL-04 text and traceability rows.
- `.planning/codebase/CONCERNS.md`: the immortal SIGHUP-trapping child. `ChildKiller::kill` raises only SIGHUP on Unix and the latched `closing` flag blocks a second attempt.

### Terminal (REL-01)
- `src-tauri/src/terminal/mod.rs`: the `closing: AtomicBool` latch (~line 45, 857), killer construction (~line 458), and the kill path (~lines 857-870). The phase08_18 tests in the same file cover writer serialization and must keep passing.
- `src-tauri/Cargo.toml`: `portable-pty = "0.8"`. Its spawn-time process-group behavior is to be confirmed.
- `.planning/phases/07-guardrails-before-churn/07-CONTEXT.md` D-01, D-02: warn-log visibility and the terminal registry/killer lock poison recovery that the kill path runs under.
- `docs/native-e2e.md` and Phase 6: the native WebDriver runner drives a real PTY. REL-01's trap-and-kill claim is only verifiable there, not in the mocked-IPC Chromium suite.

### Saves and quit (REL-02, REL-03)
- `src/lib/debouncedSave.ts` (+ `.test.ts`): the shared saver with `flush()`. It is the target for D-01.
- `src/components/ScratchpadPane.tsx`: hand-rolled `autoSaveTimerRef`, `clearAutoSaveTimer` (cancel-only), and the localStorage mirror.
- `src/components/studio/StudioMode.tsx` (`saveTimerRef`) and `src/components/today/TodayBrainDump.tsx` (`AUTOSAVE_DEBOUNCE_MS = 800`): other hand-rolled timers.
- `src/components/HtmlVisualEditor.tsx` (~line 250): the existing flush-on-unmount example.
- `src/lib/useDestructiveActionGuard.ts`: the window-close dirty-draft confirm and settings flush that D-03 extends to Cmd+Q.
- `src-tauri/src/lib.rs`: the comment at ~line 202 explaining why there is no Rust `CloseRequested` handler (it raced the JS guards), and `RunEvent::ExitRequested` at ~line 641, which currently only stops the Telegram poller.
- `src/lib/errorStore.ts`: the global toast surface used by D-07.

### Jobs (REL-04)
- `src-tauri/src/jobs.rs`: `expand_tilde` / `expand_tilde_segments` (~lines 189-241), shipped in #328 (commit `86e7074f`, issue #295).

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `debouncedSave` (`schedule`/`flush`/`cancel`, plus `createSaveQueue` for serializing side effects): the single place D-01 converges on.
- `errorStore` global toast: already used for skills notices; reachable from any module without prop drilling.
- `useDestructiveActionGuard`: pending-action state, one-shot close replay, and `onCloseRequested` subscription. This is the confirm and flush flow to reuse for Cmd+Q.
- `lock_recovery::recover_guard`: already wraps the terminal killer lock (Phase 7).

### Established Patterns
- Rust deliberately defers window close to JS `preventDefault`. A Rust-driven quit must not reintroduce the force-destroy race that the `lib.rs` comment records. It prevents exit, lets JS confirm and flush, then exits.
- Phase 7 visibility convention: one `warn` log line for recoveries and escalations.
- Guard-backed verification culture. Consider whether a cheap static check can keep new hand-rolled save timers from reappearing. This is optional and was not required by the discussion.

### Integration Points
- Tauri `RunEvent::ExitRequested` in `src-tauri/src/lib.rs` `run()`.
- `TerminalState` / session `closing` latch and killer in `src-tauri/src/terminal/mod.rs`.
- Every autosave surface's unmount cleanup.

</code_context>

<specifics>
## Specific Ideas

- The quit experience should feel like a normal quit when nothing is pending. The 3 s hold and the "saving" indicator only appear when there is work to flush.
- "Quit anyway" must be an explicit user choice. The default on failure keeps the app, and the edit, alive.

</specifics>

<deferred>
## Deferred Ideas

None. The discussion stayed within phase scope.

</deferred>

---

*Phase: 09-durability-and-session-lifecycle*
*Context gathered: 2026-09-25*
