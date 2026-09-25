---
phase: 2
slug: shared-scanner-and-path-invariants
# status lifecycle: draft (seeded by plan-phase) -> validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
created: 2026-08-23
---

# Phase 2 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | cargo test (Rust 2021, `#[cfg(test)]` modules) |
| **Config file** | `src-tauri/Cargo.toml` (existing) |
| **Quick run command** | `cargo test --lib paths` / `cargo test --lib <module>` (scoped) |
| **Full suite command** | `make verify` (typecheck, lint, clippy, fmt-check, cargo test --lib, e2e) |
| **Estimated runtime** | ~30 seconds (scoped cargo test); ~9-10 min (full gate, CI-measured) |

---

## Sampling Rate

- **After every task commit:** Run `cargo test --lib` scoped to the touched module (`paths`, `workspace_files`, `vault`, `secrets`, `project_activity`, `evidence_binder`, `content_search`, `skill_host::fs`)
- **After every plan wave:** Run `cargo test --lib` (full lib suite)
- **Before `/gsd-verify-work`:** Full `make verify` must be green (per-gate individual verification acceptable on the shared dirty checkout, per Phase 1 precedent; CI is the authoritative composite)
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 02-01 Task 1 (tracer: `paths.rs` module - GENERATED_DIRS union, `ensure_within`, `require_absolute`, full unit tests) | 02-01 | 1 | SCAN-01, SCAN-03 | T-02-01, T-02-02 | Union edit is one-line in `paths.rs`; `ensure_within` rejects escapes lexically; module registered and consumed by workspace_files/content_search | unit | `cd src-tauri && cargo test --lib -- paths:: workspace_files:: content_search::` | Yes | green |
| 02-01 Task 2 (`rg_visibility` reconciliation - generated dirs un-allowlistable) | 02-01 | 1 | SCAN-02 | T-02-02 | Allowlisting a nested `.git` no longer resurrects it into content search (`exclude_git: true` unconditionally) | unit (red->green expectation flip on `rg_hidden_and_git_traversal_follow_dot_folder_allowlist`) | `cd src-tauri && cargo test --lib content_search::` | Yes | green |
| 02-02 Task 1 (SCAN-02 union-proof test, red first) + Tasks 2-3 (rewire vault/secrets/project_activity/evidence_binder) | 02-02 | 2 | SCAN-01, SCAN-02 | T-02-04, T-02-05, T-02-06 | Vault scans exclude `__pycache__`/`.git`/`.venv` contents; all five scanners honor the union; `.maru` stays out of evidence discovery | unit (fixture tree, red->green) | `cd src-tauri && cargo test --lib -- vault:: secrets:: project_activity:: evidence_binder:: inbox::` | Yes | green |
| 02-01 Task 3 (`ensure_within` promotion - maru_dir.rs drops private copy) | 02-01 | 1 | SCAN-03 | T-02-01 | `ensure_within` importable from `paths.rs`; byte-identical error message; studio/diagram sibling copies untouched | unit | `cd src-tauri && cargo test --lib maru_dir::` | Yes | green |
| 02-03 Task 1 (`require_absolute` guard in `maru_home()`/`install_root_base()` + regression test `maru_home_rejects_relative_test_home`) | 02-03 | 2 | SCAN-04 | T-02-07, T-02-08 | Non-absolute home base errors via `Err` on every return path instead of materializing a tree | unit (MARU_TEST_HOME fixture, red->green) | `cd src-tauri && cargo test --lib skill_host::fs` | Yes | green |
| 02-03 Task 2 (delete stray `Users/` tree, same plan as the guard per D-10) | 02-03 | 2 | SCAN-05 | T-02-07 | Stray `Users/` tree deleted, no recurrence | filesystem assertion | `test ! -e Users` + guard test above | Yes | green |

*Status: pending, green, red, manual-only, or flaky.*

---

## Wave 0 Requirements

- [x] `src-tauri/src/paths.rs` test module - full unit tests (ensure_within descendant/equal/escape/unrelated-absolute; require_absolute absolute/relative) delivered by 02-01 Task 1; the SCAN-04 guard regression test (`maru_home_rejects_relative_test_home`) is delivered by 02-03 Task 1. No stub scaffolding or separate framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Composite `make verify` | SCAN-01..05 | The composite runs in the main checkout, not inside agent worktrees: the TS7006 errors in `src/components/graph/GraphCanvas.tsx` seen during this reconciliation came from the agent worktree's install layout (pnpm global virtual store), not from the code: `pnpm typecheck` exits 0 in the main checkout at `9446eb0a` and CI `make verify` is green on `main` (see `.planning/phases/11-milestone-verification-evidence/deferred-items.md`). Every phase-02-owned gate is also independently green: the five scoped `cargo test --lib` commands above, the full `cargo test --lib` (1800 passed, 0 failed, 3 ignored), `pnpm lint`, `cargo fmt --check`, and `cargo clippy` all ran clean on 2026-09-25 at HEAD `9446eb0a`. | Run `make verify` in the main checkout (the Phase 11 phase gate does this) |

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

- `cd src-tauri && cargo test --lib -- paths:: workspace_files:: content_search::` - exit 0, 65 passed; 0 failed
- `cd src-tauri && cargo test --lib content_search::` - exit 0, 21 passed; 0 failed
- `cd src-tauri && cargo test --lib -- vault:: secrets:: project_activity:: evidence_binder:: inbox::` - exit 0, 152 passed; 0 failed; 1 ignored
- `cd src-tauri && cargo test --lib maru_dir::` - exit 0, 28 passed; 0 failed
- `cd src-tauri && cargo test --lib skill_host::fs` - exit 0, 4 passed; 0 failed
- `test ! -e Users` - exit 0
- `cd src-tauri && cargo test --lib` (full lib suite) - exit 0, 1800 passed; 0 failed; 3 ignored
- `pnpm lint` - exit 0, clean
- `cd src-tauri && cargo fmt --check` - exit 0, clean
- `cd src-tauri && cargo clippy` - exit 0, clean
- `make verify` - non-zero exit at the `typecheck` target, unrelated to Phase 02 (see Manual-Only row above); escalated, not resolved in this plan per D-10 scope (no production code outside `.planning/milestones/` VALIDATION.md files may change in this plan)
- HEAD at measurement: `9446eb0a`
