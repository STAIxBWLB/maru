---
phase: 05-shell-decomposition-completion
plan: "11"
subsystem: shell-architecture
tags: [react, typescript, tauri, external-store, lazy-loading, render-isolation, testing]
requires:
  - phase: 05-shell-decomposition-completion
    provides: "Four-input panes, generation-safe terminal commands, and the complete 18-mode lazy registry from plans 05-01 through 05-10"
provides:
  - "Permanent MainApp hook, owner-boundary, registry, and render-isolation contracts"
  - "Fail-safe production add-state and add-mode drills that restore every touched source file"
  - "Approved native macOS Tauri smoke checkpoint for the D-20 matrix"
affects: [shell-decomposition, MainApp, mode-registry, terminal-runtime, phase-05-verification]
actuals:
  tokens: 37665
  tasks: 3
  commits: 10
tech-stack:
  added: []
  patterns: [AST architecture guards, production render probes, fail-safe source drills, lifecycle ownership modules]
key-files:
  created:
    - src/lib/shellDecomposition.test.ts
    - scripts/check-shell-extensibility.mjs
    - src/lib/communicationsModeLifecycle.ts
    - src/lib/documentOpsModeLifecycle.ts
    - src/lib/documentShellLifecycle.ts
    - src/lib/terminalSurfaceLifecycle.ts
  modified:
    - src/App.tsx
    - src/lib/modeRegistry.tsx
    - src/lib/modeRegistry.test.ts
    - src/__tests__/editorSurfaceRenderIsolation.test.tsx
key-decisions:
  - "MainApp remains below the D-13 ceiling at 15 useState and 24 useEffect calls; remaining lifecycle ownership lives in named production modules."
  - "The extensibility drills mutate real pane and registry source only within a finally-restored boundary and assert App byte identity."
  - "The native checkpoint is recorded as approved without inventing detailed observations that were not supplied."
patterns-established:
  - "Architecture regressions are caught by normal tests through source/AST assertions rather than a separate manual audit."
  - "Mode-local and pane-local publications are observed through static no-op-by-default production render probes."
requirements-completed: [SHELL-05, SHELL-06, SHELL-07, SHELL-08]
coverage:
  - id: D1
    description: "D-13 through D-15 hook ceilings, ownership boundaries, exhaustive registry routing, and production render isolation."
    requirement: SHELL-08
    verification:
      - kind: unit
        ref: "src/lib/shellDecomposition.test.ts, src/lib/modeRegistry.test.ts, and src/__tests__/editorSurfaceRenderIsolation.test.tsx"
        status: pass
      - kind: integration
        ref: "make verify"
        status: pass
    human_judgment: false
  - id: D2
    description: "D-14 and D-18 real add-state/add-mode source drills restore source byte-for-byte while preserving MainApp identity."
    requirement: SHELL-07
    verification:
      - kind: integration
        ref: "node scripts/check-shell-extensibility.mjs"
        status: pass
      - kind: integration
        ref: "pnpm build && pnpm check:bundle-budget"
        status: pass
    human_judgment: false
  - id: D3
    description: "D-16 deterministic completion matrix: unit suite, make verify, Playwright, production build/bundle, and terminal generation matrix."
    requirement: SHELL-06
    verification:
      - kind: integration
        ref: "make verify; 209 Vitest files / 1,939 tests"
        status: pass
      - kind: automated_ui
        ref: "pnpm test:e2e; 203/203 Playwright tests"
        status: pass
      - kind: integration
        ref: "cd src-tauri && cargo test terminal; 76 tests"
        status: pass
    human_judgment: false
  - id: D4
    description: "D-20 native Documents, Terminal, placement/lazy, recycled-generation, and render-isolation smoke."
    requirement: SHELL-05
    verification:
      - kind: manual_procedural
        ref: "05-11 native checkpoint: user approved; no per-flow observations reported"
        status: pass
    human_judgment: true
    rationale: "The macOS Tauri WebView, PTY, and native filesystem paths cannot be established by the Chromium-based automated suite."
duration: 2h 7m
completed: 2026-08-27
status: complete
---

# Phase 05 Plan 11: Shell Completion Contract Summary

**MainApp is held to a 15-state/24-effect shell boundary by permanent architecture and render-isolation tests, reversible production extensibility drills, and an approved native Tauri smoke.**

## Performance

- **Duration:** 2h 7m
- **Started:** 2026-08-26T19:51:22Z
- **Completed:** 2026-08-26T21:58:21Z
- **Tasks:** 3/3
- **Files modified:** 25

## Accomplishments

- Added CI-enforced source/AST contracts for the D-13 ceilings, four-input pane boundaries, zero target-specific shell ownership, 18 registry-only lazy adapters, and production subscriber isolation.
- Extracted the remaining communications, document-operation, terminal, settings, and workspace lifecycle bridges required to meet the final shell boundary without altering visible behavior or settings keys.
- Added real add-state and add-mode drills with `finally` restoration, source hashing, App byte-identity assertions, focused architecture tests, typechecking, production build, and bundle-budget verification.
- Preserved the deterministic Phase 5 gate evidence: `make verify`, 209 Vitest files with 1,939 tests, Playwright 203/203, terminal Rust matrix 76, both drills, and a 297.8 KiB gzip JavaScript / 61.2 KiB gzip CSS bundle.
- Recorded the D-20 native smoke as user-approved. The approval included no per-flow notes, so this summary claims no observations beyond that approval.

## Task Commits

1. **Task 1: Enforce hook ceilings, target-owner absence, registry exhaustiveness, and full render isolation** - `1ada3d1` (test), `3468e83` (feat), `05033a6` (feat), `5406792` (feat), `ce5fdbe` (feat), `eda2ca1` (fix), `fc79e5d` (fix), `6fe302f` (test)
2. **Task 2: Automate the add-state and add-mode drills with fail-safe restoration** - `42a2ac8` (test), `b8fbe03` (test)
3. **Task 3: Verify the complete Phase 5 matrix in the macOS Tauri app** - approved at the native human-verification checkpoint; no code commit required

## Files Created/Modified

- `src/lib/shellDecomposition.test.ts` - permanent MainApp AST/source architecture guard.
- `scripts/check-shell-extensibility.mjs` - fail-safe, byte-restoring add-state and add-mode drills.
- `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - real MainApp document-browser, terminal, and active-mode isolation assertions.
- `src/lib/{communicationsModeLifecycle,documentOpsModeLifecycle,documentShellLifecycle,terminalSurfaceLifecycle}.ts` - extracted lifecycle owners that remove remaining shell responsibility.
- `src/lib/modeRegistry.tsx` and `src/lib/modeRegistry.test.ts` - registry placement and lazy-adapter exhaustiveness contracts.
- `src/App.tsx` - shell-only orchestration after lifecycle bridge extraction.

## Decisions Made

- Keep the permanent hook ceiling stricter than D-13 at 15 `useState` and 24 `useEffect`, instead of treating 17/25 as a target to fill.
- Treat lifecycle extraction exposed by the source guard as direct shell-boundary work, while retaining canonical stores, settings keys, workspace request guards, and lazy adapter inputs.
- Record native approval exactly as received: approved, with no detailed per-flow narrative.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 3 - Blocking] Broadened the remaining shell lifecycle extraction required by the exact hook/ownership contract**
- **Found during:** Task 1
- **Issue:** The initial listed guard files could expose the D-13/D-14 violations but could not remove all residual communications, Files/document-operation, terminal, settings, and workspace lifecycle ownership from `MainApp`.
- **Fix:** Moved only the directly responsible lifecycle bridges and their canonical store projections into named production modules; preserved existing data owners, settings keys, navigation metadata, and mode availability.
- **Files modified:** `src/App.tsx`, `src/lib/communicationsModeLifecycle.ts`, `src/lib/documentOpsModeLifecycle.ts`, `src/lib/documentShellLifecycle.ts`, `src/lib/editorDocumentLifecycle.ts`, `src/lib/outlinePaneLifecycle.ts`, `src/lib/shellSettingsLifecycle.ts`, `src/lib/terminalSurfaceLifecycle.ts`, `src/lib/workspaceBootLifecycle.ts`.
- **Verification:** MainApp reached 15 `useState` / 24 `useEffect`; focused isolation contracts and `make verify` passed.
- **Committed in:** `3468e83`, `05033a6`, `5406792`, `ce5fdbe`

**2. [Rule 1 - Bug] Stabilized adapter callbacks that were recreating during store publications**
- **Found during:** Task 1
- **Issue:** Agents, Drafts, and Gap adapters could recreate lifecycle callbacks during registry/controller publications, risking lost handoffs or unnecessary re-renders.
- **Fix:** Stabilized the callbacks and widened the registry placement contract so every right-workbench mode remains reachable through its lazy descriptor.
- **Files modified:** `src/lib/modeAdapters/AgentsModeAdapter.tsx`, `src/lib/modeAdapters/DraftsModeAdapter.tsx`, `src/lib/modeAdapters/GapModeAdapter.tsx`, `src/lib/modeRegistry.tsx`, `src/lib/modeRegistry.test.ts`.
- **Verification:** Adapter, registry, and render-isolation tests passed, followed by the deterministic phase gate.
- **Committed in:** `eda2ca1`, `fc79e5d`

**Total deviations:** 2 auto-fixed (1 Rule 3 blocking issue, 1 Rule 1 bug).
**Impact on plan:** Both changes were required to make the documented architecture boundary true. No product feature, new settings key, eager import, navigation redesign, or unrelated design-QA change entered the plan.

## Native Checkpoint

- **Status:** Approved by the user at the Task 3 human-verification checkpoint.
- **Recorded evidence:** The response was interpreted as `approved`; it did not include per-flow success/failure observations.
- **Cleanup:** The disposable `pnpm tauri:dev` process tree for this smoke, including its Vite server on port 5307 and `target/debug/maru`, was identified by repository path and stopped with `SIGTERM` after approval.

## Known Stubs

None. The scan found only typed empty collections and nullable lifecycle/test variables, not placeholder data flowing to product UI.

## Threat Surface Scan

No new network endpoint, auth path, filesystem trust boundary, or schema trust boundary was introduced. Existing terminal generation validation, controller isolation, and lazy registry contracts are covered by the plan's T-05-01 through T-05-04 mitigations.

## Issues Encountered

None. The source tree contained unrelated modified `docs/design-qa/*.png` files and an untracked `.planning/research/` directory; neither was changed, staged, deleted, reverted, or stashed.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

Phase 5 has its complete permanent guard set, deterministic completion evidence, and native approval recorded. The shell decomposition is ready for the normal phase verification and milestone-close workflows.

## Self-Check: PASSED

- Confirmed the summary and all listed key source files exist.
- Confirmed all ten Task 1 and Task 2 commits exist in the repository history.

---
*Phase: 05-shell-decomposition-completion*
*Completed: 2026-08-27*
