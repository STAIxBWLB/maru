---
phase: 03
slug: typed-ipc-error-contract
status: verified
threats_open: 0
asvs_level: 1
created: 2026-08-28
---

# Phase 3 Security

> Retroactive verification of the Phase 3 threat register after the ERR-06
> post-close hardening.

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Rust command to Tauri bridge | `IpcError` is serialized instead of flattening reserved conflict codes into text | Conflict code and human-readable message |
| Tauri rejection to frontend normalizer | `todayInvoke`, `saveDocument`, and `updateFrontmatterField` normalize unknown rejection values before branch sites read them | Untrusted rejection object |
| Source inventory to regression guard | The ERR-06 test reads every Rust source file and checks code-emitting paths for typed-error flattening | Repository source text only |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-03-01 | Tampering / Spoofing | `normalizeIpcError` and its consumers | medium | mitigate | String-shape checks and closed union membership reject forged codes; `ipcError.test.ts`, `today.test.ts`, and `api.test.ts` pin fail-safe normalization | closed |
| T-03-02 | Information Disclosure | `IpcError` wire shape | low | accept | Conflict codes were already present in legacy error strings and the binary; the structured field adds no new sensitive detail | closed |
| T-03-03 | Information Disclosure | `From<String>` and `Display` | low | mitigate | Legacy text remains the complete message for empty-code errors; Rust Display tests and the frontmatter API test pin unchanged user-visible text | closed |
| T-03-04 | Tampering | Conflict-emitting command paths | low | mitigate | ERR-06 removes string flattening from three commands; the recursive source guard detects new Rust modules, while the sole internal `apply_receipt` exception is function-scoped and documented | closed |
| T-03-05 | Information Disclosure | E2E fixture messages | low | accept | Fixtures carry a separate code and prefix-free message; normalization restores the same display text without adding internal data | closed |
| T-03-06 | Tampering | Rename and source-discovery drills | low | mitigate | Drill edits are reverted before commit; the source-discovery probe failed on the injected offender and passed after removal | closed |
| T-03-SC | Tampering | Dependency supply chain | low | accept | No dependency was added; the recursive guard uses the repository's existing `walkdir` dependency | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-03-01 | T-03-02 | The structured code exposes no information beyond the previous string prefix | Phase 3 design decision | 2026-08-28 |
| AR-03-02 | T-03-05 | Test fixtures preserve the production display surface and contain no secrets | Phase 3 design decision | 2026-08-28 |
| AR-03-03 | T-03-SC | No new package or version was introduced | Phase 3 design decision | 2026-08-28 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-28 | 7 | 7 | 0 | Codex inline audit |

## Verification Evidence

- `make verify`: passed, including 1,945 frontend tests, 1,235 Rust tests,
  fmt, clippy with warnings denied, typecheck, lint, and production build.
- ERR-06 recursive guard: passed on the final tree.
- Red probe: a newly added unregistered Rust module was detected as
  `err06_guard_probe.rs:8`, then removed and the guard returned green.
- `Result<_, String>` measurement: 1,146 before ERR-06 and 1,142 after the
  four intended signature changes.

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted risks are documented.
- [x] `threats_open: 0` confirmed.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-08-28
