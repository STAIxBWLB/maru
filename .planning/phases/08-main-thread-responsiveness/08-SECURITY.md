---
phase: "08"
slug: main-thread-responsiveness
status: verified
threats_open: 0
asvs_level: 1
created: "2026-09-21"
---

# Phase 8 — Security

> Per-phase security contract: threat register, accepted risks, and audit trail.

---

## Trust Boundaries

| Boundary | Description | Data Crossing |
|----------|-------------|---------------|
| Webview IPC to worker | Owned inputs retain backend permission, containment and revision validation | Tauri command arguments (unbounded strings, paths) |
| Worker to filesystem/process | Scoped serialization preserves current disk state and fixed argv | Workspace paths, secrets, subprocess argv/env |
| Test fixture to native process | Only disposable roots and compile-time gated observation | Synthetic fixtures, disposable Home/config roots |

---

## Threat Register

Authored at plan time across all 29 PLANs (87 unique threats, all `mitigate`).
Executed SUMMARYs record per-threat dispositions; 84 by explicit threat ID,
3 (T-08-10-01/02/03) verified by disposition-equivalent executed tests
(`phase08_10_archive_traversal_and_denied_paths_are_rejected`,
`phase08_10_inbox_raw_tree_denial_leaves_no_partial_output`,
`all_wrappers_yield_on_same_polling_task` across 4 modules,
`failure_release`/`unwind_releases` families, synthetic-fixture/argv tests).

| Threat ID | Category | Component | Severity | Disposition | Mitigation | Status |
|-----------|----------|-----------|----------|-------------|------------|--------|
| T-08-01-01 .. T-08-29-03 (87 threats) | Tampering / Denial of service / Information disclosure | Owned mutation paths, IPC scheduling and lifecycle, errors and evidence | high / medium | mitigate | See per-PLAN `<threat_model>` registers and per-SUMMARY disposition sections | closed |

Full per-threat rows live in the 29 PLANs (`<threat_model>` blocks) and their
executed SUMMARYs; this register summarizes the complete set rather than
duplicating it.

*Status: open · closed · open — below high threshold (non-blocking)*
*Severity: critical > high > medium > low — only open threats at or above workflow.security_block_on count toward threats_open*
*Disposition: mitigate (implementation required) · accept (documented risk) · transfer (third-party)*

---

## Accepted Risks Log

No accepted risks.

---

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|------------|---------------|--------|------|--------|
| 2026-09-21 | 87 | 87 | 0 | Qwen Code orchestrator (secure-phase L1 grep audit) |

Audit method (ASVS L1, block_on high): all 29 PLAN `<threat_model>` blocks
parsed; all 87 dispositions are `mitigate`; SUMMARY disposition evidence
checked per threat ID (84 exact, 3 via executed disposition-equivalent tests).
No open threats remain at or above the high threshold.

---

## Sign-Off

- [x] All threats have a disposition (mitigate / accept / transfer)
- [x] Accepted risks documented in Accepted Risks Log
- [x] `threats_open: 0` confirmed
- [x] `status: verified` set in frontmatter

**Approval:** verified 2026-09-21
