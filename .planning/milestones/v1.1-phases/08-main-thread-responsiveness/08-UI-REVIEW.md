---
phase: "08"
slug: main-thread-responsiveness
status: reviewed
overall: 22/24
audited: "2026-09-21"
method: generic-agent-workaround
---

# Phase 8 UI Review

Performance phase, no visual redesign: Phase 8 moved blocking work off the main thread and consolidated completion notices; the audit verifies the existing UI contracts (wire types, command payloads, error messages, notice/toast consolidation) are preserved, per 08-CONTEXT.md domain ("Preserve permission checks, write guards, IPC error contracts and data ownership") and 08-26-PLAN.md ("No new UI surface or UI-SPEC is required").

**Baseline:** abstract 6-pillar standards (no UI-SPEC.md exists).
**Screenshots:** not captured (no dev server on localhost:3000/5173/8080; Tauri desktop app, so a code-only surface audit applies).
**Verification at audit time:** `pnpm exec vitest run src/lib/processingOperations.test.ts src/lib/skillOperations.test.ts` -> 31/31 pass; `pnpm lint:i18n` -> ok, 3792 keys in parity; zero U+FFFD in either locale. Phase changes are committed on `main` (`31e940f perf(08)`, `f7bd1b0 perf(08-25)`); the `31e940f..HEAD` src diff contains no Phase-8 UI surfaces.

## Scores

| Pillar | Score | Rationale |
|---|---|---|
| 1. Copywriting | 4/4 | New `processing.operation.*` (en.ts:2934-2938, ko.ts:2932-2936) and `skills.operation.*` (en.ts:2927-2933, ko.ts:2925-2931) notices are specific, actionable, and match D-01/D-02/D-05 semantics ("Already syncing; skipped.", "Source settings changed.", "Fix the cause and retry manually."); typed rejections render as `code: message`, not "[object Object]" (processingOperations.ts:105-114). Minor trailing/double-space nit in empty-reason renders. |
| 2. Visuals | 3/4 | Toast frame, icon (15px), message span, and aria-labelled close button are structurally sound (App.tsx:8649-8660); but all three notice kinds share the same AlertTriangle icon, and the phase's new success/info classification has no visual signature beyond a 3px border hue. |
| 3. Color | 3/4 | Token-only usage preserved — `--line/--danger/--panel/--ink` on `.toast` (styles.css:9769-9780), `--accent` on `.toast.notice` (styles.css:9785-9787), `--warn/--warn-soft/--muted` on today badges (styles.css:11086-11091); zero hardcoded colors. Finding: `--accent` (#b23a26) vs `--danger` (#96382a) light, (#d96a4e) vs (#d18074) dark (styles.css:34/39, 96/101) are near-identical hues, so success vs error is not color-legible. |
| 4. Typography | 4/4 | Established type tokens only: `--type-body-size` + line-height 1.5 + word-break on toast text (styles.css:9794-9799), `--type-meta-size` on badges/hints (styles.css:11044, 11176); no new sizes or weights introduced. |
| 5. Spacing | 4/4 | Established 8/10/20px rhythm preserved: toast padding 10/14, gap 10, stack inset 20 (styles.css:9752-9780); today-status margin-top 10 / padding-top 8 / gap 8 (styles.css:11173-11177); no arbitrary spacing values in phase-touched surfaces. |
| 6. Experience Design | 4/4 | The phase's core behavioral contracts are implemented and tested: single-terminal-notice consolidation (duplicate setError/toast publishers deleted in App.tsx, FilesWorkbench.tsx, SharedOutboxPane.tsx:174; SkillsTab local progress/toast machinery removed), notice dedup by operationId + settled guard (errorStore.ts:63-70, processingOperations.ts:158-159), generation-ticket stale suppression incl. A->B->A (App.tsx:1090-1096, skillOperations.ts:62-79), typed error propagation (`skills_source_busy` -> info/skipped, `skills_source_stale` -> stale, skillOperations.ts:130-137), no automatic retry, `outerOperationId` one-notice Studio aggregation (tested in processingOperations.test.ts), and the Plan-12 reconciliation badge that hides ordinary retry for unverified-ID rows (TodaySyncStatus.tsx:376-414). |

**Overall: 22/24**

## Findings

1. **Pillar 2/3 (Visuals + Color) - WARNING (minor):** Success and info notices are visually indistinguishable from errors at a glance. Both render `AlertTriangle` (App.tsx:8650) and differ only by border-left color `--accent` vs `--danger`, which are near-identical warm hues in both themes (#b23a26 vs #96382a light, #d96a4e vs #d18074 dark; styles.css:34/39, 96/101, 9785-9787). The phase's "exactly one correctly classified notice" contract is semantically complete but not visually legible. *Suggested fix:* pick a per-kind icon from the already-imported lucide set (e.g. CheckCircle for success, Info for info/error-adjacent kinds) and keep the existing border tokens; a later phase, since the shared toast predates Phase 8.
2. **Pillar 1 (Copywriting) - WARNING (cosmetic):** Empty-reason templates can render with trailing or doubled spaces: `processing.operation.empty` ends with `{reason}` and `processing.operation.partial` places `{reason}` before "Successful items are kept." (en.ts:2935, 2938; ko.ts:2933, 2936), while `formatNoticeMessage` yields `""` for empty/void statuses (processingOperations.ts:118-123). Result: "Nothing to process. " or " ... {reason}  Successful items...". *Suggested fix:* drop `{reason}` from the empty template or move "Successful items are kept." ahead of `{reason}`; alternatively trim the composed message before publishing.
3. **Pillar 3 (Color) - note, no regression:** `today-sync-badge.warn` uses `--ink` (styles.css:11047) while its hint text uses `--warn` (styles.css:11172) - two warning colorings in one row. Pre-existing badge vocabulary, preserved untouched by this phase. *Suggested fix (optional):* align the badge on `--warn` in a later visual pass.

## Top Fixes

1. Differentiate success/info toasts from errors with a per-kind icon (CheckCircle/Info) instead of the shared AlertTriangle; border tokens can stay.
2. Trim the composed notice message (or reorder the partial/empty templates) so empty reasons leave no dangling spaces.
3. None further: the phase preserved wire types, command payloads, error-message formats (`code: message` mirroring IpcError), label dictionaries (ko/en parity, lint:i18n clean), and single-notice consolidation across all toast channels.
