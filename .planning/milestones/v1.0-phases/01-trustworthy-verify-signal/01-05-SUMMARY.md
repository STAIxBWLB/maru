---
phase: 01-trustworthy-verify-signal
plan: 05
subsystem: testing
tags: [typescript, tsc-project-references, checkjs, jsdoc, scripts]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: "01-04's tsconfig.e2e.json sibling shape and @types/node@22.20.1 devDependency"
provides:
  - "tsconfig.scripts.json: allowJs+checkJs, strict:false, DOM+ES2022 lib, covering all 17 scripts/*.mjs files (plus scripts/lib/), zero errors"
  - "tsconfig.json references tsconfig.scripts.json, completing GATE-03 (e2e/ half from 01-04, scripts/ half here)"
affects: ["01-06 (eslint.config.js's scope is src/+e2e/ per D-03, so no direct dependency, but scripts/ is now typechecked alongside whatever lint scope 01-06 adds)"]

actuals:
  tokens: 1400
  tasks: 3
  commits: 3

tech-stack:
  added: []
  patterns:
    - "A destructured parameter object with only some properties carrying a default (`{ a, b = x } = {}`) needs an explicit @param JSDoc type, or checkJs infers the parameter's shape only from the defaulted properties and errors on every access to the rest"
    - "An array built as `.map(() => [a, b])` without a tuple annotation widens to T[][], not [A,B][]; new Map(...) then rejects it. Fix at the source with @returns {Array<[K,V]>} or an inline @type tuple cast, not by touching the Map call site"
    - "A Window global declared only via `declare global { interface Window {...} }` in src/ is invisible to scripts/'s separate tsc project; mirror e2e/startup.spec.ts's inline `/** @type {Window & {...}} */ (window)` cast instead of trying to share the ambient declaration across project boundaries"

key-files:
  created:
    - tsconfig.scripts.json
  modified:
    - tsconfig.json
    - scripts/lib/releaseVersion.mjs
    - scripts/lib/provisioningProfile.mjs
    - scripts/lib/updaterManifest.mjs
    - scripts/lib/updaterManifest.test.mjs
    - scripts/perf-startup-profile.mjs
    - scripts/publish-updater-manifest.mjs

key-decisions:
  - "Kept composite: true on tsconfig.scripts.json, unlike 01-04's tsconfig.e2e.json deviation. Empirically verified: scripts/ has no cross-project import (unlike e2e/workbench-layout.spec.ts's import of src/lib/settings.ts), so composite's stricter file-list enforcement never triggers the TS6307 boundary error 01-04 hit. Direct tsc -p run confirmed zero TS6307/TS2688 diagnostics with composite on."
  - "Re-measured the scripts/ error count rather than trusting RESEARCH.md's stored 44/9: got 42 errors across 8 files. All 42 traced to the same one shape (a destructured-options JSDoc gap); RESEARCH.md's number was from an earlier probe session and is a reasonable estimate, not a mismeasurement worth chasing further."
  - "GATE-03 marked complete in REQUIREMENTS.md: this plan finishes the scripts/ half 01-04 deliberately left open."

patterns-established:
  - "Destructured-parameter JSDoc types are written as inline object literal types on the @param tag (`@param {{ a?: string, b?: number }} [options]`), matching the shape callers already document in prose above the function, rather than promoting to a named @typedef, keeps the fix colocated and small for a 17-script, no-TypeScript-conversion backlog."

requirements-completed: [GATE-03]

coverage:
  - id: D1
    description: "scripts/ is typechecked by tsc -b: tsconfig.scripts.json exists (allowJs+checkJs, strict:false, ES2022+DOM lib, types:[\"node\"], include:[\"scripts\"]) and is referenced from tsconfig.json, with zero real errors across all 17 .mjs scripts plus scripts/lib/"
    requirement: "GATE-03"
    verification:
      - kind: unit
        ref: "pnpm exec tsc -p tsconfig.scripts.json (exit 0, zero diagnostics)"
        status: pass
      - kind: unit
        ref: "pnpm typecheck (tsc -b, exit 0) with all four project references live"
        status: pass
      - kind: e2e
        ref: "break-and-revert: scripts/check-release-version.mjs deliberate number-for-string tag, tsc -b failed with TS2322 naming the file, reverted, exit 0, git status clean"
        status: pass
      - kind: unit
        ref: "make verify end to end: typecheck, release-version-check, icons-check, lint-i18n, check-select-chrome, check-type-tokens, vitest (1853/1853), cargo test --lib (1199/1199), fmt-check, clippy -D warnings, build-frontend/bundle-budget, all green"
        status: pass
    human_judgment: false
  - id: D2
    description: "Every script still does exactly what it did before: all 6 files' fixes are type-only (JSDoc @param annotations, an inline @type cast, a tuple return-type annotation, and one dead duplicate object-literal key removed)"
    requirement: "GATE-03"
    verification:
      - kind: unit
        ref: "pnpm test (vitest run src scripts), 1853/1853 unchanged from 01-04's baseline"
        status: pass
      - kind: unit
        ref: "pnpm lint:i18n, pnpm check:select-chrome, pnpm icons:check, all exit 0, output unchanged"
        status: pass
    human_judgment: false

duration: ~15min (active)
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 05: scripts/ Typecheck Coverage Summary

**`tsconfig.scripts.json` brings all 17 `scripts/*.mjs` build/release scripts under `tsc -b` with `checkJs`, fixing 42 pre-existing errors that all trace to one shape: a destructured-options parameter checkJs cannot infer past its default-bearing properties.**

## Performance

- **Duration:** ~15 min active executor work (Task 1 commit 17:24 KST to Task 3 commit 17:31 KST, plus investigation before the first commit)
- **Started:** 2026-08-22
- **Completed:** 2026-08-22T17:31:17+09:00
- **Tasks:** 3/3
- **Files modified:** 8 (1 created, 7 modified)

## Accomplishments

- `tsconfig.scripts.json` created (`allowJs`+`checkJs` true, `strict: false` per D-10, `lib: ["ES2022","DOM"]`, `types: ["node"]`, `include: ["scripts"]`, own `tsBuildInfoFile`), proven at zero errors via a direct `tsc -p` run before being wired into the gate
- Re-measured the error count rather than trusting RESEARCH.md's 44/9: found **42 errors across 8 files** (`scripts/lib/updaterManifest.test.mjs` 13, `scripts/lib/releaseVersion.mjs` 11, `scripts/lib/updaterManifest.mjs` 8, `scripts/publish-updater-manifest.mjs` 5, `scripts/perf-startup-profile.mjs` 2, `scripts/lib/provisioningProfile.{mjs,test.mjs}` 1 each, `scripts/check-macos-direct-distribution.mjs` 1)
- All 42 errors traced to one root cause: `function f({ a, b = defaultB } = {})` destructured-parameter patterns where checkJs infers the object's shape only from properties carrying an inline default, so every access to a property without a default (the common case for a required-but-validated-at-runtime option) errors as "does not exist on type". Fixed with explicit `@param` JSDoc object-literal types on 4 functions across `releaseVersion.mjs`, `provisioningProfile.mjs`, `updaterManifest.mjs`, and `publish-updater-manifest.mjs`
- `scripts/perf-startup-profile.mjs`'s two `window.__MARU_STARTUP_PROFILE__` references inside Playwright `page.evaluate`/`page.waitForFunction` callbacks fixed with an inline `/** @type {Window & {...}} */ (window)` cast, mirroring the existing pattern in `e2e/startup.spec.ts` for the identical global (the `declare global` in `src/lib/startupProfile.ts` is invisible to the separate `scripts/` tsc project)
- `scripts/lib/updaterManifest.test.mjs`'s `signatureEntries()` helper annotated `@returns {Array<[string, string]>}` so `new Map(...)` resolves the tuple overload instead of the rejected `string[][]` inference; a dead duplicate `release` object-literal key (already unconditionally shadowed by a later spread+reassert) removed, a TS1117-triggering no-op
- `tsconfig.json`'s `references` array now includes `tsconfig.scripts.json` (4th entry), flipping GATE-03's `scripts/` half live inside `pnpm typecheck` (= `tsc -b` = an existing `make verify` prerequisite, no Makefile edit needed)
- Break-and-revert proof executed: a deliberate number-for-string `tag` in `scripts/check-release-version.mjs` failed `tsc -b` with `TS2322: Type 'number' is not assignable to type 'string'`, naming the file; reverted, `pnpm typecheck` green, `git status --short scripts/` empty
- Full `make verify` run end to end with all four project references, the format gate, and the clippy gate live together: `typecheck`, `release-version-check`, `icons-check`, `lint-i18n`, `check-select-chrome`, `check-type-tokens`, `vitest` (1853/1853), `cargo test --lib` (1199/1199), `fmt-check`, `clippy -- -D warnings`, `build-frontend`/bundle-budget, all green

## Task Commits

Each task was committed atomically:

1. **Task 1: Create tsconfig.scripts.json unreferenced and inventory the real error list** - `a484770` (feat)
2. **Task 2: Drive the scripts type errors to zero with type-only fixes** - `521734d` (fix)
3. **Task 3: Flip the gate by referencing tsconfig.scripts.json, then prove it goes red** - `09bca1e` (feat)

**Plan metadata:** _(this commit, made after this SUMMARY)_

## Files Created/Modified

- `tsconfig.scripts.json` - new project config for `scripts/`; `allowJs`+`checkJs`, `strict: false`, `ES2022`+`DOM` lib, `types: ["node"]`, `composite: true` (see Decisions), own `tsBuildInfoFile`
- `tsconfig.json` - `references` array gained `{ "path": "./tsconfig.scripts.json" }` (4th entry, after `tsconfig.e2e.json`)
- `scripts/lib/releaseVersion.mjs` - `@param {Record<string, unknown>} [surfaces]` and `@param {{ tag?: string | null }} [options]` on `validateReleaseVersions` (11 errors)
- `scripts/lib/provisioningProfile.mjs` - `@param` object-literal type on `evaluateProvisioningProfile`'s options, including the previously-uninferred `expectedBundleId` (1 error here, cascaded to fix 2 more at call sites)
- `scripts/lib/updaterManifest.mjs` - `@param` object-literal type on `buildUpdaterManifest`'s options (8 errors here, cascaded to fix call-site errors in `publish-updater-manifest.mjs` and its test)
- `scripts/lib/updaterManifest.test.mjs` - `signatureEntries()` return type + inline tuple cast; removed a dead duplicate `release` key (13 errors)
- `scripts/perf-startup-profile.mjs` - inline `@type` cast on `window` inside two Playwright callbacks (2 errors)
- `scripts/publish-updater-manifest.mjs` - `@param` object-literal type on `downloadUpdaterSignatures`'s options, all properties optional to match its own `= {}` runtime default (5 errors, cascaded from `updaterManifest.mjs`'s fix plus 1 own)

## Decisions Made

- **`composite: true` kept on `tsconfig.scripts.json`**, unlike 01-04's `tsconfig.e2e.json` deviation. Verified empirically before committing: `scripts/` has no cross-project import analogous to `e2e/workbench-layout.spec.ts`'s `../src/lib/settings.ts` import, so `composite`'s stricter same-project file-list enforcement never surfaces a spurious `TS6307`. A direct `tsc -p tsconfig.scripts.json` run with `composite: true` set produced exactly the 42 real errors and nothing else.
- **Re-measured 42 errors across 8 files, not RESEARCH.md's stored 44 across 9.** All 42 traced to one JSDoc-inference gap (destructured options object with a partial-default shape). RESEARCH.md's number came from an earlier probe session; the divergence is not investigated further since the actual fix work matched RESEARCH.md's characterization exactly ("real JSDoc-type mismatch work rather than mechanical").
- **GATE-03 marked complete in REQUIREMENTS.md.** 01-04 finished the `e2e/` half and deliberately left this requirement open; this plan finishes the `scripts/` half, completing the requirement.

## Deviations from Plan

None - plan executed exactly as written. The plan's Task 1 action text already flagged `composite: true` as untested-but-plausible ("with the same caveat" as 01-04); it worked cleanly here on the first attempt, so no deviation from 01-04's precedent was needed.

## Issues Encountered

None.

## Cross-Platform Risk Assessment (CI runs ubuntu-22.04, this session ran macOS)

Low risk, same reasoning as 01-04: every change in this plan is a `tsconfig` compiler-config addition or a JSDoc type annotation/cast erased before any JS runs. `tsc -b`'s project-reference handling and JSDoc type inference do not depend on OS. `scripts/perf-startup-profile.mjs`'s `process.platform === "win32"` branch (pre-existing, untouched) is the only OS-conditional code path this plan's file touches, and it was not modified. `@types/node`'s ambient ecosystem is unchanged from 01-04 (no re-install, no version change).

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- GATE-03 fully satisfied (`e2e/` from 01-04, `scripts/` here); marked complete in REQUIREMENTS.md
- `pnpm typecheck` exits 0 at HEAD with all four project references (`app`, `node`, `e2e`, `scripts`) live
- `make verify` passes end to end with the format gate, clippy gate, and all typecheck references active together, this is the first point in the phase all of GATE-01/02/03/05 have run concurrently, and nothing surfaced an interaction between them
- 01-06 (lint) scope per D-03 is `src/` + `e2e/`; `scripts/` stays out of ESLint's scope by design, so this plan's work does not overlap 01-06's

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*

## Self-Check: PASSED

All 8 files created/modified verified present on disk; all 3 task commit hashes (`a484770`, `521734d`, `09bca1e`) verified present in git log.
