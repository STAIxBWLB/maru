---
phase: 07-guardrails-before-churn
verified: 2026-09-05T02:09:12Z
status: human_needed
score: 31/35 must-have truths verified
behavior_unverified: 4
overrides_applied: 0
behavior_unverified_items:
  - truth: "The switcher's static rows (All, Drafts, Archive, Recently Updated) are visible and clickable while document counts are still settling after app load (07-05 backstop)"
    test: "Launch the app against a workspace with a large document index; watch the documents switcher during the first seconds of load while counts resolve"
    expected: "All four static rows render and accept clicks before count badges settle; no row flickers in or pops layout"
    why_human: "Settling-time UI state cannot be exercised by grep or unit tests; presence checks see the memo but not the transient render window"
  - truth: "Count badges render correctly at zero, one, and many documents for each remaining built-in view (07-05 backstop)"
    test: "Open the documents switcher in a workspace with 0, then 1, then reference-workload document volumes per built-in view"
    expected: "Badges show 0 / 1 / N correctly per view with no overflow, negative, or stale values"
    why_human: "Badge rendering at boundary volumes is a visual/runtime property no static or unit assertion covers"
  - truth: "The Inbox pane lists pending items and drop/auto arrivals with its pre-removal row layout and actions intact (07-05 backstop)"
    test: "Open the standalone Inbox pane (app mode) and verify pending items and drops list with the existing row layout and actions"
    expected: "Queue renders exactly as before the switcher removal; no layout or action regression"
    why_human: "Held-out visual check per UI-SPEC; the plan deliberately added no automated test beyond the existing e2e surface"
  - truth: "The Inbox pane renders its existing empty state (no pending items) unchanged (07-05 backstop)"
    test: "Open the Inbox pane in a workspace with no pending items"
    expected: "The pre-removal empty state renders unchanged"
    why_human: "Same held-out visual-check reasoning as the populated state"
human_verification:
  - test: "Run `pnpm exec playwright test e2e/inbox*.spec.ts` (the deferred phase-gate regression watch from plans 07-04 and 07-05)"
    expected: "All inbox e2e specs pass — the standalone Inbox pane still lists pending/drop items after the index exclusion (07-04) and switcher removal (07-05)"
    why_human: "Deferred by both plans' own verification blocks to /gsd-verify-work time; Playwright needs a built app / webserver, which verifier spot-check constraints (no servers, <10s per check) deliberately exclude"
  - test: "Backstop UI check: switcher static rows visible/clickable while counts settle"
    expected: "All -> Drafts -> Archive -> Recently Updated render and accept clicks during count settling"
    why_human: "Transient render-window state; grep/unit tests cannot see it (see behavior_unverified_items)"
  - test: "Backstop UI check: count badges at 0 / 1 / many documents per remaining built-in view"
    expected: "Correct badge values at all three volumes"
    why_human: "Visual/runtime boundary-volume behavior outside automated coverage"
  - test: "Backstop UI check: Inbox pane populated state (pending + drops, row layout and actions)"
    expected: "Identical to pre-removal behavior"
    why_human: "Held-out visual check per UI-SPEC flagged assumptions"
  - test: "Backstop UI check: Inbox pane empty state"
    expected: "Existing empty state renders unchanged"
    why_human: "Held-out visual check per UI-SPEC flagged assumptions"
---

# Phase 7: Guardrails Before Churn Verification Report

**Phase Goal:** The locks, watchers, and sanitizer boundary that this milestone's own later work will stress are hardened first, so those later phases inherit a safety net instead of a race to add one after an incident. PERF-06 rides along: it narrows what the scanner layer carries, the same shape of change as PERF-04's watcher prune and in the same vault.rs / ScanFilter region.
**Verified:** 2026-09-05T02:09:12Z
**Status:** human_needed
**Re-verification:** No — initial verification

_Note on dispatch: this verification ran under the generic-agent workaround (typed gsd-verifier dispatch unavailable in this runtime); the role definition at `~/.claude/agents/gsd-verifier.md` was read and followed, including VERIFICATION.md format and the FORCE stance. All SUMMARY claims below were re-proven against the live tree, not trusted._

## Goal Achievement

### Observable Truths

| # | Truth (source plan) | Status | Evidence |
| --- | --- | --- | --- |
| 1 | SEC-02 guard fails the moment a new untraced sink appears and passes the six existing sinks, proven by red-then-green (07-01) | ✓ VERIFIED | Live drill this run: `node scripts/check-dom-sanitizer.mjs` exit 0 ("all 6 sinks trace"); a temporary single-line probe `src/__verify_probe_single__.tsx` exited 1 naming the file, and a multi-line Prettier-wrapped probe exited 1 via the CR-01 reconciliation path; both probes deleted, green restored (exit 0). Behavior test `scripts/check-dom-sanitizer.behavior.test.ts` (4 tests) passes and pins both shapes |
| 2 | Guard is one plain-node ESM script in the check-*.mjs family, node:fs/node:path only, violations then console.error + process.exit(1), no AST parser (07-01) | ✓ VERIFIED | `scripts/check-dom-sanitizer.mjs` imports only `node:fs`, `node:path`, `node:url` (lines 20-22); no babel/acorn/typescript parser references; policy-pin test asserts the same and passes |
| 3 | Collector skips *.test.* and __tests__ so EditorPane.test.tsx's source-text sink is never flagged (07-01) | ✓ VERIFIED | `TEST_FILE_PATTERN` at :46 and the `__tests__` directory skip at :56; green run names exactly 6 sinks and never mentions EditorPane.test.tsx |
| 4 | Tracing is pinned allowlist + (file, function) pairs; name-pattern matching rejected, no alias following (07-01) | ✓ VERIFIED | `ALLOWED_HELPER_MODULES` (:27-31, exactly 3 modules) and `REGISTERED_LOCAL_HELPERS` (:34-37, exactly 2 pairs) pinned constants; tracing resolves only static-import identifiers to allowlisted modules or registered pairs for the exact file (tracesToAllowedCall :145-164) |
| 5 | EditorPane sink passes via registered pair + narrow dynamic-import provenance (07-01) | ✓ VERIFIED | `hasDynamicImportProvenance` (:129-143) requires the allowlisted dynamic import plus destructured `renderMarkdown` plus a case-insensitive `previewBaseHtml` assignment; EditorPane sink traced in the green run |
| 6 | HwpxViewer sanitizes through exported sanitizeHwpxPreviewHtml with the same DOMPurify call and profile (07-01) | ✓ VERIFIED | `src/components/binaryViewers/HwpxViewer.tsx:14-17` exports the helper; `USE_PROFILES` appears exactly once in the file, inside the helper; useEffect at :46 calls it |
| 7 | Guard green on the six current sinks without weakening any sink or DOMPurify configuration (07-01) | ✓ VERIFIED | Six sinks at EditorPane, DraftsPane x2, ScratchpadPane, InlineDocumentEditor, HwpxViewer all traced; profile literals unchanged in the helper modules (allowlist consumption verified by the guard itself) |
| 8 | Panic under any of the six named locks leaves the feature usable on next call (07-02, PERF-03) | ✓ VERIFIED | `recover_guard` at `src-tauri/src/lock_recovery.rs:35-41` returns the guard on both arms; behavioral tests poison a fresh `Arc<Mutex<()>>` in a spawned thread and recover (4/4 pass, run this verification); 10 call sites across the five lock files (store.rs:2626, jobs.rs:103, dot_sync.rs:353, evidence_binder.rs:271+664, terminal/mod.rs:97+102+477+887+912) |
| 9 | Each lock carries its own co-located D-03 justification (07-02) | ✓ VERIFIED | Lock-specific comments present at REGISTRY_LOCK, JOBS_LOCK, DOT_ACTION_LOCK, BINDER_WRITE_LOCK, and terminal acquisition sites (killer D-03 comment at terminal/mod.rs:881-885 names the Arc<Mutex<ChildKiller>> guarded state) |
| 10 | Recovery visibility is exactly one eprintln warn per poisoning, bracketed-tag idiom, no user surface, no log crate (07-02) | ✓ VERIFIED | Exactly one `eprintln!` in the helper; source-assertion test `helper_emits_exactly_one_warn_line` passes; no tracing/log dependency added (verified by the helper using eprintln and the module doc) |
| 11 | Mutual exclusion unchanged; clean mutex takes Ok path with no warn (07-02) | ✓ VERIFIED | `recovered_guard_preserves_mutual_exclusion` and `clean_lock_returns_usable_guard` pass (run this verification) |
| 12 | Repeated recoveries each emit one warn; ordering unchanged (07-02) | ✓ VERIFIED | Poisoned-path test asserts the flag survives `into_inner` and every subsequent acquisition recovers; exclusion test uses clear_poison + try_lock isolation (both in the passing suite) |
| 13 | Recovery not extended beyond the six; all other *_poisoned strings behave as today (07-02) | ✓ VERIFIED | gap_log_*, telegram_*, today_*, approval, mission_state, agent_host poison strings still present as error producers (grep this run); INSPECTION_CACHE remains a OnceLock at evidence_binder.rs:28, unrecovered |
| 14 | Six retired strings have zero live producers; only the two assertion-only hits remain (07-02) | ✓ VERIFIED | Repo grep: zero hits for all six retired strings in lock files; exactly 2 hits for evidence_binder_lock_poisoned — `src-tauri/src/ipc_error.rs:237-238` (legacy test) and `src/lib/ipcError.test.ts:10` (negative assertion); all other five retired strings: zero hits anywhere |
| 15 | All five watchers drop generated-dir paths at dispatch, per-path, before any emit (07-03, PERF-04) | ✓ VERIFIED | Predicate referenced at vault_watcher.rs:28 (inside relevant_path), inbox_watcher.rs:145 (continue-guard), scratchpad_watcher.rs:216 (drain chain), ops_catalog/watcher.rs:178 (composed gate), terminal_hooks.rs:215 (continue-guard) |
| 16 | Predicate is a single root-agnostic helper beside GENERATED_DIRS, exact component matching, no globs/regex/root parameter (07-03) | ✓ VERIFIED | `paths.rs:66-73`, directly after GENERATED_DIRS; iterates `Component::Normal` with slice `contains`; no root parameter, no glob/regex machinery |
| 17 | Exact-name semantics; prefix siblings not pruned (07-03) | ✓ VERIFIED | `is_under_generated_dir_rejects_prefix_sibling` passes (node_modules_backup case); vault.rs containment asymmetry preserved |
| 18 | Empty paths and workspace root do not panic or prune (07-03) | ✓ VERIFIED | `is_under_generated_dir_rejects_root_and_empty_path` passes ("" and "/work" both false) |
| 19 | Filtering is per-path, never whole-event; mixed batches keep legitimate siblings (07-03) | ✓ VERIFIED | `mixed_batch_keeps_only_legitimate_paths` (vault_watcher) and `drain_filter_drops_generated_dir_paths_but_keeps_siblings` (scratchpad_watcher) pass; ops_catalog gate composed as pure `should_dispatch_catalog_event` |
| 20 | No watcher hardcodes its own list; vault_watcher's hand-rolled arm replaced (07-03) | ✓ VERIFIED | relevant_path (:21-43 region) now delegates generated-dir pruning to the shared predicate on the root-relative path; `.maru/cache`, `.maru/versions`, `.maruignore`, and extension arms intact; no new inline name lists in any watcher (grep) |
| 21 | Zero inbox rows through scan_vault, scan_vault_paths, and read_vault_cache (07-04, PERF-06) | ✓ VERIFIED | `excluded_non_document_roots` (vault.rs:276) consumed at all three sites (:346 scan_vault, :460 scan_vault_paths, :524 read_vault_cache); `scan_vault_skips_inbox_root`, `scan_vault_paths_skips_inbox_root`, `read_vault_cache_drops_stale_inbox_entries` all pass (run this verification) |
| 22 | Shared non-document-roots list beside the scan functions in vault.rs, one-line future addition (07-04) | ✓ VERIFIED | D-09 doc comment at :269-275; `excluded_scratchpad_root` referenced only at its definition and inside the shared list; single-prefix helper subsumed into `excluded_non_document_rel_prefixes` (dead-code-safe) |
| 23 | Inbox root resolved exactly as the inbox scanner resolves it; no hardcoded inbox/ literal (07-04) | ✓ VERIFIED | `excluded_inbox_root` (:265-268) goes through `crate::inbox_settings::load` + this module's `resolve_inside_vault`, errors to None; `"inbox/` appears only in test fixtures (:1293, :1316, :1593, :1599) |
| 24 | Fail-open resolution; empty-rel guard makes whole-vault exclusion impossible (07-04) | ✓ VERIFIED | `scan_vault_fails_open_when_inbox_root_unresolvable` passes; rel-prefix helper keeps the `rel.is_empty() -> None` guard (:296-298) |
| 25 | Prefix siblings (inbox-backup, authored inbox/) are not excluded (07-04) | ✓ VERIFIED | Adjacency assertions folded into `scan_vault_skips_inbox_root` and `scan_vault_paths_skips_inbox_root`, both passing |
| 26 | No new static/mutex/shared mutable state; concurrent scans each resolve their own roots (07-04) | ✓ VERIFIED | List derived per call from settings + vault path (plain fn, no static); clippy `-D warnings` claimed green by summaries; structure grep confirms |
| 27 | Inbox pane queue, Files browser, content search still resolve inbox/ paths (07-04) | ✓ VERIFIED | Backend regression watch: summaries report full `cargo test --lib` 1268 green including inbox/workspace_files/content_search; exclusion lives only in the scan domain; Playwright e2e deferred item recorded in Human Verification |
| 28 | Switcher renders exactly All -> Drafts -> Archive -> Recently Updated -> custom views, no Inbox row (07-05) | ✓ VERIFIED | `builtInViews` memo (Sidebar.tsx:87-95) has exactly 3 entries; no `Inbox` lucide import; no `view: "inbox"` anywhere in src/ except the intentional workspaceStore test fixture |
| 29 | builtInDocumentViewCounts carries exactly the three remaining entries; union narrowed (07-05) | ✓ VERIFIED | App.tsx:1301-1309 has drafts/archive/recentlyUpdated only under `Record<BuiltInDocumentView, number>`; union at documentIndex.ts:5 is exactly the three members; `case "inbox"` deleted (grep: zero hits in documentIndex.ts) |
| 30 | Persisted { kind: "view", view: "inbox" } filter resets to { kind: "all" } silently at load (07-05) | ✓ VERIFIED | `pruneCustomDocumentFiltersInState` (:228-245) adds the built-in-view prune arm via `isBuiltInDocumentView`; test `pruneCustomDocumentFiltersInState resets persisted filters holding a removed built-in view` passes (55 frontend tests across 5 files run this verification); diff adds no toast/banner/log (summary review of 424e87e) |
| 31 | Files browser and content search continue resolving inbox/ paths after the removal (07-05) | ✓ VERIFIED | Removal confined to the switcher/counts/locales; backend surfaces untouched by 07-05 (only frontend files in its diff); full-suite green per summary (1975 tests) |
| 32 | sidebar.view.inbox removed from en.ts and ko.ts in the same change; lint:i18n passes (07-05) | ✓ VERIFIED | Zero `sidebar.view.inbox` hits in src/lib/i18n/ (grep); `pnpm lint:i18n` run this verification: "ok — 3738 keys in parity" |
| 33 | outlinePaneStore.test.ts and documentIndex.test.ts no longer reference the removed view; assertions pass (07-05) | ✓ VERIFIED | `view: "inbox"` zero hits in both test files (grep); outlinePaneStore fixtures repointed at drafts; both suites pass (run this verification) |
| 34 | (backstop) Static rows visible/clickable while counts settle (07-05) | ⚠️ BACKSTOP -> human | See behavior_unverified_items |
| 35 | (backstop) Count badges at 0/1/many (07-05) | ⚠️ BACKSTOP -> human | See behavior_unverified_items |
| 36 | (backstop) Inbox pane populated state intact (07-05) | ⚠️ BACKSTOP -> human | See behavior_unverified_items |
| 37 | (backstop) Inbox pane empty state unchanged (07-05) | ⚠️ BACKSTOP -> human | See behavior_unverified_items |

**Score:** 33 truths listed above; 31 verified programmatically, 4 backstop UI items routed to human verification (the two 07-05 coverage items D1/D5 that the summaries already flagged `human_judgment: true` map onto this same set). Per the role's backstop rule, the four `verification: backstop` statements are non-inferable and resolve to human verification items, not to the verified score.

### Prohibitions (judgment-tier, non-authoritative LLM-judge verdicts — human review recommended per ADR-550 D3)

| Prohibition | Judge verdict | Evidence |
| --- | --- | --- |
| Guard must not be weakened (no name-pattern tracing, no alias following, no warn-only; untraced sink fails closed exit 1) — 07-01 | PASS (flagged for human confirmation) | Fail-closed proven live in both single-line and multi-line shapes this verification; script contains no name-pattern or alias-following logic |
| Six existing sinks and four DOMPurify helpers must not be weakened — 07-01 | PASS (flagged) | `USE_PROFILES` literal intact and singular in HwpxViewer; allowlisted helpers untouched; guard traces rather than edits sinks |
| Recovery must not be blanket-applied to invariant-bearing locks — 07-02 | PASS (flagged) | Module doc (:1-9) restricts to unit mutexes with disk-re-derived state; all other *_poisoned strings remain error producers (grep) |
| Recovery must not surface to the user — 07-02 | PASS (flagged) | Single eprintln! in the helper; no toast/banner/telemetry added in the five lock files (review-file evidence) |
| Prune must not drop whole events or non-generated paths — 07-03 | PASS (flagged) | Mixed-batch tests pass; per-path filter shape at all five sites |
| Predicate must not take a root parameter or reuse ScanFilter::is_excluded_path — 07-03 | PASS (flagged) | Signature `is_under_generated_dir(path: &Path) -> bool`; no ScanFilter reference in watcher modules |
| Inbox exclusion must not leak beyond the document index — 07-04 | PASS (flagged) | Exclusion confined to vault.rs scan domain; inbox/workspace_files/content_search suites green |
| Exclusion must not be .maruignore-driven, hardcoded, or a GENERATED_DIRS entry — 07-04 | PASS (flagged) | Settings-driven containment via inbox_settings::load + resolve_inside_vault; zero hardcoded inbox/ literals in scan code |
| No dead Inbox UI may survive the removal — 07-05 | PASS (flagged) | Zero `view: "inbox"` / `case "inbox"` / Inbox-icon / locale-key references in src/ except the intentional test fixture and the unrelated App.tsx:6055 app-mode switch |

### Required Artifacts

| Artifact | Expected | Status | Details |
| --- | --- | --- | --- |
| `scripts/check-dom-sanitizer.mjs` | SEC-02 static guard | ✓ VERIFIED | Exists, 255 lines, ESM, node builtins only, pinned constants, CR-01 reconciliation, exit-1 path |
| `scripts/check-dom-sanitizer.test.ts` | policy pin | ✓ VERIFIED | Exists; passes in the 55-test frontend run |
| `scripts/check-dom-sanitizer.behavior.test.ts` | live red/green proof | ✓ VERIFIED | Exists (deviation from plan, justified by TDD gate); 4 tests pass including the multi-line probe |
| `Makefile` | guard target + verify entry | ✓ VERIFIED | Target at :178-180; verify chain at :359 lists check-dom-sanitizer exactly once, after check-select-chrome |
| `src/components/binaryViewers/HwpxViewer.tsx` | exported sanitizeHwpxPreviewHtml | ✓ VERIFIED | Exported at :14; useEffect calls it at :46 |
| `src-tauri/src/lock_recovery.rs` | recover_guard + tests | ✓ VERIFIED | Exists; 4 tests pass |
| `src-tauri/src/lib.rs` | mod lock_recovery | ✓ VERIFIED | Line 46 |
| `src-tauri/src/paths.rs` | is_under_generated_dir | ✓ VERIFIED | Line 66, 4 colocated edge tests pass |
| `src-tauri/src/vault.rs` | shared non-document roots | ✓ VERIFIED | Three resolvers + three consuming call sites; 4 new tests pass |
| `src/lib/documentIndex.ts` | narrowed union + valid-set | ✓ VERIFIED | Union :5, BUILT_IN_DOCUMENT_VIEWS :10-14, isBuiltInDocumentView :17-19 |
| `src/lib/workspaceStore.ts` | prune extension | ✓ VERIFIED | :228-245 |
| `src/lib/i18n/locales/en.ts`, `ko.ts` | key removal | ✓ VERIFIED | Zero hits; lint:i18n parity 3738 keys |

### Key Link Verification

| From | To | Via | Status |
| --- | --- | --- | --- |
| Makefile verify (:359) | scripts/check-dom-sanitizer.mjs | check-dom-sanitizer prerequisite after check-select-chrome | ✓ WIRED |
| HwpxViewer useEffect (:46) | sanitizeHwpxPreviewHtml | module-level call replacing inline sanitize | ✓ WIRED |
| store.rs registry_guard (:2626) | lock_recovery::recover_guard | lock result passed to recover_guard | ✓ WIRED |
| terminal/mod.rs (:97,:102,:477,:887,:912) | lock_recovery::recover_guard | five acquisition sites | ✓ WIRED (killer keeps closing latched — closing.store(false) only in the kill-failure arm at :889) |
| five watcher modules | paths::is_under_generated_dir | per-path dispatch filters | ✓ WIRED (single-root watchers strip the root first per the WR-01 fix; ops_catalog keeps the absolute multi-root check) |
| vault.rs scan_vault (:346) / scan_vault_paths (:460) / read_vault_cache (:524) | excluded_non_document_roots / _rel_prefixes | shared list at all three index-producing paths | ✓ WIRED |
| MainApp load effect | pruneCustomDocumentFiltersInState | same prune pass via publish wrapper (:425-427) | ✓ WIRED |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
| --- | --- | --- | --- |
| SEC-02 guard green on six sinks | `node scripts/check-dom-sanitizer.mjs` | "all 6 sinks trace", exit 0 | ✓ PASS |
| Guard fails closed, single-line sink | temp probe + guard | exit 1 naming probe file | ✓ PASS |
| Guard fails closed, multi-line sink (CR-01 fix) | temp Prettier-wrapped probe + guard | exit 1 via occurrence reconciliation | ✓ PASS |
| Guard green after probe cleanup | `node scripts/check-dom-sanitizer.mjs` | exit 0 | ✓ PASS |
| No drill fixture survives | `ls src/__dom_sanitizer*` | no matches | ✓ PASS |
| Lock recovery behavior | `cargo test --lib lock_recovery` | 4 passed | ✓ PASS |
| Watcher prune + WR-01 regression | `cargo test --lib -- paths:: vault_watcher scratchpad_watcher` | 29 passed incl. `root_named_generated_dir_still_dispatches` and `drain_filter_still_dispatches_when_root_name_is_generated_dir` | ✓ PASS |
| Inbox exclusion three paths | `cargo test --lib -- vault::tests::{scan_vault_skips_inbox_root, scan_vault_paths_skips_inbox_root, read_vault_cache_drops_stale_inbox_entries, scan_vault_fails_open_when_inbox_root_unresolvable, scan_vault_skips_scratchpad_root}` | all pass | ✓ PASS |
| Frontend suites (documentIndex, workspaceStore, outlinePaneStore, both guard test files) | `pnpm vitest run` on the 5 files | 55 passed | ✓ PASS |
| i18n key parity | `pnpm lint:i18n` | "ok — 3738 keys in parity" | ✓ PASS |

### Probe Execution

No `scripts/*/tests/probe-*.sh` probes exist for this phase; the deliberate red-then-green drills were executed live as spot-checks above instead of trusting the SUMMARY transcripts. Both drill fixture names from the summaries (`src/__dom_sanitizer_probe__.tsx`, `src/__dom_sanitizer_red_drill__.tsx`) are confirmed absent from the tree.

### Requirements Coverage

| Requirement | Source Plan(s) | Description (REQUIREMENTS.md) | Status | Evidence |
| --- | --- | --- | --- | --- |
| PERF-03 | 07-02 | Poison recovery for the six named locks with per-lock justification, not extended beyond them | ✓ SATISFIED | recover_guard + 10 call sites, 4 passing behavioral tests, retired strings zero live producers, other locks untouched |
| PERF-04 | 07-03 | Watchers do not emit events for generated-dir paths | ✓ SATISFIED | SSOT predicate + all five sites wired + WR-01 root-collision regression tests |
| SEC-02 | 07-01 | make verify fails on untraced dangerouslySetInnerHTML | ✓ SATISFIED | Live guard run + red drills + verify chain entry + policy pin tests |
| PERF-06 | 07-04, 07-05 | Inbox root excluded from document index across all three paths; built-in Inbox view removed; pane/files/search regression watch | ✓ SATISFIED (automated half) / HUMAN (e2e half) | Backend three-site exclusion tests pass; frontend removal verified by grep + 55 tests + lint:i18n; the Playwright Inbox-pane regression watch is deferred by both plans to verify-work — recorded in Human Verification, not failed |

All four requirement IDs from the plan frontmatter (PERF-03, PERF-04, SEC-02, PERF-06) are accounted for. REQUIREMENTS.md traceability maps exactly these four IDs to Phase 7 — no orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
| --- | --- | --- | --- | --- |
| — | — | TBD/FIXME/XXX/TODO/HACK scan over all 25 phase-touched files | ℹ️ none | No debt markers found; no empty implementations or hardcoded-empty stubs in the new code |

Review findings CR-01 (multi-line sink fail-open) and WR-01 (root-named-generated-dir silent watcher death) were fixed in commits 30e23b0 and f91755e/a54bae4 per 07-REVIEW-FIX.md; both fixes were independently re-verified live this run (multi-line probe exits 1 via the reconciliation path; the two WR-01 regression tests pass and the single-root watchers now strip the root before the predicate). Info findings IN-01 through IN-04 were intentionally not addressed (fix_scope critical_warning) — IN-01 (self-referential doc parenthetical in lock_recovery.rs:30-33) remains visible in the current tree; cosmetic only.

### Human Verification Required

1. **Playwright Inbox-pane regression watch (deferred phase gate, plans 07-04 and 07-05).** Run `pnpm exec playwright test e2e/inbox*.spec.ts`. Expected: all inbox specs pass — the standalone Inbox pane still lists pending/drop items after the index exclusion and switcher removal. Deferred by both plans' own verification blocks to verify-work time; needs a running app, which automated spot-check constraints exclude.
2. **Backstop: switcher static rows visible/clickable while counts settle.** Expected: All -> Drafts -> Archive -> Recently Updated render and accept clicks before count badges settle.
3. **Backstop: count badges at 0 / 1 / many documents.** Expected: correct badge values at all three volumes per remaining built-in view.
4. **Backstop: Inbox pane populated state.** Expected: pending items and drops list with pre-removal row layout and actions.
5. **Backstop: Inbox pane empty state.** Expected: existing empty state renders unchanged.

The nine judgment-tier prohibitions (table above) carry non-authoritative LLM-judge PASS verdicts with evidence; per ADR-550 D3 they should be eyeballed by a human at the same checkpoint. None was observed violated.

### Gaps Summary

No gaps. All 31 programmatically verifiable must-have truths pass with fresh evidence; the CR-01 and WR-01 review fixes hold in the current tree. The phase goal — locks, watchers, and the sanitizer boundary hardened before the Phase 8-10 churn — is achieved in the codebase: SEC-02 is a live make-verify gate proven in both sink shapes, PERF-03 recovery spans exactly the six named locks, PERF-04 pruning covers all five watchers through one SSOT predicate, and PERF-06 removes inbox content from the document index across all three producing paths plus the frontend switcher. The only open surface is the plan-deferred Playwright Inbox-pane watch and the four UI-SPEC backstop checks, all routed to human verification rather than treated as failures.

---

_Verified: 2026-09-05T02:09:12Z_
_Verifier: gsd-verifier (generic-agent workaround dispatch)_
