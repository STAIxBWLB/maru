---
phase: 05
slug: shell-decomposition-completion
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-26
---

# Phase 05 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest 4.1.5, React jsdom component harnesses, Rust `cargo test`, Playwright 1.59.1 |
| **Config file** | `vite.config.ts`, `playwright.config.ts`, `tsconfig.app.json`, `tsconfig.e2e.json`, `tsconfig.scripts.json` |
| **Quick run command** | `pnpm test -- src/lib/documentBrowserStore.test.ts src/lib/terminalPanelStore.test.ts src/components/TerminalPanel.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx` |
| **Full suite command** | `make verify && pnpm test:e2e` |
| **Estimated runtime** | Quick feedback under 120 seconds; full suite is the phase gate |

---

## Sampling Rate

- **After every task commit:** Run the focused test named by the task and `pnpm typecheck` whenever a public prop, command, handle, store, or registry type changes.
- **After every plan wave:** Run `make verify`.
- **Before `$gsd-verify-work`:** Run `make verify && pnpm test:e2e`, the bundle guard, deliberate drills, and the macOS native smoke.
- **Max feedback latency:** 120 seconds for the focused automated sample.

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 05-01-T1, 05-01-T2 | 01 | 1 | SHELL-05, SHELL-08 | T-05-04 | Four-input `DocumentList` reads canonical, workspace-scoped browser slices; repeated reveal is nonce-safe and workspace cleanup removes stale state. | Unit + component contract | `pnpm test -- src/lib/documentBrowserStore.test.ts src/components/DocumentList.test.tsx` | Yes | green |
| 05-02-T1, 05-02-T2; 05-03-T1 | 02, 03 | 1, 2 | SHELL-06, SHELL-08 | T-05-01, T-05-02 | Every session command uses an opaque generation handle; stale recycled handles are rejected, while terminal state is separated from runtime and local interaction state. | TS/Rust unit + component | `pnpm test -- src/lib/terminalSessionHandle.test.ts src/lib/terminalPanelStore.test.ts src/components/TerminalPanel.test.ts && (cd src-tauri && cargo test terminal)` | Yes | green |
| 05-04-T1, 05-05-T1 through 05-10-T3 | 04-10 | 3-9 | SHELL-07, SHELL-08 | T-05-03, T-05-04 | All 18 app modes have exactly one dedicated lazy descriptor and adapter; mode-specific ownership is outside `MainApp`. | Registry, store, and production-bundle contract | `pnpm test -- src/lib/modeRegistry.test.ts src/lib/shellDecomposition.test.ts && pnpm build && pnpm check:bundle-budget` | Yes | green |
| 05-11-T1 | 11 | 10 | SHELL-05, SHELL-06, SHELL-07, SHELL-08 | T-05-01 through T-05-04 | Hook ceilings, target-owner absence, lazy imports, and document/terminal/mode publish isolation stay enforced. | Architecture + real-shell render harness | `pnpm test -- src/lib/shellDecomposition.test.ts src/lib/modeRegistry.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx && pnpm typecheck` | Yes | green |
| 05-11-T2 | 11 | 10 | SHELL-07, SHELL-08 | T-05-03 | A temporary pane-state and temporary lazy mode can be added without changing `src/App.tsx`, then are restored safely. | Deliberate mutation drill | `node scripts/check-shell-extensibility.mjs` | Yes | green (execution evidence in 05-11 summary) |

*Status values are pending, green, red, or flaky. Planner replaces provisional W0 IDs with final task IDs.*

---

## Wave 0 Requirements

- [x] `src/lib/documentBrowserStore.test.ts` and `src/components/DocumentList.test.tsx` prove the canonical browser owner, four-prop facade, repeat reveal, cleanup, and slice identity.
- [x] `src/lib/terminalSessionHandle.test.ts`, `src/lib/terminalPanelStore.test.ts`, and Rust terminal tests prove generation-handle coverage and transient/runtime separation.
- [x] `src/lib/modeRegistry.test.ts`, `src/lib/shellDecomposition.test.ts`, and the bundle budget prove descriptor shape, all-mode coverage, dynamic imports, and no eager adapter imports.
- [x] `src/__tests__/editorSurfaceRenderIsolation.test.tsx` proves document-browser, terminal, and active mode-local publishes do not re-execute `MainApp` or unrelated shell surfaces.
- [x] Browser and terminal store tests cover stale cleanup/identity and non-persistence of runtime or interaction-only fields; settings lifecycle coverage is retained in `src/lib/shellSettingsStore.test.ts`.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| macOS native Documents/Terminal/Registry matrix | SHELL-05, SHELL-06, SHELL-07, SHELL-08 | Chromium e2e does not exercise WKWebView, real PTY, native channels, dock/Graph lifecycle, or recycled sessions. | Run the current Phase 5 native smoke checklist: Documents query/filter/reveal/favorite/file queue; Terminal spawn/input/output/dock/split/resize/Graph/hide-show/kill-recreate; registry primary/right lazy placement; observe render counters. |
| Add-state deliberate drill | SHELL-08 | The contract is that a real pane-state addition leaves `src/App.tsx` untouched. | Add throwaway facade/component state, run the focused architecture test, verify `git diff -- src/App.tsx` is empty, then revert only the throwaway drill. |
| Add-mode deliberate drill | SHELL-07, SHELL-08 | The production import graph and bundle split must be exercised by a real temporary registry entry. | Add a throwaway lazy adapter and descriptor, run typecheck, registry tests, frontend build, and bundle guard, verify `git diff -- src/App.tsx` is empty, then revert only the throwaway drill. |

---

## Threat References

- **T-05-01:** A recycled terminal session ID receives a stale UI read or mutation. Mitigation: generation-bearing handle at every command boundary plus stale/current table tests.
- **T-05-02:** Mutable channel, pump, native view, or DOM object enters an external-store snapshot. Mitigation: observable store/runtime controller/component-local three-layer split.
- **T-05-03:** A registry entry eagerly imports a heavy mode. Mitigation: dynamic-import descriptor contract, static guard, and bundle-budget proof.
- **T-05-04:** A pane/store action bypasses typed command adapters or existing write gates. Mitigation: least-authority command ports and no direct component `invoke` calls.

---

## Validation Audit 2026-08-27

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved with new tests | 0 |
| Escalated | 0 |
| Existing behavioral contracts re-run | 4 requirement groups |

### Audit Evidence

- `pnpm test -- ...` completed with 211 passed test files and 1,942 passed tests on the rerun. The first full-suite attempt had one non-reproducing `editorSurfaceRenderIsolation` assertion failure; the isolated test and the immediate full-suite rerun passed. Treat this as a test-environment/order warning, not a satisfied-by-assumption result.
- `cd src-tauri && cargo test terminal` completed with 76 passed tests, including stale/current recycled-handle behavior and the every-session-command gateway test.
- `pnpm typecheck` passed.
- `pnpm build && pnpm check:bundle-budget` passed with the initial bundle at 298.7 KiB gzip (320 KiB limit) and CSS at 61.2 KiB gzip (70 KiB limit); required lazy adapter chunks remained present.
- The add-state/add-mode drill was not re-run in this audit because it deliberately writes temporary implementation source, which is outside the audit's read-only implementation constraint. Its completed, restoring run is recorded in `05-11-SUMMARY.md` and remains covered by `scripts/check-shell-extensibility.mjs`.

## Validation Sign-Off

- [x] All tasks have automated verification.
- [x] Sampling continuity: no 3 consecutive tasks without automated verification.
- [x] Wave 0 references replaced by implemented task coverage.
- [x] No watch-mode flags.
- [x] Focused feedback latency remains under 120 seconds.
- [x] `nyquist_compliant: true` set in frontmatter after implementation evidence exists.

**Approval:** validated 2026-08-27
