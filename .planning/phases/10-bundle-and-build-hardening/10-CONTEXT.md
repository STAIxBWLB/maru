# Phase 10: Bundle and Build Hardening - Context

**Gathered:** 2026-08-29
**Status:** Ready for planning

<domain>
## Phase Boundary

The shipped bundle carries a tighter CSP and its original CSS budget headroom
back, both verified against the packaged build rather than the dev server:
`script-src 'self' blob:` is dropped if the packaged production build no longer
requires it (SEC-01), and per-mode CSS ships inside that mode's own lazy chunk
instead of the entry stylesheet so the initial-CSS budget check passes at its
existing threshold (PERF-05), with no mode showing unstyled content on first
activation.

</domain>

<decisions>
## Implementation Decisions

### CSS split

- **D-01:** Full per-mode split. Every mode's CSS leaves `src/styles.css` and
  ships in that mode's own lazy chunk; only genuinely shared/base styles stay
  in the entry stylesheet. — **Reversibility:** costly — once rules are
  dispersed across per-mode files, re-consolidating means re-deriving
  ownership for every selector again.
- **D-02:** Rule ownership is assigned mechanically by the existing class
  naming convention (per-mode prefix/section pattern in `src/styles.css`);
  only boundary cases get manual review. No new analysis tooling is built for
  the assignment.

### First-activation styling (FOUC)

- **D-03:** Preload on idle. After app load, `requestIdleCallback` triggers a
  dynamic `import()` of each mode's lazy chunk, which carries its CSS with it
  - JS and CSS are both warm before first activation. No hover/focus trigger
  is needed on top of idle preload.

### CSP tightening

- **D-04:** Dropping `script-src blob:` requires two proofs: (a) a static
  check that nothing in the production `dist/` output requires blob: script
  URLs, in the shape of the existing `scripts/check-*.mjs` family, and
  (b) a packaged-build runtime check. The packaged check lives in
  `release-preflight` so it gates every release, not just this change.
- **D-05:** `worker-src blob:` stays. The graph worker needs it and it is
  already declared separately (`src-tauri/tauri.conf.json`); only
  `script-src blob:` is in scope.

### Budget target

- **D-06:** Passing the existing 70 KiB initial-CSS budget is sufficient. The
  budget numbers are not raised (per PERF-05) and no additional headroom
  target (e.g. restoring the ~12% margin from the v0.4.46-era comment in
  `scripts/check-bundle-budget.mjs`) is pursued in this phase.

### Claude's Discretion

- Per-mode CSS file placement and naming convention under `src/`.
- How the static "dist requires blob: script" check is implemented, within
  the `scripts/check-*.mjs` idiom.
- Preload scheduling details (which modes, idle callback ordering).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Requirements and goals
- `.planning/ROADMAP.md` §Phase 10 — goal, success criteria, UI hint
- `.planning/REQUIREMENTS.md` SEC-01, PERF-05 — locked requirement text

### Evidence and prior analysis
- `.planning/codebase/CONCERNS.md` §"dangerouslySetInnerHTML" recommendation
  (2) — why `script-src blob:` is suspect and why `worker-src blob:` stays
- `.planning/codebase/CONCERNS.md` §"Bundle budgets have less headroom than
  the gate suggests" — measured CSS/JS headroom at a938128, and the explicit
  "do not raise the budget" guidance

### Configuration and gates
- `src-tauri/tauri.conf.json` — current CSP (`app.security.csp`)
- `scripts/check-bundle-budget.mjs` — existing budget gate and thresholds

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/check-*.mjs` family (`check-select-chrome.mjs` et al.): the idiom
  the new static CSP-evidence check should follow - plain node script, runs
  in `make verify`, fails the build on violation.
- `React.lazy` mode chunks (`src/App.tsx:501`-`:521`): the per-mode async
  chunks already exist; per-mode CSS rides them once imported from the mode
  module (Vite `cssCodeSplit` default).

### Established Patterns
- Entry-bundle discipline: mode panes, locale dictionaries, and heavy editors
  are dynamic imports precisely to keep the entry inside budget
  (see `.planning/codebase/ARCHITECTURE.md` §bundle budget notes).
- Verification culture from Phase 6: claims are proven against the artifact
  that ships (packaged build), not against dev-server behavior.

### Integration Points
- `src/styles.css` (24k+ lines, monolith) - the file being split.
- `src/foundations.css` - base layer that stays in the entry stylesheet.
- `Makefile` `release-preflight` target - where the packaged CSP runtime
  check lands.
- `scripts/check-bundle-budget.mjs` - may need per-mode CSS assertions once
  the split lands.

</code_context>

<specifics>
## Specific Ideas

- The stale "~12% headroom" comment in `scripts/check-bundle-budget.mjs:28`
  should be corrected to describe reality after the split lands - the user
  accepted 70 KiB-pass as the bar, but the comment should not keep promising a
  margin that is not enforced.

</specifics>

<deferred>
## Deferred Ideas

None - discussion stayed within phase scope.

</deferred>

---

*Phase: 10-Bundle and Build Hardening*
*Context gathered: 2026-08-29*
