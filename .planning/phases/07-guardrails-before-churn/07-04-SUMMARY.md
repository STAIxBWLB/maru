---
phase: 07-guardrails-before-churn
plan: 04
subsystem: document-index-scanning
tags: [perf-06, inbox-exclusion, non-document-roots, vault-scanning, rust, tauri]

requires:
  - phase: 07-guardrails-before-churn
    provides: the phase's D-09/D-10 decisions and the scratchpad exclusion precedent at vault.rs's three call sites
provides:
  - "vault.rs::excluded_non_document_roots / excluded_inbox_root / excluded_non_document_rel_prefixes — the D-09 shared non-document-roots list (scratchpad + settings-driven inbox root), fail-open, empty-rel guarded"
  - "All three index-producing paths (scan_vault walk filter, scan_vault_paths containment, read_vault_cache rel-prefix filter) consuming the shared list — a targeted rescan can no longer re-inject rows the full scan pruned"
affects: [phase-07, perf-06, plan-07-05, inbox-pane, document-index]

actuals:
  tokens: 2534
  tasks: 2
  commits: 4

tech-stack:
  added: []
  patterns:
    - "excluded_non_document_roots(vault) -> Vec<PathBuf>: per-call collection from excluded_scratchpad_root + excluded_inbox_root; no static/mutex/shared mutable state, so concurrent scans each resolve their own roots"
    - "excluded_inbox_root mirrors excluded_scratchpad_root's fail-open Option shape: inbox_settings::load (missing/malformed -> defaults) + resolve_inside_vault lexical containment, errors discarded to None"
    - "rel-prefix filter form: strip_prefix(vault), lossy, \\ -> /, trailing slash, empty-rel guard (a root equal to the vault contributes no prefix, so the whole vault can never be pruned)"
    - "scan-time exclusion is root-equality/containment against resolved absolute roots; cache-time exclusion is the relPath prefix form — the asymmetry is deliberate (RESEARCH Pitfall 1)"

key-files:
  created: []
  modified:
    - src-tauri/src/vault.rs

key-decisions:
  - "excluded_scratchpad_rel_prefix deleted rather than kept alongside the generalized excluded_non_document_rel_prefixes — after read_vault_cache switched to the shared list the single-prefix helper had zero callers and would fail clippy -D warnings as dead code; its logic (trailing slash, backslash replacement, empty-rel guard) is preserved verbatim inside the generalized helper"
  - "the adjacency and fail-open behavior bullets are pinned as separate committed tests (scan_vault_skips_inbox_root carries the inbox-backup assertion; scan_vault_fails_open_when_inbox_root_unresolvable writes an escaping inboxRoot) so T-7-11 and the fail-open truth are independently re-runnable"
  - "no scan_vault_paths RED commit for Task 2: the containment test rides the Task 2 implementation commit because the shared-list resolver it depends on was proven green by the Task 1 tracer gate — Task 2's own diff is a mechanical third call-site widening"

patterns-established:
  - "A tree browsed in its own pane is not document-index content: new non-document roots are added in exactly one place (excluded_non_document_roots), resolved settings-driven through the owning pane's own loader"

requirements-completed: [PERF-06]

coverage:
  - id: D1
    description: "Zero inbox rows via full scan: scan_vault excludes the settings-driven inbox root (default inbox/downloads) and keeps prefix siblings (inbox-backup) indexed"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "src-tauri/src/vault.rs#scan_vault_skips_inbox_root (cargo test --lib vault: 92 passed)"
        status: pass
    human_judgment: false
  - id: D2
    description: "Zero inbox rows via cache read: stale caches holding inbox rows self-heal at read time while other entries survive in order"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "src-tauri/src/vault.rs#read_vault_cache_drops_stale_inbox_entries (cargo test --lib vault: 92 passed)"
        status: pass
    human_judgment: false
  - id: D3
    description: "Resolution is fail-open and the empty-rel guard holds: an inbox root escaping the vault keeps scanning listing everything; the vault root itself can never be excluded"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "src-tauri/src/vault.rs#scan_vault_fails_open_when_inbox_root_unresolvable; empty-rel guard asserted by excluded_non_document_rel_prefixes construction (grep: no prefix produced for empty rel)"
        status: pass
    human_judgment: false
  - id: D4
    description: "Zero inbox rows via targeted rescan: scan_vault_paths containment skips any path under an excluded root, closing the ROADMAP Note re-injection hazard"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "src-tauri/src/vault.rs#scan_vault_paths_skips_inbox_root (cargo test --lib vault: 92 passed)"
        status: pass
    human_judgment: false
  - id: D5
    description: "Inbox pane, Files browser, and content search still resolve inbox paths: the exclusion stays inside the document index and the regression watch suites stay green"
    requirement: PERF-06
    verification:
      - kind: unit
        ref: "cargo test --lib 1268 passed, 0 failed (inbox, workspace_files, content_search suites green); cargo clippy --lib -- -D warnings exit 0; cargo fmt --check exit 0"
        status: pass
      - kind: e2e
        ref: "pnpm exec playwright test e2e/inbox*.spec.ts — phase gate, deferred to /gsd-verify-work per plan-level verification block"
        status: unknown
    human_judgment: true
    rationale: "The plan-level verification explicitly schedules the Inbox-pane Playwright regression watch at /gsd-verify-work time, not inside any task; the backend suites prove the index-side contract only"

duration: 15min
completed: 2026-09-05
status: complete
---

# Phase 7 Plan 4: PERF-06 Inbox Index Exclusion (Backend) Summary

**The scratchpad exclusion is widened into a D-09 shared non-document-roots list in `vault.rs` — scratchpad root plus a settings-driven inbox root resolved through the inbox scanner's own `inbox_settings::load` + `resolve_inside_vault` path — consumed by all three index-producing paths (`scan_vault` walk filter, `scan_vault_paths` containment, `read_vault_cache` rel-prefix self-heal), so a targeted rescan can no longer re-inject inbox rows a full scan just pruned.**

## Performance

- **Duration:** ~15 min
- **Started:** 2026-09-05T00:51:00Z
- **Completed:** 2026-09-05T01:06:22Z
- **Tasks:** 2
- **Files modified:** 1

## Accomplishments
- `excluded_inbox_root` mirrors `excluded_scratchpad_root`'s fail-open `Option` shape: per-vault `inbox_settings::load` (missing/malformed settings yield defaults; an escaping root fails `resolve_inside_vault` and excludes nothing), so settings trouble keeps listing rather than bricking the scan (T-7-10). No literal `inbox/` prefix is hardcoded in scan-side code — the root is user-retargetable through `.maru/inbox.json`.
- `excluded_non_document_roots` (D-09) collects scratchpad + inbox roots per call — no static, mutex, or shared mutable state, so concurrent `scan_vault`/`scan_vault_paths` calls each resolve their own roots. The rel-prefix form keeps the empty-rel guard: a root resolving to the vault itself contributes no prefix, making whole-vault exclusion impossible (T-7-11).
- All three call sites consume the shared list: the `scan_vault` walk filter's root-equality skip (nested-roots, generated-dirs, and maruignore arms untouched), the `scan_vault_paths` containment skip (`path.starts_with(root)`, closing the ROADMAP Note re-injection hazard — T-7-12), and the `read_vault_cache` stale-entry drop (self-heal comment extended to name the inbox root alongside scratchpad).
- Four inbox tests committed: the `scan_vault` and `read_vault_cache` twins of the scratchpad tests plus the `inbox-backup` adjacency assertion (in T-7-11's prefix-sibling test) and the fail-open escape-settings test.

## Task Commits

Each task was committed atomically:

1. **Task 1 RED: failing inbox exclusion tests** - `ba8fce9` (test)
2. **Task 1 GREEN: shared non-document roots + scan_vault/read_vault_cache widening** - `ca014b3` (feat)
3. **Task 2: scan_vault_paths containment widening + three-site sweep + regression watch** - `926c4bc` (feat)

_Note: Task 1 is a tdd="true" tracer — RED verified failing (the two twin tests fail because no exclusion exists), tracer `<verify>` re-run green end-to-end (vault 92/92, clippy) before Task 2 expansion per the #3299 row-3 gate (interactive, end-of-phase, automated-only verify)._

**Plan metadata:** see final docs commit below.

## Files Created/Modified
- `src-tauri/src/vault.rs` — `excluded_inbox_root`, `excluded_non_document_roots`, `excluded_non_document_rel_prefixes`; all three scan/cache call sites widened; `excluded_scratchpad_rel_prefix` subsumed and removed; four new tests

## Decisions Made
- Deleted `excluded_scratchpad_rel_prefix` instead of keeping it beside the generalized helper: after `read_vault_cache` switched to the shared list it had zero callers and would fail the clippy `-D warnings` gate as dead code. Its trailing-slash / backslash-replacement / empty-rel-guard logic survives verbatim inside `excluded_non_document_rel_prefixes`.
- Folded the `inbox-backup` adjacency assertion into `scan_vault_skips_inbox_root` and authored the fail-open escape-settings case as its own test (`scan_vault_fails_open_when_inbox_root_unresolvable`) so T-7-11 and the fail-open truth fail independently.
- Task 2 carries no separate RED commit: the containment test depends on the Task 1 tracer-proven resolver, and the plan's own `<action>` folds the test into the widening task.

## Deviations from Plan

### Auto-fixed Issues

None — no Rule 1-3 events. Two plan-shape notes (deliberate, documented above):

**1. [Plan shape — helper subsumption] `excluded_scratchpad_rel_prefix` removed rather than retained**
- **Found during:** Task 1 GREEN
- **Issue:** The acceptance criterion anticipates the rel-prefix helper surviving alongside the shared list; a zero-caller private fn fails `clippy -D warnings`.
- **Fix:** Subsumed into `excluded_non_document_rel_prefixes` (logic preserved); the three-site grep now shows `excluded_scratchpad_root` referenced only at its definition and inside `excluded_non_document_roots`.
- **Files modified:** src-tauri/src/vault.rs
- **Verification:** `cargo clippy --lib -- -D warnings` exit 0; consistency grep clean
- **Committed in:** `ca014b3` (Task 1 GREEN commit)

**2. [Plan shape — RED scope] `scan_vault_fails_open_when_inbox_root_unresolvable` passed in RED**
- **Found during:** Task 1 RED
- **Issue:** The TDD fail-fast rule flags tests passing unexpectedly in RED; this behavior bullet (settings escape keeps scanning listing) is the status quo before any exclusion exists.
- **Fix:** Investigated and confirmed: fail-open is inherent to the absent resolver, so the test legitimately passes in RED and guards the GREEN refactor against regression. Documented here per the fail-fast protocol.
- **Files modified:** none beyond the RED test itself
- **Verification:** RED run output — 89 passed / 2 failed, failures are exactly the two twin tests
- **Committed in:** `ba8fce9` (RED commit)

---

**Total deviations:** 0 auto-fixed (Rules 1-3); 2 documented plan-shape notes
**Impact on plan:** None on behavior — both notes follow the plan's must_haves (fail-open, no dead code under the clippy gate) more strictly than the literal line references.

## TDD Gate Compliance

- RED gate: `test(07-04)` commit `ba8fce9` — `cargo test --lib vault` fails with exactly `scan_vault_skips_inbox_root` and `read_vault_cache_drops_stale_inbox_entries` (assertion failures: no exclusion exists yet). The fail-open test passes in RED by design (status quo behavior it guards).
- GREEN gate: `feat(07-04)` commit `ca014b3` — `cargo test --lib vault` 91 passed / 0 failed; `cargo clippy --lib -- -D warnings` exit 0.
- Tracer feedback gate (#3299 row 3): tracer `<verify>` re-run end-to-end green before Task 2 expansion — no checkpoint (interactive run, `human_verify_mode` defaults to end-of-phase, verify is automated-only).
- No REFACTOR commit needed (`cargo fmt` changes rode the Task 2 commit).

## Issues Encountered
- None. The full `cargo test --lib` run (1268 passed, up from 07-03's 1264 — exactly the four new tests) confirms the Inbox pane queue, workspace_files, and content_search consumers still resolve inbox paths.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Backend half of PERF-06 is live: the reference workspace's ~1,906 inbox rows (issue #309) drop out of the document index through every path that produces one.
- Plan 07-05 (frontend switcher removal) can proceed; the `BuiltInDocumentView` "inbox" case removal is the remaining PERF-06 surface.
- Phase gate deferred to `/gsd-verify-work` per the plan: `pnpm exec playwright test e2e/inbox*.spec.ts` must prove the Inbox pane still lists pending/drop items after the index exclusion (recorded as coverage D5, status unknown until that run).
- Full `make verify` composite not run here; every gate this plan owns was verified individually (vault suite, full `cargo test --lib`, clippy, fmt-check). CI is the authoritative composite check.

## Self-Check: PASSED
- key-file `src-tauri/src/vault.rs` exists on disk: FOUND
- Commits `ba8fce9` / `ca014b3` / `926c4bc` present in `git log`: FOUND
- Plan-level verification re-run after all tasks: `cargo test --lib vault` 92 passed, 0 failed; `cargo test --lib` 1268 passed, 0 failed; `cargo clippy --lib -- -D warnings` exit 0; `cargo fmt --check` exit 0
- Three-site grep: `excluded_scratchpad_root` referenced only at definition, inside `excluded_non_document_roots`, and in doc comments; no `inbox/` literal in scan-side code
- Scratchpad twins (`scan_vault_skips_scratchpad_root`, `read_vault_cache_drops_stale_scratchpad_entries`) pass unchanged

---
*Phase: 07-guardrails-before-churn*
*Completed: 2026-09-05*
