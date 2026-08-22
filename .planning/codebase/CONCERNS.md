---
last_mapped_commit: a938128cd8f34d36b2f2361d683d8b419c8ca534
---

# Codebase Concerns

**Analysis Date:** 2026-08-22

Scope: full repo. Maru is a Tauri 2 desktop app - React 19 + TypeScript frontend
(`src/`, 164,330 lines of `.ts`/`.tsx` plus 31,110 lines of CSS) over a Rust backend
(`src-tauri/src/`, ~90k lines, 356 `#[tauri::command]` entry points). Tree is v0.4.62;
the `src/` half of this document was re-measured against that tree, the Rust half
carried forward from v0.4.61 unchanged.

Overall the codebase is unusually disciplined: TypeScript is `strict` with 7 `any`
uses and zero `@ts-ignore`, Rust production code contains only 18 `.unwrap()` calls
(3,370 more are inside `#[cfg(test)]` modules), deliberate simplifications carry
`ponytail:` comments naming their ceiling, and known gaps are documented at the
point of the gap (`scripts/lint-i18n.mjs:16`, `src-tauri/src/terminal/mod.rs:858`).
The v0.4.62 document-editing feature shipped with unit tests, three new e2e smoke
tests, and a Playwright geometry assertion for its new layout column - the process
holds. The concerns below are the real remainder, ordered by how much they will cost
the next person who changes this code.

---

## Tech Debt

**`src/App.tsx` is a 9,590-line God component:**
- Issue: `MainApp` (`src/App.tsx:775`) holds 69 `useState`, 49 `useEffect`,
  261 `useCallback`, 51 `useMemo` and 51 `useRef` calls, and passes the resulting
  state down as enormous prop lists - `OutlinePane` takes 71 props
  (`src/App.tsx:9170`), `EditorPane` 55 (`src/App.tsx:8201`), `DocumentList` 40
  (`src/App.tsx:9034`), `TerminalPanel` 25 (`src/App.tsx:9293`), `ScratchpadPane` 19
  (`src/App.tsx:8816`).
- Files: `src/App.tsx`
- Impact: Any state added to a pane means threading a new prop through `MainApp`,
  so unrelated features collide in the same file on every branch. Every `MainApp`
  state change re-renders the whole tree; the preview-mark regressions
  (#260/#262/#264) are a direct consequence of components re-rendering for reasons
  they cannot see.
- Evidence the pull is still active: v0.4.62 (#273) added +275 lines to `App.tsx` -
  two more `useState` and eleven more `useCallback`/`useMemo` (`savingTabId`,
  `filesEditorErrors`, `filesPreviewTab`, `prepareFilesPreviewDocument`,
  `saveFilesPreviewDocument`, `reloadFilesPreviewDocument`,
  `openFilesPreviewInDocuments`, `handleFilesHtmlModeChange`,
  `handleFilesHtmlRiskAck`, `saveActiveSurfaceDocument`, `setFilesEditorViewMode`) -
  all of it the Files inline-editor's save/reload/mode orchestration. The one thing
  the feature did right was generalize the existing `saveTab`
  (`src/App.tsx:4749`) instead of duplicating it.
- Fix approach: The extraction pattern already exists and works - `src/lib/errorStore.ts`,
  `src/lib/editorTabsStore.ts`, `src/lib/appOverlayStore.ts`, and
  `src/lib/workspaceStore.ts` are module-slot stores read via `useSyncExternalStore`,
  and `errorStore` explicitly exists "so any component can raise or clear the toast
  without an onError prop drill". Continue that: peel one pane's prop cluster into a
  store per change, highest-arity first (`OutlinePane`, then `EditorPane`). The
  Files-editor cluster added in v0.4.62 is the cheapest first extraction - it is
  self-contained, freshly written, and already reads `editorTabsStore`.

**A rendered React subtree is passed down as a prop, defeating `memo`:**
- Issue: `FilesWorkbench` is `memo`-wrapped (`src/components/FilesWorkbench.tsx:224`),
  but `App.tsx` now hands it `documentEditorNode` - a fully constructed
  `<InlineDocumentEditor ...>` element built inline at `src/App.tsx:8707-8733`. A JSX
  element literal is a new object on every render, so the memo comparison can never
  bail out and the entire 2,132-line workbench plus the inline editor reconcile on
  every `MainApp` state change.
- Files: `src/App.tsx:8707`, `src/components/FilesWorkbench.tsx:158-160`, `:1540-1546`,
  `:1761-1775`
- Impact: `memo` on the two largest panes is decorative. It was already weakened by
  inline arrow callbacks (`onWorkspaceVisibilityChange`, `onRefresh`,
  `onOpenDocument`); passing a rendered subtree makes it unconditional and also
  inverts the ownership - `FilesWorkbench` can no longer decide when its editor
  renders.
- Fix approach: Pass the data, not the node. `FilesWorkbench` already receives
  `documentEditorPath` and `documentEditorError`; give it the tab payload and let it
  render `InlineDocumentEditor` itself, or lift the editor out of the memo boundary
  entirely. Do not add `useMemo` around the JSX - that hides the coupling without
  removing it.

**Browsing the Files preview silently creates uncapped editor tabs:**
- Issue: Selecting any `.md`/`.markdown`/`.html`/`.htm` file in the Files preview pane
  calls `onPrepareDocument` (`src/components/FilesWorkbench.tsx:1806`), which reaches
  `prepareFilesPreviewDocument` (`src/App.tsx:6794`) and ends in `insertDocTab`
  (`src/App.tsx:6829`). The tab is never removed when the selection moves on, and
  `insertDocTab` (`src/lib/editorTabsStore.ts:547`) has no cap - the only cap in the
  store is `RESTORED_COMPANION_TAB_CAP = 8` (`:465`), which applies to startup restore
  only.
- Files: `src/App.tsx:6794-6845`, `src/lib/editorTabsStore.ts:465`, `:547`
- Impact: Clicking through a folder of 40 markdown files with the preview pane open
  leaves 40 tabs in Documents that the user never asked for. Sharing the tab is
  deliberate - `e2e/smoke.spec.ts` asserts "edits Markdown in Files and shares the
  saved draft with Documents" - but the sharing was designed for the edited document,
  not for every previewed one. `filesEditorErrors` (`src/App.tsx`) grows the same way:
  a `Record<string, string | null>` keyed by path that is only ever written.
- Fix approach: Insert the tab lazily - on the first `onChange`/save rather than on
  selection - and close a clean preview-created tab when the Files selection leaves it.
  The `closeTabs` transition (`src/lib/editorTabsStore.ts:558`) already handles the
  fallback-id and order prune.

**Preview markup objects are rebuilt inline in the two newest surfaces:**
- Issue: `src/components/EditorPane.tsx:481` documents the rule and `:1071` follows it -
  `previewMarkup` is memoized on the HTML string so React skips the innerHTML write
  when the string is unchanged. The two preview surfaces added since then do not:
  `src/components/InlineDocumentEditor.tsx:228` and
  `src/components/ScratchpadPane.tsx:1360` both pass an inline
  `{{ __html: previewHtml }}` literal.
- Files: `src/components/InlineDocumentEditor.tsx:228`,
  `src/components/ScratchpadPane.tsx:1360`
- Impact: React reassigns the preview container's innerHTML on every render of the
  owning component, throwing away scroll position, selection, and any DOM state inside
  the preview. Harmless today because neither surface decorates the preview
  imperatively - and dangerous the moment one does, which is exactly the bug class
  #260/#262/#264 fixed in `EditorPane`.
- Fix approach: One `useMemo(() => ({ __html: previewHtml }), [previewHtml])` in each,
  matching `EditorPane.tsx:481`. Both files already import `useMemo`.

**Stringly-typed IPC errors:**
- Issue: 1,118 signatures return `Result<T, String>`; only two real error enums exist
  (`src-tauri/src/agent_host/status.rs:351`, `src-tauri/src/hub_client/http.rs:19`).
  Error codes are encoded as string prefixes (`unknown_source:`,
  `install_target_exists:`, `evidence_binder_revision_conflict`,
  `terminal_kill_failed:`).
- Files: throughout `src-tauri/src/**`; consumer examples
  `src/components/evidence/EvidenceBinderPane.tsx:174` matches with
  `message.includes("evidence_binder_revision_conflict")`, and `e2e/smoke.spec.ts`
  now asserts on the literal `document_conflict` string surfaced in the Files editor.
- Impact: Renaming an error code silently breaks frontend recovery paths with no
  compile error on either side. The frontend cannot distinguish "retry this" from
  "this will never work" without substring matching.
- Fix approach: Do not convert 1,118 signatures. Introduce a serializable
  `{ code, message }` struct for the handful of errors the frontend actually
  branches on, and mirror the code union in `src/lib/types.ts`. Leave display-only
  errors as `String`.

**`src/styles.css` is a 26,434-line monolith:**
- Issue: One stylesheet holds every pane's layout: 534 `overflow` declarations,
  31 `@media` blocks, 29 `!important`, and class families for 20+ modes
  (`meetings` 313 selectors, `today` 264, `scratchpad` 164, `files` 162, `tasks` 155,
  `inbox` 153). Only four surfaces have their own file - `src/foundations.css`,
  `src/components/settings/settings.css`, `src/components/diagram/diagram.css`,
  `src/components/graph/graph.css`.
- Files: `src/styles.css`
- Impact: Every layout change competes in one specificity space, which is the direct
  mechanism behind the dashboard regressions #247/#267/#269 (see Fragile Areas). It
  also all ships in the initial CSS chunk - the four split files are lazy, `styles.css`
  is not.
- Fix approach: Split by mode following the `graph.css`/`diagram.css` precedent, one
  mode per change, starting with the two largest (`meetings`, `today`) since both are
  already lazy-loaded modes. Do not attempt a single big split.

**Directory prune lists are duplicated five ways and have already diverged:**
- Issue: Each scanner defines its own skip list.
  `src-tauri/src/workspace_files.rs:21` and `src-tauri/src/vault.rs:22` list
  `node_modules, target, dist, build, .next, .turbo, .cache` (no `.git`, no `.venv`);
  `src-tauri/src/secrets.rs:12` adds `.git, .venv, .context, .omc, .omx, .pnpm-store`
  but drops `.turbo`; `src-tauri/src/project_activity.rs:27` has six entries including
  `__pycache__` but no `.git`; `src-tauri/src/maru_dir.rs:79` is a twelve-entry
  `.maruignore` default; `src-tauri/src/evidence_binder.rs:1315` inlines a four-entry
  `matches!`.
- Impact: Adding a heavy generated directory requires finding and editing five lists.
  Missing `.git` in `workspace_files.rs` and `vault.rs` means those walks descend into
  git object storage on any workspace with a repo in it.
- Fix approach: One `pub const GENERATED_DIRS` in a shared module (the
  `workspace_files.rs` one is already `pub(crate)`), imported by the other four. Keep
  `maru_dir.rs`'s `.maruignore` defaults separate - that is a user-facing file format,
  not a scanner constant.

**Ad-hoc path-traversal validation, ~20 independent implementations:**
- Issue: Every module that accepts a caller-supplied relative path rolls its own
  containment check. Some match `Component::ParentDir`
  (`src-tauri/src/vault.rs:205`, `src-tauri/src/git.rs:1093`,
  `src-tauri/src/secrets.rs:774`), some substring-match `".."`
  (`src-tauri/src/maru_dir.rs:181`, `src-tauri/src/studio/mod.rs:275`,
  `src-tauri/src/diagram/mod.rs:50`, `src-tauri/src/jobs.rs:386`,
  `src-tauri/src/terminal_hooks.rs:78`). A real helper exists at
  `src-tauri/src/maru_dir.rs:189` (`ensure_within`) but is used only inside that file.
- Impact: A new command author has ~20 examples to copy from and no obvious canonical
  one. Substring `".."` checks and `Component::ParentDir` checks are not equivalent,
  so guarantees differ per module.
- Fix approach: Promote `ensure_within` to a shared module and use it for new
  path-accepting commands. Do not retrofit all callers at once - the existing checks
  are individually sound.

**Stray `Users/yj.lee/.maru/env/node_modules/` inside the repo root:**
- Issue: An absolute home path was joined as a relative one by some script or test,
  materializing `./Users/yj.lee/.maru/env/` in the working tree (dated Jul 31 / Aug 7).
  It is invisible to `git status` only because the `node_modules/` ignore rule covers
  its sole contents. Still present at `a938128`.
- Files: `Users/` at repo root; the likely producer is a `MARU_TEST_HOME`-style path
  join (see `src-tauri/src/skill_host/fs.rs:28` `env_root`, `:35` `install_root_base`).
- Impact: Low today, but it is evidence that a code path can write outside its intended
  root when a home path loses its leading separator.
- Fix approach: Delete the directory, then add a `Path::is_absolute` assertion where
  `maru_home()`/`env_root()` results are joined.

**Stale entry in the hand-maintained E2E flow TODO ledger:**
- Issue: `TODO_LEDGER` (`src/lib/e2eFlow.ts:139`) records `skill-name-drift` -
  "README names inbox-processor, lint, and hwpx-fill". `README.md` contains zero
  occurrences of those names (verified at `a938128`). The ledger is hand-written with
  no gate keeping it honest.
- Files: `src/lib/e2eFlow.ts:139-200` (the stale entry is at `:167`)
- Impact: The ledger is surfaced as product output (it ships in the E2E flow artifact),
  so a resolved item reads as an open one.
- Fix approach: Drop the resolved entry. If the ledger stays hand-maintained, note that
  in the module comment so readers know it is not derived.

**Deprecated `@types/dompurify` dependency:**
- Issue: `package.json:39` declares `@types/dompurify: ^3.2.0`; the installed package's
  own manifest says `"deprecated": "This is a stub types definition. dompurify provides
  its own type definitions"`. `dompurify` 3.4.1 ships `dist/purify.cjs.d.ts`.
- Files: `package.json:39`
- Impact: None functionally; one dependency of pure noise.
- Fix approach: Remove it from `dependencies`, run `pnpm typecheck`.

---

## Known Bugs

**Playwright traces are configured but never captured:**
- Symptoms: `playwright.config.ts:13` sets `trace: "on-first-retry"`, but no `retries`
  value is configured at any level, so Playwright's default of 0 applies in both local
  and CI runs. There is never a first retry, so a trace is never written.
- Files: `playwright.config.ts`
- Trigger: Any e2e failure in CI. `.github/workflows/ci.yml` uploads
  `playwright-report/` and `test-results/` on failure, but the trace that would make
  the report useful is absent.
- Workaround: Reproduce locally. Fix is one line - `retries: process.env.CI ? 1 : 0`,
  or switch to `trace: "retain-on-failure"` if flaky retries are unwanted.

**Scratchpad edits within 700 ms of unmount rely entirely on localStorage:**
- Symptoms: `updateContent` (`src/components/ScratchpadPane.tsx:576`) writes the buffer
  to localStorage via `persistDraft` and schedules a 700 ms debounced backend save
  (`scheduleAutoSave`, `:564`). The unmount cleanup (`:541-546`) calls
  `clearAutoSaveTimer()` only - it does not flush. `persistDraft` (`:547`) swallows all
  storage failures on purpose: "Quota or unavailable storage must never block the
  backend autosave."
- Files: `src/components/ScratchpadPane.tsx:541-596`
- Trigger: Switch modes, close the pane, or change workspace within 700 ms of the last
  keystroke, with localStorage full or unavailable. Both halves must fail.
- Workaround: The recovery-draft UI (`:1244`, `readScratchpadDraft` at `:477`) covers
  the common case and is the right design. The residual gap is that the localStorage
  write is the sole durable path in that window and its failure is silent - flushing
  on unmount instead of only clearing the timer closes it.

**A terminal child that traps SIGHUP becomes an immortal session:**
- Symptoms: `terminal_kill` latches `session.closing` and calls
  `ChildKiller::kill`, which on Unix only raises SIGHUP. A child that traps it keeps
  running; its waiter thread never removes the registry entry, and because `closing`
  is latched the session can never be killed again.
- Files: `src-tauri/src/terminal/mod.rs:836-871` (the hazard is documented in-place at
  `:858`, and a `Arc::ptr_eq`-guarded removal mitigates the registry leak).
- Trigger: A shell or agent CLI that installs a SIGHUP handler.
- Workaround: Quit the app. The escalation path already exists elsewhere in the
  codebase - `src-tauri/src/command_output.rs:404` spawns with `process_group(0)` and
  `:543` `terminate_unix_process_group` sends `SIGKILL` to `-pgid`. Applying that
  pattern to PTY sessions closes this.

---

## Security Considerations

**The webview renders untrusted third-party content and holds full IPC authority:**
- Risk: Maru ingests content the user did not author - Telegram
  (`src-tauri/src/telegram_io.rs`), KakaoTalk (`src-tauri/src/kakao_relay.rs`), Gmail
  (`src-tauri/src/gmail_gws.rs`), Outlook (`src-tauri/src/outlook_mso.rs`), inbox drops
  (`src-tauri/src/inbox_drop.rs`) - and renders it through
  `dangerouslySetInnerHTML` in seven non-test places. The same webview can call all 356
  IPC commands, including filesystem writes and `git`/`sh` invocation. A single
  sanitizer bypass is therefore a local-code-execution path, not a defacement.
- Files (current sink list): `src/components/InlineDocumentEditor.tsx:228`,
  `src/components/ScratchpadPane.tsx:1360`, `src/components/EditorPane.tsx:1071`,
  `src/components/drafts/DraftsPane.tsx:970` and `:1035`,
  `src/components/binaryViewers/HwpxViewer.tsx:95`
- Current mitigation: Strong. Every sink routes through DOMPurify -
  `src/lib/markdown.ts:52` (`renderMarkdown`, with an escaped-plain-text fallback on
  parse failure), `src/lib/scratchpad.ts:188`, `src/lib/diagram/richText.ts:21`,
  `src/components/binaryViewers/HwpxViewer.tsx:37`. `EditorPane`'s
  `decoratePreviewHtml` (`src/components/EditorPane.tsx:183`) states and upholds the
  invariant that lets it skip a second DOMPurify pass: every node it adds is built via
  `createElement`/`textContent`/`dataset`, so nothing can escape its element.
  `withGlobalTauri` is `false` (`src-tauri/tauri.conf.json:14`), the capability set is
  explicitly enumerated rather than `default`-wide
  (`src-tauri/capabilities/default.json`), and embedded site webviews get labels
  outside that capability's window list (`src-tauri/src/site_view.rs:137-162`), so a
  browsed page has no IPC access.
- Recommendations: (1) **The missing regression test is no longer hypothetical.**
  v0.4.62 added a new sink (`InlineDocumentEditor.tsx:228`) and moved another
  (`FilesWorkbench.tsx:1911` is gone; the markdown preview it held now lives in
  `InlineDocumentEditor`). Both happen to be sanitized, and nothing in the repo would
  have caught it if they were not - there is no `.test`/`.spec`/`check-*` file matching
  `dangerouslySetInnerHTML` anywhere in `src/`, `scripts/`, or `e2e/`. Add a
  `scripts/check-*.mjs` grep guard in the shape of `check-select-chrome.mjs` asserting
  every `dangerouslySetInnerHTML` value in `src/` traces to a DOMPurify-backed helper;
  it is cheaper than a unit test and runs in `verify`. (2) The CSP allows
  `script-src 'self' blob:` (`src-tauri/tauri.conf.json:31`) - `blob:` in `script-src`
  lets injected DOM create an executable script URL. The graph worker needs
  `worker-src blob:`, which is already separately declared; check whether
  `script-src blob:` is still required by the Vite build and drop it if not.

**Global process-wide locks can be poisoned into a permanently broken feature:**
- Risk: Several subsystems serialize on a process-global `Mutex` and return an error
  string on poisoning rather than recovering: `REGISTRY_LOCK`
  (`src-tauri/src/skill_host/store.rs:45`, guard at `:2618`, returns
  `skills_registry_lock_poisoned`), `terminal_registry_poisoned` /
  `terminal_killer_poisoned` (`src-tauri/src/terminal/mod.rs:851`, `:882`),
  plus `JOBS_LOCK` (`src-tauri/src/jobs.rs:16`), `DOT_ACTION_LOCK`
  (`src-tauri/src/dot_sync.rs:14`), `BINDER_WRITE_LOCK`
  (`src-tauri/src/evidence_binder.rs:19`).
- Files: as listed above
- Current mitigation: `src-tauri/src/skill_host/fs.rs:155` shows the recovery idiom
  already known here - `.unwrap_or_else(|poisoned| poisoned.into_inner())`.
- Recommendations: A single panic anywhere under `REGISTRY_LOCK` bricks all skill
  operations until app restart. Apply the `into_inner()` recovery used in `fs.rs` to the
  long-lived registry and terminal locks, where the protected data is a re-readable
  on-disk file rather than an invariant-bearing in-memory structure.

**Secrets handling is deliberate; keep it that way:**
- Risk: Low. `src-tauri/src/secrets.rs` scans, classifies, and reports mode bits
  (`permissions_ok`, `SecretIssue`), atomic writes default to `0o600`
  (`src-tauri/src/atomic_file.rs:18`), `telegram_config.rs:470` writes with
  `options.mode(0o600)`, and `secrets.rs:774` rejects `Component::ParentDir` with
  `secret_path_traversal_unsupported`. Claude credentials are read from the macOS
  Keychain, not from disk (`src-tauri/src/agent_host/status.rs:665-697`).
- Recommendations: No change needed. When adding a provider, route its token through
  `.maru/secrets/` and `write_atomic` rather than a new file-write path.

---

## Performance Bottlenecks

**Bundle budgets have less headroom than the gate suggests:**
- Problem: Measured against the current `dist/` build of `a938128`, initial CSS is
  **62.8 KiB gzip against a 70 KiB budget** (10.3% headroom, 7.2 KiB left) and initial
  JS is **300.2 KiB gzip against a 320 KiB budget** (6.2% headroom, 19.8 KiB left).
  `scripts/check-bundle-budget.mjs:28` still carries the comment "leaving ~12%
  headroom" from the v0.4.46 entry measurement; that margin has been spent.
- Files: `scripts/check-bundle-budget.mjs:29-30`, `src/styles.css`
- Cause: `src/styles.css` grew 363 lines (+1.4%) in v0.4.62 alone and is not code-split.
  At that rate the CSS gate fails within a handful of releases, as a hard build error
  on someone's unrelated branch.
- Improvement path: Splitting `src/styles.css` by mode (see Tech Debt) moves the
  per-mode CSS into the lazy chunks that already exist for those modes, which is the
  same fix as the maintainability one. Do not raise the budget - the gate working is
  the point.

**Long-running work on synchronous IPC commands blocks the UI:**
- Problem: 217 of the 356 commands are declared `#[tauri::command]` on a non-async
  `fn`, which Tauri runs on the main thread. 37 of those reach `WalkDir`, `read_dir`,
  a subprocess, or the network within their first 80 lines.
- Files: worst offenders are `skills_sync_source`
  (`src-tauri/src/skill_host/store.rs:566` - performs a git clone/pull),
  `skills_list_sources` / `skills_add_source` / `skills_remove_source`
  (`src-tauri/src/skill_host/store.rs:411`, `:420`, `:558`),
  `today_calendar_commitments` (`src-tauri/src/today_calendar.rs:188` - `WalkDir`),
  `today_calendar_publish` (`:414` - subprocess),
  `prepare_share_outbox_files` (`src-tauri/src/share_outbox.rs:307` - spawns Python),
  `detect_legacy_telegram_launchd` (`src-tauri/src/launchd_migration.rs:18`).
- Cause: `#[tauri::command]` on a sync `fn` executes inline on the main thread; only
  `async fn` (76 of them) or `#[tauri::command(async)]` moves to the pool.
- Improvement path: `skills_env_bootstrap` (`src-tauri/src/skill_host/env.rs:53`)
  already shows the right pattern - it returns an invocation id immediately and does
  the work on `thread::spawn`, streaming progress over
  `skills-env://` events. Convert the network- and subprocess-bound commands above to
  `async fn` (cheapest) or to that event-streaming pattern (best for anything with
  visible duration). Pure `read_dir` of a small config directory can stay sync.

**`skills_sync_source` holds the global skills lock across a network round-trip:**
- Problem: `skills_sync_source_impl` takes `registry_guard()`
  (`src-tauri/src/skill_host/store.rs:578`) and holds it through
  `sync_one_source_in_registry`, which pulls from a remote git source.
- Files: `src-tauri/src/skill_host/store.rs:566-597`, lock at `:45`/`:2618`
- Cause: One process-wide mutex protects the whole registry, and the network call
  happens inside the critical section.
- Improvement path: Narrow the critical section - read the source record under the
  lock, release, perform the network sync, then re-acquire to write. Combined with the
  sync-command issue above, a slow remote currently freezes both the UI thread and
  every other skills operation.

**Recursive filesystem watchers with no prune list:**
- Problem: `vault_watcher.rs:72`, `inbox_watcher.rs:168`,
  `scratchpad_watcher.rs:145`, and `ops_catalog/watcher.rs:90`/`:166` all register
  `RecursiveMode::Recursive`. Debounce windows are 120-150 ms.
- Files: as listed
- Cause: The watched roots are narrow today (`vault/`, `inbox/`, `scratchpad/`), so this
  is currently fine. `ops_catalog/watcher.rs:149` (`register_bu_watch_paths`) walks
  business-unit directories and registers a recursive watch per entry, which grows with
  the project count.
- Improvement path: If a watched root ever gains a `node_modules`/`.git` subtree, the
  event volume becomes the bottleneck. Filter by the shared `GENERATED_DIRS` constant
  when that happens; the `relevant_path` predicates
  (`vault_watcher.rs:21`, `scratchpad_watcher.rs:59`) are the right place.

**Startup and bundle instrumentation is measured and gated - keep it:**
- `scripts/check-bundle-budget.mjs` asserts `GraphView`, `RichMarkdownEditor`, and the
  `ko`/`en` dictionaries stay lazy chunks. `docs/perf-baseline.md` records a
  reproducible method and the v0.4.45 → v0.4.46 result (entry -24.5% gzip,
  `app:entry → workspace:first-usable` 283 ms → 56 ms). `src/lib/graph/perf.bench.ts`
  sets order-of-magnitude budgets at 10k nodes / 50k edges. The method is right; only
  the remaining headroom (above) needs attention.

---

## Fragile Areas

**Editor preview markup (search marks, KG reference marks, wikilink styling):**
- Files: `src/components/EditorPane.tsx:165-216` (`decoratePreviewHtml` and its
  invariant comment), `:479-486` (the `previewMarkup` memo and its comment), `:1071`;
  `src/lib/markdown.ts`
- Why fragile: Three consecutive releases fixed the same class of bug -
  v0.4.57 added repair passes, v0.4.58 (#263) retired them, then #260/#262/#264
  landed on top. The root cause is documented at `EditorPane.tsx:169`: React
  reassigns `dangerouslySetInnerHTML` whenever the prop value is not identity-equal,
  so any imperative mutation of that container is destroyed by an unrelated re-render.
- **Status at v0.4.62: the finding holds unchanged.** `EditorPane.tsx` changed by 243
  lines in #273, but the diff is a mechanical extraction of the Radix tab shell into
  `src/components/DocumentModeSurface.tsx`; the only lines touching the decoration
  region are re-indentations of the `kg-active` wrapper. `decoratePreviewHtml`, its two
  invariants, and the `previewMarkup` memo are byte-identical. The invariant survived a
  large refactor because the reasoning is written next to the code - not because
  anything enforces it. Two new preview surfaces landed in the same release and both
  already violate the memo half of it (see Tech Debt).
- Safe modification: Marks must be folded into the HTML string React renders (the
  v0.4.58 resolution), and the markup object must stay memoized on that string. Never
  add an effect that mutates the preview container's DOM - an effect will not re-run
  when the re-render that erased its work had no dependency change.
- Test coverage: `src/components/decoratePreviewHtml.test.ts`,
  `src/__tests__/editorPreviewDebounce.test.tsx`, `e2e/editor-find.spec.ts`.
  `EditorPane.tsx` itself (1,093 lines) still has no component test, and neither of the
  two files extracted from it - `DocumentModeSurface.tsx` (79) and
  `InlineDocumentEditor.tsx` (243) - has one either.

**Workbench CSS layout:**
- Files: `src/styles.css` (26,434 lines), `src/lib/workbenchLayout.ts`,
  `src/components/dashboard/DashboardPane.tsx`, `src/components/ScratchpadPane.tsx`
- Why fragile: Three dashboard layout fixes in three consecutive releases
  (#247, #267, #269). The v0.4.59 cause is instructive: the workbench pins every pane
  to `overflow: hidden` because other panes scroll an inner container, and that pin
  out-specified the dashboard's own `overflow-y: auto`. There are 534 `overflow`
  declarations in one specificity space.
- **Status at v0.4.62: the protocol was followed.** `src/styles.css` grew 363 lines for
  the Scratchpad folder-tree column - a new five-track
  `grid-template-areas: "tree tree-resize navigator resize-wide editor"` under
  `.scratchpad-workspace.tree-open` - and it landed with **zero new `!important`**,
  correct `min-width: 0` / `min-height: 0` / `minmax(0, 1fr)` grid-overflow hygiene, and
  a matching Playwright geometry assertion (`e2e/workbench-layout.spec.ts:299-345`
  measures `.scratchpad-tree-pane`, `.scratchpad-navigator` and
  `.scratchpad-editor-region` bounding boxes and the persisted widths). This is the
  documented safe-modification path being used correctly.
- Safe modification: Keep doing that - pin each layout change with a Playwright geometry
  assertion (`e2e/workbench-layout.spec.ts`, `e2e/dashboard.spec.ts`) so the shared rule
  cannot silently win again. Verify CSS-only changes against the built stylesheet rather
  than by launching the app. The structural fix is the file split in Tech Debt.

**Scratchpad pane concurrency:**
- Files: `src/components/ScratchpadPane.tsx` (1,504 lines, +429 in v0.4.62)
- Why fragile: The pane hand-rolls its own concurrency control in 13 `useRef` slots -
  `refreshSerialRef` (out-of-order refresh guard, `:333-337`), `editSerialRef`,
  `saveInFlightRef`, `dirtyRef`/`contentRef` (render-independent buffers),
  `autoSaveTimerRef` + `watcherRefreshTimerRef` (two debounces),
  `activeWorkPathRef` (workspace-change guard inside the debounce, `:569-571`),
  `activeWatcherGenerationRef`, plus a `queueWatcherTransition` serializer for
  watcher start/stop. Each guard is individually reasoned and commented; together they
  are a state machine that only exists in refs.
- Safe modification: Preserve every serial/generation guard when touching `refresh`,
  `flushCurrent`, or the watcher effect - each one exists because an overlapping async
  resolution regressed the UI to older content. Do not convert a ref guard to state.
- Test coverage: `src/components/ScratchpadPane.test.tsx` and
  `src/lib/scratchpadTree.test.ts` (4 cases, added with the tree). Neither exercises the
  overlapping-refresh, workspace-switch-mid-debounce, or watcher-restart races.
- Behavior gap worth knowing: `buildScratchpadFolderTree`
  (`src/lib/scratchpadTree.ts:26`) derives folders purely from file entries, so an empty
  directory on disk never appears in the tree, and `ideation`/`drafts` are filtered out
  entirely (`ScratchpadPane.tsx:344`, owned by `DraftsPane`) while remaining valid
  `ScratchpadCollection` values in `src/lib/types.ts:926`.

**Skill registry and install targets:**
- Files: `src-tauri/src/skill_host/store.rs` (7,878 lines - the largest file in the
  repo), `src-tauri/src/skill_host/fs.rs`, `src-tauri/src/skill_host/dispatch.rs`,
  `src-tauri/src/skill_host/bundle_update.rs`
- Why fragile: Five ownership tiers with a one-name-one-tier invariant
  (`docs/SSOT-TIERS.md`), symlink-based install into tool-owned directories that Maru
  must not otherwise write (`docs/BOUNDARIES.md`), OTA bundle updates that bypass the
  app version, plus a global lock. Recent fixes - "pin codex installs to their recorded
  root, refuse silent retarget" (#255), "rebaseline builtin hashes on rescan" (#212) -
  are both invariant-repair, not feature work.
- Safe modification: Read `docs/SSOT-TIERS.md` and `docs/BOUNDARIES.md` before touching
  install or sync paths. The boundary doc states its own conflict rule: an ownership
  change must update both repositories' boundary documents in the same change set.
- Test coverage: Strong - 468 test-side assertions in `store.rs` alone.

**Terminal / PTY session lifecycle:**
- Files: `src-tauri/src/terminal/mod.rs` (1,546 lines), `input.rs`, `snapshot.rs`,
  `src/components/NativeTerminalView.tsx` (2,277 lines),
  `src/components/TerminalPanel.tsx` (2,405 lines)
- Why fragile: Latched `closing` flags, generation tokens
  (`get_session_generation`, `mod.rs:887`), `Arc::ptr_eq` identity guards, and a
  `Drop`-ordered reservation type (`mod.rs:124`). This is genuinely concurrent code
  where the correctness argument lives in comments.
- Safe modification: Preserve the generation check on every session-scoped command;
  it is what prevents a stale frontend handle from writing into a recycled session.
- Test coverage: Good on both sides -
  `src/components/NativeTerminalView.test.tsx` (1,495 lines),
  `src/lib/terminal.test.ts`, `terminalInputPump`, `terminalTransport`,
  `terminalShortcuts`.

**macOS-native behavior has no automated coverage at all:**
- Files: `src-tauri/src/browser_passkeys.rs`, `src-tauri/src/app_menu.rs` (311 lines,
  no test module), the `objc2`/`block2`/`core-foundation-sys` code under
  `#[cfg(target_os = "macos")]`
- Why fragile: `make verify` runs on `ubuntu-22.04` only
  (`.github/workflows/ci.yml`), and the e2e suite runs Chromium against a plain Vite
  server with mocked IPC (`playwright.config.ts:17`,
  `e2e/helpers/todayFixtures.ts:3`). Nothing in CI exercises WKWebView, the real PTY,
  IME input, or the macOS menu. `fix(macos): prevent white screen after inactivity`
  (7638d2f) is exactly the class of bug this misses.
- Safe modification: Assume macOS-only changes ship unverified by CI, and validate them
  by running the real app.

---

## Scaling Limits

**Graph rendering:** budgeted at 10,000 nodes / 50,000 edges
(`src/lib/graph/perf.bench.ts:5-8`): `buildVaultGraph` < 500 ms, ForceAtlas2 warm
layout ≤ 3 s, visibility-mask update < 5 ms. Insight computation runs off-thread
(`src/lib/graph/analysis.worker.ts`) and each insight list is capped at 50. Beyond
~10k nodes the ForceAtlas2 layout is the wall; the scaling path is incremental layout
or server-side positions rather than a bigger budget.

**Content search:** `MAX_FILES = 500`, `MAX_TOTAL_MATCHES = 5_000`,
`MAX_MATCH_LINES_PER_FILE = 200`, `MAX_FILE_BYTES = 2 MiB`, `MAX_LINE_CHARS = 500`
(`src-tauri/src/content_search.rs:18-22`). Truncation is tracked
(`:252`, `:290`, `:323`) and surfaced in the UI
(`src/components/ExplorerPane.tsx:623`), so results degrade honestly. No action needed.

**Editor tabs have no live cap:** `RESTORED_COMPANION_TAB_CAP = 8`
(`src/lib/editorTabsStore.ts:465`) applies only to startup restore. `insertDocTab`
(`:547`) is unbounded, and v0.4.62 gave it a new caller that fires on file *selection*
rather than on open (see Tech Debt). Every open tab holds a full `DocumentPayload`
including `content`.

**Other hard caps:** browser tabs 12 (`src-tauri/src/site_view.rs:34`,
`src/lib/browserTabs.ts:15`); opened-URL backlog 64 (`site_view.rs:41`); active
missions 20 / tracked 80 (`src/lib/useActiveMissions.ts:7`); git diff 64 KiB and 200
change rows (`src-tauri/src/git.rs:207`, `:261`); HWPX/ZIP 500 entries and 100 MB
decompressed (`src-tauri/src/kordoc_lite.rs:20`); HTML visual editor 20,000 nodes
(`src/lib/htmlDocument.ts:26`); calendar search 500 results
(`src-tauri/src/calendar_search.rs:8`); Scratchpad tree pane width 200-360 px
(`src/lib/settings.ts` `SCRATCHPAD_TREE_WIDTH`).

**Scheduler dispatch claims are process-local:** `LAST_FIRED`
(`src-tauri/src/scheduler.rs:38`) is a `BTreeMap` that is overwritten, never evicted,
and lost on restart - already marked `ponytail: process-local only`. The persisted
`nextRunAt` guard is the durable path; `LAST_FIRED` only covers the case where that
write fails. Fine as-is; note it when debugging a double-fire after a restart.

---

## Dependencies at Risk

**Rust toolchain is unpinned while every other toolchain is pinned:**
- Risk: `.github/workflows/ci.yml` and `release-bundles.yml` use
  `dtolnay/rust-toolchain@stable`, and there is no `rust-toolchain.toml` in the repo.
  Node is pinned to `22.22.3` and pnpm to `9.15.0` in the same workflows;
  `src-tauri/Cargo.toml:8` declares `rust-version = "1.77.2"` as a floor, not a pin.
- Impact: A new Rust stable release can change CI and release-build behavior with no
  commit in this repo, and CI cannot be reproduced for an older commit.
- Migration plan: Add `rust-toolchain.toml` with the pinned channel, or pin the action
  to an explicit version. Bump it deliberately like the Node pin.

**Exact-pinned graph stack:** `sigma 3.0.3`, `@sigma/export-image 3.0.0`,
`@sigma/node-border 3.0.0`, `graphology 0.26.0`, `graphology-layout 0.6.1`,
`graphology-layout-forceatlas2 0.10.1`, `graphology-types 0.24.8` are pinned without a
caret, as is `trash = "=4.1.1"` in `src-tauri/Cargo.toml`. This is a deliberate choice
against upstream churn, not an oversight - but nothing records *why* each pin exists, so
a future upgrade has to rediscover it. Add a one-line comment at each pin.

**`@types/dompurify`** is a deprecated stub - see Tech Debt above.

---

## Missing Critical Features

**No JavaScript/TypeScript linter and no Rust lint gate:**
- Problem: There is no `.eslintrc*`, `.prettierrc*`, `biome.json`, or `.editorconfig`
  in the repo, and `make verify` (`Makefile:309`) contains no `clippy` or `rustfmt`
  step. The only static gates are `tsc -b`, an i18n lint, and two `grep`-based CSS
  guards (`check-select-chrome`, `check-type-tokens`).
- Blocks: Strict TypeScript catches type errors but not unused code, unhandled promise
  rejections, exhaustive-deps violations on the 49 `useEffect` calls in `App.tsx`, or
  accidental `console` statements (35 remain in non-test `src/`, up from 24 at v0.4.61).
  `tsconfig.app.json` does not set `noUnusedLocals`/`noUnusedParameters`, so dead code
  accumulates silently. `src/lib/markdown.ts:62` carries an `// eslint-disable-next-line`
  comment for a linter that does not exist.
- Note: The absence has not visibly hurt quality - the code reads as consistently
  hand-maintained. The cheapest win is `cargo clippy -- -D warnings` and
  `cargo fmt --check` added to `verify`; those are zero-config and the Rust code is
  already idiomatic enough to pass or near-pass.

**No native Tauri E2E runner:**
- Problem: Tracked in the codebase's own ledger as `native-tauri-e2e-runner-missing`
  (`src/lib/e2eFlow.ts:153`). All 23 e2e specs run Chromium against Vite with
  `window.__MARU_E2E_INVOKE__` handlers replacing the Rust backend
  (`e2e/helpers/todayFixtures.ts:1-16`).
- Blocks: Nothing verifies the actual IPC contract end to end. A Rust command whose
  serialized shape drifts from its TypeScript wrapper in `src/lib/api.ts` (192 `invoke`
  call sites, 199 exported functions) will pass typecheck, unit tests, and e2e, and
  fail only in the built app.

---

## Test Coverage Gaps

**Large React components with no test - the top of the list:**
- What's not tested: 35 components over 400 lines have no co-located test (up from 31
  at v0.4.61). Ranked: `src/App.tsx` (9,590),
  `src/components/meetings/MeetingsPane.tsx` (2,965),
  `src/components/FilesWorkbench.tsx` (2,132),
  `src/components/graph/GraphCanvas.tsx` (1,923),
  `src/components/diagram/DiagramMode.tsx` (1,862),
  `src/components/settings/tabs/SkillsTab.tsx` (1,753),
  `src/components/OutlinePane.tsx` (1,702),
  `src/components/studio/StudioMode.tsx` (1,480),
  `src/components/graph/GraphView.tsx` (1,433),
  `src/components/DocumentList.tsx` (1,301),
  `src/components/InboxPane.tsx` (1,144),
  `src/components/EditorPane.tsx` (1,093),
  `src/components/agents/AgentsPane.tsx` (966),
  `src/components/dashboard/DashboardPane.tsx` (895),
  `src/components/ExplorerPane.tsx` (886).
- Risk: These are the panes with the most user-visible surface and, per the recent fix
  history, the most regressions. `App.tsx` in particular has no test of any kind.
- Priority: High for `EditorPane.tsx` and `DocumentList.tsx` (active regression zone),
  Medium for the rest. `src/components/today/` shows the target state - seven component
  tests covering a whole mode.
- New in v0.4.62, untested at the unit level: `src/components/InlineDocumentEditor.tsx`
  (243) and `src/components/DocumentModeSurface.tsx` (79). Both are covered indirectly
  by `e2e/smoke.spec.ts` (three new tests: read-only enforcement, edit-and-share-draft,
  and revision-conflict draft preservation) and `e2e/html-editor.spec.ts`.
  `DocumentModeSurface` is now the shared tab shell for three panes, so a unit test on
  its `kind`-driven trigger visibility (`plain` hides rich + preview) is cheap and high
  leverage.
- Note: `src/lib/` is the opposite story and is in good shape: 184 test files across
  `src/` against 376 non-test source files, with near-complete coverage of
  `src/lib/diagram/` (30 test files), `src/lib/graph/` (7), and the store modules.
  `src/lib/scratchpadTree.ts` shipped with its test in the same commit - the right
  default.

**Frontend e2e locators are bound to Korean UI strings:** `e2e/workbench-layout.spec.ts`
selects by `name: "스크래치패드"` and `e2e/smoke.spec.ts` asserts on `"저장 필요"` /
`"저장됨"` / `.tab-trigger` `hasText: "리치"`. Renaming a `ko` locale key breaks the e2e
suite with a timeout rather than a clear failure, and `pnpm lint:i18n` does not know the
specs exist.

**Rust modules without a test module (all five):**
- What's not tested: `src-tauri/src/lib.rs` (696 lines - the command registry and
  `RunEvent` handling), `src-tauri/src/app_menu.rs` (311),
  `src-tauri/src/frontmatter/ops.rs` (185 - but covered by the sibling
  `ops_update_tests.rs`), `src-tauri/src/agent_host/contracts.rs` (159).
- Risk: Low for `lib.rs` and `contracts.rs` (wiring and type declarations).
  `app_menu.rs` is macOS menu construction and is the one worth a smoke test, since CI
  never exercises it.
- Priority: Low.

**No coverage measurement:** neither `vitest --coverage` nor `cargo-llvm-cov` is wired
into any script or Makefile target, so the gaps above are inferred from file presence
rather than measured. Adding `vitest run --coverage` as a non-gating report would make
the frontend gap concrete.

**Ignored tests (3, all deliberate):** `src-tauri/src/vault.rs:1506` (real-workspace
scan bench), `src-tauri/src/ops_catalog/scan.rs:1110`,
`src-tauri/src/agent_host/status.rs:1185` (live AI CLI smoke). `Makefile:204-211`
explains why the CLI smoke is excluded from `verify`: "a merge gate that fails on an
expired token is a gate people learn to bypass." Correct call.

**`e2e/` and `scripts/` are never typechecked:** `tsconfig.app.json` includes only
`["src"]` and `tsconfig.node.json` only `["vite.config.ts"]`, so `tsc -b` never sees the
23 Playwright specs, `e2e/helpers/todayFixtures.ts`, or `playwright.config.ts`.
Playwright transpiles without typechecking, so a type error in a spec surfaces as a
runtime failure or not at all. Fix: add a third project reference covering `e2e` and
`scripts`.

---

*Concerns audit: 2026-08-22*
