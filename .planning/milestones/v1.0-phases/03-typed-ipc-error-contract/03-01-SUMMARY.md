---
phase: 03-typed-ipc-error-contract
plan: "01"
subsystem: ipc
tags: [rust, typescript, ipc, error-contract, tracer]

requires:
  - phase: 01-trustworthy-verify-signal
    provides: fmt-check/clippy/lint/typecheck gates live in `make verify`, the two-sided rename gate ERR-02 depends on them
provides:
  - "src-tauri/src/ipc_error.rs: IpcError { code, message } with Display, std::error::Error, From<String>, and the four contract-code constants"
  - "src/lib/types.ts: IPC_ERROR_CODES tuple, IpcErrorCode union, IpcErrorBody wire interface (the TypeScript half of the ERR-02 rename gate)"
  - "src/lib/ipcError.ts: isIpcErrorCode narrowing, IpcError class, normalizeIpcError funnel entry"
  - "evidence_binder_mutate migrated end-to-end as the tracer, from the Rust emit site through the evidenceBinder.ts funnel to the EvidenceBinderPane branch"
  - "ERR-04 pre-migration baseline B = 1138, measured before any edit (03-02 and 03-04 assert against it)"
affects: [03-typed-ipc-error-contract (plans 03-02 Rust domains, 03-03 frontend branch sites, 03-04 gates)]

actuals:
  tasks: 2
  commits: 1

tech-stack:
  added: []
  patterns:
    - "Typed IPC error: Rust IpcError { code, message } serialized as a flat JSON object; TS mirrors the code set as a const tuple so a rename fails both sides"
    - "From<String> carries every legacy error path into message with an empty code, and Display renders an empty-code error as its message alone, so display-only text stays byte-identical"
    - "normalizeIpcError degrades an unrecognized code to a plain Error rather than a typed one, so the contract cannot silently widen"

key-files:
  created:
    - src-tauri/src/ipc_error.rs
    - src/lib/ipcError.ts
    - src/lib/ipcError.test.ts
  modified:
    - src-tauri/src/lib.rs
    - src-tauri/src/evidence_binder.rs
    - src/lib/types.ts
    - src/lib/evidenceBinder.ts
    - src/components/evidence/EvidenceBinderPane.tsx

key-decisions:
  - "7-command branch-on scope ratified at the checkpoint, superseding CONTEXT's specifics wording of 'four commands': same four codes, seven commands (today_mutate, today_finalize_setup, today_calendar_publish, task_transition, task_trash, save_document, evidence_binder_mutate). graph_link_apply stays display-only and OUT, per D-04's own criterion"
  - "The three not-yet-consumed code constants stay in ipc_error.rs and no suppression attribute was added. The phase prohibition on new suppression attributes holds, so `cargo clippy -- -D warnings` is transiently red on this commit until 03-02 lands their consumers"
  - "Baseline B recorded as a measurement, not the planning-time constant. It happened to match 1138, but 03-02 and 03-04 must read it from here rather than from the plan text"

patterns-established:
  - "One tracer command proves the whole contract path before the remaining six migrate: the shape 03-02 and 03-03 copy is fixed here, not negotiated per-domain"
  - "The ERR-04 baseline is captured before the first signature flips, because the tracer itself changes the count"

requirements-completed: []

coverage:
  - id: D1
    description: "IpcError carries a stable machine-readable code alongside the human message, and serializes as the exact { code, message } wire object"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "src-tauri/src/ipc_error.rs#ipc_error::tests::ipc_error_wire_shape_round_trips"
        status: pass
    human_judgment: false
  - id: D2
    description: "Display renders a contract-coded error as code + ': ' + message, and an empty-code (legacy From<String>) error as its message alone, leaving display-only text unchanged"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "src-tauri/src/ipc_error.rs#ipc_error::tests::display_renders_contract_coded_and_legacy_forms"
        status: pass
    human_judgment: false
  - id: D3
    description: "Renaming a code fails the build on the Rust side; all four constants are pinned to their literals"
    requirement: ERR-02
    verification:
      - kind: unit
        ref: "src-tauri/src/ipc_error.rs#ipc_error::tests::ipc_error_codes_are_stable"
        status: pass
    human_judgment: false
  - id: D4
    description: "normalizeIpcError wraps a contract-coded body, degrades an unknown code to a plain Error, drops the empty-code prefix, is idempotent, and passes null/strings/plain Errors/shapeless objects through unchanged"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "src/lib/ipcError.test.ts (6 cases across isIpcErrorCode and normalizeIpcError)"
        status: pass
    human_judgment: false
  - id: D5
    description: "evidence_binder_mutate returns Result<_, IpcError> and constructs EVIDENCE_BINDER_REVISION_CONFLICT at its conflict site, reaching the EvidenceBinderPane branch through the evidenceBinder.ts funnel"
    requirement: ERR-01
    verification:
      - kind: unit
        ref: "src-tauri/src/evidence_binder.rs (13 tests, incl. the revision-conflict assertion on error.code)"
        status: pass
    human_judgment: false
  - id: D6
    description: "Real-app smoke of the new wire shape on the native build"
    requirement: ERR-01
    verification:
      - kind: manual
        ref: "human-verify checkpoint, task 2"
        status: approved-without-reported-observations
    human_judgment: true
---

# Phase 3 Plan 01: Typed IPC Error Contract Tracer Summary

**The `{ code, message }` contract exists on both sides and is proven end-to-end on one command, `evidence_binder_mutate`, with the ERR-04 pre-migration baseline captured at 1138 before the first signature flipped.**

## Performance

- Tasks: 2 (task 1 implementation, task 2 the blocking human-verify checkpoint)
- Commits: 1 (`fa8a3fb`, 8 files, +279/-15)

## Accomplishments

- `src-tauri/src/ipc_error.rs` holds the four contract-code constants, the `IpcError { code, message }` struct, and its `Display` / `std::error::Error` / `From<String>` impls. `From<String>` puts the whole legacy string into `message` with an empty `code`, and `Display` renders an empty-code error as its message alone, so every non-contract error path inside a migrated command keeps byte-identical user-visible text.
- `src/lib/types.ts` mirrors the code set as `IPC_ERROR_CODES` with the derived `IpcErrorCode` union and the `IpcErrorBody` wire interface. This is the TypeScript half of the ERR-02 rename gate: the Rust constants are pinned by a test, the TS union is pinned by the compiler.
- `src/lib/ipcError.ts` provides `isIpcErrorCode`, the `IpcError` class, and `normalizeIpcError`, the single funnel entry that turns a rejection into either a typed error or an untouched value.
- `evidence_binder_mutate` is migrated as the tracer: the Rust emit site constructs `IpcError` with `EVIDENCE_BINDER_REVISION_CONFLICT`, the `evidenceBinder.ts` funnel normalizes it, and `EvidenceBinderPane.tsx` branches on `err.code` instead of matching the message substring.

## ERR-04 baseline

Measured before any edit, with the pinned command:

```
$ grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" | wc -l
1138
```

**B = 1138.** This matches the planning-time figure, so no drift occurred between planning and execution. 19 of those matches live in `src-tauri/src/hwped.rs`; the hwp-editor track is still active, so 03-04 must re-read B from this file rather than assume the constant still holds. 03-02 records its post-migration count against `B - 10`; 03-04 asserts within `[B-20, B]`.

## Task Commits

| Task | Name | Commit |
|------|------|--------|
| 1 | Tracer: typed error contract end-to-end on evidence_binder_revision_conflict | `fa8a3fb` |
| 2 | Real-app smoke of the new wire shape + confirm the 7-command scope | checkpoint, no code |

## Files Created/Modified

Created: `src-tauri/src/ipc_error.rs`, `src/lib/ipcError.ts`, `src/lib/ipcError.test.ts`

Modified: `src-tauri/src/lib.rs`, `src-tauri/src/evidence_binder.rs`, `src/lib/types.ts`, `src/lib/evidenceBinder.ts`, `src/components/evidence/EvidenceBinderPane.tsx`

## Verification Evidence

Every command below was re-run by the orchestrator against the committed tree, not relayed from the executor:

| Gate | Result |
|------|--------|
| `cargo --offline test --lib ipc_error` | 3 passed |
| `cargo --offline test --lib evidence_binder` | 13 passed |
| `pnpm vitest run src/lib/ipcError.test.ts src/lib/evidenceBinder.test.ts` | 9 passed, 2 files |
| `pnpm typecheck` | exit 0 |
| `cargo --offline clippy -- -D warnings` | **RED**, see Issues Encountered |

## Decisions Made

- **7-command scope ratified.** CONTEXT's specifics section says "four commands"; the measured branch-on set is seven. Same four codes, more commands. D-04's own criterion is what the frontend actually branches on, so the measurement wins. `graph_link_apply` stays display-only and out of the contract, since migrating it would violate ERR-04.
- **The transient clippy red is accepted rather than suppressed.** `TODAY_CONFLICT`, `TASK_CONFLICT` and `DOCUMENT_CONFLICT` are defined here per the plan's artifact spec but have no consumer until 03-02 migrates the other six commands, so `cargo clippy -- -D warnings` fails on three `never used` errors at this commit. Adding `#[allow(dead_code)]` would violate this plan's own prohibition on new suppression attributes, and moving the constants into 03-02 would split the artifact the plan specifies here. The user was offered both options and chose to proceed as-is.

## Deviations from Plan

- **The executor session ended at the checkpoint.** Task 1 and the checkpoint were executed by the `gsd-executor` subagent; the subagent went idle and was no longer reachable when the checkpoint cleared. The orchestrator completed the remaining bookkeeping, meaning this SUMMARY plus STATE.md and ROADMAP.md, after independently re-running every verify command above. No production code was written by the orchestrator.
- **The dev app used for the checkpoint was relaunched.** The subagent's background `pnpm tauri dev` process died before the user reached it. The orchestrator relaunched it with `make tauri-dev` (clean build, 1m11s) and stopped it afterwards, because a live `tauri dev` holds the cargo `target/` build lock and would stall wave 2's executors.

## Issues Encountered

- **`cargo clippy -- -D warnings` is red on this commit and expected to stay red until 03-02.** This is recorded here rather than left for a bisect to discover. It is not a gate bypass: no suppression was added and no gate was removed. 03-02's executor must confirm it clears on their commit; if it does not, the three constants have no consumer and the 7-command scope was not fully migrated.
- **Three pre-existing compiler warnings** (`LAST_FIRED`, `schedule_is_paused_by_agent`, `run_due_for_workspace`) appear in the native build. They are present on `main` at `44ea236` and are unrelated to this plan.

## Human Verification

The checkpoint gate was **approved by the user**. No per-step smoke observations were reported back. The user was asked to confirm that a binder mutation succeeded, that no error toast appeared, that the console was clean, and optionally that the conflict-path recovery fired, and approved the gate without returning those specific results.

Recording this precisely matters: the automated evidence above covers the wire shape, the code stability, the normalizer semantics and the Rust conflict site, but **nothing here is evidence that the migrated path was observed working in the real WKWebView app**. No CI gate exercises WKWebView (STATE.md blockers), so that gap stays open until 03-04's full-gate run or a later real-app run closes it.

## Next Phase Readiness

03-02 and 03-03 are unblocked and may proceed in wave 2. Both must copy the shape fixed here rather than re-deriving it. 03-02 additionally owns clearing the transient clippy red and recording its post-migration count against `B = 1138`.
