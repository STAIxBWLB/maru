# Pitfalls Research: Maru v1.1 "Felt Quality and Native Proof"

**Domain:** Adding reliability/perf/security/native-verification hardening to a
shipped, signed Tauri 2.10 + React 19 + Rust desktop app, without regressing its
existing invariants.
**Researched:** 2026-08-28
**Confidence:** HIGH for claims grounded in this repo's own code (cited by path);
MEDIUM for Tauri/React/Vite runtime-semantics claims cross-checked against current
docs and community sources this session; LOW is called out explicitly wherever a
claim could not be verified against primary docs (macOS native-automation tooling
is the main LOW-confidence area - see Pitfall 18-21 and Sources).

This is not a generic "Tauri gotchas" document. Every pitfall below is anchored to
a specific file/line in this repo, the specific work item it threatens (PERF-01..04,
REL-01, SEC-01/02, TEST-01/02, or the CSS split), and what a reviewer can concretely
check for.

---

## Critical Pitfalls

### Cluster A - PERF-01: moving 37 sync commands off the main thread

#### Pitfall 1: The single fact that makes this migration dangerous

**What goes wrong:**
Today, 217 of 356 commands are plain `#[tauri::command] fn` - Tauri runs every one
of them serialized on the main thread's event loop. That means two commands that
both touch, say, `state.sessions.lock()` or `REGISTRY_LOCK` have never actually
raced: whichever command's synchronous body runs, runs to completion before the
next one starts, because there was only ever one thread to run them on. The
instant any of the 37 commands become `async fn` or `#[tauri::command(async)]`,
Tauri schedules their bodies onto its async runtime's worker-thread pool, and two
commands invoked back-to-back from the frontend can now genuinely execute
concurrently. Any lock that was "never contended" only because nothing else could
run at the same time is now a real contention point, and any UI code that issued
command A then command B assuming A's filesystem write had landed before B ran
(because that was true under serial main-thread execution) can now observe B
racing ahead of A.

**Why it happens:**
The migration is framed (correctly) as "move IO off the main thread," which reads
as a pure performance change. It is also a concurrency-model change: single-
threaded cooperative execution becomes genuine multi-threaded execution. Nothing
in the command signature communicates that shift to a reviewer.

**How to avoid:**
For each of the 37 commands, before converting, ask: "does the frontend ever fire
this command and a sibling command close together, relying on ordering?" - check
the calling component for two `invoke`/`api.ts` wrapper calls in the same handler
or in a `.then()` chain. `src-tauri/src/skill_host/store.rs`'s
`skills_list_sources`/`skills_add_source`/`skills_remove_source` trio is the
highest-risk group precisely because they all touch the same `REGISTRY_LOCK` and
are exactly the commands PERF-01 and PERF-02 both touch in the same phase.

**Warning signs:**
A frontend caller that does `await addSource(...)` then immediately
`await listSources()` and asserts on the freshly-added entry being present - this
pattern already implicitly depends on serial execution and needs a re-read on the
lock/generation-check semantics on the Rust side, not just a "does it still
typecheck" check.

**Phase to address:**
The phase owning PERF-01, before any command is actually converted - this is a
design-review question per command, not a follow-up bug.

---

#### Pitfall 2: `async fn` is not `spawn_blocking` - a "converted" command can still starve everything else

**What goes wrong:**
Tauri's plain `async fn` command runs on `async_runtime::spawn` - the same
cooperative-scheduling worker-thread pool every other async command and Tauri's
own IPC plumbing runs on. If the converted command still does a synchronous
`WalkDir`, `read_dir`, or `Child::wait()` call directly inside that `async fn`
body (i.e. the "cheap" conversion - add `async`, change nothing else), that
worker thread is blocked exactly as before; it just moved which thread freezes.
With a small worker pool (commonly sized to CPU core count), a handful of these
"async-in-name-only" commands running concurrently can exhaust the pool and stall
every other in-flight IPC command - including ones that have nothing to do with
the slow one. This reproduces the UI-freeze bug class one layer down, in a place
that is much harder to notice because the main thread itself stays responsive.

**Why it happens:**
`#[tauri::command(async)]` on a *non-async* fn and a hand-written `async fn` look
almost identical in a diff, but only the former routes through Tauri's blocking-
capable execution path; a plain `async fn` that never actually awaits anything is,
operationally, a blocking function pretending to be async.

**How to avoid:**
For every one of the 37 commands, the conversion must be either (a) a genuine
`async fn` that performs its blocking work inside an explicit
`tauri::async_runtime::spawn_blocking(move || { ... })` and `.await`s the join
handle, or (b) `#[tauri::command(async)]` left on the existing synchronous fn body
unchanged (Tauri's own dispatcher runs that path via its blocking pool). Do not
add `async` to the fn signature and leave the blocking call inline as the entire
fix - `skills_env_bootstrap` (`src-tauri/src/skill_host/env.rs`) already shows the
project's own correct pattern (invocation-id + `thread::spawn` + event streaming)
for anything with visible duration; reuse it rather than reinventing per-command.

**Warning signs:**
None visible to the user or to `make verify` - the UI stops freezing (main thread
is free), so the naive fix looks like it worked. The only way to catch this is
deliberately: fire several of the converted commands concurrently (e.g. two
`today_calendar_commitments`-shaped calls plus an unrelated command) and check
whether the unrelated command's latency degrades. **This is the most dangerous
pitfall in the whole migration because there is no passive warning sign - it must
be actively tested for.**

**Phase to address:**
The phase owning PERF-01. Bake a concurrent-invocation timing assertion into that
phase's verification, not just a "command no longer blocks main thread" check.

---

#### Pitfall 3: compile-time-safe vs. runtime-only failure modes - know which is which

| Failure | Caught by | Why |
|---|---|---|
| `std::sync::MutexGuard` held across an `.await` point | **Compile time** (`E0277`, guard is not `Send`) | The compiler enforces `Send` for anything alive across an await suspension point. |
| Swapping `std::sync::Mutex` → `tokio::sync::Mutex` to fix the above, silently removing panic-poisoning | **Runtime only** | Both types compile; `tokio::sync::Mutex` never poisons on a panicking holder, so a bug that used to surface as `*_poisoned` (loud, PERF-03's whole subject) now surfaces as silent, possibly-corrupt state with no error path at all. This directly undermines PERF-03 if it lands after a command has already switched primitives. |
| `IpcError { code, message }` accidentally flattened to `Result<T, String>` via `.map_err(\|e\| e.to_string())` mid-conversion | **Runtime only** | `ipc_error.rs`'s own `From<String>` impl sets `code: String::new()` - the frontend union match on `code` (e.g. `document_conflict`) silently falls through to the generic toast path instead of the inline conflict banner. `tsc -b` and `pnpm typecheck` both pass; only an e2e assertion on the specific code catches it, and `e2e/smoke.spec.ts` today asserts on the literal string, not a generic contract check. |
| Two previously-serial commands now interleaving (Pitfall 1) | **Runtime only, and usually only under load/timing** | No type system encodes "these two commands must not race"; it is only visible as a flaky failure the exact width of the race window. |
| Calling a command through `State<'_, T>` after the state's `Arc` internals changed shape (e.g. new field added without updating `Default`) | **Compile time** | Standard Rust field-exhaustiveness / `Default` derive checks catch this. |
| Re-entrancy: a lock acquired inside an async command's body, released, then re-acquired later in the same call - is fine single-threaded, but once concurrent, the second acquire can now block on a different, unrelated caller | **Runtime only** | The `resize_lock` / `model` two-lock pattern in `terminal/mod.rs:826-856` (already carefully commented - "Hold the model lock across the ioctl") is the template for getting this right; any newly-async command that copies a "lock, unlock, do work, lock again" shape without that same reasoning risks a TOCTOU window that was previously impossible. |

**Phase to address:** PERF-01. Use this table directly as a plan-review checklist per converted command.

---

### Cluster B - PERF-02: narrowing `REGISTRY_LOCK` around the network pull

#### Pitfall 4: releasing the lock introduces the exact TOCTOU window the lock existed to prevent

**What goes wrong:**
The prescribed fix - "read the source record under the lock, release, perform the
network sync, then re-acquire to write" (`src-tauri/src/skill_host/store.rs:566-597`)
 - opens a window between read and re-acquired-write where a concurrent
`skills_remove_source` or `skills_add_source` (themselves migrating under PERF-01,
see Pitfall 1) can mutate or delete the same source. A naive re-acquire-and-write
back the synced result silently resurrects a source the user just removed, or
clobbers an edit made mid-sync.

**Why it happens:**
"Narrow the critical section" is correct advice for the freeze problem and
incomplete advice for correctness - it trades a liveness bug for a
consistency bug unless the re-acquired write re-validates identity.

**How to avoid:**
On re-acquire, check the record is still present and still matches the identity
read before the network call (existence + a revision/generation marker), and no-op
(or surface a conflict) if not - the same shape as `terminal/mod.rs`'s
`Arc::ptr_eq`-guarded session removal after its own network-adjacent (child-exit)
wait completes. Do not write back unconditionally.

**Warning signs:**
A test that removes a source while its sync is in flight and asserts the source
stays removed after the sync resolves. Absent such a test, this bug is invisible
until a user hits the exact race in production.

**Phase to address:** The phase owning PERF-02, alongside PERF-01 since both touch
the same lock and same command trio.

---

### Cluster C - PERF-03: `into_inner()` poisoning recovery

#### Pitfall 5: `into_inner()` is correct for re-derivable state and silently wrong for invariant-bearing in-memory state

**What goes wrong:**
`PoisonError::into_inner()` returns the guard as if nothing happened - it does
**not** repair or validate whatever the panicking thread left behind. For state
that's just a cache of on-disk truth (the terminal wake mutex in
`terminal/mod.rs:199-205`, whose own comment explains the recovery is safe because
losing a notification only delays a repaint), recovering is free: the next read
re-derives correct data from disk or the next signal fixes the delay. For state
whose only source of truth *is* the in-memory structure - a `HashMap` mid-`insert`
when the panic hit, a counter that's the sole authority for "next id," or a
multi-field struct where two fields must stay in lockstep - a panic between two
writes leaves the guard pointing at *structurally valid, semantically wrong* data,
and `into_inner()` hands that data straight back to the next caller with no
signal anything is wrong. The bug class this produces is worse than the poisoning
error it replaces: today a poisoned `REGISTRY_LOCK` bricks the feature loudly;
after a blanket `into_inner()` pass, the same panic could instead let the feature
keep running on quietly corrupt data.

**Why it happens:**
The existing idiom in this codebase (`skill_host/fs.rs:155`,
`terminal/mod.rs:203`) is real and correct for its two current uses, which makes it
tempting to copy-paste across all six target mutexes (`REGISTRY_LOCK`,
`terminal_registry`/`terminal_killer`, `JOBS_LOCK`, `DOT_ACTION_LOCK`,
`BINDER_WRITE_LOCK`) without re-deriving the argument for each one.

**How to avoid:**
For each of the six, answer explicitly: *if a panic happened at the worst possible
line inside this critical section, is the guarded data re-readable/re-derivable
from disk or another authoritative source, or is the in-memory structure itself
the only record?* `BINDER_WRITE_LOCK` (`evidence_binder.rs:19`) is the one most
worth scrutinizing - it gates a multi-step revision-checked write path, not a
pure cache. `DOT_ACTION_LOCK` similarly guards an action sequence, not a read-only
mirror. Where the answer is "in-memory is authoritative," recovery should
reconstruct/reset the structure to a known-good empty/re-scanned state rather than
calling `into_inner()` on the raw guard, or should keep returning the poisoned
error and force an explicit re-init path.

**Warning signs (how to tell in review):**
Grep the guarded type's methods for any multi-statement critical section that does
more than one logically-atomic mutation (two `.insert()`s, a check-then-write,
increment-then-use) - a panic between those statements is exactly what
poisoning exists to flag. A guard type whose only operations are single-statement
reads/writes of otherwise-immutable data is the safe case.

**Phase to address:** The phase owning PERF-03. This is not a mechanical "apply
the fs.rs idiom six times" task - each of the six needs its own one-line
justification in the PR, not a shared one.

---

### Cluster D - PERF-04: prune list on recursive watchers

#### Pitfall 6: filtering `relevant_path` reduces event volume, not the number of OS watch handles

**What goes wrong:**
Adding `GENERATED_DIRS` to the `relevant_path` predicates in `vault_watcher.rs`,
`inbox_watcher.rs`, `scratchpad_watcher.rs`, and `ops_catalog/watcher.rs` filters
*events after they've already been delivered* by the OS filesystem-notification
backend (inotify/FSEvents/kqueue). `ops_catalog/watcher.rs`'s
`register_bu_watch_paths` registers a **separate recursive watch per
business-unit directory**, which is a different resource: the count of live watch
descriptors, which grows with project count regardless of what
`relevant_path` filters out afterward. On Linux, inotify has a per-user watch
descriptor ceiling (commonly a few thousand by default); prune-list filtering
does nothing to that ceiling.

**Why it happens:**
"Add a prune list" reads as one fix, but the four watchers actually have two
different scaling problems - event volume (fixed by filtering) and watch-handle
count (not fixed by filtering) - and CONCERNS.md's own text calls out the second
one specifically for `ops_catalog/watcher.rs` without necessarily implying the
fourth watcher needs a structurally different fix than the other three.

**How to avoid:**
Apply the `GENERATED_DIRS` filter to all four as planned (real win for events),
but treat `ops_catalog/watcher.rs`'s per-business-unit registration as a second,
separate question: does the number of registered watches for large project counts
approach the OS ceiling, and if so, does it need consolidation (one recursive
watch at a shared parent, filtered) rather than N per-directory watches. Don't let
the same commit message cover both without measuring both.

**Warning signs:**
No test or metric asserts on watch-descriptor count. A workspace with many
business units (10s-100s of BU directories) approaching the platform's watch
ceiling would fail as `inotify_add_watch: No space left on device` or silently
stop delivering events for the overflow directories - neither of which is exercised
by CI (single-workspace fixtures).

**Phase to address:** PERF-04. If watch-handle consolidation is out of scope for
this milestone, say so explicitly rather than letting the prune-list fix imply the
whole class of problem is closed.

---

### Cluster E - REL-01: PTY SIGHUP → process-group SIGKILL escalation

#### Pitfall 7: the existing SIGKILL-pgid helper is not directly reusable - it targets `std::process::Child`, not `portable_pty`'s

**What goes wrong:**
`command_output.rs:543` (`terminate_unix_process_group`) and its
`ProcessTree`/`configure_process_tree` scaffolding operate on
`std::process::Command`/`Child` and were written for the general subprocess
runner, not the PTY path. `terminal/mod.rs`'s child is spawned via
`portable_pty::CommandBuilder`/`pair.slave.spawn_command(cmd)`, and its only
kill surface is `ChildKiller` (`child.clone_killer()`), a portable-pty
abstraction whose Unix impl currently only raises SIGHUP (that's the entire bug
being fixed). Escalating requires either (a) portable_pty exposing the raw pid to
build a group-kill on top of `ChildKiller`, or (b) setting a process group
explicitly at spawn time via whatever `CommandBuilder` exposes for that - and
portable_pty's own PTY spawn already calls `setsid()`/creates a new session for
controlling-terminal semantics, so an explicit `process_group(0)` call (the
pattern copied from `command_output.rs:404`) may be redundant with, or conflict
with, what the PTY spawn already does. This needs to be verified against
portable_pty's actual spawn implementation before assuming the
`command_output.rs` pattern ports over unchanged.

**Why it happens:**
Both code paths solve "kill a process tree" and sit a few hundred lines apart in
the same crate, which makes them look like the same problem with an existing
solution to copy. The PTY's controlling-terminal role (it's not just a subprocess,
it's the session leader for an interactive shell) is the difference that matters.

**How to avoid:**
Read portable_pty's Unix PTY-spawn source (or its docs) for exactly what session/
group setup it performs before assuming `process_group(0)` is needed or safe to
add. If portable_pty's own spawn already makes the child its own process-group
leader (typical for PTY slaves), the escalation may only need "send SIGKILL to
`-child_pid`" without any additional `process_group(0)` call at spawn.

**Warning signs:**
A `kill(-pgid, SIGKILL)` call that returns `ESRCH` unexpectedly in testing (no such
process group) is the signal that the assumed group setup doesn't match reality - 
check this in the phase's own manual macOS/Linux verification, since CI never
exercises PTY spawn depth this way (`ubuntu-22.04` runs the mocked-IPC e2e suite).

**Phase to address:** REL-01's owning phase, as the first design question, before
writing the kill escalation code.

---

#### Pitfall 8: group-kill regresses the documented "backgrounded grandchild survives" behavior

**What goes wrong:**
The exit-thread comment in `terminal_spawn` (`terminal/mod.rs:481-484`) explicitly
accounts for and preserves a case where a user runs `sleep 60 &` then exits the
shell - the grandchild inherits the PTY slave and is allowed to keep running past
the parent's death; the code even structures cleanup (unregister-before-join) to
not get stuck waiting on it. A blanket "on kill, SIGKILL the whole process group"
change kills that same detached grandchild that today's SIGHUP-only path (and this
comment) deliberately lets survive. If REL-01 is read as "always escalate to group
SIGKILL," it silently reverses a documented, deliberate design decision in the same
file, for every session, not just the ones that trap SIGHUP.

**Why it happens:**
The feature request ("a PTY child that traps SIGHUP can still be killed") is about
the *shell/process the user explicitly asked to close*, not about every process
the shell happens to have started - but "escalate to group SIGKILL" as a blanket
replacement doesn't distinguish the two.

**How to avoid:**
Escalation should be a **fallback**, not a first resort: send SIGHUP first (today's
behavior, preserves the survives-past-shell-exit case for well-behaved detached
children), then only if the session fails to exit within a bounded timeout,
escalate to group SIGKILL. This preserves the common case (shell exits promptly on
SIGHUP, detached grandchildren survive as documented) and only forcibly kills
everything in the rarer case a SIGHUP-trapping process is actually stuck.

**Warning signs:**
A test (or manual check) that backgrounds a long-running process in a Maru
terminal, closes the tab immediately, and checks whether the backgrounded process
is still running a few seconds later - if REL-01 lands as a blanket change, this
regresses silently (no error, no test currently covers "process I backgrounded
survives tab close" as a positive assertion, only the SIGHUP-trap survival case is
documented as a bug to fix).

**Phase to address:** REL-01's owning phase; make "timeout-gated fallback, not
blanket replacement" an explicit acceptance criterion.

---

#### Pitfall 9: pid/pgid reuse race between "already reaped" and "signal sent"

**What goes wrong:**
The escalation targets a pgid captured at spawn time (mirroring
`command_output.rs`'s `process_group_id: child.id()`). If the PTY child has
already exited and been reaped by its own exit thread
(`terminal/mod.rs:478-495`, which already runs concurrently with `terminal_kill`)
by the time the escalation fires, the OS is free to recycle that pid - and on a
busy system, a freshly-spawned unrelated process can be assigned the exact same
pid/pgid before the delayed SIGKILL lands, killing a stranger.

**Why it happens:**
The existing `session.closing` latch and generation check protect against a stale
*frontend handle* re-entering `terminal_kill`, but they don't protect the *pgid
value itself* from going stale between "read it" and "signal it" if escalation is
implemented as a delayed/retried operation rather than inline with the initial
kill call.

**How to avoid:**
Follow `terminate_unix_process_group`'s own shape exactly: attempt the kill,
and only fall back further if the OS reports `ESRCH` (process/group not found,
i.e. `process_not_found`) - which `command_output.rs:559-563` already treats as
"already gone, this is fine" rather than an error to retry against a possibly-
reused pid. Do not implement the timeout-then-escalate fallback (Pitfall 8) as a
separately-scheduled delayed action that re-reads or re-derives the pgid later;
compute it once, act on the same value, and treat `ESRCH` as success.

**Warning signs:**
Any code path that stores a raw pid/pgid in a place that outlives the session
object it came from (a scheduled timer callback capturing just the integer,
rather than the `Arc<TerminalSession>`) is the shape of bug to look for in review.

**Phase to address:** REL-01's owning phase, same PR as Pitfall 8's fallback design.

---

#### Pitfall 10: Windows must not be touched - ConPTY already kills forcefully, no SIGHUP concept exists

**What goes wrong:**
`command_output.rs` already shows the project's pattern for this exact
platform split: Unix gets `process_group(0)` + `kill(-pgid, SIGKILL)`, Windows
gets a Job Object (`windows_job::Job`) whose `terminate()` already forcibly kills
the whole tree - there is no SIGHUP-trapping equivalent on Windows because
Windows has no POSIX signal delivery to a ConPTY-hosted process; `TerminateProcess`
is already forceful. If REL-01 is implemented as one shared cross-platform
function (rather than `#[cfg(unix)]`-gated, matching the existing split), it risks
either doing nothing on Windows (fine but wasted code) or, worse, trying to invent
a Windows "escalation" that doesn't map to anything real and destabilizing the
Windows PTY-kill path that isn't broken today.

**Why it happens:**
REL-01 is framed as "process-group escalation" in the abstract, inviting a single
cross-platform implementation, when the actual bug (SIGHUP-trapping child) and its
fix are Unix-only concepts.

**How to avoid:**
Gate the new escalation code behind `#[cfg(unix)]`, matching
`command_output.rs`'s existing split exactly, and leave the Windows PTY-kill path
untouched. Confirm in review that no Windows-reachable code path changed.

**Warning signs:**
A diff that touches `#[cfg(windows)]` code, or a new shared helper function with
no `#[cfg]` split, in the REL-01 PR is the signal to stop and re-derive why.

**Phase to address:** REL-01's owning phase. This is also a direct instance of the
milestone's own hard constraint ("must not break Windows") - call it out in that
phase's verification explicitly, not just trust the Unix-only framing to hold.

---

### Cluster F - Scratchpad autosave flush on unmount

#### Pitfall 11: StrictMode's synthetic mount→unmount→remount can trigger a real flush in dev, at the wrong moment

**What goes wrong:**
The current cleanup effect (`ScratchpadPane.tsx:541-546`) only clears a timer - a
no-op-safe operation to double-invoke. The moment cleanup instead calls
`flushCurrent()` (an async function that awaits `saveInFlightRef.current`, then
calls `saveScratchpadDocument`), React 19's development-only StrictMode
mount→unmount→remount sequence fires that flush as a side effect of every
component mount, not just genuine unmounts. If the synthetic unmount's flush
races the remount's own setup effect
(`ScratchpadPane.tsx:474-479`, which calls `loadEditor(null)` and re-reads the
recovery draft), the flush could run against a `editorRef.current` that's either
stale (about to be reset by the immediately-following remount) or, if the ref
already got cleared by an earlier cleanup ordering quirk, a no-op that masks
whether the real flush logic even executes.

**Why it happens:**
StrictMode's guarantee is "every effect's cleanup must be safe to run and have
the effect re-run afterward" - that guarantee was cheap to uphold when cleanup was
just `clearTimeout`. Adding a stateful async write to cleanup changes what "safe to
run twice, back to back, in dev" means, and nothing forces re-deriving that
argument when the cleanup body changes.

**How to avoid:**
Guard the flush so it only does work when there is an actual dirty document
(`dirtyRef.current`) and a real `editorRef.current` - which the existing
`flushCurrent` implementation already checks (`if (!dirtyRef.current && !force...)
return true;`), so the risk is lower than it looks *if* `flushCurrent` itself is
reused unchanged. The thing to verify specifically: run the app in dev with
StrictMode (Vite dev, not just production build) and confirm opening/closing
Scratchpad rapidly does not double-fire `saveScratchpadDocument` for the same
unchanged content, and does not race the remount's `loadEditor(null)` reset.

**Warning signs:**
An extra `today_conflict`/`document_conflict`-shaped revision-conflict flash in
dev-only testing that doesn't reproduce in the production build - StrictMode-only
symptoms are exactly this pattern (present in `pnpm dev`, absent in
`pnpm build && tauri dev` or the packaged app) and are easy to dismiss as "dev
noise" when they're actually exposing a real double-flush race.

**Phase to address:** The phase owning the Scratchpad flush-on-unmount work. Add a
StrictMode-enabled dev-mode manual check to that phase's verification list
explicitly - `make verify`'s e2e suite runs against a Vite dev server but nothing
confirms whether StrictMode is active for it.

---

#### Pitfall 12: a cleanup function cannot await, so "flushes before unmount" is only as strong as fire-and-forget

**What goes wrong:**
`useEffect`'s cleanup return value is a synchronous function; React does not wait
for a promise it returns. `return () => { void flushCurrent(); }` starts the save
but does not block React's teardown, does not block a pane switch from completing,
and - critically - does not block a Tauri window-close event, which is a *different*
lifecycle than a React component unmounting a pane. The 700ms-loss window described
in CONCERNS.md ("Switch modes, close the pane, or change workspace within 700ms of
the last keystroke") conflates two distinct trigger paths: (1) switching
modes/panes inside the running app, where React unmount cleanup genuinely does
apply and has time to complete because the app keeps running, and (2) the user
quitting the app entirely, where a fire-and-forget promise from a React cleanup has
no guarantee of completing before the process exits - that needs a Tauri
`onCloseRequested`/`beforeunload`-level handler that is *awaited* before the window
is allowed to close, which is a different mechanism than "flush on unmount."

**Why it happens:**
"Flush on unmount instead of only clearing the timer" (the requirement's own
phrasing) reads as a single fix, but the underlying risk spans two lifecycles that
need two different guarantees - a React effect cleanup can address the pane-switch
case adequately (the app stays alive long enough for a fire-and-forget promise to
usually complete) but cannot, by construction, guarantee anything about the
app-quit case.

**How to avoid:**
Confirm explicitly which of the two trigger paths this work item is scoped to. If
app-quit is in scope (CONCERNS.md's phrasing - "close the pane" - suggests both are
plausible reads), it needs a separate, awaited handler on the window-close event
that calls `flushCurrent({ force: true })` and blocks the close until it settles or
times out, not just the `useEffect` cleanup. If only the pane-switch/mode-change
case is in scope, say so in the plan and verify the app-quit case remains an
accepted gap rather than silently assuming the unmount fix covers it.

**Warning signs:**
A verification step that only tests "switch away from Scratchpad within 700ms of
typing, then switch back - content is saved" would pass with an unmount-only fix
and give false confidence about the app-quit case, which needs a distinct test
(type, then quit the app via Cmd+Q / window close within 700ms, relaunch, confirm
no data loss).

**Phase to address:** The phase owning the Scratchpad flush. Scope this explicitly
in the plan before implementation, since the fix shape differs by scope.

---

#### Pitfall 13: a failed unmount-flush has no detectable warning sign today - flag this explicitly

**What goes wrong:**
`flushCurrent`'s failure path calls `setLocalError`/`setError` - both are React
state setters (component-local `useState` and the module-level `errorStore`
respectively). A state update issued from a cleanup function that's running as
part of (or after) the owning component's unmount either updates a store that no
component is currently rendering to show the toast (if the user has already
navigated to a different mode that also renders `errorStore`, this might surface,
but if the whole app is mid-teardown at quit time, nothing is listening), or is
simply lost. `persistDraft`'s localStorage safety net is only invoked from
`updateContent` (line 583), not from the unmount cleanup path - so if the
unmount-triggered flush itself fails, neither the backend save (that's the
failure) nor the localStorage fallback (that path was never re-triggered) has the
content, and the only remaining record is whatever localStorage state
`updateContent` last wrote *before* the flush was scheduled, which per the
existing bug description is exactly the up-to-700ms-stale draft this whole work
item exists to stop relying on.

**Why it happens:**
Every other save-failure path in this component is reached from a user-initiated
action (`openEntry`, `renameCurrent`, `trashCurrent`, ...) where a subsequent
render can show the toast. Unmount is definitionally the one path where "show the
user an error" doesn't have a reliable place to render, and nothing in the fix as
scoped ("flush on unmount") addresses what happens if that flush fails.

**How to avoid:**
Treat this as the residual known gap rather than something the unmount fix
resolves for free: log the failure (a case where a `console.error` - otherwise
avoided in this codebase per conventions - is legitimate, since there is no other
observer), and consider re-persisting the draft to localStorage from the flush's
own catch path specifically (not just relying on the last `updateContent`-time
write) as a second-chance recovery source the next mount's `readScratchpadDraft`
can pick up.

**Warning signs:**
**There is no detectable warning sign in the current design** - this is exactly
the kind of pitfall worth flagging as-is rather than papering over: a silent
failure during teardown produces no toast, no log (today), and no test failure,
only a user who reopens Scratchpad later and finds their edit missing with no
indication why. If the phase plan doesn't explicitly decide "we accept this
residual gap" or "we add a console.error + re-persisted draft as the second-chance
path," it will ship invisible either way.

**Phase to address:** The phase owning the Scratchpad flush. This should be an
explicit, named decision in that phase's plan, not an implicit byproduct.

---

### Cluster G - SEC-01: auditing/removing `script-src blob:`

#### Pitfall 14: a source grep proves absence in this repo's code, not absence in the packaged runtime

**What goes wrong:**
A grep for script-from-blob patterns (`new Blob([code])` + `createObjectURL`,
`document.createElement("script")` with a blob `src`, or a worker constructed
from a stringified blob rather than `new Worker(new URL(...), { type: "module"
})`) finds no hits in `src/` or the direct dependency source trees checked this
session (no `pdfjs-dist`/`comlink`/similar deps in `package.json`; the one worker
in the app, `GraphInsightsPanel.tsx:43`, already uses the URL-based module-worker
form that `worker-src blob:` - declared separately and left alone - covers, not
`script-src`). That is evidence the *currently-visible* code doesn't need it, not
proof the *built, packaged* app doesn't need it: Vite's production output can
introduce blob-URL script loading through mechanisms invisible to a source grep
(a legacy/polyfill plugin, a future transitive dependency, or Tauri's own
CSP-hash injection step for `index.html`'s bundled `<script>` tags, which behaves
differently for the `frontendDist` asset-protocol build than for the `pnpm dev`
server). Testing the removal only against `pnpm tauri dev` is not evidence it's
safe in the shipped `.app` - dev serves through a different CSP posture (Vite's
HMR/error-overlay client injects its own scripts) than the bundled build.

**Why it happens:**
A clean grep result reads as "confirmed unused," which is a much stronger claim
than what a source-level, single-repo-snapshot grep can actually support, given
that packaged-build-only code generation is exactly the class of thing a grep
can't see.

**How to avoid:**
Do the grep first (cheap, and it did come back clean), then verify by building the
actual signed/notarized (or at minimum the release-mode) bundle with `script-src
blob:` removed and manually exercising every surface that creates blobs/workers
today: the graph worker and its insight panel, diagram export
(`src/lib/diagram/export.ts`), graph export (`src/lib/graph/export.ts`), clipboard
(`src/lib/clipboard.ts`), and the diagram import/export dialog - none of these
*should* need `script-src` specifically (they create data/image blobs, which live
under `img-src`/`connect-src`'s already-present `blob:`, not `script-src`), but
"should" is exactly the claim this pitfall is about not trusting from source
inspection alone.

**Warning signs:**
None visible without deliberately opening devtools in the packaged app and
watching for a CSP violation report - Maru ships to end users without devtools
open, so a CSP-blocked script load in production manifests only as "this one
button/feature quietly does nothing," not a crash, not a console message anyone
will see, not a `make verify` failure (nothing in the test suite asserts on CSP
today).

**Phase to address:** The phase owning SEC-01. Route the actual verification
through the native E2E runner (TEST-01) once it exists, or through a documented
manual pass over the packaged `.app` exercising every worker/export/blob code
path - not through the grep alone, and not through dev-server testing alone.

**Phase to address:** SEC-01's owning phase.

---

### Cluster H - SEC-02: the `dangerouslySetInnerHTML` → DOMPurify grep guard

#### Pitfall 15: a syntactic grep guard has a known, already-documented legitimate exception it will false-positive on

**What goes wrong:**
`EditorPane.tsx`'s `decoratePreviewHtml` (`:165-216`) and its neighboring
`previewMarkup` memo (`:479-486`) constitute an already-audited, hand-documented
case where the HTML reaching `dangerouslySetInnerHTML` is *not* itself a fresh
DOMPurify call at that exact call site - it's DOMPurify-sanitized markdown with
marks folded in via `createElement`/`textContent`/`dataset` only (the module's own
comment states the invariant that makes this safe). A grep guard specified as "every
`dangerouslySetInnerHTML` value traces to a DOMPurify-backed helper" needs to
either special-case this site by name (matching the shape of
`check-select-chrome.mjs`'s existing subject-specific allowlisting) or it will
flag a known-safe, deliberately-designed site as a violation - at which point the
easiest "fix" available to whoever hits that CI failure is to wrap the value in a
trivial passthrough that satisfies the regex (`const safe = dompurify.sanitize
(value)` immediately followed by using the *original* `value` anyway, or a
same-named local variable one hop removed from the real call), which defeats the
guard's entire purpose while making it pass.

**Why it happens:**
A regex/grep guard checks for the *presence* of a DOMPurify-shaped identifier
somewhere upstream of the sink, not that the identifier's output is what's actually
rendered - it cannot distinguish "this value truly came from that call" from
"this value merely has that call somewhere nearby in the file."

**How to avoid:**
Design the guard with an explicit allowlist mechanism from day one (not added
reactively after the first false positive), scoped to `EditorPane.tsx`'s
`decoratePreviewHtml`/`previewMarkup` pair with the existing invariant comment as
its justification, and require every *other* site to show a direct, traceable
call. Pattern-match `check-select-chrome.mjs`'s approach (subject + exception list)
rather than inventing a new shape.

**Warning signs:**
The guard shipping with zero allowlist entries and Phase verification not
including a deliberate-break test (add a new unsanitized sink, confirm the guard
catches it; confirm the existing `EditorPane.tsx` site does *not* trip it) is the
sign this wasn't designed against the known exception.

**Phase to address:** The phase owning SEC-02.

---

### Cluster I - TEST-01: native E2E runner (WKWebView, real PTY, IME, macOS menu)

#### Pitfall 16: there is no first-party WebDriver for WKWebView on macOS - do not assume the Windows/Linux pattern ports over

**What goes wrong (MEDIUM confidence, current as of this session's search):**
Tauri's own WebDriver support (`tauri-driver`) covers Windows (WebView2, via
Microsoft's Edge driver) and Linux (WebKitGTK, via WebKitWebDriver) but has no
built-in macOS WKWebView driver - Apple does not ship one, and Tauri upstream
tracks this as an open gap. Community projects exist to fill it
(`tauri-webdriver`, `@wdio/tauri-service`'s embedded-WebDriver-server approach,
plugin-based automation via IPC/accessibility bridges), each with a different
integration shape and a different maturity level. If the phase owning TEST-01 is
planned assuming "wire up `tauri-driver` like the other platforms," that plan is
wrong on day one for the macOS leg specifically (Windows/Linux menu/PTY/IME
automation, if in scope, likely *can* follow the standard pattern) - the macOS
WKWebView leg needs its own spike to pick a real approach before any verification
steps referencing it can be written meaningfully.

**Why it happens:**
CI runs Ubuntu only, and this milestone's own framing treats "native E2E" as one
deliverable, but the macOS-specific tooling gap is not visible unless someone
specifically checks for a macOS WebDriver's existence rather than assuming parity
with the two platforms that do have one.

**How to avoid:**
Spend the first slice of the TEST-01 phase confirming which concrete tool/library
the runner will use for WKWebView specifically, before committing to a design that
assumes a driver exists. Budget for this being the highest-uncertainty piece of
the whole milestone.

**Warning signs:**
A plan for TEST-01 that lists "WKWebView" alongside "real PTY," "IME," and "macOS
menu" as four equally-scoped sub-items, with the same verification shape assumed
for all four, is the sign this wasn't separately researched - WKWebView
automation is categorically harder than the other three (which are Rust-side or
OS-accessibility-side, not webview-driver-side).

**Phase to address:** TEST-01's owning phase, as its first task, not discovered
mid-implementation.

---

#### Pitfall 17: TCC/Accessibility permission grants cannot be scripted by an unattended runner

**What goes wrong (MEDIUM confidence):**
Any automation approach that drives the packaged `.app` via macOS's Accessibility
API (UI scripting, `osascript`, `AXUIElement`-based tools, or a plugin built on
top of them) requires the controlling process to hold Accessibility permission,
granted through a one-time interactive System Settings dialog that cannot be
clicked through non-interactively, and that a freshly-provisioned or CI runner
does not have pre-granted. Combined with the milestone's own stated CI reality
("`make verify` runs on `ubuntu-22.04` only... macOS-native changes ship
unverified by CI - validate them by running the real app"), this strongly implies
TEST-01's native runner will be a human-attended local tool, not a CI gate - if
any downstream phase plan writes a verification step assuming "TEST-01 runs in
CI," that step is unverifiable as written.

**Why it happens:**
"Build a native E2E runner" implicitly suggests "add it to `make verify`," but the
permission model makes that specific promotion path a much larger, separate
undertaking (macOS self-hosted CI runner provisioning + one-time permission grant
per runner + keeping that grant alive across OS updates) than building the runner
itself.

**How to avoid:**
Scope TEST-01 explicitly as a locally-invoked tool from the start (matching how
`docs/BOUNDARIES.md`-style manual macOS gates already work in this project per
CONCERNS.md's "macOS-native behavior has no automated coverage" section), and
write its verification steps accordingly - "a human runs this and confirms N
scenarios pass," not "CI is green."

**Warning signs:**
A roadmap phase for TEST-01 whose exit criteria say "runs in CI" without a
concrete plan for a permission-pre-granted macOS runner is the sign this wasn't
reconciled with the existing CI-reality constraint.

**Phase to address:** TEST-01's owning phase; resolve the CI-vs-local scope
question before writing the phase's verification criteria.

---

#### Pitfall 18: signed + notarized + hardened-runtime is a different binary than the dev build the automation harness gets built against first

**What goes wrong (MEDIUM confidence):**
A release-signed `.app` with the hardened runtime enabled restricts dynamic
library injection and debugger/inspector attachment by default (the
`com.apple.security.get-task-allow` entitlement, needed for attaching a debugger,
is normally *off* in a notarized release build and only on in local dev/ad-hoc
signed builds). An automation approach validated only against a local unsigned
`cargo tauri dev` or debug build can rely on attach/injection mechanisms that
silently stop working against the actual signed, notarized artifact - which is
specifically the artifact PROJECT.md says this milestone must "prove [behavior]
in the runtime users actually run," not a proxy build.

**Why it happens:**
It's much faster to iterate against a dev build while building the harness, and
the harness "working" there is easy to mistake for "working," full stop.

**How to avoid:**
Run the native E2E suite at least once per release cycle against the actual
signed+notarized bundle produced by the release pipeline (`release-bundles.yml`),
not only against local dev builds, and note in the phase's verification which
artifact was used.

**Warning signs:**
A TEST-01 verification record that only cites "ran locally via `tauri dev`" with
no mention of the packaged artifact is the sign this gap wasn't closed.

**Phase to address:** TEST-01's owning phase, and re-verify at each subsequent
release that ships a hardened-runtime entitlement change.

---

#### Pitfall 19: synthetic key events (Playwright-style) never exercise real IME composition

**What goes wrong (MEDIUM confidence):**
Standard browser-automation `type()`/`press()` APIs dispatch synthetic
`keydown`/`keyup`/`input` DOM events directly - they do not go through the OS
input-method-editor pipeline that produces `compositionstart`/`compositionupdate`
/`compositionend` events for scripts like Korean 2-set Hangul, which relies on the
OS combining multiple keystrokes into a single composed character before the DOM
ever sees an `input` event. A native E2E claim to test "IME input" that actually
uses synthetic key dispatch (even inside a "native" runner, if the runner still
ultimately drives the webview via JS-level key events rather than OS-level ones)
gives false confidence: it will pass while a real composition-sequence bug in
`InlineDocumentEditor`, the source-mode `<textarea>`s, or the BlockNote rich
editor goes uncaught, because the synthetic path never enters composition mode at
all.

**Why it happens:**
"Drive real key events" and "drive real IME composition" sound like the same
requirement but are different mechanisms - composition requires OS-level event
injection (Accessibility API key posting or `CGEventPost`) routed through an
active non-Latin input source, not JS-level `dispatchEvent`.

**How to avoid:**
Verify explicitly, early, that whatever mechanism TEST-01 uses to send keys can
trigger real `compositionstart`/`compositionupdate`/`compositionend` in the target
webview - test this against a known Hangul-composition case
(e.g., typing 안녕 requires multiple raw keystrokes composed into two syllables)
before trusting any IME-labeled test in the suite.

**Warning signs:**
An IME test that "passes" by asserting on a hardcoded final string typed via the
harness's normal type-a-string API, without ever exercising intermediate
composition state, is the sign it isn't testing what it claims to.

**Phase to address:** TEST-01's owning phase; treat IME as its own spike alongside
the WKWebView-driver spike (Pitfall 16), since both are higher-uncertainty than the
Rust-side (PTY) and OS-menu pieces.

---

#### Pitfall 20: native automation has flake sources with no analogue in the mocked-IPC Chromium suite

**What goes wrong:**
Window/focus stealing (a notification or another app stealing focus mid-run fails
a click-based interaction with no error until the assertion that depended on it),
first-launch Gatekeeper/notarization verification dialogs on a freshly built
artifact, screen lock/screensaver engaging during a long local run, and leftover
PTY/watcher/child processes from a previous crashed run polluting state for the
next run are all real risks for driving the actual `.app`, and none of them have
counterparts in the existing 23 Chromium-against-mocked-IPC specs - meaning the
flake-mitigation techniques that suite relies on (deterministic fixtures, mocked
timers) don't transfer, and TEST-01 needs its own flake budget and its own
retry/cleanup strategy, not a copy of `playwright.config.ts`'s existing settings
(which, per CONCERNS.md, already has a known-broken retry/trace configuration that
should not be propagated unexamined - `retries` is unset despite `trace:
"on-first-retry"`, so traces silently never capture; check this specific
misconfiguration isn't copied into the new runner's config).

**Why it happens:**
It's natural to model a new test runner's config on the existing one; the existing
one's assumptions (headless-friendly, no OS chrome, no permission prompts) don't
hold for native automation.

**How to avoid:**
Write TEST-01's config and retry/cleanup policy from scratch against native
automation's actual failure modes, and explicitly kill/clean up any leftover
Maru process, PTY, or watcher from a prior run before each suite invocation.

**Warning signs:**
Intermittent failures in the new suite that don't reproduce on re-run, with no
clear code-level cause, are the expected shape of this pitfall manifesting - treat
early flakiness as informative about environment cleanup, not as "the test is
just flaky, add a retry."

**Phase to address:** TEST-01's owning phase.

---

### Cluster J - CSS split (`src/styles.css` per mode)

#### Pitfall 21: splitting by file changes tie-breaking order, reproducing the #247/#267/#269 bug class by a different mechanism

**What goes wrong:**
CSS specificity ties break by source order. Today every selector in
`styles.css` has a fixed relative order because they're all in one file. Once
`meetings`/`today`/etc. selectors move into separate lazy-loaded chunks, their
position relative to whatever stays in the entry chunk (shared/base rules, the
534 `overflow` declarations CONCERNS.md already flags as one specificity space) is
no longer "wherever they happened to sit in the 26,434-line file" - it becomes
"after the entry chunk, in whatever order the browser injected the lazy
`<link>`/`<style>` tags," which is load-order-dependent, not file-content-order-
dependent. Any selector pair that relied on their old relative position inside the
monolith to win a specificity tie can silently flip which one wins after the
split, without either selector's own specificity changing at all.

**Why it happens:**
The mental model "split by mode" treats the file as separable static content; the
cascade doesn't work that way - moving a rule to a different *load-order position*
changes tie-breaking even when nothing about the rule's own specificity changes.

**How to avoid:**
Before splitting a mode out, identify which base/shared rules the mode's own
selectors currently win against by order (not just by specificity) - the existing
Playwright geometry assertions (`e2e/workbench-layout.spec.ts`,
`e2e/dashboard.spec.ts`) are the right tool to catch a regression here, but only if
run *after* each individual mode split, not once at the end. CONCERNS.md's own
"do not attempt a single big split, one mode per change" guidance is directly
protective against this - follow it literally, verifying geometry after each mode.

**Warning signs:**
A layout regression that only reproduces after a mode's CSS chunk has actually
loaded (i.e., after visiting that mode at least once in the session) and not on
fresh load, is the fingerprint of an order-dependent specificity tie flipping.

**Phase to address:** The phase owning the CSS split; pin a geometry assertion per
split mode as an explicit gate, not just "the bundle budget improved."

---

#### Pitfall 22: a mode's CSS chunk is not automatically coupled to its lazy JS chunk's Suspense boundary - flash risk on first visit

**What goes wrong:**
Today every mode's CSS ships in the initial chunk (that is the entire bundle-
budget problem), so a mode's DOM is always fully styled the instant its
lazy-loaded component code paints, because the CSS was already present before any
JS ran. After the split, a mode's CSS chunk must be loaded and applied *before or
synchronously with* that mode's first paint, or its DOM renders unstyled for at
least one frame on the first visit that session (worse on a cold disk cache).
The project's existing `lazy()` + `<Suspense fallback>` pattern
(`InlineDocumentEditor.tsx`'s `LazyRichMarkdownEditor` being the canonical
example) only sequences the *JS* import behind the Suspense boundary - nothing in
that pattern today couples a CSS `<link>` load to the same boundary, because there
currently is no separate CSS chunk to couple.

**Why it happens:**
The JS-side lazy-loading discipline is already solid in this codebase; CSS
code-splitting is a new axis that the existing Suspense pattern wasn't designed to
also gate, and it's easy to assume "lazy JS chunk" and "lazy CSS chunk" arrive
together for free.

**How to avoid:**
Import the mode's CSS from inside the lazily-loaded component module itself
(`import "./mode.css"` inside the file that becomes the `lazy()` target) so Vite's
own CSS-chunk-per-dynamic-import behavior ties the two together and the browser
blocks that chunk's paint on the CSS `<link>` resolving - do not manage the CSS
`<link>` insertion manually or decouple it from the component's own import graph.

**Warning signs:**
A visible flash of unstyled/incorrectly-styled content specifically on the first
navigation to a freshly-split mode within a session (and not on subsequent visits,
once the chunk is cached) is the exact signature of this gap; it's easy to miss in
manual testing if the reviewer's dev cache is already warm.

**Phase to address:** The phase owning the CSS split; add a first-visit-to-mode
visual check (not just a warm-cache check) to that phase's verification.

---

#### Pitfall 23: shared/primitive selectors split incorrectly duplicate or vanish, and no existing guard catches either

**What goes wrong:**
`src/components/ui/` primitives (`Button`, `ModeChrome`, `PaneResizeHandle`,
`SortModeToggle`) are styled inside the same monolithic `styles.css` alongside
every mode's own classes, with no file boundary today marking which selectors are
"shared across modes" versus "belong to exactly one mode." A mode-by-mode split
that naively moves every selector textually matching a mode's class prefix
(`.scratchpad-*`, `.today-*`, ...) into that mode's own chunk risks either leaving
a shared primitive's styling behind in a chunk that isn't always loaded (the
primitive renders unstyled in whichever mode's chunk didn't happen to load first),
or duplicating the shared rule into multiple mode files (working, but reintroducing
the exact "every layout change competes in one specificity space" problem
CONCERNS.md describes, just now duplicated across files instead of one file). The
existing static guards - `check-select-chrome.mjs`, `check-type-tokens` - check
syntax (raw font-size, select-background) and would not catch either failure mode;
`tsc -b` and the bundle-budget gate would both pass regardless.

**Why it happens:**
CONCERNS.md's own recommended starting points (`meetings`, `today` - "already
self-contained ID spaces") were chosen specifically because they're low-risk;
extending the same mechanical "split by class prefix" approach to a mode that
shares primitives more heavily (or splitting the shared `ui/` primitives out
themselves) is a different, harder problem the precedent doesn't cover.

**How to avoid:**
For each mode split, explicitly classify every selector as shared-primitive
(stays in a common base chunk that always loads) or mode-exclusive (moves) before
moving anything - don't rely on a class-name-prefix heuristic alone. Verify with
the Playwright geometry suite across *multiple* modes in the same session (not
just the one being split), since a shared-primitive regression only shows up when
a second mode is visited without the first mode's now-duplicated (or now-missing)
copy.

**Warning signs:**
A shared UI primitive (a `Button`, a resize handle) looking subtly different or
unstyled specifically in one mode but not another, after a split, with no error
anywhere - this is a visual-only regression invisible to every existing automated
gate.

**Phase to address:** The phase owning the CSS split.

---

#### Pitfall 24: the bundle-budget gate can go green while the split makes the multi-mode session experience worse

**What goes wrong:**
`scripts/check-bundle-budget.mjs` gates the **entry chunk only** - moving CSS out
of the entry chunk into many small per-mode chunks restores entry-chunk headroom
(the literal goal) while potentially increasing the *sum* of what a user
downloads/parses across a session that visits several modes: extra HTTP/asset-
protocol round trips per chunk, and - if Pitfall 23's duplication risk isn't
avoided - genuinely more total CSS bytes shipped than before, just none of it
counted by a gate that only measures the first load. The milestone's own framing
is explicit that "the e2e suite still passes" is no longer sufficient evidence for
this milestone because behavior is meant to observably improve - a green
bundle-budget number that coexists with a slower or FOUC-prone multi-mode session
is exactly the shape of "gate satisfied on paper, product worse" this framing
warns against.

**Why it happens:**
The gate was built to catch entry-bundle regressions, which is the correct target
for *that* problem; it was never designed to be the acceptance criterion for a
different problem (steady-state, multi-mode session cost) that the CSS split
introduces as a new dimension.

**How to avoid:**
Treat the bundle-budget gate as necessary-not-sufficient for this specific work
item. Pair it with the per-mode Playwright geometry/visual checks (Pitfall 21/22)
and, if practical, a rough total-CSS-bytes-across-N-mode-visits measurement
alongside the existing `docs/perf-baseline.md`-style before/after methodology, so
"restored headroom" is reported alongside "did the split add net bytes/round
trips across a realistic session," not instead of it.

**Warning signs:**
A phase-completion writeup that cites only the entry-chunk gzip number as evidence
of success, with no per-mode visual check and no multi-mode session measurement,
is the sign the verification stopped at the metric the gate happens to measure
rather than the outcome the milestone actually wants.

**Phase to address:** The phase owning the CSS split; make the multi-mode
verification an explicit line item, not implied by the gate passing.

---

## Technical Debt Patterns

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|---|---|---|---|
| Convert a blocking command to `async fn` without `spawn_blocking` (Pitfall 2) | Fast, small diff, main thread stops freezing | Moves the freeze to the shared async worker pool, invisible until concurrent load | Never for the 37 target commands - always route through `spawn_blocking` or the event-streaming pattern |
| Blanket `.into_inner()` recovery on all six mutexes without per-mutex justification (Pitfall 5) | One mechanical PR, uniform pattern | Silent data corruption for invariant-bearing state instead of a loud poisoned-error | Only for state that is a pure re-derivable cache (terminal wake mutex, `fs.rs`'s existing use) |
| Model REL-01 as a single cross-platform "process-group escalation" function (Pitfall 10) | Feels more "correct"/DRY | Windows has no SIGHUP concept; a shared function either does nothing there or invents unnecessary risk | Never - `#[cfg(unix)]`-gate it, matching `command_output.rs`'s existing split |
| Grep-guard `dangerouslySetInnerHTML` with no allowlist (Pitfall 15) | Simple guard, ships fast | False-positives on `EditorPane.tsx`'s documented-safe site, inviting a defeating workaround | Never - design the allowlist in from the start |
| Reuse `playwright.config.ts` settings for the new native E2E runner (Pitfall 20) | Fast to stand up | Copies a known-broken retry/trace config and flake assumptions that don't hold for native automation | Never - write TEST-01's config from its own failure-mode analysis |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|---|---|---|
| `portable_pty::ChildKiller` (REL-01) | Assuming it exposes the same process-tree kill surface as `std::process::Command` (`command_output.rs`'s pattern) | Verify portable_pty's actual Unix PTY-spawn session/group setup before reusing the pattern; escalate as a timeout-gated fallback on top of the existing killer, not a replacement |
| Tauri CSP injection (SEC-01) | Testing CSP changes only against `pnpm tauri dev` | Test against the built `frontendDist`/packaged bundle; dev and bundled builds have different CSP-injection behavior |
| `tauri-driver` (TEST-01) | Assuming it covers macOS WKWebView because it covers Windows/Linux | Confirm macOS tooling exists and is chosen deliberately before planning around it |
| `tokio::sync::Mutex` as a drop-in replacement for `std::sync::Mutex` under `.await` (PERF-01/03 interaction) | Treating it as purely a compile-fix | It removes poisoning entirely - silently reopens the exact corruption class PERF-03 exists to catch |

## Performance Traps

| Trap | Symptoms | Prevention | When It Breaks |
|---|---|---|---|
| Async-in-name-only commands (Pitfall 2) | Main thread stays responsive but unrelated IPC calls intermittently stall | Route blocking work through `spawn_blocking`/event-streaming, never bare `async fn` over a sync body | Under concurrent load - several converted commands firing near-simultaneously, exhausting the worker pool |
| `relevant_path` filtering without addressing per-directory watch registration (Pitfall 6) | Fine at small project counts, no symptom until the ceiling is near | Measure watch-descriptor count for `ops_catalog/watcher.rs` specifically, not just event volume | Workspaces with many business-unit directories approaching the OS watch-descriptor limit |
| Per-mode CSS chunk duplication of shared selectors (Pitfall 23) | Individually small, cumulative bytes/round-trips across a multi-mode session grow | Classify shared vs. mode-exclusive selectors explicitly before splitting | A session visiting most/all modes - the split cost accumulates exactly where the entry-chunk gate can't see it |

## Security Mistakes

| Mistake | Risk | Prevention |
|---|---|---|
| Removing `script-src blob:` on source-grep evidence alone (Pitfall 14) | A packaged-build-only blob-script path silently breaks a feature with no error surfaced to the user | Verify against the actual bundled/signed build, exercising every blob/worker-touching surface, not just `pnpm dev` |
| Syntactic-only DOMPurify grep guard (Pitfall 15) | A trivially-satisfied regex invites a workaround that defeats the guard while showing green | Ship the guard with an explicit, justified allowlist for `EditorPane.tsx`'s documented exception from day one |
| Treating IPC error-string conversions as purely mechanical during async migration (Pitfall 3, row 3) | A branched-on error code silently degrades to `code: ""`, breaking a conflict-recovery UI with no compile error | Grep converted commands for `.map_err(\|e\| e.to_string())`/`anyhow`-style flattening on any path that used to construct `IpcError` with a real code |

## UX Pitfalls

| Pitfall | User Impact | Better Approach |
|---|---|---|
| Group-SIGKILL escalation applied as a blanket replacement (Pitfall 8) | A user's intentionally-backgrounded process gets killed along with the terminal session, silently, with no way to know it happened | Timeout-gated fallback: SIGHUP first, escalate only if the session doesn't exit within a bound |
| Unmount-flush failure with no user-visible surface (Pitfall 13) | A user's edit is lost with zero indication - no toast, no log, discovered only much later if at all | Explicitly decide and implement a second-chance signal (console log + re-persisted localStorage draft) rather than leaving it implicit |
| First-visit-to-mode style flash after CSS split (Pitfall 22) | A visible layout jump/unstyled flash the first time a user opens a mode each session | Couple the mode's CSS import to its lazy component import so Vite blocks paint on it |
| Non-gating coverage report (TEST-02) going stale unnoticed | A false sense of test-coverage improvement if the report isn't actually read after this milestone closes | Since it's explicitly non-gating, note in the phase's closeout who/what is expected to read it going forward, or it will silently rot like the stale `TODO_LEDGER` entry CONCERNS.md already found |

## "Looks Done But Isn't" Checklist

- [ ] **PERF-01 command conversion:** Looks done when `async` compiles and the UI
 stops freezing. Verify: fire the converted command concurrently with an
 unrelated command and confirm the unrelated one's latency doesn't degrade
 (Pitfall 2).
- [ ] **PERF-03 poisoning recovery:** Looks done when `into_inner()` compiles and
 a deliberately-triggered panic no longer bricks the feature. Verify: for each of
 the six mutexes, a one-line justification exists for why the guarded data is
 safe to hand back as-is after a mid-critical-section panic (Pitfall 5).
- [ ] **REL-01 escalation:** Looks done when a SIGHUP-trapping test process can be
 killed. Verify: a *non-trapping*, normally-behaving shell with a backgrounded
 detached child still leaves that child running after the session closes
 (Pitfall 8), and the fix is confirmed `#[cfg(unix)]`-only with no Windows-path
 changes (Pitfall 10).
- [ ] **Scratchpad flush:** Looks done when switching panes within 700ms of typing
 no longer loses content. Verify: the app-quit path (not just pane-switch) is
 either also covered or explicitly scoped out (Pitfall 12), and StrictMode dev
 testing doesn't double-fire the save (Pitfall 11).
- [ ] **SEC-01 CSP tightening:** Looks done when the packaged app launches and the
 obvious surfaces (export, graph) still work. Verify: tested against the actual
 bundled/signed build, not only `pnpm dev` (Pitfall 14).
- [ ] **SEC-02 DOMPurify guard:** Looks done when it's wired into `verify` and
 passes today. Verify: a deliberate-break test (add an unsanitized sink, confirm
 it's caught) and a deliberate-exception test (confirm `EditorPane.tsx`'s
 documented case is allowlisted, not accidentally flagged) both exist
 (Pitfall 15).
- [ ] **TEST-01 native runner:** Looks done when it runs once locally and
 something passes. Verify: the WKWebView driver mechanism is a deliberate choice
 (not a placeholder), IME tests exercise real composition events (not synthetic
 key dispatch), and the runner is scoped as local/manual rather than assumed to
 be a CI gate (Pitfalls 16, 17, 19).
- [ ] **CSS split:** Looks done when `check-bundle-budget.mjs` passes with more
 headroom. Verify: per-mode Playwright geometry checks pass after *each*
 individual mode split (not just at the end), and a first-visit-to-mode check
 (cold cache) confirms no flash (Pitfalls 21, 22).

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---|---|---|
| Async-in-name-only worker-pool starvation (Pitfall 2) | LOW | Wrap the existing blocking call in `spawn_blocking` - no signature change needed at the call site, contained to the one command |
| Blanket poisoning recovery on invariant-bearing state (Pitfall 5) | MEDIUM | Revert `into_inner()` for the affected mutex only, restore the loud poisoned-error path, add explicit re-init logic before re-attempting recovery |
| Group-SIGKILL regressing backgrounded-child survival (Pitfall 8) | MEDIUM | Reintroduce the SIGHUP-first, timeout-gated fallback; add the missing positive test for the survival case so it can't silently regress again |
| CSS split specificity tie flip (Pitfall 21) | MEDIUM-HIGH | Bisect which mode's split introduced the regression using the per-mode geometry assertions; may require re-ordering the shared/base chunk's `<link>` injection relative to mode chunks, not just re-splitting |
| Silent CSP-blocked feature in packaged app (Pitfall 14) | LOW-MEDIUM | Re-add the specific `blob:` allowance (revert is a one-line config change), then re-derive exactly which surface needed it before attempting removal again |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Work Item | Verification |
|---|---|---|
| 1-3 (concurrency-model shift, async-in-name-only, error-type flattening) | PERF-01 | Concurrent-invocation timing check; grep converted commands for inline blocking calls not wrapped in `spawn_blocking`; e2e assertion on `IpcError.code`, not just message text |
| 4 (TOCTOU on lock narrowing) | PERF-02 | Test: remove/mutate a source while its sync is in flight, assert the re-acquired write doesn't clobber it |
| 5 (invariant-bearing poisoning recovery) | PERF-03 | Per-mutex written justification for `into_inner()` safety in the PR description |
| 6 (watch-handle count vs. event volume) | PERF-04 | Watch-descriptor count measurement for `ops_catalog/watcher.rs` at realistic BU-directory counts |
| 7, 9, 10 (portable_pty reuse, pid/pgid reuse, Windows must not change) | REL-01 | Confirm portable_pty's session/group setup before implementation; `ESRCH`-as-success handling; diff review confirming zero `#[cfg(windows)]`/shared-path changes |
| 8 (backgrounded-child survival regression) | REL-01 | Positive test: background a detached child, close the session, confirm it survives |
| 11-13 (StrictMode double-flush, cleanup can't await, silent failure) | Scratchpad flush work item | Dev-mode StrictMode manual check; explicit scope decision on pane-switch vs. app-quit; explicit decision on failure-path signal |
| 14 (grep-only CSP verification) | SEC-01 | Manual/automated pass over the packaged, bundled build exercising every blob/worker surface |
| 15 (syntactic DOMPurify guard false positive) | SEC-02 | Deliberate-break + deliberate-exception tests both present |
| 16, 17, 19, 20 (WKWebView driver choice, TCC permissions, IME synthetic events, native flake) | TEST-01 | Explicit tooling spike recorded before implementation; explicit local-vs-CI scope decision; composition-event verification; runner-specific cleanup/retry policy |
| 18 (dev build vs. signed/notarized build) | TEST-01 | At least one verification pass against the actual release-pipeline artifact |
| 21-24 (cascade order, FOUC, shared-selector split, budget-gate-vs-UX gap) | CSS split | Per-mode Playwright geometry check after each split; first-visit cold-cache check; explicit multi-mode session note in the phase writeup |

## Sources

- This repository (HIGH confidence, primary source for all repo-specific claims):
 `.planning/PROJECT.md`, `.planning/codebase/CONCERNS.md`,
 `.planning/codebase/CONVENTIONS.md`, `src-tauri/tauri.conf.json`,
 `src-tauri/src/terminal/mod.rs`, `src-tauri/src/command_output.rs`,
 `src-tauri/src/ipc_error.rs`, `src-tauri/src/paths.rs`,
 `src/components/ScratchpadPane.tsx`, `src/components/graph/GraphInsightsPanel.tsx`,
 `vite.config.ts`, `package.json`.
- Tauri async command execution model (`async_runtime::spawn` vs. `spawn_blocking`
 vs. `#[tauri::command(async)]` on a sync fn): Tauri official docs
 (v2.tauri.app "Calling Rust from the Frontend"), `docs.rs/tauri` async_runtime
 module, and community discussion threads cross-checked this session - MEDIUM
 confidence, consistent across sources.
- React 19 StrictMode double-invocation of effects/cleanup in development only,
 no double-invocation in production: consistent across multiple current sources
 checked this session - MEDIUM-HIGH confidence (well-established, stable React
 behavior since 18, continued in 19).
- macOS WKWebView has no first-party Apple/Tauri WebDriver; community
 (`tauri-webdriver`, `@wdio/tauri-service`) fill the gap; `tauri-driver` covers
 Windows (WebView2) and Linux (WebKitGTK) natively - LOW-MEDIUM confidence,
 based on current community/GitHub sources rather than a single authoritative
 spec; verify directly against the chosen tool's own docs before committing to
 an approach in the TEST-01 phase.
- Vite production worker/blob CSP behavior (module workers via
 `new Worker(new URL(...), { type: "module" })` do not require `script-src
 blob:`; `?inline` workers and dynamic-blob-import edge cases do): MEDIUM
 confidence, cross-checked against Vite's own docs and issue tracker this
 session.
- Rust `std::sync::Mutex`/`PoisonError::into_inner()` semantics (returns the
 guard unchanged, does not validate or repair the protected data) and
 `tokio::sync::Mutex` never poisoning: standard, stable library behavior - HIGH
 confidence, not separately re-verified this session beyond the codebase's own
 existing correct usage at `skill_host/fs.rs:155` and `terminal/mod.rs:203`.

---
*Pitfalls research for: Maru v1.1 "Felt Quality and Native Proof"*
*Researched: 2026-08-28*
