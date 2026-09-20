---
phase: "10"
slug: "bundle-and-build-hardening"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: draft
nyquist_compliant: false
wave_0_complete: false
created: "2026-09-21"
---

# Phase 10 — Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | vitest 4.1.5 (TypeScript/React unit) + cargo test (Rust unit) |
| **Config file** | none standalone — vitest invoked via package.json scripts (`"test": "vitest run src scripts --exclude '**/check-command-isolation.test.mjs' && node --test scripts/check-command-isolation.test.mjs"`) |
| **Quick run command** | `pnpm test` |
| **Full suite command** | `make test` (runs `test-ts` + `test-rust`: vitest + cargo test) |
| **Estimated runtime** | ~60 seconds |

`make verify` remains the phase gate: typecheck, lint, release-version-check, icons-check, lint-i18n, check-select-chrome, check-dom-sanitizer, check-type-tokens, test-ts, test-rust, fmt-check, clippy, build-frontend (chains check-bundle-budget.mjs + check-native-e2e-isolation.mjs), check-command-isolation. The packaged-build proof (`make release-preflight`, human-run macOS) includes the packaged-CSP check and e2e/native suites.

---

## Sampling Rate

- **After every task commit:** Run `pnpm test` (plus `pnpm build:frontend` for any change touching dist-scanning guards or CSS placement)
- **After every plan wave:** Run `make verify`
- **Before `/gsd-verify-work`:** Full suite must be green + `make release-preflight` (human-run, macOS: packaged-CSP proof + e2e/native suites)
- **Max feedback latency:** ~60 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| TBD | 01 | 1 | SEC-01 (proof a) | T-10-01 | dist/ requires no blob: script URLs | static artifact scan (check-*.mjs) | `node scripts/check-csp-blob.mjs` (chained into `pnpm build:frontend` → `make verify`) | ❌ W0 | ⬜ pending |
| TBD | 01 | 1 | SEC-01 (proof b) | T-10-01 | packaged config's script-src has no blob: | packaged-artifact scan (release-checks window) | `node scripts/check-csp-blob.mjs --binary src-tauri/target/debug/maru` (wired into `release-checks`) | ❌ W0 | ⬜ pending |
| TBD | 01 | 1 | PERF-05 | — | initial CSS ≤ 70 KiB gzip, un-raised | budget gate (existing) | `node scripts/check-bundle-budget.mjs` (already in `pnpm build:frontend`) | ✅ | ⬜ pending |
| TBD | 01 | 1 | PERF-05 (hardening) | — | per-mode CSS in lazy chunks, never entry | budget gate + optional source assertion | same command chain | Optional — W0 | ⬜ pending |
| TBD | 02 | 1 | Criterion 3 (FOUC) | — | no unstyled first activation | e2e: Playwright computed-styles spec on first mode activation | `pnpm test:e2e` / `make test-e2e` (in `release-preflight`, NOT in `make verify`) | ❌ W0 | ⬜ pending |
| TBD | 02 | 1 | D-03 preload | — | idle preload warms chunks | manual/observation (startupProfile-style marks or devtools); no gate — preload failure degrades gracefully | — | — | ⬜ pending |

*Task IDs are planner-assigned during plan-phase step 8; this map is refined when PLAN.md files land.*

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [ ] `scripts/check-csp-blob.mjs` (new static + `--binary` modes) — covers SEC-01 both proofs
- [ ] `e2e/first-activation-styles.spec.ts` (new) — covers criterion 3
- [ ] Optional: per-mode CSS placement assertion in check-bundle-budget.mjs — PERF-05 hardening
- [ ] Stale-comment correction in `scripts/check-bundle-budget.mjs:27-28` — 10-CONTEXT.md `<specifics>` requires it in the change that lands the split

No framework install needed — existing test infrastructure covers everything else. (None of these are test-runner gaps; all land as ordinary implementation tasks.)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Packaged CSP runtime proof (proof b, CI path) | SEC-01 | CI executes only `make release-preflight-core`; the full native suite + packaged proof is a human-run macOS gate (existing verification culture) | Run `make release-preflight` on macOS after `tauri build`; confirm check-csp-blob `--binary` mode passes against the built binary before the debug binary is pruned |
| D-03 idle preload warm | Phase context D-03 | Runtime scheduling behavior (requestIdleCallback timing) is not gate-worthy; failure degrades gracefully to normal lazy load | Open packaged app, open devtools performance/startupProfile, confirm mode chunks (JS+CSS) are fetched during idle after load, before first mode activation |

---

## Validation Sign-Off

- [ ] All tasks have `<automated>` verify or Wave 0 dependencies
- [ ] Sampling continuity: no 3 consecutive tasks without automated verify
- [ ] Wave 0 covers all MISSING references
- [ ] No watch-mode flags
- [ ] Feedback latency < 60s
- [ ] `nyquist_compliant: true` set in frontmatter

**Approval:** pending
