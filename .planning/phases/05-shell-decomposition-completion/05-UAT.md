---
status: passed
phase: 05-shell-decomposition-completion
source: [05-VERIFICATION.md]
started: 2026-08-26T23:05:28Z
updated: 2026-08-28T08:44:02Z
finished: 2026-08-28T08:44:02Z
---

# Phase 05 - Native UAT

## Tests

### 1. Documents native flow

expected: Query/filter, repeated reveal, favorite/unfavorite, and file-queue application preserve prior behavior and filesystem results.
result: passed
observations:
  - A fresh debug Tauri process opened the disposable public workspace at `/tmp/maru-d20-nku23K` and indexed exactly two Markdown documents.
  - Searching for `Alpha` reduced the list from two items to one. Clearing the field restored both items.
  - Selecting `docs/alpha.md` twice kept one `Alpha Native Check` editor tab instead of duplicating it.
  - The context menu changed `FAVORITES 0` to `FAVORITES 1`; `Remove from Favorites` returned it to zero.
  - Files opened in the right workbench, `queue/source/native-check.txt` was queued and applied, and the workspace count increased from three to four files.
  - `cmp` and SHA-256 confirmed that `/tmp/maru-d20-nku23K/native-check.txt` exactly matched the queued source (`e34feec116664fea676bc78de8e5ef4040059d47f9be5123798ef5c7d69461d9`).

### 2. Terminal native flow

expected: Spawn/input/output, bottom/right dock, split/resize, Terminal/Graph switch, hide/show, kill, and recreate all work in the fresh Tauri app.
result: passed
observations:
  - Shell launch produced a live PTY in `/private/tmp/maru-d20-nku23K`; `printf 'D20_TERMINAL_OK\n'` rendered `D20_TERMINAL_OK`.
  - Docking changed the control from `Dock panel bottom` to `Dock panel right` while the tabs and active input remained available.
  - `Cmd+D` created a second live pane, two terminal inputs, and the native split separator; the resize gesture completed without an application error.
  - Terminal -> Graph showed the native knowledge graph surface (`Knowledge · Graph 0/0`, `No notes to display`); switching back restored the terminal panes.
  - Collapse changed the control to `Expand panel`; expanding restored all terminal tabs.
  - `Cmd+W` reduced the shell-tab count, and a new Shell launch recreated the session. `printf 'D20_TERMINAL_RECREATED\n'` rendered `D20_TERMINAL_RECREATED`.

### 3. Registry placement and lazy loading

expected: Representative modes open in primary and right placement with unchanged navigation, focus, fallback, and visible output; a lazy-loaded mode initializes correctly.
result: passed
observations:
  - Files opened on the right with `Move to main view` and `Close right view`, then moved to the primary surface without losing the editor or terminal state.
  - The lazy Diagram adapter initialized on the right against `/tmp/maru-d20-nku23K`, exposing its ribbon, canvas, layers, and properties surfaces.
  - `Move to main view` promoted Diagram to the primary surface; returning to Docs restored the same document and terminal tabs.

### 4. Recycled terminal generation

expected: An operation carrying a stale session generation is rejected while the recreated current session continues to work.
result: passed
observations:
  - The native UI teardown/recreate flow accepted input and rendered output only from the recreated current session.
  - The same native Rust backend passed all 76 terminal tests, including the recycled-session all-command matrix where every stale generation is rejected and every current generation succeeds.

### 5. Native render isolation

expected: Document, terminal, and mode-local actions do not visibly refresh MainApp or unrelated panes.
result: passed
observations:
  - Document search, repeated selection, favorite changes, file-queue application, terminal lifecycle changes, Graph switching, and Diagram right/primary placement left unrelated visible panes stable.
  - The `Alpha Native Check` editor and terminal tabs persisted across Files and Diagram placement changes with no visible shell refresh.
  - Exact render-count isolation remains covered by the passing real-`MainApp` render harness from phase verification.

## Summary

total: 5
passed: 5
issues: 0
pending: 0
skipped: 0
blocked: 0

## Gaps

None recorded. The disposable workspace registration was removed after the run and the original private `work` workspace was restored.
