---
phase: "10"
slug: "bundle-and-build-hardening"
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: "2026-09-25"
---

# Phase 10 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Shipped CSP (tauri.conf.json) | The webview script-src posture measured against the packaged artifact, not the dev server | Script execution origins in the production bundle |
| Preload scheduling -> app entry | A preload that throws or blocks the entry path would turn graceful degradation into a startup failure | JS chunk loads during browser idle time |
| e2e spec -> release-preflight | A FOUC spec that cannot fail would provide false confidence in the styling criterion | Playwright assertions in the release gate |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-10-01 | Tampering / Elevation of Privilege | `script-src 'self' blob:` in the shipped CSP; innerHTML sinks in src/ | high | mitigate | Dropped via 10-01 (D-04): `tauri.conf.json:35` now `script-src: 'self'`; dist half of check-csp-blob.mjs chained into `pnpm build:frontend` -> `make verify` (scans 76 JS bundles, 0 blob: script sources); packaged-binary half wired into `release-checks` (Makefile:188, :309); DOMPurify sink tracing (SEC-02, check-dom-sanitizer.mjs, Makefile:180) unchanged on top | closed |
| T-10-02 | Tampering | `worker-src 'self' blob:` retention | medium | accept | Locked decision D-05: the graph analysis worker requires blob:, the directive is scoped to workers only, and worker context cannot reach the DOM/IPC surface main-frame script execution would; `tauri.conf.json:36` keeps `worker-src: 'self' blob:'` | closed |
| T-10-03 | Tampering (evidence gap) | Dev/prod CSP divergence: dev serves no CSP (no devCsp key) | medium | mitigate | D-04 two-proof design: both proofs read produced artifacts (dist/ assets and the compiled binary via `--binary`), never dev-server behavior; both live in standing gates (`make verify` via build:frontend, `make release-checks`) | closed |
| T-10-04 | Tampering (guard weakening) | check-type-tokens scope (src/styles.css only) | medium | mitigate | Prohibition held by the split: per-mode CSS files use var(--type-*) font-size tokens (raw counts: tasks 45, calendar 30, today 78, drafts 15, agents 18, gap 24, meetings 79; raw px font-size = 0 in all seven files); the guard's scope is not escaped by the split | closed |
| T-10-05 | Tampering (guard weakening) | check-mode-css-ownership.mjs itself | medium | mitigate | 11-assertion hermetic policy pin (scripts/check-mode-css-ownership.test.ts) in the `pnpm test` suite already runs; violations exit 1 fail-closed; red-list drill in 10-02 proved the guard has teeth | closed |
| T-10-06 | Denial of Service (styling regression) | Cross-file selector dependencies (.sr-only, .mode-loading, duplicated selectors) | medium | mitigate | D-02 boundary review with recorded dispositions (10-02-SUMMARY D-02 boundary dispositions 10 items); shared utilities stay entry-side (.sr-only styles.css:294, .mode-loading styles.css:4025/:4035); the e2e FOUC/parity spec in 10-03 (38 tests) catches a flip on first activation | closed |
| T-10-07 | Denial of Service (startup failure) | modePreload.ts throwing or blocking entry | low | mitigate | Preload failures are swallowed (`.catch(() => {})` in src/lib/modePreload.ts); the schedule is idle-time (scheduleStartupIdle, non-blocking); vitest src/lib 1634 tests + typecheck + lint gate the module | closed |
| T-10-08 | Repudiation (false confidence) | FOUC spec asserting nothing observable | medium | mitigate | e2e/first-activation-styles.spec.ts asserts concrete computed styles (background-color/backgroundImage paint check, Pretendard font-family) per mode under both colorSchemes; `pnpm test:e2e` fails on any assertion miss (38 passed in 10-03) | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-10-01 | T-10-02 | D-05 locked decision: worker-src blob: retention is required by the graph analysis worker; workers cannot reach the DOM/IPC script-execution surface; directive scoped to workers only | Planner (D-05, 10-01-PLAN) + orchestrator audit 2026-09-25 | 2026-09-25 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-25 | 8 | 8 | 0 | orchestrator (generic grep audit, asvs_level 1, block_on high) |

Audit method: register authored at plan time (all three PLAN files carry parseable `<threat_model>` blocks; 8 threats total). Every threat's mitigation was verified by grep/disk evidence on this host rather than only by SUMMARY claims. Short-circuit applied (threats_open: 0, plan-time register, L1): no auditor spawn required.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-25 — 8/8 threats closed, 0 open at or above the high threshold
