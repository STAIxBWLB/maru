---
phase: 7
slug: guardrails-before-churn
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-09-05
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Seeded from 07-RESEARCH.md `## Validation Architecture`. Task IDs are
> placeholders — fill them in after the planner assigns task IDs.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `cargo test` (src-tauri) + Vitest (src/) |
| **Config file** | `src-tauri/Cargo.toml`, `vite.config.ts` |
| **Quick run command** | `cargo test <module>` / `npx vitest run <file>` |
| **Full suite command** | `make verify` (lock, watcher, scanner, sanitizer-guard suites) |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` verify command
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** Full suite must be green
- **Max feedback latency:** 120 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| {TBD} | {TBD} | 1 | PERF-03 | T-7-01 / — | Poissoned-lock recovery does not panic-loop | unit | `cargo test poison` | ❌ W0 | ⬜ pending |
| {TBD} | {TBD} | 1 | PERF-04 | T-7-02 / — | GENERATED_DIRS paths produce zero watcher events | unit | `cargo test watcher` | ❌ W0 | ⬜ pending |
| {TBD} | {TBD} | 1 | SEC-02 | T-7-03 / — | New dangerouslySetInnerHTML traces to DOMPurify helper | unit | `make verify` (sanitizer-guard) | ❌ W0 | ⬜ pending |
| {TBD} | {TBD} | 1 | PERF-06 | T-7-04 / — | Zero `inbox/...` index rows via scan, rescan, cache read | unit | `cargo test inbox` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] Lock poison-recovery tests for the six named locks — covers PERF-03
- [ ] Watcher GENERATED_DIRS prune tests — covers PERF-04
- [ ] Sanitizer-guard red-then-green harness — covers SEC-02
- [ ] Inbox exclusion tests across the three vault call sites — covers PERF-06

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Lock recovery leaves feature usable "on the next call" in production paths not covered by `#[cfg(test)]` harnesses | PERF-03 | Poison-injection into a live process is not reliably automatable | Code-review each lock's recovery justification; run the app's feature after induced panic in dev build |

*All other phase behaviors have automated verification.*

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 120s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
