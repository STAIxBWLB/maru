---
phase: 01-trustworthy-verify-signal
verified: 2026-08-22T00:00:00Z
status: human_needed
score: 5/5 roadmap success criteria verified, 7/7 GATE requirements verified
behavior_unverified: 1
overrides_applied: 0
human_verification:
  - test: "Re-run the GATE-04 CI probe (deliberately-failing e2e spec, revert after) against the CURRENT playwright.config.ts trace setting (`{ mode: retain-on-failure, snapshots: false, screenshots: false }`, commit a064994), not the earlier wide-trace config that CI run 32559390372 actually exercised."
    expected: "A non-empty, genuinely diagnosable trace.zip (0-trace.network, 0-trace.stacks present) is still produced for the failing test with no retry, confirming the narrower config still satisfies success criterion 3 in practice, not just by Playwright's documented default behavior."
    why_human: "CI run 32568102852 (headSha a064994, the commit that narrowed the trace) was a fully green make verify run with zero e2e failures, so it never exercised the trace-capture path under the config that is actually shipped on HEAD. The only real evidence of a working trace.zip (CI run 32559390372, 14-entry trace including DOM snapshot jpegs) was captured before the narrowing commit, against a materially richer trace config. This is a config-drift gap in the empirical proof, not a broken gate - Playwright's `retain-on-failure` mode is documented to always write trace.zip regardless of the snapshots/screenshots sub-flags - but the specific claim ('the narrowed trace is still sufficient to diagnose a real CI failure') has not been re-proven against what actually ships."
---

# Phase 1: Trustworthy Verify Signal Verification Report

**Phase Goal:** A developer can believe a green `make verify` means a refactor changed nothing
**Verified:** 2026-08-22
**Status:** human_needed (one flagged item below; every roadmap success criterion and GATE requirement otherwise verified)
**Re-verification:** No - initial verification

## VERIFICATION PASSED, with one flagged follow-up

All 5 roadmap success criteria and all 7 GATE-01..07 requirements for this phase are genuinely
met in the codebase, independently re-checked (not read off SUMMARY.md claims): the seven gates
are wired into `make verify`, the deliberate-break-and-revert evidence in the plan summaries is
corroborated by an actual CI catch (`489aa6b`, a real macOS-only clippy violation the new gate
caught before this report was written), and HEAD (`a064994`) is confirmed to be the exact commit
CI run 32568102852 passed against.

One item is flagged for human follow-up (not a phase-goal failure) and four risk notes are
recorded for the team lead's attention, in particular for Phase 3 planning. See below.

## Goal Achievement

### Observable Truths - Roadmap Success Criteria

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A deliberately broken hook dependency list, an unused symbol, an unformatted Rust file, and a clippy warning each fail `make verify` locally and in CI | VERIFIED | `Makefile:321` `verify` target lists `typecheck lint ... test-ts test-rust fmt-check clippy build-frontend`. Break-and-revert evidence recorded per-gate in 01-01 (fmt), 01-02 (clippy), 01-07 (lint, both rules) SUMMARYs, with literal command output/exit codes, not just pass/fail claims. Independently corroborated: CI run `32558565444` on this branch actually failed at the new `clippy` target on a real pre-existing macOS-only violation, fixed in `489aa6b` - proof the gate isn't a no-op. |
| 2 | A type error introduced into a Playwright spec or a `scripts/*.mjs` file fails `make verify` instead of surfacing at runtime | VERIFIED | `tsconfig.json` references all 4 projects (`app`, `node`, `e2e`, `scripts`), confirmed by direct read. Break-and-revert: `TS2322` in `e2e/smoke.spec.ts` and `TS2304` in `scripts/build-macos-passkeys.mjs` each failed `pnpm typecheck` (orchestrator-verified probe, both reverted clean). |
| 3 | A failing e2e test in CI leaves a downloadable Playwright trace in the uploaded artifacts | VERIFIED, with a flagged config-drift caveat | `playwright.config.ts` has `trace: { mode: "retain-on-failure", snapshots: false, screenshots: false }` (commit `a064994`, the branch's current HEAD). CI run `32559390372` proved a working, non-empty, 14-entry trace.zip on a real failure - but that proof predates `a064994` and ran against the WIDER config (plain `"retain-on-failure"`, snapshots+screenshots on). The narrowing commit's own CI run (`32568102852`) was fully green with no e2e failure, so it never exercised trace capture under the config that actually ships. See Human Verification below - this is the one behavior-unverified item in this report. |
| 4 | Checking out an older commit and building reproduces that commit's Rust toolchain rather than today's `stable` | VERIFIED for this phase and forward; does not and cannot apply retroactively | `rust-toolchain.toml` (repo root, `channel = "1.98.0"`) is new in this phase (`1cbefd8`). rustup's toolchain-file resolution walks up from cwd, so any future `cd src-tauri && cargo ...` on this commit or a later one now deterministically resolves `1.98.0` regardless of the machine's ambient `stable`. For commits BEFORE `1cbefd8`, there is no `rust-toolchain.toml` to check out - those commits never recorded a toolchain, so nothing is "reproduced" for them; they fall back to ambient `stable`, exactly as before this phase. This is what a toolchain-pin file can and cannot do, not a shortfall in the phase's delivery - the roadmap's phrasing is best read as "from here forward," which does hold. |
| 5 | `pnpm typecheck` passes with `@types/dompurify` removed, and the shipped E2E flow ledger contains no already-resolved entries | VERIFIED | `package.json`: `@types/dompurify` absent, `dompurify` (the real package) present at `^3.4.1`. `src/lib/e2eFlow.ts`: `TODO_LEDGER` has exactly 5 entries, all `status: "todo"`, zero `"done"`, confirmed by direct grep, not the SUMMARY's claim. |

**Score:** 5/5 roadmap success criteria verified (1 with a flagged, non-blocking config-drift caveat).

### GATE Requirements (REQUIREMENTS.md)

| Requirement | Status | Evidence |
|---|---|---|
| GATE-01 (Rust fmt+clippy gate) | VERIFIED | `fmt-check` and `clippy` targets present in `Makefile`, both in `verify`'s prerequisite chain. Zero new `#[allow(clippy::...)]` in this phase's diff (the 6 pre-existing escapes I found via direct grep - `ai_router.rs`, `scratchpad.rs`, `drafts.rs` x2, `today.rs`, `agent_host/structured_loop.rs` - all predate this phase per 01-02-SUMMARY's own disclosure and my independent grep). |
| GATE-02 (hook-dep + unused-symbol lint gate) | VERIFIED | `eslint.config.js` has exactly the 4 D-02 rules, no preset extended, `no-console` absent (confirmed by direct read). `lint` target wired into `verify` immediately after `typecheck` (`Makefile:321`). |
| GATE-03 (typecheck `e2e/` + `scripts/`) | VERIFIED | `tsconfig.e2e.json` and `tsconfig.scripts.json` both exist and are referenced from `tsconfig.json` (confirmed by direct read of all three files). |
| GATE-04 (CI trace on e2e failure) | VERIFIED, with the flagged config-drift caveat above | See truth #3. |
| GATE-05 (pinned Rust toolchain) | VERIFIED | `rust-toolchain.toml` at repo root, `channel = "1.98.0"`, `components = ["clippy", "rustfmt"]`. |
| GATE-06 (`@types/dompurify` removed) | VERIFIED | Confirmed by direct `package.json` read. |
| GATE-07 (truthful E2E ledger) | VERIFIED | Confirmed by direct `e2eFlow.ts` read: 5 open entries, 0 resolved, hand-maintained comment present. |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `rust-toolchain.toml` | repo-root pin | VERIFIED | `channel = "1.98.0"`, both components present |
| `Makefile` `verify` target | all 7 gates wired | VERIFIED | `typecheck lint release-version-check icons-check lint-i18n check-select-chrome check-type-tokens test-ts test-rust fmt-check clippy build-frontend` |
| `eslint.config.js` | D-02 four-rule flat config | VERIFIED | exact 4 rules, `src/**` + `e2e/**` scoped to the right tsconfigs |
| `tsconfig.e2e.json` / `tsconfig.scripts.json` | referenced project configs | VERIFIED | both exist, both in `tsconfig.json`'s `references` |
| `playwright.config.ts` | `retain-on-failure`, no `retries` | VERIFIED | trace object present, no top-level `retries` key |
| `src/lib/e2eFlow.ts` | 5 open ledger entries | VERIFIED | direct grep confirms |

### Requirements Coverage

All 7 GATE-01..07 requirements: SATISFIED (see table above). REQUIREMENTS.md's own traceability
table already marks all seven `Complete`, consistent with this independent check.

## Findings Beyond the Checkboxes (adversarial review, per the verification brief)

### 1. Coverage blind spot for Phase 3: Rust↔TypeScript IPC wire-contract changes are invisible to all 7 gates

None of the 7 gates this phase adds would catch a mismatch between a `#[tauri::command]`
struct's `#[serde(rename_all = "camelCase")]` field names and what the paired TypeScript
`invoke()` call actually sends. Concretely, for `SkillDispatchBackgroundArgs` (introduced in this
phase's own `b36f3f8`):

- `cargo clippy` / `cargo fmt` - compile-time only, no serde/JSON validation.
- `cargo test --lib` - the existing tests construct the Rust struct directly
  (`skill_host/dispatch.rs`), bypassing JSON deserialization entirely; no test does
  `serde_json::from_value::<SkillDispatchBackgroundArgs>(json!({...}))`.
- `pnpm typecheck` - TypeScript's structural typing has no knowledge of Rust's serde rename
  rules; it cannot detect a field-name mismatch.
- `pnpm exec eslint` - irrelevant to wire shape.
- `make test-e2e` - all 23 specs run Chromium against a plain Vite dev server
  (`playwright.config.ts`'s `webServer.command` is `vite`, not `tauri-dev`), so
  `window.__TAURI_INTERNALS__` never exists and the real Rust backend never runs. I confirmed
  zero e2e references to `skills_dispatch_background`/`terminal_spawn` (or their TS wrapper
  names) at all - the two commands this phase's own diff reshaped are not exercised by e2e in
  any form, mocked or real.

This is a pre-existing, honestly-disclosed gap (`CONCERNS.md` "No native Tauri E2E runner":
*"A Rust command whose serialized shape drifts from its TypeScript wrapper... will pass
typecheck, unit tests, and e2e, and fail only in the built app"* - written before this phase, and
`src/lib/e2eFlow.ts`'s `native-tauri-e2e-runner-missing` ledger entry stays open on purpose per
GATE-07 and PROJECT.md's explicit v2/out-of-scope call). Phase 1 did not hide this; it also did
not close it, and it wasn't required to (REQUIREMENTS.md tracks the real fix as `TEST-01`,
v2-scoped).

**Why this matters now:** Phase 3 ("Typed IPC Error Contract") is exactly the phase that will add
more Rust structs at IPC boundaries with a mirrored TypeScript union, on the same trust
assumption this gap undermines. Phase 3's own `ERR-02` ("renaming a code on the Rust side fails
`make verify` on the TypeScript side, and vice versa") is a narrower, self-contained mechanism
(an exhaustiveness check between a generated/mirrored file, not general JSON round-trip testing)
and is not blocked by this gap - but Phase 3's planner should read this finding before assuming
`make verify` will catch every class of contract drift it introduces. A cheap, in-scope-sized
mitigation worth considering there: one `#[test]` per new IPC-boundary struct that round-trips a
representative JSON payload through `serde_json::from_value`, well short of the deferred v2
native E2E runner.

**Severity:** WARNING - not a Phase 1 blocker (out of this phase's own requirement set, honestly
disclosed pre-existing), but material enough to flag prominently for Phase 3 planning.

### 2. GATE-04's empirical proof is stale relative to what actually ships (see Human Verification above)

Detailed in the Observable Truths table (#3) and the frontmatter `human_verification` entry.
Summary: the trace config was narrowed (`a064994`, snapshots+screenshots off, network+stacks on)
*after* the only real CI proof of a working trace.zip, and the narrowing commit's own CI run had
no e2e failures to re-exercise that path. Playwright's `retain-on-failure` mode is documented to
always write `trace.zip` independent of the snapshot/screenshot sub-flags, so this is very likely
still fine - but "very likely fine" is not the same bar as the D-13 empirical-proof standard the
rest of this phase held itself to. Recommend one more CI probe (same recipe as 01-03's Task 3:
land a temporarily-failing assertion, dispatch CI, confirm `trace.zip` is present and non-trivial,
revert) against current HEAD before treating GATE-04 as fully closed.

Separately, on whether a network+stacks-only trace is "genuinely diagnosable": for the two
failure modes that motivated the narrowing (`select-audit.spec.ts`, `today.spec.ts:449`, both
wall-clock `.poll()` timeouts), a stack trace pointing at the timed-out assertion plus the network
log is plausibly sufficient. For a different, more common failure class this refactor-heavy
milestone will generate - a selector not finding an element, or a re-render dropping visible
content (exactly the #260/#262/#264 preview-mark regression Phase 4's SC3 names) - a DOM snapshot
is usually the single most useful diagnostic, and it is now off. This is a real trade-off the
phase made and documented candidly in the `playwright.config.ts` comment and commit message; it
is not concealed, but it is also not free, and Phases 4-5 (the phases most likely to produce
exactly this failure class) should know the safety net is thinner than "full trace" implies.

**Severity:** WARNING, human-verification item recorded above.

### 3. Pre-existing per-spec retry override undermines the "zero retries" framing, but was neither introduced nor misrepresented by this phase

`e2e/graph.spec.ts:18` has carried `test.describe.configure({ retries: process.env.CI ? 2 : 0 })`
since `6c186b2c` (2026-07-27), a month before this phase started. This phase's actual verification
claims are narrowly and accurately scoped to `playwright.config.ts`'s top-level setting (confirmed
by re-reading 01-03-SUMMARY's literal check: *"no `^\s*retries\s*:` line"* in that one file) - no
SUMMARY or REQUIREMENTS text asserts "zero retries anywhere in the suite." But CONTEXT.md's D-12
rationale frames "the no-retry property the suite earned at v0.4.58 (193/193 first-attempt)" as an
asset this phase protects, without noting that one spec already carves out its own exception, and
that nothing in any of the 7 new gates would catch (or has ever caught) a second file doing the
same. Not a phase defect - pre-existing, undisclosed only in the sense that no one connected the
two facts, not because either fact was hidden. Worth a one-line correction to the D-12 rationale
if CONTEXT.md is revisited, no code action needed.

**Severity:** INFO.

### 4. Eight pre-existing bare `eslint-disable-next-line` directives survive; one SUMMARY claim reads slightly broader than the actual state

`grep -rn "eslint-disable-next-line" src/` (all 44 occurrences, all rules) turns up exactly 8 bare
`react-hooks/exhaustive-deps` directives with no `-- reason`, all predating this phase (`git blame`
dates: 2026-07-09 through 2026-07-27, none of them touched by this phase's commits). Two of the
eight sit in files 01-07 otherwise modified (`GraphCanvas.tsx:1411`, `GraphView.tsx:246`) - in
both cases 01-07 added its own new, separately-reasoned disable comment elsewhere in the same file
for the violation it was actually fixing, and left the unrelated pre-existing bare one alone.

`ESLint` itself does not require a reason on a disable comment (no `eslint-comments/*` rule is
registered in the D-02 set), so `make lint`/`pnpm exec eslint src --max-warnings 0` genuinely
exits 0 either way - GATE-02 is not affected. But 01-07-SUMMARY.md's D1 coverage bullet states
*"every exhaustive-deps disable comment names the rule and carries a same-line reason"* as a claim
about all of `src/`, which is not literally true once these 8 survivors are counted. This reads as
the plan's own convention (every disable comment IT added or touched) stated more broadly than the
codebase actually supports - a documentation-precision issue, not a fabricated test result or a
functional gap.

**Severity:** INFO.

## Human Verification Required

1. ~~**Re-run the GATE-04 CI probe against the current (narrowed) trace config.**~~
   **RESOLVED 2026-08-22.** CI run 32569215249 landed a temporary failing assertion against
   the narrowed config and confirmed a downloadable `trace.zip` is still produced:
   123,399 bytes across 6 entries (action timeline, failing stack, source), versus
   1,752,382 bytes / 14 entries under the full config. Probe reverted byte-identical
   (`ed05764`). GATE-04 is proven under the configuration that actually ships.

   The probe also corrected a factual error this report inherited: `snapshots: false`
   disables Playwright's network capture as well as DOM snapshots, so `0-trace.network`
   is 0 bytes, not retained as the `a064994` commit message claimed. Fixed in `abf575d`,
   which also records the failure class this trade-off is weakest against.

## Gaps Summary

No roadmap success criterion and no GATE-01..07 requirement is FAILED. One item (GATE-04's
empirical proof under the current, narrowed trace config) is flagged for a quick human-run CI
probe rather than certified outright, because the only real evidence available was captured
against a since-changed configuration. Four additional findings are recorded above as WARNING/INFO; the most
consequential is the Rust↔TypeScript IPC wire-contract blind spot, which this phase did not
introduce or hide, but which Phase 3 should read before assuming `make verify` protects the
contract work it is about to do.

---
*Verified: 2026-08-22*
*Verifier: Claude (gsd-verifier)*
