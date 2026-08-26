---
phase: 05
slug: shell-decomposition-completion
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase)
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| 05-W0-01 | TBD | 0 | SHELL-05 | T-05-04 | Browser actions stay behind typed command ports and canonical store ownership is not duplicated. | Unit + component + static prop contract | `pnpm test -- src/lib/documentBrowserStore.test.ts src/components/DocumentList.test.tsx` | No - W0 | pending |
| 05-W0-02 | TBD | 0 | SHELL-06 | Every session command rejects a stale generation-bearing handle and accepts the current handle. | TS/Rust unit + component + command table | `pnpm test -- src/lib/terminalPanelStore.test.ts src/components/TerminalPanel.test.ts && cd src-tauri && cargo test terminal` | Partial - extend in W0 | pending |
| 05-W0-03 | TBD | 0 | SHELL-07 | Registry descriptors use dynamic imports and registered mode surfaces remain outside the entry chunk. | Registry + static guard + production build | `pnpm test -- src/lib/modeRegistry.test.ts && pnpm build` | No - W0 | pending |
| 05-W0-04 | TBD | 0 | SHELL-08 | Document, terminal, mode-local, and editor publishes do not re-execute `MainApp`. | Real-shell render harness + architecture guard | `pnpm test -- src/__tests__/editorSurfaceRenderIsolation.test.tsx && pnpm typecheck` | Partial - extend in W0 | pending |
| 05-W0-05 | TBD | 0 | SHELL-05, SHELL-06 | Existing settings/localStorage data round-trips through the new owners while stale hydration is rejected and transient state stays transient. | Golden fixture + lifecycle matrix | `pnpm test -- src/lib/documentBrowserStore.test.ts src/lib/terminalPanelStore.test.ts` | No - W0 | pending |

*Status values are pending, green, red, or flaky. Planner replaces provisional W0 IDs with final task IDs.*

---

## Wave 0 Requirements

- [ ] `src/lib/documentBrowserStore.test.ts` and a `DocumentList` facade/prop-budget test for SHELL-05.
- [ ] `src/lib/terminalPanelStore.test.ts` plus Rust/frontend generation-handle tables covering every session-scoped wrapper for SHELL-06.
- [ ] `src/lib/modeRegistry.test.ts` or an equivalent static guard for descriptor shape, dynamic import factories, placement/fallback policy, and no eager mode imports for SHELL-07.
- [ ] Extend `src/__tests__/editorSurfaceRenderIsolation.test.tsx` to document-browser, terminal, and mode-local publishes for SHELL-08.
- [ ] Golden existing settings/localStorage fixtures for semantic round trip, stale hydration rejection, terminal continuity, and transient-state non-persistence.

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

## Validation Sign-Off

- [ ] All tasks have `<automated>` verification or Wave 0 dependencies.
- [ ] Sampling continuity: no 3 consecutive tasks without automated verification.
- [ ] Wave 0 covers all missing references.
- [ ] No watch-mode flags.
- [ ] Focused feedback latency remains under 120 seconds.
- [ ] `nyquist_compliant: true` set in frontmatter after implementation evidence exists.

**Approval:** pending
