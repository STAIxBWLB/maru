---
phase: 06
slug: native-e2e-runner-foundation
status: verified
# threats_open = count of OPEN threats at or above workflow.security_block_on severity (the blocking gate)
threats_open: 0
asvs_level: 1
created: 2026-08-29
---

# Phase 06 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| wdio Node process -> launched app process | The runner supplies the environment that decides which filesystem tree the real app treats as its home | workspace paths, registry contents |
| Build inputs -> shipped artifact | A cargo feature or Vite flag intended for the runner can reach a build a user installs | runner-only read primitives (terminal text, menu dispatch, WebDriver server) |
| Public registries -> dependency set | Six npm packages and one crate entered the supply chain in 06-01 | package integrity |
| Page JavaScript -> terminal screen / app command dispatch | The build-gated debug bridge reads PTY screen contents and invokes menu commands from page JS | terminal contents, app actions |
| Recorded scope -> downstream phases | Phase 8 and Phase 9 plan verification against this phase's records | evidence integrity |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-06-01 | Information Disclosure | `native-e2e` feature, `__MARU_NATIVE_E2E__` bridge, embedded WebDriver server | high | mitigate | Default-off feature + `optional` dep (06-01); Vite literal-folded `VITE_NATIVE_E2E` gate verified absent from production `dist/` (06-02); artifact-level bundle+binary guard `scripts/check-native-e2e-isolation.mjs` chained into `build:frontend` and `release-checks`, proven fail-first on real builds (06-04); verifier re-observed the guard's live red case | closed |
| T-06-01b | Information Disclosure / EoP | Shipped binary carrying a listening embedded WebDriver server | high | mitigate | Guard `--binary` mode scans the produced debug no-bundle binary for the plugin crate name, wired into `release-checks` before the artifact prune (06-04) | closed |
| T-06-02 | Tampering | `fixtureWorkspace.ts` | medium | mitigate | All fixture writes derive from one mkdtemp root via path.join; Rust side runs overrides through `require_absolute` (06-01). Reset hardened to contents-only + atomic rename in code review fix bf8e7e9 | closed |
| T-06-03 | Tampering / data loss | `native_e2e_dir_override`, `maru_home_dir()`, `app_config_dir()` | high | mitigate | Fail-closed resolver errors naming the missing variable; unit-tested (cargo test paths:: 10 passed) and launch-verified (06-01; verifier re-ran) | closed |
| T-06-SC | Tampering | npm/cargo installs | high | mitigate | Task 1 blocking human legitimacy gate: crate resolved live (tauri-plugin-wdio-webdriver 1.3.0), five npm packages confirmed under the webdriverio org; `@vitest/coverage-v8` deferred (06-01-SUMMARY) | closed |
| T-06-04 | Repudiation | verdict records in docs/native-e2e.md + PROJECT.md | medium | mitigate | D-01's three conditions ratified item-by-item at the blocking checkpoint with named evidence per condition; both records written in the same task (06-05) | closed |
| T-06-06 | Tampering | text-mirror read path in NativeTerminalView.tsx | low | mitigate | Reader only reads `gridRef.current`; no writes, no events (06-02) | closed |
| T-06-07 | Spoofing | PTY assertion in pty.spec.ts | medium | mitigate | Marker is shell-produced (`MARU_PTY_OK_7F3A2B`), not typed — an echo-only terminal fails the spec (06-02; observed passing on hosted run 33250704926) | closed |
| T-06-08 | Repudiation | recorded IME/menu scope in docs/native-e2e.md | medium | mitigate | Per-surface automated-vs-human split stated plainly; unreachable IME cases recorded pending-with-reason; checklist requires per-item observations (06-03, 06-05 ratification record) | closed |
| T-06-09 | Tampering | the isolation guard itself | medium | mitigate | Red cases produced by real builds (flag on / feature on), never patched sources; a wrong-string guard would false-pass the drill visibly (06-04) | closed |
| T-06-05 | Information Disclosure | spike evidence artifacts | low | accept | Ephemeral hosted runner, no user data; evidence is what settles D-01's human-observable condition | closed |
| T-06-10 | Denial of Service | `cargo metadata` in the frontend build chain | low | accept | `--no-deps --offline` reads manifests only; WR-01 review fix 5636695 made environmental failures warn-and-skip instead of hard-failing | closed |
| T-06-11 | Denial of Service | `native-e2e-suite` on main/tags | low | accept | D-16 chose the narrow trigger over per-PR execution; `release-preflight` is human-run so a real blocker is visible before a tag | closed |
| T-06-12 | Elevation of Privilege | `native-e2e-compile` on every PR | low | accept | Compiles/typechecks only; never executes the suite or the app on the runner | closed |
| T-06-13 | Information Disclosure | stripped release binary | low | accept | Binary scan targets the unstripped debug build sharing the release feature set; scanning a stripped binary risks a vacuous pass | closed |

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*

---

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---------|------------|-----------|-------------|------|
| AR-06-01 | T-06-05 | Spike evidence artifacts inherit repo visibility; ephemeral runner holds no user data; evidence is required to settle D-01 | plan 06-01 (ratified 06-05) | 2026-08-29 |
| AR-06-02 | T-06-10 | cargo metadata early-warning kept despite env-failure false-positive class; warn-and-skip applied per code review WR-01 | plan 06-04 + review fix | 2026-08-29 |
| AR-06-03 | T-06-11 | Flaky native run can block a release tag; narrower trigger chosen deliberately (D-16), human-run preflight stays the last gate | plan 06-05 | 2026-08-29 |
| AR-06-04 | T-06-12 | Compile-only PR job cannot launch processes beyond the compilers already run on Linux legs | plan 06-05 | 2026-08-29 |
| AR-06-05 | T-06-13 | Stripped-binary scan would risk vacuous pass; transitive coverage via shared feature set preferred | plan 06-04 | 2026-08-29 |

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-29 | 15 | 15 | 0 | gsd-secure-phase (L1 grep-depth; short-circuit per ASVS L1 + plan-time register) |

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-08-29
