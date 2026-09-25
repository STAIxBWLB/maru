---
phase: 02
slug: shared-scanner-and-path-invariants
status: verified
threats_open: 0
asvs_level: 1
created: 2026-09-25
---

# Phase 2 Security

> Retroactive verification, run in v1.1 Phase 11 (SEC-03), of the threat register declared
> in 02-01..02-03-PLAN.md, checked against HEAD (9446eb0a).

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|----------------|
| untrusted workspace trees to scanner prune filters | Directory names in user-controlled trees decide traversal scope | Directory names only |
| caller-supplied relative paths to ensure_within | Containment decision for paths joined under a root | Path segments |
| untrusted workspace/vault trees to scanner prune filters | Directory names decide what reaches indexes/evidence discovery | Directory names only |
| environment (MARU_TEST_HOME, dirs::home_dir()) to home-root constructors | A non-absolute base crossing this boundary silently materializes directory trees in the process cwd | Environment variable value |

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|--------------|------------|--------|
| T-02-01 | Tampering/Elevation | `ensure_within` (paths.rs) | medium | mitigate | `ensure_within` at `paths.rs:78`, with dedicated unit tests `ensure_within_accepts_descendant` (150), `ensure_within_accepts_child_equal_to_parent` (156), `ensure_within_rejects_dotdot_escape` (163), `ensure_within_rejects_unrelated_absolute_path` (169); `cargo test --lib paths::` green (14 passed) | closed |
| T-02-02 | Information disclosure | scanner prune lists (`workspace_files.rs`, `content_search.rs`) | medium | mitigate | `GENERATED_DIRS` union at `paths.rs:42` includes `.git`/`.venv`; `exclude_git: true` set at `content_search.rs:272,876,888,900`; test `rg_hidden_and_git_traversal_follow_dot_folder_allowlist` at `content_search.rs:871`; `cargo test --lib content_search::` green (21 passed) | closed |
| T-02-03 | Tampering | symlink-following containment bypass | low | accept | Design-rationale comment at `vault.rs:689-694` explaining lexical containment is deliberate (`canonicalize()` would falsely reject user symlinks inside workspaces); `..` traversal still blocked by `lexical_normalize` (`vault.rs:695,717`) | closed |
| T-02-04 | Information disclosure | `evidence_binder.rs::is_excluded_dir` | high | mitigate | Module-local `.maru` exclusion ORed with `GENERATED_DIRS` at `evidence_binder.rs:1536-1542`; `cargo test --lib evidence_binder::` green (23 passed) | closed |
| T-02-05 | Information disclosure | `vault.rs::ScanFilter::is_excluded_path` | medium | mitigate | `generated_dirs` stays an injected parameter at `vault.rs:221,234`; `inbox.rs`'s three empty-slice call sites confirmed at `inbox.rs:1034,1115,1178`; `cargo test --lib -- vault:: inbox::` green (100 passed, 1 ignored) | closed |
| T-02-06 | Information disclosure | `secrets.rs::should_prune` | low | accept | `should_prune` at `secrets.rs:791-814` widens the prune set via `GENERATED_DIRS` while the `.maru/secrets`/`.secrets` prefix rules (802-803) stay the separately-enforced primary guard; `cargo test --lib secrets::` green (18 passed) | closed |
| T-02-07 | Tampering | `skill_host/fs.rs::maru_home` / `install_root_base` | high | mitigate | Both functions wrap their return value in `require_absolute` (`fs.rs:31,52`); regression test `maru_home_rejects_relative_test_home` at `fs.rs:300`; `cargo test --lib skill_host::fs` green (4 passed) | closed |
| T-02-08 | Tampering | env-mutating guard test racing parallel tests | medium | mitigate | `test_maru_home_lock()` fixture idiom defined at `fs.rs:218` and used at `fs.rs:253,273,304` to hold the lock and restore `MARU_TEST_HOME` on every path; covered by the same `skill_host::fs` test run | closed |

*Status: closed - all 8 rows verified against HEAD; no threat is open.*
*Severity: critical > high > medium > low - only open threats at or above workflow.security_block_on (high) count toward threats_open.*
*Disposition: mitigate (implementation required) - accept (documented risk).*

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|--------------|------|
| AR-02-01 | T-02-03 | Lexical containment is deliberate design (D-07): `canonicalize()` would falsely reject a user's own symlinks inside workspaces, and `..` traversal remains blocked by `lexical_normalize` | Phase 2 design decision | 2026-08-22 |
| AR-02-02 | T-02-06 | The shared `GENERATED_DIRS` union only widens this scanner's prune set (adds `.turbo`, `__pycache__`); the secrets-domain prefix rules (`.maru/secrets`, `.secrets`) are untouched and remain the primary guard | Phase 2 design decision | 2026-08-22 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|----------------|--------|------|--------|
| 2026-09-25 | 8 | 8 | 0 | inline secure-phase audit, v1.1 Phase 11 (L1, ASVS 1) |
| 2026-09-25 | - | - | - | D-13 not triggered: no open threat. |

## Verification Evidence

- `cargo test --lib paths::` at HEAD 9446eb0a: `test result: ok. 14 passed; 0 failed; 0 ignored; 0 measured; 1789 filtered out`
- `cargo test --lib content_search::` at HEAD 9446eb0a: `test result: ok. 21 passed; 0 failed; 0 ignored; 0 measured; 1782 filtered out`
- `cargo test --lib evidence_binder::` at HEAD 9446eb0a: `test result: ok. 23 passed; 0 failed; 0 ignored; 0 measured; 1780 filtered out`
- `cargo test --lib -- vault:: inbox::` at HEAD 9446eb0a: `test result: ok. 100 passed; 0 failed; 1 ignored; 0 measured; 1702 filtered out` (one filtered invocation covering both `vault::` and `inbox::`)
- `cargo test --lib secrets::` at HEAD 9446eb0a: `test result: ok. 18 passed; 0 failed; 0 ignored; 0 measured; 1785 filtered out`
- `cargo test --lib skill_host::fs` at HEAD 9446eb0a: `test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 1799 filtered out`

## Sign-Off

- [x] All threats have a disposition (mitigate / accept).
- [x] Accepted risks are documented in Accepted Risks Log.
- [x] `threats_open: 0` confirmed.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-09-25
