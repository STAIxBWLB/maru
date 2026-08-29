# Native e2e runner

Runbook and evidence log for the native WebDriver e2e runner (`e2e-native/`,
`make test-e2e-native`). This file currently carries only the spike log;
plan 06-05 completes the rest of the document.

## Spike log

Scope of this section: **session establishment only** — whether the embedded
WebDriver provider establishes a session on a hosted macOS runner with no
interactive permission prompt. This is D-01's first condition only, not the
full three-condition CI-viability verdict (the PTY condition comes from plan
06-02).

Rules (06-CONTEXT.md D-02): an observed interactive/TCC permission prompt
settles the verdict as local-only on the spot, with no further attempts. Every
other failure class is retried within a cap of **3** hosted macOS job runs
total. The cap and the observed failure class are both recorded here.

Retry cap: 3 hosted runs. Runs used: 1.

### Attempts

| # | Date | Run URL | Result | Failure class | What changed before next attempt |
|---|------|---------|--------|---------------|----------------------------------|
| 1 | 2026-08-29 | https://github.com/STAIxBWLB/maru/actions/runs/33243419439 | pass | — (no failure; no permission prompt) | — (cap not needed) |

### Running verdict

`ci-viable-pending-full-suite`

Attempt 1 passed on the first hosted run: the embedded WebDriver provider
established a session on `macos-14` with no interactive permission prompt and
the suite ran green (`1 passing (46s)`, 1 spec). No TCC dialog appeared in the
log, and the failure-path screencapture step never fired. This settles only
session establishment; D-01's remaining conditions (PTY readability via the
canvas ink check from plan 06-02, and a full unattended run) are still open, so
this is not yet the phase verdict.

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
