# Phase 9 - PR #361 Code Review Fix Pass

> Not a new plan. This is a review-fix pass on `fix/phase-9-durability` (issue #353) addressing
> the code-review findings the orchestrator confirmed in PR #361. Each finding below records what
> was found, its root cause, the fix, the tests added, and how it was verified.

---

## Finding 1 (IMPORTANT): stale retry overwrites newer content

**File:** `src/lib/debouncedSave.ts` (`createDebouncedSaver`'s catch block, ~line 94)

**What was found:** A failed save's retry-preservation check only tested `!hasPending`. Sequence:
save A starts (drains, in flight); B is scheduled behind it; B's own debounce timer fires and
drains B too (queued behind A in the shared save queue, since A hasn't settled yet); at this
point `hasPending` is already `false` again (B's drain reset it); A then rejects. A's catch
handler sees `hasPending === false` and re-arms `pending = A`. B's save lands correctly on disk,
but the next `flushSettled()` (unmount or app quit) finds `hasPending === true`, re-drains the
stale A, and calls `save(A)` again, overwriting B's already-persisted content with A's stale
value.

**Root cause:** `hasPending`/`pending` are single mutable slots representing "the debounce
timer's own un-drained value." The catch handler used them to answer a different question,
"has anything newer superseded me since I started?", which they cannot answer once a newer
value has already been drained (not merely scheduled).

**Fix:** Stamp every drain with a monotonically increasing sequence number (`nextDrainSeq`/
`latestDrainSeq`). A failed save's catch handler now resurrects its own value only when
`!hasPending && seq === latestDrainSeq`, i.e. this drain is still the most recently dispatched
one. A drain that has already been superseded by a newer one (even if that newer one was
generated behind the failing save in the shared queue, not merely scheduled) is never resurrected.

**Tests:** RED then GREEN, per TDD:
- RED: `test(09-review): add failing test for stale retry overwriting a newer drained save`
  (`32c75cd2`), reproduces the exact A-in-flight / B-drained-behind-A / A-fails sequence and
  asserts disk content ends with `"B"`; fails on unfixed code (asserts `"A"` landed via the
  resurrected retry).
- GREEN: `fix(09-review): stamp drains so teardown flush never resurrects a stale retry over a
  newer save` (`aa53b059`).
- All 6 pre-existing `debouncedSave.test.ts`/`teardownSave.test.ts`/`ScratchpadPane.test.tsx`
  suites (74 tests total) still pass unchanged.

---

## Finding 2 (IMPORTANT): Cmd+Q dead or partial with the skill editor window open

**Files:** `src-tauri/src/app_menu.rs` (`handle_menu_event`, ~line 342), `src/components/skills/
SkillEditorWindow.tsx` (~line 258), `src/lib/useDestructiveActionGuard.ts`, `src/lib/
windowLayout.ts`, `src/lib/skillEditorEvents.ts`, `src/App.tsx`

**What was found:**
1. Menu commands were dispatched to whichever window had OS focus. When the skill editor window
   had focus, `app.quit` reached its JS runtime, which only recognizes `file.close_active`/
   `window.close` and silently drops everything else, so Cmd+Q went dead.
2. Quitting from `main` (via `requestWindowClose()`) only closed `main`. The skill editor (and any
   terminals it might keep alive indirectly through the still-running process) stayed open, and
   the exit sweep (`terminal::shutdown_all_sessions` on `RunEvent::ExitRequested`) never ran
   because the process never actually exited.

**Root cause:** Two independent gaps stacked: (a) Rust routed by focus with no special case for a
command that must reach a specific window regardless of focus, and (b) there was no orchestration
anywhere that asked every open window's own guard before deciding whether the whole app should
exit; `requestWindowClose()` (shared by the red button, Cmd+W, and previously Cmd+Q) only ever
closed the one window it was called on.

**Fix (D-03 extension, "one quit path" now covers every window):**
- `app_menu.rs`: extracted the routing decision into a pure `menu_command_target(id,
  focused_label)` function. `app.quit` always resolves to `MenuCommandTarget::Label("main")`
  regardless of focus; every other command keeps the existing focused-window-or-broadcast
  behavior.
- `src/lib/skillEditorEvents.ts`: two new events, `SKILL_EDITOR_QUIT_CHECK_EVENT`/
  `_RESPONSE_EVENT`.
- `SkillEditorWindow.tsx`: answers a quit-check request through the same dirty-draft guard/confirm
  copy as its own `onCloseRequested`, but only reports `{ proceed }`; it never destroys itself in
  response.
- `windowLayout.ts`: `requestSkillEditorQuitCheck()` (asks, awaits one response, resolves `true`
  immediately if the window isn't open) and `closeSkillEditorForQuit()` (destroys it, called only
  once every guard has passed).
- `useDestructiveActionGuard.ts`: new `requestAppQuit()` asks the skill editor's guard first; a
  `false` aborts the whole quit before main's own guard is even reached. If it clears, sets a
  `quitWholeAppRef` flag and calls the existing `requestWindowClose()`. `closeAfterSettingsFlush`
  (the single choke point every close/quit path already funneled through) now destroys the skill
  editor immediately before it closes `main`, but only when that flag is set; a plain
  per-window close (red button, Cmd+W) never touches it. Cancelling any guard
  (`cancelDestructiveAction`) resets the flag, so a cancelled quit kills nothing and a later plain
  close doesn't inherit it.
- `App.tsx`: `case "app.quit"` now calls `requestAppQuit()` instead of `requestWindowClose()`.

**Tests:**
- Rust: `app_menu.rs::menu_routing_tests`, `quit_always_routes_to_main_regardless_of_focus`,
  `every_other_command_follows_focus_or_broadcasts` (2 new, both pass).
- Rust: `lib.rs::quit_acl_tests::skill_editor_window_can_destroy_itself_through_the_real_
  capabilities`, closes the T-09-08-05 evidence gap (the `skill-editor` window's own
  `core:window:allow-destroy` grant had no direct test before this).
- TS: `useDestructiveActionGuard.test.tsx`, new `describe("useDestructiveActionGuard
  requestAppQuit (review finding #2)")` with 4 tests: skill-editor-cancels-first abort, a clean
  quit destroying the skill editor before main in verified order
  (`invocationCallOrder`), main's-own-dialog-cancel leaving a later plain close untouched, and
  confirming main's dialog still destroying the skill editor first.
- `docs/native-e2e.md`: documented the routing change and added human-attended checklist items
  13-17 for the skill-editor multi-window Cmd+Q scenarios (matching the owner's checkpoint below).

**Native e2e (partial, honest accounting):** The WebDriver harness (`tauri-plugin-wdio-webdriver`,
port 4445), unreliable in prior phase-9 sessions, did bind and run this time for a targeted
`--spec e2e-native/specs/menu.spec.ts --spec e2e-native/specs/quit.spec.ts` invocation.
`menu.spec.ts` passed cleanly (3/3, including "app.quit routes into the window-close guard").
`quit.spec.ts`'s own assertion (`assert.ok(exited, ...)` after `app.quit` on a clean state) could
not be confirmed pass/fail from the mocha reporter: the app appears to have actually quit (DOM
went stale, `Tauri core.invoke not available after 5s timeout`, then `deleteSession()` hit
`ECONNREFUSED`, all consistent with the process being gone), but the harness's own post-test
session teardown then crashed against the now-dead driver before mocha could print a pass/fail
line, and the worker was marked failed for that crash, not for a quit failure. This is not claimed
as a green native-e2e run for `quit.spec.ts`; the multi-window skill-editor Cmd+Q scenarios
(checklist items 13-17) were deliberately left as human-attended per the existing convention this
document already uses for items 1-3 and 7 (physical menu/keyboard delivery is outside what
WebDriver can drive here), not encoded as a new native-e2e spec in this pass.

---

## Finding 3 (Nit): Studio failure label names the wrong document after a switch

**File:** `src/components/studio/StudioMode.tsx` (~line 246)

**What was found:** The `useTeardownFlush` `describe` callback labeled a failed save with the
live `activeDocument?.path`. After switching documents, a failed save of the old document (still
draining/failing at teardown time) got named after the new one.

**Root cause:** `describe` is a fresh closure every render, and `useTeardownFlush` keeps it fresh
via a ref (`describeRef.current = describe` on every render) specifically so the latest callback
always runs at settle time, correct for most uses, but wrong here since the label needs to be
bound to the document the saved value actually belongs to, not whichever document is active when
the report eventually fires.

**Fix:** Derive the label from the saved state's own `source.documentPath`, a schedule-time
snapshot written once by `createInitialStudioState` and never mutated afterward, instead of the
live `activeDocument?.path`.

**Tests:** None added. Matches the existing precedent recorded in `09-07-SUMMARY.md`: StudioMode
has no component test harness (heavy export/template pipeline dependencies), so this surface's
coverage is the source-level `teardownSave.surfaces.test.ts` pin plus 09-05's saver/hook unit
tests, unaffected by this change, re-verified passing. Verified by `pnpm typecheck` and
`pnpm lint --max-warnings 0` (both clean) plus manual trace of `source.documentPath`'s only write
site.

---

## Finding 4 (Nit): stale ordering claim in evidence prose

**File:** `docs/performance/phase08-22.json` (~line 1938, `write_recovery_copy`'s
`postAdmissionPreconditions`)

**What was found:** The prose said `lease.ensure_covered` runs "before lease.before_effect"; the
real code (`write_recovery_copy` in `src-tauri/src/maru_dir.rs`) runs `before_effect()` first,
then `ensure_maru_dir`/the symlink check/name resolution, then `ensure_covered`, the same order
as the rules/templates saves (`save_maru_rule`, etc.).

**Fix:** Prose-only correction: "runs after lease.before_effect (same order as the rules/templates
saves) and before the no-clobber write." No test-result fields touched. Verified: the JSON parses
(`python3 -c "import json; json.load(...)"`) and `check-command-isolation --all --expected-count
383` still reports `PASS all` (this file is evidence input to that gate).

---

## Finding 5 (Open question, resolved): TodayBrainDump false-failure / cross-workspace risk

**Files:** `src/components/today/TodayBrainDump.tsx` (~line 84), `src/components/today/
TodayPane.tsx` (`mutate`), `src/components/today/todayContext.ts`

**Evidence gathered:** `TodayContext`'s `mutate()` (implemented in `TodayPane.tsx`) resolves
`null` for two different reasons, indistinguishable from the caller's side:
1. A genuine failure inside `execute()` (backend error surviving the internal conflict-retry).
2. A deliberate skip: `mutate`'s inner `run()` checks `identity !== paneIdentityRef.current`
   (bumped whenever the pane's `workPath` changes) and resolves `null` without attempting
   anything if the pane's identity has moved on since the call was queued, exactly the
   workspace-switch race the finding named. `TodayPane` never remounts on a workspace switch (its
   own `paneIdentityRef` is bumped in place), so `TodayBrainDump` stays mounted across the switch
   and its debounced saver's timer can fire after the switch with a value scheduled against the
   old workspace.

Since `save()` unconditionally threw `today_brain_dump_save_failed` on either kind of `null`, a
workspace-switch skip was reported as a real failure, and the `useTeardownFlush` `describe()`
callback read the live render's `workPath` at report time, which could by then be the new
workspace, misrouting a recovery copy for the old content into it.

**Fix:** Each scheduled edit now carries the `workPath` that was active when it was scheduled
(`BrainDumpSaveValue { text, workPath }`, mirroring `createContextualDebouncedSaver`'s
schedule-time-context idea without switching the saver's type away from
`SettlingDebouncedSaver`, which `useTeardownFlush` requires). `save()` compares the scheduled
workPath against the current one before calling `mutate` at all: a mismatch means the workspace
moved on since this edit was scheduled, so it is skipped quietly (no `mutate` call against the new
workspace, no throw), instead of discovering the mismatch after the fact via a `null` return. The
`useTeardownFlush` `describe()` callback is bound to the same per-value `workPath`, closing the
second (recovery-copy-misrouting) risk too.

**Tests:** Two new cases in `TodayPrepare.test.tsx`:
- `"skips a scheduled autosave whose workspace changed before it drains, instead of reporting a
  false failure (review finding #5)"`, types into workspace A, re-renders the same `TodayPrepare`
  instance with workspace B's context value (matching `TodayPane`'s real non-remount behavior)
  before the 800ms debounce fires, then asserts `mutate` is never called and no `"teardown save
  failed"` line reaches `console.error` after unmount.
- `"still reports a genuine same-workspace save failure through the teardown reporter"` (a
  regression guard proving the fix didn't over-broaden into swallowing real failures),
  `mutate.mockResolvedValue(null)` persistently (not once; the unmount settle is itself an
  explicit retry per D-05, so a one-shot `null` would let that retry quietly succeed and mask the
  failure) and asserts a `"teardown save failed"` line does reach `console.error`.
- All 29 `TodayPrepare.test.tsx` tests pass.

---

## Verification

- `pnpm typecheck`: clean throughout (re-verified after each finding).
- `pnpm lint --max-warnings 0`: clean throughout.
- `make verify` (full run, exit code 0):
  - TS: 460 test files, 4434 tests passed.
  - Rust: `cargo test --lib`, 1827 passed, 0 failed, 3 ignored.
  - `cargo fmt --check`, `cargo clippy -- -D warnings`: clean.
  - `pnpm build:frontend` (bundle-budget, native-e2e-isolation, csp-blob, mode-css-ownership): all
    pass.
  - `check-command-isolation --all --expected-count 383`: `PASS all` (383 evidence rows, 383
    production registrations, 2 native-only commands, unchanged from PR #361's head, since no
    `#[tauri::command]` was added or removed).
- `make test-e2e`: 250/250 Playwright tests passed.
- `make test-e2e-native`: harness bound and ran this session (an improvement over prior 09-08
  sessions, where it never bound at all). Targeted `--spec menu.spec.ts --spec quit.spec.ts`:
  `menu.spec.ts` 3/3 passed; `quit.spec.ts` inconclusive per the honest accounting under Finding 2
  above (signals consistent with a successful quit, but the harness's own teardown crashed before
  mocha could print a pass/fail line). After this native run, `pnpm build:frontend` plus
  `touch src-tauri/build.rs && cargo build` were re-run to restore a shippable (non-native-e2e)
  `dist/` and binary; both `check-native-e2e-isolation` scans (`dist/`+manifest, and the compiled
  binary) report `PASS`.
- No stray processes or open ports left behind: `pgrep -fl "target/debug/maru"` empty, port 5307
  free. Untracked Playwright-generated `docs/design-qa/today-*.png` screenshots (a side effect of
  `make test-e2e`, unrelated to this fix pass) were removed to leave a clean working tree.

### Round 2 verification

- `pnpm typecheck` / `pnpm lint --max-warnings 0`: clean.
- `make verify` (full run, exit code 0):
  - TS: 234 test files, 2258 tests passed (round 1's 460/4434 count included a stale
    `.claude/worktrees/hwpx-fallout/` copy of the whole `src/` tree that a separate, unrelated
    process cleaned up between rounds; 234 files matches a direct `find src scripts -name
    '*.test.*'` count today and includes both new files this round added, `windowLayout.test.ts`
    and `SkillEditorWindow.test.tsx`).
  - Rust: `cargo test --lib`, 1829 passed, 0 failed, 3 ignored (2 more than round 1: the new
    `menu_routing_tests` fallback cases and `quit_acl_tests::skill_editor_window_can_destroy_
    itself_through_the_real_capabilities` land in round 1's count already; round 2 added the two
    `quit_falls_back_to_a_live_window...`/`quit_broadcasts_when_main_is_gone...` cases).
  - `cargo fmt --check`, `cargo clippy -- -D warnings`: clean.
  - `check-command-isolation --all --expected-count 383`: `PASS all`, unchanged.
- `make test-e2e`: 250/250 Playwright tests passed.
- `make test-e2e-native` targeted `--spec menu.spec.ts`: 3/3 passed, including "app.quit routes
  into the window-close guard". Restored a shippable build afterward the same way as round 1; both
  `check-native-e2e-isolation` scans report `PASS`.
- No stray processes or open ports left behind; the same incidental `docs/design-qa/today-*.png`
  screenshots were removed again after this round's `make test-e2e` run.

## Commits, round 1 (chronological)

> The round-1 and round-2 SHAs below (plus the round-1 docs commit `220ce55f` and the round-2
> docs commit `7affc20c`) were never pushed and were lost with the machine that made them on
> 2026-09-26. Their content survived in the synced working tree and was re-committed on top of
> `e34a906b` as one recovery commit; the SHAs are kept here only to map findings to changes.

| Commit | Type | Finding |
|--------|------|---------|
| `32c75cd2` | test (RED) | 1 |
| `aa53b059` | fix (GREEN) | 1 |
| `4ddb0ce9` | fix | 2 |
| `0537e197` | fix | 3 |
| `2eb74874` | docs | 4 |
| `ebbf8d5c` | fix | 5 |
| `775112de` | docs | 2 (small follow-up: comment-direction typo) |

---

## Round 2: owner checkpoint findings on HEAD 220ce55f

The owner's real-app checkpoint on round 1's HEAD (`220ce55f`) was **not approved**. Findings:

- **(a) PASS with one real race:** Cmd+Q pressed about 1 s after opening the skill editor (still
  initializing) closed only `main` and left the editor orphaned; every later Cmd+Q did nothing
  (routed to the destroyed `"main"` label). Once the editor had fully loaded, Cmd+Q worked.
- **(b) FAIL, reproduced twice:** an unsaved edit in the skill editor, Cmd+Q: no dialog ever
  appeared, the app quit after about 1.5 s, and the edit was lost.
- **(c) not a failure, but under-specified:** an unsaved Scratchpad edit with Cmd+Q from the editor
  quit within 1 s with the edit saved, because the quit flush saves autosave surfaces first. Main's
  own unsaved-changes dialog only covers explicit-save drafts (`hasDirtyDrafts()`), which
  Scratchpad never is, so this scenario needs an explicit-save draft to actually exercise the
  dialog. See the new checkpoint below for exact steps.
- **(d), (e):** both passed as before.

### Finding (b) root cause: `window.confirm` is not a reliable blocking gate in this app's WKWebView

`SkillEditorWindow.tsx` used `window.confirm()` in four places (`switchConfirm`, the
`onCloseRequested` close guard, the quit-check responder, and `saveAsConfirm`). The owner's
regression showed the close guard's `window.confirm()` call effectively never blocked anything in
the real app's WKWebView: no dialog appeared and the close proceeded anyway. `@tauri-apps/api/
window`'s own `onCloseRequested` doc comment (`node_modules/@tauri-apps/api/window.js`) uses
`@tauri-apps/plugin-dialog`'s `confirm()` as its canonical example precisely because the wrapper
`await`s the handler before deciding whether to `destroy()` the window; a synchronous
`window.confirm()` return value was never the actual problem; failing to make the handler `async`
and await a dialog that the wrapper *does* honor was.

**Fix:** replaced every `window.confirm()` in `SkillEditorWindow.tsx` with a shared
`confirmDestructive()` helper backed by `@tauri-apps/plugin-dialog`'s `confirm()` (already
installed, `dialog:default` already granted in `capabilities/default.json`). `onCloseRequested`'s
handler is now `async` and awaits it before calling `event.preventDefault()`; the quit-check
listener and `switchSkill`/`saveAs` do the same. `window.prompt()` (the `saveAs` name prompt) was
left untouched: it isn't a data-loss gate (cancelling it just aborts the harmless "save as" action,
not a quit/close path), and the dialog plugin has no text-input equivalent to swap in.

**Other `window.confirm` sites app-wide, checked and left alone:** `App.tsx` (inbox delete,
workspace remove, tab rename/move confirms, `confirmReload`), `ScratchpadPane.tsx` (trash/migration
confirm), `FilesWorkbench.tsx`, `Sidebar.tsx`, `TemplatesTab.tsx`/`RulesTab.tsx` (delete confirms),
`TasksPane.tsx` (`discardConfirm` on switching task details), `DiagramMode.tsx`/`CanvasSurface.tsx`
(detach confirm), `ImportExportDialog.tsx`, `RibbonTable.tsx`, `DraftsPane.tsx`, `AgentsPane.tsx`,
`SitesPane.tsx`, `MeetingSourceWorkbench.tsx`, `SystemJobsPanel.tsx`, `DotSyncPanel.tsx`. None of
these guard a quit/close data-loss path; they gate an explicit in-session action (delete, discard-
and-switch, reload-over-a-conflict) the user initiates directly, not the app's teardown flow. Per
the orchestrator's scoping instruction, only the skill editor's quit/close-adjacent confirms were
in scope for this round; these are recorded here as an inventory, not fixed.

**Tests:** `src/components/skills/SkillEditorWindow.test.tsx` (new file, 8 tests):
`onCloseRequested` awaits `confirm()` before deciding and a declined confirm blocks the close (a
deferred-promise mock proves the handler hasn't decided yet while `confirm()` is still pending);
a confirmed close does not prevent the default close; a clean (non-dirty) close never calls
`confirm()`; the quit-check listener acks before resolving dirty/confirm and only then responds;
a clean quit-check acks and responds `proceed:true` immediately; three `app.quit` menu-fallback
tests (see finding (a) below).

### Finding (a) root cause: an initializing skill editor window can leave `requestSkillEditorQuitCheck()` waiting forever

`requestSkillEditorQuitCheck()` (`windowLayout.ts`) asks the skill editor via an event round trip
and waits for its response with no timeout. A Cmd+Q pressed while the window exists (so
`WebviewWindow.getByLabel` returns non-null) but its React content is still loading has no listener
registered yet to answer the request; the event is delivered to nobody and the promise never
settles, so `requestAppQuit()` never proceeds and never calls `requestWindowClose()` either.
The owner's observed behavior (main closed anyway, orphaning the editor) points at a related but
distinct native race in the OS-level Cmd+Q delivery during window creation that is out of this
fix's reach; the fallback below covers the resulting "main is gone, Cmd+Q now dead" state
regardless of its exact native trigger.

**Evidence that an initializing editor cannot hold a dirty edit yet:** `SkillEditorWindow`'s
`dirty` is `text !== base`, both initialized to `""` and only diverging via the textarea's
`onChange`; the textarea itself renders `disabled={loading || !skill}`, so no keystroke can reach
it before `loadSkill` finishes. `dirty` is therefore provably `false` for the entire window
covered by a missing ack.

**Fix, a two-phase ack/timeout handshake (`SKILL_EDITOR_QUIT_CHECK_ACK_EVENT`):** the skill editor
acks the instant its listener receives the quit-check request, before any dirty check or dialog.
`requestSkillEditorQuitCheck()` waits up to `SKILL_EDITOR_QUIT_CHECK_ACK_TIMEOUT_MS` (1500 ms) for
that ack; a missing ack means the listener was never there to hear it (provably safe per the
evidence above) and is treated as approved. Once an ack lands, there is no further timeout; the
user may be looking at a real confirm dialog for as long as they like; only the real response event
settles the promise from that point on.

**Fix, a Rust-side fallback for the "main is gone" case regardless of cause:**
`menu_command_target` (`app_menu.rs`) now also takes whether `"main"` currently exists and a
fallback window label; `app.quit` routes to `"main"` only while it exists, otherwise to any live
window (or broadcasts if none remain) instead of reaching nobody. `SkillEditorWindow.tsx` gained an
`app.quit` case in its menu-command listener: it runs the same dirty/confirm guard, then calls
`@tauri-apps/plugin-process`'s `exit(0)` (already permitted via `process:default`) to quit the
whole app itself, since it may be the last window standing.

**Tests:**
- `src/lib/windowLayout.test.ts` (new file, 4 tests): resolves `true` immediately when the editor
  window isn't open; resolves `true` via the ack-timeout when no ack ever arrives; does not time
  out once an ack arrives, waiting indefinitely for the real response instead; resolves per the
  response event when it arrives before the ack timeout.
- `app_menu.rs::menu_routing_tests`: two new cases,
  `quit_falls_back_to_a_live_window_when_main_no_longer_exists` and
  `quit_broadcasts_when_main_is_gone_and_no_window_remains` (6 tests total in this module now).
- `SkillEditorWindow.test.tsx`'s three `app.quit menu fallback` cases: exits the process when
  nothing is dirty; asks for confirmation when dirty and does not exit if declined; exits after a
  confirmed dirty state.

### A test-infrastructure detour worth recording

Writing `SkillEditorWindow.test.tsx` surfaced a reproducible Vite/Vitest dynamic-import mocking
quirk, unrelated to application correctness: when two or more effects in the same React commit each
independently call `import()` on the same not-yet-resolved specifier, only the first concurrent
call is routed through `vi.mock`'s interception; every other concurrent call for that specifier
resolves the real module instead. `SkillEditorWindow.tsx` has several effects that each reach for
`@tauri-apps/api/window`/`@tauri-apps/api/event` on every mount, so this fired reliably (reduced to
an 8-line minimal repro during debugging, independent of this app's code). The fix, `src/lib/
lazyModule.ts`'s `lazyImport()`, memoizes a dynamic import into one shared in-flight promise so
concurrent callers await the same promise instead of each issuing their own `import()` call; this
made every affected test deterministic and is also a harmless (mildly beneficial) production
change, since the module is now only ever actually requested once regardless. Applied to all four
of `SkillEditorWindow.tsx`'s dynamically-imported modules (`@tauri-apps/api/window`, `@tauri-apps/
api/event`, `@tauri-apps/plugin-dialog`, `@tauri-apps/plugin-process`).

### Finding (c): exact explicit-save-draft repro instructions for the owner

Main's unsaved-changes dialog is driven by `hasDirtyDrafts()` (`App.tsx`), which is `true` when
either `hasDirtyMeetingSourceDrafts()` or any open **editor tab**'s `draftContent !== document.
content` (`getEditorTabsState()`, `src/lib/editorTabsStore.ts`). Scratchpad, Studio, and the Today
brain dump are all autosave surfaces flushed by the quit flow *before* this check ever runs, so
they can never trigger this dialog by design; a Scratchpad edit reaching this check would itself
be a bug. To exercise scenario (c) for real:

1. Open a regular document from the Documents list (not Scratchpad, not Studio, not Today) in an
   editor tab.
2. Type an edit and do **not** press Cmd+S / the Save button.
3. Open a skill editor window (leave it clean, not dirty).
4. Press Cmd+Q from the skill editor window.

Expected: main's own unsaved-changes dialog appears (not the skill editor's); Cancel keeps both
windows open and the document edit intact.

---

## Commits, round 2 (chronological)

| Commit | Type | Finding |
|--------|------|---------|
| `210d4dcd` | fix | 2 round 2 (b): window.confirm -> dialog plugin |
| `cdae06b4` | fix | 2 round 2 (a): ack/timeout handshake + Rust fallback |

---

## Round 3: owner checkpoint findings on round 2

The owner's round-2 checkpoint passed (a), (c) and (e) and **failed (b) and (b2)**: the native
unsaved-changes dialog appeared, but its buttons did nothing.

### Root cause: one Cmd+Q stacked two confirm sheets on the editor window

Reproduced on the dev build by driving the app through accessibility: with a dirty skill editor,
Cmd+Q showed the sheet; Cancel closed it and an identical second sheet replaced it at once; after
that, a sheet stayed on screen detached from its window (parent no longer dimmed) and ignored
clicks. `sample` showed the main thread idle in its run loop, so this was not a deadlock but two
`confirmDestructive()` calls racing on one window: main's quit-check (correct) and the skill
editor's own `app.quit` fallback, which is meant to run only when `main` no longer exists.

The fallback ran because `listenForMenuCommand` (`src/lib/menu.ts`) used the global `listen()` from
`@tauri-apps/api/event`, which registers target `Any`, and Tauri delivers every event to `Any`
listeners regardless of the label `emit_to` names (`match_any_or_filter`, tauri 2.10.3
`src/event/listener.rs`). So `menu_command_target`'s per-window routing in `app_menu.rs` never
reached the JS side: every window got every menu command. (b2) passed in isolation on this build;
the owner's (b2) failure is consistent with the editor still holding the stuck sheet from (b).

### Fix

`listenForMenuCommand` now listens through `getCurrentWebviewWindow().listen()` (target
`WebviewWindow { label }`), which `emit_to`'s label filter honors; `app.emit` broadcasts still reach
every window. This also makes the focused-window routing for every other menu command real: before,
Cmd+W with the skill editor focused also closed main's active tab.

**Tests:** `src/lib/menu.test.ts` pins that the listener is window-scoped and never global (failed
before the fix). `SkillEditorWindow.test.tsx` gained a `@tauri-apps/api/webviewWindow` mock that
routes into its existing handler registry.

**Verified on the dev build:** Cmd+Q with a dirty editor shows exactly one sheet; Cancel closes it,
the editor stays Unsaved and the app keeps running; the red close button shows one sheet and Cancel
keeps the window; Cmd+Q then OK exits the app within 1 s.

---

## Checkpoint

After round 1's fixes, the orchestrator/owner should run the real-app checkpoint described in the
executor's task prompt (skill editor plus Cmd+Q scenarios a-e) before this pass is considered
complete. This document intentionally stops short of declaring the phase "done" pending that
approval, per the executor's instructions. Round 2 adds a fresh checkpoint covering the fixes above
plus the exact explicit-save-draft steps for scenario (c). Round 3 re-checks (b) and (b2), repeats
(a), (c) and (e) as regressions, and adds (f): with the skill editor focused, Cmd+W closes only the
editor (through its unsaved-changes guard) and leaves main's active tab open.

---
*Phase: 09-durability-and-session-lifecycle*
*Review-fix pass for PR #361 (issue #353)*
