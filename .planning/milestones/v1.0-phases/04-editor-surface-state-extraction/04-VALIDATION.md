---
phase: 04
slug: editor-surface-state-extraction
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-26
---

# Phase 04 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Vitest `^4.1.5` with jsdom `^29.1.1`; Playwright for browser-mode E2E |
| **Config file** | `vite.config.ts`, `playwright.config.ts` |
| **Quick run command** | `pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx src/components/EditorPaneFacade.test.tsx` |
| **Full suite command** | `make verify` |
| **Estimated runtime** | <20 seconds focused on a warmed checkout; full gate is repository-dependent |

---

## Sampling Rate

- **After every task commit:** Run the focused Vitest files owned by that task plus `pnpm typecheck`
- **After every plan wave:** Run `make verify`
- **Before `$gsd-verify-work`:** `make verify` must be green, followed by the focused native Tauri smoke below
- **Max feedback latency:** 20 seconds for focused tests on a warmed checkout

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 04-W0-01 | 04-01 | 0 | SHELL-01 | T-04-01 | Outline actions remain behind a least-authority command port and existing write checks | unit + component | `pnpm exec vitest run src/lib/outlinePaneStore.test.ts` | Yes | green |
| 04-W0-02 | 04-01 | 0 | SHELL-02 | T-04-10 | Editor actions remain behind a least-authority command port; keyed pane state does not bleed across groups | unit + component | `pnpm exec vitest run src/lib/editorSurfaceStore.test.ts` | Yes | green |
| 04-W0-03 | 04-01 | 0 | SHELL-03 | T-04-12 | Real left/right draft publishes re-execute MainApp without re-rendering DocumentList, TerminalPanel, or ActivityRail | component integration | `pnpm exec vitest run src/__tests__/editorSurfaceRenderIsolation.test.tsx` | Yes | green |
| 04-W0-04 | 04-01 | 0 | SHELL-04 | T-04-11 | Preview marks stay inside sanitized React-owned HTML and retain exact DOM-node identity | component regression | `pnpm exec vitest run src/components/EditorPane.test.tsx` | Yes | green |
| 04-W0-05 | 04-01 | 0 | SHELL-01, SHELL-02 | T-04-W0-02 | Both panes expose exactly four structural props with no individual state value/change callback props | static source test | `pnpm exec vitest run src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts` | Yes | green |
| 04-07-01/02 | 04-07 | 6 | SHELL-03 | T-04-16, T-04-18 | Nonzero production-boundary baselines and actual left/right updateTabDraft calls prove a non-vacuous MainApp isolation path | component integration | `pnpm exec vitest run src/__tests__/editorSurfaceRenderIsolation.test.tsx` | Yes | green |

*Status: pending, green, red, or flaky.*

---

## Wave 0 Requirements

- [x] `src/lib/outlinePaneStore.test.ts` - facade pure transitions, no-op identity, scoped hydration, cleanup, and command-port seams for SHELL-01
- [x] `src/lib/editorSurfaceStore.test.ts` - group/tab key isolation, no-op identity, persistence hydration, cleanup, and command-port seams for SHELL-02
- [x] `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - real MainApp left/right draft publishes with nonzero production `DocumentList`, `TerminalPanel`, and `ActivityRail` counters for SHELL-03
- [x] `src/components/EditorPane.test.tsx` - unchanged `previewHtml` preserves mark classes and marked DOM-node identity for SHELL-04
- [x] Automated prop-budget assertion - both panes expose four structural props and no individual state value/change callback props

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Focused native Tauri smoke | SHELL-01, SHELL-02, SHELL-03, SHELL-04 | Chromium with mocked IPC does not exercise WKWebView, real shell wiring, or native save/conflict paths | At phase verification, launch the real Tauri app once; exercise left/right split panes, Outline, Rich/Source/Preview, save, and conflict flows; record the observed result in phase verification evidence |

Evidence: PASS recorded in `04-06-SUMMARY.md` for the real Tauri/WKWebView Outline, split, mode, disk-save, external-revision conflict, cleanup, persistence, and IPC/serde checks.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all formerly missing references
- [x] No watch-mode flags
- [x] Focused feedback latency <20 seconds on a warmed checkout
- [x] `make verify` remains green and the lazy/bundle guard stays unchanged
- [x] Focused native Tauri smoke evidence recorded
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-08-26

## Validation Audit 2026-08-26

| Metric | Count |
|--------|-------|
| Gaps found | 5 |
| Resolved | 5 |
| Escalated | 0 |

- Focused contract suites: 5 files, 25 tests passed
- Full repository gate: `make verify` passed
- Browser E2E: 203 tests passed
- Bundle boundary: initial JS 299.3/320 KiB gzip and CSS 61.2/70 KiB gzip
- New test files required: none
