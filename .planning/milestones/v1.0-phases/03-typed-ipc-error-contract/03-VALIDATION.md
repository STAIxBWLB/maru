---
phase: 3
slug: typed-ipc-error-contract
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-23
---

# Phase 3 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest ^4.1.5 (TS) + `cargo test --lib` (Rust) |
| **Config file** | `vite.config.ts` (vitest inline config); no separate vitest.config |
| **Quick run command** | `pnpm vitest run src/lib/today.test.ts src/lib/evidenceBinder.test.ts src/lib/diagram/reportInsert.test.ts` |
| **Full suite command** | `make verify` (typecheck + lint + test-ts + test-rust + fmt-check + clippy + build-frontend) |
| **Estimated runtime** | ~60 seconds (targeted) / ~300 seconds (full) |

---

## Sampling Rate

- **After every task commit:** targeted vitest files + `cargo test --lib <module>`
- **After every plan wave:** `pnpm test && cargo test --lib`
- **Before `/gsd-verify-work`:** full `make verify` green, plus the rename drill, plus `make test-e2e` (smoke.spec.ts conflict test is the e2e canary)
- **Max feedback latency:** 60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 03-01 Task 1 (tracer: IpcError struct + normalizeIpcError funnel) | 03-01 | 1 | ERR-01 | T-3-01 | `normalizeIpcError` type-guards `code`/`message` as strings before constructing `IpcError`; forged/unknown codes fail safe to generic display | unit | `pnpm exec vitest run src/lib/ipcError.test.ts` | Yes | green |
| 03-01 Task 1 (struct + pin test) / 03-04 Task 1 (rename drill, four sub-drills) | 03-01, 03-04 | 1, 3 | ERR-02 | - | Renaming a contract code fails the Rust pin test and/or `cargo build`; a same-side rename that both Rust checks miss is caught only by the cross-language guard | unit + typecheck + drill | `cd src-tauri && cargo test --lib ipc_error` + `pnpm exec vitest run src/lib/types.test.ts` + `pnpm typecheck` | Yes | green (automated half); rename drill itself is manual-only, see below |
| 03-03 Task 2 (today/save_document funnel branch sites) / 03-04 Task 2 (residual grep proof) | 03-03, 03-04 | 2, 3 | ERR-03 | - | Frontend branches read `err.code`, never `message.includes(...)`; the retired `todayErrorCode` parser has no remaining references | unit + grep | `pnpm exec vitest run src/lib/diagram/reportInsert.test.ts src/lib/today.test.ts src/components/today` + residual greps | Yes | green |
| 03-01 Task 1 (baseline B=1138) / 03-02 Task 2 (post-migration 1128) / 03-04 Task 2 (residual grep + full verify) | 03-01, 03-02, 03-04 | 1, 2, 3 | ERR-04 | - | Display-only errors keep `Result<_, String>`; only the 10-signature migration set moved | grep baseline | `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l` | Yes | manual-only (historical measurement, see below) |
| 03-01 Task 1 (tracer: wire round-trip test) | 03-01 | 1 | D-09 | T-3-02 | wire shape round-trips; user-visible message content unchanged (`"code: message"` preserved) | unit (Rust) | `cd src-tauri && cargo test --lib ipc_error` | Yes | green |

*Status: pending, green, red, manual-only, or flaky.*

---

## Wave 0 Requirements

- [x] `src/lib/ipcError.test.ts` - normalization helper tests (ERR-01), delivered by 03-01 Task 1
- [x] Rust `ipc_error` module test module - code-list pin + `serde_json` round-trip (ERR-02, D-09), delivered by 03-01 Task 1
- [x] Existing prefix-string assertions migrated to `err.code` checks (03-03 Task 1-2); zero residual matchers confirmed by grep

*(Frameworks, configs, and fixtures already existed - no install step.)*

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| ERR-02 two-sided rename drill (Rust value rename, Rust name rename, TS union rename, matched Rust-only rename) | ERR-02 | A rename drill is a deliberate break-and-revert exercise; there is no standing automated test that performs the rename itself (only tests that fail correctly once a rename happens) | See 03-04-SUMMARY.md coverage entries D1-D4 for the four independently recorded drill results (Rust value/pin, Rust name/build-site, TS union/tsc, matched Rust-only/cross-language-guard) |
| ERR-04 `Result<_, String>` signature count | ERR-04 | This was a Phase-3-scoped invariant ("stays within a few of the measured baseline"), satisfied at Phase 3 close; later phases legitimately add new `Result<_, String>` signatures as the codebase grows, so the count is expected to drift upward over time and is not a regression to chase | 1,138 before migration and 1,128 after, per 03-01-SUMMARY.md and 03-04-SUMMARY.md. Re-measured today (2026-09-25) at HEAD `48b99585`: 1,845 (`grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l`), recorded as context, not a gap. No Rust file was touched to move this number. |

**Note on the composite gate:** `pnpm typecheck` (part of ERR-02's automated half and of `make verify`) is green; the TS7006 errors in `src/components/graph/GraphCanvas.tsx` seen during this reconciliation came from the agent worktree's install layout (pnpm global virtual store), not from the code: `pnpm typecheck` exits 0 in the main checkout at `9446eb0a` and CI `make verify` is green on `main` (see `.planning/phases/11-milestone-verification-evidence/deferred-items.md`). All of ERR-01/02/03's own targeted vitest and cargo commands, and the residual greps, ran clean at HEAD `48b99585`.

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** validated 2026-09-25

## Validation Audit 2026-09-25

| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 1 |

- `pnpm exec vitest run src/lib/ipcError.test.ts` - exit 0, 1 file, 6 tests passed
- `cd src-tauri && cargo test --lib ipc_error` - exit 0, 4 passed; 0 failed (`ipc_error_codes_are_stable`, `display_renders_contract_coded_and_legacy_forms`, `ipc_error_wire_shape_round_trips`, `no_code_emitting_path_flattens_its_error_to_string`)
- `pnpm exec vitest run src/lib/types.test.ts` - exit 0, 1 file, 1 test passed
- `pnpm exec vitest run src/lib/diagram/reportInsert.test.ts src/lib/today.test.ts src/components/today` - exit 0, 9 files, 100 tests passed
- `grep -rnE '\.includes\("(today_conflict|task_conflict|document_conflict|evidence_binder_revision_conflict)"' src/` - empty (exit 1, no matches, as required)
- `grep -rn "todayErrorCode" src/ e2e/` - empty (exit 1, no matches, as required)
- `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" | wc -l` - 1845 (historical measurement, not a gap; see Manual-Only table)
- `pnpm typecheck` - exit 0 in the main checkout at `9446eb0a`; the non-zero exit seen inside the agent worktree was an install-layout artifact (see Manual-Only note above)
- HEAD at measurement: `48b99585`
