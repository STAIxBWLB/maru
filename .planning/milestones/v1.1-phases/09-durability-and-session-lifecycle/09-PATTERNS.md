# Phase 9: Durability and Session Lifecycle - Pattern Map

**Mapped:** 2026-09-25
**Files analyzed:** 12 (4 hand-rolled autosave conversions, 1 quit-handshake pair, 1 terminal kill escalation, 1 recovery-copy helper, 4 reference-only analogs already compliant, REL-04 verify-only)
**Analogs found:** 12 / 12 (all in-repo; no external pattern needed)

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `src/components/ScratchpadPane.tsx` (convert `scheduleAutoSave`/`clearAutoSaveTimer` onto `debouncedSave.ts`) | component | CRUD (debounced file write) | `src/components/HtmlVisualEditor.tsx` (flush-on-unmount) + `src/lib/debouncedSave.ts` (the target API) | exact (already imports `errorStore`; only the timer plumbing changes) |
| `src/components/studio/StudioMode.tsx` (convert `saveTimerRef`/`enqueueStudioSave`) | component | CRUD (debounced file write) | same as above | role-match |
| `src/components/today/TodayBrainDump.tsx` (convert `timerRef`, already flushes but not via helper) | component | CRUD (debounced file write) | same as above | role-match (behavior already correct, just needs the shared primitive for consistency + D-07 toast wiring) |
| `src/components/meetings/MeetingSourceWorkbench.tsx` (convert the 700ms `setTimeout` calling `editor.flush()`) | component | CRUD (debounced file write) | same as above | role-match |
| `src/lib/useDestructiveActionGuard.ts` (extend: Cmd+Q routing, 3s budget, 300ms indicator, D-05 cancel-on-fail state) | hook/provider | request-response (confirm/flush handshake) | itself (existing `onCloseRequested` + `confirmDestructiveAction` flow) | exact  -  this file is both the analog and the edit target |
| `src-tauri/src/app_menu.rs` (replace native macOS Quit item with `command_item(app, "app.quit", ...)`) | config (native menu wiring) | event-driven | `insert_check_for_updates_item` (lines 259-267) + `remove_default_submenus` (lines 227-237) in the same file | exact |
| `src-tauri/src/terminal/mod.rs` (custom escalating kill: capture pid at spawn, spawn detached escalation thread on `terminal_kill`) | service/backend | event-driven (signal escalation) | `src-tauri/src/command_output.rs::terminate_unix_process_group` (lines 542-568) | exact (same FFI idiom, different signal ladder and trigger) |
| `src-tauri/src/terminal/mod.rs` (D-12 quit-time cleanup of all live sessions) | service/backend | batch (quit-time sweep) | same `terminate_unix_process_group` idiom + `TerminalState.sessions` iteration already used by `terminal_kill` | role-match |
| `src-tauri/src/recovery.rs` (NEW, D-08 recovery-copy writer) | utility | file-I/O | `src-tauri/src/atomic_file.rs::write_atomic` + `src-tauri/src/paths.rs::ensure_within` | exact (thin wrapper, no new pattern) |
| `src-tauri/src/lib.rs` (`RunEvent::ExitRequested`/`Exit` handler: D-12 terminal cleanup, ordered after quit commit) | config/service | event-driven | itself, ~line 641 (existing handler that stops the Telegram poller) | exact |
| `src/lib/errorStore.ts` (no structural change  -  reuse `setError` at each new flush-failure site) | store | pub-sub (toast) | itself (`ScratchpadPane.tsx:454-461` is the consumer analog) | exact |
| `src-tauri/src/jobs.rs` (verify-only, REL-04) | service | CRUD (config generation) | itself  -  existing tests `env_value_expands_every_tilde_segment`, `plist_env_expands_colon_separated_tildes` (lines 1066-1123) | exact  -  no code change |

## Pattern Assignments

### `src/components/ScratchpadPane.tsx`, `StudioMode.tsx`, `MeetingSourceWorkbench.tsx` (component, CRUD debounce)

**Analog:** `src/lib/debouncedSave.ts` (the helper itself) + `src/components/HtmlVisualEditor.tsx` (existing correct unmount-flush) + `src/components/ScratchpadPane.tsx:454-461` (existing toast wiring to inherit)

**Target API to convert onto** (`src/lib/debouncedSave.ts:49-96`):
```typescript
export function createDebouncedSaver<T>(
  save: (value: T) => Promise<void> | void,
  delayMs: number,
  onError?: (error: unknown) => void,
): DebouncedSaver<T> {
  // schedule(value) resets the timer; flush() cancels the timer and drains
  // synchronously-on-call; cancel() drops the pending value with no save.
}
```
For Studio (which needs a per-schedule context snapshot, e.g. workPath), use the contextual variant instead:
```typescript
// src/lib/debouncedSave.ts:104-167
export function createContextualDebouncedSaver<T, C>(
  save: (value: T, context: C) => Promise<void> | void,
  delayMs: number,
  onError?: (error: unknown) => void,
  queue: SaveQueue = createSaveQueue(),
): ContextualDebouncedSaver<T, C>
```

**Current cancel-only anti-pattern to remove** (`ScratchpadPane.tsx:541-545`):
```typescript
useEffect(
  () => () => {
    clearAutoSaveTimer();   // <- cancel only, no flush: THE BUG
  },
  [clearAutoSaveTimer],
);
```
```typescript
// ScratchpadPane.tsx:566-574  -  the hand-rolled scheduler being replaced
const scheduleAutoSave = useCallback(() => {
  clearAutoSaveTimer();
  const scheduledWorkPath = workPath;
  autoSaveTimerRef.current = window.setTimeout(() => {
    autoSaveTimerRef.current = null;
    if (activeWorkPathRef.current !== scheduledWorkPath) return;
    void flushCurrent();
  }, 700);
}, [clearAutoSaveTimer, flushCurrent, workPath]);
```
Same shape for Studio (`StudioMode.tsx:261-269`, `saveTimerRef` cancel-only cleanup) and MeetingSourceWorkbench (`MeetingSourceWorkbench.tsx:247-250`, `return () => window.clearTimeout(timer);` with no flush call).

**Correct flush-on-unmount pattern to copy** (`HtmlVisualEditor.tsx:251-260`):
```typescript
useEffect(
  () => () => {
    // A pending debounced edit would otherwise be lost on unmount (tab
    // switch, document change)  -  flush it synchronously first.
    if (serializeTimerRef.current != null) {
      window.clearTimeout(serializeTimerRef.current);
      serializeTimerRef.current = null;
      serializeNowRef.current();
    }
  },
  [],
);
```
Replace with, once on `debouncedSave.ts`: `useEffect(() => () => { void saver.flush(); }, [saver]);`

**Error-toast pattern already present and to be inherited for free (D-07)** (`ScratchpadPane.tsx:454-461`, plus its import at `:65`):
```typescript
import { setError } from "../lib/errorStore";
// ...
.catch((error) => {
  const message = errorMessage(error);
  if (isRevisionConflict(error)) setConflict(true);
  setLocalError(message);
  setSaveState("error");
  setError(message);           // <- GLOBAL errorStore.setError, survives unmount
  return false;
});
```
Wire the new `createDebouncedSaver(save, delayMs, onError)`'s `onError` callback to `setError(...)` for Studio/Meeting/TodayBrainDump the same way, plus a `console.error`/log line (D-07's "same line goes to the log"  -  no existing log call was found on this path, add one).

---

### `src/lib/useDestructiveActionGuard.ts` (hook, request-response confirm/flush)

**Analog:** itself  -  extend in place, do not fork a parallel flow (keeps D-03 "one quit path" literal).

**Existing confirm+flush+close sequence to extend** (lines 60-82):
```typescript
const confirmDestructiveAction = useCallback(async () => {
  const action = pendingDestructiveAction;
  setPendingDestructiveAction(null);
  if (action === "relaunch") { await relaunchAfterSettingsFlush(); return; }
  if (action === "close") {
    try {
      await settingsSaverRef.current?.flush();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    closeConfirmedRef.current = true;
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      await getCurrentWindow().close();
    } catch (err) {
      closeConfirmedRef.current = false;
      setError(err instanceof Error ? err.message : String(err));
    }
  }
}, [pendingDestructiveAction, relaunchAfterSettingsFlush, settingsSaverRef]);
```
D-04/D-05 extension shape: wrap the flush step (not just `settingsSaverRef`  -  the full set of registered autosave flushers, per the `onRegisterFlush` pattern below) in a `Promise.race([Promise.all(flushes), timeout(3000)])`, start a 300ms timer that flips a `"saving"` indicator state, and on failure/timeout set a **new** `DestructiveAction` discriminant (e.g. `"quit-failed"`) instead of a parallel modal  -  per Open Question 2's own recommendation, to keep D-03 true at the UI layer.

**`onCloseRequested` handler to reuse as the single entry point for both close and Cmd+Q** (lines 98-155): Cmd+Q must resolve to the same `requestWindowClose()` (line 88-92) call rather than a second listener, per RESEARCH.md's Architecture Patterns diagram (App.tsx menu-command switch: `case "app.quit": requestWindowClose()`).

**Flush-registration pattern already established elsewhere for "let a parent flush a child's pending debounce"** (`TodayBrainDump.tsx`/`TodayPrepare.tsx`'s `onRegisterFlush: (flush: () => Promise<void>) => () => void` callback registration, per RESEARCH.md Don't-Hand-Roll table)  -  generalize this into a small registry the quit-flush step iterates, instead of a new pub/sub bus.

---

### `src-tauri/src/app_menu.rs` (config, native menu wiring)

**Analog:** itself  -  `insert_check_for_updates_item` (lines 259-267) and `remove_default_submenus` (lines 227-237), the existing default-submenu-surgery precedent.

```rust
// Source: src-tauri/src/app_menu.rs:227-237 [pattern: locate + remove by iterating menu.items()]
fn remove_default_submenus<R: Runtime>(menu: &Menu<R>, labels: &[&str]) -> tauri::Result<()> {
    for (index, item) in menu.items()?.into_iter().enumerate().rev() {
        if let MenuItemKind::Submenu(submenu) = item {
            let text = submenu.text()?;
            if labels.iter().any(|label| text == *label) {
                let _ = menu.remove_at(index)?;
            }
        }
    }
    Ok(())
}
```
```rust
// Source: src-tauri/src/app_menu.rs:259-267 [pattern: insert a custom MenuItem into
// the macOS App submenu at a known index  -  the same shape for the Quit replacement]
#[cfg(target_os = "macos")]
fn insert_check_for_updates_item<R: Runtime>(
    _app: &AppHandle<R>,
    menu: &Menu<R>,
    check_for_updates: &MenuItem<R>,
) -> tauri::Result<()> {
    if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
        app_menu.insert(check_for_updates, 1)?;
    }
    Ok(())
}
```
```rust
// Source: src-tauri/src/app_menu.rs:252-257 [command_item helper  -  reuse verbatim
// for MenuItem::with_id(app, "app.quit", "Quit Maru", true, Some("CmdOrCtrl+Q"))]
fn command_item<R: Runtime>(
    app: &AppHandle<R>,
    id: &str,
    text: &str,
    accelerator: Option<&str>,
) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, id, text, true, accelerator)
}
```
`handle_menu_event` needs no change  -  it already dispatches unrecognized ids through the generic `MENU_COMMAND_EVENT` path (per RESEARCH.md, `app_menu.rs:289-311`), the same path App.tsx's menu-command switch already consumes for `case "save":` etc. Add `case "app.quit": requestWindowClose()` there.

**Open risk (Assumption A1):** the native `PredefinedMenuItem::quit()`'s exact `MenuItemKind` discriminant for text-matching was not verified against a live build this session  -  spike this narrowly first (RESEARCH.md Open Questions #1) before committing to the full removal.

---

### `src-tauri/src/terminal/mod.rs` (service, event-driven kill escalation)

**Analog:** `src-tauri/src/command_output.rs::terminate_unix_process_group` (lines 542-568)  -  the only process-group-kill FFI idiom in the codebase; reuse the shape, not the call site.

```rust
// Source: src-tauri/src/command_output.rs:542-568 [VERIFIED, existing working code]
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
    if result == 0 { return Ok(()); }
    let group_error = io::Error::last_os_error();
    if process_not_found(&group_error) {
        return match child.try_wait()? {
            Some(_) => Ok(()),
            None => child.kill(),
        };
    }
    let _ = child.kill();
    Err(group_error)
}
```
For REL-01, parameterize the signal (1/SIGHUP, 15/SIGTERM, 9/SIGKILL) and drive it from a detached thread with the 2s/2s ladder (D-09), keyed on the pid captured at spawn (== pgid == sid, confirmed via `portable_pty`'s `setsid()` in `pre_exec`, RESEARCH.md Pattern 2). Do **not** hold the `session.killer` mutex across the sleeps.

**Bug site to fix  -  the wrong `ChildKiller` is stored** (`terminal/mod.rs:457-458`, spawn):
```rust
let mut child = pair.slave.spawn_command(cmd)
    .map_err(|err| format!("terminal_spawn_failed: {err}"))?;
let killer = child.clone_killer();   // <- ProcessSignaller: bare SIGHUP only, no retry
```
**Latch + kill call site to extend** (`terminal/mod.rs:857-870`):
```rust
if session.closing.swap(true, Ordering::AcqRel) {
    return Ok(());
}
let mut killer =
    crate::lock_recovery::recover_guard(session.killer.lock(), "terminal", "TERMINAL_KILLER");
if let Err(err) = killer.kill() {
    session.closing.store(false, Ordering::Release);
    return Err(format!("terminal_kill_failed: {err}"));
}
// Unregister on kill. `ChildKiller::kill` only raises SIGHUP on unix, so a
// child that traps it survives ... [this comment is the exact bug REL-01 fixes]
```
Add the escalation-thread spawn immediately after this existing `killer.kill()` call (keep the fast synchronous SIGHUP here; escalate in the background per D-09/D-10). D-11: one `warn`-level log line on any escalation beyond SIGHUP, in the same style as Phase 7 D-01 (see `07-CONTEXT.md` for that log-line convention).

**D-12 (quit-time cleanup):** iterate `TerminalState.sessions` (the same map `terminal_kill` reads) inside the `RunEvent::ExitRequested`/`Exit` arm in `lib.rs`, run a compressed SIGHUP→SIGTERM ladder against each live session's pgid, then SIGKILL any survivor immediately before exit  -  same FFI idiom, no new pattern.

---

### `src-tauri/src/lib.rs` (`run()`  -  RunEvent handler)

**Analog:** itself, existing `RunEvent::ExitRequested` handler (~line 641) that stops the Telegram poller.

Order matters per D-06: this handler only runs after the JS guard already let `window.close()` proceed (last-window-`Destroyed` triggers `ExitRequested`), so gating D-12's terminal cleanup here  -  rather than anywhere in the JS flush path  -  makes "a cancelled quit never kills terminals" true by construction, not by an extra check.

---

### `src-tauri/src/recovery.rs` (NEW, utility, file-I/O)

**Analog:** `src-tauri/src/atomic_file.rs::write_atomic` (signature below) + `src-tauri/src/paths.rs::ensure_within` for containment.

```rust
// Source: src-tauri/src/atomic_file.rs:750-756 [VERIFIED signatures]
pub(crate) fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String>;
pub(crate) fn write_atomic_private(path: &Path, content: &[u8]) -> Result<(), String>;
```
Internals (`atomic_file.rs:761-797`): `NamedTempFile` in the same parent dir, `write_all`, `sync_all`, then `temp.persist(path)`  -  copy this shape unchanged; `write_atomic` already creates the parent dir (`fs::create_dir_all(parent)`), so `.maru/recovery/` does not need pre-creation.

`.maru` dot-segment exclusion already covers the recovery dir for the document-index scan (`src-tauri/src/vault.rs:221-242`, `is_excluded_path`  -  any dot-prefixed top-level segment is excluded unless allow-listed); no scanner change needed. Use `paths::ensure_within` (per RESEARCH.md Security Domain, V5) to keep the recovery filename construction inside `.maru/recovery/`  -  never build the path directly from an unsanitized document name/path.

No existing analog for retention/cleanup policy exists in the codebase (D-08's "Claude's Discretion" note flags this)  -  cap by count or age; nothing currently prunes any `.maru/*` subdirectory, so this is new, small logic, not a pattern to copy.

---

### `src-tauri/src/jobs.rs` (REL-04, verify-only  -  no pattern needed)

**Analog:** itself. Existing tests already cover all three success-criterion components:
```rust
// Source: src-tauri/src/jobs.rs:1066-1100 [VERIFIED]
#[test]
fn env_value_expands_every_tilde_segment() {
    // ... asserts every segment absolute, colon-bearing non-path byte-identical,
    // single-path byte-identical  -  see 09-RESEARCH.md Code Examples for full body
}
```
Plus `plist_env_expands_colon_separated_tildes` (lines 1102-1123). No new test needed per D-13  -  only mark REL-04 complete in `REQUIREMENTS.md`'s traceability table.

## Shared Patterns

### Global toast on teardown-save failure (D-07)
**Source:** `src/lib/errorStore.ts` (module-level `setError`/`useSyncExternalStore`), consumed today at `src/components/ScratchpadPane.tsx:454-461`
**Apply to:** every converted autosave surface's `onError` callback (Studio, TodayBrainDump, MeetingSourceWorkbench) and the quit-flush failure path in `useDestructiveActionGuard.ts`
```typescript
import { setError } from "../lib/errorStore";
// on failure:
setError(message);  // survives the pane unmounting
```

### Process-group signal via raw FFI (D-09, D-12)
**Source:** `src-tauri/src/command_output.rs:542-568` (`terminate_unix_process_group`)
**Apply to:** `terminal/mod.rs`'s new escalation thread (per-tab kill) and the quit-time sweep in `lib.rs`'s `RunEvent::ExitRequested` handler. Same `extern "C" { fn kill(pid: i32, signal: i32) -> i32; }` declaration, parameterized by signal instead of hardcoded `SIGKILL`; always target `-pid` (negated pgid), never a bare pid.

### Debounced-saver conversion (D-01)
**Source:** `src/lib/debouncedSave.ts` (`createDebouncedSaver`/`createContextualDebouncedSaver`), reference-correct consumer `src/components/HtmlVisualEditor.tsx:242-260`
**Apply to:** `ScratchpadPane.tsx`, `StudioMode.tsx`, `TodayBrainDump.tsx`, `MeetingSourceWorkbench.tsx`  -  replace every hand-rolled `window.setTimeout` + cancel-only unmount cleanup with `schedule`/`flush()`-on-unmount.

### Atomic file write for recovery copies (D-08)
**Source:** `src-tauri/src/atomic_file.rs::write_atomic` + `src-tauri/src/paths.rs::ensure_within`
**Apply to:** the new `recovery.rs` helper only; no other file needs this.

## No Analog Found

None. Every file in scope has a direct, working, already-tested in-repo analog (per RESEARCH.md's "Don't Hand-Roll" table and Key Insight); the phase is scoped as "wire the Nth caller onto an existing thing" plus one narrow, previously-undiagnosed bug fix (the wrong `ChildKiller` stored)  -  not new abstractions. The one genuinely new file, `src-tauri/src/recovery.rs`, is a thin wrapper composed entirely from two existing primitives (`write_atomic`, `ensure_within`) with no analog needed beyond those.

## Metadata

**Analog search scope:** `src/lib/`, `src/components/{ScratchpadPane,studio,today,meetings,HtmlVisualEditor}.tsx`, `src-tauri/src/{terminal,command_output,atomic_file,paths,vault,app_menu,lib,jobs}.rs`
**Files scanned:** 12 target files + 8 analog source files (all read in full or via targeted non-overlapping ranges during pattern mapping; RESEARCH.md had already done the exhaustive `grep`-driven inventory, this pass re-verified line ranges and extracted excerpts)
**Pattern extraction date:** 2026-09-25
