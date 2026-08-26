---
phase: 04-editor-surface-state-extraction
reviewed: 2026-08-26T02:51:00Z
depth: standard
files_reviewed: 16
files_reviewed_list:
  - src/App.tsx
  - src/__tests__/editorSurfaceRenderIsolation.test.tsx
  - src/components/DocumentList.tsx
  - src/components/EditorPane.test.tsx
  - src/components/EditorPane.tsx
  - src/components/EditorPaneFacade.test.tsx
  - src/components/EditorPaneFacade.tsx
  - src/components/OutlinePane.tsx
  - src/components/TerminalPanel.tsx
  - src/lib/editorPaneStore.ts
  - src/lib/editorSurfaceAdapter.ts
  - src/lib/editorSurfacePersistence.ts
  - src/lib/editorSurfaceStore.test.ts
  - src/lib/outlinePaneStore.test.ts
  - src/lib/outlinePaneStore.ts
  - src/lib/shellSurfaceRenderProbe.ts
findings:
  critical: 1
  warning: 0
  info: 0
  total: 1
status: issues_found
---

# Phase 04: Code Review Report

**Reviewed:** 2026-08-26T02:51:00Z
**Depth:** standard
**Files Reviewed:** 16
**Status:** issues_found

## Summary

The 04-07 change correctly makes the production activity rail a memo boundary, keeps the DocumentList callbacks current through complete dependencies, and leaves the TerminalPanel boundary and activity-rail markup/commands intact. Focused facade and regression tests pass. However, the new MainApp-level regression can pass without proving that the observed production surfaces or the draft-triggered MainApp rerender were actually reached, so it cannot close the phase's sole SHELL-03 verification gap.

## Narrative Findings (AI reviewer)

## Critical Issues

### BL-01: The real-shell isolation regression can pass vacuously

**Classification:** BLOCKER

**File:** `src/__tests__/editorSurfaceRenderIsolation.test.tsx:91-106`

**Issue:** `before` records each named surface as `renders.get(target) ?? 0`, but the test never establishes that `DocumentList`, `TerminalPanel`, or `ActivityRail` rendered before the draft update. If boot/layout state omits a surface, its counter is zero and every later `expectShellStable()` succeeds at zero. The `MainApp` check at line 105 is also only `> 0` after the publish, which is satisfied by the initial mount even when `updateTabDraft()` never causes MainApp to render again. Consequently this test can still be green while no observed production boundary is mounted, or while the actual invalidation path is no longer exercised; both cases recreate the false-positive proof that 04-07 was meant to replace.

**Fix:** After the mount has settled, require every observed boundary to have rendered and snapshot MainApp separately. After the first real draft publish, require MainApp's count to increase while every named boundary remains exactly at its nonzero baseline. For example:

```ts
const mainBefore = renders.get("MainApp") ?? 0;
for (const target of shellTargets) {
  expect(renders.get(target) ?? 0).toBeGreaterThan(0);
}

await act(async () => {
  updateTabDraft(left.id, "left dirty");
});

expect(renders.get("MainApp") ?? 0).toBeGreaterThan(mainBefore);
for (const target of shellTargets) {
  expect(renders.get(target) ?? 0).toBe(before.get(target));
}
```

If a normal initial MainApp mount does not render all three boundaries, configure only the test's ordinary startup/layout inputs so it does; do not replace any of the production components with test doubles.

---

_Reviewed: 2026-08-26T02:51:00Z_
_Reviewer: the agent (gsd-code-reviewer)_
_Depth: standard_
