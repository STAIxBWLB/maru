---
phase: 03-typed-ipc-error-contract
plan: "04"
subsystem: ipc
tags: [rust, typescript, ipc, error-contract, verification, ci]

requires:
  - phase: 03-typed-ipc-error-contract
    provides: "03-01's IpcError struct and the four contract-code constants; 03-02's nine migrated Rust commands/helpers and the post-migration count (1128); 03-03's five frontend branch sites and the deleted todayErrorCode"
provides:
  - "ERR-02 proven by demonstration: a Rust constant VALUE rename fails ipc_error_codes_are_stable (and, incidentally, ipc_error_wire_shape_round_trips); a Rust constant NAME rename fails cargo build at every reference site including the web_actions.rs:860 branch; a TS union literal rename fails tsc -b at today.ts:707 (TS2367) and today.test.ts (TS2820) - all three edits reverted, tree clean"
  - "ERR-04 re-confirmed at 1128, inside the [1118, 1138] tolerance band against 03-01's baseline B=1138"
  - "ERR-03 re-confirmed as a phase gate: zero residual message.includes() matchers on the four contract codes in src/, zero remaining todayErrorCode references in src/ or e2e/"
  - "Full make verify green end-to-end on the migrated contract (12 gates, no contention this run)"
affects: [phase-3-verification (this plan closes the phase's requirement set)]

actuals:
  tokens: 2800
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "The Rust and TS halves of ERR-02 are protected by different mechanisms and need different drills: a Rust constant's VALUE is pinned by an explicit unit test (ipc_error_codes_are_stable), so only a value rename exercises it; a Rust constant's NAME is pinned by the compiler at every use site (cargo build fails with E0432 unresolved import), which is the only way to observe that a non-literal branch site like web_actions.rs:860 is actually protected. The TS union has no separate constant - the literal comparison itself is the gate, caught by tsc -b's TS2367 no-overlap check the moment the union member is renamed."

key-files:
  created:
    - .planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md
  modified: []

key-decisions:
  - "Extended the ERR-02 drill beyond the plan's literal two-site text (Rust VALUE rename + TS union rename) to a third sub-drill: a Rust constant NAME rename, at the team lead's carried-forward instruction. A value-only rename of TODAY_CONFLICT does not touch web_actions.rs:860 at all, since both the emit site and that branch site read the same symbol and stay in sync automatically - it proves the pin test is load-bearing but says nothing about the one Rust-side branch-on-a-contract-code in the tree. Only a NAME rename (which the compiler enforces at every reference, not a runtime check) demonstrates that site is build-protected. This is additional evidence gathering, not a plan or scope change: no code shipped, both edits reverted, tree verified clean before and after."

patterns-established: []

requirements-completed: [ERR-02]

coverage:
  - id: D1
    description: "Rust constant VALUE rename fails the build-adjacent gate (cargo test --lib ipc_error), naming ipc_error_codes_are_stable"
    requirement: ERR-02
    verification:
      - kind: unit
        ref: "src-tauri/src/ipc_error.rs#ipc_error::tests::ipc_error_codes_are_stable (RED then reverted to pass)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Rust constant NAME rename fails cargo build --lib at every reference site, including web_actions.rs:860, the one Rust-side branch on a contract code in the tree"
    requirement: ERR-02
    verification:
      - kind: other
        ref: "cargo --offline build --lib (E0432 unresolved import at today_store.rs:13 and web_actions.rs:26, then reverted, cargo test --lib ipc_error green)"
        status: pass
    human_judgment: false
  - id: D3
    description: "TS union literal rename fails tsc -b at the err.code comparison sites"
    requirement: ERR-02
    verification:
      - kind: other
        ref: "pnpm typecheck (TS2367 at src/lib/today.ts:707, TS2820 at src/lib/today.test.ts:197,216, then reverted, pnpm typecheck exit 0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "ERR-04 signature count re-measured inside the [1118, 1138] tolerance band"
    requirement: ERR-04
    verification:
      - kind: other
        ref: "grep -roE 'Result<.*, String>' src-tauri/src --include='*.rs' | wc -l -> 1128"
        status: pass
    human_judgment: false
  - id: D5
    description: "ERR-03 residual-matcher and retired-parser greps both empty, re-run as a phase gate"
    requirement: ERR-03
    verification:
      - kind: other
        ref: "grep -rnE '.includes(\"(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)\"' src/ -> 0 matches; grep -rn todayErrorCode src/ e2e/ -> 0 matches"
        status: pass
    human_judgment: false
  - id: D6
    description: "Full make verify green end-to-end on the migrated contract"
    requirement: null
    verification:
      - kind: other
        ref: "make verify CARGO='cargo --offline' (12 sub-targets, exit 0)"
        status: pass
    human_judgment: false

duration: ~35min
completed: 2026-08-23
status: complete
---

# Phase 3 Plan 04: Typed IPC Error Contract Proof Summary

**ERR-02 is proven by three independent break-and-revert drills (Rust value pin, Rust name/build, TS union/tsc), ERR-04 re-confirms 1128 inside the tolerance band, ERR-03's residual grep is empty, and a full `make verify` passes clean end-to-end with no contention this run.**

## Performance

- **Duration:** ~35min
- **Tasks:** 2 completed
- **Files modified:** 0 (proof plan; drill edits made and reverted, no shipped diff besides this SUMMARY and the bookkeeping docs commit)

## Accomplishments

- **ERR-02, Rust VALUE half.** Control (`cargo --offline test --lib ipc_error`) ran green (3 passed). Appending `_v2` to `TODAY_CONFLICT`'s literal value (keeping the identifier) went RED: `ipc_error_codes_are_stable` failed (`assertion left == right failed, left: "today_conflict_v2", right: "today_conflict"`), and `ipc_error_wire_shape_round_trips` failed too, for the same reason. Reverted; green again.
- **ERR-02, Rust NAME half (added per carried-forward guidance).** A value-only rename does not exercise `web_actions.rs:860`, the one Rust-side branch on a contract code in the tree - both the emit site and that branch read the same symbol, so they stay in sync automatically on a value change. Renaming the constant's **identifier** instead (`TODAY_CONFLICT` -> `TODAY_CONFLICT_V2`, declaration only) made `cargo --offline build --lib` fail with `error[E0432]: unresolved import` at exactly two sites: `today_store.rs:13` and `web_actions.rs:26` (`use crate::ipc_error::TODAY_CONFLICT;`). This is the evidence that the branch site is build-protected, not just runtime-correct. Reverted; `cargo test --lib ipc_error` green again.
- **ERR-02, TS half.** Control (`pnpm typecheck`) ran green. Appending `_v2` to the `"today_conflict"` entry inside `IPC_ERROR_CODES` (leaving every comparison site untouched) went RED: `src/lib/today.ts(707,37): error TS2367: This comparison appears to be unintentional because the types '...' and '"today_conflict"' have no overlap`, plus two `TS2820` errors in `src/lib/today.test.ts` (lines 197, 216) suggesting the new literal. Reverted; `pnpm typecheck` exit 0 again.
- **ERR-04.** `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" | wc -l` returned **1128**, exactly matching 03-02's recorded post-migration count and `B - 10` (`B = 1138` from 03-01's baseline), inside `[1118, 1138]`.
- **ERR-03.** `grep -rnE '\.includes\("(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)"' src/` returned zero matches. `grep -rn "todayErrorCode" src/ e2e/` returned zero matches (D-08 retirement holds).
- **Full gate.** `make verify` (with `CARGO="cargo --offline"`) ran all 12 sub-targets to completion with exit 0: `typecheck`, `lint`, `release-version-check`, `icons-check`, `lint-i18n`, `check-select-chrome`, `check-type-tokens`, `test-ts` (189 files / 1857 tests, all pass), `test-rust` (1220 tests total, 1217 passed / 0 failed / 3 ignored), `fmt-check`, `clippy` (`-D warnings`, clean), `build-frontend` (bundle budget: 294.4 KiB JS / 61.2 KiB CSS gzip, both under limit). No `outlook_mso` timeout contention this run - the two other sessions' concurrent `cargo test --workspace` did not collide with this run's `--lib` scope this time.

## Task Commits

This plan produces no code diff - every drill edit was made and reverted within the task, per the plan's own instruction ("commit nothing from the broken intermediate states"). The only commit is the bookkeeping commit below.

**Plan metadata:** see Final Commit section.

## Files Created/Modified

- `.planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md` - this file
- `src-tauri/src/ipc_error.rs`, `src/lib/types.ts` - touched by three drill edits each, all reverted; `git diff --exit-code` confirmed clean after every drill and at final check

## Decisions Made

- **Ran a third ERR-02 sub-drill (Rust constant NAME rename) beyond the plan's literal two-site text**, per the team lead's carried-forward instruction. Rationale: a VALUE-only rename (what the plan's action text describes) proves the pin test `ipc_error_codes_are_stable` is load-bearing, but does not touch `web_actions.rs:860` at all - that branch site reads the same symbol as the emit site, so a value change keeps both in sync with no build break. Since 03-02's SUMMARY (deviation 5) specifically flags that site as "the ONLY Rust-side branch on a contract code in the tree," and the team lead's spot-check confirmed it, skipping a drill that exercises it would leave ERR-02's proof half-done for the one site the requirement is actually about. The NAME rename (`cargo build --lib` failing with `E0432` at every reference site, including `web_actions.rs:26`) is the drill that demonstrates this. No code was shipped; this is additional verification depth, not a plan change.

## Deviations from Plan

None requiring a rule. The one addition above (third ERR-02 sub-drill) was carried-forward guidance from the team lead attached to this plan's spawn, not a self-directed scope change, and produced no shipped artifact.

## Issues Encountered

None. `make verify` ran clean on the first attempt with no `outlook_mso` timeout contention, unlike 03-02's run (two other sessions were still running `cargo test --workspace` concurrently on this machine per the team lead's notes, but this run's `cargo --offline test --lib` did not collide).

## A note on the two safety mechanisms (for future authors)

The Rust and TypeScript halves of ERR-02 are protected differently, and conflating them is exactly the mistake 03-02 made and fixed (see its SUMMARY, deviation 5):

- **TypeScript:** `err.code` is typed as the `IpcErrorCode` union. A raw literal comparison (`err.code === "today_conflict"`) IS safe, because `tsc -b` reports `TS2367` on a comparison with no overlap the moment the union member is renamed. No separate exported constant is needed on the TS side.
- **Rust:** `err.code` is a plain `String`. A raw literal comparison (`err.code == "today_conflict"`) compiles against anything and is NOT rename-safe - a renamed constant would silently desync from a hardcoded literal with no build error. This is why the Rust branch site (`web_actions.rs:860`) must compare against the `TODAY_CONFLICT` constant, not a literal. 03-02 shipped the literal-comparison bug and caught it in review; this plan's NAME-rename drill is the mechanism that proves the fixed version is actually protected.

## ERR-02 unclassified-edge flag (carried from the plan's objective)

The plan's flagged assumption: the probe's `unclassified` row for ERR-02 ("unclassified - review manually") is treated as covered by the rename drill + dual pin tests (now three sub-drills: Rust value, Rust name, TS union), but a human should confirm at phase verification that no additional ERR-02 edge exists beyond rename-on-either-side. This flag is carried forward unresolved - it is a judgment call for the phase verifier, not something this plan's automated drills can close.

## Requirement Completion Note

ERR-02 marked complete in REQUIREMENTS.md on the strength of the three drills above (D1-D3 in coverage). ERR-03 and ERR-04 were already marked complete by 03-02/03-03; this plan's D4/D5 re-confirm both hold on the current tree as a phase gate, not a first-time completion.

## Next Phase Readiness

All four ERR-01..04 requirements are now complete. `make verify` is green on the migrated contract. Phase 3 has no further plans in its wave sequence; the phase is ready for its own verification/close-out step.

## Self-Check: PASSED

`.planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md` confirmed present on disk. `src-tauri/src/ipc_error.rs` and `src/lib/types.ts` confirmed byte-identical to their pre-drill state (`git diff --exit-code` both exit 0). `git status --short` confirmed no stray changes before the final bookkeeping commit.

---
*Phase: 03-typed-ipc-error-contract*
*Completed: 2026-08-23*
