---
phase: 07-guardrails-before-churn
plan: 01
subsystem: security
tags: [dompurify, dangerouslySetInnerHTML, static-guard, sec-02, check-mjs, vitest]

requires:
  - phase: 06-native-e2e-runner-foundation
    provides: the verify-chain culture (guards proven by deliberate red-then-green breaks before wiring acceptance)
provides:
  - scripts/check-dom-sanitizer.mjs — SEC-02 static guard tracing every dangerouslySetInnerHTML sink in src/ to a DOMPurify-backed helper
  - make verify gate check-dom-sanitizer (fails the moment an untraced sink lands)
  - Registered exported helper sanitizeHwpxPreviewHtml in HwpxViewer.tsx
  - Vitest policy pin + live behavioral test for the guard
affects: [phase-08, phase-09, phase-10, sec-01, make-verify]

actuals:
  tokens: 4310
  tasks: 3
  commits: 5

tech-stack:
  added: []
  patterns:
    - "check-*.mjs guard family extended: ESM, node:fs/node:path only, violations array, console.error + process.exit(1)"
    - "D-07/D-08 tracing model: pinned module allowlist + explicit (file, function) registrations, no name patterns, no alias following, no AST"

key-files:
  created:
    - scripts/check-dom-sanitizer.mjs
    - scripts/check-dom-sanitizer.test.ts
    - scripts/check-dom-sanitizer.behavior.test.ts
  modified:
    - Makefile
    - src/components/binaryViewers/HwpxViewer.tsx

key-decisions:
  - "The tracer task's tdd=true RED commit authored a permanent behavioral test (scripts/check-dom-sanitizer.behavior.test.ts) in addition to the plan's Task 3 policy-pin file; the plan's files list did not name it, but the TDD gate requires a committed failing test, and the live red/green behavioral proof complements Task 3's hermetic source assertions"
  - "The EditorPane dynamic-import provenance pattern matches previewBaseHtml case-insensitively because the state field is previewBaseHtml while the setter is setPreviewBaseHtml (capital P); the narrow check still requires the destructured renderMarkdown call from the allowlisted module"
  - "The unclassified SEC-02 edge row resolves fail-closed as the plan decided: proven by the Task 1 probe and the Task 2 red drill, both exercising the no-match path"

patterns-established:
  - "Sanitizer-guard tracing: one-hop in-file definition chains resolve identifiers to allowlisted-import calls or registered-pair functions; EditorPane additionally requires the previewBaseHtml dynamic-import provenance pattern"

requirements-completed: [SEC-02]

coverage:
  - id: D1
    description: "SEC-02 guard exists in the check-*.mjs idiom, exits 0 on the six existing sinks, and fails closed (exit 1) on an untraced sink"
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "scripts/check-dom-sanitizer.behavior.test.ts#exits 0 on the current tree / fails closed on an untraced sink"
        status: pass
      - kind: other
        ref: "node scripts/check-dom-sanitizer.mjs (green on six sinks); probe src/__dom_sanitizer_probe__.tsx red-then-deleted"
        status: pass
    human_judgment: false
  - id: D2
    description: "HwpxViewer sanitizes through the exported registered helper sanitizeHwpxPreviewHtml (byte-equivalent DOMPurify call, same USE_PROFILES)"
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "scripts/check-dom-sanitizer.behavior.test.ts + guard traces HwpxViewer.tsx:102 sink"
        status: pass
      - kind: other
        ref: "grep: USE_PROFILES appears exactly once, inside sanitizeHwpxPreviewHtml"
        status: pass
    human_judgment: false
  - id: D3
    description: "Guard wired into make verify exactly once, adjacent to check-select-chrome, proven by deliberate red-then-green drill before acceptance"
    requirement: SEC-02
    verification:
      - kind: other
        ref: "make check-dom-sanitizer green; make -n verify includes the guard once after check-select-chrome; drill transcript below"
        status: pass
    human_judgment: false
  - id: D4
    description: "Tracing policy pinned by vitest source assertions so weakening the guard turns a verify gate red"
    requirement: SEC-02
    verification:
      - kind: unit
        ref: "scripts/check-dom-sanitizer.test.ts (6 tests, 1974-test full suite green)"
        status: pass
    human_judgment: false

duration: 10min
completed: 2026-09-05
status: complete
---

# Phase 7 Plan 1: SEC-02 Sanitizer Guard Summary

**A plain-node static guard in the check-*.mjs family traces all six dangerouslySetInnerHTML sinks in src/ to DOMPurify-backed helpers (module allowlist + registered pairs), wired into make verify and proven by a deliberate red-then-green break.**

## Performance

- **Duration:** ~10 min
- **Started:** 2026-09-05T00:23:12Z
- **Completed:** 2026-09-05T00:32:34Z
- **Tasks:** 3
- **Files modified:** 5

## Accomplishments
- `scripts/check-dom-sanitizer.mjs` lands the D-07/D-08 tracing model: pinned `ALLOWED_HELPER_MODULES` (markdown.ts, scratchpad.ts, diagram/richText.ts), pinned `REGISTERED_LOCAL_HELPERS` ((EditorPane, decoratePreviewHtml), (HwpxViewer, sanitizeHwpxPreviewHtml)), one-hop in-file definition resolution, and the EditorPane-only `previewBaseHtml` dynamic-import provenance check. Fail-closed: violations print `file:line (__html: expr)` and exit 1.
- HwpxViewer's inline `useEffect` DOMPurify.sanitize extracted into the exported `sanitizeHwpxPreviewHtml` (same call, same `{ USE_PROFILES: { html: true } }`, appearing exactly once); the useEffect now calls it.
- `make verify` gained `check-dom-sanitizer` between `check-select-chrome` and `check-type-tokens`; the gate has teeth (drill transcript below).

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing behavior test** - `9048a95` (test)
2. **Task 1 GREEN: guard + HwpxViewer extraction** - `5be24d4` (feat)
3. **Task 2: Makefile wiring + red-then-green drill** - `470eb31` (feat)
4. **Task 3: vitest policy pin** - `e933a35` (test)

**Plan metadata:** see final docs commit in completion notes.

_Note: Task 1 is a tdd="true" tracer, so it carries RED + GREEN commits per the TDD task flow._

## Files Created/Modified
- `scripts/check-dom-sanitizer.mjs` - the SEC-02 static guard (new)
- `scripts/check-dom-sanitizer.behavior.test.ts` - live behavioral red/green proof (new; Task 1 RED, kept permanent)
- `scripts/check-dom-sanitizer.test.ts` - hermetic policy-pin source assertions (new; Task 3)
- `Makefile` - check-dom-sanitizer target + verify-chain entry
- `src/components/binaryViewers/HwpxViewer.tsx` - exported sanitizeHwpxPreviewHtml replacing the inline sanitize

## Decisions Made
- Added a permanent behavioral test file beyond the plan's `files_modified` list because the tracer's `tdd="true"` mandates a committed RED test; it encodes the `<behavior>` block as repeatable proof, while Task 3's file stays hermetic per the plan.
- Case-insensitive `previewBaseHtml` match in the dynamic-import provenance check (setter is `setPreviewBaseHtml`, capital P). The check stays narrow: allowlisted dynamic import + destructured helper + assignment from that helper's call.
- Restored `node_modules` with `pnpm install --frozen-lockfile` before any test run (clean checkout; lockfile only, zero new packages).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added scripts/check-dom-sanitizer.behavior.test.ts (permanent)**
- **Found during:** Task 1 (tracer, tdd="true")
- **Issue:** The plan's Task 1 `<files>` list names only the guard script and HwpxViewer.tsx; Task 3 owns the test file. But the TDD task flow requires a committed failing test before implementation, and the `<behavior>` block (green-on-six / fail-closed-on-probe / test-file skip) deserves repeatable coverage beyond the one-shot drills.
- **Fix:** Authored `scripts/check-dom-sanitizer.behavior.test.ts` as the RED commit; kept it permanently. It runs the guard as a subprocess and cleans its probe fixture in afterEach.
- **Files modified:** scripts/check-dom-sanitizer.behavior.test.ts
- **Verification:** 3 tests pass; full suite 1974 green
- **Committed in:** `9048a95` (RED), `5be24d4` (final form)

**2. [Rule 1 - Bug] Dynamic-import provenance regex missed the actual EditorPane code**
- **Found during:** Task 1 GREEN (first guard run failed EditorPane)
- **Issue:** The assignment check used case-sensitive `previewBaseHtml`, but the real assignment goes through the setter `setPreviewBaseHtml` (capital P) — substring `previewBaseHtml` never appears before `renderMarkdown(`.
- **Fix:** Case-insensitive flag on the assignment regex; the pattern remains otherwise identical and file-scoped.
- **Files modified:** scripts/check-dom-sanitizer.mjs
- **Verification:** guard green on all six sinks; EditorPane chain (previewMarkup -> previewHtml -> decoratePreviewHtml + dynamic-import provenance) traced
- **Committed in:** `5be24d4`

---

**Total deviations:** 2 auto-fixed (1 missing critical, 1 bug)
**Impact on plan:** Neither weakens the guard or any sink; both strengthen the proof surface. No scope creep into other phases.

## Red-Then-Green Drill Transcript (ROADMAP criterion 3)

Task 1 probe (acceptance criterion):
1. Created `src/__dom_sanitizer_probe__.tsx` with sink `__html: untrustedInput` (plain prop identifier, no provenance).
2. `node scripts/check-dom-sanitizer.mjs` → exit 1, output: `src/__dom_sanitizer_probe__.tsx:2 (__html: untrustedInput)`.
3. Deleted the probe; guard → exit 0 (six sinks).

Task 2 drill (Makefile wiring, before acceptance):
1. Created `src/__dom_sanitizer_red_drill__.tsx` with sink `__html: injected`.
2. `make check-dom-sanitizer` → `make: *** [check-dom-sanitizer] Error 1` (make maps the guard's exit 1 to its own error; the fixture was named in the violation output):
   ```
   check-dom-sanitizer: every dangerouslySetInnerHTML sink in src/ must trace to a DOMPurify-backed helper:
     src/__dom_sanitizer_red_drill__.tsx:2 (__html: injected)
   ```
3. Deleted the fixture (`test ! -f src/__dom_sanitizer_red_drill__.tsx` → OK).
4. `make check-dom-sanitizer` → exit 0: `check-dom-sanitizer: all 6 dangerouslySetInnerHTML sinks trace to a DOMPurify-backed helper`.

The red run preceded the green acceptance; neither fixture survives in the tree.

## Issues Encountered
- The checkout had no `node_modules`; restored with `pnpm install --frozen-lockfile` (lockfile only — no package additions, so the Rule 3 install exclusion does not apply).
- First guard run failed all six sinks because the collector built repo-relative paths without the `src/` prefix, so module resolution never hit the allowlist; fixed by seeding the collector with `relDir = "src"`.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- SEC-02 is a live gate: any new untraced sink in src/ fails `make verify`. Phases 8-10 churn lands on a guarded boundary.
- SEC-02 requirement is marked complete via requirements.mark-complete (single-plan requirement in this phase).
- `make verify` full composite not run here (Rust + build chain); every gate this plan owns was verified individually (guard both directions, pnpm test 1974 green, pnpm typecheck, pnpm lint, make check-dom-sanitizer). CI is the authoritative composite check.

## Self-Check: PASSED
- scripts/check-dom-sanitizer.mjs exists: FOUND
- scripts/check-dom-sanitizer.test.ts exists: FOUND
- scripts/check-dom-sanitizer.behavior.test.ts exists: FOUND
- Commits 9048a95 / 5be24d4 / 470eb31 / e933a35 present in git log: FOUND
- Plan-level verification re-run after all tasks: guard green on six sinks; `make -n verify` names check-dom-sanitizer exactly once after check-select-chrome; `pnpm test` 1974 passed; `pnpm typecheck` exit 0; `pnpm lint` exit 0.

---
*Phase: 07-guardrails-before-churn*
*Completed: 2026-09-05*
