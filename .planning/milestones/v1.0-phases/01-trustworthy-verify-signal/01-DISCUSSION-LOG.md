# Phase 1: Trustworthy Verify Signal - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-08-22
**Phase:** 1-Trustworthy Verify Signal
**Areas discussed:** Linter choice and rule scope, Pre-existing violation backlog, e2e/scripts typecheck shape, CI trace capture

---

## Linter choice and rule scope

| Option | Description | Selected |
|--------|-------------|----------|
| ESLint 9 flat config | Only linter implementing react-hooks/exhaustive-deps properly; the 18 existing eslint-disable comments keep working. Cost: heavier deps, slower | ✓ |
| Biome | Single binary, much faster, simpler config; but useExhaustiveDependencies differs and all 18 disable comments need converting to biome-ignore | |
| oxlint | Rust-based, fastest; no type-aware checks and incomplete exhaustive-deps support, so it satisfies only half of GATE-02 | |

**User's choice:** ESLint 9 flat config
**Notes:** The 18 pre-existing `eslint-disable` comments in `src/` (including `src/lib/markdown.ts:62`, written for a linter that was never installed) were surfaced during scouting and were the deciding evidence.

### Rule set

| Option | Description | Selected |
|--------|-------------|----------|
| Correctness minimum | react-hooks (both), no-unused-vars, no-floating-promises. Closest to the roadmap's intent, directly guards the Phase 4-5 refactor | ✓ |
| + typescript-eslint recommended | Catches more, but grows the violation backlog and lengthens Phase 1 | |
| + recommended-type-checked | Strongest; slow (needs full type build) and likely to explode the violation count | |

**User's choice:** Correctness minimum
**Notes:** Matches the roadmap's explicit "do not open a style campaign" constraint.

### Lint scope

| Option | Description | Selected |
|--------|-------------|----------|
| src/ + e2e/ | Product and test code; floating promises and unused symbols do accumulate in e2e. scripts/ excluded as build tooling | ✓ |
| src/ only | Narrowest and fastest; Phases 4-5 only touch src/ | |
| src/ + e2e/ + scripts/ | Everything; but build-script violations are unrelated to the refactor risk GATE-02 defends against | |

**User's choice:** src/ + e2e/

### Makefile wiring

| Option | Description | Selected |
|--------|-------------|----------|
| New `make lint` target added to verify | Matches existing lint-i18n / check-select-chrome pattern; lint stays runnable alone | ✓ |
| Merge into `typecheck` | Shorter Makefile, but blurs which check failed | |
| Also add a pre-commit hook | Faster feedback, but this repo has no hook infrastructure — new infra follows | |

**User's choice:** New `make lint` target added to verify

---

## Pre-existing violation backlog

| Option | Description | Selected |
|--------|-------------|----------|
| Fix everything, then open the gate | Zero violations at phase end; but fixing 49 exhaustive-deps risks behavior change, and the gate that would verify it does not exist yet — circular | |
| Staged adoption per rule | Mechanically safe rules go straight to error; exhaustive-deps blocks new violations while the existing 49 are resolved in Phases 4-5 as each pane is touched | ✓ |
| Baseline then ratchet | Fastest to green; the baseline file itself becomes a new maintenance artifact | |

**User's choice:** Staged adoption per rule

### How to mark the 49 existing exhaustive-deps violations

| Option | Description | Selected |
|--------|-------------|----------|
| disable comment + reason at each site | Rule stays error; comments become a grep-able worklist for Phases 4-5 | ✓ |
| File-level override for App.tsx | Smallest diff, but the exemption is coarse | |
| Whole rule as warn | Does not break verify; warnings get ignored over time and new violations are not blocked | |

**User's choice:** disable comment + reason at each site
**Notes:** Deliberately dual-purpose — satisfies the gate now, serves as the Phase 4-5 checklist later, and is meant to be deleted as those phases progress.

### 35 console. calls in non-test src/

| Option | Description | Selected |
|--------|-------------|----------|
| Out of scope | no-console is style, not correctness; falls under the roadmap's banned "lint style campaign" | ✓ |
| no-console as warn | Rule on, records the situation; 35 lines of noise on every lint run | |
| Allow error/warn only | Catches genuine debug leftovers; requires triaging 35 sites now, growing Phase 1 | |

**User's choice:** Out of scope

### Rust clippy violations under -D warnings

| Option | Description | Selected |
|--------|-------------|----------|
| Fix all, no allow | Run -D warnings as-is and fix whatever appears; measure at planning time | ✓ |
| crate-level allow for noisy lints | Bounds the phase by allowing a few refactor-demanding lints with a reason | |
| Decide at planning time | Let the planner run clippy first and choose | |

**User's choice:** Fix all, no allow
**Notes:** The roadmap assumed "pass or near-pass" but never measured; the count is a planning-time finding, not grounds for an `allow`.

---

## e2e/scripts typecheck shape

| Option | Description | Selected |
|--------|-------------|----------|
| Separate projects for e2e and scripts | tsconfig.e2e.json (.ts, strict kept) and tsconfig.scripts.json (allowJs+checkJs, relaxed) — their requirements genuinely differ | ✓ |
| Single tsconfig.tools.json | Fewer files; forces .ts specs to inherit the looser settings .mjs needs | |
| e2e only, skip scripts | Cheaper, but does not meet the GATE-03 wording | |

**User's choice:** Separate projects for e2e and scripts

### strict level for tsconfig.scripts.json

| Option | Description | Selected |
|--------|-------------|----------|
| strict true, fix violations | Same bar as src/; may need JSDoc across 17 build scripts, risking phase growth | |
| strict false, catch errors only | checkJs alone catches call-site typos, missing exports, wrong arity — enough for GATE-03's intent and bounded | ✓ |
| Measure at planning time | Planner runs tsc both ways and decides | |

**User's choice:** strict false, catch errors only

### GATE-05 Rust toolchain pin version

| Option | Description | Selected |
|--------|-------------|----------|
| Pin the stable CI uses today | Freezes present behavior; accurate for reproducibility and introduces no new violations | ✓ |
| Pin 1.77.2 | Matches the Cargo.toml declaration; but builds have used latest stable, so an old toolchain could surface unrelated compile and clippy differences | |
| Pin + declare components | Pin current stable and add clippy/rustfmt to components so GATE-01 works on any machine | |

**User's choice:** Pin the stable CI uses today
**Notes:** Whether to also declare `components` was moved to Claude's discretion — it does not change which version is pinned.

---

## CI trace capture

| Option | Description | Selected |
|--------|-------------|----------|
| trace: retain-on-failure | Writes a trace on first failure with no retry; preserves the no-retry signal the suite earned at v0.4.58 (193/193 first attempt) | ✓ |
| retries: CI ? 1 : 0 | Smallest change, keeps the existing on-first-retry setting; but a CI retry lets flaky tests pass green | |
| Both | Trace plus tolerance for transient failures; masked flake surfaces later | |

**User's choice:** trace: retain-on-failure

### Proving success criterion 3

| Option | Description | Selected |
|--------|-------------|----------|
| One-off failing test, manual proof | Land a deliberately failing spec, run CI once, confirm trace.zip in artifacts, revert | ✓ |
| Config inspection | Fast; does not observe actual trace generation | |
| Permanent canary spec | Certain, but leaves a permanent red signal in CI | |

**User's choice:** One-off failing test, manual proof
**Notes:** Criteria 1 and 2 already describe the same break-it-and-watch-it-fail method, so the approach is consistent across the phase.

---

## Claude's Discretion

- Exact ESLint plugin versions and flat-config file layout
- Whether `rust-toolchain.toml` also declares `components = ["clippy", "rustfmt"]`
- Wording of the individual `eslint-disable-next-line` reasons
- Phrasing of GATE-07's module comment in `src/lib/e2eFlow.ts`

## Deferred Ideas

- `no-console` cleanup (35 occurrences in non-test `src/`)
- Converting `scripts/*.mjs` to TypeScript
- Native Tauri E2E runner (`native-tauri-e2e-runner-missing`) — stays open in the ledger by design
- `typescript-eslint` recommended rule sets, once the exhaustive-deps backlog is burned down
