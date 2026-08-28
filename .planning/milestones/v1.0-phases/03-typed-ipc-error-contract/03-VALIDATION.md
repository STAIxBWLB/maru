---
phase: 3
slug: typed-ipc-error-contract
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: 2026-08-23
---

# Phase 3 — Validation Strategy

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
| 3-TBD-ERR01 | TBD | TBD | ERR-01 | T-3-01 | `normalizeIpcError` type-guards `code`/`message` as strings before constructing `IpcError`; forged/unknown codes fail safe to generic display | unit | `pnpm vitest run src/lib/ipcError.test.ts` | ❌ W0 | ⬜ pending |
| 3-TBD-ERR02 | TBD | TBD | ERR-02 | — | N/A | unit + typecheck + drill | `cargo test --lib ipc_error` + `pnpm typecheck` + rename drill | ❌ W0 | ⬜ pending |
| 3-TBD-ERR03 | TBD | TBD | ERR-03 | — | N/A | unit + grep | `pnpm vitest run src/lib/diagram/reportInsert.test.ts src/components/today` + grep for residual `.includes("<code>")` in `src/` | ✅ | ⬜ pending |
| 3-TBD-ERR04 | TBD | TBD | ERR-04 | — | N/A | grep baseline | `grep -roE "Result<.*, String>" src-tauri/src --include="*.rs" \| wc -l` (baseline 1,138) | ✅ | ⬜ pending |
| 3-TBD-D09 | TBD | TBD | D-09 | T-3-02 | wire shape round-trips; user-visible message content unchanged (`"code: message"` preserved) | unit (Rust) | `cargo test --lib ipc_error` | ❌ W0 | ⬜ pending |

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `src/lib/ipcError.test.ts` (or equivalent) — normalization helper tests (ERR-01)
- [ ] Rust `ipc_error` module test module — code-list pin + `serde_json` round-trip (ERR-02, D-09)
- [ ] Update existing prefix-string assertions — these exist and will go red on the emit-site change; they are migration targets, not new files

*(Frameworks, configs, and fixtures already exist — no install step.)*

---

## Manual-Only Verifications

All phase behaviors have automated verification.

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
