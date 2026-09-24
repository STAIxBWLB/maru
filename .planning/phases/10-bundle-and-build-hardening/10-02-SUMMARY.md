---
phase: 10-bundle-and-build-hardening
plan: 02
subsystem: frontend-build-css-pipeline
tags: [perf, vite, css, code-split, bundle-budget, guard]
requires: [PERF-03, PERF-04]
provides:
  - per-mode lazy CSS chunks for today/meetings/tasks/calendar (TasksPane, MeetingsPane, TodayPane imports)
  - per-mode lazy CSS chunks for drafts/gap/agents (mode adapter imports)
  - check-mode-css-ownership produced-artifact guard chained into build:frontend
  - check:mode-css-ownership pnpm script
  - check-mode-css-ownership.test.ts policy pin (11 assertions)
affects: [src/styles.css, src/components/today, src/components/meetings, src/components/tasks, src/components/calendar, src/components/drafts, src/components/gap, src/components/agents, scripts/check-bundle-budget.mjs, package.json, Makefile]
tech-stack: [Vite 7.3.2, React 19, TypeScript, vitest, esbuild 0.28.2]
key-files:
  - path: src/styles.css
    change: "18809 lines (was 25006); entry-side shared chrome only"
  - path: src/components/today/today.css
    change: "new, 1998 lines, /*! maru:mode:today */"
  - path: src/components/meetings/meetings-pane.css
    change: "new, 2043 lines, /*! maru:mode:meetings */"
  - path: src/components/tasks/tasks.css
    change: "new, 1346 lines, /*! maru:mode:tasks */"
  - path: src/components/calendar/calendar.css
    change: "new, 836 lines, /*! maru:mode:calendar */"
  - path: scripts/check-mode-css-ownership.mjs
    change: "new produced-artifact guard (red list, full inventory, no cross-chunk duplicates, missing marker, orphaned marker)"
  - path: scripts/check-mode-css-ownership.test.ts
    change: "new hermetic source-assertion policy pin (11 tests)"
  - path: scripts/check-bundle-budget.mjs
    change: "comment refreshed for the split; 320/70 KiB thresholds byte-identical"
decisions:
  - id: D-06
    call: initial-CSS budget stays at the original 70 KiB gzip threshold, never raised
  - id: D-02
    call: entry-side boundary review kept segmented-control, dialog-backdrop, inbox-process-dialog, pkm entries, tokens, FOUC block, sr-only, shared pane-resize-handle in styles.css
metrics:
  initial_js_gzip_kib: 310.2
  initial_css_gzip_kib: 45.3
  initial_css_budget_kib: 70
  styles_css_lines_after: 18809
  styles_css_lines_before: 25006
  per_mode_css_files: 7
  marker_bearing_per_mode_files: 7
  dist_css_chunks: 14
  tests: "2166 vitest + 96 node --test pass"
requirements-completed: "[PERF-05]"
status: complete
actuals:
  tokens: "characters/4 over the realized diff"
  tasks: 3
  commits: 4
---

# Phase 10 Plan 02: Mode CSS Lazy-Chunk Split Summary

## What Was Built

PERF-05: every mode's CSS is out of src/styles.css into per-mode files that ride
each mode's lazy chunk, and the split is guarded in the production pipeline.

- Task 1 (commit ab149808): drafts/gap/agents CSS moved into per-mode files
  imported by their mode adapters; entry chunk shed those rules.
- Task 2 (commit a8e211a3): meetings/today/tasks/calendar CSS moved into
  per-mode files imported by MeetingsPane/TodayPane/TasksPane; calendar.css
  imported by both TasksPane and MeetingsPane. 9 files, +6227/-6200.
- Task 3 (commit 6ac0da7b): `scripts/check-mode-css-ownership.mjs` guard
  chained into `pnpm build:frontend` after check-csp-blob.mjs, plus
  `check:mode-css-ownership` script and an 11-assertion hermetic policy pin
  test in `scripts/check-mode-css-ownership.test.ts`.

## Requirements Met

- [PERF-05] "Every mode's section CSS ships inside that mode's own lazy chunk, proven by the per-file ownership assertion (check-mode-css-ownership.mjs) chained into `pnpm build:frontend`."

## Coverage

- Deliverable: per-mode CSS files under src/components with maru:mode markers
  - Verification: {kind: "grep+script", ref: "src/components/{today,meetings,tasks,calendar,drafts,gap,agents}/*.css line-1 markers; node scripts/check-mode-css-ownership.mjs success line", status: "pass", human_judgment: false}
- Deliverable: check-mode-css-ownership guard chained into build:frontend
  - Verification: {kind: "build", ref: "pnpm build:frontend chained output ends with `mode-css-ownership: 14 CSS chunks, 7 marker-bearing per-mode files, ownership verified, entry chunk clean`", status: "pass", human_judgment: false}
- Deliverable: policy pin test
  - Verification: {kind: "test", ref: "pnpm test: scripts/check-mode-css-ownership.test.ts (11 tests) pass; 2166 vitest + 96 node --test", status: "pass", human_judgment: false}
- Deliverable: D-06 headroom at the original threshold
  - Verification: {kind: "build", ref: "bundle-budget: initial CSS 45.3 KiB gzip <= 70 KiB; thresholds byte-identical to pre-plan", status: "pass", human_judgment: false}

## Verification Detail

- Full rule-level equivalence between pre-surgery styles.css and the new
  chunks was proven by minifying the src CSS with Vite's own esbuild
  (esbuild@0.28.2, transform loader css, minify true) and running a
  char-level brace-walk rule splitter over both sides:
  today 246/246, tasks 174/174, calendar 114/114 rules in their chunks;
  meetings 257/258 exact + 1 via the vite autoprefixer
  `-webkit-backdrop-filter:blur(10px)` insertion (verified not a loss);
  0 self-duplicates anywhere; entry chunk carries zero moved rules.
- Red-fixture drill (acceptance criterion): injected `/*! maru:mode:tasks */`
  into the entry chunk -> guard exited 1 with the named RED LIST violation ->
  fixture deleted, guard green again.
- Dist-marker reality: vite's esbuild forces legalComments:"none", so
  `/*! maru:mode:<id> */` text never survives into dist (verified: grep over
  all 14 dist CSS chunks = 0 hits). The guard therefore asserts dist-side
  ownership by pane-root rule fingerprints (selector + minified body prefix),
  and the src side by the raw-text marker scan the plan specified.

## Deviations from Plan

- Deviation 1: The plan's Task 3 dist-marker assertions (2)(4)(5) assumed
  `/*! maru:mode:<id> */` markers survive into dist CSS chunks. They do not
  (vite forces esbuild legalComments:"none"). Implemented option (b): src-side
  raw-text marker scan plus dist-side pane-root fingerprint assertions
  (selector + body prefix), with the same five named assertion families
  (RED LIST, FULL INVENTORY, NO CROSS-CHUNK DUPLICATES, MISSING MARKER,
  ORPHANED MARKER).
- Deviation 2: Plan files_modified listed src/components/calendar/UnifiedCalendarPane.tsx.
  Left untouched: both TasksPane and MeetingsPane import ../calendar/calendar.css,
  so there is no single owning component to attach the import to. Vite hoists
  calendar.css into the shared fromEntries-*.css chunk, referenced in the CSS
  dep arrays of BOTH MeetingsModeAdapter and TasksModeAdapter lazy chunks
  (proved via __vite__mapDeps index lists and a rule-level minified comparison:
  114/114 calendar rules present).
- Deviation 3: Census corrections during the surgery: two duplicated spans in
  the first cut of today/meetings-m1/m2 were fixed by deterministic
  reconstruction from the HEAD snapshot via a keep-map; a shared sidebar
  sub-rule dropped at a span boundary was restored on both sides; the
  .meetings-review-actions sticky "missing rule" was the vite autoprefixer
  -webkit-backdrop-filter insertion, not a loss.
- Deviation 4: media-980 shared sidebar rule split: styles.css keeps its own
  @media (max-width: 980px) block for the shared sidebar rule; per-mode files
  carry their own. @container taskmain calendar overrides deduped into
  tasks.css only (not duplicated into calendar.css).

## D-02 Boundary Dispositions

- segmented-control: stays in styles.css (shared across modes)
- dialog-backdrop: stays in styles.css
- inbox-process-dialog: stays in styles.css
- pkm entries: stay in styles.css (pkm is on the NO_PER_MODE_CSS exception list)
- todaytasks-container: moved to tasks.css
- calendar home: calendar.css (marker id "calendar", not a mode id) rides the
  shared fromEntries-*.css lazy chunk in both meetings+tasks dep graphs
- calendar tokens (--cal-*): stay entry-side in styles.css
- today-banner FOUC block: stays in styles.css (first-paint)
- sr-only: stays in styles.css (used by sites and others)
- dashboard: out of scope for this plan
- media-980 shared sidebar rule: split by selector, both sides restored

## Known Stubs

None. No stubbed or partial surfaces were introduced.

## Threat Flags

None. The guard adds a new assertion layer to the existing build pipeline; it
does not create new user-facing surface. T-10-05 (guard weakening) is mitigated
by the policy pin test (Task 3) that runs in `pnpm test`, the fail-closed
exit-1 violation branch, and the red-fixture drill recorded above.

## Self-Check: PASSED
