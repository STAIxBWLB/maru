# Phase 1: Trustworthy Verify Signal - Context

**Gathered:** 2026-08-22
**Status:** Ready for planning

<domain>
## Phase Boundary

Make `make verify` a gate a behavior-preserving refactor can be trusted against.
Delivers GATE-01 through GATE-07: a Rust lint gate, a hook-dependency and
unused-symbol gate, typechecking for `e2e/` and `scripts/`, a Playwright trace on
CI e2e failure, a pinned Rust toolchain, removal of the deprecated
`@types/dompurify` stub, and a truthful E2E flow ledger.

No product behavior changes. Nothing user-visible moves. The deliverable is the
signal itself, because Phases 2 through 5 are all behavior-preserving work whose
only proof is a green gate.

</domain>

<decisions>
## Implementation Decisions

### Linter (GATE-02)

- **D-01:** ESLint 9 with flat config. It is the only linter that implements
  `react-hooks/exhaustive-deps` properly, which is the rule GATE-02 exists for,
  and the 18 `eslint-disable` comments already sitting in `src/` keep working
  instead of needing conversion. — **Reversibility:** costly — switching later
  means rewriting every disable comment to the new tool's syntax and re-tuning
  the rule set; the 18 existing comments are already written against ESLint.
- **D-02:** Correctness rules only, no style rules:
  `react-hooks/rules-of-hooks`, `react-hooks/exhaustive-deps`,
  `no-unused-vars`, `no-floating-promises`. This is the set that guards the
  Phase 4-5 decomposition. Explicitly NOT `typescript-eslint/recommended` or
  `recommended-type-checked` — both inflate the violation backlog past what this
  phase can absorb.
- **D-03:** Lint scope is `src/` and `e2e/`. `scripts/` is excluded: its
  violations are unrelated to the refactor risk GATE-02 defends against.
- **D-04:** New `make lint` target, added to the `verify` prerequisite list
  (`Makefile:309`). Matches the existing `lint-i18n` / `check-select-chrome` /
  `check-type-tokens` pattern and keeps lint runnable on its own locally. Not
  merged into `typecheck`, and no pre-commit hook (this repo has no hook
  infrastructure and adding it is not in scope).

### Pre-existing violation backlog

- **D-05:** Staged adoption per rule, not a single flip. Mechanically safe rules
  (`no-unused-vars`, `rules-of-hooks`) go straight to `error`.
- **D-06:** `exhaustive-deps` is set to `error` too, but each of the 49 existing
  violations in `src/App.tsx` gets an `eslint-disable-next-line` carrying a short
  reason. New violations are blocked from day one, and the comments become a
  grep-able worklist that Phases 4-5 burn down as they touch each pane. Chosen
  over a baseline file (another artifact to maintain) and over blanket `warn`
  (warnings get ignored and would not block new violations).
- **D-07:** `no-console` is not enabled. The 35 `console.` calls in non-test
  `src/` stay. This is a style rule, and the roadmap explicitly rules out a lint
  style campaign.
- **D-08:** Rust clippy runs as `-D warnings` with no crate-level `allow`
  escapes. Every violation it surfaces gets fixed. The roadmap estimated the
  Rust code would "pass or near-pass" but never measured it; if the count turns
  out large, that is a planning-time finding, not a reason to add `allow`.

### Typecheck coverage (GATE-03) and toolchain pin (GATE-05)

- **D-09:** Two separate TypeScript projects, not one. `tsconfig.e2e.json`
  covers `e2e/` (24 `.ts` files) at the existing strict level;
  `tsconfig.scripts.json` covers `scripts/` (17 `.mjs` files) with
  `allowJs` + `checkJs`. Both are added to the `references` array in
  `tsconfig.json`. Splitting them keeps the `.ts` specs from inheriting the
  looser settings that `.mjs` needs.
- **D-10:** `tsconfig.scripts.json` runs with `strict: false`. `checkJs` alone
  catches the real failures (typos in call sites, missing exports, wrong arity)
  without demanding JSDoc annotations across 17 build scripts. Keeps the phase
  bounded.
- **D-11:** `rust-toolchain.toml` pins the version CI builds with today, not the
  `rust-version = "1.77.2"` floor declared at `src-tauri/Cargo.toml:8`. Pinning
  the current stable freezes present behavior; pinning 1.77.2 would reach for a
  toolchain this code has never actually been built with and could surface
  unrelated compile and clippy differences.

### CI trace capture (GATE-04)

- **D-12:** Switch `playwright.config.ts:13` to `trace: "retain-on-failure"`.
  Do NOT add `retries`. Retries would let a flaky test pass green and cost the
  no-retry signal the suite earned at v0.4.58 (193/193 first-attempt).
  `retain-on-failure` writes the trace on the first failure with no retry needed.
- **D-13:** Success criterion 3 is proven empirically, not by config inspection:
  land a deliberately failing spec, run CI once, confirm `trace.zip` is present
  in the uploaded artifacts, then revert the spec. Criteria 1 and 2 use the same
  break-it-and-watch-it-fail method, which is what those criteria already
  describe.

### Claude's Discretion

- Exact ESLint plugin versions and flat-config file layout.
- Whether `rust-toolchain.toml` also declares `components = ["clippy", "rustfmt"]`.
  The version decision (D-11) is settled; adding components is an implementation
  detail that makes GATE-01 work on a fresh machine and does not change which
  version is pinned.
- Wording of the individual `eslint-disable-next-line` reasons in D-06.
- How GATE-07's module comment in `src/lib/e2eFlow.ts` is phrased.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and requirements
- `.planning/ROADMAP.md` §"Phase 1: Trustworthy Verify Signal" — goal, the 5
  success criteria, and the planning notes that pre-decided GATE-01/04/05/07
- `.planning/REQUIREMENTS.md` lines 16-22 — GATE-01 through GATE-07 verbatim
- `.planning/PROJECT.md` §"Out of Scope" — the explicit bans this phase must
  respect, in particular "A full lint style campaign"

### The findings this phase acts on
- `.planning/codebase/CONCERNS.md` §"Missing Critical Features" — "No
  JavaScript/TypeScript linter and no Rust lint gate", the source of GATE-01/02
- `.planning/codebase/CONCERNS.md` §"Known Bugs" — "Playwright traces are
  configured but never captured", the source of GATE-04
- `.planning/codebase/CONCERNS.md` §"Dependencies at Risk" — the unpinned Rust
  toolchain (GATE-05) and the deprecated `@types/dompurify` stub (GATE-06)
- `.planning/codebase/TESTING.md` — current suite layout, run commands, and the
  jsdom pragma rule for `src/lib/*.test.ts`

### Files the gates modify
- `Makefile:309` — the `verify` target D-04 extends
- `tsconfig.json`, `tsconfig.app.json` — the project-reference graph D-09 extends
- `playwright.config.ts:12-13` — the `trace` setting D-12 changes
- `src-tauri/Cargo.toml:8` — the `rust-version` floor D-11 does not treat as a pin
- `src/lib/e2eFlow.ts:139,153` — the resolved `skill-name-drift` entry GATE-07
  drops, and the `native-tauri-e2e-runner-missing` entry that stays
- `package.json:53` — the `@types/dompurify` entry GATE-06 removes

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The `verify` target already composes named sub-targets (`typecheck`,
  `lint-i18n`, `check-select-chrome`, `check-type-tokens`, `test-ts`,
  `test-rust`, `build-frontend`). D-04's `make lint` slots into that list
  without restructuring anything.
- `tsconfig.json` is already a solution-style file with `files: []` and a
  `references` array, so D-09 adds entries rather than inventing a pattern.
- CI already uploads `playwright-report/` and `test-results/` on failure
  (`.github/workflows/ci.yml`), so GATE-04 needs only the trace to start being
  written; the upload path exists.

### Established Patterns
- 18 `eslint-disable` comments already exist in `src/`, including one at
  `src/lib/markdown.ts:62` written for a linter that was never installed. The
  codebase was authored expecting ESLint, which is the strongest single argument
  behind D-01.
- The Node toolchain is pinned (Node >= 22, pnpm 9.15.0) while Rust is not. D-11
  makes Rust match the convention the repo already follows everywhere else.

### Integration Points
- `make verify` is the single gate the whole milestone is measured against; every
  GATE in this phase terminates there.
- `src/App.tsx` holds 49 `useEffect` calls, all of which D-06 annotates. That
  file is also the Phase 4 and Phase 5 target, so the disable comments written
  here are read as a worklist there.

</code_context>

<specifics>
## Specific Ideas

- The no-retry property of the e2e suite is treated as an asset worth protecting,
  not an accident. v0.4.58 shipped 193/193 passing with zero flaky tests and no
  retries; D-12 declines the `retries` fix specifically to keep that signal.
- The `eslint-disable-next-line` comments from D-06 are deliberately dual-purpose:
  they satisfy the gate now and serve as the Phase 4-5 checklist later. They are
  meant to be deleted as those phases progress, not to become permanent.

</specifics>

<deferred>
## Deferred Ideas

- **`no-console` cleanup (35 occurrences in non-test `src/`)** — style, not
  correctness. Would need its own pass with a decision about what replaces the
  calls.
- **Converting `scripts/*.mjs` to TypeScript** — D-10 settles for `checkJs`.
  A real conversion is its own piece of work.
- **Native Tauri E2E runner** (`native-tauri-e2e-runner-missing`,
  `src/lib/e2eFlow.ts:153`) — nothing currently verifies the IPC contract end to
  end. PROJECT.md already lists it as out of scope for this milestone and
  REQUIREMENTS.md tracks it as v2. GATE-07 keeps this ledger entry open on
  purpose.
- **`typescript-eslint` recommended rule sets** — rejected for this phase by
  D-02, but a reasonable follow-up once the exhaustive-deps backlog from D-06 is
  burned down in Phases 4-5.

</deferred>

---

*Phase: 1-Trustworthy Verify Signal*
*Context gathered: 2026-08-22*
