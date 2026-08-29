# Native e2e runner

Runbook and evidence log for the native WebDriver e2e runner (`e2e-native/`,
`make test-e2e-native`).

The native runner drives the real Maru application — the real WKWebView DOM, a
real PTY, and IME input — against the real Rust backend. It is macOS-only and
lives in `e2e-native/`, separate from the Playwright suite in `e2e/`. Nothing
it adds reaches a shipped build: every runner-only affordance sits behind the
default-off `native-e2e` cargo feature and the `VITE_NATIVE_E2E` build flag,
and `scripts/check-native-e2e-isolation.mjs` proves against the produced
artifacts (the JS bundle inside `make verify`, the built binary inside
`make release-checks`) that neither leaks into a production build.

## How to run

```bash
make test-e2e-native
```

The target builds the frontend with `VITE_NATIVE_E2E=1`
(`pnpm build:frontend:native-e2e`), forces the maru crate to re-embed that
frontend (cargo does not track `dist/` as a build input, so the target touches
`src-tauri/build.rs` between the two builds), builds the app with
`--features native-e2e`, then runs WebdriverIO (`e2e-native/wdio.conf.ts`)
against it. Each run seeds a fresh temporary fixture workspace and points the
app at it through `MARU_NATIVE_E2E_HOME` / `MARU_NATIVE_E2E_CONFIG_DIR`; the
developer's real workspace is never opened (D-09), and the app's outbound
providers stay unconfigured for the whole run (D-11).

The `dist/` the run leaves behind is deliberately **not shippable** — it
carries the debug bridge. Re-run `pnpm build:frontend` before inspecting a
production artifact; the ship-isolation guard inside `make verify` fails the
build on a runner bundle.

To run a single spec file, use
`pnpm exec wdio run e2e-native/wdio.conf.ts --spec e2e-native/specs/pty.spec.ts`.
Passing `-- --spec …` through `pnpm test:e2e:native` does **not** work — pnpm
forwards a literal `--` and wdio silently runs the whole suite.

**Which target runs which suite:** `make test-e2e` is the Playwright suite —
Chromium against the Vite dev server with mocked IPC. `make test-e2e-native`
is WebdriverIO against the real backend in the real app. They share no runner
and no premise, so a green result from one says nothing about the other.

## CI placement

Verdict: **ci-viable** (per-condition evidence in `## Spike log` below).
Consequences:

- **Every pull request:** the `native-e2e-compile` job in
  `.github/workflows/ci.yml` runs on `macos-14` — install, `pnpm typecheck`,
  `pnpm lint`, and `cargo check --locked --features native-e2e`. It compiles
  and typechecks the runner so it cannot rot between releases; it never
  executes the suite (D-03).
- **Pushes to `main` and release tags (`v*`):** the `native-e2e-suite` job in
  `.github/workflows/native-e2e.yml` runs the full suite unattended and
  uploads failure evidence (run log plus a screencapture of the runner's
  screen). Per-PR execution was rejected on macOS runner cost and
  early-flakiness grounds; release-tag-only was rejected because it finds
  regressions at the worst possible moment (D-16).
- **A human must run:** `make release-preflight`, which blocks on
  `make test-e2e-native` on every machine regardless of the verdict (D-03),
  and the checklist below.

## Human-attended checklist

D-08's split, stated plainly: the synthetic-composition specs inside the
runner guard the app's own composition-handling logic at the native level,
and this checklist covers the OS input method itself — the half no synthetic
event stream can exercise (per-surface evidence in `## IME sub-spike`). Work
every item and record a per-item observation, not a single overall yes.

**macOS menu bar.** Clicking a menu item is outside the webview and needs an
Accessibility grant no unattended runner can give itself; the command path the
menu emits into is covered by `e2e-native/specs/menu.spec.ts` (see
`## macOS menu bar`).

1. Open the View menu, click **Documents**. Expected: the document list
   opens.
2. Open the Terminal menu, click **New Shell**. Expected: a terminal pane
   opens with a live shell.
3. With the terminal focused, click **Split Terminal** (or press ⌘D).
   Expected: a second terminal pane appears to the right of the first.

**Korean IME, two-set (두벌식) input source.** On both surfaces the sub-spike
showed WebDriver key input never composes, so real OS-IME behavior is checked
by a human:

4. In a native terminal, switch to the macOS Korean 2-set input source and
   type `한글` (six raw jamo: ㅎㅏㄴㄱㅡㄹ). Expected: the jamo compose into
   syllables as you type, and the committed word appears **exactly once** —
   no trailing duplicate syllable after composition ends (the
   `isTrailingCompositionDuplicate` window).
5. Still in the terminal, type one syllable and press Enter mid-composition.
   Expected: the in-progress syllable commits and no command executes; a
   second Enter sends the line. Then start a composition and click elsewhere
   to abandon it. Expected: no residue or doubled text on the screen when
   focus returns.
6. In a rich editor document (open a document, switch to Rich mode), type
   `한글` with the same input source. Expected: the composed word lands in
   the document, and undo during/after composition plus mark/selection
   interaction behave as the engine specifies.

### Observations — 2026-08-29 (plan 06-05 ratification)

Worked end to end on the current debug build under fixture isolation.
Measurement note applying to all items: the debug binary and the installed
Maru.app share a process name, and early probes that targeted the process by
name hit the wrong app — every recorded result below used PID-targeted
accessibility calls.

1. **View > Documents — PASS.** Before the OS menu click: active mode 오늘,
   no `.document-list`. After: active mode 문서, `.document-list` present.
2. **Terminal > New Shell — PASS.** Terminal canvas created; the text mirror
   shows a real zsh prompt running in the fixture workspace's cwd.
3. **Split Terminal — PASS.** Panes 1 → 2, distinct session IDs.
4. **Terminal, Korean 2-set, 한글 — PASS WITH KNOWN ISSUE.** Composition
   works and the committed word lands exactly once, BUT the first syllable
   typed immediately after switching the input source from English to Korean
   2-set arrives decomposed (ㅎㅏㄴ as raw jamo instead of composed 한); from
   the second character onward composition is normal. Recorded as a known
   issue — suspected WKWebView IME-context attach race on input-source
   switch. Not a runner defect: the app's composition handlers are guarded by
   the 06-03 specs.
5. **Terminal, Enter mid-composition / abandon-by-click — PASS.** No command
   executed on composition Enter; no residue or doubled text after abandoning
   a composition (user-observed).
6. **Rich editor, Korean 2-set, 한글 + undo/mark interactions — PASS.** No
   anomalies (user-observed).

## Known limits

- The runner targets **debug builds** (`cargo build --features native-e2e`).
  A hardened-runtime, notarized `.app` restricts automation mechanisms a
  debug build permits, so a green run does not transfer to a signed release
  artifact without re-verification against that artifact.
- The four D-13 surface specs are minimum-size proofs that each surface can
  be driven at all, not suite breadth; phases that need more (Phase 8's load
  test, Phase 9's SIGHUP test) attach their own specs to this runner (D-14).
- IME coverage is the app's own composition handlers only; the OS input
  method itself is the human checklist above (D-08).
- Cross-spec-file fixture state is not reset (resets are between tests inside
  a spec file, D-12); a spec that needs a fresh per-file workspace must
  re-seed at the launcher level.

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
compile-and-typecheck job only (D-16), and the spike workflow is retired.

### Ratification

The plan 06-05 blocking human checkpoint ratified this verdict item by item on
2026-08-29, with the evidence named per condition:

1. **Session establishment with no interactive prompt — YES.** Runs
   33243419439 (1 spec) and 33250704926 (4 specs) both show zero
   TCC/permission lines; the failure-screencapture step was `skipped` in both
   (it only fires on failure/timeout), and timings were normal (4m47s and
   4m09s). A modal would have surfaced as a hang-to-timeout.
2. **Real PTY output read through the canvas surface — YES.** Run
   33250704926's log shows `pty.spec.ts 1 passing (4.7s)` — the
   shell-produced marker (echo-spoof-proof) plus the canvas ink check.
3. **A full run completed with no human present — YES.** Run 33250704926:
   `4 passed, 4 total` in a `workflow_dispatch` job with no human present; the
   merged `native-e2e-suite` job carries ongoing proof.

Blocking local gate: `make release-preflight` exited **0** on macOS
(2026-08-29, attempt 4; attempts 1-3 failed only on two pre-existing flaky
tests — the editorSurfaceRenderIsolation vitest timing test and the
graph.spec ghost-node test under parallel load — plus a missing Playwright
browser install; each passed on rerun, and none implicate phase 06 changes).

CI placement reconfirmed at ratification: the `ci.yml` diff is purely additive
(0 deleted lines, new `native-e2e-compile` job), `native-e2e.yml` exists, and
`native-e2e-spike.yml` is deleted.

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
the webview and unscriptable here. The fixed checklist lives in
`## Human-attended checklist` above (items 1-3), folded in by plan 06-05.
