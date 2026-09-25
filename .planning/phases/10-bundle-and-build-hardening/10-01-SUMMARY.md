---
phase: 10-bundle-and-build-hardening
plan: 01
subsystem: infra
tags: [csp, security, tauri, vite, make, content-security-policy]

# Dependency graph
requires:
  - phase: 07-01
    provides: check-dom-sanitizer.mjs guard family idiom (strip-before-match, two-half structure, vitest source-assertion style)
  - phase: 09-D-10
    provides: check-native-e2e-isolation.mjs two-half guard structure and the release-checks binary-scan window
provides:
  - Two-half check-csp-blob.mjs guard (dist scan + --binary embedded-CSP assertion)
  - Vitest source-assertion policy pin (check-csp-blob.test.ts)
  - CSP script-src narrowed from 'self' blob: to 'self' in tauri.conf.json (SEC-01, D-04)
  - check-csp-blob chained into build:frontend (D-04 proof (a)) and release-checks (D-04 proof (b))
  - New check:csp-blob package script and check-csp-blob make target
affects: [SEC-02, release-preflight, future CSP changes, tauri-codegen config format changes]

# Actuals (#2632) — pairs with the plan's `estimate` to calibrate future estimates.
# Same estimateTokens scale (chars/4 over the realized diff), never a harness token count.
actuals:
  tokens: 4970
  tasks: 3
  commits: 3

# Tech tracking
tech-stack:
  added: []
  patterns: [two-half produced-artifact guard (dist scan + compiled-binary scan), strip-comments-and-strings before needle matching, fail-closed embedded-config miss]

key-files:
  created:
    - scripts/check-csp-blob.mjs
    - scripts/check-csp-blob.test.ts
  modified:
    - src-tauri/tauri.conf.json
    - package.json
    - Makefile

key-decisions:
  - "createObjectURL-bound bare-identifier Worker arguments are exempt (graphology FA2 supervisor spawn): a blob-URL worker spawn fetches under worker-src 'self' blob:' (D-05), so it cannot demand script-src blob:; all other bare identifiers fail closed"
  - "Dynamic-import needle excludes method-shaped calls via lookbehind: graphology's i.import(r) in the real bundle is a layout method, not the import operator"
  - "Binary half asserts the CONFIGURED script-src source list carries no blob:, not byte-level directive disappearance (Tauri nonce handling may re-create script-src with 'self' at runtime)"

patterns-established:
  - "Two-half produced-artifact guard: dist half rides build:frontend (D-04 proof (a)), binary half rides release-checks between build and prune (D-04 proof (b))"
  - "Vitest source-assertion policy pin per check-dom-sanitizer.test.ts house style"

requirements-completed: [SEC-01]

# Coverage metadata (#1602) — one entry per shipped deliverable. Drives DETERMINISTIC UAT routing in verify-work.
coverage:
  - id: D1
    description: "Two-half check-csp-blob.mjs guard green on fresh dist (76 bundles) and proven red-then-green against fixtures in both modes"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "scripts/check-csp-blob.test.ts"
        status: pass
      - kind: manual_procedural
        ref: "fixture drill: --binary fixture with 'self' blob: exit 1; wrong-artifact fixture exit 1; dist fixture unbound Worker + bare import exit 1; re-run green; no fixture survives"
        status: pass
    human_judgment: false
  - id: D2
    description: "CSP script-src narrowed to 'self' in tauri.conf.json; every other directive byte-identical (worker-src keeps 'self' blob:' per D-05)"
    requirement: SEC-01
    verification:
      - kind: manual_procedural
        ref: "git diff base..HEAD -- src-tauri/tauri.conf.json shows only the script-src line changed; node -e assertion script-src === 'self'"
        status: pass
    human_judgment: false
  - id: D3
    description: "build:frontend chains check-csp-blob.mjs after check-native-e2e-isolation; check:csp-blob run script exists"
    requirement: SEC-01
    verification:
      - kind: unit
        ref: "pnpm build:frontend ends with 'csp-blob: dist carries no blob: script sources (76 JS bundles scanned; ...)'"
        status: pass
    human_judgment: false
  - id: D4
    description: "release-checks carries the packaged-binary CSP scan before the debug-artifact prune"
    requirement: SEC-01
    verification:
      - kind: integration
        ref: "make release-checks exit 0 with both scan lines (isolation + csp-blob); make -n release-checks | grep -c check-csp-blob = 1"
        status: pass
    human_judgment: false
  - id: D5
    description: "make check-csp-blob target exists with ## description and fails cleanly when the debug binary is absent"
    requirement: SEC-01
    verification:
      - kind: manual_procedural
        ref: "make check-csp-blob after prune exits 1 with 'csp-blob: --binary path does not exist'"
        status: pass
    human_judgment: false

# Metrics
duration: 29min
completed: 2026-09-24
status: complete
---

# Phase 10 Plan 01: CSP script-src blob: Removal Summary

**Two-half check-csp-blob guard (dist scan in build:frontend + packaged-binary scan in release-checks) gating the CSP script-src narrowing from 'self' blob:' to 'self' (SEC-01, D-04)**

## Performance

- **Duration:** 29 min
- **Started:** 2026-09-24T11:23:31Z
- **Completed:** 2026-09-24T11:58:51Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- `scripts/check-csp-blob.mjs`: two-half guard — no-arg dist mode scans `dist/assets/*.js` (after comment/string stripping) for blob:-attributable Worker spawns and non-literal dynamic imports; `--binary` mode asserts the compiled binary's embedded CSP script-src source list carries no blob: and fails closed on a wrong artifact
- `scripts/check-csp-blob.test.ts`: hermetic vitest source assertions pin both entry points, fail-closed exit, unknown-arg rejection, strip-before-match order, needle exemptions, and the embedded-config miss path
- CSP narrowed: `script-src` is exactly `'self'`; worker-src and connect-src/img-src/media-src/font-src blob: allowances untouched (D-05)
- Wiring: `build:frontend` chains the dist scan (D-04 proof (a)); `release-checks` carries the binary scan between the native-e2e isolation scan and the prune (D-04 proof (b)); `check:csp-blob` script + `make check-csp-blob` target for standalone runs

## Task Commits

Each task was committed atomically:

1. **Task 1: Two-half check-csp-blob guard green on today's dist, drilled red-then-green** - `78238fc` (feat)
2. **Task 2: Drop script-src blob: from shipped CSP, chain guard into build** - `46074a6` (feat)
3. **Task 3: Wire csp-blob binary scan into release-checks** - `e6982c1` (feat)

_Note: TDD not applicable per plan (no TDD tasks)._

## Files Created/Modified
- `scripts/check-csp-blob.mjs` - Two-half CSP guard (dist scan + binary embedded-CSP assertion)
- `scripts/check-csp-blob.test.ts` - Vitest policy pin (8 tests, hermetic)
- `src-tauri/tauri.conf.json` - script-src: 'self' blob:' → 'self'
- `package.json` - build:frontend tail + check:csp-blob script
- `Makefile` - check-csp-blob target + release-checks scan line

## Red-then-Green Fixture Drill (Task 1 teeth proof)

All fixtures deleted immediately after their red run; `test ! -f` confirmed none survive.

**(1) Binary mode, blob: present (RED — expected):**
```
$ node scripts/check-csp-blob.mjs --binary .fixture-csp-a.json   # file contains: "script-src": "'self' blob:",
csp-blob: script-src blob: must not reach a shippable build (SEC-01):
  .fixture-csp-a.json embedded CSP script-src carries blob: ("'self' blob:") — drop script-src blob: from src-tauri/tauri.conf.json (SEC-01, D-04 proof (b))
EXIT_A=1
```

**(2) Binary mode, wrong artifact (RED — expected):**
```
$ node scripts/check-csp-blob.mjs --binary .fixture-csp-b.bin    # file contains: arbitrary bytes, no csp serialization here
csp-blob: script-src blob: must not reach a shippable build (SEC-01):
  .fixture-csp-b.bin carries no embedded CSP script-src serialization — wrong artifact or the tauri-codegen config format changed; D-04 proof (b) cannot be asserted, failing closed
EXIT_B=1
```

**(3) Dist mode, unbound worker id + bare import (RED — expected), createObjectURL-bound spawn clean:**
```
$ cat > dist/assets/__csp_fixture.js   # var w = makeWorkerUrl(); new Worker(w); import(someId); var o = URL.createObjectURL(new Blob()); new Worker(o);
$ node scripts/check-csp-blob.mjs
csp-blob: script-src blob: must not reach a shippable build (SEC-01):
  production bundle carries constructs that demand script-src blob: (SEC-01):
  dist/assets/__csp_fixture.js: new Worker(w) — a bare-identifier worker argument is only exempt when bound to a createObjectURL(...) call nearby ...
  dist/assets/__csp_fixture.js: import(someId) — dynamic import() with a non-literal specifier cannot be proven same-origin; use a string literal
EXIT_C=1
```
Note: `new Worker(o)` with `o = URL.createObjectURL(new Blob())` in the same file produced no violation — the D-05-consistent exemption classified it clean.

**(4) Dist mode green after cleanup (GREEN):**
```
$ node scripts/check-csp-blob.mjs
csp-blob: dist carries no blob: script sources (76 JS bundles scanned; no blob:-attributable worker spawn or non-literal dynamic import)
EXIT_GREEN=0
```

## Verification Results

- `pnpm build:frontend` green; chain ends with the csp-blob dist line (76 bundles)
- `pnpm test -- check-csp-blob`: 225 test files, 2155 tests, all pass
- `pnpm typecheck` exit 0; `pnpm lint` exit 0
- `make release-checks` exit 0 (359s) with both artifact scans observed before the prune:
  - `native-e2e-isolation: src-tauri/target/debug/maru and Cargo manifest carry no embedded WebDriver plugin, responsiveness hook or native-only commands`
  - `csp-blob: src-tauri/target/debug/maru embedded CSP script-src carries no blob: (configured source list: "'self'")`
- `make -n release-checks | grep -c check-csp-blob` = 1
- Standalone `make check-csp-blob` after the prune fails cleanly: `csp-blob: --binary path does not exist: src-tauri/target/debug/maru` (exit 1)
- Stub scan over both new files: zero TODO/FIXME/XXX/HACK/stub/not-implemented hits
- `git diff base..HEAD -- src-tauri/tauri.conf.json`: only the script-src line changed

## Decisions Made
- Created the createObjectURL-bound-identifier exemption after inspecting the real dist: graphology's FA2 supervisor spawns its worker from a minted blob: URL (`o=i.createObjectURL(new Blob(...))`, `new Worker(o)`). Plan authorizes narrowing by call-site attribution and never a warn-only path; the exemption classifies the proven-blob-URL spawn clean while every other bare identifier fails closed. D-05-consistent: the spawn fetches under worker-src 'self' blob:', not script-src.
- Excluded method-shaped `i.import(r)` (graphology layout method, present in the real bundle) from the dynamic-import needle via lookbehind — the import operator is a free-standing token, never a property access.
- Plan's read-first note about "i18n dictionary template-literal imports" was inaccurate (source uses plain string literals); no functional impact — both forms are blanked by stripping before matching.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 4 - Judgment] Narrowed the Worker and dynamic-import needles by call-site attribution**
- **Found during:** Task 1 (guard authoring, green-run validation)
- **Issue:** The plan's base needle spec ("every `new Worker(` whose argument is neither a quoted string nor a `new URL(...)` expression is a violation") false-positives on graphology's blob-URL supervisor spawn in the real bundle; the plan explicitly authorizes call-site narrowing
- **Fix:** Added the createObjectURL-bound-identifier exemption (D-05-consistent) and the method-shaped-call lookbehind for the import needle; both fail closed otherwise
- **Files modified:** scripts/check-csp-blob.mjs
- **Verification:** Green on all 76 real bundles; fixture drill proves unbound identifiers still exit 1
- **Committed in:** 78238fc (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 judgment/narrowing, plan-authorized)
**Impact on plan:** The narrowing is exactly the plan's false-positive remediation path. No scope creep; no warn-only path added.

## Issues Encountered
- Two initial vitest assertions used regex-escape strings that did not match the guard's literal file text (e.g. `"/*"` vs `next === "*"`, `createObjectURL\s*\(` vs the literal `\\s*\\(` bytes); fixed the assertions to match the actual bytes and re-ran green.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SEC-01 landed behind both D-04 proofs; `make verify` carries proof (a) through build-frontend, `make release-checks` (and CI release-preflight-core) carries proof (b)
- Downstream SEC-02 work (DOMPurify sink tracing) builds on the same guard family
- Blockers: none

---
*Phase: 10-bundle-and-build-hardening*
*Completed: 2026-09-24*
