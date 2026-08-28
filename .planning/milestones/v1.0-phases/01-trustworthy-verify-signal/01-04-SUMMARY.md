---
phase: 01-trustworthy-verify-signal
plan: 04
subsystem: testing
tags: [typescript, tsc-project-references, playwright, dompurify, types-node]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: "01-01's rust-toolchain.toml pin and fmt-check gate (parallel wave, no direct dependency, but same phase)"
provides:
  - "tsconfig.e2e.json: a strict, DOM+DOM.Iterable+node-typed tsc project covering e2e/, with zero errors"
  - "@types/node@22.20.1 as a devDependency, required by this plan's tsconfig.e2e.json and by 01-05's tsconfig.scripts.json"
  - "@types/dompurify removed from dependencies (GATE-06 fully satisfied)"
  - "tsconfig.json references tsconfig.e2e.json, so tsc -b (= pnpm typecheck = a verify prerequisite) now typechecks e2e/"
affects: ["01-05 (tsconfig.scripts.json, same @types/node install)", "01-06 (eslint.config.js's e2e/**/*.ts type-aware block points at tsconfig.e2e.json)"]

actuals:
  tokens: 2600
  tasks: 4
  commits: 4

tech-stack:
  added: ["@types/node@22.20.1 (devDependency)"]
  patterns:
    - "tsc -b solution-file references array grows by one entry per new leaf project; files stays []"
    - "unknown[] fixture arrays narrowed at the point of use with an inline `(x as { field?: T })` cast, matching the existing todayFixtures.ts convention, rather than typing the whole array"

key-files:
  created:
    - tsconfig.e2e.json
  modified:
    - package.json
    - pnpm-lock.yaml
    - tsconfig.json
    - e2e/drafts.spec.ts
    - e2e/helpers/todayFixtures.ts
    - src/components/ScratchpadPane.tsx

key-decisions:
  - "Left composite: true off tsconfig.e2e.json, deviating from the plan's literal action text. Verified empirically that tsc -b accepts the solution-file reference without it, and that composite: true introduces a spurious TS6307 project-boundary error unrelated to the real e2e type backlog (see Deviations)."
  - "Did not mark GATE-03 complete in REQUIREMENTS.md. It is a single requirement covering both e2e/ and scripts/; this plan only finishes the e2e/ half. Marked GATE-06 complete only."

patterns-established:
  - "A Playwright addInitScript closure that seeds an array with `const x = [...]` and later assigns a wider value into an element needs an explicit array element type; TS infers the narrowest type from the initial literals, not the type's full later use."

requirements-completed: [GATE-06]

coverage:
  - id: D1
    description: "e2e/ is typechecked by tsc -b: tsconfig.e2e.json exists (strict, DOM+DOM.Iterable, types:[\"node\"], include:[\"e2e\"]) and is referenced from tsconfig.json, with zero real errors"
    requirement: "GATE-03"
    verification:
      - kind: unit
        ref: "pnpm exec tsc -p tsconfig.e2e.json (exit 0)"
        status: pass
      - kind: unit
        ref: "pnpm typecheck (tsc -b, exit 0) after the references-array edit"
        status: pass
      - kind: e2e
        ref: "break-and-revert: e2e/smoke.spec.ts deliberate TS2322, tsc -b exit 2 naming the file, reverted, exit 0"
        status: pass
    human_judgment: false
  - id: D2
    description: "@types/dompurify removed from dependencies; pnpm typecheck passes without it, dompurify's own types resolve at all 4 call sites"
    requirement: "GATE-06"
    verification:
      - kind: unit
        ref: "pnpm typecheck (exit 0) after removing @types/dompurify and installing @types/node"
        status: pass
      - kind: unit
        ref: "pnpm test, which runs vitest against src and scripts (1853/1853 passed, unchanged count)"
        status: pass
    human_judgment: false
  - id: D3
    description: "@types/node@22.20.1 installed as devDependency, approved at the blocking-human package-legitimacy gate"
    verification:
      - kind: manual_procedural
        ref: "Task 1 checkpoint:human-verify, gate=blocking-human; approved by team-lead with exact version ^22.20.1"
        status: pass
    human_judgment: true
    rationale: "Package-legitimacy checkpoints are never auto-approved by design (gate=blocking-human); this deliverable's proof is the human sign-off itself, already obtained and recorded in the checkpoint exchange."

duration: 20min (active; excludes the checkpoint wait for Task 1 approval)
completed: 2026-08-22
status: complete
---

# Phase 1 Plan 04: e2e Typecheck Coverage + Dompurify Types Cleanup Summary

**`tsconfig.e2e.json` brings all 24 `e2e/*.ts` files under `tsc -b`, fixing 6 real pre-existing type errors along the way, while `@types/node@22.20.1` replaces the deprecated `@types/dompurify` stub.**

## Performance

- **Duration:** ~20 min of active executor work (Task 2 commit to Task 4 commit spans 16:58-17:18 KST); excludes the wait for the Task 1 human-verify checkpoint approval
- **Started:** 2026-08-22 (checkpoint at Task 1; resumed after "approved, ^22.20.1")
- **Completed:** 2026-08-22T17:17:56+09:00
- **Tasks:** 4/4
- **Files modified:** 7 (1 created, 6 modified)

## Accomplishments

- `tsconfig.e2e.json` created (strict, `lib: ["ES2022","DOM","DOM.Iterable"]`, `types: ["node"]`, `include: ["e2e"]`), proven at zero errors via a direct `tsc -p` run before being wired into the gate
- `@types/node@22.20.1` installed as a devDependency (approved at the blocking-human legitimacy checkpoint), unblocking `types: ["node"]` resolution for this plan and for 01-05's `tsconfig.scripts.json`
- `@types/dompurify` removed from `dependencies`; all 4 real `import DOMPurify from "dompurify"` call sites still typecheck via dompurify's own shipped declarations
- 6 real, pre-existing e2e type errors fixed (re-measured, not trusted from RESEARCH.md; the count matched exactly: 2 in `e2e/drafts.spec.ts`, 4 in `e2e/helpers/todayFixtures.ts`), every fix type-only
- `tsconfig.json`'s `references` array now includes `tsconfig.e2e.json`, flipping GATE-03's e2e half live inside `pnpm typecheck` (= `tsc -b` = an existing `make verify` prerequisite, so no Makefile edit was needed)
- Break-and-revert proof executed and recorded: a deliberate `e2e/smoke.spec.ts` type error failed `tsc -b` with `TS2322`, naming the file; reverted clean

## Task Commits

Each task was committed atomically:

1. **Task 1: Package legitimacy check before the first dependency install of the phase** - checkpoint:human-verify, `gate="blocking-human"` (no code change); stopped and returned the checkpoint per protocol (no auto-mode config in this repo), independently re-verified `@types/node` against the live npm registry (349,691,671 weekly downloads, DefinitelyTyped repo, latest 22.x = 22.20.1), approved by team-lead: "approved, ^22.20.1"
2. **Task 2: Install @types/node, drop the dompurify types stub, prove typecheck passes** - `1f9970f` (feat)
3. **Task 3: Create tsconfig.e2e.json and drive the e2e type errors to zero, gate still off** - `1a30a0a` (feat)
4. **Task 4: Flip the gate by referencing tsconfig.e2e.json, then prove it goes red** - `31178fd` (feat)

**Plan metadata:** _(this commit, made after this SUMMARY)_

## Files Created/Modified

- `tsconfig.e2e.json` - new project config for `e2e/`; strict, DOM+DOM.Iterable+node types, no `composite` (see Deviations), not yet emitting (solution-file reference only)
- `package.json` - `@types/node@^22.20.1` added to `devDependencies`; `@types/dompurify` removed from `dependencies`
- `pnpm-lock.yaml` - regenerated by `pnpm install --no-frozen-lockfile` (not hand-edited)
- `tsconfig.json` - `references` array gained `{ "path": "./tsconfig.e2e.json" }`
- `e2e/drafts.spec.ts` - the in-page `drafts` seed array now has an explicit `DraftEntry` type instead of narrowing from the two seed literals
- `e2e/helpers/todayFixtures.ts` - merged a duplicate `taskId` field in `applyMutation`'s inline parameter type; narrowed `event` to `{ ts?: string }` before property access in `read_task_events`
- `src/components/ScratchpadPane.tsx` - two timer refs retyped `number` instead of `ReturnType<typeof window.setTimeout>` (deviation, see below)

## Decisions Made

- **`@types/node@22.20.1`** (not a floating `^22` or the newest `26.2.0`): the 22.x line matches `engines.node >= 22` and CI's pinned `22.22.3`; confirmed live against npm at the Task 1 checkpoint rather than trusting RESEARCH.md's stored figures.
- **`composite: true` left off `tsconfig.e2e.json`**, deviating from the plan's literal Task 3 action text. see Deviations below; this is the load-bearing decision of the plan.
- **GATE-03 not marked complete in REQUIREMENTS.md.** It is one requirement spanning both `e2e/` and `scripts/`; this plan finishes only the `e2e/` half. Only GATE-06 was marked complete via `requirements mark-complete`.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] `@types/node`'s ambient globals broke two `window.setTimeout`-typed refs in `src/components/ScratchpadPane.tsx`**
- **Found during:** Task 2, immediately after `pnpm install`; `pnpm typecheck` failed with `TS2322: Type 'number' is not assignable to type 'Timeout'` at two sites
- **Issue:** `tsconfig.app.json` (covers `src/`) has no explicit `types` array, so TypeScript auto-includes every package under `node_modules/@types`, including the newly-added `@types/node`. Once Node's ambient globals are visible, `ReturnType<typeof window.setTimeout>` resolves to `NodeJS.Timeout` instead of DOM's `number`, breaking two `useRef` declarations that are genuinely browser-only (`window.setTimeout`/`window.clearTimeout` at every call site)
- **Fix:** Retyped both refs (`autoSaveTimerRef`, `watcherRefreshTimerRef`) as `useRef<number | null>(null)`, a type-only change matching what these call sites already do at runtime
- **Files modified:** `src/components/ScratchpadPane.tsx`
- **Verification:** `pnpm typecheck` exits 0; `pnpm test` unchanged at 1853/1853; confirmed via a throwaway `git worktree` at the pre-change commit that a clean install with only the `package.json` diff applied reproduces exactly these 2 errors and no others
- **Committed in:** `1f9970f` (Task 2 commit)
- **Not touched:** `tsconfig.app.json` was deliberately left alone (not in this plan's file scope, and restricting its `types` array to prevent future `@types/*` leakage is a broader change than this one bug needs)

**2. [Rule 1 - Bug] Task 3's `composite: true` instruction surfaced an unrelated project-boundary error**
- **Found during:** Task 3, after creating `tsconfig.e2e.json` per the plan's literal spec (including `composite: true`)
- **Issue:** With `composite: true` set, `pnpm exec tsc -p tsconfig.e2e.json` produced 3 new `TS6307` errors ("File is not listed within the file list of project") on top of the 6 real ones, because `e2e/workbench-layout.spec.ts` imports `DEFAULT_MARU_SETTINGS` from `../src/lib/settings.ts`, a legitimate cross-project import (it clones and mutates the app's real settings default to dispatch a `maru://settings-updated` event) that composite's stricter same-project file-list enforcement rejects. RESEARCH.md's original "6 errors, 2 files" measurement did not surface this, meaning that measurement was not taken with `composite: true` set.
- **Investigated:** Tried adding `"references": [{ "path": "./tsconfig.app.json" }]` to resolve it properly; TypeScript rejected that too (`TS6306`/`TS6310`: the referenced project must itself be `composite` and must not disable emit), which would require adding `composite: true` and adjusting `noEmit` on `tsconfig.app.json`, a file this plan does not touch and a change with real blast radius on the app's actual build pipeline
- **Fix:** Left `composite: true` off. The plan's own Task 3 note already flagged this as untested territory ("I measured this repo's TypeScript 5.9.3 and `tsc -b` accepts a referenced project **without** `composite`"). Verified that claim directly: added `tsconfig.e2e.json` to `tsconfig.json`'s `references` array in an isolated test with `composite` absent, and `tsc -b` accepted it with zero boundary errors, leaving only the real 6 (then 0, once fixed)
- **Files modified:** `tsconfig.e2e.json` (kept `composite` out)
- **Verification:** Every literal acceptance criterion in Task 3/4 checks `lib`, `types`, `include`, `tsBuildInfoFile`, `strict`; none checks for `composite`. All pass. `pnpm typecheck` (`tsc -b`, the actual `verify` gate) is green with the reference live
- **Committed in:** `1a30a0a` (Task 3 commit)

### Local-environment finding (no repo change needed)

While debugging the GraphCanvas.tsx implicit-`any` errors that first appeared after the initial `pnpm install`, traced them to this machine's global pnpm config (`~/.config/pnpm/npmrc`, dotfiles-managed) pointing `virtual-store-dir` at a path shared across every project on the machine (`~/.local/share/pnpm/virtual-store`), rather than this project's own prior convention of a self-contained `node_modules/.pnpm`. That shared store let a conflicting resolution leak into `graphology`/`sigma`'s type graph. Re-ran the install with `--virtual-store-dir=node_modules/.pnpm` (a local install-time flag, not persisted anywhere in the repo, `pnpm-lock.yaml` is identical either way) and the spurious errors disappeared, leaving only the two real `@types/node` fallout errors fixed above. Confirmed via a disposable `git worktree` at the pre-change commit that this was purely local-machine state, not something this plan's changes caused or that CI (fresh containers, no shared store) would ever see.

---

**Total deviations:** 2 auto-fixed (both Rule 1 - bug), 1 local-environment finding requiring no repo change
**Impact on plan:** Both auto-fixes were necessary for `pnpm typecheck` to reach 0 at all; neither changes any spec's runtime assertions (verified: `pnpm test` 1853/1853 unchanged, `make test-e2e` 203/203 unchanged). No scope creep beyond what GATE-03/GATE-06 required.

## Issues Encountered

- **`make test-e2e` flaked twice at full default parallelism** (`e2e/today.spec.ts` rollover-retry once, `e2e/select-audit.spec.ts` once, different test each time), both unrelated to this plan's changed files. Root-caused to real-time-based waits (`.poll()` with an 8s wall-clock timeout; `select-audit.spec.ts` takes 26.2s solo, close to its 30s budget) losing their margin under this sandbox's CPU contention when running many Chromium workers in parallel. Both tests pass reliably in isolation. A full clean run at `--workers=4` (not a repo config change, a one-off local invocation) passed all 203/203. Not fixed; out of scope, pre-existing test timing characteristics unrelated to this plan's type-only diff, and this local sandbox's parallelism ceiling, not CI's.
- **`pnpm exec` intermittently hung for 15-30s** on the very first invocation after the fresh `node_modules` reinstall (`pnpm exec vite --version` alone timed out once, succeeded instantly on retry). Environmental/first-run cost, not reproducible after the first successful call in a session; worked around by retrying rather than investigating further, since it self-resolved and is orthogonal to this plan's file changes.

## Cross-Platform Risk Assessment (CI runs ubuntu-22.04, this session ran macOS)

Low risk, stated with reasoning rather than left unverified: every change in this plan is either (a) a `tsc`/`tsconfig` compiler-config change, or (b) a TypeScript type-only annotation/cast erased before any JS runs. TypeScript's type resolution and `tsc -b`'s project-reference handling do not depend on OS. `@types/node` itself is consumed only at compile time (`types: ["node"]` in a `noEmit: true` project); it never ships in the Vite-built frontend bundle, so there is no Linux/macOS Node-builtin-availability question the way there would be for actual runtime `fs`/`path` usage. Unlike plan 01-02's clippy `dead_code` surprise (Linux-only via `#[cfg]`), nothing here is platform-conditional. The one thing not verifiable locally: CI's `pnpm install --frozen-lockfile` runs in a fresh container with no shared global virtual-store-dir, so the local-environment finding above (this machine's dotfiles-managed pnpm config) has no CI analog; expect CI's install to behave like the disposable-worktree baseline test, not like my first local install attempt.

## User Setup Required

None - no external service configuration required beyond the Task 1 checkpoint approval already given.

## Next Phase Readiness

- `@types/node@22.20.1` is installed and available for 01-05's `tsconfig.scripts.json` (per D-09b, no re-install needed)
- `tsconfig.e2e.json` exists at the shape 01-06's `eslint.config.js` expects to point its `e2e/**/*.ts` type-aware block at
- `tsconfig.scripts.json` was deliberately NOT created; that is 01-05's task
- GATE-03 remains open in REQUIREMENTS.md (e2e half done, scripts/ half pending in 01-05); this is intentional, not a gap
- `pnpm typecheck` exits 0 at HEAD with `@types/dompurify` gone from `package.json`

---
*Phase: 01-trustworthy-verify-signal*
*Completed: 2026-08-22*

## Self-Check: PASSED

All 7 files created/modified verified present on disk; all 3 task commit hashes (`1f9970f`, `1a30a0a`, `31178fd`) verified present in git log.
