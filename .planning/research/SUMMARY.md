# Project Research Summary

**Project:** Maru v1.1 "Felt Quality and Native Proof"
**Domain:** Quality/reliability milestone for a shipped, signed Tauri 2.10 + React 19 + Rust desktop app (no new product features)
**Researched:** 2026-08-28
**Confidence:** MEDIUM overall — HIGH on everything grounded in this repo's own code and on Tauri/Vite documented semantics, MEDIUM-to-LOW on macOS native-automation tooling for TEST-01, which is this milestone's single highest-risk open question

## Executive Summary

v1.1 closes seven concrete defects in a shipped app rather than adding features: 37 sync Tauri commands blocking the main thread (PERF-01), a skills-registry lock held across a network call (PERF-02), six process-global mutexes that brick their feature on any panic (PERF-03), filesystem watchers that don't prune generated directories (PERF-04), a PTY kill path that a SIGHUP-trapping child can survive (REL-01), a Scratchpad autosave flush that only clears its timer instead of performing the save (the 700ms-loss bug), and a `dangerouslySetInnerHTML` sink with no regression guard (SEC-02), plus a CSS-bundling cleanup and non-gating coverage tooling. Every recommendation across all four research passes is mechanical and grounded directly in code this repo already runs elsewhere — `skill_host/env.rs`'s invocation-id + event-stream pattern, `command_output.rs`'s process-group SIGKILL escalation, `skill_host/fs.rs`'s `into_inner()` poisoning-recovery idiom, and `check-select-chrome.mjs`'s grep-guard shape are all existing precedents to port, not new architecture to invent.

The recommended approach: land the native E2E runner (TEST-01) first, because it is the only way to observe the real behavioral changes PERF-01/02/03 and REL-01 produce in the real Rust backend — the existing mocked-IPC Chromium suite never calls it. Then do PERF-03+PERF-04 (mechanical, small), then PERF-02 (rewrites the same file PERF-03 touches, so it must go after), then PERF-01 (benefits from TEST-01 existing to prove commands actually left the main thread), then REL-01 (hard-depends on TEST-01 — only a real PTY can trap SIGHUP). Everything else (Scratchpad flush, SEC-01/02, CSS split, coverage tooling) has no native dependency and can thread through in parallel.

The two largest risks are not "will the fix work" but "will the change be silently wrong in a way nothing catches." First: converting sync commands to `async fn` is a real concurrency-model change — 217 commands are currently serialized on the main thread with zero real contention, so this milestone introduces genuine multi-threaded races for the first time; and a "converted" command that still blocks inline inside `async fn` doesn't fix anything, it just relocates the freeze to Tauri's shared async worker pool with no passive warning sign — it must be actively load-tested, not just observed to no longer freeze the UI. Second: TEST-01 itself is not settled. STACK.md found a real, free, embedded WebDriver path (`@wdio/tauri-service`) that plausibly runs unattended on hosted macOS GitHub Actions runners; PITFALLS.md and ARCHITECTURE.md both independently concluded TEST-01 is very likely a human-attended local tool, not a CI gate, because the macOS Accessibility/TCC permission wall cannot be scripted on an ephemeral hosted runner. This tension is not fully resolved by research and needs a spike, detailed below.

## Key Findings

### Recommended Stack

No new frameworks. The four gaps this milestone closes at the tooling level: (1) native macOS e2e coverage via `@wdio/tauri-service`'s embedded provider (`tauri-plugin-wdio-webdriver`, dev-dependency only, never ships in the release bundle) — MEDIUM confidence, not yet tested against this repo's CI; (2) non-gating coverage measurement via `@vitest/coverage-v8` (TS) and `cargo-llvm-cov` (Rust), wired as separate `make coverage`/`make coverage-rust` targets outside `make verify`; (3) `src/styles.css` (26k lines) split into per-mode files using Vite's already-default `cssCodeSplit: true` — a plain `import "./mode.css"` inside each lazy-loaded pane module, no config change, no plugin. Explicitly rejected: any new state library, Tailwind/CSS framework, `cargo-tarpaulin`, Codecov/Coveralls, a second `vitest.config.ts`, `@crabnebula/tauri-driver` (paid, macOS-gated), and Playwright for the native suite (it drives its own managed browser binaries, not the app's real WKWebView/IPC/PTY).

**Core technologies:**
- `@wdio/tauri-service` (embedded provider) — native macOS WKWebView e2e — MEDIUM confidence, free, no signing needed, but scope (CI vs. local) is the milestone's open question
- `@vitest/coverage-v8` / `cargo-llvm-cov` — non-gating coverage reporting — HIGH confidence, straightforward wiring, kept explicitly outside `make verify`
- Existing Vite `cssCodeSplit` default — CSS code splitting — HIGH confidence, mechanical, no dependency added

### Expected Features

This is a reliability floor, not a feature landscape — findings are phrased as observable behavioral contracts, not competitive features.

**Must have (table stakes):**
- Async/event-stream pattern (already proven in `skill_host/env.rs`) for any command reaching network, subprocess, or unbounded filesystem work — under NN/g's 1s/10s response-time thresholds
- Triggering surface disabled while its own operation is in flight; failures surface through the existing `errorStore`, not a per-component promise that can be lost on unmount
- Process-group signal escalation (polite signal, then untrappable SIGKILL to the group) for `terminal_kill`, reusing `command_output.rs`'s existing pattern
- A single, verifiable "session is gone" state that preserves the existing generation-token invariant
- Flush-on-unmount that actually performs the pending save, not just clears the timer; a Rust-side `close-requested` hook is the correct app-quit mechanism, not `beforeunload` (documented unreliable inside Tauri's webview)
- A static grep/allowlist guard wired into `make verify` that fails the build on a new unsanitized `dangerouslySetInnerHTML` sink (mirrors `check-select-chrome.mjs`'s shape)

**Should have (differentiators, mostly already free):**
- Streaming real subprocess stdout into the UI for `skills_sync_source`'s git clone/pull, once PERF-02's lock-narrowing lands (near-zero incremental cost, reuses `env.rs`'s `pump()`)
- UI reflecting kill-escalation state ("Closing..." → "Force closing...") — optional polish on top of the table-stakes fix

**Defer (out of v1.1 scope):**
- Cancel-button UI for any of the 37 converted commands — moving work off the main thread does not require exposing cancel
- ERR-05 closed-enum enforcement (developer-facing, not user-felt)
- Any new lint framework for the DOMPurify guard — one grep script suffices
- Blanket `into_inner()` recovery beyond the six named locks

### Architecture Approach

The five v1.1 mechanisms attach to the existing 356-command IPC layer without changing its shape: PERF-01 is an attribute-only change (`(async)` on unchanged sync fns) for the overwhelming majority of the 37 offenders, following an already-proven in-repo pattern (`drafts_promote`, `git_sync_commit_push`, the `inbox.rs` approval commands); PERF-02 restructures one function (`skills_sync_source_impl`) to release the lock across the network call and re-validate on re-acquire, following the CAS pattern already used in `document.rs`/`evidence_binder.rs`; PERF-03 applies `into_inner()` poisoning recovery, already proven at `skill_host/fs.rs:216`, to six specific mutexes; REL-01 ports `command_output.rs`'s process-group SIGKILL escalation to the PTY kill path. TEST-01 sits beside all of this as a new, separate native test project — not folded into the existing mocked-IPC Playwright suite, and (per ARCHITECTURE.md's reading) wired as a new local-only `make` target following the `verify-integration` precedent, not a new required CI job.

**Major components:**
1. `src-tauri/src/skill_host/store.rs`, `today_calendar.rs`, `share_outbox.rs`, `launchd_migration.rs` — attribute-only PERF-01 conversions
2. `skills_sync_source_impl` (`store.rs:566-598`) — PERF-02's lock-narrowing restructure
3. Six process-global mutexes (`REGISTRY_LOCK`, `JOBS_LOCK`, `DOT_ACTION_LOCK`, `BINDER_WRITE_LOCK`, terminal `sessions`/`reservations`/`killer`) — PERF-03's poisoning-recovery idiom
4. `terminal/mod.rs`'s `terminal_kill` — REL-01's process-group escalation target
5. New native E2E runner (script + fixtures + `make` target) — TEST-01, additive, does not touch `e2e/*.spec.ts`

### Critical Pitfalls

1. **`async fn` is not `spawn_blocking` — a "converted" command can still starve everything else, with no passive warning sign.** A command marked `async` that still runs a synchronous `WalkDir`/`read_dir`/`Child::wait()` inline blocks Tauri's shared async worker pool instead of the main thread — the UI stops freezing, so the naive fix looks like it worked, but every other in-flight IPC command can now stall. Must be actively load-tested (fire several converted commands concurrently and check an unrelated command's latency), not passively observed.
2. **217 previously-serialized commands become genuinely concurrent for the first time this milestone.** Locks that were "never contended" only because nothing else could run at the same time (single main-thread execution) become real contention points the instant any of the 37 commands go async; any frontend code that fired command A then B assuming A's write landed first can now race. Check every calling component for two `invoke` calls relying on ordering before converting the commands they touch.
3. **PERF-02's lock-narrowing reintroduces the exact TOCTOU window the lock existed to prevent** unless the re-acquired write reloads the registry fresh and re-validates the source still exists — a naive re-acquire-and-write-back can silently resurrect a source the user just removed or clobber a concurrent edit.
4. **`into_inner()` poisoning recovery is correct for re-derivable state and silently wrong for invariant-bearing in-memory state.** All six PERF-03 locks are argued safe, but for two different reasons (pure on-disk-cache mutexes vs. collections this codebase already tolerates staleness in) — apply per-lock justification, not a blanket six-way copy-paste, and do not extend it to locks outside the named six (e.g. `TerminalModel`, whose torn state would be a real correctness bug).
5. **A failed unmount-triggered Scratchpad flush has no detectable warning sign today.** `setLocalError`/`errorStore` calls from a teardown path may update a store nothing is rendering; there is no console log, no toast, no test failure — only a user who reopens later and finds the edit silently missing. This is a residual gap that needs an explicit accept-or-mitigate decision, not an implicit byproduct of the unmount fix.

## The TEST-01 Disagreement (Highest-Risk Open Item)

The four research passes do **not** converge on whether the native E2E runner is a CI gate or a human-attended local tool, and this materially changes the scope of the phase that owns it.

**STACK.md's position (MEDIUM confidence):** `@wdio/tauri-service`'s embedded provider (`tauri-plugin-wdio-webdriver`, a Rust crate compiled into a debug build) runs a WebDriver-compatible HTTP bridge *inside the WKWebView process itself*. No external driver binary, no code signing, no notarization — it can genuinely drive a real WKWebView on a hosted `macos-14`/`macos-15` GitHub Actions runner, unattended. This is published (3 weeks old at research time) via the `webdriverio/desktop-mobile` org repo, MIT-licensed, and its version numbers were verified live against npm/crates.io. It has **not been tested against this repo's actual CI**.

**PITFALLS.md's position (LOW-MEDIUM confidence):** Apple ships no WebDriver for WKWebView; any automation approach that needs the macOS Accessibility/TCC permission (menu bar, native dialogs, and — depending on implementation — the webview driver itself) requires a one-time interactive System Settings grant that cannot be scripted, and hosted GitHub Actions macOS runners are fresh ephemeral VMs every run with nobody there to click it. Combined with this milestone's own stated CI reality ("macOS-native changes ship unverified by CI — validate by running the real app"), PITFALLS.md concludes TEST-01 is "very likely a human-attended local tool rather than a CI gate" and recommends scoping it as its own early spike before any downstream phase writes a verification step assuming "TEST-01 runs in CI."

**ARCHITECTURE.md's position:** Observes that both `make verify` and the existing `e2e` job pin `runs-on: ubuntu-22.04` in `.github/workflows/ci.yml`, and that this codebase already has a precedent for exactly this situation — `verify-integration` (`Makefile:216-223`), a real gate explicitly excluded from `verify` with the comment "a merge gate that fails on an expired token is a gate people learn to bypass." ARCHITECTURE.md argues the architecturally honest answer is a new local-only `make test-e2e-native` target wired into the existing `release-preflight` chain, matching that precedent — not a new required CI job, at least not without first proving a genuinely scriptable subset exists.

**Why these are not strictly contradictory, but do lead to different phase scopes:** `@wdio/tauri-service`'s embedded provider is a third-party claim about what's technically reachable on a hosted runner without a native dialog (it drives the DOM/JS/screenshots inside the webview process, which per STACK.md's own analysis does not obviously require the Accessibility/TCC permission that blocks menu-bar/native-dialog automation specifically). PITFALLS.md's TCC argument is strongest against *Accessibility-API-based* automation (menu bar, native dialogs) and weaker — untested — against an *embedded-in-webview* driver that never calls the Accessibility API at all. It is possible both are correct simultaneously: the DOM/WKWebView/PTY-via-canvas-screenshot surface may run unattended on hosted CI via the embedded provider, while the native menu bar surface stays a human-attended local gate regardless of which tool drives the rest.

**What a spike would have to demonstrate to settle this:** actually stand up `@wdio/tauri-service` with the embedded provider against a debug build of this app on a hosted `macos-14`/`macos-15` GitHub Actions runner, unattended, and confirm (a) the WebDriver session establishes without any interactive permission prompt, (b) it can read the real PTY output via canvas screenshot assertion (not DOM query — `NativeTerminalView.tsx` renders to `<canvas>`), and (c) it survives a full CI run without a human present. If that succeeds, a scriptable CI-gated subset genuinely exists and TEST-01 can be split into a CI-gated webview/PTY-screenshot suite plus a separate human-attended local suite for the menu bar. If it fails (a hidden TCC prompt, a build-signing snag, or an unreachable canvas pixel), TEST-01 collapses to PITFALLS.md's and ARCHITECTURE.md's shared conclusion: one local-only `make` target wired into `release-preflight`, run by a human. Budget this spike as the first slice of TEST-01's owning phase, not discovered mid-implementation — both PITFALLS.md and ARCHITECTURE.md independently flag this as the highest-uncertainty piece of the whole milestone, and IME composition (Pitfall 19: synthetic key events never exercise real OS-level IME) is a second, related sub-spike that needs its own verification regardless of which path TEST-01 takes for the webview driver.

## Scope Question: Does the Scratchpad Flush Requirement Cover App-Quit?

FEATURES.md and PITFALLS.md agree on the mechanism but flag the same scope ambiguity from different angles. FEATURES.md states plainly that `beforeunload` is documented-unreliable inside Tauri's webview (does not fire on reload, not guaranteed on quit per Tauri's own tracked issues), and that durable app-quit flush requires the Rust-side `close-requested`/`ExitRequested` event, which can genuinely delay or observe the close — and frames this as broader than the Scratchpad-only bug named in PROJECT.md, since any pane with a pending debounced write is exposed to the same loss class on quit.

PITFALLS.md sharpens this into an explicit blocking question: a `useEffect` cleanup function is synchronous and React does not await its return value, so "flush on unmount" (the requirement's literal phrasing) can only ever be as strong as fire-and-forget — it can adequately cover the pane-switch/mode-change case (the app keeps running long enough for the promise to usually complete) but cannot, by construction, guarantee anything about the user quitting the app entirely, which is a different lifecycle needing a separately awaited native handler. CONCERNS.md's own phrasing ("switch modes, close the pane, or change workspace") plausibly reads as covering both cases, but the plan must decide explicitly rather than let an unmount-only fix silently leave the app-quit path as an unstated accepted gap. **This needs an explicit scope decision in the phase plan** before implementation, since the fix shape differs materially by scope (React-only effect vs. a new backend-driven quit hook).

## Implications for Roadmap

### Phase 1: Native E2E Runner (TEST-01)
**Rationale:** Hard sequencing dependency — the mocked-IPC Chromium suite never calls the real Rust backend, so PERF-01/02/03's freeze-avoidance/poisoning-survival claims and REL-01's "a SIGHUP-trapping child can still be killed" are unverifiable without it. PROJECT.md itself records "the native E2E runner lands early, not as closeout."
**Delivers:** A working native test harness (scope TBD by spike — see disagreement above) and a settled answer to the CI-vs-local question.
**Addresses:** TEST-01
**Avoids:** Pitfalls 16-20 (no first-party WKWebView driver, TCC permission wall, signed-vs-debug-build divergence, synthetic-key-vs-real-IME gap, native-specific flake sources)
**First task within this phase:** the CI-viability spike for `@wdio/tauri-service`'s embedded provider, and a separate IME-composition spike — both flagged by research as too uncertain to plan around without proving them first.

### Phase 2: PERF-03 (lock poisoning recovery) + PERF-04 (watcher pruning), together
**Rationale:** Both are small and mechanical, with no structural dependency on TEST-01, and doing PERF-03 before PERF-02 means PERF-02's rewrite is written against the final `registry_guard()` rather than being rebased mid-flight.
**Delivers:** `into_inner()` recovery on the six named locks (each with its own one-line justification, not a blanket pass) and `GENERATED_DIRS` filtering on the four watcher modules (with `ops_catalog/watcher.rs`'s separate watch-handle-count question explicitly called out as in-scope-or-not, not silently folded into the same fix).
**Uses:** the proven `fs.rs:216` idiom
**Avoids:** Pitfall 5 (blanket `into_inner()` misapplication), Pitfall 6 (event-filtering vs. watch-handle-count conflation)

### Phase 3: PERF-02 (narrow the skills registry lock)
**Rationale:** Depends on Phase 2's `registry_guard()` being final; independent of PERF-01.
**Delivers:** `skills_sync_source_impl` restructured so the network pull runs outside `REGISTRY_LOCK`, with fresh-reload-and-re-validate on re-acquire.
**Avoids:** Pitfall 4 (TOCTOU window from an unconditional write-back)

### Phase 4: PERF-01 (37-command migration)
**Rationale:** Benefits from TEST-01 existing so converted commands can be shown to actually leave the main thread in the real app; sequencing after PERF-02/03 avoids touching `skill_host/store.rs` three times across overlapping phases.
**Delivers:** Per-command `(async)` attribute additions (the mechanical majority) plus any genuine `async fn`/`spawn_blocking` cases identified by the decision rule, verified with a concurrent-invocation timing assertion, not just "no longer freezes."
**Addresses:** the async/event-stream table-stakes findings from FEATURES.md §1
**Avoids:** Pitfalls 1-3 (concurrency-model shift, `async fn`-not-`spawn_blocking`, the compile-time-vs-runtime-only failure table)

### Phase 5: REL-01 (PTY process-group kill escalation)
**Rationale:** Hard-depends on TEST-01 — a Chromium-mocked spec cannot spawn a real child that traps SIGHUP, so REL-01's own success criterion is only checkable through the native runner.
**Delivers:** Timeout-gated SIGHUP-then-SIGKILL-to-process-group escalation on `terminal_kill`, `#[cfg(unix)]`-gated, preserving the documented "backgrounded grandchild survives shell exit" behavior.
**Avoids:** Pitfalls 7-10 (portable_pty vs. std::process::Child kill-surface mismatch, blanket-kill regressing detached-grandchild survival, pid/pgid reuse race, Windows must not be touched)

### Phase 6 (or threaded through any/all of the above, no ordering constraint): everything else
**Rationale:** No native dependency and no cross-dependency on each other — Scratchpad flush (with the app-quit scope decision made explicit first), SEC-01 (CSP `blob:` audit, verified via the packaged bundle not just source grep — Pitfall 14), SEC-02 (DOMPurify grep guard, designed with the `EditorPane.tsx` allowlist exception from day one — Pitfall 15), the CSS split (one mode at a time with a geometry-assertion gate per split, not a single big-bang split — Pitfalls 21-22), and non-gating coverage tooling.
**Delivers:** Independently verifiable behavioral fixes and tooling additions.

### Phase Ordering Rationale

- TEST-01 first because it's the only observability mechanism for everything else's actual behavioral claims (ARCHITECTURE.md's Build Order §Q5, corroborated by PROJECT.md's own recorded decision).
- PERF-03 before PERF-02 to avoid rebasing a lock-narrowing rewrite around a mid-flight recovery-idiom change to the same file.
- PERF-01 after PERF-02/03 to avoid touching `skill_host/store.rs` in three overlapping phases.
- REL-01 last among the "real" phases because it hard-depends on TEST-01 (only a real PTY can trap SIGHUP) and has no other cross-dependency.
- Everything in Phase 6 is genuinely independent per FEATURES.md's dependency graph, except that SEC-02 is comparatively cheap and should land early precisely because the milestone's own refactor work (moving code around) is the exact condition that produced the last accidental-but-safe new `dangerouslySetInnerHTML` sink.

### Research Flags

Phases likely needing deeper research during planning:
- **Phase 1 (TEST-01):** The core open question of this milestone — CI-vs-local scope is unresolved by research and needs the spike described above before the phase's verification criteria can be written meaningfully. IME composition is a second sub-spike.
- **Phase 5 (REL-01):** Needs to verify portable_pty's actual Unix spawn behavior (session/process-group setup) before assuming `command_output.rs`'s `process_group(0)` pattern ports over unchanged (Pitfall 7) — a quick source/docs check, not a full research pass, but flagged since an incorrect assumption here changes the implementation shape.

Phases with standard patterns (skip research-phase):
- **Phase 2 (PERF-03/PERF-04):** Mechanical, pattern already proven in-repo at `fs.rs:216`.
- **Phase 3 (PERF-02):** CAS pattern already proven in-repo at `document.rs`/`evidence_binder.rs`.
- **Phase 4 (PERF-01):** Decision rule and all four dispatch options already proven in-repo with cited examples for each.
- **Phase 6 (Scratchpad/SEC/CSS/coverage):** All mechanisms (native quit hook, grep-guard shape, CSS-chunk-follows-JS-import, coverage tool wiring) are either already-documented Tauri/Vite semantics or already-proven in-repo patterns.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | MEDIUM | Package versions verified live against npm/crates.io (HIGH for those specifics); the macOS-CI-viability claim for `@wdio/tauri-service` is cross-checked across sources but explicitly not yet tested in this repo's CI |
| Features | HIGH overall, MEDIUM on exact timeout/UX numbers | Grounded in NN/g response-time research, systemd/Unix signal convention, and this app's own `env.rs` precedent; grace-period duration and app-quit blocking-vs-fire-and-forget are explicitly flagged as [UX DECISION], not researchable conventions |
| Architecture | HIGH | Every claim grounded in code read at a specific commit tree plus current Tauri 2 official docs, not recalled from training data |
| Pitfalls | HIGH for repo-grounded claims, MEDIUM for Tauri/React/Vite runtime-semantics claims, LOW-MEDIUM explicitly for macOS native-automation tooling (Pitfalls 16-20) | The pitfalls document is explicit about which confidence level applies to which cluster; macOS automation is called out as the one area research could not verify against primary docs |

**Overall confidence:** MEDIUM — high confidence on the mechanical fixes (PERF-01/02/03/04, REL-01, SEC-02, CSS split), low-to-medium confidence on TEST-01's exact shape until the spike runs.

### Gaps to Address

- **TEST-01 CI-vs-local scope** (see dedicated section above): resolve via a spike in Phase 1 before writing that phase's verification criteria as fact.
- **App-quit inclusion in the Scratchpad flush requirement** (see dedicated section above): needs an explicit human scope decision before implementation, not an assumption baked into the fix shape.
- **SIGTERM-to-SIGKILL grace period** for `terminal_kill`'s escalation ladder: no industry-standard number exists for an interactive desktop terminal (as opposed to a service); flagged [UX DECISION] in FEATURES.md, needs a product-owner call, not more research.
- **Whether any of the 37 converted commands warrants a user-visible cancel affordance:** explicitly deferred to a per-command judgment call for the requirements author, not resolvable generically.
- **portable_pty's actual process-group setup at spawn time** (Pitfall 7): needs a quick source-read confirmation before REL-01 implementation, not a full research pass.

## Sources

### Primary (HIGH confidence)
- This repo, read directly at commit tree `a938128`+: `src-tauri/src/skill_host/{store.rs,env.rs,fs.rs}`, `src-tauri/src/terminal/mod.rs`, `src-tauri/src/command_output.rs`, `src-tauri/src/document.rs`, `src-tauri/src/evidence_binder.rs`, `src-tauri/src/jobs.rs`, `src-tauri/src/dot_sync.rs`, `Makefile`, `.github/workflows/ci.yml`, `src/components/NativeTerminalView.tsx`
- `.planning/codebase/ARCHITECTURE.md`, `.planning/codebase/CONCERNS.md`, `.planning/PROJECT.md` — in-repo source of the defect list and milestone scope, independently re-verified against current source each research pass
- `https://v2.tauri.app/develop/calling-rust/`, `https://v2.tauri.app/develop/tests/webdriver/ci/` — official Tauri 2 docs
- `docs.rs/tauri/latest/tauri/{async_runtime,test}/` — official docs.rs reference
- `npm view` / `cargo search` / `cargo info` — live registry queries for all cited package versions
- `https://vite.dev/config/build-options`, `https://vite.dev/guide/features` — official Vite docs on `cssCodeSplit`

### Secondary (MEDIUM confidence)
- `https://webdriver.io/docs/desktop-testing/tauri/platform-support/`, `https://webdriver.io/docs/wdio-tauri-service/` — WebdriverIO official docs, cross-checked but not hands-on tested in this repo's CI
- `https://github.com/webdriverio/desktop-mobile` — source repo for `@wdio/tauri-service`/`tauri-plugin-wdio-webdriver`
- `https://github.com/actions/runner-images` issues #553, #1567, #3286, #8214 — TCC/Accessibility permission blocker on hosted macOS runners, multiple independent long-running threads
- [Response Time Limits — NN/G](https://www.nngroup.com/articles/response-times-3-important-limits/), [Progress Indicators — NN/G](https://www.nngroup.com/articles/progress-indicators/)
- systemd/Docker signal-escalation convention sources (`freedesktop.org` systemd.kill manual, TIL/blog posts on SIGKILL timeout behavior)
- Tauri GitHub issues #2996, #12388 — `close-requested`/`beforeunload` reliability inside Tauri's webview

### Tertiary (LOW-MEDIUM confidence)
- `https://danielraffel.me/...` blog post and `github.com/Choochmeque/tauri-webdriver` — community precursors to the now-official embedded WebDriver provider, used only to establish the pattern predates the official release
- macOS native-automation tooling generally (Pitfalls 16-20 in PITFALLS.md) — explicitly flagged LOW-MEDIUM, the one area this research could not fully verify against primary documentation

---
*Research completed: 2026-08-28*
*Ready for roadmap: yes — with the explicit caveat that Phase 1 (TEST-01) opens with a spike, not a fixed plan*
