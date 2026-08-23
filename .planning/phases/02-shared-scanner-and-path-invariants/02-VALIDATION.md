---
phase: 2
slug: shared-scanner-and-path-invariants
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-23
---

# Phase 2 — Validation Strategy

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
| 02-01 Task 1 (tracer: `paths.rs` module — GENERATED_DIRS union, `ensure_within`, `require_absolute`, full unit tests) | 02-01 | 1 | SCAN-01, SCAN-03 | T-02-01, T-02-02 | Union edit is one-line in `paths.rs`; `ensure_within` rejects escapes lexically; module registered and consumed by workspace_files/content_search | unit | `cd src-tauri && cargo test --lib -- paths:: workspace_files:: content_search::` | ❌ created by 02-01 | ⬜ pending |
| 02-01 Task 2 (`rg_visibility` reconciliation — generated dirs un-allowlistable) | 02-01 | 1 | SCAN-02 | T-02-02 | Allowlisting a nested `.git` no longer resurrects it into content search (`exclude_git: true` unconditionally) | unit (red→green expectation flip on `rg_hidden_and_git_traversal_follow_dot_folder_allowlist`) | `cd src-tauri && cargo test --lib content_search::` | ✅ | ⬜ pending |
| 02-02 Task 1 (SCAN-02 union-proof test, red first) + Tasks 2-3 (rewire vault/secrets/project_activity/evidence_binder) | 02-02 | 2 | SCAN-01, SCAN-02 | T-02-04, T-02-05, T-02-06 | Vault scans exclude `__pycache__`/`.git`/`.venv` contents; all five scanners honor the union; `.maru` stays out of evidence discovery | unit (fixture tree, red→green) | `cd src-tauri && cargo test --lib -- vault:: secrets:: project_activity:: evidence_binder:: inbox::` | ✅ | ⬜ pending |
| 02-01 Task 3 (`ensure_within` promotion — maru_dir.rs drops private copy) | 02-01 | 1 | SCAN-03 | T-02-01 | `ensure_within` importable from `paths.rs`; byte-identical error message; studio/diagram sibling copies untouched | unit | `cd src-tauri && cargo test --lib maru_dir::` | ❌ created by 02-01 | ⬜ pending |
| 02-03 Task 1 (`require_absolute` guard in `maru_home()`/`install_root_base()` + regression test `maru_home_rejects_relative_test_home`) | 02-03 | 2 | SCAN-04 | T-02-07, T-02-08 | Non-absolute home base errors via `Err` on every return path instead of materializing a tree | unit (MARU_TEST_HOME fixture, red→green) | `cd src-tauri && cargo test --lib skill_host::fs` | ✅ | ⬜ pending |
| 02-03 Task 2 (delete stray `Users/` tree, same plan as the guard per D-10) | 02-03 | 2 | SCAN-05 | T-02-07 | Stray `Users/` tree deleted, no recurrence | filesystem assertion | `test ! -e Users` + guard test above | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/paths.rs` test module — full unit tests (ensure_within descendant/equal/escape/unrelated-absolute; require_absolute absolute/relative) delivered by 02-01 Task 1; the SCAN-04 guard regression test (`maru_home_rejects_relative_test_home`) is delivered by 02-03 Task 1. No stub scaffolding or separate framework install needed.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Composite `make verify` green on committed tree | SCAN-01..05 | Shared checkout carries a concurrent hwped session's dirty files; CI is the authoritative composite (Phase 1 precedent) | Confirm CI run green, or accept per-gate individual evidence |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
