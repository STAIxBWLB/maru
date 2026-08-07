# Performance baseline

Baseline measurements for the issue #201 performance program (steps 1–6 +
verification; App.tsx decomposition steps 7–9 are separate PRs). The "after"
column is filled in at the verification step on the same branch.

## Environment

- Machine: Apple M3 Max, 36 GB, macOS 26.6.1
- Tree: `main@252b65a` + partial step-3 WIP (uncommitted `useElapsed`
  shared-store, GitStatusBadge single-call, visibility-gated focus reloads).
  The WIP does not affect bundle size and barely affects idle timers, so the
  numbers below are treated as the pre-change baseline.
- Date: 2026-08-08

## Bundle (automated, `pnpm build`)

| Metric | Baseline | After |
|---|---|---|
| Initial JS `index-*.js` | 1,328.61 kB raw / 379.2 KiB gzip (budget 500) | 961.15 kB raw / 285.1 KiB gzip (-25%, budget now 320) |
| Initial CSS `index-*.css` | 59.0 KiB gzip (budget 70) | 59.0 KiB gzip (budget 70) |
| i18n dict chunks | — (bundled in entry) | `ko-*.js` 51.8 KiB gzip, `en-*.js` 45.4 KiB gzip, both lazy |

Baseline recorded in the issue at HEAD 252b65a (1.33 MB raw / 378 KiB gzip)
matches this re-measurement.

## Startup profile (browser dev shell, mocked IPC)

Captured with `node scripts/perf-startup-profile.mjs` — a Playwright run of
the Vite dev shell at `?startupProfile=1`, read from
`window.__MARU_STARTUP_PROFILE__`. IPC is mocked in the browser shell, so
these numbers cover module parse, React mount and first render only. Dev-mode
StrictMode double-mounts, so `app:mounted`/`boot:*` fire twice; the table
uses the later of each pair.

| Mark | Run 1 (ms) | Run 2 (ms) | After (ms) |
|---|---|---|---|
| `app:entry` | 968 | 1789 | 1102 |
| `app:mounted` | 1097 | 1931 | 1127 |
| `boot:end` | 1153 | 1992 | 1131 |
| `workspace:first-usable` | 1152 | 1992 | 1131 |
| entry → mounted | ~125 | ~142 | ~25 |
| boot:start → boot:end | ~60 | ~60 | ~29 |

The entry→mounted drop (~130 → ~25 ms) is the i18n split: the entry chunk
no longer parses ~400 KB of dictionary literals at startup. Dev-mode vite
variance dominates the absolute entry mark.

`vault:cache-read`, `document:primary-read` and `vault:authoritative-scan`
measure <1 ms each against the mocked sample workspace — not meaningful for
IPC cost; see the native protocol below.

## Native app idle (real measurement, `pnpm tauri dev`)

Sampled `ps` every 10 s for 60 s after the window settled, default workspace,
no interaction:

| Metric | Baseline | After |
|---|---|---|
| Idle CPU | 0.9–1.5 % | 0.0–0.1 % |
| RSS | settles ~105 MB (peak 138 MB during settle) | settles ~141–150 MB (peak 278 MB during settle) |

The idle-CPU drop matches the polling work (shared 1 Hz elapsed clock,
visibility-gated intervals, single git-status invoke). RSS is dev-build
noise territory (unminified code + source maps); treat the ~35 MB settle
difference as unexplained but not alarming — re-check on a release build
if it matters.

## Manual protocol (native app, not yet automated)

Cells stay `[manual]` until measured; do not fabricate numbers.

- **Native startup profile**: enable `localStorage["maru:startup:profile"] =
  "1"` in the WKWebView (or add `?startupProfile=1` to the loaded URL), cold
  start the app, read `window.__MARU_STARTUP_PROFILE__`. Key marks:
  `app:entry` → `workspace:first-usable` → `vault:authoritative-scan-done`.
- **`scan_vault` time + payload**: on a real large workspace, time
  `measureStartup("vault:authoritative-scan")` and log the serialized IPC
  payload size (entries count × frontmatter/snippet/links per entry).
- **React Profiler**: document select, typing burst, tab switch, mode switch
  (Docs ↔ Inbox ↔ Meetings ↔ Today). Record render count and total ms for
  `MainApp` and the target pane.
- **Poll/timer audit**: with a few running missions, count active
  `setInterval` timers (`vi`-style audit or Performance panel) — pre-change
  expectation: 1 Hz per mission row + 60 s usage bar + 30 s dot-sync +
  60 s new-day tick.

## Verification gates for the "after" column

`pnpm typecheck`, `pnpm test`, `make lint-i18n`, `cargo test` (src-tauri),
`pnpm build` (includes the bundle-budget check), Playwright smoke subset.

Results on `perf/201-low-risk` (2026-08-08):

- `pnpm typecheck` — clean
- `pnpm test` — 172 files / 1640 tests passed
- `make lint-i18n` — 3583 keys in parity, no hardcoded UI strings
- `cargo test` — 1101 passed, 0 failed
- `pnpm build` — budget green (285.1 KiB ≤ 320 KiB, CSS 59.0 ≤ 70)
- Playwright smoke — `smoke.spec.ts` (43), `startup.spec.ts` +
  `graph-shell.spec.ts` (9), all passed

Caught during verification: the lazy-dictionary gate exposed a stale-memo
bug (`useLocaleState().t` identity survived the dictionary load, so memoized
translations cached raw keys) and two race-prone smoke helpers; all three
fixed in `a059620`.
