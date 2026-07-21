# Maru Today — Design QA (Group 3)

Visual QA of the Maru Today stages against the reference render
(`exec-a7ea0eb8-a8a6-4a6d-93d5-ce47460cd304.png`, 1487x1058), produced on
branch `feat/today-morning-ritual`.

## How this was run

- Interactive QA was done via **Playwright-driven Chromium against `pnpm dev`
  (plain Vite, no Tauri backend)**, not the packaged Tauri shell — the
  desktop app is not runnable in this environment. All Today commands are
  mocked deterministically through the in-page fake registered by
  `e2e/helpers/todayFixtures.ts` (`window.__MARU_E2E_INVOKE__`, see
  `src/lib/e2eInvoke.ts`); hover/focus/keyboard flows are exercised in
  `e2e/today.spec.ts`.
- Spec: `e2e/today-design-qa.spec.ts` (re-runnable, asserts the anchors below
  as hard gates).

## Fixture

- Locale `ko` (localStorage `maru:locale:v1`), light theme, browser timezone
  `Asia/Seoul`.
- Logical clock fixed at `2026-07-21T03:30:00+09:00` via Playwright's fake
  clock → greeting reads `좋은 아침입니다 · 2026년 7월 21일 화요일 · 03:30`.
- Logical day `2026-07-21`, day window 03:30–21:30, dayState `preparing`.
- 5 captures: Gmail 2 / Telegram 1 / 카카오톡 1 / Outlook 1 (see P2-2 re:
  the reference's 회의 chip).
- Top 3 filled (사업계획서 핵심안 확정 45분 / 공유대학 예산안 검토 30분 /
  연구계약서 회신 60분), one fixture-completed Top-3 item, one deferred item.
- Yesterday groups 완료 6 / 진척 2 / 이월 3 (matches the reference counts).
- Capacity from 2 calendar commitments (10:00–11:30, 14:00–15:00) and the
  480분 focus cap.
- Outbox: 1 `retryNeeded` record (sync-error state visible on Execute).
- Shell state: right pane (outline) closed, matching the reference.

## Artifacts

- `docs/design-qa/today-prepare-1487.png` — Prepare at the reference viewport
- `docs/design-qa/today-execute-1487.png` — Execute
- `docs/design-qa/today-review-1487.png` — Review
- `docs/design-qa/today-prepare-1440.png` — Prepare at 1440x920
- `docs/design-qa/today-prepare-1024.png` — Prepare at 1024x720
- `docs/design-qa/side-by-side.png` — reference (left) vs implementation (right)
- `docs/design-qa/measurements.json` — raw boundingBox() output

## Pixel-anchored measurements (1487x1058)

| Area | Expected | Measured | Status |
| --- | --- | --- | --- |
| Topbar height | 44px | 44px | pass |
| Activity rail width | 48px | 48px | pass |
| Today sidebar width | 350px ±2 | 350px | pass |
| Workflow header height | ~116px ±4 | 116px | pass |
| Brain-dump panel width | 39.5% of grid (401.7px) ±4 | 401.7px | pass |
| Capture panel width | 60.5% of grid (615.3px) ±4 | 615.3px | pass |
| Brain-dump / capture split | 39.5/60.5 | 39.5/60.5 | pass |
| Horizontal overflow | none | scrollWidth == clientWidth (1487) | pass |

## States checklist

| State | Coverage |
| --- | --- |
| loading (snapshot/captures in flight) | unit: `TodayPane.test.tsx` (degraded shell), capture loading row in `TodayPrepare.test.tsx` |
| empty (Top 3, Done Today, captures, review groups) | unit: `TodayExecute.test.tsx` ("always renders the Done Today section…"), `TodayReview.test.tsx`; visual: 고정 일정 empty in `today-execute-1487.png` |
| provisional estimate | unit: `todayPlan.test.ts` ("falls back to provisional estimates and flags them"), capture add-to-today e2e (provisional 30분 item added via fixture) |
| accepted (capture add-to-today) | unit: `TodayPrepare.test.tsx` + e2e: `today.spec.ts` prepare test (setPlan asserted, no task-creation invokes) |
| over-capacity | unit: `TodayCapacityCards.test.tsx` ("shows the over-capacity warning…"), `todayPlan.test.ts` ("flags over-capacity…") |
| confirmed (planned/executing day) | e2e: `today.spec.ts` execute + review tests; visual: `today-execute-1487.png` |
| sync-error | unit: `TodaySyncStatus.test.tsx`; e2e + visual: `retryNeeded` badge + "동기화 재시도 필요" row in `today-execute-1487.png` |
| read-only / degraded (no snapshot) | unit: `TodayPane.test.tsx` ("skips route persistence in degraded mode"); browser default without the fixture (invoke rejects → degraded shell) |

## Responsive notes

- **1440x920**: sidebar 350px, brain-dump/capture side by side
  (383.1px / 586.9px), no overflow. See `today-prepare-1440.png`.
- **1024x720** (today pane 976px, ≤1239px container breakpoint): one-column
  grid (capture stacks under brain dump), sidebar 280px with labels,
  `scrollWidth == clientWidth` (1024). See `today-prepare-1024.png`.
- **960x720** (today pane ≤959px breakpoint): sidebar collapses to 56px
  icon-only, labels hidden, still no horizontal scroll (asserted in
  `today.spec.ts` layout smoke).
- The icon-only breakpoint needs a viewport of ~1007px or below (today pane
  = viewport − 48px rail with the right pane closed), so at exactly 1024 the
  correct state is the 280px labeled sidebar, not icon-only.

## Mismatches

### Fixed

- **P1 — compact sidebar breakpoints were dead CSS.** An element cannot match
  its own container query, so `.today-pane { grid-template-columns: 280px/56px … }`
  inside `@container todaypane (…)` never applied: the sidebar stayed 350px
  at every width and the icon-only collapse never happened. Fixed in
  `src/styles.css`: the pane track is now `auto minmax(0, 1fr)` and the width
  lives on the descendant `.today-sidebar` (350px → 280px ≤1239px → 56px
  ≤959px), which *can* match the container query. Re-shot all screenshots;
  anchor table above is post-fix.

### Open (P2, cosmetic / structural deltas from the reference mock)

- **P2-1** Reference left column shows workspace explorer rows (Private /
  Public 추가, Documents / Files) above the Today nav; the implementation's
  today sidebar contains the Today nav only. The 350px column geometry
  itself matches.
- **P2-2** Reference capture chips include `회의 1`. Meeting-derived
  captures are intentionally not implemented (documented TODO in
  `src/lib/todayCapture.ts`); the fixture's 5th capture is Outlook 1. The
  Kakao chip renders as `카카오톡` (i18n label) vs the reference's `Kakao`.
- **P2-3** Reference sidebar shows counts (Inbox 0, 다음에 할 일 12); the
  counts are optional props fed from live data and are absent in the mocked
  browser fixture.
- **P2-4** Reference Top 3 rows show an edit affordance only; the
  implementation shows ↑/↓ + edit (the keyboard-reorder buttons are an
  intentional accessibility feature with a live-region announcement).
- **P2-5** Capacity numbers differ from the reference (7시간 20분 etc.) —
  they are computed from the fixture's commitments, not hard-coded tokens.
- **P2-6** The collapsed terminal dock (36px) is visible at the bottom of
  the implementation screenshots; the reference shows only a minimal
  bottom-left strip.

No P0 issues found (no broken layout or overflow at any tested viewport).
