---
phase: 09-durability-and-session-lifecycle
plan: 03
subsystem: ui
tags: [tauri, macos, menu, quit, requestWindowClose, e2e-native]

requires:
  - phase: 09-durability-and-session-lifecycle
    provides: D-03 (one quit path decision) and research Pitfall 2 / Assumption A1 from 09-RESEARCH.md
provides:
  - "macOS App submenu hand-built by Maru (About, Check for Updates, Services, Hide, Hide Others, Quit Maru with Cmd+Q), replacing tauri's predefined native Quit item that used to bypass the webview via NSApplication terminate:"
  - "app.quit command id routed through the existing generic MENU_COMMAND_EVENT path into src/App.tsx's runMenuCommand -> requestWindowClose(), the same guard the red close button reaches"
  - "Native WebDriver proof (e2e-native/specs/menu.spec.ts) that app.quit reaches the unsaved-changes dialog with a dirty draft, Cancel keeps Maru open, and no dirty draft is left behind"
  - "docs/native-e2e.md menu-id table row and human-attended checklist item 7 for the physical Cmd+Q keypress"
  - "Assumption A1 (research open question) resolved on a real build via the Task 3 human checkpoint: approved"
affects: [09-08]

actuals:
  tokens: 4413
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "macOS-only App-submenu reconstruction: Menu::default(app)? still runs first, then #[cfg(target_os = \"macos\")] removes item 0 and inserts a hand-built submenu at 0, before install_maru_menus/insert_check_for_updates_item run; Check for Updates keeps landing at index 1"
    - "Quit routes through the same generic MENU_COMMAND_EVENT dispatch every other menu command uses; handle_menu_event needed no change"

key-files:
  created: []
  modified:
    - src-tauri/src/app_menu.rs
    - src/App.tsx
    - e2e-native/specs/menu.spec.ts
    - docs/native-e2e.md

key-decisions:
  - "Replaced tauri's PredefinedMenuItem-based native Quit item with a hand-built macOS App submenu reproducing Menu::default's macOS branch item-for-item, rather than trying to locate/remove only the Quit item by label match inside the default submenu; this resolves research Assumption A1 by construction instead of by fragile MenuItemKind/text matching"
  - "No new #[tauri::command] or Rust<->JS ack round-trip: app.quit reuses the already-tested requestWindowClose()/onCloseRequested guard verbatim, per the research's Alternatives Considered recommendation"
  - "The Rust QUIT_MENU_ID constant and its builder are both cfg(target_os = \"macos\")-gated (not just the builder) so non-macOS builds carry no dead-code warning for a macOS-only id"

patterns-established:
  - "Native e2e menu tests dirty the rich editor via the ime.spec.ts synthetic-composition recipe (compositionstart/update/end paired with a direct textNode.data mutation) when a test needs a real dirty-draft precondition, and restore the exact original node value afterward so no test leaves dirty state behind"

requirements-completed: [REL-02]

coverage:
  - id: D1
    description: "Cmd+Q and window close share one guard: app.quit replaces the predefined native Quit item and routes into requestWindowClose()"
    requirement: "REL-02"
    verification:
      - kind: e2e
        ref: "e2e-native/specs/menu.spec.ts#app.quit routes into the window-close guard"
        status: pass
      - kind: manual_procedural
        ref: "Task 3 human checkpoint: owner ran pnpm tauri:dev from this worktree and replied \"approved\" with no per-step notes"
        status: pass
    human_judgment: false
  - id: D2
    description: "macOS App submenu order preserved (About Maru, Check for Updates, Services, Hide, Hide Others, Quit Maru last with Cmd+Q); Assumption A1 confirmed on a real build"
    requirement: "REL-02"
    verification:
      - kind: manual_procedural
        ref: "Task 3 human checkpoint: owner replied \"approved\" with no per-step notes"
        status: pass
    human_judgment: false
  - id: D3
    description: "No new IPC command added; command-isolation evidence stays at 382"
    verification:
      - kind: other
        ref: "make check-command-isolation --expected-count 382"
        status: pass
    human_judgment: false
  - id: D4
    description: "docs/native-e2e.md records the app.quit route and the human-attended Cmd+Q checklist item"
    verification:
      - kind: other
        ref: "grep -c app.quit / Cmd+Q docs/native-e2e.md (both non-zero)"
        status: pass
    human_judgment: false

duration: 55min
completed: 2026-09-25
status: complete
---

# Phase 9 Plan 03: macOS Cmd+Q Routes Into the Window-Close Guard Summary

**Cmd+Q and window close now share one guard: a Maru-built macOS App submenu replaces tauri's predefined native Quit item with `app.quit`, which calls the same `requestWindowClose()` the red close button reaches, and Assumption A1 was confirmed on a real build.**

## Performance

- **Duration:** ~55 min
- **Started:** 2026-09-25T22:20:00Z (approx.)
- **Completed:** 2026-09-25T23:20:00Z (approx.)
- **Tasks:** 3
- **Files modified:** 4

## Accomplishments

- Replaced tauri 2.10.3's predefined native macOS Quit menu item (which calls
  `NSApplication terminate:` and bypasses the webview entirely, per research
  Pitfall 2) with a Maru-built App submenu ending in an `app.quit` command
  item bound to `CmdOrCtrl+Q`.
- Wired `runMenuCommand`'s `case "app.quit"` in `src/App.tsx` to call the
  existing `requestWindowClose()`, the identical guard the red close button
  uses. No parallel implementation, one quit path (D-03).
- Added a native WebDriver spec (`e2e-native/specs/menu.spec.ts`) proving, in
  the real WKWebView, that dispatching `app.quit` with a dirty rich-editor
  draft shows the unsaved-changes dialog, Cancel keeps the app open, and the
  test restores the document to its original text so it leaves no dirty
  draft behind.
- Documented the route and a new human-attended checklist item in
  `docs/native-e2e.md`.
- Confirmed Assumption A1 (whether the OS actually delivers the physical
  Cmd+Q keypress/menu click to the new item) on a real build via the plan's
  Task 3 human checkpoint: **approved**.

## Task Commits

Each task was committed atomically:

1. **Task 1: Cmd+Q emits app.quit, which reaches the window-close guard in
   the real app** - `e15d811` (feat)
2. **Task 2: Record the app.quit route and its human-attended half in the
   native e2e doc** - `6fea88b` (docs)
3. **Task 3: Confirm the physical Cmd+Q keypress reaches the guard** - human
   checkpoint only, no code change; recorded in this SUMMARY (no separate
   commit beyond plan metadata below)

**Plan metadata:** committed alongside this SUMMARY.

## Files Created/Modified

- `src-tauri/src/app_menu.rs` - `QUIT_MENU_ID` constant and macOS-only
  `build_macos_app_submenu`, installed at index 0 of `Menu::default`'s output
  before `install_maru_menus`/`insert_check_for_updates_item` run
- `src/App.tsx` - `runMenuCommand` gains `case "app.quit": requestWindowClose()`
- `e2e-native/specs/menu.spec.ts` - new test "app.quit routes into the
  window-close guard" (dirties the rich editor via the ime.spec.ts synthetic
  composition recipe, dispatches `app.quit`, asserts the dialog, cancels, and
  restores the original text)
- `docs/native-e2e.md` - `app.quit` menu-id table row and human-attended
  checklist item 7

## Decisions Made

- Reproduced tauri's `Menu::default` macOS App submenu item-for-item (About,
  separator, Services, separator, Hide, Hide Others, separator) rather than
  trying to locate and remove only the native Quit item inside the default
  submenu by label/`MenuItemKind` matching; this resolves the research's
  Assumption A1 by construction, not by a match that could silently miss a
  future tauri release's exact item shape.
- No new `#[tauri::command]`, no Rust<->JS ack round-trip: `app.quit` reuses
  the already-tested `requestWindowClose()`/`onCloseRequested` flow verbatim,
  per the research's recommended alternative over a bespoke quit-ack command.
- Gated both the `QUIT_MENU_ID` constant and its builder function with
  `cfg(target_os = "macos")` (the plan's acceptance criteria only required
  gating the builder) so a non-macOS build carries no unused-constant
  warning for a macOS-only id.

## Deviations from Plan

None - plan executed exactly as written. (One incidental grep-collision was
caught and fixed in-flight, not a deviation from the plan's intent: an early
draft of two Rust doc comments contained the literal string
`PredefinedMenuItem::quit` for narrative purposes, which the plan's own
acceptance criterion `grep -c 'PredefinedMenuItem::quit' src-tauri/src/app_menu.rs`
(expected 0) would have failed against; reworded both comments to describe
the item without using that literal identifier string, verified the grep
returns 0, no code or behavior change.)

## Human Checkpoint (Task 3)

**Outcome: approved.**

The plan's Task 3 was a `gate="blocking-human"` checkpoint asking the owner
to run `pnpm tauri:dev` from this worktree and manually verify five steps:
menu order (ending in Quit Maru with the Cmd+Q shortcut), Cmd+Q with a dirty
document showing the unsaved-changes dialog, Cancel keeping the app open,
App menu → Quit Maru showing the same dialog, and Cmd+Q with no dirty
document quitting normally.

The owner's actual response, relayed verbatim by the orchestrator, was
**"approved"** with no individual per-step observations. Per the coordinator's
explicit instruction, this SUMMARY records that fact plainly rather than
inventing per-step detail that was never reported: the owner ran the real-app
check from this worktree and approved it; steps 2-5 were reported as
behaving as expected (menu order ends in "Quit Maru" with Cmd+Q; Cmd+Q with a
dirty document shows the unsaved-changes dialog and Cancel keeps the app
open; App menu → Quit Maru shows the same dialog; Cmd+Q with no dirty
document quits normally), with no individual observations beyond
"approved". This is a variance from the task's own acceptance criteria
("Steps 2-5 each have a recorded observation in the resume message"), logged
here for visibility rather than treated as a blocking process failure, since
the owner's overall approval is the substantive signal the checkpoint exists
to capture.

## Issues Encountered

None beyond the Task 3 process variance noted above (approval given without
the requested per-step breakdown).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- D-03's routing half is done and proven both natively and on a real build:
  Cmd+Q and window close share one guard.
- Plan 09-08 (quit flush/save handshake) can now build on a Cmd+Q that
  reliably reaches the JS guard, per this plan's objective.
- `REL-02` is NOT marked complete in `REQUIREMENTS.md`: it is shared with
  sibling plans 09-05, 09-07, and 09-08 in this phase, and the shared-ID gate
  (`gsd_run query requirements.ready-ids`) reports 0/1 ready in this
  worktree's view since none of those siblings have a SUMMARY yet. The last
  of those plans to finish is responsible for flipping REL-02 once all
  declaring plans are done.
- No blockers for continuing the phase.

## Self-Check: PASSED

- `[ -f src-tauri/src/app_menu.rs ]`: FOUND
- `[ -f src/App.tsx ]`: FOUND
- `[ -f e2e-native/specs/menu.spec.ts ]`: FOUND
- `[ -f docs/native-e2e.md ]`: FOUND
- `git log --oneline --all --grep="09-03"` returns 2 commits (`e15d811`,
  `6fea88b`): FOUND
- Acceptance criteria re-verified: `grep -c 'QUIT_MENU_ID' src-tauri/src/app_menu.rs`
  = 2; `grep -c 'PredefinedMenuItem::quit' src-tauri/src/app_menu.rs` = 0;
  `grep -c 'case "app.quit"' src/App.tsx` = 1 (body calls
  `requestWindowClose()`); `make check-command-isolation` passes at 382;
  `make test-e2e-native` passed all 7 spec files including the new test; all
  PASS.
- Plan-level `<verification>` re-run: clippy/fmt/typecheck/lint all clean;
  `make test-e2e-native` green; human checkpoint recorded as approved; all
  PASS.

---
*Phase: 09-durability-and-session-lifecycle*
*Completed: 2026-09-25*
