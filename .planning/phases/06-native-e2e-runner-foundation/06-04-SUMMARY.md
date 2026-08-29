---
phase: 06-native-e2e-runner-foundation
plan: 04
subsystem: testing
tags: [ship-isolation, static-guard, cargo-features, tsconfig-references, eslint-flat-config, d-10, d-15]

requires:
  - phase: 06-01
    provides: "tsconfig.e2e-native.json, the default-off native-e2e cargo feature and the optional tauri-plugin-wdio-webdriver dependency the guard asserts"
  - phase: 06-02
    provides: "src/lib/nativeE2eBridge.ts — the __MARU_NATIVE_E2E__ namespace string the bundle half scans for, and build:frontend:native-e2e producing the red-case artifact"
provides:
  - "e2e-native/ inside pnpm typecheck (root tsconfig.json references) and pnpm lint (ESLint block + script), proven fail-first in both directions (D-15)"
  - "scripts/check-native-e2e-isolation.mjs: D-10's artifact-level ship-isolation guard — bundle scan chained into build:frontend (so make verify carries it), manifest assertions on every run, --binary scan wired into release-checks between the debug build and the prune"
  - "make check-native-e2e-isolation / pnpm check:native-e2e-isolation on-demand entry points"
affects: [06-05 (CI wiring inherits the guard through make verify / release-preflight), Phase 8/9 (their native specs run under the same gates)]

actuals:
  tokens: 3249
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "Artifact-over-declaration guard: both halves of D-10 read a produced artifact (dist/assets/*.js, the built binary); the cargo metadata manifest assertions are kept only as a cheap early warning because --no-deps cannot see a feature arriving through a dependency"
    - "Binary scan targets the unstripped debug no-bundle build: it shares the release build's default feature resolution, while a stripped release binary would pass vacuously (T-06-13)"
    - "Fail-first evidence standard: every red case produced by a real build (VITE_NATIVE_E2E=1 bundle, --features native-e2e binary) or a real manifest edit, never a patched source file (T-06-09)"

key-files:
  created:
    - scripts/check-native-e2e-isolation.mjs
  modified:
    - tsconfig.json
    - eslint.config.js
    - package.json
    - Makefile

key-decisions:
  - "The guard's --binary mode also runs the manifest assertions but not the bundle scan, so release-checks can invoke it against a binary without requiring a dist/ to exist"
  - "The Makefile release-checks ordering comment avoids the literal string 'clean:tauri-debug' before the --binary line: the plan's own structural verify one-liner asserts indexOf ordering over the recipe text, and a comment mentioning the prune first would trip it"
  - "Plugin crate strings copied from the resolved tree (registry dir tauri-plugin-wdio-webdriver-1.3.0, lib.rs call tauri_plugin_wdio_webdriver::init()), both confirmed present in the feature-on binary before the green was accepted — a scan that finds nothing in the red case is a wrong search string, not a pass"

patterns-established:
  - "Guard failure messages name the build to re-run (pnpm build:frontend) and the likely way the failure was met (inspecting dist/ after make test-e2e-native)"
  - "Deliberate-break drills on gate registration: an unused local for lint, a type error for typecheck, manifest edits for the guard — observed failing, then reverted, with the observations recorded here"

requirements-completed: [TEST-01]

coverage:
  - id: D1
    description: "e2e-native/ registered in tsc -b (root tsconfig.json reference) and in pnpm lint (ESLint block pointed at tsconfig.e2e-native.json, same two correctness rules as e2e/); header comment and lint script updated to the three-tree scope"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "pnpm typecheck && pnpm lint green; deliberate unused local in e2e-native/helpers/fixtureWorkspace.ts reported by pnpm lint (exit 1), deliberate type error reported by pnpm typecheck (TS2322, exit 2), both reverted and gates green again"
        status: pass
    human_judgment: false
  - id: D2
    description: "Ship-isolation guard: bundle half red on a runner build (naming dist/assets/index-DCYTENzs.js) and green on a production build inside the build:frontend chain; manifest half red on a non-empty default and on the plugin losing optional=true; --binary half red on a --features native-e2e binary (both crate-name forms found), green on the default-feature binary, red on a missing path and on a missing dist/"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "pnpm build:frontend:native-e2e && ! pnpm check:native-e2e-isolation (exit 1); pnpm build:frontend (exit 0, guard success line in chain); cargo build --offline --features native-e2e + --binary scan (exit 1); cargo build --offline + --binary scan (exit 0); two manifest edits observed failing and reverted"
        status: pass
    human_judgment: false
  - id: D3
    description: "Composite gates: make verify green with the guard's success line in its output (no new verify prerequisite); make release-checks green with the --binary scan running before the debug-artifact prune; make test-e2e-native still green (4/4 spec files)"
    requirement: TEST-01
    verification:
      - kind: other
        ref: "make verify (vitest 212 files/1954 tests, cargo 1239 passed, guard success line last); make release-checks (scan line 11367 green, prune at 11371 after it); make test-e2e-native (4 passed, 4 total)"
        status: pass
    human_judgment: false

duration: ~32min
completed: 2026-08-29
status: complete
---

# Phase 06-04: Native Runner Gate Registration and Ship-Isolation Guard Summary

**`e2e-native/` is now inside `pnpm typecheck` and `pnpm lint` (both proven fail-first with deliberate breaks), and D-10's ship-isolation promise is checked against produced artifacts — the built JS bundle inside `make verify`, the built binary inside `release-checks` — with every red case observed from a real build before the green was accepted.**

## Performance

- **Duration:** ~32 min
- **Started:** 2026-08-29T10:53:16Z
- **Completed:** 2026-08-29T11:25:10Z
- **Tasks:** 2/2
- **Commits:** 2 (3474985 chore, 3f2222d feat)

## Accomplishments

- `e2e-native/` registered in the root `tsconfig.json` references (inside `tsc -b`,
  no `-p` flag needed) and in `eslint.config.js` with the same two correctness
  rules as the `e2e/` block; the stale two-tree header comment and the
  `package.json` lint script updated in the same edits.
- `scripts/check-native-e2e-isolation.mjs` written as a member of the
  `check-*.mjs` family: bundle scan for `__MARU_NATIVE_E2E__`, manifest
  assertions (`default` empty, `native-e2e` present, plugin `optional`, nothing
  reachable from `default` enables the plugin), and a `--binary <path>` mode
  scanning the built executable for both crate-name forms with a plain buffer
  `indexOf` — no `strings`, no new dependency.
- Wired exactly where the plan put it: chained into `build:frontend` after
  `check-bundle-budget.mjs` (so `make verify` carries it with no new
  prerequisite), the `--binary` scan inside `release-checks` between the debug
  no-bundle build and the prune, and standalone
  `check:native-e2e-isolation` / `make check-native-e2e-isolation` entry points.
- Every acceptance drill observed: runner-bundle red (naming the chunk),
  production green, feature-on binary red (both string forms found — the scan
  is not vacuous), default binary green, missing `dist/` red with a named fix,
  missing `--binary` path red, two manifest breaks red and reverted, `make
  verify` / `make release-checks` / `make test-e2e-native` all green.

## Task Commits

1. **Task 1: Register e2e-native as a TypeScript project and an ESLint target** — `3474985` (chore)
2. **Task 2: Artifact-level ship-isolation guard wired into the build chain** — `3f2222d` (feat)

**Plan metadata:** recorded below in the final docs commit.

## Files Created/Modified

- `scripts/check-native-e2e-isolation.mjs` — the D-10 guard (209 lines)
- `tsconfig.json` — added `./tsconfig.e2e-native.json` to `references`
- `tsconfig.e2e-native.json` — read and confirmed unchanged (include exactly
  `["e2e-native"]`, distinct tsBuildInfoFile, no `composite`, wdio/mocha types)
- `eslint.config.js` — `e2e-native/**/*.ts` block + three-tree header comment
- `package.json` — lint covers `e2e-native`; guard chained into
  `build:frontend`; `check:native-e2e-isolation` script added
- `Makefile` — `check-native-e2e-isolation` .PHONY target; `--binary` scan in
  `release-checks` before the debug-artifact prune

## Decisions Made

- `--binary` mode runs manifest assertions plus the binary scan, not the bundle
  scan — `release-checks` must be invocable without a `dist/` contract beyond
  what its own `verify` prerequisite already produced.
- The release-checks ordering comment reworded to avoid the literal
  `clean:tauri-debug` string before the `--binary` line, because the plan's own
  structural verify asserts `indexOf('--binary') < indexOf('clean:tauri-debug')`
  over the raw recipe text — a comment naming the prune first would trip it.
- Both plugin crate-name forms were confirmed present in the feature-on binary
  before accepting the default-build green, per the plan's
  wrong-search-string-is-not-a-pass rule.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Release-checks comment tripped the plan's own structural verify**
- **Found during:** Task 2 (first run of the plan's Makefile wiring one-liner)
- **Issue:** The recipe comment explaining the ordering constraint named
  `clean:tauri-debug` literally, so `rc.indexOf('--binary') >
  rc.indexOf('clean:tauri-debug')` and the check reported the scan as running
  after the prune even though the command order was correct.
- **Fix:** Reworded the comment to "the debug-artifact prune below" — same
  explanation, no literal target name before the scan line.
- **Files modified:** Makefile
- **Verification:** The plan's structural one-liner exits 0; `make
  release-checks` run confirms the scan executes before the prune (log lines
  11366-11373).
- **Committed in:** 3f2222d

---

**Total deviations:** 1 auto-fixed (1 Rule 1)
**Impact on plan:** Comment-text only; no behavior change, no scope creep.

## Issues Encountered

- During Task 1's drills, the first lint-drill line was left in place when the
  typecheck-drill edit was applied (both anchored on the same line); the
  combined state was caught immediately by the post-drill gate run and the
  leftover line removed before committing. No commit carried drill code.

## User Setup Required

None.

## Next Phase Readiness

- 06-05 (CI wiring + docs) inherits: the guard running inside `make verify`
  and `release-checks`, the `check-native-e2e-isolation` entry points, and
  `e2e-native/` under the standard gates — CI jobs can rely on all three.
- `make test-e2e-native` remains outside `verify` and green (4/4 spec files).
- No blockers.

---
*Phase: 06-native-e2e-runner-foundation*
*Completed: 2026-08-29*

## Self-Check: PASSED

- All six files confirmed on disk (guard script, tsconfig.json, eslint.config.js, package.json, Makefile, this SUMMARY).
- Both commits found in git log: 3474985 (chore, Task 1), 3f2222d (feat, Task 2).
- Verify evidence: `pnpm typecheck` + `pnpm lint` green with e2e-native covered; both deliberate-break drills observed failing and reverted; guard red on runner bundle / feature-on binary / missing dist / missing binary path / both manifest breaks, green on production bundle / default binary; `make verify`, `make release-checks` (scan before prune), and `make test-e2e-native` (4/4) all exit 0.
