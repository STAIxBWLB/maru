---
phase: 1
slug: trustworthy-verify-signal
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-22
---

# Phase 1 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| rustup to upstream toolchain distribution | `rust-toolchain.toml` pin causes rustup to fetch from static.rust-lang.org on first use | toolchain binaries |
| repo to CI runner | Pinned toolchain overrides what `dtolnay/rust-toolchain@stable` would install | build environment |
| clippy autofix to source tree | `cargo clippy --fix` rewrites production Rust in place | source code integrity |
| CI runner to GitHub artifact storage | Playwright trace uploaded as downloadable artifact | screenshots, DOM snapshots, network payloads (fixtures only) |
| `src/lib/e2eFlow.ts` to shipped E2E artifact | `TODO_LEDGER` content written into `todos.json` | ledger metadata |
| pnpm to npm registry | New devDependencies fetched, lockfile regenerated | package integrity |
| removed type stub to sanitizer call sites | Four DOMPurify call sites change where their types come from | type-only, no runtime data |
| `scripts/` to release pipeline | Scripts sign, notarize, publish updater manifests, update Homebrew tap | release artifacts |
| eslint.config.js to the gate | Rule set defines what the gate can catch | gate efficacy |
| disable comments to future phases | Comments written here become the Phase 4-5 worklist | suppression surface |
| `make verify` to CI | The gate the whole milestone is measured against | verification signal |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-01-01 | Tampering | rustup toolchain download triggered by the new pin | low | accept | Signed manifests over TLS; exact pin narrows fetch vs floating `stable` | closed |
| T-01-02 | Denial of Service | CI build time after the pin | low | accept | One-time cache-key invalidation on landing PR | closed |
| T-01-03 | Tampering | `cargo clippy --fix` rewriting `src-tauri/src/` | high | mitigate | `cargo test --lib` run after autofix, diff review, hand-revert of behavior-changing rewrites; verified unchanged test set (UAT 01-02-D4) | closed |
| T-01-04 | Elevation of Privilege | clippy fix silently altering path-validation/permission check | medium | mitigate | Behavior preservation hard constraint, unchanged `cargo test --lib` result set (UAT 01-02-D4) | closed |
| T-01-05 | Repudiation | violation silenced instead of fixed | medium | mitigate | Diff grep for suppression attributes required count 0 (UAT 01-02-D3) | closed |
| T-01-06 | Information Disclosure | `trace.zip` uploaded as CI artifact | medium | accept | Fixtures/mocked IPC only, no credentials; repo-scoped artifact, 7-day retention | closed |
| T-01-07 | Repudiation | flaky test passing on retry | high | mitigate | No `retries:` key enforced; failing test ran exactly once (UAT 01-03-D1/D2) | closed |
| T-01-08 | Tampering | deliberate CI probe commit surviving the branch | medium | mitigate | Probe reverted, spec restored byte-for-byte, green follow-up run (UAT 01-03-D2) | closed |
| T-01-SC (01-04) | Tampering | `pnpm add -D @types/node` | high | mitigate | Package Legitimacy Audit + blocking-human checkpoint, hand-confirmed against npmjs.com (UAT test 1) | closed |
| T-01-09 | Tampering | lockfile drift from unpinned install | medium | mitigate | Lockfile diff from install only; CI runs `pnpm install --frozen-lockfile` | closed |
| T-01-10 | Information Disclosure | four DOMPurify sanitizer call sites | medium | accept | Type-only stub removal; dompurify runtime untouched, same lockfile version (UAT 01-04-D2) | closed |
| T-01-11 | Spoofing | type-only fix changing what an e2e spec asserts | medium | mitigate | Cast-to-any banned via diff grep; `make test-e2e` unchanged count (UAT 01-04) | closed |
| T-01-12 | Tampering | "type-only" fix silently changing release-script behavior | high | mitigate | JSDoc/`@type`-only fixes, suppression grep count 0, unchanged `pnpm test`, dry-run gate scripts unchanged output (UAT 01-05-D2) | closed |
| T-01-13 | Repudiation | diagnostic cleared with `@ts-ignore` instead of fixed | high | mitigate | Diff grep for `@ts-ignore`/`@ts-nocheck`/`@ts-expect-error` count 0 (UAT 01-05) | closed |
| T-01-14 | Denial of Service | broken verification script silently passing | medium | mitigate | Full `make verify` run; spot-runs compare output not just exit code (UAT 01-05) | closed |
| T-01-SC (01-06) | Tampering | `pnpm add -D eslint typescript-eslint eslint-plugin-react-hooks` | high | mitigate | Package Legitimacy Audit + blocking-human checkpoint, hand-confirmed against npmjs.com (UAT test 2) | closed |
| T-01-15 | Repudiation | bare `eslint-disable-next-line` masking unrelated rule | high | mitigate | Every directive names its rule; bare-directive grep count 0 (UAT 01-06-D2, 01-07-D1) | closed |
| T-01-16 | Tampering | "fixing" hook-dependency violation by editing dependency array | high | mitigate | Disable-with-reason mandated; diff confirms no dependency array changed; unchanged `pnpm test` (UAT 01-06-D2) | closed |
| T-01-17 | Denial of Service | `no-unused-vars` fix deleting binding with live side effect | medium | mitigate | `pnpm typecheck` + unchanged `pnpm test` count (UAT 01-06/01-07) | closed |
| T-01-18 | Repudiation | blanket-`void` on e2e floating-promise list | high | mitigate | Each site read; added `await`s listed individually; unchanged `make test-e2e` count (UAT 01-07-D2) | closed |
| T-01-19 | Tampering | clearing exhaustive-deps violation by editing dependency array | high | mitigate | Disable-with-reason + diff check + unchanged `pnpm test` (UAT 01-07-D1) | closed |
| T-01-20 | Denial of Service | new `verify` prerequisite slower than developers tolerate | low | accept | `eslint src e2e` is seconds against 9m19s CI verify; `lint` runnable standalone | closed |
| T-01-21 | Elevation of Privilege | unused-symbol deletion removing side-effect binding | medium | mitigate | `pnpm typecheck` + unchanged test counts (UAT 01-07) | closed |
| T-01-SC (01-01/02/03/05/07) | Tampering | package-manager installs | n/a | accept | These plans run no dependency install | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-01-01 | T-01-01 | rustup verifies signed manifests over TLS; exact pin narrows what is fetched vs floating `stable` | plan 01-01 | 2026-08-22 |
| AR-01-02 | T-01-02 | One-time `Swatinem/rust-cache` key invalidation; not recurring | plan 01-01 | 2026-08-22 |
| AR-01-03 | T-01-06 | Trace embeds fixtures/mocked IPC only, no real workspace or credentials; repo-scoped, 7-day retention; standing constraint: no real secrets in e2e fixtures | plan 01-03 | 2026-08-22 |
| AR-01-04 | T-01-10 | Type-only stub removal cannot change sanitizer runtime; SEC-02 regression test deferred to v2 per STATE.md | plan 01-04 | 2026-08-22 |
| AR-01-05 | T-01-20 | Lint adds seconds to a 9m19s gate; standalone `lint` target preserves fast loop | plan 01-07 | 2026-08-22 |
| AR-01-06 | T-01-SC (all plans) | Plans 01-01/02/03/05/07 run no installs; 01-04/01-06 installs gated behind Package Legitimacy Audit + blocking-human checkpoint | plans 01-01..01-07 | 2026-08-22 |

*Accepted risks do not resurface in future audit runs.*

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-22 | 24 | 24 | 0 | gsd-secure-phase (L1, ASVS 1) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-22
