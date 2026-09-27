---
phase: "7"
slug: guardrails-before-churn
status: verified
threats_open: 0
threats_total: 15
threats_closed: 15
asvs_level: 1
block_on: high
register_authored_at_plan_time: true
created: "2026-09-05"
---

# Phase 7 Security Verification

Verified the existing threat registers from all five executed plans against the current implementation. No new risk acceptance was introduced. The ASVS L1 workflow permits inline closure when every planned threat has evidence and no blocking threat remains.

## Trust Boundaries

- Untrusted document HTML to webview sinks, protected by registered DOMPurify provenance and a failing build guard.
- Panic recovery to shared disk-derived state or surviving terminal handles, limited to the six named locks.
- Filesystem events to watcher dispatch, with exact-name, per-path generated-directory pruning.
- Settings-driven inbox roots and stale cache rows to the document index, with lexical containment and three-path exclusion.
- Persisted view IDs to frontend filters, with silent invalid-view reset.

## Threat Register

| Threat ID | Category | Component | Severity | Disposition | Mitigation evidence | Status |
|---|---|---|---|---|---|---|
| T-7-01 | Tampering (stored XSS) | Any new dangerouslySetInnerHTML sink in src/ | high | mitigate | scripts/check-dom-sanitizer.mjs; Makefile check-dom-sanitizer prerequisite; behavioral red/green suite passes for single-line and multiline untraced sinks. | closed |
| T-7-02 | Elevation of privilege (webview code exec) | Sink-provenance spoof — naming a function to look sanitized | high | mitigate | Pinned ALLOWED_HELPER_MODULES and REGISTERED_LOCAL_HELPERS; scripts/check-dom-sanitizer.test.ts passes policy assertions. | closed |
| T-7-03 | Tampering | The guard itself weakened to pass sinks (warn-only, broader allowlist) | medium | mitigate | Guard exits nonzero on untraced sinks; policy and behavioral tests pass; current six sinks trace successfully. | closed |
| T-7-04 | Tampering (integrity) | Blanket `into_inner()` recovery extended to invariant-bearing state | high | mitigate | Ten production call sites remain restricted to skill_host/store.rs, jobs.rs, dot_sync.rs, evidence_binder.rs and terminal/mod.rs. Co-located D-03 comments describe disk-derived state or surviving terminal handles; INSPECTION_CACHE untouched. | closed |
| T-7-05 | Denial of service | Poisoned lock bricks skills/jobs/dot-sync/binder/terminal until app restart | medium | mitigate | cargo test --lib lock_recovery: 4 passed, including poisoned reacquisition and retained mutual exclusion. | closed |
| T-7-06 | Information disclosure | Recovery warn line leaks path or user data to stderr | low | accept | Existing plan disposition retained. recover_guard prints only fixed module tag and lock name; no path or payload. | closed |
| T-7-07 | Denial of service | Event-volume bottleneck under a heavy generated subtree | medium | mitigate | All five watchers call paths::is_under_generated_dir before dispatch; generated-name Rust regression selection: 19 passed. | closed |
| T-7-08 | Tampering (integrity of notifications) | Over-broad matching hides user-content updates | medium | mitigate | Exact component matching, per-path filtering and root-relative single-root checks verified; prefix-sibling, mixed-batch and root-name collision regressions pass. | closed |
| T-7-09 | Tampering | Divergent matching semantics between scanners and watchers | low | mitigate | paths.rs GENERATED_DIRS remains the shared source; watcher consumers call the shared predicate. | closed |
| T-7-10 | Tampering (path traversal) | Settings-driven inbox root escapes vault containment | high | mitigate | excluded_inbox_root calls resolve_inside_vault and returns None on invalid resolution; vault suite passes fail-open and containment tests. | closed |
| T-7-11 | Tampering (integrity of index) | Exclusion over-reach prunes authored content | medium | mitigate | vault suite passes authored-prefix-sibling and settings-driven inbox exclusion cases; rel-prefix generation rejects an empty relative root. | closed |
| T-7-12 | Tampering (integrity of index) | Stale cache re-injects excluded rows | low | mitigate | read_vault_cache uses excluded_non_document_rel_prefixes; stale-inbox-cache regression passes. | closed |
| T-7-13 | Denial of service | Persisted `view: "inbox"` filter crashes or blanks the documents surface after upgrade | medium | mitigate | workspaceStore prune resets removed built-in filters to All; targeted workspaceStore suite passes. | closed |
| T-7-14 | Tampering (i18n integrity) | Removing the view row but leaving its locale keys | low | mitigate | pnpm lint:i18n passes with 3738 keys in parity; removed key absent in both locales. | closed |
| T-7-15 | Information disclosure | Removal surfaces user data unexpectedly | low | accept | Existing plan disposition retained. No data deletion path added; live Inbox UAT displays pending, auto and drop rows independently of the document index. | closed |

## Accepted Risks Log

| Risk ID | Threat Ref | Rationale | Accepted By | Date |
|---|---|---|---|---|
| R-7-01 | T-7-06 | Fixed lock-name warning on local stderr contains no user data. | Existing 07-02-PLAN.md disposition, retained | 2026-09-05 |
| R-7-02 | T-7-15 | UI view removal deletes no underlying data; independent Inbox remains available. | Existing 07-05-PLAN.md disposition, retained | 2026-09-05 |

## Security Audit Trail

| Audit Date | Threats Total | Closed | Open | Run By |
|---|---|---|---|---|
| 2026-09-05 | 15 | 15 | 0 | Codex, inline ASVS L1 verification |

Fresh checks: 33 TypeScript tests across sanitizer behavior, sanitizer policy and workspace state; 4 lock recovery tests; 19 generated-path tests; 38 vault tests passed with one unrelated existing ignored benchmark. Sanitizer guard passes for six sinks; i18n parity passes. Browser evidence and limitations are recorded in 07-UAT.md.

## Sign-Off

- [x] All threats have an existing plan disposition.
- [x] Existing accepted risks documented without expanding acceptance.
- [x] No open threats at any severity.
- [x] `threats_open: 0` and `status: verified` confirmed.

**Approval:** verified 2026-09-05
