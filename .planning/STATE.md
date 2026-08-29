---
gsd_state_version: 1.0
milestone: v1.1
milestone_name: Felt Quality and Native Proof
current_phase: 06
current_phase_name: native-e2e-runner-foundation
status: executing
stopped_at: Completed 06-03-PLAN.md
last_updated: "2026-08-29T10:48:03.468Z"
last_activity: 2026-08-29
last_activity_desc: "ROADMAP.md created for v1.1: 6 phases (6-11), 15/15 requirements mapped"
progress:
  total_phases: 6
  completed_phases: 0
  total_plans: 5
  completed_plans: 3
  percent: 0
---

# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-08-28)

**Core value:** The filesystem stays the source of truth, everything Maru shows is derived from real files the user owns, and nothing is lost if Maru is uninstalled.
**Current focus:** Phase 06 — native-e2e-runner-foundation

## Current Position

Phase: 06 (native-e2e-runner-foundation) — EXECUTING
Plan: 3 of 5
Status: Ready to execute
Last activity: 2026-08-29 — Phase 06 execution resumed (wave continue)

Progress: [██████░░░░] 60%

## Performance Metrics

**Velocity:**

- Total plans completed: 32
- Average duration: -
- Total execution time: -

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 1 | 7 | - | - |
| 2 | 3 | - | - |
| 03 | 4 | - | - |
| 04 | 7 | - | - |
| 05 | 11 | - | - |

**Recent Trend:**

- Last 5 plans: -
- Trend: -

*Updated after each plan completion*
**Per-Plan Metrics:**

| Plan | Duration | Tasks | Files |
|------|----------|-------|-------|
| Phase 01 P01 | 8min | 2 tasks | 2 files |
| Phase 01 P02 | 37min | 3 tasks | 42 files |
| Phase 01-trustworthy-verify-signal P03 | 51min | 3 tasks | 2 files |
| Phase 01 P04 | 20min | 4 tasks | 7 files |
| Phase 01 P05 | 15min | 3 tasks | 8 files |
| Phase 01-trustworthy-verify-signal P06 | 20min | 3 tasks | 4 files |
| Phase 01-trustworthy-verify-signal P07 | 70min | 3 tasks | 30 files |
| Phase 02 P01 | 9min | 3 tasks | 6 files |
| Phase 02 P02 | 5min | 3 tasks | 4 files |
| Phase 02 P03 | 7min | 2 tasks | 3 files |
| Phase 03 P02 | ~50min | 2 tasks | 6 files |
| Phase 03 P03 | 15min | 2 tasks | 9 files |
| Phase 03 P04 | ~35min | 2 tasks | 0 files |
| Phase 04 P01 | 6min | 2 tasks | 4 files |
| Phase 04 P02 | 13min | 2 tasks | 5 files |
| Phase 04-editor-surface-state-extraction P03 | 9min | 2 tasks | 6 files |
| Phase 04 P04 | 12min | 2 tasks | 4 files |
| Phase 04 P05 | 15min | 2 tasks | 8 files |
| Phase 04 P06 | 1h 40min | 2 tasks | 4 files |
| Phase 04 P07 | 13min | 2 tasks | 5 files |
| Phase 05 P01 | 1h 10m | 2 tasks | 8 files |
| Phase 05 P02 | 10m | 2 tasks | 4 files |
| Phase 05 P03 | 14min | 2 tasks | 7 files |
| Phase 05 P04 | 8min | 3 tasks | 8 files |
| Phase 05 P05 | 11min | 2 tasks | 9 files |
| Phase 05 P06 | 9m | 2 tasks | 7 files |
| Phase 05 P07 | 7min | 2 tasks | 7 files |
| Phase 05 P08 | 13min | 2 tasks | 10 files |
| Phase 05 P09 | 7min | 2 tasks | 8 files |
| Phase 05 P10 | 9min | 3 tasks | 9 files |
| Phase 05 P11 | 2h 7m | 3 tasks | 25 files |
| Phase 06 P02 | 55min | 2 tasks | 7 files |
| Phase 06 P03 | 50min | 2 tasks | 4 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- Milestone 1 is structural debt paydown scoped to the Tech Debt section of `.planning/codebase/CONCERNS.md`; no feature work
- Verification gates land in Phase 1 before the App.tsx decomposition, because moving 68 `useState` / 50 `useEffect` without a hook-dependency gate reproduces #260/#262/#264
- The 64 SPEC constraints are invariants to preserve, not features to build; 0 ADRs means none is decision-locked and a future ADR can override any of them
- [Phase 1]: Pinned rust-toolchain.toml to rustc 1.98.0, resolved live via rustup update stable (D-11), not the RESEARCH.md-predicted value
- [Phase 1]: Re-measured clippy count on rustc 1.98.0 matched RESEARCH.md's 75 exactly; 36 auto-fixed via cargo clippy --fix, 39 fixed by hand with zero suppression attributes added
- [Phase 1]: Two too_many_arguments violations on #[tauri::command] IPC boundaries fixed by bundling params into a struct and updating the paired frontend invoke() call in the same commit, rather than adding a new allow(clippy::too_many_arguments)
- [Phase 1]: D-12 held under empirical proof: retain-on-failure captured a first-attempt trace with zero retries in a real CI run (GATE-04)
- [Phase 1]: GATE-04's CI proof required workflow_dispatch, not a branch push, since ci.yml's push trigger is scoped to branches: [main]
- [Phase 1]: skill-name-drift deleted outright from TODO_LEDGER (not marked done) - GATE-07 requires the shipped ledger to list only open items
- [Phase 1]: @types/node@22.20.1 approved at the blocking-human package-legitimacy checkpoint after independent live npm registry re-verification (349.7M weekly downloads, DefinitelyTyped repo)
- [Phase 1]: tsconfig.e2e.json left composite:true out, deviating from the plan's literal action text - it introduced a spurious TS6307 project-boundary error (e2e/workbench-layout.spec.ts importing src/lib/settings.ts) unrelated to the real e2e type backlog; tsc -b accepts the solution-file reference without it
- [Phase 1]: GATE-03 not marked complete in REQUIREMENTS.md - it is one requirement spanning e2e/ and scripts/, and plan 01-04 only finishes the e2e/ half; scripts/ is plan 01-05
- [Phase 1]: Kept composite: true on tsconfig.scripts.json (unlike 01-04's tsconfig.e2e.json deviation); scripts/ has no cross-project import so the TS6307 boundary error 01-04 hit never triggers
- [Phase 1]: Re-measured scripts/ error count: 42 across 8 files, not RESEARCH.md's stored 44/9; all 42 traced to one destructured-options JSDoc-inference gap
- [Phase 1]: GATE-03 marked complete in REQUIREMENTS.md: 01-05 finishes the scripts/ half 01-04 deliberately left open
- [Phase 1]: eslint@10.9.0, typescript-eslint@8.67.0, eslint-plugin-react-hooks@7.1.1 approved at the blocking-human legitimacy checkpoint after independent live-registry re-verification
- [Phase 1]: App.tsx re-measured at 22 real violations (13 no-unused-vars + 9 exhaustive-deps), not the plan's 12+10; deleting one dead useCallback retired a no-unused-vars fix and its paired exhaustive-deps violation together, landing the final committed split at 12+8
- [Phase 1]: make verify's fmt-check failed solely on a concurrent unrelated session's Rust files (hwped.rs, lib.rs) sharing this checkout; reported and not diagnosed per the team lead's instruction, everything in 01-06's own scope (typecheck, test, eslint, cargo test --lib) verified green independently
- [Phase 1]: src/ backlog re-measured at exactly 52 errors + 7 warnings across 28 files, matching 01-06's prediction; e2e/ needed zero fixes (already ESLint-clean and typecheck-clean before this plan touched it)
- [Phase 1]: 12 separate eslint-disable-next-line directives added in one TerminalPanel.tsx unmount-cleanup block (one per ref read ESLint reports independently), not a single block-level disable, to keep every directive individually load-bearing
- [Phase 1]: Positional/required-interface unused args (favoriteIds, settings, warnings, hdbg, headerBg) renamed with a leading underscore rather than deleted, since deletion would have required touching call sites or type signatures outside this plan's fix-not-rewrite mandate
- [Phase 1]: GATE-02 flipped - make lint added to the verify prerequisite list immediately after typecheck, proven red-then-green on both react-hooks/exhaustive-deps and no-unused-vars via deliberate break-and-revert on src/components/today/useTodayTasks.ts
- [Phase 1]: Full make verify could not be proven green on the shared checkout - test-rust failed on 12 outlook_mso timeout tests racing a concurrent session's own cargo test --workspace process, and cargo clippy/fmt-check both fail solely inside the concurrent session's uncommitted src-tauri/src/hwped.rs; neither traces to this plan's diff (zero Rust files touched). Each gate this plan owns was verified individually instead (make lint both directions, pnpm typecheck, pnpm test, make test-e2e, all green); CI is the authoritative composite check, to be triggered by the team lead
- [Phase ?]: [Phase 2]: mod paths; registered between outlook_mso and project_activity (true alphabetical, rustfmt-verified) - plan-stated ops_catalog/outlook_mso slot violates the strictly-alphabetical registry convention
- [Phase ?]: [Phase 2]: vault.rs could_include_dot_folder_named deleted (lost its only caller when rg_visibility went unconditional) rather than kept as dead code under the clippy gate
- [Phase ?]: [Phase 2]: ensure_within error message kept byte-identical (Path escapes the .maru directory) - live user-visible string in a behavior-preserving phase (RESEARCH Pitfall 4)
- [Phase ?]: [Phase 2]: 02-02 union-proof fixture leaves written as .md documents instead of the plan's literal .pyc/extensionless/.py leaves - scan_vault only collects md/markdown/html/htm, so the literal fixture could never go red and the SCAN-02 proof required the change
- [Phase ?]: [Phase 2]: 02-03 guard shape - maru_home()/install_root_base() restructured to a single exit wrapped in require_absolute, so a future early-return cannot bypass the check without restructuring the exit
- [Phase ?]: [Phase 2]: 02-03 env_root()/skills_root() get no separate guard - they derive from maru_home() and are covered transitively; duplicating the check would re-fragment the invariant
- [Phase ?]: [Phase 2]: 02-03 require_absolute's temporary allow(dead_code) removed in the same commit the first consumer landed - closes WINDOWS.md ledger entry 1
- [Phase 3]: 03-01 ratified the 7-command branch-on scope over CONTEXT's "four commands" wording - same four codes, seven commands; graph_link_apply stays display-only and OUT
- [Phase 3]: 03-01 ERR-04 pre-migration baseline measured at B = 1138 before any edit, matching the planning-time figure; 03-02 records against B-10 and 03-04 asserts within [B-20, B]
- [Phase 3]: 03-01 leaves `cargo clippy -- -D warnings` transiently red on three not-yet-consumed code constants rather than adding a suppression attribute - the phase prohibition holds and 03-02 clears it
- [Phase 3]: 03-01's human-verify checkpoint was approved without per-step smoke observations being reported back, so no real-app evidence exists for the migrated path yet
- [Phase ?]: [Phase 3]: 03-02 found web_actions.rs (not in the plan's file list) calls today_mutate and task_transition directly; its call sites and one internal conflict-code branch needed the same map_err adapter / code-based check as the plan's own adapter sites, added as Rule 3 fallout
- [Phase ?]: [Phase 3]: 03-02 also fixed document.rs's update_frontmatter_field (uncalled out in PATTERNS.md), which calls assert_expected_revision directly and needed the same map_err adapter as today_apply_plan_result
- [Phase ?]: [Phase 3]: 03-02 measured the post-migration ERR-04 count at 1128, exactly B-10 against 03-01's baseline B=1138, confirming no signature outside the 10-item migration set changed
- [Phase ?]: [Phase 3]: 03-02 migrated eleven prefix-string test assertions, not the six PATTERNS.md/PLAN.md enumerated by line number, since every unwrap_err() on a migrated command now yields IpcError regardless of which error path fired
- [Phase ?]: All three today_conflict fixture throw sites migrated to raw wire shape (not just the two the plan named by line), keeping the one-normalization-point invariant intact
- [Phase ?]: ERR-01 and ERR-03 marked complete after verifying all four contract codes have a frontend reader and the residual substring-matcher grep is zero; ERR-02 left open for 03-04's formal two-sided rename drill
- [Phase ?]: ERR-02 drill extended to three sub-drills (Rust value pin, Rust name/build, TS union/tsc) so the web_actions.rs:860 branch site is proven build-protected, not just the pin test
- [Phase ?]: Wave 0 contracts remain activation-gated until their owning production plan removes the condition.
- [Phase ?]: Use workspace-keyed, per-domain subscriber maps so file-queue publishes cannot notify document consumers.
- [Phase ?]: Keep queue update and selection transitions pure in outlinePaneStore; reserve OutlinePaneCommands for shell orchestration and persistence effects.
- [Phase ?]: Keep queue progress and actionable failures in the operation slice while notification-only failures continue through errorStore.
- [Phase ?]: OutlinePane now receives only scope, commands, pane ref, and render slots; sidebar and explorer values are facade slices.
- [Phase ?]: The persistence adapter consumes App's existing loadWorkspace request id and never owns a second generation counter.
- [Phase ?]: Workspace cleanup drops only facade-local Outline records, leaving editorTabsStore drafts and MaruSettings untouched.
- [Phase ?]: Editor view modes are workspace and split-group scoped; HTML mode, risk acknowledgement, and operation state remain tab-local transient facade state.
- [Phase ?]: Editor hydration reuses App loadWorkspaceRequestRef and the normalized settings writer; no second generation counter or settings key exists.
- [Phase ?]: Facade cleanup runs after canonical editorTabsStore closes, so it never deletes an unsaved draft itself.
- [Phase ?]: EditorPane now receives only scope, commands, and optional editor refs; all render values are read from keyed facade slices.
- [Phase ?]: EditorPaneCommands objects are stable across App renders and dispatch against current keyed scope and current shell handlers.
- [Phase ?]: Preview markup remains memoized solely on previewHtml and React remains the only preview DOM writer.
- [Phase ?]: Keep HTML view/risk state facade-local so parent App renders cannot replay stale legacy values.
- [Phase ?]: Require a distinct-bundle native WKWebView smoke after deterministic editor-surface gates pass.
- [Phase ?]: MainApp may observe editor tab snapshots while unrelated shell surfaces stay behind stable production memo boundaries.
- [Phase ?]: Render instrumentation observes static target names only and defaults to a no-op.
- [Phase ?]: DocumentList now exposes only scope, commands, searchInputRef, and paneRef; browser state publishes through keyed external-store slices.
- [Phase ?]: Outline composes document selection and filters from documentBrowserStore instead of mirroring browser state.
- [Phase ?]: TerminalSessionHandle is the only frontend identity accepted by session-scoped terminal wrappers.
- [Phase ?]: Rust validates terminal handles against the authoritative registry before every read or mutation.
- [Phase ?]: Unknown terminal kills remain idempotent, but stale recycled handles are rejected.
- [Phase ?]: Terminal reducer state is process-global while launch context is a separate slice.
- [Phase ?]: TerminalPanel accepts only scope, commands, graphNode, and its forwarded ref.
- [Phase ?]: Normalized MaruSettings now has one module-store owner, while MainApp subscribes to its current snapshot.
- [Phase ?]: PKM and E2E descriptors own dynamic loaders, placement, availability, and fallback identity; ActivityRail metadata remains in App.
- [Phase ?]: Graph uses one adapter for primary, right, and terminal-panel placement.
- [Phase ?]: Sites native URLs are ordered visual-mode intents acknowledged after consumption.
- [Phase ?]: Compose canonical tracked missions instead of duplicating mission records in the agent runtime store.
- [Phase ?]: Agents uses a dedicated lazy adapter with only ModeHostScope and ModeHostCommands.
- [Phase ?]: Inbox and Comms render through registry-loaded adapters while retaining their existing typed action and approval ports.
- [Phase ?]: Processed-item state is one controller domain shared by both adapters rather than synchronized copies.
- [Phase ?]: Scratchpad keeps document, autosave, watcher, recovery, and editor state in ScratchpadPane; only shell refresh and settings projections move to knowledgeModeStore.
- [Phase ?]: Drafts and Gap compose canonical workspace, agent-runtime, shell-settings, and visual-mode ownership instead of copying filesystem or approval state.
- [Phase ?]: Gap handoffs use a request nonce so repeated explicit selections of the same draft remain distinguishable after consumption.
- [Phase ?]: Files preview state is transient and rejects responses by request sequence plus selected path.
- [Phase ?]: Files, Studio, and Catalog preserve canonical drafts, capability and revision gates, settings keys, and filesystem commands behind lazy adapters.
- [Phase ?]: Planning adapters use isolated controller slices while canonical task, agent, and settings owners remain external.
- [Phase ?]: Mode registry IDs are typed as MaruAppMode and exhaustively tested across all 18 modes.
- [Phase ?]: MainApp stays below the D-13 ceiling at 15 useState and 24 useEffect calls, with lifecycle ownership in named modules.
- [Phase ?]: Extensibility drills mutate real production source only inside a finally-restored boundary and assert App byte identity.
- [Phase 5]: Direct D-20 native UAT recorded five passed flows covering Documents/filesystem effects, live PTY lifecycle, lazy right/primary placement, stale/current generation coverage, and render isolation.
- [Roadmap]: v1.1 phases 6-11 sequenced with TEST-01 first (Phase 6, native runner - the only way to observe PERF-01/02/03's and REL-01's real behavioral claims), PERF-03/04 plus SEC-02 as early guardrails (Phase 7, no native dependency, SEC-02 landed early precisely because this milestone's own refactor churn produces new unsanitized-sink risk), PERF-02 before PERF-01 in the same phase (Phase 8, PERF-02 rewrites the store.rs region PERF-03 touches and must settle first), REL-01 after TEST-01 (Phase 9, only a real PTY can trap SIGHUP), and the remaining budget/evidence items grouped by no-dependency convenience (Phases 10-11). TEST-01 and REL-01 carry materially higher planning uncertainty and are flagged in ROADMAP.md pending their respective spikes.
- [Phase ?]: [Phase 6]: 06-02 VITE_NATIVE_E2E gate repeated as a literal expression at each register entry point - esbuild folds the statically replaced expression but does not inline a helper call across functions, so calling nativeE2eEnabled() would leak __MARU_NATIVE_E2E__ into production bundles (verified empirically both ways)
- [Phase ?]: [Phase 6]: 06-02 pty.spec clicks the Shell launcher specifically, not the plan's literal first enabled button (Claude), because only a real shell makes the shell-produced-marker assertion meaningful
- [Phase ?]: [Phase 6]: 06-02 native specs use in-page clicks + executeAsync inline poll loops - wdio element commands cost ~10-15s each with withGlobalTauri:false, and probe functions cannot cross the WebDriver boundary
- [Phase ?]: [Phase 6]: 06-02 fixture lifecycle fixes - cleanup only in onComplete (afterSession deleted the shared root under the next spec's app), first per-worker reset skipped (races app boot into Sample Workspace seeding), reset clears contents never watched dirs, mocha timeout 120s
- [Phase ?]: [Phase 6]: 06-03 IME verdicts settled empirically - WebDriver keys never compose on either surface (terminal: literal jamo via insertText; rich editor: no change); synthetic composition events drive both surfaces' real handlers (rich editor needs the engine's DOM mutation paired in), so those halves stay as native regression tests and OS-level IME stays human-attended (D-08)
- [Phase ?]: [Phase 6]: 06-03 Radix Tabs triggers activate on mousedown not click, and ProseMirror adopts synthetic composition only with the DOM mutation paired - both mechanics now encoded in ime.spec.ts

### Pending Todos

[From .planning/todos/pending/ - ideas captured during sessions]

None yet.

### Blockers/Concerns

- **Phase 3's ERR-04 count band is coupled to `hwped.rs`.** The pinned command reports 1,138, and `hwped.rs` contributes 19 of those matches; without it the tree reads 1,119 and the post-migration count lands at 1,109, below `03-04-PLAN.md`'s `[1118, 1138]` band. The baseline is now anchored to a commit rather than a date - re-confirmed 2026-08-23 on the committed tree at 34f96ee - and `03-02`/`03-04` cite that provenance. Residual risk: the hwp-editor track is still active, so `03-04` now requires a re-measurement at the start of the plan rather than treating drift as exceptional.
- `make verify` runs on ubuntu-22.04 only and e2e runs Chromium against Vite with mocked IPC. Nothing in CI exercises WKWebView, the real PTY, IME input, or the macOS menu - macOS-affecting changes need a real-app run. Phase 6 (TEST-01) exists to close this gap; until its spike resolves, treat this as open.

## Deferred Items

| Category | Item | Status | Deferred At |
|----------|------|--------|-------------|
| Concurrency/Perf | PERF-01..04 (sync-command main thread, lock-across-network, poison recovery, watcher pruning) | Promoted to v1.1 (Phases 7-8) | 2026-08-22 |
| Security | SEC-01 CSP `script-src blob:` audit, SEC-02 sanitizer regression test | Promoted to v1.1 (Phases 7, 10) | 2026-08-22 |
| Reliability | REL-01 SIGHUP-immortal terminal session | Promoted to v1.1 (Phase 9) | 2026-08-22 |
| Testing | TEST-01, TEST-02 (native Tauri E2E runner, coverage) | Promoted to v1.1 (Phases 6, 11) | 2026-08-22 |
| Testing | TEST-03, TEST-04 (remaining component tests, app_menu smoke) | v2 | 2026-08-22 |
| Product | HUB-01 Hub graph-metadata sync - the doc set's only explicit deferral | v2 | 2026-08-22 |
| Typed IPC | ERR-05 closed-enum contract (emission sites unconstrained; guard checks declarations only) | v2 | 2026-08-23 |
| Evidence | Re-run a deliberate failing CI E2E against the shipped narrowed Playwright trace configuration | Promoted to v1.1 (GATE-08, Phase 11) | 2026-08-28 |
| Validation | Reconcile Phase 01-03 Nyquist metadata with `$gsd-validate-phase` | Promoted to v1.1 (VALID-01, Phase 11) | 2026-08-28 |
| Security | Add a Phase 02 security report if uniform milestone evidence is required | Promoted to v1.1 (SEC-03, Phase 11) | 2026-08-28 |

## Post-Close Resolutions

| Item | Resolution | Release | Date |
|------|------------|---------|------|
| ERR-06 | All conflict-emitting commands preserve `IpcError`; recursive source guard and frontend normalization tests added in PR #283 | v0.5.0 | 2026-08-28 |
| Phase 03 security evidence | Seven threats closed, accepted risks documented, `threats_open: 0` | v0.5.0 | 2026-08-28 |

## Session Continuity

Last session: 2026-08-29T10:48:03.459Z
Stopped at: Completed 06-03-PLAN.md
Resume file: None

## Operator Next Steps

- Plan Phase 6 with `/gsd-plan-phase 6`
