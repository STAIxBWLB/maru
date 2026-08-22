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
| TBD by planner | — | — | SCAN-01 | — | Union edit is one-line, all five scanners honor it | unit | `cargo test --lib paths` | ❌ W0 | ⬜ pending |
| TBD by planner | — | — | SCAN-02 | — | Workspace/vault scans skip `.git`/`.venv` | unit (fixture tree) | `cargo test --lib vault workspace_files` | ✅ | ⬜ pending |
| TBD by planner | — | — | SCAN-03 | — | `ensure_within` importable from `paths.rs`, rejects escapes lexically | unit | `cargo test --lib paths` | ❌ W0 | ⬜ pending |
| TBD by planner | — | — | SCAN-04 | — | Non-absolute home base errors instead of materializing a tree | unit (MARU_TEST_HOME fixture) | `cargo test --lib skill_host::fs` | ✅ | ⬜ pending |
| TBD by planner | — | — | SCAN-05 | — | Stray `Users/` tree deleted, no recurrence | filesystem assertion | `test ! -d Users` + guard test above | ✅ | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src-tauri/src/paths.rs` test module — stubs for SCAN-01/03/04 guard tests (created by the plan that introduces the module; no separate framework install needed)

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
