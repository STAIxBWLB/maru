# Phase 10 — UI Review

**Audited:** 2026-09-25
**Baseline:** `10-UI-SPEC.md` (approved design contract; regression nature — two claims: computed-style parity after the split, no first-activation FOUC)
**Screenshots:** not captured (no dev server on ports 3000/5173/5307; code-only audit — dist guards and source comparison instead)
**Dispatch note:** generic-agent workaround (typed `gsd-ui-auditor` dispatch unavailable in this session)

---

## Pillar Scores

| Pillar | Score | Key Finding |
|--------|-------|-------------|
| 1. Copywriting | 4/4 | The only copy this phase can affect (`.mode-loading` "…", role="status") is byte-untouched; split moved zero copy |
| 2. Visuals | 4/4 | Rule-level equivalence proven (today 246/246, tasks 174/174, calendar 114/114); pane roots enforced by dist fingerprint guard |
| 3. Color | 4/4 | Single color-definition site preserved; one pre-existing hardcoded `#fff` moved verbatim (today.css:924, merge-base :11387) |
| 4. Typography | 4/4 | Zero raw-px font-size in the 7 per-mode files; check-type-tokens gate not weakened; Pretendard stack asserted per mode in e2e |
| 5. Spacing | 4/4 | Raw spacing line counts preserved exactly: 1956 pre-split = 1299 (styles.css) + 657 (per-mode) |
| 6. Experience Design | 3/4 | 38-test FOUC spec under both color schemes is strong; `.empty-state` duplicate left with two homes and no recorded D-02 disposition |

**Overall: 23/24**

---

## Top 3 Priority Fixes

1. **`.empty-state` still defined twice in the entry stylesheet** — styles.css:3608 (`place-items: center; gap: 10px; padding: 36px 24px`) and styles.css:17874 (`justify-items: center; gap: var(--space-2); min-height: 104px; padding: var(--space-6)`). The later block (:17874) deterministically wins today and the e2e spec pins its computed values, so there is no visible breakage — but plan 10-02's prohibition ("No duplicated selector is left with two homes") required one owning section or an explicit entry-side disposition, and neither landed. The shadowed :3608 block (+ its `.empty-state strong`/`.empty-state p` companions, also duplicated) is dead weight and a latent trap: any future move of one block can flip the winner silently. Fix: delete the :3608 block and its companion rules (~20 lines), or record the explicit D-02 disposition in the SUMMARY.
2. **`color: #fff` hardcoded in a per-mode file** — today.css:924 inside `.today-button-primary`. Pre-existing at merge base and moved verbatim per D-01 (so not a phase regression), but after the split it is the only hardcoded color outside styles.css, the single color-definition site — per-mode files have no color-definition privileges per the UI-SPEC. The button sits on `var(--accent)` (scheme-invariant #b23a26), so legibility holds in both schemes today. Fix: hoist to a token (e.g. `--on-accent` defined in styles.css) so future dark-scheme retunes cannot strand white text.
3. **Backfill the `.empty-state` D-02 boundary disposition into 10-02-SUMMARY.md** — the summary's "D-02 Boundary Dispositions" list covers segmented-control, dialog-backdrop, pkm, calendar tokens, sr-only, etc., but omits `.empty-state` (the one duplicated selector the plan named by line number as a required boundary case). The e2e parity assertion covers the winner via the gap pane (`갭 분석`) but not the `.empty-state strong`/`p` companion duplicates. Fix: record the disposition (entry-side, later block wins) and optionally extend the e2e empty-state assertion to the `strong`/`p` computed styles.

---

## Detailed Findings

### Pillar 1: Copywriting (4/4)

UI-SPEC declares the loading fallback as the only copy this phase can affect, with "No CTAs, no destructive confirmations."

- `.mode-loading` renders `…` with `role="status"` at App.tsx:8432 and modeRegistry.tsx:58/67/74/81 — unchanged; styles.css keeps the class (verified in Pillar 6).
- Empty state copy remains i18n-keyed via the EmptyState primitive; the split moved no text. The e2e spec contains diagnostic strings (JSON computed-style dumps) only in test-failure paths — not user-facing copy.
- No generic label literals (`Submit`/`Click Here`/`OK`/`Cancel`/`Save`) introduced in the touched mode directories.

### Pillar 2: Visuals (4/4)

- **Rule-level parity:** 10-02's brace-walk proof (esbuild-minified, char-level) shows today 246/246, tasks 174/174, calendar 114/114 rules in their chunks, meetings 257/258 exact + 1 via the vite autoprefixer `-webkit-backdrop-filter:blur(10px)` insertion (verified not a loss), 0 self-duplicates, entry chunk carries zero moved rules.
- **Focal-point integrity:** the ownership guard (check-mode-css-ownership.mjs, run by this audit against a fresh build) verifies each mode's pane-root rule body — `.today-pane{display:grid`, `.drafts-pane{display:flex`, etc. — appears in exactly one produced dist chunk and never in the entry chunk. Guard chain output on fresh dist: `mode-css-ownership: 14 CSS chunks, 7 marker-bearing per-mode files, ownership verified, entry chunk clean`.
- **Icon buttons:** 102 `aria-label` attributes across today/tasks/meetings/agents TSX; ModeChrome and TodayTop3 confirm the pattern.
- **Painting proof:** the FOUC spec asserts each mode's root surface is painted (`backgroundColor !== transparent || backgroundImage !== none`) and not `display: none` on first activation — gradient panes handled explicitly.
- Screenshots were not captured (no dev server); the computed-style assertions substitute as visual evidence, but pixel-level confirmation is outstanding (see Minor Recommendations).

### Pillar 3: Color (4/4)

- **Single color-definition site preserved:** both head-of-file `prefers-color-scheme` blocks (styles.css:78, :14881) and all six `:root` token blocks (:1, :130, :180, :14854, :14903, :17664) remain entry-side; the 7 per-mode files define zero `:root` or scheme blocks (grep clean).
- **Accent discipline:** accent appears in per-mode files only as `background: var(--accent)` on `.today-button-primary` — one of the UI-SPEC's five reserved element groups (primary buttons). No accent drift, no new accent uses.
- **Hardcoded colors:** exactly one in the 7 per-mode files — today.css:924 `color: #fff` — verified byte-identical at merge base (:11387, pre-existing, moved verbatim per D-01). It is a token-hygiene nit (Priority Fix 2), not a scheme break: the text sits on `var(--accent)`, which is fixed in both schemes.
- **No new color tokens, no renames:** confirmed via the 10-02 rule-level equivalence proof.

### Pillar 4: Typography (4/4)

- **Token discipline after the split:** all 289 `font-size:` declarations across the 7 per-mode files use `var(--*)` tokens (grep for non-var values returns empty); styles.css retains only the two relative values the spec documents (`0.9em`, `0`) — the raw-px escape hatch was never used.
- **Guard-weakening prohibition holds:** check-type-tokens still greps only `src/styles.css` (Makefile), and no raw-px font-size rule was moved out of it to dodge the gate — both sides verified clean.
- **Weight preservation:** 400/600 declared pair plus 650/700 pre-existing rungs moved verbatim; the rule-level equivalence proof confirms no normalization during the split.
- **Font stack proof:** the FOUC spec asserts `font-family` includes "Pretendard Variable" on every mode's root surface under both color schemes.

### Pillar 5: Spacing (4/4)

- **Value preservation is exact:** raw padding/gap/margin line counts across the split sum to the merge-base census — 1956 lines pre-split vs 1299 (styles.css) + 168 + 157 + 121 + 59 + 56 + 46 + 50 = 657 (per-mode). No rule's spacing changed during the move, which is the spec's only spacing requirement ("no rule's spacing may change during the split").
- **Token usage in moved rules:** 14 `var(--space-*)` references across the 7 per-mode files (4× --space-2, 3× --space-3, 2× --space-6, 2× --space-5, 1× each --space-1/4/7); the e2e `.empty-state` assertion pins computed `padding: 20px` (--space-6) and `gap: 6px` (--space-2) — foundation scale conformant.
- Raw-px spacing dominates the moved files (657 raw lines) — this is the pre-existing convention carried verbatim (1956/1970 raw pre-split), not a phase regression; the spec declares no new spacing and requires values unchanged.

### Pillar 6: Experience Design (3/4)

- **FOUC coverage (the phase's core UX claim): strong.** `e2e/first-activation-styles.spec.ts` — 38 Playwright tests, one genuine first activation per test (fresh context + localStorage clear), 16 rail modes + pkm `.editor-pane` + e2e `?maru-e2e=1`, under both `colorScheme: "light"` and `"dark"` describe blocks. Asserts painted surface, non-hidden display, and the Pretendard stack per mode. Dark is correctly treated as the first-paint FOUC path.
- **Idle preload:** `src/lib/modePreload.ts` honors D-03 — idle-only via reused `scheduleStartupIdle(…, 2000)`, no hover/focus trigger, per-load failures swallowed (`.catch(() => {})`), imports only `./modeRegistry` + `./startupProfile` (src/lib boundary respected). `src/main.tsx` wiring is exactly two lines, called after `markStartup("app:entry")` before render.
- **Loading fallback:** `.mode-loading`/`.editor-loading` stay entry-side (styles.css:4025-4035); the e2e spec verifies the rule is resolvable in `document.styleSheets` on first activation under both schemes. The fallback *render* during a chunk window is not directly observed — per the plan this is a pass condition once the idle preload closes the window, noted only.
- **Chunk failure:** idle-preload failure degrades to normal lazy load; activation-time failure is pre-existing behavior; no ErrorBoundary exists and the UI-SPEC marks adding one out of scope. Error surfaces (errorStore toast) unchanged.
- **Deduction — `.empty-state` duplicated selector:** plan 10-02's prohibition required every duplicated selector to have exactly one owning section (or an explicit entry-side disposition recorded in the SUMMARY). Both definitions remain (styles.css:3608, :17874) and no disposition was recorded. Today's behavior is deterministic (both entry-side; later block wins; e2e pins `display: grid`, `min-height: 104px`, `padding: 20px`, `gap: 6px` via the gap pane and passes), so this is a latent-risk/process gap, not a visible defect — score 3/4 rather than 4/4.

---

## Registry Audit

Skipped: `components.json` does not exist in this project and the UI-SPEC declares no third-party registries (`Tool: none`).

---

## Files Audited

**Baseline and phase records**
- .planning/phases/10-bundle-and-build-hardening/10-UI-SPEC.md (audit baseline)
- 10-01-SUMMARY.md, 10-02-SUMMARY.md, 10-03-SUMMARY.md
- 10-01-PLAN.md, 10-02-PLAN.md, 10-03-PLAN.md
- 10-CONTEXT.md (D-01..D-06)

**Styles and split surfaces**
- src/styles.css (invariants: prefers-color-scheme :78/:14881, :root blocks, .mode-loading/.editor-loading :4025-4035, .sr-only :294, .empty-state :3608/:17874, spacing census)
- src/components/today/today.css, meetings/meetings-pane.css, tasks/tasks.css, calendar/calendar.css, drafts/drafts.css, gap/gap.css, agents/agents.css (markers, font-sizes, colors, spacing)
- src/components/{drafts/DraftsPane.tsx, gap/GapPane.tsx, agents/AgentsPane.tsx, meetings/MeetingsPane.tsx, today/TodayPane.tsx, tasks/TasksPane.tsx} (CSS import placement)

**FOUC and preload**
- e2e/first-activation-styles.spec.ts
- src/lib/modePreload.ts
- src/main.tsx

**Guards and config**
- scripts/check-mode-css-ownership.mjs (+ .test.ts), scripts/check-csp-blob.mjs (+ .test.ts)
- scripts/check-bundle-budget.mjs (D-06 comment, byte-identical thresholds)
- package.json (build:frontend chain order), Makefile (check-type-tokens), src-tauri/tauri.conf.json (CSP)

**Verification run by this audit**
- `pnpm build:frontend` on a fresh dist: bundle-budget initial JS 310.3 KiB / CSS 45.3 KiB (both under 320/70), native-e2e-isolation clean, csp-blob clean (76 JS bundles), mode-css-ownership clean (14 chunks, 7 marker-bearing files, entry clean)
- CSP assertion: `script-src` exactly `'self'`, `worker-src` exactly `'self' blob:`
- Policy pins: check-csp-blob.test.ts (8) + check-mode-css-ownership.test.ts (11) = 19/19 pass
- Merge-base comparison (4efd1c55): `.empty-state` duplicate pre-existed (:3608/:24072); raw spacing lines 1956; `#fff` pre-existing (:11387)
