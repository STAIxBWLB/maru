---
phase: "10"
slug: "bundle-and-build-hardening"
# status lifecycle: draft (seeded by plan-phase) → validated (set by validate-phase §6)
# audit-milestone §5.5 distinguishes NOT-VALIDATED (draft) from PARTIAL (validated + nyquist_compliant: false) (#2117)
status: validated
nyquist_compliant: true
wave_0_complete: true
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
| 10-01-1/2 | 01 | 1 | SEC-01 (proof a) | T-10-01 | dist/ requires no blob: script URLs | static artifact scan (check-*.mjs) | `node scripts/check-csp-blob.mjs` (chained into `pnpm build:frontend` → `make verify`) | ✅ | ✅ green |
| 10-01-3 | 01 | 1 | SEC-01 (proof b) | T-10-01 | packaged config's script-src has no blob: | packaged-artifact scan (release-checks window) | `node scripts/check-csp-blob.mjs --binary src-tauri/target/debug/maru` (wired into `release-checks`) | ✅ | ✅ green |
| 10-02-1..3 | 02 | 2 | PERF-05 | — | initial CSS ≤ 70 KiB gzip, un-raised | budget gate (existing) | `node scripts/check-bundle-budget.mjs` (already in `pnpm build:frontend`) | ✅ | ✅ green |
| 10-02-3 | 02 | 2 | PERF-05 (hardening) | — | per-mode CSS in lazy chunks, never entry | ownership guard (new check-mode-css-ownership.mjs) | `node scripts/check-mode-css-ownership.mjs` (chained into `pnpm build:frontend`) | ✅ | ✅ green |
| 10-03-2 | 03 | 3 | Criterion 3 (FOUC) | — | no unstyled first activation | e2e: Playwright computed-styles spec on first mode activation | `pnpm test:e2e -- first-activation-styles` / `make test-e2e` (in `release-preflight`, NOT in `make verify`) | ✅ | ✅ green |
| 10-03-1 | 03 | 3 | D-03 preload | — | idle preload warms chunks | unit + wiring (vitest, typecheck, lint, grep≥2 in main.tsx); runtime scheduling stays in Manual-Only | `pnpm exec vitest run src/lib` | ✅ | ✅ green |

*Task IDs are planner-assigned from the landed PLAN.md files (10-01: 3 tasks, 10-02: 3 tasks, 10-03: 2 tasks).*

*Status: ⬜ pending · ✅ green · ❌ red · ⚠️ flaky*

---

## Wave 0 Requirements

- [x] `scripts/check-csp-blob.mjs` (new static + `--binary` modes) — covers SEC-01 both proofs
- [x] `e2e/first-activation-styles.spec.ts` (new) — covers criterion 3
- [x] Optional: per-mode CSS placement assertion — landed as `scripts/check-mode-css-ownership.mjs` chained into `pnpm build:frontend`
- [x] Stale-comment correction in `scripts/check-bundle-budget.mjs` — landed with the 10-02 policy pin

No framework install needed — existing test infrastructure covers everything else. (None of these are test-runner gaps; all land as ordinary implementation tasks.)

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Packaged CSP runtime proof (proof b, CI path) | SEC-01 | CI executes only `make release-preflight-core`; the full native suite + packaged proof is a human-run macOS gate (existing verification culture) | Run `make release-preflight` on macOS after `tauri build`; confirm check-csp-blob `--binary` mode passes against the built binary before the debug binary is pruned |
| D-03 idle preload warm | Phase context D-03 | Runtime scheduling behavior (requestIdleCallback timing) is not gate-worthy; failure degrades gracefully to normal lazy load | Open packaged app, open devtools performance/startupProfile, confirm mode chunks (JS+CSS) are fetched during idle after load, before first mode activation |

---

## Validation Sign-Off

- [x] All tasks have `<automated>` verify or Wave 0 dependencies
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all MISSING references
- [x] No watch-mode flags
- [x] Feedback latency < 60s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** nyquist audit clean 2026-09-25 — 0 gaps, 0 escalations; 2 manual-only items retained per verification culture

## Validation Audit 2026-09-25
| Metric | Count |
|--------|-------|
| Gaps found | 0 |
| Resolved | 0 |
| Escalated | 0 |

Audit basis: all three SUMMARYs recorded every verification command as pass at
execution time (10-01: coverage D1-D5 all pass; 10-02: vitest 2166 + node 96,
guards green; 10-03: vitest src/lib 1634 + e2e 38 green, typecheck/lint/build
exit 0). Disk verification on this host agrees with the SUMMARY claims:
`tauri.conf.json` carries `script-src: 'self'` and `worker-src: 'self' blob:'`,
7 per-mode CSS files each carry a `maru:mode` marker, dist ships 14 CSS chunks,
`check-bundle-budget.mjs` reports initial JS 310.3 KiB ≤ 320 and initial CSS
45.3 KiB ≤ 70, `check-mode-css-ownership.mjs` verifies entry chunk clean, and
`check-csp-blob.mjs` finds no blob: script sources across 76 JS bundles. The
two manual-only rows above remain the honest human-gated remainder; no gap was
replaced with an approval marker.
