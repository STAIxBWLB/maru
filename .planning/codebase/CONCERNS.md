---
last_mapped_commit: 293cd8e
---

# Codebase Concerns

**Analysis Date:** 2026-09-02  
**Commit:** `293cd8e` (`v1.1.3-10-g293cd8e`)

Scope: Maru is a Tauri 2 desktop app (React 19 + TypeScript frontend, Rust backend).
Current tree has ~93,000 lines of Rust in `src-tauri/src/`, ~172,000 lines of `.ts`/`.tsx` in `src/`,
287 `#[tauri::command]` entry points (240 synchronous, 47 asynchronous), and `src/styles.css`
at 26,434 lines. The concerns below are ordered by how much they will cost the next person
who touches this code.

---

## 1. Architectural / Tech Debt

**`src/App.tsx` is an 8,850-line god component.**
- `export default function App()` starts at `src/App.tsx:940` and holds roughly 15 `useState`,
  26 `useEffect`, 238 `useCallback`, 85 `useMemo`, and 35 `useRef` calls.
- It passes state down as enormous prop clusters to every pane. Recent additions include the
  Files/Explorer workbench integration and the right/workbench surface, all threaded through
  the same component.
- Impact: Any new pane state requires a new prop drill through `App.tsx`, so unrelated features
  collide in the same file. Every `App` render re-renders the whole tree; previous preview-mark
  regressions (#260/#262/#264) were direct consequences of components re-rendering for reasons
  they cannot see.
- Fix direction: Continue the store extraction pattern already used by
  `src/lib/errorStore.ts`, `src/lib/editorTabsStore.ts`, `src/lib/appOverlayStore.ts`, and
  `src/lib/workspaceStore.ts`. The Files-editor cluster is the cheapest first extraction.

**A rendered React subtree is passed as a prop, defeating `memo`.**
- `FilesWorkbench` is `memo`-wrapped, but `App.tsx` hands it `documentEditorNode` — a fully
  constructed `<InlineDocumentEditor ...>` element built inline at `src/App.tsx:8103-8121`.
  A JSX element literal is a new object on every render, so the memo comparison can never bail
  out (`src/components/FilesWorkbench.tsx:1885-1886`).
- Impact: `memo` on the workbench is decorative, and the 2,132-line pane reconciles on every
  `App` state change. Ownership is also inverted: `FilesWorkbench` can no longer decide when
  its editor renders.
- Fix direction: Pass data, not the node. `FilesWorkbench` already receives
  `documentEditorPath` and `documentEditorError`; give it the tab payload and let it render
  `InlineDocumentEditor` itself.

**Files preview creates uncapped editor tabs.**
- Selecting a `.md`/`.markdown`/`.html`/`.htm` file in the Files pane calls `prepareDocument`
  (`src/lib/documentOpsModeLifecycle.ts:121`), which inserts a tab via
  `insertDocTab` (`src/lib/editorTabsStore.ts:547`). The only cap is
  `RESTORED_COMPANION_TAB_CAP = 8` (`src/lib/editorTabsStore.ts:465`), which applies only to
  startup restore.
- Impact: Clicking through a folder of markdown files leaves a tab per selection in the
  Documents stack. The user did not ask for most of them.
- Fix direction: Insert lazily on first edit/save, and close clean preview tabs when the Files
  selection moves on.

**Two new preview surfaces rebuild `dangerouslySetInnerHTML` objects inline.**
- `src/components/EditorPane.tsx:1041` documents and follows the rule: `previewMarkup` is
  memoized on the HTML string so React skips the innerHTML write when the string is unchanged.
  `src/components/InlineDocumentEditor.tsx:228` and `src/components/ScratchpadPane.tsx:1360`
  do not; both pass a fresh `{{ __html: previewHtml }}` literal.
- Impact: React reassigns the preview container's innerHTML on every render, throwing away
  scroll position, selection, and any DOM state. This is the exact bug class #260/#262/#264
  fixed in `EditorPane`.
- Fix direction: One `useMemo(() => ({ __html: previewHtml }), [previewHtml])` in each file.

**`src/styles.css` is a 26,434-line monolith.**
- One stylesheet holds layout rules for every pane. The file is not code-split and ships in the
  initial CSS chunk.
- Impact: Every layout change competes in one specificity space, which has caused dashboard
  regressions in consecutive releases. It also makes the CSS budget fragile.
- Fix direction: Split by mode following the `src/components/graph/graph.css` and
  `src/components/diagram/diagram.css` precedent.

**Path-traversal validation is still fragmented.**
- `src-tauri/src/paths.rs:62` now provides `ensure_within` and `src-tauri/src/paths.rs:42`
  provides a shared `GENERATED_DIRS` constant, but many modules still roll their own checks:
  some match `Component::ParentDir` (`src-tauri/src/vault.rs:194`, `src-tauri/src/git.rs`),
  others substring-match `".."` (`src-tauri/src/maru_dir.rs:181`,
  `src-tauri/src/diagram/mod.rs`, `src-tauri/src/jobs.rs`,
  `src-tauri/src/terminal_hooks.rs`).
- Impact: A new command author has many examples to copy from and no single canonical helper.
  Substring and `Component` checks are not equivalent, so guarantees differ per module.
- Fix direction: Route all new path-accepting commands through `paths::ensure_within`.

**Most IPC errors are still plain strings.**
- 1,119 signatures return `Result<T, String>`. A typed error contract now exists in
  `src-tauri/src/ipc_error.rs` for five conflict codes (`today_conflict`, `task_conflict`,
  `document_conflict`, `evidence_binder_revision_conflict`, `web_action_repair_conflict`), with
  a TypeScript mirror in `src/lib/types.ts:70-76` and a normalizer in `src/lib/ipcError.ts`.
- Impact: Until the migration reaches every command the frontend branches on, renaming a string
  prefix silently breaks frontend recovery paths with no compile-time error.
- Fix direction: Extend `IpcError` to every error the frontend actually distinguishes.

---

## 2. Security Boundaries

**The webview renders untrusted third-party content and holds full IPC authority.**
- Maru ingests content the user did not author (Telegram, KakaoTalk, Gmail, Outlook, inbox
  drops) and renders it through `dangerouslySetInnerHTML` at:
  - `src/components/EditorPane.tsx:1041`
  - `src/components/drafts/DraftsPane.tsx:968` and `:1033`
  - `src/components/ScratchpadPane.tsx:1360`
  - `src/components/InlineDocumentEditor.tsx:228`
  - `src/components/binaryViewers/HwpxViewer.tsx:95`
- The same webview can call all 287 IPC commands, including filesystem writes and subprocess
  invocation. A single sanitizer bypass is therefore a local-code-execution path.
- Current mitigations are strong: every sink routes through DOMPurify
  (`src/lib/markdown.ts:50`, `src/lib/scratchpad.ts:188`, `src/lib/diagram/richText.ts:21`,
  `src/components/binaryViewers/HwpxViewer.tsx:37`). `withGlobalTauri` is `false`
  (`src-tauri/tauri.conf.json:14`), capabilities are explicitly enumerated
  (`src-tauri/capabilities/default.json`), and embedded site webviews get labels outside the
  default capability window list (`src-tauri/src/site_view.rs`).
- Open gaps:
  - There is no automated guard (test, script, or CI check) that verifies every
    `dangerouslySetInnerHTML` value traces to a DOMPurify-backed helper. New sinks added in
    recent releases happened to be sanitized by inspection.
  - The CSP allows `script-src 'self' blob:` (`src-tauri/tauri.conf.json:35`). `blob:` in
    `script-src` lets injected DOM create executable script URLs. The graph worker needs
    `worker-src blob:` (already declared); verify whether `script-src blob:` is still required.

**Global process-wide locks can be poisoned into a broken feature.**
- `REGISTRY_LOCK` (`src-tauri/src/skill_host/store.rs:45`, guard at `:2618`) returns
  `skills_registry_lock_poisoned`. `terminal_kill` returns `terminal_killer_poisoned`
  (`src-tauri/src/terminal/mod.rs:859-877`). `JOBS_LOCK` (`src-tauri/src/jobs.rs:16`),
  `DOT_ACTION_LOCK` (`src-tauri/src/dot_sync.rs:14`), and `BINDER_WRITE_LOCK`
  (`src-tauri/src/evidence_binder.rs:24`) serialize on the same pattern.
- A single panic under `REGISTRY_LOCK` bricks all skill operations until app restart.
  `src-tauri/src/skill_host/fs.rs` already shows the recovery idiom
  `.unwrap_or_else(|poisoned| poisoned.into_inner())`; the long-lived registry and terminal
  locks do not use it.

**Secrets handling remains deliberate.**
- `src-tauri/src/secrets.rs` scans/classifies secrets, rejects `Component::ParentDir`
  (`src-tauri/src/secrets.rs`), atomic writes default to `0o600`
  (`src-tauri/src/atomic_file.rs`), and Claude credentials are read from the macOS Keychain
  (`src-tauri/src/agent_host/status.rs`). No change needed; route any new provider token through
  `.maru/secrets/` and `write_atomic`.

**macOS browser passkeys are `unsafe` FFI with no CI coverage.**
- `src-tauri/src/browser_passkeys.rs` calls `AuthenticationServices.framework` via `objc2`,
  `block2`, and `core-foundation-sys`. The 32 `unsafe` blocks in the Rust tree are concentrated
  here and in platform-specific PTY/process code.
- `make verify` runs on Ubuntu; nothing in CI exercises the WKWebView, the real PTY, IME input,
  or macOS menu/passkey paths.

---

## 3. Performance & Scaling

**Initial JS bundle is over budget.**
- Current `dist/` initial JS is **371.9 KiB gzip** against a **320 KiB budget**
  (`scripts/check-bundle-budget.mjs:29`). `pnpm build:frontend` currently fails this gate.
- Initial CSS is **58.3 KiB gzip** against a **70 KiB budget**, so the CSS gate still passes.
- The lazy-chunk guards still hold (`DiagramModeAdapter`, `GraphModeAdapter`,
  `SitesModeAdapter`, `RichMarkdownEditor`, `PkmModeAdapter`, `E2EFlowModeAdapter`, `ko`/`en`
  dictionaries).
- Fix direction: Do not raise the JS budget. Reduce entry-bundle weight by splitting more mode
  CSS/JS and by thinning `App.tsx`'s direct imports.

**Long-running work on synchronous IPC commands blocks the UI.**
- 240 of 287 commands are synchronous `fn` commands, which Tauri runs on the main thread.
  Heavy offenders include `skills_sync_source` (`src-tauri/src/skill_host/store.rs:567`, git
  clone/pull), `today_calendar_commitments` (`src-tauri/src/today_calendar.rs`, `WalkDir`),
  `prepare_share_outbox_files` (`src-tauri/src/share_outbox.rs`, spawns Python), and
  `detect_legacy_telegram_launchd` (`src-tauri/src/launchd_migration.rs`).
- `skills_sync_source` also holds the global `REGISTRY_LOCK` across the network round-trip
  (`src-tauri/src/skill_host/store.rs:582`), freezing both the UI thread and every other skill
  operation while a remote git source is slow.
- Fix direction: Convert network/subprocess-bound commands to `async fn`, or adopt the event-
  streaming pattern used by `skills_env_bootstrap` (`src-tauri/src/skill_host/env.rs`).

**Recursive filesystem watchers have no generated-directory guard.**
- `vault_watcher.rs`, `inbox_watcher.rs`, `scratchpad_watcher.rs`, and
  `src-tauri/src/ops_catalog/watcher.rs` all register `RecursiveMode::Recursive`. `ops_catalog`
  registers one recursive watch per business-unit directory, which grows with project count.
- The shared `GENERATED_DIRS` constant exists but is not wired into the watcher predicates.
  If a watched root ever gains a `node_modules`/`.git` subtree, event volume becomes the
  bottleneck.

**Scaling limits are documented and mostly honest.**
- Graph: 10,000 nodes / 50,000 edges (`src/lib/graph/perf.bench.ts:19-20`).
- Content search: 500 files, 5,000 total matches, 2 MiB/file, 500 chars/line
  (`src-tauri/src/content_search.rs:19-23`).
- Editor tabs: only startup restore is capped at 8 (`src/lib/editorTabsStore.ts:465`);
  `insertDocTab` (`src/lib/editorTabsStore.ts:547`) is unbounded, and the Files preview path
  now calls it on selection.
- Browser tabs: 12 (`src-tauri/src/site_view.rs:34`, `src/lib/browserTabs.ts:15`); opened-URL
  backlog: 64 (`src-tauri/src/site_view.rs:43`).
- Scheduler `LAST_FIRED` (`src-tauri/src/scheduler.rs:38`) is process-local and unbounded, but
  already marked `ponytail:` and guarded by persisted `nextRunAt`.

---

## 4. Fragile Areas

**Editor preview markup (search marks, KG reference marks, wikilink styling).**
- Root cause is documented at `src/components/EditorPane.tsx:120-216`: React reassigns
  `dangerouslySetInnerHTML` whenever the prop object is not identity-equal, so any imperative
  mutation of the preview container is destroyed by an unrelated re-render.
- The rule is followed in `EditorPane.tsx` but violated by the two newer preview surfaces
  (`InlineDocumentEditor.tsx`, `ScratchpadPane.tsx`).
- Safe modification: fold all marks into the HTML string React renders, and memoize the markup
  object on that string.

**Workbench CSS layout.**
- Three dashboard layout fixes in three consecutive releases (#247, #267, #269). The root cause
  is 26,434 lines of CSS sharing one specificity space, with 534 `overflow` declarations.
- Recent changes followed the safe path (Playwright geometry assertions in
  `e2e/workbench-layout.spec.ts`), but the structural fix is splitting `styles.css`.

**Scratchpad pane concurrency.**
- `src/components/ScratchpadPane.tsx` (1,504 lines) hand-rolls concurrency control across 13
  `useRef` slots: refresh serials, save-in-flight flags, two debounce timers, workspace-change
  generation tokens, and a watcher transition queue. Each guard is individually reasoned; none
  is exercised by overlapping-race tests.

**Skill registry and install targets.**
- `src-tauri/src/skill_host/store.rs` is the largest file in the repo at 7,878 lines. It owns
  five skill-source tiers, symlink-based installs into tool-owned directories, OTA bundle
  updates, and a process-global registry lock. Recent fixes (#255, #212) were invariant repair,
  not feature work.

**Terminal / PTY session lifecycle.**
- `src-tauri/src/terminal/mod.rs` (1,665 lines), `src/components/NativeTerminalView.tsx`
  (2,292 lines), and `src/components/TerminalPanel.tsx` (2,437 lines) rely on latched
  `closing` flags, generation tokens, and `Arc::ptr_eq` identity guards. A child that traps
  SIGHUP can become immortal because `ChildKiller::kill` raises only SIGHUP on Unix and the
  latched `closing` flag prevents a second kill attempt (`src-tauri/src/terminal/mod.rs:859-884`).

**macOS-native behavior has no automated coverage.**
- `make verify` runs on `ubuntu-22.04`; the e2e suite runs Chromium against a Vite server with
  mocked IPC. WKWebView, real PTY, IME, macOS menu, and passkey paths are only validated by
  running the real app on macOS.

---

## 5. Dependencies & Toolchain

**Rust toolchain is unpinned while Node/pnpm are pinned.**
- `.github/workflows/ci.yml` and `release-bundles.yml` use `dtolnay/rust-toolchain@stable`;
  there is no `rust-toolchain.toml`. Node is pinned to `22.22.3` and pnpm to `9.15.0`.
- A new Rust stable release can change CI/release behavior with no commit in this repo.
- Fix direction: Add `rust-toolchain.toml` with a pinned channel and bump it deliberately.

**Exact-pinned graph stack has no recorded rationale.**
- `sigma 3.0.3`, `@sigma/export-image 3.0.0`, `@sigma/node-border 3.0.0`,
  `graphology 0.26.0`, `graphology-layout 0.6.1`, `graphology-layout-forceatlas2 0.10.1`,
  and `graphology-types 0.24.8` are pinned without a caret. `trash = "=4.1.1"` in
  `src-tauri/Cargo.toml` is also exact-pinned.
- The pins are deliberate but undocumented; a future upgrade has to rediscover why each exists.

---

## 6. Test & Verification Gaps

**No native Tauri E2E runner.**
- Tracked in the codebase's own ledger as `native-tauri-e2e-runner-missing`
  (`src/lib/e2eFlow.ts:154`). All e2e specs run Chromium against Vite with mocked IPC
  (`e2e/helpers/todayFixtures.ts`). Nothing verifies the actual IPC contract end to end.

**Large React components have no unit tests.**
- The top untested surfaces are `src/App.tsx` (8,850 lines), `src/components/meetings/MeetingsPane.tsx`
  (2,965), `src/components/FilesWorkbench.tsx` (2,132), `src/components/NativeTerminalView.tsx`
  (2,292), `src/components/TerminalPanel.tsx` (2,437), `src/components/ScratchpadPane.tsx`
  (1,504), `src/components/settings/tabs/SkillsTab.tsx` (1,753), `src/components/OutlinePane.tsx`
  (1,644), `src/components/studio/StudioMode.tsx` (1,535), `src/components/graph/GraphCanvas.tsx`
  (1,924), and `src/components/diagram/DiagramMode.tsx` (1,862).
- `src/lib/` is in better shape: ~208 `.test.ts`/`.test.tsx` files, with strong coverage of
  diagram, graph, and store modules.

**e2e locators are bound to Korean UI strings.**
- `e2e/workbench-layout.spec.ts` selects by `name: "스크래치패드"`; `e2e/smoke.spec.ts` asserts
  on `"저장 필요"`, `"저장됨"`, and `"리치"`. Renaming a `ko` locale key breaks the suite with a
  timeout rather than a clear failure.

**`e2e/` and `scripts/` are not typechecked.**
- `tsconfig.app.json` includes only `src`; `tsconfig.node.json` includes only `vite.config.ts`.
  `tsc -b` never sees the Playwright specs or helpers, so type errors surface as runtime
  failures or not at all.

**No coverage measurement.**
- Neither `vitest --coverage` nor `cargo-llvm-cov` is wired into a script or Makefile target,
  so the gaps above are inferred from file presence rather than measured.

**Three Rust tests are deliberately ignored.**
- `src-tauri/src/vault.rs` (real-workspace scan bench), `src-tauri/src/ops_catalog/scan.rs`,
  and `src-tauri/src/agent_host/status.rs` (live AI CLI smoke). `Makefile:204-211` documents
  why the CLI smoke is excluded from `verify`.

---

## 7. Resolved Since the Last Audit

These are no longer active concerns; they are recorded so they are not re-raised.

- `@types/dompurify` was removed; `dompurify` ships its own types.
- The hand-maintained `TODO_LEDGER` in `src/lib/e2eFlow.ts` no longer contains resolved entries
  and declares itself hand-maintained in a module comment.
- Playwright traces are now captured via `retain-on-failure` with snapshots/screenshots off
  (`playwright.config.ts:30`).
- Directory pruning and path containment were centralized into `src-tauri/src/paths.rs`
  (`GENERATED_DIRS`, `ensure_within`, `require_absolute`).
- `make verify` now includes ESLint, Rust `fmt --check`, and `clippy -D warnings`.
- A typed IPC error contract exists for the five conflict codes the frontend branches on
  (`src-tauri/src/ipc_error.rs`, `src/lib/types.ts`, `src/lib/ipcError.ts`).

---

*Concerns audit: 2026-09-02*
