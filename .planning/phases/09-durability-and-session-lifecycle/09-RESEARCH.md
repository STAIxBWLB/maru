# Phase 9: Durability and Session Lifecycle - Research

**Researched:** 2026-09-25
**Domain:** Rust process-group signaling (portable_pty/Unix), Tauri 2 quit lifecycle, React debounced-save teardown
**Confidence:** HIGH (all four requirements verified at source level; two design decisions remain for the planner)

<user_constraints>
## User Constraints (from CONTEXT.md)

### Locked Decisions

**Save scope (REL-02)**
- **D-01:** Every debounced autosave surface flushes its pending save on unmount and on app quit, not just Scratchpad. Surfaces that hand-roll a save timer (Scratchpad 700 ms, Studio, Today brain dump 800 ms, plus any other surface the researcher's inventory turns up) move onto the existing `src/lib/debouncedSave.ts` helper, which already exposes `schedule`/`flush`/`cancel`. Unmount calls `flush()`, never only `cancel()`. `HtmlVisualEditor` already flushes on unmount and needs no change beyond conforming, if that is cheap. Reversibility: costly.
- **D-02:** Scratchpad's localStorage mirror stays as a secondary safety net for abnormal exits (crash, force-quit, OS kill). The file remains the source of truth. The mirror is used only for recovery and is cleared once the file save lands.

**Quit flush behavior (REL-02)**
- **D-03:** One quit path. Window close and Cmd+Q (Rust `RunEvent::ExitRequested`) both go through the same unsaved-changes confirm (the existing `useDestructiveActionGuard` dirty-draft dialog) and the same flush of pending autosaves. Today Cmd+Q bypasses both. Per REL-02, the quit path is driven from the Rust side (prevent exit, ask the webview to flush and confirm, then exit), not from a webview unload handler.
- **D-04:** Quit waits at most 3 s for pending saves. A "saving" indicator appears if the wait exceeds about 300 ms.
- **D-05:** If a save fails or the 3 s window expires during quit, the quit is cancelled. The app stays open and shows the failure, and the user can retry or explicitly choose "quit anyway". An edit is never dropped silently to make quit succeed.
- **D-06:** Ordering: terminal cleanup at quit (D-12) starts only after the quit is committed, meaning the save flush and confirm passed or the user chose "quit anyway". A quit cancelled by D-05 never kills terminals.

**Save failure visibility (REL-03)**
- **D-07:** A failed teardown save (on unmount or at quit) raises the global toast through the existing `src/lib/errorStore.ts`, which survives the pane unmounting. The toast names the file and the reason. The same line goes to the log.
- **D-08:** The unsaved content is preserved as a recovery copy under the workspace's `.maru/recovery/`, and the toast offers to open it. This keeps the "files are the source of truth" principle: the edit survives as a real file, not only in memory or localStorage.

**Terminal force kill (REL-01)**
- **D-09:** Escalation ladder when a closed tab's child survives SIGHUP: SIGHUP, then 2 s, then SIGTERM, then 2 s, then SIGKILL. It targets the terminal child's process group, never the whole session. A grandchild deliberately backgrounded into its own session or process group (nohup/setsid/disown) must survive, per REL-01.
- **D-10:** The tab closes immediately, as today. Escalation runs in the background. The existing generation-token invariant keeps late output from a dying child out of any new session.
- **D-11:** An escalation beyond SIGHUP is recorded as one `warn`-level log line, in the same style as Phase 7 D-01. There is no toast.
- **D-12:** At app quit, any live terminal children are cleaned up inside the 3 s quit window (SIGHUP, then SIGTERM), and any process group still alive just before exit is SIGKILLed. No orphans outlive Maru.

**REL-04 (already shipped)**
- **D-13:** Verify-only. Confirm success criterion 4 against the shipped `expand_tilde_segments` in `src-tauri/src/jobs.rs`: every tilde segment becomes absolute, and a colon-bearing non-path value and a single-path value are byte-identical to the pre-fix output. Add a missing test only if a criterion has no test. Mark REL-04 complete in REQUIREMENTS.md traceability.

### Claude's Discretion
- The exact mechanism for the Rust-driven quit handshake: `prevent_exit`, the event to the webview, the ack command, and the native fallback dialog if the webview does not answer within the window.
- Recovery-copy naming, retention, and cleanup policy under `.maru/recovery/`.
- Whether `portable_pty` sets up a distinct process group at spawn (flagged MEDIUM uncertainty in ROADMAP). The researcher must confirm this at source level before D-09 is implemented, and add process-group setup if it is missing.
- How the 300 ms "saving" indicator threshold and its copy are presented.

### Deferred Ideas (OUT OF SCOPE)
None. The discussion stayed within phase scope. New capabilities (session restore, crash reporting, a terminal process manager UI, etc.) are out of scope per the phase boundary in `.planning/ROADMAP.md`.
</user_constraints>

<phase_requirements>
## Phase Requirements

| ID | Description | Research Support |
|----|-------------|------------------|
| REL-01 | A terminal child that traps SIGHUP can still be killed via timeout-gated process-group escalation; a deliberately backgrounded grandchild survives; the generation-token invariant holds. | **MEDIUM uncertainty RESOLVED**: read `portable-pty-0.8.1` source directly (vendored at `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.8.1/src/unix.rs`). The child already becomes its own session+process-group leader via `libc::setsid()` in `pre_exec` (verified, quoted below). The actual bug is in `ChildKiller::kill()`: the stored killer is a `ProcessSignaller` (from `clone_killer()`) whose `kill()` sends bare SIGHUP to the single pid with no retry and no group targeting (verified, quoted below). See Architecture Patterns / Code Examples for the fix design (reuse `command_output.rs`'s existing `kill(-pgid, sig)` FFI idiom; no new crate needed). |
| REL-02 | A pending debounced editor save is performed (not cancelled) on pane unmount and app quit; quit is Rust-driven, not a webview unload handler. | Complete inventory of every hand-rolled save timer in `src/` (7 found, 3 excluded with reasons) in Common Pitfalls / Don't Hand-Roll. Full quit-handshake design verified against Tauri 2.10.3 source: `RunEvent::ExitRequested` only fires from (a) last-window-`Destroyed` or (b) `AppHandle::exit()` -- **not** automatically from the macOS native Quit menu item. Recommended fix (verified against `Window::close()` source and existing `app_menu.rs` patterns) needs no new IPC command. |
| REL-03 | A save that fails on a teardown path is visible (log, toast) instead of silent. | `errorStore.ts` global toast mechanism read in full; `ScratchpadPane.tsx`'s existing `flushCurrent().catch()` already calls the global `setError` (verified, quoted) -- most of D-07 is inherited "for free" once D-01 wires flush-on-unmount. Recovery-copy (`D-08`) conventions (`.maru/recovery/`, atomic write, dot-folder exclusion from the document index) verified against `paths.rs` and `vault.rs`. |
| REL-04 | Every `:`-separated tilde segment in a job's `program.env` PATH-like value expands to absolute; colon-bearing non-path and single-path values stay byte-identical. | Verify-only per D-13. Read `src-tauri/src/jobs.rs` `expand_tilde`/`expand_tilde_segments` and all six regression-test bodies; all three success-criterion components already have direct test coverage (quoted below) -- **no new test is needed**. |
</phase_requirements>

## Summary

This phase closes three independent "work disappears silently" gaps. Two required reading a vendored third-party crate's actual source (not its docs) to resolve a flagged MEDIUM uncertainty, and reading the pinned Tauri crate's event-loop source to resolve an unstated but load-bearing uncertainty about Cmd+Q. Both paid off with concrete, buildable answers.

**REL-01** turned out to be simpler than the ROADMAP's uncertainty note implied. `portable_pty` 0.8.1 *already* makes the terminal's immediate child a session leader and process-group leader via `setsid()` at spawn (`pre_exec`, before `exec`) -- the MEDIUM uncertainty is resolved as "already true, no process-group setup needs adding." The actual defect is narrower and different from what the comment in `terminal/mod.rs` implies: the `ChildKiller` stored in `TerminalSession` is not the spawned `std::process::Child` (whose blanket `ChildKiller` impl already retries and escalates to SIGKILL, just against the wrong target and on the wrong timeline) -- it is a `ProcessSignaller`, produced by `.clone_killer()`, whose `kill()` is a single bare SIGHUP to the single pid with no retry, no escalation, and no process-group targeting at all. Fixing this needs no new crate: `command_output.rs` already has a working `kill(-pgid, SIGKILL)` FFI idiom in this exact codebase to copy from.

**REL-02/REL-03** required building a complete inventory of debounced-save timers (done: 7 candidates found, 4 need D-01 conversion, 3 excluded with reasons) and resolving how the Rust-driven quit handshake should actually work. Reading the pinned `tauri` 2.10.3 crate's event-loop source shows `RunEvent::ExitRequested` fires from exactly two places: the last window's `Destroyed` event, or a call to `AppHandle::exit()`. Nothing in tao/muda intercepts the macOS-native `Quit` menu action (`Cmd+Q`) to route it through this path -- this matches the context's own observation that "Today Cmd+Q bypasses both [confirm and flush]" and matches long-standing upstream Tauri issues about this exact gap. The fix does not need a new Rust->JS->Rust ack round-trip or a new `#[tauri::command]`: replacing the macOS App-menu's native `Quit` item with a custom `MenuItem` that calls `window.close()` (verified: `Window::close()` dispatches the same `WindowEvent::CloseRequested` as the red button) routes Cmd+Q through the *already-existing, already-tested* `useDestructiveActionGuard` window-close guard, unifying both quit triggers into one JS-side path with zero new IPC surface -- avoiding the command-isolation evidence-update cost CLAUDE.md flags for a new command.

**REL-04** is verify-only. All three success-criterion components (every segment absolute, colon-bearing non-path byte-identical, single-path byte-identical) already have direct, named regression tests in `jobs.rs`. No new test is required; the task is to mark it complete in the traceability table.

**Primary recommendation:** Fix REL-01 by adding a custom process-group-aware `ChildKiller` (or a parallel escalation path keyed on the child's pid, which is also its pgid) that runs the SIGHUP -> 2s -> SIGTERM -> 2s -> SIGKILL ladder against `-pid` in a detached thread, reusing the exact `extern "C" { fn kill(...) }` FFI pattern already in `command_output.rs`. Fix REL-02/03 by (a) converting the 4 in-scope hand-rolled timers onto `debouncedSave.ts`, (b) replacing the macOS native Quit menu item with a `window.close()`-driven custom item so Cmd+Q reuses the existing dirty-draft guard, and (c) extending that guard's flush step with a 3 s budget, a 300 ms "saving" indicator, cancel-on-failure (D-05), and a `.maru/recovery/` write via the existing `atomic_file.rs::write_atomic` on failure. Mark REL-04 complete with no code change.

## Architectural Responsibility Map

| Capability | Primary Tier | Secondary Tier | Rationale |
|------------|-------------|----------------|-----------|
| Terminal child process-group escalation (REL-01) | API/Backend (Rust, `terminal/mod.rs`) | n/a | Process signaling is OS-level; only the Rust backend holds the PTY child handle and pid |
| Quit handshake orchestration (REL-02 D-03/04/05) | API/Backend (Rust, `lib.rs`/`app_menu.rs`) | Frontend Server-equivalent (webview JS, `useDestructiveActionGuard`) | Rust owns `RunEvent::ExitRequested`/`app.exit()`; JS owns the actual flush execution and the confirm dialog UI. Neither tier can do this alone: Rust cannot inspect in-memory React state, JS cannot intercept the native quit action or guarantee process exit ordering |
| Debounced autosave flush (REL-02 D-01) | Browser/Client (webview JS, per-component) | n/a | All autosave state (timers, pending text) is React component/module state; the fix is purely frontend |
| Save-failure toast + recovery copy (REL-03 D-07/08) | Browser/Client (`errorStore.ts` for toast) | API/Backend (Rust `atomic_file::write_atomic` for the `.maru/recovery/` copy) | The toast is pure frontend state; the recovery file must be a real workspace file, which requires a Rust write path (JS has no reliable direct filesystem write outside Tauri commands) |
| Job env tilde expansion (REL-04) | API/Backend (Rust, `jobs.rs`) | n/a | Verify-only; already correctly scoped to the launchd-plist generator |

## Standard Stack

No new external packages are needed for this phase.

### Core
No new dependencies. REL-01's fix reuses `std::os::unix::process::CommandExt` conventions and a raw `extern "C" { fn kill(pid: i32, signal: i32) -> i32; }` FFI declaration -- the exact idiom already used in `src-tauri/src/command_output.rs:549-555` `[VERIFIED: src-tauri/src/command_output.rs:542-560]`. `nix` 0.25.1 and `libc` 0.2.186 are already transitive dependencies of `portable-pty` (`[VERIFIED: src-tauri/Cargo.lock:3539-3556]`, `portable-pty` depends on `libc` and `nix`) but are **not** direct dependencies in `src-tauri/Cargo.toml` -- adding a direct `nix` or `libc` dependency is unnecessary; the raw FFI pattern avoids the question entirely, matching the codebase's existing precedent.

### Supporting
None needed. `debouncedSave.ts` (already in the repo, already tested) is the only "library" REL-02 depends on, and it requires no new dependency -- it is the reuse target, not something to add.

### Alternatives Considered
| Instead of | Could Use | Tradeoff |
|------------|-----------|----------|
| Raw FFI `kill(-pgid, sig)` (reuse `command_output.rs` idiom) | Add `nix` as a direct dependency for `nix::sys::signal::killpg` | `nix` is already transitive via `portable-pty`, so it would compile with zero new supply-chain risk -- but it adds a new direct `Cargo.toml` line, a new import surface, and diverges from the one FFI pattern the codebase already uses for exactly this operation. Not recommended: prefer consistency with `command_output.rs`. |
| Replace-quit-item + `window.close()` reuse (recommended) | New `#[tauri::command]` quit-ack + `prevent_exit()`/event round-trip | The ack-command design is more literally "the exact mechanism" the CONTEXT.md discretion note describes, but it adds IPC surface (382-command gate, new evidence JSON per CLAUDE.md), duplicates logic the window-close guard already has tested, and must independently reimplement D-04/05's timeout-and-cancel semantics. Only choose this if the planner decides the app needs a *distinct* quit-specific UX (e.g., a modal only for quit, not close) that the existing guard cannot express. |

**Installation:** None -- no `npm install` / `cargo add` needed.

## Package Legitimacy Audit

**Not applicable.** This phase introduces no new external packages (npm or crates). No `package-legitimacy check` run was needed. If, during planning, the team instead chooses the "add `nix` as a direct dependency" alternative above, run the gate at that time: `nix` is already vendored (`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/nix-0.25.1`), transitively trusted via `portable-pty`, and would need only the standard ecosystem-registry verification, not a fresh legitimacy check from zero.

## Architecture Patterns

### System Architecture Diagram: Quit handshake (REL-02)

```
 [Cmd+Q, macOS App-menu native Quit item]      [Window red-button / Cmd+W-to-empty]
              |                                              |
   (TODAY: bypasses everything --      (TODAY: fires WindowEvent::CloseRequested,
    routes straight to AppKit           already caught by onCloseRequested in
    termination, no Rust hook)          useDestructiveActionGuard.ts)
              |                                              |
   RECOMMENDED FIX: replace native            (unchanged -- already correct)
   Quit menu item with a custom                              |
   MenuItem::with_id("app.quit", ...)                        |
   wired through the EXISTING generic                        |
   MENU_COMMAND_EVENT dispatch in                             |
   app_menu.rs::handle_menu_event                             |
   (no Rust code change needed there)                        |
              |                                              |
              v                                              v
     App.tsx menu-command switch:                  onCloseRequested(event) handler
     case "app.quit": requestWindowClose()  ------->  (same function, same guard)
              |
              v
   +-------------------------------------------------------------+
   | useDestructiveActionGuard: hasDirtyDrafts()?                |
   |   yes -> setPendingDestructiveAction("close") -> user modal |
   |   no  -> flush pending saves (extend: 3s budget, D-04/05)   |
   |             |-- success -> closeConfirmedRef=true -> window.close()
   |             |-- failure/timeout -> D-05: cancel, show toast, offer "quit anyway"
   +-------------------------------------------------------------+
              |
              v (only on confirmed success or "quit anyway")
   window.close() [Rust Window::close() -- same code path as the
                   native red button; fires WindowEvent::CloseRequested,
                   then (last window) WindowEvent::Destroyed]
              |
              v
   Rust .run(|app_handle, event| match event {
     RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        // D-12: terminal cleanup runs HERE -- by construction, this only
        // fires after the JS guard already let the close proceed, so
        // D-06 ("cancelled quit never kills terminals") holds for free.
        kill_all_live_terminal_process_groups_within_quit_budget();
        stop_poller_on_exit(...); // existing
     }
   })
```

**Why this satisfies D-03 "one quit path" literally, not just in spirit:** both Cmd+Q and the red button end up calling the exact same `useDestructiveActionGuard` code that already exists and is already covered by tests -- there is only one flush-and-confirm implementation in the whole app, not two implementations kept in sync.

**Verified precedent for menu-item substitution in this codebase:** `app_menu.rs` already does exactly this kind of default-submenu surgery for the Check-for-Updates item:
```rust
// Source: src-tauri/src/app_menu.rs:266-269 [VERIFIED: src-tauri/src/app_menu.rs:266-269]
#[cfg(target_os = "macos")]
if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
    app_menu.insert(check_for_updates, 1)?;
}
```
The same `menu.items()?.into_iter().enumerate()` + `MenuItemKind` matching pattern used in `remove_default_submenus` (`app_menu.rs:228-238`) can locate and remove the native `Quit` item from this same first-item (index 0) macOS App submenu, then insert a `command_item(app, "app.quit", "Quit Maru", Some("CmdOrCtrl+Q"))` in its place. `handle_menu_event` needs **no changes**: it already dispatches any unrecognized id through the generic `MENU_COMMAND_EVENT` path (`app_menu.rs:298-309`, `[VERIFIED: src-tauri/src/app_menu.rs:289-311]`), the same path `App.tsx`'s existing menu-command switch (`case "save":`, `case "open-graph":`, etc.) already consumes.

### System Architecture Diagram: Terminal kill escalation (REL-01)

```
terminal_kill(session_id)
     |
     v
session.closing.swap(true) -- latch, unchanged (terminal/mod.rs:857)
     |
     v
killer.kill()  <-- TODAY: ProcessSignaller::kill() = bare SIGHUP to single pid, no retry
     |             RECOMMENDED: keep this call (fast, non-blocking) for the
     |             immediate SIGHUP, but ALSO capture pid (== pgid == sid,
     |             see verified setsid() finding) at spawn time and hand it
     |             to a background escalation task:
     v
[detached thread, spawned once per terminal_kill call, no locks held across sleeps]
     |
     |-- immediately: kill(-pid, SIGHUP)  (already sent above; or send again here
     |                for a single code path -- planner's call)
     |-- sleep 2s
     |-- if child's Arc<AtomicBool> "exited" flag not yet set by the exit-thread:
     |      kill(-pid, SIGTERM)
     |      sleep 2s
     |      if still not exited: kill(-pid, SIGKILL)
     v
(session already removed from registry by terminal_kill; escalation thread
 only touches the OS process group, never re-touches session/registry state
 -- no interaction with the generation-token invariant, D-10)
```

A deliberately backgrounded grandchild (`sleep 999 &`, `disown`, `setsid cmd &`) has called its own `setsid()`/`setpgid()` and lives in a **different** process group than the terminal's immediate child -- `kill(-pid, sig)` targeting the terminal child's own pgid never reaches it. This is exactly the REL-01 survival requirement, and it falls out naturally from `kill(-pgid, ...)` semantics; no special-casing is needed.

**At app quit (D-12):** iterate `TerminalState.sessions`, and for each live session, run a compressed version of the same ladder (SIGHUP, then SIGTERM, no full 2s+2s waits if the budget is shared with the 3s save-flush window) inside the `RunEvent::ExitRequested`/`Exit` handler, then SIGKILL any process group still alive immediately before the handler returns (right before `app.exit(0)`/process teardown).

### Recommended Project Structure
No new files are strictly required. Natural seams:
```
src-tauri/src/terminal/
|-- mod.rs              # existing; add pid capture + escalation spawn at kill time
`-- kill_escalation.rs  # NEW (optional): the SIGHUP->SIGTERM->SIGKILL ladder as a
                         #   pure, testable function taking a pid and a clock/sleep
                         #   abstraction, so it can be unit-tested without a real PTY

src/lib/
`-- debouncedSave.ts     # existing; no structural change, just more callers

src-tauri/src/
`-- recovery.rs           # NEW (optional): `.maru/recovery/` write helper wrapping
                          #   atomic_file::write_atomic, naming/retention policy (D-08,
                          #   Claude's Discretion)
```

### Pattern 1: Process-group kill via raw FFI (verified existing idiom)
**What:** Send a signal to an entire process group by negating the pgid, via a local `extern "C"` declaration -- no `libc`/`nix` crate dependency required.
**When to use:** Any time a spawned child (or PTY slave) needs itself and its foreground descendants killed without touching backgrounded/detached descendants.
**Example:**
```rust
// Source: src-tauri/src/command_output.rs:542-560 (existing, working code in this
// repo) [VERIFIED: src-tauri/src/command_output.rs:542-560]
#[cfg(unix)]
fn terminate_unix_process_group(
    child: &mut std::process::Child,
    process_group_id: u32,
) -> io::Result<()> {
    const SIGKILL: i32 = 9;
    extern "C" {
        fn kill(pid: i32, signal: i32) -> i32;
    }
    let process_group = i32::try_from(process_group_id)
        .map_err(|_| io::Error::other("child process id exceeds i32"))?;
    let result = unsafe { kill(-process_group, SIGKILL) };
    if result == 0 {
        return Ok(());
    }
    // ... error handling continues (checks for ESRCH-equivalent "already gone")
}
```
REL-01's fix needs the same call shape, parameterized by signal number (1=SIGHUP, 15=SIGTERM, 9=SIGKILL) instead of hardcoding SIGKILL, and driven by a timed ladder instead of a single call.

### Pattern 2: portable_pty already makes the terminal child a process/session group leader
**What:** `portable_pty`'s Unix `PtyFd::spawn_command` calls `libc::setsid()` in the child's `pre_exec` hook, before `exec`.
**When to use:** This is not something to *add* -- it is the existing behavior confirming the ROADMAP's MEDIUM uncertainty resolves to "no action needed" on this specific point.
**Example:**
```rust
// Source: ~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.8.1/src/unix.rs:200-247
// [VERIFIED: portable-pty-0.8.1/src/unix.rs:200-247, read this session]
unsafe {
    cmd.stdin(self.as_stdio()?)
        .stdout(self.as_stdio()?)
        .stderr(self.as_stdio()?)
        .pre_exec(move || {
            for signo in &[
                libc::SIGCHLD, libc::SIGHUP, libc::SIGINT,
                libc::SIGQUIT, libc::SIGTERM, libc::SIGALRM,
            ] {
                libc::signal(*signo, libc::SIG_DFL);
            }
            // Establish ourselves as a session leader.
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if controlling_tty {
                if libc::ioctl(0, libc::TIOCSCTTY as _, 0) == -1 {
                    return Err(io::Error::last_os_error());
                }
            }
            close_random_fds();
            if let Some(mask) = configured_umask { libc::umask(mask); }
            Ok(())
        })
};
let mut child = cmd.spawn()?;
```
`setsid()` makes the child the leader of a *new* session and a *new* process group whose ID equals its own pid. So `child.process_id()` (available via the `Child` trait, `[VERIFIED: portable-pty-0.8.1/src/lib.rs:137]`) is simultaneously the pid, the pgid, and the sid of the terminal's immediate child -- `kill(-pid, sig)` is therefore correct and needs no separate pgid lookup or `setpgid()` call at spawn time.

### Pattern 3: The actual REL-01 bug -- `ChildKiller` stored is not the escalating one
**What:** `TerminalSession.killer` is populated from `child.clone_killer()` at spawn (`terminal/mod.rs:458`), not from `child` itself. On Unix, `std::process::Child::clone_killer()` returns a `ProcessSignaller`, whose `ChildKiller::kill()` is a single bare `SIGHUP` with no retry and no group targeting:
```rust
// Source: portable-pty-0.8.1/src/lib.rs:312-327
// [VERIFIED: portable-pty-0.8.1/src/lib.rs:312-327, read this session]
#[cfg(unix)]
impl ChildKiller for ProcessSignaller {
    fn kill(&mut self) -> IoResult<()> {
        if let Some(pid) = self.pid {
            let result = unsafe { libc::kill(pid as i32, libc::SIGHUP) };
            if result != 0 {
                return Err(std::io::Error::last_os_error());
            }
        }
        Ok(())
    }
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync> {
        Box::new(Self { pid: self.pid })
    }
}
```
Contrast: the boxed `child` value itself (consumed by the exit-wait thread, `terminal/mod.rs:485-502`) implements a *different*, escalating `ChildKiller` (SIGHUP -> up to ~250ms of polling -> SIGKILL to the single pid, `portable-pty-0.8.1/src/lib.rs:329-362`) -- but that impl is never reachable from `terminal_kill`, because only the *cloned* `ProcessSignaller` is stored for out-of-band signaling, and `clone_killer()` deliberately does not carry over the escalation behavior. This exactly matches the `terminal/mod.rs:871-875` comment ("`ChildKiller::kill` only raises SIGHUP on unix") -- now precisely explained rather than just observed. The fix is a custom `ChildKiller`/escalation task per Pattern 1, not a change to how `child.clone_killer()` is called.

### Anti-Patterns to Avoid
- **Holding `TERMINAL_KILLER` mutex across the 2s+2s sleeps:** the existing lock (`session.killer: Mutex<...>`, recovered via `crate::lock_recovery::recover_guard`) must only be held for the instant needed to read/send the initial signal. The escalation ladder's sleeps must run in a detached thread that does not hold this lock, per the Claude's Discretion note "work out how to escalate without holding locks across sleeps."
- **Sending signals to a bare pid instead of `-pid`:** would kill only the exact PTY child and leave foreground pipeline/subshell descendants (which share its pgid) running as orphans -- this is the actual production bug class Phase 9 is fixing, not a hypothetical.
- **Re-deriving the pgid via a `getpgid()` syscall:** unnecessary. Since `setsid()` runs before `exec`, `child.process_id()` captured once at spawn time already equals the pgid for the lifetime of that process (a process cannot change its own session/group leader status after `setsid()`).
- **Routing Cmd+Q through a brand-new ack command "because the discretion note mentions an ack command":** the note lists it as one *option* the researcher should investigate, not a mandate. The `window.close()`-reuse design (Alternatives Considered) is lower-risk and reuses tested code; only add IPC surface if a genuinely different quit-only UX is required.
- **Assuming `beforeunload`/`pagehide` (current `App.tsx:1934-1943`) is sufficient for Cmd+Q:** it is not -- REL-02's own text calls this "documented-unreliable inside Tauri," and it does not even fire today for the native-Quit-menu path in the first place (Cmd+Q bypasses the webview lifecycle entirely when it terminates the process via AppKit, not via window close).

## Don't Hand-Roll

| Problem | Don't Build | Use Instead | Why |
|---------|-------------|-------------|-----|
| Debounce-then-save-on-timer | A new bespoke `setTimeout` + ref pattern per surface (4 already exist) | `src/lib/debouncedSave.ts`'s `createDebouncedSaver`/`createContextualDebouncedSaver` | Already handles clear-on-reschedule, `flush()` draining the pending value synchronously-on-call, and a `SaveQueue` serializing concurrent flushes -- exactly the primitives D-01 needs, already tested in `debouncedSave.test.ts` |
| Sending a signal to a process group | A new `nix`/`libc` direct dependency, or a hand-rolled `libc::kill` import | The existing `extern "C" { fn kill(...) }` raw-FFI idiom in `command_output.rs` | Zero new dependency surface; one pattern for "signal a process group" across the whole codebase instead of two |
| Cross-component "flush everything before you go away" signal | A new ad hoc pub/sub bus | The `onRegisterFlush` callback-registration pattern `TodayBrainDump.tsx`/`TodayPrepare.tsx` already use (`(flush: () => Promise<void>) => () => void`), generalized to a small registry consumed by `hasDirtyDrafts`/the quit-flush step | Precedent already exists and is already tested for exactly this "parent needs to flush a child's pending debounce before an atomic operation" shape |

**Key insight:** every piece of infrastructure REL-01/02/03 need already exists somewhere in this codebase in a *working, tested* form (an escalating-kill FFI pattern, a debounced-saver abstraction, a global toast store, an atomic file writer, a flush-registration callback shape, and a dirty-draft quit guard). The work is almost entirely "wire the fourth/fifth caller onto the existing thing" and "fix one narrow, previously-undiagnosed bug in which killer object gets stored" -- not new abstractions.

## Common Pitfalls

### Pitfall 1: Complete debounced-autosave inventory (REL-02 D-01) -- do not stop at the three named in CONTEXT.md

**What goes wrong:** Only converting Scratchpad/Studio/TodayBrainDump (the three explicitly named in CONTEXT.md) misses at least one more genuine cancel-only-on-unmount bug.

**Full inventory** (grep across `src/`, every `setTimeout`/`setInterval` site cross-checked against unmount cleanup behavior):

| Surface | File | Debounce | Unmount behavior today | Disposition |
|---------|------|----------|------------------------|-------------|
| Scratchpad memo autosave | `src/components/ScratchpadPane.tsx:566-574` (`scheduleAutoSave`) | 700ms | `useEffect(() => () => { clearAutoSaveTimer(); }, ...)` (`:541-545`) -- **cancel only, no flush** | **D-01 fix required.** `flushCurrent()`'s `.catch()` (`:454-461`) already calls the global `errorStore.setError` -- D-07 is nearly free once wired |
| Studio draft autosave | `src/components/studio/StudioMode.tsx:260-268` (`saveTimerRef` -> `enqueueStudioSave`) | 600ms | `return () => { if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current); }` (`:265-267`) -- **cancel only** | **D-01 fix required** |
| Today brain dump autosave | `src/components/today/TodayBrainDump.tsx:44,112` (`timerRef`) | 800ms (`AUTOSAVE_DEBOUNCE_MS`) | `useEffect(() => () => { if (timerRef.current !== null) clearTimeout(timerRef.current); if (pendingTextRef.current !== null) void saveRef.current(pendingTextRef.current); }, [])` (`:89-96`) -- **already flushes** (fire-and-forget) | Convert onto `debouncedSave.ts` for consistency/D-01, but this surface is not currently dropping edits on unmount. Already has an `onRegisterFlush` hook wired to `TodayPrepare.tsx` for the Finish/Quick-skip flow -- reuse for quit |
| Meeting source editor debounce | `src/components/meetings/MeetingSourceWorkbench.tsx:247-250` | 700ms (calls `editor.flush()`, itself synchronous-on-call, not its own debounce) | `return () => window.clearTimeout(timer);` -- **cancel only, no flush call** | **D-01 fix required** |
| HTML visual editor serialize | `src/components/HtmlVisualEditor.tsx:242-259` (`serializeTimerRef`) | 300ms | Already flushes: `if (serializeTimerRef.current != null) { window.clearTimeout(...); serializeTimerRef.current = null; serializeNowRef.current(); }` (`:250-259`) | Already compliant per CONTEXT.md D-01 note; no change needed beyond confirming it "conforms" (it calls `onChange`, pushing to parent state synchronously -- not itself a disk write) |
| Graph layout position autosave | `src/components/graph/GraphView.tsx:395,604-616` (`saveTimerRef`, `SAVE_DEBOUNCE_MS = 1500`) | 1500ms | `return () => { if (saveTimerRef.current) clearTimeout(saveTimerRef.current); };` (`:614-616`) -- **cancel only** | **Borderline candidate, flag for planner decision.** This persists node-position layout to `.maru`'s vault-graph-layout cache, not user-authored text. Losing one autosave cycle means positions revert to the last save, not "an edit vanishes" in the REL-02 sense the requirement text describes (editor content). Recommend including it for consistency (it is a genuine cancel-only-on-unmount timer) but it is lower severity than the four above |
| Diagram version-history auto-snapshot | `src/lib/diagram/versionHistory.ts` (`createAutoSnapshotScheduler`) used by `src/components/diagram/DiagramMode.tsx:397-416` | 2500ms quiet / 5min interval | `sched.dispose()` on unmount clears both timers with no final fire | **Excluded.** The code's own comment states this "bypasses the human-facing save and stores a versioned copy" and the catch block says "ignore -- snapshots are best-effort" (`DiagramMode.tsx:394-408`, `[VERIFIED: src/components/diagram/DiagramMode.tsx:393-409]`). The diagram's actual document save is an explicit Cmd+S (`handleSave`, `DiagramMode.tsx:1049`), not a debounce -- out of scope for REL-02, which is about *debounced* saves |
| Vault index delta rescan | `src/lib/workspaceStore.ts:553-565` (`deltaTimer`) | 150ms | Cancel-only on unmount | **Excluded.** This is a derived/rebuildable read-side index cache triggered by filesystem-watcher events, not user-authored content; dropping it just means the index re-syncs on the next full scan, not that an edit is lost |
| Drafts pane save status | `src/components/drafts/DraftsPane.tsx` | none found | N/A | **Excluded.** No `setTimeout`/debounce found; "autosave" styling is reused CSS class naming, not an actual debounce -- saves appear to be explicit-action-triggered |
| Main document editor (`editorTabsStore.ts`) | n/a | none found | N/A -- dirty-draft confirm dialog instead | **Excluded.** `grep` found zero `setTimeout`/debounce in `editorTabsStore.ts`; the primary markdown editor uses explicit Cmd+S + the existing `useDestructiveActionGuard` dirty-draft confirm, which already blocks close/quit on unsaved changes rather than silently autosaving. This is a *different*, already-correct mechanism and needs no REL-02 change |
| Settings saver | `src/App.tsx:1908-1930` | 250ms, via `createContextualDebouncedSaver` | Already flushes on unmount (`void saver.flush()`, `:1926`) and on `beforeunload`/`pagehide` (`:1932-1943`) | Already on the shared helper (the *only* production caller today). The `beforeunload`/`pagehide` fallback is exactly the "documented-unreliable" mechanism REL-02's text calls out -- D-03 replaces/supplements it with the Rust-driven handshake, it does not need removal necessarily, but should not be relied on as the primary mechanism going forward |

**Why it happens:** Every one of these surfaces was built independently, each author reaching for `setTimeout` + a ref rather than the shared helper (which did not exist yet, or was not discovered) -- textbook "don't hand-roll" drift.

**How to avoid:** Convert the 4 required surfaces (Scratchpad, Studio, TodayBrainDump for consistency, MeetingSourceWorkbench) onto `debouncedSave.ts`. Consider a cheap static guard (mentioned as optional in CONTEXT.md "Established Patterns") to prevent a sixth hand-rolled timer from reappearing -- e.g., a `check-*.mjs` grep for `window.setTimeout` co-located with a string like "save" outside `debouncedSave.ts` itself and its already-approved call sites; this is explicitly optional and was not required by the discussion.

**Warning signs:** grep for `setTimeout` inside any `useEffect` cleanup that does *not* also call the save/flush function -- that shape is the exact anti-pattern.

### Pitfall 2: Cmd+Q does not reach `RunEvent::ExitRequested` today, and the reason is structural, not a missing handler

**What goes wrong:** A plan that only adds a `match event { RunEvent::ExitRequested { api, .. } => { api.prevent_exit(); ... } }` block to the existing `.run()` closure (`lib.rs:641-648`) will work for window-close-to-zero-windows, but will **not** intercept Cmd+Q, because Cmd+Q never reaches that closure at all on macOS with the current menu setup.

**Why it happens:** Verified in `tauri-runtime-wry-2.10.1/src/lib.rs:4171-4187,4214-4228`: `RunEvent::ExitRequested` is only constructed in two places -- `TaoWindowEvent::Destroyed` when the window count reaches zero, and `Message::RequestExit` (i.e. `AppHandle::exit()`). Maru's macOS App-menu submenu is Tauri's untouched `Menu::default(app)` default (confirmed: `app_menu.rs`'s `remove_default_submenus` list is `["File", "Edit", "View", "Window"]` -- the macOS App submenu, which carries the native `Quit`, is never touched, `[VERIFIED: src-tauri/src/app_menu.rs:29]`). The native macOS `Quit` menu item is built by `muda::PredefinedMenuItem::quit()` (`tauri-2.10.3/src/menu/predefined.rs:318-334`), a native OS-level menu action -- on macOS this triggers `NSApplication terminate:`. Neither `tao` 0.34.8 nor `tauri-runtime-wry` install an `applicationShouldTerminate:` AppKit delegate override (`grep` for that selector across the vendored `tao-0.34.8` source returned zero hits), so the default AppKit termination sequence runs, which does not route through `TaoWindowEvent::CloseRequested`/`Destroyed` at all. This is not a training-data guess: it matches upstream Tauri issue history describing exactly this gap (`tauri-apps/tauri#3124` "native Quit menu item doesn't trigger CloseRequested nor ExitRequested", `tauri-apps/tauri#9198` "ExitRequested not fired on macOS") and matches CONTEXT.md's own observed-behavior note, "Today Cmd+Q bypasses both."

**How to avoid:** Do not add logic solely inside the `.run()` `RunEvent::ExitRequested` match arm and assume Cmd+Q is covered. Replace the native Quit item (see Architecture Patterns / Pattern reuse of `app_menu.rs`'s existing submenu-surgery pattern) so Cmd+Q routes through the same JS guard as window-close, *then* the `RunEvent::ExitRequested` handler (for D-12 terminal cleanup) will reliably fire for both paths because both now end at `window.close()`.

**Warning signs:** If a native e2e/manual QA check presses Cmd+Q and the app exits immediately with no confirm dialog even when a Scratchpad memo has unsaved changes -- that is this exact gap, not a race condition in the new code.

### Pitfall 3: `command_output.rs`'s pattern does not port unchanged (per the ROADMAP uncertainty note) -- confirm why

**What goes wrong:** Assuming `configure_process_tree`/`ProcessTree` from `command_output.rs` can be reused as-is for the terminal PTY child.

**Why it happens:** `command_output.rs`'s `configure_process_tree` calls `command.process_group(0)` on a **`std::process::Command`** built directly by that module (`command_output.rs:400-405`) -- but the terminal's child is spawned via `portable_pty`'s `CommandBuilder`/`pair.slave.spawn_command(cmd)` (`terminal/mod.rs:454-457`), which internally builds and spawns its own `std::process::Command` inside the vendored crate, with its own `pre_exec` (the `setsid()` call, Pattern 2 above) -- Maru's code never gets a `&mut Command` to call `.process_group(0)` on. The *effect* `command_output.rs` wants (make this child killable as a group) is already achieved a different way (via `setsid()`, which `command_output.rs`'s target commands do not use) inside the vendored crate. The kill-side code (Pattern 1) still ports directly, because it only needs a pid/pgid integer and a raw `kill()` FFI call -- it does not depend on how the child was spawned.

**How to avoid:** Do not try to inject a `pre_exec`/`process_group(0)` call into the PTY spawn path -- it is unnecessary (setsid already achieves distinct-group status) and portable_pty's `CommandBuilder` does not expose a `pre_exec` hook to callers outside the crate. Only the *kill-side* FFI pattern needs porting.

**Warning signs:** Spending implementation time trying to find a way to call `.process_group(0)` on `portable_pty::CommandBuilder` -- it does not have that method; this is the wrong branch of the fix.

## Code Examples

### REL-04 verify-only: existing coverage already satisfies success criterion 4

```rust
// Source: src-tauri/src/jobs.rs:1066-1100 [VERIFIED: src-tauri/src/jobs.rs:1066-1100]
#[test]
fn env_value_expands_every_tilde_segment() {
    let _home = Home::new();
    let home = crate::skill_host::fs::install_root_base().unwrap().to_string_lossy().to_string();

    // Regression: a two-tilde PATH must expand both segments.
    assert_eq!(
        expand_tilde_segments("~/a:~/b:/usr/bin"),
        format!("{home}/a:{home}/b:/usr/bin")
    );                                                    // <- criterion (1): every segment absolute
    assert_eq!(
        expand_tilde_segments("/usr/bin:/opt/homebrew/bin"),
        "/usr/bin:/opt/homebrew/bin"
    );                                                    // <- criterion (3): single/no-tilde byte-identical
    assert_eq!(
        expand_tilde_segments("~/bin/tools"),
        format!("{home}/bin/tools")
    );
    assert_eq!(
        expand_tilde_segments("https://example.com/x"),
        "https://example.com/x"
    );                                                    // <- criterion (2): colon-bearing non-path byte-identical
    assert_eq!(expand_tilde_segments("12:30"), "12:30");   // <- criterion (2), second case
    assert_eq!(
        expand_tilde_segments("~:/usr/bin"),
        format!("{home}:/usr/bin")
    );
}
```
Plus a full plist-XML integration test (`jobs.rs:1102-1123`, `plist_env_expands_colon_separated_tildes`) that asserts the generated launchd XML contains the fully-expanded string and `assert!(!xml.contains("~/"), ...)`. **Conclusion: all three success-criterion (4) components are already covered by name-matching regression tests. D-13 requires no new test -- only marking REL-04 complete in `REQUIREMENTS.md`'s traceability table.**

### REL-03: the toast mechanism a fixed unmount-flush will inherit

```typescript
// Source: src/components/ScratchpadPane.tsx:454-461 [VERIFIED: src/components/ScratchpadPane.tsx:454-461]
.catch((error) => {
  const message = errorMessage(error);
  if (isRevisionConflict(error)) setConflict(true);
  setLocalError(message);
  setSaveState("error");
  setError(message);           // <- this is the GLOBAL errorStore.setError
  return false;
});
```
```typescript
// Source: src/components/ScratchpadPane.tsx:65 [VERIFIED: src/components/ScratchpadPane.tsx:65]
import { setError } from "../lib/errorStore";
```
Once D-01 wires the unmount cleanup to actually call `flushCurrent()` (instead of only `clearAutoSaveTimer()`), a save failure during unmount already raises the global, pane-surviving toast (`errorStore.ts`'s module-level `errorValue` + `useSyncExternalStore`, `[VERIFIED: src/lib/errorStore.ts:1-51]`) with no additional wiring. Remaining D-07 work: confirm the message names the file (check `errorMessage(error)`'s format upstream) and add the "same line goes to the log" requirement (no existing `console.error`/Rust-side log call was found on this path -- add one). D-08 (recovery copy under `.maru/recovery/`) is new work in all cases; there is no existing analog to reuse beyond `atomic_file::write_atomic` for the write itself.

### REL-03/D-08: recovery-file conventions verified

```rust
// Source: src-tauri/src/paths.rs:37-57 [VERIFIED: src-tauri/src/paths.rs:37-57]
/// Directories produced by tooling, never authored content. Every scanner
/// prunes these; adding one is a one-line edit here (SCAN-01).
///
/// `.maru` is deliberately absent -- it is Maru state, not a generated dir
/// (evidence_binder keeps excluding it module-locally).
pub const GENERATED_DIRS: &[&str] = &[ "node_modules", "target", "dist", ... ];
```
```rust
// Source: src-tauri/src/vault.rs:221-242 [VERIFIED: src-tauri/src/vault.rs:221-242]
pub fn is_excluded_path(&self, path: &Path, root: &Path, generated_dirs: &[&str]) -> bool {
    // ...
    let mut has_dot_segment = false;
    for component in rel.components() {
        // ...
        if name.starts_with('.') { has_dot_segment = true; }
    }
    has_dot_segment && !self.dot_path_allowed(rel)
}
```
`.maru` is intentionally absent from `GENERATED_DIRS` (that list is for build/tooling output, not Maru's own state), but the document-index scanner (`scan_vault`, via `ScanFilter::is_excluded_path`) independently excludes **any** dot-prefixed top-level path segment unless explicitly allow-listed via `dot_path_allowed`. Since `.maru/recovery/...` starts with a dot segment and is not on any allow-list, recovery files will not appear in the Documents index/Files browser by construction -- **confirms the research question "does `.maru/` stay out of watchers and indexes" is YES for the document-index scan path.** (The raw filesystem watcher may still emit low-level fs-change events for `.maru/recovery/*` writes, but the delta-apply step re-runs this same exclusion filter, so no user-visible leak is expected -- the planner should still smoke-test this rather than assume, since the watcher layer itself was not read line-by-line this session.)

Atomic-write helper to reuse for the recovery copy itself:
```rust
// Source: src-tauri/src/atomic_file.rs:750,756 [VERIFIED: src-tauri/src/atomic_file.rs:750-806, signatures only]
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String>;
pub(crate) fn write_atomic_private(path: &Path, content: &[u8]) -> Result<(), String>;
```
Both are `pub(crate)`, callable from any module in `src-tauri/src/`, and internally use a `NamedTempFile` + `.persist(path)` pattern (`atomic_file.rs:794`) -- the same primitive `document.rs`'s save path presumably already relies on. Use `ensure_within` (`paths.rs:78-84`) to keep the recovery filename construction inside `.maru/recovery/`, matching the codebase's existing containment-check convention.

## State of the Art

| Old Approach | Current Approach | When Changed | Impact |
|--------------|------------------|---------------|--------|
| Webview `beforeunload`/`pagehide` to flush state before quit | Rust-driven `RunEvent::ExitRequested` handshake | This phase (REL-02) | `beforeunload` is asynchronous-unsafe (the OS does not guarantee the page gets to finish async work) and, per this research, does not even fire for the macOS-native-Quit path in the first place since that path terminates before the webview lifecycle runs at all |
| `ChildKiller::kill()` = single bare signal | Timeout-gated, process-group-targeted escalation ladder | This phase (REL-01) | Closes the "immortal SIGHUP-trapping session" class of bug (`CONCERNS.md`'s named defect) without breaking the deliberately-backgrounded-grandchild survival guarantee |

**Deprecated/outdated:** None -- this is a bug-fix phase, not a version-upgrade phase.

## Assumptions Log

| # | Claim | Section | Risk if Wrong |
|---|-------|---------|---------------|
| A1 | The macOS App-menu submenu-surgery approach (remove native `Quit`, insert a custom `MenuItem` calling `window.close()`) can locate the native Quit item reliably via `MenuItemKind`/`.text()` matching, the same way `remove_default_submenus` locates `"File"`/`"Edit"`/etc. by label text. Not verified against a live build -- `muda`'s exact `MenuItemKind` variant/id for a `PredefinedMenuItem::quit()` item was not read this session. | Architecture Patterns / Quit handshake | If the native Quit item cannot be cleanly located/removed via the same `menu.items()` iteration, the executor needs a different approach (e.g., not calling `Menu::default()` for the macOS App submenu at all, and hand-building it item-by-item) -- more invasive but still buildable |
| A2 | Calling `window.close()` from the custom quit menu item's Rust handler (rather than a JS-side `getCurrentWindow().close()`) behaves identically -- both dispatch through the same `dispatcher.close()` runtime call. Verified only that `Window::close()`'s doc comment contrasts it with `destroy()` ("does not emit any events... force close"), implying `close()` does emit events; the exact downstream event (`WindowEvent::CloseRequested`) was confirmed via the wry match arm for `TaoWindowEvent::CloseRequested`, not by tracing the JS binding's identical code path line-by-line. | Architecture Patterns / Quit handshake | If Rust-side `window.close()` and JS-side `getCurrentWindow().close()` diverge in some Tauri-internal way, the plan should call the window-close **from JS** instead (dispatch the `"app.quit"` menu-command id straight into the same `requestWindowClose()` JS function, which already calls `getCurrentWindow().close()`) -- this is actually the simpler and already-described design in the Architecture diagram, so this assumption's failure mode is low-cost |
| A3 | No secondary/detached webview window exists in the shipped app today (only `"main"`). Verified: no `WebviewWindowBuilder::new` call outside test/mock code was found, and `tauri.conf.json` declares no additional window labels. | Architecture Patterns / Quit handshake, Pitfall 2 | If a secondary window is added in a later phase, Cmd+Q pressed while that window is focused needs its own "quit means close the *app*, not just this window" handling -- out of scope today but worth a one-line note for future-proofing |
| A4 | The raw filesystem watcher (not just the document-index scan) also effectively excludes `.maru/recovery/*` from producing user-visible index churn, because the delta-apply step re-runs the same `is_excluded_path`/dot-segment filter. Not verified by reading the watcher module line-by-line this session -- inferred from the scan-filter's use in `scan_and_applyVaultDelta`'s Rust counterpart. | Code Examples / REL-03 D-08 | If wrong, `.maru/recovery/*` writes could produce spurious index-delta churn (not a data-loss risk, just noise) -- cheap to smoke-test during implementation |
| A5 | `errorMessage(error)` (used throughout `ScratchpadPane.tsx`'s catch handlers) already produces a message that names the failing file, satisfying D-07's "names the file" requirement without extra work. Not verified -- `errorMessage`'s implementation was not read this session. | Common Pitfalls / Pitfall 1, Code Examples | If the message is generic (e.g., just the raw error string with no filename), the planner needs to prepend the target path explicitly at each teardown-flush call site |

**If this table is empty:** N/A -- see above; all five assumptions are narrow, cheaply-checkable-at-implementation-time gaps, not load-bearing unknowns that block planning.

## Open Questions

1. **Does the macOS App submenu's native `Quit` item expose a stable, matchable identity for removal?**
   - What we know: `Menu::default(app)` builds it via `muda::PredefinedMenuItem::quit()`; `app_menu.rs` already demonstrates removing/inserting items into default submenus by iterating `menu.items()` and matching `MenuItemKind`.
   - What's unclear: whether a `PredefinedMenuItem`'s `MenuItemKind` variant carries an easily-matchable discriminant (vs. having to match on displayed text, which is locale-dependent) for specifically the "quit" kind, as opposed to About/Services/Hide, which must stay.
   - Recommendation: spike this narrowly first (a few lines in `app_menu.rs`, checked with a debug print of `menu.items()` on a dev build) before committing to the full quit-handshake plan; if it is awkward, fall back to hand-building the macOS App submenu (`Submenu::with_items`) instead of starting from `Menu::default()`.

2. **What is the precise UX for "quit anyway" (D-05) and the "3s timeout -> cancel" path, given the existing `pendingDestructiveAction` dialog only has one shape today ("close" vs "relaunch")?**
   - What we know: `useDestructiveActionGuard` already has `pendingDestructiveAction: "close" | "relaunch"` and a confirm/cancel pair; D-05 needs a *third* state (failed-save-during-quit, offering retry or force-quit) that is distinct from the existing pre-flush "you have unsaved drafts, quit anyway?" dialog.
   - What's unclear: whether this is a new `DestructiveAction` variant (e.g. `"quit-failed"`) or a separate toast-driven flow layered on top of the existing dialog.
   - Recommendation: the planner should design this as a new discriminant on the existing `pendingDestructiveAction` type rather than a parallel modal system, to keep "one quit path" (D-03) true at the UI layer too.

## Environment Availability

Not applicable -- this phase has no new external tool/service dependency. `portable-pty` 0.8.1, `nix` 0.25.1, and `libc` 0.2.186 are already vendored and already compiled into the shipped binary today (verified present under `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/`). Tauri 2.10.3 is already the pinned version (`src-tauri/Cargo.lock:4998-5000`).

## Validation Architecture

### Test Framework
| Property | Value |
|----------|-------|
| Framework (TS) | Vitest 4.1.5 |
| Framework (Rust) | `cargo test --lib` (via `make test-rust`) |
| Native e2e | WebdriverIO against the real app (`docs/native-e2e.md`, `e2e-native/`) -- macOS-only, not hermetic, outside `make verify` |
| Config file | `vitest.config.ts` (TS), none dedicated for Rust (cargo default), `e2e-native/wdio.conf.ts` (native) |
| Quick run command (Rust, this module) | `cargo test --lib terminal:: -- --nocapture` (from `src-tauri/`) |
| Quick run command (TS, this module) | `pnpm vitest run src/lib/debouncedSave.test.ts src/lib/useDestructiveActionGuard.test.ts` (second file does not yet exist -- see Wave 0 gap) |
| Full suite command | `make verify` (typecheck, lint, guards, `test-ts`, `test-rust`, fmt, clippy, frontend build, command-isolation) |
| Native full run | `make test-e2e-native` |

### Phase Requirements -> Test Map
| Req ID | Behavior | Test Type | Automated Command | File Exists? |
|--------|----------|-----------|-------------------|-------------|
| REL-01 | A SIGHUP-trapping child (foreground) is killed via the escalation ladder within ~4s | Rust integration (real PTY, `#[cfg(test)]` in `terminal/mod.rs`, following the existing `phase08_18_stage` harness shape) | `cargo test --lib terminal::tests -- --nocapture` | Partial -- `terminal/mod.rs` already has a `#[cfg(test)] mod tests` block with real-command-spec tests; a new test spawning `trap '' HUP; sleep 60` and asserting the child is gone within budget needs to be added -- NO - Wave 0 |
| REL-01 | A grandchild backgrounded via `setsid`/`disown`/`nohup ... &` survives tab close | Rust integration, same file, or native e2e (`e2e-native/specs/pty.spec.ts` already drives a real PTY) | `cargo test --lib terminal::tests::grandchild_survives_group_kill` (new) or extend `pty.spec.ts` | NO - Wave 0 (new Rust test recommended -- faster and more precise than native e2e for this specific process-tree assertion) |
| REL-01 | Generation-token invariant still holds (late output from a dying child does not land in a new session) | Existing coverage -- do not regress | `cargo test --lib terminal::` (existing `phase08_18` tests already assert generation/registry behavior) | yes - existing |
| REL-02 | Pending debounced save flushes (not drops) on component unmount, for each of the 4 in-scope surfaces | Vitest, component-level, following the pattern likely already used for `HtmlVisualEditor`'s unmount-flush (if a test exists) or `debouncedSave.test.ts`'s existing flush-on-demand assertions | `pnpm vitest run src/components/ScratchpadPane.test.tsx src/components/studio/StudioMode.test.tsx` (need to confirm these files exist) | Needs a Wave 0 check: `find src/components -iname "ScratchpadPane.test.tsx" -o -iname "StudioMode.test.tsx"` was not run this session -- NO - Wave 0 verification pending |
| REL-02 | Cmd+Q and window-close both route through one flush+confirm path | Native e2e only (`e2e-native/specs/menu.spec.ts` already dispatches menu-command ids through the debug bridge into the same JS handler the native menu emits) + manual/human-attended macOS check for the actual native accelerator | `pnpm test:e2e:native` (extend `menu.spec.ts` with an `"app.quit"` case) + manual checklist entry in `docs/native-e2e.md` | Partial -- `menu.spec.ts` exists and is directly extensible; **the literal native keypress-to-menu-action wiring is fundamentally human-attended only** (documented "No Analog Found" limitation for the macOS menu bar, `menu.spec.ts:1-11`) |
| REL-02 | Quit waits <=3s, shows a "saving" indicator after ~300ms, cancels on failure/timeout (D-04/05) | Vitest (fake timers) on the guard hook itself, once extended | `pnpm vitest run src/lib/useDestructiveActionGuard.test.ts` (new file) | NO - Wave 0 -- no test file found for this hook this session |
| REL-03 | Failed teardown save raises the global toast + writes a `.maru/recovery/` copy | Vitest for the toast assertion (mock the save to reject, assert `errorStore`'s value); Rust unit test for `write_atomic`-based recovery write | `pnpm vitest run src/lib/errorStore.test.ts` (check exists) + new Rust test for the recovery module | NO - Wave 0 for the recovery-write Rust test (module does not exist yet) |
| REL-04 | Every tilde segment absolute; colon-bearing non-path and single-path byte-identical | Rust unit (already exists) | `cargo test --lib jobs::tests::env_value_expands_every_tilde_segment jobs::tests::plist_env_expands_colon_separated_tildes` | yes - existing -- no Wave 0 gap |

### Sampling Rate
- **Per task commit:** the quick run command scoped to the touched module (`cargo test --lib terminal::` or `pnpm vitest run <touched test file>`).
- **Per wave merge:** `make verify` (TS + Rust, minus native e2e).
- **Phase gate:** `make verify` green, plus a human-attended native pass following `docs/native-e2e.md`'s macOS-menu-bar checklist for the actual Cmd+Q keypress (cannot be automated -- Accessibility-walled, same limitation `menu.spec.ts`'s own header comment documents for every other native menu command).

### Wave 0 Gaps
- [ ] Confirm whether `ScratchpadPane.test.tsx`, `StudioMode.test.tsx`, and `useDestructiveActionGuard.test.ts` exist (not checked this session) -- if absent, each new flush-on-unmount/quit-guard behavior needs a fresh test file, not just new cases in an existing one.
- [ ] New Rust integration test(s) in `terminal/mod.rs`'s existing `#[cfg(test)] mod tests` block: SIGHUP-trapping child killed within budget; backgrounded grandchild survives.
- [ ] New Rust unit test(s) for the recovery-copy write helper (module does not exist yet -- covers REL-03/D-08).
- [ ] Extend `e2e-native/specs/menu.spec.ts` with an `"app.quit"` dispatch case, following the exact pattern already used for other menu-command ids in that file.
- [ ] `docs/native-e2e.md` macOS-menu-bar manual checklist needs a new line item for "Cmd+Q with a dirty Scratchpad draft shows the confirm dialog and does not exit" -- this is the one part of REL-02 that automation fundamentally cannot prove, per the existing "No Analog Found" precedent in this same doc for every other native-menu-bar interaction.

## Security Domain

### Applicable ASVS Categories

| ASVS Category | Applies | Standard Control |
|---------------|---------|-------------------|
| V2 Authentication | no | Not touched by this phase |
| V3 Session Management | no | "Session" here means terminal/PTY sessions, not auth sessions -- not an ASVS V3 concern |
| V4 Access Control | no | Not touched |
| V5 Input Validation | yes | Recovery-copy filenames (D-08) must be constructed from a sanitized/derived name, then checked with the existing `paths::ensure_within` containment helper before writing under `.maru/recovery/` -- never build the path directly from unsanitized user-controlled document names |
| V6 Cryptography | no | Not touched |

### Known Threat Patterns for this stack

| Pattern | STRIDE | Standard Mitigation |
|---------|--------|----------------------|
| Signal misdirection (killing more or less than intended) | Tampering / Denial of Service | Always signal `-pid` (process group) using the pid captured at spawn time (verified == pgid == sid via `setsid()`), never a bare pid for the escalation and never a pid read from anywhere other than the session's own recorded spawn-time value. Never widen the target to the *session* id in a way that could affect an unrelated process group sharing the terminal's controlling tty |
| Recovery-file path traversal | Tampering | Reuse `paths::ensure_within` (already used for `.maru/rules` and similar) to guarantee the recovery file write cannot escape `.maru/recovery/` even if the source document's name/path contains `..` or other traversal-shaped segments |
| Resource exhaustion via unbounded recovery copies | Denial of Service | D-08's "Claude's Discretion" note explicitly calls out retention/cleanup policy for `.maru/recovery/` -- the planner should cap either count or age, since every failed teardown save writes a new file and nothing currently prunes this directory |

## Sources

### Primary (HIGH confidence -- read this session, quoted with path + line range)
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.8.1/src/unix.rs:194-343` -- `setsid()` in `pre_exec`, `process_group_leader`, `Child`/`ChildKiller` wiring
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/portable-pty-0.8.1/src/lib.rs:120-387` -- `Child`/`ChildKiller` trait definitions, `ProcessSignaller`, blanket impls for `std::process::Child`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.10.3/src/app.rs:190-245,525-570` -- `RunEvent` enum, `ExitRequestApi`, `AppHandle::exit`/`restart`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.10.3/src/menu/predefined.rs:296-334` -- `PredefinedMenuItem::quit`/`close_window`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-2.10.3/src/window/mod.rs:1780-1787` -- `Window::close`/`destroy`
- `~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tauri-runtime-wry-2.10.1/src/lib.rs:4140-4235` -- the exact two call sites that construct `RunEvent::ExitRequested`
- `src-tauri/src/terminal/mod.rs` (full file read) -- `TerminalSession`, `terminal_kill`, spawn/kill lifecycle
- `src-tauri/src/command_output.rs:1-560` -- existing process-group kill FFI pattern
- `src-tauri/src/app_menu.rs` (full file read) -- default-submenu manipulation precedent, `handle_menu_event` dispatch
- `src-tauri/src/lib.rs:150-260,600-648` -- `run()`, existing `ExitRequested` handler, CloseRequested comment
- `src-tauri/src/jobs.rs:180-260,973-1200` -- `expand_tilde`/`expand_tilde_segments` + all regression tests
- `src-tauri/src/paths.rs` (full file read) -- `GENERATED_DIRS`, `ensure_within`, dot-folder rationale
- `src-tauri/src/vault.rs:200-302` -- `ScanFilter::is_excluded_path`, non-document root exclusion
- `src-tauri/src/atomic_file.rs:1-60,750-806` -- `write_atomic` signatures
- `src/lib/debouncedSave.ts` (full file read), `src/lib/errorStore.ts` (full file read), `src/lib/useDestructiveActionGuard.ts` (full file read)
- `src/components/ScratchpadPane.tsx`, `src/components/studio/StudioMode.tsx`, `src/components/today/TodayBrainDump.tsx`, `src/components/HtmlVisualEditor.tsx`, `src/components/meetings/MeetingSourceWorkbench.tsx`, `src/components/graph/GraphView.tsx`, `src/components/diagram/DiagramMode.tsx`, `src/lib/diagram/versionHistory.ts`, `src/lib/workspaceStore.ts`, `src/App.tsx` -- targeted reads of every debounce/timer site found by grep
- `src-tauri/Cargo.lock:2447-2450,2791-2794,3539-3556,4998-5000` -- pinned versions of `libc`, `nix`, `portable-pty`, `tauri`
- `.planning/phases/09-durability-and-session-lifecycle/09-CONTEXT.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/ROADMAP.md` (Phase 9/6/7/8 sections)

### Secondary (MEDIUM confidence)
- WebSearch summary of `tauri-apps/tauri` issues #3124 (closed, Tauri 1.0-beta era) and #9198 (Tauri 1.6.1, open at last check) describing native-Quit-menu-item not triggering `CloseRequested`/`ExitRequested` on macOS -- corroborates the source-level finding above but does not itself confirm current (2.10.3) behavior; treat the source reading as primary and this as corroboration only

### Tertiary (LOW confidence)
- None used as load-bearing for any claim in this document; every claim above is either source-verified this session or explicitly logged in the Assumptions table

## Metadata

**Confidence breakdown:**
- Standard stack: HIGH -- no new dependencies; existing dependency versions confirmed via `Cargo.lock`
- Architecture (REL-01): HIGH -- root cause and fix pattern both confirmed by reading vendored crate source directly, not docs or training memory
- Architecture (REL-02 quit handshake): HIGH on the "why Cmd+Q doesn't work today" diagnosis (multiple independent source confirmations); MEDIUM on the exact recommended replacement-menu-item mechanics (flagged as A1/A2 assumptions, cheap to falsify early)
- Pitfalls: HIGH -- the debounced-save inventory is a complete `grep`-driven sweep with each candidate individually read and classified, not a sample
- REL-04: HIGH -- verify-only claim backed by direct test-body reads, not a general "tests probably exist" assumption

**Research date:** 2026-09-25
**Valid until:** 30 days (stable dependency versions; the macOS-quit finding could be invalidated by a `tauri`/`tao`/`muda` version bump before the phase executes -- re-check `Cargo.lock` if `tauri` version differs from `2.10.3` at implementation time)
</content>
