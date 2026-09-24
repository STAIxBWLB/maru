# 10-03 Summary

Plan 10-03 ("modePreload.ts first-activation styles preload") shipped both
tasks: the idle mode-chunk preload and the Playwright FOUC spec that guards
first-activation styling for every registered mode.

## What shipped

### Task 1: modePreload.ts (commit 78126271)

- `src/lib/modePreload.ts` — `scheduleModePreload()` wraps
  `scheduleStartupIdle(…, 2000)` and, during browser idle time, loads every
  registered mode's lazy chunk via its registry descriptor
  (`getRegisteredModeIds()` + `getModeDescriptor(id)`), skipping unavailable
  modes and swallowing per-load failures with `.catch(() => {})`. The 2000ms
  timeout is intentionally above the 1500ms startup default: idle preload has
  no UI deadline.
- `src/main.tsx` — wired with exactly two added lines: the
  `import { scheduleModePreload } from "./lib/modePreload";` import and the
  `scheduleModePreload();` call after `markStartup("app:entry")`, before the
  createRoot render.
- D-03 honored: idle-only preload (requestIdleCallback with setTimeout
  fallback + cancel handle), no hover/focus trigger.

### Task 2: first-activation-styles.spec.ts (commit 456e2015)

- `e2e/first-activation-styles.spec.ts` — 38 Playwright tests following
  `e2e/startup.spec.ts`'s structure (localStorage clear in beforeEach, `/`
  navigation). Each test is a fresh context, so every run is a genuine first
  activation starting on the default `문서` (pkm) mode.
- Per non-flag-gated mode FIRST-activation computed-style assertions via
  `expect.poll`: the mode's root surface (`.editor-pane` for pkm, then 16
  rail-toggled modes + `.e2e-pane` via `?maru-e2e=1`) must have
  `display !== "none"`, be painted (composite check:
  `backgroundColor !== "rgba(0, 0, 0, 0)" || backgroundImage !== "none"` —
  gradient panes keep a transparent background-color), and carry the
  Pretendard font stack (`font-family` includes "Pretendard Variable").
- `.mode-loading` fallback verified resolvable in `document.styleSheets` on
  first activation (light + dark describe blocks).
- `.empty-state` single-home pinned via the `갭 분석` (gap) pane empty state:
  computed `display: grid`, `min-height: 104px`, `padding: 20px`
  (`--space-6`), `gap: 6px` (`--space-2`) — the styles.css :17874 winner.
- `test.use({ colorScheme: "light" })` and `test.use({ colorScheme: "dark" })`
  describe blocks; dark is the first-paint FOUC path. Hermetic: no artificial
  sleeps; the idle preload closing the chunk window is the pass condition.
- The app ships `themeMode: "system"` by default, so Playwright's colorScheme
  emulation is effective for both describe blocks.

## Verification

All commands run in the worktree with pnpm 10.x / Node v24.18.1:

| Check | Command | Result |
| --- | --- | --- |
| Unit tests (Task 1) | `pnpm exec vitest run src/lib --reporter=dot` | 1634 tests passed, exit 0 |
| Typecheck (Task 1) | `pnpm typecheck` | exit 0 |
| Lint (both tasks) | `pnpm lint` | exit 0 |
| E2E (Task 2) | `pnpm test:e2e -- first-activation-styles` | 38 passed, exit 0 |
| Build guard chain | `pnpm build:frontend` | exit 0 |

`build:frontend` guard chain detail: `bundle-budget: initial JS 310.3 KiB
gzip <= 320 KiB`, `initial CSS 45.3 KiB gzip <= 70 KiB`,
`native-e2e-isolation: no native-e2e affordances`, `csp-blob: no blob:
script sources`, `mode-css-ownership: 14 CSS chunks, 7 marker-bearing
per-mode files, ownership verified, entry chunk clean`.

## Flagged-assumption dispositions

- **Diagram (flag-gated, opt-out)**: exercised in both describe blocks via
  the same in-app affordance the existing suite uses — the `다이어그램`
  activity-rail click (default-enabled).
- **E2E mode (flag-gated, opt-in)**: exercised via its existing enablement
  hook `?maru-e2e=1` + `E2E 플로우` rail click, matching
  `e2e/maru-e2e-flow.spec.ts`.
- **Criterion 3 (`.mode-loading` in styleSheets)**: scoped to the browser-mode
  Playwright suite per the plan.
- **`expect.poll().toSatisfy`**: not available in @playwright/test 1.59.1
  (first run failed with `Property 'toSatisfy' not found`); replaced with a
  boolean poll returning `"styled"` or a JSON diagnostic string, then
  `.toBe("styled")` so failures still print the offending computed styles.

## Deviations

None beyond the toSatisfy substitution recorded above; no source code changes
were needed for Task 2.

## PERF-05 evidence

The e2e spec proves mode stylesheets land at first activation. The shared-ID
gate #2388 in `.planning/REQUIREMENTS.md` was intentionally NOT touched per
the dispatch: the PERF-05 flip is deferred to the orchestrator after wave 3.
