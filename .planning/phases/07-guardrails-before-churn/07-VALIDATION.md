---
phase: 7
slug: guardrails-before-churn
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-09-05
---

# Phase 7 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.
> Task IDs reference the tasks in 07-01-PLAN.md through 07-05-PLAN.md (13 tasks,
> all wave 1, no inter-plan dependencies).

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Rust `cargo test` (src-tauri) + Vitest (src/, scripts/) |
| **Config file** | `src-tauri/Cargo.toml`, `package.json` (vitest 4.1.5) |
| **Quick run command** | `cargo test --lib <module>` / `pnpm test -- <file>` |
| **Full suite command** | `make verify` (lock, watcher, scanner, sanitizer-guard suites) |
| **Estimated runtime** | ~120 seconds |

---

## Sampling Rate

- **After every task commit:** Run the task's `<automated>` verify command — scoped to the touched module/suite so feedback lands in seconds (Nyquist per-task guideline: < 30s; no task verify runs the full `pnpm test` or full `cargo test --lib` except where the touched surface *is* the crate-wide Rust suite, e.g. 07-02 Task 3 and 07-03 Task 3, whose final verify is the smallest suite that proves no process-global static was poisoned)
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** Full suite must be green, plus the phase-gate e2e run: `pnpm exec playwright test e2e/inbox*.spec.ts` (the Inbox-pane regression watch for ROADMAP criterion 4, recorded in the 07-04 and 07-05 plan-level `<verification>` blocks)
- **Max feedback latency:** 120 seconds (phase gate); task-level verifies are module-scoped

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 07-01 T1 | 07-01 | 1 | SEC-02 | T-7-01 / T-7-02 | Guard exits 0 on the six existing sinks, fail-closed (exit 1) on an untraced sink; HwpxViewer sanitizes through registered `sanitizeHwpxPreviewHtml` | unit + shell | `node scripts/check-dom-sanitizer.mjs`; `pnpm typecheck`; `pnpm lint` | ❌ created in-task | ⬜ pending |
| 07-01 T2 | 07-01 | 1 | SEC-02 | T-7-03 | Guard wired into `make verify` exactly once, adjacent to `check-select-chrome`; red-then-green drill proven before acceptance | integration (make) | `make check-dom-sanitizer`; `test "$(make -n verify \| grep -c check-dom-sanitizer)" = 1` | ❌ created in-task | ⬜ pending |
| 07-01 T3 | 07-01 | 1 | SEC-02 | T-7-03 | Tracing policy pinned (module allowlist, registered pairs, fail-closed, no AST) by a source-assertion vitest | unit (TS) | `pnpm test -- check-dom-sanitizer` | ❌ created in-task | ⬜ pending |
| 07-02 T1 | 07-02 | 1 | PERF-03 | T-7-04 / T-7-05 | `recover_guard` returns the guard on Ok and Err(poisoned); exactly one warn line; mutual exclusion preserved; REGISTRY_LOCK pattern slice | unit (Rust) | `cargo test --lib lock_recovery`; `cargo test --lib skill_host`; `cargo clippy --lib -- -D warnings` | ❌ created in-task | ⬜ pending |
| 07-02 T2 | 07-02 | 1 | PERF-03 | T-7-04 / T-7-05 | JOBS_LOCK / DOT_ACTION_LOCK / BINDER_WRITE_LOCK recover with lock-specific D-03 justifications; INSPECTION_CACHE untouched | unit (Rust) | `cargo test --lib jobs`; `cargo test --lib dot_sync`; `cargo test --lib evidence_binder`; `cargo clippy --lib -- -D warnings` | ❌ created in-task | ⬜ pending |
| 07-02 T3 | 07-02 | 1 | PERF-03 | T-7-04 / T-7-06 | All five terminal acquisition sites recover (killer keeps `closing` latched per D-02); six retired poison strings exist only as inert test assertions | unit (Rust) | `cargo test --lib terminal`; `cargo test --lib`; `cargo clippy --lib -- -D warnings && cargo fmt --check`; `pnpm test -- ipcError` | ⚠️ existing suites | ⬜ pending |
| 07-03 T1 | 07-03 | 1 | PERF-04 | T-7-07 / T-7-08 | `is_under_generated_dir` exact-component semantics (prefix sibling not pruned, empty/root safe); vault_watcher mixed batch emits only legitimate paths | unit (Rust) | `cargo test --lib paths`; `cargo test --lib vault_watcher`; `cargo clippy --lib -- -D warnings` | ❌ created in-task | ⬜ pending |
| 07-03 T2 | 07-03 | 1 | PERF-04 | T-7-07 / T-7-08 | inbox_watcher and scratchpad_watcher prune per path at dispatch time; non-generated siblings in the same event still emit | unit (Rust) | `cargo test --lib inbox_watcher`; `cargo test --lib scratchpad_watcher`; `cargo clippy --lib -- -D warnings` | ⚠️ existing suites extended | ⬜ pending |
| 07-03 T3 | 07-03 | 1 | PERF-04 | T-7-07 / T-7-09 | ops_catalog and terminal_hooks prune; all five watchers reference the SSOT predicate; no local name lists introduced | unit (Rust) | `cargo test --lib ops_catalog`; `cargo test --lib terminal_hooks`; `cargo test --lib`; `cargo clippy --lib -- -D warnings && cargo fmt --check` | ⚠️ existing suites | ⬜ pending |
| 07-04 T1 | 07-04 | 1 | PERF-06 | T-7-10 / T-7-11 | Zero inbox rows via full scan and cache read (stale cache self-heals); fail-open resolution; empty-rel guard; `inbox-backup` prefix sibling still indexed | unit (Rust) | `cargo test --lib vault`; `cargo clippy --lib -- -D warnings` | ❌ created in-task | ⬜ pending |
| 07-04 T2 | 07-04 | 1 | PERF-06 | T-7-10 / T-7-12 | `scan_vault_paths` containment excludes the resolved inbox root (rescan cannot re-inject pruned rows); Inbox pane / Files browser / content search regression watch green | unit (Rust) | `cargo test --lib vault`; `cargo test --lib inbox`; `cargo test --lib workspace_files`; `cargo test --lib content_search`; `cargo test --lib && cargo clippy --lib -- -D warnings && cargo fmt --check` | ⚠️ existing suites | ⬜ pending |
| 07-05 T1 | 07-05 | 1 | PERF-06 | T-7-13 / T-7-15 | Switcher narrowed to All / Drafts / Archive / Recently Updated; counts map and union agree; zero remaining references to the removed view | unit (TS) | `pnpm typecheck`; `pnpm test -- documentIndex`; `pnpm lint` | ⚠️ existing suites updated | ⬜ pending |
| 07-05 T2 | 07-05 | 1 | PERF-06 | T-7-13 / T-7-14 | Persisted `view: "inbox"` filter reset silently to `{ kind: "all" }` per visibility; i18n key parity (en + ko same commit) | unit (TS) | `pnpm test -- workspaceStore`; `pnpm test -- outlinePaneStore`; `pnpm lint:i18n`; `pnpm test -- documentIndex`; `pnpm typecheck && pnpm lint` | ❌ created in-task | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

The phase-gate e2e run (`pnpm exec playwright test e2e/inbox*.spec.ts`, the Inbox-pane
regression watch named in 07-RESEARCH.md's Phase Requirements → Test Map) is not a
task verify: it is recorded as an explicit phase-gate run in the plan-level
`<verification>` blocks of 07-04 and 07-05 and executes at `/gsd-verify-work` time.

---

## Wave 0 Requirements

There is **no separate Wave 0** in this phase. All five plans are wave 1 with empty
`depends_on`, and every plan's Task 1 is a `tracer` task (`tdd="true"`) that authors
its own tests before the implementation — the test-creation work a Wave 0 would
normally front-load is folded into the tracer tasks:

- [x] 07-02 Task 1 authors the poison-recovery harness (`lock_recovery.rs` tests on fresh `Arc<Mutex<()>>` values, Pitfall 5 shape (b)) — covers PERF-03
- [x] 07-03 Task 1 authors `paths::is_under_generated_dir` plus the colocated predicate tests (exact match, prefix sibling, empty/root, mixed batch) — covers PERF-04
- [x] 07-01 Task 1 authors the guard script; Task 3 pins the policy in vitest; Task 2 runs the red-then-green drill — covers SEC-02
- [x] 07-04 Task 1 authors the inbox twins of the scratchpad exclusion tests across `scan_vault` and `read_vault_cache` — covers PERF-06 (backend)
- [x] 07-05 Tasks 1-2 author/update the documentIndex, workspaceStore, and outlinePaneStore test cases — covers PERF-06 (frontend)

Because nothing is front-loaded, `wave_0_complete: true` means "no Wave 0 exists to
run" rather than "a Wave 0 ran and passed".

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Lock recovery leaves feature usable "on the next call" in production paths not covered by `#[cfg(test)]` harnesses | PERF-03 | Poison-injection into a live process is not reliably automatable | Code-review each lock's recovery justification; run the app's feature after induced panic in dev build |

*All other phase behaviors have automated verification.*

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies — all 13 tasks across 07-01..07-05 carry at least one `<automated>` verify command
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references — no separate Wave 0 exists; every test file marked "❌ created in-task" above is authored inside its tracer task, and every "⚠️ existing suites" row names the suite that must stay green
- [x] No watch-mode flags — all verifies are one-shot (`vitest run` / `cargo test` / script exits), no `--watch`
- [x] Feedback latency < 120s — task verifies are module-scoped (largest: `cargo test --lib`, which the Pitfall 5 poison-safety check requires); full `pnpm test` and the e2e inbox spec are plan/phase-gate runs, not task verifies
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
