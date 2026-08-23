---
phase: 03-typed-ipc-error-contract
verified: 2026-08-23T14:34:21Z
status: human_needed
score: 4/4 roadmap success criteria verified, 4/4 ERR requirements verified
behavior_unverified: 0
overrides_applied: 0
human_verification:
  - test: "Run the real app (pnpm tauri dev or make tauri-dev), open a document with an evidence binder, apply an accept/reject mutation, and separately force a today/task/document revision conflict from the real UI (not the Playwright mock layer)."
    expected: "The mutation succeeds through the actual WKWebView Tauri IPC bridge with no console serde/deserialize errors, and on the conflict path each of the four recovery branches (EvidenceBinderPane reload, isTodayConflict, isTaskConflict, TodayReview/reportInsert document_conflict) fires exactly as the mocked/unit-tested behavior predicts, with per-step observations recorded."
    why_human: "No CI gate exercises WKWebView (make test-e2e serves plain vite, not tauri-dev, so window.__TAURI_INTERNALS__ never exists). This is the pre-disclosed native-tauri-e2e-runner-missing blind spot carried from Phase 1's own verification into this phase's REQUIREMENTS.md note. 03-01's checkpoint for exactly this smoke was approved by the user, but no per-step observations were reported back (recorded candidly in 03-01-SUMMARY.md's own Human Verification section), so there is still no real evidence the migrated {code, message} wire shape round-trips through the actual native bridge for any of the 7 migrated commands, only through cargo test, vitest unit/component tests, and Playwright's mocked IPC layer."
---

# Phase 3: Typed IPC Error Contract Verification Report

**Phase Goal:** A frontend recovery path breaks at compile time when the error it depends on is renamed
**Verified:** 2026-08-23
**Status:** human_needed (all four roadmap success criteria and all four ERR requirements independently verified true in the codebase; one carried-forward gap - no real-app WKWebView evidence - flagged below rather than papered over)
**Re-verification:** No - initial verification

## Summary

Every claim below was re-derived against the current tree on `gsd/phase-3-typed-ipc-error-contract` (HEAD `c8791ff`), not read off SUMMARY.md text. In particular, the ERR-02 mechanism - the phase's central claim - was proven independently in this verification pass by performing my own rename drill rather than trusting 03-04's reported drill: I edited `TODAY_CONFLICT`'s value in `src-tauri/src/ipc_error.rs` together with both of that file's own hardcoded-literal tests (`ipc_error_codes_are_stable` and `ipc_error_wire_shape_round_trips`, the way a real developer would do a matched rename), and confirmed `cargo test --lib ipc_error` and `pnpm typecheck` both stayed green while `pnpm vitest run src/lib/types.test.ts` (the new cross-language guard) went red with the exact mismatch expected. The edit was reverted; `git diff --exit-code -- src-tauri/src/ipc_error.rs` confirmed byte-identical, and the full drill was re-run green after revert.

The one open item is not a phase-goal failure: it is the same real-app-evidence gap 03-01's own SUMMARY disclosed at the time (checkpoint approved without per-step smoke observations reported back), still open because no later plan closed it. It is carried forward here rather than silently dropped.

## Goal Achievement

### Observable Truths - Roadmap Success Criteria

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | A frontend caller can read a stable `code` and a human message from every error it branches on, without parsing the message | VERIFIED | Read all five branch sites directly (not from SUMMARY claims): `src/components/evidence/EvidenceBinderPane.tsx:175` (`err instanceof IpcError && err.code === "evidence_binder_revision_conflict"`), `src/lib/today.ts:707,713` (`isTodayConflict`/`isTaskConflict`), `src/components/today/TodayReview.tsx:177` (`document_conflict`), `src/lib/diagram/reportInsert.ts:94` (`isConflict`). All five use `err instanceof IpcError && err.code === "<literal>"`, zero message parsing. `IpcError.message` (`src/lib/ipcError.ts`) still carries the human text. |
| 2 | Renaming a code on the Rust side fails `make verify` on the TypeScript side, and vice versa | VERIFIED (independently reproduced, see Summary and ERR-02 Rename Drill below) | My own matched Rust-side rename left `cargo test --lib ipc_error` and `pnpm typecheck` green but failed `pnpm vitest run src/lib/types.test.ts` (part of `make verify`'s `test-ts` target) with the exact expected diff. 03-03's SUMMARY documents the mirrored TS-side check (renaming a union literal fails `tsc -b` with TS2367) - not independently re-run in this pass since it is a narrower, previously-established mechanism (the TS union member gates its own comparison sites directly), but the file evidence (`IPC_ERROR_CODES` in `src/lib/types.ts`, `err.code === "today_conflict"` as a literal comparison against the `IpcErrorCode` union type) supports it structurally. |
| 3 | No `message.includes("<error_code>")` matcher remains in `src/` for a code that moved to the contract | VERIFIED | `grep -rnE '\.includes\("(today_conflict\|task_conflict\|document_conflict\|evidence_binder_revision_conflict)"' src/` returns zero matches (re-run directly, not cited from SUMMARY). `grep -rn "todayErrorCode" src/ e2e/` also returns zero - the retired parser is fully gone. D-06's local non-IPC matchers (`src/lib/clipboard.ts:30`'s `"clipboard is empty"`, `src/components/diagram/ribbon/RibbonTable.tsx:84-86`'s span/rectangle strings) are confirmed untouched by this phase (`git log 44ea236..HEAD` shows zero commits touching either file) and correctly excluded from the contract. |
| 4 | The `Result<T, String>` count in `src-tauri/src/` is essentially unchanged from the measured baseline of 1,138 (CONCERNS.md's 1,118 is stale) - display-only errors were not touched | VERIFIED | `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l` = **1128**, re-run directly against the exact pinned command. This is `B - 10` where `B = 1138` is 03-01's pre-migration baseline (measured before any file was touched, recorded in 03-01-SUMMARY.md), matching the 10-signature migration set (7 commands + 3 shared helpers) exactly, well inside the `[1118, 1138]` tolerance band 03-04's plan specified. |

**Score:** 4/4 roadmap success criteria verified.

### ERR Requirements (REQUIREMENTS.md)

| Requirement | Status | Evidence |
|---|---|---|
| ERR-01 (typed code + human message readable by frontend callers) | VERIFIED | `src-tauri/src/ipc_error.rs` `IpcError { code, message }` with `Serialize`/`Deserialize`, `Display`, `std::error::Error`, `From<String>` - all read directly. `cargo --offline test --lib ipc_error` (3 passed: `ipc_error_codes_are_stable`, `ipc_error_wire_shape_round_trips`, `display_renders_contract_coded_and_legacy_forms`), re-run in this pass, not cited. All seven branch-on commands (`today_mutate`, `today_finalize_setup`, `today_calendar_publish`, `task_transition`, `task_trash`, `save_document`, `evidence_binder_mutate`) confirmed returning `Result<_, IpcError>` via direct grep and diff inspection of `today_store.rs`, `today_calendar.rs`, `today_lifecycle.rs`, `document.rs`, `evidence_binder.rs`. |
| ERR-02 (two-sided rename-fails-the-build) | VERIFIED, independently reproduced this pass | See Rename Drill section below. The mechanism is not merely read off SUMMARY.md; it was re-executed from scratch in this verification and produced the identical result 03-04 reported: a Rust-only value rename (matched against its own two hardcoded-literal tests) is invisible to `cargo test --lib ipc_error` and `pnpm typecheck`, and is caught only by the new cross-language guard `src/lib/types.test.ts`, which reads `ipc_error.rs` via Vite's `?raw` and diffs its `pub const` values against `IPC_ERROR_CODES`. This guard is itself a `.test.ts` file, so it runs under `make verify`'s `test-ts` target - the roadmap wording ("fails make verify on the TypeScript side") is satisfied by this mechanism, not by `tsc -b` alone. |
| ERR-03 (matcher migration; no contract expansion) | VERIFIED | Residual-matcher and retired-parser greps both empty (re-run, see truth #3 above). D-04's four-code scope confirmed as the only contract members in `IPC_ERROR_CODES` (`src/lib/types.ts`) and the only four `pub const` values in `ipc_error.rs`. D-05's prefix families (`unknown_source:`, `install_target_exists:`, `terminal_kill_failed:`) confirmed untouched by this phase's diff. |
| ERR-04 (display-only errors untouched) | VERIFIED | Count = 1128 (see truth #4). Legacy error text spot-checked byte-identical across `document.rs` ("Cannot read document: ...") and `today_store.rs` (`today_undo_unavailable`, `today_finalize_idempotency_key_required`, `today_finalize_idempotency_conflict`, `today_finalize_duplicate_capture`, `today_finalize_capture_missing`, `today_capture_id_required` - all read via direct `git diff`, confirmed carried through `.into()` on `From<String>` with zero rewording). |

### Required Artifacts

| Artifact | Expected | Status | Details |
|---|---|---|---|
| `src-tauri/src/ipc_error.rs` | `IpcError` struct, 4 constants, Display/Error/From impls, pin test, round-trip test | VERIFIED | All present, read directly; 3/3 tests pass |
| `src/lib/types.ts` | `IPC_ERROR_CODES`, `IpcErrorCode`, `IpcErrorBody` | VERIFIED | Present, confirmed via grep and the cross-language guard test reading it |
| `src/lib/ipcError.ts` | `IpcError` class, `isIpcErrorCode`, `normalizeIpcError` (idempotent) | VERIFIED | Read directly; idempotence guard is the function's first statement (`if (reason instanceof IpcError) return reason;`) |
| `src/lib/ipcError.test.ts` | Unit coverage for the normalizer | VERIFIED | Included in the 5-file, 58-test spot-check run below |
| `src/lib/types.test.ts` | Cross-language guard (the fix for the review-caught ERR-02 gap) | VERIFIED, and load-bearing (proven by my own drill) | New file, present, confirmed to fail on exactly the gap it exists to close |

### Key Link Verification

| From | To | Via | Status | Details |
|---|---|---|---|---|
| `evidence_binder_mutate` (Rust) | `EvidenceBinderPane.tsx` branch | `evidenceBinder.ts` funnel -> `normalizeIpcError` | VERIFIED | Funnel wraps whole body per D-07; branch reads `err.code` |
| `today_mutate`/`today_finalize_setup`/`today_calendar_publish` (Rust) | `isTodayConflict` | `todayInvoke` funnel -> `normalizeIpcError` | VERIFIED | `src/lib/today.ts:23` wraps whole body; `isTodayConflict` at :707 |
| `task_transition`/`task_trash` (Rust) | `isTaskConflict` | same `todayInvoke` funnel | VERIFIED | `isTaskConflict` at :713 |
| `save_document` (Rust) | `TodayReview.tsx` / `reportInsert.ts` | `api.ts` `saveDocument` funnel -> `normalizeIpcError` | VERIFIED | `src/lib/api.ts:1104`; both consumers confirmed reading `.code` |
| `ipc_error.rs` (Rust source) | `IPC_ERROR_CODES` (TS) | `src/lib/types.test.ts` via Vite `?raw` | VERIFIED, and proven load-bearing | Independently drilled in this pass; the only mechanism that compares both sides against each other |

### ERR-02 Rename Drill (independently reproduced in this verification)

1. **Control.** `cargo --offline test --lib ipc_error` green (3/3); `pnpm typecheck` exit 0; `pnpm vitest run src/lib/types.test.ts` green (1/1).
2. **Matched Rust-only rename.** Edited `src-tauri/src/ipc_error.rs`: changed `TODAY_CONFLICT`'s value from `"today_conflict"` to `"today_conflict_v2"`, and updated both of that file's own hardcoded-literal tests to match (`ipc_error_codes_are_stable`'s assertion, and `ipc_error_wire_shape_round_trips`'s expected JSON literal) - the way a real, careful developer would perform a same-side rename. Left `src/lib/types.ts` and every TS comparison site untouched.
3. **Result.** `cargo --offline test --lib ipc_error`: 3/3 green. `pnpm typecheck`: exit 0, no errors. `pnpm vitest run src/lib/types.test.ts`: **FAILED** - `AssertionError: expected [...] today_conflict_v2 ... to deeply equal [...] today_conflict ...`, naming the exact rename. This reproduces 03-04-SUMMARY's reported drill result byte-for-byte (including that a *partial* rename, touching only `ipc_error_codes_are_stable` and not the round-trip test's separate hardcoded literal, fails `cargo test` on its own for an unrelated reason - `ipc_error_wire_shape_round_trips` also hardcodes the literal - which I hit first and then corrected to match the plan's documented "matched" drill before drawing a conclusion).
4. **Revert.** Restored `ipc_error.rs` from a pre-edit copy; `git diff --exit-code -- src-tauri/src/ipc_error.rs` confirmed clean. Re-ran all three commands green.

This independently confirms the phase's central ERR-02 claim: the two-sided rename gate is not merely "each side pins itself" (a weaker property already true before 03-04's fix) but genuinely catches a same-side rename performed consistently, because a dedicated cross-language guard exists and is load-bearing.

### Requirements Coverage

All four ERR-01..04 requirements: SATISFIED (see table above). REQUIREMENTS.md's traceability table already marks all four Complete, consistent with this independent check.

### Anti-Patterns Found

- Zero new `#[allow(` suppression attributes in `git diff 44ea236..HEAD -- src-tauri/` (grep confirms no matches).
- Zero new `eslint-disable` directives in `git diff 44ea236..HEAD -- src/` (grep confirms no matches).
- No `TBD`/`FIXME`/`XXX`/`TODO`/`HACK`/`PLACEHOLDER` markers found in any of the phase's modified files.
- No stub patterns (`return null`/`return {}`/empty handlers) in the touched Rust or TypeScript files - every migrated function has a real, tested implementation.

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|---|---|---|---|
| Rust contract tests | `cargo --offline test --lib ipc_error` | 3 passed | PASS |
| Rust today domain | `cargo --offline test --lib today` | 96 passed | PASS |
| Rust document domain | `cargo --offline test --lib document::` | 20 passed | PASS |
| Rust evidence_binder | `cargo --offline test --lib evidence_binder::` | 13 passed | PASS |
| Rust web_actions (fallout fix site) | `cargo --offline test --lib web_actions::` | 29 passed | PASS |
| TS contract + funnel unit tests | `pnpm vitest run src/lib/ipcError.test.ts src/lib/today.test.ts src/lib/diagram/reportInsert.test.ts src/lib/evidenceBinder.test.ts src/components/today/TodayExecute.test.tsx` | 5 files, 58 tests passed | PASS |
| TS cross-language guard | `pnpm vitest run src/lib/types.test.ts` | 1 passed | PASS |
| Full typecheck | `pnpm typecheck` | exit 0 | PASS |
| ERR-04 pinned count | `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l` | 1128 | PASS |
| ERR-03 residual matcher grep | `grep -rnE '\.includes\("(today_conflict\|task_conflict\|document_conflict\|evidence_binder_revision_conflict)"' src/` | empty | PASS |
| ERR-02 rename drill | see dedicated section above | red on the guard, green everywhere else, reverted clean | PASS |

**Full `make verify` was not re-run in this pass** (it was run by the orchestrator immediately before this verification, on this exact commit, and is cited rather than duplicated per the assignment's instruction): exit 0, `test-rust` 1217 passed / 0 failed / 3 ignored, `test-ts` 190 files / 1858 tests, bundle budget within limits. The targeted spot-checks above independently re-confirm the phase-relevant subset of that result rather than taking it purely on faith.

### Human Verification Required

1. **Real-app (WKWebView) smoke of the migrated wire shape, with reported observations.**
   - **Test:** Run `pnpm tauri dev` or `make tauri-dev`. Exercise at least one accept/reject mutation and one forced revision conflict for each of: evidence binder, today mutation, task transition, document save.
   - **Expected:** Each mutation succeeds or fails through the real native IPC bridge with no console serde/deserialize errors, and each conflict path fires its typed recovery branch (reload / conflict notice) exactly as the mocked and unit-tested behavior predicts.
   - **Why human:** No CI gate exercises WKWebView; this is the pre-disclosed `native-tauri-e2e-runner-missing` blind spot (REQUIREMENTS.md's Phase 3 note, inherited from Phase 1's own verification finding #1). 03-01's checkpoint for this exact smoke was approved by the user, but 03-01-SUMMARY.md's own "Human Verification" section states plainly that no per-step observations were reported back. No later plan (03-02/03-03/03-04) re-attempted or closed this gap - all of their evidence is `cargo test`, `vitest`, `tsc`, and Playwright's mocked IPC layer, none of which exercises the real bridge. This is not a phase-goal failure (D-09's serde round-trip tests and the extensive unit/component test coverage above are strong indirect evidence the wire shape is correct), but it is the one place this phase's own evidence chain has a real, disclosed hole rather than a closed loop.

## Gaps Summary

No roadmap success criterion and no ERR-01..04 requirement is FAILED. All four are independently verified true in the codebase, with ERR-02 (the phase's central and hardest-to-fake claim) specifically re-proven by an independent drill in this verification pass rather than accepted from SUMMARY text. One item - real-app WKWebView evidence for the migrated wire shape - remains open exactly as 03-01-SUMMARY.md itself disclosed, and is carried forward here as a human-verification item rather than silently dropped or treated as closed by proxy (unit tests, serde round-trip tests, and Playwright's mocked layer are not the same evidence as the real native bridge). Recommend a short human smoke pass (the checklist above) before treating Phase 3 as fully closed, though nothing found in this verification blocks proceeding to Phase 4 on the merits of the typed-error-contract work itself.

---
*Verified: 2026-08-23*
*Verifier: Claude (gsd-verifier)*
