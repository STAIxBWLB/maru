---
phase: 04
slug: editor-surface-state-extraction
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase)
status: draft
nyquist_compliant: false
wave_0_complete: false
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
| **Quick run command** | `pnpm test -- src/lib/outlinePaneStore.test.ts src/lib/editorSurfaceStore.test.ts src/__tests__/editorSurfaceRenderIsolation.test.tsx src/components/EditorPane.test.tsx` |
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
| 04-W0-01 | TBD | 0 | SHELL-01 | T-04-01 | Outline actions remain behind a least-authority command port and existing write checks | unit + component | `pnpm test -- src/lib/outlinePaneStore.test.ts` | No - W0 | pending |
| 04-W0-02 | TBD | 0 | SHELL-02 | Editor actions remain behind a least-authority command port; keyed pane state does not bleed across groups | unit + component | `pnpm test -- src/lib/editorSurfaceStore.test.ts` | No - W0 | pending |
| 04-W0-03 | TBD | 0 | SHELL-03 | Typing changes only subscribed editor slices and never unrelated shell probes | component harness | `pnpm test -- src/__tests__/editorSurfaceRenderIsolation.test.tsx` | No - W0 | pending |
| 04-W0-04 | TBD | 0 | SHELL-04 | Preview marks stay inside sanitized React-owned HTML and retain DOM identity | component regression | `pnpm test -- src/components/EditorPane.test.tsx` | No - W0 | pending |
| 04-W0-05 | TBD | 0 | SHELL-01, SHELL-02 | Both panes remain at or below eight props with no individual state value/change callback props | static source test | Focused Vitest command selected by the planner | No - W0 | pending |

*Status: pending, green, red, or flaky.*

---

## Wave 0 Requirements

- [ ] `src/lib/outlinePaneStore.test.ts` - facade pure transitions, no-op identity, scoped hydration, cleanup, and command-port seams for SHELL-01
- [ ] `src/lib/editorSurfaceStore.test.ts` - group/tab key isolation, no-op identity, persistence hydration, cleanup, and command-port seams for SHELL-02
- [ ] `src/__tests__/editorSurfaceRenderIsolation.test.tsx` - left/right typing harness with unaffected `DocumentList`, `TerminalPanel`, and activity-rail render counters for SHELL-03
- [ ] `src/components/EditorPane.test.tsx` - unchanged `previewHtml` preserves mark classes and marked DOM-node identity for SHELL-04
- [ ] Automated prop-budget assertion - both panes expose at most eight props and no individual state value/change callback props

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Focused native Tauri smoke | SHELL-01, SHELL-02, SHELL-03, SHELL-04 | Chromium with mocked IPC does not exercise WKWebView, real shell wiring, or native save/conflict paths | At phase verification, launch the real Tauri app once; exercise left/right split panes, Outline, Rich/Source/Preview, save, and conflict flows; record the observed result in phase verification evidence |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Focused feedback latency <20 seconds on a warmed checkout
- [ ] `make verify` remains green and the lazy/bundle guard stays unchanged
- [ ] Focused native Tauri smoke evidence recorded
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
