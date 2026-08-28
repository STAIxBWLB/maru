# Feature Research - Felt Quality Behavioral Contracts

**Domain:** Local-first Tauri 2 desktop app - quality/reliability milestone (v1.1), no new product features
**Researched:** 2026-08-28
**Confidence:** HIGH overall (grounded in NN/g response-time research, systemd/Unix signal-escalation convention, and this app's own `skill_host/env.rs` precedent); MEDIUM on exact timeout numbers, which are UX decisions, not conventions

This is not a competitor feature-landscape survey - v1.1 adds no product features. It is a
survey of what "responsive and trustworthy" means as **observable, testable behavior** for
this class of app, organized around the four defect areas in scope. Each finding is phrased
so it can become a requirement of the form "user can observe X." Findings flagged **[UX
DECISION]** are not conventions - they need a product-owner call, not a research answer.

---

## 1. Long-running operations (PERF-01, PERF-02)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Async / invocation-id + event-stream pattern for anything reaching network, subprocess, or a large `WalkDir` | NN/g's three response-time limits (0.1s / 1s / 10s) are the standard UX baseline: under 1s needs no indicator, 1-10s needs an indeterminate busy indicator, over 10s needs a determinate percent-done indicator plus a way to interrupt. A 40s-measured WalkDir or a git clone/pull cannot promise a bound, so it must not run inline on the main thread at all - it must return immediately and report progress asynchronously. | MEDIUM per command | This app already has the exact reference implementation: `skills_env_bootstrap` (`src-tauri/src/skill_host/env.rs:52-143`) returns an `invocation_id` synchronously, does the work on `thread::spawn`, and streams `skills-env://output` / `skills-env://done` events. The 37 flagged commands should converge on this one pattern rather than inventing per-command variants - `async fn` alone (cheapest) suffices for commands with no visible duration; the event-streaming variant is for anything the user perceives as having duration (`skills_sync_source`, `today_calendar_publish`, `prepare_share_outbox_files`). |
| Triggering surface disabled while its own operation is in flight | Prevents duplicate concurrent invocation of a non-idempotent operation (e.g. a second `skills_sync_source` call while the first still holds `REGISTRY_LOCK`) and gives the user the "my click registered" feedback NN/g's 0.1s threshold is about. | LOW | Cheaper than a queue and matches the currently-shipped serialization already implied by the process-global locks - the bug is the *lock scope* (PERF-02), not the idea of serializing. |
| Failures surface through a durable, app-global channel, not a per-component promise | An async/streamed operation can finish after the component that started it has unmounted (user switched panes). A `.catch()` tied to that component's lifetime silently loses the error. | LOW | The codebase already has the right primitive: `errorStore` (`src/lib/errorStore.ts`), a module-slot store read via `useSyncExternalStore`, exists explicitly "so any component can raise or clear the toast without an onError prop drill" (PROJECT.md, Key Decisions). Route `skills-env://done { success: false }`-style event failures into it. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Streaming real subprocess stdout/stderr lines into the UI as they happen (not just a spinner) | Most apps show a generic spinner for a git clone; showing the actual clone progress lines is a stronger trust signal and costs nothing extra here. | LOW (already built) | `env.rs`'s `pump()` (`:179-201`) already does this for env bootstrap. Reusing it for `skills_sync_source`'s git clone/pull is close to free once the lock-scope fix (PERF-02) lands - this is the cheapest genuine differentiator in the milestone. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Spinner/progress UI on every converted command, including sub-100ms ones | "Make it feel responsive" gets over-applied uniformly | NN/g: under ~1s, an indicator is unnecessary and can itself feel laggy (a flash-then-gone spinner reads as jank). CONCERNS.md already notes "pure `read_dir` of a small config directory can stay sync." | Only commands whose *measured* worst case exceeds roughly 1s need any indicator; only those exceeding ~10s or with unbounded duration (network, subprocess) need the full invocation-id + event-stream treatment. |
| A cancel button that hides the UI state without actually terminating the underlying work | Feels like a quick win - flip a boolean, stop polling | Cosmetic cancellation is worse than no cancel button: the user believes the side effect stopped (a running git pull, a spawned Python process) when it did not. This is a direct trust regression, the opposite of this milestone's goal. | Cancellation is only offered where the backend can actually kill the underlying process/request (see §2's escalation ladder) - see Dependencies below. |
| Converting all 217 sync commands to async as a blanket policy | Simpler mental model ("everything is async now") | Adds thread-pool dispatch overhead and API surface churn for calls that already resolve in single-digit milliseconds; PROJECT.md's own scope explicitly rejects blanket conversions elsewhere (errors, path validators) for the same reason - cost without benefit. | Convert only the 37 commands with a measured or structurally-obvious blocking path (WalkDir/read_dir/subprocess/network in the first ~80 lines), per CONCERNS.md's own list. |

**[UX DECISION]** Whether any of the 37 commands gets a user-visible cancel affordance at all (vs. just moving off the main thread silently), and whether long syncs report through a toast/notification model or a blocking modal, is a per-surface product call for the requirements author - not something this research can assert generically.

---

## 2. Process and terminal session lifecycle (REL-01)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Kill targets the process **group**, not the single leader pid | A shell or agent CLI spawns children; signaling only the parent pid leaves orphans. Unix/systemd convention is process-group signaling for exactly this reason. | LOW-MEDIUM | The codebase already has the correct pattern *elsewhere*: `command_output.rs:404` spawns with `process_group(0)`, and `:543 terminate_unix_process_group` sends `SIGKILL` to `-pgid`. `terminal_kill` (`terminal/mod.rs:836-871`) is the one place that still signals a single pid with SIGHUP only - porting the existing pattern closes REL-01, no new primitive needed. |
| Escalation ladder: polite signal first, forced signal if it doesn't exit | Convention (systemd's `TimeoutStopSec`, Docker's stop-task, VS Code/most terminal emulators): SIGTERM (SIGHUP is the historical "your controlling terminal went away" signal, sent by default for backgrounded shells) to the group, wait a bounded timeout, then SIGKILL to the group if the process is still alive. SIGKILL cannot be trapped or ignored, so it is the only rung that is guaranteed to work. | MEDIUM | REL-01's specific failure mode - a child that traps SIGHUP survives forever - only happens because there is no second rung today. Any process that ignores rung 1 must hit an untrappable rung 2. |
| "Session is gone" is a single, verifiable state covering registry + OS process + stale handles | A session must not be able to reach "removed from the registry" while the OS process is still alive (leak), or "process reaped" while a stale frontend handle can still write into a *different, recycled* session. | MEDIUM | Ties directly to the existing generation-token invariant (`get_session_generation`, `mod.rs:887`) that PROJECT.md calls out as sacred: "Preserve the generation check on every session-scoped command; it is what stops a stale frontend handle writing into a recycled session." The kill fix must not weaken this - it should reuse the same `Arc::ptr_eq`-guarded removal already noted as a partial mitigation. |
| The `closing` flag is not a permanent one-shot latch | Today, once `closing` is set, the session can never be killed again - even after adding a second escalation rung, a session stuck between rungs must still be re-killable/re-escalatable, not permanently un-killable because a boolean was already flipped once. | LOW | Direct fix for the "session can never be killed again" half of REL-01's bug description. |

### Differentiators

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| UI reflects escalation state ("Closing..." → "Force closing...") instead of instant-then-silent | Most terminal wrappers fire-and-forget a kill signal with no visible state change; showing the user that escalation is happening is a stronger trust signal, especially for a session that resists the first rung. | LOW-MEDIUM | Optional polish on top of the table-stakes fix; not required to close REL-01, but cheap once the ladder exists. |

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| An unbounded or long (systemd default is 90s) wait for graceful exit before escalating | Feels "safer" - give the process every chance to clean up | This is a foreground, user-triggered "close this pane" action, not a service shutdown; a 90s hang reads as exactly the freeze this milestone exists to eliminate. | A short, bounded grace window before forced escalation - see [UX DECISION] below. |
| Relying on SIGHUP alone as the sole termination mechanism | It is the existing behavior and "usually works" | It is precisely today's bug: any process that installs a SIGHUP handler becomes immortal. | SIGHUP/SIGTERM to the process group, SIGKILL to the process group as the guaranteed second rung. |

**[UX DECISION]** The exact grace-period duration between the polite signal and the forced one (industry examples range from Docker's 10-30s default to systemd's 90s default, both far longer than a snappy interactive "close tab" expectation) and whether to prompt the user ("process not responding - force quit?") versus auto-escalate silently are product calls, not conventions this research can assert.

**Dependency:** If any long-running operation from §1 grows a real cancel button (subprocess-backed ops like `today_calendar_publish` or `prepare_share_outbox_files`), it should call into the *same* process-group kill primitive built for REL-01 rather than a second bespoke implementation - one kill code path, not two.

---

## 3. Unsaved-work durability (Scratchpad debounce flush)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Flush-on-unmount actually performs the pending save, not just clears the timer | The conventional contract for debounced autosave (Notion, Obsidian, VS Code auto-save) is: unmounting/closing the editing surface with a dirty buffer must not silently drop the last debounce window's edits. | LOW-MEDIUM | This is REL-02's exact bug: `ScratchpadPane`'s unmount cleanup (`:541-546`) calls `clearAutoSaveTimer()` only. Fix is to fire the same save path the timer would have fired, synchronously enough to complete before the component is gone (or fire-and-forget with a durable fallback - see recovery UI below). |
| App-quit is intercepted on the native side, not via browser `beforeunload` | Tauri's own tracked issues confirm `beforeunload` is unreliable inside its webview (does not fire on reload, not documented as guaranteed on quit). The Tauri-idiomatic equivalent is the Rust-side window `close-requested` event, which *can* delay or observe the close. | MEDIUM | Broader than the Scratchpad-only bug named in PROJECT.md - any pane with a pending debounced write (not just Scratchpad) is exposed to the same class of loss on quit. Should be a generic "flush all dirty buffers" hook fired from the Rust exit-requested handler, not a second bespoke per-pane listener. |
| A visible recovery path exists when the durable save did not land | If a flush genuinely cannot complete (storage full/unavailable, backend save fails), the user must be told, and get their content back on next open - never silent data loss. | LOW (already exists) | The codebase already does this well: `persistDraft`/`readScratchpadDraft` (`ScratchpadPane.tsx:547`, `:477`) plus a recovery-draft UI (`:1244`) is what CONCERNS.md calls "the right design." The gap being closed is narrow - the flush-on-unmount window where *neither* the local buffer *nor* the backend save has landed. Preserve the existing recovery UI; do not replace it. |

### Differentiators

None identified - this is a reliability floor, not a competitive feature. The existing draft-recovery UX (compare saved-vs-draft, let the user choose) is already better than "silently overwrite," which is common in simpler apps; the milestone's job is to close the one remaining gap, not add new UX here.

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Relying on `window.beforeunload` as the save-on-quit mechanism | It is the standard web-platform idiom | Documented as unreliable specifically inside Tauri's webview per Tauri's own GitHub issue tracker - it is not a safe primitive to build a data-loss guarantee on in this stack. | Rust-side `close-requested`/`ExitRequested` handling, which can genuinely gate or delay the exit. |
| Making localStorage the primary/durable save path | It is synchronous and simple | The codebase has already correctly rejected this ("Quota or unavailable storage must never block the backend autosave") - regressing into it would remove the one thing standing between a full quota and silent data loss today. | Keep localStorage as a bridge/recovery buffer only; the backend file save remains the source of truth. |
| Flushing the backend save synchronously on every keystroke to "solve" the gap | Removes the debounce race entirely | Defeats the purpose of debouncing - adds IO/CPU cost on every keystroke for a problem that only exists at two specific boundaries (unmount, quit). | Keep the 700ms debounce; only add explicit flush calls at unmount and at the native quit hook. |

**[UX DECISION]** Whether app-quit should visibly block/delay exit while flushing (a brief "Saving..." state) versus fire-and-forget best-effort flush is a real tradeoff between data safety and perceived quit speed - a product call, not a convention.

---

## 4. Security regression guard (SEC-02: DOMPurify sink guard)

### Table Stakes

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| A static check wired into `make verify` that fails the build if a new unsanitized `dangerouslySetInnerHTML` sink appears | CONCERNS.md's own finding is decisive here: v0.4.62 added a new sink (`InlineDocumentEditor.tsx:228`) that happened to be sanitized, and *nothing in the repo would have caught it if it were not* - there is no test matching `dangerouslySetInnerHTML` anywhere. Given this app renders untrusted third-party content (Telegram/Kakao/Gmail/Outlook/inbox drops) through a webview with full IPC authority, a sanitizer bypass is a local-code-execution path, not a defacement - this crosses from "nice to have" to table stakes. | LOW-MEDIUM | Shape it exactly as CONCERNS.md recommends: one `scripts/check-*.mjs` grep/AST guard, same family as the already-shipped `check-select-chrome.mjs`, checking that every `dangerouslySetInnerHTML` value traces to one of an explicit allowlist of sanitizer-backed helpers (`renderMarkdown` in `src/lib/markdown.ts`, `src/lib/scratchpad.ts`, `src/lib/diagram/richText.ts`, the `HwpxViewer` helper). Cheaper than a unit test, and matches the "no new frontend tooling" constraint. |

### Differentiators

None - this is table stakes for an app in this specific risk class (full IPC authority + untrusted external content), not a place to compete.

### Anti-Features

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|------------------|-------------|
| Adopting `eslint-plugin-react`'s blanket `react/no-danger` rule | It is the standard off-the-shelf lint rule for this class of risk | It flags all 7 legitimate, already-sanitized uses equally, forcing a `// eslint-disable-next-line` at every site - which trains contributors to reflexively silence exactly the warning meant to catch a regression. Strictly worse than a targeted allowlist check. | The narrow grep/allowlist guard above, which distinguishes "sanitized" from "unsanitized" rather than flagging the sink itself. |
| Introducing a new lint framework or ESLint plugin package just for this one check | Feels like the "proper" way to add a lint rule | The repo deliberately has no JS linter yet (CONCERNS.md, "Missing Critical Features"), and PROJECT.md explicitly excludes "a full lint style campaign" from this milestone's scope. Adding a linter dependency for a single check is scope creep into a different, larger decision. | One more `scripts/check-*.mjs` script, matching the existing pattern - zero new dependencies. |
| Generalizing the guard up front to cover every conceivable DOM-XSS sink (`document.write`, `insertAdjacentHTML`, future `<iframe srcDoc>`) | Thoroughness | None of those sink types exist in this codebase today; building detection for hypothetical future sinks is speculative scope with no current defect to fix. | Scope the guard to the 7 known `dangerouslySetInnerHTML` sites now; extend the pattern only when a second sink type actually appears. |

**Note for the requirements author:** SEC-02 is a build-time, developer-facing guard, not user-observable runtime behavior. It should not be phrased as "user can observe X" - it is closer to "CI/`verify` fails if a new unsanitized sink is introduced." Flagging this so it isn't miscast as a UX requirement alongside §1-3.

---

## Feature Dependencies

```
REL-01 (process-group kill + escalation ladder for terminal_kill)
    └──enables (shared primitive)──> §1's cancel-button guarantee for any
                                       subprocess-backed long operation
                                       (today_calendar_publish, prepare_share_outbox_files)

PERF-02 (narrow REGISTRY_LOCK critical section)
    └──enables (near-zero-cost add-on)──> §1's streaming-progress differentiator
                                            for skills_sync_source's git clone/pull

Scratchpad flush-on-unmount (local fix)
    └──independent of──> app-quit flush-on-close-requested (broader, backend-driven,
                          applies to every pane with a pending debounced write)

SEC-02 (dangerouslySetInnerHTML guard)
    └──independent of §1/§2/§3──> should land early since it is cheap and this
                                    milestone's own refactor work (moving code
                                    around) is the exact condition that produced
                                    the last near-miss (InlineDocumentEditor.tsx)
```

### Dependency Notes

- **REL-01 enables §1's cancel guarantee:** a cancel button on any subprocess-backed operation is only trustworthy if it actually terminates the underlying process. Build the process-group kill/escalation primitive once (for terminals), then reuse it for any operation from §1 that later grows a cancel affordance - do not build a second kill path.
- **PERF-02 enables §1's differentiator:** the streaming-stdout UX already exists (`env.rs`'s `pump()`); it becomes cheap to apply to `skills_sync_source` only once the lock is no longer held across the network round-trip, otherwise streaming progress from inside a lock that blocks every other skills operation would be misleading.
- **Scratchpad-unmount vs. app-quit flush are independent:** the unmount fix is scoped to one component; the quit-hook fix is backend-driven and generic across panes. They can be sequenced in either order, but the quit-hook fix has broader blast radius (fixing it once covers every current and future debounced pane, not just Scratchpad).
- **SEC-02 has no dependency on the other three** and is comparatively cheap - recommend sequencing it early precisely because the other three items involve moving/refactoring code (the exact activity that produced the last accidental-but-safe new sink).

---

## MVP Definition

This is a quality milestone, not a product launch, so "MVP" here means the minimum set of
observable-behavior changes that make each requirement (PERF-01/02/03/04, REL-01, SEC-01/02)
independently verifiable, per PROJECT.md's own framing: *"the milestone's own changes are
observable... each one needs evidence that the behavior changed in the intended
direction."*

### Must Land (v1.1)

- [ ] Async/event-stream conversion of the 37 flagged commands, using the existing `env.rs` pattern - the behavioral floor for PERF-01
- [ ] `skills_sync_source` narrows its critical section so the network round-trip is outside `REGISTRY_LOCK` - PERF-02
- [ ] Process-group SIGTERM/SIGKILL escalation for `terminal_kill`, with registry cleanup and generation-token guarantees preserved - REL-01
- [ ] Scratchpad flush-on-unmount performs the actual pending save - closes the named 700ms gap
- [ ] `scripts/check-*.mjs` DOMPurify-sink guard wired into `verify` - SEC-02

### Add If Cheap, Same Milestone (v1.1, opportunistic)

- [ ] Streaming subprocess output for `skills_sync_source`'s git clone/pull (near-free once PERF-02 lands)
- [ ] Generic "flush dirty buffers on native quit" hook via `close-requested`, generalized beyond Scratchpad

### Explicitly Deferred (out of v1.1 scope per PROJECT.md)

- [ ] Cancel affordances (UI) for any of the 37 converted commands - moving work off the main thread does not require exposing a cancel button; that is a separate [UX DECISION]
- [ ] ERR-05's closed-enum emission-site enforcement - developer-facing correctness gap, not user-felt
- [ ] Any new lint framework/dependency for the DOMPurify guard - one grep script suffices

---

## Confidence Assessment

| Finding | Confidence | Basis |
|---------|------------|-------|
| NN/g 0.1s/1s/10s response-time thresholds | HIGH | Long-established, widely-cited UX research (Nielsen Norman Group) |
| Process-group signal escalation (SIGTERM/SIGKILL over single-pid, SIGKILL untrappable) | HIGH | Convergent convention across systemd, Docker, and this app's own existing `command_output.rs` implementation |
| Exact grace-period duration between escalation rungs | MEDIUM - flagged as [UX DECISION] | Industry examples vary 10-90s for service shutdown; none of them fit an interactive "close this tab" action directly |
| `beforeunload` unreliability inside Tauri's webview | MEDIUM-HIGH | Corroborated by multiple Tauri maintainer-tracked GitHub issues, not a single source |
| Invocation-id + event-stream as the target pattern for this app specifically | HIGH | Directly read from this app's own shipped code (`skill_host/env.rs`), not an external convention |
| DOMPurify-sink guard shape | HIGH | Directly read from CONCERNS.md's own recommendation, which is already specific and actionable |

## Gaps to Address

- No industry-standard number exists for "how long before a PTY session's polite-kill escalates to forced-kill" specific to interactive desktop terminals (as opposed to services) - this needs a product decision, flagged above.
- Whether app-quit flush should be blocking (delay exit) or best-effort is unresolved by convention and needs a product call.
- Whether any of the 37 converted commands warrant a user-visible cancel button is a per-command judgment call for the requirements author, not resolvable generically here.

## Sources

- [Response Time Limits: Article by Jakob Nielsen - NN/G](https://www.nngroup.com/articles/response-times-3-important-limits/)
- [Progress Indicators Make a Slow System Less Insufferable - NN/G](https://www.nngroup.com/articles/progress-indicators/)
- [TIL systemd sends SIGKILL signals after waiting for 'TimeoutStopSec' seconds](https://til.codeinthehole.com/posts/systemd-sends-sigkill-signals-after-waiting-for-timestopsec-seconds/)
- [systemd.kill - freedesktop.org manual](https://www.freedesktop.org/software/systemd/man/latest/systemd.kill.html)
- [SIGINT vs. SIGTERM vs. SIGKILL](https://thecodinggopher.substack.com/p/sigint-vs-sigterm-vs-sigkill)
- [Cant't listen event 'tauri://close-requested' or 'tauri://destroyed' · Issue #2996 · tauri-apps/tauri](https://github.com/tauri-apps/tauri/issues/2996)
- [[docs] Improve Documentation for Event Subscriptions and Memory Management in @tauri-app/api · Issue #12388 · tauri-apps/tauri](https://github.com/tauri-apps/tauri/issues/12388)
- `/Users/yj.lee/workspace/work/dev/maru/.planning/codebase/CONCERNS.md` (in-repo, primary source for all defect specifics)
- `/Users/yj.lee/workspace/work/dev/maru/src-tauri/src/skill_host/env.rs` (in-repo, the invocation-id + event-stream precedent)
- `/Users/yj.lee/workspace/work/dev/maru/.planning/PROJECT.md` (in-repo, milestone scope and constraints)

---
*Feature research for: Maru v1.1 Felt Quality and Native Proof*
*Researched: 2026-08-28*
