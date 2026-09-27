---
phase: 08-main-thread-responsiveness
status: findings
files_reviewed: 98
findings:
  critical: 0
  warning: 1
  info: 4
  total: 5
created: 2026-09-21
---

# Phase 8 Code Review (08-main-thread-responsiveness)

Diff base: `31e940f14b7415acea67d165a6f692ec59c507cb^` (274 files, +107360/-3208). Scope: bugs, security issues, code quality problems in the Phase 8 listed sources. No tests run, no code executed, no source files modified.

**Summary: 0 critical, 1 warning, 4 info.** The phase's core contracts hold: path-transaction admission (atomic_file.rs) fails closed; the lock-order contract (path admission → domain guard → statics) is consistent with no inversion found; git.rs mutation locking and auto-maintenance suppression are correct with strong tests; web_actions replay never duplicates; dot_sync and InstallCli/UpdateCli fail closed; the frontend operation wrappers preserve the `skills_source_busy` no-retry contract and dedupe notices by operationId.

### WR-01: Registry lock held across git subprocess and full-checkout SHA-256 hash during sync commit

- **Severity:** warning
- **File:** `src-tauri/src/skill_host/store.rs:1327-1330` (in `sync_source_transaction` tail)

**Description:** After the network step, the commit tail takes `registry_guard()` (REGISTRY_LOCK) at line 1327 and then, while holding it, calls `revalidate_source_mutation_paths(&snapshot.source, &network_paths)` (line 1329) and `hash_directory(&original_path)` (line 1330). `revalidate_source_mutation_paths` reaches `SourceOperationLease::identity` (store.rs:103), which spawns a `git rev-parse --show-toplevel` subprocess; `hash_directory` (store.rs:6325-6355) walks the entire checkout with WalkDir and reads + SHA-256s every file. Both run under REGISTRY_LOCK, so any concurrent registry reader/writer (settings UI, other sources' sync, native-e2e probes) stalls for the full duration of a subprocess spawn plus an O(checkout size) hash. Against large checkouts this is exactly the main-thread/lock-contention cost Phase 8's PERF-02 goal set out to remove.

**Suggested fix:** Move the revalidation and the content hash before `registry_guard()` — they only touch the filesystem and the source snapshot, not the registry — and under the lock re-verify only cheap in-memory state (source existence, `generation` equality, `registry_mutation_paths` overlap), which the existing ABA `ensure_source_generation`/`before_effect` machinery already supports. If reordering is not feasible for the commit invariant, document the accepted cost next to the guard so future readers know the stall is deliberate and bounded.

### IN-01: Duplicated source+checkout admission logic between `admit_source_operation` and `SourceOperationLease::reserve`

- **Severity:** info
- **File:** `src-tauri/src/skill_host/store.rs:253` (vs `store.rs:83`)

**Description:** `admit_source_operation` (returns `IpcError`) and `SourceOperationLease::reserve` (returns `String`) implement near-identical admission: path expansion/canonicalization, a `git rev-parse --show-toplevel` subprocess, and SOURCE_OPERATIONS insertion with the busy check. Two call sites with the same semantics but different error types invite drift — a future hardening (e.g. a new path validation) added to one will silently miss the other.

**Suggested fix:** Make `admit_source_operation` a thin wrapper that calls `SourceOperationLease::reserve` and maps the `String` error into an `IpcError`, so the admission logic exists once.

### IN-02: Non-absolute paths silently dropped from the inbox PathTransactionRequest set

- **Severity:** info
- **File:** `src-tauri/src/inbox.rs:470` (in `stage_inbox_drop_files`)

**Description:** `source_paths.iter().map(PathBuf::from).filter(|p| p.is_absolute())` silently removes non-absolute entries from the admitted path set. A relative path then passes the request stage without error, and only fails later per-file in `stage_one_drop_file_result` via `lease.ensure_covered(...)` with "Transaction paths must be absolute" (from `PathTransactionRequest::new` at atomic_file.rs:124). The outcome is correct (fails closed) but the diagnostics route is indirect and a caller passing a mix of absolute and relative paths gets a partial admission set with no signal at the boundary.

**Suggested fix:** Validate at the boundary: partition the input and return an explicit per-path error for non-absolute entries in the staged outcome (or reject the whole request up front), so the mismatch is reported where the caller can act on it.

### IN-03: Redundant parent-directory handle opens per admitted path in path transaction revalidation

- **Severity:** info
- **File:** `src-tauri/src/atomic_file.rs:158-166`

**Description:** Revalidation opens the same parent directory handle twice per candidate (`Self::open_parent(&parent)` twice in one identity comparison), and the loop runs for both the path and its physical alias key — up to 4 opens per admitted path. On macOS/Linux each open is a syscall; correctness is unaffected.

**Suggested fix:** Open the parent once per candidate, compare that single handle against the stored identity, and drop it after; reuse the same handle across the alias iteration where the parent is identical.

### IN-04: Test-only `unwrap()` on parent capture in `trash_inbox_items_with`

- **Severity:** info
- **File:** `src-tauri/src/inbox.rs:1947` (`#[cfg(test)]` helper)

**Description:** The test helper uses `PathTransactionParent::capture(work).unwrap()`. Test-only, so no production risk, but a panic here produces a less actionable failure than an assertion message.

**Suggested fix:** Replace `unwrap()` with `.expect("fixture workspace parent capture")` (or propagate) so a failing test names the operation.

## Methodology

Honest provenance for the 274-file, ~107k-line diff. Review depth: standard. Counts below are per-file.

**Read fully (30 files)** — complete file or complete diff, plus targeted current-file sections for every finding:

- Core admission/locking: `src-tauri/src/atomic_file.rs` (full diff + current sections at lines 115-305), `src-tauri/src/skill_host/store.rs` (sections 83-158, 245-285, 660-720, 1240-1360, 6325-6355 + diff), `src-tauri/src/git.rs` (full ~1800-line diff), `src-tauri/src/maru_dir.rs` (full 1700-line diff), `src-tauri/src/inbox.rs` (sections 445-505, 1935-1960, 2722-2797 + diff), `src-tauri/src/lock_recovery.rs`, `src-tauri/src/scheduler.rs`, `src-tauri/src/telegram_io.rs`, `src-tauri/src/skill_host/dispatch.rs`, `src-tauri/src/skill_host/env.rs`, `src-tauri/src/skill_host/fs.rs`, `src-tauri/src/skill_host/mod.rs`, `src-tauri/src/secrets.rs`, `src-tauri/src/binary_viewer.rs`, `src-tauri/src/share_outbox.rs`
- Other Rust: `src-tauri/src/dot_sync.rs` (core sections 160-990 + diff), `src-tauri/src/inbox_classifier.rs`, `src-tauri/src/native_e2e.rs`, `src-tauri/src/ipc_error.rs`, `src-tauri/src/paths.rs`, `src-tauri/src/lib.rs` (registration diff)
- Frontend logic: `src/lib/processingOperations.ts`, `src/lib/skillOperations.ts`, `src/lib/errorStore.ts`, `src/lib/skills.ts`, `src/lib/studio.ts`, `src/lib/ipcError.ts`, `src/lib/skills.test.ts`
- E2e: `e2e-native/specs/skills-sync.spec.ts`, `e2e-native/helpers/fixtureWorkspace.ts`

**Skimmed structurally (68 files)** — diff-stat plus grep passes over added lines for `fn`/`invoke`/`spawn`/`listen`/lock/admission markers; all conformed to the established pattern, no issues found:

- Rust long tail (34): `web_actions.rs`, `workspace_files.rs`, `tasks.rs`, `today_store.rs`, `today_lifecycle.rs`, `today_outbox.rs`, `today_calendar.rs`, `drafts.rs`, `scratchpad.rs`, `document.rs`, `jobs.rs`, `system_jobs.rs`, `launchd_migration.rs`, `terminal/mod.rs`, `terminal_hooks.rs`, `diagram/mod.rs`, `shelf.rs`, `mission_state.rs`, `content_search.rs`, `gmail_gws.rs`, `hub_client/mod.rs`, `kakao_relay.rs`, `outlook_mso.rs`, `scratchpad_watcher.rs`, `inbox_watcher.rs`, `vault_watcher.rs`, `ops_catalog/watcher.rs`, `hwped.rs`, `site_view.rs`, `template_fill.rs`, `hwp_cli_template.rs`, `export/dispatch.rs`, `agent_host/status.rs`, `agent_host/provider.rs`
- Frontend (18): `App.tsx`, `src/components/settings/tabs/SkillsTab.tsx`, `src/lib/api.ts`, `src/lib/api.test.ts`, `src/lib/nativeE2eBridge.ts`, `src/lib/export.ts`, `src/lib/types.ts`, `src/lib/workspaceStore.ts`, `src/lib/documentIndex.ts`, `src/lib/i18n.ts`, `src/lib/i18n/locales/en.ts`, `src/lib/i18n/locales/ko.ts`, `src/components/FilesWorkbench.tsx`, `src/components/SharedOutboxPane.tsx`, `src/components/binaryViewers/HwpxViewer.tsx`, `src/components/today/TodaySyncStatus.tsx`, `src/components/Sidebar.tsx`, `src/components/studio/StudioMode.tsx`
- Scripts (5): `scripts/check-command-isolation.mjs`, `scripts/check-dom-sanitizer.mjs`, `scripts/check-native-e2e-isolation.mjs`, plus their test files
- Configs (7): `package.json`, `Makefile`, `tsconfig.scripts.json`, `src-tauri/Cargo.toml`, `maru-cli/Cargo.toml`, `src-tauri/tauri.conf.json`, `e2e-native/wdio.conf.ts`
- E2e (2): `e2e-native/specs/responsiveness.spec.ts`, `e2e-native/helpers/responsivenessSamples.ts`
- Docs (2): `README.md`, `docs/native-e2e.md`

**Existence-checked only:** `src-tauri/Cargo.lock` (exists, 181,548 bytes) and `docs/performance/phase08-*.json` (29 files present) per review constraints. `.planning/` artifacts (08-PLAN, 08-CONTEXT, plan summaries) read only as context, not reviewed.

**Known accepted costs, deliberately not filed:** `env.rs`/`dispatch.rs` hold an admission lease across a whole setup/dispatch subprocess — documented in-plan and enforced by tests as intentional; `classifyTemplateFillCompletion` in `src/lib/studio.ts` contains an unreachable "empty" branch (cosmetic only). Verified non-issues: lock-order consistency across all fully-read files, `git.rs` mutation revalidation + maintenance suppression (strong test coverage), `web_actions.rs` replay dedup via applied-ledger + outbox id, scheduler settle no-resurrection, Condvar wait loops in path admission, `share_outbox.rs` WalkDir cycle failing closed, `HwpxViewer` sink now routed through a registered DOMPurify helper (SEC-02 gate).

No critical findings. WR-01 is the only item worth scheduling; the info items are consolidation/diagnostics quality improvements.
