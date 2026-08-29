---
phase: 06-native-e2e-runner-foundation
plan: 03
subsystem: testing
tags: [webdriverio, tauri, ime, composition, promirror, macos-menu, radix-tabs]

requires:
  - phase: 06-02
    provides: "window.__MARU_NATIVE_E2E__ bridge (terminalText + menuCommand), readTerminalText/assertTerminalInk helpers, the command-economy spec pattern, and the pty.spec terminal-open flow"
provides:
  - "e2e-native/specs/ime.spec.ts: D-13 surface 3 — the D-07 two-surface IME sub-spike with all four surface-by-mechanism verdicts locked in as assertions; the working halves are live regression tests (terminal: composed word lands exactly once with the trailing echo deliberately dispatched and dropped; rich editor: composition events + engine DOM mutation land the word once)"
  - "e2e-native/specs/menu.spec.ts: D-13 surface 4 — three real app_menu.rs ids driven through the bridge into the app's own runMenuCommand, each with an asserted DOM consequence"
  - "src/App.tsx: registerMenuCommandDispatcher wired beside listenForMenuCommand, delegating to the same runMenuCommand (no parallel switch)"
  - "docs/native-e2e.md: '## IME sub-spike' and '## macOS menu bar' sections recording per-surface verdicts and naming what stays human-attended (D-08)"
affects: [06-04 ship-isolation guard (production-absence re-verified after the new App.tsx import), 06-05 document completion (folds the menu checklist into the doc's checklist section), Phase 8/9 specs (attach to the same runner mechanics)]

actuals:
  tokens: 8838
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Radix Tabs triggers activate on mousedown, not click — in-page tab switches must dispatch the mousedown/mouseup/click sequence (a plain .click() leaves data-state unchanged)"
    - "ProseMirror surfaces read their DOM through a mutation observer, so a faithful synthetic composition must pair the event sequence with the DOM mutation a real engine produces; events alone change nothing"
    - "Boundary-guard assertions for negative sub-spike results: assert the observed non-behavior (raw jamo land literally / document unchanged) so a future provider or WebKit change goes red instead of silently widening coverage"

key-files:
  created:
    - e2e-native/specs/ime.spec.ts
    - e2e-native/specs/menu.spec.ts
  modified:
    - src/App.tsx
    - docs/native-e2e.md

key-decisions:
  - "IME verdicts recorded as observed: terminal × WebDriver keys = literal jamo via the plain insertText path, never composition; terminal × synthetic composition events = reaches the real handlers, trailing-duplicate guard exercised and holding; rich editor × WebDriver keys = no observable change; rich editor × synthetic composition = reaches ProseMirror only when paired with the engine's DOM mutation"
  - "Negative results are asserted as boundary guards (jamo literal / text unchanged), not marked pending: both mechanisms produced a determinate observable on every surface, so no case needed a pending-with-reason marker"
  - "The rich-editor contenteditable selector is `.rich-editor-surface [contenteditable=\"true\"]` (resolves to BlockNote's div.tiptap.ProseMirror.bn-editor), chosen by reading the rendered structure rather than pinning a BlockNote internal class"
  - "menu.spec drives three ids, not the minimum two: terminal.split's DOM consequence (a second, distinct session in the right pane) only exists after terminal.shell has launched one"

patterns-established:
  - "Negative-result boundary guards: assert the exact observed non-behavior so platform drift fails loudly"
  - "Synthetic composition reproduction on ProseMirror: compositionstart → mutate text node → compositionupdate(s) → compositionend, letting the observer flush adopt the text"

requirements-completed: [TEST-01]

coverage:
  - id: D1
    description: "IME sub-spike: both D-07 surfaces driven by both mechanisms; all four results recorded in docs/native-e2e.md; terminal composition (word lands exactly once, trailing echo suppressed) and rich-editor composition (word adopted into the document) remain as live native regression tests; the OS-IME half is named human-attended per surface"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "make test-e2e-native — ime.spec.ts 6 passing (6.6s), suite exit 0, 2026-08-29"
        status: pass
      - kind: other
        ref: "node doc check: '## IME sub-spike' present, names both terminal and rich editor surfaces"
        status: pass
    human_judgment: false
  - id: D2
    description: "macOS menu surface: bridge menuCommand dispatches view.documents / terminal.shell / terminal.split into the app's own runMenuCommand with asserted DOM consequences (document list opens, terminal mounts, split produces a second distinct pane); the OS-menu-delivery half is written down as a fixed human checklist"
    requirement: TEST-01
    verification:
      - kind: e2e
        ref: "make test-e2e-native — menu.spec.ts 2 passing (305ms), suite exit 0, 2026-08-29"
        status: pass
      - kind: other
        ref: "id-declaration guard: every dispatched menu id is a command_item in src-tauri/src/app_menu.rs (plan's verify command)"
        status: pass
      - kind: other
        ref: "post-build grep over dist/assets/*.js after plain pnpm build:frontend: __MARU_NATIVE_E2E__ absent with the new App.tsx import in place (T-06-01)"
        status: pass
    human_judgment: false

duration: ~50min
completed: 2026-08-29
status: complete
---

# Phase 06-03: IME Sub-Spike and macOS Menu-Command Surface Summary

**The IME sub-spike settled all four surface-by-mechanism combinations on evidence — synthetic composition events (paired with the engine's DOM mutation on ProseMirror) drive both surfaces' real handlers and stay as native regression tests, while WebDriver keys never compose — and D-13's fourth surface got its one honest living test: real menu ids driven through the app's own `runMenuCommand`, with OS-menu delivery recorded as human-attended.**

## Performance

- **Duration:** ~50 min
- **Started:** 2026-08-29T09:55:02Z
- **Completed:** 2026-08-29T10:44Z
- **Tasks:** 2/2
- **Commits:** 2 (e888a87, b981a20)

## Task 1 — IME sub-spike on the terminal textarea and the rich editor

Executed as a genuine spike: a throwaway probe spec (iterated 5 times, never
committed) established the verdicts first, then the final spec locked them in
as assertions.

- **Terminal × WebDriver keys:** the six raw jamo (`ㅎㅏㄴㄱㅡㄹ`) land as
  literal text through the app's plain `insertText` path (screen shows the
  jamo sequence); no composition event ever fires. The final spec asserts
  exactly that boundary — jamo present, composed word absent — so a future
  provider/WebKit change that starts composing goes red.
- **Terminal × synthetic composition events:** the in-page sequence
  (`compositionstart` → updates → paired `beforeinput`/`input` →
  `compositionend` with data) drives the app's real handlers; the word
  commits through `finalCompositionText(event.data, …)`. The spec then
  dispatches WKWebView's known trailing `insertText` echo inside the 100ms
  `COMPOSITION_TRAILING_MS` window and asserts the word appears **exactly
  once** in the text mirror — a count of 2 would mean
  `isTrailingCompositionDuplicate` stopped dropping the echo. Observed:
  count 1.
- **Rich editor × WebDriver keys:** no observable change at all (document
  text unchanged). Asserted as a boundary guard.
- **Rich editor × synthetic composition:** events alone change nothing —
  ProseMirror reads its DOM through a mutation observer and synthetic events
  mutate nothing. Pairing the sequence with the DOM mutation a real engine
  produces (text-node updates between `compositionstart` and
  `compositionend`) lands the word in the document; it survives the observer
  flush. Asserted: count exactly 1.
- The rich-editor surface is reached by opening the seeded Welcome document
  from the tree-mode document list (`.tree-row.file`) and switching to rich
  mode; the contenteditable selector used is
  `.rich-editor-surface [contenteditable="true"]` (resolves to
  `div.tiptap.ProseMirror.bn-editor`).
- `docs/native-e2e.md` gained `## IME sub-spike`: one row per
  surface × mechanism with reached-handlers / reproduced-engine-sequence /
  left-to-a-human columns, and the plain statement that a synthetic stream
  drives the app's handler code but cannot exercise the OS input method.

## Task 2 — Living test for the macOS menu-command surface

- `src/App.tsx`: a second effect beside the existing `listenForMenuCommand`
  wiring, guarded by `nativeE2eEnabled()`, registers
  `registerMenuCommandDispatcher((id) => runMenuCommand(id))` with the
  disposer as cleanup and a complete dependency array (no eslint-disable).
  The dispatcher delegates to the same `runMenuCommand` the Tauri listener
  calls — no parallel copy of the switch.
- `e2e-native/specs/menu.spec.ts`: waits for the bridge's `menuCommand`
  member, then drives three real `app_menu.rs` ids with DOM-consequence
  assertions: `view.documents` (the document list opens showing the seeded
  Welcome document), `terminal.shell` (a native terminal view mounts with a
  live session), then `terminal.split` (`.terminal-body.split` with a second,
  **distinct** session in the right pane — TerminalPanel's splitOpen effect
  launches it). The opening comment states what the spec proves and what it
  cannot.
- `docs/native-e2e.md` gained `## macOS menu bar`: the automatable half (the
  command path, with an id → menu item → asserted-consequence table) and the
  human-attended half (fixed checklist: click Documents, New Shell, Split
  Terminal / ⌘D and confirm the same consequences), marked for 06-05 to fold
  into the document's checklist section.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Document row selector: `.tree-row.file`, not `.doc-row`**
- **Found during:** Task 1 (probe run: `.doc-row` count 0 while the list text
  contained "Welcome")
- **Issue:** The document list defaults to tree mode; rows are
  `.tree-row.file` buttons (`.doc-row` exists only in list mode).
- **Fix:** The spec queries `.tree-row.file, .doc-row`.
- **Files modified:** e2e-native/specs/ime.spec.ts
- **Committed in:** e888a87

**2. [Rule 3 - Blocking] Radix Tabs triggers do not activate on synthetic click**
- **Found during:** Task 1 (probe run: after `rich.click()`, the trigger's
  `data-state` stayed `inactive` and source mode stayed active)
- **Issue:** Radix Tabs activates a trigger on mousedown
  (activationMode="automatic"); a plain in-page `.click()` never switches
  the tab.
- **Fix:** The mode switch dispatches mousedown/mouseup/click in-page, polled
  until `.rich-editor-surface [contenteditable="true"]` exists.
- **Files modified:** e2e-native/specs/ime.spec.ts
- **Committed in:** e888a87

**3. [Rule 2 - Missing critical functionality] Production-absence re-verified after the new App.tsx import**
- **Found during:** Task 2 (threat model T-06-01: the menuCommand bridge
  member is covered by the VITE_NATIVE_E2E build gate, which the new App.tsx
  call site must not defeat)
- **Issue:** 06-02 proved the bridge string is absent from production bundles
  with NativeTerminalView as the only importer; App.tsx becoming a second
  importer could have changed the tree-shaking outcome.
- **Fix:** Ran plain `pnpm build:frontend` and grepped `dist/assets/*.js`:
  `__MARU_NATIVE_E2E__` absent. The flagged build was restored afterwards
  (`pnpm build:frontend:native-e2e` + cargo rebuild) to leave the checkout
  runnable.
- **Files modified:** none (verification only)
- **Committed in:** b981a20 (noted in the commit message)

---

**Total deviations:** 3 auto-fixed (2 Rule 3, 1 Rule 2)
**Impact on plan:** No scope creep; both Rule 3 fixes are spec-driving
mechanics the plan's `read_first` anticipated having to resolve empirically
("resolve the actual contenteditable selector by reading the rendered
structure").

## Issues Encountered

- The first probe run of the terminal synthetic-composition case read the
  text mirror too early (fixed 1.5s sleep) and saw count 0 on a cold launch;
  the final spec polls the mirror with an in-page deadline loop instead of
  sleeping, then settles 500ms before counting. No flake observed in the
  final form (two full-suite runs green).
- `pnpm test:e2e:native -- --spec …` passes a literal `"--"` through to wdio,
  silently ignoring the filter and running the whole suite. The correct
  passthrough is `pnpm exec wdio run e2e-native/wdio.conf.ts --spec …`.
  Noted for 06-05's runbook work.
- Unrelated pre-existing dirt: `docs/design-qa/*.png` files were modified in
  the working tree before this plan started; left untouched and uncommitted.

## User Setup Required

None.

## Next Phase Readiness

- 06-04 (ship-isolation guard): the production-absence assertion was
  re-verified with the App.tsx import in place; the single-string guard shape
  still holds.
- 06-05: folds the `## macOS menu bar` checklist into the document's
  checklist section; can also document the `--spec` passthrough gotcha above.
- All four D-13 surfaces now have living tests: webview, pty, ime, menu —
  `make test-e2e-native` reports 10 passing across 4 spec files, exit 0.

---
*Phase: 06-native-e2e-runner-foundation*
*Completed: 2026-08-29*

## Self-Check: PASSED

- All four plan artifacts exist on disk (ime.spec.ts, menu.spec.ts, App.tsx registration — 3 references to registerMenuCommandDispatcher, docs/native-e2e.md carrying both new sections); SUMMARY.md written.
- Both commits found in git log: e888a87 (Task 1), b981a20 (Task 2).
- No file deletions in the plan's diff range.
- Verify evidence: `make test-e2e-native` exit 0 with 10 passing across 4 spec files (ime 6, menu 2, pty 1, webview 1); `pnpm typecheck` + `pnpm lint` clean; `pnpm exec tsc -p tsconfig.e2e-native.json --noEmit` clean; menu-id declaration guard passed (view.documents, terminal.shell, terminal.split); production `dist/` free of `__MARU_NATIVE_E2E__` with the App.tsx import in place.
