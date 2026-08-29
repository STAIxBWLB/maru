# Native e2e runner

Runbook and evidence log for the native WebDriver e2e runner (`e2e-native/`,
`make test-e2e-native`). This file currently carries only the spike log;
plan 06-05 completes the rest of the document.

## Spike log

Scope of this section: the D-01 CI-viability verdict and the hosted evidence
behind it. Attempt 1 (plan 06-01) covered session establishment only; attempt 2
(plan 06-05) ran the full four-spec suite on the hosted runner, covering D-01's
remaining two conditions (PTY readability through the canvas surface, and a
full run completed with no human present).

Rules (06-CONTEXT.md D-02): an observed interactive/TCC permission prompt would
have settled the verdict as human-attended on the spot, with no further
attempts. Every other failure class was retried within a cap of **3** hosted
macOS job runs total. The cap and the observed failure class are both recorded
here.

Retry cap: 3 hosted runs. Runs used: 2.

### Attempts

| # | Date | Run URL | Result | Failure class | What changed before next attempt |
|---|------|---------|--------|---------------|----------------------------------|
| 1 | 2026-08-29 | https://github.com/STAIxBWLB/maru/actions/runs/33243419439 | pass | — (no failure; no permission prompt) | The three remaining D-13 surface specs landed (plans 06-02/06-03), so the suite grew from 1 spec to 4 |
| 2 | 2026-08-29 | https://github.com/STAIxBWLB/maru/actions/runs/33250704926 | pass | — (no failure; no permission prompt) | — (verdict settled; cap not needed) |

### Verdict

`ci-viable` — settled 2026-08-29; all three D-01 conditions held on hosted
`macos-14` runs:

1. **Session establishment with no interactive prompt** — attempts 1 and 2
   both established a WebDriver session with no interactive or TCC prompt: no
   dialog text appears in either run log, and the failure-path screencapture
   step never fired in either run.
2. **Real PTY output read through the canvas surface** — attempt 2 ran
   `e2e-native/specs/pty.spec.ts` green on the hosted runner (`1 passing
   (4.7s)`): the shell-produced marker was read through the text mirror and
   the canvas ink check proved paint, under hosted WebKit rendering.
3. **A full run completed with no human present** — attempt 2 ran the whole
   suite unattended: `4 passed, 4 total` (webview 45.8s, pty 4.7s, ime 7.2s,
   menu 2.7s) inside a `workflow_dispatch` job, start to finish with no human
   present.

Consequence: the full suite runs in CI on pushes to `main` and on release tags
(`.github/workflows/native-e2e.yml`, plan 06-05), pull requests get the
compile-and-typecheck job only (D-16), and the spike workflow is retired. The
human checkpoint in plan 06-05 ratifies this verdict item by item before the
phase closes.

## IME sub-spike

Recorded 2026-08-29 by `e2e-native/specs/ime.spec.ts` (D-07's two surfaces,
each driven by both mechanisms; ROADMAP criterion 4). The spec asserts these
observations, so a future WebDriver-provider or WebKit change that alters any
row turns the suite red rather than silently changing what the suite covers.

The word driven is `한글` (two syllables; raw jamo `ㅎㅏㄴㄱㅡㄹ`).

| Surface | Mechanism | Reached the app's handlers? | Reproduced a real engine's sequence? | Left to a human |
|---------|-----------|------------------------------|--------------------------------------|-----------------|
| Terminal hidden textarea (`.native-terminal-input`) | WebDriver key input (raw jamo) | Only the plain `insertText` path — the jamo landed literally (`ㅎㅏㄴㄱㅡㄹ` on screen); `compositionstart`/`update`/`end` never fired, so the composition handlers and the trailing-duplicate guard were never engaged | No — no composition occurred at all | Real OS-IME composition into the terminal, including the trailing-duplicate window under real timing |
| Terminal hidden textarea | Synthetic composition events in-page | Yes — `onCompositionStart`/`onCompositionEnd` ran, the word committed at `compositionend`, and a deliberately dispatched trailing `insertText` echo was dropped by `isTrailingCompositionDuplicate`; the word landed exactly once | The event stream, yes; the OS engine that would emit it, no | Everything above, plus Enter-during-composition and blur-abandonment under a real engine |
| Rich editor (`.rich-editor-surface [contenteditable="true"]`, currently BlockNote's `div.tiptap.ProseMirror.bn-editor`) | WebDriver key input (raw jamo) | No observable change at all — the document text was unchanged after the keystrokes | No | Real OS-IME composition into the rich editor |
| Rich editor | Synthetic composition events in-page | Events alone: no (ProseMirror reads its DOM through a mutation observer, and a synthetic event mutates nothing). Events paired with the DOM mutation a real engine produces alongside them: yes — the composed word was adopted into the document and survived the observer flush | The event stream plus the browser's DOM half, yes; the OS engine, no | Real OS-IME composition, including undo behaviour and mark/selection interaction during composition |

The boundary this draws, stated plainly: a synthetic stream can drive the
app's own composition-handling code, but it cannot exercise the OS input
method itself. Those prove different things. The working halves (terminal
composition events, rich-editor composition events with DOM mutation) stay in
the native suite as regression tests for the app's handler logic (D-08). The
OS-level half — that a real macOS Korean IME composes correctly into both
surfaces — is human-attended and is not claimed as covered anywhere in this
document.

## macOS menu bar

Recorded 2026-08-29 with `e2e-native/specs/menu.spec.ts` (D-13 surface 4).

The menu bar lives outside the webview and WebDriver cannot reach it; driving
it needs an Accessibility grant no unattended runner can give itself. The
surface therefore splits in two:

**Automated half** — the command path the menu emits into. The spec dispatches
real `command_item` ids from `src-tauri/src/app_menu.rs` through
`window.__MARU_NATIVE_E2E__.menuCommand`, which App.tsx registers into the
same `runMenuCommand` the Tauri `maru://menu-command` listener calls — so the
test exercises the handler the real menu reaches, not a parallel copy. Covered
ids and their asserted DOM consequences:

| Menu id | Menu item | Asserted DOM consequence |
|---------|-----------|--------------------------|
| `view.documents` | View → Documents | The document list opens and shows the seeded document |
| `terminal.shell` | Terminal → New Shell | A native terminal view mounts with a live session |
| `terminal.split` | Terminal → Split Terminal (⌘D) | The terminal body enters split mode with a second, distinct session in the right pane |

**Human-attended half** — that the OS menu bar actually delivers the id.
Clicking a menu item (or pressing a key equivalent the menu owns) is outside
the webview and unscriptable here. Fixed checklist, to be folded into this
document's checklist section by plan 06-05:

1. Open the View menu, click **Documents**; confirm the document list opens.
2. Open the Terminal menu, click **New Shell**; confirm a terminal pane opens
   with a live shell.
3. With the terminal focused, click **Split Terminal** (or press ⌘D); confirm
   a second terminal pane appears to the right.
