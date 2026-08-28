---
phase: 05
slug: shell-decomposition-completion
status: verified
# threats_open counts open threats at or above workflow.security_block_on.
threats_open: 0
asvs_level: 1
created: 2026-08-27
verified: 2026-08-27
---

# Phase 05 - Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| React terminal surface -> typed IPC wrappers | Session operations leave the frontend only through generation-bearing handles. | Session ID, generation, input, selection, viewport commands |
| Typed IPC -> Rust terminal registry | Rust validates that the handle generation matches the authoritative live session before every read or mutation. | Terminal commands and current session identity |
| React external stores -> runtime controllers | Observable immutable state is separated from mutable channels, pumps, native handles, and DOM interaction resources. | Logical task/tab/layout state versus native runtime objects |
| Mode registry -> lazy adapters | Mode descriptors load adapters dynamically and expose only narrow scope/command ports. | Mode ID, placement, availability, typed commands |
| Pane command ports -> filesystem/native handlers | Components cannot invoke native writes directly; retained shell handlers enforce revision, approval, capability, and containment gates. | Document paths, revisions, write operations, approvals |

---

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-05-01 | Spoofing / Tampering | Terminal session identity | high | mitigate | `TerminalSessionHandle` is required by all 14 frontend session operations; Rust checks generation through the shared gateway. Exhaustive stale/current recycled-ID tables cover every command. | closed |
| T-05-02 | Tampering / Denial of service | External-store snapshots and terminal runtime resources | medium | mitigate | `terminalPanelStore` contains logical state only; channels, pumps, native views, and generation resources live in `terminalRuntimeController`. Post-commit host publication and cleanup tests prevent render-time mutation and stale owners. | closed |
| T-05-03 | Denial of service | Lazy mode import graph | medium | mitigate | All 18 descriptors use dynamic factories and `React.lazy`; architecture and bundle guards reject eager adapter imports. Extensibility drills restore captured source in `finally` and verify the `App.tsx` digest. | closed |
| T-05-04 | Tampering / Elevation of privilege | Pane and mode command ports | high | mitigate | Four-input pane boundaries and `ModeHostCommands` keep raw IPC out of components. Existing approval, revision, capability, write, and path-containment handlers remain authoritative. | closed |

All 44 repeated threat declarations across the 11 PLAN files map to these four unique threats and are closed by the controls above.

---

## Verification Evidence

- `src/lib/api.ts`: all frontend terminal session wrappers accept a nested generation-bearing handle.
- `src-tauri/src/terminal/mod.rs`: every session command passes the authoritative generation gateway; terminal matrix reports 76 passing tests.
- `src/lib/terminalPanelStore.test.ts`: snapshots reject runtime channels, native handles, generation registries, and DOM interaction fields.
- `src/lib/modeRegistry.tsx`, `src/lib/shellDecomposition.test.ts`, `scripts/check-bundle-budget.mjs`: dynamic factories, exhaustive 18-mode coverage, and lazy bundle enforcement.
- `scripts/check-shell-extensibility.mjs`: add-state/add-mode drills use scoped restoration and confirm `App.tsx` stays byte-identical.
- Final canonical gates: 211 Vitest files / 1,942 tests, 1,222 Rust tests, Playwright 203/203, typecheck/lint/fmt/clippy/build/bundle all passed.
- Code review: 68 files, 0 Critical and 0 Warning findings after two fix iterations.

---

## Accepted Risks Log

No accepted risks.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-08-27 | 4 unique / 44 declarations | 4 / 44 | 0 | gsd-security-auditor |

---

## Sign-Off

- [x] All threats have a disposition.
- [x] Accepted risks documented; none accepted.
- [x] `threats_open: 0` confirmed.
- [x] `status: verified` set in frontmatter.

**Approval:** verified 2026-08-27
