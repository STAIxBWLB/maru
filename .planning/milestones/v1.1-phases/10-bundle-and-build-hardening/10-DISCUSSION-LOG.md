# Phase 10: Bundle and Build Hardening - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-29
**Phase:** 10-Bundle and Build Hardening
**Areas discussed:** CSS split boundary, FOUC prevention, CSP proof standard, Budget target (follow-ups: ownership assignment, preload trigger, packaged-check placement)

---

## CSS split boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Full per-mode split | Each mode's CSS rides its lazy chunk; max headroom, more files | ✓ |
| Two-way split | core (entry) + one combined lazy bundle; simpler, less headroom | |
| Research the boundary first | Defer to researcher analysis of the 24k-line file | |

**User's choice:** Full per-mode split
**Notes:** None.

## Rule ownership assignment (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| Prefix/section rule | Mechanical assignment via existing naming convention; manual edge cases | ✓ |
| DOM-based attribution | Analyze which selectors each mode pane renders | |
| You decide | Planner discretion | |

**User's choice:** Prefix/section rule

## FOUC prevention

| Option | Description | Selected |
|--------|-------------|----------|
| Preload | Warm mode CSS before first activation | ✓ |
| Critical CSS remains | Per-mode first-paint minimum stays in entry | |
| Researcher decides | Decide after frame-level measurement | |

**User's choice:** Preload

## Preload trigger/mechanism (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| Idle full-chunk preload | requestIdleCallback imports lazy chunks; JS+CSS both warm | ✓ |
| Rail hover/focus | Load on activation intent; no idle cost, first hover may lag | |
| Idle + hover | Idle covers most; hover triggers immediately | |

**User's choice:** Idle full-chunk preload

## CSP proof standard

| Option | Description | Selected |
|--------|-------------|----------|
| Static analysis + packaged runtime check | dist blob: scan plus packaged app verification | ✓ |
| Static analysis only | check-*.mjs in make verify; packaged check manual | |
| Native runner | Phase 6 runner proves no console errors | |

**User's choice:** Static analysis + packaged runtime check

## Packaged-check placement (follow-up)

| Option | Description | Selected |
|--------|-------------|----------|
| release-preflight | Gates every release | ✓ |
| One-time manual proof | Static guard only afterwards | |
| You decide | Planner discretion | |

**User's choice:** release-preflight

## Budget target

| Option | Description | Selected |
|--------|-------------|----------|
| Passing 70 KiB is enough | Gate pass is the goal; minimal split | ✓ |
| Restore ~12% headroom | Recover the v0.4.46-era margin (~62 KiB) | |
| You decide | Planner/researcher discretion | |

**User's choice:** Passing 70 KiB is enough

---

## Claude's Discretion

- Per-mode CSS file placement/naming under `src/`
- Static blob:-evidence check implementation (within check-*.mjs idiom)
- Preload scheduling details

## Deferred Ideas

None.
