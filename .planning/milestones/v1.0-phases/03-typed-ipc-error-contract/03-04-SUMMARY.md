---
phase: 03-typed-ipc-error-contract
plan: "04"
subsystem: ipc
tags: [rust, typescript, ipc, error-contract, verification, ci, review-caught]

requires:
  - phase: 03-typed-ipc-error-contract
    provides: "03-01's IpcError struct and the four contract-code constants; 03-02's nine migrated Rust commands/helpers and the post-migration count (1128); 03-03's five frontend branch sites and the deleted todayErrorCode"
provides:
  - "ERR-02 proven by four independent break-and-revert drills: a Rust constant VALUE rename fails ipc_error_codes_are_stable; a Rust constant NAME rename fails cargo build at every reference site including the web_actions.rs:860 branch; a TS union literal rename fails tsc -b; a Rust-only value+assertion rename (both Rust tests updated together, TS untouched) fails ONLY the new cross-language guard - typecheck and cargo test both stay green, which is the gap this guard closes"
  - "src/lib/types.test.ts: a vitest cross-language guard that reads src-tauri/src/ipc_error.rs via Vite's ?raw, extracts the four pub const string values, and asserts the set equals IPC_ERROR_CODES exactly - the assertion neither side's own pin test makes"
  - "ERR-04 re-confirmed at 1128, inside the [1118, 1138] tolerance band against 03-01's baseline B=1138"
  - "ERR-03 re-confirmed as a phase gate: zero residual message.includes() matchers on the four contract codes in src/, zero remaining todayErrorCode references in src/ or e2e/"
  - "Full make verify green end-to-end on the migrated contract, twice - once before the cross-language guard existed, once after"
affects: [phase-3-verification (this plan closes the phase's requirement set)]

actuals:
  tokens: 3300
  tasks: 2
  commits: 2

tech-stack:
  added: []
  patterns:
    - "The Rust and TS halves of ERR-02 are each protected by their own mechanism (Rust: an explicit pin test on the constant's VALUE, and the compiler on the constant's NAME at every use site; TS: the union member is the gate, caught by tsc -b's TS2367 no-overlap check) - but neither mechanism asserts the two sides agree WITH EACH OTHER. A rename applied consistently on one side only (constant value + its own pin-test assertion, both updated together, exactly as a real rename would be done) leaves both typecheck and cargo test green while the wire contract silently drifts. The fix, copied from src/lib/agentCapabilities.test.ts's existing precedent: a vitest that imports the Rust source via Vite's `?raw` loader, regex-extracts the pub const values, and diffs them against the TS union directly - this is the only gate that reads both sides in the same test."

key-files:
  created:
    - .planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md
    - src/lib/types.test.ts
  modified:
    - src/lib/types.ts

key-decisions:
  - "Extended the ERR-02 drill beyond the plan's literal two-site text (Rust VALUE rename + TS union rename) to a third sub-drill: a Rust constant NAME rename, at the team lead's carried-forward instruction. A value-only rename of TODAY_CONFLICT does not touch web_actions.rs:860 at all, since both the emit site and that branch site read the same symbol and stay in sync automatically - it proves the pin test is load-bearing but says nothing about the one Rust-side branch-on-a-contract-code in the tree. Only a NAME rename (which the compiler enforces at every reference, not a runtime check) demonstrates that site is build-protected."
  - "[Review-caught - ERR-02 gap] The three-drill set above proves each side pins ITSELF, not that the two sides agree with each other. Team-lead review reproduced the actual failure mode ERR-02 exists to prevent: rename the Rust constant's value AND its own pin-test assertion together (the shape of a real, deliberate rename), leave the TS union untouched. Both cargo test --lib ipc_error and pnpm typecheck stay green - a recovery path (isTodayConflict) is now silently comparing against a code the backend will never send again. Fixed by adding src/lib/types.test.ts, a vitest that reads ipc_error.rs's source text via ?raw and asserts its four pub const values equal IPC_ERROR_CODES, following the exact pattern already established by src/lib/agentCapabilities.test.ts for a different Rust/TS pairing. Re-ran the matched-rename drill against the fixed tree: cargo test and typecheck both still green (confirming the gap is real and not otherwise caught), the new guard test goes RED (AssertionError: today_conflict_v2 not in IPC_ERROR_CODES), reverted, guard green again. Also fixed the now-corrected but previously-false doc comment at src/lib/types.ts:64, which had claimed a TS-side rename fails on its own with no mention of the cross-language gap."

patterns-established: []

requirements-completed: [ERR-02]

coverage:
  - id: D1
    description: "Rust constant VALUE rename fails the Rust-side pin test (cargo test --lib ipc_error), naming ipc_error_codes_are_stable - proves the Rust side pins itself"
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
    description: "TS union literal rename fails tsc -b at the err.code comparison sites - proves the TS side pins itself"
    requirement: ERR-02
    verification:
      - kind: other
        ref: "pnpm typecheck (TS2367 at src/lib/today.ts:707, TS2820 at src/lib/today.test.ts:197,216, then reverted, pnpm typecheck exit 0)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Cross-language guard (src/lib/types.test.ts) closes the gap D1-D3 leave open: a Rust-only rename (value + its own pin-test assertion updated together, TS untouched) leaves cargo test and pnpm typecheck both green, but fails this new test - the only gate that reads both sides in one assertion"
    requirement: ERR-02
    verification:
      - kind: unit
        ref: "src/lib/types.test.ts (RED on the matched Rust-only rename: AssertionError expected today_conflict_v2 not present; reverted, test green; cargo test --lib ipc_error and pnpm typecheck confirmed green throughout, proving neither catches this case alone)"
        status: pass
    human_judgment: false
  - id: D5
    description: "ERR-04 signature count re-measured inside the [1118, 1138] tolerance band"
    requirement: ERR-04
    verification:
      - kind: other
        ref: "grep -roE 'Result<.*, String>' src-tauri/src --include='*.rs' | wc -l -> 1128"
        status: pass
    human_judgment: false
  - id: D6
    description: "ERR-03 residual-matcher and retired-parser greps both empty, re-run as a phase gate"
    requirement: ERR-03
    verification:
      - kind: other
        ref: "grep -rnE '.includes(\"(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)\"' src/ -> 0 matches; grep -rn todayErrorCode src/ e2e/ -> 0 matches"
        status: pass
    human_judgment: false
  - id: D7
    description: "Full make verify green end-to-end on the migrated contract, re-run after adding the cross-language guard"
    requirement: null
    verification:
      - kind: other
        ref: "make verify CARGO='cargo --offline' (12 sub-targets, exit 0, run twice - once before src/lib/types.test.ts existed, once after)"
        status: pass
    human_judgment: false

duration: ~55min
completed: 2026-08-23
status: complete
---

# Phase 3 Plan 04: Typed IPC Error Contract Proof Summary

**ERR-02 is proven by four break-and-revert drills, the last of which (a new cross-language vitest guard, src/lib/types.test.ts) closes a real gap a team-lead review caught: a Rust-only rename that updates the Rust side's own pin test leaves both `cargo test` and `pnpm typecheck` green while silently breaking a recovery path. ERR-04 re-confirms 1128, ERR-03's residual grep is empty, and `make verify` passes clean end-to-end both before and after the fix.**

## Performance

- **Duration:** ~55min
- **Tasks:** 2 completed
- **Files modified:** 2 (`src/lib/types.ts` comment fix, plus the new `src/lib/types.test.ts`)

## Accomplishments

- **ERR-02, Rust VALUE half.** Control (`cargo --offline test --lib ipc_error`) ran green (3 passed). Appending `_v2` to `TODAY_CONFLICT`'s literal value (keeping the identifier, leaving its own pin-test assertion untouched) went RED: `ipc_error_codes_are_stable` failed, and `ipc_error_wire_shape_round_trips` failed too, for the same reason. Reverted; green again.
- **ERR-02, Rust NAME half (added per carried-forward guidance).** A value-only rename does not exercise `web_actions.rs:860`, the one Rust-side branch on a contract code in the tree - both the emit site and that branch read the same symbol, so they stay in sync automatically on a value change. Renaming the constant's **identifier** instead (`TODAY_CONFLICT` -> `TODAY_CONFLICT_V2`, declaration only) made `cargo --offline build --lib` fail with `error[E0432]: unresolved import` at exactly two sites: `today_store.rs:13` and `web_actions.rs:26`. Reverted; `cargo test --lib ipc_error` green again.
- **ERR-02, TS half.** Control (`pnpm typecheck`) ran green. Appending `_v2` to the `"today_conflict"` entry inside `IPC_ERROR_CODES` (leaving every comparison site untouched) went RED: `TS2367` at `src/lib/today.ts:707`, plus two `TS2820` errors in `src/lib/today.test.ts` (lines 197, 216). Reverted; `pnpm typecheck` exit 0 again.
- **ERR-02, the gap a review caught.** The three drills above each prove one side pins itself; none proves the two sides are pinned to EACH OTHER. Team-lead review reproduced the real failure mode: change `TODAY_CONFLICT`'s value from `"today_conflict"` to `"today_conflict_v2"` **and** update `ipc_error_codes_are_stable`'s own assertion to match (the shape of a real, deliberate Rust-side rename, done properly, including the wire-shape round-trip test's hardcoded literal) - leave the TS union untouched. Result: `cargo test --lib ipc_error` fully green (3/3), `pnpm typecheck` exit 0, `pnpm vitest run src/lib/` 140 files / 1391 tests all pass. `isTodayConflict`'s comparison against `"today_conflict"` is now dead code - the backend will never send that string again - and nothing in the gate set noticed. This is exactly the failure ERR-02's requirement text names: "instead of silently breaking a recovery path."
- **The fix.** Added `src/lib/types.test.ts`, following the exact pattern already in the repo (`src/lib/agentCapabilities.test.ts`, which does the same thing for `AGENT_CAPABILITIES` against `provider.rs`): import `../../src-tauri/src/ipc_error.rs?raw` through Vite, regex-extract the four `pub const \w+: &str = "([^"]+)";` values, assert the sorted set equals `[...IPC_ERROR_CODES].sort()`. Re-ran the exact matched-rename drill against the fixed tree: `cargo test` and `typecheck` stayed green (confirming the gap is real, not a fluke), the new guard went RED (`AssertionError`, expected `today_conflict`, received `today_conflict_v2`), reverted, guard green again.
- Fixed the now-corrected doc comment at `src/lib/types.ts:64`, which previously claimed (falsely) that a TS-side rename alone fails `tsc -b` "matching Rust-side rename" - true only in the sense that the TS side catches TS-only renames; it said nothing about a Rust-only rename and implied a cross-check that did not exist until this plan.
- **ERR-04.** `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" | wc -l` returned **1128**, exactly matching 03-02's recorded post-migration count and `B - 10` (`B = 1138` from 03-01's baseline), inside `[1118, 1138]`.
- **ERR-03.** `grep -rnE '\.includes\("(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)"' src/` returned zero matches. `grep -rn "todayErrorCode" src/ e2e/` returned zero matches (D-08 retirement holds).
- **Full gate, twice.** `make verify` (with `CARGO="cargo --offline"`) ran all 12 sub-targets to completion with exit 0 on two separate runs: once before `src/lib/types.test.ts` existed (189 test-ts files / 1857 tests, `test-rust` 1217 passed / 0 failed / 3 ignored, no `outlook_mso` contention), and once after adding the guard (190 test-ts files / 1858 tests, `test-rust` again 1217 passed / 0 failed / 3 ignored). Both runs: `clippy -- -D warnings` clean, `fmt-check` clean, `build-frontend` bundle budget within limits (294.4 KiB JS / 61.2 KiB CSS gzip).

## Task Commits

This plan's drill work produces no shipped diff for the drills themselves - every rename edit was made, observed red, and reverted within the task. The one real shipped change is the cross-language guard added after the team-lead review caught the gap.

1. **Task 1/2 (review round): add the cross-language guard closing the ERR-02 gap** - see Final Commit section for hash (`src/lib/types.test.ts`, `src/lib/types.ts` comment fix)

**Plan metadata:** see Final Commit section (first round: `add9249`).

## Files Created/Modified

- `.planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md` - this file
- `src/lib/types.test.ts` - new: cross-language guard, reads `ipc_error.rs` via `?raw`, asserts its pub const values equal `IPC_ERROR_CODES`
- `src/lib/types.ts` - doc comment at the `IPC_ERROR_CODES` declaration corrected to describe both the TS-side pin and the new cross-language guard, instead of falsely implying a cross-check already existed
- `src-tauri/src/ipc_error.rs` - touched by four drill edits (VALUE rename, NAME rename, and the matched value+assertion rename run twice - once before the guard existed, once after), all reverted; `git diff --exit-code` confirmed clean after every drill

## Decisions Made

See `key-decisions` in the frontmatter for the full rationale on both the NAME-rename extension and the review-caught gap fix. Summary: the original three drills (value, name, TS union) each prove one side is pinned to itself; they do not prove the two sides are pinned to each other. A matched Rust-only rename (value + its own assertion, done the way a real developer would do it) passes both `cargo test` and `pnpm typecheck`, which is the actual gap ERR-02's requirement text is written against. `src/lib/types.test.ts` closes it, using the exact pattern `agentCapabilities.test.ts` already established elsewhere in this codebase for a comparable Rust/TS cross-check.

## Deviations from Plan

### Review-caught Issues

**1. [Review-caught - ERR-02 gap] The original three-drill set proved self-pinning, not cross-language agreement**
- **Found during:** Team-lead review of this plan's first commit (`add9249`)
- **Issue:** No test in the repo asserted the Rust `ipc_error.rs` constants and the TS `IPC_ERROR_CODES` union agree with each other. A rename performed correctly on the Rust side alone (constant value + its own `ipc_error_codes_are_stable` assertion, updated together, as a real rename would be done) left `cargo test --lib ipc_error` and `pnpm typecheck` both green, while `isTodayConflict`'s comparison against the old literal silently stopped matching anything the backend would ever send - the exact "silently breaking a recovery path" failure ERR-02 exists to prevent. The doc comment at `src/lib/types.ts:64` also overstated the existing protection, claiming a TS union rename "matching Rust-side rename fails tsc -b," which was true only for the TS-only direction.
- **Fix:** Added `src/lib/types.test.ts` (vitest, reads `ipc_error.rs` via Vite `?raw`, regex-extracts the four `pub const` values, asserts the set equals `IPC_ERROR_CODES`), following the existing `agentCapabilities.test.ts` pattern. Corrected the doc comment. Re-ran the matched-rename drill against the fixed tree to confirm the new guard - and only the new guard - catches this case.
- **Files modified:** `src/lib/types.test.ts` (new), `src/lib/types.ts`
- **Verification:** Matched-rename drill: `cargo test --lib ipc_error` green (3/3), `pnpm typecheck` exit 0, `pnpm vitest run src/lib/` 140/141 files pass with only the new guard failing (before the guard existed: 140 files / 1391 tests all pass, matching what the team lead independently observed) - the new guard test failed with `AssertionError: expected [...] today_conflict_v2 ...`. Reverted; `pnpm vitest run src/lib/types.test.ts` green. Full `make verify` re-run green afterward (190 test-ts files / 1858 tests, `test-rust` 1217/1217).
- **Committed in:** see Final Commit section (second round)

---

**Total deviations:** 1 review-caught (the ERR-02 cross-language gap above), plus the carried-forward NAME-rename extension already documented in the first round. No scope creep - the guard is the minimum test that closes the specific gap identified, copying an established in-repo pattern rather than inventing a new mechanism.

## Issues Encountered

None beyond the review-caught gap documented above. Both `make verify` runs (before and after the fix) completed clean with no `outlook_mso` timeout contention.

## A note on the three safety mechanisms (for future authors)

ERR-02 is protected by three distinct mechanisms, and conflating any two of them is a mistake this phase made twice (03-02's literal-vs-constant bug, and this plan's original three-drill gap):

- **Rust value pin:** `err.code` is a plain `String`, so `ipc_error_codes_are_stable` is an explicit unit test asserting each constant's literal value. It catches a value-only rename, nothing else.
- **Rust name/build:** the compiler enforces the constant's identifier at every reference site (`use crate::ipc_error::TODAY_CONFLICT`). It catches an identifier rename that isn't propagated everywhere - proving sites like `web_actions.rs:860` are build-protected as long as they compare against the constant, not a literal (03-02's fixed bug).
- **TS union pin:** `err.code` is typed as `IpcErrorCode`, so `err.code === "today_conflict"` fails `tsc -b` (TS2367) the moment the union member is renamed. It catches a TS-only rename.
- **Cross-language guard (new, `src/lib/types.test.ts`):** none of the three above compares the two sides against each other. This test reads the Rust source text directly and diffs its constant values against the TS union - the only mechanism that catches a rename done consistently on one side while the other side is untouched.

## ERR-02 unclassified-edge flag (carried from the plan's objective)

The plan's flagged assumption named an "unclassified - review manually" edge for ERR-02. That review happened - it is what surfaced the cross-language gap above, which is now closed. No further open edge is known; the four mechanisms in the note above cover every direction a rename can happen (Rust value alone, Rust name alone, TS alone, Rust value done "properly" with its own test updated). A phase verifier should still treat this as a judgment call, not a mechanically-closed checklist item.

## Requirement Completion Note

ERR-02 marked complete in REQUIREMENTS.md, and kept complete after this round: the new cross-language guard was verified to actually go red on the drill that exposed the gap (not just added and trusted). ERR-03 and ERR-04 were already marked complete by 03-02/03-03; this plan's D5/D6 re-confirm both hold on the current tree as a phase gate.

## Next Phase Readiness

All four ERR-01..04 requirements are complete, and ERR-02 now has a mechanism proven against the specific gap a review found, not just against the two drills the plan text originally described. `make verify` is green on the migrated contract, confirmed twice. Phase 3 has no further plans in its wave sequence; the phase is ready for its own verification/close-out step.

## Self-Check: PASSED

`.planning/phases/03-typed-ipc-error-contract/03-04-SUMMARY.md` and `src/lib/types.test.ts` confirmed present on disk. `src/lib/types.ts` confirmed to contain the corrected comment. `src-tauri/src/ipc_error.rs` confirmed byte-identical to its pre-drill state after every drill in this round (`git diff --exit-code` exit 0 each time). `git status --short` confirmed clean before the final commit.

---
*Phase: 03-typed-ipc-error-contract*
*Completed: 2026-08-23*
