# Architecture Research — v1.1 "Felt Quality and Native Proof"

**Domain:** Integration analysis for a shipped Tauri 2.10 desktop app (Maru) — how five quality
requirements (PERF-01..04, REL-01, TEST-01) attach to the existing architecture.
**Researched:** 2026-08-28
**Confidence:** HIGH (every claim below is grounded in code read at commit tree `a938128`+ and in
Tauri 2's own current documentation, not recalled from training data)

This is not ecosystem research — the stack, store pattern, and 356-command IPC layer are fixed and
documented in `.planning/codebase/ARCHITECTURE.md`. This file answers one question: **where do the
five v1.1 mechanisms attach to that existing structure, file by file, and in what order.**

## Standard Architecture

### Integration Overview

```text
┌───────────────────────────────────────────────────────────────────────┐
│ React 19 webview (unchanged surface for this milestone)                │
│   src/lib/api.ts invoke() calls — signatures survive PERF-01/02/03     │
│   except the small subset that moves to invocation-id + event (below)  │
└───────────────────────────────┬────────────────────────────────────────┘
                                 │ invoke() / listen()
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Tauri command layer — src-tauri/src/lib.rs generate_handler![]          │
│                                                                         │
│  PERF-01 target: 37 sync fns → #[tauri::command(async)]                │
│    (mechanical — same fn, same Result<T,E>, same State<'_,T> args)     │
│    skill_host/store.rs, today_calendar.rs, share_outbox.rs,            │
│    launchd_migration.rs, …                                             │
│                                                                         │
│  PERF-02 target: skill_host/store.rs:566-598                           │
│    skills_sync_source_impl — narrow REGISTRY_LOCK around the git pull  │
│                                                                         │
│  PERF-03 target: 6 process-global Mutex<()> / Mutex<T> sites           │
│    REGISTRY_LOCK · terminal sessions/reservations/killer · JOBS_LOCK · │
│    DOT_ACTION_LOCK · BINDER_WRITE_LOCK — into_inner() recovery         │
│                                                                         │
│  REL-01 target: terminal/mod.rs terminal_kill (~L858-898)              │
│    apply command_output.rs's process-group SIGKILL escalation to PTY   │
└───────────────────────────────┬────────────────────────────────────────┘
                                 │
                                 ▼
┌───────────────────────────────────────────────────────────────────────┐
│ Rust domain modules — filesystem, git CLI, subprocess, PTY (unchanged) │
└───────────────────────────────────────────────────────────────────────┘

┌───────────────────────────────────────────────────────────────────────┐
│ TEST-01 (new, sits beside everything above, not inside it)             │
│   New: a native runner that drives the real Tauri app (real WKWebView, │
│   real PTY, real IME, real macOS menu) — NOT the Chromium/mocked-IPC   │
│   e2e/*.spec.ts suite, which is unmodified.                            │
│   Wired as: a new `make` target, evidence for PERF-01/02/03/REL-01,    │
│   NOT a new required CI job (see Q4 below for why).                    │
└───────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities — new vs. modified

| Component | New or Modified | What changes |
|---|---|---|
| `src-tauri/src/skill_host/store.rs` (37-command subset) | **Modified** — attribute only | `#[tauri::command]` → `#[tauri::command(async)]` on `pub fn`s; no body/signature change |
| `src-tauri/src/today_calendar.rs`, `share_outbox.rs`, `launchd_migration.rs` (rest of the 37) | **Modified** — attribute only | Same mechanical change |
| `skills_sync_source_impl` (`skill_host/store.rs:578-598`) | **Modified** — restructured | Lock scope narrowed around the network call; registry re-read after re-acquire (see Q2) |
| `REGISTRY_LOCK`, `JOBS_LOCK`, `DOT_ACTION_LOCK`, `BINDER_WRITE_LOCK`, terminal `sessions`/`reservations`/`killer` locks | **Modified** — recovery idiom | `.lock().map_err(...)?` → `.lock().unwrap_or_else(\|poisoned\| poisoned.into_inner())`, same idiom already proven at `skill_host/fs.rs:216` (currently `#[cfg(test)]`-only; PERF-03 promotes it to production call sites) |
| `terminal_kill` (`terminal/mod.rs:858-898`) | **Modified** | Adds the `command_output.rs:404`/`:543` process-group escalation path when the plain `ChildKiller::kill()` (SIGHUP-only on Unix) doesn't reap the child |
| `src-tauri/src/vault_watcher.rs`, `inbox_watcher.rs`, `scratchpad_watcher.rs`, `ops_catalog/watcher.rs` | **Modified** | Their `relevant_path` predicates start filtering against `crate::paths::GENERATED_DIRS` (already exists, unused by these four today) |
| Native E2E runner (script + fixtures + `make` target) | **New** | Drives the packaged/dev Tauri binary directly; no existing analog. Playwright `e2e/*.spec.ts` and `playwright.config.ts` are untouched |
| `ipc_error.rs`, `IpcError` union, `src/lib/types.ts` mirror | **Unmodified** | None of PERF-01/02/03 touch a command that returns `IpcError` today (`today_mutate`, `task_transition`, `task_trash`, `save_document`, `evidence_binder_mutate` are not in the 37-offender list) |

## Architectural Patterns

### Pattern 1 (Q1 — PERF-01): the off-main-thread decision rule

**What Tauri 2 actually offers**, verified against the current Tauri 2 docs and the docs.rs
reference for `async_runtime::spawn_blocking`:

- **`async fn` command.** Dispatched via `tauri::async_runtime::spawn` onto Tauri's async worker
  pool — off the main thread. The catch (stated verbatim in Tauri's own docs): *"you cannot simply
  include borrowed arguments in the signature of an asynchronous function. Some common examples of
  types like this are `&str` and `State<'_, Data>`"* — the fix is either owned types (`String`) or
  wrapping the return type in `Result<T, E>`. Because this codebase already returns `Result<T,
  String>` (or `Result<T, IpcError>`) from essentially every command, that second escape hatch is
  usually already satisfied "for free." Real cost: any `std::sync::MutexGuard` held across a
  genuine `.await` inside the body must be dropped first or the lock switched to
  `tokio::sync::Mutex` — a per-command judgement call, not mechanical.
- **`#[tauri::command(async)]` on an unchanged sync `fn`.** Same dispatch path
  (`async_runtime::spawn`) as `async fn`, but the function body itself never contains an `.await`,
  so **the borrow-lifetime problem above does not apply.** This codebase already proves it: plain
  `pub fn` commands taking `State<'_, T>` are already marked `(async)` and compile and run —
  `drafts_promote` (`drafts.rs:1011-1013`), `git_sync_commit_push` (`git.rs:636-638`),
  `trash_inbox_items`/`accept_inbox_item`/`reject_inbox_item`/`apply_inbox_decisions`
  (`inbox.rs:429-576`) — and the State-free case is proven by `scan_task_notes`/`read_task_metadata`
  (`tasks.rs:178-221`). This is the **cheapest, purely mechanical option**: add `(async)` to the
  attribute, change nothing else.
- **`tauri::async_runtime::spawn_blocking` inside an `async fn`.** For a command that must be
  `async fn` for some other reason (it awaits something else) but also has one heavy synchronous
  sub-step, wrap only that sub-step: `dot_sync_overview` (`dot_sync.rs:325-329`) is the exact
  precedent already in this codebase — `tauri::async_runtime::spawn_blocking(overview_sync).await`.
- **Invocation-id + `thread::spawn` + event streaming** (`skills_env_bootstrap`,
  `skill_host/env.rs:52-143`). Returns an id immediately, does the work on a raw OS thread, streams
  `skills-env://output` / `skills-env://done`. This is a **real API-shape change**: the command's
  own `Result<T, E>` becomes `Result<String, E>` (the id), the actual result/error moves to an event
  payload, and the frontend facade needs a new `listen()` call instead of just awaiting the promise.
  A closure moved into `thread::spawn` also cannot borrow `State<'_, T>` — it must capture an owned
  clone (`app.clone()` at `env.rs:88`), same constraint as any `'static` thread body.

**The decision rule** (apply per command, in order):

1. Does the body ever need to `.await` something (an async HTTP client, another async fn)? — **No**
   for all 37 currently-cited offenders (they shell out via `std::process::Command` or walk the
   filesystem, both synchronous APIs). If **yes**, it must become `async fn`; audit `State<'_, T>`
   usage and any lock guard held across the await, then stop — this branch is a judgement call, not
   mechanical.
2. Is the operation's duration bounded (finishes in roughly the time a user already expects a
   click to take — a `WalkDir` of a working tree, a `read_dir`, a short subprocess) **and** does it
   not need new progress/cancel UX it doesn't already have? — **Add `(async)` to the existing
   `#[tauri::command]` attribute. Nothing else changes.** This is the answer for
   `skills_list_sources`/`skills_add_source`/`skills_remove_source` (no `State` params, plain
   `pub fn`, `store.rs:411/420/558`), `today_calendar_commitments`/`today_calendar_publish`
   (`today_calendar.rs:189/415`), `prepare_share_outbox_files` (`share_outbox.rs:307`), and
   `detect_legacy_telegram_launchd` (`launchd_migration.rs:18`) — none borrow anything, none need
   new progress plumbing.
3. Is the operation's duration genuinely unbounded (network) **and** does it already have (or
   plausibly need) a progress/cancel surface? `skills_sync_source` is the interesting case: its
   network pull is unbounded, but it already threads a `ProgressReporter`/`progress_id` through
   `skills_sync_source_impl` today — so it does **not** need to move to the invocation-id pattern;
   `(async)` on the attribute is sufficient, and PERF-02 (Pattern 2 below) is the separate fix for
   its lock-holding problem. Reach for invocation-id + events only when a command has **no**
   existing progress channel and genuinely needs one.

**Error-shape guarantee for the plan author:** neither `(async)` on a sync fn nor `async fn` changes
a command's `Result<T, E>` type — the async/sync attribute is orthogonal to the error type, so the
`IpcError` contract (`ipc_error.rs`) is untouched by PERF-01 regardless of which of the first three
options is used. Only the invocation-id/event pattern changes the wire shape (id instead of result),
and no command currently returning `IpcError` is in the 37-offender list, so this is moot for
PERF-01 as scoped — but state the rule anyway, since a future author may reach for the pattern on an
`IpcError` command and need to mirror the error into the event payload by hand.

### Pattern 2 (Q2 — PERF-02): narrow a lock across a network call, with re-validation on re-acquire

**Current shape** (`skill_host/store.rs:578-598`, lock at `:45`/`:2618`):

```rust
fn skills_sync_source_impl(...) -> Result<Vec<SkillRecord>, String> {
    let _guard = registry_guard()?;                 // held for the whole fn
    let mut registry = load_registry_unlocked()?;
    let source = registry.sources.iter().find(...).cloned()...?;
    let skills = sync_one_source_in_registry(&mut registry, &source, progress)?; // git pull inside
    save_registry_unlocked(&registry)?;
    Ok(skills)
}
```

`registry_guard()` returns `MutexGuard<'static, ()>` — a **unit mutex**. It protects no in-memory
state of its own; it only serializes the read-modify-write sequence against `registry.json` on disk
(`load_registry_unlocked`/`save_registry_unlocked`, `store.rs:2656-2726`). That is exactly why the
restructure is safe to do at all: there is nothing living in memory under this lock that a release
would corrupt.

**Correct restructure:**

```rust
fn skills_sync_source_impl(...) -> Result<Vec<SkillRecord>, String> {
    // 1. Read under the lock, then release.
    let source = {
        let _guard = registry_guard()?;
        let registry = load_registry_unlocked()?;
        registry.sources.iter().find(|s| s.id == source_id).cloned()
            .ok_or_else(|| format!("unknown_source: {source_id}"))?
    }; // guard drops here

    // 2. Network, outside the lock — this is the whole point.
    if source.kind == "cloned" {
        run_command(Command::new("git").arg("-C").arg(source_path(&source)?).arg("pull").arg("--ff-only"))?;
    }

    // 3. Re-acquire, reload FRESH (not the stale copy from step 1), re-validate, then mutate+save.
    let _guard = registry_guard()?;
    let mut registry = load_registry_unlocked()?;               // fresh read, not reused
    if !registry.sources.iter().any(|s| s.id == source_id) {
        return Err(format!("unknown_source: {source_id}"));      // CAS re-check
    }
    let skills = rescan_source_in_registry_with_progress(&mut registry, &source_id, progress)?; // fs-only, no network
    save_registry_unlocked(&registry)?;
    Ok(skills)
}
```

**The consistency hazard:** `save_registry_unlocked` does a **wholesale overwrite** of
`registry.json`, not a merge. Between step 1's release and step 3's re-acquire, any other writer —
`skills_add_source`, `skills_remove_source`, `skills_sync_all_sources`, or a second concurrent
`skills_sync_source` for a different id — can load, modify, and save the registry. If step 3 resumed
work on the **stale** in-memory `registry` captured in step 1 and saved it, that save would silently
clobber whatever the concurrent writer did (a lost update / ABA problem, worse than a normal
optimistic-concurrency conflict because nothing here is versioned per record).

**Detection and handling — no separate consistency check needed, only discipline:** reload the
registry fresh under the re-acquired lock in step 3 rather than reusing the step-1 copy. That alone
prevents clobbering any *other* source or skill record, since step 3 starts from the latest on-disk
state and only touches the fields this call owns. The remaining question — did *this specific
source* survive the network call — is a genuine existence re-check (shown above): if
`skills_remove_source` ran mid-pull, fail with the same `unknown_source: {id}` message already used
for a source that never existed, rather than silently re-inserting rescanned skill records for a
source the user just removed.

**Existing compare-and-swap precedent to follow (not copy verbatim):** `assert_expected_revision`
(`document.rs:123-133`) and the identical shape in `evidence_binder_mutate`
(`evidence_binder.rs:655-673`, `actual_revision != req.expected_revision` →
`EVIDENCE_BINDER_REVISION_CONFLICT`) are this codebase's real CAS pattern — a revision hash read
before the operation, re-checked immediately before the write, conflict surfaced as a typed error.
The registry has no per-record revision field, so a full hash-CAS is out of scope for PERF-02; the
existence re-check above is the minimum viable analog for the one hazard PERF-02 actually
introduces. Do not add a revision field to `SkillSource` to do this "properly" — that is scope
creep past what PERF-02 asks for.

### Pattern 3 (Q3 — PERF-03): classifying the six locks for `into_inner()` recovery

The already-proven idiom (currently test-only) is at `skill_host/fs.rs:216-221`:

```rust
MARU_TEST_HOME_LOCK.get_or_init(|| Mutex::new(())).lock()
    .unwrap_or_else(|poisoned| poisoned.into_inner())
```

The distinguishing question the milestone poses is *re-readable on-disk file* vs. *invariant-bearing
in-memory structure*. Reading the actual guarded data at each of the six sites gives a sharper
answer than that binary — **all six are safe to recover, but for two different reasons**, and a plan
author should know which reason applies to avoid over-trusting the fix where it doesn't transfer:

| Lock | File:line | What it guards | Why `into_inner()` is safe |
|---|---|---|---|
| `REGISTRY_LOCK` | `skill_host/store.rs:45`, guard at `:2618` | `Mutex<()>` — no data, purely serializes `registry.json` read-modify-write | Trivial: the guard protects `()`. There is no in-memory state to be torn; poisoning only means *some* panic happened during a critical section, and the on-disk file is re-read fresh on every call anyway |
| `JOBS_LOCK` | `jobs.rs:16`, guard at `jobs.rs:95-99` | `Mutex<()>` — serializes `jobs.json` read-modify-write | Same as `REGISTRY_LOCK` |
| `DOT_ACTION_LOCK` | `dot_sync.rs:14`, guard at `:348-351` | `Mutex<()>` — serializes external `dot`/`brew` CLI invocations, no data at all | Same, and simpler still: nothing is even read/written through the guard itself |
| `BINDER_WRITE_LOCK` | `evidence_binder.rs:24` (static, not `OnceLock`-wrapped), guards at `:265` and `:653` | `Mutex<()>` — serializes evidence-binder JSON state read-modify-write | Same as `REGISTRY_LOCK`/`JOBS_LOCK` |
| Terminal registry lock | `terminal/mod.rs` — `TerminalState.sessions: Arc<Mutex<HashMap<String, Arc<TerminalSession>>>>` and `.reservations: Arc<Mutex<HashSet<String>>>`; poisoning message `"terminal_registry_poisoned"` at lines **95, 99** (`SessionReservation::acquire`), **469** (`terminal_spawn` insert), **904** (`get_session`) | Live in-memory handles to real OS PTY sessions — genuinely not reconstructable from disk | Safe for a different reason: std collections do not leave themselves internally torn by a caller panic elsewhere in the same statement (a `.insert()`/`.get()` call is not interruptible mid-write by an unrelated panic), and this codebase already tolerates a stale/duplicate-looking entry by design — the generation token (`get_session_generation`) and the `Arc::ptr_eq`-guarded removal in the exit thread (`mod.rs:485-492`) exist precisely so a momentarily-stale registry entry is not a correctness bug. `into_inner()` recovery composes with that existing defense; it does not replace it |
| Terminal killer lock | `terminal/mod.rs` — `TerminalSession.killer: Mutex<Box<dyn ChildKiller + Send + Sync>>`; poisoning message `"terminal_killer_poisoned"` at line **877** inside `terminal_kill` | A single live process-kill handle per session | Safe: the only operation under this lock is `killer.kill()`. If that panics mid-call, the OS-level signal-send is ambiguous either way — recovering the mutex doesn't worsen that ambiguity, and calling `.kill()` again on a recovered guard is effectively idempotent (killing an already-dead process just errors). Note `terminal_kill` already resets `session.closing` to `false` on a poisoning `Err` today (`mod.rs:875-878`) specifically so a retry is possible; `into_inner()` recovery makes the *first* call succeed instead of requiring that retry |

**What `into_inner()` recovery does *not* fix, so plan authors don't over-apply it:**
`SessionReservation::acquire` (`mod.rs:91-110`) locks `reservations` and then `sessions` in sequence
under two separate `Mutex` guards. A panic between those two `.lock()` calls is a cross-lock
ordering hazard, not a poisoning-recovery problem — `into_inner()` on either lock individually does
not restore the invariant "a reservation implies no session yet exists for that id" if the panic
happened between them. This is out of scope for PERF-03 as written (recover-from-poisoning, not
fix-cross-lock-atomicity) and should not be conflated with it in the plan.

## Anti-Patterns

### Anti-Pattern 1: converting PERF-01 commands to genuine `async fn`

**What people do:** Reflexively write `pub async fn` because that's the textbook Tauri async
command, then hit the `State<'_, T>` borrow error the official docs describe and "fix" it by
cloning state unnecessarily or restructuring signatures.
**Why it's wrong:** None of the 37 offenders need to `.await` anything — they shell out to
synchronous APIs (`std::process::Command`, `WalkDir`, `fs`). `async fn` invites exactly the
borrow-lifetime friction this codebase already avoided by using `#[tauri::command(async)]` on plain
`pub fn`s elsewhere (`drafts_promote`, `git_sync_commit_push`, the `inbox.rs` approval commands).
**Do this instead:** Add `(async)` to the attribute, leave the fn signature and body alone (Pattern 1).

### Anti-Pattern 2: reusing the in-memory registry after re-acquiring the PERF-02 lock

**What people do:** Restructure `skills_sync_source_impl` to release the lock around the git pull,
then re-acquire and call `save_registry_unlocked(&registry)` using the same `registry` variable
captured before the pull, because it "already has the pulled source's changes reflected after the
rescan."
**Why it's wrong:** That `registry` value is frozen at the moment of the pre-pull read. Any writer
that ran during the network call is invisible to it, and the wholesale-overwrite save silently
reverts their write.
**Do this instead:** Reload the registry fresh under the re-acquired lock (Pattern 2) and only then
run the (disk-scan-only) rescan against that fresh copy.

### Anti-Pattern 3: treating `into_inner()` as safe everywhere a `Mutex` exists

**What people do:** See the PERF-03 requirement, grep for every `.lock().map_err(...)` in the
codebase, and mechanically apply `into_inner()` to all of them, including ones not in the six-lock
list (e.g. `session.model: Arc<Mutex<TerminalModel>>`, which holds live terminal-screen state whose
internal invariants — cursor position, damage tracking, scrollback — genuinely could be torn by a
panic mid-`advance()`).
**Why it's wrong:** PERF-03's scope is exactly the six locks named in the milestone (all of them
either `Mutex<()>` or collections whose contents this codebase already treats as tolerant of
staleness). A `TerminalModel` guard poisoned mid-mutation is a materially different risk profile —
recovering it could hand back a screen buffer with an inconsistent grid/cursor.
**Do this instead:** Apply `into_inner()` only to the six sites classified in Pattern 3. Leave every
other lock's poisoning behavior as-is; it is out of scope for this milestone.

## Integration Points (Q4 — TEST-01: native E2E runner)

**Where it attaches — new `make` target, not a new required CI job.** This codebase already has the
exact precedent for "a real gate that CI cannot honestly run": `verify-integration`
(`Makefile:216-223`), which smokes the real installed AI CLIs and is explicitly excluded from
`verify` with the comment *"a merge gate that fails on an expired token is a gate people learn to
bypass."* TEST-01 should copy that shape, not invent a new one:

1. **New `Makefile` target**, e.g. `test-e2e-native`, with the same doc-comment convention: state
   why it's excluded from `verify` (WKWebView chrome, a real PTY, IME composition, and the macOS
   native menu cannot run headless on the `ubuntu-22.04` runner `make verify`/`e2e` both use today —
   `.github/workflows/ci.yml:105`, `:184`), and state exactly which files/changes should trigger a
   human running it locally: `terminal/mod.rs`, `app_menu.rs`, `browser_passkeys.rs`, and any
   change under `#[cfg(target_os = "macos")]`.
2. **No new required CI job.** `make verify` (`ci.yml:102-178`) and the `e2e` job
   (`ci.yml:180-219`) both pin `runs-on: ubuntu-22.04`; neither can execute macOS-native code at
   all, so folding the native runner into either would either silently no-op or fail every PR. If a
   genuinely scriptable *subset* exists that doesn't need a real windowed session (e.g. a
   `macos-14` GH Actions runner driving the packaged binary's IPC without real user-focus IME), that
   subset could become its own **non-required** job on a macOS runner later — but per the milestone's
   own framing ("possibly only attended"), do not promise that subset exists before proving it; treat
   the runner as attended-local-only until demonstrated otherwise.
3. **Wire it into `release-preflight`** (`Makefile:262-271`), the existing local-only chain
   (`release-preflight-core` → `cli-smoke` → `test-e2e`) that a human already runs before a release.
   Add the new target as a step there, matching PROJECT.md's own stated CI reality: *"macOS-native
   changes ship unverified by CI - validate them by running the real app."* This makes the gate
   honest instead of decorative — it exists, it's documented, and it's run by a human at a known
   point, exactly like `verify-integration` and the three deliberately-`#[ignore]`d Rust tests
   (`vault.rs:1506`, `ops_catalog/scan.rs:1110`, `agent_host/status.rs:1185`).

**What must NOT change about the existing Playwright suite:** `e2e/*.spec.ts` (23 specs),
`playwright.config.ts`, and `e2e/helpers/todayFixtures.ts`'s `window.__MARU_E2E_INVOKE__` mocking
stay exactly as they are — mocked-IPC, Chromium, `ubuntu-22.04`, still the `e2e` CI job. The native
runner is **additive evidence for the felt-quality behavior changes**, not a replacement, and it
does not reuse the `.spec.ts` files (different IPC surface entirely — real `invoke()` round-trips
and a real PTY, not the mock). Do not attempt to point the same spec files at both runners.

## Build Order (Q5)

**TEST-01 lands first, not last — this is the one hard sequencing dependency in the milestone.**
PERF-01, PERF-02's freeze-avoidance claim, PERF-03's "the feature survives a poisoned lock instead
of bricking," and REL-01's "a SIGHUP-trapping child can still be killed" are all *observable behavior
changes*, and the mocked-IPC Chromium suite cannot see any of them — it never calls the real Rust
backend. Without a native runner in place first, every later phase either ships unverified or
invents its own one-off manual-check ritual that TEST-01 would have made redundant. This matches
PROJECT.md's own recorded decision ("The native E2E runner lands early, not as closeout").

Suggested order, with the dependency reasoning stated per step:

1. **TEST-01 — native E2E runner.** No dependency on anything else in this milestone. Everything
   below depends on it for evidence, so it goes first.
2. **PERF-03 (all six locks) + PERF-04 (watcher `GENERATED_DIRS` wiring), together.** Both are
   small and mechanical (`into_inner()` idiom already proven at `fs.rs:216`; `GENERATED_DIRS`
   already exists at `paths.rs:31`, just unreferenced by the four watcher modules). Neither has a
   structural dependency on TEST-01, though the terminal-lock half of PERF-03 is worth proving with
   a real PTY once the runner exists. Do PERF-03 *before* PERF-02 for a narrower reason:
   PERF-02 rewrites `skills_sync_source_impl`'s body, and that rewrite should be written against the
   final (poisoning-recovering) `registry_guard()` rather than being rebased around a
   mid-flight change to the same file.
3. **PERF-02 — narrow the skills registry lock.** Depends on step 2's `registry_guard()` being
   final. Independent of PERF-01.
4. **PERF-01 — the 37-command migration.** Benefits from TEST-01 existing so each migrated command
   (or a representative batch) can be shown to actually leave the main thread in the real app, not
   just in the mocked suite. No hard dependency on PERF-02/03, but doing it after them avoids
   touching `skill_host/store.rs` three times in overlapping phases.
5. **REL-01 — PTY process-group kill.** Hard-depends on TEST-01: a Chromium-mocked e2e spec cannot
   spawn a real child that traps SIGHUP, so this requirement's own success criterion is only
   checkable through the native runner. Apply the already-proven pattern
   (`command_output.rs:404` `process_group(0)`, `:543` `terminate_unix_process_group` SIGKILL to
   `-pgid`) to `terminal_kill` (`terminal/mod.rs:858-898`).
6. **Independent, no ordering constraint — thread through any phase or their own light phase:**
   the scratchpad flush-on-unmount fix (verifiable with an existing jsdom/RTL unmount test, no
   native dependency), SEC-01/SEC-02 (CSP `blob:` drop + the `dangerouslySetInnerHTML` grep guard,
   both CI-verifiable on `ubuntu-22.04`), the `src/styles.css` per-mode split (bundle-budget-gated,
   no native dependency), TEST-02 (non-gating coverage reporting, pure tooling), and the v1.0
   closeout evidence debt (GATE-04 trace reproduction, Phase 01-03 Nyquist reconciliation, Phase 02
   security report — pure documentation, no code dependency at all).

## Sources

- Tauri 2 official docs, "Calling Rust from the Frontend" (`https://v2.tauri.app/develop/calling-rust/`) — verified: async command dispatch via `tauri::async_runtime::spawn`, the `State<'_, T>`/`&str` borrow restriction specific to genuine `async fn`, and the `Result<T, E>`-wrapping workaround. Fetched directly, current as of research date.
- `docs.rs/tauri/latest/tauri/async_runtime/fn.spawn_blocking.html` and related search results — verified `spawn_blocking` signature and intended use (offload a blocking sub-step from within an async command).
- This codebase, read directly at the current tree: `src-tauri/src/skill_host/{store.rs,env.rs,fs.rs}`, `src-tauri/src/terminal/mod.rs`, `src-tauri/src/command_output.rs`, `src-tauri/src/document.rs`, `src-tauri/src/evidence_binder.rs`, `src-tauri/src/jobs.rs`, `src-tauri/src/dot_sync.rs`, `src-tauri/src/tasks.rs`, `src-tauri/src/drafts.rs`, `src-tauri/src/git.rs`, `src-tauri/src/inbox.rs`, `src-tauri/src/ipc_error.rs`, `src-tauri/src/paths.rs`, `Makefile`, `.github/workflows/ci.yml`.
- `.planning/codebase/ARCHITECTURE.md` and `.planning/codebase/CONCERNS.md` (2026-08-22 codebase audit) — source of the 37-command list's four cited examples, the six-lock list, and the native-runner gap description; every claim drawn from them was independently re-verified against current source in this research pass.
- `.planning/PROJECT.md` — milestone scope, constraints, and the "native runner lands early" key decision.

---
*Architecture research for: Maru v1.1 "Felt Quality and Native Proof"*
*Researched: 2026-08-28*
